// Модуль «Сервис в зале» (миграция 042): гость за столом зовёт сотрудника с карты на столе.
//
//   Страница карты /c/КОД (карта с галочкой «Стол» в админке, модуль включён, гость пришёл с NFC/QR):
//     блок «Стол 5» и три кнопки — «Позвать официанта», «Попросить счёт» (одним или разделить на 2–6), «Нужна помощь».
//   GET /call?c=КОД&t=waiter|bill|help[&n=2]&s=nfc|qr — создать вызов (обычная ссылка, без скриптов, как подарок:
//     обычный переход браузер повторяет сам, если связь оборвалась). Повтор того же вызова, пока его не выполнили,
//     нового не создаёт — показывает статус; страница сама обновляется, пока вызов не приняли.
//   /k/ТОКЕН/calls — страница вызовов для персонала (та же ссылка, что у кассы подарков): список, звук, «Принял», «Готово».
//     GET ?format=json — список для обновления без перезагрузки; POST id=&do=accept|done — сменить статус.
//   Telegram: вызов уходит в чаты заведения с галочкой «Вызовы гостей» (tg_subscribers.service_calls).
//
// Защита от шуток: только с cookie устройства (ставится при открытии страницы с карты), не больше
// CALLS_PER_HOUR вызовов с одного телефона в час и BUSINESS_PER_10MIN на заведение за 10 минут.

import { db } from "./supabase.js";
import { isBot } from "./analytics.js";
import { deviceFrom, visitorKeyOf } from "./guests.js";
import { hasModule } from "./tariffs.js";
import { isExpired } from "./billing.js";
import { renderPage, escapeHtml, customDesign, DEFAULT_ACCENT } from "./public-page.js";
import { html, esc, notFound, TOKEN_RE } from "./stats-page.js";
import { tg } from "./telegram.js";

export const CALL_KINDS = {
  waiter: { label: "Позвать официанта", icon: "🙋", tg: "зовут официанта", staff: "Зовут официанта" },
  bill: { label: "Попросить счёт", icon: "🧾", tg: "просят счёт", staff: "Просят счёт" },
  help: { label: "Нужна помощь", icon: "💬", tg: "нужна помощь", staff: "Нужна помощь" }
};
const SPLITS = [2, 3, 4, 5, 6];
const ACTIVE_MINUTES = 60; // вызов старше часа считаем забытым: не показываем персоналу и не мешаем позвать снова
const REPEAT_AFTER_DONE_MS = 2 * 60 * 1000; // после «Готово» тот же вызов с того же телефона — не раньше чем через 2 минуты
const CALLS_PER_HOUR = 8;
const BUSINESS_PER_10MIN = 60;
const KEEP_DAYS = 180;
const CODE_RE = /^[A-Z0-9]{4,12}$/;

// Название стола: подпись карты в админке («Стол 5»), иначе номер карты
export function placeOf(card) {
  const label = String(card.label || "").trim();
  return label || `Стол ${card.code.length === 6 ? `${card.code.slice(0, 3)}-${card.code.slice(3)}` : card.code}`;
}

// Включено ли на этой карте: модуль у заведения + карта-стол + гость пришёл с карты (не по прямой ссылке)
export function callsOn(business, card, source) {
  return Boolean(card && card.is_table && hasModule(business, "service") && (source === "nfc" || source === "qr"));
}

// ---------- Блок на странице стола ----------

// menu — у заведения есть меню (menu.js): под кнопками вызова — «Меню и заказ»
export function serviceBlock(business, card, source, { menu = false } = {}) {
  if (!callsOn(business, card, source)) return "";
  const menuLink = menu
    ? `<a class="svc-menu" href="${escapeHtml(`/menu/${business.slug}?c=${card.code}&s=${source}`)}">📖 Меню и заказ</a>`
    : "";
  const href = (kind, n) => {
    const p = new URLSearchParams({ c: card.code, t: kind, s: source });
    if (n) p.set("n", String(n));
    return escapeHtml(`/call?${p}`);
  };
  const splits = SPLITS.map((n) => `<a class="svc-split" href="${href("bill", n)}" rel="nofollow">на ${n}</a>`).join("");
  return `
    <section class="svc" aria-label="Вызвать сотрудника">
      <p class="svc-place">${escapeHtml(placeOf(card))}</p>
      <div class="svc-row">
        <a class="svc-btn" href="${href("waiter")}" rel="nofollow"><span class="svc-icon" aria-hidden="true">${CALL_KINDS.waiter.icon}</span>${CALL_KINDS.waiter.label}</a>
        <details class="svc-bill">
          <summary class="svc-btn"><span class="svc-icon" aria-hidden="true">${CALL_KINDS.bill.icon}</span>${CALL_KINDS.bill.label}</summary>
          <div class="svc-bill-menu">
            <a class="svc-split svc-split-one" href="${href("bill", 1)}" rel="nofollow">Одним счётом</a>
            <p class="svc-bill-q">Разделить счёт</p>
            <div class="svc-splits">${splits}</div>
          </div>
        </details>
        <a class="svc-btn" href="${href("help")}" rel="nofollow"><span class="svc-icon" aria-hidden="true">${CALL_KINDS.help.icon}</span>${CALL_KINDS.help.label}</a>
      </div>
      ${menuLink}
    </section>`;
}

export const SERVICE_CSS = `
  .svc { margin: 4px 0 22px; text-align: center; }
  .svc-place { display: inline-block; margin: 0 0 10px; padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 600;
    color: var(--text); background: var(--btn-bg); border: 1px solid var(--btn-border); }
  .svc-row { position: relative; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; align-items: start; }
  .svc-btn { display: flex; flex-direction: column; align-items: center; gap: 4px; min-height: 76px; justify-content: center;
    padding: 10px 6px; border-radius: 16px; border: 1px solid var(--btn-border); background: var(--btn-bg); color: var(--btn-text);
    font-size: 13px; font-weight: 600; line-height: 1.2; text-decoration: none; cursor: pointer; list-style: none; }
  .svc-btn::-webkit-details-marker { display: none; }
  .svc-btn:hover, .svc-btn:focus-visible { border-color: var(--accent); }
  .svc-icon { font-size: 22px; line-height: 1; }
  .svc-bill[open] > .svc-btn { border-color: var(--accent); }
  /* Меню счёта — во всю ширину ряда кнопок, поверх содержимого ниже */
  .svc-bill-menu { position: absolute; left: 0; right: 0; top: calc(100% + 8px); z-index: 5; padding: 12px; border-radius: 16px;
    border: 1px solid var(--accent); background: var(--card); box-shadow: 0 14px 36px var(--card-shadow, rgba(0, 0, 0, 0.18)); }
  .svc-bill-q { margin: 10px 0 6px; font-size: 12px; color: var(--muted); }
  .svc-splits { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
  .svc-split { display: inline-block; padding: 8px 12px; border-radius: 999px; border: 1px solid var(--btn-border); background: var(--btn-bg);
    color: var(--btn-text); font-size: 13px; font-weight: 600; text-decoration: none; }
  .svc-split-one { display: block; padding: 11px 12px; }
  .svc-split:hover { border-color: var(--accent); }
  .svc-menu { display: block; margin-top: 8px; padding: 13px 16px; border-radius: 16px; background: var(--text); color: var(--card);
    font-weight: 700; text-decoration: none; }
  .svc-status { margin: 6px 0 18px; }
  .svc-big { font-size: 46px; line-height: 1; margin: 6px 0 10px; }
  .svc-state { display: inline-block; margin-top: 4px; padding: 6px 14px; border-radius: 999px; font-size: 14px; font-weight: 600;
    background: var(--btn-bg); border: 1px solid var(--btn-border); }
  .svc-state-ok { border-color: #22a06b; color: #22a06b; }
  .svc-back { display: inline-block; margin-top: 16px; color: var(--muted); font-size: 14px; }
`;

// ---------- GET /call — гость нажал кнопку ----------

export async function handleCall(request, env, ctx) {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") return guestPage(405, null, "Откройте страницу с карты ещё раз");
    if (isBot(request)) return guestPage(403, null, "Вызов недоступен");
    const url = new URL(request.url);
    const code = String(url.searchParams.get("c") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const kind = String(url.searchParams.get("t") || "");
    const source = url.searchParams.get("s") === "qr" ? "qr" : "nfc";
    const n = Number(url.searchParams.get("n"));
    if (!CODE_RE.test(code) || !CALL_KINDS[kind]) return guestPage(404, null, "Ссылка повреждена — коснитесь карты на столе ещё раз");
    const split = kind === "bill" && Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;

    const cards = await db(env, `cards?code=eq.${code}&is_active=is.true&select=id,code,label,is_table,business_id&limit=1`);
    const card = cards[0];
    const business = card && card.business_id
      ? (await db(env, `businesses?id=eq.${card.business_id}&is_active=eq.true&select=id,slug,name,theme,design,brand_color,paid_until,modules,tariff&limit=1`))[0]
      : null;
    if (!business || !callsOn(business, card, source) || isExpired(business.paid_until)) {
      return guestPage(404, business, "Вызов с этой карты сейчас недоступен. Обратитесь, пожалуйста, к персоналу.");
    }
    const back = `/c/${card.code}?s=${source}`;

    // Cookie ставится, когда страницу стола открыли с карты. Без неё — ссылку открыли не со стола (или из превью)
    const { deviceId, setCookie } = deviceFrom(request);
    if (setCookie) return guestPage(400, business, "Коснитесь карты на столе ещё раз и нажмите кнопку.", back);
    const visitor = await visitorKeyOf(env, deviceId, business.id);

    const since = (ms) => encodeURIComponent(new Date(Date.now() - ms).toISOString());
    const [open, mineDone] = await Promise.all([
      db(env, `service_calls?card_id=eq.${card.id}&kind=eq.${kind}&status=neq.done&created_at=gt.${since(ACTIVE_MINUTES * 60e3)}&select=id,status,split,created_at&order=created_at.desc&limit=1`),
      db(env, `service_calls?card_id=eq.${card.id}&kind=eq.${kind}&visitor_hash=eq.${visitor}&status=eq.done&done_at=gt.${since(REPEAT_AFTER_DONE_MS)}&select=id&limit=1`)
    ]);
    // Уже позвали с этого стола — не дублируем, показываем статус (сменилось число счетов — запоминаем новое)
    if (open.length) {
      const call = open[0];
      if (split && split !== call.split) {
        await db(env, `service_calls?id=eq.${call.id}`, { method: "PATCH", body: { split }, prefer: "return=minimal" });
        call.split = split;
      }
      return statusPage(business, card, kind, call, back);
    }
    if (mineDone.length) return statusPage(business, card, kind, { status: "done", split }, back);

    const [mine, all] = await Promise.all([
      db(env, `service_calls?business_id=eq.${business.id}&visitor_hash=eq.${visitor}&created_at=gt.${since(3600e3)}&select=id`),
      db(env, `service_calls?business_id=eq.${business.id}&created_at=gt.${since(600e3)}&select=id`)
    ]);
    if (mine.length >= CALLS_PER_HOUR || all.length >= BUSINESS_PER_10MIN) {
      return guestPage(429, business, "Слишком много вызовов подряд. Подойдите, пожалуйста, к персоналу.", back);
    }

    const place = placeOf(card);
    const rows = await db(env, "service_calls?select=id,status,split,created_at", {
      method: "POST",
      body: { business_id: business.id, card_id: card.id, place, kind, split, visitor_hash: visitor },
      prefer: "return=representation"
    });
    ctx.waitUntil(notifyChats(env, business, { place, kind, split }));
    return statusPage(business, card, kind, rows[0], back);
  } catch (error) {
    console.error(`Service call error: ${error.message}\n${error.stack}`);
    return guestPage(500, null, "Не получилось отправить вызов. Попробуйте ещё раз или подойдите к персоналу.");
  }
}

function splitText(split) {
  if (!split) return "";
  return split === 1 ? "одним счётом" : `разделить на ${split}`;
}

function statusPage(business, card, kind, call, back) {
  const k = CALL_KINDS[kind];
  const split = kind === "bill" && call.split ? ` · ${splitText(call.split)}` : "";
  const state = call.status === "accepted"
    ? `<p class="svc-state svc-state-ok">✓ Сотрудник принял вызов</p>`
    : call.status === "done"
      ? `<p class="svc-state svc-state-ok">✓ Готово</p>`
      : `<p class="svc-state">Передали персоналу — сейчас подойдут</p>`;
  const lead = call.status === "done"
    ? "Если нужно что-то ещё — вернитесь на страницу стола через пару минут."
    : "Эту страницу можно не закрывать: она обновится сама, когда сотрудник примет вызов.";
  // Пока вызов не приняли — страница обновляется сама (без скриптов)
  const meta = call.status === "new" ? `<meta http-equiv="refresh" content="15">` : "";
  return themed(business, {
    title: `${k.label} — ${business.name}`,
    meta,
    body: `
      <h1 class="name name-mid">${escapeHtml(business.name)}</h1>
      <p class="tagline">${escapeHtml(placeOf(card))}</p>
      <div class="divider"></div>
      <section class="svc-status">
        <div class="svc-big" aria-hidden="true">${k.icon}</div>
        <h2 class="thanks">${escapeHtml(k.label)}${escapeHtml(split)}</h2>
        ${state}
        <p class="lead">${lead}</p>
      </section>
      <a class="svc-back" href="${escapeHtml(back)}">← На страницу стола</a>`
  });
}

function guestPage(status, business, text, back = null) {
  const page = themed(business, {
    status,
    title: "Вызов сотрудника",
    body: `
      <h2 class="thanks">Вызов сотрудника</h2>
      <p class="lead">${escapeHtml(text)}</p>
      ${back ? `<a class="svc-back" href="${escapeHtml(back)}">← На страницу стола</a>` : ""}`
  });
  return page;
}

function themed(business, { status = 200, title, body, meta = "" }) {
  const response = renderPage({
    status,
    title,
    accent: business && /^#[0-9A-Fa-f]{6}$/.test(business.brand_color || "") ? business.brand_color : (business ? null : DEFAULT_ACCENT),
    theme: business ? business.theme : "classic",
    design: business ? customDesign(business) : null,
    extraCss: SERVICE_CSS,
    meta,
    // Как на странице заведения: зелёная кнопка «Работает на TapReview / Хочу такую карту»
    footer: business ? { href: `/r/${business.slug}?s=card`, text: "Хочу такую карту" } : null,
    body
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

// ---------- Telegram ----------

async function notifyChats(env, business, { place, kind, split }) {
  try {
    const chats = await db(env, `tg_subscribers?business_id=eq.${business.id}&service_calls=is.true&select=chat_id`);
    if (!chats.length) return;
    const k = CALL_KINDS[kind];
    const extra = kind === "bill" && split ? ` (${splitText(split)})` : "";
    const text = `${k.icon} <b>${escapeHtml(place)}</b> — ${k.tg}${escapeHtml(extra)}\n${escapeHtml(business.name)}`;
    await Promise.all(
      chats.map((c) =>
        tg(env, "sendMessage", { chat_id: c.chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }).catch((error) =>
          console.error(`Вызов в Telegram ${c.chat_id}: ${error.message}`)
        )
      )
    );
  } catch (error) {
    console.error(`Вызов в Telegram: ${error.message}`);
  }
}

// ---------- /k/ТОКЕН/calls — персонал ----------

export async function handleStaffCalls(request, env, token) {
  try {
    if (!TOKEN_RE.test(token)) return notFound();
    const links = await db(env, `staff_links?token=eq.${token}&select=business_id,label,staff_id`);
    if (!links.length) return notFound();
    const link = links[0];
    const business = (await db(env, `businesses?id=eq.${link.business_id}&select=id,name,modules,tariff,bonus_mode&limit=1`))[0];
    if (!business) return notFound();
    const base = `/k/${token}/calls`;
    if (!hasModule(business, "service")) {
      return html(200, "Вызовы гостей", `<main class="wrap wrap-center"><section class="panel">
        <h1 class="lost">Вызовы гостей не подключены</h1>
        <p>Модуль «Сервис в зале» для этого заведения выключен. Чтобы подключить, напишите в TapReview.</p>
        <a class="back back-dark" href="/k/${token}">← Касса подарков</a></section></main>`);
    }

    const url = new URL(request.url);
    const wantsJson = url.searchParams.get("format") === "json" || (request.headers.get("Accept") || "").includes("application/json");

    if (request.method === "POST") {
      const form = new URLSearchParams((await request.text()).slice(0, 500));
      const id = Number(form.get("id"));
      const action = form.get("do");
      // t=order — заказ со стола (menu.js), иначе вызов
      const table = form.get("t") === "order" ? "table_orders" : "service_calls";
      if (Number.isSafeInteger(id) && id > 0 && (action === "accept" || action === "done")) {
        const now = new Date().toISOString();
        const by = link.label ? link.label.slice(0, 80) : "персонал";
        // Ссылка привязана к сотруднику (staff.js) — вызов засчитывается ему
        const who = { accepted_at: now, accepted_by: by, accepted_staff_id: link.staff_id || null };
        const body = action === "accept"
          ? { status: "accepted", ...who }
          : { status: "done", done_at: now };
        // Только вызовы своего заведения; «Принял» — только у нового, у принятого время не меняем
        const filter = action === "accept" ? "&status=eq.new" : "&status=neq.done";
        await db(env, `${table}?id=eq.${id}&business_id=eq.${business.id}${filter}`, { method: "PATCH", body, prefer: "return=minimal" });
        // «Готово» без «Принял» — считаем принятым в тот же момент (для времени реакции)
        if (action === "done") {
          await db(env, `${table}?id=eq.${id}&business_id=eq.${business.id}&accepted_at=is.null`, {
            method: "PATCH", body: who, prefer: "return=minimal"
          });
        }
        db(env, `staff_links?token=eq.${token}`, { method: "PATCH", body: { last_used_at: now }, prefer: "return=minimal" }).catch(() => {});
      }
      if (wantsJson) return callsJson(env, business);
      return new Response(null, { status: 303, headers: { Location: base, "Cache-Control": "no-store" } });
    }

    if (wantsJson) return callsJson(env, business);
    const calls = await activeCalls(env, business.id);
    const gifts = business.bonus_mode && business.bonus_mode !== "off";
    const body = `
  <style>${STAFF_CSS}</style>
  <header class="top">
    <div class="top-inner">
      <div class="brand">TapReview <span>· вызовы</span></div>
      ${gifts ? `<a class="back" href="/k/${token}">🎁 Касса подарков</a>` : ""}
      <h1 class="name">Вызовы гостей</h1>
      <p class="sub">${esc(business.name)}</p>
      <p class="range">Новые вызовы появляются сами, со звуком. Держите страницу открытой.</p>
    </div>
  </header>
  <main class="wrap">
    <button class="calls-sound" type="button" hidden>🔔 Включить звук</button>
    <section class="panel"><div id="calls" aria-live="polite">${callsList(calls, base)}</div></section>
    <section class="note">
      <p><b>Принял</b> — гость увидит, что вы идёте. <b>Готово</b> — вызов закрыт. Вызов старше часа исчезает сам.</p>
      <p>Это рабочая ссылка персонала. Не передавайте её гостям.</p>
    </section>
  </main>`;
    return html(200, "Вызовы гостей", body, STAFF_SCRIPT);
  } catch (error) {
    console.error(`Staff calls error: ${error.message}\n${error.stack}`);
    return html(500, "Ошибка", `<main class="wrap wrap-center"><section class="panel"><h1 class="lost">Не удалось загрузить вызовы</h1><p>Обновите страницу через минуту.</p></section></main>`);
  }
}

// Вызовы (за час) и заказы со стола (за 3 часа, menu.js) — один список по времени; uid: c123 / o45
async function activeCalls(env, businessId) {
  const since = (min) => encodeURIComponent(new Date(Date.now() - min * 60e3).toISOString());
  const [calls, orders] = await Promise.all([
    db(env, `service_calls?business_id=eq.${businessId}&status=neq.done&created_at=gt.${since(ACTIVE_MINUTES)}&select=id,place,kind,split,status,accepted_by,created_at,accepted_at&order=created_at.asc&limit=100`),
    db(env, `table_orders?business_id=eq.${businessId}&status=neq.done&created_at=gt.${since(ACTIVE_MINUTES * 3)}&select=id,place,items,total,comment,status,accepted_by,created_at,accepted_at&order=created_at.asc&limit=100`).catch(() => [])
  ]);
  return [
    ...calls.map((c) => ({ ...c, type: "call", uid: `c${c.id}` })),
    ...orders.map((o) => ({ ...o, type: "order", uid: `o${o.id}` }))
  ].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

async function callsJson(env, business) {
  const calls = await activeCalls(env, business.id);
  return new Response(JSON.stringify({ ids: calls.filter((c) => c.status === "new").map((c) => c.uid), count: calls.length, html: callsList(calls, null) }), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}

function ago(iso, now = Date.now()) {
  const min = Math.max(0, Math.floor((now - Date.parse(iso)) / 60e3));
  return min < 1 ? "только что" : `${min} мин назад`;
}

// base = null → формы отправляет скрипт (адрес берётся из страницы)
function callsList(calls, base) {
  if (!calls.length) return `<p class="calls-empty">Сейчас вызовов нет 👌</p>`;
  const action = base ? ` action="${esc(base)}"` : "";
  return `<ul class="calls">${calls
    .map((c) => {
      const accepted = c.status === "accepted";
      const button = (todo, text, cls) =>
        `<form method="post"${action}><input type="hidden" name="t" value="${c.type}"><input type="hidden" name="id" value="${c.id}"><input type="hidden" name="do" value="${todo}"><button class="${cls}" type="submit">${text}</button></form>`;
      let what;
      if (c.type === "order") {
        const lines = (c.items || []).map((l) => `<li>${esc(l.name)} × ${l.qty}</li>`).join("");
        what = `<p class="call-what">🧾 Заказ · ${Number(c.total).toLocaleString("ru-RU")} ₽</p><ul class="call-lines">${lines}</ul>${c.comment ? `<p class="call-meta">«${esc(c.comment)}»</p>` : ""}`;
      } else {
        const k = CALL_KINDS[c.kind] || CALL_KINDS.help;
        const split = c.kind === "bill" && c.split ? ` · ${splitText(c.split)}` : "";
        what = `<p class="call-what">${k.icon} ${esc(k.staff)}${esc(split)}</p>`;
      }
      return `<li class="call${accepted ? " call-taken" : " call-new"}" data-id="${c.uid}">
        <div class="call-main">
          <p class="call-place">${esc(c.place)}</p>
          ${what}
          <p class="call-meta">${esc(ago(c.created_at))}${accepted ? ` · принял${c.accepted_by ? `: ${esc(c.accepted_by)}` : ""}` : ""}</p>
        </div>
        <div class="call-actions">
          ${accepted ? "" : button("accept", "Принял", "call-accept")}
          ${button("done", "Готово", "call-done")}
        </div>
      </li>`;
    })
    .join("")}</ul>`;
}

const STAFF_CSS = `
  .calls { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .call { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 14px; border-radius: 16px; border: 1px solid #e3e7ef; background: #fff; }
  .call-new { border-color: #e5aa0c; background: #fff8e6; box-shadow: 0 0 0 3px rgba(229, 170, 12, 0.18); }
  .call-place { margin: 0; font-size: 20px; font-weight: 800; color: #0a2a5c; }
  .call-what { margin: 2px 0 0; font-size: 15px; font-weight: 600; color: #141a2b; }
  .call-lines { margin: 4px 0 0; padding-left: 18px; font-size: 14px; color: #141a2b; }
  .call-meta { margin: 4px 0 0; font-size: 12px; color: #6b7280; }
  .call-actions { display: flex; flex-direction: column; gap: 6px; flex: none; }
  .call-actions form { margin: 0; }
  .call-actions button { min-width: 104px; padding: 10px 12px; border-radius: 12px; border: 0; font: inherit; font-weight: 700; cursor: pointer; }
  .call-accept { background: #0a2a5c; color: #fff; }
  .call-done { background: #eaf6ef; color: #137a4d; }
  .calls-empty { margin: 8px 0; text-align: center; color: #6b7280; font-size: 15px; }
  .calls-sound { display: block; width: 100%; margin: 0 0 12px; padding: 12px; border-radius: 14px; border: 1px dashed #e5aa0c; background: #fffaf0; color: #8a6400; font: inherit; font-weight: 700; cursor: pointer; }
`;

// Обновление списка каждые 5 секунд, звук и вибрация на новый вызов, «Принял»/«Готово» без перезагрузки.
// Браузер разрешает звук только после касания страницы — для этого кнопка «Включить звук».
const STAFF_SCRIPT = `(function () {
  var box = document.getElementById("calls");
  var soundBtn = document.querySelector(".calls-sound");
  var base = location.pathname;
  var seen = {};
  var audio = null;
  document.querySelectorAll(".call-new").forEach(function (li) { seen[li.getAttribute("data-id")] = true; });
  function unlock() {
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch (e) {}
    soundBtn.hidden = true;
  }
  soundBtn.hidden = false;
  soundBtn.addEventListener("click", function () { unlock(); beep(); });
  document.addEventListener("click", unlock, { once: true });
  function beep() {
    if (!audio) return;
    [0, 0.25].forEach(function (t) {
      var o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.0001, audio.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.4, audio.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + t + 0.2);
      o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.22);
    });
  }
  function apply(data) {
    box.innerHTML = data.html;
    var fresh = data.ids.some(function (id) { return !seen[id]; });
    data.ids.forEach(function (id) { seen[id] = true; });
    document.title = (data.count ? "(" + data.count + ") " : "") + "Вызовы гостей";
    if (fresh) { beep(); if (navigator.vibrate) navigator.vibrate([200, 100, 200]); }
  }
  function refresh() {
    fetch(base + "?format=json", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d) apply(d); }).catch(function () {});
  }
  box.addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target;
    form.querySelector("button").disabled = true;
    fetch(base, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(new FormData(form)).toString() })
      .then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d) apply(d); else refresh(); }).catch(refresh);
  });
  setInterval(refresh, 5000);
})();`;

// ---------- Статистика владельцу (/s/…) ----------

// Вызовы за период: всего, по видам, медиана времени до «Принял», не принятые, столы с наибольшим числом вызовов
// from, to — миллисекунды (report.js periodRange)
export async function serviceStats(env, ids, { from, to }) {
  const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());
  const rows = await db(
    env,
    `service_calls?business_id=in.(${ids.join(",")})&created_at=gte.${iso(from)}&created_at=lte.${iso(to)}` +
      "&select=place,kind,status,created_at,accepted_at&limit=20000"
  );
  const byKind = { waiter: 0, bill: 0, help: 0 };
  const places = new Map();
  const waits = [];
  let missed = 0;
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    places.set(r.place, (places.get(r.place) || 0) + 1);
    if (r.accepted_at) waits.push((Date.parse(r.accepted_at) - Date.parse(r.created_at)) / 1000);
    else missed++;
  }
  waits.sort((a, b) => a - b);
  const median = waits.length ? waits[Math.floor(waits.length / 2)] : null;
  const top = [...places.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return { total: rows.length, byKind, median, missed, top };
}

export function serviceSection(s) {
  if (!s || !s.total) return "";
  const time = s.median === null ? "—" : s.median < 60 ? `${Math.round(s.median)} с` : `${Math.round(s.median / 60)} мин`;
  const kinds = Object.entries(CALL_KINDS)
    .map(([key, k]) => `<tr><td>${k.icon} ${esc(k.staff)}</td><td>${s.byKind[key] || 0}</td></tr>`)
    .join("");
  const top = s.top.map(([place, n]) => `<tr><td>${esc(place)}</td><td>${n}</td></tr>`).join("");
  return `
    <section class="panel">
      <h2>Вызовы персонала</h2>
      <div class="kpis desk-kpis">
        <div class="kpi"><div class="kpi-label">Вызовов</div><div class="kpi-value">${s.total}</div></div>
        <div class="kpi"><div class="kpi-label">Реакция (медиана)</div><div class="kpi-value">${time}</div></div>
      </div>
      ${s.missed ? `<p>Не приняли на странице вызовов: ${s.missed}. Возможно, подошли без отметки — попросите персонал нажимать «Принял».</p>` : ""}
      <table class="desk-table"><thead><tr><th>Что просили</th><th>Раз</th></tr></thead><tbody>${kinds}</tbody></table>
      ${top ? `<table class="desk-table"><thead><tr><th>Чаще всего зовут</th><th>Раз</th></tr></thead><tbody>${top}</tbody></table>` : ""}
    </section>`;
}

// ---------- Ежедневная очистка ----------

export async function purgeOldCalls(env) {
  const before = encodeURIComponent(new Date(Date.now() - KEEP_DAYS * 86400000).toISOString());
  await db(env, `service_calls?created_at=lt.${before}`, { method: "DELETE", prefer: "return=minimal" });
}
