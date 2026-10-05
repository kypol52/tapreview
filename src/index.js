// TapReview — серверная часть (Cloudflare Worker).
//   /b/:slug             — публичная страница бизнеса (public-page.js)
//   /go/:slug/:platform  — учёт клика и переход на Google / Яндекс / 2ГИС (public-page.js)
//   /api/...             — API админ-панели (admin-api.js)
// Все остальные адреса отдаются как обычные файлы (index.html, admin/, 404.html и т.д.).

import { handleBusinessPage, handleGo } from "./public-page.js";
import { handleApi } from "./admin-api.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isRead = request.method === "GET" || request.method === "HEAD";

    const pageMatch = url.pathname.match(/^\/b\/([^/]+)\/?$/);
    if (pageMatch && isRead) {
      return handleBusinessPage(request, env, ctx, pageMatch[1]);
    }

    const goMatch = url.pathname.match(/^\/go\/([^/]+)\/([a-z0-9]+)\/?$/);
    if (goMatch && isRead) {
      return handleGo(request, env, ctx, goMatch[1], goMatch[2]);
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    return env.ASSETS.fetch(request);
  }
};
