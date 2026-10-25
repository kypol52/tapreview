// TapReview — серверная часть (Cloudflare Worker).
//   /b/:slug             — публичная страница бизнеса (public-page.js)
//   /c/:code             — шаблонная карта: страница привязанного бизнеса или «не активирована»
//   /g/:slug           — страница группы: список заведений, ведёт на их /b/:slug (public-page.js)
//   /go/:slug/:platform — учёт клика и переход на Google / Яндекс / 2ГИС (public-page.js)
//   /api/...             — API админ-панели (admin-api.js)
//   /tg/webhook          — сообщения Telegram-боту для владельцев (telegram.js)
// Все остальные адреса отдаются как обычные файлы (index.html, admin/, 404.html и т.д.).

import { handleBusinessPage, handleCardPage, handleGroupPage, handleGo } from "./public-page.js";
import { handleApi } from "./admin-api.js";
import { handleTelegramWebhook, weeklyReports } from "./telegram.js";
import { db } from "./supabase.js";

// Должно совпадать с расписанием в wrangler.jsonc ("crons")
const WEEKLY_REPORT_CRON = "0 6 * * 1";

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

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    if (url.pathname === "/tg/webhook" && request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }

    return env.ASSETS.fetch(request);
  },

  // Расписание — в wrangler.jsonc ("crons"):
  //  - по понедельникам в 09:00 МСК — отчёт за неделю владельцам в Telegram;
  //  - каждый день — маленький запрос к базе, чтобы бесплатный Supabase не приостановился.
  async scheduled(controller, env, ctx) {
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
