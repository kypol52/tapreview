// Учёт открытий страницы и кликов по кнопкам.
//
// Что НЕ сохраняем: IP-адрес и браузер посетителя. Вместо них — обезличенный
// отпечаток (хеш), который меняется каждые сутки, поэтому человека нельзя отследить.
//
// Защита от накрутки:
//  - роботы и превью ссылок в мессенджерах не считаются;
//  - один и тот же посетитель считается один раз за 30 минут
//    (на одно и то же действие: открытие или клик по конкретной кнопке).

import { db } from "./supabase.js";

const DEDUPE_WINDOW_MINUTES = 30;

const BOT_RE =
  /(?<!cu)bot(\b|\/)|crawl|spider|slurp|preview|facebookexternalhit|embedly|^whatsapp\/|vkshare|slack-imgproxy|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|headless|lighthouse|pingdom|uptime/i;

const SOURCES = ["nfc", "qr"];

// Источник перехода: ?s=nfc (записано в NFC-карту) или ?s=qr (QR-код на карте)
export function sourceFrom(url) {
  const value = url.searchParams.get("s");
  return SOURCES.includes(value) ? value : "direct";
}

export function isBot(request) {
  const userAgent = request.headers.get("User-Agent") || "";
  return !userAgent || BOT_RE.test(userAgent);
}

// Записывает событие. Ошибки только логируются — посетитель их не увидит.
export async function logEvent(request, env, { businessId, eventType, destination, source }) {
  try {
    if (isBot(request)) return;

    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const windowNumber = Math.floor(now / (DEDUPE_WINDOW_MINUTES * 60 * 1000));

    const ip = request.headers.get("CF-Connecting-IP") || "";
    const userAgent = request.headers.get("User-Agent") || "";

    // Секретный ключ используется как «соль», чтобы хеш нельзя было подобрать перебором
    const visitorHash = await sha256(`${day}|${ip}|${userAgent}|${env.SUPABASE_SECRET_KEY}`);
    const dedupeKey = await sha256(
      `${businessId}|${eventType}|${destination || ""}|${visitorHash}|${windowNumber}`
    );

    await db(env, "click_events?on_conflict=dedupe_key", {
      method: "POST",
      body: {
        business_id: businessId,
        event_type: eventType,
        destination: destination || null,
        source,
        visitor_hash: visitorHash,
        dedupe_key: dedupeKey
      },
      prefer: "resolution=ignore-duplicates,return=minimal"
    });
  } catch (error) {
    console.error(`Не удалось записать событие: ${error.message}\n${error.stack}`);
  }
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
