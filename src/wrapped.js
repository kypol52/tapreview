// «Итоги месяца» (Wrapped) для владельца — миграция 029.
//   /s/:token/wrapped?m=YYYY-MM&b=ID — красивая сводка за месяц по ссылке статистики (по умолчанию — прошлый месяц)
//   monthlyWrapped(env) — 1-го числа в 09:00 МСК короткие итоги в Telegram-бот владельца со ссылкой на страницу
// Без скриптов; цифры считает база (wrapped_month), здесь — только слова и оформление.

import { db } from "./supabase.js";
import { html, esc, notFound, TOKEN_RE } from "./stats-page.js";
import { billingState } from "./billing.js";
import { tg } from "./telegram.js";
import { LIKES } from "./rating.js";
import { has } from "./tariffs.js";
import { computeScore, scoreContext, activeDaysIn, daysBetween, scoreHtml, SCORE_CSS } from "./score.js";

const MSK = 3 * 3600 * 1000;
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_DAT = ["январю", "февралю", "марту", "апрелю", "маю", "июню", "июлю", "августу", "сентябрю", "октябрю", "ноябрю", "декабрю"];
const MONTHS_PREP = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];
const WEEKDAYS = ["", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
const WEEKDAYS_SHORT = ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const PLATFORM_NAMES = { yandex: "Яндекс Карты", twogis: "2ГИС", google: "Google Maps" };
const HISTORY_MONTHS = 12;

// Месяц по МСК: { y, m (1–12), key "YYYY-MM", from, to (мс UTC) }
function monthOf(y, m) {
  const d = new Date(Date.UTC(y, m - 1, 1));
  const yy = d.getUTCFullYear();
  const mm = d.getUTCMonth() + 1;
  return {
    y: yy,
    m: mm,
    key: `${yy}-${String(mm).padStart(2, "0")}`,
    from: Date.UTC(yy, mm - 1, 1) - MSK,
    to: Date.UTC(yy, mm, 1) - MSK
  };
}

function currentMonth(now = Date.now()) {
  const d = new Date(now + MSK);
  return monthOf(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

export function lastMonth(now = Date.now()) {
  const c = currentMonth(now);
  return monthOf(c.y, c.m - 1);
}

async function loadMonth(env, ids, month) {
  const result = await db(env, "rpc/wrapped_month", {
    method: "POST",
    body: { p_ids: ids, p_from: new Date(month.from).toISOString(), p_to: new Date(month.to).toISOString() }
  });
  return result || {};
}

// ---------- Страница ----------

export async function handleWrapped(request, env, token) {
  try {
    if (!TOKEN_RE.test(token)) return notFound();
    const links = await db(env, `stats_links?token=eq.${token}&select=business_id,business_ids`);
    if (!links.length) return notFound();
    const linkIds = [...new Set(links[0].business_ids && links[0].business_ids.length ? links[0].business_ids : [links[0].business_id])];

    const url = new URL(request.url);
    const wanted = Number(url.searchParams.get("b"));
    if (wanted && !linkIds.includes(wanted)) return notFound();

    const linked = await db(env, `businesses?id=in.(${linkIds.join(",")})&select=id,name,paid_until,tariff`);
    // «Итоги месяца» — с тарифа Plus (tariffs.js)
    if (linked.length && !linked.some((v) => has(v, "wrapped"))) {
      return html(200, "Итоги месяца", `<main class="wrap wrap-center"><section class="panel">
        <h1 class="lost">Итоги месяца — с тарифа Plus</h1><p>Чтобы подключить, напишите в TapReview.</p>
        <a class="back back-dark" href="/s/${token}">← Статистика</a></section></main>`);
    }
    const venues = linked.filter((v) => billingState(v.paid_until).state !== "expired" && has(v, "wrapped"));
    if (!venues.length) {
      return html(200, "Итоги на паузе", `<main class="wrap wrap-center"><section class="panel">
        <h1 class="lost">Статистика на паузе</h1><p>Продлите подписку, чтобы снова видеть итоги месяца.</p>
        <a class="back back-dark" href="/s/${token}">← Статистика</a></section></main>`);
    }
    const ids = wanted ? venues.filter((v) => v.id === wanted).map((v) => v.id) : venues.map((v) => v.id);
    if (!ids.length) return notFound();
    const title = ids.length === 1 ? venues.find((v) => v.id === ids[0]).name : `${ids.length} заведения`;

    // Месяц: ?m=YYYY-MM в пределах последних 12 месяцев, по умолчанию — прошлый
    const now = Date.now();
    const cur = currentMonth(now);
    let month = lastMonth(now);
    const m = /^(\d{4})-(\d{2})$/.exec(url.searchParams.get("m") || "");
    if (m) {
      const pick = monthOf(Number(m[1]), Number(m[2]));
      const oldest = monthOf(cur.y, cur.m - HISTORY_MONTHS);
      if (pick.from <= cur.from && pick.from >= oldest.from) month = pick;
    }
    const prevMonth = monthOf(month.y, month.m - 1);
    const [data, prev, ctx] = await Promise.all([
      loadMonth(env, ids, month),
      loadMonth(env, ids, prevMonth),
      // Score — только для одного заведения; открытия по дням сразу за два месяца
      ids.length === 1 ? scoreContext(env, ids[0], prevMonth.from, now).catch(() => null) : null
    ]);
    let score = null;
    if (ctx) {
      const end = Math.min(month.to, now);
      const opts = (from, to) => ({ activeDays: activeDaysIn(ctx.daily, from, to), periodDays: daysBetween(from, to), hasBot: ctx.hasBot, hasMoment: ctx.hasMoment });
      score = {
        cur: computeScore(data, opts(month.from, end)),
        prev: computeScore(prev, opts(prevMonth.from, prevMonth.to)),
        hasPrev: Number(prev.views) > 0
      };
    }

    const query = (key) => `/s/${token}/wrapped?m=${key}${wanted ? `&b=${wanted}` : ""}`;
    const nav = Array.from({ length: 6 }, (_, i) => monthOf(cur.y, cur.m - i))
      .map((x) => `<a class="wr-month${x.key === month.key ? " wr-month-on" : ""}" href="${query(x.key)}">${MONTHS[x.m - 1]}${x.y !== cur.y ? ` ${x.y}` : ""}</a>`)
      .join("");
    return html(200, `Итоги ${MONTHS_GEN[month.m - 1]} · ${title}`, wrappedBody({ token, title, month, prevMonth, data, prev, nav, score, isCurrent: month.key === cur.key }));
  } catch (error) {
    console.error(`Wrapped error: ${error.message}\n${error.stack}`);
    return html(500, "Итоги временно недоступны", `<main class="wrap wrap-center"><section class="panel">
      <h1 class="lost">Не удалось загрузить итоги</h1><p>Попробуйте обновить страницу через минуту.</p></section></main>`);
  }
}

function num(n) {
  return Number(n || 0).toLocaleString("ru-RU");
}

function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

function delta(cur, prev, prevMonth) {
  if (!prev) return cur ? `<p class="wr-delta">впервые за всё время 🎉</p>` : "";
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return `<p class="wr-delta">столько же, сколько в ${MONTHS_PREP[prevMonth.m - 1]}</p>`;
  const sign = pct > 0 ? "+" : "−";
  return `<p class="wr-delta ${pct > 0 ? "wr-up" : "wr-down"}">${sign}${Math.abs(pct)}% к ${MONTHS_DAT[prevMonth.m - 1]}</p>`;
}

function card(cls, inner) {
  return `<section class="wr-card ${cls}">${inner}</section>`;
}

function wrappedBody({ token, title, month, prevMonth, data, prev, nav, score, isCurrent }) {
  const views = Number(data.views) || 0;
  const clicks = data.clicks || {};
  const totalClicks = Object.values(clicks).reduce((s, n) => s + Number(n), 0);
  const prevClicks = Object.values(prev.clicks || {}).reduce((s, n) => s + Number(n), 0);
  const cards = [];

  cards.push(card("wr-hero", `
    <p class="wr-kicker">${isCurrent ? "Месяц ещё идёт" : "Итоги месяца"}</p>
    <h1 class="wr-title">${MONTHS[month.m - 1][0].toUpperCase() + MONTHS[month.m - 1].slice(1)} ${month.y}</h1>
    <p class="wr-venue">${esc(title)}</p>
    <p class="wr-lead">${isCurrent ? "Цифры на сегодня — полные итоги будут 1-го числа." : "Как гости знакомились с вами в этом месяце."}</p>`));

  if (!views && !totalClicks) {
    cards.push(card("", `<p class="wr-big-label">В этом месяце страницу не открывали.</p>
      <p class="wr-note">Проверьте, что карты стоят на видных местах, а персонал предлагает гостям приложить телефон.</p>`));
  } else {
    cards.push(card("", `
      <p class="wr-big">${num(views)}</p>
      <p class="wr-big-label">${plural(views, "раз гости открыли", "раза гости открыли", "раз гости открыли")} вашу страницу</p>
      ${delta(views, Number(prev.views) || 0, prevMonth)}`));

    const platforms = Object.entries(PLATFORM_NAMES)
      .filter(([k]) => Number(clicks[k]))
      .sort((a, b) => Number(clicks[b[0]]) - Number(clicks[a[0]]))
      .map(([k, name]) => {
        const v = Number(clicks[k]);
        const pct = totalClicks ? Math.round((v / totalClicks) * 100) : 0;
        return `<li><span>${name}</span><span class="wr-track"><span style="width:${pct}%"></span></span><b>${num(v)}</b></li>`;
      })
      .join("");
    cards.push(card("wr-gold", `
      <p class="wr-big">${num(totalClicks)}</p>
      <p class="wr-big-label">${plural(totalClicks, "раз перешли", "раза перешли", "раз перешли")} оставить отзыв</p>
      ${delta(totalClicks, prevClicks, prevMonth)}
      ${views && totalClicks ? `<p class="wr-note">Это ${Math.round((totalClicks / views) * 100)}% от открытий страницы.</p>` : ""}
      ${platforms ? `<ul class="wr-bars">${platforms}</ul>` : ""}`));
  }

  const r = data.ratings || {};
  if (Number(r.count)) {
    const avg = Number(r.avg).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const likes = data.likes || {};
    const liked = Number(data.liked) || 0;
    const top = LIKES.map((l) => ({ ...l, v: Number(likes[l.key]) || 0 })).filter((l) => l.v).sort((a, b) => b.v - a.v);
    cards.push(card("", `
      <p class="wr-big">${avg}<span class="wr-star">★</span></p>
      <p class="wr-big-label">средняя оценка из ${num(r.count)} ${plural(Number(r.count), "оценки", "оценок", "оценок")}</p>
      ${top.length && liked ? `<p class="wr-note">Больше всего хвалят: <b>${top[0].label.toLowerCase()}</b> — ${Math.round((top[0].v / liked) * 100)}% довольных гостей${top[1] ? `, затем ${top[1].label.toLowerCase()}` : ""}.</p>` : ""}`));
  }

  // Ритм: день недели, час пик, рекорд месяца
  const weekday = data.weekday || {};
  const wdMax = Math.max(0, ...Object.values(weekday).map(Number));
  if (wdMax) {
    const bestWd = Object.entries(weekday).sort((a, b) => Number(b[1]) - Number(a[1]))[0][0];
    const hours = Object.entries(data.hour || {}).sort((a, b) => Number(b[1]) - Number(a[1]));
    const peak = hours.length ? Number(hours[0][0]) : null;
    const best = data.best_day;
    const cols = [1, 2, 3, 4, 5, 6, 7]
      .map((d) => {
        const v = Number(weekday[d]) || 0;
        return `<li class="${String(d) === String(bestWd) ? "wr-col-on" : ""}"><span class="wr-col" style="height:${Math.max(4, Math.round((v / wdMax) * 64))}px"></span>${WEEKDAYS_SHORT[d]}</li>`;
      })
      .join("");
    cards.push(card("", `
      <p class="wr-kicker">Ритм заведения</p>
      <p class="wr-mid">Самый активный день — ${WEEKDAYS[bestWd]}</p>
      <ul class="wr-week">${cols}</ul>
      ${peak !== null ? `<p class="wr-note">Час пик — <b>${String(peak).padStart(2, "0")}:00–${String((peak + 1) % 24).padStart(2, "0")}:00</b> по московскому времени.</p>` : ""}
      ${best && best.day ? `<p class="wr-note">Рекорд месяца — <b>${Number(best.day.slice(8))} ${MONTHS_GEN[Number(best.day.slice(5, 7)) - 1]}</b>: ${num(best.views)} ${plural(Number(best.views), "открытие", "открытия", "открытий")}.</p>` : ""}`));
  }

  const g = data.guests || {};
  if (Number(g.guests)) {
    cards.push(card("", `
      <p class="wr-big">${num(g.returning)}</p>
      <p class="wr-big-label">${plural(Number(g.returning), "гость вернулся", "гостя вернулись", "гостей вернулись")} к вам снова</p>
      <p class="wr-note">Всего ${num(g.guests)} ${plural(Number(g.guests), "гость приложил", "гостя приложили", "гостей приложили")} телефон к карте. Узнаём по обезличенной метке телефона, без имён и номеров.</p>`));
  }

  const b = data.bonus || {};
  if (Number(b.issued)) {
    cards.push(card("wr-gold", `
      <p class="wr-big">${num(b.redeemed)}</p>
      <p class="wr-big-label">${plural(Number(b.redeemed), "подарок забрали", "подарка забрали", "подарков забрали")} на кассе</p>
      <p class="wr-note">Выдано кодов: ${num(b.issued)}${Number(b.rewards) ? `, из них особых призов за штампы: ${num(b.rewards)}` : ""}. Каждый погашенный код — гость, который пришёл снова.</p>`));
  }

  const f = data.feedback || {};
  if (Number(f.count)) {
    cards.push(card("", `
      <p class="wr-big">${num(f.count)}</p>
      <p class="wr-big-label">${plural(Number(f.count), "сообщение", "сообщения", "сообщений")} от недовольных гостей пришло вам, а не на карты</p>
      <p class="wr-note">Разобрано: ${num(f.resolved)} из ${num(f.count)}.${Number(f.resolved) < Number(f.count) ? ` <a href="/s/${token}#fb">Посмотреть →</a>` : " Отличная работа 👏"}</p>`));
  } else if (Number(r.count)) {
    cards.push(card("", `<p class="wr-mid">Ни одной жалобы за месяц 👏</p><p class="wr-note">Гости, которым что-то не понравилось бы, написали бы вам напрямую.</p>`));
  }

  // TapReview Score месяца — последней карточкой, с изменением к прошлому месяцу
  if (score && (views || totalClicks)) {
    cards.push(scoreHtml(score.cur, {
      prevTotal: score.hasPrev ? score.prev.total : null,
      note: score.hasPrev ? `За ${MONTHS[prevMonth.m - 1]} было ${score.prev.total}.` : "Как заведение работает с гостями: отзывы, оценки, жалобы, возвраты."
    }).replace('class="panel sc"', 'class="wr-card sc"'));
  }

  return `
  <style>${WRAPPED_CSS}${SCORE_CSS}</style>
  <header class="top">
    <div class="top-inner">
      <div class="brand">TapReview <span>· итоги месяца</span></div>
      <a class="back" href="/s/${token}">← Статистика</a>
      <nav class="wr-months" aria-label="Месяц">${nav}</nav>
    </div>
  </header>
  <main class="wrap wr">
    ${cards.join("")}
    <p class="wr-share">Сделайте скриншот и поделитесь с командой — это их результат 💛</p>
  </main>`;
}

const WRAPPED_CSS = `
  .wr { display: grid; gap: 12px; }
  .wr-months { display: flex; gap: 6px; margin-top: 12px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
  .wr-months::-webkit-scrollbar { display: none; }
  .wr-month { flex: none; padding: 6px 12px; border-radius: 999px; background: rgba(255,255,255,0.12); color: #fff;
    font-size: 13px; font-weight: 600; text-decoration: none; }
  .wr-month-on { background: var(--gold); color: var(--navy); }
  .wr-card { padding: 22px 20px; border-radius: 22px; background: #fff; box-shadow: 0 1px 2px rgba(20,26,43,0.04), 0 10px 30px rgba(20,26,43,0.06); }
  .wr-hero { background: linear-gradient(150deg, var(--navy) 0%, #071d42 70%); color: #fff; }
  .wr-gold { background: linear-gradient(160deg, #fffaf0, #fff 60%); box-shadow: 0 0 0 1px #f3dfa9 inset, 0 10px 30px rgba(20,26,43,0.06); }
  .wr-kicker { margin: 0 0 6px; font-size: 12px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: var(--gold); }
  .wr-title { margin: 0; font-size: 36px; font-weight: 800; line-height: 1.05; letter-spacing: -0.02em; }
  .wr-venue { margin: 6px 0 0; font-size: 16px; font-weight: 700; color: var(--gold-soft); }
  .wr-lead { margin: 12px 0 0; font-size: 14px; color: rgba(255,255,255,0.8); }
  .wr-big { margin: 0; font-size: 56px; font-weight: 800; line-height: 1; letter-spacing: -0.03em; color: var(--navy); }
  .wr-star { margin-left: 4px; font-size: 38px; color: var(--gold); }
  .wr-big-label { margin: 8px 0 0; font-size: 17px; font-weight: 700; line-height: 1.3; color: var(--text); }
  .wr-mid { margin: 0; font-size: 22px; font-weight: 800; line-height: 1.25; color: var(--navy); }
  .wr-delta { display: inline-block; margin: 12px 0 0; padding: 4px 10px; border-radius: 99px; background: var(--bg); font-size: 13px; font-weight: 700; color: var(--muted); }
  .wr-up { background: #e6f6ec; color: #18794e; }
  .wr-down { background: #fdecec; color: #b42318; }
  .wr-note { margin: 10px 0 0; font-size: 14px; line-height: 1.5; color: var(--muted); }
  .wr-note b { color: var(--text); }
  .wr-note a { color: var(--navy); font-weight: 700; }
  .wr-bars { margin: 14px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }
  .wr-bars li { display: grid; grid-template-columns: 110px 1fr 40px; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--muted); }
  .wr-bars b { text-align: right; color: var(--text); }
  .wr-track { height: 8px; border-radius: 99px; background: #f1ead8; overflow: hidden; }
  .wr-track span { display: block; height: 100%; border-radius: 99px; background: var(--gold); }
  .wr-week { display: flex; justify-content: space-between; align-items: flex-end; height: 92px; margin: 14px 0 0; padding: 0; list-style: none; }
  .wr-week li { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 12%; font-size: 12px; font-weight: 600; color: var(--muted); }
  .wr-col { display: block; width: 100%; border-radius: 6px; background: #dfe5f0; }
  .wr-col-on { color: var(--navy); }
  .wr-col-on .wr-col { background: var(--navy); }
  .wr-card.sc h2 { margin: 0 0 12px; font-size: 16px; font-weight: 700; }
  .wr-share { margin: 4px 0 8px; text-align: center; font-size: 13px; color: var(--muted); }
`;

// ---------- Telegram: 1-го числа короткие итоги прошлого месяца ----------

export async function monthlyWrapped(env, now = Date.now()) {
  if (new Date(now + MSK).getUTCDate() !== 1) return;
  const month = lastMonth(now);
  const subs = await db(env, "tg_subscribers?weekly_report=eq.true&select=chat_id,business_id&limit=1000");
  if (!subs.length) return;
  const ids = [...new Set(subs.map((s) => s.business_id))];
  const businesses = (await db(env, `businesses?id=in.(${ids.join(",")})&is_active=eq.true&select=id,name,paid_until,tariff`))
    .filter((b) => has(b, "wrapped"));
  const base = String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const texts = new Map();
  for (const b of businesses) {
    if (billingState(b.paid_until, now).state === "expired") continue;
    try {
      const [data, links, ctx] = await Promise.all([
        loadMonth(env, [b.id], month),
        db(env, `stats_links?or=(business_id.eq.${b.id},business_ids.cs.{${b.id}})&select=token&limit=1`),
        scoreContext(env, b.id, month.from, now).catch(() => null)
      ]);
      const score = ctx && Number(data.views)
        ? computeScore(data, { activeDays: activeDaysIn(ctx.daily, month.from, month.to), periodDays: daysBetween(month.from, month.to), hasBot: ctx.hasBot, hasMoment: ctx.hasMoment })
        : null;
      const clicks = Object.values(data.clicks || {}).reduce((s, n) => s + Number(n), 0);
      const r = data.ratings || {};
      const avg = Number(r.count) ? ` · ★ ${Number(r.avg).toLocaleString("ru-RU", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}` : "";
      const back = data.guests && Number(data.guests.returning) ? `\n🔁 Вернулись снова: ${num(data.guests.returning)}` : "";
      const link = links.length ? `\n\nВсе итоги — красиво, на одной странице:\n${base}/s/${links[0].token}/wrapped?m=${month.key}&b=${b.id}` : "";
      texts.set(b.id,
        `✨ <b>Итоги ${MONTHS_GEN[month.m - 1]}</b> · ${escTg(b.name)}\n\n` +
        `👀 Открыли страницу: <b>${num(data.views)}</b>\n⭐ Перешли оставить отзыв: <b>${num(clicks)}</b>${avg}${back}` +
        (score ? `\n📈 TapReview Score: <b>${score.total}</b> из 100 — ${score.level.toLowerCase()}` : "") + link);
    } catch (error) {
      console.error(`Monthly wrapped ${b.id}: ${error.message}`);
    }
  }
  let sent = 0;
  for (const sub of subs) {
    const text = texts.get(sub.business_id);
    if (!text) continue;
    try {
      await tg(env, "sendMessage", { chat_id: sub.chat_id, text, parse_mode: "HTML", disable_web_page_preview: true });
      sent++;
    } catch (error) {
      console.error(`Monthly wrapped to ${sub.chat_id}: ${error.message}`);
    }
  }
  console.log(`Monthly wrapped sent: ${sent}`);
}

function escTg(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
