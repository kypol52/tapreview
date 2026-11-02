// Сторож сайта: работает только на Cloudflare Worker (снаружи России), каждые 5 минут
// открывает https://tapreview.ru/health на нашем сервере. Если сайт или база не отвечают
// (две попытки подряд) или копия базы на Яндекс Диске старше 2 суток — пишет администратору в Telegram.
// Повторное сообщение — не чаще раза в 30 минут, и одно «снова работает», когда всё починилось.
//
// Секреты Worker (Settings → Variables and Secrets, тип Secret): TG_BOT_TOKEN, ALERT_CHAT_ID (можно несколько через запятую).

import { tg } from "./telegram.js";

export const UPTIME_CRON = "*/5 * * * *";
const REMIND_S = 30 * 60;
const BACKUP_MAX_HOURS = 48;

export async function uptimeCheck(env) {
  if (!env.TG_BOT_TOKEN || !env.ALERT_CHAT_ID) return;
  const base = String(env.PUBLIC_BASE_URL || "https://tapreview.ru").replace(/\/+$/, "");

  let problem = await probe(base);
  if (problem && !problem.startsWith("Копия")) {
    await new Promise((r) => setTimeout(r, 15000)); // разовый сбой сети — не тревога
    problem = await probe(base);
  }

  // Память между проверками — в самом Worker (между запусками обычно сохраняется; если Cloudflare
  // перезапустит Worker, в худшем случае придёт лишнее повторное сообщение)
  if (problem) {
    if (lastAlertAt && Date.now() - lastAlertAt < REMIND_S * 1000) return;
    await notify(env, `🚨 TapReview: ${problem}`);
    lastAlertAt = Date.now();
  } else if (lastAlertAt) {
    lastAlertAt = 0;
    await notify(env, "✅ TapReview снова работает");
  }
}

// ALERT_CHAT_ID — один chat_id или несколько через запятую
async function notify(env, text) {
  const ids = String(env.ALERT_CHAT_ID).split(",").map((s) => s.trim()).filter(Boolean);
  await Promise.allSettled(ids.map((chat_id) => tg(env, "sendMessage", { chat_id, text })));
}

let lastAlertAt = 0;

async function probe(base) {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10000), headers: { "Cache-Control": "no-cache" } });
    const data = await r.json().catch(() => null);
    if (!data) return `сайт не отвечает (HTTP ${r.status})`;
    if (data.db !== "ok") return "сайт работает, но база данных не отвечает";
    if (data.backup_hours != null && data.backup_hours > BACKUP_MAX_HOURS) {
      return `Копия базы на Яндекс Диске не обновлялась ${data.backup_hours} ч — проверьте сервер`;
    }
    return null;
  } catch (error) {
    return `сайт не открывается (${error.name === "TimeoutError" ? "нет ответа 10 с" : "ошибка соединения"})`;
  }
}
