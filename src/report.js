// Подсчёт статистики для владельца — общий для Telegram-бота (telegram.js)
// и страницы статистики по ссылке (stats-page.js), чтобы цифры везде совпадали.
//
// Периоды считаются по московскому времени, текущий день включается:
//   «Сегодня»  — с полуночи до сейчас;       сравнение — вчера с полуночи до этого же времени
//   «7 дней»   — сегодня и 6 дней до него;   сравнение — такой же отрезок неделей раньше
//   «30 дней»  — сегодня и 29 дней до него;  сравнение — такой же отрезок 30 днями раньше

import { db } from "./supabase.js";

const DAY = 24 * 60 * 60 * 1000;
const MSK_OFFSET = 3 * 60 * 60 * 1000; // Москва, без перехода на летнее время

export const PERIODS = {
  today: { days: 1, title: "Сегодня", compare: "со вчерашним днём к этому же времени", vs: "ко вчера" },
  week: { days: 7, title: "За 7 дней", compare: "с предыдущими 7 днями", vs: "к прошлым 7 дням" },
  month: { days: 30, title: "За 30 дней", compare: "с предыдущими 30 днями", vs: "к прошлым 30 дням" }
};

export const PLATFORMS = [
  { key: "yandex", label: "Яндекс Карты", short: "Яндекс" },
  { key: "google", label: "Google Карты", short: "Google" },
  { key: "twogis", label: "2ГИС", short: "2ГИС" }
];

export function periodRange(period, now) {
  const days = PERIODS[period].days;
  const dayStart = Math.floor((now + MSK_OFFSET) / DAY) * DAY - MSK_OFFSET;
  const from = dayStart - (days - 1) * DAY;
  return { from, to: now, prevFrom: from - days * DAY, prevTo: now - days * DAY };
}

function emptyTotals() {
  return { views: 0, nfc: 0, qr: 0, direct: 0, clicks: 0, yandex: 0, google: 0, twogis: 0 };
}

// Возвращает Map: id заведения → { id, name, period, range, cur, prev, cards: [{ name, views, clicks }] }
export async function loadReports(env, ids, period, now) {
  const range = periodRange(period, now);
  const iso = (ms) => new Date(ms).toISOString();
  const idList = ids.join(",");

  const [rows, businesses, cards] = await Promise.all([
    db(env, "rpc/business_report", {
      method: "POST",
      body: {
        p_business_ids: ids,
        p_from: iso(range.from),
        p_to: iso(range.to),
        p_prev_from: iso(range.prevFrom),
        p_prev_to: iso(range.prevTo)
      }
    }),
    db(env, `businesses?id=in.(${idList})&select=id,name`),
    db(env, `cards?business_id=in.(${idList})&select=id,code,label`)
  ]);

  const stats = new Map();
  for (const id of ids) stats.set(id, { cur: emptyTotals(), prev: emptyTotals(), cards: new Map() });

  for (const row of rows) {
    const s = stats.get(row.business_id);
    if (!s) continue;
    const n = Number(row.events);
    const t = row.is_current ? s.cur : s.prev;

    if (row.event_type === "page_view") {
      t.views += n;
      if (row.source in t) t[row.source] += n;
    } else if (row.event_type === "click") {
      t.clicks += n;
      if (row.destination in t) t[row.destination] += n;
    }

    if (row.is_current && row.card_id) {
      const c = s.cards.get(row.card_id) || { views: 0, clicks: 0 };
      if (row.event_type === "page_view") c.views += n;
      if (row.event_type === "click") c.clicks += n;
      s.cards.set(row.card_id, c);
    }
  }

  const cardNames = new Map(cards.map((c) => [c.id, c.label || formatCardCode(c.code)]));
  const result = new Map();
  for (const b of businesses) {
    const s = stats.get(b.id);
    const cardRows = [...s.cards.entries()]
      .filter(([id]) => cardNames.has(id))
      .map(([id, c]) => ({ name: cardNames.get(id), views: c.views, clicks: c.clicks }))
      .sort((a, b) => b.views - a.views || b.clicks - a.clicks);
    result.set(b.id, { id: b.id, name: b.name, period, range, cur: s.cur, prev: s.prev, cards: cardRows });
  }
  return result;
}

// По дням (для графика): [{ day: "2026-10-25", views, clicks }] — каждый день периода, включая пустые
export async function loadDaily(env, businessId, period, now) {
  const days = PERIODS[period].days;
  const rows = await db(env, "rpc/business_stats", {
    method: "POST",
    body: { p_business_id: businessId, p_days: days + 1, p_tz: "Europe/Moscow" }
  });

  const range = periodRange(period, now);
  const list = [];
  const byDay = new Map();
  for (let i = 0; i < days; i++) {
    const day = mskDate(range.from + i * DAY + MSK_OFFSET);
    const item = { day, views: 0, clicks: 0 };
    list.push(item);
    byDay.set(day, item);
  }
  for (const row of rows) {
    const item = byDay.get(row.day);
    if (!item) continue;
    if (row.event_type === "page_view") item.views += Number(row.events);
    if (row.event_type === "click") item.clicks += Number(row.events);
  }
  return list;
}

function mskDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatDateRange(period, range) {
  const fmt = (ms) =>
    new Date(ms).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });
  if (period === "today") return fmt(range.to);
  const from = fmt(range.from).split(" ");
  const to = fmt(range.to).split(" ");
  // «19 – 25 октября», а если месяцы разные — «26 сентября – 25 октября»
  return from[1] === to[1] ? `${from[0]} – ${to.join(" ")}` : `${from.join(" ")} – ${to.join(" ")}`;
}

export function formatCardCode(code) {
  return code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}
