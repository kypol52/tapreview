// API админ-панели.
//   GET    /api/config                   — публичные настройки для страницы входа
//   GET    /api/admin/businesses         — список бизнесов
//   POST   /api/admin/businesses         — создать бизнес (slug генерируется здесь)
//   PATCH  /api/admin/businesses/:id     — изменить бизнес
//   DELETE /api/admin/businesses/:id     — удалить бизнес
//   GET    /api/admin/businesses/:id/stats?days=30&tz=Europe/Moscow — статистика по дням
//   GET    /api/admin/stats-summary?days=30 — итоги по всем бизнесам (для списка)
//   GET    /api/admin/groups             — список групп (один QR → несколько заведений)
//   POST   /api/admin/groups             — создать группу
//   PATCH  /api/admin/groups/:id         — изменить группу
//   DELETE /api/admin/groups/:id         — удалить группу (сами заведения остаются)
//   GET    /api/admin/cards              — список шаблонных карт
//   POST   /api/admin/cards              — выпустить партию карт { count }
//   PATCH  /api/admin/cards/:id          — привязать / перепривязать / отключить карту
//   DELETE /api/admin/cards/:id          — удалить карту
//   GET    /api/admin/card-stats?days=30 — открытия и клики по каждой карте
//   GET    /api/admin/telegram/status    — настроен ли Telegram-бот
//   POST   /api/admin/telegram/setup     — включить бота (адрес для сообщений и список команд)
//   POST   /api/admin/businesses/:id/telegram-invite — одноразовая ссылка для владельца
//   GET    /api/admin/businesses/:id/telegram        — чаты, подключённые к бизнесу
//   DELETE /api/admin/telegram/subscribers/:id       — отключить чат
//   GET    /api/admin/businesses/:id/referrals       — ссылка-приглашение, переходы за 30 дней, кого привело
//   POST   /api/admin/businesses/:id/ref-reward      — «месяц бесплатно обоим» за приглашённое заведение :id
//   GET    /api/admin/businesses/:id/staff-links     — ссылки для персонала (/k/...): только касса подарков
//   POST   /api/admin/businesses/:id/staff-links     — создать { label }
//   DELETE /api/admin/staff-links/:token             — отключить
//   GET    /api/admin/businesses/:id/bonus-stats     — подарки за 30 дней: выдано / погашено
//   GET    /api/admin/orders                         — заявки с сайта (/order/)
//   PATCH  /api/admin/orders/:id                     — сменить статус { status }
//   DELETE /api/admin/orders/:id                     — удалить заявку (и персональные данные в ней)
//   GET    /api/admin/order-recipients               — чаты, куда приходят заявки
//   POST   /api/admin/order-recipients/invite        — ссылка «получать заявки в Telegram»
//   DELETE /api/admin/order-recipients/:chat_id      — перестать присылать заявки в чат
//   GET    /api/admin/businesses/:id/stats-links     — ссылки на страницу статистики (/s/...)
//   POST   /api/admin/businesses/:id/stats-links     — создать ссылку
//   PATCH  /api/admin/stats-links/:token             — какие заведения показывает ссылка { business_ids }
//   DELETE /api/admin/stats-links/:token             — отключить ссылку
//
// Каждый запрос к /api/admin/ проверяет токен входа Supabase и email из ADMIN_EMAILS.
// С базой работаем секретным ключом SUPABASE_SECRET_KEY — он есть только на сервере.

import { db } from "./supabase.js";
import { tg, BOT_COMMANDS } from "./telegram.js";
import { deleteRuOrder } from "./orders.js";
import { bonusCounts } from "./bonus.js";
import { refUrl, refStats } from "./referral.js";

const CATEGORIES = ["restaurant", "beauty", "shop", "hotel", "auto", "other"];

const ADMIN_COLUMNS =
  "id,slug,name,tagline,category,address,logo_url,brand_color," +
  "google_url,yandex_url,twogis_url,discount_code,discount_text,is_active," +
  "paid_until,monthly_price,billing_note," +
  "bonus_mode,bonus_prizes,bonus_from_days,bonus_valid_days,bonus_cooldown_days,bonus_conditions," +
  "referred_by,ref_reward_at,theme," +
  "created_at,updated_at";

const GROUP_COLUMNS = "id,slug,name,tagline,logo_url,business_ids,is_active,created_at,updated_at";
const MAX_GROUP_SIZE = 50;

const CARD_COLUMNS = "id,code,business_id,label,is_active,assigned_at,created_at";
// Код карты печатается на карте — только заглавные буквы и цифры без похожих (0/O, 1/I/L)
const CARD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CARD_CODE_LENGTH = 6;
const MAX_CARDS_PER_BATCH = 200;

// Без похожих символов (0/O, 1/l/I), чтобы ссылку можно было продиктовать
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SLUG_LENGTH = 8;

const MAX_BODY_SIZE = 20000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function handleApi(request, env, url) {
  let isAdmin = false;

  try {
    const path = url.pathname;
    const method = request.method;

    if (path === "/api/config" && method === "GET") {
      return json({
        supabaseUrl: env.SUPABASE_URL,
        publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
        publicBaseUrl: env.PUBLIC_BASE_URL || url.origin
      });
    }

    if (path.startsWith("/api/admin/")) {
      await requireAdmin(request, env);
      isAdmin = true;

      if (path === "/api/admin/businesses") {
        if (method === "GET") return await listBusinesses(env);
        if (method === "POST") return await createBusiness(request, env);
      }

      const idMatch = path.match(/^\/api\/admin\/businesses\/(\d{1,18})$/);
      if (idMatch) {
        if (method === "PATCH") return await updateBusiness(request, env, idMatch[1]);
        if (method === "DELETE") return await deleteBusiness(env, idMatch[1]);
      }

      const statsMatch = path.match(/^\/api\/admin\/businesses\/(\d{1,18})\/stats$/);
      if (statsMatch && method === "GET") {
        return await businessStats(env, statsMatch[1], url);
      }

      if (path === "/api/admin/stats-summary" && method === "GET") {
        return await statsSummary(env, url);
      }

      if (path === "/api/admin/groups") {
        if (method === "GET") return await listGroups(env);
        if (method === "POST") return await createGroup(request, env);
      }

      const groupMatch = path.match(/^\/api\/admin\/groups\/(\d{1,18})$/);
      if (groupMatch) {
        if (method === "PATCH") return await updateGroup(request, env, groupMatch[1]);
        if (method === "DELETE") return await deleteGroup(env, groupMatch[1]);
      }

      if (path === "/api/admin/cards") {
        if (method === "GET") return await listCards(env);
        if (method === "POST") return await issueCards(request, env);
      }

      const cardMatch = path.match(/^\/api\/admin\/cards\/(\d{1,18})$/);
      if (cardMatch) {
        if (method === "PATCH") return await updateCard(request, env, cardMatch[1]);
        if (method === "DELETE") return await deleteCard(env, cardMatch[1]);
      }

      if (path === "/api/admin/card-stats" && method === "GET") {
        return await cardStats(env, url);
      }

      if (path === "/api/admin/telegram/status" && method === "GET") {
        return json(await telegramStatus(env));
      }
      if (path === "/api/admin/telegram/setup" && method === "POST") {
        return await telegramSetup(env);
      }

      const tgInviteMatch = path.match(/^\/api\/admin\/businesses\/(\d{1,18})\/telegram-invite$/);
      if (tgInviteMatch && method === "POST") {
        return await createTelegramInvite(env, tgInviteMatch[1]);
      }

      const tgListMatch = path.match(/^\/api\/admin\/businesses\/(\d{1,18})\/telegram$/);
      if (tgListMatch && method === "GET") {
        return await listTelegramSubscribers(env, tgListMatch[1]);
      }

      const tgSubMatch = path.match(/^\/api\/admin\/telegram\/subscribers\/(\d{1,18})$/);
      if (tgSubMatch && method === "DELETE") {
        return await deleteTelegramSubscriber(env, tgSubMatch[1]);
      }

      const refMatch = path.match(/^\/api\/admin\/businesses\/(\d{1,18})\/referrals$/);
      if (refMatch && method === "GET") {
        const rows = await db(env, `businesses?id=eq.${refMatch[1]}&select=slug`);
        if (!rows.length) throw new HttpError(404, "Бизнес не найден");
        return json({ url: refUrl(env, rows[0].slug), ...(await refStats(env, Number(refMatch[1]))) });
      }
      const rewardMatch = path.match(/^\/api\/admin\/businesses\/(\d{1,18})\/ref-reward$/);
      if (rewardMatch && method === "POST") {
        return await giveRefReward(env, Number(rewardMatch[1]));
      }

      const staffLinksMatch = path.match(/^\/api\/admin\/businesses\/(\d{1,18})\/staff-links$/);
      if (staffLinksMatch) {
        if (method === "GET") return await listStaffLinks(env, staffLinksMatch[1]);
        if (method === "POST") return await createStaffLink(request, env, staffLinksMatch[1]);
      }
      const staffLinkMatch = path.match(/^\/api\/admin\/staff-links\/([A-Za-z0-9]{24})$/);
      if (staffLinkMatch && method === "DELETE") {
        const rows = await db(env, `staff_links?token=eq.${staffLinkMatch[1]}&select=token`, {
          method: "DELETE",
          prefer: "return=representation"
        });
        if (!rows.length) throw new HttpError(404, "Ссылка не найдена");
        return json({ deleted: true });
      }

      const bonusStatsMatch = path.match(/^\/api\/admin\/businesses\/(\d{1,18})\/bonus-stats$/);
      if (bonusStatsMatch && method === "GET") {
        return json(await bonusCounts(env, [Number(bonusStatsMatch[1])], 30));
      }

      if (path === "/api/admin/orders" && method === "GET") {
        return await listOrders(env);
      }
      const orderMatch = path.match(/^\/api\/admin\/orders\/(\d{1,18})$/);
      if (orderMatch) {
        if (method === "PATCH") return await updateOrder(request, env, orderMatch[1]);
        if (method === "DELETE") return await deleteOrder(env, orderMatch[1]);
      }
      if (path === "/api/admin/order-recipients" && method === "GET") {
        return json(await db(env, "order_recipients?select=chat_id,chat_title,created_at&order=created_at.asc"));
      }
      if (path === "/api/admin/order-recipients/invite" && method === "POST") {
        return await createOrderInvite(env);
      }
      const recipientMatch = path.match(/^\/api\/admin\/order-recipients\/(-?\d{1,18})$/);
      if (recipientMatch && method === "DELETE") {
        return await deleteOrderRecipient(env, recipientMatch[1]);
      }

      const statsLinksMatch = path.match(/^\/api\/admin\/businesses\/(\d{1,18})\/stats-links$/);
      if (statsLinksMatch) {
        if (method === "GET") return await listStatsLinks(env, statsLinksMatch[1]);
        if (method === "POST") return await createStatsLink(env, statsLinksMatch[1]);
      }

      const statsLinkMatch = path.match(/^\/api\/admin\/stats-links\/([A-Za-z0-9]{24})$/);
      if (statsLinkMatch) {
        if (method === "PATCH") return await updateStatsLink(request, env, statsLinkMatch[1]);
        if (method === "DELETE") return await deleteStatsLink(env, statsLinkMatch[1]);
      }
    }

    return json({ error: "Не найдено" }, 404);
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }
    // Cloudflare сохраняет в логе только строки, поэтому пишем текст ошибки явно
    console.error(`API error: ${error.message}\n${error.stack}`);

    // Подробности видит только вошедший администратор, посторонним — общий текст
    const message = isAdmin
      ? `Ошибка сервера: ${error.message}`
      : "Ошибка сервера. Подробности — в логах Cloudflare.";
    return json({ error: message }, 500);
  }
}

// ---------- Проверка администратора ----------

async function requireAdmin(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    throw new HttpError(401, "Нужно войти");
  }

  // Supabase сам проверяет подпись и срок действия токена
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    throw new HttpError(401, "Сессия истекла, войдите заново");
  }

  const user = await response.json();
  const email = String(user.email || "").toLowerCase();
  if (!adminEmails(env).includes(email)) {
    throw new HttpError(403, "У этого аккаунта нет доступа к админ-панели");
  }
  return user;
}

function adminEmails(env) {
  return String(env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// ---------- Операции с бизнесами ----------

async function listBusinesses(env) {
  const rows = await db(
    env,
    `businesses?select=${ADMIN_COLUMNS}&order=created_at.desc&limit=1000`
  );
  return json(rows);
}

async function createBusiness(request, env) {
  const data = validateBusiness(await readJson(request));

  // Если случайный slug уже занят (почти невероятно) — пробуем другой
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const rows = await db(env, `businesses?select=${ADMIN_COLUMNS}`, {
        method: "POST",
        body: { ...data, slug: generateSlug() },
        prefer: "return=representation"
      });
      return json(rows[0], 201);
    } catch (error) {
      if (error.code === "23505" && /slug/.test(error.message)) continue;
      throw error;
    }
  }
  throw new Error("Не удалось подобрать свободный slug за 5 попыток");
}

async function updateBusiness(request, env, id) {
  const data = validateBusiness(await readJson(request));
  if (data.referred_by === Number(id)) throw new HttpError(400, "Заведение не может пригласить само себя");
  const rows = await db(env, `businesses?id=eq.${id}&select=${ADMIN_COLUMNS}`, {
    method: "PATCH",
    body: data,
    prefer: "return=representation"
  });
  if (!rows.length) {
    throw new HttpError(404, "Бизнес не найден");
  }
  return json(rows[0]);
}

async function deleteBusiness(env, id) {
  const rows = await db(env, `businesses?id=eq.${id}&select=id`, {
    method: "DELETE",
    prefer: "return=representation"
  });
  if (!rows.length) {
    throw new HttpError(404, "Бизнес не найден");
  }
  return json({ deleted: true });
}

// ---------- Группы заведений (один QR → список заведений) ----------

async function listGroups(env) {
  const rows = await db(
    env,
    `business_groups?select=${GROUP_COLUMNS}&order=created_at.desc&limit=1000`
  );
  return json(rows);
}

async function createGroup(request, env) {
  const data = await validateGroup(await readJson(request), env);

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const rows = await db(env, `business_groups?select=${GROUP_COLUMNS}`, {
        method: "POST",
        body: { ...data, slug: generateSlug() },
        prefer: "return=representation"
      });
      return json(rows[0], 201);
    } catch (error) {
      if (error.code === "23505" && /slug/.test(error.message)) continue;
      throw error;
    }
  }
  throw new Error("Не удалось подобрать свободный slug за 5 попыток");
}

async function updateGroup(request, env, id) {
  const data = await validateGroup(await readJson(request), env);
  const rows = await db(env, `business_groups?id=eq.${id}&select=${GROUP_COLUMNS}`, {
    method: "PATCH",
    body: data,
    prefer: "return=representation"
  });
  if (!rows.length) {
    throw new HttpError(404, "Группа не найдена");
  }
  return json(rows[0]);
}

async function deleteGroup(env, id) {
  const rows = await db(env, `business_groups?id=eq.${id}&select=id`, {
    method: "DELETE",
    prefer: "return=representation"
  });
  if (!rows.length) {
    throw new HttpError(404, "Группа не найдена");
  }
  return json({ deleted: true });
}

async function validateGroup(input, env) {
  const name = cleanText(input.name, 200, "Название");
  if (!name) {
    throw new HttpError(400, "Укажите название");
  }

  const rawIds = Array.isArray(input.business_ids) ? input.business_ids : [];
  const ids = [...new Set(rawIds.map(Number))];
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new HttpError(400, "Неверный список заведений");
  }
  if (ids.length > MAX_GROUP_SIZE) {
    throw new HttpError(400, `В группе может быть не больше ${MAX_GROUP_SIZE} заведений`);
  }
  if (ids.length) {
    const found = await db(env, `businesses?id=in.(${ids.join(",")})&select=id`);
    if (found.length !== ids.length) {
      throw new HttpError(400, "Некоторые заведения не найдены — обновите страницу");
    }
  }

  return {
    name,
    tagline: cleanText(input.tagline, 80, "Подпись") || null,
    logo_url: cleanUrl(input.logo_url, "логотипа"),
    business_ids: ids,
    is_active: input.is_active !== false
  };
}

// ---------- Шаблонные карты (у каждой свой код и QR: /c/КОД) ----------

async function listCards(env) {
  const rows = await db(
    env,
    `cards?select=${CARD_COLUMNS}&order=created_at.asc,id.asc&limit=5000`
  );
  return json(rows);
}

// Выпуск партии: создаём N новых свободных карт со случайными кодами
async function issueCards(request, env) {
  const input = await readJson(request);
  const count = Number(input.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_CARDS_PER_BATCH) {
    throw new HttpError(400, `Количество карт: от 1 до ${MAX_CARDS_PER_BATCH}`);
  }

  const codes = new Set();
  while (codes.size < count) codes.add(generateCardCode());

  // Повтор с уже существующим кодом почти невероятен; если случится — пробуем ещё раз
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const rows = await db(env, `cards?select=${CARD_COLUMNS}`, {
        method: "POST",
        body: [...codes].map((code) => ({ code })),
        prefer: "return=representation"
      });
      return json(rows, 201);
    } catch (error) {
      if (error.code === "23505") {
        codes.clear();
        while (codes.size < count) codes.add(generateCardCode());
        continue;
      }
      throw error;
    }
  }
  throw new Error("Не удалось подобрать свободные коды за 5 попыток");
}

async function updateCard(request, env, id) {
  const input = await readJson(request);

  let businessId = null;
  if (input.business_id !== null && input.business_id !== undefined && input.business_id !== "") {
    businessId = Number(input.business_id);
    if (!Number.isSafeInteger(businessId) || businessId <= 0) {
      throw new HttpError(400, "Неверное заведение");
    }
    const found = await db(env, `businesses?id=eq.${businessId}&select=id`);
    if (!found.length) {
      throw new HttpError(400, "Заведение не найдено — обновите страницу");
    }
  }

  const current = await db(env, `cards?id=eq.${id}&select=business_id`);
  if (!current.length) {
    throw new HttpError(404, "Карта не найдена");
  }

  const data = {
    business_id: businessId,
    label: cleanText(input.label, 60, "Место") || null,
    is_active: input.is_active !== false
  };
  // Время привязки меняем, только когда карту привязали к другому заведению
  if (current[0].business_id !== businessId) {
    data.assigned_at = businessId ? new Date().toISOString() : null;
  }

  const rows = await db(env, `cards?id=eq.${id}&select=${CARD_COLUMNS}`, {
    method: "PATCH",
    body: data,
    prefer: "return=representation"
  });
  return json(rows[0]);
}

async function deleteCard(env, id) {
  const rows = await db(env, `cards?id=eq.${id}&select=id`, {
    method: "DELETE",
    prefer: "return=representation"
  });
  if (!rows.length) {
    throw new HttpError(404, "Карта не найдена");
  }
  return json({ deleted: true });
}

async function cardStats(env, url) {
  const { days } = statsParams(url);
  const rows = await db(env, "rpc/card_stats_summary", {
    method: "POST",
    body: { p_days: days }
  });
  return json({ days, rows });
}

function generateCardCode() {
  const limit = Math.floor(256 / CARD_ALPHABET.length) * CARD_ALPHABET.length;
  let code = "";
  while (code.length < CARD_CODE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (const byte of bytes) {
      if (byte < limit && code.length < CARD_CODE_LENGTH) {
        code += CARD_ALPHABET[byte % CARD_ALPHABET.length];
      }
    }
  }
  return code;
}

// ---------- Проверка данных формы ----------

function validateBusiness(input) {
  const name = cleanText(input.name, 200, "Название");
  if (!name) {
    throw new HttpError(400, "Укажите название");
  }

  const category = input.category ? String(input.category) : null;
  if (category && !CATEGORIES.includes(category)) {
    throw new HttpError(400, "Неизвестная категория");
  }

  const brandColor = input.brand_color ? String(input.brand_color).trim() : null;
  if (brandColor && !/^#[0-9A-Fa-f]{6}$/.test(brandColor)) {
    throw new HttpError(400, "Цвет должен быть в формате #RRGGBB");
  }

  return {
    name,
    tagline: cleanText(input.tagline, 80, "Подпись") || null,
    category,
    address: cleanText(input.address, 300, "Адрес") || null,
    logo_url: cleanUrl(input.logo_url, "логотипа"),
    brand_color: brandColor,
    google_url: cleanUrl(input.google_url, "Google"),
    yandex_url: cleanUrl(input.yandex_url, "Яндекс"),
    twogis_url: cleanUrl(input.twogis_url, "2ГИС"),
    discount_code: cleanText(input.discount_code, 40, "Кодовое слово") || null,
    discount_text: cleanText(input.discount_text, 120, "Описание скидки") || null,
    is_active: input.is_active !== false,
    paid_until: cleanDate(input.paid_until),
    monthly_price: cleanPrice(input.monthly_price),
    billing_note: cleanText(input.billing_note, 200, "Заметка об оплате") || null,
    referred_by: cleanRefId(input.referred_by),
    theme: ["classic", "dark", "coffee", "fresh", "rose"].includes(input.theme) ? input.theme : "classic",
    ...cleanBonus(input)
  };
}

function cleanRefId(value) {
  if (value === undefined || value === null || value === "") return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "«Кто привёл»: неверное заведение");
  return id;
}

// Подарок для гостей (bonus.js): режим, призы колеса, сроки, условия
function cleanBonus(input) {
  const mode = ["off", "fixed", "wheel"].includes(input.bonus_mode) ? input.bonus_mode : "off";
  const prizes = Array.isArray(input.bonus_prizes) ? input.bonus_prizes : [];
  if (prizes.length > 8) throw new HttpError(400, "Колесо: не больше 8 призов");
  const cleanPrizes = prizes.map((p, i) => {
    const label = cleanText(p && p.label, 30, `Приз ${i + 1}`);
    const weight = Number(p && p.weight);
    if (!label) throw new HttpError(400, `Приз ${i + 1}: укажите название`);
    if (!Number.isInteger(weight) || weight < 1 || weight > 1000) {
      throw new HttpError(400, `Приз «${label}»: шанс — целое число от 1 до 1000`);
    }
    return { label, weight };
  });
  if (mode === "wheel" && cleanPrizes.length < 2) throw new HttpError(400, "Для колеса нужно хотя бы 2 приза");
  if (mode === "fixed" && !cleanText(input.discount_text, 120, "Подарок")) {
    throw new HttpError(400, "Напишите, какой подарок получает гость");
  }
  const int = (value, min, max, label, fallback) => {
    if (value === undefined || value === null || value === "") return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label}: целое число от ${min} до ${max}`);
    return n;
  };
  return {
    bonus_mode: mode,
    bonus_prizes: cleanPrizes,
    bonus_from_days: int(input.bonus_from_days, 0, 30, "Через сколько дней начинает действовать", 1),
    bonus_valid_days: int(input.bonus_valid_days, 1, 365, "Сколько дней действует", 14),
    bonus_cooldown_days: int(input.bonus_cooldown_days, 1, 365, "Как часто можно получать", 30),
    bonus_conditions: cleanText(input.bonus_conditions, 200, "Условия подарка") || null
  };
}

function cleanDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new HttpError(400, "«Оплачено до»: неверная дата");
  }
  return text;
}

function cleanPrice(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const price = Number(text);
  if (!Number.isInteger(price) || price < 0 || price > 1000000) {
    throw new HttpError(400, "Цена в месяц: целое число рублей от 0 до 1 000 000");
  }
  return price;
}

function cleanText(value, maxLength, label) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) {
    throw new HttpError(400, `${label}: не больше ${maxLength} символов`);
  }
  return text;
}

function cleanUrl(value, label) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > 2000) {
    throw new HttpError(400, `Ссылка ${label} слишком длинная`);
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new HttpError(400, `Ссылка ${label}: неверный адрес`);
  }
  if (url.protocol !== "https:") {
    throw new HttpError(400, `Ссылка ${label} должна начинаться с https://`);
  }
  return url.href;
}

function generateSlug() {
  // Отбрасываем байты >= 224, чтобы все символы выпадали с одинаковой вероятностью
  const limit = Math.floor(256 / SLUG_ALPHABET.length) * SLUG_ALPHABET.length;
  let slug = "";
  while (slug.length < SLUG_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (const byte of bytes) {
      if (byte < limit && slug.length < SLUG_LENGTH) {
        slug += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
      }
    }
  }
  return slug;
}

// ---------- Статистика ----------

function statsParams(url) {
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days"), 10) || 30, 1), 365);
  const tzParam = url.searchParams.get("tz") || "";
  const tz = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tzParam) ? tzParam : "Europe/Moscow";
  return { days, tz };
}

async function businessStats(env, id, url) {
  const { days, tz } = statsParams(url);
  const rows = await db(env, "rpc/business_stats", {
    method: "POST",
    body: { p_business_id: Number(id), p_days: days, p_tz: tz }
  });
  return json({ days, tz, rows });
}

async function statsSummary(env, url) {
  const { days } = statsParams(url);
  const rows = await db(env, "rpc/stats_summary", {
    method: "POST",
    body: { p_days: days }
  });
  return json({ days, rows });
}

// ---------- Telegram-бот для владельцев ----------

const TG_INVITE_LENGTH = 20;

function webhookUrl(env) {
  return `${String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "")}/tg/webhook`;
}

async function telegramStatus(env) {
  if (!env.TG_BOT_TOKEN) {
    return { configured: false, has_secret: Boolean(env.TG_WEBHOOK_SECRET) };
  }
  const [me, hook] = await Promise.all([tg(env, "getMe"), tg(env, "getWebhookInfo")]);
  return {
    configured: true,
    has_secret: Boolean(env.TG_WEBHOOK_SECRET),
    username: me.username,
    webhook_ok: hook.url === webhookUrl(env),
    last_error: hook.last_error_message || null
  };
}

async function telegramSetup(env) {
  if (!env.TG_BOT_TOKEN || !env.TG_WEBHOOK_SECRET) {
    throw new HttpError(400, "Сначала добавьте в Cloudflare секреты TG_BOT_TOKEN и TG_WEBHOOK_SECRET");
  }
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(env.TG_WEBHOOK_SECRET)) {
    throw new HttpError(400, "TG_WEBHOOK_SECRET: от 16 символов, только латинские буквы, цифры, _ и -");
  }
  await tg(env, "setWebhook", {
    url: webhookUrl(env),
    secret_token: env.TG_WEBHOOK_SECRET,
    allowed_updates: ["message"],
    drop_pending_updates: true
  });
  await tg(env, "setMyCommands", { commands: BOT_COMMANDS });
  await tg(env, "setMyDescription", {
    description:
      "Статистика TapReview для владельцев заведений: сколько раз открыли страницу отзывов " +
      "и сколько человек перешли оставить отзыв. Подключение — по ссылке от TapReview."
  });
  return json(await telegramStatus(env));
}

async function createTelegramInvite(env, businessId) {
  const found = await db(env, `businesses?id=eq.${businessId}&select=id`);
  if (!found.length) {
    throw new HttpError(404, "Бизнес не найден");
  }
  const me = await tg(env, "getMe");
  const code = randomString(SLUG_ALPHABET, TG_INVITE_LENGTH);
  const rows = await db(env, "tg_invites?select=code,expires_at", {
    method: "POST",
    body: { code, business_id: Number(businessId) },
    prefer: "return=representation"
  });
  return json({ link: `https://t.me/${me.username}?start=${code}`, expires_at: rows[0].expires_at }, 201);
}

async function listTelegramSubscribers(env, businessId) {
  const rows = await db(
    env,
    `tg_subscribers?business_id=eq.${businessId}&select=id,chat_id,chat_title,weekly_report,created_at&order=created_at.asc`
  );
  return json(rows);
}

async function deleteTelegramSubscriber(env, id) {
  const rows = await db(env, `tg_subscribers?id=eq.${id}&select=id`, {
    method: "DELETE",
    prefer: "return=representation"
  });
  if (!rows.length) {
    throw new HttpError(404, "Чат не найден");
  }
  return json({ deleted: true });
}

// ---------- Рекомендации: «месяц бесплатно обоим» ----------
// id — приглашённое заведение. Условие: у него указан «кто привёл» и есть оплаченная подписка.
// Обоим продлеваем «Оплачено до» на 1 месяц (от конца срока или от сегодня, если срок прошёл).

async function giveRefReward(env, id) {
  const rows = await db(env, `businesses?id=eq.${id}&select=id,name,referred_by,paid_until,ref_reward_at`);
  const invited = rows[0];
  if (!invited) throw new HttpError(404, "Бизнес не найден");
  if (!invited.referred_by) throw new HttpError(400, "У заведения не указано, кто его привёл");
  if (invited.ref_reward_at) throw new HttpError(400, "Награда за это заведение уже выдана");
  if (!invited.paid_until) throw new HttpError(400, "Заведение ещё не оплатило подписку — награда выдаётся после первой оплаты");

  const refRows = await db(env, `businesses?id=eq.${invited.referred_by}&select=id,name,paid_until`);
  const referrer = refRows[0];

  const extended = {};
  extended.invited = plusMonth(invited.paid_until);
  await db(env, `businesses?id=eq.${invited.id}`, {
    method: "PATCH",
    body: { paid_until: extended.invited, ref_reward_at: new Date().toISOString() },
    prefer: "return=minimal"
  });
  if (referrer && referrer.paid_until) {
    extended.referrer = plusMonth(referrer.paid_until);
    await db(env, `businesses?id=eq.${referrer.id}`, {
      method: "PATCH",
      body: { paid_until: extended.referrer },
      prefer: "return=minimal"
    });
  }
  return json({ ok: true, invited: extended.invited, referrer: extended.referrer || null, referrerName: referrer ? referrer.name : null });
}

// «2026-11-14» → «2026-12-14»; если срок уже прошёл — месяц от сегодняшнего дня (по Москве)
function plusMonth(isoDate) {
  const today = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const base = isoDate && isoDate >= today ? isoDate : today;
  const [y, m, d] = base.split("-").map(Number);
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

// ---------- Ссылки для персонала (/k/...): только проверка и погашение кодов подарков ----------

const MAX_STAFF_LINKS = 20;

function staffLinkUrl(env, token) {
  return `${String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "")}/k/${token}`;
}

async function listStaffLinks(env, businessId) {
  const rows = await db(
    env,
    `staff_links?business_id=eq.${businessId}&select=token,label,created_at,last_used_at&order=created_at.asc`
  );
  return json(rows.map((row) => ({ ...row, url: staffLinkUrl(env, row.token) })));
}

async function createStaffLink(request, env, businessId) {
  const data = await readJson(request);
  const found = await db(env, `businesses?id=eq.${businessId}&select=id`);
  if (!found.length) throw new HttpError(404, "Бизнес не найден");
  const existing = await db(env, `staff_links?business_id=eq.${businessId}&select=token`);
  if (existing.length >= MAX_STAFF_LINKS) {
    throw new HttpError(400, `У заведения уже ${MAX_STAFF_LINKS} ссылок для персонала — отключите ненужные`);
  }
  const rows = await db(env, "staff_links?select=token,label,created_at,last_used_at", {
    method: "POST",
    body: {
      token: randomString(STATS_TOKEN_ALPHABET, STATS_TOKEN_LENGTH),
      business_id: Number(businessId),
      label: cleanText(data.label, 60, "Подпись") || null
    },
    prefer: "return=representation"
  });
  return json({ ...rows[0], url: staffLinkUrl(env, rows[0].token) }, 201);
}

// ---------- Заявки с сайта (/order/) ----------

const ORDER_STATUSES = ["new", "in_work", "done", "rejected"];

async function listOrders(env) {
  const rows = await db(env, "orders?select=*&order=created_at.desc&limit=300");
  return json(rows);
}

async function updateOrder(request, env, id) {
  const data = await readJson(request);
  if (!ORDER_STATUSES.includes(data.status)) {
    throw new HttpError(400, "Неизвестный статус");
  }
  const rows = await db(env, `orders?id=eq.${id}&select=*`, {
    method: "PATCH",
    body: { status: data.status },
    prefer: "return=representation"
  });
  if (!rows.length) throw new HttpError(404, "Заявка не найдена");
  return json(rows[0]);
}

// Удаление — по просьбе человека или когда данные больше не нужны (см. политику /privacy/)
async function deleteOrder(env, id) {
  // Сначала — из российской базы (первичная запись), потом копию здесь
  const found = await db(env, `orders?id=eq.${id}&select=ru_id`);
  if (!found.length) throw new HttpError(404, "Заявка не найдена");
  await deleteRuOrder(env, found[0].ru_id);
  const rows = await db(env, `orders?id=eq.${id}&select=id`, { method: "DELETE", prefer: "return=representation" });
  if (!rows.length) throw new HttpError(404, "Заявка не найдена");
  return json({ deleted: true });
}

async function createOrderInvite(env) {
  const me = await tg(env, "getMe");
  const code = randomString(SLUG_ALPHABET, TG_INVITE_LENGTH);
  const rows = await db(env, "order_invites?select=code,expires_at", {
    method: "POST",
    body: { code },
    prefer: "return=representation"
  });
  return json({ link: `https://t.me/${me.username}?start=${code}`, expires_at: rows[0].expires_at }, 201);
}

async function deleteOrderRecipient(env, chatId) {
  const rows = await db(env, `order_recipients?chat_id=eq.${chatId}&select=chat_id`, {
    method: "DELETE",
    prefer: "return=representation"
  });
  if (!rows.length) throw new HttpError(404, "Чат не найден");
  return json({ deleted: true });
}

// ---------- Страница статистики по ссылке (/s/...) ----------

const STATS_TOKEN_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const STATS_TOKEN_LENGTH = 24;
const MAX_STATS_LINKS = 20;

function statsLinkUrl(env, token) {
  return `${String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "")}/s/${token}`;
}

const STATS_LINK_COLUMNS = "token,business_id,business_ids,created_at,last_opened_at";
const MAX_STATS_LINK_BUSINESSES = 50;

// Ссылки, в которых есть это заведение (одна ссылка может показывать несколько заведений)
async function listStatsLinks(env, businessId) {
  const rows = await db(
    env,
    `stats_links?or=(business_id.eq.${businessId},business_ids.cs.{${businessId}})` +
      `&select=${STATS_LINK_COLUMNS}&order=created_at.asc`
  );
  return json(await withLinkCards(env, rows.map((row) => statsLinkOut(env, row))));
}

function statsLinkOut(env, row) {
  const ids = row.business_ids && row.business_ids.length ? row.business_ids : [row.business_id];
  return { ...row, business_ids: ids, url: statsLinkUrl(env, row.token) };
}

// Карты, которые видны по ссылке (все карты её заведений): link.cards = [{ code, label, business_id, is_active }]
async function withLinkCards(env, links) {
  const ids = [...new Set(links.flatMap((l) => l.business_ids))];
  const cards = ids.length
    ? await db(env, `cards?business_id=in.(${ids.join(",")})&select=code,label,business_id,is_active&order=code.asc`)
    : [];
  return links.map((l) => ({ ...l, cards: cards.filter((c) => l.business_ids.includes(c.business_id)) }));
}

async function createStatsLink(env, businessId) {
  const found = await db(env, `businesses?id=eq.${businessId}&select=id`);
  if (!found.length) {
    throw new HttpError(404, "Бизнес не найден");
  }
  const existing = await db(env, `stats_links?business_id=eq.${businessId}&select=token`);
  if (existing.length >= MAX_STATS_LINKS) {
    throw new HttpError(400, `У заведения уже ${MAX_STATS_LINKS} ссылок — отключите ненужные`);
  }
  const id = Number(businessId);
  const rows = await db(env, `stats_links?select=${STATS_LINK_COLUMNS}`, {
    method: "POST",
    body: { token: randomString(STATS_TOKEN_ALPHABET, STATS_TOKEN_LENGTH), business_id: id, business_ids: [id] },
    prefer: "return=representation"
  });
  return json(statsLinkOut(env, rows[0]), 201);
}

// Что показывает ссылка:
//   { business_ids: [id, ...] } — список заведений по порядку, первое — главное
//   { add_card: "W6A-P37" }     — добавить карту по номеру (добавляется заведение, к которому она привязана)
async function updateStatsLink(request, env, token) {
  const data = await readJson(request);
  if (data.add_card !== undefined) {
    data.business_ids = await idsWithCard(env, token, data.add_card);
  }
  if (!Array.isArray(data.business_ids)) {
    throw new HttpError(400, "Нужен список заведений");
  }
  const ids = [...new Set(data.business_ids.map(Number))];
  if (!ids.length) {
    throw new HttpError(400, "В ссылке должно остаться хотя бы одно заведение");
  }
  if (ids.length > MAX_STATS_LINK_BUSINESSES) {
    throw new HttpError(400, `В одной ссылке — не больше ${MAX_STATS_LINK_BUSINESSES} заведений`);
  }
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw new HttpError(400, "Неверный список заведений");
  }
  const found = await db(env, `businesses?id=in.(${ids.join(",")})&select=id`);
  if (found.length !== ids.length) {
    throw new HttpError(400, "Некоторые заведения не найдены — обновите страницу");
  }
  const rows = await db(env, `stats_links?token=eq.${token}&select=${STATS_LINK_COLUMNS}`, {
    method: "PATCH",
    body: { business_id: ids[0], business_ids: ids },
    prefer: "return=representation"
  });
  if (!rows.length) {
    throw new HttpError(404, "Ссылка не найдена");
  }
  return json(statsLinkOut(env, rows[0]));
}

async function idsWithCard(env, token, rawCode) {
  const code = String(rawCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z0-9]{4,12}$/.test(code)) {
    throw new HttpError(400, "Введите номер карты — он напечатан на обратной стороне, например W6A-P37");
  }
  const pretty = code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code; // как на карте
  const [cards, links] = await Promise.all([
    db(env, `cards?code=eq.${code}&select=business_id`),
    db(env, `stats_links?token=eq.${token}&select=business_id,business_ids`)
  ]);
  if (!links.length) {
    throw new HttpError(404, "Ссылка не найдена");
  }
  if (!cards.length) {
    throw new HttpError(404, `Карта ${pretty} не найдена`);
  }
  if (!cards[0].business_id) {
    throw new HttpError(400, `Карта ${pretty} ещё не привязана к заведению — сначала привяжите её во вкладке «Карты»`);
  }
  const link = statsLinkOut(env, links[0]);
  if (link.business_ids.includes(cards[0].business_id)) {
    throw new HttpError(400, `Карта ${pretty} уже есть в этой ссылке`);
  }
  return [...link.business_ids, cards[0].business_id];
}

async function deleteStatsLink(env, token) {
  const rows = await db(env, `stats_links?token=eq.${token}&select=token`, {
    method: "DELETE",
    prefer: "return=representation"
  });
  if (!rows.length) {
    throw new HttpError(404, "Ссылка не найдена");
  }
  return json({ deleted: true });
}

function randomString(alphabet, length) {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    for (const byte of bytes) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

// ---------- Вспомогательные функции ----------

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_SIZE) {
    throw new HttpError(413, "Слишком большой запрос");
  }
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data;
    }
  } catch {
    // ниже вернём понятную ошибку
  }
  throw new HttpError(400, "Неверный формат данных");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
