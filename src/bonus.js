// Бонус для гостей: одноразовый код на следующий визит, обычный или с колесом призов.
//
// Правила площадок (Яндекс Карты, 2ГИС) запрещают вознаграждать за отзывы, поэтому бонус
// НЕ зависит от отзыва: кнопку видит каждый, кто отсканировал карту (NFC или QR), и она появляется
// через несколько секунд после открытия страницы — ниже кнопок отзывов.
//
// Защита от злоупотреблений:
//  - только при скане карты (?s=nfc / ?s=qr), по прямой ссылке кнопки нет; сам код выдаётся только с меткой
//    касания карты (tap.js) — пересланная ссылка /bonus?… не работает;
//  - один код в день с отпечатка «сеть + браузер» и не больше GIFTS_PER_IP с одного адреса сети;
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
import { tapOf, ipAllow } from "./tap.js";

// Подарков в сутки с одного адреса сети на заведение (dailyGuard)
export const GIFTS_PER_IP = 10;

// Коды подарков — 6 цифр (быстро набрать на кассе). Старые коды с буквами по-прежнему принимаются.
const CODE_DIGITS = "0123456789";
const CODE_LENGTH = 6;
const DAY = 24 * 60 * 60 * 1000;
const MSK_OFFSET = 3 * 60 * 60 * 1000;
export const BONUS_DELAY_SECONDS = 10;

// Сектор колеса (bonus_prizes, jsonb): { label, weight, active, icon, tone, description, conditions, valid_days }.
// label и weight — как раньше; остальное необязательно (старые записи без этих полей работают как прежде).
// Значки и цвета секторов — из короткого списка, чтобы колесо оставалось в фирменной палитре.
export const WHEEL_MAX = 8; // ограничение базы (миграция 015)
export const WHEEL_RECOMMENDED = 6; // больше — надписи становятся мельче
export const WHEEL_ICONS = {
  auto: "Авто — по названию",
  coffee: "Чашка",
  discount: "Скидка",
  drink: "Напиток",
  dessert: "Десерт",
  gift: "Подарок",
  chef: "От шефа",
  star: "Звезда"
};
export const WHEEL_TONES = {
  auto: "Авто — чередовать",
  navy: "Глубокий синий",
  midnight: "Тёмно-синий",
  cream: "Кремовый",
  gold: "Светлое золото"
};

// Мягкая нормализация для показа (строгая проверка при сохранении — cleanBonus в admin-api.js)
export function normalizePrize(p) {
  const text = (v, max) => String((p && v) || "").trim().slice(0, max);
  const days = Number(p && p.valid_days);
  return {
    label: text(p.label, 60),
    weight: Math.max(0, Number(p && p.weight) || 0),
    active: !(p && p.active === false),
    icon: p && WHEEL_ICONS[p.icon] ? p.icon : "auto",
    tone: p && WHEEL_TONES[p.tone] ? p.tone : "auto",
    description: text(p.description, 80),
    conditions: text(p.conditions, 120),
    valid_days: Number.isInteger(days) && days >= 1 && days <= 365 ? days : null
  };
}

// Призы заведения: только включённые сектора с шансом. Для обычного бонуса — один приз из discount_text.
// Выключенный приз не крутится и не выпадает — его просто нет на колесе.
export function prizesOf(business) {
  if (business.bonus_mode === "wheel") {
    const list = Array.isArray(business.bonus_prizes) ? business.bonus_prizes : [];
    return list
      .filter((p) => p && typeof p === "object")
      .map(normalizePrize)
      .filter((p) => p.label && p.weight > 0 && p.active);
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
    // Предпросмотр для владельца и админки (/bonus?b=SLUG&s=qr&preview=1): то же колесо и та же выдача
    // по шансам, но в базу ничего не пишется, а код — заведомо ненастоящий «000-000» (касса его не примет).
    if (form.get("preview") === "1") return previewPage(business);
    // Только после касания карты (tap.js): пересланная ссылка /bonus?… без этого не работает
    if (!(await tapOf(request, env, business.id))) {
      return infoPage(403, "Поднесите телефон к карте или отсканируйте QR-код ещё раз — подарок выдаётся только в заведении");
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
    const prizes = prizesOf(business);

    const repeatResult = (code) => {
      // Для колеса показываем его уже остановленным на выпавшем призе — так понятно, что розыгрыш был
      const index = business.bonus_mode === "wheel" && !code.stamp_reward && !code.reward_kind && !code.vip && !code.sorry
        ? prizes.findIndex((p) => p.label === code.prize)
        : -1;
      const wheel = index >= 0 ? { prizes, index } : null;
      return withCookie(resultPage(business, code, { repeat: true, backUrl, wheel, ...extras }), setCookie);
    };
    if (existing.length) return repeatResult(existing[0]);

    // Защита от накрутки (миграция 023): один код в день с телефона и лимит кодов в день на заведение
    const guard = await dailyGuard(request, env, business);
    if (guard.blocked) {
      return withCookie(limitPage(business, backUrl, guard.blocked.heading, guard.blocked.text, rewards), setCookie);
    }

    // Все штампы собраны — вместо колеса особый приз владельца, счёт штампов начнётся заново.
    // VIP-гость (миграция 032) — VIP-подарок вместо колеса (приз за штампы важнее).
    const reward = stamps !== null && stamps >= business.stamps_goal;
    const vip = !reward && vipOn(business) && (await visitCount(env, business, visitorKey)) >= business.vip_visits;
    const index = reward || vip ? -1 : pickWeighted(prizes);
    const wheel = business.bonus_mode === "wheel" && index >= 0 ? { prizes, index } : null;
    const prizeLabel = reward ? String(business.stamps_prize).slice(0, 60) : vip ? String(business.vip_gift).slice(0, 60) : prizes[index].label;

    let cardId = null;
    if (cardCode) {
      const cards = await db(env, `cards?code=eq.${cardCode}&business_id=eq.${business.id}&select=id&limit=1`);
      cardId = cards.length ? cards[0].id : null;
    }

    // У сектора могут быть свои условия и срок действия — иначе общие настройки заведения
    const own = index >= 0 ? prizes[index] : null;
    const saved = await issueCode(env, business, {
      prize: prizeLabel,
      visitorKey,
      deviceDay: guard.deviceDay,
      cardId,
      extra: reward ? { stamp_reward: true } : vip ? { vip: true } : {},
      conditions: own && own.conditions ? own.conditions : undefined,
      validDays: own && own.valid_days ? own.valid_days : undefined,
      wheel
    });
    if (saved.repeat) return repeatResult(saved);
    if (saved.blocked) {
      const { heading, text } = GIFT_LIMITS[saved.blocked];
      return withCookie(limitPage(business, backUrl, heading, text, rewards), setCookie);
    }

    return withCookie(
      resultPage(business, saved, {
        repeat: false,
        backUrl,
        wheel: wheel ? { prizes, index: saved.wheel_index } : null,
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

export const CODE_FIELDS = "code,prize,conditions,valid_from,valid_until,redeemed_at,created_at,stamp_reward,reward_kind,vip,sorry";

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
const GIFT_LIMITS = {
  device: {
    heading: "Подарок с этого телефона сегодня уже получен",
    text: "Код был на экране, когда вы получали подарок. Новый подарок можно будет получить в другой день."
  },
  venue: { heading: "Подарки на сегодня закончились", text: "Приходите завтра — подарки снова будут ждать вас." }
};

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
  // Кроме отпечатка «сеть + браузер» — потолок на адрес сети: инкогнито или другой браузер на том же телефоне
  // меняют отпечаток, но не адрес. С запасом на общий Wi-Fi и мобильных операторов, у которых один адрес на многих.
  if (sameDevice.length || !(await ipAllow(request, env, `gift|${business.id}`, GIFTS_PER_IP, DAY))) {
    return { deviceDay, blocked: GIFT_LIMITS.device };
  }
  if (today.length >= limit) {
    return { deviceDay, blocked: GIFT_LIMITS.venue };
  }
  return { deviceDay, blocked: null };
}

// Новый одноразовый код подарка со сроками заведения. extra — stamp_reward / reward_kind / invite_code.
// Дни — по Москве. С задержкой: с начала дня через N дней и ещё bonus_valid_days дней.
// Без задержки: с этой минуты до конца (bonus_valid_days)-го дня, считая сегодняшний.
// conditions / validDays — свои у сектора колеса (иначе — заведения).
export async function issueCode(env, business, { prize, visitorKey, deviceDay = null, cardId = null, extra = {}, noDelay = false, conditions, validDays, wheel = null }) {
  const giftFields = (label, ownConditions, ownDays) => {
    const { validFrom, validUntil } = codeDates(business, { noDelay, validDays: ownDays });
    return {
      prize: String(label).slice(0, 60),
      conditions: (ownConditions !== undefined ? ownConditions : business.bonus_conditions) || null,
      valid_from: new Date(validFrom).toISOString(),
      valid_until: new Date(validUntil).toISOString()
    };
  };
  const candidates = wheel?.prizes.map((p) => giftFields(p.label, p.conditions || undefined, p.valid_days));
  const body = {
    business_id: business.id,
    card_id: cardId,
    visitor_key: visitorKey,
    device_day: deviceDay,
    ...extra,
    ...(wheel ? {} : giftFields(prize, conditions, validDays))
  };
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const code = randomString(CODE_DIGITS, CODE_LENGTH);
      if (wheel) {
        return await db(env, "rpc/issue_wheel_gift", {
          method: "POST",
          body: { p_gift: { ...body, code }, p_prizes: candidates, p_random_index: wheel.index, p_config: business.bonus_prizes }
        });
      }
      const inserted = await db(env, `bonus_codes?select=${CODE_FIELDS}`, {
        method: "POST",
        body: { ...body, code },
        prefer: "return=representation"
      });
      return inserted[0];
    } catch (error) {
      if (error.code !== "23505") throw error; // совпал код — пробуем другой
    }
  }
  throw new Error("Не удалось подобрать свободный код");
}

function codeDates(business, { noDelay = false, validDays } = {}) {
  const now = Date.now();
  const dayStart = Math.floor((now + MSK_OFFSET) / DAY) * DAY - MSK_OFFSET;
  const delayed = !noDelay && business.bonus_from_days > 0;
  const validFrom = delayed ? dayStart + business.bonus_from_days * DAY : now;
  const validUntil = (delayed ? validFrom : dayStart) + (validDays || business.bonus_valid_days || 14) * DAY;
  return { validFrom, validUntil };
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

// ---------- Страница подарка: колесо и карточка ----------
// Приз выбирает сервер и сразу выдаёт код (GET /bonus). Страница только красиво его открывает: гость нажимает
// на колесо → оно доворачивается ровно до выпавшего сектора (угол считает сервер) → появляется карточка подарка.
// Скрипт (с nonce) отвечает только за анимацию, звук и кнопку «Копировать». Без скрипта карточка появится сама
// через несколько секунд. Повторный заход — колесо уже стоит на призе, карточка сразу открыта.

// Цвета колеса по теме страницы: a/b — чередующиеся сектора, rim — обод, acc — золото, text — подписи
const WHEEL_THEMES = {
  classic: { rim: "#101D35", a: "#172744", b: "#101D35", text: "#FFFFFF", acc: "#D8AD58" },
  dark: { rim: "#121722", a: "#262d3e", b: "#1a2030", text: "#F3F4F8", acc: "#D8AD58" },
  coffee: { rim: "#24180f", a: "#4a3324", b: "#33231a", text: "#FFF7EE", acc: "#D8AD58" },
  fresh: { rim: "#0d261d", a: "#1d5040", b: "#143a2b", text: "#F2FFF8", acc: "#D8AD58" },
  rose: { rim: "#2e101c", a: "#5e2742", b: "#451a32", text: "#FFF3F8", acc: "#E0B566" },
  custom: { rim: "#15100b", a: "#3a2a1c", b: "#261b12", text: "#FFF3E2", acc: "#D8AD58" }
};
// Цвета, которые владелец может выбрать для сектора (фирменная палитра)
const TONE_COLORS = {
  navy: { fill: "#172744", text: "#FFFFFF", icon: "#D8AD58" },
  midnight: { fill: "#101D35", text: "#FFFFFF", icon: "#D8AD58" },
  cream: { fill: "#FAF7F0", text: "#172744", icon: "#A87A22" },
  gold: { fill: "#F2D99B", text: "#172744", icon: "#7E5A17" }
};
const SPIN_MS = 4600; // вращение: мягкий разгон, несколько оборотов, долгое плавное торможение
const SPIN_TURNS = 5;

// Значки — тонкие линии (viewBox 24)
const ICON_PATHS = {
  coffee: "M5 9h11v5a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5zM16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5c-.6.8-.6 1.7 0 2.5M11.5 3.5c-.6.8-.6 1.7 0 2.5",
  discount: "M3.5 12.5 11 5h7.5v7.5L11 20zM15 8.5h.01M9.5 15.5l4-4",
  drink: "M6 4h12l-1.5 7a4.5 4.5 0 0 1-9 0zM12 15.5V20M8.5 20h7",
  dessert: "M5.5 12h13l-1.6 8H7.1zM5.5 12a6.5 6.5 0 0 1 13 0M12 5.5V4M9.5 16h5",
  gift: "M4 10h16v4H4zM5.5 14h13v6h-13zM12 10v10M12 10c-1.6-3.6-6-4.2-6-1.4 0 1.5 2.6 1.4 6 1.4zM12 10c1.6-3.6 6-4.2 6-1.4 0 1.5-2.6 1.4-6 1.4z",
  chef: "M3.5 17.5h17M5 17.5a7 7 0 0 1 14 0M12 10.5V8.5M10.5 8.5h3M3.5 20.5h17",
  star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"
};
// «Авто» — значок по словам в названии
const ICON_AUTO = [
  [/кофе|капуч|латте|чай|какао|раф|эспрессо|американо/i, "coffee"],
  [/скидк|%|процент/i, "discount"],
  [/шот|коктейл|пив|вино|бокал|напит|лимонад|сок|морс/i, "drink"],
  [/десерт|торт|пирож|морож|чизкейк|круассан|печень|эклер/i, "dessert"],
  [/шеф|блюд|закуск|пицц|салат|комплимент/i, "chef"],
  [/подар|бесплат|сюрприз/i, "gift"]
];
function iconKey(p) {
  if (p.icon && p.icon !== "auto" && ICON_PATHS[p.icon]) return p.icon;
  const hit = ICON_AUTO.find(([re]) => re.test(p.label));
  return hit ? hit[1] : "star";
}
const iconSvg = (key) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON_PATHS[key]}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Геометрия: колесо 320×320, центр 160. Углы — по часовой от верха (там указатель).
const WC = 160;
const R_SEG = 146;
const point = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return `${(WC + r * Math.sin(a)).toFixed(2)} ${(WC - r * Math.cos(a)).toFixed(2)}`;
};
const sectorPath = (from, to, r = R_SEG) =>
  `M${WC} ${WC} L${point(r, from)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${point(r, to)} Z`;
const mixHex = (x, y) => {
  const n = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [a, b] = [n(x), n(y)];
  return `#${a.map((v, i) => Math.round((v + b[i]) / 2).toString(16).padStart(2, "0")).join("")}`;
};
// Угол в диапазон (-180; 180]
const norm180 = (deg) => {
  const d = ((deg % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
};

// Размеры подписей под число секторов (в единицах колеса 320): меньше секторов — крупнее
function labelLayout(n) {
  const r = n <= 3 ? 90 : n <= 6 ? 97 : 104;
  const w = Math.min(n <= 3 ? 120 : 100, 2 * r * Math.sin(Math.PI / n) * 0.84);
  const font = n <= 4 ? 14.5 : n <= 6 ? 12.5 : 11;
  const icon = n <= 4 ? 26 : n <= 6 ? 22 : 18;
  return { r, w, font, icon };
}

// still = колесо уже стоит на призе (повторный заход, предпросмотр после остановки)
function wheelHtml(prizes, index, { still = false, theme = "classic", sound = false } = {}) {
  const t = WHEEL_THEMES[theme] || WHEEL_THEMES.classic;
  const n = prizes.length;
  const seg = 360 / n;
  const L = labelLayout(n);
  const cq = (v) => `${(v / 3.2).toFixed(3)}cqw`; // единицы колеса → доля ширины колеса
  // Финальный поворот диска: центр сектора index встаёт под указатель. Небольшой разброс внутри сектора —
  // чтобы остановка выглядела живой; до разделителя остаётся не меньше 20% сектора.
  const jitter = still ? 0 : (crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 - 0.5) * seg * 0.6;
  const end = 360 * SPIN_TURNS - index * seg + jitter;
  const rest = ((end % 360) + 360) % 360;

  const colors = prizes.map((p, i) => {
    if (TONE_COLORS[p.tone]) return TONE_COLORS[p.tone];
    // при нечётном числе последний «авто»-сектор — промежуточный оттенок, чтобы не слился с первым
    const fill = n % 2 === 1 && i === n - 1 ? mixHex(t.a, t.b) : i % 2 ? t.b : t.a;
    return { fill, text: t.text, icon: t.acc };
  });
  const sectors = prizes
    .map((_, i) => `<path class="gw-seg" d="${sectorPath(i * seg - seg / 2, i * seg + seg / 2)}" fill="${colors[i].fill}"/>`)
    .join("");
  const dims = prizes
    .map((p, i) => `<path class="gw-dim${p.tone === "cream" || p.tone === "gold" ? " gw-dim-l" : ""}${i === index ? " gw-dim-win" : ""}" d="${sectorPath(i * seg - seg / 2, i * seg + seg / 2)}"/>`)
    .join("");
  const win = sectorPath(index * seg - seg / 2, index * seg + seg / 2);
  const lines = prizes
    .map((_, i) => `<line x1="${point(34, i * seg - seg / 2).replace(" ", `" y1="`)}" x2="${point(R_SEG, i * seg - seg / 2).replace(" ", `" y2="`)}"/>`)
    .join("");
  const dots = prizes.map((_, i) => `<circle cx="${point(152.5, i * seg - seg / 2).replace(" ", `" cy="`)}" r="1.7"/>`).join("");

  const labels = prizes
    .map((p, i) => {
      const angle = i * seg;
      // Подпись стоит ровно: до вращения — при диске в нуле, после — при диске на финальном угле
      const finalCa = norm180(-angle - rest);
      const ca = still ? finalCa : norm180(-angle);
      return `<span class="gw-l" style="transform: rotate(${angle.toFixed(2)}deg)">` +
        `<span class="gw-li" data-final="${finalCa.toFixed(2)}" style="--ca: ${ca.toFixed(2)}deg; top: -${cq(L.r)}; left: -${cq(L.w / 2)}; width: ${cq(L.w)}; ` +
        `font-size: ${cq(L.font)}; --ic: ${cq(L.icon)}; color: ${colors[i].text};">` +
        `<span class="gw-ic" style="color: ${colors[i].icon}">${iconSvg(iconKey(p))}</span>${escapeHtml(p.label)}</span></span>`;
    })
    .join("");

  return `
    <div class="gw${still ? " is-done" : ""}" data-end="${end.toFixed(2)}" data-seg="${seg.toFixed(4)}"
      style="--gw-rim: ${t.rim}; --gw-acc: ${t.acc}; --gw-hub: ${t.a};">
      <div class="gw-disc" style="transform: rotate(${(still ? rest : 0).toFixed(2)}deg)">
        <svg class="gw-svg" viewBox="0 0 320 320" aria-hidden="true">
          <defs><radialGradient id="gw-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0.25" stop-color="${t.acc}" stop-opacity="0"/><stop offset="1" stop-color="${t.acc}" stop-opacity="0.38"/>
          </radialGradient></defs>
          <circle cx="160" cy="160" r="159" fill="${t.rim}"/>
          <circle cx="160" cy="160" r="158.3" fill="none" stroke="${t.acc}" stroke-opacity="0.85" stroke-width="1"/>
          ${sectors}
          <g class="gw-dims">${dims}</g>
          <path class="gw-glow" d="${win}" fill="url(#gw-glow)"/>
          <g stroke="${t.acc}" stroke-opacity="0.5" stroke-width="0.9">${lines}</g>
          <circle cx="160" cy="160" r="${R_SEG + 0.4}" fill="none" stroke="${t.acc}" stroke-opacity="0.45" stroke-width="0.8"/>
          <path class="gw-hl" d="${win}" fill="none" stroke="${t.acc}" stroke-width="2.4" stroke-linejoin="round"/>
          <g fill="${t.acc}" fill-opacity="0.9">${dots}</g>
        </svg>
        ${labels}
      </div>
      <span class="gw-flash" aria-hidden="true"></span>
      <span class="gw-ripple" aria-hidden="true"></span>
      <span class="gw-pin" aria-hidden="true"><svg viewBox="0 0 28 36"><defs><linearGradient id="gw-pin" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#F2D99B"/><stop offset="1" stop-color="${t.acc}"/></linearGradient></defs>
        <path d="M14 35C12 31 2.5 21 2.5 13a11.5 11.5 0 0 1 23 0c0 8-9.5 18-11.5 22z" fill="url(#gw-pin)" stroke="rgba(16,29,53,.35)" stroke-width=".8"/>
        <circle cx="14" cy="13" r="4" fill="${t.rim}"/></svg></span>
      ${still
        ? `<div class="gw-hub" aria-hidden="true"><span class="gw-mark">TR</span></div>`
        : `<button class="gw-hub" type="button" aria-label="Жми, чтобы открыть подарок" disabled>
            <span class="gw-mark" aria-hidden="true">TR</span>
            <span class="gw-action" aria-hidden="true">ЖМИ</span>
          </button>`}
      <span class="gw-sparks" aria-hidden="true"></span>
    </div>
    ${sound ? `<button class="gw-sound" type="button" aria-pressed="false" aria-label="Включить звук" hidden>
      <svg class="gw-snd-off" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <svg class="gw-snd-on" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>Звук</span>
    </button>` : ""}`;
}

function formatCode(code) {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

function dayLabel(ms) {
  return new Date(ms).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });
}

export function validityText(c) {
  return `Действует ${validityShort(c)}`;
}

// «до 2 декабря включительно» / «с 19 ноября по 2 декабря»
function validityShort(c) {
  const from = Date.parse(c.valid_from);
  const lastDay = Date.parse(c.valid_until) - 1;
  if (from <= Date.now()) return `до ${dayLabel(lastDay)} включительно`;
  return `с ${dayLabel(from)} по ${dayLabel(lastDay)}`;
}

// Карточка подарка — как подарочный сертификат: приз, код с кнопкой «Копировать», как получить, сроки, условия
function giftCard(business, c, { repeat, pending, prize, preview }) {
  const kicker = c.stamp_reward ? "Подарок за штампы" : c.reward_kind === "friend" ? "Подарок от друга" : c.vip ? "⭐ VIP-подарок" : "Ваш подарок";
  const title = c.stamp_reward ? "Все штампы собраны!" : repeat ? "Ваш подарок уже ждёт вас" : "Для вас приготовлен подарок!";
  const nextAt = c.created_at ? Date.parse(c.created_at) + business.bonus_cooldown_days * DAY : null;
  const rows = [
    ["Срок действия", validityShort(c)],
    nextAt ? [business.bonus_mode === "wheel" ? "Повторное участие" : "Новый подарок", `с ${dayLabel(nextAt)}`] : null,
    c.conditions ? ["Условия", c.conditions] : null
  ].filter(Boolean);
  const status = c.redeemed_at
    ? `<p class="br-warn">Этот код уже использован ${escapeHtml(dayLabel(Date.parse(c.redeemed_at)))}. Новый подарок можно будет получить позже.</p>`
    : "";
  return `
    <section class="gc${pending ? " gc-pending" : ""}" aria-live="polite">
      <p class="gc-kicker">${kicker}</p>
      <h2 class="gc-title">${title}</h2>
      <div class="gc-rule"></div>
      <p class="gc-prize">${escapeHtml(c.prize)}</p>
      ${prize && prize.description ? `<p class="gc-desc">${escapeHtml(prize.description)}</p>` : ""}
      <div class="gc-code">
        <span class="gc-code-label">Код</span>
        <span class="gc-code-value" aria-label="Код ${escapeHtml(c.code.split("").join(" "))}">${escapeHtml(formatCode(c.code))}</span>
        ${preview ? "" : `<button class="gc-copy" type="button" data-copy="${escapeHtml(c.code)}" hidden>Копировать</button>`}
      </div>
      <p class="gc-how">Покажите код сотруднику на кассе</p>
      <p class="gc-shot">Код сохранён на этом телефоне: откройте подарок с карты ещё раз — он будет здесь.</p>
      <dl class="gc-meta">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl>
      ${status}
    </section>`;
}

function resultPage(business, c, { repeat, backUrl, wheel = null, stamps = null, rewards = [], invite = null, preview = false }) {
  // Штампы: приз за штампы — праздничная надпись; обычный код — прогресс и «штамп поставят на кассе»
  let stampBox = "";
  if (stampsOn(business) && stamps !== null) {
    stampBox = c.stamp_reward
      ? `<p class="br-stamp">🎉 Все ${business.stamps_goal} ${plural(business.stamps_goal, "штамп", "штампа", "штампов")} собраны — это ваш особый подарок. Штампы начинают копиться заново.</p>`
      : `${stampsHtml(business, stamps)}${c.redeemed_at ? "" : `<p class="br-stamp-note">Штамп появится, когда персонал погасит этот код.</p>`}`;
  }
  const spin = Boolean(wheel) && !repeat; // колесо ждёт нажатия
  const prize = wheel ? wheel.prizes[wheel.index] : null;
  const stage = wheel
    ? `<div class="gs" data-state="${spin ? "idle" : "result"}">
        ${spin ? `<p class="gs-lead">Для вас приготовлен небольшой сюрприз</p>` : ""}
        ${wheelHtml(wheel.prizes, wheel.index, { still: !spin, theme: business.theme, sound: spin })}
        ${spin ? `<p class="gs-hint" aria-live="polite">Нажмите на колесо, чтобы открыть свой подарок</p>` : ""}
      </div>`
    : `<div class="br-gift" aria-hidden="true">${GIFT}</div>`;

  return renderPage({
    status: 200,
    title: `Подарок — ${business.name}`,
    accent: null,
    theme: business.theme,
    design: customDesign(business),
    extraCss: BONUS_PAGE_CSS,
    // Как на странице заведения: зелёная кнопка на сайт TapReview (через реферальную ссылку заведения)
    footer: { href: `/r/${business.slug}?s=card`, text: "Хочу такую карту" },
    script: GIFT_SCRIPT,
    body: `
      <h1 class="name name-long">${escapeHtml(business.name)}</h1>
      <div class="divider"></div>
      ${preview ? `<p class="gp-note">Предпросмотр: так колесо увидит гость. Приз выпадает по настоящим шансам, но код не настоящий и в базу ничего не записывается.</p>` : ""}
      ${rewardsHtml(rewards)}
      ${stage}
      ${giftCard(business, c, { repeat, pending: spin, prize, preview })}
      ${stampBox}
      ${invite ? inviteBlock(business, invite) : ""}
      <p class="br-rules">Подарок не зависит от отзыва. Один подарок на устройство за ${business.bonus_cooldown_days} ${plural(business.bonus_cooldown_days, "день", "дня", "дней")}.</p>
      <a class="br-back" href="${escapeHtml(backUrl)}">← Вернуться к странице заведения</a>`
  });
}

// Предпросмотр колеса (?preview=1): приз — по тем же шансам, сроки — как у настоящего кода, код «000-000».
function previewPage(business) {
  const prizes = prizesOf(business);
  if (business.bonus_mode !== "wheel") return infoPage(404, "Предпросмотр есть только у колеса подарков");
  const index = pickWeighted(prizes);
  const p = prizes[index];
  const { validFrom, validUntil } = codeDates(business, { validDays: p.valid_days || undefined });
  const c = {
    code: "000000",
    prize: p.label,
    conditions: p.conditions || business.bonus_conditions || null,
    valid_from: new Date(validFrom).toISOString(),
    valid_until: new Date(validUntil).toISOString(),
    created_at: new Date().toISOString()
  };
  return resultPage(business, c, { repeat: false, backUrl: `/b/${business.slug}`, wheel: { prizes, index }, preview: true });
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
  /* ---------- Колесо подарков ---------- */
  .gs { position: relative; margin: 2px 0 20px; }
  .gs-lead { margin: 0; font-size: 15px; line-height: 1.45; color: var(--muted); animation: gs-in 0.6s ease 0.05s both; }
  .gw {
    position: relative; align-self: center; width: min(384px, calc(100% + 24px)); aspect-ratio: 1 / 1; margin: 26px 0 0;
    container-type: inline-size; touch-action: manipulation; -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none;
    animation: gw-in 0.75s cubic-bezier(0.2, 0.7, 0.2, 1) 0.15s both;
  }
  .gs-js[data-state="idle"] .gw { cursor: pointer; }
  .gw-disc { position: absolute; inset: 0; border-radius: 50%; will-change: transform; filter: drop-shadow(0 12px 20px rgba(16, 29, 53, 0.22)); }
  .gw-svg { display: block; width: 100%; height: 100%; }
  .gw-dim { fill: var(--gw-rim); opacity: 0; transition: opacity 0.7s ease; }
  .gw.is-done .gw-dim:not(.gw-dim-win) { opacity: 0.42; }
  .gw-dim-l { fill: #B79F6B; } /* светлые сектора гаснут в тёплый бежевый, а не в серый */
  .gw.is-done .gw-dim-l:not(.gw-dim-win) { opacity: 0.32; }
  .gw-glow, .gw-hl { opacity: 0; transition: opacity 0.8s ease 0.1s; }
  .gw.is-done .gw-glow, .gw.is-done .gw-hl { opacity: 1; }
  /* подпись: держатель повёрнут к своему сектору, сама подпись — ровно (--ca) */
  .gw-l { position: absolute; left: 50%; top: 50%; width: 0; height: 0; pointer-events: none; }
  .gw-li {
    position: absolute; display: flex; flex-direction: column; align-items: center; gap: 0.35em;
    transform: translateY(-50%) rotate(var(--ca)); transition: transform 0.8s cubic-bezier(0.3, 0.7, 0.2, 1);
    font-weight: 600; line-height: 1.18; text-align: center; letter-spacing: 0.005em; overflow-wrap: anywhere;
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.18);
  }
  .gw-ic { display: block; width: var(--ic); height: var(--ic); }
  .gw-ic svg { display: block; width: 100%; height: 100%; }
  /* указатель — золотая метка сверху, слегка вздрагивает на разделителях */
  .gw-pin { position: absolute; z-index: 3; left: 50%; top: 0; width: 9.5%; transform: translate(-50%, -46%); transform-origin: 50% 30%; filter: drop-shadow(0 3px 4px rgba(16, 29, 53, 0.3)); }
  .gw-pin svg { display: block; width: 100%; height: auto; }
  .gw-pin.is-tick { animation: gw-tick 0.18s ease-out; }
  @keyframes gw-tick { 0%, 100% { transform: translate(-50%, -46%) rotate(0); } 35% { transform: translate(-50%, -46%) rotate(-10deg); } }
  /* центральная кнопка TR */
  .gw-hub {
    position: absolute; z-index: 2; left: 50%; top: 50%; width: 24%; height: 24%; margin: 0; padding: 0; border: 0; border-radius: 50%;
    transform: translate(-50%, -50%); display: grid; place-items: center; cursor: inherit;
    background: radial-gradient(circle at 50% 30%, color-mix(in srgb, var(--gw-hub) 82%, #fff), var(--gw-hub) 62%, var(--gw-rim));
    box-shadow: 0 0 0 1.5px var(--gw-acc), 0 0 0 4.5px var(--gw-rim), 0 0 0 5.5px color-mix(in srgb, var(--gw-acc) 55%, transparent), 0 8px 16px rgba(7, 13, 26, 0.35);
    transition: transform 0.16s ease;
  }
  .gw-hub span { grid-area: 1 / 1; line-height: 1; }
  .gw-mark { font-family: var(--serif, "Playfair Display", Georgia, serif); font-size: 8.4cqw; font-weight: 600; letter-spacing: 0.02em; color: #F2D99B; }
  .gw-action { display: none; font-family: var(--sans, sans-serif); font-size: 6.4cqw; font-weight: 800; }
  .gw-hub:enabled { background: radial-gradient(circle at 50% 25%, #FFF2C6, #D8AD58); color: #241907; }
  .gw-hub:enabled .gw-action { display: block; }
  .gw-hub:enabled .gw-mark { color: inherit; opacity: 0; }
  .gw-hub:focus-visible { outline: 2px solid var(--gw-acc); outline-offset: 6px; }
  /* Два цикла, затем подсказка остаётся на кнопке до нажатия. */
  @media (prefers-reduced-motion: no-preference) {
    .gw.is-pressed .gw-hub { transform: translate(-50%, -50%) scale(0.9); }
    .gw-hub:enabled .gw-action { animation: gw-action 2.3s ease 0.3s 2; }
    .gw-hub:enabled .gw-mark { animation: gw-mark 2.3s ease 0.3s 2; }
  }
  @keyframes gw-action {
    0%, 49%, 100% { opacity: 1; transform: scale(1); }
    22% { transform: scale(1.09); }
    58%, 89% { opacity: 0; transform: scale(0.93); }
  }
  @keyframes gw-mark {
    0%, 58%, 89%, 100% { opacity: 0; }
    65%, 82% { opacity: 1; }
  }
  /* нажатие: тонкая золотая волна и мягкая вспышка от центра */
  .gw-ripple, .gw-flash { position: absolute; left: 50%; top: 50%; border-radius: 50%; pointer-events: none; opacity: 0; }
  .gw-ripple { z-index: 1; width: 24%; height: 24%; border: 1.5px solid var(--gw-acc); transform: translate(-50%, -50%); }
  .gw-flash { z-index: 1; width: 70%; height: 70%; transform: translate(-50%, -50%); background: radial-gradient(circle, rgba(255, 246, 220, 0.55), rgba(242, 217, 155, 0) 65%); }
  .gw.is-go .gw-ripple { animation: gw-ripple 0.95s cubic-bezier(0.2, 0.6, 0.3, 1) both; }
  .gw.is-go .gw-flash { animation: gw-flash 0.55s ease-out both; }
  @keyframes gw-ripple { 0% { opacity: 0.9; transform: translate(-50%, -50%) scale(1); } 100% { opacity: 0; transform: translate(-50%, -50%) scale(4); } }
  @keyframes gw-flash { 0% { opacity: 0; } 30% { opacity: 1; } 100% { opacity: 0; } }
  /* немного золотых искр после остановки */
  .gw-sparks { position: absolute; z-index: 4; left: 50%; top: 2%; width: 0; height: 0; pointer-events: none; }
  .gw-sp { position: absolute; left: -3px; top: -3px; width: 6px; height: 6px; border-radius: 50%; background: var(--gw-acc); opacity: 0;
    animation: gw-sp 1.3s cubic-bezier(0.2, 0.7, 0.3, 1) var(--d) forwards; }
  .gw-sp.is-d { width: 5px; height: 5px; border-radius: 1px; background: #F2D99B; }
  @keyframes gw-sp {
    0% { opacity: 0; transform: translate(0, 0) scale(0.4) rotate(45deg); }
    15% { opacity: 1; }
    100% { opacity: 0; transform: translate(var(--x), var(--y)) scale(1) rotate(45deg); }
  }
  .gs-hint { display: none; margin: 18px 0 0; min-height: 1.45em; font-size: 14px; line-height: 1.45; color: var(--muted); }
  .gs-js .gs-hint { display: block; animation: gs-in 0.6s ease 1.1s both; }
  .gs { display: flex; flex-direction: column; }
  .gw-sound {
    order: 1; align-self: center; display: inline-flex; align-items: center; gap: 6px; min-height: 34px; margin: 12px 0 0; padding: 0 14px 0 11px;
    border: 1px solid color-mix(in srgb, var(--muted) 35%, transparent); border-radius: 999px; background: transparent;
    color: var(--muted); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .gw-sound[hidden] { display: none; }
  .gw-sound svg { width: 17px; height: 17px; }
  .gw-sound .gw-snd-on, .gw-sound[aria-pressed="true"] .gw-snd-off { display: none; }
  .gw-sound[aria-pressed="true"] .gw-snd-on { display: block; }
  .gw-sound[aria-pressed="true"] { color: var(--text); border-color: var(--gw-acc, #D8AD58); }
  @keyframes gs-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @keyframes gw-in { from { opacity: 0; transform: scale(0.94); } to { opacity: 1; transform: none; } }

  /* ---------- Карточка подарка: как подарочный сертификат ---------- */
  .gc {
    position: relative; margin: 0; padding: 24px 20px 20px; border: 1px solid #E8DCC0; border-radius: 20px;
    background: #FAF7F0; color: #172744; text-align: center; box-shadow: 0 10px 28px rgba(16, 29, 53, 0.1);
  }
  .gc::before { content: ""; position: absolute; inset: 6px; border: 1px solid rgba(216, 173, 88, 0.45); border-radius: 15px; pointer-events: none; }
  .gc-pending { animation: gc-in 0.5s ease 4.5s both; } /* без скрипта карточка появится сама */
  /* пока колесо не остановилось, карточки нет и места она не занимает */
  .gc.gc-hold { position: absolute; left: 0; right: 0; height: 0; overflow: hidden; animation: none; opacity: 0; visibility: hidden; pointer-events: none; }
  .gc.gc-show { animation: gc-in 0.6s cubic-bezier(0.2, 0.7, 0.2, 1) both; }
  @keyframes gc-in { from { opacity: 0; visibility: hidden; transform: translateY(14px); } to { opacity: 1; visibility: visible; transform: none; } }
  .gc-kicker { margin: 0; font-size: 11.5px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: #A27A2C; }
  .gc-title { margin: 8px 0 0; font-family: var(--serif, "Playfair Display", Georgia, serif); font-size: 21px; font-weight: 600; line-height: 1.25; color: #172744; }
  .gc-rule { width: 40px; height: 1px; margin: 14px auto; background: #D8AD58; }
  .gc-prize { margin: 0; font-size: 25px; font-weight: 700; line-height: 1.2; color: #101D35; overflow-wrap: anywhere; }
  .gc-desc { margin: 6px 0 0; font-size: 14px; line-height: 1.45; color: #777F8D; }
  .gc-code {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px 12px; width: fit-content; max-width: 100%;
    margin: 18px auto 0; padding: 10px 10px 10px 16px; border: 1px dashed #D8AD58; border-radius: 14px; background: #FFFFFF;
  }
  .gc-code-label { font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #777F8D; }
  .gc-code-value { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 28px; font-weight: 700; letter-spacing: 0.1em; color: #101D35; user-select: all; -webkit-user-select: all; }
  .gc-copy {
    min-height: 38px; padding: 0 14px; border: 1px solid #172744; border-radius: 999px; background: #172744; color: #FAF7F0;
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.2s ease, border-color 0.2s ease;
  }
  .gc-copy[hidden] { display: none; }
  .gc-copy.is-done { background: #2F7A55; border-color: #2F7A55; }
  .gc-how { margin: 14px 0 0; font-size: 15.5px; font-weight: 600; line-height: 1.4; color: #172744; }
  .gc-shot { margin: 4px 0 0; font-size: 12.5px; line-height: 1.45; color: #777F8D; }
  .gc-meta { display: grid; gap: 8px; margin: 16px 0 0; padding: 14px 2px 0; border-top: 1px solid #EDE3CC; text-align: left; }
  .gc-meta div { display: flex; justify-content: space-between; gap: 14px; font-size: 13.5px; line-height: 1.4; }
  .gc-meta dt { flex: none; color: #777F8D; }
  .gc-meta dd { margin: 0; font-weight: 600; text-align: right; color: #172744; }
  .gc .br-warn { text-align: left; }
  .gp-note { margin: 0 0 14px; padding: 10px 12px; border-radius: 12px; background: #FFF6DD; color: #6B4E12; font-size: 13px; line-height: 1.45; }

  /* ---------- Подарок без колеса, «за друга», лимиты (friends.js и др.) ---------- */
  .br-gift { width: 64px; height: 64px; margin: 4px auto 16px; }
  .br-gift svg { width: 100%; height: 100%; }
  .br { padding: 18px 18px 16px; border: 1px dashed #e2c46e; border-radius: 18px; background: #fffdf6; color: #141a2b; }
  .br-fade { animation: br-in 0.5s ease 0.2s both; }
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
  .br .stamps, .br ~ .stamps, .gc ~ .stamps { margin-top: 16px; }
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
    .gs-lead, .gw, .gs-js .gs-hint, .gc-pending { animation-duration: 0.01s; animation-delay: 0s; }
    .gw.is-go .gw-ripple, .gw.is-go .gw-flash { animation: none; }
    .gc-pending { animation-delay: 1.5s; }
    .gc.gc-show { animation-duration: 0.01s; }
    .gw-li, .gw-dim, .gw-glow, .gw-hl { transition: none; }
    .br-fade { animation: none; }
  }
`;

// Анимация колеса. Состояния: idle → pressed → spinning → result (или error — тогда карточка просто открывается).
// Угол остановки (data-end) посчитал сервер под уже выданный приз — скрипт его не выбирает и не меняет.
const GIFT_SCRIPT = `(function () {
  var doc = document;
  var card = doc.querySelector(".gc");
  // «Копировать» код
  var copy = doc.querySelector(".gc-copy");
  if (copy) {
    copy.hidden = false;
    copy.addEventListener("click", function () {
      var code = copy.getAttribute("data-copy");
      var done = function () {
        copy.textContent = "Скопировано"; copy.classList.add("is-done");
        setTimeout(function () { copy.textContent = "Копировать"; copy.classList.remove("is-done"); }, 2000);
      };
      var fallback = function () {
        var t = doc.createElement("textarea");
        t.value = code; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
        doc.body.appendChild(t); t.select();
        try { if (doc.execCommand("copy")) done(); } catch (e) {}
        t.remove();
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, fallback);
      else fallback();
    });
  }

  var stage = doc.querySelector(".gs");
  if (!stage || stage.getAttribute("data-state") !== "idle" || !card) return;
  var wheel = stage.querySelector(".gw"), disc = stage.querySelector(".gw-disc"), pin = stage.querySelector(".gw-pin");
  var hub = wheel.querySelector(".gw-hub");
  var hint = stage.querySelector(".gs-hint"), soundBtn = stage.querySelector(".gw-sound");
  var end = Number(wheel.getAttribute("data-end")), seg = Number(wheel.getAttribute("data-seg"));
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var state = "idle";
  function setState(s) { state = s; stage.setAttribute("data-state", s); }

  // Карточка ждёт остановки колеса (без скрипта она появляется сама — .gc-pending)
  card.classList.remove("gc-pending");
  card.classList.add("gc-hold");
  stage.classList.add("gs-js");

  // Звук: выключен по умолчанию, включается кнопкой. Тихие синтезированные тона, без файлов.
  var ctx = null, soundOn = false;
  try { soundOn = localStorage.getItem("tr_gift_sound") === "1"; } catch (e) {}
  function audio() {
    if (!ctx) { var A = window.AudioContext || window.webkitAudioContext; if (!A) return null; ctx = new A(); }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function tone(freq, dur, gain, type, delay) {
    if (!soundOn) return;
    try {
      var a = audio(); if (!a) return;
      var t0 = a.currentTime + (delay || 0), o = a.createOscillator(), g = a.createGain();
      o.type = type || "sine"; o.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(a.destination); o.start(t0); o.stop(t0 + dur + 0.05);
    } catch (e) {}
  }
  function syncSound() {
    soundBtn.setAttribute("aria-pressed", soundOn ? "true" : "false");
    soundBtn.setAttribute("aria-label", soundOn ? "Выключить звук" : "Включить звук");
  }
  if (soundBtn) {
    soundBtn.hidden = false; syncSound();
    soundBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      soundOn = !soundOn;
      try { localStorage.setItem("tr_gift_sound", soundOn ? "1" : "0"); } catch (x) {}
      syncSound();
      tone(660, 0.16, 0.04);
    });
  }
  function buzz(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }

  // cubic-bezier: мягкий разгон, несколько оборотов, долгое плавное торможение
  function bezier(x1, y1, x2, y2) {
    function k(p1, p2) { var c = 3 * p1, b = 3 * (p2 - p1) - c; return { a: 1 - c - b, b: b, c: c }; }
    var X = k(x1, x2), Y = k(y1, y2);
    function f(q, t) { return ((q.a * t + q.b) * t + q.c) * t; }
    function d(q, t) { return (3 * q.a * t + 2 * q.b) * t + q.c; }
    return function (x) {
      var t = x;
      for (var i = 0; i < 8; i++) { var s = d(X, t); if (Math.abs(s) < 1e-6) break; t -= (f(X, t) - x) / s; t = Math.min(1, Math.max(0, t)); }
      return f(Y, t);
    };
  }
  var ease = bezier(0.42, 0, 0.12, 1);

  function start(e) {
    if (state !== "idle") return; // повторные нажатия игнорируются
    if (e) e.preventDefault();
    setState("pressed");
    hub.disabled = true;
    if (hint) hint.textContent = "Открываем подарок…";
    wheel.classList.add("is-pressed", "is-go");
    tone(520, 0.12, 0.045); buzz(10);
    setTimeout(function () { wheel.classList.remove("is-pressed"); safe(spin); }, reduce ? 0 : 200);
  }
  function spin() {
    setState("spinning");
    if (reduce) { disc.style.transform = "rotate(" + end + "deg)"; return finish(); }
    var t0 = null, lastSep = 0, lastTick = 0;
    function frame(now) {
      if (t0 === null) t0 = now;
      var p = Math.min(1, (now - t0) / ${SPIN_MS});
      var a = end * ease(p);
      disc.style.transform = "rotate(" + a.toFixed(2) + "deg)";
      var sep = Math.floor((a + seg / 2) / seg);
      if (sep !== lastSep) {
        lastSep = sep;
        if (now - lastTick > 60) {
          lastTick = now;
          pin.classList.remove("is-tick"); void pin.offsetWidth; pin.classList.add("is-tick");
          tone(1400, 0.035, 0.01, "triangle");
        }
      }
      if (p < 1) requestAnimationFrame(function (n) { safe(function () { frame(n); }); });
      else finish();
    }
    requestAnimationFrame(function (n) { safe(function () { frame(n); }); });
  }
  function finish() {
    if (state === "result") return;
    setState("result");
    disc.style.transform = "rotate(" + end + "deg)";
    wheel.classList.add("is-done");
    var labels = disc.querySelectorAll(".gw-li");
    for (var i = 0; i < labels.length; i++) labels[i].style.setProperty("--ca", labels[i].getAttribute("data-final") + "deg");
    tone(784, 0.5, 0.035); tone(988, 0.6, 0.03, "sine", 0.09); tone(1175, 0.9, 0.025, "sine", 0.18);
    buzz([12, 40, 18]);
    if (!reduce) sparkle();
    if (hint) hint.textContent = "Готово! Ваш подарок — ниже";
    setTimeout(showCard, reduce ? 0 : 450);
  }
  function showCard() {
    card.classList.remove("gc-hold", "gc-pending");
    card.classList.add("gc-show");
    var r = card.getBoundingClientRect();
    if (r.top > window.innerHeight - 140) card.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  }
  function sparkle() {
    var box = wheel.querySelector(".gw-sparks");
    for (var i = 0; i < 12; i++) {
      var s = doc.createElement("i");
      var ang = (-165 + (150 * i) / 11 + (Math.random() - 0.5) * 10) * Math.PI / 180;
      var dist = 34 + Math.random() * 42;
      s.className = "gw-sp" + (i % 3 === 0 ? " is-d" : "");
      s.style.setProperty("--x", (Math.cos(ang) * dist).toFixed(1) + "px");
      s.style.setProperty("--y", (Math.sin(ang) * dist).toFixed(1) + "px");
      s.style.setProperty("--d", (Math.random() * 0.15).toFixed(2) + "s");
      box.appendChild(s);
    }
    setTimeout(function () { box.textContent = ""; }, 1800);
  }
  // Любая ошибка анимации — просто открываем подарок: код уже выдан
  function safe(fn) {
    try { fn(); } catch (e) { setState("error"); wheel.classList.add("is-done"); if (hint) hint.textContent = "Ваш подарок — ниже"; showCard(); }
  }
  wheel.addEventListener("click", function (e) { safe(function () { start(e); }); });
  hub.disabled = false;
})();`;

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
