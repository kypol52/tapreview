// Публичная страница бизнеса /b/:slug.
// Собирается на сервере: посетитель получает готовый HTML за один запрос,
// ключи не попадают в браузер.

const SLUG_RE = /^[A-Za-z0-9_-]{3,64}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_COLOR = "#111827";

const PLATFORMS = [
  { field: "google_url", label: "Оставить отзыв в Google" },
  { field: "yandex_url", label: "Оставить отзыв в Яндекс Картах" },
  { field: "twogis_url", label: "Оставить отзыв в 2ГИС" }
];

export async function handleBusinessPage(env, slug) {
  if (!SLUG_RE.test(slug)) {
    return notFoundPage();
  }

  let business;
  try {
    business = await fetchBusiness(env, slug);
  } catch (error) {
    console.error(`Ошибка загрузки бизнеса: ${error.message}\n${error.stack}`);
    return renderPage({
      status: 500,
      title: "Не удалось загрузить",
      color: DEFAULT_COLOR,
      body: `
        <h1>Не удалось загрузить страницу</h1>
        <p class="lead">Попробуйте обновить страницу через минуту.</p>`
    });
  }

  if (!business) {
    return notFoundPage();
  }

  return businessPage(business);
}

async function fetchBusiness(env, slug) {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    throw new Error(
      "Не заданы переменные SUPABASE_URL или SUPABASE_PUBLISHABLE_KEY в wrangler.jsonc"
    );
  }

  const url =
    `${env.SUPABASE_URL}/rest/v1/businesses` +
    `?slug=eq.${encodeURIComponent(slug)}` +
    `&select=name,logo_url,brand_color,google_url,yandex_url,twogis_url` +
    `&limit=1`;

  const response = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  }

  const rows = await response.json();
  return rows[0] || null;
}

function businessPage(business) {
  const color = COLOR_RE.test(business.brand_color || "")
    ? business.brand_color
    : DEFAULT_COLOR;

  const buttons = PLATFORMS
    .filter((p) => isHttpsUrl(business[p.field]))
    .map(
      (p) =>
        `<a class="button" href="${escapeHtml(business[p.field])}" rel="noopener">${p.label}</a>`
    )
    .join("\n");

  const logo = isHttpsUrl(business.logo_url)
    ? `<img class="logo" src="${escapeHtml(business.logo_url)}" alt="${escapeHtml(business.name)}" referrerpolicy="no-referrer">`
    : "";

  const actions = buttons
    ? `<p class="lead">Спасибо за ваш визит!<br>Пожалуйста, поделитесь впечатлением:</p>
       <div class="buttons">${buttons}</div>`
    : `<p class="lead">Спасибо за ваш визит!<br>Ссылки для отзывов скоро появятся.</p>`;

  return renderPage({
    status: 200,
    title: `Отзыв — ${business.name}`,
    color,
    body: `
      ${logo}
      <h1>${escapeHtml(business.name)}</h1>
      ${actions}`
  });
}

function notFoundPage() {
  return renderPage({
    status: 404,
    title: "Страница не найдена",
    color: DEFAULT_COLOR,
    body: `
      <h1>Страница не найдена</h1>
      <p class="lead">Проверьте ссылку или отсканируйте карту ещё раз.</p>`
  });
}

function renderPage({ status, title, color, body }) {
  const textOnColor = isLightColor(color) ? "#111827" : "#ffffff";

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { --brand: ${color}; --on-brand: ${textOnColor}; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
      background: #f6f7f9;
      color: #111827;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    }
    .card {
      width: 100%;
      max-width: 420px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 16px;
      padding: 32px 24px;
      text-align: center;
      box-shadow: 0 4px 16px rgba(17, 24, 39, 0.06);
    }
    .logo {
      display: block;
      max-width: 120px;
      max-height: 80px;
      margin: 0 auto 16px;
      object-fit: contain;
    }
    h1 { margin: 0 0 12px; font-size: 24px; line-height: 1.25; }
    .lead { margin: 0 0 24px; color: #4b5563; line-height: 1.5; }
    .buttons { display: flex; flex-direction: column; gap: 12px; }
    .button {
      display: block;
      padding: 16px;
      border-radius: 12px;
      background: var(--brand);
      color: var(--on-brand);
      font-size: 17px;
      font-weight: 600;
      text-decoration: none;
    }
    .button:active { opacity: 0.85; }
    .footer { margin-top: 20px; font-size: 12px; color: #9ca3af; }
  </style>
</head>
<body>
  <main class="card">
    ${body}
  </main>
  <div class="footer">TapReview</div>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy":
        "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
  });
}

function isHttpsUrl(value) {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// Светлый ли цвет — чтобы выбрать чёрный или белый текст на кнопке
function isLightColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 160;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
