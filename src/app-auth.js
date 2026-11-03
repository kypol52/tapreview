// Вход в Telegram Mini App и билеты «отзыв по карте».
//
// initData — строка, которую Telegram передаёт приложению при открытии. Её подписывает Telegram ключом,
// производным от токена бота (APP_BOT_TOKEN). Мы проверяем подпись на сервере, поэтому подделать
// Telegram ID с фронтенда нельзя. Запрос к API Telegram не нужен — блокировка Telegram на сервере не мешает.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// Билет карты: страница /c/КОД даёт ссылку t.me/<бот>/<приложение>?startapp=v_КОД_СРОК_ПОДПИСЬ.
// Подпись — HMAC от секрета сервера, срок — TICKET_HOURS. Отзыв с действующим билетом получает метку
// «по карте TapReview». Это НЕ доказательство визита (QR можно сфотографировать) — так и пишем в интерфейсе.

const enc = new TextEncoder();
export const INIT_DATA_MAX_AGE = 24 * 60 * 60;
export const TICKET_HOURS = 12;

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// → { tgId, startParam } или null, если подпись неверна, данные устарели или пользователя нет
export async function verifyInitData(initData, botToken, nowMs = Date.now()) {
  if (!initData || !botToken || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete("hash");

  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  if (!sameString(hex(await hmac(secret, checkString)), hash)) return null;

  const authDate = Number(params.get("auth_date"));
  const nowSec = nowMs / 1000;
  if (!Number.isFinite(authDate) || nowSec - authDate > INIT_DATA_MAX_AGE || authDate - nowSec > 300) return null;

  let user;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot) return null;
  return { tgId: user.id, startParam: String(params.get("start_param") || "").slice(0, 512) };
}

function ticketSecret(env) {
  const s = env.APP_TICKET_SECRET || env.HASH_SALT;
  if (!s) throw new Error("Не задан APP_TICKET_SECRET или HASH_SALT");
  return enc.encode(`card-ticket|${s}`);
}

// startapp-параметр для карты (только A–Z, a–z, 0–9, _ и - — так требует Telegram)
export async function makeCardTicket(env, cardCode, nowMs = Date.now()) {
  const exp = Math.floor(nowMs / 1000 + TICKET_HOURS * 3600).toString(36);
  const sig = hex(await hmac(ticketSecret(env), `${cardCode}|${exp}`)).slice(0, 24);
  return `v_${cardCode}_${exp}_${sig}`;
}

// → код карты, если билет настоящий и не истёк; иначе null
export async function readCardTicket(env, ticket, nowMs = Date.now()) {
  const m = /^v_([A-Z0-9]{4,12})_([0-9a-z]{1,10})_([0-9a-f]{24})$/.exec(String(ticket || ""));
  if (!m) return null;
  const [, code, exp, sig] = m;
  if (parseInt(exp, 36) * 1000 < nowMs) return null;
  const good = hex(await hmac(ticketSecret(env), `${code}|${exp}`)).slice(0, 24);
  return sameString(good, sig) ? code : null;
}
