// API админ-панели.
//   GET    /api/config                   — публичные настройки для страницы входа
//   GET    /api/admin/businesses         — список бизнесов
//   POST   /api/admin/businesses         — создать бизнес (slug генерируется здесь)
//   PATCH  /api/admin/businesses/:id     — изменить бизнес
//   DELETE /api/admin/businesses/:id     — удалить бизнес
//
// Каждый запрос к /api/admin/ проверяет токен входа Supabase и email из ADMIN_EMAILS.
// С базой работаем секретным ключом SUPABASE_SECRET_KEY — он есть только на сервере.

const CATEGORIES = ["restaurant", "beauty", "shop", "hotel", "auto", "other"];

const ADMIN_COLUMNS =
  "id,slug,name,category,address,logo_url,brand_color," +
  "google_url,yandex_url,twogis_url,is_active,created_at,updated_at";

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
        publishableKey: env.SUPABASE_PUBLISHABLE_KEY
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
    category,
    address: cleanText(input.address, 300, "Адрес") || null,
    logo_url: cleanUrl(input.logo_url, "логотипа"),
    brand_color: brandColor,
    google_url: cleanUrl(input.google_url, "Google"),
    yandex_url: cleanUrl(input.yandex_url, "Яндекс"),
    twogis_url: cleanUrl(input.twogis_url, "2ГИС"),
    is_active: input.is_active !== false
  };
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

// ---------- Вспомогательные функции ----------

async function db(env, path, options = {}) {
  if (!env.SUPABASE_SECRET_KEY) {
    throw new Error(
      "Не задан секрет SUPABASE_SECRET_KEY (Cloudflare → Worker → Settings → Variables and Secrets)"
    );
  }

  const headers = {
    apikey: env.SUPABASE_SECRET_KEY,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  if (options.prefer) {
    headers.Prefer = options.prefer;
  }

  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(`Supabase ${response.status}: ${text}`);
    error.code = data && data.code;
    throw error;
  }
  return data;
}

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
