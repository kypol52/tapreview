// TapReview — админ-панель.
// Вход — через Supabase Auth (email + пароль). Все данные — через наш API /api/admin/,
// который проверяет, что вошёл именно администратор.

const SESSION_KEY = "tapreview_admin_session";

const CATEGORY_LABELS = {
  restaurant: "Ресторан / кафе",
  beauty: "Салон красоты",
  shop: "Магазин",
  hotel: "Отель",
  auto: "Автосервис",
  other: "Другое"
};

const state = {
  config: null,
  session: null,
  businesses: [],
  editing: null // бизнес, который сейчас открыт в форме (null = новый)
};

const $ = (id) => document.getElementById(id);

// ================= Запуск =================

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();

  try {
    const response = await fetch("/api/config");
    state.config = await response.json();
  } catch {
    showLogin("Не удалось связаться с сервером. Обновите страницу.");
    return;
  }

  state.session = loadSession();
  if (state.session) {
    showApp();
  } else {
    showLogin();
  }
}

function bindEvents() {
  $("login-form").addEventListener("submit", onLogin);
  $("logout-button").addEventListener("click", logout);
  $("new-button").addEventListener("click", () => openEditor(null));
  $("search").addEventListener("input", renderList);

  $("editor-form").addEventListener("submit", onSave);
  $("editor-close").addEventListener("click", closeEditor);
  $("cancel-button").addEventListener("click", closeEditor);
  $("delete-button").addEventListener("click", onDelete);
  $("link-copy").addEventListener("click", () => copyText($("link-url").value));
  $("f-color-on").addEventListener("change", () => {
    $("f-color").disabled = !$("f-color-on").checked;
  });
}

// ================= Вход и сессия =================

async function onLogin(event) {
  event.preventDefault();
  hideError("login-error");

  const button = $("login-button");
  button.disabled = true;
  button.textContent = "Входим…";

  try {
    const data = await authRequest("password", {
      email: $("login-email").value.trim(),
      password: $("login-password").value
    });
    saveSession(data);
    $("login-password").value = "";
    showApp();
  } catch (error) {
    showError("login-error", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Войти";
  }
}

async function authRequest(grantType, body) {
  const response = await fetch(
    `${state.config.supabaseUrl}/auth/v1/token?grant_type=${grantType}`,
    {
      method: "POST",
      headers: {
        apikey: state.config.publishableKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  if (response.status === 429) {
    throw new Error("Слишком много попыток. Подождите несколько минут.");
  }
  if (!response.ok) {
    throw new Error("Неверный email или пароль");
  }
  return response.json();
}

function saveSession(data) {
  state.session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    email: data.user ? data.user.email : ""
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
  } catch {
    // без localStorage просто придётся входить заново после перезагрузки
  }
}

function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY));
    return saved && saved.refresh_token ? saved : null;
  } catch {
    return null;
  }
}

function clearSession() {
  state.session = null;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ничего страшного
  }
}

async function refreshSession() {
  const data = await authRequest("refresh_token", {
    refresh_token: state.session.refresh_token
  });
  saveSession(data);
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (!state.session.expires_at || state.session.expires_at - 60 < now) {
    await refreshSession();
  }
  return state.session.access_token;
}

async function logout() {
  const token = state.session && state.session.access_token;
  clearSession();
  showLogin();

  if (token && state.config) {
    // Сообщаем Supabase, что сессия закончена (если не получится — не страшно)
    fetch(`${state.config.supabaseUrl}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: state.config.publishableKey, Authorization: `Bearer ${token}` }
    }).catch(() => {});
  }
}

// ================= Запросы к нашему API =================

async function api(path, options = {}, retried = false) {
  let token;
  try {
    token = await getAccessToken();
  } catch {
    sessionExpired();
    throw new Error("Сессия истекла");
  }

  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (response.status === 401 && !retried) {
    try {
      await refreshSession();
      return api(path, options, true);
    } catch {
      sessionExpired();
      throw new Error("Сессия истекла");
    }
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // пустой ответ
  }

  if (response.status === 401) {
    sessionExpired();
    throw new Error("Сессия истекла");
  }
  if (!response.ok) {
    throw new Error((data && data.error) || `Ошибка ${response.status}`);
  }
  return data;
}

function sessionExpired() {
  clearSession();
  showLogin("Сессия истекла, войдите заново.");
}

// ================= Экраны =================

function showLogin(message) {
  $("app-view").hidden = true;
  $("login-view").hidden = false;
  if ($("editor").open) $("editor").close();
  if (message) {
    showError("login-error", message);
  } else {
    hideError("login-error");
  }
  $("login-email").focus();
}

function showApp() {
  $("login-view").hidden = true;
  $("app-view").hidden = false;
  $("user-email").textContent = state.session.email || "";
  loadBusinesses();
}

// ================= Список бизнесов =================

async function loadBusinesses() {
  $("loading").hidden = false;
  hideError("list-error");

  try {
    state.businesses = await api("/api/admin/businesses");
    renderList();
  } catch (error) {
    if (!$("app-view").hidden) {
      showError("list-error", error.message);
    }
  } finally {
    $("loading").hidden = true;
  }
}

function renderList() {
  const query = $("search").value.trim().toLowerCase();
  const items = state.businesses.filter(
    (b) =>
      !query ||
      b.name.toLowerCase().includes(query) ||
      b.slug.toLowerCase().includes(query)
  );

  const total = state.businesses.length;
  const active = state.businesses.filter((b) => b.is_active).length;
  $("count").textContent = total ? `Всего: ${total}, активных: ${active}` : "";

  const rows = $("rows");
  rows.replaceChildren(...items.map(renderRow));

  $("table").hidden = items.length === 0;
  $("empty").hidden = total !== 0;
}

function renderRow(business) {
  const tr = document.createElement("tr");

  // Название + адрес
  const nameCell = document.createElement("td");
  nameCell.append(el("div", "cell-name", business.name));
  if (business.address) {
    nameCell.append(el("div", "cell-sub", business.address));
  }

  // Категория
  const categoryCell = el("td", "cell-sub", CATEGORY_LABELS[business.category] || "—");

  // Статус
  const statusCell = document.createElement("td");
  statusCell.append(
    business.is_active
      ? el("span", "badge badge-on", "Активен")
      : el("span", "badge badge-off", "Выключен")
  );

  // Ссылка
  const linkCell = document.createElement("td");
  const linkWrap = el("div", "slug-cell");
  const copyButton = el("button", "btn btn-secondary btn-small", "Копировать");
  copyButton.type = "button";
  copyButton.addEventListener("click", () => copyText(publicUrl(business)));
  linkWrap.append(el("span", "slug", `/b/${business.slug}`), copyButton);
  linkCell.append(linkWrap);

  // Действия
  const actionsCell = el("td", "cell-actions");
  const openLink = el("a", "btn btn-ghost btn-small", "Открыть ↗");
  openLink.href = publicUrl(business);
  openLink.target = "_blank";
  openLink.rel = "noopener";
  const editButton = el("button", "btn btn-secondary btn-small", "Изменить");
  editButton.type = "button";
  editButton.addEventListener("click", () => openEditor(business));
  actionsCell.append(openLink, editButton);

  tr.append(nameCell, categoryCell, statusCell, linkCell, actionsCell);
  return tr;
}

// ================= Форма =================

function openEditor(business) {
  state.editing = business;
  hideError("editor-error");

  $("editor-title").textContent = business ? "Редактирование" : "Новый бизнес";
  $("delete-button").hidden = !business;

  $("f-name").value = business ? business.name : "";
  $("f-category").value = business ? business.category || "" : "";
  $("f-address").value = business ? business.address || "" : "";
  $("f-google").value = business ? business.google_url || "" : "";
  $("f-yandex").value = business ? business.yandex_url || "" : "";
  $("f-twogis").value = business ? business.twogis_url || "" : "";
  $("f-logo").value = business ? business.logo_url || "" : "";
  $("f-active").checked = business ? business.is_active : true;

  const hasColor = Boolean(business && business.brand_color);
  $("f-color-on").checked = hasColor;
  $("f-color").disabled = !hasColor;
  $("f-color").value = hasColor ? business.brand_color.toLowerCase() : "#2563eb";

  showLinkBox(business);

  if (!$("editor").open) $("editor").showModal();
  $("f-name").focus();
}

function showLinkBox(business) {
  $("link-box").hidden = !business;
  if (business) {
    $("link-url").value = publicUrl(business);
    $("link-open").href = publicUrl(business);
  }
}

function closeEditor() {
  $("editor").close();
  state.editing = null;
}

function readForm() {
  return {
    name: $("f-name").value,
    category: $("f-category").value || null,
    address: $("f-address").value,
    google_url: $("f-google").value,
    yandex_url: $("f-yandex").value,
    twogis_url: $("f-twogis").value,
    logo_url: $("f-logo").value,
    brand_color: $("f-color-on").checked ? $("f-color").value : null,
    is_active: $("f-active").checked
  };
}

async function onSave(event) {
  event.preventDefault();
  hideError("editor-error");

  const button = $("save-button");
  button.disabled = true;
  button.textContent = "Сохраняем…";

  try {
    const isNew = !state.editing;
    const saved = isNew
      ? await api("/api/admin/businesses", { method: "POST", body: readForm() })
      : await api(`/api/admin/businesses/${state.editing.id}`, {
          method: "PATCH",
          body: readForm()
        });

    upsertBusiness(saved);
    renderList();

    if (isNew) {
      // Оставляем окно открытым: сразу видна готовая ссылка для NFC и QR
      openEditor(saved);
      toast("Бизнес создан. Ссылка готова.");
    } else {
      closeEditor();
      toast("Сохранено");
    }
  } catch (error) {
    showError("editor-error", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Сохранить";
  }
}

async function onDelete() {
  const business = state.editing;
  if (!business) return;

  const ok = confirm(
    `Удалить «${business.name}» навсегда?\n\n` +
      "Страница перестанет открываться, статистика удалится.\n" +
      "Если нужно временно отключить — лучше снимите галочку «Активен»."
  );
  if (!ok) return;

  try {
    await api(`/api/admin/businesses/${business.id}`, { method: "DELETE" });
    state.businesses = state.businesses.filter((b) => b.id !== business.id);
    renderList();
    closeEditor();
    toast("Бизнес удалён");
  } catch (error) {
    showError("editor-error", error.message);
  }
}

function upsertBusiness(saved) {
  const index = state.businesses.findIndex((b) => b.id === saved.id);
  if (index === -1) {
    state.businesses.unshift(saved);
  } else {
    state.businesses[index] = saved;
  }
}

// ================= Мелочи =================

function publicUrl(business) {
  return `${window.location.origin}/b/${business.slug}`;
}

// Пока открыто окно формы, остальная страница «заморожена»,
// поэтому временные элементы добавляем внутрь окна
function overlayHost() {
  return $("editor").open ? $("editor") : document.body;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // запасной способ для старых браузеров
    const input = document.createElement("textarea");
    input.value = text;
    overlayHost().append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  toast("Ссылка скопирована");
}

let toastTimer;
function toast(message) {
  const box = $("toast");
  overlayHost().append(box);
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, 2200);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showError(id, message) {
  $(id).textContent = message;
  $(id).hidden = false;
}

function hideError(id) {
  $(id).hidden = true;
}
