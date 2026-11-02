// Постоянные гости (миграция 028): «С возвращением!» и штампы.
//
// Гостя узнаём по случайному номеру устройства в cookie tr_device (та же cookie, что для подарков).
// В базе — только хеш «номер + заведение + секрет», поэтому визиты в разные заведения между собой не связаны.
// Визит — не чаще раза в день и только при касании карты или QR (не по прямой ссылке).
// Штамп — код подарка, погашенный на кассе: подделать его гость не может.

import { db } from "./supabase.js";

export const DEVICE_COOKIE = "tr_device";
const DEVICE_RE = /^[A-Za-z0-9]{24}$/;
const DEVICE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz";
export const VISITS_KEEP_DAYS = 400;

// { deviceId, setCookie }: setCookie — заголовок, если cookie ещё не было
export function deviceFrom(request) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const current = cookies[DEVICE_COOKIE];
  if (DEVICE_RE.test(current || "")) return { deviceId: current, setCookie: null };
  const deviceId = randomString(DEVICE_ALPHABET, 24);
  return {
    deviceId,
    setCookie: `${DEVICE_COOKIE}=${deviceId}; Path=/; Max-Age=${VISITS_KEEP_DAYS * 24 * 3600}; HttpOnly; Secure; SameSite=Lax`
  };
}

export async function visitorKeyOf(env, deviceId, businessId) {
  return sha256(`${deviceId}|${businessId}|${env.HASH_SALT || env.SUPABASE_SECRET_KEY}`);
}

export function stampsOn(business) {
  return Boolean(business.stamps_goal && business.stamps_prize && business.bonus_mode && business.bonus_mode !== "off");
}

// Сколько штампов набрано с последнего приза за штампы (не больше цели)
export async function stampCount(env, business, key) {
  const rows = await db(
    env,
    `bonus_codes?business_id=eq.${business.id}&visitor_key=eq.${key}&select=redeemed_at,stamp_reward&order=created_at.desc&limit=50`
  );
  let count = 0;
  for (const r of rows) {
    if (r.stamp_reward) break;
    if (r.redeemed_at) count++;
  }
  return Math.min(count, business.stamps_goal);
}

// Для страницы заведения: отметить визит и узнать штампы. Ошибки не ломают страницу — просто без приветствия.
export async function guestOf(request, env, business, source) {
  if (source !== "nfc" && source !== "qr") return null;
  const { deviceId, setCookie } = deviceFrom(request);
  const key = await visitorKeyOf(env, deviceId, business.id);
  const [visits, stamps] = await Promise.all([
    db(env, "rpc/log_visit", { method: "POST", body: { p_business_id: business.id, p_key: key } }).catch((error) => {
      console.error(`log_visit: ${error.message}`);
      return null;
    }),
    stampsOn(business) && !setCookie
      ? stampCount(env, business, key).catch((error) => {
          console.error(`stampCount: ${error.message}`);
          return null;
        })
      : 0
  ]);
  return { visits: Number(visits) || null, stamps, setCookie };
}

// Раз в день: визиты старше VISITS_KEEP_DAYS удаляем
export async function purgeOldVisits(env) {
  const before = new Date(Date.now() - VISITS_KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  await db(env, `guest_visits?day=lt.${before}`, { method: "DELETE", prefer: "return=minimal" });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function randomString(alphabet, length) {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

async function sha256(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
