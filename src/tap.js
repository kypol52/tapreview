// Метка «гость коснулся карты» и лимиты по сети — защита от накрутки.
//
// Карта напечатана с постоянной ссылкой (/c/КОД?s=qr, /b/slug?s=nfc), поэтому «?s=qr» в адресе ничего не доказывает:
// его можно дописать руками или переслать ссылку в чат. Поэтому:
//   1. Обычное открытие страницы с карты (без ?r=) ставит cookie tr_tap — номер заведения, источник, время и подпись
//      HMAC секретом сервера. Действует TAP_HOURS.
//   2. Оценка, сообщение владельцу, подарки, вызов персонала, код баллов и заказ со стола верят только этой cookie,
//      пришедшей ВМЕСТЕ с запросом, а не параметру ?s=. Ссылка «?r=1», присланная в чат или собранная вручную,
//      оценку не запишет.
//   3. Сфотографированный QR — это обычный скан, от него метка не спасает. Для этого — лимиты ниже (по сети и
//      на заведение): даже скрипт с несколькими телефонами упрётся в потолок, а не испортит статистику целиком.
//
// Лимиты по сети держим в памяти процесса (сервер один): IP не пишем в базу. После перезапуска счёт начинается заново.

import { isBot, sha256 } from "./analytics.js";

export const TAP_HOURS = 4;
const COOKIE = "tr_tap";
const enc = new TextEncoder();
const keys = new Map(); // секрет → ключ HMAC

function secret(env) {
  return env.HASH_SALT || env.SUPABASE_SECRET_KEY || "";
}

async function sign(env, message) {
  const s = secret(env);
  if (!keys.has(s)) keys.set(s, crypto.subtle.importKey("raw", enc.encode(`tap|${s}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", await keys.get(s), enc.encode(message)));
  return [...bytes.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Set-Cookie для гостя, открывшего страницу с карты (или null — робот, прямая ссылка)
export async function tapCookie(request, env, businessId, source) {
  if ((source !== "nfc" && source !== "qr") || isBot(request) || !secret(env)) return null;
  const body = `${Number(businessId).toString(36)}.${source}.${Math.floor(Date.now() / 1000).toString(36)}`;
  const value = `${body}.${await sign(env, body)}`;
  return `${COOKIE}=${value}; Max-Age=${TAP_HOURS * 3600}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

// → "nfc" | "qr", если запрос пришёл с действующей меткой этого заведения, иначе null
export async function tapOf(request, env, businessId) {
  if (!secret(env)) return null;
  const match = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)tr_tap=([a-z0-9]+)\.(nfc|qr)\.([a-z0-9]+)\.([0-9a-f]{24})(?:;|$)/);
  if (!match) return null;
  const [, bid, source, ts, sig] = match;
  if (parseInt(bid, 36) !== Number(businessId)) return null;
  const age = Date.now() / 1000 - parseInt(ts, 36);
  if (!(age >= -60 && age <= TAP_HOURS * 3600)) return null;
  const expected = await sign(env, `${bid}.${source}.${ts}`);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? source : null;
}

// ---------- Лимиты по сети (в памяти) ----------

const hits = new Map();
let lastSweep = 0;

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "";
}

// true — можно; false — с этого адреса уже limit действий kind за windowMs. Засчитывает попытку только если можно.
export async function ipAllow(request, env, kind, limit, windowMs) {
  const now = Date.now();
  if (now - lastSweep > 10 * 60e3) {
    lastSweep = now;
    for (const [k, list] of hits) if (!list.length || now - list[list.length - 1] > 24 * 3600e3) hits.delete(k);
  }
  const key = await sha256(`${kind}|${clientIp(request)}|${secret(env)}`);
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    hits.set(key, list);
    return false;
  }
  list.push(now);
  hits.set(key, list);
  return true;
}

// Для тестов: сбросить счётчики
export function resetIpLimits() {
  hits.clear();
}
