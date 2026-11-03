// /p/:slug — страница «Поделиться» заведением из каталога Mini App.
// Telegram (и другие мессенджеры) по этой ссылке показывает превью: фото заведения, название и рейтинг (Open Graph).
// На самой странице — рейтинг, 3 последних опубликованных отзыва и кнопка «Открыть в Telegram».
// Только заведения с согласием на каталог (catalog_visible); поисковикам закрыта (noindex для yandex/googlebot/bingbot,
// а не общий robots — с ним Telegram не строит превью).
// Без скриптов, тот же вид и та же защита (CSP), что у страницы отзывов.

import { db } from "./supabase.js";
import { renderPage, escapeHtml, customDesign, ROBOTS_SEARCH_ONLY } from "./public-page.js";
import { MEDIA_ID_RE } from "./media.js";

const SLUG_RE = /^[A-Za-z0-9_-]{3,64}$/;
const CATEGORY = { restaurant: "Кафе и рестораны", beauty: "Салон красоты", barber: "Барбершоп", shop: "Магазин" };
const STAR = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6 6.6.8-4.9 4.6 1.3 6.5L12 17.3l-5.9 3.2 1.3-6.5L2.5 9.4l6.6-.8z"/></svg>`;

function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}
const fmt = (v) => v.toFixed(1).replace(".", ",");

export async function handleSharePage(request, env, slug) {
  if (!SLUG_RE.test(slug)) return notFound();
  let b;
  let dist;
  let reviews;
  try {
    const rows = await db(
      env,
      `businesses?slug=eq.${encodeURIComponent(slug)}&is_active=is.true&catalog_visible=is.true` +
        "&select=id,slug,name,tagline,category,city,address,logo_url,photos,theme,design,brand_color&limit=1"
    );
    if (!rows.length) return notFound();
    b = rows[0];
    [dist, reviews] = await Promise.all([
      db(env, "rpc/app_place_rating", { method: "POST", body: { p_business_id: b.id } }),
      db(env, `reviews?business_id=eq.${b.id}&status=eq.published&text=neq.&select=score,text,created_at&order=created_at.desc&limit=3`)
    ]);
  } catch (error) {
    console.error(`Страница «Поделиться» ${slug}: ${error.message}`);
    return renderPage({ status: 500, title: "Ошибка", body: `<h1 class="name">Не удалось загрузить</h1><p class="lead">Попробуйте чуть позже.</p>` });
  }

  let count = 0;
  let sum = 0;
  for (const d of dist) {
    count += Number(d.cnt);
    sum += d.score * Number(d.cnt);
  }
  const avg = count ? Math.round((sum / count) * 10) / 10 : null;
  const reviewsText = count ? `${count} ${plural(count, "отзыв", "отзыва", "отзывов")}` : "пока без отзывов";
  const category = CATEGORY[b.category] || "";

  const base = String(env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
  const photo = (b.photos || []).find((id) => MEDIA_ID_RE.test(String(id)));
  const logo = b.design && MEDIA_ID_RE.test(String(b.design.logo || "")) ? b.design.logo : null;
  const image = photo ? `${base}/m/${photo}` : logo ? `${base}/m/${logo}` : `${base}/assets/og.png`;
  const appLink = env.APP_BOT_USERNAME && env.APP_SHORT_NAME
    ? `https://t.me/${env.APP_BOT_USERNAME}/${env.APP_SHORT_NAME}?startapp=p_${b.slug}`
    : null;

  const ogTitle = avg !== null ? `${b.name} — ★ ${fmt(avg)} · ${reviewsText}` : `${b.name} — отзывы гостей`;
  const ogDescription = [category, b.city].filter(Boolean).join(", ") + (category || b.city ? ". " : "") + "Честные отзывы гостей в TapReview.";
  const meta = `
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="TapReview">
  <meta property="og:title" content="${escapeHtml(ogTitle)}">
  <meta property="og:description" content="${escapeHtml(ogDescription)}">
  <meta property="og:image" content="${escapeHtml(image)}">
  <meta property="og:url" content="${escapeHtml(`${base}/p/${b.slug}`)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="description" content="${escapeHtml(ogDescription)}">`;

  const stars = (n) =>
    `<span class="sh-stars" role="img" aria-label="${n} из 5">${STAR.repeat(Math.round(n))}<span class="sh-off">${STAR.repeat(5 - Math.round(n))}</span></span>`;
  const quote = (r) => {
    const text = r.text.length > 220 ? `${r.text.slice(0, 220).trimEnd()}…` : r.text;
    const date = new Date(r.created_at).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });
    return `<li class="sh-review">${stars(r.score)}<p>${escapeHtml(text)}</p><span class="sh-meta">Гость · ${escapeHtml(date)}</span></li>`;
  };

  const body = `
      ${photo ? `<img class="sh-photo" src="/m/${photo}" alt="">` : ""}
      <h1 class="name${[...b.name].length > 22 ? " name-long" : ""}">${escapeHtml(b.name)}</h1>
      ${b.tagline || category ? `<p class="tagline">${escapeHtml(b.tagline || category)}</p>` : ""}
      <div class="divider"></div>
      ${avg !== null
        ? `<div class="sh-rating"><b>${fmt(avg)}</b>${stars(avg)}<span class="sh-count">${escapeHtml(reviewsText)} в TapReview</span></div>`
        : `<p class="lead">Отзывов пока нет — станьте первым.</p>`}
      ${reviews.length ? `<ul class="sh-reviews">${reviews.map(quote).join("")}</ul>` : ""}
      ${[b.city, b.address].filter(Boolean).length ? `<p class="sh-address">${escapeHtml([b.city, b.address].filter(Boolean).join(", "))}</p>` : ""}
      ${appLink
        ? `<a class="app-btn" href="${escapeHtml(appLink)}" rel="nofollow">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 4.5 2.9 11.4c-1 .4-1 1.7 0 2l4.5 1.5 1.7 5.3c.2.7 1.1.9 1.6.3l2.5-2.6 4.6 3.4c.6.4 1.4.1 1.6-.6L22.4 5.9c.2-.9-.6-1.7-1.4-1.4zM9.6 14.4l8.3-6.6-6.6 7.7-.3 3.2z" fill="currentColor"/></svg>
            <span class="app-btn-copy"><span class="app-btn-big">Все отзывы в Telegram</span><span class="app-btn-small">Открыть в приложении TapReview</span></span>
          </a>`
        : ""}`;

  const extraCss = `
    .sh-photo { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border-radius: 16px; margin: 0 0 18px; }
    .sh-rating { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 6px 10px; margin: 6px 0 4px; }
    .sh-rating b { font-size: 34px; line-height: 1; }
    .sh-count { flex-basis: 100%; color: var(--muted); font-size: 14px; }
    .card .sh-stars { display: inline-flex; gap: 2px; color: #e5aa0c; }
    .card .sh-stars svg { width: 22px; height: 22px; fill: currentColor; }
    .card .sh-off { display: inline-flex; gap: 2px; color: rgba(127, 127, 127, .3); }
    .sh-reviews { list-style: none; margin: 18px 0 0; padding: 0; display: grid; gap: 10px; text-align: left; }
    .sh-review { padding: 12px 14px; border-radius: 14px; background: var(--btn-bg); border: 1px solid var(--btn-border); }
    .card .sh-review .sh-stars svg { width: 15px; height: 15px; }
    .sh-review p { margin: 6px 0 4px; font-size: 14.5px; line-height: 1.45; overflow-wrap: anywhere; }
    .sh-meta { font-size: 12px; color: var(--muted); }
    .sh-address { margin: 16px 0 0; color: var(--muted); font-size: 14px; }`;

  return renderPage({
    status: 200,
    title: ogTitle,
    accent: /^#[0-9A-Fa-f]{6}$/.test(b.brand_color || "") ? b.brand_color : null,
    theme: b.theme,
    design: customDesign(b),
    meta,
    // Общий noindex отключает превью в Telegram — запрещаем индексацию только поисковикам
    robots: ROBOTS_SEARCH_ONLY,
    extraCss,
    footer: { href: `/r/${b.slug}?s=link`, text: "Хочу такую карту" },
    body
  });
}

function notFound() {
  return renderPage({
    status: 404,
    title: "Заведение не найдено",
    body: `<h1 class="name">Не нашли</h1><p class="lead">Заведения нет в каталоге TapReview или оно скрыто.</p>`
  });
}
