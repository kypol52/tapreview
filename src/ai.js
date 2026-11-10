// Модуль «AI-разбор отзывов» (миграция 046). Модели — YandexGPT в Yandex Cloud (данные остаются в России).
//
//   Разметка (YandexGPT Lite): каждое сообщение недовольного гостя и отзыв в Mini App → темы, тон, «срочно» и суть
//     одной фразой. Срочное (здоровье, безопасность, грубость, угрозы, обман) владелец видит в Telegram с пометкой 🔥.
//   Сводка недели (YandexGPT Pro): по понедельникам в отчёте и в статистике. Все цифры считает код и передаёт модели
//     готовыми; предложения с числами, которых нет в фактах, выбрасываем — придумать показатель модель не может.
//
// Перед отправкой из текста вырезаются телефоны, почта и ссылки. Нет ключа, модуль выключен, превышен лимит или
// Яндекс не ответил — всё работает как раньше, просто без разметки.
//
// Настройки сервера (/etc/tapreview.env): YC_API_KEY (ключ сервисного аккаунта с ролью ai.languageModels.user),
// YC_FOLDER_ID (каталог), AI_MONTHLY_TOKENS (лимит токенов в месяц, по умолчанию 3 000 000),
// AI_VENUE_MONTHLY_TOKENS (лимит на одно заведение, по умолчанию 300 000), YC_LLM_URL (для тестов).

import { db } from "./supabase.js";
import { hasModule } from "./tariffs.js";
import { reasonLabels } from "./rating.js";

const DEFAULT_URL = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion";
const LITE = "yandexgpt-lite";
const PRO = "yandexgpt";
export const AI_PRO = PRO;
// Ориентир цены за 1000 токенов, ₽ (прайс Yandex AI Studio, синхронный режим) — только для отчёта в админке
export const PRICE_PER_1K = { [LITE]: 0.2, [PRO]: 1.2 };
const TOPICS = ["wait", "quality", "service", "clean", "price", "other"];
const TONES = ["negative", "neutral", "positive"];
const TIMEOUT_MS = 15000;
let usageCache = null;
const venueCache = new Map();

export function aiConfigured(env) {
  return Boolean(env.YC_API_KEY && env.YC_FOLDER_ID);
}

export function aiOn(env, business) {
  return aiConfigured(env) && hasModule(business, "ai");
}

// Телефоны, почта, ссылки → [скрыто]: в AI не уходят ни контакты гостя, ни чужие
export function maskPersonal(text) {
  return String(text || "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[скрыто]")
    .replace(/(https?:\/\/|www\.)\S+/gi, "[скрыто]")
    .replace(/(\+?\d[\d\s()-]{8,}\d)/g, "[скрыто]")
    .slice(0, 1500);
}

function monthStart(now = Date.now()) {
  const d = new Date(now + 3 * 3600e3);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 3 * 3600e3).toISOString();
}

export async function monthUsage(env, now = Date.now()) {
  const rows = await db(env, `ai_usage?created_at=gte.${encodeURIComponent(monthStart(now))}&select=model,tokens_in,tokens_out,kind,ok&limit=200000`);
  const tokens = rows.reduce((s, r) => s + r.tokens_in + r.tokens_out, 0);
  const rub = rows.reduce((s, r) => s + ((r.tokens_in + r.tokens_out) / 1000) * (PRICE_PER_1K[r.model] || PRICE_PER_1K[PRO]), 0);
  return { tokens, rub, requests: rows.length, failed: rows.filter((r) => !r.ok).length, limit: Number(env.AI_MONTHLY_TOKENS) || 3000000 };
}

// Лимит токенов в месяц на одно заведение (AI_VENUE_MONTHLY_TOKENS, по умолчанию 300 000 ≈ 1 000 разборов и 4 сводки)
export function venueLimit(env) {
  return Number(env.AI_VENUE_MONTHLY_TOKENS) || 300000;
}

// Расход заведения за месяц; кэш на 5 минут, но свои запросы добавляем сразу (см. complete)
async function venueTokens(env, businessId) {
  const hit = venueCache.get(businessId);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.tokens;
  const rows = await db(env, `ai_usage?business_id=eq.${businessId}&created_at=gte.${encodeURIComponent(monthStart())}&select=tokens_in,tokens_out&limit=100000`).catch(() => null);
  if (!rows) return 0;
  const tokens = rows.reduce((s, r) => s + r.tokens_in + r.tokens_out, 0);
  venueCache.set(businessId, { at: Date.now(), tokens });
  return tokens;
}

// Один запрос к YandexGPT → текст ответа или null (ошибка, лимит, таймаут). Расход пишем в ai_usage.
export async function complete(env, { model, system, user, json = false, maxTokens = 400, temperature = 0.2, businessId = null, kind }) {
  if (!aiConfigured(env)) return null;
  // Расход за месяц проверяем не чаще раза в 5 минут
  if (!usageCache || Date.now() - usageCache.at > 5 * 60e3) {
    usageCache = { at: Date.now(), value: await monthUsage(env).catch(() => null) };
  }
  const usage = usageCache.value;
  if (usage && usage.tokens >= usage.limit) {
    console.error(`AI: месячный лимит ${usage.limit} токенов исчерпан`);
    return null;
  }
  // Свой лимит у каждого заведения: накрутка сообщений в одном не выключит AI остальным
  if (businessId && (await venueTokens(env, businessId)) >= venueLimit(env)) {
    console.error(`AI: лимит заведения ${businessId} на месяц исчерпан`);
    return null;
  }
  const body = {
    modelUri: `gpt://${env.YC_FOLDER_ID}/${model}/latest`,
    completionOptions: { stream: false, temperature, maxTokens: String(maxTokens) },
    messages: [{ role: "system", text: system }, { role: "user", text: user }]
  };
  if (json) body.jsonObject = true;
  let ok = false;
  let inTok = 0;
  let outTok = 0;
  try {
    const response = await fetch(env.YC_LLM_URL || DEFAULT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Api-Key ${env.YC_API_KEY}`, "x-folder-id": env.YC_FOLDER_ID },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error(`YandexGPT ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
    const result = data.result || data;
    inTok = Number(result.usage && result.usage.inputTextTokens) || 0;
    outTok = Number(result.usage && result.usage.completionTokens) || 0;
    const text = result.alternatives && result.alternatives[0] && result.alternatives[0].message && result.alternatives[0].message.text;
    if (!text) throw new Error("YandexGPT: пустой ответ");
    ok = true;
    return String(text);
  } catch (error) {
    console.error(`AI ${kind}: ${error.message}`);
    return null;
  } finally {
    const hit = businessId && venueCache.get(businessId);
    if (hit) hit.tokens += inTok + outTok;
    db(env, "ai_usage", {
      method: "POST",
      body: { business_id: businessId, kind, model, tokens_in: inTok, tokens_out: outTok, ok },
      prefer: "return=minimal"
    }).catch(() => {});
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

// Кнопка «Проверить ключ» в админке: короткий запрос к YandexGPT Lite → { ok, answer | error }
export async function aiPing(env) {
  if (!aiConfigured(env)) return { ok: false, error: "На сервере не заданы YC_API_KEY и YC_FOLDER_ID" };
  try {
    const response = await fetch(env.YC_LLM_URL || DEFAULT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Api-Key ${env.YC_API_KEY}`, "x-folder-id": env.YC_FOLDER_ID },
      body: JSON.stringify({
        modelUri: `gpt://${env.YC_FOLDER_ID}/${LITE}/latest`,
        completionOptions: { stream: false, temperature: 0, maxTokens: "10" },
        messages: [{ role: "user", text: "Ответь одним словом: готово" }]
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = (data && (data.message || (data.error && (data.error.message || data.error)))) || `код ${response.status}`;
      return { ok: false, error: `Яндекс ответил: ${String(message).slice(0, 300)}` };
    }
    const result = (data && (data.result || data)) || {};
    const text = result.alternatives && result.alternatives[0] && result.alternatives[0].message && result.alternatives[0].message.text;
    return text ? { ok: true, answer: String(text).slice(0, 100) } : { ok: false, error: "Пустой ответ от YandexGPT" };
  } catch (error) {
    return { ok: false, error: `Нет связи с YandexGPT: ${error.message}` };
  }
}

// ---------- Разметка одного текста ----------

const CLASSIFY_SYSTEM = `Ты помогаешь владельцу заведения разбирать отзывы гостей. Отвечай только JSON-объектом без пояснений.`;

export async function classifyText(env, { text, score = null, reasons = [], category = null, kind = "feedback", businessId = null }) {
  const clean = maskPersonal(text).trim();
  if (!clean && !reasons.length) return null;
  const labels = reasonLabels(category);
  const user = [
    `Тип: ${kind === "review" ? "публичный отзыв в каталоге" : "личное сообщение владельцу"}.`,
    score ? `Оценка гостя: ${score} из 5.` : "",
    reasons.length ? `Гость отметил: ${reasons.map((k) => labels[k]).filter(Boolean).join(", ")}.` : "",
    `Текст гостя: «${clean || "(без текста)"}»`,
    "",
    "Верни JSON:",
    `{"topics": [темы из списка: ${TOPICS.map((k) => `"${k}" — ${labels[k].toLowerCase()}`).join(", ")}; "atmosphere" не использовать],`,
    ` "tone": "negative" | "neutral" | "positive",`,
    ` "urgent": true только если есть риск для здоровья или безопасности (отравление, травма, аллергия, грязь на кухне), грубость или оскорбление гостя, дискриминация, угрозы, обман или кража; иначе false,`,
    ` "urgent_reason": "коротко почему срочно, иначе пустая строка",`,
    ` "note": "суть одной фразой до 120 символов, без имён и телефонов"}`
  ].filter((line) => line !== "").join("\n");
  const answer = await complete(env, { model: LITE, system: CLASSIFY_SYSTEM, user, json: true, maxTokens: 300, temperature: 0.1, businessId, kind: "classify" });
  const data = answer ? parseJson(answer) : null;
  if (!data || typeof data !== "object") return null;
  const topics = [...new Set((Array.isArray(data.topics) ? data.topics : []).filter((t) => TOPICS.includes(t)))];
  const tone = TONES.includes(data.tone) ? data.tone : null;
  const urgent = data.urgent === true;
  const why = urgent ? maskPersonal(String(data.urgent_reason || "")).trim().slice(0, 120) : "";
  const note = maskPersonal(String(data.note || "")).trim().slice(0, 200);
  return { topics, tone, urgent, urgentReason: why, note: [urgent && why ? `Срочно: ${why}.` : "", note].filter(Boolean).join(" ").slice(0, 300) };
}

export async function classifyFeedback(env, business, feedbackId, { text, score, reasons }) {
  if (!aiOn(env, business)) return null;
  const ai = await classifyText(env, { text, score, reasons, category: business.category, kind: "feedback", businessId: business.id });
  if (!ai) return null;
  await db(env, `feedback?id=eq.${feedbackId}`, {
    method: "PATCH",
    body: { ai_topics: ai.topics, ai_tone: ai.tone, ai_urgent: ai.urgent, ai_note: ai.note || null, ai_at: new Date().toISOString() },
    prefer: "return=minimal"
  }).catch((error) => console.error(`AI feedback #${feedbackId}: ${error.message}`));
  return ai;
}

// Отзыв в Mini App (app-api.js): размечаем, если у заведения модуль AI
export async function classifyReview(env, businessId, reviewId, { text, score }) {
  try {
    const rows = await db(env, `businesses?id=eq.${businessId}&select=id,category,modules,tariff&limit=1`);
    if (!rows.length || !aiOn(env, rows[0]) || !String(text || "").trim()) return null;
    const ai = await classifyText(env, { text, score, category: rows[0].category, kind: "review", businessId });
    if (!ai) return null;
    await db(env, `reviews?id=eq.${reviewId}`, {
      method: "PATCH",
      body: { ai_topics: ai.topics, ai_tone: ai.tone, ai_urgent: ai.urgent, ai_note: ai.note || null, ai_at: new Date().toISOString() },
      prefer: "return=minimal"
    });
    return ai;
  } catch (error) {
    console.error(`AI review #${reviewId}: ${error.message}`);
    return null;
  }
}

// ---------- Сводка недели ----------

const DIGEST_SYSTEM =
  "Ты аналитик сервиса для кафе, салонов и магазинов. Пишешь владельцу коротко и по делу, на «вы», по-русски. " +
  "Опирайся только на факты из сообщения. Любые числа бери только из блока ФАКТЫ — новых чисел, процентов и прогнозов не придумывай. " +
  "Если данных мало, так и скажи.";

// Все числа, которые есть в тексте (12, 4,5 → 4.5)
function numbersIn(text) {
  return (String(text).match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", "."));
}

// Выбрасываем предложения с числами, которых нет в фактах
export function keepKnownNumbers(text, facts) {
  const allowed = new Set(numbersIn(facts));
  return String(text)
    .split("\n")
    .map((line) => line
      .split(/(?<=[.!?…])\s+/)
      .filter((sentence) => numbersIn(sentence).every((n) => allowed.has(n)))
      .join(" ")
      .replace(/\s{2,}/g, " ")
      .trim())
    .filter(Boolean)
    .join("\n");
}

export async function weeklyDigest(env, business, now = Date.now()) {
  if (!aiOn(env, business)) return null;
  const from = new Date(now - 7 * 86400e3).toISOString();
  const range = `business_id=eq.${business.id}&created_at=gte.${encodeURIComponent(from)}`;
  const [ratings, feedback, reviews] = await Promise.all([
    db(env, `ratings?${range}&select=score,likes&limit=20000`),
    db(env, `feedback?${range}&select=score,text,reasons,ai_topics,ai_urgent&limit=2000`),
    db(env, `reviews?${range}&status=eq.published&select=score,text,ai_topics&limit=2000`)
  ]);
  if (!ratings.length && !feedback.length && !reviews.length) return null;
  const labels = reasonLabels(business.category);
  const topicCount = new Map();
  for (const f of feedback) for (const k of new Set([...(f.reasons || []), ...(f.ai_topics || [])])) topicCount.set(k, (topicCount.get(k) || 0) + 1);
  const likes = new Map();
  for (const r of ratings) for (const k of r.likes || []) likes.set(k, (likes.get(k) || 0) + 1);
  const avg = ratings.length ? (ratings.reduce((s, r) => s + r.score, 0) / ratings.length).toFixed(1) : null;
  const LIKE_NAMES = { food: "кухня", service: "обслуживание", vibe: "атмосфера", drinks: "напитки", price: "цены" };
  const facts = [
    `Заведение: ${business.name}. Период: последние 7 дней.`,
    `Оценок гостей: ${ratings.length}${avg ? `, средняя ${avg}` : ""}; из них низких (1–3): ${ratings.filter((r) => r.score <= 3).length}.`,
    `Сообщений недовольных владельцу: ${feedback.length}; срочных: ${feedback.filter((f) => f.ai_urgent).length}.`,
    topicCount.size ? `Темы жалоб: ${[...topicCount.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${labels[k] || k} — ${v}`).join("; ")}.` : "Тем жалоб нет.",
    likes.size ? `Что отметили довольные гости: ${[...likes.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${LIKE_NAMES[k] || k} — ${v}`).join("; ")}.` : "",
    `Опубликованных отзывов в каталоге: ${reviews.length}.`
  ].filter(Boolean).join("\n");
  const quotes = [
    ...feedback.filter((f) => f.text).slice(0, 25).map((f) => `— (жалоба, ${f.score}★) ${maskPersonal(f.text).slice(0, 250)}`),
    ...reviews.filter((r) => r.text).slice(0, 25).map((r) => `— (отзыв, ${r.score}★) ${maskPersonal(r.text).slice(0, 250)}`)
  ].join("\n");
  const user = `ФАКТЫ:\n${facts}\n\nТЕКСТЫ ГОСТЕЙ (без имён и контактов):\n${quotes || "(текстов нет)"}\n\n` +
    "Напиши для владельца разбор недели, до 700 символов, три коротких блока с заголовками: " +
    "«Что хорошо», «Что мешает», «Что сделать на этой неделе» (1–3 конкретных совета). Без приветствий и Markdown.";
  const answer = await complete(env, { model: PRO, system: DIGEST_SYSTEM, user, maxTokens: 600, temperature: 0.3, businessId: business.id, kind: "digest" });
  if (!answer) return null;
  const text = keepKnownNumbers(answer.replace(/[*#_`]/g, ""), facts).slice(0, 2000);
  if (!text) return null;
  const week = new Date(now + 3 * 3600e3);
  week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
  await db(env, "ai_digests?on_conflict=business_id,week_start", {
    method: "POST",
    body: { business_id: business.id, week_start: week.toISOString().slice(0, 10), text },
    prefer: "resolution=merge-duplicates,return=minimal"
  }).catch((error) => console.error(`AI digest save: ${error.message}`));
  return text;
}

// ---------- Статистика владельцу ----------

export async function aiStats(env, businessId, { from, to }) {
  const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());
  const range = `business_id=eq.${businessId}&created_at=gte.${iso(from)}&created_at=lte.${iso(to)}&ai_at=not.is.null`;
  const [feedback, reviews, digest] = await Promise.all([
    db(env, `feedback?${range}&select=ai_topics,ai_tone,ai_urgent,ai_note,created_at&order=created_at.desc&limit=5000`),
    db(env, `reviews?${range}&select=ai_topics,ai_tone,ai_urgent,ai_note,created_at&order=created_at.desc&limit=5000`),
    db(env, `ai_digests?business_id=eq.${businessId}&select=week_start,text&order=week_start.desc&limit=1`)
  ]);
  const all = [...feedback, ...reviews];
  const topics = new Map();
  const tones = { negative: 0, neutral: 0, positive: 0 };
  for (const r of all) {
    for (const k of r.ai_topics || []) topics.set(k, (topics.get(k) || 0) + 1);
    if (r.ai_tone) tones[r.ai_tone]++;
  }
  const urgent = all.filter((r) => r.ai_urgent).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 5);
  return { total: all.length, topics, tones, urgent, digest: digest[0] || null };
}
