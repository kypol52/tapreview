// Сотрудники и их оценки (миграция 043, модуль «Сервис в зале»).
//
//   Личная карта официанта (cards.staff_id): оценки и сообщения недовольных с неё — его.
//   На странице такой карты: «Вас обслуживает Анна» и кнопка «Оставить чаевые» на его ссылку (если задана).
//   Ссылка персонала /k/… привязана к сотруднику (staff_links.staff_id) — «Принял» на странице вызовов засчитывается ему.
//
// Защита от накруток: считаем только оценки с касания/скана карты (не по ссылке), с одного телефона — одна оценка
// в день на личной карте (rating.js), а пока оценок меньше MIN_RATINGS — вместо цифры «мало данных».
// Цифры видит только владелец (статистика /s/), персонал свой рейтинг не видит.
//
// Список ведут владелец («Настройки» → «Сотрудники») и админка (/api/admin/businesses/:id/staff).

import { db } from "./supabase.js";
import { esc } from "./stats-page.js";

export const STAFF_MAX = 50;
export const MIN_RATINGS = 10;
const NAME_MAX = 40;

export class StaffError extends Error {}

function cleanName(value) {
  const name = String(value ?? "").replace(/[\u0000-\u001F\u007F<>]/g, "").replace(/\s+/g, " ").trim();
  if (!name) throw new StaffError("Укажите имя сотрудника");
  if (name.length > NAME_MAX) throw new StaffError(`Имя — не длиннее ${NAME_MAX} символов`);
  return name;
}

function cleanTips(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new StaffError("Ссылка на чаевые должна начинаться с https://");
  }
  if (url.protocol !== "https:" || text.length > 2000) throw new StaffError("Ссылка на чаевые должна начинаться с https://");
  return url.href;
}

export function cleanStaff(input) {
  return { name: cleanName(input.name), tips_url: cleanTips(input.tips_url), is_active: input.is_active !== false };
}

// Сотрудники заведения + их личные карты
export async function listStaff(env, businessId) {
  const [staff, cards] = await Promise.all([
    db(env, `staff?business_id=eq.${businessId}&select=id,name,is_active,tips_url,created_at&order=is_active.desc,name.asc`),
    db(env, `cards?business_id=eq.${businessId}&staff_id=not.is.null&select=id,code,staff_id`)
  ]);
  return staff.map((s) => ({ ...s, cards: cards.filter((c) => c.staff_id === s.id).map((c) => ({ id: c.id, code: c.code })) }));
}

export async function createStaff(env, businessId, input) {
  const data = cleanStaff(input);
  const count = await db(env, `staff?business_id=eq.${businessId}&select=id`);
  if (count.length >= STAFF_MAX) throw new StaffError(`Не больше ${STAFF_MAX} сотрудников в заведении`);
  return (await db(env, "staff?select=id,name,is_active,tips_url,created_at", {
    method: "POST",
    body: { ...data, business_id: businessId },
    prefer: "return=representation"
  }))[0];
}

// businessId — только сотрудник этого заведения (для владельца); null — любой (админка)
export async function updateStaff(env, id, input, businessId = null) {
  const data = cleanStaff(input);
  const scope = businessId ? `&business_id=eq.${businessId}` : "";
  const rows = await db(env, `staff?id=eq.${id}${scope}&select=id,business_id,name,is_active,tips_url,created_at`, {
    method: "PATCH",
    body: data,
    prefer: "return=representation"
  });
  if (!rows.length) throw new StaffError("Сотрудник не найден");
  return rows[0];
}

// Личная карта сотрудника: карта должна быть этого же заведения. cardId = null — снять карту.
// У сотрудника одна личная карта; карта стола (is_table) личной быть не может.
export async function setStaffCard(env, businessId, staffId, cardId) {
  await db(env, `cards?business_id=eq.${businessId}&staff_id=eq.${staffId}`, { method: "PATCH", body: { staff_id: null }, prefer: "return=minimal" });
  if (!cardId) return;
  const rows = await db(env, `cards?id=eq.${cardId}&business_id=eq.${businessId}&select=id,is_table`);
  if (!rows.length) throw new StaffError("Карта не найдена в этом заведении");
  if (rows[0].is_table) throw new StaffError("Это карта стола — личной картой сотрудника она быть не может");
  await db(env, `cards?id=eq.${cardId}&business_id=eq.${businessId}`, { method: "PATCH", body: { staff_id: staffId }, prefer: "return=minimal" });
}

// Для страницы карты: работающий сотрудник этой карты или null
export async function staffOfCard(env, card) {
  if (!card || !card.staff_id) return null;
  const rows = await db(env, `staff?id=eq.${card.staff_id}&business_id=eq.${card.business_id}&is_active=is.true&select=id,name,tips_url&limit=1`).catch(() => []);
  return rows[0] || null;
}

// Кнопка «Оставить чаевые» на личной карте — на ссылку сотрудника (вместо общей ссылки заведения)
export function withStaffTips(business, staff) {
  if (!staff || !staff.tips_url) return business;
  const links = (Array.isArray(business.extra_links) ? business.extra_links : []).filter((l) => l && l.type !== "tips");
  return { ...business, extra_links: [{ type: "tips", url: staff.tips_url, label: `Чаевые — ${staff.name}` }, ...links].slice(0, 6) };
}

// ---------- Статистика владельцу ----------

// from, to — миллисекунды (report.js periodRange)
export async function staffStats(env, businessId, { from, to }) {
  const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());
  const range = `created_at=gte.${iso(from)}&created_at=lte.${iso(to)}`;
  const staff = await db(env, `staff?business_id=eq.${businessId}&select=id,name,is_active&order=name.asc`);
  if (!staff.length) return null;
  const [ratings, feedback, calls] = await Promise.all([
    db(env, `ratings?business_id=eq.${businessId}&staff_id=not.is.null&source=in.(nfc,qr)&${range}&select=staff_id,score,likes&limit=50000`),
    db(env, `feedback?business_id=eq.${businessId}&staff_id=not.is.null&${range}&select=staff_id&limit=50000`),
    db(env, `service_calls?business_id=eq.${businessId}&accepted_staff_id=not.is.null&${range}&select=accepted_staff_id,created_at,accepted_at&limit=50000`)
  ]);
  const rows = staff.map((s) => {
    const mine = ratings.filter((r) => r.staff_id === s.id);
    const waits = calls
      .filter((c) => c.accepted_staff_id === s.id && c.accepted_at)
      .map((c) => (Date.parse(c.accepted_at) - Date.parse(c.created_at)) / 1000)
      .sort((a, b) => a - b);
    return {
      id: s.id,
      name: s.name,
      active: s.is_active,
      count: mine.length,
      avg: mine.length ? mine.reduce((sum, r) => sum + r.score, 0) / mine.length : null,
      low: mine.filter((r) => r.score <= 3).length,
      service: mine.filter((r) => (r.likes || []).includes("service")).length,
      feedback: feedback.filter((f) => f.staff_id === s.id).length,
      calls: waits.length,
      median: waits.length ? waits[Math.floor(waits.length / 2)] : null
    };
  });
  // Уволенных без данных за период не показываем
  return rows.filter((r) => r.active || r.count || r.calls || r.feedback);
}

export function staffSection(rows) {
  if (!rows || !rows.length) return "";
  const fmt = (v) => v.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const time = (s) => (s === null ? "—" : s < 60 ? `${Math.round(s)} с` : `${Math.round(s / 60)} мин`);
  const items = rows
    .map((r) => {
      const score = r.count >= MIN_RATINGS
        ? `<b>${fmt(r.avg)} ★</b> · ${r.count} оценок${r.low ? ` · низких ${Math.round((r.low / r.count) * 100)}%` : ""}`
        : r.count
          ? `мало данных: ${r.count} из ${MIN_RATINGS} оценок`
          : "оценок пока нет";
      const extra = [
        r.service ? `«обслуживание» понравилось ${r.service}` : "",
        r.feedback ? `сообщений недовольных: ${r.feedback}` : "",
        r.calls ? `вызовов принял: ${r.calls}, реакция ${time(r.median)}` : ""
      ].filter(Boolean).join(" · ");
      return `<li class="staff-row"><p class="staff-name">${esc(r.name)}${r.active ? "" : " <span>(не работает)</span>"}</p>
        <p class="staff-score">${score}</p>${extra ? `<p class="staff-extra">${esc(extra)}</p>` : ""}</li>`;
    })
    .join("");
  return `
    <section class="panel">
      <h2>Сотрудники</h2>
      <style>.staff-list{list-style:none;margin:0;padding:0;display:grid;gap:10px}.staff-row{padding:12px 14px;border:1px solid #e3e7ef;border-radius:14px}
        .staff-name{margin:0;font-weight:700}.staff-name span{font-weight:400;color:#6b7280}.staff-score{margin:4px 0 0}.staff-extra{margin:4px 0 0;font-size:13px;color:#6b7280}</style>
      <ul class="staff-list">${items}</ul>
      <p class="staff-extra">Оценки с личных карт сотрудников — только касанием или сканом карты, не чаще одной в день с телефона.
        Средняя показывается с ${MIN_RATINGS} оценок. Эти цифры видите только вы.</p>
    </section>`;
}
