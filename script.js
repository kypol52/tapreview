const SUPABASE_URL = "https://snrnusvqqrhnljcmnncb.supabase.co";
const SUPABASE_KEY = "sb_publishable_6tOGONYM3yQkS8ZOeJDLHQ_f9u75f0d";

// Берём slug из ?slug=abc или из адреса вида /b/abc
function getSlug() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("slug");
  if (fromQuery) return fromQuery.trim();

  const match = window.location.pathname.match(/\/b\/([A-Za-z0-9_-]+)\/?$/);
  return match ? match[1] : null;
}

// Разрешаем только https-ссылки
function isSafeUrl(value) {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// Показывает сообщение вместо кнопок (не найдено / ошибка)
function showMessage(title, text) {
  document.title = title;
  document.getElementById("businessName").textContent = title;
  document.querySelector(".card p").textContent = text;
  document.querySelectorAll(".button").forEach((b) => b.remove());
}

// Включает кнопку, если ссылка есть, иначе убирает её со страницы
function setupButton(id, url) {
  const button = document.getElementById(id);
  if (isSafeUrl(url)) {
    button.href = url;
    button.rel = "noopener";
    button.classList.remove("disabled");
    return true;
  }
  button.remove();
  return false;
}

async function loadBusiness() {
  const slug = getSlug();

  if (!slug || !/^[A-Za-z0-9_-]{1,64}$/.test(slug)) {
    showMessage("Страница не найдена", "Проверьте ссылку или отсканируйте карту ещё раз.");
    return;
  }

  const url =
    `${SUPABASE_URL}/rest/v1/businesses` +
    `?slug=eq.${encodeURIComponent(slug)}` +
    `&select=name,google_url,yandex_url,twogis_url&limit=1`;

  try {
    const response = await fetch(url, {
      headers: { apikey: SUPABASE_KEY }
    });

    if (!response.ok) {
      console.error("SUPABASE ERROR:", response.status, await response.text());
      throw new Error("Ошибка Supabase");
    }

    const businesses = await response.json();

    if (!businesses.length) {
      showMessage("Страница не найдена", "Такого бизнеса нет или ссылка устарела.");
      return;
    }

    const business = businesses[0];
    document.title = `Отзыв — ${business.name}`;
    document.getElementById("businessName").textContent = business.name;

    const shown = [
      setupButton("google", business.google_url),
      setupButton("yandex", business.yandex_url),
      setupButton("twogis", business.twogis_url)
    ].filter(Boolean).length;

    if (shown === 0) {
      document.querySelector(".card p").textContent =
        "Спасибо за ваш визит! Ссылки для отзывов скоро появятся.";
    }
  } catch (error) {
    console.error(error);
    showMessage("Не удалось загрузить", "Проверьте интернет и обновите страницу.");
  }
}

loadBusiness();

5. Нажмите зелёную кнопку Commit changes…, затем ещё раз Commit changes.

Файл 2: 404.html

Сделайте то же самое (открыть → ✏️ → выделить всё → вставить → Commit):

<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>TapReview</title>
  <script>
    const repo = "/tapreview";
    let path = window.location.pathname;

    if (path.startsWith(repo)) path = path.slice(repo.length);
    path = path.replace(/^\/+|\/+$/g, "");

    // Принимаем "b/abc123" и просто "abc123"
    const match = path.match(/^(?:b\/)?([A-Za-z0-9_-]+)$/);

    window.location.replace(
      match ? `${repo}/?slug=${encodeURIComponent(match[1])}` : `${repo}/?slug=`
    );
  </script>
</head>
<body>
  Загрузка...
</body>
</html>
