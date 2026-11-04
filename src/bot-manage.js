// Управление заведением из Telegram-бота (миграция 031). Только для чатов с галочкой «Может управлять»
// (tg_subscribers.can_manage, ставится в админке). Команды — обычный текст, без inline-кнопок:
//   /manage                — что сейчас включено и какие команды есть
//   /gifts_on, /gifts_off  — включить / выключить подарки для гостей
//   /news Заголовок        — опубликовать «Сейчас у нас» (текст — со следующей строки)
//   /news_off              — убрать «Сейчас у нас»
// Если в чате несколько заведений с управлением — номер заведения после команды: /gifts_off 2, /news 2 Заголовок.
// Проверки — те же, что в админке (cleanMoment). Фото, ссылки, даты, призы — во вкладке «Настройки» по ссылке.

import { db } from "./supabase.js";
import { cleanMoment } from "./admin-api.js";
import { has } from "./tariffs.js";

const MANAGE_RE = /^\/(manage|gifts_on|gifts_off|news|news_off)(?:@\w+)?(?=\s|$)/i;

export function isManageCommand(text) {
  return MANAGE_RE.test(text);
}

async function managedBusinesses(env, chatId) {
  const subs = await db(env, `tg_subscribers?chat_id=eq.${chatId}&can_manage=eq.true&select=business_id&order=created_at.asc`);
  if (!subs.length) return [];
  const ids = subs.map((s) => s.business_id);
  const rows = await db(
    env,
    `businesses?id=in.(${ids.join(",")})&select=id,name,bonus_mode,bonus_prizes,discount_text,moment,tariff`
  );
  return ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
}

// Управление из Telegram — с тарифа Plus (tariffs.js)
async function plusBusinesses(env, chatId) {
  const all = await managedBusinesses(env, chatId);
  return { all, list: all.filter((b) => has(b, "bot")) };
}

// → ответ бота (HTML) или null, если команда не про управление
export async function handleManage(env, chat, text) {
  const match = text.match(MANAGE_RE);
  if (!match) return null;
  const name = match[1].toLowerCase();
  let rest = text.slice(match[0].length).replace(/^[ \t]+/, "");

  const { all, list } = await plusBusinesses(env, chat.id);
  if (!all.length) {
    return "⚙ Управление из бота для этого чата не включено. Напишите нам — включим для владельца заведения.";
  }
  if (!list.length) {
    return "⚙ Управление из Telegram доступно с тарифа Plus. Чтобы подключить, напишите в TapReview.";
  }
  // В группе команду может отправить любой участник — управляем только из личного чата
  if (chat.type !== "private") {
    return "⚙ Управлять заведением можно только в личном чате с ботом. Напишите ему напрямую.";
  }
  if (name === "manage") return overview(env, list);

  // Номер заведения — если их несколько
  let business = list[0];
  if (list.length > 1) {
    const num = rest.match(/^(\d{1,2})(?=\s|$)/);
    if (!num || !list[Number(num[1]) - 1]) {
      return `В этом чате несколько заведений — укажите номер после команды, например <code>/${name} 1</code>.\n\n${numbered(list)}`;
    }
    business = list[Number(num[1]) - 1];
    rest = rest.slice(num[0].length).replace(/^[ \t]+/, "");
  }

  if (name === "gifts_off") {
    if (business.bonus_mode === "off") return `🎁 Подарки в ${q(business.name)} и так выключены.`;
    await patch(env, business.id, { bonus_mode: "off" });
    return `🎁 Подарки в ${q(business.name)} выключены. Гости больше не видят кнопку подарка.\nВключить снова — /gifts_on${suffix(list, business)}`;
  }

  if (name === "gifts_on") {
    if (business.bonus_mode !== "off") return `🎁 Подарки в ${q(business.name)} уже включены (${bonusText(business)}).`;
    const prizes = Array.isArray(business.bonus_prizes) ? business.bonus_prizes.filter((p) => p && p.label) : [];
    const mode = prizes.length >= 2 ? "wheel" : business.discount_text ? "fixed" : null;
    if (!mode) {
      return "Сначала задайте подарок: призы колеса или один подарок для всех — во вкладке «⚙ Настройки» на странице статистики.";
    }
    await patch(env, business.id, { bonus_mode: mode });
    return `🎁 Подарки в ${q(business.name)} включены: ${bonusText({ ...business, bonus_mode: mode })}.\nВыключить — /gifts_off${suffix(list, business)}`;
  }

  if (name === "news_off") {
    const m = business.moment || {};
    if (!m.title && !m.text) return `📣 В ${q(business.name)} блок «Сейчас у нас» и так пустой.`;
    await patch(env, business.id, { moment: {} });
    return `📣 «Сейчас у нас» в ${q(business.name)} убран.`;
  }

  // /news Заголовок\nТекст
  const body = rest.trim();
  if (!body) {
    return "Напишите новость после команды. Первая строка — заголовок, дальше — текст. Например:\n\n" +
      `<code>/news${suffix(list, business)} Живая музыка в пятницу\nС 20:00 — кавер-группа. Вход свободный.</code>`;
  }
  const [first, ...more] = body.split("\n");
  const title = first.trim();
  const tail = more.join("\n").trim();
  let moment;
  try {
    moment = title.length <= 60
      ? cleanMoment({ title, text: tail })
      : cleanMoment({ title: "", text: body });
  } catch (error) {
    return `⚠️ ${esc(error.message)}. Заголовок — до 60 символов, текст — до 300.`;
  }
  await patch(env, business.id, { moment });
  return `📣 Опубликовано в ${q(business.name)} — гости видят это после оценки:\n\n` +
    (moment.title ? `<b>${esc(moment.title)}</b>\n` : "") + (moment.text ? `${esc(moment.text)}\n` : "") +
    `\nУбрать — /news_off${suffix(list, business)}. Фото, кнопку-ссылку и даты показа можно добавить во вкладке «⚙ Настройки».`;
}

async function overview(env, list) {
  const base = String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const blocks = [];
  for (const [i, b] of list.entries()) {
    const n = list.length > 1 ? ` ${i + 1}` : "";
    const m = b.moment || {};
    const links = await db(
      env,
      `stats_links?or=(business_id.eq.${b.id},business_ids.cs.{${b.id}})&can_edit=eq.true&select=token&limit=1`
    ).catch(() => []);
    blocks.push(
      `${list.length > 1 ? `${i + 1}. ` : ""}⚙ <b>${esc(b.name)}</b>\n` +
        `🎁 Подарки: ${b.bonus_mode === "off" ? "выключены — включить /gifts_on" : `${bonusText(b)} — выключить /gifts_off`}${n}\n` +
        `📣 Сейчас у нас: ${m.title || m.text ? `«${esc(m.title || String(m.text).slice(0, 40))}» — убрать /news_off${n}` : "пусто"}\n` +
        `Новость: <code>/news${n} Заголовок</code> (текст — со следующей строки)` +
        (links.length ? `\nВсе настройки: ${base}/s/${links[0].token}/settings?b=${b.id}` : "")
    );
  }
  return blocks.join("\n\n");
}

function numbered(list) {
  return list.map((b, i) => `${i + 1}. ${esc(b.name)}`).join("\n");
}

function suffix(list, business) {
  return list.length > 1 ? ` ${list.indexOf(business) + 1}` : "";
}

function bonusText(b) {
  if (b.bonus_mode === "wheel") {
    const n = (Array.isArray(b.bonus_prizes) ? b.bonus_prizes : []).length;
    return `колесо, ${n} ${n % 10 === 1 && n % 100 !== 11 ? "приз" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "приза" : "призов"}`;
  }
  return `«${esc(b.discount_text || "подарок")}»`;
}

async function patch(env, id, body) {
  await db(env, `businesses?id=eq.${id}`, { method: "PATCH", body, prefer: "return=minimal" });
}

// «Ярик» / Бар «Ярик» — без двойных кавычек
function q(name) {
  return /[«"]/.test(name) ? esc(name) : `«${esc(name)}»`;
}

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
