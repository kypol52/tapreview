// Вкладка «Настройки» на странице статистики владельца (миграция 027):
//   GET  /s/:token/settings?b=ID — формы: «Сейчас у нас», подарок для гостей, ссылки «Ещё у нас»
//   POST /s/:token/settings      — сохранить один раздел (section = moment | bonus | links)
// Доступно, только если у ссылки включено «Может менять настройки» (stats_links.can_edit, ставится в админке).
// Проверки — те же, что в админке (admin-api.js), чтобы правила не разъезжались.
// Страница работает без скриптов; маленький скрипт нужен только чтобы сжать фото перед загрузкой.

import { db } from "./supabase.js";
import { html, esc, notFound, TOKEN_RE } from "./stats-page.js";
import { cleanMoment, cleanBonus, cleanExtraLinks, EXTRA_LINK_MAX } from "./admin-api.js";
import { BONUS_COLUMNS, EXTRA_LINKS } from "./public-page.js";
import { saveMedia } from "./media.js";
import { has } from "./tariffs.js";

const MAX_PRIZES = 8;
const MAX_BODY = 1200000; // фото уже сжато в браузере до ~300 КБ (≈ 400 КБ в base64)
const SECTIONS = { moment: "«Сейчас у нас»", bonus: "Подарок для гостей", links: "Ссылки «Ещё у нас»" };

export async function handleOwnerSettings(request, env, token) {
  try {
    if (!TOKEN_RE.test(token)) return notFound();
    const links = await db(env, `stats_links?token=eq.${token}&select=business_id,business_ids,can_edit`);
    if (!links.length) return notFound();
    const link = links[0];
    if (!link.can_edit) return closedPage(token);
    const ids = [...new Set(link.business_ids && link.business_ids.length ? link.business_ids : [link.business_id])];

    const url = new URL(request.url);
    const form = request.method === "POST" ? await readForm(request) : null;
    if (form === false) return new Response("Слишком большой запрос", { status: 413 });
    const wanted = Number((form && form.get("b")) || url.searchParams.get("b"));
    // Чужое заведение (не из этой ссылки) — как несуществующая страница
    if (wanted && !ids.includes(wanted)) return notFound();
    const id = wanted || (ids.length === 1 ? ids[0] : null);

    if (!id) {
      const venues = await db(env, `businesses?id=in.(${ids.join(",")})&select=id,name&order=name.asc`);
      return html(200, "Настройки", chooserBody(token, venues));
    }
    const rows = await db(env, `businesses?id=eq.${id}&select=id,name,slug,discount_text,moment,extra_links,${BONUS_COLUMNS}`);
    if (!rows.length) return notFound();
    const business = rows[0];
    // Тарифы (tariffs.js): «Настройки» — с «Стандарта», раздел подарков — только в «Плюсе»
    if (!has(business, "settings")) {
      return html(200, "Настройки", `${header(token, business.name, "", `/s/${token}`, "Статистика")}
  <main class="wrap"><section class="panel">
    <p>В тарифе «Старт» страница ведёт гостей сразу к отзывам, и настраивать здесь нечего.
      «Сейчас у нас», кнопки «Меню», «Запись», «Чаевые» и оценка гостей есть в тарифе «Стандарт», подарки и штампы — в «Плюсе».
      Чтобы сменить тариф, напишите в TapReview.</p>
  </section></main>`);
    }

    if (!form) {
      const ok = SECTIONS[url.searchParams.get("ok")] ? url.searchParams.get("ok") : null;
      return html(200, `Настройки · ${business.name}`, settingsBody(token, ids.length > 1, business, { ok }), PHOTO_SCRIPT);
    }

    const section = String(form.get("section") || "");
    let patch;
    try {
      if (section === "moment") patch = await momentPatch(env, form, business);
      else if (section === "bonus") {
        if (!has(business, "gifts")) throw new Error("Подарки доступны в тарифе «Плюс» — напишите в TapReview, чтобы сменить тариф");
        patch = bonusPatch(form);
      }
      else if (section === "links") patch = linksPatch(form);
      else throw new Error("Неизвестный раздел");
    } catch (error) {
      // Показываем ту же страницу с введёнными значениями и понятной ошибкой
      const draft = { ...business, ...draftFrom(section, form, business) };
      return html(400, `Настройки · ${business.name}`, settingsBody(token, ids.length > 1, draft, { error: { section, text: error.message } }), PHOTO_SCRIPT);
    }
    await db(env, `businesses?id=eq.${id}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
    const back = new URLSearchParams();
    if (ids.length > 1) back.set("b", String(id));
    back.set("ok", section);
    return new Response(null, {
      status: 303,
      headers: { Location: `/s/${token}/settings?${back}#${section}`, "Cache-Control": "no-store" }
    });
  } catch (error) {
    console.error(`Owner settings error: ${error.message}\n${error.stack}`);
    return html(500, "Настройки временно недоступны", `<main class="wrap wrap-center"><section class="panel">
      <h1 class="lost">Не удалось сохранить</h1><p>Попробуйте ещё раз через минуту.</p>
      <a class="back back-dark" href="/s/${token}/settings">← Настройки</a></section></main>`);
  }
}

async function readForm(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return false;
  return new URLSearchParams(text);
}

// ---------- Сохранение разделов ----------

async function momentPatch(env, form, business) {
  const current = (business.moment && business.moment.photo) || null;
  let photo = form.get("photo_remove") === "1" ? null : current;
  const data = String(form.get("photo_data") || "");
  if (data) photo = await saveMedia(env, "moment", data);
  return { moment: cleanMoment({ ...momentFields(form), photo }) };
}

function momentFields(form) {
  const get = (k) => String(form.get(k) || "");
  return { title: get("title"), text: get("text"), url: get("url"), button: get("button"), from: get("from"), to: get("to") };
}

function bonusPatch(form) {
  const input = bonusFields(form);
  const bonus = cleanBonus(input);
  const gift = String(input.discount_text || "").trim().slice(0, 120) || null;
  return { ...bonus, discount_text: gift };
}

function bonusFields(form) {
  const prizes = [];
  for (let i = 0; i < MAX_PRIZES; i++) {
    const label = String(form.get(`p${i}`) || "").trim();
    if (!label) continue;
    const w = String(form.get(`w${i}`) || "").trim();
    prizes.push({ label, weight: w === "" ? 1 : Number(w) });
  }
  return {
    bonus_mode: String(form.get("bonus_mode") || "off"),
    discount_text: String(form.get("gift") || ""),
    bonus_prizes: prizes,
    bonus_conditions: String(form.get("conditions") || ""),
    bonus_from_days: String(form.get("from_days") || ""),
    bonus_valid_days: String(form.get("valid_days") || ""),
    bonus_cooldown_days: String(form.get("cooldown_days") || ""),
    bonus_daily_limit: String(form.get("daily_limit") || ""),
    stamps_goal: String(form.get("stamps_goal") || ""),
    stamps_prize: String(form.get("stamps_prize") || ""),
    vip_visits: String(form.get("vip_visits") || ""),
    vip_gift: String(form.get("vip_gift") || ""),
    friend_gift: String(form.get("friend_gift") || ""),
    friend_reward: String(form.get("friend_reward") || "")
  };
}

function linksPatch(form) {
  return { extra_links: cleanExtraLinks(linkFields(form)) };
}

function linkFields(form) {
  const list = [];
  for (let i = 0; i < EXTRA_LINK_MAX; i++) {
    const url = String(form.get(`u${i}`) || "").trim();
    const label = String(form.get(`t${i}`) || "").trim();
    if (!url && !label) continue;
    list.push({ type: String(form.get(`k${i}`) || "custom"), url, label });
  }
  return list;
}

// Введённое владельцем — чтобы при ошибке ничего не пришлось набирать заново
function draftFrom(section, form, business) {
  if (section === "moment") return { moment: { ...momentFields(form), photo: business.moment && business.moment.photo } };
  if (section === "bonus") {
    const b = bonusFields(form);
    return { ...b, bonus_prizes: b.bonus_prizes };
  }
  if (section === "links") return { extra_links: linkFields(form) };
  return {};
}

// ---------- Разметка ----------

function header(token, title, sub, backHref, backText) {
  return `
  <header class="top">
    <div class="top-inner">
      <div class="brand">TapReview <span>· настройки</span></div>
      <a class="back" href="${backHref}">← ${backText}</a>
      <h1 class="name">${esc(title)}</h1>
      ${sub ? `<p class="sub">${sub}</p>` : ""}
    </div>
  </header>`;
}

function closedPage(token) {
  return html(403, "Настройки недоступны", `${header(token, "Настройки", "", `/s/${token}`, "Статистика")}
  <main class="wrap"><section class="panel">
    <p>По этой ссылке можно только смотреть статистику. Чтобы менять «Сейчас у нас», подарки и ссылки,
      напишите в TapReview — включим настройки для вашей ссылки.</p>
  </section></main>`);
}

function chooserBody(token, venues) {
  const items = venues
    .map((v) => `<li><a class="set-venue" href="/s/${token}/settings?b=${v.id}">${esc(v.name)} →</a></li>`)
    .join("");
  return `${header(token, "Настройки", "Выберите заведение", `/s/${token}`, "Статистика")}
  <main class="wrap"><section class="panel"><ul class="set-venues">${items}</ul></section></main>`;
}

function settingsBody(token, multi, b, { ok = null, error = null } = {}) {
  const hidden = `<input type="hidden" name="b" value="${b.id}">`;
  const flash = (section) =>
    error && error.section === section
      ? `<p class="set-msg set-err" role="alert">${esc(error.text)}</p>`
      : ok === section
        ? `<p class="set-msg set-ok" role="status">✓ Сохранено — гости уже видят изменения</p>`
        : "";
  const backHref = multi ? `/s/${token}/settings` : `/s/${token}`;
  return `${header(token, b.name, `<a class="set-preview" href="/b/${esc(b.slug)}?v=all" target="_blank" rel="noopener">Посмотреть, как видит гость ↗</a>`, backHref, multi ? "Все заведения" : "Статистика")}
  <main class="wrap">
    ${momentSection(b, hidden, flash("moment"))}
    ${has(b, "gifts") ? bonusSection(b, hidden, flash("bonus")) : `<section class="panel" id="bonus"><h2>Подарок для гостей</h2>
      <p class="set-hint">Колесо подарков, штампы, VIP-гости и «Подарите другу» — в тарифе «Плюс». Чтобы подключить, напишите в TapReview.</p></section>`}
    ${linksSection(b, hidden, flash("links"))}
    ${multi ? `<a class="back back-dark" href="/s/${token}">← Статистика</a>` : ""}
  </main>`;
}

function momentSection(b, hidden, msg) {
  const m = b.moment || {};
  const v = (k) => esc(m[k] || "");
  const photo = m.photo
    ? `<div class="set-photo"><img src="/m/${esc(m.photo)}" alt="Фото блока"><label class="set-check"><input type="checkbox" name="photo_remove" value="1"> Убрать фото</label></div>`
    : "";
  return `
    <section class="panel" id="moment">
      <h2>Сейчас у нас</h2>
      <p class="set-hint">Новость, событие или акция. Гость видит карточку после оценки, под кнопками отзывов. Пустые заголовок и текст — карточки нет.</p>
      ${msg}
      <form class="set-form" method="post" action="" enctype="application/x-www-form-urlencoded">
        ${hidden}<input type="hidden" name="section" value="moment">
        <label>Заголовок<input name="title" maxlength="60" value="${v("title")}" placeholder="Живая музыка в эту пятницу"></label>
        <label>Текст<textarea name="text" rows="3" maxlength="300" placeholder="С 20:00 — кавер-группа. Вход свободный.">${v("text")}</textarea></label>
        ${photo}
        <label>${m.photo ? "Заменить фото" : "Фото (необязательно)"}<input type="file" accept="image/*" data-photo></label>
        <input type="hidden" name="photo_data" value="">
        <p class="set-hint" data-photo-status></p>
        <div class="set-two">
          <label>Ссылка (необязательно)<input name="url" type="url" inputmode="url" value="${v("url")}" placeholder="https://…"></label>
          <label>Текст кнопки<input name="button" maxlength="30" value="${v("button")}" placeholder="Забронировать стол"></label>
        </div>
        <div class="set-two">
          <label>Показывать с<input name="from" type="date" value="${v("from")}"></label>
          <label>по (включительно)<input name="to" type="date" value="${v("to")}"></label>
        </div>
        <p class="set-hint">Без дат — показывается всегда. После последней даты карточка пропадает сама.</p>
        <button class="set-save" type="submit">Сохранить</button>
      </form>
    </section>`;
}

function bonusSection(b, hidden, msg) {
  const mode = ["off", "fixed", "wheel"].includes(b.bonus_mode) ? b.bonus_mode : "off";
  const opt = (value, label) => `<option value="${value}"${mode === value ? " selected" : ""}>${label}</option>`;
  const prizes = Array.isArray(b.bonus_prizes) ? b.bonus_prizes : [];
  const rows = Array.from({ length: MAX_PRIZES }, (_, i) => {
    const p = prizes[i] || {};
    return `<div class="set-prize"><input name="p${i}" maxlength="30" value="${esc(p.label || "")}" placeholder="${i === 0 ? "Капучино" : i === 1 ? "Скидка 10%" : "Приз " + (i + 1)}" aria-label="Приз ${i + 1}">
      <input name="w${i}" type="number" min="1" max="1000" inputmode="numeric" value="${p.label ? esc(String(p.weight ?? 1)) : ""}" placeholder="шанс" aria-label="Шанс приза ${i + 1}"></div>`;
  }).join("");
  const n = (name, value, min, max) =>
    `<input name="${name}" type="number" min="${min}" max="${max}" inputmode="numeric" value="${esc(String(value ?? ""))}">`;
  return `
    <section class="panel" id="bonus">
      <h2>Подарок для гостей</h2>
      <p class="set-hint">Кнопка подарка появляется через несколько секунд после скана карты. Каждый гость получает свой одноразовый код, кассир гасит его в «Проверить код подарка».</p>
      ${msg}
      <form class="set-form" method="post" action="">
        ${hidden}<input type="hidden" name="section" value="bonus">
        <label>Режим<select name="bonus_mode">${opt("off", "Выключен")}${opt("fixed", "Один подарок для всех")}${opt("wheel", "Колесо подарков")}</select></label>
        <label>Подарок (для режима «один для всех»)<input name="gift" maxlength="60" value="${esc(b.discount_text || "")}" placeholder="Скидка 10% на следующий визит"></label>
        <fieldset class="set-prizes"><legend>Призы колеса и шансы (2–8 призов)</legend>
          <p class="set-hint">Шанс — во сколько раз чаще выпадает приз. Капучино 3 и шот 1 — капучино в 3 раза чаще. Пустые строки не учитываются.</p>
          ${rows}
        </fieldset>
        <label>Условия (видят гость и кассир)<input name="conditions" maxlength="200" value="${esc(b.bonus_conditions || "")}" placeholder="При заказе от 500 ₽, один код на чек"></label>
        <div class="set-two">
          <label>Начнёт действовать через, дней${n("from_days", b.bonus_from_days ?? 1, 0, 30)}</label>
          <label>Действует, дней${n("valid_days", b.bonus_valid_days ?? 14, 1, 365)}</label>
        </div>
        <div class="set-two">
          <label>Один подарок на телефон раз в, дней${n("cooldown_days", b.bonus_cooldown_days ?? 30, 1, 365)}</label>
          <label>Не больше подарков в день${n("daily_limit", b.bonus_daily_limit ?? 50, 1, 10000)}</label>
        </div>
        <fieldset class="set-prizes"><legend>Штампы (необязательно)</legend>
          <p class="set-hint">Штамп — каждый подарок, погашенный на кассе. Собрал все — следующий подарок будет особым призом вместо колеса, и счёт начнётся заново. Пусто — штампов нет.</p>
          <div class="set-two">
            <label>Штампов до приза (2–10)<input name="stamps_goal" type="number" min="2" max="10" inputmode="numeric" value="${esc(String(b.stamps_goal ?? ""))}" placeholder="выключено"></label>
            <label>Особый приз<input name="stamps_prize" maxlength="60" value="${esc(b.stamps_prize || "")}" placeholder="Пицца в подарок"></label>
          </div>
          <p class="set-hint">Чтобы штампы копились быстрее, поставьте «Один подарок на телефон раз в» 7 дней.</p>
        </fieldset>
        <fieldset class="set-prizes"><legend>VIP-гости (необязательно)</legend>
          <p class="set-hint">Новый → постоянный (3+ визита) → VIP. Визит — день, когда гость приложил телефон к карте. VIP видит значок, получает VIP-подарок вместо колеса, кассир видит «⭐ VIP-гость». Пусто — выключено.</p>
          <div class="set-two">
            <label>VIP с какого визита (4–100)<input name="vip_visits" type="number" min="4" max="100" inputmode="numeric" value="${esc(String(b.vip_visits ?? ""))}" placeholder="выключено"></label>
            <label>VIP-подарок<input name="vip_gift" maxlength="60" value="${esc(b.vip_gift || "")}" placeholder="Коктейль от шефа"></label>
          </div>
        </fieldset>
        <fieldset class="set-prizes"><legend>Подарите другу (необязательно)</legend>
          <p class="set-hint">Гость делится ссылкой со своего экрана подарка. Новый гость получает подарок на первый визит, а пригласивший — свой, когда друг придёт и кассир погасит его код. До 3 друзей в месяц по одной ссылке. Пусто — выключено.</p>
          <div class="set-two">
            <label>Подарок другу<input name="friend_gift" maxlength="60" value="${esc(b.friend_gift || "")}" placeholder="Десерт в подарок"></label>
            <label>Подарок пригласившему<input name="friend_reward" maxlength="60" value="${esc(b.friend_reward || "")}" placeholder="Капучино"></label>
          </div>
        </fieldset>
        <p class="set-hint">Подарок не должен зависеть от отзыва — так требуют правила Яндекс Карт и 2ГИС. Не пишите «за отзыв».</p>
        <button class="set-save" type="submit">Сохранить</button>
      </form>
    </section>`;
}

function linksSection(b, hidden, msg) {
  const list = Array.isArray(b.extra_links) ? b.extra_links : [];
  const rows = Array.from({ length: EXTRA_LINK_MAX }, (_, i) => {
    const l = list[i] || {};
    const type = EXTRA_LINKS[l.type] ? l.type : i < list.length ? "custom" : "menu";
    const options = Object.entries(EXTRA_LINKS)
      .map(([key, x]) => `<option value="${key}"${key === type ? " selected" : ""}>${key === "custom" ? "Своя подпись" : esc(x.label)}</option>`)
      .join("");
    return `<div class="set-link">
      <select name="k${i}" aria-label="Кнопка ${i + 1}">${options}</select>
      <input name="u${i}" type="url" inputmode="url" value="${esc(l.url || "")}" placeholder="https://…" aria-label="Адрес ${i + 1}">
      <input name="t${i}" maxlength="30" value="${esc(l.label || "")}" placeholder="Подпись (необязательно)" aria-label="Подпись ${i + 1}">
    </div>`;
  }).join("");
  return `
    <section class="panel" id="links">
      <h2>Ссылки «Ещё у нас»</h2>
      <p class="set-hint">Кнопки под отзывами: меню, онлайн-запись, доставка, чаевые, оплата. До ${EXTRA_LINK_MAX} штук. Чтобы убрать кнопку — сотрите адрес и подпись.</p>
      ${msg}
      <form class="set-form" method="post" action="">
        ${hidden}<input type="hidden" name="section" value="links">
        ${rows}
        <button class="set-save" type="submit">Сохранить</button>
      </form>
    </section>`;
}

// Сжатие фото в браузере: до 1280 px по длинной стороне, JPEG ≤ 300 КБ → скрытое поле photo_data
const PHOTO_SCRIPT = `(function () {
  var input = document.querySelector("[data-photo]");
  if (!input) return;
  var form = input.form, hidden = form.querySelector('[name="photo_data"]'), status = form.querySelector("[data-photo-status]"), busy = false;
  input.addEventListener("change", function () {
    var file = input.files && input.files[0];
    hidden.value = "";
    if (!file) { status.textContent = ""; return; }
    busy = true; status.textContent = "Обрабатываю фото…";
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var k = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
      var c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      var q = [0.82, 0.74, 0.66, 0.58, 0.5], data = "";
      for (var i = 0; i < q.length; i++) { data = c.toDataURL("image/jpeg", q[i]); if (data.length * 0.75 <= 300 * 1024) break; }
      hidden.value = data; busy = false; URL.revokeObjectURL(url);
      status.textContent = "Фото готово (" + Math.round(data.length * 0.75 / 1024) + " КБ). Нажмите «Сохранить».";
    };
    img.onerror = function () { busy = false; status.textContent = "Не получилось открыть фото — выберите JPG или PNG."; };
    img.src = url;
  });
  form.addEventListener("submit", function (e) { if (busy) { e.preventDefault(); status.textContent = "Подождите, фото ещё обрабатывается…"; } });
})();`;
