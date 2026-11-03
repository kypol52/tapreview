// Публичная страница бизнеса /b/:slug, шаблонная карта /c/:code,
// страница группы заведений /g/:slug и переходы на площадки /go/:slug/:platform.
// Страница собирается на сервере: посетитель получает готовый HTML за один запрос,
// ключи не попадают в браузер.
// Кнопки ведут не прямо на Google/Яндекс/2ГИС, а через /go/... — так мы считаем клики,
// после чего сразу перенаправляем посетителя на нужную площадку.

import { db } from "./supabase.js";
import { logEvent, sourceFrom, isBot } from "./analytics.js";
import { guestOf, vipOn } from "./guests.js";
import { has } from "./tariffs.js";
import { isExpired } from "./billing.js";
import { bonusBlock } from "./bonus.js";
import { flowFrom, logRating, LIKES, PHONE_KEEP_DAYS } from "./rating.js";
import { makeCardTicket } from "./app-auth.js";

const SLUG_RE = /^[A-Za-z0-9_-]{3,64}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
// Тёплый золотисто-бежевый — черта под названием, если свой цвет не задан
export const DEFAULT_ACCENT = "#c9a27e";

// Подпись под названием, если в админке её не заполнили
const CATEGORY_TAGLINES = {
  restaurant: "Ресторан",
  beauty: "Салон красоты",
  barber: "Барбершоп",
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

export const GIFT = `<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="20" fill="#f0b43c"/><g fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"><rect x="11" y="17" width="18" height="12" rx="1.5"/><path d="M10 13.5h20v3.5H10zM20 13.5V29"/><path d="M20 13.5c-1.5-3.5-6-4-6-1.2 0 1.5 2.5 1.2 6 1.2zM20 13.5c1.5-3.5 6-4 6-1.2 0 1.5-2.5 1.2-6 1.2z" stroke-linecap="round"/></g></svg>`;

// Настройки бонуса для гостей (bonus.js, миграции 015, 023)
export const BONUS_COLUMNS =
  "bonus_mode,bonus_prizes,bonus_from_days,bonus_valid_days,bonus_cooldown_days,bonus_conditions,bonus_daily_limit," +
  "stamps_goal,stamps_prize,friend_gift,friend_reward,vip_visits,vip_gift,tariff";

const BUSINESS_COLUMNS =
  "id,slug,name,tagline,category,logo_url,brand_color,google_url,yandex_url,twogis_url," +
  "discount_code,discount_text,paid_until,theme,design,extra_links,rating_first,moment," +
  "catalog_visible,app_button," + BONUS_COLUMNS;

// Ссылки заведения под кнопками отзывов (миграция 020): меню, каталог, услуги…
// Значки — тонкие линии в цвете текста темы, чтобы не спорить с логотипами площадок
const LINK_ICON = (d) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const EXTRA_LINKS = {
  menu: { label: "Меню", icon: LINK_ICON("M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 21V3c-2.2 1.2-3.5 3.6-3.5 6.5V13H17") },
  catalog: { label: "Каталог", icon: LINK_ICON("M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z") },
  services: { label: "Услуги и цены", icon: LINK_ICON("M3 12.5V4h8.5L21 13.5 13.5 21zM7.5 8h.01") },
  booking: { label: "Онлайн-запись", icon: LINK_ICON("M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M8 14h3") },
  delivery: { label: "Доставка", icon: LINK_ICON("M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2") },
  site: { label: "Наш сайт", icon: LINK_ICON("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z") },
  // Деньги идут напрямую заведению / официанту через их сервис (чаевые, СБП банка) — мы только даём кнопку
  tips: { label: "Оставить чаевые", icon: LINK_ICON("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM10.5 7.5h2.6a2.3 2.3 0 0 1 0 4.6h-2.6zM10.5 7.5v9M9 14.3h4.5") },
  pay: { label: "Оплатить счёт", icon: LINK_ICON("M3 7h18v11H3zM3 11h18M7 15h3") },
  custom: { label: "Ссылка", icon: LINK_ICON("M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1") }
};

// «Сейчас у нас» (миграция 025): новость, событие или акция заведения — в даты показа (МСК, включительно)
function momentBlock(business, now = Date.now()) {
  if (!has(business, "moment")) return "";
  const m = business.moment;
  if (!m || (!m.title && !m.text)) return "";
  const today = new Date(now + 3 * 3600 * 1000).toISOString().slice(0, 10);
  if ((m.from && today < m.from) || (m.to && today > m.to)) return "";
  const photo = m.photo && /^[0-9a-f-]{36}$/.test(m.photo)
    ? `<img class="moment-photo" src="/m/${m.photo}" alt="" loading="lazy">`
    : "";
  const button = m.url && isHttpsUrl(m.url)
    ? `<a class="moment-link" href="${escapeHtml(m.url)}" target="_blank" rel="noopener nofollow">${escapeHtml(m.button || "Подробнее")} →</a>`
    : "";
  return `
    <section class="moment">
      ${photo}
      <div class="moment-body">
        <p class="moment-kicker">Сейчас у нас</p>
        ${m.title ? `<h3 class="moment-title">${escapeHtml(m.title)}</h3>` : ""}
        ${m.text ? `<p class="moment-text">${escapeHtml(m.text)}</p>` : ""}
        ${button}
      </div>
    </section>`;
}

function extraLinksBlock(business, top = false) {
  if (!has(business, "links")) return "";
  const links = (Array.isArray(business.extra_links) ? business.extra_links : []).filter((l) => l && isHttpsUrl(l.url));
  if (!links.length) return "";
  const items = links
    .map((l) => {
      const kind = EXTRA_LINKS[l.type] || EXTRA_LINKS.custom;
      return `
        <a class="xlink" href="${escapeHtml(l.url)}" target="_blank" rel="noopener nofollow">
          <span class="xlink-icon">${kind.icon}</span>
          <span class="xlink-label">${escapeHtml(l.label || kind.label)}</span>
        </a>`;
    })
    .join("");
  return `
    <div class="xlinks${top ? " xlinks-top" : ""}">
      ${top ? "" : `<p class="xlinks-title">Ещё у нас</p>`}
      <div class="xlinks-grid${links.length === 1 ? " xlinks-one" : ""}">${items}</div>
    </div>`;
}

export const TELEGRAM_URL ="https://t.me/tapreviewru";

export async function handleBusinessPage(request, env, ctx, slug) {
  const result = await loadBusiness(env, slug);
  if (result.response) return result.response;

  const business = result.business;
  const url = new URL(request.url);
  const source = sourceFrom(url);
  const flow = flowFrom(url);

  ctx.waitUntil(
    logEvent(request, env, { businessId: business.id, eventType: "page_view", source })
  );
  if (business.rating_first && has(business, "rating") && flow.score && !flow.sent && !flow.all) {
    ctx.waitUntil(logRating(request, env, { businessId: business.id, score: flow.score, source, likes: flow.likes }));
  }

  if (isExpired(business.paid_until)) return pausedResponse(business);
  const guest = isBot(request) ? null : await guestOf(request, env, business, source);
  return withGuestCookie(businessPage(business, source, null, flow, guest), guest);
}

// Cookie устройства ставим при первом касании карты (guests.js): «С возвращением!» и штампы
function withGuestCookie(response, guest) {
  if (guest && guest.setCookie) response.headers.append("Set-Cookie", guest.setCookie);
  return response;
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

  const url = new URL(request.url);
  const source = sourceFrom(url);
  const flow = flowFrom(url);
  ctx.waitUntil(
    logEvent(request, env, {
      businessId: business.id,
      eventType: "page_view",
      source,
      cardId: card.id
    })
  );
  if (business.rating_first && has(business, "rating") && flow.score && !flow.sent && !flow.all) {
    ctx.waitUntil(logRating(request, env, { businessId: business.id, cardId: card.id, score: flow.score, source, likes: flow.likes }));
  }

  if (isExpired(business.paid_until)) return pausedResponse(business);
  const guest = isBot(request) ? null : await guestOf(request, env, business, source);
  const appLink = await appLinkFor(env, business, card.code);
  return withGuestCookie(businessPage(business, source, card.code, flow, guest, appLink), guest);
}

// Кнопка «Отзыв в Telegram» (миграция 035): галочка в админке + заведение в каталоге + бот настроен.
// Ссылка несёт подписанный билет карты — отзыв в Mini App получит метку «по карте TapReview».
async function appLinkFor(env, business, cardCode) {
  if (!business.app_button || !business.catalog_visible || !env.APP_BOT_USERNAME || !env.APP_SHORT_NAME) return null;
  try {
    const ticket = await makeCardTicket(env, cardCode);
    return `https://t.me/${env.APP_BOT_USERNAME}/${env.APP_SHORT_NAME}?startapp=${ticket}`;
  } catch (error) {
    console.error(`Билет карты: ${error.message}`);
    return null;
  }
}

// Одинаково при любой оценке и на любом шаге — чтобы рейтинг в каталоге оставался честным
function appBlock(appLink) {
  if (!appLink) return "";
  return `
      <a class="app-btn" href="${escapeHtml(appLink)}" rel="nofollow">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 4.5 2.9 11.4c-1 .4-1 1.7 0 2l4.5 1.5 1.7 5.3c.2.7 1.1.9 1.6.3l2.5-2.6 4.6 3.4c.6.4 1.4.1 1.6-.6L22.4 5.9c.2-.9-.6-1.7-1.4-1.4zM9.6 14.4l8.3-6.6-6.6 7.7-.3 3.2z" fill="currentColor"/></svg>
        <span class="app-btn-copy"><span class="app-btn-big">Отзыв в Telegram</span><span class="app-btn-small">Его увидят другие гости в каталоге TapReview</span></span>
      </a>`;
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

function businessPage(business, source, cardCode = null, flow = { score: null, all: false, sent: false }, guest = null, appLink = null) {
  // Свой фирменный цвет заведения, иначе — цвет черты выбранной темы
  const accent = COLOR_RE.test(business.brand_color || "") ? business.brand_color : null;

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

  const design = customDesign(business);
  const logo = design && design.logo
    ? `<img class="logo logo-custom" src="/m/${design.logo}" alt="${escapeHtml(business.name)}">`
    : isHttpsUrl(business.logo_url)
      ? `<img class="logo" src="${escapeHtml(business.logo_url)}" alt="" referrerpolicy="no-referrer">`
      : "";

  const taglineText = business.tagline || CATEGORY_TAGLINES[business.category] || "";
  // «С возвращением!» — со второго дня визитов (guests.js); визиты считаются только при касании карты или QR
  // VIP-уровни (миграция 032): VIP — свой значок, остальным — сколько визитов до VIP
  let welcome = "";
  if (guest && guest.visits >= 2 && has(business, "guests")) {
    const vip = vipOn(business) ? business.vip_visits : null;
    if (vip && guest.visits >= vip) {
      welcome = `<p class="welcome welcome-vip">⭐ VIP-гость · вы у нас ${guest.visits}-й раз</p>`;
    } else {
      const left = vip ? vip - guest.visits : 0;
      welcome = `<p class="welcome">С возвращением! Вы у нас ${guest.visits}-й раз 👋</p>` +
        (left ? `<p class="welcome-next">Ещё ${left} ${plural(left, "визит", "визита", "визитов")} — и вы VIP-гость</p>` : "");
    }
  }
  // «Мои штампы и подарки — в Telegram»: связать этот телефон с Telegram гостя (guest-wallet.js, /me-link)
  const wallet = guest && guest.walletLink
    ? `<a class="wallet-link" href="/me-link" rel="nofollow">🎁 Мои штампы и подарки — в Telegram</a>`
    : "";
  const tagline = (taglineText ? `<p class="tagline">${escapeHtml(taglineText)}</p>` : "") + welcome + wallet;

  // Длинные названия делаем мельче, чтобы помещались на экран телефона.
  // Логотип «Своего дизайна» заменяет название — тогда название остаётся только для экранного диктора.
  const nameLength = [...business.name].length;
  const nameClass = (nameLength > 22 ? "name name-long" : nameLength > 12 ? "name name-mid" : "name") +
    (design && design.logo ? " sr-only" : "");

  // Подарок для гостей (bonus.js): только при скане карты, появляется через несколько секунд,
  // не зависит от отзыва. Без JavaScript — обычная форма.
  // Подарки — только в тарифе «Плюс» (tariffs.js)
  const discount = !has(business, "gifts") ? "" : bonusBlock(business, source, cardCode, guest ? guest.stamps : null, guest ? guest.rewards : 0, guest ? guest.visits : 0);

  if (business.rating_first && has(business, "rating")) {
    return ratingFlowPage(business, { source, cardCode, flow, buttons, accent, logo, nameClass, tagline, discount, design, appLink });
  }

  const actions = buttons
    ? `<p class="lead">Пожалуйста, поделитесь впечатлением о&nbsp;нашем заведении.</p>
       <div class="stars" role="img" aria-label="Пять звёзд">${STAR.repeat(5)}</div>
       <div class="buttons">${buttons}</div>`
    : `<p class="lead">Ссылки для отзывов скоро появятся.</p>`;

  return renderPage({
    status: 200,
    title: `Отзыв — ${business.name}`,
    accent,
    theme: business.theme,
    design,
    // «Карта как реклама»: гость-владелец бизнеса переходит на наш сайт, а заведение получает рекомендацию
    footer: { href: `/r/${business.slug}?s=card`, text: "Хочу такую карту" },
    body: `
      ${logo}
      <h1 class="${nameClass}">${escapeHtml(business.name)}</h1>
      ${tagline}
      <div class="divider"></div>
      <h2 class="thanks">Спасибо за ваш визит!</h2>
      ${actions}
      ${appBlock(appLink)}
      ${momentBlock(business)}
      ${extraLinksBlock(business)}
      ${discount}`
  });
}

// Сначала оценка (rating.js): карточка заведения → «Как вам у нас?» → площадки (4–5) или сообщение владельцу (1–3).
// Площадки доступны при любой оценке, подарок — после любой оценки.
function ratingFlowPage(business, { source, cardCode, flow, buttons, accent, logo, nameClass, tagline, discount, design, appLink }) {
  const base = new URLSearchParams();
  if (source !== "direct") base.set("s", source);
  const link = (extra) => {
    const p = new URLSearchParams(base);
    for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
    return escapeHtml(`?${p}`);
  };
  const { score, all, sent } = flow;
  const chosen = score
    ? `<div class="stars stars-chosen" role="img" aria-label="Ваша оценка: ${score} из 5">${STAR.repeat(score)}<span class="stars-off">${STAR.repeat(5 - score)}</span></div>`
    : "";
  const platforms = buttons ? `<div class="buttons">${buttons}</div>` : `<p class="lead">Ссылки для отзывов скоро появятся.</p>`;
  const publicLink = (text) =>
    buttons ? `<a class="rate-public" href="${link({ v: "all", ...(score ? { r: score } : {}) })}">${text}</a>` : "";

  let step;
  if (!score && !all) {
    // 1. Вопрос: пять звёзд-ссылок (подсветка при наведении — на CSS)
    const stars = [5, 4, 3, 2, 1]
      .map((n) => `<a class="rate-star" href="${link({ r: n })}" rel="nofollow" aria-label="Оценка ${n} из 5">${STAR}</a>`)
      .join("");
    step = `
      <h2 class="thanks">Как вам у нас?</h2>
      <p class="lead">Оцените визит — это одно касание.</p>
      <div class="rate" role="group" aria-label="Оценка от 1 до 5">${stars}</div>
      <div class="rate-scale"><span>Плохо</span><span>Отлично</span></div>
      ${publicLink("Сразу оставить отзыв на картах →")}`;
  } else if (all || score >= 4) {
    // 2а. Довольный гость (или сам выбрал «сразу на картах») — площадки.
    // Под ними — необязательное «Что понравилось?»: каждое касание — ссылка, которая включает/выключает пункт (?l=…)
    let likes = "";
    if (score >= 4) {
      const chips = LIKES.map(({ key, label }) => {
        const on = flow.likes.includes(key);
        const next = on ? flow.likes.filter((k) => k !== key) : [...flow.likes, key];
        const href = `${link({ r: score, ...(next.length ? { l: next.join(",") } : {}) })}#like`;
        return `<a class="like${on ? " like-on" : ""}" href="${href}" rel="nofollow"${on ? ' aria-pressed="true"' : ""}>${on ? "✓ " : ""}${label}</a>`;
      }).join("");
      likes = `
      <div class="likes" id="like">
        <p class="likes-q">${flow.likes.length ? "Спасибо! Передадим команде 💛" : "Что понравилось больше всего?"}</p>
        <div class="likes-row">${chips}</div>
      </div>`;
    }
    step = `
      <h2 class="thanks">${score >= 4 ? "Спасибо за высокую оценку!" : "Спасибо за ваш визит!"}</h2>
      ${chosen}
      <p class="lead">Поделитесь впечатлением — это очень поможет нам.</p>
      ${platforms}
      ${likes}`;
  } else if (sent) {
    // 2б. Сообщение отправлено
    step = `
      <h2 class="thanks">Спасибо, что рассказали</h2>
      ${chosen}
      <p class="lead">Владелец уже получил ваше сообщение и разберётся. Будем рады видеть вас снова.</p>
      ${flow.phoneLost ? `<p class="fb-warn">Номер не похож на российский, поэтому мы его не сохранили. Сообщение владелец получил.</p>` : ""}
      ${publicLink("Оставить отзыв на картах")}`;
  } else {
    // 2в. Оценка 1–3 — сообщение владельцу
    step = `
      <h2 class="thanks">Нам жаль, что что-то пошло не так</h2>
      ${chosen}
      <p class="lead">Расскажите, что случилось, — владелец получит сообщение сразу и разберётся.</p>
      <form class="fb" method="post" action="/feedback">
        <input type="hidden" name="b" value="${escapeHtml(business.slug)}">
        ${cardCode ? `<input type="hidden" name="c" value="${escapeHtml(cardCode)}">` : ""}
        ${source !== "direct" ? `<input type="hidden" name="s" value="${escapeHtml(source)}">` : ""}
        <input type="hidden" name="r" value="${score}">
        <input class="fb-trap" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
        <textarea name="text" rows="4" maxlength="1000" required placeholder="Например: долго ждали заказ, остыл кофе…" aria-label="Ваше сообщение"></textarea>
        <input class="fb-call-box" type="checkbox" name="call" value="1" id="fb-call">
        <label class="fb-call" for="fb-call">Перезвоните мне</label>
        <div class="fb-phone">
          <input type="tel" name="phone" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="+7 900 000-00-00" aria-label="Ваш телефон">
          <p class="fb-consent">Отмечая «Перезвоните мне» и указывая номер, вы соглашаетесь, что ${escapeHtml(business.name)} позвонит вам по этому сообщению.
            Номер видит только владелец, он не уходит в рекламу и удаляется через ${PHONE_KEEP_DAYS} дней. <a href="/privacy/#guests" target="_blank" rel="noopener">Подробнее</a></p>
        </div>
        <p class="fb-hint">Без отметки сообщение анонимное — имя и телефон в тексте не пишите.</p>
        <button class="fb-send" type="submit">Отправить владельцу</button>
      </form>
      ${publicLink("Оставить отзыв на картах")}`;
  }

  return renderPage({
    status: 200,
    title: `Отзыв — ${business.name}`,
    accent,
    theme: business.theme,
    design,
    // Оценка 1–3: подарок появляется позже (22 с), чтобы гость сначала спокойно написал владельцу
    extraCss: score && score <= 3 ? ".bonus { animation-delay: 22s; }" : "",
    footer: { href: `/r/${business.slug}?s=card`, text: "Хочу такую карту" },
    body: `
      ${logo}
      <h1 class="${nameClass}">${escapeHtml(business.name)}</h1>
      ${tagline}
      <div class="divider"></div>
      ${step}
      ${appBlock(appLink)}
      ${all || sent || score >= 4 ? momentBlock(business) : ""}
      ${extraLinksBlock(business)}
      ${score || all ? discount : ""}`
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

// Оформление страницы отзывов: выбирается в админке одним кликом (businesses.theme, миграция 018).
// accent — цвет черты под названием по умолчанию (если у заведения не задан свой brand_color).
// Кнопки площадок — в цветах темы (btn*): спокойный фон и тонкая рамка, узнаваемость дают логотипы.
export const THEMES = {
  classic: { label: "Классика", bg: "#f4f6fa", blob1: "#e8ecf5", blob2: "#eef1f7", card: "#ffffff", text: "#141a2b", muted: "#6b7280", accent: "#c9a27e", cta1: "#22a06b", cta2: "#137a4d", shadow: "rgba(20, 26, 43, 0.08)", btn: "#f5f7fb", btnBorder: "#e3e7ef", btnText: "#141a2b", gift: "#fff8e8", giftBorder: "#f3dfa9" },
  dark: { label: "Тёмная", bg: "#0e131d", blob1: "#161d2b", blob2: "#1b2335", card: "#171e2c", text: "#f1f3f8", muted: "#9aa4b6", accent: "#e5aa0c", cta1: "#22a06b", cta2: "#137a4d", shadow: "rgba(0, 0, 0, 0.35)", btn: "rgba(255, 255, 255, 0.06)", btnBorder: "rgba(255, 255, 255, 0.12)", btnText: "#f1f3f8", gift: "rgba(229, 170, 12, 0.12)", giftBorder: "rgba(229, 170, 12, 0.38)" },
  coffee: { label: "Кофейня", bg: "#f3ebe1", blob1: "#eadfce", blob2: "#efe6da", card: "#fffaf4", text: "#2a1f17", muted: "#7a6a5c", accent: "#a9744a", cta1: "#3c9461", cta2: "#28704a", shadow: "rgba(60, 40, 20, 0.10)", btn: "#f7efe5", btnBorder: "#eadcc9", btnText: "#2a1f17", gift: "#fbf0d9", giftBorder: "#ead29b" },
  fresh: { label: "Свежая", bg: "#edf6f0", blob1: "#dcefe3", blob2: "#e6f3ea", card: "#ffffff", text: "#13261b", muted: "#5f7466", accent: "#2f9e5b", cta1: "#16a34a", cta2: "#0f7a37", shadow: "rgba(15, 60, 35, 0.10)", btn: "#f2f8f4", btnBorder: "#d9ebe0", btnText: "#13261b", gift: "#fff8e8", giftBorder: "#f3dfa9" },
  rose: { label: "Бьюти", bg: "#f8eef1", blob1: "#f1dde4", blob2: "#f5e6eb", card: "#ffffff", text: "#2a1720", muted: "#80646f", accent: "#c2577a", cta1: "#22a06b", cta2: "#137a4d", shadow: "rgba(90, 30, 50, 0.10)", btn: "#fbf2f5", btnBorder: "#f0dbe3", btnText: "#2a1720", gift: "#fff6ea", giftBorder: "#f1dcb0" },
  // «Свой дизайн»: тёмное стекло поверх фото заведения (фон, логотип и свечение — designCss)
  custom: { label: "Свой дизайн", bg: "#0d0a08", blob1: "#1a130e", blob2: "#22180f", card: "rgba(18, 13, 10, 0.62)", text: "#f7efe4", muted: "#cdbfae", accent: "#f0a43a", cta1: "#22a06b", cta2: "#137a4d", shadow: "rgba(0, 0, 0, 0.5)", btn: "rgba(20, 14, 10, 0.55)", btnBorder: "rgba(255, 236, 214, 0.18)", btnText: "#f7efe4", gift: "rgba(240, 164, 58, 0.12)", giftBorder: "rgba(240, 164, 58, 0.7)" }
};

// Настройки «Своего дизайна» заведения или null (тема не custom). id картинок проверены (только uuid).
export function customDesign(business) {
  if (!business || business.theme !== "custom") return null;
  const d = business.design && typeof business.design === "object" ? business.design : {};
  const id = (v) => (/^[0-9a-f-]{36}$/.test(String(v || "")) ? String(v) : null);
  const dim = Number(d.dim);
  return { bg: id(d.bg), logo: id(d.logo), dim: Number.isFinite(dim) ? Math.min(85, Math.max(30, dim)) : 60, glow: d.glow !== false };
}

// Фон-фото под тёмной вуалью, стеклянная карточка с тонкой светящейся рамкой,
// неоновое свечение логотипа, кнопки площадок с обводкой в их фирменных цветах.
function designCss(d) {
  const veil = (k) => `rgba(10, 7, 5, ${Math.min(0.95, (d.dim / 100) * k).toFixed(2)})`;
  const photo = d.bg ? `, url(/m/${d.bg}) center / cover no-repeat` : "";
  const glow = (c) => `0 0 0 1px color-mix(in srgb, ${c} 75%, transparent), 0 0 14px color-mix(in srgb, ${c} 35%, transparent), inset 0 0 14px color-mix(in srgb, ${c} 12%, transparent)`;
  return `
    body::before {
      width: auto; height: auto; inset: 0; top: 0; left: 0; right: 0; bottom: 0; border-radius: 0;
      background: linear-gradient(180deg, ${veil(0.85)} 0%, ${veil(1)} 45%, ${veil(1.15)} 100%)${photo};
      background-color: #0d0a08;
    }
    body::after { display: none; }
    .card {
      background: var(--card);
      -webkit-backdrop-filter: blur(6px) saturate(1.15);
      backdrop-filter: blur(6px) saturate(1.15);
      border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
      box-shadow: 0 0 22px color-mix(in srgb, var(--accent) 22%, transparent), 0 24px 60px rgba(0, 0, 0, 0.55);
    }
    .logo-custom { max-width: min(250px, 78%); max-height: 130px; margin-bottom: 6px; }
    ${d.glow ? `.logo-custom { filter: drop-shadow(0 0 1px rgba(255, 244, 228, 0.9)) drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 85%, transparent)) drop-shadow(0 0 18px color-mix(in srgb, var(--accent) 55%, transparent)); }
    .name { text-shadow: 0 0 6px color-mix(in srgb, var(--accent) 70%, transparent), 0 0 20px color-mix(in srgb, var(--accent) 45%, transparent); }` : ""}
    .tagline { color: var(--muted); }
    .divider { box-shadow: 0 0 10px var(--accent); }
    .thanks { font-weight: 700; }
    .rate-star svg { fill: rgba(255, 236, 214, 0.14); stroke: rgba(255, 236, 214, 0.35); }
    .rate-star:hover svg, .rate-star:hover ~ .rate-star svg, .rate-star:focus-visible svg, .rate-star:focus-visible ~ .rate-star svg,
    .stars svg { filter: drop-shadow(0 0 6px rgba(240, 180, 60, 0.65)); }
    .stars-off svg { fill: rgba(255, 236, 214, 0.14); filter: none; }
    .button { border-color: transparent; box-shadow: ${glow("var(--accent)")}; }
    .button-yandex { box-shadow: ${glow("#fc3f1d")}; }
    .button-google { box-shadow: ${glow("#4285f4")}; }
    .button-twogis { box-shadow: ${glow("#2fbf3a")}; }
    .button:hover { border-color: transparent; filter: brightness(1.12); }
    .xlink { background: var(--btn-bg); }
    .xlink:hover { border-color: var(--accent); box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 30%, transparent); }
    .bonus-button { box-shadow: ${glow("var(--accent)")}; }
    .fb textarea, .fb-phone input, .like, .moment { background: rgba(0, 0, 0, 0.35); }
    .moment { border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
    .like-on { background: color-mix(in srgb, var(--accent) 22%, rgba(0, 0, 0, 0.35)); box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 35%, transparent); }
    .footer:not(.footer-cta-btn) { background: rgba(18, 13, 10, 0.6); border-color: rgba(255, 236, 214, 0.2); color: var(--muted); }
  `;
}

// footer — { href, text }: зелёная кнопка внизу («Работает на TapReview / Хочу такую карту»).
// Без footer — скромная подпись «TapReview» со ссылкой на Telegram-канал (служебные страницы).
// theme — ключ из THEMES.
// design — customDesign(business) для темы «Свой дизайн».
// meta — готовые теги для <head> (превью ссылки в Telegram: og:title, og:image… — share-page.js); значения экранирует вызывающий.
// robots — запрет индексации. По умолчанию для всех роботов; share-page.js запрещает только поисковикам,
//   потому что общий noindex отключает и превью ссылки в Telegram.
const ROBOTS_ALL = `<meta name="robots" content="noindex">`;
export const ROBOTS_SEARCH_ONLY = `<meta name="yandex" content="noindex, nofollow">\n  <meta name="googlebot" content="noindex, nofollow">\n  <meta name="bingbot" content="noindex, nofollow">`;
export function renderPage({ status, title, accent, body, extraCss = "", footer = null, theme = "classic", design = null, meta = "", robots = ROBOTS_ALL }) {
  const t = THEMES[theme] || THEMES.classic;
  if (design) extraCss = designCss(design) + extraCss;
  const footerHtml = footer
    ? `<a class="footer footer-cta-btn" href="${escapeHtml(footer.href)}" rel="nofollow">
        <span class="footer-mark" aria-hidden="true">TR</span>
        <span class="footer-copy"><span class="footer-small">Работает на TapReview</span><span class="footer-big">${escapeHtml(footer.text)}</span></span>
        <svg class="footer-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </a>`
    : `<a class="footer" href="${TELEGRAM_URL}" target="_blank" rel="noopener">${HEART}<span class="footer-text">TapReview</span>${EXTERNAL}</a>`;
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${robots}
  <meta name="theme-color" content="${t.bg}">
  <title>${escapeHtml(title)}</title>${meta}
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
      --accent: ${accent || t.accent};
      --text: ${t.text};
      --muted: ${t.muted};
      --bg: ${t.bg};
      --card: ${t.card};
      --blob1: ${t.blob1};
      --blob2: ${t.blob2};
      --cta1: ${t.cta1};
      --cta2: ${t.cta2};
      --card-shadow: ${t.shadow};
      --btn-bg: ${t.btn};
      --btn-border: ${t.btnBorder};
      --btn-text: ${t.btnText};
      --gift-bg: ${t.gift};
      --gift-border: ${t.giftBorder};
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
      background: linear-gradient(135deg, var(--blob1), var(--blob2));
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
      background: var(--card);
      border-radius: 22px;
      padding: 32px 26px 28px;
      text-align: center;
      box-shadow: 0 1px 2px rgba(20, 26, 43, 0.04), 0 12px 40px var(--card-shadow);
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
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
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
      border: 1px solid var(--btn-border);
      background: var(--btn-bg);
      color: var(--btn-text);
      text-decoration: none;
      text-align: left;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
      -webkit-tap-highlight-color: transparent;
    }
    .button:hover { box-shadow: 0 6px 18px var(--card-shadow); border-color: var(--accent); }
    .button:active { transform: scale(0.98); }
    .button:focus-visible { outline: 2px solid var(--text); outline-offset: 3px; }
    .icon { flex: none; width: 40px; height: 40px; }
    .icon svg { display: block; width: 100%; height: 100%; }
    .label { flex: 1; font-size: 16px; line-height: 1.35; }
    .arrow { flex: none; width: 22px; height: 22px; color: var(--muted); }

    /* Сначала оценка: звёзды-ссылки (справа налево — для подсветки «до наведённой» на CSS) */
    .rate { display: flex; flex-direction: row-reverse; justify-content: center; gap: 6px; margin: 18px 0 6px; }
    .rate-star {
      display: grid; place-items: center; width: 52px; height: 52px; border-radius: 14px;
      -webkit-tap-highlight-color: transparent; transition: transform 0.12s ease;
    }
    .rate-star svg { width: 42px; height: 42px; fill: var(--btn-border); stroke: color-mix(in srgb, var(--muted) 35%, transparent); stroke-width: 0.6; transition: fill 0.12s ease; }
    .rate-star:hover svg, .rate-star:hover ~ .rate-star svg, .rate-star:focus-visible svg, .rate-star:focus-visible ~ .rate-star svg { fill: #f0b43c; stroke: transparent; }
    .rate-star:active { transform: scale(0.9); }
    .rate-star:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
    .rate-scale { display: flex; justify-content: space-between; max-width: 290px; margin: 0 auto; color: var(--muted); font-size: 12px; }
    .rate-public { display: inline-block; margin-top: 18px; color: var(--muted); font-size: 14px; text-underline-offset: 3px; }
    .wallet-link {
      display: inline-block; margin: 10px 0 2px; padding: 6px 14px; border-radius: 99px;
      border: 1px solid var(--btn-border); background: var(--btn-bg); color: var(--btn-text);
      font-size: 13px; font-weight: 600; text-decoration: none;
    }
    .wallet-link:hover, .wallet-link:focus-visible { border-color: var(--accent); }
    .app-btn {
      display: flex; align-items: center; gap: 12px; width: 100%; margin-top: 18px; padding: 12px 16px;
      border: 1px solid var(--btn-border); border-radius: 16px; background: var(--btn-bg);
      color: var(--btn-text); text-decoration: none; text-align: left;
    }
    .app-btn svg { flex: none; width: 24px; height: 24px; color: #2aabee; }
    .app-btn-copy { display: flex; flex-direction: column; line-height: 1.25; }
    .app-btn-big { font-size: 15px; font-weight: 700; }
    .app-btn-small { font-size: 12px; color: var(--muted); }
    .app-btn:hover, .app-btn:focus-visible { border-color: var(--accent); }
    .stars-chosen { margin: 6px 0 14px; }
    .stars-chosen svg { width: 24px; height: 24px; }
    .stars-off svg { fill: var(--btn-border); }
    .stars-off { display: contents; }
    /* сообщение владельцу */
    .fb { margin-top: 14px; text-align: left; }
    .fb textarea {
      display: block; width: 100%; min-height: 110px; padding: 12px 14px; border-radius: 14px; resize: vertical;
      border: 1px solid var(--btn-border); background: var(--btn-bg); color: var(--text); font: inherit; font-size: 16px; line-height: 1.4;
    }
    .fb textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
    .fb-hint { margin: 8px 2px 12px; color: var(--muted); font-size: 12.5px; }
    .fb-send {
      display: block; width: 100%; padding: 15px 18px; border: 0; border-radius: 999px; cursor: pointer;
      background: linear-gradient(135deg, var(--cta1), var(--cta2)); color: #fff; font: inherit; font-size: 16px; font-weight: 700;
    }
    .fb-send:active { transform: scale(0.98); }
    .fb-trap { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }
    /* «Перезвоните мне»: поле телефона появляется только после отметки (без скриптов) */
    .fb-call-box { width: 20px; height: 20px; margin: 14px 8px 0 2px; vertical-align: -4px; accent-color: var(--accent); cursor: pointer; }
    .fb-call { font-size: 15px; font-weight: 650; cursor: pointer; }
    .fb-phone { display: none; margin-top: 10px; }
    .fb-call-box:checked ~ .fb-phone { display: block; }
    .fb-phone input {
      display: block; width: 100%; padding: 12px 14px; border-radius: 14px;
      border: 1px solid var(--btn-border); background: var(--btn-bg); color: var(--text); font: inherit; font-size: 16px;
    }
    .fb-phone input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
    .fb-consent { margin: 8px 2px 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .fb-consent a { color: inherit; }
    .fb-warn { margin: 0 0 8px; color: var(--muted); font-size: 13px; }
    /* «С возвращением!» и штампы (guests.js) */
    .welcome { margin: 8px auto 0; padding: 5px 12px; width: fit-content; border-radius: 999px;
      background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--text); font-size: 13.5px; font-weight: 650; }
    .stamps { margin: 0 0 12px; }
    .stamps-row { display: flex; justify-content: center; align-items: center; gap: 7px; }
    .stamp { width: 22px; height: 22px; border-radius: 50%; border: 2px dashed color-mix(in srgb, var(--muted) 55%, transparent); }
    .stamp-on { border: 0; background: radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--accent) 55%, #fff), var(--accent)); box-shadow: 0 2px 6px color-mix(in srgb, var(--accent) 40%, transparent); }
    .stamp-gift { width: 30px; height: 30px; border: 0; opacity: 0.45; }
    .stamp-gift svg { display: block; width: 100%; height: 100%; }
    .stamp-ready { opacity: 1; animation: stamp-pulse 1.6s ease-in-out infinite; }
    @keyframes stamp-pulse { 50% { transform: scale(1.12); } }
    .welcome-vip { background: linear-gradient(135deg, #f6d77a, #e5aa0c); color: #3b2a00; box-shadow: 0 4px 14px rgba(229, 170, 12, 0.35); }
    .welcome-next { margin: 5px 0 0; font-size: 12.5px; color: var(--muted); }
    .bonus-vip { margin: 0 0 8px; font-size: 13.5px; font-weight: 700; color: var(--text); }
    .bonus-friend { margin: 0 0 10px; padding: 10px 12px; border-radius: 12px; background: color-mix(in srgb, var(--accent) 14%, transparent);
      font-size: 13.5px; font-weight: 650; line-height: 1.4; color: var(--text); }
    .stamps-text { margin: 6px 0 0; font-size: 13px; font-weight: 600; color: var(--text); }
    @media (prefers-reduced-motion: reduce) { .stamp-ready { animation: none; } }
    /* «Сейчас у нас» */
    .moment { margin-top: 22px; overflow: hidden; border-radius: 18px; border: 1px solid var(--btn-border); background: var(--btn-bg); text-align: left; }
    .moment-photo { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; }
    .moment-body { padding: 14px 16px 16px; }
    .moment-kicker { margin: 0 0 4px; color: var(--accent); font-size: 11.5px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
    .moment-title { margin: 0 0 4px; color: var(--text); font-size: 18px; line-height: 1.25; }
    .moment-text { margin: 0; color: var(--muted); font-size: 14.5px; line-height: 1.45; white-space: pre-line; overflow-wrap: anywhere; }
    .moment-link { display: inline-block; margin-top: 10px; color: var(--text); font-size: 14.5px; font-weight: 700; text-decoration: none; border-bottom: 2px solid var(--accent); }
    /* «Что понравилось?» после 4–5 */
    .likes { margin-top: 20px; }
    .likes-q { margin: 0 0 10px; color: var(--muted); font-size: 14px; font-weight: 600; }
    .likes-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
    .like {
      padding: 8px 14px; border-radius: 999px; border: 1px solid var(--btn-border); background: var(--btn-bg);
      color: var(--text); font-size: 14px; font-weight: 600; text-decoration: none; -webkit-tap-highlight-color: transparent;
    }
    .like-on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, var(--btn-bg)); }
    .like:active { transform: scale(0.96); }
    /* ссылки заведения вверху — как карточка заведения */
    .xlinks-top { margin: 18px 0 4px; }

    /* Ссылки заведения: меню, каталог, услуги… — компактная сетка под кнопками отзывов */
    .xlinks { margin-top: 26px; }
    .xlinks-title {
      margin: 0 0 10px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .xlinks-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .xlinks-grid.xlinks-one { grid-template-columns: 1fr; }
    .xlink {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 48px;
      padding: 10px 12px;
      border-radius: 14px;
      border: 1px solid var(--btn-border);
      background: var(--btn-bg);
      color: var(--btn-text);
      font-size: 14px;
      font-weight: 600;
      line-height: 1.25;
      text-decoration: none;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
      -webkit-tap-highlight-color: transparent;
    }
    .xlink:hover { box-shadow: 0 6px 18px var(--card-shadow); border-color: var(--accent); }
    .xlink:active { transform: scale(0.98); }
    .xlink:focus-visible { outline: 2px solid var(--text); outline-offset: 3px; }
    .xlink-icon { flex: none; width: 20px; height: 20px; color: var(--accent); }
    .xlink-icon svg { display: block; width: 100%; height: 100%; }
    .xlink-label { min-width: 0; overflow-wrap: anywhere; }
    /* нечётное число ссылок — последняя на всю ширину */
    .xlinks-grid .xlink:last-child:nth-child(odd) { grid-column: 1 / -1; }
    @media (max-width: 380px) {
      .xlink { gap: 6px; padding: 10px 8px; font-size: 13px; }
      .xlink-icon { width: 18px; height: 18px; }
    }

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

    /* Подарок для гостей: появляется через несколько секунд, место под него занято сразу (без скачков) */
    .bonus { margin: 20px 0 0; animation: bonus-in 0.5s ease 10s both; }
    @keyframes bonus-in {
      from { opacity: 0; transform: translateY(8px); visibility: hidden; }
      to { opacity: 1; transform: none; visibility: visible; }
    }
    .bonus-note { margin: 0 0 8px; font-size: 13px; color: var(--muted); }
    .bonus-button {
      width: 100%;
      font: inherit;
      cursor: pointer;
      background: var(--gift-bg);
      border-color: var(--gift-border);
    }
    .bonus-button .label { font-weight: 600; text-align: center; }
    .bonus-button .icon { width: 34px; height: 34px; }

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

    /* Зелёная кнопка «Работает на TapReview / Хочу такую карту» */
    .footer-cta-btn {
      gap: 10px;
      margin-top: 22px;
      padding: 7px 16px 7px 7px;
      border: 0;
      background: linear-gradient(135deg, var(--cta1), var(--cta2));
      color: #fff;
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.25) inset, 0 8px 20px rgba(19, 122, 77, 0.28);
      text-align: left;
    }
    .footer-cta-btn:hover, .footer-cta-btn:focus-visible {
      color: #fff;
      background: linear-gradient(135deg, var(--cta1), var(--cta2));
      filter: brightness(1.06);
    }
    .footer-mark {
      flex: none;
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: #fff;
      color: var(--cta2);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.02em;
    }
    .footer-copy { display: flex; flex-direction: column; line-height: 1.15; }
    .footer-small { font-size: 11px; font-weight: 500; opacity: 0.85; }
    .footer-big { font-size: 15px; font-weight: 700; }
    .footer-arrow { flex: none; width: 18px; height: 18px; margin-left: 2px; }

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
      .button { transition: none; }
      .footer { transition: none; }
      /* Без движения, но с той же паузой */
      .bonus { animation-name: bonus-show; animation-duration: 0.01s; }
      @keyframes bonus-show { from { visibility: hidden; opacity: 0; } to { visibility: visible; opacity: 1; } }
    }
${extraCss}
  </style>
</head>
<body>
  <main class="card">
    ${body}
  </main>
  ${footerHtml}
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
        "default-src 'none'; img-src 'self' https:; font-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    }
  });
}

function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

export function isHttpsUrl(value) {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
