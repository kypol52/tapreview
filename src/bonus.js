// Бонус для гостей: одноразовый код на следующий визит, обычный или с колесом призов.
//
// Правила площадок (Яндекс Карты, 2ГИС) запрещают вознаграждать за отзывы, поэтому бонус
// НЕ зависит от отзыва: кнопку видит каждый, кто отсканировал карту (NFC или QR), и она появляется
// через несколько секунд после открытия страницы — ниже кнопок отзывов.
//
// Защита от злоупотреблений:
//  - только при скане карты (?s=nfc / ?s=qr), по прямой ссылке кнопки нет;
//  - один бонус на устройство за bonus_cooldown_days (случайный id устройства в cookie,
//    в базе — только его хеш с секретом), повторный заход показывает тот же код;
//  - приз разыгрывает сервер, а не браузер;
//  - код одноразовый, действует со следующего визита, кассир гасит его на /s/ТОКЕН/bonus.
//
//   bonusBlock(business, source, cardCode) — кнопка на странице отзывов
//   POST /bonus                           — выдать код (и показать колесо)

import { db } from "./supabase.js";
import { isBot } from "./analytics.js";
import { renderPage, escapeHtml, GIFT, DEFAULT_ACCENT, BONUS_COLUMNS } from "./public-page.js";
import { isExpired } from "./billing.js";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // без 0/O, 1/I/L
const CODE_LENGTH = 6;
const DEVICE_COOKIE = "tr_device";
const DAY = 24 * 60 * 60 * 1000;
const MSK_OFFSET = 3 * 60 * 60 * 1000;
export const BONUS_DELAY_SECONDS = 10;

// Призы заведения: [{ label, weight }]. Для обычного бонуса — один приз из discount_text.
export function prizesOf(business) {
  if (business.bonus_mode === "wheel") {
    const list = Array.isArray(business.bonus_prizes) ? business.bonus_prizes : [];
    return list
      .map((p) => ({ label: String(p.label || "").trim().slice(0, 60), weight: Math.max(0, Number(p.weight) || 0) }))
      .filter((p) => p.label && p.weight > 0);
  }
  if (business.bonus_mode === "fixed") {
    return [{ label: String(business.discount_text || "Скидка на следующий визит").trim().slice(0, 60), weight: 1 }];
  }
  return [];
}

function bonusEnabled(business) {
  const prizes = prizesOf(business);
  return business.bonus_mode === "wheel" ? prizes.length >= 2 : prizes.length === 1;
}

// ---------- Кнопка на странице отзывов ----------

export function bonusBlock(business, source, cardCode) {
  if (!bonusEnabled(business) || (source !== "nfc" && source !== "qr")) return "";
  const wheel = business.bonus_mode === "wheel";
  // Обычная ссылка, а не форма: в РФ провайдеры иногда обрывают соединения с Cloudflare,
  // и обычный переход браузер сам повторяет, а отправку формы — нет («соединение прервано» в Safari).
  // Повтор безопасен: тот же телефон получает тот же код.
  const params = new URLSearchParams({ b: business.slug, s: source });
  if (cardCode) params.set("c", cardCode);
  return `
    <div class="bonus">
      <p class="bonus-note">Подарок на следующий визит</p>
      <a class="button bonus-button" href="/bonus?${escapeHtml(params.toString())}" rel="nofollow">
        <span class="icon bonus-icon">${GIFT}</span>
        <span class="label">${wheel ? "Крутить колесо подарков" : "Получить подарок"}</span>
      </a>
    </div>`;
}

// ---------- GET /bonus?b=SLUG&s=nfc|qr&c=КОД ----------

export async function handleBonus(request, env) {
  try {
    if (request.method !== "GET" && request.method !== "POST") return infoPage(405, "Откройте страницу с карты ещё раз");
    if (isBot(request)) return infoPage(403, "Бонус недоступен");

    // GET — основной способ (ссылка); POST оставлен для страниц, открытых до обновления
    let form;
    if (request.method === "GET") {
      form = new URL(request.url).searchParams;
    } else {
      const text = await request.text();
      if (text.length > 2000) return infoPage(413, "Слишком большой запрос");
      form = new URLSearchParams(text);
    }
    if (!form.get("b")) return infoPage(404, "Откройте страницу с карты ещё раз");
    const slug = String(form.get("b") || "");
    const source = form.get("s");
    const cardCode = String(form.get("c") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    if (!/^[A-Za-z0-9]{4,32}$/.test(slug)) return infoPage(404, "Заведение не найдено");
    if (source !== "nfc" && source !== "qr") {
      return infoPage(403, "Бонус выдаётся только при скане карты в заведении");
    }

    const rows = await db(
      env,
      `businesses?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true` +
        `&select=id,slug,name,discount_text,paid_until,theme,${BONUS_COLUMNS}&limit=1`
    );
    const business = rows[0];
    if (!business || isExpired(business.paid_until) || !bonusEnabled(business)) {
      return infoPage(404, "Бонус сейчас недоступен");
    }

    // Устройство: случайный id в cookie; в базе — только хеш с секретом
    const cookies = parseCookies(request.headers.get("Cookie"));
    let deviceId = cookies[DEVICE_COOKIE];
    let setCookie = null;
    if (!/^[A-Za-z0-9]{24}$/.test(deviceId || "")) {
      deviceId = randomString(CODE_ALPHABET + "abcdefghjkmnpqrstuvwxyz", 24);
      setCookie = `${DEVICE_COOKIE}=${deviceId}; Path=/; Max-Age=${400 * 24 * 3600}; HttpOnly; Secure; SameSite=Lax`;
    }
    const visitorKey = await sha256(`${deviceId}|${business.id}|${env.HASH_SALT || env.SUPABASE_SECRET_KEY}`);
    const backUrl = cardCode ? `/c/${cardCode}?s=${source}` : `/b/${business.slug}?s=${source}`;

    // Уже получал бонус за последние N дней — показываем тот же код, без нового розыгрыша
    const since = new Date(Date.now() - business.bonus_cooldown_days * DAY).toISOString();
    const existing = await db(
      env,
      `bonus_codes?business_id=eq.${business.id}&visitor_key=eq.${visitorKey}` +
        `&created_at=gt.${encodeURIComponent(since)}&select=code,prize,conditions,valid_from,valid_until,redeemed_at,created_at` +
        `&order=created_at.desc&limit=1`
    );
    if (existing.length) {
      // Для колеса показываем его уже остановленным на выпавшем призе — так понятно, что розыгрыш был
      const prizes = prizesOf(business);
      const index = business.bonus_mode === "wheel" ? prizes.findIndex((p) => p.label === existing[0].prize) : -1;
      const wheel = index >= 0 ? { prizes, index } : null;
      return withCookie(resultPage(business, existing[0], { repeat: true, backUrl, wheel }), setCookie);
    }

    const prizes = prizesOf(business);
    const index = pickWeighted(prizes);
    const now = Date.now();
    const dayStart = Math.floor((now + MSK_OFFSET) / DAY) * DAY - MSK_OFFSET;
    // Дни — по Москве. С задержкой: с начала дня через N дней и ещё bonus_valid_days дней.
    // Без задержки: с этой минуты до конца (bonus_valid_days)-го дня, считая сегодняшний.
    const delayed = business.bonus_from_days > 0;
    const validFrom = delayed ? dayStart + business.bonus_from_days * DAY : now;
    const validUntil = (delayed ? validFrom : dayStart) + business.bonus_valid_days * DAY;

    let cardId = null;
    if (cardCode) {
      const cards = await db(env, `cards?code=eq.${cardCode}&business_id=eq.${business.id}&select=id&limit=1`);
      cardId = cards.length ? cards[0].id : null;
    }

    let saved = null;
    for (let attempt = 0; attempt < 5 && !saved; attempt++) {
      try {
        const inserted = await db(env, "bonus_codes?select=code,prize,conditions,valid_from,valid_until,redeemed_at", {
          method: "POST",
          body: {
            code: randomString(CODE_ALPHABET, CODE_LENGTH),
            business_id: business.id,
            card_id: cardId,
            prize: prizes[index].label,
            conditions: business.bonus_conditions || null,
            visitor_key: visitorKey,
            valid_from: new Date(validFrom).toISOString(),
            valid_until: new Date(validUntil).toISOString()
          },
          prefer: "return=representation"
        });
        saved = inserted[0];
      } catch (error) {
        if (error.code !== "23505") throw error; // совпал код — пробуем другой
      }
    }
    if (!saved) throw new Error("Не удалось подобрать свободный код");

    return withCookie(
      resultPage(business, saved, { repeat: false, backUrl, wheel: business.bonus_mode === "wheel" ? { prizes, index } : null }),
      setCookie
    );
  } catch (error) {
    console.error(`Bonus error: ${error.message}\n${error.stack}`);
    return infoPage(500, "Не удалось выдать бонус. Попробуйте ещё раз через минуту.");
  }
}

function pickWeighted(prizes) {
  const total = prizes.reduce((sum, p) => sum + p.weight, 0);
  const roll = (crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * total;
  let acc = 0;
  for (let i = 0; i < prizes.length; i++) {
    acc += prizes[i].weight;
    if (roll < acc) return i;
  }
  return prizes.length - 1;
}

// ---------- Страница результата (без скриптов: колесо крутится на CSS) ----------

// Премиальное колесо: тёмно-синие сектора с золотыми надписями, золотой обод с лампочками
const WHEEL_COLORS = [
  { bg: "#0b2b5e", fg: "#f3d68e" },
  { bg: "#061b3d", fg: "#f3d68e" },
  { bg: "#14407f", fg: "#fbe7b0" } // только последнему сектору при нечётном числе, чтобы не слился с первым
];
const WHEEL_BULBS = 18;
const WHEEL_SPIN_S = 7; // длительность вращения; результат появляется сразу после остановки

// still = колесо уже остановлено на призе (повторный заход — без нового розыгрыша)
function wheelHtml(prizes, index, still = false) {
  const n = prizes.length;
  const seg = 360 / n;
  const colors = prizes.map((_, i) => WHEEL_COLORS[n % 2 === 1 && i === n - 1 ? 2 : i % 2]);
  const gradient = colors.map((c, i) => `${c.bg} ${i * seg}deg ${(i + 1) * seg}deg`).join(", ");
  // Указатель сверху: сектор index должен остановиться под ним
  const jitter = still ? 0 : (crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 - 0.5) * seg * 0.6;
  const end = (still ? 360 : 360 * 10) - (index * seg + seg / 2) + jitter;
  const labels = prizes
    .map((p, i) => `<span class="w-label" style="transform: rotate(${(i * seg + seg / 2).toFixed(2)}deg) translateY(-82px); color: ${colors[i].fg}">${escapeHtml(p.label)}</span>`)
    .join("");
  const bulbs = Array.from(
    { length: WHEEL_BULBS },
    (_, i) => `<span class="w-bulb" style="transform: rotate(${((360 / WHEEL_BULBS) * i).toFixed(2)}deg) translateY(-142px)"></span>`
  ).join("");
  return `
    <div class="wheel-wrap${still ? " is-still" : ""}" aria-hidden="true">
      <div class="w-rim">${bulbs}</div>
      <div class="wheel${still ? " wheel-still" : ""}" style="--end: ${end.toFixed(2)}deg; background: conic-gradient(${gradient});">
        <div class="w-lines" style="--seg: ${seg.toFixed(3)}deg"></div>${labels}
      </div>
      <div class="w-gloss"></div>
      <div class="w-pointer"></div>
      <div class="w-hub"><span>TR</span></div>
    </div>`;
}

function formatCode(code) {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

function dayLabel(ms) {
  return new Date(ms).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });
}

export function validityText(c) {
  const from = Date.parse(c.valid_from);
  const lastDay = Date.parse(c.valid_until) - 1;
  if (from <= Date.now()) return `Действует до ${dayLabel(lastDay)} включительно`;
  return `Действует с ${dayLabel(from)} по ${dayLabel(lastDay)}`;
}

function resultPage(business, c, { repeat, backUrl, wheel = null }) {
  const status = c.redeemed_at
    ? `<p class="br-warn">Этот код уже использован ${escapeHtml(dayLabel(Date.parse(c.redeemed_at)))}. Новый подарок можно будет получить позже.</p>`
    : "";
  // Когда этот телефон сможет получить новый подарок (крутить колесо снова)
  const nextAt = c.created_at ? Date.parse(c.created_at) + business.bonus_cooldown_days * DAY : null;
  const next = repeat && nextAt
    ? `<p class="br-next">${business.bonus_mode === "wheel" ? "Крутить колесо снова" : "Получить новый подарок"} можно с ${escapeHtml(dayLabel(nextAt))}</p>`
    : "";
  const result = `
    <div class="br ${wheel && !repeat ? "br-after-spin" : "br-fade"}">
      <p class="br-kicker">${repeat ? "Ваш подарок уже ждёт вас" : wheel ? "Ваш приз" : "Ваш подарок"}</p>
      <p class="br-prize">${escapeHtml(c.prize)}</p>
      <p class="br-code" aria-label="Код ${escapeHtml(c.code.split("").join(" "))}">${escapeHtml(formatCode(c.code))}</p>
      <p class="br-valid">${escapeHtml(validityText(c))}</p>
      ${c.conditions ? `<p class="br-cond">Условия: ${escapeHtml(c.conditions)}</p>` : ""}
      ${status}
      <p class="br-hint">Покажите код на кассе. Сделайте скриншот, чтобы не потерять.</p>
      ${next}
    </div>`;

  return renderPage({
    status: 200,
    title: `Подарок — ${business.name}`,
    accent: null,
    theme: business.theme,
    extraCss: BONUS_PAGE_CSS,
    // Как на странице заведения: зелёная кнопка на сайт TapReview (через реферальную ссылку заведения)
    footer: { href: `/r/${business.slug}?s=card`, text: "Хочу такую карту" },
    body: `
      <h1 class="name name-long">${escapeHtml(business.name)}</h1>
      <div class="divider"></div>
      ${wheel ? wheelHtml(wheel.prizes, wheel.index, repeat) : `<div class="br-gift" aria-hidden="true">${GIFT}</div>`}
      ${result}
      <p class="br-rules">Подарок не зависит от отзыва. Один подарок на устройство за ${business.bonus_cooldown_days} ${plural(business.bonus_cooldown_days, "день", "дня", "дней")}.</p>
      <a class="br-back" href="${escapeHtml(backUrl)}">← Вернуться к странице заведения</a>`
  });
}

function infoPage(status, text) {
  return renderPage({
    status,
    title: "Подарок",
    accent: DEFAULT_ACCENT,
    body: `<h2 class="thanks">${escapeHtml(text)}</h2>`
  });
}

const BONUS_PAGE_CSS = `
  /* Колесо: обод 300 px, сектора 268 px. Вращение ~7 с с долгим плавным торможением */
  .wheel-wrap { position: relative; width: 300px; height: 300px; margin: 10px auto 24px; max-width: 100%; }
  .w-rim {
    position: absolute; inset: 0; border-radius: 50%;
    background: conic-gradient(from 20deg, #8a5f06, #f6dc8c, #b98510, #fff1c2, #a87508, #f0cd6a, #8a5f06, #e9c25a, #8a5f06);
    box-shadow: 0 22px 44px rgba(6, 20, 45, 0.38), 0 6px 14px rgba(6, 20, 45, 0.25), inset 0 0 0 1px rgba(255, 255, 255, 0.35);
  }
  .w-rim::after {
    content: ""; position: absolute; inset: 13px; border-radius: 50%;
    box-shadow: 0 0 0 2px #6e4a04, inset 0 0 0 1px rgba(0, 0, 0, 0.2);
  }
  .w-bulb {
    position: absolute; left: 50%; top: 50%; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%;
    background: radial-gradient(circle at 35% 35%, #ffffff, #fff4c9 40%, #f2c14a 75%);
    box-shadow: 0 0 6px 2px rgba(255, 226, 140, 0.85);
    animation: w-twinkle 0.35s ease-in-out infinite alternate;
  }
  .w-bulb:nth-child(even) { animation-delay: -0.35s; }
  /* повторный заход (колесо стоит) — лампочки мигают спокойно */
  .is-still .w-bulb { animation-duration: 1.4s; }
  .is-still .w-bulb:nth-child(even) { animation-delay: -1.4s; }
  @keyframes w-twinkle { from { opacity: 0.35; box-shadow: 0 0 2px 0 rgba(255, 226, 140, 0.4); } to { opacity: 1; } }
  .wheel {
    position: absolute; inset: 16px; border-radius: 50%; overflow: hidden;
    box-shadow: inset 0 0 0 2px rgba(243, 214, 142, 0.55), inset 0 0 26px rgba(0, 0, 0, 0.45);
    animation: w-spin ${WHEEL_SPIN_S}s cubic-bezier(0.17, 0.67, 0.08, 1) 0.3s both;
  }
  @keyframes w-spin { from { transform: rotate(0deg); } to { transform: rotate(var(--end)); } }
  .wheel-still { animation: none; transform: rotate(var(--end)); }
  /* тонкие золотые линии между секторами */
  .w-lines {
    position: absolute; inset: 0; border-radius: 50%;
    background: repeating-conic-gradient(from -0.4deg, rgba(243, 214, 142, 0.9) 0deg 0.8deg, transparent 0.8deg var(--seg));
    -webkit-mask: radial-gradient(circle, transparent 30px, #000 31px);
    mask: radial-gradient(circle, transparent 30px, #000 31px);
  }
  .br-next { margin: 8px 0 0; font-size: 13px; font-weight: 600; color: #0a2a5c; }
  .w-label {
    position: absolute; left: 50%; top: 50%; width: 88px; margin: -0.65em 0 0 -44px;
    transform-origin: 50% 50%; font-size: 11.5px; font-weight: 700; line-height: 1.15; text-align: center;
    letter-spacing: 0.02em; overflow-wrap: anywhere; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  }
  /* блик сверху — не вращается */
  .w-gloss {
    position: absolute; inset: 16px; border-radius: 50%; pointer-events: none;
    background: radial-gradient(ellipse 60% 32% at 50% 8%, rgba(255, 255, 255, 0.13), rgba(255, 255, 255, 0) 70%);
  }
  .w-pointer {
    position: absolute; z-index: 3; left: 50%; top: -10px; width: 34px; height: 44px; margin-left: -17px;
    filter: drop-shadow(0 4px 5px rgba(6, 20, 45, 0.45));
  }
  .w-pointer::before {
    content: ""; position: absolute; inset: 0;
    background: linear-gradient(90deg, #a87508, #fff1c2 45%, #e3b23c 60%, #8a5f06);
    clip-path: polygon(50% 100%, 6% 22%, 18% 6%, 50% 0, 82% 6%, 94% 22%);
  }
  .w-pointer::after {
    content: ""; position: absolute; left: 50%; top: 9px; width: 10px; height: 10px; margin-left: -5px; border-radius: 50%;
    background: radial-gradient(circle at 35% 35%, #2a5aa3, #061b3d);
    box-shadow: 0 0 0 1.5px #fbe7b0;
  }
  .w-hub {
    position: absolute; z-index: 2; left: 50%; top: 50%; width: 64px; height: 64px; margin: -32px 0 0 -32px;
    display: grid; place-items: center; border-radius: 50%;
    background: radial-gradient(circle at 34% 28%, #fff6d2, #f0cd6a 35%, #c18d14 70%, #8a5f06);
    box-shadow: 0 6px 14px rgba(0, 0, 0, 0.4), inset 0 -3px 6px rgba(0, 0, 0, 0.25), 0 0 0 3px #061b3d, 0 0 0 4.5px rgba(243, 214, 142, 0.7);
  }
  .w-hub span {
    display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%;
    background: radial-gradient(circle at 40% 30%, #1b4a8f, #061b3d 75%);
    box-shadow: inset 0 0 0 1.5px rgba(251, 231, 176, 0.8);
    color: #f6dc8c; font-weight: 800; font-size: 15px; letter-spacing: 0.04em;
  }
  .br-gift { width: 64px; height: 64px; margin: 4px auto 16px; }
  .br-gift svg { width: 100%; height: 100%; }
  .br { padding: 18px 18px 16px; border: 1px dashed #e2c46e; border-radius: 18px; background: #fffdf6; color: #141a2b; }
  .br-fade { animation: br-in 0.5s ease 0.2s both; }
  .br-after-spin { animation: br-in 0.5s ease ${WHEEL_SPIN_S + 0.5}s both; }
  @keyframes br-in { from { opacity: 0; transform: translateY(8px); visibility: hidden; } to { opacity: 1; transform: none; visibility: visible; } }
  .br-kicker { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #8a6300; }
  .br-prize { margin: 6px 0 12px; font-size: 22px; font-weight: 700; line-height: 1.25; }
  .br-code {
    margin: 0 auto 10px; padding: 10px 14px; width: fit-content; border-radius: 12px; background: #fff;
    box-shadow: 0 0 0 1.5px #e2c46e inset; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 30px; font-weight: 700; letter-spacing: 0.12em; user-select: all;
  }
  .br-valid { margin: 0; font-size: 15px; font-weight: 600; }
  .br-cond { margin: 6px 0 0; font-size: 14px; color: #6b7280; }
  .br-warn { margin: 10px 0 0; padding: 8px 10px; border-radius: 10px; background: #fdecec; color: #7f1d1d; font-size: 14px; }
  .br-hint { margin: 10px 0 0; font-size: 13px; color: #6b7280; }
  .br-rules { margin: 14px 0 0; font-size: 12px; color: var(--muted); }
  .br-back { display: inline-block; margin-top: 14px; font-size: 14px; color: var(--text); text-underline-offset: 3px; }
  @media (prefers-reduced-motion: reduce) {
    .wheel { animation: none; transform: rotate(var(--end)); }
    .w-bulb { animation: none; }
    .br-fade, .br-after-spin { animation: none; }
  }
`;

// ---------- Касса: проверка и погашение кода (страница /s/ТОКЕН/bonus) ----------

// Русские буквы-двойники (кассир не переключил раскладку) → латиница
const RU_LOOKALIKE = { А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", У: "Y" };

export function normalizeCode(value) {
  const code = String(value || "")
    .toUpperCase()
    .replace(/[А-ЯЁ]/g, (ch) => RU_LOOKALIKE[ch] || "")
    .replace(/[^A-Z0-9]/g, "");
  return code.length === CODE_LENGTH ? code : null;
}

// Код из заведений этой ссылки: { row, state: ok | soon | expired | used } или null
export async function findCode(env, code, businessIds) {
  const rows = await db(
    env,
    `bonus_codes?code=eq.${code}&business_id=in.(${businessIds.join(",")})` +
      `&select=id,code,business_id,prize,conditions,valid_from,valid_until,redeemed_at,created_at&limit=1`
  );
  if (!rows.length) return null;
  const row = rows[0];
  const now = Date.now();
  const state = row.redeemed_at
    ? "used"
    : now < Date.parse(row.valid_from)
      ? "soon"
      : now >= Date.parse(row.valid_until)
        ? "expired"
        : "ok";
  return { row, state };
}

// by — кто погасил: «владелец» или «персонал: <подпись ссылки>» (видно в админке)
export async function redeemCode(env, id, by = null) {
  const rows = await db(env, `bonus_codes?id=eq.${id}&redeemed_at=is.null&select=id,redeemed_at`, {
    method: "PATCH",
    body: { redeemed_at: new Date().toISOString(), redeemed_by: by ? String(by).slice(0, 80) : null },
    prefer: "return=representation"
  });
  return rows.length > 0;
}

export async function bonusCounts(env, businessIds, days = 30) {
  const since = new Date(Date.now() - days * DAY).toISOString();
  const rows = await db(
    env,
    `bonus_codes?business_id=in.(${businessIds.join(",")})&created_at=gt.${encodeURIComponent(since)}` +
      `&select=prize,redeemed_at&limit=10000`
  );
  const byPrize = {};
  let redeemed = 0;
  for (const r of rows) {
    const p = (byPrize[r.prize] = byPrize[r.prize] || { issued: 0, redeemed: 0 });
    p.issued++;
    if (r.redeemed_at) {
      p.redeemed++;
      redeemed++;
    }
  }
  return { issued: rows.length, redeemed, byPrize };
}

// ---------- Мелочи ----------

function withCookie(response, cookie) {
  if (cookie) response.headers.append("Set-Cookie", cookie);
  return response;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function randomString(alphabet, length) {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

async function sha256(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}
