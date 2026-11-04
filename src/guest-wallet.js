// «Мои заведения и подарки» в Mini App (миграция 041).
//
// Визиты, штампы и коды подарков считаются по случайному номеру устройства в cookie tr_device (guests.js) —
// в браузере телефона, где открывается страница карты. Telegram эту cookie не видит, поэтому гость сам связывает
// телефон со своим Telegram:
//   1) на странице карты кнопка «Мои штампы и подарки — в Telegram» → GET /me-link?b=slug
//      → одноразовый токен (15 минут) → t.me/<бот>/<приложение>?startapp=g_<токен>;
//   2) приложение показывает, что будет связано, и только после «Связать» вызывает POST /api/app/devices/link.
// Заведениям связь не показывается. Отвязать — DELETE /api/app/devices; «Удалить мои данные» удаляет и её.

import { db } from "./supabase.js";
import { deviceFrom, visitorKeyOf, stampsOn, vipOn } from "./guests.js";
import { renderPage } from "./public-page.js";
import { pointsOn } from "./points.js";

const TOKEN_RE = /^[A-Za-z0-9]{24}$/;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const REGULAR_FROM = 3; // «постоянный гость» — с 3-го визита (как в статистике «Гости по уровням», миграция 032)
const KEYS_PER_REQUEST = 60; // ключи в адресе запроса — пачками, чтобы адрес не был слишком длинным

function randomToken() {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = "";
  while (out.length < 24) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limit && out.length < 24) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

// ---------- GET /me-link — со страницы карты (браузер телефона) ----------

export async function handleMeLink(request, env) {
  const { deviceId, setCookie } = deviceFrom(request);
  if (setCookie || !env.APP_BOT_USERNAME || !env.APP_SHORT_NAME) {
    return renderPage({
      status: 400,
      title: "Откройте с карты",
      body: `<h1 class="name">Сначала коснитесь карты</h1>
        <p class="lead">Штампы и подарки привязаны к телефону, которым вы касаетесь карт TapReview в заведениях.
        Откройте страницу с карты на этом телефоне и нажмите кнопку ещё раз.</p>`
    });
  }
  const token = randomToken();
  try {
    await db(env, "device_link_tokens", { method: "POST", body: { token, device_id: deviceId }, prefer: "return=minimal" });
    // Попутно чистим просроченные
    db(env, `device_link_tokens?expires_at=lt.${encodeURIComponent(new Date(Date.now() - 3600e3).toISOString())}`, {
      method: "DELETE",
      prefer: "return=minimal"
    }).catch(() => {});
  } catch (error) {
    console.error(`me-link: ${error.message}`);
    return renderPage({ status: 500, title: "Ошибка", body: `<h1 class="name">Не получилось</h1><p class="lead">Попробуйте ещё раз чуть позже.</p>` });
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://t.me/${env.APP_BOT_USERNAME}/${env.APP_SHORT_NAME}?startapp=g_${token}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer"
    }
  });
}

// ---------- API Mini App ----------

// → { linked: true } | бросает Error с текстом для гостя (status в error.status)
export async function linkDevice(env, user, token) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!TOKEN_RE.test(String(token || ""))) throw fail(400, "Ссылка повреждена — нажмите кнопку на странице карты ещё раз");
  const rows = await db(env, `device_link_tokens?token=eq.${token}&used_at=is.null&select=device_id,expires_at`);
  if (!rows.length) throw fail(410, "Ссылка уже использована — нажмите кнопку на странице карты ещё раз");
  if (Date.parse(rows[0].expires_at) < Date.now()) throw fail(410, "Ссылка устарела (действует 15 минут) — нажмите кнопку на странице карты ещё раз");
  // Одноразовая: помечаем использованной только если её ещё никто не использовал
  const used = await db(env, `device_link_tokens?token=eq.${token}&used_at=is.null&select=token`, {
    method: "PATCH",
    body: { used_at: new Date().toISOString() },
    prefer: "return=representation"
  });
  if (!used.length) throw fail(410, "Ссылка уже использована — нажмите кнопку на странице карты ещё раз");
  await db(env, "app_user_devices?on_conflict=device_id", {
    method: "POST",
    body: { device_id: rows[0].device_id, user_id: user.id, linked_at: new Date().toISOString() },
    prefer: "resolution=merge-duplicates,return=minimal"
  });
  return { linked: true };
}

export async function unlinkDevices(env, user) {
  await db(env, `app_user_devices?user_id=eq.${user.id}`, { method: "DELETE", prefer: "return=minimal" });
  return { linked: false };
}

const PLACE_COLUMNS =
  "id,slug,name,city,address,logo_url,design,photos,catalog_visible,is_active," +
  "stamps_goal,stamps_prize,vip_visits,vip_gift,bonus_mode,tariff,points_on";

// Визиты, штампы, уровень и действующие коды подарков гостя во всех заведениях
export async function walletSummary(env, user) {
  const devices = await db(env, `app_user_devices?user_id=eq.${user.id}&select=device_id,linked_at`);
  if (!devices.length) return { devices: 0, places: [] };

  const places = await db(env, `businesses?is_active=is.true&select=${PLACE_COLUMNS}&limit=5000`);
  // Ключ визитов — свой для каждой пары «устройство + заведение» (guests.js), считаем их здесь
  const keyToPlace = new Map();
  for (const d of devices) {
    for (const p of places) keyToPlace.set(await visitorKeyOf(env, d.device_id, p.id), p.id);
  }
  const keys = [...keyToPlace.keys()];
  const visits = [];
  const codes = [];
  const pointOps = [];
  for (let i = 0; i < keys.length; i += KEYS_PER_REQUEST) {
    const chunk = keys.slice(i, i + KEYS_PER_REQUEST).join(",");
    const [v, c, o] = await Promise.all([
      db(env, `guest_visits?visitor_key=in.(${chunk})&select=business_id,day&limit=100000`),
      db(env, `bonus_codes?visitor_key=in.(${chunk})&select=business_id,code,prize,valid_from,valid_until,redeemed_at,created_at,stamp_reward,vip,reward_kind&order=created_at.desc&limit=100000`),
      // Баллы (points.js, миграция 045)
      db(env, `point_ops?visitor_key=in.(${chunk})&select=business_id,points&limit=100000`)
    ]);
    visits.push(...v);
    codes.push(...c);
    pointOps.push(...o);
  }
  const pointsBy = new Map();
  for (const o of pointOps) pointsBy.set(o.business_id, (pointsBy.get(o.business_id) || 0) + o.points);

  const byPlace = new Map();
  const slot = (id) => {
    if (!byPlace.has(id)) byPlace.set(id, { days: new Set(), codes: [] });
    return byPlace.get(id);
  };
  for (const v of visits) slot(v.business_id).days.add(v.day); // два телефона в один день — один визит
  for (const c of codes) slot(c.business_id).codes.push(c);

  const now = Date.now();
  const mediaUrl = (id) => (id ? `/m/${id}` : null);
  const out = [];
  for (const p of places) {
    const s = byPlace.get(p.id) || { days: new Set(), codes: [] };
    if (!s.days.size && !s.codes.length && !pointsBy.get(p.id)) continue;
    const visitsCount = s.days.size;
    const lastVisit = [...s.days].sort().pop() || null;
    s.codes.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

    // Штампы: погашенные коды с последнего приза за штампы (та же логика, что guests.js stampCount)
    let stamps = null;
    if (stampsOn(p)) {
      let have = 0;
      for (const c of s.codes) {
        if (c.stamp_reward) break;
        if (c.redeemed_at) have++;
      }
      stamps = { have: Math.min(have, p.stamps_goal), goal: p.stamps_goal, prize: p.stamps_prize };
    }
    const vip = vipOn(p) ? { from: p.vip_visits, gift: p.vip_gift } : null;
    const level = vip && visitsCount >= vip.from ? "vip" : visitsCount >= REGULAR_FROM ? "regular" : "new";
    const active = s.codes
      .filter((c) => !c.redeemed_at && Date.parse(c.valid_until) > now)
      .map((c) => ({
        code: c.code,
        prize: c.prize,
        validFrom: c.valid_from,
        validUntil: c.valid_until,
        kind: c.stamp_reward ? "stamps" : c.vip ? "vip" : c.reward_kind === "friend" ? "friend" : c.reward_kind === "inviter" ? "inviter" : "gift"
      }));
    out.push({
      slug: p.slug,
      name: p.name,
      city: p.city || null,
      address: p.address || null,
      logo: p.logo_url || mediaUrl(p.design && p.design.logo),
      cover: mediaUrl((p.photos || [])[0]),
      inCatalog: Boolean(p.catalog_visible),
      visits: visitsCount,
      lastVisit,
      level,
      vip,
      stamps,
      // Баллы: только если включены у заведения или ещё остались на счёте
      points: pointsOn(p) || pointsBy.get(p.id) ? Math.max(0, pointsBy.get(p.id) || 0) : null,
      codes: active
    });
  }
  out.sort((a, b) => b.codes.length - a.codes.length || String(b.lastVisit).localeCompare(String(a.lastVisit)));
  return { devices: devices.length, places: out };
}
