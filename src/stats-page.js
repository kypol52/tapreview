// Страница статистики для владельца по личной ссылке: /s/:token?p=today|week|month
// Работает в любом браузере, без Telegram и без входа. Ссылку создают и отключают в админ-панели.
// Страница собирается целиком на сервере, скриптов в браузере нет.

import { db } from "./supabase.js";
import { PERIODS, PLATFORMS, loadReports, loadDaily, sumTotals, formatDateRange, formatCardCode } from "./report.js";
import { ICONS } from "./public-page.js";
import { formatDay } from "./billing.js";
import { normalizeCode, findCode, redeemCode, bonusCounts, validityText } from "./bonus.js";

const TOKEN_RE = /^[A-Za-z0-9]{24}$/;
// Куда владелец пишет, чтобы продлить подписку (личный Telegram TapReview)
const SUPPORT_HANDLE = "@tapreview_ru";
const SUPPORT_URL = "https://t.me/tapreview_ru";
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

// Одна ссылка может показывать несколько заведений. Внутри три вида страницы:
//   без параметров — сводка по всем заведениям ссылки (если заведение одно — сразу оно)
//   ?b=ID          — одно заведение
//   ?c=КОД         — одна карта (только карта, привязанная к заведению этой ссылки)
async function statsPage(request, env, ctx, token) {
  if (!TOKEN_RE.test(token)) return notFound();

  const links = await db(env, `stats_links?token=eq.${token}&select=business_id,business_ids`);
  if (!links.length) return notFound();
  const link = links[0];
  const linkIds = [...new Set(link.business_ids && link.business_ids.length ? link.business_ids : [link.business_id])];

  const url = new URL(request.url);
  const period = PERIODS[url.searchParams.get("p")] ? url.searchParams.get("p") : "week";
  const now = Date.now();

  const [reports, bonusRows] = await Promise.all([
    loadReports(env, linkIds, period, now),
    // Включён ли подарок для гостей хотя бы в одном заведении — тогда показываем кнопку для кассы
    db(env, `businesses?id=in.(${linkIds.join(",")})&bonus_mode=neq.off&select=id&limit=1`).catch(() => [])
  ]);
  // Удалённые заведения просто пропускаем, порядок — как в ссылке
  const allVenues = linkIds.map((id) => reports.get(id)).filter(Boolean);
  if (!allVenues.length) return notFound();

  // Заведения с закончившейся подпиской: статистика на паузе, показываем только напоминание
  const venues = allVenues.filter((v) => v.billing.state !== "expired");
  const paused = allVenues.filter((v) => v.billing.state === "expired");
  const notices = billingNotices(allVenues);
  const multi = venues.length > 1;

  // Запоминаем, когда владелец смотрел статистику (видно в админ-панели)
  ctx.waitUntil(
    db(env, `stats_links?token=eq.${token}`, {
      method: "PATCH",
      body: { last_opened_at: new Date(now).toISOString() },
      prefer: "return=minimal"
    }).catch((error) => console.error(`stats_links last_opened_at: ${error.message}`))
  );

  if (!venues.length || refersTo(url, paused)) {
    return html(200, "Статистика на паузе", pausedBody(token, venues.length ? null : allVenues, notices));
  }
  const view = pickView(url, venues, multi);
  if (!view) return notFound();

  const daily =
    period === "today"
      ? null
      : await loadDaily(env, view.dailyIds, period, now, view.card ? view.card.id : null);

  const page = { token, period, range: venues[0].range, now, multi, notices, bonusOn: bonusRows.length > 0 };
  return html(200, `Статистика · ${view.title}`, renderBody(view, daily, page));
}

// ---------- Касса: проверка и погашение кода подарка ----------
//   /s/:token/bonus — владелец (ссылка статистики): касса + счётчики подарков, ссылка «← Статистика»
//   /k/:token       — персонал (ссылка для кассы): ТОЛЬКО проверка и погашение кода своего заведения
// GET ?code=ABC123 — проверить; ?code=ABC123&redeem=1 — погасить. Только коды заведений этой ссылки.

export async function handleBonusDesk(request, env, token) {
  try {
    if (!TOKEN_RE.test(token)) return notFound();
    const links = await db(env, `stats_links?token=eq.${token}&select=business_id,business_ids`);
    if (!links.length) return notFound();
    const link = links[0];
    const ids = [...new Set(link.business_ids && link.business_ids.length ? link.business_ids : [link.business_id])];
    return await renderDesk(request, env, { ids, base: `/s/${token}/bonus`, owner: true, token, by: "владелец" });
  } catch (error) {
    return deskError(error);
  }
}

export async function handleStaffDesk(request, env, token) {
  try {
    if (!TOKEN_RE.test(token)) return notFound();
    const links = await db(env, `staff_links?token=eq.${token}&select=business_id,label`);
    if (!links.length) return notFound();
    const link = links[0];
    return await renderDesk(request, env, {
      ids: [link.business_id],
      base: `/k/${token}`,
      owner: false,
      by: link.label ? `персонал: ${link.label}` : "персонал",
      onRedeem: () =>
        db(env, `staff_links?token=eq.${token}`, {
          method: "PATCH",
          body: { last_used_at: new Date().toISOString() },
          prefer: "return=minimal"
        }).catch(() => {})
    });
  } catch (error) {
    return deskError(error);
  }
}

function deskError(error) {
  console.error(`Bonus desk error: ${error.message}\n${error.stack}`);
  return html(500, "Ошибка", `<main class="wrap wrap-center"><section class="panel"><h1 class="lost">Не удалось проверить код</h1><p>Попробуйте ещё раз через минуту.</p></section></main>`);
}

async function renderDesk(request, env, { ids, base, owner, token, by, onRedeem }) {
    const businesses = await db(env, `businesses?id=in.(${ids.join(",")})&select=id,name`);
    if (!businesses.length) return notFound();
    const names = new Map(businesses.map((b) => [b.id, b.name]));

    // Погашение — обычной ссылкой ?code=…&redeem=1 (а не формой): в РФ соединения с Cloudflare
    // иногда обрываются, и обычный переход браузер повторяет сам. Если повтор пришёл сразу после
    // погашения, показываем «погашен», а не «уже погашен» — кассир не запутается.
    const url = new URL(request.url);
    const params = request.method === "POST" ? new URLSearchParams((await request.text()).slice(0, 500)) : url.searchParams;
    const input = String(params.get("code") || "");
    const wantRedeem = request.method === "POST" || params.get("redeem") === "1";
    let result = "";
    if (input) {
      const code = normalizeCode(input);
      const found = code ? await findCode(env, code, ids) : null;
      if (wantRedeem && found && found.state === "ok") {
        const done = await redeemCode(env, found.row.id, by);
        if (done && onRedeem) await onRedeem();
        result = done
          ? deskResult("done", found.row, names, "Код погашен — можно выдавать подарок")
          : deskResult("used", found.row, names, "Код уже погашен");
      } else if (wantRedeem && found && found.state === "used" && Date.now() - Date.parse(found.row.redeemed_at) < 2 * 60 * 1000) {
        result = deskResult("done", found.row, names, "Код погашен — можно выдавать подарок");
      } else {
        result = deskState(found, input, names, base);
      }
    }

    // Счётчики подарков видит только владелец
    let statsPanel = "";
    if (owner) {
      const counts = await bonusCounts(env, ids, 30);
      const prizeRows = Object.entries(counts.byPrize)
        .sort((a, b) => b[1].issued - a[1].issued)
        .map(([prize, c]) => `<tr><td>${esc(prize)}</td><td>${num(c.issued)}</td><td>${num(c.redeemed)}</td></tr>`)
        .join("");
      statsPanel = `
    <section class="panel">
      <h2>Подарки за 30 дней</h2>
      <div class="kpis desk-kpis">
        <div class="kpi"><div class="kpi-label">Выдано кодов</div><div class="kpi-value">${num(counts.issued)}</div></div>
        <div class="kpi"><div class="kpi-label">Погашено</div><div class="kpi-value">${num(counts.redeemed)}</div></div>
      </div>
      ${prizeRows ? `<table class="desk-table"><thead><tr><th>Подарок</th><th>Выдано</th><th>Погашено</th></tr></thead><tbody>${prizeRows}</tbody></table>` : ""}
    </section>`;
    }

    const venueName = businesses.length === 1 ? businesses[0].name : "";
    const body = `
  <header class="top">
    <div class="top-inner">
      <div class="brand">TapReview <span>· касса</span></div>
      ${owner ? `<a class="back" href="/s/${token}">← Статистика</a>` : ""}
      <h1 class="name">Проверка подарка</h1>
      ${venueName ? `<p class="sub">${esc(venueName)}</p>` : ""}
      <p class="range">Введите код с экрана гостя: 6 букв и цифр, например ABC-123</p>
    </div>
  </header>
  <main class="wrap">
    <section class="panel">
      <form class="desk-form" method="get" action="${base}">
        <input name="code" value="${esc(input)}" maxlength="12" autocomplete="off" autocapitalize="characters"
          spellcheck="false" placeholder="ABC-123" aria-label="Код подарка" required>
        <button type="submit">Проверить</button>
      </form>
      ${result}
    </section>
    ${statsPanel}
    <section class="note">
      <p>Код действует один раз. Гость получает его, только когда сканирует карту в заведении, и не чаще раза в несколько недель.
        Подарок не зависит от отзыва — так требуют правила Яндекс Карт и 2ГИС.</p>
      ${owner ? "" : "<p>Это рабочая ссылка кассы. Не передавайте её гостям.</p>"}
    </section>
  </main>`;
    return html(200, "Проверка подарка", body);
}

function deskState(found, input, names, base) {
  if (!found) return `<div class="desk-res desk-bad"><p class="desk-title">Такого кода нет</p><p>Проверьте, правильно ли введён код «${esc(input)}».</p></div>`;
  const { row, state } = found;
  if (state === "ok") {
    return `${deskResult("ok", row, names, "Код действует")}
      <a class="desk-redeem" href="${base}?code=${esc(row.code)}&amp;redeem=1" rel="nofollow">Погасить код и выдать подарок</a>`;
  }
  if (state === "soon") {
    return deskResult("soon", row, names, `Код начнёт действовать ${formatDayTime(row.valid_from)}`);
  }
  if (state === "expired") return deskResult("bad", row, names, "Срок действия кода истёк");
  return deskResult("used", row, names, `Код уже погашен ${formatDayTime(row.redeemed_at)}`);
}

function deskResult(kind, row, names, title) {
  const tone = kind === "ok" || kind === "done" ? "desk-ok" : kind === "soon" ? "desk-warn" : "desk-bad";
  return `<div class="desk-res ${tone}">
      <p class="desk-title">${kind === "done" ? "✅ " : ""}${esc(title)}</p>
      <p class="desk-prize">${esc(row.prize)}</p>
      <p>${esc(validityText(row))}${names.size > 1 ? ` · ${esc(names.get(row.business_id) || "")}` : ""}</p>
      ${row.conditions ? `<p>Условия: ${esc(row.conditions)}</p>` : ""}
    </div>`;
}

function formatDayTime(iso) {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow"
  });
}

// ---------- Подписка ----------

// Напоминания владельцу: скоро закончится / закончилась, идёт отсрочка / на паузе
function billingNotices(venues) {
  const renew = `<a href="${esc(SUPPORT_URL)}" target="_blank" rel="noopener noreferrer">Продлить — написать в Telegram ${esc(SUPPORT_HANDLE)}</a>`;
  return venues
    .map(({ name, billing: b }) => {
      const who = `«${esc(name)}»`;
      if (b.state === "ending") {
        return notice(
          "warn",
          b.daysLeft === 0
            ? `Подписка на ${who} заканчивается сегодня.`
            : `Подписка на ${who} оплачена до ${formatDay(b.paidUntil)} включительно.`,
          "Продлите заранее, чтобы карта и статистика работали без перерыва.",
          renew
        );
      }
      if (b.state === "grace") {
        return notice(
          "bad",
          `Подписка на ${who} закончилась ${formatDay(b.paidUntil)}.`,
          `Карта работает до ${formatDay(b.lastDay)} включительно. После этого гости будут попадать сразу на страницу ` +
            "площадки без вашей страницы отзывов, а статистика встанет на паузу.",
          renew
        );
      }
      if (b.state === "expired") {
        return notice(
          "bad",
          `${who}: подписка закончилась ${formatDay(b.paidUntil)}, статистика на паузе.`,
          "Карта по-прежнему работает: гости попадают сразу на страницу площадки. Открытия мы продолжаем считать — " +
            "после продления они появятся здесь.",
          renew
        );
      }
      return "";
    })
    .join("");
}

function notice(tone, title, text, action) {
  return `<section class="notice notice-${tone}" role="status">
      <p class="notice-title">${title}</p>
      <p>${esc(text)}</p>
      <p class="notice-action">${action}</p>
    </section>`;
}

// Ссылка ведёт на заведение или карту, у которых подписка на паузе
function refersTo(url, paused) {
  const id = Number(url.searchParams.get("b"));
  const code = String(url.searchParams.get("c") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return paused.some((v) => v.id === id || (code && v.allCards.some((c) => c.code === code)));
}

function pausedBody(token, allPaused, notices) {
  const title = allPaused
    ? allPaused.length > 1
      ? "Все заведения"
      : allPaused[0].name
    : "Статистика на паузе";
  return `
  <header class="top">
    <div class="top-inner">
      <div class="brand">TapReview <span>· статистика</span></div>
      ${allPaused ? "" : `<a class="back" href="/s/${token}">← Вернуться к статистике</a>`}
      <h1 class="name">${esc(title)}</h1>
      <p class="range">Статистика на паузе</p>
    </div>
  </header>
  <main class="wrap">${notices}</main>
  <footer class="foot">
    <p>Сохраните ссылку — после продления статистика появится здесь же.</p>
  </footer>`;
}

function pickView(url, venues, multi) {
  const params = url.searchParams;

  if (params.has("c")) {
    const code = String(params.get("c")).toUpperCase().replace(/[^A-Z0-9]/g, "");
    for (const venue of venues) {
      const card = venue.allCards.find((c) => c.code === code);
      if (!card) continue;
      const pretty = formatCardCode(card.code);
      const labeled = card.name !== pretty;
      return {
        kind: "card",
        title: labeled ? card.name : `Карта ${pretty}`,
        sub: labeled ? `Карта ${pretty} · ${venue.name}` : venue.name,
        back: { query: multi ? `&b=${venue.id}` : "", label: venue.name },
        query: `&c=${card.code}`,
        cur: card.cur,
        prev: card.prev,
        dailyIds: [venue.id],
        card
      };
    }
    return null;
  }

  if (params.has("b") || !multi) {
    const id = multi ? Number(params.get("b")) : venues[0].id;
    const venue = venues.find((v) => v.id === id);
    if (!venue) return null;
    return {
      kind: "venue",
      title: venue.name,
      back: multi ? { query: "", label: "Все заведения" } : null,
      query: multi ? `&b=${venue.id}` : "",
      cur: venue.cur,
      prev: venue.prev,
      cards: venue.allCards.map((c) => ({ ...c, sub: c.name !== formatCardCode(c.code) ? formatCardCode(c.code) : "" })),
      dailyIds: [venue.id]
    };
  }

  const { cur, prev } = sumTotals(venues);
  return {
    kind: "all",
    title: "Все заведения",
    sub: `${venues.length} ${plural(venues.length, "заведение", "заведения", "заведений")}`,
    query: "",
    cur,
    prev,
    venues,
    cards: venues.flatMap((v) => v.allCards.map((c) => ({ ...c, sub: v.name }))).sort(
      (x, y) => y.cur.views - x.cur.views || y.cur.clicks - x.cur.clicks
    ),
    dailyIds: venues.map((v) => v.id)
  };
}

// ---------- Разметка ----------

function renderBody(view, daily, page) {
  const { token, period, range, now, multi } = page;
  const { cur, prev } = view;
  const p = PERIODS[period];
  const empty = !cur.views && !cur.clicks;
  const href = (query) => `/s/${token}?p=${period}${query}`;

  const tabs = TABS.map(
    (t) =>
      `<a class="tab" href="/s/${token}?p=${t.key}${view.query}"${t.key === period ? ' aria-current="page"' : ""}>${t.label}</a>`
  ).join("");

  const conversion =
    cur.views && cur.clicks ? `<div class="kpi-sub">Это ${Math.round((cur.clicks / cur.views) * 100)}% от открытий</div>` : "";

  let sections = "";
  if (daily) sections += chartSection(daily, period);
  if (view.venues) {
    sections += listSection(
      "Заведения",
      "Заведение",
      view.venues.map((v) => ({ href: href(`&b=${v.id}`), name: v.name, cur: v.cur }))
    );
  }
  if (view.cards && view.cards.length) {
    sections += listSection(
      "Карты",
      "Карта",
      view.cards.slice(0, 100).map((c) => ({
        href: href(`&c=${c.code}`),
        name: c.name,
        sub: c.isActive ? c.sub : [c.sub, "отключена"].filter(Boolean).join(" · "),
        cur: c.cur
      })),
      "Нажмите на карту, чтобы увидеть её статистику отдельно."
    );
  }
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
      ${view.back ? `<a class="back" href="${href(view.back.query)}">← ${esc(view.back.label)}</a>` : ""}
      <h1 class="name">${esc(view.title)}</h1>
      ${view.sub ? `<p class="sub">${esc(view.sub)}</p>` : ""}
      <p class="range">${p.title} · ${formatDateRange(period, range)}</p>
      <nav class="tabs" aria-label="Период">${tabs}</nav>
      ${page.bonusOn ? `<a class="desk-link" href="/s/${token}/bonus">🎁 Проверить код подарка</a>` : ""}
    </div>
  </header>
  <main class="wrap">
    ${page.notices}
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
      ${view.kind === "card" ? "<p>На этой странице — только переходы с этой карты.</p>" : ""}
      <p>Сравнение — ${p.compare}.</p>
    </section>
  </main>
  <footer class="foot">
    <p>Обновлено ${esc(updated)} (МСК). Чтобы увидеть свежие цифры, обновите страницу.</p>
    <p>Сохраните ссылку в закладки или на главный экран телефона. Не пересылайте её посторонним — по ней видна статистика ${multi ? "ваших заведений" : "вашего заведения"}.</p>
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

// Список заведений или карт — каждая строка ведёт на свою страницу
function listSection(title, column, items, hint) {
  const rows = items
    .map(
      (it) => `<li><a class="item" href="${it.href}">
          <span class="item-main"><span class="item-name">${esc(it.name)}</span>${it.sub ? `<span class="item-sub">${esc(it.sub)}</span>` : ""}</span>
          <span class="item-num${it.cur.views ? "" : " zero"}">${num(it.cur.views)}</span>
          <span class="item-num${it.cur.clicks ? "" : " zero"}">${num(it.cur.clicks)}</span>
          <span class="item-go" aria-hidden="true">›</span>
        </a></li>`
    )
    .join("");
  return `<section class="panel">
      <h2>${esc(title)}</h2>
      ${hint ? `<p class="hint">${esc(hint)}</p>` : ""}
      <div class="item item-head" aria-hidden="true"><span>${esc(column)}</span><span>Открыли</span><span>К отзыву</span><span></span></div>
      <ul class="items">${rows}</ul>
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
        "default-src 'none'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
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
  .back { display: inline-block; margin-top: 10px; padding: 4px 0; color: var(--gold-soft); font-size: 14px;
    font-weight: 600; text-decoration: none; overflow-wrap: anywhere; }
  .back:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .back + .name { margin-top: 4px; }
  .sub { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: rgba(255,255,255,0.9); overflow-wrap: anywhere; }
  .notice { margin-bottom: 12px; padding: 14px 16px; border-radius: 16px; font-size: 13px; line-height: 1.5; }
  .notice p { margin: 0 0 6px; }
  .notice p:last-child { margin-bottom: 0; }
  .notice-title { font-size: 14px; font-weight: 700; }
  .notice-warn { background: #fff7e0; color: #6b4a00; border: 1px solid #f3d27a; }
  .notice-bad { background: #fdecec; color: #7f1d1d; border: 1px solid #f5b5b5; }
  .notice-action a { color: inherit; font-weight: 700; }
  .desk-link { display: inline-block; margin-top: 14px; padding: 8px 14px; border-radius: 999px; background: rgba(255,255,255,0.12);
    color: #fff; font-size: 14px; font-weight: 600; text-decoration: none; }
  .desk-link:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .desk-form { display: flex; gap: 8px; }
  .desk-form input { flex: 1; min-width: 0; padding: 12px 14px; border: 0; border-radius: 12px; box-shadow: 0 0 0 1.5px var(--line) inset;
    font: inherit; font-size: 22px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text); }
  .desk-form input:focus { outline: none; box-shadow: 0 0 0 2px var(--navy) inset; }
  .desk-form button { border: 0; border-radius: 12px; padding: 0 18px; background: var(--navy); color: #fff;
    font: inherit; font-size: 15px; font-weight: 700; cursor: pointer; }
  .desk-redeem { display: grid; place-items: center; min-height: 52px; margin-top: 10px; border-radius: 12px; background: var(--up);
    color: #fff; font-size: 15px; font-weight: 700; text-decoration: none; }
  .desk-redeem:focus-visible { outline: 2px solid var(--navy); outline-offset: 2px; }
  .desk-res { margin-top: 14px; padding: 14px 16px; border-radius: 14px; font-size: 14px; line-height: 1.5; }
  .desk-res p { margin: 0 0 4px; }
  .desk-title { font-size: 16px; font-weight: 700; }
  .desk-prize { font-size: 20px; font-weight: 800; }
  .desk-ok { background: #e9f7ef; color: #14532d; }
  .desk-warn { background: #fff7e0; color: #6b4a00; }
  .desk-bad { background: #fdecec; color: #7f1d1d; }
  .desk-kpis { margin: 0 0 12px; }
  .desk-kpis .kpi { box-shadow: none; background: var(--bg); }
  .desk-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .desk-table th { text-align: left; font-size: 12px; color: var(--muted); font-weight: 600; padding: 0 0 8px; }
  .desk-table td { padding: 8px 0; border-top: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  .desk-table th + th, .desk-table td + td { text-align: right; padding-left: 12px; }
  .hint { margin: -6px 0 10px; font-size: 12px; color: var(--muted); }
  .items { list-style: none; margin: 0; padding: 0; }
  .item { display: grid; grid-template-columns: 1fr 64px 64px 14px; align-items: center; column-gap: 8px;
    padding: 10px 0; color: inherit; text-decoration: none; -webkit-tap-highlight-color: transparent; }
  .items .item { border-top: 1px solid var(--line); }
  .item-head { padding: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--muted); }
  .item-head span + span { text-align: right; }
  .item:focus-visible { outline: 2px solid var(--navy); outline-offset: 2px; border-radius: 6px; }
  .item-main { min-width: 0; display: flex; flex-direction: column; }
  .item-name { font-size: 14px; font-weight: 700; overflow-wrap: anywhere; }
  .item-sub { margin-top: 2px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
  .item-num { font-size: 15px; font-weight: 800; text-align: right; font-variant-numeric: tabular-nums; }
  .item-num.zero { font-weight: 600; color: #b3b9c6; }
  .item-go { font-size: 20px; line-height: 1; color: #b3b9c6; text-align: right; }
  @media (hover: hover) { .item:hover .item-name { color: var(--navy-2); text-decoration: underline; } }
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
