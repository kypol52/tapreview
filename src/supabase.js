// Запросы к базе Supabase с секретным ключом.
// Этот код работает только на сервере Cloudflare — ключ не попадает в браузер.

export async function db(env, path, options = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    throw new Error(
      "Не заданы SUPABASE_URL или секрет SUPABASE_SECRET_KEY (Cloudflare → Worker → Settings → Variables and Secrets)"
    );
  }

  const headers = {
    apikey: env.SUPABASE_SECRET_KEY,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  if (options.prefer) {
    headers.Prefer = options.prefer;
  }

  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(`Supabase ${response.status}: ${text}`);
    error.code = data && data.code;
    throw error;
  }
  return data;
}
