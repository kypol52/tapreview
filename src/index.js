// TapReview — серверная часть (Cloudflare Worker).
//   /b/:slug             — публичная страница бизнеса (public-page.js)
//   /c/:code             — шаблонная карта: страница привязанного бизнеса или «не активирована»
//   /p/:slug             — «Поделиться» заведением из каталога Mini App: превью с фото и рейтингом (share-page.js)
//   /g/:slug           — страница группы: список заведений, ведёт на их /b/:slug (public-page.js)
//   /go/:slug/:platform — учёт клика и переход на Google / Яндекс / 2ГИС (public-page.js)
//   /api/order           — заявка с сайта: калькулятор и форма на /order/ (orders.js)
//   /api/app/...         — Telegram Mini App: каталог, отзывы, избранное (app-api.js); само приложение — /app/
//   /api/...             — API админ-панели (admin-api.js)
//   /tg/webhook          — сообщения Telegram-боту для владельцев (telegram.js)
//   /s/:token            — статистика для владельца по личной ссылке (stats-page.js)
//   /s/:token/bonus      — касса владельца: проверить и погасить код подарка + счётчики (stats-page.js)
//   /s/:token/wrapped    — «Итоги месяца» для владельца (wrapped.js)
//   /s/:token/settings   — «Настройки» владельца: «Сейчас у нас», подарки, ссылки (owner-settings.js)
//   POST /s/:token/fb    — владелец отмечает сообщение гостя «Разобрано» (stats-page.js)
//   /k/:token            — касса для персонала: только проверить и погасить код (stats-page.js)
//   /k/:token/calls      — вызовы гостей для персонала: «Сервис в зале» (service.js)
//   GET /call            — гость зовёт сотрудника со стола (service.js)
//   GET /points          — одноразовый код гостя для кассы баллов (points.js)
//   /k/:token/points, /s/:token/points — касса баллов: персонал и владелец (points.js)
//   POST /bonus          — выдать гостю код подарка, колесо призов (bonus.js)
//   /f/:code             — «Подарите другу»: подарок новому гостю по приглашению (friends.js)
//   /m/:id               — картинки «Своего дизайна»: фон и логотип заведения (media.js)
//   /r/:slug             — ссылка-приглашение заведения: учёт перехода → главная с ?ref= (referral.js)
// Все остальные адреса отдаются как обычные файлы (index.html, admin/, 404.html и т.д.).

import { handleBusinessPage, handleCardPage, handleGroupPage, handleGo } from "./public-page.js";
import { handleApi } from "./admin-api.js";
import { handleTelegramWebhook, handleTelegramRelay, weeklyReports } from "./telegram.js";
import { handleStatsPage, handleBonusDesk, handleStaffDesk, handleFeedbackResolve } from "./stats-page.js";
import { handleBonus } from "./bonus.js";
import { handleOwnerSettings } from "./owner-settings.js";
import { purgeOldVisits } from "./guests.js";
import { handleFriend } from "./friends.js";
import { handleWrapped, monthlyWrapped } from "./wrapped.js";
import { handleRef } from "./referral.js";
import { handleOrder, orderReminders } from "./orders.js";
import { handleFeedback, purgeOldPhones, feedbackReminders, RECOVERY_CRON } from "./rating.js";
import { handleMedia } from "./media.js";
import { uptimeCheck, UPTIME_CRON } from "./uptime.js";
import { handleAppApi } from "./app-api.js";
import { handleSharePage, handleShareProxy } from "./share-page.js";
import { handleMeLink } from "./guest-wallet.js";
import { handleCall, handleStaffCalls, purgeOldCalls } from "./service.js";
import { handlePointsCode, handleStaffPoints, handleOwnerPoints, pointsDaily } from "./points.js";
import { db } from "./supabase.js";

// Должно совпадать с расписанием в server/server.mjs
const WEEKLY_REPORT_CRON = "0 6 * * 1";
const DAILY_CRON = "0 6 * * *";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isRead = request.method === "GET" || request.method === "HEAD";

    // Только на Cloudflare Worker (share.tapreview.ru, задано SHARE_ORIGIN): превью ссылок для Telegram (share-page.js)
    if (env.SHARE_ORIGIN) {
      const shared = await handleShareProxy(request, env, url);
      if (shared) return shared;
    }

    // Cloudflare Worker без базы (после переезда в РФ): только посредник для Telegram и превью ссылок,
    // остальные адреса — на основной сайт
    if (!env.DB_URL && !env.SUPABASE_URL) {
      if (url.pathname.startsWith("/tg-api/") || url.pathname === "/tg-hook") {
        return handleTelegramRelay(request, env, url.pathname);
      }
      const base = String(env.PUBLIC_BASE_URL || "https://tapreview.ru").replace(/\/+$/, "");
      // Основной адрес совпадает с этим (ошибка настройки) — отдаём файлы, а не перенаправляем по кругу
      if (new URL(base).host === url.host) return env.ASSETS.fetch(request);
      return Response.redirect(`${base}${url.pathname}${url.search}`, 301);
    }

    const pageMatch = url.pathname.match(/^\/b\/([^/]+)\/?$/);
    if (pageMatch && isRead) {
      return handleBusinessPage(request, env, ctx, pageMatch[1]);
    }

    const cardMatch = url.pathname.match(/^\/c\/([^/]+)\/?$/);
    if (cardMatch && isRead) {
      return handleCardPage(request, env, ctx, cardMatch[1]);
    }

    // «Мои штампы и подарки — в Telegram» со страницы карты: одноразовая ссылка в Mini App (guest-wallet.js)
    if (url.pathname === "/me-link" && isRead) {
      return handleMeLink(request, env);
    }

    const shareMatch = url.pathname.match(/^\/p\/([^/]+)\/?$/);
    if (shareMatch && isRead) {
      return handleSharePage(request, env, shareMatch[1]);
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

    const friendMatch = url.pathname.match(/^\/f\/([^/]+)\/?$/);
    if (friendMatch && isRead) {
      return handleFriend(request, env, friendMatch[1]);
    }

    const mediaMatch = url.pathname.match(/^\/m\/([^/]+)$/);
    if (mediaMatch && isRead) {
      return handleMedia(request, env, mediaMatch[1]);
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

    const wrappedMatch = url.pathname.match(/^\/s\/([^/]+)\/wrapped\/?$/);
    if (wrappedMatch && isRead) {
      return handleWrapped(request, env, wrappedMatch[1]);
    }

    const settingsMatch = url.pathname.match(/^\/s\/([^/]+)\/settings\/?$/);
    if (settingsMatch && (isRead || request.method === "POST")) {
      return handleOwnerSettings(request, env, settingsMatch[1]);
    }

    const fbMatch = url.pathname.match(/^\/s\/([^/]+)\/fb\/?$/);
    if (fbMatch && request.method === "POST") {
      return handleFeedbackResolve(request, env, fbMatch[1]);
    }

    // «Сервис в зале» (service.js): гость зовёт сотрудника со стола, персонал видит вызовы
    if (url.pathname === "/call") {
      return handleCall(request, env, ctx);
    }
    // Баллы лояльности (points.js): код гостя для кассы и касса баллов персонала / владельца
    if (url.pathname === "/points") {
      return handlePointsCode(request, env);
    }
    const staffPointsMatch = url.pathname.match(/^\/k\/([^/]+)\/points\/?$/);
    if (staffPointsMatch && (isRead || request.method === "POST")) {
      return handleStaffPoints(request, env, staffPointsMatch[1]);
    }
    const ownerPointsMatch = url.pathname.match(/^\/s\/([^/]+)\/points\/?$/);
    if (ownerPointsMatch && (isRead || request.method === "POST")) {
      return handleOwnerPoints(request, env, ownerPointsMatch[1]);
    }

    const callsMatch = url.pathname.match(/^\/k\/([^/]+)\/calls\/?$/);
    if (callsMatch && (isRead || request.method === "POST")) {
      return handleStaffCalls(request, env, callsMatch[1]);
    }

    const staffMatch = url.pathname.match(/^\/k\/([^/]+)\/?$/);
    if (staffMatch) {
      return handleStaffDesk(request, env, staffMatch[1]);
    }

    if (url.pathname === "/api/order") {
      return handleOrder(request, env, ctx);
    }

    if (url.pathname.startsWith("/api/app/")) {
      return handleAppApi(request, env, url);
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
    // На Cloudflare (без своей базы) расписание только одно — сторож сайта (uptime.js)
    if (!env.DB_URL) {
      if (controller.cron === UPTIME_CRON) ctx.waitUntil(uptimeCheck(env).catch((e) => console.error(`Uptime: ${e.message}`)));
      return;
    }
    // Каждые 10 минут — напоминания о неразобранных сообщениях недовольных гостей (rating.js)
    if (controller.cron === RECOVERY_CRON) {
      ctx.waitUntil(feedbackReminders(env).catch((error) => console.error(`Feedback reminders failed: ${error.message}`)));
      return;
    }
    if (controller.cron === DAILY_CRON) {
      ctx.waitUntil(
        orderReminders(env).catch((error) => console.error(`Order reminders failed: ${error.message}\n${error.stack}`))
      );
      ctx.waitUntil(purgeOldPhones(env).catch((error) => console.error(`Phone purge failed: ${error.message}`)));
      ctx.waitUntil(purgeOldVisits(env).catch((error) => console.error(`Visits purge failed: ${error.message}`)));
      ctx.waitUntil(purgeOldCalls(env).catch((error) => console.error(`Calls purge failed: ${error.message}`)));
      ctx.waitUntil(pointsDaily(env).catch((error) => console.error(`Points daily failed: ${error.message}`)));
      // 1-го числа — «Итоги месяца» владельцам в Telegram (внутри проверка даты)
      ctx.waitUntil(monthlyWrapped(env).catch((error) => console.error(`Monthly wrapped failed: ${error.message}`)));
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
