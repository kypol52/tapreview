// Подписка заведения: до какого дня оплачено и что из этого следует.
// Дни считаются по Москве. paid_until — последний оплаченный день (включительно).
//
//   none     — подписка не ведётся (paid_until пустое), всё работает всегда
//   ok       — оплачено, до конца больше REMIND_DAYS дней
//   ending   — оплачено, но осталось меньше REMIND_DAYS дней → напоминание владельцу
//   grace    — срок прошёл, но ещё идут GRACE_DAYS дней отсрочки → всё работает, предупреждение
//   expired  — отсрочка кончилась → карта ведёт сразу на площадку, статистика на паузе

export const GRACE_DAYS = 3;
export const REMIND_DAYS = 5;

const DAY = 24 * 60 * 60 * 1000;
const MSK_OFFSET = 3 * 60 * 60 * 1000;

export function mskToday(now = Date.now()) {
  return new Date(now + MSK_OFFSET).toISOString().slice(0, 10);
}

function dayNumber(isoDate) {
  return Math.round(Date.parse(`${isoDate}T00:00:00Z`) / DAY);
}

function addDays(isoDate, days) {
  return new Date((dayNumber(isoDate) + days) * DAY).toISOString().slice(0, 10);
}

export function billingState(paidUntil, now = Date.now()) {
  if (!paidUntil || !/^\d{4}-\d{2}-\d{2}$/.test(paidUntil)) return { state: "none" };
  const daysLeft = dayNumber(paidUntil) - dayNumber(mskToday(now));
  if (daysLeft >= 0) {
    return { state: daysLeft < REMIND_DAYS ? "ending" : "ok", paidUntil, daysLeft };
  }
  if (-daysLeft <= GRACE_DAYS) {
    return { state: "grace", paidUntil, daysLeft, lastDay: addDays(paidUntil, GRACE_DAYS) };
  }
  return { state: "expired", paidUntil, daysLeft };
}

export function isExpired(paidUntil, now = Date.now()) {
  return billingState(paidUntil, now).state === "expired";
}

// «30 ноября»
export function formatDay(isoDate) {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: "UTC"
  });
}
