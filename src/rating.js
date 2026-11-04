// Сначала оценка, потом отзывы (миграция 021).
//
// Страница с карты: карточка заведения → «Как вам у нас?» 1–5 →
//   4–5 — кнопки Яндекс / 2ГИС / Google;
//   1–3 — сообщение владельцу (сразу в Telegram) + маленькая ссылка на площадки.
// Площадки доступны всем (ссылка «Сразу оставить отзыв…»), подарок — после любой оценки одинаково.
// Так мы не фильтруем отзывы (это запрещено правилами Яндекса и Google), а владелец узнаёт о проблеме первым.
//
// Всё работает без скриптов: звёзды — обычные ссылки (GET ?r=N), сообщение — форма POST /feedback.

import { db } from "./supabase.js";
import { tg } from "./telegram.js";
import { isBot, sha256, visitorHashOf } from "./analytics.js";
import { has } from "./tariffs.js";
import { classifyFeedback } from "./ai.js";

const DEDUPE_WINDOW_MINUTES = 30;
const SLUG_RE = /^[A-Za-z0-9_-]{3,64}$/;
const MAX_TEXT = 1000;
// Телефон гостя (по желанию, с согласием) хранится столько дней, потом стирается (purgeOldPhones)
export const PHONE_KEEP_DAYS = 30;

// «Что понравилось?» после оценки 4–5 — порядок как на странице
export const LIKES = [
  { key: "food", label: "Кухня" },
  { key: "service", label: "Обслуживание" },
  { key: "vibe", label: "Атмосфера" },
  { key: "drinks", label: "Напитки" },
  { key: "price", label: "Цены" }
];
const LIKE_KEYS = new Set(LIKES.map((l) => l.key));

// Причины недовольства (миграция 044) — одним касанием при оценке 1–3, можно несколько.
// «quality» называется по виду заведения: еда и напитки / результат услуги / товар.
const REASON_KEYS = ["wait", "quality", "service", "clean", "price", "other"];
const QUALITY_LABELS = { restaurant: "Еда и напитки", hotel: "Еда и напитки", beauty: "Результат услуги", barber: "Результат услуги", shop: "Товар", auto: "Качество работы" };
export function reasonLabels(category) {
  return {
    wait: "Долго ждали",
    quality: QUALITY_LABELS[category] || "Качество",
    service: "Обслуживание",
    clean: "Чистота",
    price: "Цена",
    other: "Другое"
  };
}
export const REASONS = REASON_KEYS;
// Напоминание о неразобранном сообщении: через столько часов, только с 9 до 23 по МСК
export const REMIND_AFTER_HOURS = 2;
export const RECOVERY_CRON = "*/10 * * * *";

// Шаг на странице по адресу: ?r=1..5 — оценка, ?v=all — сразу к площадкам, ?sent=1 — сообщение отправлено,
// ?l=food,service — отмеченное «Что понравилось», ?np=1 — номер не сохранили (неверный формат)
export function flowFrom(url) {
  const r = Number(url.searchParams.get("r"));
  const score = Number.isInteger(r) && r >= 1 && r <= 5 ? r : null;
  const likes = score >= 4
    ? [...new Set(String(url.searchParams.get("l") || "").split(",").filter((k) => LIKE_KEYS.has(k)))]
    : [];
  return {
    score,
    likes,
    all: url.searchParams.get("v") === "all",
    sent: url.searchParams.get("sent") === "1",
    phoneLost: url.searchParams.get("np") === "1",
    // ?e=1 — отправили пустую форму (ни причины, ни текста)
    empty: url.searchParams.get("e") === "1"
  };
}

// Российский номер → +7XXXXXXXXXX, иначе null
export function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10 && digits[0] === "9") return `+7${digits}`;
  if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) return `+7${digits.slice(1)}`;
  return null;
}

// Оценка: один посетитель — одна оценка за 30 минут (передумал — обновляется).
// Личная карта сотрудника (staffId, staff.js): одна оценка с телефона в день — чтобы рейтинг сотрудника не накручивали.
export async function logRating(request, env, { businessId, cardId, score, source, likes = [], staffId = null }) {
  try {
    if (isBot(request)) return;
    const visitor = await visitorHashOf(request, env);
    const windowKey = staffId
      ? `staff${staffId}|day${Math.floor((Date.now() + 3 * 3600e3) / 86400e3)}`
      : String(Math.floor(Date.now() / (DEDUPE_WINDOW_MINUTES * 60 * 1000)));
    const body = {
      business_id: businessId,
      score,
      source,
      likes: score >= 4 ? likes : [],
      dedupe_key: await sha256(`${businessId}|rating|${visitor}|${windowKey}`)
    };
    if (cardId) body.card_id = cardId;
    if (staffId) body.staff_id = staffId;
    await db(env, "ratings?on_conflict=dedupe_key", {
      method: "POST",
      body,
      prefer: "resolution=merge-duplicates,return=minimal"
    });
  } catch (error) {
    console.error(`Не удалось записать оценку: ${error.message}`);
  }
}

// POST /feedback — сообщение владельцу при оценке 1–3
export async function handleFeedback(request, env, ctx) {
  if (request.method !== "POST") return new Response("Метод не поддерживается", { status: 405 });
  const text = await request.text();
  if (text.length > 6000) return new Response("Слишком большой запрос", { status: 413 });
  const form = new URLSearchParams(text);

  const slug = String(form.get("b") || "");
  const cardCode = String(form.get("c") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  const source = ["nfc", "qr"].includes(form.get("s")) ? form.get("s") : "direct";
  const score = Number(form.get("r"));
  if (!SLUG_RE.test(slug) || !Number.isInteger(score) || score < 1 || score > 5) {
    return new Response("Откройте страницу с карты ещё раз", { status: 400 });
  }

  // Обратно на ту же страницу (карты /c/КОД или заведения /b/slug) с отметкой «отправлено»
  const back = new URLSearchParams();
  if (source !== "direct") back.set("s", source);
  back.set("r", String(score));
  back.set("sent", "1");
  const message = String(form.get("text") || "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_TEXT);
  // Телефон — только если гость сам отметил «Перезвоните мне» (это и есть согласие); без отметки номер не берём
  const consent = form.get("call") === "1";
  const rawPhone = consent ? String(form.get("phone") || "").trim() : "";
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (rawPhone && !phone) back.set("np", "1");
  const location = `${cardCode ? `/c/${cardCode}` : `/b/${slug}`}?${back}`;
  const done = () => new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
  // Причины (миграция 044): только известные, без повторов
  const reasons = [...new Set(form.getAll("why").filter((k) => REASON_KEYS.includes(k)))];

  // Робот (скрытое поле) — просто возвращаем на страницу
  if (isBot(request) || String(form.get("website") || "").trim()) return done();
  // Ни причины, ни текста — обратно к форме с подсказкой
  if (!message && !reasons.length) {
    back.delete("sent");
    back.set("e", "1");
    return new Response(null, { status: 303, headers: { Location: `${cardCode ? `/c/${cardCode}` : `/b/${slug}`}?${back}#fb`, "Cache-Control": "no-store" } });
  }

  try {
    const rows = await db(env, `businesses?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=id,name,tariff,category,modules&limit=1`);
    if (!rows.length || !has(rows[0], "rating")) return done();
    const business = rows[0];
    const visitor = await visitorHashOf(request, env);

    // Не больше 3 сообщений с одного телефона за 10 минут и 20 на заведение в минуту
    const since10 = encodeURIComponent(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const since1 = encodeURIComponent(new Date(Date.now() - 60 * 1000).toISOString());
    const [mine, all] = await Promise.all([
      db(env, `feedback?business_id=eq.${business.id}&visitor_hash=eq.${visitor}&created_at=gt.${since10}&select=id`),
      db(env, `feedback?business_id=eq.${business.id}&created_at=gt.${since1}&select=id`)
    ]);
    if (mine.length >= 3 || all.length >= 20) return done();

    let card = null;
    if (cardCode) {
      const cards = await db(env, `cards?code=eq.${cardCode}&business_id=eq.${business.id}&select=id,code,label,staff_id&limit=1`);
      card = cards[0] || null;
    }
    const body = { business_id: business.id, card_id: card ? card.id : null, score, text: message, reasons, source, visitor_hash: visitor };
    // Личная карта сотрудника (staff.js) — сообщение относится к нему
    if (card && card.staff_id) body.staff_id = card.staff_id;
    if (phone) Object.assign(body, { phone, phone_consent_at: new Date().toISOString() });
    const saved = await db(env, "feedback?select=id", { method: "POST", body, prefer: "return=representation" });
    // Модуль AI (ai.js): сначала разметка (до 15 с), потом сообщение владельцу — с пометкой «Срочно», если нужно.
    // AI не ответил — сообщение уходит как обычно.
    ctx.waitUntil((async () => {
      const ai = await classifyFeedback(env, business, saved[0].id, { text: message, score, reasons }).catch(() => null);
      await notifyOwner(env, business, card, score, message, saved[0].id, Boolean(phone), reasons, ai);
    })());
  } catch (error) {
    console.error(`Feedback error: ${error.message}\n${error.stack}`);
  }
  return done();
}

// Сообщение сразу владельцу — всем, кто подключил Telegram-бота этого заведения
// Сам номер в Telegram не отправляем (серверы Telegram за пределами РФ) — только ссылку на статистику, где он виден
async function notifyOwner(env, business, card, score, message, id, hasPhone, reasons = [], ai = null) {
  try {
    const chats = await db(env, `tg_subscribers?business_id=eq.${business.id}&select=chat_id`);
    if (!chats.length) return;
    const where = card ? `\n🃏 Карта ${card.label ? `«${esc(card.label)}» ` : ""}${card.code.slice(0, 3)}-${card.code.slice(3)}` : "";
    let contact = "Гость остался анонимным. Разберитесь с причиной, пока он ещё рядом, — так недовольство не уйдёт в публичный отзыв.";
    if (hasPhone) {
      const link = await statsLinkOf(env, business.id);
      contact = `📞 <b>Гость просит перезвонить.</b> Номер — в статистике${link ? `:\n${link}#fb` : " по вашей ссылке."}\n` +
        `Позвоните, пока впечатление свежее, — так недовольство не уйдёт в публичный отзыв.`;
    }
    const labels = reasonLabels(business.category);
    const why = reasons.length ? `\nПричина: <b>${reasons.map((k) => esc(labels[k])).join(", ")}</b>` : "";
    // Модуль AI: «Срочно» сверху и суть одной фразой
    const urgent = ai && ai.urgent ? `🔥 <b>СРОЧНО</b>${ai.urgentReason ? `: ${esc(ai.urgentReason)}` : ""}\n` : "";
    const gist = ai && ai.note && !ai.urgent ? `\n💡 ${esc(ai.note)}` : "";
    const text =
      `${urgent}😟 <b>${esc(business.name)}</b>: гость поставил ${"★".repeat(score)}${"☆".repeat(5 - score)} (${score} из 5)${where}${why}${gist}\n\n` +
      (message ? `«${esc(message)}»\n\n` : "") +
      contact;
    let delivered = false;
    for (const { chat_id: chatId } of chats) {
      try {
        await tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
        delivered = true;
      } catch (error) {
        console.error(`Feedback #${id} to ${chatId}: ${error.message}`);
      }
    }
    if (delivered) {
      await db(env, `feedback?id=eq.${id}`, { method: "PATCH", body: { tg_delivered: true }, prefer: "return=minimal" });
    }
  } catch (error) {
    console.error(`Feedback #${id} notify failed: ${error.message}`);
  }
}

// Ссылка статистики заведения (первая) — для сообщений в Telegram
async function statsLinkOf(env, businessId) {
  const links = await db(
    env,
    `stats_links?or=(business_id.eq.${businessId},business_ids.cs.{${businessId}})&select=token&limit=1`
  ).catch(() => []);
  const base = String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return links.length ? `${base}/s/${links[0].token}` : null;
}

// Каждые 10 минут (server.mjs): сообщения недовольных, не отмеченные «Разобрано» за REMIND_AFTER_HOURS часа, —
// одно напоминание владельцу. С 23:00 до 9:00 по МСК не пишем: напоминание придёт утром.
// Берём сообщения не старше 3 дней, чтобы после долгого простоя сервера не завалить владельца старыми.
export async function feedbackReminders(env, now = Date.now()) {
  const hour = new Date(now + 3 * 3600e3).getUTCHours();
  if (hour < 9 || hour >= 23) return 0;
  const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());
  const due = await db(
    env,
    `feedback?resolved_at=is.null&reminded_at=is.null&created_at=lt.${iso(now - REMIND_AFTER_HOURS * 3600e3)}&created_at=gt.${iso(now - 3 * 86400e3)}` +
      "&select=id,business_id,score,reasons,created_at,businesses(name,category)&order=created_at.asc&limit=200"
  );
  if (!due.length) return 0;
  const byBusiness = new Map();
  for (const f of due) byBusiness.set(f.business_id, [...(byBusiness.get(f.business_id) || []), f]);
  let sent = 0;
  for (const [businessId, list] of byBusiness) {
    // Отмечаем сразу — даже если Telegram недоступен, второй раз не напоминаем
    await db(env, `feedback?id=in.(${list.map((f) => f.id).join(",")})`, {
      method: "PATCH", body: { reminded_at: new Date(now).toISOString() }, prefer: "return=minimal"
    });
    const chats = await db(env, `tg_subscribers?business_id=eq.${businessId}&select=chat_id`).catch(() => []);
    if (!chats.length) continue;
    const b = list[0].businesses || {};
    const labels = reasonLabels(b.category);
    const lines = list.slice(0, 5).map((f) => {
      const time = new Date(f.created_at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
      const why = (f.reasons || []).map((k) => labels[k]).filter(Boolean).join(", ");
      return `• ${time} — ${"★".repeat(f.score)}${why ? ` · ${esc(why)}` : ""}`;
    });
    const link = await statsLinkOf(env, businessId);
    const text =
      `⏰ <b>${esc(b.name || "Заведение")}</b>: ${list.length === 1 ? "сообщение недовольного гостя не разобрано" : `не разобрано сообщений недовольных гостей: ${list.length}`} больше ${REMIND_AFTER_HOURS} часов\n\n` +
      `${lines.join("\n")}${list.length > 5 ? `\n…и ещё ${list.length - 5}` : ""}\n\n` +
      `Разберитесь и отметьте «Разобрано»${link ? `:\n${link}#fb` : " в статистике по вашей ссылке."}`;
    for (const { chat_id: chatId } of chats) {
      try {
        await tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
        sent++;
      } catch (error) {
        console.error(`Feedback reminder to ${chatId}: ${error.message}`);
      }
    }
  }
  return sent;
}

// Для статистики: оценки и сообщения за период
export async function ratingStats(env, ids, { from, to, cardId = null }) {
  const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());
  const card = cardId ? `&card_id=eq.${cardId}` : "";
  const range = `business_id=in.(${ids.join(",")})${card}&created_at=gte.${iso(from)}&created_at=lte.${iso(to)}`;
  const [ratings, feedback, all] = await Promise.all([
    db(env, `ratings?${range}&select=score,likes&limit=20000`),
    db(env, `feedback?${range}&select=id,business_id,card_id,score,text,reasons,phone,resolved_at,created_at&order=created_at.desc&limit=30`),
    // Все сообщения периода — для причин и скорости разбора
    db(env, `feedback?${range}&select=reasons,resolved_at,created_at&limit=20000`)
  ]);
  const reasons = new Map(REASON_KEYS.map((k) => [k, 0]));
  const resolveHours = [];
  for (const f of all) {
    for (const k of f.reasons || []) if (reasons.has(k)) reasons.set(k, reasons.get(k) + 1);
    if (f.resolved_at) resolveHours.push((Date.parse(f.resolved_at) - Date.parse(f.created_at)) / 3600e3);
  }
  resolveHours.sort((a, b) => a - b);
  const recovery = {
    total: all.length,
    resolved: resolveHours.length,
    medianHours: resolveHours.length ? resolveHours[Math.floor(resolveHours.length / 2)] : null,
    reasons
  };
  const dist = [0, 0, 0, 0, 0];
  const likes = new Map(LIKES.map((l) => [l.key, 0]));
  for (const r of ratings) {
    dist[r.score - 1]++;
    for (const k of r.likes || []) if (likes.has(k)) likes.set(k, likes.get(k) + 1);
  }
  const count = ratings.length;
  const avg = count ? ratings.reduce((sum, r) => sum + r.score, 0) / count : null;
  const high = dist[3] + dist[4];
  // Сколько довольных гостей (4–5) отметили хоть что-то — от них считаем проценты
  const liked = ratings.filter((r) => r.score >= 4 && r.likes && r.likes.length).length;
  return { count, avg, dist, low: dist[0] + dist[1] + dist[2], high, liked, likes, feedback, recovery };
}

// Владелец отмечает сообщение «Разобрано» (или возвращает в работу) — только сообщения своих заведений
export async function setFeedbackResolved(env, ids, feedbackId, resolved) {
  if (!Number.isInteger(feedbackId) || feedbackId <= 0) return;
  await db(env, `feedback?id=eq.${feedbackId}&business_id=in.(${ids.join(",")})`, {
    method: "PATCH",
    body: { resolved_at: resolved ? new Date().toISOString() : null },
    prefer: "return=minimal"
  });
}

// Раз в день: стираем телефоны гостей старше PHONE_KEEP_DAYS (сообщение остаётся, номер — нет)
export async function purgeOldPhones(env) {
  const before = encodeURIComponent(new Date(Date.now() - PHONE_KEEP_DAYS * 86400000).toISOString());
  await db(env, `feedback?phone=not.is.null&created_at=lt.${before}`, {
    method: "PATCH",
    body: { phone: null },
    prefer: "return=minimal"
  });
}

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
