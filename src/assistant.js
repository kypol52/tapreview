// AI-ассистент владельца (миграция 048, модуль «AI-разбор отзывов»).
//
//   Владелец спрашивает обычным языком: на странице статистики «🤖 Спросить AI» (/s/ТОКЕН/ask) или в боте «/ask вопрос»
//   (только чаты с «Может управлять»). Код сначала собирает справку по заведению за 8 недель — по неделям, дням недели,
//   времени суток, причинам жалоб, сотрудникам, вызовам, заказам, баллам, гостям — и передаёт её YandexGPT Pro.
//   Модель отвечает только по справке; предложения с числами, которых в справке нет, выбрасываем (keepKnownNumbers).
//   Не больше QUESTIONS_PER_DAY вопросов в день на заведение.

import { db } from "./supabase.js";
import { aiOn, complete, keepKnownNumbers, maskPersonal, AI_PRO } from "./ai.js";
import { reasonLabels, LIKES } from "./rating.js";
import { hasModule } from "./tariffs.js";
import { html, esc, notFound, TOKEN_RE } from "./stats-page.js";

export const QUESTIONS_PER_DAY = 20;
const WEEKS = 8;
const MSK = 3 * 3600e3;
const DAY = 86400e3;
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
export const SUGGESTIONS = [
  "Почему изменилась оценка за последние недели?",
  "На что чаще всего жалуются гости?",
  "В какие дни и часы больше недовольных?",
  "Кто из сотрудников работает лучше и кому нужна помощь?",
  "Что улучшить, чтобы гости возвращались?"
];

const SYSTEM =
  "Ты — аналитик TapReview, помогаешь владельцу заведения разобраться в его цифрах. Отвечай по-русски, на «вы», " +
  "коротко и по делу: сначала прямой ответ, потом 1–3 конкретных совета. Опирайся только на СПРАВКУ. " +
  "Числа бери только из СПРАВКИ, не придумывай новых чисел, процентов, прогнозов и причин, которых нет в данных. " +
  "Если в справке нет данных для ответа — так и скажи и подскажи, что начать собирать. Без Markdown, до 900 символов.";

const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());
const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1);
const mskDay = (ms) => new Date(ms + MSK).toISOString().slice(0, 10);
const weekday = (ms) => (new Date(ms + MSK).getUTCDay() + 6) % 7;
const hourPart = (ms) => {
  const h = new Date(ms + MSK).getUTCHours();
  return h >= 6 && h < 12 ? "утро (6–12)" : h >= 12 && h < 17 ? "день (12–17)" : h >= 17 && h < 23 ? "вечер (17–23)" : "ночь (23–6)";
};

// Понедельник недели (МСК) для даты
function weekStart(ms) {
  const d = new Date(ms + MSK);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// Справка по заведению: текст с готовыми цифрами
export async function buildFacts(env, business, now = Date.now()) {
  const from = now - WEEKS * 7 * DAY;
  const range = `business_id=eq.${business.id}&created_at=gte.${iso(from)}`;
  const service = hasModule(business, "service");
  const [events, ratings, feedback, reviews, staff, calls, orders, levels] = await Promise.all([
    db(env, `click_events?${range}&select=event_type,source,created_at&limit=200000`).catch(() => []),
    db(env, `ratings?${range}&select=score,likes,staff_id,created_at&limit=100000`).catch(() => []),
    db(env, `feedback?${range}&select=score,reasons,ai_topics,text,resolved_at,staff_id,created_at&order=created_at.desc&limit=5000`).catch(() => []),
    db(env, `reviews?${range}&status=eq.published&select=score,created_at&limit=5000`).catch(() => []),
    service ? db(env, `staff?business_id=eq.${business.id}&select=id,name,is_active`).catch(() => []) : [],
    service ? db(env, `service_calls?${range}&select=kind,created_at,accepted_at,accepted_staff_id&limit=20000`).catch(() => []) : [],
    service ? db(env, `table_orders?${range}&select=items,total,upsell,created_at&limit=20000`).catch(() => []) : [],
    db(env, "rpc/guest_levels", { method: "POST", body: { p_ids: [business.id], p_vip: business.vip_visits || null, p_since: mskDay(now - 90 * DAY) } }).catch(() => null)
  ]);
  const labels = reasonLabels(business.category);
  const likeNames = Object.fromEntries(LIKES.map((l) => [l.key, l.label.toLowerCase()]));
  const lines = [`Заведение: ${business.name}. Данные за последние ${WEEKS} недель, время московское. Сегодня ${mskDay(now)}.`];

  // По неделям
  const weeks = new Map();
  const wk = (ms) => {
    const k = weekStart(ms);
    if (!weeks.has(k)) weeks.set(k, { views: 0, clicks: 0, ratings: [], low: 0, fb: 0, reasons: new Map() });
    return weeks.get(k);
  };
  for (let t = from; t <= now; t += 7 * DAY) wk(t);
  for (const e of events) {
    const w = wk(Date.parse(e.created_at));
    if (e.event_type === "page_view") w.views++;
    else if (e.event_type === "click") w.clicks++;
  }
  for (const r of ratings) {
    const w = wk(Date.parse(r.created_at));
    w.ratings.push(r.score);
    if (r.score <= 3) w.low++;
  }
  for (const f of feedback) {
    const w = wk(Date.parse(f.created_at));
    w.fb++;
    for (const k of new Set([...(f.reasons || []), ...(f.ai_topics || [])])) w.reasons.set(k, (w.reasons.get(k) || 0) + 1);
  }
  lines.push("", "ПО НЕДЕЛЯМ (неделя с понедельника: открыли страницу / перешли к отзыву / оценок / средняя / низких 1–3 / сообщений недовольных / главная причина):");
  for (const [k, w] of [...weeks.entries()].sort()) {
    const avg = w.ratings.length ? fmt(w.ratings.reduce((s, x) => s + x, 0) / w.ratings.length) : "—";
    const top = [...w.reasons.entries()].sort((a, b) => b[1] - a[1])[0];
    lines.push(`${k}: ${w.views} / ${w.clicks} / ${w.ratings.length} / ${avg} / ${w.low} / ${w.fb} / ${top ? `${labels[top[0]] || top[0]} (${top[1]})` : "—"}`);
  }

  // По дням недели и времени суток
  const byDay = WEEKDAYS.map(() => ({ n: 0, sum: 0, low: 0, fb: 0 }));
  const byPart = new Map();
  for (const r of ratings) {
    const d = byDay[weekday(Date.parse(r.created_at))];
    d.n++;
    d.sum += r.score;
    if (r.score <= 3) d.low++;
  }
  for (const f of feedback) {
    byDay[weekday(Date.parse(f.created_at))].fb++;
    const p = hourPart(Date.parse(f.created_at));
    byPart.set(p, (byPart.get(p) || 0) + 1);
  }
  lines.push("", "ПО ДНЯМ НЕДЕЛИ (оценок / средняя / низких / сообщений недовольных):");
  byDay.forEach((d, i) => lines.push(`${WEEKDAYS[i]}: ${d.n} / ${d.n ? fmt(d.sum / d.n) : "—"} / ${d.low} / ${d.fb}`));
  if (byPart.size) lines.push(`Сообщения недовольных по времени суток: ${[...byPart.entries()].map(([k, v]) => `${k} — ${v}`).join("; ")}.`);

  // Причины, «что понравилось», разобранные
  const reasons = new Map();
  for (const f of feedback) for (const k of new Set([...(f.reasons || []), ...(f.ai_topics || [])])) reasons.set(k, (reasons.get(k) || 0) + 1);
  const likes = new Map();
  for (const r of ratings) for (const k of r.likes || []) likes.set(k, (likes.get(k) || 0) + 1);
  lines.push("", `Всего оценок: ${ratings.length}; средняя ${ratings.length ? fmt(ratings.reduce((s, r) => s + r.score, 0) / ratings.length) : "—"}.`);
  lines.push(`Сообщений недовольных: ${feedback.length}; разобрано: ${feedback.filter((f) => f.resolved_at).length}.`);
  if (reasons.size) lines.push(`Причины недовольства за ${WEEKS} недель: ${[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${labels[k] || k} — ${v}`).join("; ")}.`);
  if (likes.size) lines.push(`Что отметили довольные гости: ${[...likes.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${likeNames[k] || k} — ${v}`).join("; ")}.`);
  if (reviews.length) lines.push(`Опубликованных отзывов в каталоге TapReview: ${reviews.length}, средняя ${fmt(reviews.reduce((s, r) => s + r.score, 0) / reviews.length)}.`);
  if (levels) lines.push(`Гости за 90 дней по визитам: новые ${levels.new}, постоянные (3+ визита) ${levels.regular}, VIP ${levels.vip}.`);

  // Сотрудники, вызовы, заказы
  if (staff.length) {
    lines.push("", "СОТРУДНИКИ (оценок с личной карты / средняя / сообщений недовольных / принял вызовов):");
    for (const s of staff) {
      const rs = ratings.filter((r) => r.staff_id === s.id);
      const fb = feedback.filter((f) => f.staff_id === s.id).length;
      const cs = calls.filter((c) => c.accepted_staff_id === s.id).length;
      if (!rs.length && !fb && !cs && !s.is_active) continue;
      lines.push(`${s.name}${s.is_active ? "" : " (не работает)"}: ${rs.length} / ${rs.length ? fmt(rs.reduce((a, r) => a + r.score, 0) / rs.length) : "—"} / ${fb} / ${cs}`);
    }
    lines.push("Средняя по сотруднику надёжна только от 10 оценок.");
  }
  if (calls.length) {
    const waits = calls.filter((c) => c.accepted_at).map((c) => (Date.parse(c.accepted_at) - Date.parse(c.created_at)) / 60e3).sort((a, b) => a - b);
    lines.push(`Вызовов персонала: ${calls.length}; принято ${waits.length}; обычное время реакции ${waits.length ? `${fmt(waits[Math.floor(waits.length / 2)])} мин` : "—"}.`);
  }
  if (orders.length) {
    const top = new Map();
    for (const o of orders) for (const l of o.items || []) top.set(l.name, (top.get(l.name) || 0) + l.qty);
    const sum = orders.reduce((s, o) => s + o.total, 0);
    lines.push(`Заказов со столов: ${orders.length} на ${sum} ₽, средний ${Math.round(sum / orders.length)} ₽; из рекомендаций добавили ${orders.reduce((s, o) => s + o.upsell, 0)} шт.; чаще заказывают: ${[...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, q]) => `${n} — ${q}`).join("; ")}.`);
  }

  // Последние сообщения недовольных — для смысла, без контактов
  const quotes = feedback.filter((f) => f.text).slice(0, 20)
    .map((f) => `— ${mskDay(Date.parse(f.created_at))}, ${f.score}★: ${maskPersonal(f.text).slice(0, 200)}`);
  if (quotes.length) lines.push("", "ПОСЛЕДНИЕ СООБЩЕНИЯ НЕДОВОЛЬНЫХ:", ...quotes);
  return lines.join("\n");
}

// → { answer } | { error }
export async function askAssistant(env, business, question, source = "web", now = Date.now()) {
  const q = String(question || "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  if (q.length < 3) return { error: "Напишите вопрос" };
  if (!aiOn(env, business)) return { error: "AI-ассистент — в модуле «AI-разбор отзывов». Чтобы подключить, напишите в TapReview." };
  const today = new Date(`${mskDay(now)}T00:00:00+03:00`).toISOString();
  const asked = await db(env, `ai_questions?business_id=eq.${business.id}&created_at=gte.${encodeURIComponent(today)}&select=id`);
  if (asked.length >= QUESTIONS_PER_DAY) return { error: `Сегодня уже ${QUESTIONS_PER_DAY} вопросов — это лимит на день. Спросите завтра.` };
  const facts = await buildFacts(env, business, now);
  const answer = await complete(env, {
    model: AI_PRO,
    system: SYSTEM,
    user: `СПРАВКА:\n${facts}\n\nВОПРОС ВЛАДЕЛЬЦА: ${maskPersonal(q)}`,
    maxTokens: 700,
    temperature: 0.2,
    businessId: business.id,
    kind: "ask"
  });
  if (!answer) return { error: "AI сейчас не отвечает. Попробуйте через пару минут." };
  // Разрешённые числа: из справки и вопроса, даты недель в виде «02.11» и небольшие числа до 12 («2–3 совета», «в 9 утра»)
  const dates = [...facts.matchAll(/\d{4}-(\d{2})-(\d{2})/g)].map((m) => `${m[2]}.${m[1]} ${Number(m[2])}`).join(" ");
  const small = Array.from({ length: 13 }, (_, i) => i).join(" ");
  const clean = keepKnownNumbers(answer.replace(/[*#_`]/g, ""), `${facts}\n${q}\n${dates}\n${small}`).slice(0, 2500) ||
    "Не получилось ответить по вашим данным — попробуйте задать вопрос иначе.";
  await db(env, "ai_questions", { method: "POST", body: { business_id: business.id, question: q, answer: clean, source }, prefer: "return=minimal" }).catch(() => {});
  return { answer: clean };
}

// ---------- /s/ТОКЕН/ask ----------

export async function handleAsk(request, env, token) {
  try {
    if (!TOKEN_RE.test(token)) return notFound();
    const links = await db(env, `stats_links?token=eq.${token}&select=business_id,business_ids`);
    if (!links.length) return notFound();
    const ids = [...new Set(links[0].business_ids && links[0].business_ids.length ? links[0].business_ids : [links[0].business_id])];
    const url = new URL(request.url);
    const form = request.method === "POST" ? new URLSearchParams((await request.text()).slice(0, 2000)) : url.searchParams;
    const wanted = Number(form.get("b")) || (ids.length === 1 ? ids[0] : null);
    if (wanted && !ids.includes(wanted)) return notFound();
    const venues = await db(env, `businesses?id=in.(${ids.join(",")})&select=id,name,category,modules,vip_visits&order=name.asc`);
    const withAi = venues.filter((v) => aiOn(env, v));
    const business = withAi.find((v) => v.id === wanted) || (withAi.length === 1 ? withAi[0] : null);
    const head = (sub) => `
  <header class="top">
    <div class="top-inner">
      <div class="brand">TapReview <span>· AI-ассистент</span></div>
      <a class="back" href="/s/${token}${business && ids.length > 1 ? `?b=${business.id}` : ""}">← Статистика</a>
      <h1 class="name">Спросить AI</h1>
      ${sub ? `<p class="sub">${esc(sub)}</p>` : ""}
      <p class="range">Отвечает по цифрам вашего заведения за ${WEEKS} недель. Не больше ${QUESTIONS_PER_DAY} вопросов в день.</p>
    </div>
  </header>`;
    if (!withAi.length) {
      return html(200, "Спросить AI", `${head("")}<main class="wrap"><section class="panel"><p>AI-ассистент — в модуле «AI-разбор отзывов». Чтобы подключить, напишите в TapReview.</p></section></main>`);
    }
    if (!business) {
      return html(200, "Спросить AI", `${head("Выберите заведение")}<main class="wrap"><section class="panel"><ul class="set-venues">${withAi
        .map((v) => `<li><a class="set-venue" href="/s/${token}/ask?b=${v.id}">${esc(v.name)} →</a></li>`).join("")}</ul></section></main>`);
    }

    let result = "";
    const question = String(form.get("q") || "");
    if (request.method === "POST" && question) {
      const r = await askAssistant(env, business, question, "web");
      result = r.answer
        ? `<div class="ask-a"><p class="ask-q">${esc(question)}</p><p>${esc(r.answer).replace(/\n/g, "<br>")}</p></div>`
        : `<div class="desk-res desk-bad"><p>${esc(r.error)}</p></div>`;
    }
    const history = await db(env, `ai_questions?business_id=eq.${business.id}&select=question,answer,created_at&order=created_at.desc&limit=6`).catch(() => []);
    const past = (request.method === "POST" ? history.slice(1) : history)
      .map((h) => `<details class="ask-h"><summary>${esc(h.question)}</summary><p>${esc(h.answer || "").replace(/\n/g, "<br>")}</p></details>`).join("");
    const chips = SUGGESTIONS.map((s) => `<button class="ask-chip" type="submit" name="q" value="${esc(s)}">${esc(s)}</button>`).join("");
    const body = `${head(business.name)}
  <main class="wrap">
    <style>
      .ask-form{display:grid;gap:10px}.ask-form textarea{padding:12px;border-radius:14px;border:1px solid #d6dbe5;font:inherit;font-size:16px}
      .ask-form>button{padding:14px;border-radius:999px;border:0;background:#0a2a5c;color:#fff;font:inherit;font-weight:700;cursor:pointer}
      .ask-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.ask-chip{padding:8px 12px;border-radius:999px;border:1px solid #d6dbe5;background:#f5f7fb;font:inherit;font-size:13px;cursor:pointer;text-align:left}
      .ask-a{margin-top:14px;padding:14px;border-radius:14px;background:#f2f6ff;line-height:1.5}.ask-q{margin:0 0 8px;font-weight:700}
      .ask-h{margin-top:8px;padding:10px 12px;border-radius:12px;background:#f5f7fb}.ask-h summary{cursor:pointer;font-weight:600}
    </style>
    <section class="panel">
      <form class="ask-form" method="post" action="/s/${token}/ask">
        <input type="hidden" name="b" value="${business.id}">
        <textarea name="q" rows="3" maxlength="300" placeholder="Например: почему в пятницу больше недовольных?" aria-label="Ваш вопрос"></textarea>
        <button type="submit">Спросить</button>
      </form>
      <form method="post" action="/s/${token}/ask"><input type="hidden" name="b" value="${business.id}"><div class="ask-chips">${chips}</div></form>
      ${result}
    </section>
    ${past ? `<section class="panel"><h2>Недавние вопросы</h2>${past}</section>` : ""}
    <section class="note"><p>Ассистент видит только обезличенные цифры и тексты жалоб без телефонов и почты. Числа в ответе — из ваших данных:
      если модель пытается назвать число, которого в данных нет, мы его убираем. Ответ готовится 10–20 секунд.</p></section>
  </main>`;
    return html(200, "Спросить AI", body);
  } catch (error) {
    console.error(`Ask error: ${error.message}\n${error.stack}`);
    return html(500, "Ошибка", `<main class="wrap wrap-center"><section class="panel"><h1 class="lost">Не получилось</h1><p>Попробуйте ещё раз через минуту.</p></section></main>`);
  }
}
