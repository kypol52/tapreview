export const SERVICE_DEMOS = {
  beauty: {
    business: {name: "Студия «Линия»", category: "beauty"},
    services: [
      ["Маникюр с покрытием", "1 900 ₽", "90 мин", "Маникюр, снятие и однотонное покрытие."],
      ["Педикюр", "2 400 ₽", "90 мин", "Обработка стоп и ногтей с покрытием."],
      ["Окрашивание", "от 4 500 ₽", "150 мин", "Подбор оттенка, окрашивание и укладка."],
      ["Укладка", "1 600 ₽", "45 мин", "Укладка феном или мягкие локоны."],
      ["Косметологический уход", "2 800 ₽", "60 мин", "Консультация и базовый уход за кожей."],
    ],
    masters: [
      {name: "Анна", detail: "Мастер маникюра и педикюра", review: "«Аккуратное покрытие и чистая форма»", services: [0, 1], photo: 0},
      {name: "Мария", detail: "Стилист-колорист", review: "«Помогла подобрать оттенок»", services: [2, 3], photo: 9},
      {name: "Елена", detail: "Специалист по уходу за кожей", review: "«Объяснила каждый этап ухода»", services: [4], photo: 10},
    ],
    portfolio: [["Нюдовый маникюр", 3, 0], ["Каштановый балаяж", 6, 1], ["Мягкие волны", 15, 1]],
    history: ["Маникюр с покрытием · Анна · прошлый визит"],
    care: ["После маникюра используйте масло для кутикулы.", "Для окрашенных волос подберите мягкий шампунь и термозащиту по рекомендации мастера."],
    products: [["Масло для кутикулы", "590 ₽"], ["Термозащита для волос", "1 250 ₽"]],
    pass: "3 укладки · доступно 2 из 3 посещений",
    amount: "1 900 ₽"
  },
  barber: {
    business: {name: "Барбершоп «Форма»", category: "barber"},
    links: [
      ["tips", "tips", "Чаевые мастеру"],
      ["masters", "custom", "Мастера"],
      ["more", "custom", "Уход, сертификаты и абонементы"],
    ],
    services: [
      ["Стрижка", "1 700 ₽", "45 мин", "Консультация, стрижка и укладка."],
      ["Моделирование бороды", "1 000 ₽", "30 мин", "Форма, контур и уход за бородой."],
      ["Стрижка и борода", "2 400 ₽", "75 мин", "Стрижка, оформление бороды и укладка."],
    ],
    masters: [
      {name: "Илья", detail: "Фейды, короткие стрижки и борода", review: "«Точный переход и аккуратный контур»", services: [0, 1, 2], photo: 1},
      {name: "Артём", detail: "Классические формы и укладки", review: "«Подобрал форму, которую легко укладывать»", services: [0, 2], photo: 11},
    ],
    portfolio: [["Фейд и текстурный кроп", 4, 0], ["Классический сайд-парт", 7, 1]],
    history: ["Стрижка · Илья · фейд с текстурным верхом"],
    care: ["Для текстурной укладки разотрите немного матовой пасты и нанесите на сухие волосы.", "При следующем визите покажите барберу сохранённый референс."],
    products: [["Матовая паста", "1 190 ₽"], ["Масло для бороды", "890 ₽"], ["Шампунь", "1 050 ₽"]],
    pass: "4 стрижки · доступно 3 из 4 посещений",
    amount: "1 700 ₽"
  },
  massage: {
    business: {name: "Массажный салон «Тишина»", category: "massage", tagline: "Массажный салон"},
    services: [
      ["Расслабляющий массаж", "2 800 ₽", "60 мин", "Спокойный сеанс с мягкой интенсивностью."],
      ["Массаж шеи и плеч", "1 700 ₽", "30 мин", "Короткий сеанс с акцентом на плечи и шею."],
      ["Массаж стоп", "1 500 ₽", "30 мин", "Отдельный сеанс для стоп в комфортном темпе."],
    ],
    masters: [
      {name: "Ольга", detail: "Расслабляющие сеансы и массаж шеи и плеч", review: "«Специалист учитывала мои пожелания»", services: [0, 1], photo: 2},
      {name: "Дарья", detail: "Расслабляющий массаж и массаж стоп", review: "«Понравились спокойный темп и атмосфера»", services: [0, 2], photo: 12},
    ],
    portfolio: [["Сеанс для шеи и плеч", 5, 0], ["Кабинет для расслабляющих сеансов", 8, 1]],
    history: ["Расслабляющий массаж · Ольга · 60 мин"],
    care: ["Попросите специалиста добавить персональные рекомендации после сеанса.", "Сохраните предпочтения по интенсивности для следующего визита."],
    products: [["Масло для тела", "950 ₽"], ["Увлажняющий крем", "1 100 ₽"]],
    pass: "5 сеансов по 60 минут · доступно 3 из 5 посещений",
    amount: "2 800 ₽"
  }
};

export const SERVICE_LINKS = [
  ["services", "services", "Услуги и цены"],
  ["booking", "booking", "Онлайн-запись"],
  ["masters", "custom", "Мастера и отзывы"],
  ["portfolio", "catalog", "Портфолио"],
  ["admin", "custom", "Вызвать администратора"],
  ["drinks", "custom", "Заказать напиток"],
  ["visits", "custom", "Мои визиты"],
  ["more", "custom", "Уход, сертификаты и абонементы"],
  ["tips", "tips", "Чаевые мастеру"]
];

export const SERVICE_DEMO_CSS = `
  .demo-list, .demo-form { display: grid; gap: 10px; text-align: left; margin-top: 18px; }
  .demo-item { padding: 14px; border: 1px solid var(--btn-border); border-radius: 14px; background: var(--btn-bg); }
  .demo-item h2 { margin: 0; font-size: 17px; }
  .demo-item p { margin: 5px 0 0; color: var(--muted); font-size: 14px; }
  .demo-item .rate-public { margin-top: 9px; }
  .demo-actions { display: flex; flex-wrap: wrap; gap: 0 16px; }
  .demo-photo { aspect-ratio: 1; max-width: 260px; margin: 0 auto 12px; border-radius: 10px; background: var(--btn-border) url('/assets/demo-services.jpg') no-repeat; background-size: 300% 300%; }
  .demo-photo-portrait { width: 112px; margin: 0 0 12px; }
  .demo-photo-more { background-image: url('/assets/demo-services-more.jpg'); }
  .demo-field { display: grid; gap: 4px; }
  .demo-field label { font-size: 14px; font-weight: 650; }
  .demo-form select { width: 100%; min-height: 44px; padding: 6px 10px; color: var(--text); background: var(--card); border: 1px solid var(--btn-border); border-radius: 10px; font: inherit; }
  .demo-form .fb-send { min-height: 44px; }
`;

export const SERVICE_BOOKING_SCRIPT = `(() => {
  const service = document.querySelector('select[name="service"]');
  const master = document.querySelector('select[name="master"]');
  if (!service || !master) return;
  const refresh = () => {
    for (const option of master.options) {
      option.disabled = !option.dataset.services.split(',').includes(service.value);
    }
    if (!master.value || master.selectedOptions[0]?.disabled) {
      master.value = Array.from(master.options).find(option => !option.disabled)?.value ?? '';
    }
  };
  service.addEventListener('change', refresh);
  refresh();
})();`;

export function serviceDemoContent(action, profile, url, {href, path}, esc) {
  const link = (target, label, params) => `<a class="rate-public" href="${esc(href(target, params))}">${esc(label)}</a>`;
  const list = (items) => `<div class="demo-list">${items.join("")}</div>`;
  const item = (title, detail, controls = "", photo = "") => `<article class="demo-item">${photo}<h2>${esc(title)}</h2>${detail ? `<p>${esc(detail)}</p>` : ""}${controls}</article>`;
  const photo = (index, description, portrait = false) => {
    if (!Number.isInteger(index)) return "";
    const cell = index % 9;
    const classes = `demo-photo${portrait ? " demo-photo-portrait" : ""}${index >= 9 ? " demo-photo-more" : ""}`;
    return `<div class="${classes}" style="background-position:${(cell % 3) * 50}% ${Math.floor(cell / 3) * 50}%" role="img" aria-label="${esc(description)}"></div>`;
  };
  const param = (key, values) => {
    const raw = url.searchParams.get(key);
    const n = Number(raw);
    return raw !== null && /^\d+$/.test(raw) && n < values.length ? n : null;
  };
  const select = (key, title, values, selected = null) => `<div class="demo-field"><label for="demo-${key}">${esc(title)}</label><select id="demo-${key}" name="${key}" required>${values.map(([value, label, allowed]) => `<option value="${value}"${value === selected ? " selected" : ""}${allowed ? ` data-services="${allowed.join(",")}"` : ""}>${esc(label)}</option>`).join("")}</select></div>`;
  const hidden = (key, value) => `<input type="hidden" name="${key}" value="${esc(value)}">`;
  const form = (fields, button) => `<form class="demo-form" action="${path}" method="get">${hidden("example", action)}${hidden("done", "1")}${fields}<button class="fb-send" type="submit">${esc(button)}</button></form>`;
  const done = url.searchParams.get("done") === "1";
  const notice = (line) => `<p class="lead">${esc(line)}</p>`;
  const choices = (values) => values.map((label, i) => [i, label]);
  const simpleChoice = (title, label, values, button, result) => {
    const index = param("choice", values);
    return [title, done && index !== null ? notice(result(values[index])) : form(select("choice", label, choices(values)), button)];
  };
  const {services, masters, portfolio} = profile;
  const isBarber = profile.business.category === "barber";

  switch (action) {
    case "services":
      return ["Услуги и цены", list(services.map(([name, price, time, text], i) => item(name, `${price} · ${time}. ${text}`, link("booking", "Записаться", {service: i}))))];
    case "masters": {
      const cards = masters.map((m, i) => {
        const portfolioLink = link("portfolio", isBarber ? "Портфолио" : "Работы мастера", {master: i});
        const controls = isBarber
          ? `<div class="demo-actions">${portfolioLink}${link("master-review", "Оценить мастера", {subject: i})}</div>`
          : portfolioLink + " · " + link("booking", "Записаться к мастеру", {master: i});
        return item(m.name, `${m.detail}. Пример отзыва: ${m.review}`, controls, photo(m.photo, `Демо-портрет мастера · ${m.name}`, true));
      });
      return [isBarber ? "Мастера" : "Мастера и отзывы", list(cards)];
    }
    case "portfolio": {
      const master = param("master", masters);
      const filtered = portfolio.filter(([, , owner]) => master === null || owner === master);
      return ["Портфолио", filtered.length ? list(filtered.map(([name, image, owner]) => {
        const work = portfolio.findIndex((entry) => entry[1] === image);
        return item(name, masters[owner].name, link("same", "Хочу так же", {work}) + (isBarber ? " · " + link("style", "Сохранить в «Мой стиль»", {work}) : ""), photo(image, name));
      })) + (isBarber ? link("before-after", "Посмотреть до и после") : "") : notice("В демо у этого мастера пока нет работ.")];
    }
    case "same":
    case "style": {
      const index = param("work", portfolio);
      if (index === null) return ["Референс", link("portfolio", "Выбрать работу")];
      const [work, image, master] = portfolio[index];
      const isStyle = action === "style";
      const title = isStyle ? "Мой стиль" : "Хочу так же";
      return [title, list([item(work, done ? (isStyle ? "Референс сохранён в примере подборки." : `В демо референс выбран для мастера ${masters[master].name}.`) : `Работа мастера · ${masters[master].name}`, "", photo(image, work))]) + (done ? link("booking", "Записаться к мастеру", {master}) : form(hidden("work", index), isStyle ? "Сохранить в демо" : "Поделиться в демо"))];
    }
    case "booking":
    case "repeat": {
      const title = action === "repeat" ? (isBarber ? "Повторить стрижку" : "Повторить запись") : "Онлайн-запись";
      const master = param("master", masters) ?? (action === "repeat" ? 0 : null);
      const service = param("service", services) ?? (action === "repeat" ? 0 : null);
      const days = [1, 2, 4].map((day) => new Intl.DateTimeFormat("ru-RU", {day: "numeric", month: "long", timeZone: "Europe/Samara"}).format(Date.now() + day * 86400000));
      const slots = ["10:00", "12:30", "16:00", "18:30"];
      const day = param("day", days), time = param("time", slots);
      const eligible = master === null || service === null || masters[master].services.includes(service);
      if (done && eligible && [master, service, day, time].every((value) => value !== null)) {
        return [title, notice(`Пробная запись подтверждена: ${services[service][0]}, мастер ${masters[master].name}, ${days[day]} в ${slots[time]}.`)];
      }
      const error = done && !eligible ? notice("Этот мастер не оказывает выбранную услугу. Выберите другое сочетание.") : "";
      return [title, error + form(select("service", "Услуга", choices(services.map(([name]) => name)), service ?? masters[master ?? 0].services[0]) +
        select("master", "Мастер", masters.map((m, i) => [i, m.name, m.services]), master ?? masters.findIndex((m) => m.services.includes(service ?? 0))) +
        select("day", "Дата", choices(days), day) + select("time", "Время", choices(slots), time), "Записаться в демо") + link("waitlist", "Встать в лист ожидания")];
    }
    case "admin":
      return ["Вызов администратора", done ? notice("Показано подтверждение вызова администратора.") : notice("Попробуйте вызвать администратора с гостевой карточки.") + form("", "Вызвать в демо")];
    case "drinks":
      return simpleChoice("Заказ напитка", "Напиток", ["Кофе", "Чай", "Вода", "Лимонад"], "Заказать в демо", (drink) => `Пробный заказ принят: ${drink}.`);
    case "pay": {
      const products = profile.products.map(([name, price]) => `${name} · ${price}`);
      const product = param("product", ["Без товара", ...products]);
      const parseMoney = (value) => Number(value.replace(/[^0-9]/g, ""));
      const total = product ? `${new Intl.NumberFormat("ru-RU").format(parseMoney(profile.amount) + parseMoney(profile.products[product - 1][1]))} ₽` : profile.amount;
      return ["Оплата услуг", done ? notice(`Пробная оплата на ${total} завершена.${product ? ` В чеке: ${products[product - 1]}.` : ""}`) : notice(`К оплате за визит ${profile.amount}.`) + form(select("product", "Добавить средство к визиту", choices(["Без товара", ...products]), product), "Оплатить в демо")];
    }
    case "tips": {
      const master = param("master", masters);
      const tips = ["100 ₽", "200 ₽", "500 ₽"];
      const amount = param("amount", tips);
      return ["Чаевые мастеру", done && master !== null && amount !== null ? notice(`Пробные чаевые: ${masters[master].name} · ${tips[amount]}.`) : form(select("master", "Мастер", choices(masters.map((m) => m.name))) + select("amount", "Сумма", choices(tips)), "Оставить чаевые в демо")];
    }
    case "visits":
      return ["Мои визиты", list([item("История посещений", profile.history[0], link("repeat", isBarber ? "Повторить стрижку" : "Повторная запись")), item("Лист ожидания", "Выберите услугу и удобное время.", link("waitlist", "Встать в лист ожидания")), item("Абонемент", profile.pass, link("passes", "Доступные пакеты")), ...(isBarber ? [item("Напоминание о стрижке", "Выберите, через сколько недель напомнить о записи.", link("remind", "Настроить напоминание")), item("Штампы и бонусы", "У вас 3 из 5 штампов.", link("points", "Открыть код для кассы"))] : [])])];
    case "more":
      return ["Уход и подарки", list([item("Рекомендации по уходу", "Советы после процедуры и подбор средств.", link("care", "Посмотреть рекомендации")), item("Магазин средств", "Примеры товаров, доступных в салоне.", link("products", "Выбрать средство")), item("Подарочный сертификат", "Выберите номинал.", link("certificates", "Купить в демо")), item("Абонементы", "Доступные пакеты и остаток посещений.", link("passes", "Посмотреть пакеты")), ...(isBarber ? [item("Подбор стрижки", "Сравните формы и выберите референс.", link("fit", "Подобрать стрижку")), item("Новости барбершопа", "В субботу — день консультаций по укладке.", link("booking", "Выбрать время"))] : [])])];
    case "care":
      return ["Рекомендации по уходу", profile.care.map(notice).join("") + link("products", "Подобрать домашний уход")];
    case "products":
      return ["Магазин средств", list(profile.products.map(([name, price], i) => item(name, price, link("pay", "Добавить к оплате визита", {product: i + 1}))))];
    case "certificates":
      return simpleChoice("Подарочный сертификат", "Номинал", ["2 000 ₽", "3 000 ₽", "5 000 ₽"], "Оформить в демо", (amount) => `Показан пробный сертификат на ${amount}.`);
    case "passes":
      return ["Абонементы", list([item("Ваш пакет", profile.pass, link("repeat", "Запланировать визит")), item("Доступный пакет", "Три посещения выбранной услуги", link("certificates", "Посмотреть подарочные варианты"))])];
    case "waitlist": {
      const service = param("service", services);
      const periods = ["Утро", "День", "Вечер", "Любое время"];
      const period = param("period", periods);
      return ["Лист ожидания", done && service !== null && period !== null ? notice(`Пробная заявка в лист ожидания: ${services[service][0]}, ${periods[period].toLowerCase()}.`) : form(select("service", "Услуга", choices(services.map(([name]) => name))) + select("period", "Удобное время", choices(periods)), "Встать в лист в демо")];
    }
    case "master-review": {
      const subject = param("subject", masters);
      const ratings = ["5 — отлично", "4 — хорошо", "3 — нормально", "2 — плохо", "1 — очень плохо"];
      const rating = param("rating", ratings);
      return ["Оценка мастера и салона", done && subject !== null && rating !== null ? notice(`Пробная оценка мастера ${masters[subject].name}: ${ratings[rating]}. Оценку салона можно оставить на карточке.`) : form(select("subject", "Мастер", choices(masters.map((m) => m.name)), subject) + select("rating", "Оценка", choices(ratings)), "Оценить в демо")];
    }
    case "remind":
      return isBarber ? simpleChoice("Напоминание о стрижке", "Когда напомнить", ["Через 3 недели", "Через 4 недели", "Через 5 недель"], "Выбрать в демо", (period) => `Пробное напоминание запланировано: ${period.toLowerCase()}.`) : null;
    case "fit": {
      if (!isBarber) return null;
      const face = param("choice", [0, 1, 2]);
      if (!done || face === null) return ["Подбор стрижки", form(select("choice", "Форма лица", choices(["Круглая", "Овальная", "Квадратная"])), "Посмотреть варианты")];
      const work = face === 0 ? 0 : 1;
      return ["Подбор стрижки", notice(`Пример для обсуждения с мастером: ${portfolio[work][0]}.`) + link("same", "Посмотреть референс", {work})];
    }
    case "before-after":
      return isBarber ? ["До и после", list([item("До стрижки", "Отросшая форма", "", photo(13, "До стрижки")), item("После стрижки", "Короткий текстурный кроп", link("booking", "Записаться на стрижку", {service: 0}), photo(14, "После стрижки"))])] : null;
    default:
      return null;
  }
}
