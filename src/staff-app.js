// Рабочий режим официанта в Telegram-приложении (app/, раздел «Работа»): то же, что ссылка персонала /k/ТОКЕН —
// вызовы и заказы со столов, касса подарков, касса баллов. Права — сама ссылка персонала (токен), как в браузере;
// дополнительно нужен вход через Telegram (initData), чтобы токеном нельзя было пользоваться вне приложения.
//
// Токены хранятся на телефоне официанта (Telegram CloudStorage), на сервере ничего не запоминаем: отключили ссылку
// в админке — она пропадает и из приложения. Привязка: ссылка t.me/<бот>/<app>?startapp=k_ТОКЕН (кнопка на /k/…).
//
//   POST /api/app/staff/places {tokens}                    — какие ссылки живы и что в них включено
//   GET  /api/app/staff/calls?t=ТОКЕН                       — вызовы, заказы и счета (то же, что /k/ТОКЕН/calls)
//   POST /api/app/staff/calls {t, type, id, do, amount}     — «Принял» / «Готово» / «Выставить» / «Закрыть»
//   POST /api/app/staff/gift {t, code, redeem}              — проверить / погасить код подарка
//   POST /api/app/staff/points {t, code[, check, spend]}    — найти код баллов / провести чек

import { db } from "./supabase.js";
import { hasModule } from "./tariffs.js";
import { TOKEN_RE } from "./stats-page.js";
import { CALL_KINDS, activeCalls, staffCallAction } from "./service.js";
import { normalizeCode, findCode, redeemCode, validityText } from "./bonus.js";
import { rewardInviter } from "./friends.js";
import { POINTS_COLUMNS, pointsOn, balanceOf, rulesText, PointsError, findCode as findPointsCode, operate } from "./points.js";

const MAX_TOKENS = 10;

export class StaffError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function linkOf(env, token) {
  if (!TOKEN_RE.test(String(token || ""))) throw new StaffError(404, "Рабочая ссылка не найдена или отключена");
  const rows = await db(env, `staff_links?token=eq.${token}&select=token,business_id,label,staff_id`);
  if (!rows.length) throw new StaffError(404, "Рабочая ссылка не найдена или отключена");
  const link = rows[0];
  const business = (await db(env, `businesses?id=eq.${link.business_id}&select=id,slug,name,modules,tariff,bonus_mode,pay_on,${POINTS_COLUMNS}&limit=1`))[0];
  if (!business) throw new StaffError(404, "Заведение не найдено");
  return { link, business };
}

const touch = (env, token) =>
  db(env, `staff_links?token=eq.${token}`, { method: "PATCH", body: { last_used_at: new Date().toISOString() }, prefer: "return=minimal" }).catch(() => {});

function features(env, business) {
  return {
    calls: hasModule(business, "service"),
    gifts: Boolean(business.bonus_mode && business.bonus_mode !== "off"),
    points: pointsOn(business),
    pay: Boolean(env.PAY_PROVIDER && business.pay_on)
  };
}

export async function staffPlaces(env, tokens) {
  const list = [...new Set((Array.isArray(tokens) ? tokens : []).map(String).filter((t) => TOKEN_RE.test(t)))].slice(0, MAX_TOKENS);
  const out = [];
  for (const token of list) {
    try {
      const { link, business } = await linkOf(env, token);
      out.push({ token, ok: true, name: business.name, label: link.label || "", ...features(env, business) });
    } catch (error) {
      if (!(error instanceof StaffError)) throw error;
      out.push({ token, ok: false });
    }
  }
  return { places: out };
}

// Список для приложения — данными, не HTML (приложение строит экран само)
export async function staffCalls(env, token) {
  const { business } = await linkOf(env, token);
  if (!hasModule(business, "service")) throw new StaffError(403, "Вызовы гостей для этого заведения не подключены");
  const pay = features(env, business).pay;
  const rows = await activeCalls(env, business.id, pay);
  return {
    pay,
    items: rows.map((c) => {
      const base = { uid: c.uid, type: c.type, id: c.id, place: c.place, created: c.created_at };
      if (c.type === "bill") return { ...base, status: c.status, amount: c.amount, paid: c.paid };
      const common = { ...base, status: c.status, acceptedBy: c.accepted_by || null };
      if (c.type === "order") {
        return { ...common, total: Number(c.total), comment: c.comment || null, lines: (c.items || []).map((l) => ({ name: l.name, qty: l.qty })) };
      }
      const k = CALL_KINDS[c.kind] || CALL_KINDS.help;
      return { ...common, kind: c.kind, icon: k.icon, what: k.staff, split: c.kind === "bill" && c.split ? c.split : null };
    })
  };
}

export async function staffCallsDo(env, input) {
  const { link, business } = await linkOf(env, input.t);
  if (!hasModule(business, "service")) throw new StaffError(403, "Вызовы гостей для этого заведения не подключены");
  const type = ["call", "order", "bill"].includes(input.type) ? input.type : "call";
  const action = ["accept", "done", "bill"].includes(input.do) ? input.do : null;
  if (!action) throw new StaffError(400, "Неизвестное действие");
  await staffCallAction(env, business, link, link.token, features(env, business).pay, {
    type, id: input.id, action, amount: input.amount === undefined ? null : String(input.amount).slice(0, 12)
  });
  return staffCalls(env, link.token);
}

// Касса подарков: как /k/ТОКЕН, только ответ — данные
export async function staffGift(env, input) {
  const { link, business } = await linkOf(env, input.t);
  const code = normalizeCode(input.code);
  if (!code) return { state: "format" };
  const found = await findCode(env, code, [business.id]);
  if (!found) return { state: "none", code };
  const by = link.label ? `персонал: ${link.label}` : "персонал";
  let state = found.state;
  if (input.redeem === true && state === "ok") {
    const done = await redeemCode(env, found.row.id, by);
    if (done) {
      touch(env, link.token);
      await rewardInviter(env, found.row);
    }
    state = done ? "done" : "used";
  }
  const r = found.row;
  return {
    state,
    code,
    prize: r.prize,
    vip: Boolean(r.vip),
    validity: validityText(r),
    conditions: r.conditions || null,
    validFrom: r.valid_from,
    redeemedAt: state === "done" ? new Date().toISOString() : r.redeemed_at
  };
}

// Касса баллов: найти код → баланс и правила; с суммой чека — провести (один код — одна операция)
export async function staffPoints(env, input) {
  const { link, business } = await linkOf(env, input.t);
  if (!pointsOn(business)) throw new StaffError(403, "Баллы в этом заведении не включены");
  const code = String(input.code || "").replace(/\D/g, "");
  const found = await findPointsCode(env, code, [business.id]);
  if (!found) return { state: "none" };
  const balance = await balanceOf(env, business.id, found.visitor_key);
  const info = { balance, rules: rulesText(business), maxCheck: business.points_max_check, maxShare: business.points_max_share };
  if (input.check === undefined || input.check === null || input.check === "") return { state: "found", ...info };
  const form = new URLSearchParams({ check: String(input.check), spend: input.spend === undefined || input.spend === null ? "" : String(input.spend) });
  try {
    const done = await operate(env, business, found, balance, form, {
      by: link.label ? `персонал: ${link.label}` : "персонал",
      staffId: link.staff_id || null
    });
    touch(env, link.token);
    return { state: "done", ...done };
  } catch (error) {
    if (!(error instanceof PointsError)) throw error;
    return { state: "error", error: error.message, ...info };
  }
}
