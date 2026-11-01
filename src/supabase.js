// Запросы к базе с секретным ключом. Этот код работает только на сервере — ключ не попадает в браузер.
//
// Два режима:
//   DB_URL задан  — свой сервер в России: PostgreSQL + PostgREST на том же сервере (http://127.0.0.1:3000),
//                   доступен только изнутри сервера, ключ не нужен.
//   DB_URL не задан — Supabase (как раньше): SUPABASE_URL + SUPABASE_SECRET_KEY.
// Запросы одинаковые (PostgREST), поэтому остальной код не зависит от того, где база.

export async function db(env, path, options = {}) {
  let url;
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json"
  };

  if (env.DB_URL) {
    url = `${String(env.DB_URL).replace(/\/+$/, "")}/${path}`;
  } else {
    if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
      throw new Error("Не заданы DB_URL или SUPABASE_URL + SUPABASE_SECRET_KEY");
    }
    url = `${env.SUPABASE_URL}/rest/v1/${path}`;
    headers.apikey = env.SUPABASE_SECRET_KEY;
  }
  if (options.prefer) {
    headers.Prefer = options.prefer;
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(`База ${response.status}: ${text}`);
    error.code = data && data.code;
    throw error;
  }
  return data;
}
