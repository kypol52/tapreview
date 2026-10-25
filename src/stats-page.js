// Страница статистики для владельца по личной ссылке: /s/:token?p=today|week|month
// Работает в любом браузере, без Telegram и без входа. Ссылку создают и отключают в админ-панели.
// Страница собирается целиком на сервере, скриптов в браузере нет.

import { db } from "./supabase.js";
import { PERIODS, PLATFORMS, loadReports, loadDaily, formatDateRange } from "./report.js";
import { ICONS } from "./public-page.js";

const TOKEN_RE = /^[A-Za-z0-9]{24}$/;
const TABS = [
  { key: "today", label: "Сегодня" },
  { key: "week", label: "7 дней" },
  { key: "month", label: "30 дней" }
];
const SOURCES = [
  { key: "nfc", label: "NFC — приложили телефон" },
  { key: "qr", label: "QR-код" },
  { key: "direct", label: "По ссылке" }
];

export async function handleStatsPage(request, env, ctx, token) {
  try {
    return await statsPage(request, env, ctx, token);
  } catch (error) {
    console.error(`Stats page error: ${error.message}\n${error.stack}`);
    return html(
      500,
      "Статистика временно недоступна",
      `<main class="wrap wrap-center"><section class="panel">
        <h1 class="lost">Не удалось загрузить статистику</h1>
        <p>Попробуйте обновить страницу через минуту.</p>
      </section></main>`
    );
  }
}

async function statsPage(request, env, ctx, token) {
  if (!TOKEN_RE.test(token)) return notFound();

  const links = await db(env, `stats_links?token=eq.${token}&select=business_id`);
  if (!links.length) return notFound();
  const businessId = links[0].business_id;

  const url = new URL(request.url);
  const period = PERIODS[url.searchParams.get("p")] ? url.searchParams.get("p") : "week";
  const now = Date.now();

  const [reports, daily] = await Promise.all([
    loadReports(env, [businessId], period, now),
    period === "today" ? Promise.resolve(null) : loadDaily(env, businessId, period, now)
  ]);
  const report = reports.get(businessId);
  if (!report) return notFound();

  // Запоминаем, когда владелец смотрел статистику (видно в админ-панели)
  ctx.waitUntil(
    db(env, `stats_links?token=eq.${token}`, {
      method: "PATCH",
      body: { last_opened_at: new Date(now).toISOString() },
      prefer: "return=minimal"
    }).catch((error) => console.error(`stats_links last_opened_at: ${error.message}`))
  );

  return html(200, `Статистика · ${report.name}`, renderBody(report, daily, token, now));
}

// ---------- Разметка ----------

function renderBody(report, daily, token, now) {
  const { name, period, range, cur, prev, cards } = report;
  const p = PERIODS[period];
  const empty = !cur.views && !cur.clicks;

  const tabs = TABS.map(
    (t) =>
      `<a class="tab" href="/s/${token}?p=${t.key}"${t.key === period ? ' aria-current="page"' : ""}>${t.label}</a>`
  ).join("");

  const conversion =
    cur.views && cur.clicks ? `<div class="kpi-sub">Это ${Math.round((cur.clicks / cur.views) * 100)}% от открытий</div>` : "";

  let sections = "";
  if (daily) sections += chartSection(daily, period);
  if (!empty) {
    sections += barsSection(
      "Откуда открыли страницу",
      SOURCES.map((s) => ({ label: s.label, value: cur[s.key] })),
      cur.views,
      "bar-navy"
    );
    sections += barsSection(
      "Куда перешли оставить отзыв",
      PLATFORMS.map((pl) => ({ label: pl.label, value: cur[pl.key], icon: ICONS[pl.key] })),
      cur.clicks,
      "bar-gold"
    );
    if (cards.length > 1) sections += cardsSection(cards);
  } else {
    sections += `<section class="panel"><p class="empty">За этот период переходов не было.</p></section>`;
  }

  const updated = new Date(now).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow"
  });

  return `
  <header class="top">
    <div class="top-inner">
      <div class="brand">TapReview <span>· статистика</span></div>
      <h1 class="name">${esc(name)}</h1>
      <p class="range">${p.title} · ${formatDateRange(period, range)}</p>
      <nav class="tabs" aria-label="Период">${tabs}</nav>
    </div>
  </header>
  <main class="wrap">
    <section class="kpis">
      <div class="kpi">
        <div class="kpi-label">Открыли страницу</div>
        <div class="kpi-value">${num(cur.views)}</div>
        ${delta(cur.views, prev.views, p.vs)}
      </div>
      <div class="kpi">
        <div class="kpi-label">Перешли к отзыву</div>
        <div class="kpi-value">${num(cur.clicks)}</div>
        ${delta(cur.clicks, prev.clicks, p.vs)}
        ${conversion}
      </div>
    </section>
    ${sections}
    <section class="note">
      <h2>Как считаем</h2>
      <p><b>Открыли страницу</b> — сколько раз страницу отзывов открыли с карты (приложили телефон или отсканировали QR) или по ссылке.
        Один и тот же человек считается не чаще раза в 30 минут, роботы не считаются.</p>
      <p><b>Перешли к отзыву</b> — сколько раз нажали кнопку Яндекс Карт, Google или 2ГИС.
        Сам отзыв человек пишет уже на площадке, поэтому опубликованные отзывы здесь не считаются.</p>
      <p>Сравнение — ${p.compare}.</p>
    </section>
  </main>
  <footer class="foot">
    <p>Обновлено ${esc(updated)} (МСК). Чтобы увидеть свежие цифры, обновите страницу.</p>
    <p>Сохраните ссылку в закладки или на главный экран телефона. Не пересылайте её посторонним — по ней видна статистика вашего заведения.</p>
  </footer>`;
}

function chartSection(daily, period) {
  const max = Math.max(1, ...daily.map((d) => d.views), ...daily.map((d) => d.clicks));
  const month = period === "month";
  const cols = daily
    .map((d, i) => {
      const date = new Date(`${d.day}T12:00:00Z`);
      const dayNum = date.getUTCDate();
      const label = month
        ? i % 5 === 4 || i === daily.length - 1
          ? String(dayNum)
          : ""
        : `${date.toLocaleDateString("ru-RU", { weekday: "short", timeZone: "UTC" })}<br>${dayNum}`;
      const title = `${date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" })}: ` +
        `${d.views} ${plural(d.views, "открытие", "открытия", "открытий")}, ` +
        `${d.clicks} ${plural(d.clicks, "переход", "перехода", "переходов")} к отзыву`;
      const hv = Math.round((d.views / max) * 100);
      const hc = Math.round((d.clicks / max) * 100);
      return `<div class="col" title="${esc(title)}">
          ${month ? "" : `<div class="col-num">${d.views || ""}</div>`}
          <div class="col-area"><div class="col-views" style="height:${hv}%"></div><div class="col-clicks" style="height:${hc}%"></div></div>
          <div class="col-label">${label}</div>
        </div>`;
    })
    .join("");

  return `<section class="panel">
      <h2>По дням</h2>
      <div class="legend"><span><i class="dot dot-navy"></i>открыли страницу</span><span><i class="dot dot-gold"></i>перешли к отзыву</span></div>
      <div class="chart${month ? " chart-month" : ""}" role="img" aria-label="График по дням">${cols}</div>
    </section>`;
}

function barsSection(title, rows, total, barClass) {
  const items = rows
    .map((r) => {
      const share = total ? Math.round((r.value / total) * 100) : 0;
      return `<li class="row">
          ${r.icon ? `<span class="row-icon">${r.icon}</span>` : ""}
          <span class="row-label">${esc(r.label)}</span>
          <span class="row-value">${num(r.value)}<small>${share}%</small></span>
          <span class="row-bar"><span class="${barClass}" style="width:${share}%"></span></span>
        </li>`;
    })
    .join("");
  return `<section class="panel"><h2>${esc(title)}</h2><ul class="rows">${items}</ul></section>`;
}

function cardsSection(cards) {
  const items = cards
    .slice(0, 20)
    .map(
      (c) => `<tr><td>${esc(c.name)}</td><td>${num(c.views)}</td><td>${num(c.clicks)}</td></tr>`
    )
    .join("");
  return `<section class="panel">
      <h2>По картам</h2>
      <table class="cards"><thead><tr><th>Карта</th><th>Открыли</th><th>К отзыву</th></tr></thead><tbody>${items}</tbody></table>
    </section>`;
}

function delta(cur, prev, vs) {
  if (!cur && !prev) return "";
  const diff = cur - prev;
  if (diff > 0) return `<div class="delta delta-up">▲ +${num(diff)}<span>${vs}</span></div>`;
  if (diff < 0) return `<div class="delta delta-down">▼ −${num(-diff)}<span>${vs}</span></div>`;
  return `<div class="delta">без изменений<span>${vs}</span></div>`;
}

// ---------- Ответы ----------

function notFound() {
  return html(
    404,
    "Ссылка недействительна",
    `<main class="wrap wrap-center">
      <section class="panel">
        <h1 class="lost">Ссылка недействительна</h1>
        <p>Возможно, её отключили или в ней ошибка. Попросите новую ссылку у TapReview.</p>
      </section>
    </main>`
  );
}

function html(status, title, body) {
  const page = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="referrer" content="no-referrer">
  <meta name="theme-color" content="#0a2a5c">
  <meta name="apple-mobile-web-app-title" content="Статистика">
  <link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
  <link rel="icon" href="/assets/favicon.png">
  <title>${esc(title)}</title>
  <style>${CSS}</style>
</head>
<body>${body}
</body>
</html>`;
  return new Response(page, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
  });
}

// ---------- Мелочи ----------

function num(n) {
  return Number(n).toLocaleString("ru-RU");
}

function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
  @font-face { font-family: "Montserrat"; font-weight: 100 900; font-display: swap;
    src: url(/fonts/montserrat-var-cyrillic.woff2) format("woff2");
    unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116; }
  @font-face { font-family: "Montserrat"; font-weight: 100 900; font-display: swap;
    src: url(/fonts/montserrat-var-latin.woff2) format("woff2");
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+25B2, U+25BC, U+FEFF, U+FFFD; }
  :root {
    --navy: #0a2a5c; --navy-2: #123a78; --gold: #e5aa0c; --gold-soft: #f6d77a;
    --text: #141a2b; --muted: #6b7280; --bg: #f4f6fa; --line: #e4e8f0;
    --up: #15803d; --down: #b91c1c;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font-family: "Montserrat", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
  .top { background: linear-gradient(160deg, var(--navy) 0%, #071d42 100%); color: #fff; padding: 22px 16px 26px;
    border-bottom: 3px solid var(--gold); }
  .top-inner, .wrap, .foot { max-width: 560px; margin: 0 auto; }
  .brand { font-size: 13px; font-weight: 700; letter-spacing: 0.02em; color: var(--gold); }
  .brand span { color: rgba(255,255,255,0.7); font-weight: 500; }
  .name { margin: 10px 0 4px; font-size: 26px; font-weight: 800; line-height: 1.2; overflow-wrap: anywhere; }
  .range { margin: 0 0 18px; font-size: 14px; color: rgba(255,255,255,0.78); }
  .tabs { display: flex; gap: 4px; padding: 4px; background: rgba(255,255,255,0.1); border-radius: 999px; }
  .tab { flex: 1; text-align: center; padding: 9px 6px; border-radius: 999px; color: #fff; text-decoration: none;
    font-size: 14px; font-weight: 600; -webkit-tap-highlight-color: transparent; }
  .tab[aria-current="page"] { background: #fff; color: var(--navy); }
  .tab:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .wrap { padding: 16px; }
  .wrap-center { padding-top: 18vh; text-align: center; }
  .kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: -2px; }
  .kpi, .panel { background: #fff; border-radius: 18px; padding: 16px;
    box-shadow: 0 1px 2px rgba(20,26,43,0.04), 0 8px 24px rgba(20,26,43,0.06); }
  .kpi-label { font-size: 13px; color: var(--muted); font-weight: 600; }
  .kpi-value { margin: 6px 0 4px; font-size: 38px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
  .kpi-sub { margin-top: 6px; font-size: 12px; color: var(--muted); }
  .delta { font-size: 13px; font-weight: 700; color: var(--muted); }
  .delta span { display: block; margin-top: 1px; font-size: 12px; font-weight: 500; color: var(--muted); }
  .delta-up { color: var(--up); }
  .delta-down { color: var(--down); }
  .panel { margin-top: 12px; }
  .panel h2, .note h2 { margin: 0 0 12px; font-size: 16px; font-weight: 700; }
  .empty { margin: 0; color: var(--muted); text-align: center; }
  .legend { display: flex; flex-wrap: wrap; gap: 14px; margin: -4px 0 12px; font-size: 12px; color: var(--muted); }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  .dot-navy { background: var(--navy); }
  .dot-gold { background: var(--gold); }
  .chart { display: flex; align-items: flex-end; gap: 6px; }
  .chart-month { gap: 2px; }
  .col { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: stretch; }
  .col-num { height: 16px; font-size: 11px; font-weight: 600; text-align: center; color: var(--muted); }
  .col-area { position: relative; height: 130px; background: #f1f3f8; border-radius: 6px; overflow: hidden; }
  .chart-month .col-area { border-radius: 3px; }
  .col-views, .col-clicks { position: absolute; left: 0; right: 0; bottom: 0; border-radius: 6px 6px 0 0; }
  .col-views { background: var(--navy); }
  .col-clicks { left: 22%; right: 22%; background: var(--gold); }
  .chart-month .col-clicks { left: 0; right: 0; opacity: 0.95; }
  .col-label { min-height: 30px; margin-top: 6px; font-size: 11px; line-height: 1.25; text-align: center; color: var(--muted); }
  .rows { list-style: none; margin: 0; padding: 0; }
  .row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; column-gap: 10px; row-gap: 6px; padding: 8px 0; }
  .row + .row { border-top: 1px solid var(--line); }
  .row-icon { grid-row: span 2; width: 32px; height: 32px; }
  .row-icon svg { display: block; width: 100%; height: 100%; }
  .row-label { font-size: 14px; font-weight: 600; }
  .row-value { font-size: 16px; font-weight: 800; font-variant-numeric: tabular-nums; text-align: right; }
  .row-value small { margin-left: 6px; font-size: 12px; font-weight: 600; color: var(--muted); }
  .row-bar { grid-column: span 2; height: 6px; background: #f1f3f8; border-radius: 3px; overflow: hidden; }
  .row:not(:has(.row-icon)) { grid-template-columns: 1fr auto; }
  .row:not(:has(.row-icon)) .row-bar { grid-column: 1 / -1; }
  .row-bar span { display: block; height: 100%; border-radius: 3px; }
  .bar-navy { background: var(--navy); }
  .bar-gold { background: var(--gold); }
  .cards { width: 100%; border-collapse: collapse; font-size: 14px; }
  .cards th { text-align: left; font-size: 12px; color: var(--muted); font-weight: 600; padding: 0 0 8px; }
  .cards td { padding: 9px 0; border-top: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  .cards th + th, .cards td + td { text-align: right; padding-left: 12px; }
  .note { margin-top: 16px; padding: 4px 4px 0; font-size: 13px; line-height: 1.55; color: var(--muted); }
  .note p { margin: 0 0 8px; }
  .note b { color: var(--text); }
  .lost { margin: 0 0 8px; font-size: 22px; }
  .foot { padding: 8px 20px 36px; font-size: 12px; line-height: 1.5; color: var(--muted); }
  .foot p { margin: 0 0 6px; }
  @media (max-width: 360px) {
    .kpi-value { font-size: 32px; }
    .name { font-size: 22px; }
  }
`;
