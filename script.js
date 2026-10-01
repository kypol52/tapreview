const SUPABASE_URL = "https://snrnusvqqrhnljcmnncb.supabase.co";
const SUPABASE_KEY = "sb_publishable_6tOGONYM3yQkS8ZOeJDLHQ_f9u75f0d";

async function loadBusiness() {
  const path = window.location.pathname.split("/").filter(Boolean);
  const slug = path[path.length - 1] || "test";

  const url =
    `${SUPABASE_URL}/rest/v1/businesses` +
    `?slug=eq.${encodeURIComponent(slug)}&select=*`;

  try {
    const response = await fetch(url, {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`
      }
    });

    if (!response.ok) {
      throw new Error("Ошибка Supabase");
    }

    const businesses = await response.json();

    if (!businesses.length) {
      document.getElementById("businessName").textContent =
        "Бизнес не найден";
      return;
    }

    const business = businesses[0];

    document.getElementById("businessName").textContent =
      business.name;

    setupButton("google", business.google_url);
    setupButton("yandex", business.yandex_url);
    setupButton("twogis", business.twogis_url);

  } catch (error) {
    console.error(error);

    document.getElementById("businessName").textContent =
      "Ошибка загрузки";
  }
}

function setupButton(id, url) {
  const button = document.getElementById(id);

  if (url) {
    button.href = url;
    button.classList.remove("disabled");
  }
}

loadBusiness();
