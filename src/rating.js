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
    phoneLost: url.searchParams.get("np") === "1"
  };
}

// Российский номер → +7XXXXXXXXXX, иначе null
export function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10 && digits[0] === "9") return `+7${digits}`;
  if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) return `+7${digits.slice(1)}`;
  return null;
}

// Оценка: один посетитель — одна оценка за 30 минут (передумал — обновляется)
export async function logRating(request, env, { businessId, cardId, score, source, likes = [] }) {
  try {
    if (isBot(request)) return;
    const visitor = await visitorHashOf(request, env);
    const windowNumber = Math.floor(Date.now() / (DEDUPE_WINDOW_MINUTES * 60 * 1000));
    const body = {
      business_id: businessId,
      score,
      source,
      likes: score >= 4 ? likes : [],
      dedupe_key: await sha256(`${businessId}|rating|${visitor}|${windowNumber}`)
    };
    if (cardId) body.card_id = cardId;
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

  // Робот (скрытое поле) или пустое сообщение — просто возвращаем на страницу
  if (isBot(request) || String(form.get("website") || "").trim() || !message) return done();

  try {
    const rows = await db(env, `businesses?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=id,name&limit=1`);
    if (!rows.length) return done();
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
      const cards = await db(env, `cards?code=eq.${cardCode}&business_id=eq.${business.id}&select=id,code,label&limit=1`);
      card = cards[0] || null;
    }
    const body = { business_id: business.id, card_id: card ? card.id : null, score, text: message, source, visitor_hash: visitor };
    if (phone) Object.assign(body, { phone, phone_consent_at: new Date().toISOString() });
    const saved = await db(env, "feedback?select=id", { method: "POST", body, prefer: "return=representation" });
    ctx.waitUntil(notifyOwner(env, business, card, score, message, saved[0].id, Boolean(phone)));
  } catch (error) {
    console.error(`Feedback error: ${error.message}\n${error.stack}`);
  }
  return done();
}

// Сообщение сразу владельцу — всем, кто подключил Telegram-бота этого заведения
// Сам номер в Telegram не отправляем (серверы Telegram за пределами РФ) — только ссылку на статистику, где он виден
async function notifyOwner(env, business, card, score, message, id, hasPhone) {
  try {
    const chats = await db(env, `tg_subscribers?business_id=eq.${business.id}&select=chat_id`);
    if (!chats.length) return;
    const where = card ? `\n🃏 Карта ${card.label ? `«${esc(card.label)}» ` : ""}${card.code.slice(0, 3)}-${card.code.slice(3)}` : "";
    let contact = "Гость остался анонимным. Разберитесь с причиной, пока он ещё рядом, — так недовольство не уйдёт в публичный отзыв.";
    if (hasPhone) {
      const links = await db(
        env,
        `stats_links?or=(business_id.eq.${business.id},business_ids.cs.{${business.id}})&select=token&limit=1`
      ).catch(() => []);
      const base = String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
      contact = `📞 <b>Гость просит перезвонить.</b> Номер — в статистике${links.length ? `:\n${base}/s/${links[0].token}#fb` : " по вашей ссылке."}\n` +
        `Позвоните, пока впечатление свежее, — так недовольство не уйдёт в публичный отзыв.`;
    }
    const text =
      `😟 <b>${esc(business.name)}</b>: гость поставил ${"★".repeat(score)}${"☆".repeat(5 - score)} (${score} из 5)${where}\n\n` +
      `«${esc(message)}»\n\n` +
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

// Для статистики: оценки и сообщения за период
export async function ratingStats(env, ids, { from, to, cardId = null }) {
  const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());
  const card = cardId ? `&card_id=eq.${cardId}` : "";
  const range = `business_id=in.(${ids.join(",")})${card}&created_at=gte.${iso(from)}&created_at=lte.${iso(to)}`;
  const [ratings, feedback] = await Promise.all([
    db(env, `ratings?${range}&select=score,likes&limit=20000`),
    db(env, `feedback?${range}&select=id,business_id,card_id,score,text,phone,resolved_at,created_at&order=created_at.desc&limit=30`)
  ]);
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
  return { count, avg, dist, low: dist[0] + dist[1] + dist[2], high, liked, likes, feedback };
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
