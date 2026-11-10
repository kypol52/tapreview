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
import { isBot, visitorHashOf } from "./analytics.js";
import { renderPage, escapeHtml, GIFT, DEFAULT_ACCENT, BONUS_COLUMNS, customDesign } from "./public-page.js";
import { isExpired } from "./billing.js";
import { deviceFrom, visitorKeyOf, stampsOn, stampCount, vipOn, visitCount } from "./guests.js";
import { friendOn, inviteFor, inviterRewards, inviteBlock } from "./friends.js";
import { has } from "./tariffs.js";

// Коды подарков — 6 цифр (быстро набрать на кассе). Старые коды с буквами по-прежнему принимаются.
const CODE_DIGITS = "0123456789";
const CODE_LENGTH = 6;
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

// Штампы (миграция 028): кружки по числу штампов до особого приза, последний — подарок
export function stampsHtml(business, count) {
  if (!stampsOn(business) || count === null || count === undefined) return "";
  const goal = business.stamps_goal;
  const n = Math.min(count, goal);
  const dots = Array.from({ length: goal }, (_, i) => `<span class="stamp${i < n ? " stamp-on" : ""}"></span>`).join("");
  const left = goal - n;
  const prize = escapeHtml(business.stamps_prize);
  const text = left
    ? `Ещё ${left} ${plural(left, "штамп", "штампа", "штампов")} — и подарок «${prize}»`
    : `Все штампы собраны! Следующий подарок — «${prize}»`;
  return `
    <div class="stamps" role="img" aria-label="Штампы: ${n} из ${goal}">
      <div class="stamps-row">${dots}<span class="stamp stamp-gift${left ? "" : " stamp-ready"}">${GIFT}</span></div>
      <p class="stamps-text">${text}</p>
    </div>`;
}

export function bonusBlock(business, source, cardCode, stamps = null, rewards = 0, visits = 0) {
  if (!bonusEnabled(business) || (source !== "nfc" && source !== "qr")) return "";
  const wheel = business.bonus_mode === "wheel";
  const ready = stampsOn(business) && stamps !== null && stamps >= business.stamps_goal;
  const vip = !ready && vipOn(business) && visits >= business.vip_visits;
  // Обычная ссылка, а не форма: в РФ провайдеры иногда обрывают соединения с Cloudflare,
  // и обычный переход браузер сам повторяет, а отправку формы — нет («соединение прервано» в Safari).
  // Повтор безопасен: тот же телефон получает тот же код.
  const params = new URLSearchParams({ b: business.slug, s: source });
  if (cardCode) params.set("c", cardCode);
  return `
    <div class="bonus">
      ${stampsHtml(business, stamps)}
      ${rewards ? `<p class="bonus-friend">🎉 Ваш друг пришёл по приглашению — для вас подарок «${escapeHtml(business.friend_reward || "")}». Нажмите кнопку, код будет сверху.</p>` : ""}
      ${vip ? `<p class="bonus-vip">⭐ Для VIP-гостей — «${escapeHtml(business.vip_gift)}»</p>` : ""}
      <p class="bonus-note">Подарок на следующий визит</p>
      <a class="button bonus-button" href="/bonus?${escapeHtml(params.toString())}" rel="nofollow">
        <span class="icon bonus-icon">${GIFT}</span>
        <span class="label">${ready ? "Получить особый подарок" : vip ? "Получить VIP-подарок" : wheel ? "Крутить колесо подарков" : "Получить подарок"}</span>
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
        `&select=id,slug,name,discount_text,paid_until,theme,design,${BONUS_COLUMNS}&limit=1`
    );
    const business = rows[0];
    if (!business || isExpired(business.paid_until) || !bonusEnabled(business) || !has(business, "gifts")) {
      return infoPage(404, "Бонус сейчас недоступен");
    }

    // Устройство: случайный id в cookie; в базе — только хеш с секретом (guests.js)
    const { deviceId, setCookie } = deviceFrom(request);
    const visitorKey = await visitorKeyOf(env, deviceId, business.id);
    const backUrl = cardCode ? `/c/${cardCode}?s=${source}` : `/b/${business.slug}?s=${source}`;

    // Уже получал бонус за последние N дней — показываем тот же код, без нового розыгрыша.
    // Подарок «за друга» (reward_kind = inviter) сюда не входит: он показывается отдельно и не мешает обычному.
    const since = new Date(Date.now() - business.bonus_cooldown_days * DAY).toISOString();
    const existing = await db(
      env,
      `bonus_codes?business_id=eq.${business.id}&visitor_key=eq.${visitorKey}` +
        `&created_at=gt.${encodeURIComponent(since)}&or=(reward_kind.is.null,reward_kind.eq.friend)&select=${CODE_FIELDS}` +
        `&order=created_at.desc&limit=1`
    );
    // Штампы (миграция 028), подарки за приглашённых друзей и ссылка «Подарите другу» (миграция 030)
    const [stamps, rewards, invite] = await Promise.all([
      stampsOn(business) ? stampCount(env, business, visitorKey) : null,
      friendOn(business) ? inviterRewards(env, business, visitorKey) : [],
      friendOn(business) ? inviteFor(env, business, visitorKey) : null
    ]);
    const extras = { stamps, rewards, invite };

    if (existing.length) {
      // Для колеса показываем его уже остановленным на выпавшем призе — так понятно, что розыгрыш был
      const prizes = prizesOf(business);
      const index = business.bonus_mode === "wheel" && !existing[0].stamp_reward && !existing[0].reward_kind && !existing[0].vip
        ? prizes.findIndex((p) => p.label === existing[0].prize)
        : -1;
      const wheel = index >= 0 ? { prizes, index } : null;
      return withCookie(resultPage(business, existing[0], { repeat: true, backUrl, wheel, ...extras }), setCookie);
    }

    // Защита от накрутки (миграция 023): один код в день с телефона и лимит кодов в день на заведение
    const guard = await dailyGuard(request, env, business);
    if (guard.blocked) {
      return withCookie(limitPage(business, backUrl, guard.blocked.heading, guard.blocked.text, rewards), setCookie);
    }

    const prizes = prizesOf(business);
    // Все штампы собраны — вместо колеса особый приз владельца, счёт штампов начнётся заново.
    // VIP-гость (миграция 032) — VIP-подарок вместо колеса (приз за штампы важнее).
    const reward = stamps !== null && stamps >= business.stamps_goal;
    const vip = !reward && vipOn(business) && (await visitCount(env, business, visitorKey)) >= business.vip_visits;
    const index = reward || vip ? -1 : pickWeighted(prizes);
    const prizeLabel = reward ? String(business.stamps_prize).slice(0, 60) : vip ? String(business.vip_gift).slice(0, 60) : prizes[index].label;

    let cardId = null;
    if (cardCode) {
      const cards = await db(env, `cards?code=eq.${cardCode}&business_id=eq.${business.id}&select=id&limit=1`);
      cardId = cards.length ? cards[0].id : null;
    }

    const saved = await issueCode(env, business, {
      prize: prizeLabel,
      visitorKey,
      deviceDay: guard.deviceDay,
      cardId,
      extra: reward ? { stamp_reward: true } : vip ? { vip: true } : {}
    });

    return withCookie(
      resultPage(business, saved, {
        repeat: false,
        backUrl,
        wheel: business.bonus_mode === "wheel" && !reward && !vip ? { prizes, index } : null,
        ...extras,
        stamps: reward ? 0 : stamps
      }),
      setCookie
    );
  } catch (error) {
    console.error(`Bonus error: ${error.message}\n${error.stack}`);
    return infoPage(500, "Не удалось выдать бонус. Попробуйте ещё раз через минуту.");
  }
}

export const CODE_FIELDS = "code,prize,conditions,valid_from,valid_until,redeemed_at,created_at,stamp_reward,reward_kind,vip";

// ---------- Извинение при оценке 1–3 (миграция 050) ----------
// Владелец задаёт sorry_gift — недовольный гость сразу видит одноразовый код над формой, без колеса.
// Защита та же, что у обычного подарка: только с карты, только с уже знакомого телефона (cookie с главного экрана),
// один подарок на телефон за bonus_cooldown_days (если код уже был — показываем его же), dailyGuard.
export function sorryOn(business) {
  return Boolean(business.sorry_gift) && has(business, "gifts");
}

// → строка bonus_codes или null (выключено, не с карты, робот, лимит)
export async function sorryCode(request, env, business, { source, cardId = null }) {
  if (!sorryOn(business) || (source !== "nfc" && source !== "qr") || isBot(request)) return null;
  const { deviceId, setCookie } = deviceFrom(request);
  if (setCookie) return null; // телефон без метки — не выдаём (инкогнито, прямой заход на шаг оценки)
  const visitorKey = await visitorKeyOf(env, deviceId, business.id);
  const since = new Date(Date.now() - (business.bonus_cooldown_days || 30) * DAY).toISOString();
  const existing = await db(
    env,
    `bonus_codes?business_id=eq.${business.id}&visitor_key=eq.${visitorKey}` +
      `&created_at=gt.${encodeURIComponent(since)}&or=(reward_kind.is.null,reward_kind.eq.friend)&select=${CODE_FIELDS}` +
      `&order=created_at.desc&limit=1`
  );
  if (existing.length) return existing[0];
  const guard = await dailyGuard(request, env, business);
  if (guard.blocked) return null;
  return issueCode(env, business, { prize: business.sorry_gift, visitorKey, deviceDay: guard.deviceDay, cardId, extra: { sorry: true } });
}

// Блок над формой: подарок, крупный код, сроки
export function sorryHtml(c) {
  if (!c) return "";
  return `
    <section class="sorry" aria-label="Подарок на следующий визит">
      <p class="sorry-title">🎁 Простите нас — подарок на следующий визит</p>
      <p class="sorry-prize">${escapeHtml(c.prize)}</p>
      <p class="sorry-code" aria-label="Код ${c.code.split("").join(" ")}">${formatCode(c.code)}</p>
      <p class="sorry-note">Покажите код персоналу.</p>
      <p class="sorry-valid">${escapeHtml(validityText(c))}${c.conditions ? ` · ${escapeHtml(c.conditions)}` : ""}.</p>
    </section>`;
}

// Защита от накрутки (миграция 023):
//  1) один код в день с одного телефона, даже в инкогнито / после очистки cookie —
//     по суточному обезличенному отпечатку «сеть + браузер» (IP не хранится);
//  2) не больше bonus_daily_limit кодов в день на заведение.
// → { deviceDay, blocked: null | { heading, text } }
export async function dailyGuard(request, env, business) {
  const dayStart = Math.floor((Date.now() + MSK_OFFSET) / DAY) * DAY - MSK_OFFSET;
  const deviceDay = await sha256(`${await visitorHashOf(request, env)}|${business.id}`);
  const limit = business.bonus_daily_limit || 50;
  const [sameDevice, today] = await Promise.all([
    db(env, `bonus_codes?business_id=eq.${business.id}&device_day=eq.${deviceDay}&select=id&limit=1`),
    db(
      env,
      `bonus_codes?business_id=eq.${business.id}&created_at=gte.${encodeURIComponent(new Date(dayStart).toISOString())}` +
        `&select=id&limit=${limit}`
    )
  ]);
  if (sameDevice.length) {
    return {
      deviceDay,
      blocked: {
        heading: "Подарок с этого телефона сегодня уже получен",
        text: "Код был на экране, когда вы получали подарок. Новый подарок можно будет получить в другой день."
      }
    };
  }
  if (today.length >= limit) {
    return { deviceDay, blocked: { heading: "Подарки на сегодня закончились", text: "Приходите завтра — подарки снова будут ждать вас." } };
  }
  return { deviceDay, blocked: null };
}

// Новый одноразовый код подарка со сроками заведения. extra — stamp_reward / reward_kind / invite_code.
// Дни — по Москве. С задержкой: с начала дня через N дней и ещё bonus_valid_days дней.
// Без задержки: с этой минуты до конца (bonus_valid_days)-го дня, считая сегодняшний.
export async function issueCode(env, business, { prize, visitorKey, deviceDay = null, cardId = null, extra = {}, noDelay = false }) {
  const now = Date.now();
  const dayStart = Math.floor((now + MSK_OFFSET) / DAY) * DAY - MSK_OFFSET;
  const delayed = !noDelay && business.bonus_from_days > 0;
  const validFrom = delayed ? dayStart + business.bonus_from_days * DAY : now;
  const validUntil = (delayed ? validFrom : dayStart) + (business.bonus_valid_days || 14) * DAY;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const inserted = await db(env, `bonus_codes?select=${CODE_FIELDS}`, {
        method: "POST",
        body: {
          code: randomString(CODE_DIGITS, CODE_LENGTH),
          business_id: business.id,
          card_id: cardId,
          prize: String(prize).slice(0, 60),
          conditions: business.bonus_conditions || null,
          visitor_key: visitorKey,
          device_day: deviceDay,
          ...extra,
          valid_from: new Date(validFrom).toISOString(),
          valid_until: new Date(validUntil).toISOString()
        },
        prefer: "return=representation"
      });
      return inserted[0];
    } catch (error) {
      if (error.code !== "23505") throw error; // совпал код — пробуем другой
    }
  }
  throw new Error("Не удалось подобрать свободный код");
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

// Колесо в стиле «мягкий премиум»: толстый матовый обод, сектора в двух оттенках, золотые значки,
// золотая метка-указатель и золотая шайба в центре. Цвета — от темы страницы заведения (насыщенные, не блеклые).
const WHEEL_THEMES = {
  classic: { rim: "#1d2c4d", a: "#1a2846", b: "#2b406b", text: "#ffffff", acc: "#e8b54d" },
  dark: { rim: "#2b3243", a: "#1b2130", b: "#363e53", text: "#f3f4f8", acc: "#e3b25b" },
  coffee: { rim: "#4b3323", a: "#36251a", b: "#5b4030", text: "#fff7ee", acc: "#eab46b" },
  fresh: { rim: "#1c4a37", a: "#143a2b", b: "#23604a", text: "#f2fff8", acc: "#f0c35a" },
  rose: { rim: "#5a2541", a: "#451a32", b: "#6c2d50", text: "#fff3f8", acc: "#f2c27a" },
  custom: { rim: "#2e2016", a: "#1e150f", b: "#3d2a1b", text: "#fff3e2", acc: "#f0b45a" }
};
const WHEEL_SPIN_S = 7; // длительность вращения; результат появляется сразу после остановки

// Значок над призом — по словам в названии (тонкие линии в золотом цвете)
const PRIZE_ICON = (d) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PRIZE_ICONS = [
  { re: /кофе|капуч|латте|чай|какао|раф/i, d: "M5 9h11v5a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5zM16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5c-.6.8-.6 1.7 0 2.5M11.5 3.5c-.6.8-.6 1.7 0 2.5" },
  { re: /скидк|%|процент/i, d: "M3.5 12.5 11 5h7.5v7.5L11 20zM15 8.5h.01M9.5 15.5l4-4" },
  { re: /шот|коктейл|пив|вино|бокал|напит|лимонад|сок/i, d: "M6 4h12l-1.5 7a4.5 4.5 0 0 1-9 0zM12 15.5V20M8.5 20h7" },
  { re: /десерт|торт|пирож|морож|подар|бесплат|комплимент/i, d: "M4 10h16v4H4zM5.5 14h13v6h-13zM12 10v10M12 10c-1.6-3.6-6-4.2-6-1.4 0 1.5 2.6 1.4 6 1.4zM12 10c1.6-3.6 6-4.2 6-1.4 0 1.5-2.6 1.4-6 1.4z" },
  { re: /.*/, d: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" }
];

// still = колесо уже остановлено на призе (повторный заход — без нового розыгрыша)
function wheelHtml(prizes, index, still = false, theme = "classic") {
  const t = WHEEL_THEMES[theme] || WHEEL_THEMES.classic;
  const n = prizes.length;
  const seg = 360 / n;
  // при нечётном числе последний сектор — промежуточный оттенок, чтобы не слился с первым
  const tones = prizes.map((_, i) => (n % 2 === 1 && i === n - 1 ? "mid" : i % 2 ? "b" : "a"));
  const toneColor = { a: "var(--w-a)", b: "var(--w-b)", mid: "color-mix(in srgb, var(--w-a) 50%, var(--w-b))" };
  const gradient = tones.map((tone, i) => `${toneColor[tone]} ${(i * seg).toFixed(3)}deg ${((i + 1) * seg).toFixed(3)}deg`).join(", ");
  // Указатель сверху: сектор index должен остановиться под ним
  const jitter = still ? 0 : (crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 - 0.5) * seg * 0.6;
  const end = (still ? 360 : 360 * 10) - (index * seg + seg / 2) + jitter;
  const narrow = n >= 7 ? " w-narrow" : "";
  const labels = prizes
    .map((p, i) => {
      const icon = PRIZE_ICONS.find((x) => x.re.test(p.label)).d;
      const angle = i * seg + seg / 2;
      // содержимое повёрнуто обратно так, чтобы после остановки колеса все подписи стояли ровно
      return `<span class="w-label${narrow}" style="transform: rotate(${angle.toFixed(2)}deg) translateY(-${n >= 7 ? 86 : 80}px)">` +
        `<span class="w-label-in" style="transform: rotate(${(-(angle + end)).toFixed(2)}deg)"><span class="w-icon">${PRIZE_ICON(icon)}</span>${escapeHtml(p.label)}</span></span>`;
    })
    .join("");
  return `
    <div class="wheel-wrap${still ? " is-still" : ""}" aria-hidden="true"
      style="--w-rim: ${t.rim}; --w-a: ${t.a}; --w-b: ${t.b}; --w-text: ${t.text}; --w-acc: ${t.acc};">
      <div class="w-arc w-arc-1"></div><div class="w-arc w-arc-2"></div>
      <div class="w-rim"></div>
      <div class="wheel${still ? " wheel-still" : ""}" style="--end: ${end.toFixed(2)}deg; background: conic-gradient(${gradient});">
        <div class="w-shade"></div><div class="w-lines" style="--seg: ${seg.toFixed(3)}deg"></div>${labels}
      </div>
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

function resultPage(business, c, { repeat, backUrl, wheel = null, stamps = null, rewards = [], invite = null }) {
  // Штампы: приз за штампы — праздничная надпись; обычный код — прогресс и «штамп поставят на кассе»
  let stampBox = "";
  if (stampsOn(business) && stamps !== null) {
    stampBox = c.stamp_reward
      ? `<p class="br-stamp">🎉 Все ${business.stamps_goal} ${plural(business.stamps_goal, "штамп", "штампа", "штампов")} собраны — это ваш особый подарок. Штампы начинают копиться заново.</p>`
      : `${stampsHtml(business, stamps)}${c.redeemed_at ? "" : `<p class="br-stamp-note">Штамп появится, когда персонал погасит этот код.</p>`}`;
  }
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
      <p class="br-kicker">${c.stamp_reward ? "Подарок за штампы" : c.reward_kind === "friend" ? "Подарок от друга" : c.vip ? "⭐ VIP-подарок" : repeat ? "Ваш подарок уже ждёт вас" : wheel ? "Ваш приз" : "Ваш подарок"}</p>
      <p class="br-prize">${escapeHtml(c.prize)}</p>
      <p class="br-code" aria-label="Код ${escapeHtml(c.code.split("").join(" "))}">${escapeHtml(formatCode(c.code))}</p>
      <p class="br-hint">Покажите код на кассе. Сделайте скриншот, чтобы не потерять.</p>
      <p class="br-valid">${escapeHtml(validityText(c))}</p>
      ${c.conditions ? `<p class="br-cond">Условия: ${escapeHtml(c.conditions)}</p>` : ""}
      ${status}
      ${next}
    </div>`;

  return renderPage({
    status: 200,
    title: `Подарок — ${business.name}`,
    accent: null,
    theme: business.theme,
    design: customDesign(business),
    extraCss: BONUS_PAGE_CSS,
    // Как на странице заведения: зелёная кнопка на сайт TapReview (через реферальную ссылку заведения)
    footer: { href: `/r/${business.slug}?s=card`, text: "Хочу такую карту" },
    body: `
      <h1 class="name name-long">${escapeHtml(business.name)}</h1>
      <div class="divider"></div>
      ${rewardsHtml(rewards)}
      ${wheel ? wheelHtml(wheel.prizes, wheel.index, repeat, business.theme) : `<div class="br-gift" aria-hidden="true">${GIFT}</div>`}
      ${result}
      ${stampBox}
      ${invite ? inviteBlock(business, invite) : ""}
      <p class="br-rules">Подарок не зависит от отзыва. Один подарок на устройство за ${business.bonus_cooldown_days} ${plural(business.bonus_cooldown_days, "день", "дня", "дней")}.</p>
      <a class="br-back" href="${escapeHtml(backUrl)}">← Вернуться к странице заведения</a>`
  });
}

// Отказ в оформлении заведения (лимит подарков) — с кнопкой назад к странице заведения
// Подарки «за друга», которые ждут гостя (друг пришёл и погасил свой код) — сверху страницы подарка
export function rewardsHtml(rewards) {
  if (!rewards || !rewards.length) return "";
  return rewards
    .map((c) => `
      <div class="br br-friend">
        <p class="br-kicker">🎉 Ваш друг пришёл — подарок вам</p>
        <p class="br-prize">${escapeHtml(c.prize)}</p>
        <p class="br-code" aria-label="Код ${escapeHtml(c.code.split("").join(" "))}">${escapeHtml(formatCode(c.code))}</p>
        <p class="br-valid">${escapeHtml(validityText(c))}</p>
        ${c.conditions ? `<p class="br-cond">Условия: ${escapeHtml(c.conditions)}</p>` : ""}
      </div>`)
    .join("");
}

export { BONUS_PAGE_CSS, formatCode, plural, infoPage, withCookie };

function limitPage(business, backUrl, heading, text, rewards = []) {
  return renderPage({
    status: 200,
    title: `Подарок — ${business.name}`,
    accent: null,
    theme: business.theme,
    design: customDesign(business),
    extraCss: BONUS_PAGE_CSS,
    footer: { href: `/r/${business.slug}?s=card`, text: "Хочу такую карту" },
    body: `
      <h1 class="name name-long">${escapeHtml(business.name)}</h1>
      <div class="divider"></div>
      ${rewardsHtml(rewards)}
      <div class="br-gift" aria-hidden="true">${GIFT}</div>
      <h2 class="thanks">${escapeHtml(heading)}</h2>
      <p class="lead">${escapeHtml(text)}</p>
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
  /* Колесо: 300 px, матовый обод 20 px. Вращение ~7 с с долгим плавным торможением */
  .wheel-wrap { position: relative; width: 300px; height: 300px; margin: 14px auto 26px; max-width: 100%; }
  /* тонкие золотые дуги вокруг */
  .w-arc { position: absolute; inset: -14px; border-radius: 50%; border: 1.5px solid transparent; pointer-events: none; }
  .w-arc-1 { border-left-color: var(--w-acc); transform: rotate(28deg); opacity: 0.75;
    -webkit-mask: linear-gradient(180deg, transparent 8%, #000 40%, #000 60%, transparent 92%); mask: linear-gradient(180deg, transparent 8%, #000 40%, #000 60%, transparent 92%); }
  .w-arc-2 { border-right-color: var(--w-acc); transform: rotate(28deg); opacity: 0.75;
    -webkit-mask: linear-gradient(180deg, transparent 8%, #000 40%, #000 60%, transparent 92%); mask: linear-gradient(180deg, transparent 8%, #000 40%, #000 60%, transparent 92%); }
  .w-rim {
    position: absolute; inset: 0; border-radius: 50%;
    background: linear-gradient(160deg, color-mix(in srgb, var(--w-rim) 78%, #fff) 0%, var(--w-rim) 35%, color-mix(in srgb, var(--w-rim) 70%, #000) 100%);
    box-shadow: 0 24px 46px rgba(0, 0, 0, 0.35), 0 8px 16px rgba(0, 0, 0, 0.22),
      inset 0 2px 1px rgba(255, 255, 255, 0.16), inset 0 -4px 8px rgba(0, 0, 0, 0.35);
  }
  .wheel {
    position: absolute; inset: 20px; border-radius: 50%; overflow: hidden;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35), inset 0 0 22px rgba(0, 0, 0, 0.45);
    animation: w-spin ${WHEEL_SPIN_S}s cubic-bezier(0.17, 0.67, 0.08, 1) 0.3s both;
  }
  @keyframes w-spin { from { transform: rotate(0deg); } to { transform: rotate(var(--end)); } }
  .wheel-still { animation: none; transform: rotate(var(--end)); }
  /* мягкий объём секторов: светлее к краю, темнее к центру */
  .w-shade {
    position: absolute; inset: 0; border-radius: 50%;
    background: radial-gradient(circle, rgba(0, 0, 0, 0.28) 0%, rgba(0, 0, 0, 0) 45%, rgba(255, 255, 255, 0.07) 100%);
  }
  /* разделители: тёмная линия + тонкий свет рядом — как фаска */
  .w-lines {
    position: absolute; inset: 0; border-radius: 50%;
    background: repeating-conic-gradient(from -0.6deg, rgba(0, 0, 0, 0.45) 0deg 0.7deg, rgba(255, 255, 255, 0.1) 0.7deg 1.2deg, transparent 1.2deg var(--seg));
  }
  .br-next { margin: 8px 0 0; font-size: 13px; font-weight: 600; color: var(--text); }
  .w-label {
    position: absolute; left: 50%; top: 50%; width: 86px; height: 64px; margin: -32px 0 0 -43px;
    transform-origin: 50% 50%; color: var(--w-text); font-size: 12px; font-weight: 600; line-height: 1.2; text-align: center;
    overflow-wrap: anywhere; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  }
  .w-label-in { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; width: 100%; height: 100%; }
  .w-label.w-narrow { width: 66px; height: 56px; margin: -28px 0 0 -33px; font-size: 10.5px; }
  .w-narrow .w-label-in { gap: 3px; }
  .w-icon { display: block; width: 24px; height: 24px; color: var(--w-acc); filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.3)); }
  .w-narrow .w-icon { width: 19px; height: 19px; }
  .w-icon svg { display: block; width: 100%; height: 100%; }
  /* указатель — золотая метка */
  .w-pointer {
    position: absolute; z-index: 3; left: 50%; top: -16px; width: 30px; height: 30px; margin-left: -15px;
    border-radius: 50% 50% 50% 0; transform: rotate(-45deg);
    background: linear-gradient(135deg, color-mix(in srgb, var(--w-acc) 55%, #fff), var(--w-acc) 45%, color-mix(in srgb, var(--w-acc) 70%, #000));
    box-shadow: -3px 4px 8px rgba(0, 0, 0, 0.35);
  }
  .w-pointer::after {
    content: ""; position: absolute; left: 50%; top: 50%; width: 9px; height: 9px; margin: -4.5px 0 0 -4.5px; border-radius: 50%;
    background: color-mix(in srgb, var(--w-a) 80%, #000); box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.5);
  }
  /* центр — золотая шайба */
  .w-hub {
    position: absolute; z-index: 2; left: 50%; top: 50%; width: 70px; height: 70px; margin: -35px 0 0 -35px;
    display: grid; place-items: center; border-radius: 50%;
    background: radial-gradient(circle at 35% 28%, color-mix(in srgb, var(--w-acc) 35%, #fff), var(--w-acc) 55%, color-mix(in srgb, var(--w-acc) 72%, #000));
    box-shadow: 0 8px 18px rgba(0, 0, 0, 0.45), inset 0 2px 2px rgba(255, 255, 255, 0.45), inset 0 -3px 6px rgba(0, 0, 0, 0.2);
  }
  .w-hub span { color: color-mix(in srgb, var(--w-a) 85%, #000); font-weight: 800; font-size: 20px; letter-spacing: 0.02em; }  .br-gift { width: 64px; height: 64px; margin: 4px auto 16px; }
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
  .br-valid { margin: 8px 0 0; font-size: 14px; font-weight: 500; }
  .br-cond { margin: 6px 0 0; font-size: 14px; color: #6b7280; }
  .br-warn { margin: 10px 0 0; padding: 8px 10px; border-radius: 10px; background: #fdecec; color: #7f1d1d; font-size: 14px; }
  .br-hint { margin: 0; font-size: 15.5px; font-weight: 600; line-height: 1.4; color: inherit; }
  .br-rules { margin: 14px 0 0; font-size: 12px; color: var(--muted); }
  .br-back { display: inline-block; margin-top: 14px; font-size: 14px; color: var(--text); text-underline-offset: 3px; }
  .br .stamps, .br ~ .stamps { margin-top: 16px; }
  .br-stamp { margin: 14px 0 0; padding: 10px 12px; border-radius: 12px; background: color-mix(in srgb, var(--accent) 14%, transparent); font-size: 14px; font-weight: 600; color: var(--text); }
  .br-friend { margin: 0 0 16px; border-style: solid; border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, #fffdf6); }
  .invite { margin-top: 18px; padding: 16px; border-radius: 18px; border: 1px solid var(--btn-border); background: var(--btn-bg); text-align: left; }
  .invite-title { margin: 0 0 4px; font-size: 16px; font-weight: 800; color: var(--text); }
  .invite-text { margin: 0 0 12px; font-size: 14px; line-height: 1.45; color: var(--muted); }
  .invite-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .invite-btn { display: grid; place-items: center; min-height: 44px; border-radius: 12px; color: #fff; font-size: 14px; font-weight: 700; text-decoration: none; }
  .invite-tg { background: #229ed9; }
  .invite-wa { background: #25a244; }
  .invite-link { margin: 10px 0 0; padding: 9px 12px; border-radius: 10px; background: rgba(127,127,127,0.08); font-size: 13.5px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; user-select: all; -webkit-user-select: all; }
  .invite-hint { margin: 8px 0 0; font-size: 12px; color: var(--muted); }
  .br-stamp-note { margin: 10px 0 0; font-size: 15.5px; font-weight: 600; line-height: 1.4; color: var(--text); }
  @media (prefers-reduced-motion: reduce) {
    .wheel { animation: none; transform: rotate(var(--end)); }
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
      `&select=id,code,business_id,prize,conditions,valid_from,valid_until,redeemed_at,created_at,reward_kind,invite_code,vip&limit=1`
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

// Для воронки в статистике: коды, выданные за период (и сколько из них уже погашено). cardId — одна карта.
export async function bonusFunnel(env, businessIds, { from, to, cardId = null }) {
  const rows = await db(
    env,
    `bonus_codes?business_id=in.(${businessIds.join(",")})` +
      `&created_at=gte.${encodeURIComponent(new Date(from).toISOString())}&created_at=lt.${encodeURIComponent(new Date(to).toISOString())}` +
      (cardId ? `&card_id=eq.${cardId}` : "") +
      `&select=redeemed_at&limit=10000`
  );
  return { issued: rows.length, redeemed: rows.filter((r) => r.redeemed_at).length };
}

// ---------- Мелочи ----------

function withCookie(response, cookie) {
  if (cookie) response.headers.append("Set-Cookie", cookie);
  return response;
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
