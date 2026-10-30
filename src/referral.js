// Рекомендации: «карта как реклама» и «приведи знакомое заведение — месяц бесплатно обоим».
//
//   GET /r/:slug?s=card — переход со страницы отзывов заведения («Хочу такую карту»)
//   GET /r/:slug?s=link — владелец поделился своей ссылкой-приглашением
// Записываем переход (без персональных данных) и ведём на главную с ?ref=slug — главная и калькулятор
// запоминают приглашение и показывают «первый месяц подписки в подарок».
// Награду (+1 месяц обоим) выдаёт администратор в админке, когда приглашённый начал платить.

import { db } from "./supabase.js";
import { isBot } from "./analytics.js";

const SLUG_RE = /^[A-Za-z0-9]{4,32}$/;
const DAY = 24 * 60 * 60 * 1000;

export function refUrl(env, slug, source = "link") {
  return `${String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "")}/r/${slug}?s=${source}`;
}

export async function handleRef(request, env, ctx, slug) {
  const home = new URL("/", request.url);
  if (!SLUG_RE.test(slug)) return Response.redirect(home.toString(), 302);
  try {
    const rows = await db(env, `businesses?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=id&limit=1`);
    if (!rows.length) return Response.redirect(home.toString(), 302);
    const source = new URL(request.url).searchParams.get("s") === "card" ? "card" : "link";
    if (!isBot(request)) {
      ctx.waitUntil(
        db(env, "ref_visits", { method: "POST", body: { business_id: rows[0].id, source }, prefer: "return=minimal" })
          .catch((error) => console.error(`ref_visits: ${error.message}`))
      );
    }
    home.searchParams.set("ref", slug);
    return new Response(null, { status: 302, headers: { Location: home.toString(), "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`Ref error: ${error.message}`);
    return Response.redirect(home.toString(), 302);
  }
}

// Для владельца и админки: переходы по ссылкам за 30 дней и кого заведение уже привело
export async function refStats(env, businessId) {
  const since = new Date(Date.now() - 30 * DAY).toISOString();
  const [visits, invited] = await Promise.all([
    db(env, `ref_visits?business_id=eq.${businessId}&created_at=gt.${encodeURIComponent(since)}&select=source&limit=10000`),
    db(env, `businesses?referred_by=eq.${businessId}&select=id,name,paid_until,ref_reward_at,created_at&order=created_at.asc`)
  ]);
  const card = visits.filter((v) => v.source === "card").length;
  return { visits: { card, link: visits.length - card }, invited };
}
