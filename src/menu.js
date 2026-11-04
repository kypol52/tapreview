// Меню и заказ со стола (миграция 047).
//
//   Меню (тариф от «Стандарта»): владелец вставляет список текстом —
//       # Кофе
//       Капучино — 250
//       * Раф лавандовый — 320 | На сливках, с сиропом лаванды     (* — «рекомендуем», после | — описание)
//     Фото, описание, «рекомендуем» и «нет в наличии» — у каждого блюда отдельно («Настройки» владельца).
//   GET /menu/:slug[?c=КОД&s=nfc|qr] — меню в оформлении заведения. С карты стола и модулем «Сервис в зале» — корзина:
//     +/− (маленький скрипт, без него — поля количества), «К этому часто берут» (блюда с «рекомендуем»), комментарий.
//   POST /table-order — заказ уходит персоналу: страница вызовов /k/…/calls (рядом с вызовами) и Telegram-чаты
//     с галочкой «Вызовы гостей». Без оплаты: гость платит официанту как обычно.
//   GET /table-order?c=КОД&s= — статус последнего заказа этого телефона за этим столом (обновляется сама, пока не приняли).
// Защита: только с cookie устройства и с карты стола, не больше ORDERS_PER_HOUR заказов с телефона в час,
// ORDERS_PER_10MIN на заведение, не больше 30 позиций и 20 штук каждой.

import { db } from "./supabase.js";
import { isBot } from "./analytics.js";
import { deviceFrom, visitorKeyOf } from "./guests.js";
import { has } from "./tariffs.js";
import { isExpired } from "./billing.js";
import { renderPage, escapeHtml, customDesign, DEFAULT_ACCENT } from "./public-page.js";
import { callsOn, placeOf } from "./service.js";
import { tg } from "./telegram.js";

export const MENU_MAX = 300;
const SLUG_RE = /^[A-Za-z0-9_-]{3,64}$/;
const CODE_RE = /^[A-Z0-9]{4,12}$/;
const ORDERS_PER_HOUR = 5;
const ORDERS_PER_10MIN = 60;
const MAX_QTY = 20;
const MAX_LINES = 30;
const ITEM_COLUMNS = "id,section,name,price,description,photo,recommended,available,position";

export class MenuError extends Error {}

// ---------- Текст ↔ меню ----------

// → { items: [{ section, name, price, description, recommended }], errors: ["строка 3: …"] }
export function parseMenu(text) {
  const items = [];
  const errors = [];
  let section = "";
  String(text || "").replace(/\r\n?/g, "\n").split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith("#")) {
      section = line.replace(/^#+/, "").trim().slice(0, 40);
      return;
    }
    let rest = line;
    let recommended = false;
    if (rest.startsWith("*")) {
      recommended = true;
      rest = rest.slice(1).trim();
    }
    let description = null;
    const bar = rest.indexOf("|");
    if (bar !== -1) {
      description = rest.slice(bar + 1).trim().slice(0, 200) || null;
      rest = rest.slice(0, bar).trim();
    }
    let price = null;
    const m = rest.match(/^(.*?)(?:\s*[—–:-]\s*|\s+)(\d[\d\s]{0,8})\s*(?:₽|р\.?|руб\.?)?$/i);
    if (m && m[1].trim()) {
      rest = m[1].trim();
      price = Number(m[2].replace(/\s/g, ""));
    }
    const name = rest.replace(/\s*[—–:-]\s*$/, "").trim();
    if (!name) return errors.push(`строка ${i + 1}: нет названия`);
    if (name.length > 80) return errors.push(`строка ${i + 1}: название длиннее 80 символов`);
    if (price !== null && (!Number.isInteger(price) || price > 1000000)) return errors.push(`строка ${i + 1}: странная цена`);
    items.push({ section, name, price, description, recommended });
  });
  if (items.length > MENU_MAX) errors.push(`не больше ${MENU_MAX} позиций`);
  return { items, errors };
}

export function menuToText(items) {
  let section = null;
  const lines = [];
  for (const it of items) {
    if (it.section !== section) {
      section = it.section;
      if (section) lines.push(lines.length ? `\n# ${section}` : `# ${section}`);
    }
    lines.push(`${it.recommended ? "* " : ""}${it.name}${it.price !== null && it.price !== undefined ? ` — ${it.price}` : ""}${it.description ? ` | ${it.description}` : ""}`);
  }
  return lines.join("\n");
}

export async function loadMenu(env, businessId) {
  return db(env, `menu_items?business_id=eq.${businessId}&select=${ITEM_COLUMNS}&order=position.asc,id.asc&limit=${MENU_MAX + 50}`);
}

// Сохранить список: совпавшие по разделу и названию позиции сохраняют фото и «в наличии», лишние удаляются
export async function saveMenuText(env, businessId, text) {
  const { items, errors } = parseMenu(text);
  if (errors.length) throw new MenuError(`Не получилось разобрать меню: ${errors.slice(0, 3).join("; ")}`);
  const existing = await loadMenu(env, businessId);
  const key = (it) => `${it.section}|${it.name}`.toLowerCase();
  const pool = new Map();
  for (const e of existing) pool.set(key(e), [...(pool.get(key(e)) || []), e]);
  const fresh = [];
  for (const [position, it] of items.entries()) {
    const match = (pool.get(key(it)) || []).shift();
    const data = { section: it.section, name: it.name, price: it.price, description: it.description, recommended: it.recommended, position };
    if (match) {
      const changed = Object.keys(data).some((k) => (match[k] ?? null) !== (data[k] ?? null));
      if (changed) await db(env, `menu_items?id=eq.${match.id}&business_id=eq.${businessId}`, { method: "PATCH", body: data, prefer: "return=minimal" });
    } else {
      fresh.push({ ...data, business_id: businessId });
    }
  }
  if (fresh.length) await db(env, "menu_items", { method: "POST", body: fresh, prefer: "return=minimal" });
  const gone = [...pool.values()].flat();
  if (gone.length) {
    await db(env, `menu_items?business_id=eq.${businessId}&id=in.(${gone.map((g) => g.id).join(",")})`, { method: "DELETE", prefer: "return=minimal" });
    const photos = gone.map((g) => g.photo).filter(Boolean);
    if (photos.length) await db(env, `media?id=in.(${photos.join(",")})`, { method: "DELETE", prefer: "return=minimal" }).catch(() => {});
  }
  return { count: items.length };
}

// Одно блюдо: фото, описание, «рекомендуем», «в наличии» — только позиции этого заведения
export async function updateMenuItem(env, businessId, itemId, patch) {
  const body = {};
  if ("description" in patch) body.description = String(patch.description || "").trim().slice(0, 200) || null;
  if ("recommended" in patch) body.recommended = Boolean(patch.recommended);
  if ("available" in patch) body.available = Boolean(patch.available);
  if ("photo" in patch) body.photo = patch.photo || null;
  const rows = await db(env, `menu_items?id=eq.${itemId}&business_id=eq.${businessId}&select=id,photo`, { method: "GET" });
  if (!rows.length) throw new MenuError("Блюдо не найдено");
  await db(env, `menu_items?id=eq.${itemId}&business_id=eq.${businessId}`, { method: "PATCH", body, prefer: "return=minimal" });
  if ("photo" in patch && rows[0].photo && rows[0].photo !== body.photo) {
    await db(env, `media?id=eq.${rows[0].photo}`, { method: "DELETE", prefer: "return=minimal" }).catch(() => {});
  }
}

// «В наличии» сразу для всех: ids — те, что есть
export async function setAvailability(env, businessId, availableIds) {
  const items = await loadMenu(env, businessId);
  const on = new Set(availableIds.map(Number));
  for (const it of items) {
    if (it.available !== on.has(it.id)) {
      await db(env, `menu_items?id=eq.${it.id}&business_id=eq.${businessId}`, { method: "PATCH", body: { available: on.has(it.id) }, prefer: "return=minimal" });
    }
  }
}

export async function hasMenu(env, businessId) {
  const rows = await db(env, `menu_items?business_id=eq.${businessId}&select=id&limit=1`).catch(() => []);
  return rows.length > 0;
}

// ---------- Страница меню ----------

const BUSINESS_SELECT = "id,slug,name,tagline,category,theme,design,brand_color,paid_until,tariff,modules";

async function loadVenue(env, slug) {
  const rows = await db(env, `businesses?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=${BUSINESS_SELECT}&limit=1`);
  return rows[0] || null;
}

async function loadTableCard(env, code, businessId) {
  if (!CODE_RE.test(code)) return null;
  const rows = await db(env, `cards?code=eq.${code}&business_id=eq.${businessId}&is_active=is.true&select=id,code,label,is_table,business_id&limit=1`);
  return rows[0] || null;
}

function rub(n) {
  return `${Number(n).toLocaleString("ru-RU")} ₽`;
}

export async function handleMenuPage(request, env, slug) {
  try {
    if (!SLUG_RE.test(slug)) return infoPage(404, null, "Меню не найдено");
    const business = await loadVenue(env, slug);
    if (!business || !has(business, "menu") || isExpired(business.paid_until)) return infoPage(404, business, "Меню сейчас недоступно");
    const url = new URL(request.url);
    const source = url.searchParams.get("s") === "qr" ? "qr" : url.searchParams.get("s") === "nfc" ? "nfc" : "direct";
    const code = String(url.searchParams.get("c") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const card = code ? await loadTableCard(env, code, business.id) : null;
    const items = await loadMenu(env, business.id);
    if (!items.length) return infoPage(404, business, "Меню пока не заполнено");
    const ordering = !isBot(request) && callsOn(business, card, source);
    const back = card ? `/c/${card.code}${source !== "direct" ? `?s=${source}` : ""}` : `/b/${business.slug}${source !== "direct" ? `?s=${source}` : ""}`;
    return themed(business, {
      title: `Меню — ${business.name}`,
      body: menuBody(business, items, { ordering, card, source, back, empty: url.searchParams.get("e") === "1" }),
      script: ordering ? CART_SCRIPT : ""
    });
  } catch (error) {
    console.error(`Menu page error: ${error.message}\n${error.stack}`);
    return infoPage(500, null, "Меню временно недоступно");
  }
}

function menuBody(b, items, { ordering, card, source, back, empty }) {
  const sections = [];
  for (const it of items) {
    const last = sections[sections.length - 1];
    if (!last || last.name !== it.section) sections.push({ name: it.section, items: [it] });
    else last.items.push(it);
  }
  const recommended = items.filter((it) => it.recommended && it.available);
  const nav = sections.length > 1
    ? `<nav class="mn-nav">${sections.map((s, i) => `<a href="#s${i}">${escapeHtml(s.name || "Меню")}</a>`).join("")}</nav>`
    : "";
  const row = (it) => {
    const price = it.price !== null ? rub(it.price) : "по запросу";
    const qty = ordering && it.available
      ? `<div class="mn-qty" data-id="${it.id}" data-price="${it.price ?? 0}" data-name="${escapeHtml(it.name)}"${it.recommended ? " data-rec" : ""}>
          <button type="button" class="mn-minus" aria-label="Меньше">−</button>
          <input name="q${it.id}" type="number" min="0" max="${MAX_QTY}" value="0" inputmode="numeric" aria-label="Сколько: ${escapeHtml(it.name)}">
          <button type="button" class="mn-plus" aria-label="Больше">+</button>
        </div>`
      : "";
    return `<li class="mn-item${it.available ? "" : " mn-off"}">
        ${it.photo ? `<img class="mn-photo" src="/m/${it.photo}" alt="" loading="lazy">` : ""}
        <div class="mn-main">
          <p class="mn-name">${escapeHtml(it.name)}${it.recommended ? ` <span class="mn-rec">рекомендуем</span>` : ""}</p>
          ${it.description ? `<p class="mn-desc">${escapeHtml(it.description)}</p>` : ""}
          <p class="mn-price">${it.available ? price : "нет в наличии"}</p>
        </div>
        ${qty}
      </li>`;
  };
  const list = sections
    .map((s, i) => `<section class="mn-sec" id="s${i}">${s.name ? `<h2 class="mn-title">${escapeHtml(s.name)}</h2>` : ""}<ul class="mn-list">${s.items.map(row).join("")}</ul></section>`)
    .join("");
  const head = `
      <h1 class="name name-mid">${escapeHtml(b.name)}</h1>
      <p class="tagline">${card && ordering ? `Меню · ${escapeHtml(placeOf(card))}` : "Меню"}</p>
      <div class="divider"></div>`;
  if (!ordering) {
    return `${head}${nav}${list}<a class="mn-back" href="${escapeHtml(back)}">← На страницу заведения</a>`;
  }
  const upsell = recommended.length
    ? `<div class="mn-upsell" hidden><p class="mn-upsell-q">К этому часто берут</p><div class="mn-upsell-row"></div></div>`
    : "";
  return `${head}
      ${empty ? `<p class="fb-warn" role="alert">Выберите хотя бы одно блюдо.</p>` : ""}
      <form class="mn-form" method="post" action="/table-order">
        <input type="hidden" name="c" value="${escapeHtml(card.code)}">
        <input type="hidden" name="s" value="${escapeHtml(source)}">
        <input type="hidden" name="up" value="">
        <input class="fb-trap" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
        ${nav}${list}
        ${upsell}
        <label class="mn-comment">Комментарий (необязательно)<textarea name="comment" rows="2" maxlength="200" placeholder="Например: без сахара, принести сразу"></textarea></label>
        <div class="mn-bar">
          <span class="mn-total" aria-live="polite">Выберите блюда</span>
          <button class="mn-send" type="submit">Отправить официанту</button>
        </div>
        <p class="mn-note">Оплата — официанту, как обычно. Заказ увидит персонал заведения.</p>
      </form>
      <a class="mn-back" href="${escapeHtml(back)}">← На страницу стола</a>`;
}

export const MENU_CSS = `
  .mn-nav { display: flex; gap: 6px; overflow-x: auto; margin: 0 -4px 10px; padding: 2px 4px 6px; scrollbar-width: none; }
  .mn-nav a { flex: none; padding: 7px 12px; border-radius: 999px; border: 1px solid var(--btn-border); background: var(--btn-bg); color: var(--btn-text); font-size: 13px; font-weight: 600; text-decoration: none; }
  .mn-sec { text-align: left; margin: 8px 0 14px; scroll-margin-top: 10px; }
  .mn-title { margin: 14px 0 6px; font-size: 18px; }
  .mn-list { list-style: none; margin: 0; padding: 0; }
  .mn-item { display: flex; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--btn-border); }
  .mn-item:last-child { border-bottom: 0; }
  .mn-off { opacity: 0.5; }
  .mn-photo { width: 64px; height: 64px; flex: none; border-radius: 12px; object-fit: cover; }
  .mn-main { flex: 1; min-width: 0; }
  .mn-name { margin: 0; font-weight: 650; font-size: 15px; }
  .mn-rec { display: inline-block; margin-left: 4px; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; vertical-align: 1px;
    color: var(--text); background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .mn-desc { margin: 2px 0 0; color: var(--muted); font-size: 13px; line-height: 1.35; }
  .mn-price { margin: 4px 0 0; font-weight: 700; font-size: 14px; }
  .mn-qty { display: flex; align-items: center; gap: 4px; flex: none; }
  .mn-qty input { width: 42px; padding: 6px 2px; border-radius: 10px; border: 1px solid var(--btn-border); background: var(--btn-bg); color: var(--text); font: inherit; text-align: center; -moz-appearance: textfield; }
  .mn-qty input::-webkit-inner-spin-button { -webkit-appearance: none; }
  .mn-qty button { width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--btn-border); background: var(--btn-bg); color: var(--btn-text); font-size: 18px; line-height: 1; cursor: pointer; }
  .mn-qty.mn-in input { border-color: var(--accent); font-weight: 700; }
  .mn-upsell { margin: 6px 0 12px; padding: 12px; border-radius: 16px; border: 1px dashed var(--accent); text-align: left; }
  .mn-upsell-q { margin: 0 0 8px; font-weight: 700; font-size: 14px; }
  .mn-upsell-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .mn-upsell-row button { padding: 7px 12px; border-radius: 999px; border: 1px solid var(--btn-border); background: var(--btn-bg); color: var(--btn-text); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
  .mn-comment { display: grid; gap: 6px; margin: 10px 0; text-align: left; font-size: 14px; font-weight: 600; }
  .mn-comment textarea { padding: 10px 12px; border-radius: 14px; border: 1px solid var(--btn-border); background: var(--btn-bg); color: var(--text); font: inherit; font-size: 16px; }
  .mn-bar { position: sticky; bottom: 10px; display: flex; gap: 10px; align-items: center; justify-content: space-between; padding: 10px 10px 10px 16px;
    border-radius: 999px; background: var(--text); color: var(--card); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25); }
  .mn-total { font-weight: 700; font-size: 14px; white-space: nowrap; }
  .mn-send { flex: none; padding: 11px 16px; border-radius: 999px; border: 0; background: var(--accent); color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
  .mn-note { margin: 10px 0 0; color: var(--muted); font-size: 12px; }
  .mn-back { display: inline-block; margin-top: 14px; color: var(--muted); font-size: 14px; }
  .mn-lines { list-style: none; margin: 10px 0; padding: 0; text-align: left; }
  .mn-lines li { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--btn-border); font-size: 15px; }
  .mn-sum { margin: 8px 0 0; font-weight: 800; font-size: 18px; }
`;

// +/−, итог в полоске снизу, «К этому часто берут» — рекомендуемые блюда, которых ещё нет в заказе
const CART_SCRIPT = `(function () {
  var form = document.querySelector(".mn-form");
  if (!form) return;
  var boxes = [].slice.call(form.querySelectorAll(".mn-qty"));
  var total = form.querySelector(".mn-total");
  var up = form.querySelector('[name="up"]');
  var upsell = form.querySelector(".mn-upsell");
  var upRow = upsell && upsell.querySelector(".mn-upsell-row");
  var fromUpsell = {};
  function val(box) { var n = parseInt(box.querySelector("input").value, 10); return isNaN(n) ? 0 : Math.max(0, Math.min(${MAX_QTY}, n)); }
  function set(box, n) { box.querySelector("input").value = n; box.classList.toggle("mn-in", n > 0); }
  function render() {
    var count = 0, sum = 0;
    boxes.forEach(function (b) { var n = val(b); count += n; sum += n * Number(b.getAttribute("data-price")); });
    total.textContent = count ? count + " шт. · " + sum.toLocaleString("ru-RU") + " ₽" : "Выберите блюда";
    up.value = Object.keys(fromUpsell).join(",");
    if (!upsell) return;
    var offers = boxes.filter(function (b) { return b.hasAttribute("data-rec") && val(b) === 0; }).slice(0, 3);
    upsell.hidden = !count || !offers.length;
    upRow.innerHTML = "";
    offers.forEach(function (b) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "+ " + b.getAttribute("data-name");
      btn.addEventListener("click", function () { fromUpsell[b.getAttribute("data-id")] = 1; set(b, 1); render(); });
      upRow.appendChild(btn);
    });
  }
  boxes.forEach(function (b) {
    b.querySelector(".mn-plus").addEventListener("click", function () { set(b, Math.min(${MAX_QTY}, val(b) + 1)); render(); });
    b.querySelector(".mn-minus").addEventListener("click", function () { set(b, Math.max(0, val(b) - 1)); render(); });
    b.querySelector("input").addEventListener("input", render);
  });
  form.addEventListener("submit", function (e) {
    var count = boxes.reduce(function (s, b) { return s + val(b); }, 0);
    if (!count) { e.preventDefault(); total.textContent = "Сначала выберите блюда"; return; }
    form.querySelector(".mn-send").disabled = true;
  });
  render();
})();`;

// ---------- POST /table-order и GET /table-order ----------

export async function handleOrder(request, env, ctx) {
  try {
    if (isBot(request)) return infoPage(403, null, "Недоступно");
    const url = new URL(request.url);
    const form = request.method === "POST" ? new URLSearchParams((await request.text()).slice(0, 8000)) : url.searchParams;
    const code = String(form.get("c") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const source = form.get("s") === "qr" ? "qr" : "nfc";
    if (!CODE_RE.test(code)) return infoPage(404, null, "Откройте меню с карты на столе ещё раз");
    const cards = await db(env, `cards?code=eq.${code}&is_active=is.true&select=id,code,label,is_table,business_id&limit=1`);
    const card = cards[0];
    const business = card && card.business_id ? (await db(env, `businesses?id=eq.${card.business_id}&is_active=eq.true&select=${BUSINESS_SELECT}&limit=1`))[0] : null;
    if (!business || !has(business, "menu") || !callsOn(business, card, source) || isExpired(business.paid_until)) {
      return infoPage(404, business || null, "Заказ с этой карты сейчас недоступен. Обратитесь, пожалуйста, к персоналу.");
    }
    const menuUrl = `/menu/${business.slug}?c=${card.code}&s=${source}`;
    const { deviceId, setCookie } = deviceFrom(request);
    if (setCookie) return infoPage(400, business, "Коснитесь карты на столе ещё раз и откройте меню.", `/c/${card.code}?s=${source}`);
    const visitor = await visitorKeyOf(env, deviceId, business.id);
    const since = (ms) => encodeURIComponent(new Date(Date.now() - ms).toISOString());

    if (request.method !== "POST") {
      const last = (await db(env, `table_orders?card_id=eq.${card.id}&visitor_hash=eq.${visitor}&created_at=gt.${since(2 * 3600e3)}&select=id,items,total,comment,status&order=created_at.desc&limit=1`))[0];
      if (!last) return new Response(null, { status: 302, headers: { Location: menuUrl, "Cache-Control": "no-store" } });
      return statusPage(business, card, last, menuUrl);
    }

    if (String(form.get("website") || "").trim()) return new Response(null, { status: 303, headers: { Location: menuUrl } });
    const items = await loadMenu(env, business.id);
    const byId = new Map(items.map((it) => [it.id, it]));
    const upIds = new Set(String(form.get("up") || "").split(",").map(Number).filter(Boolean));
    const lines = [];
    let upsell = 0;
    for (const [k, v] of form.entries()) {
      const m = /^q(\d{1,18})$/.exec(k);
      if (!m) continue;
      const qty = Math.min(MAX_QTY, Math.max(0, parseInt(v, 10) || 0));
      const it = byId.get(Number(m[1]));
      if (!qty || !it || !it.available) continue;
      lines.push({ id: it.id, name: it.name, price: it.price, qty });
      if (upIds.has(it.id) && it.recommended) upsell += qty;
    }
    if (!lines.length) return new Response(null, { status: 303, headers: { Location: `${menuUrl}&e=1`, "Cache-Control": "no-store" } });
    if (lines.length > MAX_LINES) return infoPage(400, business, `Не больше ${MAX_LINES} позиций в одном заказе`, menuUrl);

    const [mine, all] = await Promise.all([
      db(env, `table_orders?business_id=eq.${business.id}&visitor_hash=eq.${visitor}&created_at=gt.${since(3600e3)}&select=id`),
      db(env, `table_orders?business_id=eq.${business.id}&created_at=gt.${since(600e3)}&select=id`)
    ]);
    if (mine.length >= ORDERS_PER_HOUR || all.length >= ORDERS_PER_10MIN) {
      return infoPage(429, business, "Слишком много заказов подряд. Подойдите, пожалуйста, к персоналу.", menuUrl);
    }
    const total = lines.reduce((s, l) => s + (l.price || 0) * l.qty, 0);
    const comment = String(form.get("comment") || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 200) || null;
    const place = placeOf(card);
    const rows = await db(env, "table_orders?select=id", {
      method: "POST",
      body: { business_id: business.id, card_id: card.id, place, items: lines, total, comment, upsell, visitor_hash: visitor },
      prefer: "return=representation"
    });
    ctx.waitUntil(notifyOrder(env, business, { place, lines, total, comment }));
    return new Response(null, { status: 303, headers: { Location: `/table-order?c=${card.code}&s=${source}`, "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`Order error: ${error.message}\n${error.stack}`);
    return infoPage(500, null, "Не получилось отправить заказ. Попробуйте ещё раз или подойдите к персоналу.");
  }
}

export function orderLinesText(lines) {
  return lines.map((l) => `${l.name} × ${l.qty}`).join(", ");
}

function statusPage(business, card, order, menuUrl) {
  const state = order.status === "accepted"
    ? `<p class="svc-state svc-state-ok">✓ Официант принял заказ</p>`
    : order.status === "done"
      ? `<p class="svc-state svc-state-ok">✓ Готово</p>`
      : `<p class="svc-state">Передали персоналу — скоро подойдут</p>`;
  const lines = (order.items || []).map((l) => `<li><span>${escapeHtml(l.name)} × ${l.qty}</span><span>${l.price !== null ? rub(l.price * l.qty) : "—"}</span></li>`).join("");
  return themed(business, {
    title: `Заказ — ${business.name}`,
    meta: order.status === "new" ? `<meta http-equiv="refresh" content="15">` : "",
    body: `
      <h1 class="name name-mid">${escapeHtml(business.name)}</h1>
      <p class="tagline">${escapeHtml(placeOf(card))}</p>
      <div class="divider"></div>
      <h2 class="thanks">Ваш заказ</h2>
      ${state}
      <ul class="mn-lines">${lines}</ul>
      <p class="mn-sum">Итого: ${rub(order.total)}</p>
      ${order.comment ? `<p class="lead">«${escapeHtml(order.comment)}»</p>` : ""}
      <p class="mn-note">Оплата — официанту, как обычно. Страница обновится сама, когда официант примет заказ.</p>
      <a class="mn-back" href="${escapeHtml(menuUrl)}">Заказать ещё</a><br>
      <a class="mn-back" href="/c/${escapeHtml(card.code)}">← На страницу стола</a>`
  });
}

async function notifyOrder(env, business, { place, lines, total, comment }) {
  try {
    const chats = await db(env, `tg_subscribers?business_id=eq.${business.id}&service_calls=is.true&select=chat_id`);
    if (!chats.length) return;
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const text = `🧾 <b>${esc(place)}</b> — заказ\n${lines.map((l) => `• ${esc(l.name)} × ${l.qty}`).join("\n")}\nИтого: <b>${rub(total)}</b>` +
      (comment ? `\n«${esc(comment)}»` : "") + `\n${esc(business.name)}`;
    await Promise.all(chats.map((c) => tg(env, "sendMessage", { chat_id: c.chat_id, text, parse_mode: "HTML" }).catch((e) => console.error(`Заказ в Telegram ${c.chat_id}: ${e.message}`))));
  } catch (error) {
    console.error(`Заказ в Telegram: ${error.message}`);
  }
}

// ---------- Оформление ----------

function themed(business, { status = 200, title, body, meta = "", script = "" }) {
  const response = renderPage({
    status,
    title,
    accent: business && /^#[0-9A-Fa-f]{6}$/.test(business.brand_color || "") ? business.brand_color : (business ? null : DEFAULT_ACCENT),
    theme: business ? business.theme : "classic",
    design: business ? customDesign(business) : null,
    extraCss: MENU_CSS + SVC_STATE_CSS,
    meta,
    script,
    footer: business ? { href: `/r/${business.slug}?s=card`, text: "Хочу такую карту" } : null,
    body
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

const SVC_STATE_CSS = `
  .svc-state { display: inline-block; margin-top: 4px; padding: 6px 14px; border-radius: 999px; font-size: 14px; font-weight: 600; background: var(--btn-bg); border: 1px solid var(--btn-border); }
  .svc-state-ok { border-color: #22a06b; color: #22a06b; }
`;

function infoPage(status, business, text, back = null) {
  return themed(business, {
    status,
    title: "Меню",
    body: `<h2 class="thanks">Меню</h2><p class="lead">${escapeHtml(text)}</p>${back ? `<a class="mn-back" href="${escapeHtml(back)}">← Назад</a>` : ""}`
  });
}

// ---------- Статистика владельцу ----------

export async function orderStats(env, ids, { from, to }) {
  const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());
  const rows = await db(env, `table_orders?business_id=in.(${ids.join(",")})&created_at=gte.${iso(from)}&created_at=lte.${iso(to)}&select=items,total,upsell&limit=20000`);
  if (!rows.length) return null;
  const top = new Map();
  for (const o of rows) for (const l of o.items || []) top.set(l.name, (top.get(l.name) || 0) + l.qty);
  const sum = rows.reduce((s, o) => s + o.total, 0);
  return {
    count: rows.length,
    sum,
    avg: Math.round(sum / rows.length),
    upsell: rows.reduce((s, o) => s + o.upsell, 0),
    top: [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  };
}

export function orderSection(s, esc) {
  if (!s) return "";
  const top = s.top.map(([name, n]) => `<tr><td>${esc(name)}</td><td>${n}</td></tr>`).join("");
  return `
    <section class="panel">
      <h2>Заказы со столов</h2>
      <div class="kpis desk-kpis">
        <div class="kpi"><div class="kpi-label">Заказов</div><div class="kpi-value">${s.count}</div></div>
        <div class="kpi"><div class="kpi-label">Средний заказ</div><div class="kpi-value">${rub(s.avg)}</div></div>
      </div>
      <p>Всего на ${rub(s.sum)}${s.upsell ? ` · из «К этому часто берут» добавили ${s.upsell} шт.` : ""}. Сумма — по ценам меню, без скидок и оплаты.</p>
      ${top ? `<table class="desk-table"><thead><tr><th>Чаще заказывают</th><th>Шт.</th></tr></thead><tbody>${top}</tbody></table>` : ""}
    </section>`;
}

// Раз в день: заказы старше 180 дней удаляем (как вызовы)
export async function purgeOldOrders(env) {
  const before = encodeURIComponent(new Date(Date.now() - 180 * 86400e3).toISOString());
  await db(env, `table_orders?created_at=lt.${before}`, { method: "DELETE", prefer: "return=minimal" });
}
