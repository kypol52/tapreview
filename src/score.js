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
// Пока карту открыли меньше раз, общий счёт не показываем: на паре открытий он случайный и только путает
export const MIN_VIEWS = 20;
const times = (n) => (n % 10 === 1 && n % 100 !== 11 ? "раз" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "раза" : "раз");

// data — ответ wrapped_month; activeDays — дней с открытиями; periodDays — дней в периоде.
// Часть без данных (мало оценок, мало гостей) получает points: null — она не считается ни в плюс, ни в минус.
// total — доля набранных баллов среди частей с данными, от 0 до 100; null, если открытий меньше MIN_VIEWS
export function computeScore(data, { activeDays, periodDays, hasBot, hasMoment }) {
  const views = Number(data.views) || 0;
  const clicks = Object.values(data.clicks || {}).reduce((s, n) => s + Number(n), 0);
  const r = data.ratings || {};
  const f = data.feedback || {};
  const g = data.guests || {};
  const parts = [];

  const conv = views ? Math.min(1, clicks / views) : 0;
  parts.push({
    key: "reviews", label: "Переходы к отзыву", max: 30,
    points: views ? Math.round(clamp(conv / 0.3) * 30) : null,
    value: views
      ? `Карту открыли ${views} ${times(views)}, к форме отзыва на картах перешли ${clicks} ${times(clicks)} (${pct(conv)}). Цель — 30%.`
      : "Карту за это время ни разу не открывали.",
    tip: "Пусть персонал предлагает приложить телефон к карте в конце визита, когда гость доволен."
  });

  const count = Number(r.count) || 0;
  const avg = Number(r.avg) || 0;
  parts.push({
    key: "rating", label: "Оценка гостей", max: 20,
    points: count < 5 ? null : Math.round(clamp((avg - 3) / 1.8) * 20),
    value: count < 5
      ? `Оценок пока ${count} — нужно хотя бы 5, чтобы судить.`
      : `Средняя оценка ${avg.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ★ из 5 по ${count} оценкам.`,
    tip: "Загляните в «Что нравится гостям» и в сообщения недовольных — там видно, что улучшить."
  });

  const fbCount = Number(f.count) || 0;
  const resolved = Number(f.resolved) || 0;
  parts.push({
    key: "feedback", label: "Ответ недовольным", max: 15,
    // Нет сообщений при достаточном числе оценок — заслуженный полный балл; при паре оценок — ещё рано судить
    points: fbCount ? Math.round((resolved / fbCount) * 15) : count >= 5 ? 15 : null,
    value: fbCount
      ? `Недовольные написали ${fbCount} ${fbCount === 1 ? "сообщение" : fbCount < 5 ? "сообщения" : "сообщений"}, вы отметили «Разобрано» у ${resolved}.`
      : "Сообщений от недовольных гостей не было.",
    tip: "Свяжитесь с недовольным гостем и отметьте сообщение «Разобрано» в статистике."
  });

  const guests = Number(g.guests) || 0;
  const returning = Number(g.returning) || 0;
  parts.push({
    key: "loyal", label: "Возвращаются ли гости", max: 15,
    points: guests < 10 ? null : Math.round(clamp(returning / guests / 0.25) * 15),
    value: guests < 10
      ? `Разных гостей пока ${guests} — нужно хотя бы 10, чтобы считать возвраты.`
      : `Пришли снова ${returning} из ${guests} гостей (${pct(returning / guests)}). Цель — 25%.`,
    tip: "Включите подарок на следующий визит и штампы — это повод вернуться."
  });

  const share = periodDays ? activeDays / periodDays : 0;
  parts.push({
    key: "steady", label: "Карты на виду каждый день", max: 10,
    points: Math.round(clamp(share / 0.7) * 10),
    value: `Карту открывали в ${activeDays} из ${periodDays} дней.`,
    tip: "Карты должны стоять на видных местах каждый день — на столах, у кассы, на выходе."
  });

  parts.push({
    key: "touch", label: "Связь с гостями", max: 10,
    points: (hasBot ? 5 : 0) + (hasMoment ? 5 : 0),
    value: [hasBot ? "Telegram-бот подключён" : "Telegram-бот не подключён", hasMoment ? "блок «Сейчас у нас» заполнен" : "блок «Сейчас у нас» пустой"].join(", ") + ".",
    tip: hasBot ? "Расскажите гостям о новинках в блоке «Сейчас у нас» (вкладка «Настройки»)." : "Подключите Telegram-бота, чтобы узнавать о жалобах сразу."
  });

  const measured = parts.filter((p) => p.points !== null);
  const max = measured.reduce((s, p) => s + p.max, 0);
  const total = views >= MIN_VIEWS && max ? Math.round((measured.reduce((s, p) => s + p.points, 0) / max) * 100) : null;
  const level = total === null ? { label: "Мало данных", tone: "none" } : LEVELS.find((l) => total >= l.min);
  return { total, level: level.label, tone: level.tone, parts, views };
}

// Статус части словами — вместо «баллов из максимума», которые путают с числом гостей
function statusOf(p) {
  if (p.points === null) return { text: "Мало данных", cls: "st-none" };
  const k = p.points / p.max;
  if (k >= 0.8) return { text: "Отлично", cls: "st-good" };
  if (k >= 0.5) return { text: "Нормально", cls: "st-ok" };
  return { text: "Можно лучше", cls: "st-low" };
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
  const has = score.total !== null;
  const deg = has ? Math.round((score.total / 100) * 360) : 0;
  const diff = has && prevTotal !== null ? score.total - prevTotal : 0;
  const trend = !diff
    ? ""
    : `<span class="sc-trend ${diff > 0 ? "sc-up" : "sc-down"}">${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)}</span>`;
  // Две самые «проседающие» части с данными — с советом, что сделать
  const weak = score.parts
    .filter((p) => p.points !== null && p.points < p.max)
    .sort((a, b) => a.points / a.max - b.points / b.max)
    .slice(0, 2)
    .map((p) => p.key);
  const rows = score.parts
    .map((p) => {
      const st = statusOf(p);
      return `
      <li class="sc-row">
        <div class="sc-row-head"><span>${p.label}</span><b class="sc-st ${st.cls}">${st.text}</b></div>
        <p class="sc-value">${p.value}</p>
        ${weak.includes(p.key) ? `<p class="sc-tip">💡 ${p.tip}</p>` : ""}
      </li>`;
    })
    .join("");
  const sub = has
    ? note || "Оценка от 0 до 100: как заведение работает с гостями. Ниже — из чего она складывается."
    : `Общая оценка появится, когда карту откроют хотя бы ${MIN_VIEWS} раз — сейчас ${score.views || 0}. Ниже — что уже видно.`;
  return `
    <section class="panel sc">
      <h2>${title}</h2>
      <div class="sc-head">
        <div class="sc-ring sc-${score.tone}" style="background: conic-gradient(var(--sc-color) ${deg}deg, #eef1f6 ${deg}deg)">
          <div class="sc-ring-in">${has ? `<b>${score.total}</b><span>из 100</span>` : `<b class="sc-dash">—</b>`}</div>
        </div>
        <div>
          <p class="sc-level sc-${score.tone}-text">${score.level} ${trend}</p>
          <p class="sc-sub">${sub}</p>
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
  .sc-none { --sc-color: #c3cad8; } .sc-none-text { color: #4b5363; }
  .sc-dash { color: #8a91a1 !important; }
  .sc-sub { margin: 4px 0 0; font-size: 14px; line-height: 1.45; color: #4b5363; }
  .sc-trend { display: inline-block; margin-left: 6px; padding: 2px 8px; border-radius: 99px; font-size: 12px; vertical-align: 3px; }
  .sc-up { background: #e6f6ec; color: #18794e; } .sc-down { background: #fdecec; color: #b42318; }
  .sc-rows { margin: 16px 0 0; padding: 0; list-style: none; display: grid; gap: 0; }
  .sc-row { padding: 12px 0; border-top: 1px solid #eef1f6; }
  .sc-row-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 15px; font-weight: 700; color: var(--text); }
  .sc-st { flex: none; padding: 3px 10px; border-radius: 99px; font-size: 12.5px; font-weight: 700; }
  .st-good { background: #e6f6ec; color: #18794e; } .st-ok { background: #fff4d6; color: #8a6300; }
  .st-low { background: #fdecec; color: #b42318; } .st-none { background: #eef1f6; color: #5b6475; }
  .sc-value { margin: 5px 0 0; font-size: 14px; line-height: 1.45; color: #3f4757; }
  .sc-tip { margin: 8px 0 0; padding: 9px 11px; border-radius: 10px; background: #fff7e0; color: #6b4a00; font-size: 13.5px; line-height: 1.45; }
`;
