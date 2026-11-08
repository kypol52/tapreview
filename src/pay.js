// Оплата счёта со стола (модуль «Сервис в зале» + галочка «Оплата счёта» в админке, миграция 051).
//
//   Официант на странице вызовов (/k/ТОКЕН/calls) вводит сумму счёта стола → table_bills.
//   Гость на карте стола жмёт «Счёт и оплата» → GET /pay?c=КОД&s=nfc|qr:
//     счёт, сколько уже оплачено, выбор — «всё», «поровну на N», «своя сумма» → подтверждение с сервисным сбором
//     (FEE_PERCENT сверху, платит гость) → POST /pay → платёж у банка (СБП) → /pay/status?p=ТОКЕН.
//   После оплаты части счёта — вторым шагом чаевые официанту (тот же путь, kind=tip, тот же сбор).
//   Банк сообщает об оплате → settle() (функция базы bill_payment_settle: один раз, повтор ничего не меняет).
//   Счёт оплачен полностью — сообщение в чаты «Вызовы гостей» и зелёная строка на странице вызовов.
//
// Куда идут деньги: всё, что платит гость (счёт, чаевые и сбор), — сразу на счёт заведения в ЕГО банке (СБП по QR
// через API банка заведения). Через TapReview деньги не проходят. Сбор копится в bill_payments.fee, и в начале месяца
// ИП выставляет заведению счёт за прошлый месяц (feeMonths: страница владельца и админка).
// Банк: env.PAY_PROVIDER. Сейчас есть только «mock» — поддельный банк для стенда (/pay/mock): настоящих денег нет.
// Без PAY_PROVIDER оплата не показывается нигде, даже если галочка в админке стоит.

import { db } from "./supabase.js";
import { isBot } from "./analytics.js";
import { deviceFrom, visitorKeyOf } from "./guests.js";
import { escapeHtml } from "./public-page.js";
import { callsOn, placeOf, themed } from "./service.js";
import { isExpired } from "./billing.js";
import { tg } from "./telegram.js";

const CODE_RE = /^[A-Z0-9]{4,12}$/;
const TOKEN_RE = /^[A-Za-z0-9]{24}$/;
const TOKEN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const BILL_HOURS = 6; // счёт старше 6 часов гостю уже не показываем
const SPLITS = [2, 3, 4, 5, 6];
const TIP_PERCENTS = [5, 10, 15];
const PAYMENTS_PER_HOUR = 12; // с одного телефона
const MIN_KOP = 100; // 1 ₽

export function feePercent(env) {
  const n = Number(env.PAY_FEE_PERCENT);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : 3;
}
export const feeOf = (env, amount) => Math.round((amount * feePercent(env)) / 100);

// Оплата включена: банк настроен + галочка у заведения + карта-стол с NFC/QR (как у вызовов)
export function payOn(env, business, card, source) {
  return Boolean(env.PAY_PROVIDER && business && business.pay_on && callsOn(business, card, source));
}

// 245000 → «2 450 ₽», 126235 → «1 262,35 ₽»
export function rub(kop) {
  const r = Math.floor(kop / 100);
  const k = kop % 100;
  return `${r.toLocaleString("ru-RU")}${k ? `,${String(k).padStart(2, "0")}` : ""} ₽`;
}

// «2450», «2 450», «2450,50» → копейки; иначе null
export function parseRub(value) {
  const s = String(value || "").replace(/[\s ₽]/g, "").replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

// Последний счёт стола за BILL_HOURS часов (кроме закрытых официантом)
export async function currentBill(env, cardId) {
  const since = encodeURIComponent(new Date(Date.now() - BILL_HOURS * 3600e3).toISOString());
  const rows = await db(env, `table_bills?card_id=eq.${cardId}&status=neq.closed&created_at=gt.${since}&select=id,business_id,place,amount,paid,split,staff_id,status&order=created_at.desc&limit=1`);
  return rows[0] || null;
}

// ---------- Банк ----------

// → { providerId, confirmUrl }
async function createAtBank(env, payment, { description, returnUrl }) {
  if (env.PAY_PROVIDER === "mock") {
    return { providerId: `mock-${payment.token}`, confirmUrl: `/pay/mock?p=${payment.token}` };
  }
  // Настоящий банк заведения (СБП по QR через его API) — когда известен банк первого заведения
  void description; void returnUrl;
  throw new Error(`Платёжный провайдер ${env.PAY_PROVIDER} не подключён`);
}

// Уведомление банка (или поддельного банка) об оплате/отмене
export async function settle(env, token, status) {
  const rows = await db(env, "rpc/bill_payment_settle", { method: "POST", body: { p_token: token, p_status: status } });
  const r = rows && rows[0];
  if (!r || !r.changed || status !== "succeeded") return r;
  const pay = (await db(env, `bill_payments?token=eq.${token}&select=amount,business_id,bill_id&limit=1`))[0];
  const bill = (await db(env, `table_bills?id=eq.${r.bill_id}&select=place,amount,paid,status&limit=1`))[0];
  const business = (await db(env, `businesses?id=eq.${pay.business_id}&select=name&limit=1`))[0];
  if (r.kind === "tip") {
    await notify(env, pay.business_id, `💝 <b>${escapeHtml(bill.place)}</b> — чаевые ${rub(pay.amount)}\n${escapeHtml(business.name)}`);
  } else if (bill.status === "paid") {
    await notify(env, pay.business_id, `💳 <b>${escapeHtml(bill.place)}</b> — счёт оплачен полностью: ${rub(bill.amount)}\n${escapeHtml(business.name)}`);
  }
  return r;
}

async function notify(env, businessId, text) {
  try {
    const chats = await db(env, `tg_subscribers?business_id=eq.${businessId}&service_calls=is.true&select=chat_id`);
    await Promise.all(chats.map((c) =>
      tg(env, "sendMessage", { chat_id: c.chat_id, text, parse_mode: "HTML", disable_web_page_preview: true })
        .catch((e) => console.error(`Оплата в Telegram ${c.chat_id}: ${e.message}`))));
  } catch (error) {
    console.error(`Оплата в Telegram: ${error.message}`);
  }
}

// ---------- Гость: /pay ----------

async function loadTable(env, code) {
  const card = (await db(env, `cards?code=eq.${code}&is_active=is.true&select=id,code,label,is_table,business_id&limit=1`))[0];
  const business = card && card.business_id
    ? (await db(env, `businesses?id=eq.${card.business_id}&is_active=eq.true&select=id,slug,name,theme,design,brand_color,paid_until,modules,tariff,pay_on&limit=1`))[0]
    : null;
  return { card, business };
}

export async function handlePay(request, env, url) {
  try {
    if (url.pathname === "/pay/status") return await statusRoute(env, url);
    if (url.pathname === "/pay/mock") return await mockBank(request, env, url);
    if (request.method === "POST") return await createPayment(request, env);
    if (request.method !== "GET" && request.method !== "HEAD") return simple(405, null, "Откройте страницу с карты ещё раз");
    if (isBot(request)) return simple(403, null, "Оплата недоступна");

    const code = String(url.searchParams.get("c") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const source = url.searchParams.get("s") === "qr" ? "qr" : "nfc";
    if (!CODE_RE.test(code)) return simple(404, null, "Ссылка повреждена — коснитесь карты на столе ещё раз");
    const { card, business } = await loadTable(env, code);
    if (!business || !payOn(env, business, card, source) || isExpired(business.paid_until)) {
      return simple(404, business, "Оплата с этой карты сейчас недоступна. Попросите счёт у официанта.");
    }
    const back = `/c/${card.code}?s=${source}`;
    const self = (extra = {}) => `/pay?${new URLSearchParams({ c: card.code, s: source, ...extra })}`;
    const bill = await currentBill(env, card.id);

    // Счёт ещё не выставили — ждём официанта, страница обновляется сама
    if (!bill) {
      return page(business, card, {
        title: "Счёт", meta: `<meta http-equiv="refresh" content="10">`,
        body: `
          <div class="pay-big" aria-hidden="true">🧾</div>
          <h2 class="thanks">Официант готовит счёт</h2>
          <p class="lead">Как только он введёт сумму, здесь появится кнопка оплаты. Страница обновится сама.</p>
          <a class="svc-back" href="${escapeHtml(back)}">← На страницу стола</a>`
      });
    }
    const left = Math.max(0, bill.amount - bill.paid);
    if (bill.status === "paid" || left === 0) {
      return page(business, card, {
        title: "Счёт оплачен",
        body: `
          <div class="pay-big" aria-hidden="true">✅</div>
          <h2 class="thanks">Счёт оплачен</h2>
          <p class="pay-sum">${rub(bill.amount)}</p>
          <p class="lead">Спасибо! Ждём вас снова.</p>
          <a class="svc-back" href="${escapeHtml(back)}">← На страницу стола</a>`
      });
    }

    // Выбрана часть → подтверждение со сбором
    const part = choosePart(url, bill, left);
    if (part.error) return choosePage(business, card, bill, left, self, back, part.error);
    if (part.amount) {
      const fee = feeOf(env, part.amount);
      return page(business, card, {
        title: "Оплата счёта",
        body: `
          ${billHead(bill, left)}
          <section class="pay-box">
            <p class="pay-what">${escapeHtml(part.label)}</p>
            <table class="pay-lines">
              <tr><td>Ваша часть</td><td>${rub(part.amount)}</td></tr>
              <tr><td>Сервисный сбор ${feePercent(env)}%</td><td>${rub(fee)}</td></tr>
              <tr class="pay-total"><td>К оплате</td><td>${rub(part.amount + fee)}</td></tr>
            </table>
            <form method="post" action="/pay">
              <input type="hidden" name="c" value="${escapeHtml(card.code)}">
              <input type="hidden" name="s" value="${source}">
              <input type="hidden" name="bill" value="${bill.id}">
              <input type="hidden" name="kind" value="bill">
              <input type="hidden" name="amount" value="${part.amount}">
              <button class="pay-btn" type="submit">${SBP} Оплатить через СБП</button>
            </form>
            <p class="pay-note">Откроется приложение вашего банка. Деньги поступят напрямую ${escapeHtml(business.name)}. Сбор ${feePercent(env)}% — за оплату по QR.</p>
          </section>
          <a class="svc-back" href="${escapeHtml(self())}">← Выбрать другую сумму</a>`
      });
    }
    return choosePage(business, card, bill, left, self, back);
  } catch (error) {
    console.error(`Pay error: ${error.message}\n${error.stack}`);
    return simple(500, null, "Не получилось открыть оплату. Попробуйте ещё раз или попросите счёт у официанта.");
  }
}

// ?part=all | ?n=3 | ?a=1200 → { amount, label } | { error } | {}
function choosePart(url, bill, left) {
  if (url.searchParams.get("part") === "all") return { amount: left, label: bill.paid ? "Оставшаяся часть счёта" : "Весь счёт" };
  const n = Number(url.searchParams.get("n"));
  if (Number.isInteger(n) && n >= 2 && n <= 10) {
    // Доля — в целых рублях вверх; последний платит остаток
    return { amount: Math.min(left, Math.ceil(bill.amount / n / 100) * 100), label: `Счёт поровну на ${n} — ваша доля` };
  }
  if (url.searchParams.has("a")) {
    const a = parseRub(url.searchParams.get("a"));
    if (!a || a < MIN_KOP) return { error: "Введите сумму в рублях, например 1200" };
    if (a > left) return { error: `Осталось оплатить ${rub(left)} — введите сумму не больше` };
    return { amount: a, label: "Своя сумма" };
  }
  return {};
}

function billHead(bill, left) {
  return `
    <section class="pay-head">
      <p class="pay-label">Счёт</p>
      <p class="pay-sum">${rub(bill.amount)}</p>
      ${bill.paid ? `<p class="pay-paid">Оплачено ${rub(bill.paid)} · осталось <b>${rub(left)}</b></p>` : ""}
    </section>`;
}

function choosePage(business, card, bill, left, self, back, error = "") {
  const splits = [...new Set([bill.split, ...SPLITS].filter((n) => n && n >= 2))].sort((a, b) => a - b).slice(0, 5);
  return page(business, card, {
    title: "Оплата счёта",
    // Пока гость выбирает — подтягиваем оплаты соседей по столу
    meta: `<meta http-equiv="refresh" content="30">`,
    body: `
      ${billHead(bill, left)}
      <a class="pay-btn" href="${escapeHtml(self({ part: "all" }))}" rel="nofollow">${bill.paid ? `Оплатить остаток · ${rub(left)}` : `Оплатить весь счёт · ${rub(left)}`}</a>
      <p class="pay-q">Разделить поровну</p>
      <div class="pay-splits">${splits.map((n) => `<a class="svc-split${n === bill.split ? " pay-split-on" : ""}" href="${escapeHtml(self({ n }))}" rel="nofollow">на ${n}</a>`).join("")}</div>
      <form class="pay-own" method="get" action="/pay">
        <input type="hidden" name="c" value="${escapeHtml(card.code)}">
        <input type="hidden" name="s" value="${escapeHtml(new URLSearchParams(self().split("?")[1]).get("s"))}">
        <label class="pay-q" for="pay-a">Или своя сумма</label>
        <div class="pay-own-row">
          <input id="pay-a" name="a" inputmode="decimal" autocomplete="off" maxlength="10" placeholder="Сумма, ₽" required>
          <button type="submit">Далее</button>
        </div>
      </form>
      ${error ? `<p class="fb-warn" role="alert">${escapeHtml(error)}</p>` : ""}
      <a class="svc-back" href="${escapeHtml(back)}">← На страницу стола</a>`
  });
}

// POST /pay: kind=bill (часть счёта) или tip (чаевые после оплаты, p = платёж за счёт)
async function createPayment(request, env) {
  const form = new URLSearchParams((await request.text()).slice(0, 1000));
  const code = String(form.get("c") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const source = form.get("s") === "qr" ? "qr" : "nfc";
  const kind = form.get("kind") === "tip" ? "tip" : "bill";
  const amount = Number(form.get("amount"));
  const billId = Number(form.get("bill"));
  if (!CODE_RE.test(code) || !Number.isSafeInteger(amount) || amount < MIN_KOP || !Number.isSafeInteger(billId)) {
    return simple(400, null, "Не получилось начать оплату — вернитесь к счёту и попробуйте ещё раз.");
  }
  const { card, business } = await loadTable(env, code);
  if (!business || !payOn(env, business, card, source) || isExpired(business.paid_until)) {
    return simple(404, business, "Оплата с этой карты сейчас недоступна. Попросите счёт у официанта.");
  }
  const back = `/pay?c=${card.code}&s=${source}`;
  const { deviceId, setCookie } = deviceFrom(request);
  if (setCookie) return simple(400, business, "Коснитесь карты на столе ещё раз и откройте счёт.", `/c/${card.code}?s=${source}`);
  const visitor = await visitorKeyOf(env, deviceId, business.id);

  const bill = (await db(env, `table_bills?id=eq.${billId}&card_id=eq.${card.id}&select=id,amount,paid,status,staff_id,place&limit=1`))[0];
  if (!bill || bill.status === "closed") return simple(404, business, "Этот счёт уже закрыт.", back);
  if (kind === "bill") {
    const left = bill.amount - bill.paid;
    if (left <= 0) return simple(409, business, "Счёт уже оплачен полностью.", back);
    if (amount > left) return simple(409, business, `Пока вы выбирали, часть счёта оплатили. Осталось ${rub(left)}.`, back);
  } else if (amount > bill.amount) {
    return simple(400, business, "Чаевые не могут быть больше счёта.", back);
  }

  const since = encodeURIComponent(new Date(Date.now() - 3600e3).toISOString());
  const recent = await db(env, `bill_payments?business_id=eq.${business.id}&visitor_hash=eq.${visitor}&created_at=gt.${since}&select=id`);
  if (recent.length >= PAYMENTS_PER_HOUR) return simple(429, business, "Слишком много попыток оплаты. Попросите помощи у официанта.", back);

  const fee = feeOf(env, amount);
  const token = randomToken();
  const row = {
    token, bill_id: bill.id, business_id: business.id, kind, amount, fee, total: amount + fee,
    staff_id: bill.staff_id, provider: String(env.PAY_PROVIDER).slice(0, 20), visitor_hash: visitor
  };
  await db(env, "bill_payments", { method: "POST", body: row, prefer: "return=minimal" });
  const bank = await createAtBank(env, row, {
    description: `${kind === "tip" ? "Чаевые" : "Счёт"} · ${bill.place} · ${business.name}`.slice(0, 128),
    returnUrl: `${String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "")}/pay/status?p=${token}`
  });
  await db(env, `bill_payments?token=eq.${token}`, { method: "PATCH", body: { provider_id: bank.providerId }, prefer: "return=minimal" });
  // На свой адрес, а оттуда — в банк: form-action 'self' не пускает форму сразу на чужой сайт
  return new Response(null, { status: 303, headers: { Location: `/pay/status?p=${token}&go=1`, "Cache-Control": "no-store" } });
}

// ---------- /pay/status?p=ТОКЕН ----------

async function statusRoute(env, url) {
  const token = String(url.searchParams.get("p") || "");
  if (!TOKEN_RE.test(token)) return simple(404, null, "Платёж не найден");
  const pay = (await db(env, `bill_payments?token=eq.${token}&select=token,bill_id,business_id,kind,amount,fee,total,status,staff_id,provider,created_at&limit=1`))[0];
  if (!pay) return simple(404, null, "Платёж не найден");
  const bill = (await db(env, `table_bills?id=eq.${pay.bill_id}&select=id,card_id,place,amount,paid,status,staff_id&limit=1`))[0];
  const business = (await db(env, `businesses?id=eq.${pay.business_id}&select=id,slug,name,theme,design,brand_color&limit=1`))[0];
  const card = bill && bill.card_id ? (await db(env, `cards?id=eq.${bill.card_id}&select=id,code,label&limit=1`))[0] : null;
  const source = url.searchParams.get("s") === "qr" ? "qr" : "nfc";
  const table = card ? `/c/${card.code}?s=${source}` : null;
  const billUrl = card ? `/pay?c=${card.code}&s=${source}` : null;
  const confirm = pay.provider === "mock" ? `/pay/mock?p=${token}` : null;
  const view = { place: bill ? bill.place : "", card };

  if (pay.status === "pending") {
    // Сразу после «Оплатить» — в банк; вернулись из банка — ждём подтверждения
    const go = url.searchParams.get("go") === "1" && confirm;
    return page(business, view, {
      title: "Оплата",
      meta: go ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(confirm)}">` : `<meta http-equiv="refresh" content="4">`,
      body: `
        <div class="pay-big" aria-hidden="true">⏳</div>
        <h2 class="thanks">${go ? "Переходим в банк…" : "Ждём подтверждение банка"}</h2>
        <p class="pay-sum">${rub(pay.total)}</p>
        <p class="lead">${go ? "Если банк не открылся сам — нажмите кнопку." : "Обычно это несколько секунд. Страница обновится сама."}</p>
        ${confirm ? `<a class="pay-btn" href="${escapeHtml(confirm)}">${SBP} Открыть оплату</a>` : ""}`
    });
  }
  if (pay.status === "canceled") {
    return page(business, view, {
      title: "Оплата отменена",
      body: `
        <div class="pay-big" aria-hidden="true">✖️</div>
        <h2 class="thanks">Оплата не прошла</h2>
        <p class="lead">Деньги не списаны. Можно попробовать ещё раз.</p>
        ${billUrl ? `<a class="pay-btn" href="${escapeHtml(billUrl)}">Вернуться к счёту</a>` : ""}`
    });
  }

  // Оплачено
  const name = await staffName(env, pay.staff_id);
  if (pay.kind === "tip") {
    return page(business, view, {
      title: "Спасибо за чаевые",
      body: `
        <div class="pay-big" aria-hidden="true">💝</div>
        <h2 class="thanks">Спасибо за чаевые!</h2>
        <p class="pay-sum">${rub(pay.amount)}</p>
        ${name ? `<p class="pay-paid">Официант: ${escapeHtml(name)}</p>` : ""}
        <p class="lead">Заведение передаст чаевые официанту полностью. Ждём вас снова!</p>
        ${table ? `<a class="svc-back" href="${escapeHtml(table)}">← На страницу стола</a>` : ""}`
    });
  }
  const left = bill ? Math.max(0, bill.amount - bill.paid) : 0;
  const tipChoice = Number(url.searchParams.get("tip"));
  const tipOwn = url.searchParams.has("ta") ? parseRub(url.searchParams.get("ta")) : null;
  const tipAmount = TIP_PERCENTS.includes(tipChoice) ? Math.max(MIN_KOP, Math.round((pay.amount * tipChoice) / 10000) * 100) : tipOwn;
  const tipped = await db(env, `bill_payments?bill_id=eq.${pay.bill_id}&kind=eq.tip&status=eq.succeeded&visitor_hash=not.is.null&created_at=gt.${encodeURIComponent(pay.created_at)}&select=id&limit=1`);
  const self = (extra) => `/pay/status?${new URLSearchParams({ p: token, s: source, ...extra })}`;

  let tips = "";
  if (bill && bill.status !== "closed" && !tipped.length) {
    if (tipAmount && tipAmount >= MIN_KOP && tipAmount <= bill.amount) {
      const fee = feeOf(env, tipAmount);
      tips = `
        <section class="pay-box">
          <p class="pay-what">Чаевые ${name ? `— ${escapeHtml(name)}` : "официанту"}</p>
          <table class="pay-lines">
            <tr><td>Чаевые</td><td>${rub(tipAmount)}</td></tr>
            <tr><td>Сервисный сбор ${feePercent(env)}%</td><td>${rub(fee)}</td></tr>
            <tr class="pay-total"><td>К оплате</td><td>${rub(tipAmount + fee)}</td></tr>
          </table>
          <form method="post" action="/pay">
            <input type="hidden" name="c" value="${card ? escapeHtml(card.code) : ""}">
            <input type="hidden" name="s" value="${source}">
            <input type="hidden" name="bill" value="${pay.bill_id}">
            <input type="hidden" name="kind" value="tip">
            <input type="hidden" name="amount" value="${tipAmount}">
            <button class="pay-btn" type="submit">${SBP} Оставить чаевые</button>
          </form>
          <a class="svc-back" href="${escapeHtml(self({}))}">← Другая сумма</a>
        </section>`;
    } else {
      tips = `
        <section class="pay-box">
          <p class="pay-what">Оставить чаевые${name ? ` — ${escapeHtml(name)}` : " официанту"}?</p>
          <div class="pay-splits">${TIP_PERCENTS.map((p) =>
            `<a class="svc-split" href="${escapeHtml(self({ tip: p }))}" rel="nofollow">${p}% · ${rub(Math.max(MIN_KOP, Math.round((pay.amount * p) / 10000) * 100))}</a>`).join("")}</div>
          <form class="pay-own" method="get" action="/pay/status">
            <input type="hidden" name="p" value="${token}">
            <input type="hidden" name="s" value="${source}">
            <div class="pay-own-row">
              <input name="ta" inputmode="decimal" autocomplete="off" maxlength="10" placeholder="Своя сумма, ₽" required>
              <button type="submit">Далее</button>
            </div>
          </form>
          ${url.searchParams.has("ta") ? `<p class="fb-warn" role="alert">Введите сумму в рублях, не больше счёта</p>` : ""}
          ${table ? `<a class="pay-skip" href="${escapeHtml(table)}">Без чаевых</a>` : ""}
        </section>`;
    }
  }
  return page(business, view, {
    title: "Оплачено",
    body: `
      <div class="pay-big" aria-hidden="true">✅</div>
      <h2 class="thanks">Оплачено</h2>
      <p class="pay-sum">${rub(pay.amount)}</p>
      <p class="pay-paid">${left ? `По счёту осталось ${rub(left)} — соседи по столу могут оплатить свою часть` : "Счёт оплачен полностью"}</p>
      ${tips || (table ? `<a class="svc-back" href="${escapeHtml(table)}">← На страницу стола</a>` : "")}`
  });
}

async function staffName(env, staffId) {
  if (!staffId) return "";
  const rows = await db(env, `staff?id=eq.${staffId}&select=name&limit=1`);
  return rows[0] ? rows[0].name : "";
}

// ---------- Поддельный банк (только PAY_PROVIDER=mock, для стенда) ----------

async function mockBank(request, env, url) {
  if (env.PAY_PROVIDER !== "mock") return simple(404, null, "Страница не найдена");
  if (request.method === "POST") {
    const form = new URLSearchParams((await request.text()).slice(0, 300));
    const token = String(form.get("p") || "");
    if (!TOKEN_RE.test(token)) return simple(404, null, "Платёж не найден");
    await settle(env, token, form.get("ok") === "1" ? "succeeded" : "canceled");
    return new Response(null, { status: 303, headers: { Location: `/pay/status?p=${token}`, "Cache-Control": "no-store" } });
  }
  const token = String(url.searchParams.get("p") || "");
  const pay = TOKEN_RE.test(token) ? (await db(env, `bill_payments?token=eq.${token}&select=total,status,business_id&limit=1`))[0] : null;
  if (!pay) return simple(404, null, "Платёж не найден");
  const business = (await db(env, `businesses?id=eq.${pay.business_id}&select=name&limit=1`))[0];
  const response = new Response(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Тестовый банк · СБП</title>
<style>body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#eef1f6;color:#111}main{max-width:420px;margin:0 auto;padding:24px 16px}
.bank{background:#fff;border-radius:20px;padding:22px;box-shadow:0 8px 30px rgba(0,0,0,.08)}.tag{display:inline-block;padding:4px 10px;border-radius:99px;background:#fde68a;font-size:12px;font-weight:700}
h1{font-size:20px;margin:12px 0 4px}.sum{font-size:34px;font-weight:800;margin:14px 0}.to{color:#555;margin:0}
button{width:100%;margin-top:10px;padding:15px;border:0;border-radius:14px;font:inherit;font-weight:700;cursor:pointer}.ok{background:#1d4ed8;color:#fff}.no{background:#eef1f6;color:#333}</style></head>
<body><main><div class="bank"><span class="tag">ТЕСТОВЫЙ БАНК — деньги не списываются</span>
<h1>Оплата по СБП</h1><p class="to">Получатель: ${escapeHtml(business ? business.name : "")}</p><p class="sum">${rub(pay.total)}</p>
${pay.status === "pending" ? `<form method="post" action="/pay/mock"><input type="hidden" name="p" value="${token}"><input type="hidden" name="ok" value="1"><button class="ok" type="submit">Подтвердить оплату</button></form>
<form method="post" action="/pay/mock"><input type="hidden" name="p" value="${token}"><input type="hidden" name="ok" value="0"><button class="no" type="submit">Отменить</button></form>`
    : `<p>Платёж уже обработан.</p><a href="/pay/status?p=${token}">Вернуться</a>`}
</div></main></body></html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    }
  });
  return response;
}

// ---------- Оформление ----------

const SBP = `<svg class="pay-sbp" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5l4 7v6l-4-2zM7 12l4-7h7l-11 7zM11 19l7-4v-5l-7 4zM7 18l4 1 7-4-7-1z" fill="currentColor"/></svg>`;

const PAY_CSS = `
  .pay-big { font-size: 46px; line-height: 1; margin: 6px 0 10px; }
  .pay-head { margin: 0 0 16px; }
  .pay-label { margin: 0; color: var(--muted); font-size: 13px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
  .pay-sum { margin: 4px 0; color: var(--text); font-size: 34px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .pay-paid { margin: 0 0 6px; color: var(--muted); font-size: 14.5px; }
  .pay-paid b { color: var(--text); }
  .pay-btn { display: flex; gap: 8px; align-items: center; justify-content: center; width: 100%; box-sizing: border-box; margin: 6px 0 0; padding: 15px 16px;
    border: 0; border-radius: 16px; background: linear-gradient(135deg, var(--cta1, #1f9d6b), var(--cta2, #137a52)); color: #fff;
    font: inherit; font-size: 16px; font-weight: 800; text-decoration: none; cursor: pointer; }
  .pay-sbp { width: 20px; height: 20px; flex: none; }
  .pay-q { display: block; margin: 18px 0 8px; color: var(--muted); font-size: 13px; }
  .pay-splits { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
  .pay-split-on { border-color: var(--accent); }
  .pay-own-row { display: flex; gap: 8px; }
  .pay-own-row input { flex: 1; min-width: 0; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--btn-border); background: var(--btn-bg);
    color: var(--text); font: inherit; font-size: 16px; }
  .pay-own-row button { padding: 12px 16px; border-radius: 12px; border: 1px solid var(--btn-border); background: var(--btn-bg); color: var(--btn-text);
    font: inherit; font-weight: 700; cursor: pointer; }
  .pay-own { margin-top: 4px; }
  .pay-box { margin: 18px 0 0; padding: 16px; border-radius: 18px; border: 1px solid var(--btn-border); background: var(--btn-bg); text-align: left; }
  .pay-what { margin: 0 0 10px; color: var(--text); font-size: 16px; font-weight: 800; text-align: center; }
  .pay-lines { width: 100%; border-collapse: collapse; margin: 0 0 12px; color: var(--text); font-size: 15px; }
  .pay-lines td { padding: 5px 0; }
  .pay-lines td + td { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pay-total td { padding-top: 9px; border-top: 1px solid var(--btn-border); font-size: 17px; font-weight: 800; }
  .pay-note { margin: 10px 0 0; color: var(--muted); font-size: 12.5px; text-align: center; }
  .pay-skip { display: block; margin-top: 12px; color: var(--muted); font-size: 14px; text-align: center; }
  .pay-box .svc-back { display: block; text-align: center; margin-top: 10px; }
`;

function page(business, card, { title, body, meta = "" }) {
  return themed(business, {
    title: `${title} — ${business.name}`,
    meta,
    extraCss: PAY_CSS,
    body: `
      <h1 class="name name-mid">${escapeHtml(business.name)}</h1>
      ${card && (card.place || card.code) ? `<p class="tagline">${escapeHtml(card.place || placeOf(card))}</p>` : ""}
      <div class="divider"></div>
      <section class="svc-status">${body}</section>`
  });
}

function simple(status, business, text, back = null) {
  return themed(business, {
    status,
    title: "Оплата счёта",
    extraCss: PAY_CSS,
    body: `
      <h2 class="thanks">Оплата счёта</h2>
      <p class="lead">${escapeHtml(text)}</p>
      ${back ? `<a class="svc-back" href="${escapeHtml(back)}">← Назад</a>` : ""}`
  });
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]).join("");
}

// ---------- Сбор TapReview: считаем по месяцам, выставляем заведению счёт ----------
// Деньги гостя (счёт + чаевые + сбор) приходят прямо на счёт заведения в его банке. Сбор (fee) — наш:
// в начале месяца ИП выставляет заведению счёт на сумму сборов за прошлый месяц (МСК).

const MSK = 3 * 3600e3;
// Начало месяца по МСК (shift: 0 — текущий, -1 — прошлый, 1 — следующий), в миллисекундах UTC
export function mskMonthStart(now, shift = 0) {
  const d = new Date(now + MSK);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + shift, 1) - MSK;
}
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
export const monthName = (ms) => MONTHS[new Date(ms + MSK).getUTCMonth()];

// Успешные оплаты за период: { parts, bills, billSum, tipSum, tips, fee } | null
export async function payStats(env, ids, { from, to }) {
  const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());
  const rows = await db(env, `bill_payments?business_id=in.(${ids.join(",")})&status=eq.succeeded&paid_at=gte.${iso(from)}&paid_at=lt.${iso(to)}&select=bill_id,kind,amount,fee&limit=50000`);
  if (!rows.length) return null;
  const s = { parts: 0, bills: new Set(), billSum: 0, tipSum: 0, tips: 0, fee: 0 };
  for (const r of rows) {
    s.fee += r.fee;
    if (r.kind === "tip") { s.tips++; s.tipSum += r.amount; } else { s.parts++; s.bills.add(r.bill_id); s.billSum += r.amount; }
  }
  return { ...s, bills: s.bills.size };
}

// Сбор за прошлый и текущий месяц — для владельца и админки: { prev: {name, fee}, cur: {name, fee} }
export async function feeMonths(env, ids, now = Date.now()) {
  const [p0, c0, n0] = [mskMonthStart(now, -1), mskMonthStart(now), mskMonthStart(now, 1)];
  const [prev, cur] = await Promise.all([payStats(env, ids, { from: p0, to: c0 }), payStats(env, ids, { from: c0, to: n0 })]);
  return { prev: { name: monthName(p0), fee: prev ? prev.fee : 0 }, cur: { name: monthName(c0), fee: cur ? cur.fee : 0 } };
}

// Раздел на странице статистики владельца (/s/…)
export function paySection(s, months, esc) {
  if (!s && !(months && (months.prev.fee || months.cur.fee))) return "";
  const kpis = s ? `
      <div class="kpis desk-kpis">
        <div class="kpi"><div class="kpi-label">Оплачено по счетам</div><div class="kpi-value">${esc(rub(s.billSum))}</div></div>
        <div class="kpi"><div class="kpi-label">Чаевые</div><div class="kpi-value">${esc(rub(s.tipSum))}</div></div>
      </div>
      <p>Счетов: ${s.bills}, платежей гостей: ${s.parts}, чаевых: ${s.tips}. Все деньги пришли на ваш счёт в банке сразу при оплате.</p>` : "";
  const fee = months ? `
      <table class="desk-table"><thead><tr><th>Сервисный сбор TapReview</th><th>₽</th></tr></thead><tbody>
        <tr><td>За ${esc(months.prev.name)} — к оплате по счёту</td><td>${esc(rub(months.prev.fee))}</td></tr>
        <tr><td>За ${esc(months.cur.name)} — на сегодня</td><td>${esc(rub(months.cur.fee))}</td></tr>
      </tbody></table>
      <p>Сбор платят гости сверху счёта, он уже поступил вам вместе с оплатами. В начале месяца TapReview выставляет счёт на сумму сбора за прошлый месяц.</p>` : "";
  return `
    <section class="panel">
      <h2>Оплаты по QR</h2>
      ${kpis}
      ${fee}
    </section>`;
}

// ---------- Персонал: счёт на странице вызовов (service.js) ----------

// Официант выставил счёт по вызову «Просят счёт»: прежний незакрытый счёт стола закрываем, вызов — «Готово»
export async function issueBill(env, business, link, callId, amount) {
  const call = (await db(env, `service_calls?id=eq.${callId}&business_id=eq.${business.id}&select=id,card_id,place,split&limit=1`))[0];
  if (!call || !call.card_id) return;
  const now = new Date().toISOString();
  await db(env, `table_bills?card_id=eq.${call.card_id}&status=eq.open&paid=eq.0`, { method: "PATCH", body: { status: "closed", closed_at: now }, prefer: "return=minimal" });
  await db(env, "table_bills", {
    method: "POST",
    body: {
      business_id: business.id, card_id: call.card_id, place: call.place, amount, split: call.split,
      staff_id: link.staff_id || null, created_by: link.label ? link.label.slice(0, 80) : "персонал"
    },
    prefer: "return=minimal"
  });
  const by = link.label ? link.label.slice(0, 80) : "персонал";
  await db(env, `service_calls?id=eq.${callId}&business_id=eq.${business.id}`, {
    method: "PATCH",
    body: { status: "done", done_at: now, accepted_at: now, accepted_by: by, accepted_staff_id: link.staff_id || null },
    prefer: "return=minimal"
  });
}

// Незакрытые счета за BILL_HOURS часов — для списка персонала
export async function activeBills(env, businessId) {
  const since = encodeURIComponent(new Date(Date.now() - BILL_HOURS * 3600e3).toISOString());
  return db(env, `table_bills?business_id=eq.${businessId}&status=neq.closed&created_at=gt.${since}&select=id,place,amount,paid,status,created_at,created_by&order=created_at.asc&limit=100`).catch(() => []);
}

export async function closeBill(env, businessId, id) {
  await db(env, `table_bills?id=eq.${id}&business_id=eq.${businessId}&status=neq.closed`, {
    method: "PATCH", body: { status: "closed", closed_at: new Date().toISOString() }, prefer: "return=minimal"
  });
}
