// Тарифы TapReview (миграция 033; прайс 4 ноября 2026). Подписка — за заведение, карты — разовая покупка пакетом.
// Ключи в базе прежние (start / standard / plus), на сайте и в оферте — Start / Plus / Pro.
// ВНИМАНИЕ: подпись «Plus» — у ключа standard, а ключ plus — это тариф Pro. Ключи не меняли, чтобы не трогать базу.
//   start    Start    490 ₽/мес, подключение 1 490 ₽ (до 5 карт) — страница отзывов, переходы, статистика,
//                      отчёт в Telegram, оценка гостя, сообщения недовольных, причины и напоминания
//   standard Plus 990 ₽/мес, подключение 3 490 ₽ (до 20 карт) — + меню, «Сейчас у нас», «Ещё у нас», настройки,
//                      Score, итоги месяца, подарки, штампы, VIP, баллы, «Подарите другу», управление из бота
//   plus     Pro    1 990 ₽/мес, подключение 5 990 ₽ (до 50 карт) — + модули «Сервис в зале» и «AI» включены
// Модули к Plus — по MODULE_PRICE ₽/мес каждый. Карта сверх пакета — EXTRA_CARD_PRICE ₽ разово.
// Сеть: со второй точки подписка дешевле на NETWORK_DISCOUNT. Год = 10 месяцев, первый месяц бесплатно.
// Early Partner (первые EARLY.seats заведений): подключение бесплатно с 8.11.2026 (EARLY.cards карт, сверх — по EARLY.extraCard ₽, «Свой дизайн»
// в подарок), EARLY.monthly ₽/мес до конца EARLY.months-го месяца с функциями Plus.
// Расчёт — orders.js orderTotals; те же цифры на главной, в калькуляторе /order/ и в оферте (п. 3.3–3.4).

export const TARIFFS = {
  start: { label: "Start", base: 490, connection: 1490, cards: 5 },
  standard: { label: "Plus", base: 990, connection: 3490, cards: 20 },
  plus: { label: "Pro", base: 1990, connection: 5990, cards: 50 }
};
export const TARIFF_KEYS = Object.keys(TARIFFS);
export const DESIGN_PRICE = 990;
export const EXTRA_CARD_PRICE = 199;
export const MODULE_PRICE = 490;
export const NETWORK_DISCOUNT = 0.2;
export const YEAR_MONTHS = 10;
export const EARLY = { connection: 0, cards: 5, extraCard: 150, monthly: 490, months: 6, seats: 20 };

const LEVEL = { start: 0, standard: 1, plus: 2 };
// С какого тарифа доступна функция
const NEED = {
  rating: 0, // оценка 1–5, сообщения недовольных, «Что понравилось», причины и напоминания
  links: 1, // кнопки «Ещё у нас»
  moment: 1, // «Сейчас у нас»
  settings: 1, // вкладка «Настройки» на странице статистики
  score: 1, // TapReview Score
  wrapped: 1, // «Итоги месяца»
  menu: 1, // меню на странице заведения (menu.js); заказ со стола — модуль «Сервис в зале»
  gifts: 1, // подарки, колесо, штампы, VIP, «Подарите другу», касса, баллы
  guests: 1, // «С возвращением!» и уровни гостей
  bot: 1 // управление из Telegram
};

// Нет поля (запрос без tariff или база до миграции 033) — считаем Pro по функциям, чтобы ничего не пропало
export function tariffOf(business) {
  const t = business && business.tariff;
  return LEVEL[t] !== undefined ? t : "plus";
}

export function has(business, feature) {
  return LEVEL[tariffOf(business)] >= NEED[feature];
}

// Модули (миграция 042): к Plus — галочкой в админке, в Pro — включены.
//   service «Сервис в зале» — вызов сотрудника, заказ со стола, сотрудники и их оценки
//   ai      «AI-разбор отзывов» — темы, тон и «срочно», разбор недели, AI-ассистент (ai.js, assistant.js)
// Pro учитываем, только если тариф явно указан в строке (business.tariff === "plus"): многие запросы выбирают
// заведение без поля tariff, и для них модуль включается только галочкой.
export const MODULES = {
  service: { label: "Сервис в зале" },
  ai: { label: "AI-разбор отзывов" }
};
export const MODULE_KEYS = Object.keys(MODULES);

export function hasModule(business, key) {
  if (!business) return false;
  if (Array.isArray(business.modules) && business.modules.includes(key)) return true;
  return business.tariff === "plus";
}

// Название тарифа, с которого доступна функция (Plus / Pro)
export function tariffFor(feature) {
  return TARIFFS[TARIFF_KEYS[NEED[feature]]].label;
}
