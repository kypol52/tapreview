// TapReview Score — насколько хорошо заведение работает с гостями, от 0 до 100.
// Считается за период (в статистике — последние 30 дней, в «Итогах месяца» — за месяц) из тех же цифр,
// что и «Итоги месяца» (wrapped_month, миграция 029), плюс открытия по дням (stats_daily).
//
// Из чего складывается (максимум 100):
//   Отзывы             30 — сколько гостей из открывших страницу перешли оставить отзыв (цель — 30%)
//   (без единого открытия страницы «нейтральных» баллов нет — счёт 0 + «Связь с гостями»)
//   Оценка гостей      20 — средняя оценка: 3,0 → 0, 4,8 и выше → 20 (меньше 5 оценок — половина баллов)
//   Ответ на жалобы    15 — доля сообщений недовольных гостей, отмеченных «Разобрано» (жалоб нет — полный балл)
//   Постоянные гости   15 — доля вернувшихся гостей (цель — 25%; меньше 10 гостей — половина баллов)
//   Регулярность       10 — в сколько дней периода карту открывали (цель — 70% дней)
//   Связь с гостями    10 — подключён Telegram-бот (5) и заполнено «Сейчас у нас» (5)

import { db } from "./supabase.js";

const DAY = 86400000;

const LEVELS = [
  { min: 90, label: "Высший класс", tone: "top" },
  { min: 70, label: "Отлично", tone: "good" },
  { min: 40, label: "Хорошо", tone: "ok" },
  { min: 0, label: "Есть куда расти", tone: "low" }
];

const clamp = (x) => Math.max(0, Math.min(1, x));
const pct = (x) => `${Math.round(x * 100)}%`;

// data — ответ wrapped_month; activeDays — дней с открытиями; periodDays — дней в периоде
export function computeScore(data, { activeDays, periodDays, hasBot, hasMoment }) {
  const views = Number(data.views) || 0;
  const clicks = Object.values(data.clicks || {}).reduce((s, n) => s + Number(n), 0);
  const r = data.ratings || {};
  const f = data.feedback || {};
  const g = data.guests || {};
  const parts = [];
  // «Нейтральные» баллы (мало оценок, жалоб нет, мало гостей) — только если страницу вообще открывали
  const active = views > 0;

  const conv = views ? clicks / views : 0;
  parts.push({
    key: "reviews", label: "Отзывы", max: 30,
    points: Math.round(clamp(conv / 0.3) * 30),
    value: views ? `${pct(conv)} открывших перешли к отзыву` : "страницу не открывали",
    tip: "Пусть персонал предлагает приложить телефон к карте в конце визита, когда гость доволен."
  });

  const count = Number(r.count) || 0;
  const avg = Number(r.avg) || 0;
  parts.push({
    key: "rating", label: "Оценка гостей", max: 20,
    points: count < 5 ? (active ? 10 : 0) : Math.round(clamp((avg - 3) / 1.8) * 20),
    value: count < 5 ? `мало оценок (${count})` : `средняя ${avg.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ★`,
    tip: "Загляните в «Что нравится гостям» и в сообщения недовольных — там видно, что улучшить."
  });

  const fbCount = Number(f.count) || 0;
  const resolved = Number(f.resolved) || 0;
  parts.push({
    key: "feedback", label: "Ответ на жалобы", max: 15,
    points: fbCount ? Math.round((resolved / fbCount) * 15) : active ? 15 : 0,
    value: fbCount ? `разобрано ${resolved} из ${fbCount}` : "жалоб не было",
    tip: "Свяжитесь с недовольным гостем и отметьте сообщение «Разобрано» в статистике."
  });

  const guests = Number(g.guests) || 0;
  const returning = Number(g.returning) || 0;
  parts.push({
    key: "loyal", label: "Постоянные гости", max: 15,
    points: guests < 10 ? (active ? 7 : 0) : Math.round(clamp(returning / guests / 0.25) * 15),
    value: guests < 10 ? "пока мало данных" : `вернулись ${pct(returning / guests)} гостей`,
    tip: "Включите подарок на следующий визит и штампы — это повод вернуться."
  });

  const share = periodDays ? activeDays / periodDays : 0;
  parts.push({
    key: "steady", label: "Регулярность", max: 10,
    points: Math.round(clamp(share / 0.7) * 10),
    value: `карту открывали ${activeDays} из ${periodDays} дней`,
    tip: "Карты должны стоять на видных местах каждый день — на столах, у кассы, на выходе."
  });

  parts.push({
    key: "touch", label: "Связь с гостями", max: 10,
    points: (hasBot ? 5 : 0) + (hasMoment ? 5 : 0),
    value: [hasBot ? "бот подключён" : "бот не подключён", hasMoment ? "есть «Сейчас у нас»" : "нет «Сейчас у нас»"].join(", "),
    tip: hasBot ? "Расскажите гостям о новинках в блоке «Сейчас у нас» (вкладка «Настройки»)." : "Подключите Telegram-бота, чтобы узнавать о жалобах сразу."
  });

  const total = parts.reduce((s, p) => s + p.points, 0);
  const level = LEVELS.find((l) => total >= l.min);
  return { total, level: level.label, tone: level.tone, parts };
}

function momentActive(moment, now) {
  if (!moment || (!moment.title && !moment.text)) return false;
  const today = new Date(now + 3 * 3600 * 1000).toISOString().slice(0, 10);
  return !(moment.to && today > moment.to);
}

// Дни (МСК) с открытиями внутри [from, to): rows из stats_daily
export function activeDaysIn(rows, from, to) {
  const a = new Date(from + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const b = new Date(to + 3 * 3600 * 1000).toISOString().slice(0, 10);
  return new Set(rows.filter((r) => r.event_type === "page_view" && Number(r.events) && r.day >= a && r.day < b).map((r) => r.day)).size;
}

export function daysBetween(from, to) {
  return Math.max(1, Math.round((to - from) / DAY));
}

// Всё для одного заведения: daily и «связь» загружаем здесь; data (wrapped_month) — по запросу
export async function scoreContext(env, businessId, from, now = Date.now()) {
  const [daily, subs, rows] = await Promise.all([
    db(env, "rpc/stats_daily", {
      method: "POST",
      body: { p_business_ids: [businessId], p_card_id: null, p_from: new Date(from).toISOString(), p_tz: "Europe/Moscow" }
    }),
    db(env, `tg_subscribers?business_id=eq.${businessId}&select=chat_id&limit=1`),
    db(env, `businesses?id=eq.${businessId}&select=moment`)
  ]);
  return { daily, hasBot: subs.length > 0, hasMoment: momentActive(rows[0] && rows[0].moment, now) };
}

// Последние 30 дней — для страницы статистики
export async function recentScore(env, businessId, now = Date.now()) {
  const from = now - 30 * DAY;
  const [data, ctx] = await Promise.all([
    db(env, "rpc/wrapped_month", {
      method: "POST",
      body: { p_ids: [businessId], p_from: new Date(from).toISOString(), p_to: new Date(now).toISOString() }
    }),
    scoreContext(env, businessId, from, now)
  ]);
  return computeScore(data || {}, {
    activeDays: activeDaysIn(ctx.daily, from, now + DAY),
    periodDays: 30,
    hasBot: ctx.hasBot,
    hasMoment: ctx.hasMoment
  });
}

// Блок для страниц владельца (статистика и «Итоги месяца»); prev — счёт прошлого периода (необязательно)
export function scoreHtml(score, { prevTotal = null, title = "TapReview Score", note = "" } = {}) {
  const deg = Math.round((score.total / 100) * 360);
  const diff = prevTotal === null ? "" : score.total - prevTotal;
  const trend = prevTotal === null || diff === 0
    ? ""
    : `<span class="sc-trend ${diff > 0 ? "sc-up" : "sc-down"}">${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)}</span>`;
  // Две самые «проседающие» части — с советом, что сделать
  const weak = score.parts
    .filter((p) => p.points < p.max)
    .sort((a, b) => a.points / a.max - b.points / b.max)
    .slice(0, 2)
    .map((p) => p.key);
  const rows = score.parts
    .map((p) => `
      <li class="sc-row">
        <div class="sc-row-head"><span>${p.label}</span><b>${p.points}<small> / ${p.max}</small></b></div>
        <span class="sc-track"><span style="width:${Math.round((p.points / p.max) * 100)}%"></span></span>
        <p class="sc-value">${p.value}</p>
        ${weak.includes(p.key) ? `<p class="sc-tip">💡 ${p.tip}</p>` : ""}
      </li>`)
    .join("");
  return `
    <section class="panel sc">
      <h2>${title}</h2>
      <div class="sc-head">
        <div class="sc-ring sc-${score.tone}" style="background: conic-gradient(var(--sc-color) ${deg}deg, #eef1f6 ${deg}deg)">
          <div class="sc-ring-in"><b>${score.total}</b><span>из 100</span></div>
        </div>
        <div>
          <p class="sc-level sc-${score.tone}-text">${score.level} ${trend}</p>
          <p class="sc-sub">${note || "Как заведение работает с гостями: отзывы, оценки, жалобы, возвраты."}</p>
        </div>
      </div>
      <ul class="sc-rows">${rows}</ul>
    </section>`;
}

export const SCORE_CSS = `
  .sc-head { display: flex; align-items: center; gap: 16px; }
  .sc-ring { --sc-color: var(--gold); flex: none; display: grid; place-items: center; width: 96px; height: 96px; border-radius: 50%; }
  .sc-top { --sc-color: #18794e; } .sc-good { --sc-color: #2f9e5b; } .sc-ok { --sc-color: var(--gold); } .sc-low { --sc-color: #d9534f; }
  .sc-ring-in { display: grid; place-items: center; width: 78px; height: 78px; border-radius: 50%; background: #fff; line-height: 1; }
  .sc-ring-in b { font-size: 30px; font-weight: 800; color: var(--navy); }
  .sc-ring-in span { margin-top: -14px; font-size: 11px; color: var(--muted); }
  .sc-level { margin: 0; font-size: 20px; font-weight: 800; }
  .sc-top-text, .sc-good-text { color: #18794e; } .sc-ok-text { color: #8a6300; } .sc-low-text { color: #b42318; }
  .sc-sub { margin: 4px 0 0; font-size: 13px; line-height: 1.45; color: var(--muted); }
  .sc-trend { display: inline-block; margin-left: 6px; padding: 2px 8px; border-radius: 99px; font-size: 12px; vertical-align: 3px; }
  .sc-up { background: #e6f6ec; color: #18794e; } .sc-down { background: #fdecec; color: #b42318; }
  .sc-rows { margin: 16px 0 0; padding: 0; list-style: none; display: grid; gap: 12px; }
  .sc-row-head { display: flex; justify-content: space-between; font-size: 14px; font-weight: 700; }
  .sc-row-head small { font-weight: 600; color: var(--muted); }
  .sc-track { display: block; height: 7px; margin-top: 5px; border-radius: 99px; background: #eef1f6; overflow: hidden; }
  .sc-track span { display: block; height: 100%; border-radius: 99px; background: var(--navy); }
  .sc-value { margin: 4px 0 0; font-size: 12.5px; color: var(--muted); }
  .sc-tip { margin: 6px 0 0; padding: 8px 10px; border-radius: 10px; background: #fff7e0; color: #6b4a00; font-size: 12.5px; line-height: 1.45; }
`;
