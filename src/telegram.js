// Telegram-бот для владельцев заведений: статистика по их карте и странице.
//   POST /tg/webhook   — сюда Telegram присылает сообщения боту (проверяем секрет в заголовке)
//   weeklyReports(env) — отчёт за неделю по понедельникам (запускает расписание из index.js)
//
// Как владелец подключается: в админ-панели создаём одноразовую ссылку t.me/<бот>?start=КОД,
// владелец открывает её и нажимает «Запустить» — его чат привязывается к заведению.
//
// Секреты (на сервере — файл /etc/tapreview.env; на Cloudflare — Worker → Settings → Variables and Secrets):
//   TG_BOT_TOKEN      — токен бота от @BotFather
//   TG_WEBHOOK_SECRET — любая длинная случайная строка из латинских букв и цифр

import { ratingStats, reasonLabels } from "./rating.js";
import { aiConfigured, aiOn, weeklyDigest } from "./ai.js";
import { askAssistant, SUGGESTIONS } from "./assistant.js";

const escapeTg = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
import { db } from "./supabase.js";
import { PERIODS, PLATFORMS, loadReports, loadDaily, formatDateRange } from "./report.js";
import { WEEKLY_WIDGET_HTML, widgetData, widgetCaption } from "./tg-widget.js";
import { formatDay } from "./billing.js";
import { isManageCommand, handleManage } from "./bot-manage.js";

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
  { command: "manage", description: "Управление: подарки и «Сейчас у нас»" },
  { command: "news", description: "Опубликовать «Сейчас у нас»" },
  { command: "ask", description: "Спросить AI о своих цифрах (модуль AI)" },
  { command: "report_off", description: "Не присылать отчёт по понедельникам" },
  { command: "report_on", description: "Присылать отчёт по понедельникам" },
  { command: "stop", description: "Отключить бота от заведений" },
  { command: "help", description: "Как пользоваться ботом" }
];

// ---------- Посредник для Telegram (работает на Cloudflare Worker, за рубежом) ----------
// Включается переменными Worker: TG_RELAY_KEY (секрет, тот же, что на сервере) и TG_HOOK_TARGET.
//   POST /tg-api/bot<токен>/<метод> — сервер → Telegram (только с заголовком X-Relay-Key)
//   POST /tg-hook                   — Telegram → сервер: пересылаем на TG_HOOK_TARGET (https://tapreview.ru/tg/webhook)
//                                     вместе с заголовком секрета вебхука, который проверяет уже сам сервер
// Открытым прокси для посторонних не является: /tg-api без ключа → 403, /tg-hook ходит только на TG_HOOK_TARGET.

export async function handleTelegramRelay(request, env, path) {
  if (!env.TG_RELAY_KEY || request.method !== "POST") return new Response("Not found", { status: 404 });

  if (path.startsWith("/tg-api/")) {
    const key = request.headers.get("X-Relay-Key") || "";
    if (!sameString(key, env.TG_RELAY_KEY)) return new Response("Forbidden", { status: 403 });
    const rest = path.slice("/tg-api".length);
    if (!/^\/bot\d+:[A-Za-z0-9_-]+\/[A-Za-z]+$/.test(rest)) return new Response("Bad request", { status: 400 });
    const response = await fetch(`https://api.telegram.org${rest}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text()
    });
    return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json" } });
  }

  if (path === "/tg-hook" && env.TG_HOOK_TARGET) {
    const headers = { "Content-Type": "application/json" };
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
    const response = await fetch(env.TG_HOOK_TARGET, { method: "POST", headers, body: await request.text() });
    return new Response(await response.text(), { status: response.status });
  }

  return new Response("Not found", { status: 404 });
}

// ---------- Запросы к Telegram ----------

export async function tg(env, method, body = {}) {
  if (!env.TG_BOT_TOKEN) {
    throw new Error("Не задан TG_BOT_TOKEN (на сервере — /etc/tapreview.env)");
  }
  return tgAs(env, env.TG_BOT_TOKEN, method, body);
}

// Любой наш бот: бот владельцев (TG_BOT_TOKEN) или бот гостей Mini App (APP_BOT_TOKEN, app-api.js)
export async function tgAs(env, token, method, body = {}) {
  // На сервере в РФ Telegram закрыт на уровне дата-центра — запросы идут через посредника
  // (наш Cloudflare Worker, см. handleTelegramRelay): TG_API_BASE + ключ TG_RELAY_KEY.
  const base = String(env.TG_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (env.TG_RELAY_KEY) headers["X-Relay-Key"] = env.TG_RELAY_KEY;
  const response = await fetch(`${base}/bot${token}/${method}`, {
    method: "POST",
    headers,
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

  // Управление заведением (bot-manage.js): /manage, /gifts_on, /gifts_off, /news …, /news_off
  if (isManageCommand(text)) {
    const reply = await handleManage(env, chat, text);
    if (reply) return send(env, chat.id, reply, replyKeyboard(chat));
  }

  // AI-ассистент (assistant.js): /ask вопрос — только чаты с «Может управлять» и модулем AI
  const ask = text.match(/^\/ask(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (ask) return askFromChat(env, chat, ask[1] || "");

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

async function askFromChat(env, chat, question) {
  const subs = await db(env, `tg_subscribers?chat_id=eq.${chat.id}&can_manage=is.true&select=business_id&order=created_at.asc`);
  const venues = subs.length
    ? await db(env, `businesses?id=in.(${subs.map((s) => s.business_id).join(",")})&select=id,name,category,modules,tariff,vip_visits`)
    : [];
  const withAi = venues.filter((b) => aiOn(env, b));
  if (!withAi.length) {
    return send(env, chat.id, "🤖 AI-ассистент отвечает владельцу в чате с правом «Может управлять», если у заведения подключён модуль «AI-разбор отзывов».");
  }
  if (!question.trim()) {
    return send(env, chat.id, `🤖 Напишите вопрос после команды, например:\n<code>/ask ${escapeTg(SUGGESTIONS[0])}</code>\n\nЯ отвечу по цифрам «${escapeTg(withAi[0].name)}» за 8 недель.`);
  }
  const business = withAi[0];
  await send(env, chat.id, "🤖 Смотрю ваши цифры, это займёт 10–20 секунд…").catch(() => {});
  const r = await askAssistant(env, business, question, "tg");
  return send(env, chat.id, r.answer
    ? `🤖 <b>${escapeTg(business.name)}</b>\n${escapeTg(r.answer)}${withAi.length > 1 ? "\n\nОтвечаю по первому заведению в этом чате. Про остальные — на странице «Спросить AI» в статистике." : ""}`
    : `🤖 ${escapeTg(r.error)}`);
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
      "<b>Управление</b> (если включено для вашего чата)\n" +
      "/manage — что сейчас включено\n" +
      "/gifts_on, /gifts_off — включить или выключить подарки для гостей\n" +
      "/news Заголовок — опубликовать «Сейчас у нас» (текст — со следующей строки), /news_off — убрать\n\n" +
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

  const now = Date.now();
  // «7 дней» в личном чате — виджетом, как в понедельничном отчёте; при любой ошибке — текстом
  if (period === "week" && chat.type === "private" && env.TG_WIDGETS !== "0") {
    const raw = await loadReports(env, ids, period, now);
    for (const id of ids) {
      const report = raw.get(id);
      if (!report) continue;
      const text = reportText(report);
      if (!text.startsWith("⏸")) {
        try {
          const rating = await ratingStats(env, [id], { from: now - 7 * 24 * 60 * 60 * 1000, to: now })
            .then((r) => (r.count ? { avg: r.avg, count: r.count, low: r.low, reason: topReason(r) } : null))
            .catch(() => null);
          const widget = await buildWidget(env, report, rating, now);
          await tg(env, "sendWidget", { chat_id: chat.id, html: WEEKLY_WIDGET_HTML, caption: widget.caption, chat_data: widget.data });
          continue;
        } catch (error) {
          console.error(`Widget /week to ${chat.id} failed, sending text: ${error.message}`);
        }
      }
      await send(env, chat.id, text, replyKeyboard(chat));
    }
    return;
  }

  const reports = await buildReports(env, ids, period, now);
  for (const id of ids) {
    if (reports.has(id)) await send(env, chat.id, reports.get(id), replyKeyboard(chat));
  }
}

// Самая частая причина недовольства (миграция 044) — строчными, или ""
function topReason(r) {
  const top = [...r.recovery.reasons.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] ? reasonLabels(null)[top[0]].toLowerCase() : "";
}

// ---------- Еженедельный отчёт ----------

// На своём сервере (DB_URL) ограничений нет — до 1000 отчётов за раз.
// На бесплатном Cloudflare было 50 внешних запросов за запуск — поэтому там только 40.
function maxWeeklyMessages(env) {
  return env.DB_URL ? 1000 : 40;
}

export async function weeklyReports(env) {
  const MAX_WEEKLY_MESSAGES = maxWeeklyMessages(env);
  const subs = await db(
    env,
    "tg_subscribers?weekly_report=eq.true&select=chat_id,business_id&order=created_at.asc&limit=1000"
  );
  if (!subs.length) return;
  if (subs.length > MAX_WEEKLY_MESSAGES) {
    console.error(`Weekly reports: ${subs.length} подписок, отправим только ${MAX_WEEKLY_MESSAGES} (лимит тарифа)`);
  }

  const ids = [...new Set(subs.map((s) => s.business_id))];
  const now = Date.now();
  const raw = await loadReports(env, ids, "week", now);
  const reports = new Map();
  for (const [id, report] of raw) reports.set(id, reportText(report));
  const ratings = new Map(); // для виджета: { avg, count, low, reason }
  const digests = new Map(); // разбор недели от AI — после виджета уходит отдельным сообщением

  // Оценки гостей за неделю (шаг «Сначала оценка»): средняя и сколько недовольных
  for (const id of ids) {
    const text = reports.get(id);
    if (!text || text.startsWith("⏸")) continue;
    try {
      const r = await ratingStats(env, [id], { from: now - 7 * 24 * 60 * 60 * 1000, to: now });
      if (!r.count) continue;
      const avg = r.avg.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      // Самая частая причина недовольства за неделю (миграция 044)
      const top = [...r.recovery.reasons.entries()].sort((a, b) => b[1] - a[1])[0];
      const reason = top && top[1] ? reasonLabels(null)[top[0]].toLowerCase() : "";
      ratings.set(id, { avg: r.avg, count: r.count, low: r.low, reason });
      const why = reason ? `\n      Чаще всего: ${reason} (${top[1]})` : "";
      reports.set(id, `${text}\n\n🌟 Оценки гостей: <b>${avg}</b> из 5 (${r.count})` +
        (r.low ? `\n      Недовольных (1–3 ★): ${r.low}, сообщений вам: ${r.recovery.total}${why}` : "\n      Недовольных не было 👏"));
    } catch (error) {
      console.error(`Weekly ratings ${id}: ${error.message}`);
    }
  }

  // Модуль AI (ai.js): разбор недели — цифры считает код, модель только формулирует
  if (aiConfigured(env)) {
    const venues = await db(env, `businesses?id=in.(${ids.join(",")})&select=id,name,category,modules,tariff`).catch(() => []);
    for (const b of venues) {
      const text = reports.get(b.id);
      if (!text || text.startsWith("⏸") || !aiOn(env, b)) continue;
      const digest = await weeklyDigest(env, b, now).catch((error) => {
        console.error(`Weekly digest ${b.id}: ${error.message}`);
        return null;
      });
      if (digest) {
        const block = `🤖 <b>Разбор недели</b> (AI по вашим отзывам):\n${escapeTg(digest)}`;
        digests.set(b.id, block);
        reports.set(b.id, `${text}\n\n${block}`);
      }
    }
  }

  // Виджет (tg-widget.js) — только в личных чатах (chat_id > 0), данные собираем один раз на заведение
  const widgets = new Map();
  async function widgetFor(id) {
    if (!widgets.has(id)) widgets.set(id, await buildWidget(env, raw.get(id), ratings.get(id), now).catch((error) => {
      console.error(`Weekly widget ${id}: ${error.message}`);
      return null;
    }));
    return widgets.get(id);
  }

  let sent = 0;
  for (const sub of subs.slice(0, MAX_WEEKLY_MESSAGES)) {
    const text = reports.get(sub.business_id);
    if (!text) continue;
    try {
      const widget = sub.chat_id > 0 && env.TG_WIDGETS !== "0" && !text.startsWith("⏸") ? await widgetFor(sub.business_id) : null;
      if (widget) {
        try {
          await tg(env, "sendWidget", { chat_id: sub.chat_id, html: WEEKLY_WIDGET_HTML, caption: widget.caption, chat_data: widget.data });
          const digest = digests.get(sub.business_id);
          if (digest) await send(env, sub.chat_id, digest);
          sent++;
          continue;
        } catch (error) {
          if (error.tgCode === 403) throw error;
          // Виджет не принят (старый Bot API, лимиты) — отправим обычный текст ниже
          console.error(`Weekly widget to ${sub.chat_id} failed, sending text: ${error.message}`);
        }
      }
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

// Данные виджета: график по дням + ссылка на страницу статистики (последняя созданная для заведения)
async function buildWidget(env, report, rating, now) {
  if (!report) return null;
  const [daily, links] = await Promise.all([
    loadDaily(env, [report.id], "week", now),
    db(env, `stats_links?business_id=eq.${report.id}&select=token&order=created_at.desc&limit=1`).catch(() => [])
  ]);
  const base = String(env.PUBLIC_BASE_URL || "https://tapreview.ru").replace(/\/+$/, "");
  const link = links[0] ? `${base}/s/${links[0].token}?p=week` : null;
  const rangeText = formatDateRange("week", report.range);
  return { data: widgetData(report, daily, rating, link, rangeText), caption: widgetCaption(report, rangeText) };
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
