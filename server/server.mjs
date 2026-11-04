// TapReview на своём сервере (Россия): запускает тот же код, что работал на Cloudflare (src/index.js),
// под обычным Node.js. Перед ним стоит Caddy (HTTPS для tapreview.ru), база — PostgreSQL + PostgREST
// на этом же сервере.
//
//  - запросы: http://127.0.0.1:PORT ← Caddy; превращаем их в стандартный Request и отдаём src/index.js;
//  - файлы сайта (index.html, admin/, fonts/, assets/…) — env.ASSETS, как на Cloudflare: правила из _headers,
//    закрытые папки из .assetsignore, 404.html для несуществующих адресов;
//  - расписание: отчёт за неделю владельцам в Telegram по понедельникам в 09:00 МСК (как "0 6 * * 1").
//
// Настройки — переменные окружения (файл /etc/tapreview.env, его читает systemd): см. server/README.md.

import http from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import worker from "../src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const WEEKLY_REPORT_CRON = "0 6 * * 1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".xml": "application/xml; charset=utf-8"
};

// ---------- Настройки из окружения → env, как у Cloudflare Worker ----------

const env = { ...process.env, ASSETS: { fetch: serveAsset } };

// ---------- Закрытые папки (.assetsignore) и заголовки (_headers) ----------

let ignored = new Set();
let headerRules = [];

async function loadSiteRules() {
  try {
    const text = await fs.readFile(path.join(ROOT, ".assetsignore"), "utf8");
    ignored = new Set(text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } catch {
    ignored = new Set();
  }
  // Всегда закрыто: код сервера, настройки, служебные файлы
  for (const name of [".git", ".github", ".assetsignore", "wrangler.jsonc", "src", "server", "supabase", "node_modules"]) {
    ignored.add(name);
  }

  headerRules = [];
  try {
    const text = await fs.readFile(path.join(ROOT, "_headers"), "utf8");
    let current = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      if (!/^\s/.test(line)) {
        current = { pattern: line.trim(), headers: [] };
        headerRules.push(current);
      } else if (current) {
        const i = line.indexOf(":");
        if (i > 0) current.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
      }
    }
  } catch {
    headerRules = [];
  }
}

function headersFor(urlPath) {
  const out = [];
  for (const rule of headerRules) {
    const p = rule.pattern;
    const match = p.endsWith("*") ? urlPath.startsWith(p.slice(0, -1)) : urlPath === p;
    if (match) out.push(...rule.headers);
  }
  return out;
}

// ---------- Файлы сайта ----------

async function serveAsset(request) {
  const url = new URL(request.url);
  let urlPath;
  try {
    urlPath = decodeURIComponent(url.pathname);
  } catch {
    return notFound();
  }
  const parts = urlPath.split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p.startsWith(".")) || (parts[0] && ignored.has(parts[0]))) {
    return notFound();
  }

  let file = path.join(ROOT, ...parts);
  let stat = await fs.stat(file).catch(() => null);
  if (stat && stat.isDirectory()) {
    if (!urlPath.endsWith("/")) {
      return new Response(null, { status: 307, headers: { Location: `${url.pathname}/${url.search}` } });
    }
    file = path.join(file, "index.html");
    stat = await fs.stat(file).catch(() => null);
  } else if (!stat && !path.extname(file)) {
    // /oferta → /oferta.html, как у Cloudflare
    const html = `${file}.html`;
    const htmlStat = await fs.stat(html).catch(() => null);
    if (htmlStat) {
      file = html;
      stat = htmlStat;
    }
  }
  if (!stat || !stat.isFile()) return notFound();

  const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = new Headers({ "Content-Type": type, ETag: etag, "X-Content-Type-Options": "nosniff" });
  if (!type.startsWith("text/html")) headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  for (const [name, value] of headersFor(urlPath)) headers.set(name, value);

  if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") {
    headers.set("Content-Length", String(stat.size));
    return new Response(null, { status: 200, headers });
  }
  return new Response(Readable.toWeb(createReadStream(file)), { status: 200, headers });
}

async function notFound() {
  const page = await fs.readFile(path.join(ROOT, "404.html")).catch(() => null);
  return new Response(page || "Not found", {
    status: 404,
    headers: { "Content-Type": page ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" }
  });
}

// ---------- HTTP-сервер ----------

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "";
}

// ---------- /health — для внешней проверки «сайт жив» (Cloudflare Worker, src/uptime.js) ----------
// Без персональных данных: ok/ошибка базы и возраст последней копии базы на Яндекс Диске.
// Файл-отметку пишет server/offsite-backup.sh после успешной выгрузки.
const OFFSITE_MARK = "/var/lib/tapreview-offsite/last-ok";

async function health(res) {
  const out = { ok: true, db: "ok", backup_hours: null };
  try {
    const r = await fetch(`${String(env.DB_URL || "").replace(/\/+$/, "")}/businesses?select=id&limit=1`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(String(r.status));
  } catch {
    out.ok = false;
    out.db = "down";
  }
  try {
    const stat = await fs.stat(OFFSITE_MARK);
    out.backup_hours = Math.round((Date.now() - stat.mtimeMs) / 36e5);
  } catch {
    // копия на Яндекс Диск ещё не настроена
  }
  res.writeHead(out.ok ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(out));
}

const server = http.createServer(async (req, res) => {
  const waits = [];
  if (req.url === "/health") return health(res);
  try {
    const host = req.headers["x-forwarded-host"] || req.headers.host || "tapreview.ru";
    const proto = req.headers["x-forwarded-proto"] || "https";
    const url = `${proto}://${host}${req.url}`;

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
      else if (value !== undefined) headers.set(name, value);
    }
    // Код сайта берёт IP посетителя отсюда (как на Cloudflare) — только для обезличенного счёта, не сохраняется
    headers.set("CF-Connecting-IP", clientIp(req));

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(url, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? "half" : undefined
    });

    const ctx = { waitUntil: (promise) => waits.push(Promise.resolve(promise).catch((e) => console.error("waitUntil:", e))) };
    const response = await worker.fetch(request, env, ctx);

    const out = {};
    response.headers.forEach((value, name) => {
      if (name.toLowerCase() !== "set-cookie") out[name] = value;
    });
    const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(response.status, out);

    if (response.body && req.method !== "HEAD") {
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error(`Request error: ${error && error.stack ? error.stack : error}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Ошибка сервера");
  }
  Promise.allSettled(waits);
});

// ---------- Расписание (06:00 UTC = 09:00 МСК) ----------
//  - по понедельникам — недельный отчёт владельцам;
//  - каждый день — напоминания по заявкам. Повторов не будет даже после перезапуска:
//    в базе отмечается, о каких заявках сегодня уже напомнили (reminded_on).

const DAILY_CRON = "0 6 * * *";

function runCron(cron) {
  const waits = [];
  Promise.resolve(worker.scheduled({ cron }, env, { waitUntil: (p) => waits.push(p) }))
    .then(() => Promise.allSettled(waits))
    .catch((error) => console.error(`Cron ${cron} failed: ${error.stack || error}`));
}

// Каждые 10 минут — напоминания о неразобранных сообщениях недовольных гостей (src/rating.js feedbackReminders).
// Повторов нет: в базе отмечается, о каком сообщении уже напомнили (feedback.reminded_at).
const RECOVERY_CRON = "*/10 * * * *";
setInterval(() => runCron(RECOVERY_CRON), 10 * 60 * 1000);

let lastWeeklyRun = "";
let lastDailyRun = "";
setInterval(() => {
  const now = new Date();
  const key = now.toISOString().slice(0, 10);
  if (now.getUTCHours() !== 6) return;
  if (lastDailyRun !== key) {
    lastDailyRun = key;
    runCron(DAILY_CRON);
  }
  if (now.getUTCDay() === 1 && now.getUTCMinutes() < 5 && lastWeeklyRun !== key) {
    lastWeeklyRun = key;
    runCron(WEEKLY_REPORT_CRON);
  }
}, 30 * 1000);

// ---------- Запуск ----------

await loadSiteRules();
// Правила перечитываем раз в минуту — после обновления сайта перезапуск не обязателен для файлов
setInterval(() => loadSiteRules().catch(() => {}), 60 * 1000);

server.listen(PORT, HOST, () => {
  console.log(`TapReview: http://${HOST}:${PORT} (сайт: ${ROOT})`);
});
