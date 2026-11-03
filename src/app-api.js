// API Telegram Mini App «каталог и отзывы» (миграция 034). Приложение — /app/ (статичные файлы).
//
// Кто есть кто: каждый запрос несёт заголовок «Authorization: tma <initData>». Подпись проверяет
// app-auth.js ключом бота APP_BOT_TOKEN. Без заголовка можно только читать каталог (например, из браузера).
// В ответы никогда не попадает Telegram ID — автор отзыва публично «Гость».
//
//   GET    /api/app/config                     — имя бота и приложения (для ссылок t.me/…)
//   GET    /api/app/home?city=                 — города, категории, лучшие, популярные, новые (в выбранном городе)
//   GET    /api/app/places?q=&cat=&min=&sort=&city=&offset= — каталог (только заведения с catalog_visible)
//   GET    /api/app/nearby                     — заведения каталога с координатами (расстояние считает телефон:
//                                                 геопозиция гостя на сервер не передаётся)
//   GET    /api/app/places/:slug               — заведение, рейтинг, первые отзывы, мой отзыв, избранное
//   GET    /api/app/places/:slug/reviews?offset= — ещё отзывы
//   POST   /api/app/reviews                    — оставить или изменить свой отзыв → на проверку
//   DELETE /api/app/reviews/:id                — удалить свой отзыв
//   POST   /api/app/reviews/:id/report         — жалоба { reason, comment }
//   PUT    /api/app/reviews/:id/helpful, DELETE — «Полезно» (один голос, не за свой отзыв)
//   GET    /api/app/places/:slug[/reviews]?sort=new|helpful|photo|low|high — порядок отзывов
//   POST   /api/app/reviews/:id/reply          — ответ заведения { text } (владелец с правом управления)
//   DELETE /api/app/reviews/:id/reply          — удалить ответ заведения
//   PUT    /api/app/favorites/:slug, DELETE    — избранное
//   GET    /api/app/me                         — мои отзывы, избранное, мои заведения
//   PATCH  /api/app/me                         — { notify }: сообщения о моих отзывах от бота (согласие гостя)
//   DELETE /api/app/me                         — удалить мои данные (отзывы, жалобы, избранное, привязанные телефоны)
//   GET    /api/app/wallet                     — «Мои заведения и подарки»: визиты, штампы, уровень, коды (guest-wallet.js)
//   POST   /api/app/devices/link {token}       — связать телефон (ссылка со страницы карты), DELETE /api/app/devices — отвязать
//   GET    /api/app/ticket?t=                  — проверить билет карты (для метки в форме)
//   GET    /api/app/biz/:slug?period=week|month — кабинет заведения (только владелец): рейтинг, динамика,
//                                                 отзывы без ответа, переходы с карт (report.js — те же цифры, что в боте)
//   PATCH  /api/app/biz/:slug                  — { description, city, address, coords }
//   POST   /api/app/biz/:slug/catalog          — { on, consent } показ в каталоге (согласие владельца), { appButton }
//   POST   /api/app/biz/:slug/photos           — { photo: dataURL } (до 8), DELETE …/photos/:id
//
// Модерация (админ-панель, /api/admin/app/*) — handleAppAdmin внизу файла.

import { db } from "./supabase.js";
import { verifyInitData, readCardTicket } from "./app-auth.js";
import { saveMedia, MEDIA_ID_RE } from "./media.js";
import { loadReports, loadDaily } from "./report.js";
import { tg, tgAs } from "./telegram.js";
import { escapeHtml } from "./public-page.js";
import { walletSummary, linkDevice, unlinkDevices } from "./guest-wallet.js";

export const APP_CATEGORIES = [
  { key: "restaurant", label: "Кафе и рестораны" },
  { key: "beauty", label: "Салоны красоты" },
  { key: "barber", label: "Барбершопы" },
  { key: "shop", label: "Магазины" },
  { key: "other", label: "Другое" }
];
const MAIN_CATS = new Set(["restaurant", "beauty", "barber", "shop"]);
const SORTS = ["top", "popular", "new", "name"];
const REPORT_REASONS = ["spam", "offensive", "fake", "personal", "other"];
const SLUG_RE = /^[A-Za-z0-9_-]{3,64}$/;
const PAGE = 20;
const MAX_TEXT = 2000;
const MAX_REPLY = 1000;
const MAX_BODY = 600000; // фото отзыва в base64 (браузер сжимает до ~300 КБ)
const NEW_REVIEWS_PER_DAY = 5;
const REPORTS_TO_RECHECK = 3; // столько жалоб — опубликованный отзыв снова уходит на проверку

const PLACE_COLUMNS =
  "id,slug,name,tagline,category,city,address,description,logo_url,design,photos,extra_links," +
  "google_url,yandex_url,twogis_url,catalog_visible,lat,lon";

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- Маленькие помощники ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}

async function readJson(request, max = 20000) {
  const text = await request.text();
  if (text.length > max) throw new AppError(413, "Слишком большой запрос");
  try {
    const data = JSON.parse(text || "{}");
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new AppError(400, "Неверный формат запроса");
  }
}

// Текст от пользователя: без управляющих символов, обрезанные пробелы, не длиннее max
export function cleanUserText(value, max, label) {
  const s = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (s.length > max) throw new AppError(400, `${label}: не длиннее ${max} символов`);
  return s;
}

// Ограничитель частоты в памяти сервера: не больше limit действий за windowMs
const hits = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= limit) throw new AppError(429, "Слишком часто. Попробуйте чуть позже");
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 3600e3) hits.delete(k);
}

const mediaUrl = (id) => (id && MEDIA_ID_RE.test(String(id)) ? `/m/${id}` : null);
const logoOf = (b) => b.logo_url || mediaUrl(b.design && b.design.logo);
const catLabel = (key) => (APP_CATEGORIES.find((c) => c.key === (MAIN_CATS.has(key) ? key : "other")) || {}).label;
const avg = (v) => (v === null || v === undefined ? null : Number(v));

// ---------- Кто пользователь ----------

// Кэш на минуту: не ходить в базу на каждый запрос; бан срабатывает не позже чем через минуту
const userCache = new Map();

export async function appUser(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("tma ")) return null;
  if (!env.APP_BOT_TOKEN) throw new AppError(503, "Приложение ещё не настроено");
  const auth = await verifyInitData(header.slice(4), env.APP_BOT_TOKEN);
  if (!auth) throw new AppError(401, "Откройте приложение заново из Telegram");

  const cached = userCache.get(auth.tgId);
  if (cached && Date.now() - cached.at < 60e3) return { ...cached.user, startParam: auth.startParam };

  const rows = await db(env, "app_users?on_conflict=tg_id&select=id,tg_id,banned_at", {
    method: "POST",
    body: { tg_id: auth.tgId, last_seen_at: new Date().toISOString() },
    prefer: "resolution=merge-duplicates,return=representation"
  });
  const user = { id: rows[0].id, tgId: rows[0].tg_id, banned: Boolean(rows[0].banned_at) };
  userCache.set(auth.tgId, { user, at: Date.now() });
  if (userCache.size > 5000) userCache.delete(userCache.keys().next().value);
  return { ...user, startParam: auth.startParam };
}

async function requireUser(request, env, { write = false } = {}) {
  const user = await appUser(request, env);
  if (!user) throw new AppError(401, "Откройте приложение в Telegram");
  if (write && user.banned) throw new AppError(403, "Вы не можете оставлять отзывы и жалобы");
  return user;
}

// Заведения, которыми пользователь управляет: его Telegram подключён к боту владельцев с правом управления
async function ownedIds(env, user) {
  if (!user) return [];
  const rows = await db(env, `tg_subscribers?chat_id=eq.${user.tgId}&can_manage=is.true&select=business_id`);
  return rows.map((r) => r.business_id);
}

// ---------- Маршрутизатор ----------

export async function handleAppApi(request, env, url) {
  try {
    const path = url.pathname.replace(/\/+$/, "");
    const method = request.method;

    // Имя бота и приложения — для ссылок «Открыть в Telegram» и «Поделиться» (не секрет)
    if (path === "/api/app/config" && method === "GET") {
      // share — домен для ссылок «Поделиться» (share.tapreview.ru на Cloudflare: Telegram строит превью там)
      return json({ bot: env.APP_BOT_USERNAME || null, app: env.APP_SHORT_NAME || null, share: env.SHARE_BASE_URL || null });
    }
    if (path === "/api/app/home" && method === "GET") return await home(env, url);
    if (path === "/api/app/places" && method === "GET") return await places(env, url);
    if (path === "/api/app/nearby" && method === "GET") return await nearby(env);

    let m = path.match(/^\/api\/app\/places\/([^/]+)$/);
    if (m && method === "GET") return await place(request, env, m[1], url);
    m = path.match(/^\/api\/app\/places\/([^/]+)\/reviews$/);
    if (m && method === "GET") return await moreReviews(request, env, m[1], url);

    if (path === "/api/app/reviews" && method === "POST") return await saveReview(request, env);
    m = path.match(/^\/api\/app\/reviews\/(\d{1,18})$/);
    if (m && method === "DELETE") return await deleteReview(request, env, m[1]);
    m = path.match(/^\/api\/app\/reviews\/(\d{1,18})\/report$/);
    if (m && method === "POST") return await report(request, env, m[1]);
    m = path.match(/^\/api\/app\/reviews\/(\d{1,18})\/helpful$/);
    if (m && (method === "PUT" || method === "DELETE")) return await helpful(request, env, m[1], method === "PUT");
    m = path.match(/^\/api\/app\/reviews\/(\d{1,18})\/reply$/);
    if (m && (method === "POST" || method === "DELETE")) return await reply(request, env, m[1], method === "DELETE");

    m = path.match(/^\/api\/app\/favorites\/([^/]+)$/);
    if (m && (method === "PUT" || method === "DELETE")) return await favorite(request, env, m[1], method === "PUT");

    m = path.match(/^\/api\/app\/biz\/([^/]+)$/);
    if (m && method === "GET") return await bizCabinet(request, env, m[1], url);
    if (m && method === "PATCH") return await bizUpdate(request, env, m[1]);
    m = path.match(/^\/api\/app\/biz\/([^/]+)\/catalog$/);
    if (m && method === "POST") return await bizCatalog(request, env, m[1]);
    m = path.match(/^\/api\/app\/biz\/([^/]+)\/photos$/);
    if (m && method === "POST") return await bizPhotoAdd(request, env, m[1]);
    m = path.match(/^\/api\/app\/biz\/([^/]+)\/photos\/([0-9a-f-]{36})$/);
    if (m && method === "DELETE") return await bizPhotoDelete(request, env, m[1], m[2]);

    // «Мои заведения и подарки» (guest-wallet.js, миграция 041)
    if (path === "/api/app/wallet" && method === "GET") return json(await walletSummary(env, await requireUser(request, env)));
    if (path === "/api/app/devices/link" && method === "POST") {
      const user = await requireUser(request, env);
      rateLimit(`d:${user.id}`, 10, 3600e3);
      const input = await readJson(request);
      try {
        return json(await linkDevice(env, user, input.token));
      } catch (error) {
        if (error.status) throw new AppError(error.status, error.message);
        throw error;
      }
    }
    if (path === "/api/app/devices" && method === "DELETE") return json(await unlinkDevices(env, await requireUser(request, env)));

    if (path === "/api/app/me" && method === "GET") return await me(request, env);
    if (path === "/api/app/me" && method === "PATCH") return await meSettings(request, env);
    if (path === "/api/app/me" && method === "DELETE") return await deleteMe(request, env);
    if (path === "/api/app/ticket" && method === "GET") return await ticketInfo(env, url);

    return json({ error: "Не найдено" }, 404);
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    console.error(`App API error: ${error.message}\n${error.stack}`);
    return json({ error: "Ошибка сервера. Попробуйте позже" }, 500);
  }
}

// ---------- Каталог ----------

function card(row) {
  return {
    slug: row.slug,
    name: row.name,
    category: MAIN_CATS.has(row.category) ? row.category : "other",
    categoryLabel: catLabel(row.category),
    city: row.city || null,
    address: row.address || null,
    tagline: row.tagline || null,
    logo: logoOf(row),
    cover: mediaUrl(row.cover),
    rating: avg(row.avg_score),
    reviews: Number(row.reviews || 0)
  };
}

async function catalog(env, args) {
  return db(env, "rpc/app_catalog", { method: "POST", body: args });
}

// Город из запроса: как его ввели в админке, сравнение без учёта регистра (в базе — app_catalog p_city)
const cityKey = (s) => String(s || "").trim().toLowerCase();

async function home(env, url) {
  const all = await db(env, "businesses?is_active=is.true&catalog_visible=is.true&select=category,city&limit=5000");
  // Города каталога: от большего к меньшему
  const cityMap = new Map();
  for (const b of all) {
    const key = cityKey(b.city);
    if (!key) continue;
    const c = cityMap.get(key) || { name: String(b.city).trim(), count: 0 };
    c.count++;
    cityMap.set(key, c);
  }
  const cities = [...cityMap.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ru"));
  const wanted = cityMap.get(cityKey(url.searchParams.get("city")));
  const city = wanted ? wanted.name : null;
  const inCity = city ? all.filter((b) => cityKey(b.city) === cityKey(city)) : all;

  const monthFrom = encodeURIComponent(new Date(Date.now() - 30 * 864e5).toISOString());
  const [top, popular, recent, monthReviews, inCatalog] = await Promise.all([
    catalog(env, { p_sort: "top", p_min_reviews: 1, p_limit: 10, p_city: city }),
    catalog(env, { p_sort: "popular", p_limit: 10, p_city: city }),
    catalog(env, { p_sort: "new", p_limit: 10, p_city: city }),
    db(env, `reviews?status=eq.published&created_at=gte.${monthFrom}&select=business_id,score&limit=100000`),
    catalog(env, { p_sort: "name", p_limit: 50, p_city: city })
  ]);
  // «Лучшее за месяц»: средняя по отзывам за 30 дней, минимум 2 отзыва (рейтинг на плитке — тоже за месяц)
  const month = new Map();
  for (const r of monthReviews) {
    const m = month.get(r.business_id) || { n: 0, sum: 0 };
    m.n++;
    m.sum += r.score;
    month.set(r.business_id, m);
  }
  const best = inCatalog
    .filter((b) => (month.get(b.id) || { n: 0 }).n >= 2)
    .map((b) => {
      const m = month.get(b.id);
      return { ...b, reviews: m.n, avg_score: Math.round((m.sum / m.n) * 10) / 10 };
    })
    .sort((a, b) => b.avg_score - a.avg_score || b.reviews - a.reviews)
    .slice(0, 10);
  const counts = {};
  for (const b of inCity) {
    const key = MAIN_CATS.has(b.category) ? b.category : "other";
    counts[key] = (counts[key] || 0) + 1;
  }
  return json({
    cities,
    city,
    categories: APP_CATEGORIES.map((c) => ({ ...c, count: counts[c.key] || 0 })),
    total: inCity.length,
    top: top.map(card),
    month: best.map(card),
    popular: popular.filter((r) => Number(r.views_30d) > 0).map(card),
    recent: recent.map(card)
  });
}

async function places(env, url) {
  const q = cleanUserText(url.searchParams.get("q"), 80, "Поиск");
  const cat = url.searchParams.get("cat");
  const min = Number(url.searchParams.get("min"));
  const sort = SORTS.includes(url.searchParams.get("sort")) ? url.searchParams.get("sort") : "top";
  const offset = Math.max(0, Math.min(5000, Math.floor(Number(url.searchParams.get("offset")) || 0)));
  const city = cleanUserText(url.searchParams.get("city"), 60, "Город");
  const rows = await catalog(env, {
    p_city: city || null,
    p_q: q || null,
    p_category: APP_CATEGORIES.some((c) => c.key === cat) ? cat : null,
    p_min_score: [3, 4, 4.5].includes(min) ? min : null,
    p_sort: sort,
    p_limit: PAGE + 1,
    p_offset: offset
  });
  // Первая страница несёт и список городов — для кнопки «город», если каталог открыли не с главной
  let cities;
  if (!offset) {
    const all = await db(env, "businesses?is_active=is.true&catalog_visible=is.true&city=not.is.null&select=city&limit=5000");
    const map = new Map();
    for (const b of all) {
      const key = cityKey(b.city);
      if (!key) continue;
      const c = map.get(key) || { name: String(b.city).trim(), count: 0 };
      c.count++;
      map.set(key, c);
    }
    cities = [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ru"));
  }
  return json({ items: rows.slice(0, PAGE).map(card), more: rows.length > PAGE, cities });
}

// «Рядом со мной»: все заведения каталога с координатами + рейтинг. Сортирует по расстоянию само приложение.
async function nearby(env) {
  const rows = await db(env, "businesses?is_active=is.true&catalog_visible=is.true&lat=not.is.null&select=id,slug,name,category,city,address,tagline,logo_url,design,photos,lat,lon&limit=3000");
  const ids = rows.map((b) => b.id);
  const scores = ids.length
    ? await db(env, `reviews?business_id=in.(${ids.join(",")})&status=eq.published&select=business_id,score&limit=200000`)
    : [];
  const agg = new Map();
  for (const s of scores) {
    const a = agg.get(s.business_id) || { n: 0, sum: 0 };
    a.n++;
    a.sum += s.score;
    agg.set(s.business_id, a);
  }
  return json({
    items: rows.map((b) => {
      const a = agg.get(b.id);
      return {
        ...card({ ...b, cover: (b.photos || [])[0], reviews: a ? a.n : 0, avg_score: a ? Math.round((a.sum / a.n) * 10) / 10 : null }),
        lat: b.lat,
        lon: b.lon
      };
    })
  });
}

// ---------- Заведение ----------

async function findPlace(env, slug) {
  if (!SLUG_RE.test(slug)) throw new AppError(404, "Заведение не найдено");
  const rows = await db(env, `businesses?slug=eq.${encodeURIComponent(slug)}&is_active=is.true&catalog_visible=is.true&select=${PLACE_COLUMNS}&limit=1`);
  if (!rows.length) throw new AppError(404, "Заведение не найдено или скрыто из каталога");
  return rows[0];
}

function publicReview(r, userId, extra = {}) {
  return {
    id: r.id,
    score: r.score,
    text: r.text,
    photo: mediaUrl(r.photo_id),
    date: r.created_at,
    edited: r.edited_at || null,
    viaCard: Boolean(r.card_id),
    reply: r.reply_text ? { text: r.reply_text, date: r.reply_at } : null,
    mine: Boolean(userId && r.user_id === userId),
    helpful: Number(r.helpful || 0),
    ...extra
  };
}

const REVIEW_COLUMNS = "id,user_id,score,text,photo_id,status,reject_reason,card_id,reply_text,reply_at,edited_at,created_at,updated_at,helpful";

// Сортировка отзывов на странице заведения (миграция 038 — счётчик «Полезно»)
const REVIEW_SORTS = {
  new: "order=created_at.desc,id.desc",
  helpful: "order=helpful.desc,created_at.desc,id.desc",
  photo: "photo_id=not.is.null&order=created_at.desc,id.desc",
  low: "order=score.asc,created_at.desc,id.desc",
  high: "order=score.desc,created_at.desc,id.desc"
};
const reviewSortOf = (url) => (REVIEW_SORTS[url.searchParams.get("sort")] ? url.searchParams.get("sort") : "new");

async function reviewPage(env, businessId, offset, sort = "new") {
  const rows = await db(
    env,
    `reviews?business_id=eq.${businessId}&status=eq.published&select=${REVIEW_COLUMNS}&${REVIEW_SORTS[sort]}&limit=${PAGE + 1}&offset=${offset}`
  );
  return { rows: rows.slice(0, PAGE), more: rows.length > PAGE };
}

// За какие из этих отзывов пользователь уже голосовал «Полезно»
async function votedSet(env, user, rows) {
  if (!user || !rows.length) return new Set();
  const votes = await db(env, `review_votes?user_id=eq.${user.id}&review_id=in.(${rows.map((r) => r.id).join(",")})&select=review_id`);
  return new Set(votes.map((v) => v.review_id));
}

async function place(request, env, slug, url) {
  const user = await appUser(request, env).catch((e) => {
    if (e instanceof AppError && e.status === 401) return null; // читать можно и без входа
    throw e;
  });
  const b = await findPlace(env, slug);
  const sort = reviewSortOf(url);
  const [dist, page, mine, fav, owned] = await Promise.all([
    db(env, "rpc/app_place_rating", { method: "POST", body: { p_business_id: b.id } }),
    reviewPage(env, b.id, 0, sort),
    user ? db(env, `reviews?business_id=eq.${b.id}&user_id=eq.${user.id}&select=${REVIEW_COLUMNS}`) : [],
    user ? db(env, `favorites?business_id=eq.${b.id}&user_id=eq.${user.id}&select=business_id`) : [],
    ownedIds(env, user)
  ]);
  const counts = [0, 0, 0, 0, 0];
  let sum = 0;
  let total = 0;
  for (const d of dist) {
    counts[d.score - 1] = Number(d.cnt);
    sum += d.score * Number(d.cnt);
    total += Number(d.cnt);
  }
  const isOwner = owned.includes(b.id);
  const voted = await votedSet(env, user, page.rows);
  const links =(Array.isArray(b.extra_links) ? b.extra_links : []).map((l) => ({ type: l.type, url: l.url, label: l.label || null }));
  return json({
    place: {
      slug: b.slug,
      name: b.name,
      category: MAIN_CATS.has(b.category) ? b.category : "other",
      categoryLabel: catLabel(b.category),
      tagline: b.tagline || null,
      city: b.city || null,
      address: b.address || null,
      description: b.description || null,
      logo: logoOf(b),
      photos: (b.photos || []).map(mediaUrl).filter(Boolean),
      links,
      maps: { yandex: b.yandex_url || null, google: b.google_url || null, twogis: b.twogis_url || null },
      coords: b.lat != null && b.lon != null ? { lat: b.lat, lon: b.lon } : null
    },
    rating: { avg: total ? Math.round((sum / total) * 10) / 10 : null, count: total, dist: counts },
    reviews: page.rows.map((r) => publicReview(r, user && user.id, { voted: voted.has(r.id) })),
    sort,
    more: page.more,
    myReview: mine.length ? myReview(mine[0]) : null,
    favorite: fav.length > 0,
    isOwner,
    signedIn: Boolean(user),
    banned: Boolean(user && user.banned)
  });
}

function myReview(r) {
  return {
    id: r.id,
    score: r.score,
    text: r.text,
    photo: mediaUrl(r.photo_id),
    status: r.status,
    rejectReason: r.status === "rejected" ? r.reject_reason || null : null,
    viaCard: Boolean(r.card_id),
    reply: r.reply_text ? { text: r.reply_text, date: r.reply_at } : null,
    date: r.created_at,
    updated: r.updated_at
  };
}

async function moreReviews(request, env, slug, url) {
  const user = await appUser(request, env).catch(() => null);
  const b = await findPlace(env, slug);
  const offset = Math.max(0, Math.min(100000, Math.floor(Number(url.searchParams.get("offset")) || 0)));
  const page = await reviewPage(env, b.id, offset, reviewSortOf(url));
  const voted = await votedSet(env, user, page.rows);
  return json({ reviews: page.rows.map((r) => publicReview(r, user && user.id, { voted: voted.has(r.id) })), more: page.more });
}

// ---------- Отзывы ----------

async function ticketInfo(env, url) {
  const code = await readCardTicket(env, url.searchParams.get("t"));
  if (!code) return json({ valid: false });
  const rows = await db(env, `cards?code=eq.${code}&is_active=is.true&select=business_id,businesses(slug,catalog_visible,is_active)&limit=1`);
  const b = rows.length && rows[0].businesses;
  if (!b || !b.is_active) return json({ valid: false });
  return json({ valid: true, slug: b.slug, inCatalog: Boolean(b.catalog_visible) });
}

async function saveReview(request, env) {
  const user = await requireUser(request, env, { write: true });
  rateLimit(`w:${user.id}`, 10, 10 * 60e3);
  const input = await readJson(request, MAX_BODY);
  const b = await findPlace(env, String(input.slug || ""));

  const score = Number(input.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) throw new AppError(400, "Поставьте оценку от 1 до 5 звёзд");
  const text = cleanUserText(input.text, MAX_TEXT, "Отзыв");
  if (score <= 2 && text.length < 10) throw new AppError(400, "Расскажите, что пошло не так — хотя бы пару слов");

  const existing = (await db(env, `reviews?business_id=eq.${b.id}&user_id=eq.${user.id}&select=id,photo_id,card_id`))[0];
  if (!existing) {
    const since = encodeURIComponent(new Date(Date.now() - 24 * 3600e3).toISOString());
    const recent = await db(env, `reviews?user_id=eq.${user.id}&created_at=gte.${since}&select=id`);
    if (recent.length >= NEW_REVIEWS_PER_DAY) throw new AppError(429, `Не больше ${NEW_REVIEWS_PER_DAY} новых отзывов в сутки`);
  }

  // Билет карты: только настоящий, не истёкший и от карты этого заведения
  let cardId = existing ? existing.card_id : null;
  if (!cardId && input.ticket) {
    const code = await readCardTicket(env, input.ticket);
    if (code) {
      const cards = await db(env, `cards?code=eq.${code}&business_id=eq.${b.id}&is_active=is.true&select=id`);
      if (cards.length) cardId = cards[0].id;
    }
  }

  // Фото: новое (dataURL), оставить прежнее (keepPhoto) или убрать
  let photoId = existing && input.keepPhoto ? existing.photo_id : null;
  if (input.photo) {
    try {
      photoId = await saveMedia(env, "review", input.photo);
    } catch (error) {
      throw new AppError(400, error.message);
    }
  }

  const body = { score, text, photo_id: photoId, card_id: cardId, status: "pending", reject_reason: null, moderated_at: null };
  let row;
  if (existing) {
    body.edited_at = new Date().toISOString();
    row = (await db(env, `reviews?id=eq.${existing.id}&select=${REVIEW_COLUMNS}`, { method: "PATCH", body, prefer: "return=representation" }))[0];
    if (existing.photo_id && existing.photo_id !== photoId) await dropMedia(env, existing.photo_id);
  } else {
    row = (await db(env, `reviews?select=${REVIEW_COLUMNS}`, {
      method: "POST",
      body: { ...body, business_id: b.id, user_id: user.id },
      prefer: "return=representation"
    }))[0];
  }
  // Не ждём: сообщение модератору уходит в фоне (сервер работает постоянно)
  notifyModerators(env, existing ? "Отзыв изменён — снова на проверке" : "Новый отзыв на проверке");
  // notify — включены ли сообщения о отзывах: если нет, приложение один раз предложит их включить
  const settings = await db(env, `app_users?id=eq.${user.id}&select=notify`);
  return json({ review: myReview(row), notify: Boolean(settings[0] && settings[0].notify) }, existing ? 200 : 201);
}

async function dropMedia(env, id) {
  if (!id) return;
  try {
    await db(env, `media?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
  } catch (error) {
    console.error(`Не удалось удалить картинку ${id}: ${error.message}`);
  }
}

async function deleteReview(request, env, id) {
  const user = await requireUser(request, env);
  const rows = await db(env, `reviews?id=eq.${id}&user_id=eq.${user.id}&select=id,photo_id`, { method: "DELETE", prefer: "return=representation" });
  if (!rows.length) throw new AppError(404, "Отзыв не найден");
  await dropMedia(env, rows[0].photo_id);
  return json({ deleted: true });
}

async function report(request, env, id) {
  const user = await requireUser(request, env, { write: true });
  rateLimit(`r:${user.id}`, 20, 24 * 3600e3);
  const input = await readJson(request);
  const reason = REPORT_REASONS.includes(input.reason) ? input.reason : null;
  if (!reason) throw new AppError(400, "Выберите причину жалобы");
  const comment = cleanUserText(input.comment, 500, "Комментарий") || null;

  const rows = await db(env, `reviews?id=eq.${id}&status=eq.published&select=id,user_id`);
  if (!rows.length) throw new AppError(404, "Отзыв не найден");
  if (rows[0].user_id === user.id) throw new AppError(400, "Это ваш отзыв — его можно изменить или удалить");

  await db(env, "review_reports?on_conflict=review_id,user_id", {
    method: "POST",
    body: { review_id: Number(id), user_id: user.id, reason, comment },
    prefer: "resolution=ignore-duplicates,return=minimal"
  });
  const open = await db(env, `review_reports?review_id=eq.${id}&resolved_at=is.null&select=id`);
  if (open.length >= REPORTS_TO_RECHECK) {
    const moved = await db(env, `reviews?id=eq.${id}&status=eq.published&select=id`, { method: "PATCH", body: { status: "pending" }, prefer: "return=representation" });
    if (moved.length) notifyModerators(env, "Отзыв снят с публикации после жалоб", { force: true });
  }
  return json({ ok: true });
}

async function helpful(request, env, id, on) {
  const user = await requireUser(request, env, { write: true });
  rateLimit(`h:${user.id}`, 60, 10 * 60e3);
  const rows = await db(env, `reviews?id=eq.${id}&status=eq.published&select=id,user_id`);
  if (!rows.length) throw new AppError(404, "Отзыв не найден");
  if (rows[0].user_id === user.id) throw new AppError(400, "За свой отзыв голосовать нельзя");
  if (on) {
    await db(env, "review_votes?on_conflict=review_id,user_id", {
      method: "POST",
      body: { review_id: Number(id), user_id: user.id },
      prefer: "resolution=ignore-duplicates,return=minimal"
    });
  } else {
    await db(env, `review_votes?review_id=eq.${id}&user_id=eq.${user.id}`, { method: "DELETE", prefer: "return=minimal" });
  }
  const after = await db(env, `reviews?id=eq.${id}&select=helpful`);
  return json({ voted: on, helpful: after.length ? after[0].helpful : 0 });
}

async function reply(request, env, id, remove) {
  const user = await requireUser(request, env, { write: true });
  const rows = await db(env, `reviews?id=eq.${id}&select=id,business_id,status`);
  if (!rows.length) throw new AppError(404, "Отзыв не найден");
  if (!(await ownedIds(env, user)).includes(rows[0].business_id)) throw new AppError(403, "Отвечать может только представитель заведения");
  let body = { reply_text: null, reply_at: null };
  if (!remove) {
    rateLimit(`a:${user.id}`, 30, 3600e3);
    const text = cleanUserText((await readJson(request)).text, MAX_REPLY, "Ответ");
    if (text.length < 2) throw new AppError(400, "Напишите ответ");
    body = { reply_text: text, reply_at: new Date().toISOString() };
  }
  // Ответ меняет только эти два поля — статус отзыва и updated_at автора не трогаем
  await db(env, `reviews?id=eq.${id}`, { method: "PATCH", body, prefer: "return=minimal" });
  // Автору — только про ответ на опубликованный отзыв (на проверке его ещё никто не видит)
  if (!remove && rows[0].status === "published") notifyAuthor(env, id, "reply");
  return json({ reply: body.reply_text ? { text: body.reply_text, date: body.reply_at } : null });
}

// ---------- Избранное и профиль ----------

async function favorite(request, env, slug, on) {
  const user = await requireUser(request, env);
  rateLimit(`f:${user.id}`, 60, 60e3);
  const b = await findPlace(env, slug);
  if (on) {
    await db(env, "favorites?on_conflict=user_id,business_id", {
      method: "POST",
      body: { user_id: user.id, business_id: b.id },
      prefer: "resolution=ignore-duplicates,return=minimal"
    });
  } else {
    await db(env, `favorites?user_id=eq.${user.id}&business_id=eq.${b.id}`, { method: "DELETE", prefer: "return=minimal" });
  }
  return json({ favorite: on });
}

async function me(request, env) {
  const user = await requireUser(request, env);
  const [reviews, favs, owned, settings] = await Promise.all([
    db(env, `reviews?user_id=eq.${user.id}&select=${REVIEW_COLUMNS},businesses(slug,name,catalog_visible)&order=updated_at.desc&limit=200`),
    db(env, `favorites?user_id=eq.${user.id}&select=created_at,businesses(id,slug,name,category,city,address,logo_url,design,photos,is_active,catalog_visible)&order=created_at.desc&limit=200`),
    ownedIds(env, user),
    db(env, `app_users?id=eq.${user.id}&select=notify`)
  ]);
  const own = owned.length
    ? await db(env, `businesses?id=in.(${owned.join(",")})&select=id,slug,name,catalog_visible`)
    : [];
  const visibleFavs = favs.filter((f) => f.businesses && f.businesses.is_active && f.businesses.catalog_visible);
  // Рейтинг избранных — по опубликованным отзывам, одним запросом
  const favIds = visibleFavs.map((f) => f.businesses.id);
  const scores = favIds.length
    ? await db(env, `reviews?business_id=in.(${favIds.join(",")})&status=eq.published&select=business_id,score&limit=100000`)
    : [];
  const agg = {};
  for (const s of scores) {
    const a = (agg[s.business_id] ||= { sum: 0, n: 0 });
    a.sum += s.score;
    a.n += 1;
  }
  return json({
    banned: user.banned,
    notify: Boolean(settings[0] && settings[0].notify),
    reviews: reviews.map((r) => ({ ...myReview(r), place: r.businesses ? { slug: r.businesses.slug, name: r.businesses.name, visible: r.businesses.catalog_visible } : null })),
    favorites: visibleFavs.map((f) => {
      const a = agg[f.businesses.id];
      return card({
        ...f.businesses,
        cover: (f.businesses.photos || [])[0],
        reviews: a ? a.n : 0,
        avg_score: a ? Math.round((a.sum / a.n) * 10) / 10 : null
      });
    }),
    businesses: own.map((b) => ({ slug: b.slug, name: b.name, inCatalog: b.catalog_visible }))
  });
}

async function meSettings(request, env) {
  const user = await requireUser(request, env);
  const input = await readJson(request);
  if (typeof input.notify !== "boolean") throw new AppError(400, "Нечего менять");
  await db(env, `app_users?id=eq.${user.id}`, {
    method: "PATCH",
    body: { notify: input.notify, notify_at: input.notify ? new Date().toISOString() : null },
    prefer: "return=minimal"
  });
  return json({ notify: input.notify });
}

async function deleteMe(request, env) {
  const user = await requireUser(request, env);
  const photos = await db(env, `reviews?user_id=eq.${user.id}&photo_id=not.is.null&select=photo_id`);
  await db(env, `app_users?id=eq.${user.id}`, { method: "DELETE", prefer: "return=minimal" });
  for (const p of photos) await dropMedia(env, p.photo_id);
  userCache.delete(user.tgId);
  return json({ deleted: true });
}

// ================= Уведомления в Telegram (бот владельцев, telegram.js) =================
// Модератору (чаты «Получать заявки» из админки) — без текста отзыва и без данных автора, не чаще раза в 10 минут.
// Владельцу (чаты заведения в боте) — когда отзыв опубликован: текст уже публичный, кнопка ведёт в кабинет.

const MOD_ALERT_MS = 10 * 60e3;
let lastModAlert = 0;

function appDeepLink(env, param) {
  if (!env.APP_BOT_USERNAME || !env.APP_SHORT_NAME) return null;
  return `https://t.me/${env.APP_BOT_USERNAME}/${env.APP_SHORT_NAME}?startapp=${param}`;
}

async function notifyModerators(env, reason, { force = false } = {}) {
  try {
    if (!env.TG_BOT_TOKEN) return;
    if (!force && Date.now() - lastModAlert < MOD_ALERT_MS) return;
    lastModAlert = Date.now();
    const [chats, pending] = await Promise.all([
      db(env, "order_recipients?select=chat_id"),
      db(env, "reviews?status=eq.pending&select=id&limit=1000")
    ]);
    if (!chats.length) return;
    const base = String(env.PUBLIC_BASE_URL || "https://tapreview.ru").replace(/\/+$/, "");
    const text = `🛡 <b>${escapeHtml(reason)}</b>\nНа проверке отзывов: ${pending.length}\n\nАдминка → вкладка «Отзывы»: ${base}/admin/`;
    for (const { chat_id } of chats) {
      await tg(env, "sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }).catch((e) =>
        console.error(`Модерация → ${chat_id}: ${e.message}`)
      );
    }
  } catch (error) {
    console.error(`Уведомление модератору: ${error.message}`);
  }
}

async function notifyOwnersPublished(env, reviewId) {
  try {
    if (!env.TG_BOT_TOKEN) return;
    const rows = await db(env, `reviews?id=eq.${reviewId}&select=score,text,card_id,businesses(id,slug,name)`);
    const r = rows[0];
    if (!r || !r.businesses) return;
    const chats = await db(env, `tg_subscribers?business_id=eq.${r.businesses.id}&select=chat_id`);
    if (!chats.length) return;
    const text =
      `${"⭐".repeat(r.score)} <b>Новый отзыв в каталоге TapReview</b>\n${escapeHtml(r.businesses.name)}` +
      (r.card_id ? " · по карте" : "") +
      (r.text ? `\n\n«${escapeHtml(r.text.length > 600 ? `${r.text.slice(0, 600)}…` : r.text)}»` : "") +
      `\n\nОтвет заведения увидят все гости — это повышает доверие.`;
    const link = appDeepLink(env, `b_${r.businesses.slug}`);
    const extra = link ? { reply_markup: { inline_keyboard: [[{ text: "Ответить в кабинете", url: link }]] } } : {};
    for (const { chat_id } of chats) {
      await tg(env, "sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra }).catch((e) =>
        console.error(`Отзыв ${reviewId} → ${chat_id}: ${e.message}`)
      );
    }
  } catch (error) {
    console.error(`Уведомление владельцу: ${error.message}`);
  }
}

// Автору отзыва — от бота гостей (APP_BOT_TOKEN), только если он сам включил «Сообщать о моих отзывах».
// kind: published | rejected | reply. Если гость заблокировал бота (403) — выключаем ему сообщения.
async function notifyAuthor(env, reviewId, kind) {
  try {
    if (!env.APP_BOT_TOKEN) return;
    const rows = await db(env, `reviews?id=eq.${reviewId}&select=reject_reason,reply_text,app_users:app_users!reviews_user_id_fkey(id,tg_id,notify),businesses(slug,name)`);
    const r = rows[0];
    if (!r || !r.app_users || !r.app_users.notify || !r.businesses) return;
    // «Кофейня «Зерно»» — некрасиво: если в названии уже есть кавычки, не оборачиваем
    const raw = r.businesses.name;
    const name = escapeHtml(/[«»"]/.test(raw) ? raw : `«${raw}»`);
    const short = (s, n) => escapeHtml(s.length > n ? `${s.slice(0, n)}…` : s);
    let text;
    let button;
    if (kind === "published") {
      text = `✅ Ваш отзыв о ${name} опубликован. Спасибо — он поможет другим гостям!`;
      button = "Открыть отзыв";
    } else if (kind === "rejected") {
      text = `Отзыв о ${name} не прошёл проверку.` + (r.reject_reason ? `\nПричина: ${short(r.reject_reason, 200)}` : "") +
        "\n\nЕго можно исправить и отправить снова.";
      button = "Исправить отзыв";
    } else if (kind === "reply" && r.reply_text) {
      text = `💬 ${name} ответило на ваш отзыв:\n\n«${short(r.reply_text, 600)}»`;
      button = "Посмотреть";
    } else {
      return;
    }
    const link = appDeepLink(env, `p_${r.businesses.slug}`);
    try {
      await tgAs(env, env.APP_BOT_TOKEN, "sendMessage", {
        chat_id: r.app_users.tg_id,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(link ? { reply_markup: { inline_keyboard: [[{ text: button, url: link }]] } } : {})
      });
    } catch (error) {
      if (error.tgCode === 403) {
        await db(env, `app_users?id=eq.${r.app_users.id}`, { method: "PATCH", body: { notify: false }, prefer: "return=minimal" });
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error(`Сообщение автору отзыва ${reviewId}: ${error.message}`);
  }
}

// ================= Кабинет заведения (владелец) =================

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MSK = 3 * 3600e3;
const MAX_PLACE_PHOTOS = 8;

// Заведение, которым управляет пользователь (в каталоге оно может и не быть)
async function ownedPlace(request, env, slug, { write = false } = {}) {
  const user = await requireUser(request, env, { write });
  if (!SLUG_RE.test(slug)) throw new AppError(404, "Заведение не найдено");
  const rows = await db(env, `businesses?slug=eq.${encodeURIComponent(slug)}&select=id,slug,name,category,address,city,description,photos,catalog_visible,catalog_consent_at,app_button,is_active,lat,lon&limit=1`);
  if (!rows.length || !(await ownedIds(env, user)).includes(rows[0].id)) {
    throw new AppError(403, "Кабинет доступен только представителю заведения");
  }
  return { user, b: rows[0] };
}

async function bizCabinet(request, env, slug, url) {
  const { b } = await ownedPlace(request, env, slug);
  const period = url.searchParams.get("period") === "week" ? "week" : "month";
  const now = Date.now();

  // 6 месяцев по МСК, включая текущий
  const nowMsk = new Date(now + MSK);
  const startMsk = Date.UTC(nowMsk.getUTCFullYear(), nowMsk.getUTCMonth() - 5, 1) - MSK;
  const days = period === "week" ? 7 : 30;
  const periodFrom = encodeURIComponent(new Date(now - days * 864e5).toISOString());

  const [published, pendingRows, unanswered, reports, daily, cardScores] = await Promise.all([
    db(env, `reviews?business_id=eq.${b.id}&status=eq.published&select=score,created_at&limit=100000`),
    db(env, `reviews?business_id=eq.${b.id}&status=eq.pending&select=id`),
    db(env, `reviews?business_id=eq.${b.id}&status=eq.published&reply_text=is.null&select=${REVIEW_COLUMNS}&order=created_at.desc&limit=30`),
    loadReports(env, [b.id], period, now),
    loadDaily(env, [b.id], period, now),
    db(env, `ratings?business_id=eq.${b.id}&created_at=gte.${periodFrom}&select=score&limit=100000`)
  ]);

  const dist = [0, 0, 0, 0, 0];
  let sum = 0;
  const byMonth = new Map();
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(nowMsk.getUTCFullYear(), nowMsk.getUTCMonth() - 5 + i, 1));
    byMonth.set(d.toISOString().slice(0, 7), { month: d.toISOString().slice(0, 7), label: MONTHS_SHORT[d.getUTCMonth()], count: 0, sum: 0 });
  }
  let periodNew = 0;
  for (const r of published) {
    dist[r.score - 1]++;
    sum += r.score;
    const t = Date.parse(r.created_at);
    if (t >= now - days * 864e5) periodNew++;
    if (t >= startMsk) {
      const m = byMonth.get(new Date(t + MSK).toISOString().slice(0, 7));
      if (m) {
        m.count++;
        m.sum += r.score;
      }
    }
  }
  const rep = reports.get(b.id);
  const cardAvg = cardScores.length ? Math.round((cardScores.reduce((a, r) => a + r.score, 0) / cardScores.length) * 10) / 10 : null;

  return json({
    place: {
      slug: b.slug,
      name: b.name,
      city: b.city || "",
      description: b.description || "",
      photos: (b.photos || []).map((id) => ({ id, url: mediaUrl(id) })),
      inCatalog: Boolean(b.catalog_visible && b.is_active),
      active: Boolean(b.is_active),
      appButton: Boolean(b.app_button),
      consentAt: b.catalog_consent_at || null,
      address: b.address || "",
      coords: b.lat != null ? `${b.lat}, ${b.lon}` : "",
      gaps: catalogGaps(b)
    },
    rating: {
      avg: published.length ? Math.round((sum / published.length) * 10) / 10 : null,
      count: published.length,
      dist,
      pending: pendingRows.length,
      periodNew
    },
    months: [...byMonth.values()].map((m) => ({ month: m.month, label: m.label, count: m.count, avg: m.count ? Math.round((m.sum / m.count) * 10) / 10 : null })),
    unanswered: unanswered.map((r) => publicReview(r, null)),
    period,
    traffic: rep
      ? {
          cur: rep.cur,
          prev: rep.prev,
          daily,
          cards: rep.allCards.map((c) => ({ name: c.name, views: c.cur.views, clicks: c.cur.clicks }))
        }
      : null,
    cardRatings: { avg: cardAvg, count: cardScores.length }
  });
}

// Чего не хватает, чтобы страница в каталоге выглядела хорошо (то же, что подсказывает админка)
function catalogGaps(b) {
  const gaps = [];
  if (!b.city) gaps.push("город");
  if (!b.address) gaps.push("адрес");
  if (!b.description) gaps.push("описание");
  if (!(b.photos && b.photos.length)) gaps.push("фото");
  if (b.lat == null) gaps.push("место на карте");
  return gaps;
}

// «56.84, 53.21» или ссылка Яндекс Карт (ll= / pt= / whatshere — долгота первой) или 2ГИС (m= / /geo/ — тоже долгота первой).
// Та же логика, что parseCoords в admin/admin.js. → { lat, lon } | null (пусто) | бросает AppError
export function parseCoordsText(text) {
  let s = String(text || "").trim();
  if (!s) return null;
  try {
    s = decodeURIComponent(s);
  } catch {
    // как есть
  }
  const check = (lat, lon) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new AppError(400, "Координаты вне допустимых пределов");
    }
    return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
  };
  let m = /[?&](?:ll|pt|whatshere\[point\])=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(s);
  if (m) return check(Number(m[2]), Number(m[1]));
  m = /[?&]m=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(s) || /\/geo\/(?:\d+\/)?(-?\d+\.\d+),(-?\d+\.\d+)/.exec(s);
  if (m) return check(Number(m[2]), Number(m[1]));
  m = /^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(s);
  if (m) return check(Number(m[1]), Number(m[2]));
  throw new AppError(400, "Место на карте: вставьте ссылку из Яндекс Карт («Поделиться») или «56.845264, 53.213727»");
}

async function bizUpdate(request, env, slug) {
  const { user, b } = await ownedPlace(request, env, slug, { write: true });
  rateLimit(`b:${user.id}`, 30, 3600e3);
  const input = await readJson(request);
  const body = {
    description: cleanUserText(input.description, 1000, "Описание") || null,
    city: cleanUserText(input.city, 60, "Город").replace(/\s+/g, " ") || null
  };
  if ("address" in input) body.address = cleanUserText(input.address, 300, "Адрес").replace(/\s+/g, " ") || null;
  if ("coords" in input) {
    const c = parseCoordsText(cleanUserText(input.coords, 600, "Место на карте"));
    body.lat = c ? c.lat : null;
    body.lon = c ? c.lon : null;
  }
  await db(env, `businesses?id=eq.${b.id}`, { method: "PATCH", body, prefer: "return=minimal" });
  return json({ ok: true, ...body, coords: body.lat != null ? `${body.lat}, ${body.lon}` : body.lat === null ? "" : undefined, gaps: catalogGaps({ ...b, ...body }) });
}

// Владелец сам включает/выключает показ в каталоге (с согласием) и кнопку «Отзыв в Telegram» на картах
async function bizCatalog(request, env, slug) {
  const { user, b } = await ownedPlace(request, env, slug, { write: true });
  rateLimit(`c:${user.id}`, 20, 3600e3);
  const input = await readJson(request);
  const body = {};
  if (typeof input.on === "boolean") {
    if (!b.is_active) throw new AppError(400, "Заведение выключено — напишите TapReview");
    if (input.on && input.consent !== true) throw new AppError(400, "Подтвердите согласие на публичные рейтинг и отзывы");
    body.catalog_visible = input.on;
    if (input.on) {
      body.catalog_consent_at = new Date().toISOString();
      body.catalog_consent_by = user.id;
    }
  }
  if (typeof input.appButton === "boolean") body.app_button = input.appButton;
  if (!Object.keys(body).length) throw new AppError(400, "Нечего менять");
  await db(env, `businesses?id=eq.${b.id}`, { method: "PATCH", body, prefer: "return=minimal" });
  if (typeof input.on === "boolean" && input.on !== Boolean(b.catalog_visible)) {
    notifyModerators(env, `«${b.name}» ${input.on ? "само включило показ в каталоге" : "убрало себя из каталога"}`, { force: true });
  }
  return json({
    inCatalog: "catalog_visible" in body ? body.catalog_visible : Boolean(b.catalog_visible),
    appButton: "app_button" in body ? body.app_button : Boolean(b.app_button),
    consentAt: body.catalog_consent_at || b.catalog_consent_at || null
  });
}

async function bizPhotoAdd(request, env, slug) {
  const { user, b } = await ownedPlace(request, env, slug, { write: true });
  rateLimit(`p:${user.id}`, 20, 3600e3);
  const photos = b.photos || [];
  if (photos.length >= MAX_PLACE_PHOTOS) throw new AppError(400, `Не больше ${MAX_PLACE_PHOTOS} фото`);
  const input = await readJson(request, MAX_BODY);
  let id;
  try {
    id = await saveMedia(env, "place", input.photo);
  } catch (error) {
    throw new AppError(400, error.message);
  }
  const next = [...photos, id];
  await db(env, `businesses?id=eq.${b.id}`, { method: "PATCH", body: { photos: next }, prefer: "return=minimal" });
  return json({ photos: next.map((p) => ({ id: p, url: mediaUrl(p) })) }, 201);
}

async function bizPhotoDelete(request, env, slug, photoId) {
  const { b } = await ownedPlace(request, env, slug, { write: true });
  const photos = b.photos || [];
  if (!photos.includes(photoId)) throw new AppError(404, "Фото не найдено");
  const next = photos.filter((p) => p !== photoId);
  await db(env, `businesses?id=eq.${b.id}`, { method: "PATCH", body: { photos: next }, prefer: "return=minimal" });
  await dropMedia(env, photoId);
  return json({ photos: next.map((p) => ({ id: p, url: mediaUrl(p) })) });
}

// ================= Модерация (админ-панель) =================
//   GET   /api/admin/app/summary                  — пользователи, отзывы по статусам, открытые жалобы
//   GET   /api/admin/app/stats?days=7|30|90       — статистика платформы: итоги, по дням, топ заведений
//   GET   /api/admin/app/users?q=&filter=all|banned|reviewers&offset= — пользователи (без Telegram ID)
//   GET   /api/admin/app/reviews?status=pending|published|rejected|reported&offset=
//   PATCH /api/admin/app/reviews/:id              — { status, reject_reason } или { reply: null }
//   POST  /api/admin/app/reviews/:id/resolve      — закрыть жалобы на отзыв
//   PATCH /api/admin/app/users/:id                — { banned, reason }
// Администратор уже проверен в admin-api.js. Возвращает Response или null (адрес не наш).

export async function handleAppAdmin(request, env, path, method, url) {
  if (!path.startsWith("/api/admin/app/")) return null;
  try {
    if (path === "/api/admin/app/summary" && method === "GET") return await adminSummary(env);
    if (path === "/api/admin/app/stats" && method === "GET") return await adminStats(env, url);
    if (path === "/api/admin/app/users" && method === "GET") return await adminUsers(env, url);
    if (path === "/api/admin/app/reviews" && method === "GET") return await adminReviews(env, url);
    let m = path.match(/^\/api\/admin\/app\/reviews\/(\d{1,18})$/);
    if (m && method === "PATCH") return await adminModerate(request, env, m[1]);
    m = path.match(/^\/api\/admin\/app\/reviews\/(\d{1,18})\/resolve$/);
    if (m && method === "POST") {
      await db(env, `review_reports?review_id=eq.${m[1]}&resolved_at=is.null`, { method: "PATCH", body: { resolved_at: new Date().toISOString() }, prefer: "return=minimal" });
      return json({ ok: true });
    }
    m = path.match(/^\/api\/admin\/app\/users\/(\d{1,18})$/);
    if (m && method === "PATCH") return await adminBan(request, env, m[1]);
    return json({ error: "Не найдено" }, 404);
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    throw error;
  }
}

async function adminSummary(env) {
  const [users, reviews, reports, placesRows] = await Promise.all([
    db(env, "app_users?select=id,banned_at&limit=100000"),
    db(env, "reviews?select=status&limit=100000"),
    db(env, "review_reports?resolved_at=is.null&select=review_id&limit=100000"),
    db(env, "businesses?is_active=is.true&catalog_visible=is.true&select=id&limit=100000")
  ]);
  const byStatus = { pending: 0, published: 0, rejected: 0 };
  for (const r of reviews) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  return json({
    users: users.length,
    banned: users.filter((u) => u.banned_at).length,
    reviews: byStatus,
    reportedReviews: new Set(reports.map((r) => r.review_id)).size,
    places: placesRows.length
  });
}

// Статистика платформы. Объёмы пока небольшие — считаем в коде по строкам за период (без новых функций в базе).
async function adminStats(env, url) {
  const days = [7, 30, 90].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
  const now = Date.now();
  const fromMs = now - days * DAY_MS;
  const from = encodeURIComponent(new Date(fromMs).toISOString());
  const [users, reviews, reports, votes, favs, places] = await Promise.all([
    db(env, "app_users?select=id,created_at,last_seen_at,banned_at,notify&limit=200000"),
    db(env, "reviews?select=id,business_id,score,status,created_at,moderated_at,card_id,photo_id&limit=200000"),
    db(env, `review_reports?created_at=gte.${from}&select=id,resolved_at&limit=200000`),
    db(env, `review_votes?created_at=gte.${from}&select=review_id&limit=200000`),
    db(env, "favorites?select=user_id&limit=200000"),
    db(env, "businesses?select=id,slug,name,catalog_visible,is_active&limit=10000")
  ]);
  const inPeriod = (iso) => iso && Date.parse(iso) >= fromMs;
  const periodReviews = reviews.filter((r) => inPeriod(r.created_at));

  // По дням (МСК): новые пользователи и новые отзывы
  const dayKey = (ms) => new Date(ms + MSK).toISOString().slice(0, 10);
  const daily = new Map();
  for (let i = days - 1; i >= 0; i--) daily.set(dayKey(now - i * DAY_MS), { day: dayKey(now - i * DAY_MS), users: 0, reviews: 0 });
  for (const u of users) { const d = daily.get(dayKey(Date.parse(u.created_at))); if (d && inPeriod(u.created_at)) d.users++; }
  for (const r of periodReviews) { const d = daily.get(dayKey(Date.parse(r.created_at))); if (d) d.reviews++; }

  // Время модерации: от отправки до решения (медиана, в часах) — по отзывам, решённым за период
  const waits = reviews
    .filter((r) => r.moderated_at && inPeriod(r.moderated_at) && r.status !== "pending")
    .map((r) => (Date.parse(r.moderated_at) - Date.parse(r.created_at)) / 3600e3)
    .filter((h) => h >= 0)
    .sort((a, b) => a - b);
  const median = waits.length ? Math.round(waits[Math.floor(waits.length / 2)] * 10) / 10 : null;

  // Топ заведений по опубликованным отзывам за период
  const byPlace = new Map();
  for (const r of periodReviews.filter((x) => x.status === "published")) {
    const p = byPlace.get(r.business_id) || { n: 0, sum: 0 };
    p.n++;
    p.sum += r.score;
    byPlace.set(r.business_id, p);
  }
  const placeName = new Map(places.map((p) => [p.id, p]));
  const top = [...byPlace.entries()]
    .map(([id, p]) => ({ slug: (placeName.get(id) || {}).slug, name: (placeName.get(id) || {}).name || `#${id}`, reviews: p.n, avg: Math.round((p.sum / p.n) * 10) / 10 }))
    .sort((a, b) => b.reviews - a.reviews || b.avg - a.avg)
    .slice(0, 10);

  const count = (list, f) => list.filter(f).length;
  return json({
    days,
    users: {
      total: users.length,
      new: count(users, (u) => inPeriod(u.created_at)),
      active: count(users, (u) => inPeriod(u.last_seen_at)),
      notify: count(users, (u) => u.notify),
      banned: count(users, (u) => u.banned_at)
    },
    reviews: {
      new: periodReviews.length,
      published: count(periodReviews, (r) => r.status === "published"),
      rejected: count(periodReviews, (r) => r.status === "rejected"),
      pending: count(reviews, (r) => r.status === "pending"),
      viaCard: count(periodReviews, (r) => r.card_id),
      withPhoto: count(periodReviews, (r) => r.photo_id),
      medianModerationHours: median
    },
    reports: { new: reports.length, open: count(reports, (r) => !r.resolved_at) },
    votes: votes.length,
    favorites: favs.length,
    places: { inCatalog: count(places, (p) => p.catalog_visible && p.is_active), total: count(places, (p) => p.is_active) },
    daily: [...daily.values()],
    top
  });
}

// Пользователи Mini App: внутренний номер (не Telegram ID), даты, отзывы по статусам, жалобы от пользователя
async function adminUsers(env, url) {
  const q = String(url.searchParams.get("q") || "").replace(/[^0-9]/g, "");
  const filter = url.searchParams.get("filter") || "all";
  const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
  let path = "app_users?select=id,created_at,last_seen_at,banned_at,ban_reason,notify";
  if (q) path += `&id=eq.${q}`;
  if (filter === "banned") path += "&banned_at=not.is.null";
  let rows;
  if (filter === "reviewers" && !q) {
    // С отзывами — по числу отзывов
    const all = await db(env, "reviews?select=user_id&limit=200000");
    const n = all.reduce((m, r) => m.set(r.user_id, (m.get(r.user_id) || 0) + 1), new Map());
    const ids = [...n.entries()].sort((a, b) => b[1] - a[1]).slice(offset, offset + 51).map(([id]) => id);
    rows = ids.length ? await db(env, `${path}&id=in.(${ids.join(",")})`) : [];
    rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  } else {
    rows = await db(env, `${path}&order=last_seen_at.desc&limit=51&offset=${offset}`);
  }
  const page = rows.slice(0, 50);
  const ids = page.map((u) => u.id);
  const [revs, reps] = ids.length
    ? await Promise.all([
        db(env, `reviews?user_id=in.(${ids.join(",")})&select=user_id,status&limit=100000`),
        db(env, `review_reports?user_id=in.(${ids.join(",")})&select=user_id&limit=100000`)
      ])
    : [[], []];
  return json({
    more: rows.length > 50,
    users: page.map((u) => {
      const mine = revs.filter((r) => r.user_id === u.id);
      return {
        id: u.id,
        created: u.created_at,
        lastSeen: u.last_seen_at,
        banned: Boolean(u.banned_at),
        banReason: u.ban_reason || null,
        notify: u.notify,
        reviews: {
          published: mine.filter((r) => r.status === "published").length,
          pending: mine.filter((r) => r.status === "pending").length,
          rejected: mine.filter((r) => r.status === "rejected").length
        },
        reportsMade: reps.filter((r) => r.user_id === u.id).length
      };
    })
  });
}

async function adminReviews(env, url) {
  const status = url.searchParams.get("status") || "pending";
  const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
  const cols = `${REVIEW_COLUMNS},business_id,moderated_at,businesses(slug,name),cards(code),app_users:app_users!reviews_user_id_fkey(id,banned_at),review_reports(id,reason,comment,created_at,resolved_at)`;
  let rows;
  if (status === "reported") {
    const open = await db(env, "review_reports?resolved_at=is.null&select=review_id&limit=1000");
    const ids = [...new Set(open.map((r) => r.review_id))];
    rows = ids.length ? await db(env, `reviews?id=in.(${ids.join(",")})&select=${cols}&order=updated_at.desc`) : [];
  } else {
    if (!["pending", "published", "rejected"].includes(status)) throw new AppError(400, "Неизвестный статус");
    const order = status === "pending" ? "updated_at.asc" : "updated_at.desc";
    rows = await db(env, `reviews?status=eq.${status}&select=${cols}&order=${order}&limit=51&offset=${offset}`);
  }
  const more = status !== "reported" && rows.length > 50;
  const flags = status === "published" || status === "rejected" ? new Map() : await suspicionFlags(env, rows.slice(0, 50));
  return json({
    more,
    reviews: rows.slice(0, 50).map((r) => ({
      flags: flags.get(r.id) || [],
      id: r.id,
      place: r.businesses,
      score: r.score,
      text: r.text,
      photo: mediaUrl(r.photo_id),
      status: r.status,
      rejectReason: r.reject_reason,
      card: r.cards ? r.cards.code : null,
      reply: r.reply_text ? { text: r.reply_text, date: r.reply_at } : null,
      user: r.app_users ? { id: r.app_users.id, banned: Boolean(r.app_users.banned_at) } : null,
      reports: (r.review_reports || []).filter((x) => !x.resolved_at),
      helpful: Number(r.helpful || 0),
      created: r.created_at,
      updated: r.updated_at,
      moderated: r.moderated_at
    }))
  });
}

// Подсказки модератору — НЕ решение и не блокировка, только «посмотрите внимательнее»:
//   новый аккаунт · 3+ отзыва автора за сутки · всплеск отзывов у заведения · такой же текст у другого автора ·
//   у автора уже отклоняли отзывы
const DAY_MS = 24 * 3600e3;
const normText = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();

async function suspicionFlags(env, rows) {
  const out = new Map();
  if (!rows.length) return out;
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const placeIds = [...new Set(rows.map((r) => r.business_id))];
  const dayAgo = encodeURIComponent(new Date(Date.now() - DAY_MS).toISOString());
  const since90 = encodeURIComponent(new Date(Date.now() - 90 * DAY_MS).toISOString());
  const [users, userDay, rejected, placeDay, recentTexts] = await Promise.all([
    db(env, `app_users?id=in.(${userIds.join(",")})&select=id,created_at`),
    db(env, `reviews?user_id=in.(${userIds.join(",")})&created_at=gte.${dayAgo}&select=user_id&limit=10000`),
    db(env, `reviews?user_id=in.(${userIds.join(",")})&status=eq.rejected&select=id,user_id&limit=10000`),
    db(env, `reviews?business_id=in.(${placeIds.join(",")})&created_at=gte.${dayAgo}&select=business_id&limit=10000`),
    db(env, `reviews?created_at=gte.${since90}&text=neq.&select=id,user_id,text&limit=5000`)
  ]);
  const created = new Map(users.map((u) => [u.id, Date.parse(u.created_at)]));
  const count = (list, key) => list.reduce((m, x) => m.set(x[key], (m.get(x[key]) || 0) + 1), new Map());
  const perUserDay = count(userDay, "user_id");
  const perPlaceDay = count(placeDay, "business_id");
  const textAuthors = new Map();
  for (const t of recentTexts) {
    const n = normText(t.text);
    if (n.length < 20) continue;
    if (!textAuthors.has(n)) textAuthors.set(n, new Set());
    textAuthors.get(n).add(t.user_id);
  }

  for (const r of rows) {
    const f = [];
    const age = Date.parse(r.created_at) - (created.get(r.user_id) || 0);
    if (created.has(r.user_id) && age < 3600e3) f.push("Новый аккаунт: отзыв в первый час");
    if ((perUserDay.get(r.user_id) || 0) >= 3) f.push(`Автор оставил ${perUserDay.get(r.user_id)} отзыва за сутки`);
    if ((perPlaceDay.get(r.business_id) || 0) >= 5) f.push(`Всплеск: ${perPlaceDay.get(r.business_id)} отзывов о заведении за сутки`);
    const n = normText(r.text);
    if (n.length >= 20 && [...(textAuthors.get(n) || [])].some((u) => u !== r.user_id)) f.push("Такой же текст у другого автора");
    const rej = rejected.filter((x) => x.user_id === r.user_id && x.id !== r.id).length;
    if (rej) f.push(`У автора уже отклоняли отзывы: ${rej}`);
    out.set(r.id, f);
  }
  return out;
}

async function adminModerate(request, env, id) {
  const input = await readJson(request);
  let body;
  if ("reply" in input && input.reply === null) {
    body = { reply_text: null, reply_at: null };
  } else {
    if (!["published", "rejected", "pending"].includes(input.status)) throw new AppError(400, "Неизвестный статус");
    const reason = cleanUserText(input.reject_reason, 200, "Причина") || null;
    if (input.status === "rejected" && !reason) throw new AppError(400, "Напишите причину — её увидит автор");
    body = { status: input.status, reject_reason: input.status === "rejected" ? reason : null, moderated_at: new Date().toISOString() };
  }
  const before = (await db(env, `reviews?id=eq.${id}&select=status`))[0];
  if (!before) throw new AppError(404, "Отзыв не найден");
  const rows = await db(env, `reviews?id=eq.${id}&select=id,status`, { method: "PATCH", body, prefer: "return=representation" });
  if (!rows.length) throw new AppError(404, "Отзыв не найден");
  // Отзыв впервые (или после правки автора) стал виден всем — сообщаем заведению
  if (body.status === "published" && before.status === "pending") {
    notifyOwnersPublished(env, id);
    notifyAuthor(env, id, "published");
  }
  if (body.status === "rejected" && before.status !== "rejected") notifyAuthor(env, id, "rejected");
  // Решение по отзыву закрывает и жалобы на него
  if (body.status) {
    await db(env, `review_reports?review_id=eq.${id}&resolved_at=is.null`, { method: "PATCH", body: { resolved_at: new Date().toISOString() }, prefer: "return=minimal" });
  }
  return json({ ok: true, status: rows[0].status });
}

async function adminBan(request, env, id) {
  const input = await readJson(request);
  const body = input.banned
    ? { banned_at: new Date().toISOString(), ban_reason: cleanUserText(input.reason, 200, "Причина") || null }
    : { banned_at: null, ban_reason: null };
  const rows = await db(env, `app_users?id=eq.${id}&select=id,tg_id`, { method: "PATCH", body, prefer: "return=representation" });
  if (!rows.length) throw new AppError(404, "Пользователь не найден");
  userCache.delete(rows[0].tg_id);
  // Забаненный: его отзывы на проверке отклоняем, опубликованные остаются до решения модератора
  if (input.banned) {
    await db(env, `reviews?user_id=eq.${id}&status=eq.pending`, {
      method: "PATCH",
      body: { status: "rejected", reject_reason: "Аккаунт заблокирован", moderated_at: new Date().toISOString() },
      prefer: "return=minimal"
    });
  }
  return json({ ok: true, banned: Boolean(input.banned) });
}
