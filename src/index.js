// TapReview — серверная часть (Cloudflare Worker).
//   /b/:slug  — публичная страница бизнеса (public-page.js)
//   /api/...  — API админ-панели (admin-api.js)
// Все остальные адреса отдаются как обычные файлы (index.html, admin/, 404.html и т.д.).

import { handleBusinessPage } from "./public-page.js";
import { handleApi } from "./admin-api.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const pageMatch = url.pathname.match(/^\/b\/([^/]+)\/?$/);
    if (pageMatch && (request.method === "GET" || request.method === "HEAD")) {
      return handleBusinessPage(env, pageMatch[1]);
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    return env.ASSETS.fetch(request);
  }
};
