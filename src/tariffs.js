// Тарифы TapReview (миграция 033). Тариф задаёт возможности заведения и цену первой карты в месяц;
// каждая следующая карта стоит одинаково во всех тарифах (шкала в orders.js).
//   start    «Старт»    — страница сразу с кнопками площадок, статистика переходов, отчёт в Telegram
//   standard «Стандарт» — + оценка гостя и сообщения недовольных, «Что понравилось», «Ещё у нас», «Сейчас у нас»,
//                          вкладка «Настройки», TapReview Score, «Итоги месяца»
//   plus     «Плюс»     — + подарки (колесо, штампы, VIP, «Подарите другу», касса), «С возвращением!» и уровни гостей,
//                          управление из Telegram
// «Свой дизайн» страницы — разовая услуга 990 ₽, в любом тарифе.

export const TARIFFS = {
  start: { label: "Старт", base: 129 },
  standard: { label: "Стандарт", base: 189 },
  plus: { label: "Плюс", base: 299 }
};
export const TARIFF_KEYS = Object.keys(TARIFFS);
export const DESIGN_PRICE = 990;

const LEVEL = { start: 0, standard: 1, plus: 2 };
// С какого тарифа доступна функция
const NEED = {
  rating: 1, // оценка 1–5, сообщения недовольных, «Что понравилось»
  links: 1, // кнопки «Ещё у нас»
  moment: 1, // «Сейчас у нас»
  settings: 1, // вкладка «Настройки» на странице статистики
  score: 1, // TapReview Score
  wrapped: 1, // «Итоги месяца»
  gifts: 2, // подарки, колесо, штампы, VIP, «Подарите другу», касса
  guests: 2, // «С возвращением!» и уровни гостей
  bot: 2 // управление из Telegram
};

// Нет поля (запрос без tariff или база до миграции 033) — считаем «Плюс», чтобы ничего не пропало
export function tariffOf(business) {
  const t = business && business.tariff;
  return LEVEL[t] !== undefined ? t : "plus";
}

export function has(business, feature) {
  return LEVEL[tariffOf(business)] >= NEED[feature];
}

// Модули сверх тарифа (миграция 042): включаются заведению отдельно в админке, в любом тарифе.
//   service «Сервис в зале» — вызов сотрудника со стола, страница вызовов для персонала, вызовы в Telegram
export const MODULES = {
  service: { label: "Сервис в зале" }
};
export const MODULE_KEYS = Object.keys(MODULES);

export function hasModule(business, key) {
  return Boolean(business && Array.isArray(business.modules) && business.modules.includes(key));
}

// Название тарифа, с которого доступна функция («Стандарт» / «Плюс»)
export function tariffFor(feature) {
  return TARIFFS[TARIFF_KEYS[NEED[feature]]].label;
}
