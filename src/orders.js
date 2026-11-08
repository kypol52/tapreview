// Заявки с сайта: POST /api/order.
//
// РЕЖИМ «СВОЙ СЕРВЕР В РФ» (ORDERS_DIRECT=1): сайт и база уже в России, поэтому форма отправляет заявку
// прямо сюда — проверяем (чужой сайт, ловушка для роботов, слишком быстрая отправка, частота) и сохраняем.
//
// РЕЖИМ «CLOUDFLARE» (как было): форма отправляет заявку не сюда, а в функцию Yandex Cloud (папка yandex-function/):
// по закону персональные данные сначала записываются в базу в России (Yandex Database). Функция сохраняет
// заявку и пересылает копию сюда с секретом X-Relay-Secret. Здесь копия сохраняется в Supabase
// (для админ-панели → «Заявки») и уходит в Telegram всем чатам из order_recipients.
// Напрямую из браузера сюда заявку отправить нельзя.
//
// Секреты Cloudflare Worker:
//   ORDER_RELAY_SECRET  — общий секрет с функцией (у функции — RELAY_SECRET)
//   ORDER_FUNCTION_URL  — адрес функции: через него удаляем заявку и из российской базы

import { db } from "./supabase.js";
import { tg } from "./telegram.js";
import { TARIFFS, DESIGN_PRICE, EXTRA_CARD_PRICE, MODULE_PRICE, MODULE_KEYS, NETWORK_DISCOUNT, YEAR_MONTHS, EARLY } from "./tariffs.js";

// Цены (прайс 4 ноября 2026) — tariffs.js; те же на главной, в калькуляторе order/index.html и в оферте (п. 3.3–3.4).
// Подписка — за заведение: Start 490 / Plus 990 / Pro 1 990 ₽ в месяц; со второй точки −20%.
// Подключение — за заведение, в него входит пакет карт (5 / 20 / 50); каждая карта сверх пакетов — 199 ₽ разово.
// К Plus — модули «Сервис в зале» и «AI» по 490 ₽ в месяц за точку (в Pro включены).
// Год = 10 месяцев, первый месяц подписки бесплатно, «Свой дизайн» — разово 990 ₽.
// Early Partner: одно заведение, функции Plus, подключение бесплатно с 5 картами (сверх — 150 ₽) и «Своим дизайном»,
// 490 ₽/мес (+ модули) до конца 6-го месяца, оплата помесячно.
export const PRICES = { yearMonths: YEAR_MONTHS, trialMonths: 1 };

// Подписка в месяц: первая точка по полной цене, остальные со скидкой сети
export function monthlyTotal(tariff, venues = 1, modules = []) {
  const t = TARIFFS[tariff] || TARIFFS.standard;
  const perVenue = t.base + (tariff === "standard" ? modules.length * MODULE_PRICE : 0);
  return perVenue + (venues - 1) * Math.round(perVenue * (1 - NETWORK_DISCOUNT));
}
export const PLAN_LABELS = { month: "Месяц", year: "Год" };
// Меняется вместе с текстом согласия (consent/index.html)
const CONSENT_VERSION = "2026-11-01";

const MAX_BODY = 8000;
const MIN_FILL_MS = 3000;

// Форму можно отправить только со своего сайта
function checkOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return;
  const allowed = new Set([new URL(request.url).origin]);
  if (env.PUBLIC_BASE_URL) allowed.add(new URL(env.PUBLIC_BASE_URL).origin);
  if (!allowed.has(origin)) throw new OrderError(403, "Запрос с чужого сайта");
}
const RU_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class OrderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function handleOrder(request, env, ctx) {
  try {
    if (request.method !== "POST") throw new OrderError(405, "Метод не поддерживается");
    const secret = request.headers.get("X-Relay-Secret") || "";
    const relay = Boolean(env.ORDER_RELAY_SECRET) && sameString(secret, env.ORDER_RELAY_SECRET);
    const direct = !relay && env.ORDERS_DIRECT === "1";
    if (!relay && !direct) {
      throw new OrderError(403, "Заявки принимаются через форму на tapreview.ru/order/");
    }
    if (direct) checkOrigin(request, env);

    const text = await request.text();
    if (text.length > MAX_BODY) throw new OrderError(413, "Слишком большой запрос");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new OrderError(400, "Неверный формат данных");
    }
    if (!data || typeof data !== "object") throw new OrderError(400, "Неверный формат данных");

    let order;
    if (direct) {
      // Роботы заполняют скрытое поле или отправляют форму мгновенно — делаем вид, что всё хорошо
      if (String(data.website || "").trim() || Number(data.elapsed) < MIN_FILL_MS) return reply({ ok: true });
      order = validate(data);
    } else {
      if (!RU_ID_RE.test(String(data.ru_id))) throw new OrderError(400, "Нет номера заявки в российской базе");
      order = { ...validate(data), ru_id: String(data.ru_id) };
    }
    await checkRate(env, order);

    const rows = await db(env, "orders?select=id,created_at", {
      method: "POST",
      body: order,
      prefer: "return=representation"
    });
    const saved = { ...order, ...rows[0] };

    ctx.waitUntil(notify(env, saved));
    return reply({ ok: true, id: saved.id });
  } catch (error) {
    if (error instanceof OrderError) return reply({ error: error.message }, error.status);
    console.error(`Order error: ${error.message}\n${error.stack}`);
    return reply({ error: "Не удалось отправить заявку. Попробуйте ещё раз или напишите нам в Telegram." }, 500);
  }
}

// Удалить заявку из российской базы (вызывается при удалении в админ-панели)
export async function deleteRuOrder(env, ruId) {
  if (!ruId) return;
  if (!env.ORDER_FUNCTION_URL || !env.ORDER_RELAY_SECRET) {
    throw new Error("Не заданы ORDER_FUNCTION_URL и ORDER_RELAY_SECRET — не могу удалить заявку из российской базы");
  }
  const response = await fetch(env.ORDER_FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Relay-Secret": env.ORDER_RELAY_SECRET },
    body: JSON.stringify({ action: "delete", ru_id: ruId })
  });
  if (!response.ok) {
    throw new Error(`Не удалось удалить заявку из российской базы (код ${response.status})`);
  }
}

// Сравнение строк за одинаковое время — чтобы секрет нельзя было подобрать по скорости ответа
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clean(value, max, label, required = false) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (required && !text) throw new OrderError(400, `Заполните поле «${label}»`);
  if (text.length > max) throw new OrderError(400, `«${label}»: не больше ${max} символов`);
  return text;
}

// manual — контакт добавлен вручную в админке (личная встреча): галочки согласия с сайта нет
export function validate(data, { manual = false } = {}) {
  const name = clean(data.name, 80, "Имя", true);
  const businessName = clean(data.business_name, 120, "Название заведения", true);
  const city = clean(data.city, 80, "Город");
  const comment = String(data.comment ?? "").trim().slice(0, 1000);

  // В поле заранее стоит «+7» — если дальше ничего не ввели, телефона нет
  let rawPhone = clean(data.phone, 30, "Телефон");
  if (rawPhone.replace(/\D/g, "") === "7") rawPhone = "";
  let digits = rawPhone.replace(/\D/g, "");
  // Набрали 8 после готового «+7»: +7 8900… → +7 900…
  if (digits.length === 12 && digits.startsWith("78")) digits = `7${digits.slice(2)}`;
  if (rawPhone && (digits.length < 10 || digits.length > 15)) {
    throw new OrderError(400, "Проверьте номер телефона");
  }
  const phone = rawPhone ? (rawPhone.trim().startsWith("+") ? "+" : "") + digits : "";

  const telegram = clean(data.telegram, 60, "Telegram")
    .replace(/^https?:\/\/(www\.)?t(elegram)?\.me\//i, "")
    .replace(/^@/, "");
  if (telegram && !/^[A-Za-z0-9_]{4,32}$/.test(telegram)) {
    throw new OrderError(400, "Telegram: укажите имя пользователя, например @tapreview_ru");
  }
  if (!phone && !telegram) throw new OrderError(400, "Укажите телефон или Telegram, чтобы мы могли связаться");

  const venues = Number(data.venues);
  const cards = Number(data.cards);
  if (!Number.isInteger(venues) || venues < 1 || venues > 50) throw new OrderError(400, "Заведений: от 1 до 50");
  if (!Number.isInteger(cards) || cards < venues || cards > 500) {
    throw new OrderError(400, "Карт: не меньше, чем заведений, и не больше 500");
  }
  const plan = data.plan === "year" ? "year" : data.plan === "month" ? "month" : null;
  if (!plan) throw new OrderError(400, "Выберите оплату: месяц или год");
  // Тариф и «Свой дизайн» (миграция 033); старые формы без поля — Plus
  let tariff = TARIFFS[data.tariff] ? data.tariff : "standard";
  // Модули к Plus (миграция 049); в Pro включены, в Start недоступны
  const modules = tariff === "standard"
    ? [...new Set((Array.isArray(data.modules) ? data.modules : []).filter((m) => MODULE_KEYS.includes(m)))]
    : [];
  // Early Partner: одно заведение, функции Plus, помесячно
  const early = data.early === true;
  if (early) {
    if (venues !== 1) throw new OrderError(400, "Early Partner — для одного заведения. Для сети выберите обычный тариф");
    if (plan !== "month") throw new OrderError(400, "Early Partner оплачивается помесячно");
    tariff = "standard";
  }
  const customDesign = data.custom_design === true || early;
  if (!manual && data.consent !== true) throw new OrderError(400, "Нужно согласие на обработку персональных данных");

  const totals = orderTotals({ venues, cards, plan, tariff, custom_design: customDesign, modules, early });
  if (manual) {
    return {
      name,
      phone: phone || null,
      telegram: telegram || null,
      business_name: businessName,
      city: city || null,
      comment: comment || null,
      venues,
      cards,
      plan,
      tariff,
      modules,
      early,
      custom_design: customDesign,
      total_now: totals.now,
      total_next: totals.next,
      source: "manual",
      consent_at: null,
      consent_version: null
    };
  }
  return {
    name,
    phone: phone || null,
    telegram: telegram || null,
    business_name: businessName,
    city: city || null,
    comment: comment || null,
    venues,
    cards,
    plan,
    tariff,
    modules,
    early,
    custom_design: customDesign,
    total_now: totals.now,
    total_next: totals.next,
    consent_at: new Date().toISOString(),
    consent_version: CONSENT_VERSION
  };
}

// Первый месяц бесплатно: при заказе платится только подключение (и «Свой дизайн»), подписка — после него.
// extra — карты сверх пакетов всех заведений
export function orderTotals({ venues = 1, cards, plan, tariff = "standard", custom_design = false, modules = [], early = false }) {
  const v = Math.max(1, venues);
  const n = Math.max(v, cards);
  if (early) {
    const extra = Math.max(0, n - EARLY.cards);
    const connection = EARLY.connection + extra * EARLY.extraCard;
    const monthly = EARLY.monthly + modules.length * MODULE_PRICE;
    return { connection, design: 0, extra, monthly, subscription: monthly, now: connection, next: monthly };
  }
  const t = TARIFFS[tariff] || TARIFFS.standard;
  const extra = Math.max(0, n - t.cards * v);
  const connection = t.connection * v + extra * EXTRA_CARD_PRICE;
  const monthly = monthlyTotal(tariff, v, modules);
  const subscription = plan === "year" ? monthly * YEAR_MONTHS : monthly;
  const design = custom_design ? DESIGN_PRICE : 0;
  return { connection, design, extra, monthly, subscription, now: connection + design, next: subscription };
}

async function checkRate(env, order) {
  const since = encodeURIComponent(new Date(Date.now() - 10 * 60 * 1000).toISOString());
  const minute = encodeURIComponent(new Date(Date.now() - 60 * 1000).toISOString());
  const contact = order.phone
    ? `phone.eq.${encodeURIComponent(order.phone)}`
    : `telegram.eq.${encodeURIComponent(order.telegram)}`;
  const [same, all] = await Promise.all([
    db(env, `orders?created_at=gt.${since}&or=(${contact})&select=id`),
    db(env, `orders?created_at=gt.${minute}&select=id`)
  ]);
  if (same.length >= 3 || all.length >= 20) {
    throw new OrderError(429, "Заявка уже отправлена. Мы скоро свяжемся с вами!");
  }
}

// ---------- Уведомление в Telegram ----------

async function notify(env, order) {
  try {
    const chats = await db(env, "order_recipients?select=chat_id");
    if (!chats.length) {
      console.log(`Order #${order.id}: no Telegram recipients — see admin panel → Заявки`);
      return;
    }
    let delivered = false;
    for (const { chat_id: chatId } of chats) {
      try {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: orderText(order, env),
          parse_mode: "HTML",
          disable_web_page_preview: true
        });
        delivered = true;
      } catch (error) {
        console.error(`Order #${order.id} to ${chatId}: ${error.message}`);
      }
    }
    if (delivered) {
      await db(env, `orders?id=eq.${order.id}`, {
        method: "PATCH",
        body: { tg_delivered: true },
        prefer: "return=minimal"
      });
    }
  } catch (error) {
    console.error(`Order #${order.id} notify failed: ${error.message}`);
  }
}

// Уведомление БЕЗ персональных данных: Telegram (и посредник) за рубежом, а данные заявителя
// (имя, телефон, Telegram, название заведения, комментарий) остаются только в базе в России —
// их смотрят в админ-панели. Так нет трансграничной передачи данных заявителей.
export function orderText(o, env = {}) {
  const rub = (n) => `${Number(n).toLocaleString("ru-RU")} ₽`;
  const t = orderTotals(o);
  const admin = `${String(env.PUBLIC_BASE_URL || "https://tapreview.ru").replace(/\/+$/, "")}/admin/`;
  return [
    `🆕 <b>Заявка №${o.id}</b>`,
    `🃏 Карт: <b>${o.cards}</b> · заведений: <b>${o.venues}</b> · тариф: <b>${o.early ? "Early Partner" : (TARIFFS[o.tariff] || TARIFFS.standard).label}</b>, оплата за ${o.plan === "year" ? "год" : "месяц"}` +
      ((o.modules || []).length ? ` · модули: <b>${o.modules.map((m) => (m === "ai" ? "AI" : "Сервис в зале")).join(", ")}</b>` : "") +
      (o.custom_design && !o.early ? " · <b>+ свой дизайн</b>" : ""),
    `💳 При заказе: <b>${rub(t.now)}</b> (подключение${o.custom_design && !o.early ? " и дизайн" : ""}) · месяц бесплатно, дальше ${rub(t.next)} ${o.plan === "year" ? "в год" : "в месяц"}`,
    `👉 Контакты и детали — в админке: <a href="${esc(admin)}">${esc(admin.replace(/^https?:\/\//, ""))}</a> → «Заявки»`
  ].join("\n");
}

// ---------- Напоминания воронки (каждый день в 09:00 по Москве) ----------

// Сегодняшняя дата по Москве (UTC+3, без перехода на летнее время)
export function todayMsk(now = Date.now()) {
  return new Date(now + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Только номера заявок и шаги без имён и телефонов — данные заявителей остаются в России
export async function orderReminders(env) {
  const today = todayMsk();
  const due = await db(
    env,
    `orders?status=not.in.(done,rejected)&next_at=lte.${today}` +
      `&or=(reminded_on.is.null,reminded_on.lt.${today})&select=id,next_at&order=next_at.asc,id.asc&limit=50`
  );
  if (!due.length) return { sent: 0 };
  const chats = await db(env, "order_recipients?select=chat_id");
  if (!chats.length) return { sent: 0 };

  const admin = `${String(env.PUBLIC_BASE_URL || "https://tapreview.ru").replace(/\/+$/, "")}/admin/`;
  const late = due.filter((o) => o.next_at < today).map((o) => `№${o.id}`);
  const now = due.filter((o) => o.next_at === today).map((o) => `№${o.id}`);
  const text = [
    "⏰ <b>Задачи по заявкам</b>",
    now.length ? `На сегодня: ${now.join(", ")}` : "",
    late.length ? `Просрочено: ${late.join(", ")}` : "",
    `👉 Что сделать — в админке: <a href="${esc(admin)}">${esc(admin.replace(/^https?:\/\//, ""))}</a> → «Заявки» → «На сегодня»`
  ].filter(Boolean).join("\n");

  let sent = 0;
  for (const { chat_id: chatId } of chats) {
    try {
      await tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
      sent++;
    } catch (error) {
      console.error(`Order reminder to ${chatId}: ${error.message}`);
    }
  }
  if (sent) {
    await db(env, `orders?id=in.(${due.map((o) => o.id).join(",")})`, {
      method: "PATCH",
      body: { reminded_on: today },
      prefer: "return=minimal"
    });
  }
  return { sent, orders: due.length };
}

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
