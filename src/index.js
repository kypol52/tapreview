// TapReview — серверная часть (Cloudflare Worker).
//   /b/:slug             — публичная страница бизнеса (public-page.js)
//   /c/:code             — шаблонная карта: страница привязанного бизнеса или «не активирована»
//   /g/:slug           — страница группы: список заведений, ведёт на их /b/:slug (public-page.js)
//   /go/:slug/:platform — учёт клика и переход на Google / Яндекс / 2ГИС (public-page.js)
//   /api/order           — заявка с сайта: калькулятор и форма на /order/ (orders.js)
//   /api/...             — API админ-панели (admin-api.js)
//   /tg/webhook          — сообщения Telegram-боту для владельцев (telegram.js)
//   /s/:token            — статистика для владельца по личной ссылке (stats-page.js)
//   /s/:token/bonus      — касса владельца: проверить и погасить код подарка + счётчики (stats-page.js)
//   /k/:token            — касса для персонала: только проверить и погасить код (stats-page.js)
//   POST /bonus          — выдать гостю код подарка, колесо призов (bonus.js)
//   /r/:slug             — ссылка-приглашение заведения: учёт перехода → главная с ?ref= (referral.js)
// Все остальные адреса отдаются как обычные файлы (index.html, admin/, 404.html и т.д.).

import { handleBusinessPage, handleCardPage, handleGroupPage, handleGo } from "./public-page.js";
import { handleApi } from "./admin-api.js";
import { handleTelegramWebhook, handleTelegramRelay, weeklyReports } from "./telegram.js";
import { handleStatsPage, handleBonusDesk, handleStaffDesk } from "./stats-page.js";
import { handleBonus } from "./bonus.js";
import { handleRef } from "./referral.js";
import { handleOrder, orderReminders } from "./orders.js";
import { handleFeedback } from "./rating.js";
import { db } from "./supabase.js";

// Должно совпадать с расписанием в server/server.mjs
const WEEKLY_REPORT_CRON = "0 6 * * 1";
const DAILY_CRON = "0 6 * * *";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isRead = request.method === "GET" || request.method === "HEAD";

    const pageMatch = url.pathname.match(/^\/b\/([^/]+)\/?$/);
    if (pageMatch && isRead) {
      return handleBusinessPage(request, env, ctx, pageMatch[1]);
    }

    const cardMatch = url.pathname.match(/^\/c\/([^/]+)\/?$/);
    if (cardMatch && isRead) {
      return handleCardPage(request, env, ctx, cardMatch[1]);
    }

    const groupMatch = url.pathname.match(/^\/g\/([^/]+)\/?$/);
    if (groupMatch && isRead) {
      return handleGroupPage(request, env, groupMatch[1]);
    }

    const goMatch = url.pathname.match(/^\/go\/([^/]+)\/([a-z0-9]+)\/?$/);
    if (goMatch && isRead) {
      return handleGo(request, env, ctx, goMatch[1], goMatch[2]);
    }

    const refMatch = url.pathname.match(/^\/r\/([^/]+)\/?$/);
    if (refMatch && isRead) {
      return handleRef(request, env, ctx, refMatch[1]);
    }

    if (url.pathname === "/feedback") {
      return handleFeedback(request, env, ctx);
    }

    if (url.pathname === "/bonus") {
      return handleBonus(request, env);
    }

    const deskMatch = url.pathname.match(/^\/s\/([^/]+)\/bonus\/?$/);
    if (deskMatch) {
      return handleBonusDesk(request, env, deskMatch[1]);
    }

    const staffMatch = url.pathname.match(/^\/k\/([^/]+)\/?$/);
    if (staffMatch) {
      return handleStaffDesk(request, env, staffMatch[1]);
    }

    if (url.pathname === "/api/order") {
      return handleOrder(request, env, ctx);
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    const statsMatch = url.pathname.match(/^\/s\/([^/]+)\/?$/);
    if (statsMatch && isRead) {
      return handleStatsPage(request, env, ctx, statsMatch[1]);
    }

    // Посредник для Telegram — работает только там, где задан TG_RELAY_KEY (Cloudflare Worker)
    if (url.pathname.startsWith("/tg-api/") || url.pathname === "/tg-hook") {
      return handleTelegramRelay(request, env, url.pathname);
    }

    if (url.pathname === "/tg/webhook" && request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }

    return env.ASSETS.fetch(request);
  },

  // Расписание задаёт server/server.mjs (свой сервер в РФ):
  //  - по понедельникам в 09:00 МСК — отчёт за неделю владельцам в Telegram;
  //  - каждый день в 09:00 МСК — напоминания по заявкам (воронка в админке).
  // Старый Cloudflare Worker теперь только посредник для Telegram: у него нет DB_URL, и по расписанию
  // он ничего не делает — иначе разослал бы отчёты по устаревшей базе Supabase.
  async scheduled(controller, env, ctx) {
    if (!env.DB_URL) return;
    if (controller.cron === DAILY_CRON) {
      ctx.waitUntil(
        orderReminders(env).catch((error) => console.error(`Order reminders failed: ${error.message}\n${error.stack}`))
      );
      return;
    }
    if (controller.cron === WEEKLY_REPORT_CRON) {
      ctx.waitUntil(
        weeklyReports(env).catch((error) => console.error(`Weekly reports failed: ${error.message}\n${error.stack}`))
      );
      return;
    }
    ctx.waitUntil(keepDatabaseAwake(env));
  }
};

async function keepDatabaseAwake(env) {
  try {
    await db(env, "businesses?select=id&limit=1");
    console.log("Supabase keep-alive: ok");
  } catch (error) {
    console.error(`Supabase keep-alive failed: ${error.message}`);
  }
}
