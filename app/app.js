// TapReview Mini App: каталог заведений и отзывы. Без фреймворков и сборки.
// Данные — /api/app/* (src/app-api.js). Вход — подпись Telegram (initData) в каждом запросе,
// сервер сам проверяет её; здесь мы ничего не решаем о правах, только показываем.
// Адреса экранов (hash): #/  #/catalog?cat=&q=&min=&sort=  #/place/:slug  #/favorites  #/me
"use strict";

const tg = window.Telegram && window.Telegram.WebApp;
const inTelegram = Boolean(tg && tg.initData);
const state = { config: null, ticket: null, ticketSlug: null, lastPlace: null };
const view = document.getElementById("view");

// ================= Telegram =================

function setupTelegram() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor("#ffffff");
    tg.setBackgroundColor("#f5f6f8");
    if (tg.setBottomBarColor) tg.setBottomBarColor("#ffffff");
    if (tg.isVersionAtLeast && tg.isVersionAtLeast("7.7") && tg.disableVerticalSwipes) tg.disableVerticalSwipes();
  } catch {
    // старые версии Telegram — просто без цветов
  }
  if (tg.BackButton) tg.BackButton.onClick(goBack);
}

const haptic = {
  tap() {
    try { tg && tg.HapticFeedback && tg.HapticFeedback.selectionChanged(); } catch {}
  },
  ok() {
    try { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred("success"); } catch {}
  },
  err() {
    try { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred("error"); } catch {}
  }
};

function openLink(url) {
  if (!/^https:\/\//.test(url)) return;
  if (tg && /^https:\/\/t\.me\//.test(url) && tg.openTelegramLink) return tg.openTelegramLink(url);
  if (tg && tg.openLink) return tg.openLink(url);
  window.open(url, "_blank", "noopener");
}

function confirmBox(text) {
  return new Promise((resolve) => {
    if (tg && tg.showConfirm && tg.isVersionAtLeast && tg.isVersionAtLeast("6.2")) tg.showConfirm(text, resolve);
    else resolve(window.confirm(text));
  });
}

// ================= Запросы к серверу =================

async function api(path, options = {}) {
  const headers = { Accept: "application/json" };
  if (inTelegram) headers.Authorization = `tma ${tg.initData}`;
  if (options.body) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(path, { method: options.method || "GET", headers, body: options.body ? JSON.stringify(options.body) : undefined });
  } catch {
    throw new Error("Нет связи с сервером. Проверьте интернет");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // пустой ответ
  }
  if (!res.ok) {
    const error = new Error((data && data.error) || `Ошибка ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

// ================= Построение DOM (без innerHTML — текст пользователей всегда как текст) =================

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (k === "style") node.setAttribute("style", v);
      else node.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function icon(paths, cls) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  for (const d of [].concat(paths)) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

const I = {
  search: ["M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z", "m16 16 4.5 4.5"],
  star: "M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6-4.5-4.2 6.1-.8z",
  heart: "M12 20s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7.3a4.4 4.4 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z",
  pin: ["M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z", "M12 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z"],
  share: ["M12 15V3.5", "m7.5 8 4.5-4.5L16.5 8", "M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5"],
  user: ["M12 12.3a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6z", "M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"],
  card: ["M3.5 6.5h17v11h-17z", "M7 14.5h4"],
  pen: ["M4 20h4L19 9l-4-4L4 16z", "m13.5 6.5 4 4"],
  store: ["M4 9.5 5.5 4h13L20 9.5", "M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0", "M5.5 11.5V20h13v-8.5", "M10 20v-4.5h4V20"],
  chat: "M5 18.5 3.5 21l.6-4A8 8 0 1 1 8 19.6z",
  shield: ["M12 3.5 5 6v5.5c0 4.3 3 7.8 7 9 4-1.2 7-4.7 7-9V6z", "m9 12 2 2 4-4"],
  trash: ["M5 7h14", "M9.5 7V4.5h5V7", "M7 7l.8 12.5h8.4L17 7"],
  photo: ["M4 6.5h16v12H4z", "m4 15.5 4.5-4.5 4 4 2.5-2.5 5 5", "M15.5 10a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z"],
  go: "m10 6 6 6-6 6",
  cats: {
    restaurant: ["M7 3v8", "M5 3v5a2 2 0 0 0 4 0V3", "M7 11v10", "M17 21V3c-2.2 1.2-3.5 3.6-3.5 6.5V13H17"],
    beauty: ["M7.5 21v-8.5", "M5.5 12.5h4l-.5-5.5h-3z", "M7.5 7V3.5", "M16.5 21V9", "M14 9h5V5.5a2.5 2.5 0 0 0-5 0z"],
    barber: ["M6 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z", "M6 14.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z", "M8 8.5 20 17", "M8 15.5 20 7"],
    shop: ["M5 8h14l-1 12H6z", "M9 8V6a3 3 0 0 1 6 0v2"],
    other: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"]
  },
  links: {
    menu: ["M7 3v8", "M5 3v5a2 2 0 0 0 4 0V3", "M7 11v10", "M17 21V3c-2.2 1.2-3.5 3.6-3.5 6.5V13H17"],
    catalog: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
    services: ["M3 12.5V4h8.5L21 13.5 13.5 21z", "M7.5 8h.01"],
    booking: ["M4 6h16v14H4z", "M4 10h16", "M8 3v4", "M16 3v4", "M8 14h3"],
    delivery: ["M5 8h14l-1 12H6z", "M9 8V6a3 3 0 0 1 6 0v2"],
    site: ["M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", "M3.5 12h17", "M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z"],
    tips: ["M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", "M14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.4 0-2.5.7-2.5 1.9 0 2.8 5 1.4 5 4.2 0 1.2-1.1 1.9-2.5 1.9-1.1 0-2-.4-2.5-1.2", "M12 6.5v1.5", "M12 16v1.5"],
    pay: ["M3.5 6.5h17v11h-17z", "M3.5 10h17", "M7 14.5h4"],
    custom: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"]
  }
};

const LINK_LABELS = { menu: "Меню", catalog: "Каталог", services: "Услуги и цены", booking: "Онлайн-запись", delivery: "Доставка", site: "Сайт", tips: "Чаевые", pay: "Оплата" };
const SCORE_HINTS = ["", "Очень плохо", "Плохо", "Нормально", "Хорошо", "Отлично"];
const REPORT_REASONS = [
  ["spam", "Спам или реклама"],
  ["offensive", "Оскорбления или мат"],
  ["fake", "Неправда или накрутка"],
  ["personal", "Личные данные (телефон, фамилия)"],
  ["other", "Другое"]
];

function stars(value, size) {
  const box = h("span", { class: "stars", "aria-label": value ? `Оценка ${value} из 5` : "Нет оценок" });
  for (let i = 1; i <= 5; i++) {
    const s = icon(I.star, i <= Math.round(value || 0) ? "star-full" : "star-empty");
    if (size) s.setAttribute("style", `width:${size}px;height:${size}px`);
    box.append(s);
  }
  return box;
}

function initials(name) {
  const words = String(name || "?").replace(/[«»"]/g, "").trim().split(/\s+/);
  const a = (words[0] || "?")[0] || "?";
  const b = words[1] ? words[1][0] : "";
  return h("div", { class: "initials" }, a.toUpperCase(), b ? h("b", null, b.toUpperCase()) : null);
}

function coverOf(p) {
  if (p.cover) return h("img", { src: p.cover, alt: "", loading: "lazy", decoding: "async" });
  if (p.logo) return h("img", { class: "logo-fit", src: p.logo, alt: "", loading: "lazy" });
  return initials(p.name);
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const reviewsWord = (n) => `${n} ${plural(n, "отзыв", "отзыва", "отзывов")}`;
const fmtRating = (v) => (v === null || v === undefined ? "—" : Number(v).toFixed(1).replace(".", ","));

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("ru-RU", sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" });
}

function placeMeta(p) {
  return [p.categoryLabel, p.city, p.address].filter(Boolean).join(" · ");
}

function toast(text) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.hidden = false;
  t.style.animation = "none";
  void t.offsetWidth;
  t.style.animation = "";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2800);
}

function render(...nodes) {
  view.replaceChildren(...nodes.flat().filter(Boolean));
  view.style.animation = "none";
  void view.offsetWidth;
  view.style.animation = "";
}

function errorView(error, retry) {
  return h("div", { class: "empty" },
    h("div", { class: "empty-icon" }, icon(I.chat)),
    h("h2", null, error.status === 404 ? "Не нашли" : "Не получилось загрузить"),
    h("p", null, error.message),
    retry ? h("button", { class: "btn btn-soft", onclick: retry }, "Повторить") : null
  );
}

function emptyView(iconPaths, title, text, action) {
  return h("div", { class: "empty" },
    h("div", { class: "empty-icon" }, icon(iconPaths)),
    h("h2", null, title),
    text ? h("p", null, text) : null,
    action || null
  );
}

function skeletonList(n = 4) {
  return h("div", { class: "list" },
    Array.from({ length: n }, () =>
      h("div", { class: "row" },
        h("div", { class: "row-thumb sk" }),
        h("div", { class: "row-main" }, h("div", { class: "sk sk-line", style: "width:60%" }), h("div", { class: "sk sk-line", style: "width:85%" }))
      )
    )
  );
}

// ================= Карточки заведений =================

function tile(p) {
  return h("a", { class: "tile", href: `#/place/${encodeURIComponent(p.slug)}`, onclick: haptic.tap },
    h("div", { class: "tile-cover" },
      coverOf(p),
      p.rating !== null ? h("span", { class: "badge-rating" }, icon(I.star), fmtRating(p.rating)) : null
    ),
    h("div", { class: "tile-body" },
      h("div", { class: "tile-name" }, p.name),
      h("div", { class: "tile-meta" }, [p.categoryLabel, p.city].filter(Boolean).join(" · "))
    )
  );
}

function row(p) {
  return h("a", { class: "row", href: `#/place/${encodeURIComponent(p.slug)}`, onclick: haptic.tap },
    h("div", { class: "row-thumb" }, coverOf(p)),
    h("div", { class: "row-main" },
      h("div", { class: "row-name" }, p.name),
      h("div", { class: "row-meta" }, placeMeta(p)),
      p.reviews
        ? h("div", { class: "row-rating" }, icon(I.star), fmtRating(p.rating), h("span", null, `· ${reviewsWord(p.reviews)}`))
        : h("div", { class: "row-new" }, "Пока без отзывов — будьте первым")
    )
  );
}

function searchBox(value, onInput, onSubmit) {
  const input = h("input", { type: "search", placeholder: "Название, адрес или город", value: value || "", enterkeyhint: "search", "aria-label": "Поиск заведений" });
  let timer;
  if (onInput) input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => onInput(input.value.trim()), 350);
  });
  const form = h("form", { class: "search", role: "search" }, icon(I.search), input);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    input.blur();
    if (onSubmit) onSubmit(input.value.trim());
  });
  return form;
}

// ================= Экран: Главная =================

async function homeView() {
  render(
    h("header", { class: "head" }, brand(), h("div", { class: "sk", style: "height:46px;border-radius:14px" })),
    skeletonList(3)
  );
  let data;
  try {
    data = await api("/api/app/home");
  } catch (error) {
    return render(errorView(error, homeView));
  }

  const rail = (title, items, link) =>
    items.length
      ? h("section", { class: "section" },
          h("div", { class: "section-head" }, h("h2", { class: "section-title" }, title), link ? h("a", { class: "section-link", href: link }, "Все") : null),
          h("div", { class: "rail" }, items.map(tile))
        )
      : null;

  render(
    h("header", { class: "head" },
      brand(),
      h("h1", { class: "title" }, "Где хорошо?"),
      h("p", { class: "lead", style: "margin-bottom:14px" }, "Честные оценки гостей заведений вашего города"),
      searchBox("", null, (q) => go(`#/catalog?q=${encodeURIComponent(q)}`))
    ),
    h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h2", { class: "section-title" }, "Категории")),
      h("div", { class: "cats" },
        data.categories.map((c) =>
          h("a", { class: "cat", href: `#/catalog?cat=${c.key}`, onclick: haptic.tap },
            h("span", { class: "cat-icon" }, icon(I.cats[c.key] || I.cats.other)),
            h("span", { class: "cat-name" }, c.label),
            h("span", { class: "cat-count" }, String(c.count))
          )
        )
      )
    ),
    data.total === 0
      ? emptyView(I.store, "Каталог только открывается", "Скоро здесь появятся заведения. Если у вас карта TapReview — коснитесь её телефоном.")
      : null,
    rail("Лучшие по оценкам", data.top, "#/catalog?sort=top"),
    rail("Популярные", data.popular, "#/catalog?sort=popular"),
    rail("Недавно добавлены", data.recent, "#/catalog?sort=new")
  );
}

function brand() {
  return h("div", { class: "brand" },
    h("div", { class: "brand-mark" }, "T", h("b", null, "R")),
    h("div", null, h("div", { class: "brand-name" }, "TapReview"), h("div", { class: "brand-sub" }, "Заведения и отзывы"))
  );
}

// ================= Экран: Каталог =================

async function catalogView(params) {
  const q = params.get("q") || "";
  const cat = params.get("cat") || "";
  const min = params.get("min") || "";
  const sort = params.get("sort") || "top";

  const setParam = (key, value) => {
    const p = new URLSearchParams(params);
    if (value) p.set(key, value);
    else p.delete(key);
    go(`#/catalog${p.toString() ? `?${p}` : ""}`, true);
  };

  const cats = [["", "Все"], ["restaurant", "Кафе и рестораны"], ["beauty", "Салоны красоты"], ["barber", "Барбершопы"], ["shop", "Магазины"], ["other", "Другое"]];
  const list = h("div", { class: "list" });
  const more = h("button", { class: "btn btn-soft btn-block", hidden: true }, "Показать ещё");

  render(
    h("header", { class: "head" },
      h("h1", { class: "title", style: "margin-bottom:12px" }, "Каталог"),
      searchBox(q, (v) => setParam("q", v), (v) => setParam("q", v))
    ),
    h("div", { class: "chips", style: "margin-top:4px" },
      cats.map(([key, label]) => h("button", { class: `chip${key === cat ? " on" : ""}`, onclick: () => { haptic.tap(); setParam("cat", key); } }, label))
    ),
    h("div", { class: "filters" },
      h("div", { class: "seg", role: "group", "aria-label": "Минимальная оценка" },
        [["", "Любые"], ["4", "4+"], ["4.5", "4,5+"]].map(([v, label]) =>
          h("button", { class: v === min ? "on" : "", onclick: () => { haptic.tap(); setParam("min", v); } }, label)
        )
      ),
      (() => {
        const s = h("select", { class: "select", "aria-label": "Сортировка" },
          [["top", "По рейтингу"], ["popular", "Популярные"], ["new", "Новые"], ["name", "По названию"]].map(([v, label]) =>
            h("option", { value: v, selected: v === sort }, label)
          )
        );
        s.addEventListener("change", () => setParam("sort", s.value === "top" ? "" : s.value));
        return s;
      })()
    ),
    list,
    h("div", { class: "pad", style: "margin-top:12px" }, more)
  );

  let offset = 0;
  const load = async () => {
    more.disabled = true;
    if (!offset) list.replaceChildren(...skeletonList(4).children);
    try {
      const qs = new URLSearchParams({ q, cat, min, sort, offset: String(offset) });
      const data = await api(`/api/app/places?${qs}`);
      if (!offset) list.replaceChildren();
      list.append(...data.items.map(row));
      offset += data.items.length;
      more.hidden = !data.more;
      if (!list.children.length) {
        list.replaceChildren(
          emptyView(I.search, "Ничего не нашли", q || cat || min ? "Попробуйте другой запрос или уберите фильтры." : "В каталоге пока нет заведений.")
        );
      }
    } catch (error) {
      list.replaceChildren(errorView(error, load));
    } finally {
      more.disabled = false;
    }
  };
  more.addEventListener("click", load);
  load();
}

// ================= Экран: Заведение =================

async function placeView(slug) {
  render(
    h("div", { class: "gallery sk", style: "border-radius:0" }),
    h("div", { class: "place-card" }, h("div", { class: "sk sk-line", style: "height:22px;width:60%" }), h("div", { class: "sk sk-line", style: "width:40%" })),
    skeletonList(2)
  );
  let data;
  try {
    data = await api(`/api/app/places/${encodeURIComponent(slug)}`);
  } catch (error) {
    return render(errorView(error, () => placeView(slug)));
  }
  state.lastPlace = data;
  const p = data.place;

  // Фото
  const photos = p.photos.length ? p.photos : [];
  const gallery = photos.length
    ? h("div", { class: "gallery-wrap" },
        h("div", { class: "gallery" }, photos.map((src) => h("img", { src, alt: "", loading: "lazy", onclick: () => lightbox(src) }))),
        photos.length > 1 ? h("span", { class: "gallery-count" }, `${photos.length} фото`) : null
      )
    : null;

  // Избранное
  const favBtn = h("button", { class: `btn btn-soft btn-icon${data.favorite ? " on" : ""}`, "aria-label": "В избранное", "aria-pressed": String(data.favorite) }, icon(I.heart));
  favBtn.addEventListener("click", async () => {
    if (!requireTelegram()) return;
    const on = !favBtn.classList.contains("on");
    favBtn.classList.toggle("on", on);
    haptic.tap();
    try {
      await api(`/api/app/favorites/${encodeURIComponent(p.slug)}`, { method: on ? "PUT" : "DELETE" });
      toast(on ? "Добавлено в избранное" : "Убрано из избранного");
    } catch (error) {
      favBtn.classList.toggle("on", !on);
      toast(error.message);
    }
  });
  const shareBtn = h("button", { class: "btn btn-soft btn-icon", "aria-label": "Поделиться", onclick: () => sharePlace(p) }, icon(I.share));

  const mine = data.myReview;
  const reviewBtn = h("button", { class: "btn btn-primary", onclick: () => reviewSheet(p, mine) }, icon(I.pen), mine ? "Изменить отзыв" : "Оставить отзыв");
  if (data.banned) reviewBtn.disabled = true;

  // Рейтинг
  const r = data.rating;
  const maxDist = Math.max(1, ...r.dist);
  const ratingCard = h("div", { class: "card rating" },
    h("div", { class: "rating-big" },
      h("div", { class: "rating-num" }, fmtRating(r.avg)),
      stars(r.avg),
      h("div", { class: "rating-count" }, r.count ? reviewsWord(r.count) : "Пока нет отзывов")
    ),
    h("div", { class: "bars" },
      [5, 4, 3, 2, 1].map((s) =>
        h("div", { class: "bar" },
          h("span", null, String(s)),
          h("div", { class: "bar-track" }, h("div", { class: "bar-fill", style: `width:${(r.dist[s - 1] / maxDist) * 100}%` })),
          h("span", { class: "bar-n" }, String(r.dist[s - 1]))
        )
      )
    )
  );

  // Адрес и ссылки
  const mapUrl = p.maps.yandex || p.maps.twogis || p.maps.google ||
    (p.address ? `https://yandex.ru/maps/?text=${encodeURIComponent([p.city, p.address].filter(Boolean).join(", "))}` : null);
  const infoCard = p.address || p.links.length
    ? h("div", { class: "card" },
        p.address
          ? h("button", { class: "info-row", style: "width:100%;border-left:0;border-right:0;border-bottom:0;background:none;text-align:left", onclick: () => mapUrl && openLink(mapUrl) },
              icon(I.pin),
              h("div", { class: "info-main" }, [p.city, p.address].filter(Boolean).join(", "), mapUrl ? h("div", { class: "info-sub" }, "Открыть на карте") : null),
              mapUrl ? h("span", { class: "info-go" }, "›") : null
            )
          : null,
        p.links.length
          ? h("div", { class: "info-row" },
              h("div", { class: "links", style: "width:100%" },
                p.links.map((l) =>
                  h("button", { class: "link-btn", onclick: () => openLink(l.url) }, icon(I.links[l.type] || I.links.custom), h("span", null, l.label || LINK_LABELS[l.type] || "Ссылка"))
                )
              )
            )
          : null
      )
    : null;

  // Мой отзыв: статус
  let myNotice = null;
  if (mine) {
    const texts = {
      pending: ["Ваш отзыв на проверке", "Обычно это занимает до суток. Потом его увидят все."],
      published: ["Ваш отзыв опубликован", "Спасибо! Изменить его можно в любой момент."],
      rejected: ["Отзыв не прошёл проверку", mine.rejectReason ? `Причина: ${mine.rejectReason}. Исправьте и отправьте снова.` : "Исправьте и отправьте снова."]
    }[mine.status];
    myNotice = h("div", { class: `notice notice-${mine.status}` }, h("div", null, h("b", null, texts[0]), texts[1]));
  } else if (state.ticket && state.ticketSlug === p.slug) {
    myNotice = h("div", { class: "notice notice-info" }, icon(I.card), h("div", null, h("b", null, "Вы пришли по карте TapReview"), "Ваш отзыв получит метку «по карте TapReview»."));
  }
  if (data.banned) myNotice = h("div", { class: "notice notice-rejected" }, h("div", null, h("b", null, "Отзывы недоступны"), "Ваш аккаунт заблокирован за нарушение правил."));

  // Отзывы
  const reviewsBox = h("div", { class: "reviews" }, data.reviews.map((rv) => reviewItem(rv, data)));
  const moreBtn = h("button", { class: "btn btn-soft btn-block", hidden: !data.more }, "Показать ещё отзывы");
  let offset = data.reviews.length;
  moreBtn.addEventListener("click", async () => {
    moreBtn.disabled = true;
    try {
      const page = await api(`/api/app/places/${encodeURIComponent(p.slug)}/reviews?offset=${offset}`);
      reviewsBox.append(...page.reviews.map((rv) => reviewItem(rv, data)));
      offset += page.reviews.length;
      moreBtn.hidden = !page.more;
    } catch (error) {
      toast(error.message);
    } finally {
      moreBtn.disabled = false;
    }
  });

  render(
    gallery,
    h("div", { class: "place-card", style: gallery ? null : "margin-top:0" },
      h("div", { class: "place-top" },
        h("div", { class: "place-logo" }, p.logo ? h("img", { class: "logo-fit", style: "padding:10%", src: p.logo, alt: "" }) : initials(p.name)),
        h("div", { style: "min-width:0" }, h("h1", { class: "place-name" }, p.name), h("div", { class: "place-sub" }, [p.categoryLabel, p.tagline !== p.categoryLabel ? p.tagline : null].filter(Boolean).join(" · ")))
      ),
      p.description ? h("p", { class: "place-desc" }, p.description) : null,
      h("div", { class: "actions" }, reviewBtn, favBtn, shareBtn)
    ),
    h("div", { class: "stack" },
      myNotice,
      ratingCard,
      infoCard,
      h("div", { class: "section-head", style: "padding:10px 0 0" }, h("h2", { class: "section-title" }, "Отзывы гостей")),
      data.reviews.length ? reviewsBox : emptyView(I.chat, "Отзывов пока нет", "Станьте первым — это займёт минуту."),
      moreBtn,
      h("p", { class: "fine", style: "margin:6px 2px 0" },
        "Отзывы публикуются после проверки. Авторы показаны как «Гость». Метка «по карте TapReview» значит, что отзыв оставлен по ссылке с карты в заведении, но не гарантирует визит.")
    )
  );

  // Пришли с карты и отзыва ещё нет — сразу открываем форму
  if (state.ticket && state.ticketSlug === p.slug && !mine && state.autoOpen) {
    state.autoOpen = false;
    setTimeout(() => reviewSheet(p, null), 350);
  }
}

function reviewItem(rv, data) {
  const node = h("article", { class: "review" });
  const moreBtn = h("button", { class: "review-more", "aria-label": "Ещё", onclick: () => reviewMenu(rv, data, node) }, "⋯");
  // Пустые части (нет фото, нет ответа) пропускаем: node.append(null) напечатал бы «null»
  node.append(...[
    h("div", { class: "review-head" },
      h("div", { class: "avatar" }, icon(I.user)),
      h("div", null, h("div", { class: "review-who" }, rv.mine ? "Вы" : "Гость"), h("div", { class: "review-date" }, fmtDate(rv.date), rv.edited ? " · изменён" : "")),
      rv.mine ? null : moreBtn
    ),
    h("div", { class: "review-stars" },
      stars(rv.score, 15),
      rv.viaCard
        ? h("button", { class: "tag-card", onclick: () => toast("Отзыв оставлен по ссылке с карты TapReview в заведении. Это не гарантия визита.") }, icon(I.card), "по карте TapReview")
        : null
    ),
    rv.text ? h("p", { class: "review-text" }, rv.text) : null,
    rv.photo ? h("button", { class: "review-photo", onclick: () => lightbox(rv.photo), "aria-label": "Фото к отзыву" }, h("img", { src: rv.photo, alt: "", loading: "lazy" })) : null,
    rv.reply ? h("div", { class: "reply" }, h("div", { class: "reply-who" }, "Ответ заведения"), h("div", { class: "reply-text" }, rv.reply.text)) : null
  ].filter(Boolean));
  if (data.isOwner) {
    node.append(
      h("div", { class: "owner-actions" },
        h("button", { class: "btn btn-ghost", onclick: () => replySheet(rv, data) }, rv.reply ? "Изменить ответ" : "Ответить"),
        rv.reply ? h("button", { class: "btn btn-ghost", style: "color:var(--bad)", onclick: () => deleteReply(rv) }, "Удалить ответ") : null
      )
    );
  }
  return node;
}

function reviewMenu(rv) {
  if (!requireTelegram()) return;
  let reason = "";
  const comment = h("textarea", { class: "textarea", style: "min-height:80px", maxlength: "500", placeholder: "Комментарий (необязательно)" });
  const send = h("button", { class: "btn btn-primary btn-block", disabled: true }, "Отправить жалобу");
  const sheet = openSheet(
    h("h2", null, "Пожаловаться на отзыв"),
    h("p", { class: "lead" }, "Модератор проверит отзыв. Ваше имя никто не увидит."),
    h("div", { class: "radio-list" },
      REPORT_REASONS.map(([key, label]) =>
        h("label", { class: "radio" }, h("input", { type: "radio", name: "reason", value: key, onchange: () => { reason = key; send.disabled = false; } }), label)
      )
    ),
    h("label", { class: "field" }, comment),
    h("div", { class: "sheet-actions" }, send, h("button", { class: "btn btn-soft btn-block", onclick: () => sheet.close() }, "Отмена"))
  );
  send.addEventListener("click", async () => {
    send.disabled = true;
    try {
      await api(`/api/app/reviews/${rv.id}/report`, { method: "POST", body: { reason, comment: comment.value } });
      haptic.ok();
      sheet.close();
      toast("Спасибо, жалоба отправлена");
    } catch (error) {
      haptic.err();
      toast(error.message);
      send.disabled = false;
    }
  });
}

// ================= Форма отзыва =================

function reviewSheet(p, mine) {
  if (!requireTelegram(p)) return;
  let score = mine ? mine.score : 0;
  let photoData = null; // новое фото (dataURL)
  let keepPhoto = Boolean(mine && mine.photo);

  const hint = h("div", { class: "star-hint" }, score ? SCORE_HINTS[score] : "Нажмите на звезду");
  const starBtns = [1, 2, 3, 4, 5].map((n) => h("button", { type: "button", "aria-label": `${n} из 5` }, icon(I.star)));
  const paint = () => starBtns.forEach((b, i) => b.classList.toggle("on", i < score));
  starBtns.forEach((b, i) =>
    b.addEventListener("click", () => {
      score = i + 1;
      haptic.tap();
      paint();
      b.classList.remove("pop");
      void b.offsetWidth;
      b.classList.add("pop");
      hint.textContent = SCORE_HINTS[score];
      textarea.placeholder = score <= 2 ? "Что пошло не так? Это поможет заведению исправиться" : "Что понравилось? Блюда, мастер, атмосфера…";
      check();
    })
  );
  paint();

  const textarea = h("textarea", { class: "textarea", maxlength: "2000", placeholder: "Расскажите о своём опыте: что понравилось, что нет" });
  textarea.value = mine ? mine.text : "";
  const counter = h("div", { class: "counter" }, `${textarea.value.length} / 2000`);
  textarea.addEventListener("input", () => {
    counter.textContent = `${textarea.value.length} / 2000`;
    check();
  });

  const fileInput = h("input", { type: "file", accept: "image/*", hidden: true });
  const photoBox = h("div", { class: "photo-pick" });
  const showPhoto = () => {
    const src = photoData || (keepPhoto && mine && mine.photo);
    photoBox.replaceChildren(
      src
        ? h("div", { class: "photo-prev" }, h("img", { src, alt: "" }),
            h("button", { class: "photo-del", type: "button", "aria-label": "Убрать фото", onclick: () => { photoData = null; keepPhoto = false; showPhoto(); } }, "×"))
        : h("button", { class: "btn btn-soft", type: "button", onclick: () => fileInput.click() }, icon(I.photo), "Добавить фото"),
      h("span", { class: "fine" }, src ? "Фото увидят после проверки" : "Одно фото, необязательно"),
      fileInput
    );
  };
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    try {
      photoData = await compressPhoto(file);
      keepPhoto = false;
      showPhoto();
    } catch {
      toast("Не получилось открыть фото");
    }
  });
  showPhoto();

  const viaCard = (mine && mine.viaCard) || (state.ticket && state.ticketSlug === p.slug);
  const submit = h("button", { class: "btn btn-primary btn-block", disabled: true }, mine ? "Отправить изменения" : "Отправить отзыв");
  const check = () => {
    submit.disabled = !score || (score <= 2 && textarea.value.trim().length < 10);
  };

  const sheet = openSheet(
    h("h2", null, p.name),
    h("p", { class: "lead" }, mine ? "Изменённый отзыв снова пройдёт проверку" : "Ваша оценка поможет другим гостям"),
    h("div", { class: "star-input", role: "group", "aria-label": "Оценка" }, starBtns),
    hint,
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Отзыв"), textarea, counter),
    photoBox,
    viaCard ? h("div", { class: "notice notice-info", style: "margin-top:14px" }, icon(I.card), h("div", null, h("b", null, "Отзыв по карте TapReview"), "Вы открыли приложение с карты в заведении.")) : null,
    h("p", { class: "fine", style: "margin:14px 0 0" },
      "Публично вы будете «Гость». Отзыв появится после проверки модератором. Без оскорблений, рекламы и личных данных (телефонов, фамилий сотрудников)."),
    h("div", { class: "sheet-actions" }, submit,
      mine ? h("button", { class: "btn btn-ghost", style: "color:var(--bad)", onclick: () => removeReview(mine, sheet, p) }, "Удалить мой отзыв") : null
    )
  );
  check();

  submit.addEventListener("click", async () => {
    submit.disabled = true;
    submit.textContent = "Отправляю…";
    try {
      await api("/api/app/reviews", {
        method: "POST",
        body: {
          slug: p.slug,
          score,
          text: textarea.value,
          photo: photoData,
          keepPhoto,
          ticket: state.ticketSlug === p.slug ? state.ticket : null
        }
      });
      haptic.ok();
      sheet.close();
      toast("Спасибо! Отзыв отправлен на проверку");
      placeView(p.slug);
    } catch (error) {
      haptic.err();
      toast(error.message);
      submit.textContent = mine ? "Отправить изменения" : "Отправить отзыв";
      check();
    }
  });
}

async function removeReview(mine, sheet, p) {
  if (!(await confirmBox("Удалить ваш отзыв? Это нельзя отменить."))) return;
  try {
    await api(`/api/app/reviews/${mine.id}`, { method: "DELETE" });
    sheet.close();
    toast("Отзыв удалён");
    placeView(p.slug);
  } catch (error) {
    toast(error.message);
  }
}

function replySheet(rv) {
  const textarea = h("textarea", { class: "textarea", maxlength: "1000", placeholder: "Спасибо за отзыв! …" });
  textarea.value = rv.reply ? rv.reply.text : "";
  const send = h("button", { class: "btn btn-primary btn-block" }, "Опубликовать ответ");
  const sheet = openSheet(
    h("h2", null, "Ответ заведения"),
    h("p", { class: "lead" }, "Ответ увидят все. Пишите вежливо и по делу — гости это ценят."),
    h("label", { class: "field" }, textarea),
    h("div", { class: "sheet-actions" }, send)
  );
  send.addEventListener("click", async () => {
    send.disabled = true;
    try {
      await api(`/api/app/reviews/${rv.id}/reply`, { method: "POST", body: { text: textarea.value } });
      haptic.ok();
      sheet.close();
      toast("Ответ опубликован");
      placeView(state.lastPlace.place.slug);
    } catch (error) {
      toast(error.message);
      send.disabled = false;
    }
  });
}

async function deleteReply(rv) {
  if (!(await confirmBox("Удалить ответ заведения?"))) return;
  try {
    await api(`/api/app/reviews/${rv.id}/reply`, { method: "DELETE" });
    toast("Ответ удалён");
    placeView(state.lastPlace.place.slug);
  } catch (error) {
    toast(error.message);
  }
}

// Фото: длинная сторона до 1280 px, JPEG ≤ 300 КБ (как в админке)
async function compressPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * k);
    canvas.height = Math.round(img.naturalHeight * k);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    let data;
    for (const q of [0.82, 0.72, 0.62, 0.52, 0.42]) {
      data = canvas.toDataURL("image/jpeg", q);
      if (data.length * 0.75 <= 300 * 1024) break;
    }
    return data;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// ================= Нижний лист, картинка на весь экран =================

function openSheet(...content) {
  const root = document.getElementById("sheet-root");
  const backdrop = h("div", { class: "sheet-backdrop" });
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true" }, h("div", { class: "sheet-grip" }), ...content);
  root.replaceChildren(backdrop, sheet);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sheet.classList.add("closing");
    backdrop.style.opacity = "0";
    setTimeout(() => root.replaceChildren(), 200);
    syncBackButton();
  };
  backdrop.addEventListener("click", close);
  state.sheet = { close, isOpen: () => !closed };
  syncBackButton(true);
  return { close };
}

function lightbox(src) {
  const root = document.getElementById("sheet-root");
  const box = h("div", { class: "lightbox", onclick: () => { root.replaceChildren(); syncBackButton(); } }, h("img", { src, alt: "" }));
  root.replaceChildren(box);
  state.sheet = { close: () => { root.replaceChildren(); syncBackButton(); }, isOpen: () => root.contains(box) };
  syncBackButton(true);
}

// ================= Вне Telegram =================

function appLink(startParam) {
  const c = state.config;
  if (!c || !c.bot) return null;
  return `https://t.me/${c.bot}${c.app ? `/${c.app}` : ""}${startParam ? `?${c.app ? "startapp" : "start"}=${startParam}` : ""}`;
}

function requireTelegram(p) {
  if (inTelegram) return true;
  const link = appLink(p ? `p_${p.slug}` : "");
  const sheet = openSheet(
    h("h2", null, "Откройте в Telegram"),
    h("p", { class: "lead" }, "Оставлять отзывы и сохранять избранное можно в приложении TapReview в Telegram — так мы защищаем отзывы от накрутки."),
    h("div", { class: "sheet-actions" },
      link ? h("a", { class: "btn btn-primary btn-block", href: link, target: "_blank", rel: "noopener" }, "Открыть в Telegram") : null,
      h("button", { class: "btn btn-soft btn-block", onclick: () => sheet.close() }, "Понятно")
    )
  );
  return false;
}

function sharePlace(p) {
  const link = appLink(`p_${p.slug}`);
  if (!link) return toast("Ссылка появится после запуска приложения в Telegram");
  const text = `${p.name} — отзывы гостей в TapReview`;
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
  haptic.tap();
  openLink(share);
}

// ================= Избранное и профиль =================

async function favoritesView() {
  render(h("header", { class: "head" }, h("h1", { class: "title" }, "Избранное")), skeletonList(3));
  if (!inTelegram) {
    return render(h("header", { class: "head" }, h("h1", { class: "title" }, "Избранное")),
      emptyView(I.heart, "Только в Telegram", "Избранное хранится в вашем аккаунте Telegram.", openInTelegramButton()));
  }
  try {
    const data = await api("/api/app/me");
    render(
      h("header", { class: "head" }, h("h1", { class: "title" }, "Избранное")),
      data.favorites.length
        ? h("div", { class: "list" }, data.favorites.map(row))
        : emptyView(I.heart, "Пока пусто", "Нажмите на сердечко на странице заведения, чтобы сохранить его здесь.", h("a", { class: "btn btn-soft", href: "#/catalog" }, "Открыть каталог"))
    );
  } catch (error) {
    render(errorView(error, favoritesView));
  }
}

function openInTelegramButton() {
  const link = appLink("");
  return link ? h("a", { class: "btn btn-primary", href: link, target: "_blank", rel: "noopener" }, "Открыть в Telegram") : null;
}

const STATUS_LABEL = { pending: "На проверке", published: "Опубликован", rejected: "Отклонён" };

async function meView() {
  const head = h("header", { class: "head" }, h("h1", { class: "title" }, "Профиль"), h("p", { class: "lead" }, "Ваши отзывы и настройки"));
  if (!inTelegram) return render(head, emptyView(I.user, "Только в Telegram", "Профиль привязан к вашему аккаунту Telegram.", openInTelegramButton()));
  render(head, skeletonList(3));
  let data;
  try {
    data = await api("/api/app/me");
  } catch (error) {
    return render(head, errorView(error, meView));
  }

  const reviews = data.reviews.length
    ? h("div", { class: "menu" },
        data.reviews.map((r) =>
          h("a", { class: "menu-item", href: r.place && r.place.visible ? `#/place/${encodeURIComponent(r.place.slug)}` : "#/me" },
            h("div", { class: "grow" },
              h("div", { style: "font-weight:700;color:var(--ink)" }, r.place ? r.place.name : "Заведение"),
              h("span", { class: "sub" }, `${"★".repeat(r.score)}${"☆".repeat(5 - r.score)} · ${fmtDate(r.updated || r.date)}${r.text ? ` · ${r.text}` : ""}`)
            ),
            h("span", { class: `pill pill-${r.status}` }, STATUS_LABEL[r.status])
          )
        )
      )
    : emptyView(I.pen, "Вы ещё не оставляли отзывов", "Найдите заведение в каталоге и поделитесь впечатлением.", h("a", { class: "btn btn-soft", href: "#/catalog" }, "Открыть каталог"));

  const business = data.businesses.length
    ? [
        h("div", { class: "section-head", style: "padding:18px 0 10px" }, h("h2", { class: "section-title" }, "Мои заведения")),
        h("div", { class: "menu" },
          data.businesses.map((b) =>
            h("a", { class: "menu-item", href: b.inCatalog ? `#/place/${encodeURIComponent(b.slug)}` : "#/me", onclick: b.inCatalog ? null : () => toast("Заведение пока не в каталоге") },
              icon(I.store, "menu-icon"),
              h("div", { class: "grow" }, h("div", { style: "font-weight:700;color:var(--ink)" }, b.name), h("span", { class: "sub" }, b.inCatalog ? "Отвечайте на отзывы на странице заведения" : "Не показывается в каталоге")),
              h("span", { class: "info-go" }, "›")
            )
          )
        )
      ]
    : [];

  render(
    head,
    h("div", { class: "stack" },
      data.banned ? h("div", { class: "notice notice-rejected" }, h("div", null, h("b", null, "Аккаунт заблокирован"), "Вы не можете оставлять отзывы и жалобы.")) : null,
      h("div", { class: "section-head", style: "padding:6px 0 0" }, h("h2", { class: "section-title" }, "Мои отзывы"), h("span", { class: "fine" }, data.reviews.length ? String(data.reviews.length) : "")),
      reviews,
      ...business,
      h("div", { class: "section-head", style: "padding:18px 0 0" }, h("h2", { class: "section-title" }, "Данные и приватность")),
      h("div", { class: "card fine" },
        "Мы храним только ваш Telegram ID — чтобы один человек оставлял один отзыв о заведении и для защиты от накрутки. ",
        "Имя, фото и username не сохраняем. В отзывах вы — «Гость». Данные хранятся на сервере в России. ",
        h("a", { href: "/privacy/", onclick: (e) => { e.preventDefault(); openLink(`${location.origin}/privacy/`); }, style: "color:var(--navy-2);font-weight:600" }, "Политика конфиденциальности")
      ),
      h("button", { class: "btn btn-soft btn-block danger", onclick: deleteMe }, icon(I.trash), "Удалить мои данные")
    )
  );
}

async function deleteMe() {
  if (!(await confirmBox("Удалить все ваши отзывы, жалобы и избранное? Это нельзя отменить."))) return;
  try {
    await api("/api/app/me", { method: "DELETE" });
    haptic.ok();
    toast("Данные удалены");
    meView();
  } catch (error) {
    toast(error.message);
  }
}

// ================= Навигация =================

const TAB_OF = { "": "home", catalog: "catalog", favorites: "favorites", me: "me" };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(query || "") };
}

function go(hash, replace) {
  if (replace) {
    history.replaceState(null, "", hash);
    route();
  } else {
    location.hash = hash;
  }
}

let depth = 0;
function goBack() {
  if (state.sheet && state.sheet.isOpen()) return state.sheet.close();
  if (depth > 0) history.back();
  else go("#/");
}

function syncBackButton(sheetOpen) {
  if (!tg || !tg.BackButton) return;
  const { parts } = parseHash();
  const isRoot = parts.length === 0 || (parts.length === 1 && parts[0] in TAB_OF);
  if (sheetOpen || !isRoot) tg.BackButton.show();
  else tg.BackButton.hide();
}

function route() {
  const { parts, params } = parseHash();
  if (state.sheet && state.sheet.isOpen()) state.sheet.close();
  const tab = parts[0] === "place" ? null : TAB_OF[parts[0] || ""];
  for (const t of document.querySelectorAll(".tabbar .tab")) t.classList.toggle("on", t.dataset.tab === tab);
  syncBackButton();
  window.scrollTo(0, 0);

  if (parts[0] === "place" && parts[1]) return placeView(parts[1]);
  if (parts[0] === "catalog") return catalogView(params);
  if (parts[0] === "favorites") return favoritesView();
  if (parts[0] === "me") return meView();
  return homeView();
}

window.addEventListener("hashchange", (e) => {
  const from = new URL(e.oldURL).hash;
  const to = location.hash;
  // глубина для «Назад»: заведение — на шаг глубже
  if (/^#\/place\//.test(to) && !/^#\/place\//.test(from)) depth++;
  else if (/^#\/place\//.test(from) && !/^#\/place\//.test(to)) depth = Math.max(0, depth - 1);
  route();
});

// ================= Запуск =================

async function start() {
  setupTelegram();
  api("/api/app/config").then((c) => (state.config = c)).catch(() => {});

  // Открыли по ссылке: p_<slug> — заведение, v_… — билет с карты TapReview
  const startParam = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || new URLSearchParams(location.search).get("tgWebAppStartParam") || "";
  if (/^p_[A-Za-z0-9_-]{3,64}$/.test(startParam) && !location.hash) {
    history.replaceState(null, "", `#/place/${encodeURIComponent(startParam.slice(2))}`);
    depth = 1;
  } else if (/^v_/.test(startParam)) {
    try {
      const t = await api(`/api/app/ticket?t=${encodeURIComponent(startParam)}`);
      if (t.valid && t.inCatalog) {
        state.ticket = startParam;
        state.ticketSlug = t.slug;
        state.autoOpen = true;
        history.replaceState(null, "", `#/place/${encodeURIComponent(t.slug)}`);
        depth = 1;
      }
    } catch {
      // билет не проверился — просто главная
    }
  }
  route();
}

start();
