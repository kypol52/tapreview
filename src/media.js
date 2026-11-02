// Картинки «Своего дизайна» (миграция 022): фон-фото заведения и логотип; фото блока «Сейчас у нас» (025).
//   GET /m/:id — отдать картинку (кэш браузера на год: у новой картинки всегда новый id)
// Загрузка — из админки (admin-api.js → saveMedia): браузер уже сжал картинку,
// здесь проверяем тип по первым байтам и размер.

import { db } from "./supabase.js";

export const MEDIA_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 700 * 1024;

// Небольшой кэш в памяти сервера, чтобы не читать базу на каждый показ
const cache = new Map();
const CACHE_MAX = 40;

export async function handleMedia(request, env, id) {
  if (!MEDIA_ID_RE.test(id)) return notFound();
  let item = cache.get(id);
  if (!item) {
    const rows = await db(env, `media?id=eq.${id}&select=mime,data&limit=1`);
    if (!rows.length) return notFound();
    item = { mime: rows[0].mime, bytes: Uint8Array.from(atob(rows[0].data), (c) => c.charCodeAt(0)) };
    cache.set(id, item);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return new Response(item.bytes, {
    headers: {
      "Content-Type": item.mime,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

// dataUrl — "data:image/jpeg;base64,...". Возвращает id или бросает Error с понятным текстом.
export async function saveMedia(env, kind, dataUrl) {
  if (!["bg", "logo", "moment"].includes(kind)) throw new Error("Неизвестный тип картинки");
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!match) throw new Error("Картинка должна быть JPG, PNG или WebP");
  const [, mime, data] = match;
  const bytes = Uint8Array.from(atob(data.slice(0, 64)), (c) => c.charCodeAt(0));
  if (sniff(bytes) !== mime) throw new Error("Файл не похож на картинку");
  if (Math.floor((data.length * 3) / 4) > MAX_BYTES) throw new Error("Картинка больше 700 КБ — выберите поменьше");
  const rows = await db(env, "media?select=id", {
    method: "POST",
    body: { kind, mime, data },
    prefer: "return=representation"
  });
  return rows[0].id;
}

function sniff(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return null;
}

function notFound() {
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
