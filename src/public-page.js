// Публичная страница бизнеса /b/:slug, шаблонная карта /c/:code,
// страница группы заведений /g/:slug и переходы на площадки /go/:slug/:platform.
// Страница собирается на сервере: посетитель получает готовый HTML за один запрос,
// ключи не попадают в браузер.
// Кнопки ведут не прямо на Google/Яндекс/2ГИС, а через /go/... — так мы считаем клики,
// после чего сразу перенаправляем посетителя на нужную площадку.

import { db } from "./supabase.js";
import { logEvent, sourceFrom } from "./analytics.js";
import { isExpired } from "./billing.js";

const SLUG_RE = /^[A-Za-z0-9_-]{3,64}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
// Тёплый золотисто-бежевый — черта под названием, если свой цвет не задан
const DEFAULT_ACCENT = "#c9a27e";

// Подпись под названием, если в админке её не заполнили
const CATEGORY_TAGLINES = {
  restaurant: "Ресторан",
  beauty: "Салон красоты",
  shop: "Магазин",
  hotel: "Отель",
  auto: "Автосервис"
};

// Порядок здесь = порядок кнопок на странице
const PLATFORMS = [
  { key: "yandex", field: "yandex_url", label: "в Яндекс Картах" },
  { key: "google", field: "google_url", label: "в Google Maps" },
  { key: "twogis", field: "twogis_url", label: "в 2ГИС" }
];

// Значки площадок — рисуем сами (inline SVG), без загрузки картинок со сторонних сайтов
export const ICONS = {
  yandex: `<svg viewBox="0 0 40 40" aria-hidden="true">
    <circle cx="20" cy="20" r="20" fill="#fc3f1d"/>
    <path fill="#fff" d="M22.4 31h3.9V9h-5.7c-5.7 0-8.7 2.9-8.7 7.2 0 3.4 1.6 5.5 4.6 7.6L11.3 31h4.2l5.7-8.5-2-1.3c-2.4-1.6-3.6-2.9-3.6-5.6 0-2.4 1.7-4 4.9-4h1.9V31z"/>
  </svg>`,
  google: `<svg viewBox="0 0 40 40" aria-hidden="true">
    <defs><clipPath id="gm-pin"><path d="M20 2c-7.2 0-13 5.6-13 12.6 0 9.4 13 23.4 13 23.4s13-14 13-23.4C33 7.6 27.2 2 20 2z"/></clipPath></defs>
    <g clip-path="url(#gm-pin)">
      <rect x="0" y="0" width="40" height="40" fill="#34a853"/>
      <path d="M0 0h20v16L0 30z" fill="#fbbc04"/>
      <path d="M0 0h40v8L20 16 7 6z" fill="#4285f4"/>
      <path d="M20 0h20v22L20 16z" fill="#ea4335"/>
      <path d="M7 0h22L20 14z" fill="#1a73e8"/>
    </g>
    <circle cx="20" cy="14.6" r="4.8" fill="#fff"/>
  </svg>`,
  twogis: `<svg viewBox="0 0 40 40" aria-hidden="true">
    <rect width="40" height="40" rx="10" fill="#19aa1e"/>
    <path d="M0 10a10 10 0 0 1 10-10h20a10 10 0 0 1 10 10v8H0z" fill="#ffd200"/>
    <path d="M0 16h40v6H0z" fill="#fff" opacity=".9"/>
    <path d="M20 8.5c-5.2 0-9.3 3.9-9.3 8.8 0 6.6 9.3 14.2 9.3 14.2s9.3-7.6 9.3-14.2c0-4.9-4.1-8.8-9.3-8.8z" fill="#fff"/>
    <path d="M20 10.8c-3.9 0-7 2.9-7 6.5 0 4.8 7 10.9 7 10.9s7-6.1 7-10.9c0-3.6-3.1-6.5-7-6.5z" fill="#1ba1f2"/>
  </svg>`
};

const ARROW = `<svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const STAR = `<svg viewBox="0 0 24 24"><path d="M12 2.6l2.9 6 6.6.8-4.9 4.6 1.3 6.5L12 17.3l-5.9 3.2 1.3-6.5L2.5 9.4l6.6-.8z"/></svg>`;

const HEART = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

const EXTERNAL = `<svg class="ext" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16 16 8M9.5 8H16v6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const GIFT = `<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="20" fill="#f0b43c"/><g fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"><rect x="11" y="17" width="18" height="12" rx="1.5"/><path d="M10 13.5h20v3.5H10zM20 13.5V29"/><path d="M20 13.5c-1.5-3.5-6-4-6-1.2 0 1.5 2.5 1.2 6 1.2zM20 13.5c1.5-3.5 6-4 6-1.2 0 1.5-2.5 1.2-6 1.2z" stroke-linecap="round"/></g></svg>`;

const BUSINESS_COLUMNS =
  "id,slug,name,tagline,category,logo_url,brand_color,google_url,yandex_url,twogis_url," +
  "discount_code,discount_text,paid_until";

export const TELEGRAM_URL ="https://t.me/tapreviewru";

export async function handleBusinessPage(request, env, ctx, slug) {
  const result = await loadBusiness(env, slug);
  if (result.response) return result.response;

  const business = result.business;
  const source = sourceFrom(new URL(request.url));

  ctx.waitUntil(
    logEvent(request, env, { businessId: business.id, eventType: "page_view", source })
  );

  if (isExpired(business.paid_until)) return pausedResponse(business);
  return businessPage(business, source);
}

// Подписка закончилась (после отсрочки): гость не должен упираться в ошибку —
// отправляем его сразу на первую площадку из списка. Открытия продолжаем считать,
// чтобы после продления владелец увидел их в статистике.
function pausedResponse(business) {
  const platform = PLATFORMS.find((p) => isHttpsUrl(business[p.field]));
  if (platform) return redirect(business[platform.field]);
  return renderPage({
    status: 200,
    title: business.name,
    accent: DEFAULT_ACCENT,
    body: `
      <h1 class="name">${escapeHtml(business.name)}</h1>
      <div class="divider"></div>
      <h2 class="thanks">Спасибо, что вы с нами!</h2>
      <p class="lead">Страница отзывов временно недоступна.</p>`
  });
}

export async function handleGo(request, env, ctx, slug, platformKey) {
  const platform = PLATFORMS.find((p) => p.key === platformKey);
  if (!platform) return notFoundPage();

  const result = await loadBusiness(env, slug);
  if (result.response) return result.response;

  const business = result.business;
  const target = business[platform.field];

  // Ссылку убрали, а посетитель нажал старую кнопку — возвращаем на страницу бизнеса
  if (!isHttpsUrl(target)) {
    return redirect(`/b/${business.slug}`);
  }

  // Клик со страницы шаблонной карты: ?c=КОД. Карту засчитываем, только если она
  // действительно привязана к этому бизнесу (подделанный код просто игнорируется).
  const url = new URL(request.url);
  const cardCode = normalizeCardCode(url.searchParams.get("c"));

  ctx.waitUntil(
    (async () => {
      let cardId = null;
      if (cardCode) {
        try {
          const cards = await db(
            env,
            `cards?code=eq.${cardCode}&business_id=eq.${business.id}&select=id&limit=1`
          );
          cardId = cards.length ? cards[0].id : null;
        } catch (error) {
          console.error(`Не удалось найти карту для клика: ${error.message}`);
        }
      }
      await logEvent(request, env, {
        businessId: business.id,
        eventType: "click",
        destination: platform.key,
        source: sourceFrom(url),
        cardId
      });
    })()
  );

  return redirect(target);
}

// Шаблонная карта /c/:code. У каждой напечатанной карты свой код.
// Карта привязана к бизнесу → сразу показываем страницу отзывов этого бизнеса
// (адрес не меняется, редиректа нет). Не привязана → «Карта ещё не активирована».
export async function handleCardPage(request, env, ctx, rawCode) {
  const code = normalizeCardCode(rawCode);
  if (!code) return notFoundPage();

  let card;
  let business = null;
  try {
    const cards = await db(
      env,
      `cards?code=eq.${code}&select=id,code,business_id,is_active&limit=1`
    );
    if (!cards.length) return notFoundPage();
    card = cards[0];

    if (card.is_active && card.business_id) {
      const rows = await db(
        env,
        `businesses?id=eq.${card.business_id}&is_active=eq.true&select=${BUSINESS_COLUMNS}&limit=1`
      );
      business = rows[0] || null;
    }
  } catch (error) {
    console.error(`Ошибка загрузки карты: ${error.message}\n${error.stack}`);
    return errorPage();
  }

  if (!card.is_active) {
    return cardInfoPage(
      card.code,
      "Карта отключена",
      "Эта карта больше не используется. Обратитесь, пожалуйста, к персоналу заведения.",
      false
    );
  }
  if (!card.business_id) {
    return cardInfoPage(
      card.code,
      "Карта ещё не активирована",
      "Совсем скоро здесь появится страница заведения. Загляните чуть позже!",
      true
    );
  }
  if (!business) {
    return cardInfoPage(
      card.code,
      "Страница временно недоступна",
      "Попробуйте, пожалуйста, ещё раз немного позже.",
      false
    );
  }

  const source = sourceFrom(new URL(request.url));
  ctx.waitUntil(
    logEvent(request, env, {
      businessId: business.id,
      eventType: "page_view",
      source,
      cardId: card.id
    })
  );

  if (isExpired(business.paid_until)) return pausedResponse(business);
  return businessPage(business, source, card.code);
}

// Код карты: только латинские буквы и цифры, регистр и дефисы не важны (K7P-3QX = k7p3qx)
function normalizeCardCode(value) {
  const code = String(value || "").replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(code) ? code : null;
}

// K7P3QX → K7P-3QX (так номер напечатан на карте)
function formatCardCode(code) {
  return code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

function cardInfoPage(code, heading, text, showOwnerLink) {
  const ownerLink = showOwnerLink
    ? `<a class="owner-link" href="/admin/?card=${escapeHtml(code)}">Я владелец — активировать карту</a>`
    : "";
  return renderPage({
    status: 200,
    title: heading,
    accent: DEFAULT_ACCENT,
    body: `
      <div class="card-mark" aria-hidden="true">TR</div>
      <h2 class="thanks">${escapeHtml(heading)}</h2>
      <p class="lead">${escapeHtml(text)}</p>
      <p class="card-code">Карта № ${escapeHtml(formatCardCode(code))}</p>
      ${ownerLink}`
  });
}

// Страница группы /g/:slug: один QR / NFC на несколько заведений.
// Посетитель выбирает заведение и попадает на его обычную страницу /b/:slug,
// где просмотр и клики считаются как обычно (с тем же источником NFC / QR).
export async function handleGroupPage(request, env, slug) {
  if (!SLUG_RE.test(slug)) return notFoundPage();

  let group;
  let venues = [];
  try {
    const groups = await db(
      env,
      `business_groups?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true` +
        `&select=name,tagline,logo_url,business_ids&limit=1`
    );
    if (!groups.length) return notFoundPage();
    group = groups[0];

    const ids = (group.business_ids || []).filter((id) => Number.isSafeInteger(id));
    if (ids.length) {
      const rows = await db(
        env,
        `businesses?id=in.(${ids.join(",")})&is_active=eq.true` +
          `&select=id,slug,name,tagline,category`
      );
      // Порядок — как задан в админке
      venues = ids.map((id) => rows.find((b) => b.id === id)).filter(Boolean);
    }
  } catch (error) {
    console.error(`Ошибка загрузки группы: ${error.message}\n${error.stack}`);
    return errorPage();
  }

  const source = sourceFrom(new URL(request.url));
  return groupPage(group, venues, source);
}

function groupPage(group, venues, source) {
  const sourceQuery = source === "direct" ? "" : `?s=${source}`;

  const buttons = venues
    .map((venue) => {
      const subText = venue.tagline || CATEGORY_TAGLINES[venue.category] || "";
      const sub = subText ? `<span class="venue-sub">${escapeHtml(subText)}</span>` : "";
      const letter = [...venue.name.trim()][0] || "•";
      return `
        <a class="button venue" href="/b/${escapeHtml(venue.slug)}${sourceQuery}">
          <span class="venue-mark" aria-hidden="true">${escapeHtml(letter.toUpperCase())}</span>
          <span class="label"><span class="venue-name">${escapeHtml(venue.name)}</span>${sub}</span>
          ${ARROW}
        </a>`;
    })
    .join("");

  const logo = isHttpsUrl(group.logo_url)
    ? `<img class="logo" src="${escapeHtml(group.logo_url)}" alt="" referrerpolicy="no-referrer">`
    : "";
  const tagline = group.tagline ? `<p class="tagline">${escapeHtml(group.tagline)}</p>` : "";

  const nameLength = [...group.name].length;
  const nameClass = nameLength > 22 ? "name name-long" : nameLength > 12 ? "name name-mid" : "name";

  const actions = buttons
    ? `<p class="lead">Выберите заведение, где хотите оставить отзыв.</p>
       <div class="stars" role="img" aria-label="Пять звёзд">${STAR.repeat(5)}</div>
       <div class="buttons">${buttons}</div>`
    : `<p class="lead">Список заведений скоро появится.</p>`;

  return renderPage({
    status: 200,
    title: `Отзыв — ${group.name}`,
    accent: DEFAULT_ACCENT,
    body: `
      ${logo}
      <h1 class="${nameClass}">${escapeHtml(group.name)}</h1>
      ${tagline}
      <div class="divider"></div>
      <h2 class="thanks">Спасибо, что вы с нами!</h2>
      ${actions}`
  });
}

function errorPage() {
  return renderPage({
    status: 500,
    title: "Не удалось загрузить",
    accent: DEFAULT_ACCENT,
    body: `
      <h2 class="thanks">Не удалось загрузить страницу</h2>
      <p class="lead">Попробуйте обновить страницу через минуту.</p>`
  });
}

// Возвращает { business } или { response } с готовой страницей ошибки
async function loadBusiness(env, slug) {
  if (!SLUG_RE.test(slug)) {
    return { response: notFoundPage() };
  }

  try {
    const rows = await db(
      env,
      `businesses?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true` +
        `&select=${BUSINESS_COLUMNS}&limit=1`
    );
    return rows.length ? { business: rows[0] } : { response: notFoundPage() };
  } catch (error) {
    console.error(`Ошибка загрузки бизнеса: ${error.message}\n${error.stack}`);
    return { response: errorPage() };
  }
}

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer"
    }
  });
}

function businessPage(business, source, cardCode = null) {
  const accent = COLOR_RE.test(business.brand_color || "")
    ? business.brand_color
    : DEFAULT_ACCENT;

  // Источник (NFC / QR) и код карты передаём дальше, чтобы клик тоже знал,
  // откуда пришёл посетитель
  const params = new URLSearchParams();
  if (source !== "direct") params.set("s", source);
  if (cardCode) params.set("c", cardCode);
  const query = params.toString();
  const sourceQuery = query ? `?${query.replace(/&/g, "&amp;")}` : "";

  const buttons = PLATFORMS
    .filter((p) => isHttpsUrl(business[p.field]))
    .map(
      (p) => `
        <a class="button button-${p.key}" href="/go/${escapeHtml(business.slug)}/${p.key}${sourceQuery}" rel="nofollow">
          <span class="icon">${ICONS[p.key]}</span>
          <span class="label">Оставить отзыв<br>${p.label}</span>
          ${ARROW}
        </a>`
    )
    .join("");

  const logo = isHttpsUrl(business.logo_url)
    ? `<img class="logo" src="${escapeHtml(business.logo_url)}" alt="" referrerpolicy="no-referrer">`
    : "";

  const taglineText = business.tagline || CATEGORY_TAGLINES[business.category] || "";
  const tagline = taglineText ? `<p class="tagline">${escapeHtml(taglineText)}</p>` : "";

  // Длинные названия делаем мельче, чтобы помещались на экран телефона
  const nameLength = [...business.name].length;
  const nameClass = nameLength > 22 ? "name name-long" : nameLength > 12 ? "name name-mid" : "name";

  const actions = buttons
    ? `<p class="lead">Пожалуйста, поделитесь впечатлением о&nbsp;нашем заведении.</p>
       <div class="stars" role="img" aria-label="Пять звёзд">${STAR.repeat(5)}</div>
       <div class="buttons">${buttons}</div>`
    : `<p class="lead">Ссылки для отзывов скоро появятся.</p>`;

  // Кнопка «Получить скидку»: раскрывает кодовое слово программы лояльности.
  // Работает без JavaScript (<details>), поэтому на странице по-прежнему нет скриптов.
  const discountCode = (business.discount_code || "").trim();
  const discount = discountCode
    ? `<details class="discount">
         <summary class="button discount-button">
           <span class="icon discount-icon">${GIFT}</span>
           <span class="label">Получить скидку</span>
           <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
         </summary>
         <div class="discount-panel">
           ${business.discount_text ? `<p class="discount-text">${escapeHtml(business.discount_text)}</p>` : ""}
           <p class="discount-hint">Назовите или покажите кодовое слово:</p>
           <p class="discount-code">${escapeHtml(discountCode)}</p>
         </div>
       </details>`
    : "";

  return renderPage({
    status: 200,
    title: `Отзыв — ${business.name}`,
    accent,
    body: `
      ${logo}
      <h1 class="${nameClass}">${escapeHtml(business.name)}</h1>
      ${tagline}
      <div class="divider"></div>
      <h2 class="thanks">Спасибо за ваш визит!</h2>
      ${actions}
      ${discount}`
  });
}

function notFoundPage() {
  return renderPage({
    status: 404,
    title: "Страница не найдена",
    accent: DEFAULT_ACCENT,
    body: `
      <h2 class="thanks">Страница не найдена</h2>
      <p class="lead">Проверьте ссылку или отсканируйте карту ещё раз.</p>`
  });
}

function renderPage({ status, title, accent, body }) {
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="theme-color" content="#f4f6fa">
  <title>${escapeHtml(title)}</title>
  <link rel="preload" href="/fonts/playfair-display-600-cyrillic.woff2" as="font" type="font/woff2" crossorigin>
  <style>
    /* Фирменный шрифт названия (Playfair Display, лицензия OFL — fonts/OFL.txt).
       Лежит на нашем сайте; браузер скачивает только нужную часть: кириллицу и/или латиницу */
    @font-face {
      font-family: "Playfair Display";
      font-weight: 600;
      font-display: swap;
      src: url(/fonts/playfair-display-600-cyrillic.woff2) format("woff2");
      unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
    }
    @font-face {
      font-family: "Playfair Display";
      font-weight: 600;
      font-display: swap;
      src: url(/fonts/playfair-display-600-latin.woff2) format("woff2");
      unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
    }
    :root {
      --accent: ${accent};
      --text: #141a2b;
      --muted: #6b7280;
      --bg: #f4f6fa;
      --serif: "Playfair Display", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Noto Serif", "Times New Roman", serif;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 28px 16px;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      overflow-x: hidden;
      position: relative;
    }
    /* Мягкие круги на фоне */
    body::before, body::after {
      content: "";
      position: fixed;
      border-radius: 50%;
      background: linear-gradient(135deg, #e8ecf5, #eef1f7);
      z-index: 0;
      pointer-events: none;
    }
    body::before { width: 520px; height: 520px; top: -300px; left: -260px; }
    body::after { width: 620px; height: 620px; bottom: -380px; right: -300px; }

    .card {
      position: relative;
      z-index: 1;
      width: 100%;
      max-width: 440px;
      background: #fff;
      border-radius: 22px;
      padding: 32px 26px 28px;
      text-align: center;
      box-shadow: 0 1px 2px rgba(20, 26, 43, 0.04), 0 12px 40px rgba(20, 26, 43, 0.08);
    }
    .logo {
      display: block;
      max-width: 140px;
      max-height: 72px;
      margin: 0 auto 14px;
      object-fit: contain;
    }
    .name {
      margin: 0;
      font-family: var(--serif);
      font-weight: 600;
      font-size: 46px;
      line-height: 1.1;
      letter-spacing: -0.01em;
      overflow-wrap: anywhere;
    }
    .name-mid { font-size: 32px; }
    .name-long { font-size: 26px; }
    .tagline {
      margin: 10px 0 0;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.32em;
      text-transform: uppercase;
      color: var(--muted);
      /* letter-spacing добавляет отступ справа — компенсируем, чтобы текст стоял по центру */
      padding-left: 0.32em;
    }
    .divider {
      width: 44px;
      height: 2px;
      margin: 18px auto 22px;
      border-radius: 2px;
      background: var(--accent);
      opacity: 0.8;
    }
    .thanks {
      margin: 0 0 8px;
      font-size: 24px;
      font-weight: 400;
      line-height: 1.25;
    }
    .lead {
      margin: 0 auto;
      max-width: 320px;
      font-size: 16px;
      line-height: 1.5;
      color: var(--muted);
    }
    .stars {
      display: flex;
      justify-content: center;
      gap: 6px;
      margin: 16px 0 22px;
    }
    .stars svg { width: 30px; height: 30px; fill: #f0b43c; }

    .buttons { display: flex; flex-direction: column; gap: 14px; }
    .button {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 14px 20px 14px 16px;
      border-radius: 999px;
      border: 1px solid;
      color: var(--text);
      text-decoration: none;
      text-align: left;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
      -webkit-tap-highlight-color: transparent;
    }
    .button:hover { box-shadow: 0 6px 18px rgba(20, 26, 43, 0.08); }
    .button:active { transform: scale(0.98); }
    .button:focus-visible { outline: 2px solid var(--text); outline-offset: 3px; }
    .button-yandex { background: #fff3f2; border-color: #fbd9d5; }
    .button-google { background: #f2f6fe; border-color: #d9e4fb; }
    .button-twogis { background: #f2f9ef; border-color: #d8eccf; }
    .icon { flex: none; width: 40px; height: 40px; }
    .icon svg { display: block; width: 100%; height: 100%; }
    .label { flex: 1; font-size: 16px; line-height: 1.35; }
    .arrow { flex: none; width: 22px; height: 22px; color: #3a4152; }

    /* Страница шаблонной карты, которая ещё не привязана */
    .card-mark {
      display: grid;
      place-items: center;
      width: 64px;
      height: 64px;
      margin: 0 auto 18px;
      border-radius: 50%;
      background: #0a2a5c;
      color: #fff;
      font-weight: 700;
      font-size: 22px;
      letter-spacing: 0.02em;
      box-shadow: 0 0 0 4px #fff, 0 0 0 5px #e5aa0c;
    }
    .card-code {
      margin: 18px 0 0;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 14px;
      letter-spacing: 0.06em;
      color: var(--muted);
    }
    .owner-link {
      display: inline-block;
      margin-top: 14px;
      font-size: 14px;
      color: #0a2a5c;
      text-underline-offset: 3px;
    }

    /* «Получить скидку» */
    .discount { margin-top: 14px; }
    .discount-button {
      list-style: none;
      cursor: pointer;
      background: #fff8e8;
      border-color: #f3dfa9;
    }
    .discount-button::-webkit-details-marker { display: none; }
    .discount-button .label { font-weight: 600; }
    .chevron { flex: none; width: 22px; height: 22px; color: #3a4152; transition: transform 0.2s ease; }
    .discount[open] .chevron { transform: rotate(180deg); }
    .discount-panel {
      margin-top: 10px;
      padding: 16px 18px 18px;
      border: 1px dashed #e2c46e;
      border-radius: 16px;
      background: #fffdf6;
    }
    .discount-text { margin: 0 0 10px; font-size: 16px; font-weight: 600; line-height: 1.35; }
    .discount-hint { margin: 0; font-size: 14px; color: var(--muted); }
    .discount-code {
      margin: 6px 0 0;
      font-size: 28px;
      font-weight: 700;
      letter-spacing: 0.08em;
      overflow-wrap: anywhere;
      user-select: all;
    }

    /* Кнопки заведений на странице группы /g/... */
    .venue { background: #fff; border-color: #e1e5ee; padding: 10px 20px 10px 10px; }
    .venue:hover { border-color: #cdd3e0; }
    .venue-mark {
      flex: none;
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: #f4f6fa;
      border: 1px solid var(--accent);
      font-family: var(--serif);
      font-weight: 600;
      font-size: 20px;
      color: var(--text);
    }
    .venue-name { display: block; font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
    .venue-sub { display: block; margin-top: 2px; font-size: 13px; color: var(--muted); }

    .footer {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 22px;
      padding: 7px 14px 7px 12px;
      border: 1px solid #dfe3ec;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.7);
      font-size: 14px;
      color: #5d6475;
      text-decoration: none;
      -webkit-tap-highlight-color: transparent;
      transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
    }
    .footer svg { width: 18px; height: 18px; }
    .footer .ext { width: 13px; height: 13px; opacity: 0.75; }
    .footer-text { text-decoration: underline; text-decoration-color: #c4c9d6; text-underline-offset: 3px; }
    .footer:hover, .footer:focus-visible { color: #1f2433; border-color: #c4c9d6; background: #fff; }
    .footer:focus-visible { outline: 2px solid #9aa3b8; outline-offset: 2px; }

    @media (max-width: 360px) {
      .card { padding: 26px 18px 22px; }
      .name { font-size: 38px; }
      .name-mid { font-size: 28px; }
      .name-long { font-size: 23px; }
      .tagline { letter-spacing: 0.22em; padding-left: 0.22em; }
      .button { gap: 12px; padding: 12px 16px 12px 12px; }
      .label { font-size: 15px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .button, .chevron { transition: none; }
      .footer { transition: none; }
    }
  </style>
</head>
<body>
  <main class="card">
    ${body}
  </main>
  <a class="footer" href="${TELEGRAM_URL}" target="_blank" rel="noopener">${HEART}<span class="footer-text">TapReview</span>${EXTERNAL}</a>
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
        "default-src 'none'; img-src https:; font-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
