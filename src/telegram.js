// Telegram-бот для владельцев заведений: статистика по их карте и странице.
//   POST /tg/webhook   — сюда Telegram присылает сообщения боту (проверяем секрет в заголовке)
//   weeklyReports(env) — отчёт за неделю по понедельникам (запускает расписание из index.js)
//
// Как владелец подключается: в админ-панели создаём одноразовую ссылку t.me/<бот>?start=КОД,
// владелец открывает её и нажимает «Запустить» — его чат привязывается к заведению.
//
// Секреты (Cloudflare → Worker → Settings → Variables and Secrets, тип Secret):
//   TG_BOT_TOKEN      — токен бота от @BotFather
//   TG_WEBHOOK_SECRET — любая длинная случайная строка из латинских букв и цифр

import { db } from "./supabase.js";
import { PERIODS, PLATFORMS, loadReports, formatDateRange } from "./report.js";
import { formatDay } from "./billing.js";

const MAX_BUSINESSES_PER_CHAT = 10;
const INVITE_RE = /^[A-Za-z0-9]{16,32}$/;

// Кнопки под полем ввода в личном чате
const KEYBOARD = {
  keyboard: [[{ text: "📊 Сегодня" }, { text: "📊 7 дней" }, { text: "📊 30 дней" }]],
  resize_keyboard: true,
  is_persistent: true
};

export const BOT_COMMANDS = [
  { command: "week", description: "Статистика за 7 дней" },
  { command: "today", description: "Статистика за сегодня" },
  { command: "month", description: "Статистика за 30 дней" },
  { command: "report_off", description: "Не присылать отчёт по понедельникам" },
  { command: "report_on", description: "Присылать отчёт по понедельникам" },
  { command: "stop", description: "Отключить бота от заведений" },
  { command: "help", description: "Как пользоваться ботом" }
];

// ---------- Запросы к Telegram ----------

export async function tg(env, method, body = {}) {
  if (!env.TG_BOT_TOKEN) {
    throw new Error("Не задан секрет TG_BOT_TOKEN (Cloudflare → Worker → Settings → Variables and Secrets)");
  }
  const response = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` }));
  if (!data.ok) {
    const error = new Error(`Telegram ${method}: ${data.description}`);
    error.tgCode = data.error_code;
    throw error;
  }
  return data.result;
}

function send(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra
  });
}

// ---------- Входящие сообщения ----------

export async function handleTelegramWebhook(request, env) {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!env.TG_WEBHOOK_SECRET || !sameString(secret, env.TG_WEBHOOK_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("ok");
  }

  // Всегда отвечаем 200, иначе Telegram будет присылать то же сообщение снова и снова
  try {
    await onMessage(env, update.message);
  } catch (error) {
    console.error(`Telegram bot error: ${error.message}\n${error.stack}`);
  }
  return new Response("ok");
}

async function onMessage(env, message) {
  if (!message || typeof message.text !== "string") return;
  const chat = message.chat;
  const isPrivate = chat.type === "private";
  const text = message.text.trim();

  // Команда: /start КОД, /week, /week@ИмяБота
  const command = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+(\S+))?/i);
  if (command) {
    const name = command[1].toLowerCase();
    const arg = command[2] || "";
    if (name === "start") return arg ? connectChat(env, chat, arg) : greet(env, chat);
    if (name === "orders_off") return disconnectOrders(env, chat);
    if (name === "today" || name === "week" || name === "month") return sendReports(env, chat, name);
    if (name === "stats") return sendReports(env, chat, "week");
    if (name === "report_off" || name === "report_on") return setWeekly(env, chat, name === "report_on");
    if (name === "stop") return disconnectChat(env, chat);
    if (name === "help") return help(env, chat);
    return isPrivate ? help(env, chat) : undefined;
  }

  // Кнопки под полем ввода приходят обычным текстом
  if (/сегодня/i.test(text)) return sendReports(env, chat, "today");
  if (/7\s*дн/i.test(text)) return sendReports(env, chat, "week");
  if (/30\s*дн/i.test(text)) return sendReports(env, chat, "month");

  // В группах не отвечаем на обычную переписку
  if (isPrivate) return greet(env, chat);
}

async function chatBusinessIds(env, chatId) {
  const rows = await db(env, `tg_subscribers?chat_id=eq.${chatId}&select=business_id&order=created_at.asc`);
  return rows.map((row) => row.business_id);
}

async function greet(env, chat) {
  const ids = await chatBusinessIds(env, chat.id);
  if (!ids.length) {
    return send(
      env,
      chat.id,
      "👋 Это бот <b>TapReview</b>. Он присылает владельцу статистику по карте для отзывов: " +
        "сколько раз открыли страницу и сколько человек перешли оставить отзыв.\n\n" +
        "Чтобы подключить своё заведение, попросите у нас ссылку для подключения и откройте её."
    );
  }
  return send(env, chat.id, "Выберите период — кнопки ниже, или команды /today, /week, /month.", replyKeyboard(chat));
}

async function help(env, chat) {
  return send(
    env,
    chat.id,
    "<b>Что умеет бот</b>\n" +
      "/today — статистика за сегодня\n" +
      "/week — за 7 дней\n" +
      "/month — за 30 дней\n" +
      "/report_off, /report_on — отчёт по понедельникам в 9:00 (МСК)\n" +
      "/stop — отключить бота\n\n" +
      "<b>Что значат цифры</b>\n" +
      "👀 <b>Открыли страницу</b> — сколько раз страницу отзывов открыли с карты (NFC или QR) или по ссылке. " +
      "Один и тот же человек считается не чаще раза в 30 минут, роботы не считаются.\n" +
      "⭐ <b>Перешли к отзыву</b> — сколько раз нажали кнопку Яндекса, Google или 2ГИС. " +
      "Сам отзыв человек пишет уже на площадке, поэтому опубликованные отзывы бот не считает.",
    replyKeyboard(chat)
  );
}

function replyKeyboard(chat) {
  return chat.type === "private" ? { reply_markup: KEYBOARD } : {};
}

function chatTitle(chat) {
  if (chat.title) return chat.title.slice(0, 120);
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  const user = chat.username ? `@${chat.username}` : "";
  return [name, user].filter(Boolean).join(" ").slice(0, 120) || String(chat.id);
}

// /start КОД — привязать чат к заведению по одноразовой ссылке
async function connectChat(env, chat, code) {
  const bad = () =>
    send(env, chat.id, "⚠️ Ссылка недействительна: она уже использована или устарела. Попросите новую ссылку.");
  if (!INVITE_RE.test(code)) return bad();
  const nowIso = new Date().toISOString();

  // Ссылка из админ-панели «Получать заявки в Telegram» — для владельца TapReview, не для заведений
  const orderInvite = await db(
    env,
    `order_invites?code=eq.${code}&used_at=is.null&expires_at=gt.${encodeURIComponent(nowIso)}&select=code`,
    { method: "PATCH", body: { used_at: nowIso }, prefer: "return=representation" }
  );
  if (orderInvite.length) {
    await db(env, "order_recipients?on_conflict=chat_id", {
      method: "POST",
      body: { chat_id: chat.id, chat_title: chatTitle(chat) },
      prefer: "resolution=merge-duplicates,return=minimal"
    });
    return send(
      env,
      chat.id,
      "✅ Готово! Сюда будут приходить заявки с сайта tapreview.ru.\n\nОтключить — команда /orders_off"
    );
  }

  // Отмечаем ссылку использованной; условие used_at=is.null не даст использовать её дважды
  const used = await db(
    env,
    `tg_invites?code=eq.${code}&used_at=is.null&expires_at=gt.${encodeURIComponent(nowIso)}&select=business_id`,
    { method: "PATCH", body: { used_at: nowIso, used_by_chat: chat.id }, prefer: "return=representation" }
  );
  if (!used.length) return bad();
  const businessId = used[0].business_id;

  const ids = await chatBusinessIds(env, chat.id);
  if (!ids.includes(businessId) && ids.length >= MAX_BUSINESSES_PER_CHAT) {
    return send(env, chat.id, `⚠️ К одному чату можно подключить не больше ${MAX_BUSINESSES_PER_CHAT} заведений.`);
  }

  await db(env, "tg_subscribers?on_conflict=chat_id,business_id", {
    method: "POST",
    body: { chat_id: chat.id, business_id: businessId, chat_title: chatTitle(chat) },
    prefer: "resolution=ignore-duplicates,return=minimal"
  });

  const business = await db(env, `businesses?id=eq.${businessId}&select=name`);
  const name = business.length ? business[0].name : "заведение";
  await send(
    env,
    chat.id,
    `✅ Готово! Сюда будет приходить статистика по «<b>${esc(name)}</b>».\n\n` +
      "🗓 Каждый понедельник в 9:00 (МСК) — отчёт за неделю.\n" +
      "📊 В любой момент — кнопки ниже или команды /today, /week, /month.\n" +
      "❓ Что значат цифры — /help",
    replyKeyboard(chat)
  );
  return sendReports(env, chat, "week", [businessId]);
}

async function disconnectChat(env, chat) {
  await db(env, `tg_subscribers?chat_id=eq.${chat.id}`, { method: "DELETE", prefer: "return=minimal" });
  return send(env, chat.id, "Бот отключён, статистика больше не будет приходить. Подключиться снова можно по новой ссылке.", {
    reply_markup: { remove_keyboard: true }
  });
}

async function disconnectOrders(env, chat) {
  const rows = await db(env, `order_recipients?chat_id=eq.${chat.id}&select=chat_id`, {
    method: "DELETE",
    prefer: "return=representation"
  });
  return send(
    env,
    chat.id,
    rows.length ? "Заявки с сайта больше не будут приходить в этот чат." : "Этот чат и так не получает заявки."
  );
}

async function setWeekly(env, chat, enabled) {
  const rows = await db(env, `tg_subscribers?chat_id=eq.${chat.id}&select=id`, {
    method: "PATCH",
    body: { weekly_report: enabled },
    prefer: "return=representation"
  });
  if (!rows.length) return greet(env, chat);
  return send(
    env,
    chat.id,
    enabled
      ? "🗓 Отчёт за неделю будет приходить по понедельникам в 9:00 (МСК)."
      : "Хорошо, по понедельникам отчёт присылать не будем. Включить снова — /report_on",
    replyKeyboard(chat)
  );
}

async function sendReports(env, chat, period, onlyIds) {
  const ids = onlyIds || (await chatBusinessIds(env, chat.id));
  if (!ids.length) return greet(env, chat);

  const reports = await buildReports(env, ids, period, Date.now());
  for (const id of ids) {
    if (reports.has(id)) await send(env, chat.id, reports.get(id), replyKeyboard(chat));
  }
}

// ---------- Еженедельный отчёт ----------

// Бесплатный тариф Cloudflare разрешает 50 внешних запросов за один запуск:
// 4 уходят на базу, остальные — на сообщения (и запас на удаление заблокировавших бота).
// Поэтому отправляем не больше 40 отчётов и пишем в лог, если подписок больше
// (тогда нужен платный тариф Workers — там лимит 1000).
const MAX_WEEKLY_MESSAGES = 40;

export async function weeklyReports(env) {
  const subs = await db(
    env,
    "tg_subscribers?weekly_report=eq.true&select=chat_id,business_id&order=created_at.asc&limit=1000"
  );
  if (!subs.length) return;
  if (subs.length > MAX_WEEKLY_MESSAGES) {
    console.error(`Weekly reports: ${subs.length} подписок, отправим только ${MAX_WEEKLY_MESSAGES} (лимит тарифа)`);
  }

  const ids = [...new Set(subs.map((s) => s.business_id))];
  const reports = await buildReports(env, ids, "week", Date.now());

  let sent = 0;
  for (const sub of subs.slice(0, MAX_WEEKLY_MESSAGES)) {
    const text = reports.get(sub.business_id);
    if (!text) continue;
    try {
      await send(env, sub.chat_id, `🗓 <b>Отчёт за неделю</b>\n\n${text}`);
      sent++;
    } catch (error) {
      // 403 — бота заблокировали или удалили из группы: больше не пишем в этот чат
      if (error.tgCode === 403) {
        await db(env, `tg_subscribers?chat_id=eq.${sub.chat_id}`, { method: "DELETE", prefer: "return=minimal" });
      }
      console.error(`Weekly report to ${sub.chat_id} failed: ${error.message}`);
    }
  }
  console.log(`Weekly reports sent: ${sent}`);
}

// ---------- Текст отчёта (цифры считает report.js) ----------

// Возвращает Map: id заведения → готовый текст сообщения
async function buildReports(env, ids, period, now) {
  const reports = await loadReports(env, ids, period, now);
  const result = new Map();
  for (const [id, report] of reports) result.set(id, reportText(report));
  return result;
}

function reportText({ name, period, range, cur, prev, cards, billing }) {
  const p = PERIODS[period];
  const lines = [];

  if (billing.state === "expired") {
    return (
      `⏸ <b>${esc(name)}</b>\n` +
      `Подписка закончилась ${formatDay(billing.paidUntil)}, статистика на паузе.\n` +
      "Карта работает: гости попадают сразу на страницу площадки. После продления статистика вернётся."
    );
  }
  if (billing.state === "ending" || billing.state === "grace") {
    lines.push(
      billing.state === "ending"
        ? `⚠️ Подписка оплачена до ${formatDay(billing.paidUntil)} включительно — продлите заранее.`
        : `⚠️ Подписка закончилась ${formatDay(billing.paidUntil)}. Карта работает до ${formatDay(billing.lastDay)}, потом статистика встанет на паузу.`
    );
    lines.push("");
  }

  lines.push(`📊 <b>${esc(name)}</b>`);
  lines.push(`${p.title} · ${formatDateRange(period, range)}`);
  lines.push("");

  lines.push(`👀 Открыли страницу: <b>${cur.views}</b>${delta(cur.views, prev.views)}`);
  if (cur.views) {
    lines.push(`      NFC ${cur.nfc} · QR ${cur.qr} · по ссылке ${cur.direct}`);
  }

  lines.push(`⭐ Перешли к отзыву: <b>${cur.clicks}</b>${delta(cur.clicks, prev.clicks)}`);
  if (cur.clicks) {
    lines.push("      " + PLATFORMS.map((pl) => `${pl.short} ${cur[pl.key]}`).join(" · "));
  }
  if (cur.views && cur.clicks) {
    lines.push(`      Это ${Math.round((cur.clicks / cur.views) * 100)}% от открытий страницы`);
  }

  if (cards.length > 1) {
    lines.push("");
    lines.push("🏷 По картам:");
    for (const c of cards.slice(0, 5)) {
      lines.push(`      ${esc(c.name)} — ${c.views} откр., ${c.clicks} к отзыву`);
    }
  }

  if (!cur.views && !cur.clicks) {
    lines.push("");
    lines.push("Пока переходов не было.");
  }

  lines.push("");
  lines.push(`<i>Сравнение — ${p.compare}.</i>`);
  return lines.join("\n");
}

function delta(cur, prev) {
  if (!cur && !prev) return "";
  const diff = cur - prev;
  if (diff > 0) return `  ▲ +${diff}`;
  if (diff < 0) return `  ▼ −${-diff}`;
  return "  = столько же";
}

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Сравнение строк за одинаковое время — чтобы секрет нельзя было подобрать по скорости ответа
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
