// «Подарите другу» (миграция 030).
//
// 1. На экране своего подарка гость видит ссылку /f/КОД (одна на гостя и заведение) и кнопки Telegram / WhatsApp.
// 2. Друг открывает ссылку → видит «Друг дарит вам …» и кнопку «Получить подарок» (/f/КОД?claim=1).
//    Два шага нарочно: превью ссылки в мессенджере открывает страницу, но на кнопку не нажимает.
//    Подарок — только новому гостю этого заведения (на этом телефоне не было визитов и кодов),
//    не больше 3 друзей за 30 дней по одной ссылке, плюс обычные лимиты подарков (один код в день с телефона, лимит в день).
// 3. Друг приходит, кассир гасит его код → пригласивший получает свой подарок за друга (rewardInviter).
//    Его он увидит на странице подарка при следующем касании карты.
// Подарок не зависит от отзывов — это приглашение в заведение.

import { db } from "./supabase.js";
import { renderPage, escapeHtml, GIFT, BONUS_COLUMNS, customDesign, isHttpsUrl } from "./public-page.js";
import { isBot } from "./analytics.js";
import { isExpired } from "./billing.js";
import { deviceFrom, visitorKeyOf } from "./guests.js";
import { has } from "./tariffs.js";
import { issueCode, dailyGuard, validityText, formatCode, BONUS_PAGE_CSS, CODE_FIELDS, infoPage, withCookie } from "./bonus.js";

const CODE_RE = /^[a-z0-9]{8}$/;
const CODE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const FRIENDS_PER_MONTH = 3;
const DAY = 86400000;

export function friendOn(business) {
  return Boolean(business.friend_gift && business.friend_reward && business.bonus_mode && business.bonus_mode !== "off") && has(business, "gifts");
}

// Ссылка гостя для друзей: { code, url }. Одна на гостя и заведение — создаём при первом показе.
export async function inviteFor(env, business, key) {
  const base = String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const find = () => db(env, `guest_invites?business_id=eq.${business.id}&inviter_key=eq.${key}&select=code&limit=1`);
  let rows = await find();
  for (let attempt = 0; !rows.length && attempt < 5; attempt++) {
    try {
      rows = await db(env, "guest_invites?select=code", {
        method: "POST",
        body: { code: randomString(CODE_ALPHABET, 8), business_id: business.id, inviter_key: key },
        prefer: "return=representation"
      });
    } catch (error) {
      if (error.code !== "23505") throw error; // совпал код или ссылка уже создана параллельно
      rows = await find();
    }
  }
  if (!rows.length) return null;
  return { code: rows[0].code, url: `${base}/f/${rows[0].code}` };
}

// Неиспользованные подарки «за друга», срок которых не вышел
export async function inviterRewards(env, business, key) {
  return db(
    env,
    `bonus_codes?business_id=eq.${business.id}&visitor_key=eq.${key}&reward_kind=eq.inviter&redeemed_at=is.null` +
      `&valid_until=gt.${encodeURIComponent(new Date().toISOString())}&select=${CODE_FIELDS}&order=created_at.asc&limit=5`
  );
}

// Блок на экране подарка: кнопки поделиться (без скриптов — обычные ссылки) и сама ссылка для копирования
export function inviteBlock(business, invite) {
  const text = `Дарю тебе «${business.friend_gift}» в ${quoted(business.name)} 🎁 Забери по ссылке:`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(invite.url)}&text=${encodeURIComponent(text)}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(`${text} ${invite.url}`)}`;
  return `
    <section class="invite">
      <p class="invite-title">💛 Подарите другу</p>
      <p class="invite-text">Друг получит «${escapeHtml(business.friend_gift)}» на первый визит, а вы — «${escapeHtml(business.friend_reward)}», когда он придёт.</p>
      <div class="invite-btns">
        <a class="invite-btn invite-tg" href="${escapeHtml(tg)}" target="_blank" rel="noopener">Telegram</a>
        <a class="invite-btn invite-wa" href="${escapeHtml(wa)}" target="_blank" rel="noopener">WhatsApp</a>
      </div>
      <p class="invite-link">${escapeHtml(invite.url)}</p>
      <p class="invite-hint">Или скопируйте ссылку и отправьте как удобно. Подарок — для тех, кто у нас ещё не был; до ${FRIENDS_PER_MONTH} друзей в месяц.</p>
    </section>`;
}

// ---------- GET /f/:code ----------

export async function handleFriend(request, env, rawCode) {
  try {
    const code = String(rawCode || "").toLowerCase();
    if (!CODE_RE.test(code)) return infoPage(404, "Ссылка-приглашение не найдена");
    const invites = await db(env, `guest_invites?code=eq.${code}&select=code,business_id,inviter_key&limit=1`);
    if (!invites.length) return infoPage(404, "Ссылка-приглашение не найдена");
    const invite = invites[0];
    const rows = await db(
      env,
      `businesses?id=eq.${invite.business_id}&is_active=eq.true` +
        `&select=id,slug,name,address,discount_text,paid_until,theme,design,yandex_url,twogis_url,google_url,${BONUS_COLUMNS}&limit=1`
    );
    const business = rows[0];
    if (!business || isExpired(business.paid_until) || !friendOn(business)) {
      return infoPage(404, "Подарок по этой ссылке сейчас недоступен");
    }

    const { deviceId, setCookie } = deviceFrom(request);
    const key = await visitorKeyOf(env, deviceId, business.id);
    const page = (body) => withCookie(friendPage(business, body), setCookie);

    if (key === invite.inviter_key) {
      return page(`
        <h2 class="thanks">Это ваша ссылка-приглашение</h2>
        <p class="lead">Отправьте её другу, который ещё не был в ${escapeHtml(quoted(business.name))}. Он получит «${escapeHtml(business.friend_gift)}», а вы — «${escapeHtml(business.friend_reward)}», когда он придёт.</p>`);
    }

    // Друг уже получил подарок по приглашению — показываем тот же код
    const mine = await db(
      env,
      `bonus_codes?business_id=eq.${business.id}&visitor_key=eq.${key}&reward_kind=eq.friend&select=${CODE_FIELDS}&order=created_at.desc&limit=1`
    );
    if (mine.length) return page(codeBox(business, mine[0], true));

    // Только для новых гостей: на этом телефоне не было визитов и подарков в этом заведении
    const [visits, codes, recent] = await Promise.all([
      db(env, `guest_visits?business_id=eq.${business.id}&visitor_key=eq.${key}&select=day&limit=1`),
      db(env, `bonus_codes?business_id=eq.${business.id}&visitor_key=eq.${key}&select=id&limit=1`),
      db(
        env,
        `bonus_codes?invite_code=eq.${code}&reward_kind=eq.friend&created_at=gt.${encodeURIComponent(new Date(Date.now() - 30 * DAY).toISOString())}` +
          `&select=id&limit=${FRIENDS_PER_MONTH}`
      )
    ]);
    if (visits.length || codes.length) {
      return page(`
        <h2 class="thanks">Вы уже бывали у нас 🙂</h2>
        <p class="lead">Подарок по приглашению — для тех, кто ещё не был в ${escapeHtml(quoted(business.name))}. Приходите снова: при касании карты на столе вас тоже ждёт подарок.</p>
        ${placeLinks(business)}`);
    }
    if (recent.length >= FRIENDS_PER_MONTH) {
      return page(`
        <h2 class="thanks">Приглашения по этой ссылке закончились</h2>
        <p class="lead">По одной ссылке можно пригласить до ${FRIENDS_PER_MONTH} друзей в месяц. Попросите друга прислать новую позже — или просто приходите, на столе вас ждёт карта с подарком.</p>
        ${placeLinks(business)}`);
    }

    const url = new URL(request.url);
    if (url.searchParams.get("claim") !== "1" || isBot(request)) {
      return page(`
        <div class="br-gift" aria-hidden="true">${GIFT}</div>
        <h2 class="thanks">Друг дарит вам подарок</h2>
        <p class="br-prize">${escapeHtml(business.friend_gift)}</p>
        <p class="lead">в ${escapeHtml(quoted(business.name))} — на первый визит.</p>
        <a class="button bonus-button friend-claim" href="/f/${code}?claim=1" rel="nofollow">
          <span class="icon bonus-icon">${GIFT}</span><span class="label">Получить подарок</span>
        </a>
        ${placeLinks(business)}`);
    }

    const guard = await dailyGuard(request, env, business);
    if (guard.blocked) {
      return page(`<h2 class="thanks">${escapeHtml(guard.blocked.heading)}</h2><p class="lead">${escapeHtml(guard.blocked.text)}</p>`);
    }
    const saved = await issueCode(env, business, {
      prize: business.friend_gift,
      visitorKey: key,
      deviceDay: guard.deviceDay,
      noDelay: true,
      extra: { reward_kind: "friend", invite_code: code }
    });
    return page(codeBox(business, saved, false));
  } catch (error) {
    console.error(`Friend invite error: ${error.message}\n${error.stack}`);
    return infoPage(500, "Не удалось открыть приглашение. Попробуйте ещё раз через минуту.");
  }
}

// Касса погасила код друга → подарок пригласившему (вызывается после успешного погашения)
export async function rewardInviter(env, row) {
  try {
    if (!row || row.reward_kind !== "friend" || !row.invite_code) return;
    const invites = await db(env, `guest_invites?code=eq.${row.invite_code}&select=business_id,inviter_key&limit=1`);
    if (!invites.length) return;
    const rows = await db(env, `businesses?id=eq.${invites[0].business_id}&select=id,friend_reward,bonus_conditions,bonus_valid_days,bonus_from_days&limit=1`);
    if (!rows.length || !rows[0].friend_reward) return;
    await issueCode(env, rows[0], {
      prize: rows[0].friend_reward,
      visitorKey: invites[0].inviter_key,
      noDelay: true,
      extra: { reward_kind: "inviter", invite_code: row.invite_code }
    });
  } catch (error) {
    console.error(`Reward inviter failed: ${error.message}`);
  }
}

function codeBox(business, c, repeat) {
  return `
    <div class="br-gift" aria-hidden="true">${GIFT}</div>
    <div class="br br-fade">
      <p class="br-kicker">${repeat ? "Ваш подарок от друга уже ждёт вас" : "Подарок от друга"}</p>
      <p class="br-prize">${escapeHtml(c.prize)}</p>
      <p class="br-code" aria-label="Код ${escapeHtml(c.code.split("").join(" "))}">${escapeHtml(formatCode(c.code))}</p>
      <p class="br-valid">${escapeHtml(validityText(c))}</p>
      ${c.conditions ? `<p class="br-cond">Условия: ${escapeHtml(c.conditions)}</p>` : ""}
      ${c.redeemed_at ? `<p class="br-warn">Этот код уже использован.</p>` : ""}
      <p class="br-hint">Покажите код на кассе в ${escapeHtml(quoted(business.name))}. Сделайте скриншот, чтобы не потерять.</p>
    </div>
    ${placeLinks(business)}`;
}

// Где заведение: адрес и ссылка на карты (та же, что для отзывов, — это страница заведения на карте)
function placeLinks(business) {
  const map = [business.yandex_url, business.twogis_url, business.google_url].find((u) => isHttpsUrl(u));
  if (!business.address && !map) return "";
  return `
    <div class="friend-place">
      ${business.address ? `<p class="friend-addr">📍 ${escapeHtml(business.address)}</p>` : ""}
      ${map ? `<a class="friend-map" href="${escapeHtml(map)}" target="_blank" rel="noopener nofollow">Открыть на карте →</a>` : ""}
    </div>`;
}

function friendPage(business, body) {
  return renderPage({
    status: 200,
    title: `Подарок от друга — ${business.name}`,
    accent: null,
    theme: business.theme,
    design: customDesign(business),
    extraCss: BONUS_PAGE_CSS + FRIEND_CSS,
    footer: { href: `/r/${business.slug}?s=card`, text: "Хочу такую карту" },
    body: `
      <h1 class="name name-long">${escapeHtml(business.name)}</h1>
      <div class="divider"></div>
      ${body}`
  });
}

const FRIEND_CSS = `
  .friend-claim { margin-top: 18px; }
  .friend-place { margin-top: 18px; }
  .friend-addr { margin: 0 0 6px; font-size: 14px; color: var(--text); }
  .friend-map { font-size: 14px; font-weight: 700; color: var(--text); text-underline-offset: 3px; }
`;

// «Ярик» → «Ярик»; Бар «Ярик» → Бар «Ярик» (без двойных кавычек)
function quoted(name) {
  return /[«"]/.test(name) ? name : `«${name}»`;
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
