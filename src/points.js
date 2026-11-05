// Баллы лояльности (миграция 045, тариф Plus и Pro). 1 балл = 1 ₽ скидки; деньги через TapReview не идут.
//
//   Гость: на странице с карты — «У вас N баллов» и кнопка «Код для кассы».
//     GET /points?b=SLUG&s=nfc|qr[&c=КОД][&new=1] — одноразовый код из 6 цифр на 10 минут (только с cookie устройства).
//     Страница обновляется сама, пока кассир не проведёт код, потом показывает итог: сколько списано и начислено.
//   Кассир: /k/ТОКЕН/points (персонал) и /s/ТОКЕН/points (владелец) — ввести код, сумму чека и, если гость хочет,
//     сколько баллов списать (не больше баланса и points_max_share % чека). Начисляется points_percent % от оплаченной
//     части чека. Один код — одна операция.
//   Защита: код одноразовый и живёт 10 минут; чек не больше points_max_check; не больше OPS_PER_DAY операций у гостя
//     в день; в журнале видно, кто провёл; баллы сгорают, если points_expire_days дней не было операций (points_expire()).

import { db } from "./supabase.js";
import { isBot } from "./analytics.js";
import { deviceFrom, visitorKeyOf } from "./guests.js";
import { has } from "./tariffs.js";
import { isExpired } from "./billing.js";
import { renderPage, escapeHtml, customDesign, DEFAULT_ACCENT } from "./public-page.js";
import { html, esc, notFound, TOKEN_RE } from "./stats-page.js";

export const POINTS_COLUMNS = "points_on,points_percent,points_max_share,points_expire_days,points_max_check";
const CODE_MINUTES = 10;
const OPS_PER_DAY = 5;
const SLUG_RE = /^[A-Za-z0-9_-]{3,64}$/;

export function pointsOn(business) {
  return Boolean(business && business.points_on) && has(business, "gifts");
}

export class PointsError extends Error {}

// Настройки из админки и «Настроек» владельца
export function cleanPoints(input) {
  const num = (value, min, max, label, fallback) => {
    if (value === undefined || value === null || value === "") return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new PointsError(`${label}: от ${min} до ${max}`);
    return n;
  };
  return {
    points_on: input.points_on === true || input.points_on === "1" || input.points_on === "on",
    points_percent: num(input.points_percent, 1, 30, "Баллов от чека, %", 5),
    points_max_share: num(input.points_max_share, 1, 100, "Оплатить баллами до, % чека", 30),
    points_expire_days: num(input.points_expire_days, 30, 730, "Баллы сгорают через, дней", 180),
    points_max_check: num(input.points_max_check, 100, 10000000, "Самый большой чек, ₽", 50000)
  };
}

export function rulesText(b) {
  return `${b.points_percent}% от чека возвращается баллами · баллами можно оплатить до ${b.points_max_share}% чека · ` +
    `1 балл = 1 ₽ · баллы сгорают, если не приходить ${b.points_expire_days} дней`;
}

export async function balanceOf(env, businessId, key) {
  const rows = await db(env, `point_ops?business_id=eq.${businessId}&visitor_key=eq.${key}&select=points&limit=10000`);
  return rows.reduce((sum, r) => sum + r.points, 0);
}

// ---------- Блок на странице с карты ----------

export function pointsBlock(business, source, cardCode, balance) {
  if (!pointsOn(business) || (source !== "nfc" && source !== "qr") || balance === null || balance === undefined) return "";
  const params = new URLSearchParams({ b: business.slug, s: source });
  if (cardCode) params.set("c", cardCode);
  // Компактная строка: баланс слева, «Код для кассы» справа. Правила — на странице с кодом
  return `
    <section class="pts">
      <p class="pts-balance">💰 ${balance ? `У вас <b>${balance}</b> ${plural(balance, "балл", "балла", "баллов")}` : "Баллы с каждого чека"}</p>
      <a class="pts-btn" href="/points?${escapeHtml(params.toString())}" rel="nofollow">Код для кассы</a>
    </section>`;
}

export const POINTS_CSS = `
  .pts { margin: 18px 0 6px; padding: 14px; border-radius: 18px; border: 1px solid var(--btn-border); background: var(--btn-bg); text-align: center; }
  section.pts { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 10px 10px 16px; text-align: left; }
  .pts-balance { margin: 0 0 10px; font-size: 16px; font-weight: 650; }
  section.pts .pts-balance { margin: 0; font-size: 14.5px; }
  .pts-btn { display: block; padding: 13px 16px; border-radius: 999px; background: var(--text); color: var(--card); font-weight: 700; text-decoration: none; }
  section.pts .pts-btn { flex: none; padding: 9px 14px; font-size: 14px; }
  .pts-rules { margin: 10px 0 0; color: var(--muted); font-size: 12px; line-height: 1.4; }
  .pts-code { margin: 6px 0 4px; font-size: 44px; font-weight: 800; letter-spacing: 0.08em; font-variant-numeric: tabular-nums; }
  .pts-sub { margin: 0 0 14px; color: var(--muted); font-size: 14px; }
  .pts-done { display: inline-block; margin: 6px 0 12px; padding: 6px 14px; border-radius: 999px; border: 1px solid #22a06b; color: #22a06b; font-weight: 700; }
  .pts-link { display: inline-block; margin-top: 14px; color: var(--muted); font-size: 14px; }
`;

// ---------- GET /points — код для кассы ----------

export async function handlePointsCode(request, env) {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") return guestPage(405, null, "Откройте страницу с карты ещё раз");
    if (isBot(request)) return guestPage(403, null, "Недоступно");
    const url = new URL(request.url);
    const slug = String(url.searchParams.get("b") || "");
    const source = url.searchParams.get("s") === "qr" ? "qr" : "nfc";
    const cardCode = String(url.searchParams.get("c") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    if (!SLUG_RE.test(slug)) return guestPage(404, null, "Заведение не найдено");
    const rows = await db(env, `businesses?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=id,slug,name,theme,design,brand_color,paid_until,tariff,${POINTS_COLUMNS}&limit=1`);
    const business = rows[0];
    if (!business || !pointsOn(business) || isExpired(business.paid_until)) return guestPage(404, business || null, "Баллы в этом заведении сейчас не действуют");
    const back = `${cardCode ? `/c/${cardCode}` : `/b/${business.slug}`}?s=${source}`;

    const { deviceId, setCookie } = deviceFrom(request);
    if (setCookie) return guestPage(400, business, "Коснитесь карты заведения ещё раз и нажмите кнопку.", back);
    const key = await visitorKeyOf(env, deviceId, business.id);
    const now = Date.now();

    const latest = (await db(env, `point_codes?business_id=eq.${business.id}&visitor_key=eq.${key}&select=id,code,expires_at,used_at&order=created_at.desc&limit=1`))[0];
    // Кассир только что провёл код — показываем итог
    if (latest && latest.used_at && now - Date.parse(latest.used_at) < 2 * 60e3 && url.searchParams.get("new") !== "1") {
      const ops = await db(env, `point_ops?business_id=eq.${business.id}&visitor_key=eq.${key}&created_at=gte.${encodeURIComponent(new Date(Date.parse(latest.used_at) - 5000).toISOString())}&kind=neq.expire&select=kind,points`);
      const spent = -ops.filter((o) => o.kind === "spend").reduce((s, o) => s + o.points, 0);
      const earned = ops.filter((o) => o.kind === "earn").reduce((s, o) => s + o.points, 0);
      const balance = await balanceOf(env, business.id, key);
      return codePage(business, back, url, {
        done: true,
        body: `<p class="pts-done">✓ Готово</p>
          ${spent ? `<p class="lead">Списано <b>${spent}</b> ${plural(spent, "балл", "балла", "баллов")} — скидка ${spent} ₽</p>` : ""}
          ${earned ? `<p class="lead">Начислено <b>+${earned}</b> ${plural(earned, "балл", "балла", "баллов")}</p>` : ""}
          <p class="lead">Сейчас у вас <b>${balance}</b> ${plural(balance, "балл", "балла", "баллов")}</p>`
      });
    }
    let code = latest && !latest.used_at && Date.parse(latest.expires_at) - now > 60e3 && url.searchParams.get("new") !== "1" ? latest : null;
    if (!code) {
      if (latest && !latest.used_at) {
        await db(env, `point_codes?id=eq.${latest.id}&used_at=is.null`, { method: "PATCH", body: { expires_at: new Date(now).toISOString() }, prefer: "return=minimal" });
      }
      code = await newCode(env, business.id, key, now);
    }
    const balance = await balanceOf(env, business.id, key);
    const until = new Date(code.expires_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
    return codePage(business, back, url, {
      done: false,
      body: `<p class="lead">Покажите код кассиру</p>
        <p class="pts-code" aria-label="Код ${code.code.split("").join(" ")}">${code.code.slice(0, 3)} ${code.code.slice(3)}</p>
        <p class="pts-sub">Действует до ${until} по МСК, один раз</p>
        <p class="lead">У вас <b>${balance}</b> ${plural(balance, "балл", "балла", "баллов")}</p>
        <p class="pts-rules">${escapeHtml(rulesText(business))}</p>`
    });
  } catch (error) {
    console.error(`Points code error: ${error.message}\n${error.stack}`);
    return guestPage(500, null, "Не получилось. Попробуйте ещё раз через минуту.");
  }
}

// Случайный код, которого сейчас нет среди действующих кодов заведения
async function newCode(env, businessId, key, now) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
    const code = String(n).padStart(6, "0");
    const taken = await db(env, `point_codes?business_id=eq.${businessId}&code=eq.${code}&used_at=is.null&expires_at=gt.${encodeURIComponent(new Date(now).toISOString())}&select=id`);
    if (taken.length) continue;
    const rows = await db(env, "point_codes?select=id,code,expires_at,used_at", {
      method: "POST",
      body: { business_id: businessId, visitor_key: key, code, expires_at: new Date(now + CODE_MINUTES * 60e3).toISOString() },
      prefer: "return=representation"
    });
    return rows[0];
  }
  throw new Error("Не удалось подобрать свободный код");
}

function codePage(business, back, url, { done, body }) {
  const again = new URLSearchParams(url.searchParams);
  again.set("new", "1");
  return themed(business, {
    title: `Баллы — ${business.name}`,
    // Пока код не провели — страница обновляется сама и покажет итог
    meta: done ? "" : `<meta http-equiv="refresh" content="8">`,
    body: `
      <h1 class="name name-mid">${escapeHtml(business.name)}</h1>
      <p class="tagline">Баллы</p>
      <div class="divider"></div>
      ${body}
      ${done ? `<a class="pts-link" href="/points?${escapeHtml(again.toString())}">Новый код</a><br>` : ""}
      <a class="pts-link" href="${escapeHtml(back)}">← На страницу заведения</a>`
  });
}

function guestPage(status, business, text, back = null) {
  return themed(business, {
    status,
    title: "Баллы",
    body: `<h2 class="thanks">Баллы</h2><p class="lead">${escapeHtml(text)}</p>${back ? `<a class="pts-link" href="${escapeHtml(back)}">← На страницу заведения</a>` : ""}`
  });
}

function themed(business, { status = 200, title, body, meta = "" }) {
  const response = renderPage({
    status,
    title,
    accent: business && /^#[0-9A-Fa-f]{6}$/.test(business.brand_color || "") ? business.brand_color : (business ? null : DEFAULT_ACCENT),
    theme: business ? business.theme : "classic",
    design: business ? customDesign(business) : null,
    extraCss: POINTS_CSS,
    meta,
    footer: business ? { href: `/r/${business.slug}?s=card`, text: "Хочу такую карту" } : null,
    body
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

// ---------- Касса баллов: /k/ТОКЕН/points и /s/ТОКЕН/points ----------

export async function handleStaffPoints(request, env, token) {
  if (!TOKEN_RE.test(token)) return notFound();
  const links = await db(env, `staff_links?token=eq.${token}&select=business_id,label,staff_id`);
  if (!links.length) return notFound();
  const link = links[0];
  return pointsDesk(request, env, {
    ids: [link.business_id],
    base: `/k/${token}/points`,
    back: { href: `/k/${token}`, text: "🎁 Касса подарков" },
    by: link.label ? `персонал: ${link.label}` : "персонал",
    staffId: link.staff_id || null,
    onUse: () => db(env, `staff_links?token=eq.${token}`, { method: "PATCH", body: { last_used_at: new Date().toISOString() }, prefer: "return=minimal" }).catch(() => {})
  });
}

export async function handleOwnerPoints(request, env, token) {
  if (!TOKEN_RE.test(token)) return notFound();
  const links = await db(env, `stats_links?token=eq.${token}&select=business_id,business_ids`);
  if (!links.length) return notFound();
  const ids = [...new Set(links[0].business_ids && links[0].business_ids.length ? links[0].business_ids : [links[0].business_id])];
  return pointsDesk(request, env, { ids, base: `/s/${token}/points`, back: { href: `/s/${token}`, text: "← Статистика" }, by: "владелец", staffId: null });
}

async function pointsDesk(request, env, { ids, base, back, by, staffId, onUse }) {
  try {
    const businesses = await db(env, `businesses?id=in.(${ids.join(",")})&select=id,name,tariff,${POINTS_COLUMNS}`);
    const on = businesses.filter(pointsOn);
    if (!on.length) {
      return html(200, "Баллы", `<main class="wrap wrap-center"><section class="panel"><h1 class="lost">Баллы не включены</h1>
        <p>Баллы лояльности — в тарифах Plus и Pro. Владелец включает их в «Настройках» → «Баллы».</p>
        <a class="back back-dark" href="${back.href}">${back.text}</a></section></main>`);
    }
    const url = new URL(request.url);
    const form = request.method === "POST" ? new URLSearchParams((await request.text()).slice(0, 500)) : url.searchParams;
    const code = String(form.get("code") || "").replace(/\D/g, "");
    let panel = "";
    if (code) {
      const found = await findCode(env, code, on.map((b) => b.id));
      if (!found) {
        panel = result("bad", "Такого кода нет", "Код неверный, уже использован или прошло больше 10 минут. Попросите гостя нажать «Новый код».");
      } else {
        const business = on.find((b) => b.id === found.business_id);
        const balance = await balanceOf(env, business.id, found.visitor_key);
        if (request.method === "POST") {
          try {
            const done = await operate(env, business, found, balance, form, { by, staffId });
            if (onUse) await onUse();
            panel = result("ok", "✅ Проведено", [
              done.spend ? `Списано ${done.spend} ${plural(done.spend, "балл", "балла", "баллов")} — скидка ${done.spend} ₽. К оплате ${done.check - done.spend} ₽.` : `К оплате ${done.check} ₽.`,
              done.earn ? `Начислено ${done.earn} ${plural(done.earn, "балл", "балла", "баллов")}.` : "",
              `Баланс гостя: ${done.balance}.`
            ].filter(Boolean).join(" "));
          } catch (error) {
            if (!(error instanceof PointsError)) throw error;
            panel = result("bad", "Не проведено", error.message) + opForm(base, code, business, balance, on.length > 1);
          }
        } else {
          panel = opForm(base, code, business, balance, on.length > 1);
        }
      }
    }
    const body = `
  <header class="top">
    <div class="top-inner">
      <div class="brand">TapReview <span>· баллы</span></div>
      <a class="back" href="${back.href}">${back.text}</a>
      <h1 class="name">Баллы гостя</h1>
      ${on.length === 1 ? `<p class="sub">${esc(on[0].name)}</p>` : ""}
      <p class="range">Гость показывает код из 6 цифр. Введите его, затем сумму чека.</p>
    </div>
  </header>
  <main class="wrap">
    <section class="panel">
      <form class="desk-form" method="get" action="${base}">
        <input name="code" value="${esc(code)}" maxlength="7" inputmode="numeric" autocomplete="off" placeholder="123 456" aria-label="Код гостя" required>
        <button type="submit">Найти</button>
      </form>
      ${panel}
    </section>
    <section class="note"><p>1 балл = 1 ₽. Скидку проведите в своей кассе как обычно. Один код — одна операция; гость может взять новый код на своей странице.</p></section>
  </main>`;
    return html(200, "Баллы гостя", body);
  } catch (error) {
    console.error(`Points desk error: ${error.message}\n${error.stack}`);
    return html(500, "Ошибка", `<main class="wrap wrap-center"><section class="panel"><h1 class="lost">Не удалось провести</h1><p>Попробуйте ещё раз через минуту.</p></section></main>`);
  }
}

async function findCode(env, code, businessIds) {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const rows = await db(
    env,
    `point_codes?code=eq.${code}&business_id=in.(${businessIds.join(",")})&used_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}` +
      "&select=id,business_id,visitor_key&order=created_at.desc&limit=1"
  );
  return rows[0] || null;
}

function opForm(base, code, b, balance, showName) {
  return `<div class="desk-res desk-ok">
      <p class="desk-title">Код действует${showName ? ` · ${esc(b.name)}` : ""}</p>
      <p class="desk-prize">${balance} ${plural(balance, "балл", "балла", "баллов")}</p>
      <p>${esc(rulesText(b))}</p>
    </div>
    <form class="pts-op" method="post" action="${base}">
      <input type="hidden" name="code" value="${esc(code)}">
      <label>Сумма чека, ₽<input name="check" type="number" min="1" max="${b.points_max_check}" inputmode="numeric" required></label>
      ${balance > 0 ? `<label>Списать баллов (необязательно, до ${b.points_max_share}% чека)<input name="spend" type="number" min="0" max="${balance}" inputmode="numeric" placeholder="0"></label>` : ""}
      <button type="submit">Провести</button>
    </form>
    <style>.pts-op{display:grid;gap:10px;margin-top:12px}.pts-op label{display:grid;gap:4px;font-weight:600;font-size:14px}
      .pts-op input{padding:12px;border-radius:12px;border:1px solid #d6dbe5;font:inherit;font-size:18px}
      .pts-op button{padding:14px;border-radius:999px;border:0;background:#0a2a5c;color:#fff;font:inherit;font-weight:700;cursor:pointer}</style>`;
}

function result(kind, title, text) {
  return `<div class="desk-res ${kind === "ok" ? "desk-ok" : "desk-bad"}"><p class="desk-title">${esc(title)}</p><p>${esc(text)}</p></div>`;
}

// Списание и начисление по одному коду
async function operate(env, b, found, balance, form, { by, staffId }) {
  const check = Number(form.get("check"));
  const spend = form.get("spend") === null || form.get("spend") === "" ? 0 : Number(form.get("spend"));
  if (!Number.isInteger(check) || check < 1) throw new PointsError("Укажите сумму чека в рублях");
  if (check > b.points_max_check) throw new PointsError(`Чек больше ${b.points_max_check} ₽ — так много нельзя. Если всё верно, владелец может поднять лимит в настройках.`);
  if (!Number.isInteger(spend) || spend < 0) throw new PointsError("Списать: целое число баллов");
  const maxSpend = Math.min(balance, Math.floor((check * b.points_max_share) / 100));
  if (spend > maxSpend) throw new PointsError(`Можно списать не больше ${maxSpend} ${plural(maxSpend, "балла", "баллов", "баллов")} (баланс ${balance}, до ${b.points_max_share}% чека)`);
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const dayStart = new Date(`${today}T00:00:00+03:00`).toISOString();
  const todayOps = await db(env, `point_ops?business_id=eq.${b.id}&visitor_key=eq.${found.visitor_key}&kind=eq.earn&created_at=gte.${encodeURIComponent(dayStart)}&select=id`);
  if (todayOps.length >= OPS_PER_DAY) throw new PointsError(`У гостя уже ${OPS_PER_DAY} операций сегодня — это похоже на ошибку. Попробуйте завтра.`);
  // Код одноразовый: отмечаем, только если его ещё никто не провёл
  const used = await db(env, `point_codes?id=eq.${found.id}&used_at=is.null&select=id`, {
    method: "PATCH", body: { used_at: new Date().toISOString() }, prefer: "return=representation"
  });
  if (!used.length) throw new PointsError("Этот код уже провели");
  const earn = Math.floor(((check - spend) * b.points_percent) / 100);
  const row = (kind, points) => ({ business_id: b.id, visitor_key: found.visitor_key, kind, points, check_sum: check, by_label: String(by).slice(0, 80), staff_id: staffId });
  const ops = [];
  if (spend) ops.push(row("spend", -spend));
  if (earn) ops.push(row("earn", earn));
  if (ops.length) await db(env, "point_ops", { method: "POST", body: ops, prefer: "return=minimal" });
  return { check, spend, earn, balance: balance - spend + earn };
}

// ---------- Статистика и обслуживание ----------

export async function pointsStats(env, ids, { from, to }) {
  const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());
  const [period, all] = await Promise.all([
    db(env, `point_ops?business_id=in.(${ids.join(",")})&created_at=gte.${iso(from)}&created_at=lte.${iso(to)}&select=kind,points,visitor_key&limit=50000`),
    db(env, `point_ops?business_id=in.(${ids.join(",")})&select=business_id,visitor_key,points&limit=200000`)
  ]);
  const sum = (kind) => Math.abs(period.filter((o) => o.kind === kind).reduce((s, o) => s + o.points, 0));
  const balances = new Map();
  for (const o of all) balances.set(`${o.business_id}|${o.visitor_key}`, (balances.get(`${o.business_id}|${o.visitor_key}`) || 0) + o.points);
  const holders = [...balances.values()].filter((v) => v > 0);
  return {
    earned: sum("earn"),
    spent: sum("spend"),
    expired: sum("expire"),
    guests: new Set(period.filter((o) => o.kind !== "expire").map((o) => o.visitor_key)).size,
    holders: holders.length,
    outstanding: holders.reduce((s, v) => s + v, 0)
  };
}

export function pointsSection(s, token) {
  if (!s) return "";
  return `
    <section class="panel">
      <h2>Баллы гостей</h2>
      <div class="kpis desk-kpis">
        <div class="kpi"><div class="kpi-label">Начислено</div><div class="kpi-value">${s.earned}</div></div>
        <div class="kpi"><div class="kpi-label">Списано (₽ скидок)</div><div class="kpi-value">${s.spent}</div></div>
      </div>
      <p>За период баллами пользовались гостей: ${s.guests}${s.expired ? ` · сгорело баллов: ${s.expired}` : ""}.
        Сейчас баллы копят ${s.holders} ${plural(s.holders, "гость", "гостя", "гостей")}, всего на счетах ${s.outstanding} ${plural(s.outstanding, "балл", "балла", "баллов")} (это ваши будущие скидки).</p>
      <a class="desk-link" href="/s/${token}/points">💰 Провести баллы гостя</a>
    </section>`;
}

// Раз в день: сгорание баллов и чистка старых кодов
export async function pointsDaily(env) {
  await db(env, "rpc/points_expire", { method: "POST", body: {} });
  const before = encodeURIComponent(new Date(Date.now() - 2 * 86400e3).toISOString());
  await db(env, `point_codes?expires_at=lt.${before}`, { method: "DELETE", prefer: "return=minimal" });
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
