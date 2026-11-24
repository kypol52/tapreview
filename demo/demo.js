(() => {
  "use strict";

  const dishes = [
    { id: "cappuccino", group: "Кофе", name: "Капучино", details: "Двойной эспрессо и молоко · 250 мл", price: 240 },
    { id: "filter", group: "Кофе", name: "Фильтр-кофе", details: "Колумбия, яблоко и карамель · 250 мл", price: 210 },
    { id: "raf", group: "Кофе", name: "Ванильный раф", details: "Эспрессо, сливки и ваниль · 300 мл", price: 320 },
    { id: "toast", group: "Завтраки", name: "Тост с авокадо", details: "Авокадо, яйцо пашот и ржаной хлеб", price: 490 },
    { id: "syrniki", group: "Завтраки", name: "Сырники", details: "Творог, сметана и ягодный соус", price: 420 },
    { id: "bun", group: "Выпечка", name: "Булочка с корицей", details: "Сдобное тесто и сливочная глазурь", price: 220 },
    { id: "croissant", group: "Выпечка", name: "Миндальный круассан", details: "Слоёное тесто и миндальный крем", price: 290 }
  ];
  const byId = new Map(dishes.map(dish => [dish.id, dish]));
  const groups = [...new Set(dishes.map(dish => dish.group))];
  const priceFormat = new Intl.NumberFormat("ru-RU");
  const rubles = value => priceFormat.format(value) + " ₽";
  const storageKey = "tapreview-guest-demo-v1";
  const giftPrice = 200;
  const wifiPassword = "teploe-demo";
  const initial = () => ({ cart: {}, bill: {}, points: 240, gift: false, events: [] });
  const $ = selector => document.querySelector(selector);
  const menu = $("#menu");
  const cart = $("#cart");
  const filters = $("#filters");
  const orderButton = $("#order");
  const status = $("#status");
  const events = $("#events");
  const dialog = $("#dialog");
  const dialogTitle = $("#dialog-title");
  const dialogBody = $("#dialog-body");

  let category = groups[0];
  let state = initial();
  let tip = 0;
  let rating = 0;
  let activeDialog = "";

  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (saved && Number.isSafeInteger(saved.points) && saved.points >= 0 && Array.isArray(saved.events)) {
      const itemCounts = value => Object.fromEntries(dishes.flatMap(({ id }) => {
        const quantity = value?.[id];
        return Number.isSafeInteger(quantity) && quantity > 0 && quantity <= 99 ? [[id, quantity]] : [];
      }));
      state = {
        cart: itemCounts(saved.cart), bill: itemCounts(saved.bill), points: saved.points,
        gift: saved.gift === true, events: saved.events.filter(line => typeof line === "string").slice(0, 8)
      };
    }
  } catch {}

  function persist() {
    try { sessionStorage.setItem(storageKey, JSON.stringify(state)); } catch {}
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, action, classes = "button") {
    const node = element("button", classes, label);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }

  function setStatus(text) {
    status.textContent = text;
  }

  function log(text) {
    state.events.unshift(text);
    state.events = state.events.slice(0, 8);
    persist();
    renderEvents();
    setStatus(text);
  }

  function entries(items) {
    return Object.entries(items).map(([id, quantity]) => ({ ...byId.get(id), quantity }));
  }

  function total(items) {
    return entries(items).reduce((sum, dish) => sum + dish.price * dish.quantity, 0);
  }

  function renderMenu() {
    for (const filter of filters.children) {
      filter.setAttribute("aria-pressed", String(filter.textContent === category));
    }
    menu.replaceChildren(...dishes.filter(dish => dish.group === category).map(dish => {
      const item = element("li", "dish");
      const info = element("div");
      info.append(element("h3", "", dish.name), element("small", "", dish.details));
      const add = button("+ " + rubles(dish.price), () => changeQuantity(dish.id, 1));
      add.setAttribute("aria-label", "Добавить: " + dish.name + ", " + rubles(dish.price));
      item.append(info, add);
      return item;
    }));
  }

  function changeQuantity(id, amount, focusKey) {
    const quantity = (state.cart[id] || 0) + amount;
    if (quantity > 99 - (state.bill[id] || 0)) {
      setStatus("В одном счёте может быть до 99 порций одного блюда.");
      return;
    }
    if (quantity <= 0) delete state.cart[id];
    else state.cart[id] = quantity;
    persist();
    renderCart();
    if (focusKey) {
      const replacement = [...cart.querySelectorAll("button")].find(control => control.dataset.focus === focusKey);
      (replacement || cart.querySelector("button") || $("#cart-title")).focus();
    }
    setStatus(quantity > 0 ? byId.get(id).name + " в заказе: " + quantity : "Позиция убрана из заказа.");
  }

  function sumLine(label, value) {
    const line = element("p", "sum");
    line.append(element("span", "", label), element("strong", "", rubles(value)));
    return line;
  }

  function renderCart() {
    const rows = entries(state.cart);
    const balance = total(state.bill);
    orderButton.disabled = rows.length === 0;
    const count = rows.reduce((sum, dish) => sum + dish.quantity, 0);
    $("#cart-link").textContent = count ? "К заказу (" + count + ")" : "К заказу";
    cart.replaceChildren();
    if (!rows.length) {
      cart.append(element("p", "empty", "Добавьте блюдо или напиток из меню."));
    } else {
      const list = element("ul", "ticket-list");
      for (const dish of rows) {
        const row = element("li", "ticket-item");
        const controls = element("div", "qty");
        for (const [label, delta, action] of [["−", -1, "Убрать"], ["+", 1, "Добавить"]]) {
          const key = dish.id + ":" + delta;
          const control = button(label, () => changeQuantity(dish.id, delta, key));
          control.dataset.focus = key;
          control.setAttribute("aria-label", action + ": " + dish.name);
          controls.append(control);
          if (delta < 0) controls.append(element("b", "", dish.quantity));
        }
        row.append(element("span", "", dish.name), controls);
        list.append(row);
      }
      cart.append(list, sumLine("К отправке", total(state.cart)));
    }
    if (balance) cart.append(sumLine("Счёт столика", balance));
  }

  function renderEvents() {
    events.replaceChildren(...(state.events.length ? state.events : ["Здесь появятся действия за столиком."])
      .map(text => element("li", "", text)));
  }

  function show(title, ...content) {
    dialogTitle.textContent = title;
    dialogBody.replaceChildren(...content);
    if (!dialog.open) dialog.showModal();
  }

  function finish(text) {
    dialog.close();
    log(text);
  }

  function showBill() {
    const balance = total(state.bill);
    if (!balance) {
      show("Счёт и чаевые", element("p", "", "Счёт пока пуст. Отправьте заказ, чтобы попробовать оплату и чаевые."));
      return;
    }
    const lines = element("ul", "ticket-list");
    for (const dish of entries(state.bill)) {
      const row = element("li", "ticket-item");
      row.append(element("span", "", dish.name + " × " + dish.quantity), element("strong", "", rubles(dish.price * dish.quantity)));
      lines.append(row);
    }
    const choices = element("div", "choices");
    const amount = element("strong");
    const sum = element("p", "sum");
    sum.append(element("span", "", "Итого с чаевыми"), amount);
    for (const percent of [0, 5, 10, 15]) {
      const option = button(percent ? percent + "%" : "Без чаевых", () => {
        tip = percent;
        refresh();
      }, "button filter");
      option.dataset.tip = percent;
      choices.append(option);
    }
    function refresh() {
      amount.textContent = rubles(balance + Math.round(balance * tip / 100));
      for (const choice of choices.children) {
        choice.setAttribute("aria-pressed", String(Number(choice.dataset.tip) === tip));
      }
    }
    refresh();
    const pay = button("Оплатить в демо", () => {
      const current = total(state.bill);
      if (!current) return;
      const gratuity = Math.round(current * tip / 100);
      const earned = Math.floor(current / 10);
      state.bill = {};
      state.points += earned;
      renderCart();
      finish("Демо-оплата " + rubles(current + gratuity) + (gratuity ? ", из них чаевые " + rubles(gratuity) : "") + ". Начислено баллов: " + earned + ".");
    }, "button primary");
    show("Счёт и чаевые", lines, element("p", "note", "Выберите чаевые. Деньги списаны не будут."), choices, sum, pay);
  }

  function showReview() {
    const choices = element("div", "choices");
    choices.setAttribute("aria-label", "Оценка от 1 до 5");
    const comment = element("textarea");
    comment.rows = 3;
    comment.maxLength = 300;
    comment.placeholder = "Например, как вам кофе и обслуживание?";
    comment.setAttribute("aria-label", "Комментарий к отзыву");
    const send = button("Отправить отзыв", () => {
      if (!rating) return;
      const hasComment = Boolean(comment.value.trim());
      finish("Получен демо-отзыв: " + rating + " из 5" + (hasComment ? ", с комментарием." : "."));
      comment.value = "";
    }, "button primary");
    send.disabled = true;
    for (let value = 1; value <= 5; value++) {
      const option = button(String(value), () => {
        rating = value;
        send.disabled = false;
        for (const item of choices.children) item.setAttribute("aria-pressed", String(item === option));
      }, "button filter");
      option.setAttribute("aria-label", "Оценка " + value + " из 5");
      option.setAttribute("aria-pressed", "false");
      choices.append(option);
    }
    show("Как прошёл визит?", element("p", "note", "Тестовый отзыв не публикуется. Не указывайте персональные данные."), choices, comment, send);
  }

  function showLoyalty() {
    const points = element("p", "", "Ваш баланс: " + priceFormat.format(state.points) + " баллов.");
    if (state.gift) {
      show("Баллы и подарок", points, element("p", "", "Ваш подарок — фильтр-кофе. Покажите код ZERNO7 бариста в демо."));
      return;
    }
    const claim = button("Получить подарок", () => {
      if (state.gift || state.points < giftPrice) return;
      state.points -= giftPrice;
      state.gift = true;
      log("Гость обменял баллы на фильтр-кофе.");
      showLoyalty();
      dialogBody.querySelector("p").tabIndex = -1;
      dialogBody.querySelector("p").focus();
    }, "button primary");
    claim.disabled = state.points < giftPrice;
    show("Баллы и подарок", points, element("p", "note", "Фильтр-кофе за 200 баллов. После оплаты заказа начисляется 10% от суммы блюд."), claim);
  }

  function showWifi() {
    const feedback = element("p", "note", "Реквизиты показаны для примера.");
    feedback.setAttribute("role", "status");
    const copy = button("Скопировать пароль", async () => {
      try {
        await navigator.clipboard.writeText(wifiPassword);
        feedback.textContent = "Пароль скопирован.";
      } catch {
        feedback.textContent = "Скопируйте пароль вручную: " + wifiPassword + ".";
      }
    });
    show("Wi‑Fi", element("p", "", "Сеть: Teploe-Zerno-Guest"), element("p", "", "Пароль: " + wifiPassword), copy, feedback);
  }

  function reset() {
    state = initial();
    category = groups[0];
    persist();
    renderMenu();
    renderCart();
    renderEvents();
    dialog.close();
    setStatus("Демо началось заново.");
  }

  const dialogs = {
    call() {
      show("Позвать официанта", element("p", "", "Отправить тестовый вызов к столику №7?"),
        button("Отправить вызов", () => finish("Официант получил вызов к столику №7 в демо."), "button primary"));
    },
    bill() { tip = 0; showBill(); },
    review() { rating = 0; showReview(); },
    loyalty: showLoyalty,
    wifi: showWifi,
    reset() {
      show("Начать заново?", element("p", "", "Пробный заказ, баллы и история действий будут сброшены."),
        button("Сбросить демо", reset, "button primary"));
    }
  };

  for (const control of document.querySelectorAll("[data-open]")) {
    control.addEventListener("click", () => {
      activeDialog = control.dataset.open;
      dialogs[activeDialog]();
    });
  }
  dialog.addEventListener("close", () => {
    document.querySelector('[data-open="' + activeDialog + '"]')?.focus();
    dialogBody.replaceChildren();
  });
  orderButton.addEventListener("click", () => {
    const rows = entries(state.cart);
    if (!rows.length) return;
    for (const dish of rows) state.bill[dish.id] = (state.bill[dish.id] || 0) + dish.quantity;
    state.cart = {};
    renderCart();
    $("#cart-title").focus();
    log("Заказ к столику №7: " + rows.map(dish => dish.name + " × " + dish.quantity).join(", ") + ".");
  });
  $("#cart-title").tabIndex = -1;
  for (const group of groups) {
    filters.append(button(group, () => {
      category = group;
      renderMenu();
    }, "filter"));
  }
  renderMenu();
  renderCart();
  renderEvents();
})();
