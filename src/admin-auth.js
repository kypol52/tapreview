// Вход в админ-панель на своём сервере (без Supabase Auth).
//
//   ADMIN_EMAILS        — кому можно входить (через запятую)
//   ADMIN_PASSWORD_HASH — хеш пароля: pbkdf2$<итерации>$<соль base64>$<хеш base64>
//                         (делает server/make-password.mjs; сам пароль нигде не хранится)
//   ADMIN_SESSION_SECRET — секрет для подписи токена сессии (длинная случайная строка)
//
// POST /api/login { email, password } → { access_token, expires_at, refresh_token: "local", user: { email } }
// Токен: base64url({ e: email, x: срок }) + "." + HMAC-SHA256. Действует 30 дней.
// Защита от подбора: не больше 5 неудачных попыток с одного IP за 10 минут.

const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const fails = new Map(); // ip → [время неудачи, ...] (в памяти процесса сервера)

const enc = new TextEncoder();

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64(text) {
  const s = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

export function localAuthEnabled(env) {
  return Boolean(env.ADMIN_PASSWORD_HASH && env.ADMIN_SESSION_SECRET);
}

function emailsOf(env) {
  return String(env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password, iterations = 210000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${b64url(salt)}$${b64url(hash)}`;
}

async function checkPassword(password, stored) {
  const [kind, iter, saltB64, hashB64] = String(stored || "").split("$");
  if (kind !== "pbkdf2" || !iter || !saltB64 || !hashB64) return false;
  const actual = await pbkdf2(password, fromB64(saltB64), Number(iter));
  const expected = fromB64(hashB64);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

async function hmac(env, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.ADMIN_SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

async function makeToken(env, email) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 24 * 3600;
  const body = b64url(enc.encode(JSON.stringify({ e: email, x: exp })));
  return { token: `${body}.${await hmac(env, body)}`, exp };
}

// Возвращает email или null
export async function verifyToken(env, token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const expected = await hmac(env, body);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64(body)));
    if (!data.e || !data.x || data.x < Date.now() / 1000) return null;
    if (!emailsOf(env).includes(String(data.e).toLowerCase())) return null;
    return data.e;
  } catch {
    return null;
  }
}

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export async function handleLogin(request, env) {
  if (request.method !== "POST") return reply({ error: "Метод не поддерживается" }, 405);
  if (!localAuthEnabled(env)) return reply({ error: "Вход не настроен" }, 404);

  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const now = Date.now();
  const recent = (fails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (recent.length >= MAX_FAILS) return reply({ error: "Слишком много попыток. Подождите 10 минут." }, 429);

  let data = {};
  try {
    data = JSON.parse((await request.text()).slice(0, 2000));
  } catch {
    // ниже — общий ответ
  }
  const email = String(data.email || "").trim().toLowerCase();
  const ok = emailsOf(env).includes(email) && (await checkPassword(String(data.password || ""), env.ADMIN_PASSWORD_HASH));
  if (!ok) {
    recent.push(now);
    fails.set(ip, recent);
    return reply({ error: "Неверный email или пароль" }, 401);
  }
  fails.delete(ip);
  const { token, exp } = await makeToken(env, email);
  return reply({ access_token: token, expires_at: exp, refresh_token: "local", user: { email } });
}
