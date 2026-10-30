// Заявки с сайта: POST /api/order (страница tapreview.ru/order/ — калькулятор и форма).
// Заявка сохраняется в базе и сразу приходит в Telegram всем чатам из order_recipients
// (чаты подключаются в админ-панели → «Заявки» → «Получать заявки в Telegram»).
//
// Защита от спама: скрытое поле-ловушка, слишком быстрая отправка, не больше 3 заявок
// с одного контакта за 10 минут и не больше 20 заявок в минуту всего. IP-адреса не сохраняем.

import { db } from "./supabase.js";
import { tg } from "./telegram.js";

// Приём заявок включается, когда опубликованы политика и согласие (privacy/, consent/)
// с данными оператора. Вместе с этим — FORM_ENABLED = true в order/index.html.
const ORDERS_OPEN = false;

// Цены — те же, что на главной и на странице заказа (order/index.html)
export const PRICES = { card: 100, month: 200, year: 2000 };
export const PLAN_LABELS = { month: "Месяц", year: "Год" };
// Меняется вместе с текстом согласия (consent/index.html)
const CONSENT_VERSION = "2026-10-30";

const MAX_BODY = 8000;
const MIN_FILL_MS = 3000;

class OrderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function handleOrder(request, env, ctx) {
  try {
    if (request.method !== "POST") throw new OrderError(405, "Метод не поддерживается");
    if (!ORDERS_OPEN) {
      throw new OrderError(503, "Приём заявок через сайт скоро откроется. Напишите нам в Telegram @tapreview_ru");
    }
    checkOrigin(request, env);

    const text = await request.text();
    if (text.length > MAX_BODY) throw new OrderError(413, "Слишком большой запрос");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new OrderError(400, "Неверный формат данных");
    }
    if (!data || typeof data !== "object") throw new OrderError(400, "Неверный формат данных");

    // Роботы заполняют скрытое поле или отправляют форму мгновенно — делаем вид, что всё хорошо
    if (String(data.website || "").trim() || Number(data.elapsed) < MIN_FILL_MS) {
      return reply({ ok: true });
    }

    const order = validate(data);
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

// Форму можно отправить только со своего сайта
function checkOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return;
  const allowed = new Set([new URL(request.url).origin]);
  if (env.PUBLIC_BASE_URL) allowed.add(new URL(env.PUBLIC_BASE_URL).origin);
  if (!allowed.has(origin)) throw new OrderError(403, "Запрос с чужого сайта");
}

function clean(value, max, label, required = false) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (required && !text) throw new OrderError(400, `Заполните поле «${label}»`);
  if (text.length > max) throw new OrderError(400, `«${label}»: не больше ${max} символов`);
  return text;
}

function validate(data) {
  const name = clean(data.name, 80, "Имя", true);
  const businessName = clean(data.business_name, 120, "Название заведения", true);
  const city = clean(data.city, 80, "Город");
  const comment = String(data.comment ?? "").trim().slice(0, 1000);

  const rawPhone = clean(data.phone, 30, "Телефон");
  const digits = rawPhone.replace(/\D/g, "");
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
  if (!plan) throw new OrderError(400, "Выберите тариф");
  if (data.consent !== true) throw new OrderError(400, "Нужно согласие на обработку персональных данных");

  const totals = orderTotals({ venues, cards, plan });
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
    total_now: totals.now,
    total_next: totals.next,
    consent_at: new Date().toISOString(),
    consent_version: CONSENT_VERSION
  };
}

// Подключение каждой карты + подписка за каждое заведение
export function orderTotals({ venues, cards, plan }) {
  const subscription = venues * PRICES[plan];
  return { connection: cards * PRICES.card, subscription, now: cards * PRICES.card + subscription, next: subscription };
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
          text: orderText(order),
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

export function orderText(o) {
  const rub = (n) => `${Number(n).toLocaleString("ru-RU")} ₽`;
  const t = orderTotals(o);
  const lines = [
    `🆕 <b>Заявка №${o.id}</b>`,
    "",
    `👤 ${esc(o.name)}`,
    o.phone ? `📞 <a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>` : null,
    o.telegram ? `✈️ <a href="https://t.me/${esc(o.telegram)}">@${esc(o.telegram)}</a>` : null,
    `🏠 ${esc(o.business_name)}${o.city ? `, ${esc(o.city)}` : ""}`,
    "",
    `🃏 Карт: <b>${o.cards}</b> · заведений: <b>${o.venues}</b> · тариф: <b>${PLAN_LABELS[o.plan]}</b>`,
    `💳 Сейчас: <b>${rub(t.now)}</b> (подключение ${rub(t.connection)} + подписка ${rub(t.subscription)})`,
    `🔁 Дальше: ${rub(t.next)} ${o.plan === "year" ? "в год" : "в месяц"}`,
    o.comment ? `\n💬 ${esc(o.comment)}` : null
  ];
  return lines.filter((line) => line !== null).join("\n");
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
