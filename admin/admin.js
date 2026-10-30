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
  summary: {}, // id бизнеса → { page_views, clicks } за 30 дней
  editing: null, // бизнес, который сейчас открыт в форме (null = новый)
  groups: [],
  groupsLoaded: false,
  editingGroup: null, // группа, открытая в форме группы (null = новая)
  groupItems: [], // id заведений в форме группы, по порядку
  cards: [],
  cardsLoaded: false,
  cardStats: {}, // id карты → { page_views, clicks } за 30 дней
  cardFilter: "all",
  billingFilter: "all", // фильтр списка бизнесов по подписке
  orders: [],
  orderFilter: "open",
  editingCard: null,
  pendingCardCode: null, // карта, которую нужно открыть после загрузки (?card=КОД)
  tg: null // состояние Telegram-бота (загружается один раз)
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
  for (const chip of document.querySelectorAll("#businesses-section .chip")) {
    chip.addEventListener("click", () => {
      state.billingFilter = chip.dataset.billing;
      for (const other of document.querySelectorAll("#businesses-section .chip")) {
        other.classList.toggle("active", other === chip);
      }
      renderList();
    });
  }
  $("f-plus-month").addEventListener("click", () => extendPaidUntil(1));
  $("f-plus-year").addEventListener("click", () => extendPaidUntil(12));
  $("f-no-billing").addEventListener("click", () => {
    $("f-paid-until").value = "";
    showBillingStatus();
  });
  $("f-paid-until").addEventListener("input", showBillingStatus);
  $("f-bonus-mode").addEventListener("change", showBonusMode);
  $("staff-create").addEventListener("click", onCreateStaffLink);
  $("f-prize-add").addEventListener("click", () => {
    if ($("f-prizes").children.length < 8) $("f-prizes").append(prizeRow({ label: "", weight: 10 }));
    updatePrizeShares();
  });

  $("editor-form").addEventListener("submit", onSave);
  $("editor-close").addEventListener("click", closeEditor);
  $("cancel-button").addEventListener("click", closeEditor);
  $("delete-button").addEventListener("click", onDelete);
  $("link-copy").addEventListener("click", () => copyText($("link-url").value));
  $("qr-png").addEventListener("click", () => {
    if (state.editing) downloadQrPng(sourceUrl(state.editing, "qr"), `tapreview-qr-${state.editing.slug}`);
  });
  $("qr-svg").addEventListener("click", () => {
    if (state.editing) downloadQrSvg(sourceUrl(state.editing, "qr"), `tapreview-qr-${state.editing.slug}`);
  });
  $("f-color-on").addEventListener("change", () => {
    $("f-color").disabled = !$("f-color-on").checked;
  });
  $("sl-create").addEventListener("click", onCreateStatsLink);
  $("tg-setup").addEventListener("click", onTelegramSetup);
  $("tg-invite").addEventListener("click", onTelegramInvite);
  $("tg-link-copy").addEventListener("click", () => copyText($("tg-link").value));

  // Разделы
  $("tab-businesses").addEventListener("click", () => showTab("businesses"));
  $("tab-groups").addEventListener("click", () => showTab("groups"));

  // Группы
  $("g-new-button").addEventListener("click", () => openGroupEditor(null));
  $("group-form").addEventListener("submit", onSaveGroup);
  $("g-editor-close").addEventListener("click", closeGroupEditor);
  $("g-cancel-button").addEventListener("click", closeGroupEditor);
  $("g-delete-button").addEventListener("click", onDeleteGroup);
  $("g-add-button").addEventListener("click", addGroupItem);
  $("g-link-copy").addEventListener("click", () => copyText($("g-link-url").value));
  $("g-qr-png").addEventListener("click", () => {
    const g = state.editingGroup;
    if (g) downloadQrPng(groupSourceUrl(g, "qr"), `tapreview-qr-group-${g.slug}`);
  });
  $("g-qr-svg").addEventListener("click", () => {
    const g = state.editingGroup;
    if (g) downloadQrSvg(groupSourceUrl(g, "qr"), `tapreview-qr-group-${g.slug}`);
  });

  // Заявки
  $("tab-orders").addEventListener("click", () => showTab("orders"));
  $("o-refresh").addEventListener("click", loadOrders);
  $("o-tg-invite").addEventListener("click", onOrderTgInvite);
  for (const chip of document.querySelectorAll("#orders-section .chip")) {
    chip.addEventListener("click", () => {
      state.orderFilter = chip.dataset.ostatus;
      for (const other of document.querySelectorAll("#orders-section .chip")) {
        other.classList.toggle("active", other === chip);
      }
      renderOrders();
    });
  }

  // Карты
  $("tab-cards").addEventListener("click", () => showTab("cards"));
  $("c-issue-button").addEventListener("click", openIssueDialog);
  $("issue-form").addEventListener("submit", onIssueCards);
  $("issue-close").addEventListener("click", () => $("issue-dialog").close());
  $("issue-cancel").addEventListener("click", () => $("issue-dialog").close());
  $("c-csv-button").addEventListener("click", downloadCardsCsv);
  $("c-search").addEventListener("input", renderCards);
  $("c-search").addEventListener("keydown", onCardSearchEnter);
  for (const chip of document.querySelectorAll("#cards-section .chip")) {
    chip.addEventListener("click", () => {
      state.cardFilter = chip.dataset.filter;
      for (const other of document.querySelectorAll("#cards-section .chip")) {
        other.classList.toggle("active", other === chip);
      }
      renderCards();
    });
  }
  $("card-form").addEventListener("submit", onSaveCard);
  $("c-editor-close").addEventListener("click", closeCardEditor);
  $("c-cancel-button").addEventListener("click", closeCardEditor);
  $("c-delete-button").addEventListener("click", onDeleteCard);
  $("c-link-copy").addEventListener("click", () => copyText($("c-link-url").value));
  $("c-qr-png").addEventListener("click", () => {
    const c = state.editingCard;
    if (c) downloadQrPng(cardUrl(c, "qr"), `tapreview-card-${formatCardCode(c.code)}`);
  });
  $("c-qr-svg").addEventListener("click", () => {
    const c = state.editingCard;
    if (c) downloadQrSvg(cardUrl(c, "qr"), `tapreview-card-${formatCardCode(c.code)}`);
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
  for (const id of ["group-editor", "card-editor", "issue-dialog"]) {
    if ($(id).open) $(id).close();
  }
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
  state.groupsLoaded = false;
  state.cardsLoaded = false;

  // Ссылка «Я владелец — активировать карту» со страницы карты: /admin/?card=КОД
  const cardParam = normalizeCardCode(new URLSearchParams(location.search).get("card"));
  if (cardParam) {
    state.pendingCardCode = cardParam;
    history.replaceState(null, "", location.pathname);
  }

  showTab(state.pendingCardCode ? "cards" : "businesses");
  loadBusinesses();
  // Счётчик новых заявок на вкладке; если API заявок ещё не обновлён — просто молчим
  api("/api/admin/orders")
    .then((rows) => {
      state.orders = rows;
      renderOrdersBadge();
    })
    .catch(() => {});
}

// ================= Заявки с сайта =================

const ORDER_STATUS_LABELS = { new: "Новая", in_work: "В работе", done: "Готово", rejected: "Отказ" };

async function loadOrders() {
  $("o-loading").hidden = false;
  hideError("o-error");
  loadOrderRecipients();
  try {
    state.orders = await api("/api/admin/orders");
    renderOrders();
  } catch (error) {
    showError("o-error", error.message);
  } finally {
    $("o-loading").hidden = true;
  }
}

function renderOrdersBadge() {
  const fresh = state.orders.filter((o) => o.status === "new").length;
  $("orders-badge").textContent = String(fresh);
  $("orders-badge").hidden = fresh === 0;
}

function renderOrders() {
  renderOrdersBadge();
  const items = state.orders.filter(
    (o) => state.orderFilter === "all" || o.status === "new" || o.status === "in_work"
  );
  $("o-count").textContent = state.orders.length
    ? `Всего: ${state.orders.length}, новых: ${state.orders.filter((o) => o.status === "new").length}`
    : "Заявки со страницы tapreview.ru/order/ — калькулятор и форма.";
  $("o-list").replaceChildren(...items.map(renderOrder));
  $("o-empty").hidden = items.length !== 0;
  $("o-empty").textContent = state.orders.length ? "Нет заявок с таким статусом." : "Заявок пока нет.";
}

function renderOrder(order) {
  const card = el("article", `o-card o-${order.status}`);
  const rub = (n) => `${Number(n).toLocaleString("ru-RU")} ₽`;

  const head = el("div", "o-head");
  const title = el("div", "o-title", `№${order.id} · ${order.business_name}${order.city ? `, ${order.city}` : ""}`);
  const date = el(
    "span",
    "o-date",
    new Date(order.created_at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
  );
  head.append(title, date);

  const contacts = el("div", "o-contacts");
  contacts.append(el("b", "", order.name));
  if (order.phone) {
    const a = el("a", "", order.phone);
    a.href = `tel:${order.phone}`;
    contacts.append(a);
  }
  if (order.telegram) {
    const a = el("a", "", `@${order.telegram}`);
    a.href = `https://t.me/${order.telegram}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    contacts.append(a);
  }

  const per = order.plan === "year" ? "в год" : "в месяц";
  const sum = el(
    "div",
    "o-sum",
    `Карт: ${order.cards} · заведений: ${order.venues} · тариф «${order.plan === "year" ? "Год" : "Месяц"}» · ` +
      `при заказе ${rub(order.total_now)}, дальше ${rub(order.total_next)} ${per}`
  );

  card.append(head, contacts, sum);
  if (order.comment) card.append(el("p", "o-comment", order.comment));
  if (!order.tg_delivered) card.append(el("div", "o-warn", "Не доставлена в Telegram — подключите уведомления выше"));

  const actions = el("div", "o-actions");
  const select = el("select", "o-status");
  for (const [value, label] of Object.entries(ORDER_STATUS_LABELS)) {
    const option = el("option", "", label);
    option.value = value;
    option.selected = order.status === value;
    select.append(option);
  }
  select.addEventListener("change", () => onOrderStatus(order, select));
  const remove = el("button", "btn btn-danger btn-small", "Удалить");
  remove.type = "button";
  remove.addEventListener("click", () => onOrderDelete(order, remove));
  actions.append(select, remove);
  card.append(actions);
  return card;
}

async function onOrderStatus(order, select) {
  hideError("o-error");
  select.disabled = true;
  try {
    const saved = await api(`/api/admin/orders/${order.id}`, { method: "PATCH", body: { status: select.value } });
    Object.assign(order, saved);
    renderOrders();
  } catch (error) {
    showError("o-error", error.message);
    select.value = order.status;
    select.disabled = false;
  }
}

async function onOrderDelete(order, button) {
  if (!confirm(`Удалить заявку №${order.id}? Данные человека будут удалены без возможности восстановления.`)) return;
  hideError("o-error");
  button.disabled = true;
  try {
    await api(`/api/admin/orders/${order.id}`, { method: "DELETE" });
    state.orders = state.orders.filter((o) => o.id !== order.id);
    renderOrders();
  } catch (error) {
    showError("o-error", error.message);
    button.disabled = false;
  }
}

async function loadOrderRecipients() {
  hideError("o-tg-error");
  try {
    const rows = await api("/api/admin/order-recipients");
    $("o-tg-status").textContent = rows.length
      ? "Новые заявки приходят в эти чаты:"
      : "Telegram не подключён — заявки видны только здесь. Нажмите кнопку ниже, чтобы получать их в Telegram.";
    $("o-tg-list").replaceChildren(
      ...rows.map((row) => {
        const li = document.createElement("li");
        const off = el("button", "btn btn-ghost btn-small", "Отключить");
        off.type = "button";
        off.addEventListener("click", async () => {
          if (!confirm("Перестать присылать заявки в этот чат?")) return;
          off.disabled = true;
          try {
            await api(`/api/admin/order-recipients/${row.chat_id}`, { method: "DELETE" });
            loadOrderRecipients();
          } catch (error) {
            showError("o-tg-error", error.message);
            off.disabled = false;
          }
        });
        li.append(el("span", "tg-sub-name", row.chat_title || String(row.chat_id)), off);
        return li;
      })
    );
  } catch (error) {
    $("o-tg-status").textContent = "";
    showError("o-tg-error", error.message);
  }
}

async function onOrderTgInvite() {
  hideError("o-tg-error");
  $("o-tg-invite").disabled = true;
  try {
    const data = await api("/api/admin/order-recipients/invite", { method: "POST", body: {} });
    $("o-tg-link").value = data.link;
    $("o-tg-open").href = data.link;
    $("o-tg-link-box").hidden = false;
    $("o-tg-hint").hidden = false;
  } catch (error) {
    showError("o-tg-error", error.message);
  } finally {
    $("o-tg-invite").disabled = false;
  }
}

const TABS = ["businesses", "groups", "cards", "orders"];

function showTab(name) {
  for (const tab of TABS) {
    $(`${tab}-section`).hidden = tab !== name;
    $(`tab-${tab}`).classList.toggle("active", tab === name);
  }
  if (name === "groups" && !state.groupsLoaded) loadGroups();
  if (name === "cards" && !state.cardsLoaded) loadCards();
  if (name === "orders") loadOrders();
}

// ================= Список бизнесов =================

async function loadBusinesses() {
  $("loading").hidden = false;
  hideError("list-error");

  try {
    const [businesses, summary] = await Promise.all([
      api("/api/admin/businesses"),
      // если статистика не загрузится, список всё равно покажем
      api("/api/admin/stats-summary?days=30").catch(() => ({ rows: [] }))
    ]);
    state.businesses = businesses;
    state.businessesLoaded = true;
    state.summary = {};
    for (const row of summary.rows) {
      state.summary[row.business_id] = row;
    }
    renderList();
    // Названия заведений в списках групп и карт берутся отсюда
    if (state.groupsLoaded) renderGroups();
    if (state.cardsLoaded) renderCards();
    openPendingCard();
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
      (!query ||
        b.name.toLowerCase().includes(query) ||
        b.slug.toLowerCase().includes(query)) &&
      (state.billingFilter === "all" || billingGroup(b) === state.billingFilter)
  );

  const total = state.businesses.length;
  const active = state.businesses.filter((b) => b.is_active).length;
  $("count").textContent = total ? `Всего: ${total}, активных: ${active}` : "";
  renderBillingSummary();

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
  const billing = billingInfo(business.paid_until);
  if (billing.state !== "none") {
    statusCell.append(el("div", `cell-billing ${billing.tone}`, billing.short));
  }

  // Статистика за 30 дней
  const stats = state.summary[business.id];
  const statsCell = el(
    "td",
    "cell-stats",
    stats ? statsText(stats) : "—"
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

  tr.append(nameCell, categoryCell, statusCell, statsCell, linkCell, actionsCell);
  return tr;
}

// ================= Форма =================

function openEditor(business) {
  state.editing = business;
  hideError("editor-error");

  $("editor-title").textContent = business ? "Редактирование" : "Новый бизнес";
  $("delete-button").hidden = !business;

  $("f-name").value = business ? business.name : "";
  $("f-tagline").value = business ? business.tagline || "" : "";
  $("f-category").value = business ? business.category || "" : "";
  $("f-address").value = business ? business.address || "" : "";
  $("f-google").value = business ? business.google_url || "" : "";
  $("f-yandex").value = business ? business.yandex_url || "" : "";
  $("f-twogis").value = business ? business.twogis_url || "" : "";
  $("f-logo").value = business ? business.logo_url || "" : "";
  $("f-discount-text").value = business ? business.discount_text || "" : "";
  fillBonus(business);
  $("f-active").checked = business ? business.is_active : true;
  $("f-paid-until").value = business ? business.paid_until || "" : "";
  $("f-price").value = business && business.monthly_price != null ? String(business.monthly_price) : "";
  $("f-billing-note").value = business ? business.billing_note || "" : "";
  showBillingStatus();

  const hasColor = Boolean(business && business.brand_color);
  $("f-color-on").checked = hasColor;
  $("f-color").disabled = !hasColor;
  $("f-color").value = hasColor ? business.brand_color.toLowerCase() : "#2563eb";

  showLinkBox(business);
  loadStats(business);
  loadStatsLinks(business);
  loadTelegram(business);

  if (!$("editor").open) $("editor").showModal();
  $("f-name").focus();
}

function showLinkBox(business) {
  $("link-box").hidden = !business;
  if (!business) return;

  const url = publicUrl(business);
  $("link-url").value = sourceUrl(business, "nfc");
  $("link-open").href = url;
  $("temp-domain-warning").hidden = !isTemporaryDomain(url);
  $("qr-preview").src =
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(sourceUrl(business, "qr")))}`;
}

// ================= Статистика =================

async function loadStats(business) {
  $("stats-box").hidden = !business;
  if (!business) return;

  $("stats-loading").hidden = false;
  $("stats-content").hidden = true;
  hideError("stats-error");

  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow";
    const data = await api(
      `/api/admin/businesses/${business.id}/stats?days=30&tz=${encodeURIComponent(tz)}`
    );
    // Пока грузилось, могли открыть другой бизнес
    if (state.editing !== business) return;
    renderStats(data.rows);
  } catch (error) {
    if (state.editing === business) showError("stats-error", error.message);
  } finally {
    if (state.editing === business) $("stats-loading").hidden = true;
  }
}

function renderStats(rows) {
  const totals = { views: 0, nfc: 0, qr: 0, direct: 0, google: 0, yandex: 0, twogis: 0 };
  const byDay = {};

  for (const row of rows) {
    const count = Number(row.events);
    const day = (byDay[row.day] = byDay[row.day] || { views: 0, google: 0, yandex: 0, twogis: 0 });

    if (row.event_type === "page_view") {
      totals.views += count;
      totals[row.source] = (totals[row.source] || 0) + count;
      day.views += count;
    } else if (row.event_type === "click" && row.destination in totals) {
      totals[row.destination] += count;
      day[row.destination] += count;
    }
  }

  $("st-views").textContent = totals.views;
  $("st-sources").textContent = `NFC ${totals.nfc} · QR ${totals.qr} · прямые ${totals.direct}`;
  $("st-google").textContent = totals.google;
  $("st-yandex").textContent = totals.yandex;
  $("st-twogis").textContent = totals.twogis;

  const days = Object.keys(byDay).sort().reverse();
  $("stats-rows").replaceChildren(
    ...days.map((day) => {
      const d = byDay[day];
      const tr = document.createElement("tr");
      tr.append(
        el("td", "", formatDay(day)),
        el("td", "", String(d.views)),
        el("td", "", String(d.google)),
        el("td", "", String(d.yandex)),
        el("td", "", String(d.twogis))
      );
      return tr;
    })
  );
  $("stats-table").hidden = days.length === 0;
  $("stats-empty").hidden = days.length !== 0;
  $("stats-content").hidden = false;
}

function formatDay(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    weekday: "short"
  });
}

// ================= Статистика владельцу по ссылке (/s/...) =================

async function loadStatsLinks(business) {
  $("sl-box").hidden = !business;
  if (!business) return;
  hideError("sl-error");
  $("sl-list").replaceChildren();
  try {
    const rows = await api(`/api/admin/businesses/${business.id}/stats-links`);
    if (state.editing === business) renderStatsLinks(business, rows);
  } catch (error) {
    if (state.editing === business) showError("sl-error", error.message);
  }
}

function renderStatsLinks(business, rows) {
  const shortDate = (iso) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  $("sl-list").replaceChildren(
    ...rows.map((link) => {
      const li = document.createElement("li");

      const row = el("div", "link-row");
      const input = el("input");
      input.type = "text";
      input.readOnly = true;
      input.value = link.url;
      const copy = el("button", "btn btn-secondary", "Копировать");
      copy.type = "button";
      copy.addEventListener("click", () => copyText(link.url));
      const open = el("a", "btn btn-secondary", "Открыть");
      open.href = link.url;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      row.append(input, copy, open);

      const meta = el(
        "span",
        "sl-meta",
        `Создана ${shortDate(link.created_at)} · ` +
          (link.last_opened_at ? `последний раз открывали ${shortDate(link.last_opened_at)}` : "ещё не открывали")
      );
      const remove = el("button", "btn btn-danger btn-small", "Отключить");
      remove.type = "button";
      remove.addEventListener("click", () => onDeleteStatsLink(business, link, remove));

      li.append(row, statsLinkCards(business, link), statsLinkVenues(business, link), meta, remove);
      return li;
    })
  );
}

// Карты, которые владелец видит по ссылке, и добавление карты по номеру с обратной стороны
function statsLinkCards(business, link) {
  const box = el("div", "sl-venues");
  const cards = link.cards || [];
  box.append(el("span", "sl-venues-title", cards.length ? `Карты в ссылке (${cards.length}):` : "Карт в ссылке пока нет."));

  const chips = el("div", "sl-chips");
  for (const card of cards) {
    const pretty = card.code.length === 6 ? `${card.code.slice(0, 3)}-${card.code.slice(3)}` : card.code;
    const text = pretty + (card.label ? ` · ${card.label}` : "") + (card.is_active ? "" : " (отключена)");
    chips.append(el("span", "sl-chip", text));
  }
  box.append(chips);

  const form = el("form", "sl-card-form");
  const input = el("input");
  input.type = "text";
  input.placeholder = "Номер карты, напр. W6A-P37";
  input.maxLength = 16;
  input.autocomplete = "off";
  const add = el("button", "btn btn-secondary btn-small", "Добавить карту");
  add.type = "submit";
  form.append(input, add);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!input.value.trim()) return;
    hideError("sl-error");
    add.disabled = true;
    try {
      await api(`/api/admin/stats-links/${link.token}`, { method: "PATCH", body: { add_card: input.value } });
      await loadStatsLinks(business);
    } catch (error) {
      showError("sl-error", error.message);
      add.disabled = false;
    }
  });
  box.append(form);
  return box;
}

// Какие заведения видит владелец по ссылке: можно добавить другие точки того же владельца
function statsLinkVenues(business, link) {
  const box = el("div", "sl-venues");
  const ids = link.business_ids;
  box.append(el("span", "sl-venues-title", ids.length > 1 ? `Заведения в ссылке (${ids.length}):` : "Заведения в ссылке:"));

  const chips = el("div", "sl-chips");
  for (const id of ids) {
    const found = businessById(id);
    const chip = el("span", "sl-chip", found ? found.name : `Удалённое заведение #${id}`);
    if (ids.length > 1) {
      const x = el("button", "sl-chip-x", "✕");
      x.type = "button";
      x.title = "Убрать из ссылки";
      x.addEventListener("click", () =>
        onChangeStatsLink(business, link, ids.filter((other) => other !== id), x)
      );
      chip.append(x);
    }
    chips.append(chip);
  }
  box.append(chips);

  const available = [...state.businesses]
    .filter((b) => !ids.includes(b.id))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  if (available.length) {
    const select = el("select", "sl-add");
    const first = el("option", "", "+ Добавить заведение…");
    first.value = "";
    select.append(first, ...available.map((b) => {
      const option = el("option", "", b.name + (b.address ? ` — ${b.address}` : ""));
      option.value = String(b.id);
      return option;
    }));
    select.addEventListener("change", () => {
      if (select.value) onChangeStatsLink(business, link, [...ids, Number(select.value)], select);
    });
    box.append(select);
  }
  return box;
}

async function onChangeStatsLink(business, link, ids, control) {
  hideError("sl-error");
  control.disabled = true;
  try {
    await api(`/api/admin/stats-links/${link.token}`, { method: "PATCH", body: { business_ids: ids } });
    await loadStatsLinks(business);
  } catch (error) {
    showError("sl-error", error.message);
    control.disabled = false;
  }
}

async function onCreateStatsLink() {
  const business = state.editing;
  if (!business) return;
  hideError("sl-error");
  $("sl-create").disabled = true;
  try {
    await api(`/api/admin/businesses/${business.id}/stats-links`, { method: "POST", body: {} });
    await loadStatsLinks(business);
  } catch (error) {
    showError("sl-error", error.message);
  } finally {
    $("sl-create").disabled = false;
  }
}

async function onDeleteStatsLink(business, link, button) {
  if (!confirm("Отключить эту ссылку? Владелец больше не сможет открыть по ней статистику.")) return;
  hideError("sl-error");
  button.disabled = true;
  try {
    await api(`/api/admin/stats-links/${link.token}`, { method: "DELETE" });
    await loadStatsLinks(business);
  } catch (error) {
    showError("sl-error", error.message);
    button.disabled = false;
  }
}

// ================= Telegram-бот для владельца =================

async function loadTelegram(business) {
  $("tg-box").hidden = !business;
  if (!business) return;

  hideError("tg-error");
  $("tg-setup").hidden = true;
  $("tg-area").hidden = true;
  $("tg-link-box").hidden = true;
  $("tg-status").textContent = "Загрузка…";

  try {
    if (!state.tg) state.tg = await api("/api/admin/telegram/status");
    if (state.editing !== business) return;
    renderTelegramStatus();
    if (state.tg.configured && state.tg.webhook_ok) await loadTelegramSubscribers(business);
  } catch (error) {
    if (state.editing !== business) return;
    $("tg-status").textContent = "";
    showError("tg-error", error.message);
  }
}

function renderTelegramStatus() {
  const s = state.tg;
  $("tg-setup").hidden = true;
  $("tg-area").hidden = true;

  if (!s.configured) {
    $("tg-status").textContent =
      "Бот ещё не подключён: добавьте в Cloudflare секреты TG_BOT_TOKEN и TG_WEBHOOK_SECRET, затем обновите страницу.";
    return;
  }
  if (!s.webhook_ok) {
    $("tg-status").textContent = s.has_secret
      ? `Бот @${s.username} найден. Нажмите «Включить бота», чтобы он начал отвечать.`
      : `Бот @${s.username} найден, но нет секрета TG_WEBHOOK_SECRET — добавьте его в Cloudflare.`;
    $("tg-setup").hidden = !s.has_secret;
    return;
  }
  $("tg-status").textContent =
    `Бот: @${s.username}` + (s.last_error ? ` · последняя ошибка Telegram: ${s.last_error}` : "");
  $("tg-area").hidden = false;
}

async function onTelegramSetup() {
  const business = state.editing;
  hideError("tg-error");
  $("tg-setup").disabled = true;
  try {
    state.tg = await api("/api/admin/telegram/setup", { method: "POST", body: {} });
    if (state.editing !== business) return;
    renderTelegramStatus();
    if (state.tg.webhook_ok) await loadTelegramSubscribers(business);
  } catch (error) {
    showError("tg-error", error.message);
  } finally {
    $("tg-setup").disabled = false;
  }
}

async function onTelegramInvite() {
  const business = state.editing;
  if (!business) return;
  hideError("tg-error");
  $("tg-invite").disabled = true;
  try {
    const data = await api(`/api/admin/businesses/${business.id}/telegram-invite`, { method: "POST", body: {} });
    if (state.editing !== business) return;
    $("tg-link").value = data.link;
    $("tg-qr").src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(data.link))}`;
    $("tg-link-box").hidden = false;
  } catch (error) {
    showError("tg-error", error.message);
  } finally {
    $("tg-invite").disabled = false;
  }
}

async function loadTelegramSubscribers(business) {
  const rows = await api(`/api/admin/businesses/${business.id}/telegram`);
  if (state.editing !== business) return;

  $("tg-subs").replaceChildren(
    ...rows.map((sub) => {
      const li = document.createElement("li");
      const since = new Date(sub.created_at).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
      const name = el(
        "span",
        "tg-sub-name",
        `${sub.chat_title || sub.chat_id} · с ${since}` + (sub.weekly_report ? "" : " · без отчёта по понедельникам")
      );
      const remove = el("button", "btn btn-danger btn-small", "Отключить");
      remove.type = "button";
      remove.addEventListener("click", () => onTelegramUnsubscribe(business, sub, remove));
      li.append(name, remove);
      return li;
    })
  );
  $("tg-subs-empty").hidden = rows.length !== 0;
}

async function onTelegramUnsubscribe(business, sub, button) {
  if (!confirm(`Отключить «${sub.chat_title || sub.chat_id}»? Статистика перестанет приходить в этот чат.`)) return;
  hideError("tg-error");
  button.disabled = true;
  try {
    await api(`/api/admin/telegram/subscribers/${sub.id}`, { method: "DELETE" });
    await loadTelegramSubscribers(business);
  } catch (error) {
    showError("tg-error", error.message);
    button.disabled = false;
  }
}

function isTemporaryDomain(url) {
  const host = new URL(url).hostname;
  return host.endsWith(".workers.dev") || host.endsWith(".pages.dev") || host.endsWith(".github.io");
}

function closeEditor() {
  $("editor").close();
  state.editing = null;
}

function readForm() {
  return {
    name: $("f-name").value,
    tagline: $("f-tagline").value,
    category: $("f-category").value || null,
    address: $("f-address").value,
    google_url: $("f-google").value,
    yandex_url: $("f-yandex").value,
    twogis_url: $("f-twogis").value,
    logo_url: $("f-logo").value,
    discount_code: state.editing ? state.editing.discount_code || "" : "",
    discount_text: $("f-discount-text").value,
    bonus_mode: $("f-bonus-mode").value,
    bonus_prizes: readPrizes(),
    bonus_from_days: $("f-bonus-from").value,
    bonus_valid_days: $("f-bonus-valid").value,
    bonus_cooldown_days: $("f-bonus-cooldown").value,
    bonus_conditions: $("f-bonus-conditions").value,
    brand_color: $("f-color-on").checked ? $("f-color").value : null,
    is_active: $("f-active").checked,
    paid_until: $("f-paid-until").value,
    monthly_price: $("f-price").value,
    billing_note: $("f-billing-note").value
  };
}

// ================= Подарок для гостей =================

const DEFAULT_PRIZES = [
  { label: "Скидка 5%", weight: 50 },
  { label: "Скидка 10%", weight: 30 },
  { label: "Кофе в подарок", weight: 15 },
  { label: "Десерт в подарок", weight: 5 }
];

function fillBonus(business) {
  $("f-bonus-mode").value = business ? business.bonus_mode || "off" : "off";
  const prizes = business && Array.isArray(business.bonus_prizes) && business.bonus_prizes.length
    ? business.bonus_prizes
    : DEFAULT_PRIZES;
  $("f-prizes").replaceChildren(...prizes.map(prizeRow));
  $("f-bonus-from").value = business ? business.bonus_from_days ?? 1 : 1;
  $("f-bonus-valid").value = business ? business.bonus_valid_days ?? 14 : 14;
  $("f-bonus-cooldown").value = business ? business.bonus_cooldown_days ?? 30 : 30;
  $("f-bonus-conditions").value = business ? business.bonus_conditions || "" : "";
  $("f-bonus-stats").textContent = "";
  showBonusMode();
  updatePrizeShares();
  if (business && business.bonus_mode && business.bonus_mode !== "off") loadBonusStats(business);
  loadStaffLinks(business);
}

// ---------- Ссылки для персонала (/k/...) ----------

async function loadStaffLinks(business) {
  $("staff-box").hidden = !business;
  if (!business) return;
  hideError("staff-error");
  $("staff-list").replaceChildren();
  try {
    const rows = await api(`/api/admin/businesses/${business.id}/staff-links`);
    if (state.editing === business) renderStaffLinks(business, rows);
  } catch (error) {
    if (state.editing === business) showError("staff-error", error.message);
  }
}

function renderStaffLinks(business, rows) {
  const shortDate = (iso) =>
    new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  $("staff-list").replaceChildren(
    ...rows.map((link) => {
      const li = document.createElement("li");
      const row = el("div", "link-row");
      const input = el("input");
      input.type = "text";
      input.readOnly = true;
      input.value = link.url;
      const copy = el("button", "btn btn-secondary", "Копировать");
      copy.type = "button";
      copy.addEventListener("click", () => copyText(link.url));
      const open = el("a", "btn btn-secondary", "Открыть");
      open.href = link.url;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      row.append(input, copy, open);

      const meta = el(
        "span",
        "sl-meta",
        `${link.label ? `${link.label} · ` : ""}создана ${shortDate(link.created_at)} · ` +
          (link.last_used_at ? `последнее погашение ${shortDate(link.last_used_at)}` : "ещё не гасили коды")
      );
      const remove = el("button", "btn btn-danger btn-small", "Отключить");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        if (!confirm("Отключить эту ссылку? По ней больше нельзя будет гасить коды.")) return;
        remove.disabled = true;
        try {
          await api(`/api/admin/staff-links/${link.token}`, { method: "DELETE" });
          loadStaffLinks(business);
        } catch (error) {
          showError("staff-error", error.message);
          remove.disabled = false;
        }
      });
      li.append(row, meta, remove);
      return li;
    })
  );
}

async function onCreateStaffLink() {
  const business = state.editing;
  if (!business) return;
  hideError("staff-error");
  $("staff-create").disabled = true;
  try {
    await api(`/api/admin/businesses/${business.id}/staff-links`, {
      method: "POST",
      body: { label: $("staff-label").value }
    });
    $("staff-label").value = "";
    await loadStaffLinks(business);
  } catch (error) {
    showError("staff-error", error.message);
  } finally {
    $("staff-create").disabled = false;
  }
}

function showBonusMode() {
  const mode = $("f-bonus-mode").value;
  $("f-bonus-settings").hidden = mode === "off";
  $("f-fixed-box").hidden = mode !== "fixed";
  $("f-wheel-box").hidden = mode !== "wheel";
}

function prizeRow(prize) {
  const row = el("div", "prize-row");
  const label = el("input");
  label.type = "text";
  label.maxLength = 30;
  label.placeholder = "Название приза";
  label.value = prize.label || "";
  label.className = "prize-label";
  const weight = el("input");
  weight.type = "number";
  weight.min = "1";
  weight.max = "1000";
  weight.step = "1";
  weight.value = String(prize.weight || 10);
  weight.className = "prize-weight";
  weight.title = "Вес: чем больше, тем чаще выпадает";
  weight.addEventListener("input", updatePrizeShares);
  const share = el("span", "prize-share", "");
  const remove = el("button", "sl-chip-x", "✕");
  remove.type = "button";
  remove.title = "Убрать приз";
  remove.addEventListener("click", () => {
    row.remove();
    updatePrizeShares();
  });
  row.append(label, weight, share, remove);
  return row;
}

function readPrizes() {
  if ($("f-bonus-mode").value !== "wheel") return [];
  return [...$("f-prizes").children]
    .map((row) => ({
      label: row.querySelector(".prize-label").value.trim(),
      weight: Number(row.querySelector(".prize-weight").value)
    }))
    .filter((p) => p.label);
}

// Рядом с весом показываем шанс в процентах — так понятнее
function updatePrizeShares() {
  const rows = [...$("f-prizes").children];
  const total = rows.reduce((sum, row) => sum + (Number(row.querySelector(".prize-weight").value) || 0), 0);
  for (const row of rows) {
    const w = Number(row.querySelector(".prize-weight").value) || 0;
    row.querySelector(".prize-share").textContent = total ? `${Math.round((w / total) * 100)}%` : "";
  }
  $("f-prize-add").hidden = rows.length >= 8;
}

async function loadBonusStats(business) {
  try {
    const s = await api(`/api/admin/businesses/${business.id}/bonus-stats`);
    if (state.editing !== business) return;
    $("f-bonus-stats").textContent = `За 30 дней: выдано ${s.issued}, погашено ${s.redeemed}`;
    $("f-bonus-stats").className = "billing-status ok";
  } catch {
    // счётчики — не главное, форму не ломаем
  }
}

// ================= Подписка =================
// Те же правила, что в src/billing.js: дни по Москве, 3 дня отсрочки, напоминание за 5 дней

const GRACE_DAYS = 3;
const REMIND_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function mskToday() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dayNum(iso) {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}

function isoFromDayNum(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function prettyDay(iso, withYear = false) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC"
  });
}

// { state: none|ok|ending|grace|expired, tone, short, long }
function billingInfo(paidUntil) {
  if (!paidUntil) return { state: "none", tone: "", short: "", long: "Подписка не ведётся — всё работает всегда." };
  const left = dayNum(paidUntil) - dayNum(mskToday());
  const date = prettyDay(paidUntil, true);
  if (left >= REMIND_DAYS) {
    return { state: "ok", tone: "ok", short: `до ${prettyDay(paidUntil)}`, long: `Оплачено до ${date} (ещё ${left} дн.)` };
  }
  if (left >= 0) {
    const when = left === 0 ? "сегодня последний день" : `осталось ${left} дн.`;
    return { state: "ending", tone: "soon", short: `до ${prettyDay(paidUntil)} · ${when}`, long: `Оплачено до ${date} — ${when}. Владелец видит напоминание.` };
  }
  if (-left <= GRACE_DAYS) {
    const off = prettyDay(isoFromDayNum(dayNum(paidUntil) + GRACE_DAYS + 1));
    return { state: "grace", tone: "bad", short: `просрочено · отключится ${off}`, long: `Срок прошёл ${date}. Отсрочка: карта отключится ${off}.` };
  }
  return { state: "expired", tone: "bad", short: `отключено с ${prettyDay(isoFromDayNum(dayNum(paidUntil) + GRACE_DAYS + 1))}`, long: `Не оплачено с ${date}: карта ведёт сразу на площадку, статистика владельца на паузе.` };
}

// Группа для фильтра списка: soon (скоро продление или отсрочка), expired, none, ok
function billingGroup(business) {
  const s = billingInfo(business.paid_until).state;
  return s === "ending" || s === "grace" ? "soon" : s;
}

function renderBillingSummary() {
  const box = $("billing-summary");
  const tracked = state.businesses.filter((b) => b.paid_until);
  if (!tracked.length) {
    box.hidden = true;
    return;
  }
  let paying = 0;
  let income = 0;
  let soon = 0;
  let expired = 0;
  for (const b of tracked) {
    const s = billingInfo(b.paid_until).state;
    if (s === "expired") {
      expired++;
      continue;
    }
    paying++;
    income += b.monthly_price || 0;
    if (s === "ending" || s === "grace") soon++;
  }
  box.replaceChildren(
    "Платят: ", el("b", "", String(paying)),
    " · В месяц: ", el("b", "", `${income.toLocaleString("ru-RU")} ₽`),
    " · Скоро продление: ", el("b", soon ? "warn" : "", String(soon)),
    " · Отключены за неуплату: ", el("b", expired ? "bad" : "", String(expired))
  );
  box.hidden = false;
}

function showBillingStatus() {
  const info = billingInfo($("f-paid-until").value);
  const node = $("f-billing-status");
  node.textContent = info.long;
  node.className = `billing-status ${info.tone}`;
}

// +N месяцев: если подписка ещё идёт (или в отсрочке) — от конца срока, иначе — с сегодняшнего дня
function extendPaidUntil(months) {
  const current = $("f-paid-until").value;
  const today = mskToday();
  const fromEnd = current && dayNum(current) >= dayNum(today) - GRACE_DAYS;
  const base = fromEnd ? current : isoFromDayNum(dayNum(today) - 1);
  $("f-paid-until").value = addMonths(base, months);
  showBillingStatus();
}

function addMonths(iso, months) {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
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

// ================= Группы заведений =================
// Группа = одна ссылка /g/... (QR / NFC), на странице — список заведений.
// Сами заведения — обычные бизнесы из первой вкладки, они не меняются.

async function loadGroups() {
  $("g-loading").hidden = false;
  hideError("g-list-error");

  try {
    state.groups = await api("/api/admin/groups");
    state.groupsLoaded = true;
    renderGroups();
  } catch (error) {
    if (!$("app-view").hidden) {
      showError("g-list-error", error.message);
    }
  } finally {
    $("g-loading").hidden = true;
  }
}

function businessById(id) {
  return state.businesses.find((b) => b.id === id);
}

function renderGroups() {
  $("g-rows").replaceChildren(...state.groups.map(renderGroupRow));
  $("g-table").hidden = state.groups.length === 0;
  $("g-empty").hidden = state.groups.length !== 0;
}

function renderGroupRow(group) {
  const tr = document.createElement("tr");

  const nameCell = document.createElement("td");
  nameCell.append(el("div", "cell-name", group.name));
  if (group.tagline) nameCell.append(el("div", "cell-sub", group.tagline));

  const names = (group.business_ids || [])
    .map(businessById)
    .filter(Boolean)
    .map((b) => b.name);
  const venuesCell = el("td", "cell-sub", names.length ? names.join(", ") : "—");

  const statusCell = document.createElement("td");
  statusCell.append(
    group.is_active
      ? el("span", "badge badge-on", "Активна")
      : el("span", "badge badge-off", "Выключена")
  );

  const linkCell = document.createElement("td");
  const linkWrap = el("div", "slug-cell");
  const copyButton = el("button", "btn btn-secondary btn-small", "Копировать");
  copyButton.type = "button";
  copyButton.addEventListener("click", () => copyText(groupUrl(group)));
  linkWrap.append(el("span", "slug", `/g/${group.slug}`), copyButton);
  linkCell.append(linkWrap);

  const actionsCell = el("td", "cell-actions");
  const openLink = el("a", "btn btn-ghost btn-small", "Открыть ↗");
  openLink.href = groupUrl(group);
  openLink.target = "_blank";
  openLink.rel = "noopener";
  const editButton = el("button", "btn btn-secondary btn-small", "Изменить");
  editButton.type = "button";
  editButton.addEventListener("click", () => openGroupEditor(group));
  actionsCell.append(openLink, editButton);

  tr.append(nameCell, venuesCell, statusCell, linkCell, actionsCell);
  return tr;
}

function openGroupEditor(group) {
  // Без списка бизнесов нельзя показать состав группы (и при сохранении он бы потерялся)
  if (!state.businesses.length && (!group || group.business_ids.length)) {
    toast("Список заведений ещё загружается — попробуйте через секунду");
    return;
  }
  state.editingGroup = group;
  hideError("g-editor-error");

  $("g-editor-title").textContent = group ? "Редактирование группы" : "Новая группа";
  $("g-delete-button").hidden = !group;

  $("g-name").value = group ? group.name : "";
  $("g-tagline").value = group ? group.tagline || "" : "";
  $("g-logo").value = group ? group.logo_url || "" : "";
  $("g-active").checked = group ? group.is_active : true;

  // Удалённые бизнесы из группы просто пропускаем
  state.groupItems = group ? (group.business_ids || []).filter((id) => businessById(id)) : [];
  renderGroupItems();

  $("g-link-box").hidden = !group;
  if (group) {
    $("g-link-url").value = groupSourceUrl(group, "nfc");
    $("g-link-open").href = groupUrl(group);
    $("g-qr-preview").src =
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(groupSourceUrl(group, "qr")))}`;
  }

  if (!$("group-editor").open) $("group-editor").showModal();
  $("g-name").focus();
}

function closeGroupEditor() {
  $("group-editor").close();
  state.editingGroup = null;
}

function renderGroupItems() {
  const items = state.groupItems.map((id, index) => {
    const business = businessById(id);
    const li = el("li", "group-item");

    const text = el("div", "group-item-text");
    text.append(el("div", "cell-name", business.name));
    if (!business.is_active) {
      text.append(el("div", "cell-sub", "Выключен — на странице группы не показывается"));
    }

    const buttons = el("div", "group-item-buttons");
    buttons.append(
      smallButton("↑", "Выше", index === 0, () => moveGroupItem(index, -1)),
      smallButton("↓", "Ниже", index === state.groupItems.length - 1, () => moveGroupItem(index, 1)),
      smallButton("✕", "Убрать из группы", false, () => {
        state.groupItems.splice(index, 1);
        renderGroupItems();
      })
    );

    li.append(text, buttons);
    return li;
  });
  $("g-items").replaceChildren(...items);
  $("g-items-empty").hidden = items.length !== 0;

  // В списке «Добавить» — только те, кого ещё нет в группе
  const select = $("g-add-select");
  const available = state.businesses
    .filter((b) => !state.groupItems.includes(b.id))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const placeholder = el(
    "option",
    "",
    available.length ? "— выберите заведение —" : "Все заведения уже в группе"
  );
  placeholder.value = "";
  select.replaceChildren(
    placeholder,
    ...available.map((b) => {
      const option = el("option", "", b.is_active ? b.name : `${b.name} (выключен)`);
      option.value = String(b.id);
      return option;
    })
  );
  select.disabled = available.length === 0;
  $("g-add-button").disabled = available.length === 0;
}

function smallButton(label, title, disabled, onClick) {
  const button = el("button", "btn btn-ghost btn-small", label);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function addGroupItem() {
  const id = Number($("g-add-select").value);
  if (!id) return;
  state.groupItems.push(id);
  renderGroupItems();
}

function moveGroupItem(index, step) {
  const items = state.groupItems;
  [items[index], items[index + step]] = [items[index + step], items[index]];
  renderGroupItems();
}

async function onSaveGroup(event) {
  event.preventDefault();
  hideError("g-editor-error");

  const button = $("g-save-button");
  button.disabled = true;
  button.textContent = "Сохраняем…";

  const body = {
    name: $("g-name").value,
    tagline: $("g-tagline").value,
    logo_url: $("g-logo").value,
    business_ids: state.groupItems,
    is_active: $("g-active").checked
  };

  try {
    const isNew = !state.editingGroup;
    const saved = isNew
      ? await api("/api/admin/groups", { method: "POST", body })
      : await api(`/api/admin/groups/${state.editingGroup.id}`, { method: "PATCH", body });

    const index = state.groups.findIndex((g) => g.id === saved.id);
    if (index === -1) state.groups.unshift(saved);
    else state.groups[index] = saved;
    renderGroups();

    if (isNew) {
      openGroupEditor(saved);
      toast("Группа создана. Ссылка готова.");
    } else {
      closeGroupEditor();
      toast("Сохранено");
    }
  } catch (error) {
    showError("g-editor-error", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Сохранить";
  }
}

async function onDeleteGroup() {
  const group = state.editingGroup;
  if (!group) return;

  const ok = confirm(
    `Удалить группу «${group.name}»?\n\n` +
      "Страница группы и её QR перестанут работать.\n" +
      "Сами заведения и их страницы останутся."
  );
  if (!ok) return;

  try {
    await api(`/api/admin/groups/${group.id}`, { method: "DELETE" });
    state.groups = state.groups.filter((g) => g.id !== group.id);
    renderGroups();
    closeGroupEditor();
    toast("Группа удалена");
  } catch (error) {
    showError("g-editor-error", error.message);
  }
}

// ================= Шаблонные карты =================
// У каждой напечатанной карты свой код и QR: /c/КОД. Карта привязывается к бизнесу
// здесь, и её можно в любой момент перепривязать — без перепечатки.

async function loadCards() {
  $("c-loading").hidden = false;
  hideError("c-list-error");

  try {
    const [cards, stats] = await Promise.all([
      api("/api/admin/cards"),
      api("/api/admin/card-stats?days=30").catch(() => ({ rows: [] }))
    ]);
    state.cards = cards;
    state.cardStats = {};
    for (const row of stats.rows) {
      state.cardStats[row.card_id] = row;
    }
    state.cardsLoaded = true;
    renderCards();
    openPendingCard();
  } catch (error) {
    if (!$("app-view").hidden) {
      showError("c-list-error", error.message);
    }
  } finally {
    $("c-loading").hidden = true;
  }
}

// Открыть карту из ссылки ?card=КОД — когда загружены и карты, и бизнесы
function openPendingCard() {
  const code = state.pendingCardCode;
  if (!code || !state.cardsLoaded || !state.businessesLoaded) return;
  state.pendingCardCode = null;

  const card = state.cards.find((c) => c.code === code);
  if (card) {
    openCardEditor(card);
  } else {
    toast(`Карта ${formatCardCode(code)} не найдена`);
  }
}

function cardStatus(card) {
  if (!card.is_active) return "off";
  return card.business_id ? "assigned" : "free";
}

function filteredCards() {
  const query = $("c-search").value.trim().toLowerCase();
  const codeQuery = normalizeCardCode(query, true);

  return state.cards.filter((card) => {
    if (state.cardFilter !== "all" && cardStatus(card) !== state.cardFilter) return false;
    if (!query) return true;
    const business = businessById(card.business_id);
    return (
      (codeQuery && card.code.includes(codeQuery)) ||
      (business && business.name.toLowerCase().includes(query)) ||
      (card.label && card.label.toLowerCase().includes(query))
    );
  });
}

function renderCards() {
  const items = filteredCards();

  const total = state.cards.length;
  const free = state.cards.filter((c) => cardStatus(c) === "free").length;
  const assigned = state.cards.filter((c) => cardStatus(c) === "assigned").length;
  $("c-count").textContent = total
    ? `Всего: ${total} · привязано: ${assigned} · свободно: ${free}`
    : "Шаблонные карты с уникальным QR. Привяжите карту к заведению — и она заработает.";

  $("c-rows").replaceChildren(...items.map(renderCardRow));
  $("c-table").hidden = items.length === 0;
  $("c-empty").hidden = total !== 0;
  $("c-nothing").hidden = total === 0 || items.length !== 0;
}

function renderCardRow(card) {
  const tr = document.createElement("tr");
  tr.className = "clickable";
  tr.addEventListener("click", (event) => {
    if (!event.target.closest("button, a")) openCardEditor(card);
  });

  const codeCell = document.createElement("td");
  codeCell.append(el("span", "slug card-code", formatCardCode(card.code)));

  const business = businessById(card.business_id);
  const businessCell = document.createElement("td");
  if (business) {
    businessCell.append(el("div", "cell-name", business.name));
    if (!business.is_active) businessCell.append(el("div", "cell-sub", "Заведение выключено"));
  } else {
    businessCell.append(el("span", "muted", "—"));
  }

  const labelCell = el("td", "cell-sub", card.label || "—");

  const status = cardStatus(card);
  const statusCell = document.createElement("td");
  statusCell.append(
    status === "assigned"
      ? el("span", "badge badge-on", "Работает")
      : status === "free"
        ? el("span", "badge badge-free", "Свободна")
        : el("span", "badge badge-off", "Отключена")
  );

  const stats = state.cardStats[card.id];
  const statsCell = el(
    "td",
    "cell-stats",
    stats ? statsText(stats) : "—"
  );

  const actionsCell = el("td", "cell-actions");
  const editButton = el(
    "button",
    status === "free" ? "btn btn-primary btn-small" : "btn btn-secondary btn-small",
    status === "free" ? "Привязать" : "Изменить"
  );
  editButton.type = "button";
  editButton.addEventListener("click", () => openCardEditor(card));
  actionsCell.append(editButton);

  tr.append(codeCell, businessCell, labelCell, statusCell, statsCell, actionsCell);
  return tr;
}

// Enter в поиске: если введён точный номер карты — сразу открываем её
function onCardSearchEnter(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const code = normalizeCardCode($("c-search").value);
  const card = code && state.cards.find((c) => c.code === code);
  if (card) {
    openCardEditor(card);
  } else if (filteredCards().length === 1) {
    openCardEditor(filteredCards()[0]);
  }
}

function openCardEditor(card) {
  state.editingCard = card;
  hideError("c-editor-error");

  $("c-editor-title").textContent = `Карта ${formatCardCode(card.code)}`;
  $("c-link-url").value = cardUrl(card, "nfc");
  $("c-link-open").href = cardUrl(card);
  $("c-qr-preview").src =
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(cardUrl(card, "qr")))}`;

  // Список заведений: сначала «не привязана», затем все по алфавиту
  const select = $("c-business");
  const none = el("option", "", "— не привязана —");
  none.value = "";
  const options = [...state.businesses]
    .sort((a, b) => a.name.localeCompare(b.name, "ru"))
    .map((b) => {
      const option = el("option", "", b.is_active ? b.name : `${b.name} (выключен)`);
      option.value = String(b.id);
      return option;
    });
  select.replaceChildren(none, ...options);
  select.value = card.business_id ? String(card.business_id) : "";

  $("c-label").value = card.label || "";
  $("c-active").checked = card.is_active;

  const stats = state.cardStats[card.id];
  const assigned = card.assigned_at
    ? `Привязана ${new Date(card.assigned_at).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}. `
    : "";
  $("c-stats").textContent =
    assigned +
    (stats
      ? `За 30 дней с этой карты: ${stats.page_views} ${plural(stats.page_views, "открытие", "открытия", "открытий")}, ` +
        `${stats.clicks} ${plural(stats.clicks, "переход", "перехода", "переходов")} к отзывам.`
      : "За 30 дней с этой карты переходов не было.");

  if (!$("card-editor").open) $("card-editor").showModal();
  select.focus();
}

function closeCardEditor() {
  $("card-editor").close();
  state.editingCard = null;
}

async function onSaveCard(event) {
  event.preventDefault();
  hideError("c-editor-error");
  const card = state.editingCard;
  if (!card) return;

  const button = $("c-save-button");
  button.disabled = true;
  button.textContent = "Сохраняем…";

  try {
    const saved = await api(`/api/admin/cards/${card.id}`, {
      method: "PATCH",
      body: {
        business_id: $("c-business").value || null,
        label: $("c-label").value,
        is_active: $("c-active").checked
      }
    });

    const index = state.cards.findIndex((c) => c.id === saved.id);
    if (index !== -1) state.cards[index] = saved;
    renderCards();
    closeCardEditor();

    const business = businessById(saved.business_id);
    toast(
      business && saved.is_active
        ? `Карта ${formatCardCode(saved.code)} → ${business.name}`
        : "Сохранено"
    );
  } catch (error) {
    showError("c-editor-error", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Сохранить";
  }
}

async function onDeleteCard() {
  const card = state.editingCard;
  if (!card) return;

  const ok = confirm(
    `Удалить карту ${formatCardCode(card.code)} навсегда?\n\n` +
      "Если карта напечатана, её QR перестанет работать.\n" +
      "Чтобы временно выключить карту — лучше снимите галочку «Карта работает»."
  );
  if (!ok) return;

  try {
    await api(`/api/admin/cards/${card.id}`, { method: "DELETE" });
    state.cards = state.cards.filter((c) => c.id !== card.id);
    renderCards();
    closeCardEditor();
    toast("Карта удалена");
  } catch (error) {
    showError("c-editor-error", error.message);
  }
}

function openIssueDialog() {
  hideError("issue-error");
  $("issue-count").value = "10";
  $("issue-dialog").showModal();
  $("issue-count").select();
}

async function onIssueCards(event) {
  event.preventDefault();
  hideError("issue-error");

  const button = $("issue-save");
  button.disabled = true;
  button.textContent = "Выпускаем…";

  try {
    const created = await api("/api/admin/cards", {
      method: "POST",
      body: { count: Number($("issue-count").value) }
    });
    state.cards.push(...created);
    renderCards();
    $("issue-dialog").close();
    toast(`Выпущено карт: ${created.length}`);
  } catch (error) {
    showError("issue-error", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Выпустить";
  }
}

// CSV для типографии (и для себя): номер, ссылка для QR, ссылка для NFC, привязка.
// Выгружаются карты, которые сейчас видны в списке (с учётом фильтра и поиска).
function downloadCardsCsv() {
  const cards = filteredCards();
  if (!cards.length) {
    toast("Список пуст");
    return;
  }

  const rows = [["Номер", "Ссылка для QR", "Ссылка для NFC", "Заведение", "Место", "Статус"]];
  for (const card of cards) {
    const business = businessById(card.business_id);
    const status = { assigned: "Работает", free: "Свободна", off: "Отключена" }[cardStatus(card)];
    rows.push([
      formatCardCode(card.code),
      cardUrl(card, "qr"),
      cardUrl(card, "nfc"),
      business ? business.name : "",
      card.label || "",
      status
    ]);
  }

  // Точка с запятой и BOM — чтобы Excel сразу открыл файл с русскими буквами по колонкам
  const csv = rows
    .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(";"))
    .join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `tapreview-cards-${new Date().toISOString().slice(0, 10)}.csv`);
}

// Код карты: латинские буквы и цифры, регистр и дефисы не важны (k7p-3qx = K7P3QX).
// partial = true — для поиска по части номера.
function normalizeCardCode(value, partial = false) {
  const code = String(value || "").replace(/[\s-]/g, "").toUpperCase();
  if (partial) return /^[A-Z0-9]{1,12}$/.test(code) ? code : null;
  return /^[A-Z0-9]{4,12}$/.test(code) ? code : null;
}

// K7P3QX → K7P-3QX (так номер напечатан на карте)
function formatCardCode(code) {
  return code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

function cardUrl(card, source) {
  const base = (state.config && state.config.publicBaseUrl) || window.location.origin;
  const url = `${base.replace(/\/+$/, "")}/c/${card.code}`;
  return source ? `${url}?s=${source}` : url;
}

// ================= QR-коды =================
// Библиотека qrcode-generator (MIT) только рассчитывает узор,
// а картинки PNG и SVG рисуем сами — так их качество под нашим контролем.

const QR_QUIET_ZONE = 4; // белая рамка по стандарту QR — 4 модуля
const QR_PNG_SIZE = 2048; // пикселей: хватает для печати любого размера карты

function qrMatrix(text) {
  // "M" — средняя коррекция ошибок (~15%): надёжно считывается даже с потёртой карты
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();

  const count = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < count; r++) {
    const row = [];
    for (let c = 0; c < count; c++) {
      row.push(qr.isDark(r, c));
    }
    rows.push(row);
  }
  return rows;
}

function qrSvg(text) {
  const matrix = qrMatrix(text);
  const size = matrix.length + QR_QUIET_ZONE * 2;

  let path = "";
  matrix.forEach((row, r) => {
    row.forEach((dark, c) => {
      if (dark) path += `M${c + QR_QUIET_ZONE},${r + QR_QUIET_ZONE}h1v1h-1z`;
    });
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `width="${size * 10}" height="${size * 10}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/>` +
    `</svg>`
  );
}

function qrPngBlob(text) {
  const matrix = qrMatrix(text);
  const modules = matrix.length + QR_QUIET_ZONE * 2;
  const scale = Math.floor(QR_PNG_SIZE / modules);
  const size = modules * scale;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000000";
  matrix.forEach((row, r) => {
    row.forEach((dark, c) => {
      if (dark) {
        ctx.fillRect((c + QR_QUIET_ZONE) * scale, (r + QR_QUIET_ZONE) * scale, scale, scale);
      }
    });
  });

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function downloadQrPng(url, baseName) {
  const blob = await qrPngBlob(url);
  downloadBlob(blob, `${baseName}.png`);
}

function downloadQrSvg(url, baseName) {
  const blob = new Blob([qrSvg(url)], { type: "image/svg+xml" });
  downloadBlob(blob, `${baseName}.svg`);
}

function downloadBlob(blob, fileName) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  overlayHost().append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ================= Мелочи =================

function publicUrl(business) {
  const base = (state.config && state.config.publicBaseUrl) || window.location.origin;
  return `${base.replace(/\/+$/, "")}/b/${business.slug}`;
}

// Та же страница, но с пометкой источника для статистики: ?s=nfc или ?s=qr
function sourceUrl(business, source) {
  return `${publicUrl(business)}?s=${source}`;
}

function groupUrl(group) {
  const base = (state.config && state.config.publicBaseUrl) || window.location.origin;
  return `${base.replace(/\/+$/, "")}/g/${group.slug}`;
}

function groupSourceUrl(group, source) {
  return `${groupUrl(group)}?s=${source}`;
}

// Пока открыто окно формы, остальная страница «заморожена»,
// поэтому временные элементы добавляем внутрь окна
function overlayHost() {
  if ($("editor").open) return $("editor");
  for (const id of ["group-editor", "card-editor", "issue-dialog"]) {
    if ($(id).open) return $(id);
  }
  return document.body;
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

function statsText(stats) {
  return `${stats.page_views} откр. · ${stats.clicks} ${plural(stats.clicks, "клик", "клика", "кликов")}`;
}

function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
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
