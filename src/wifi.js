// Wi-Fi заведения на странице карты (миграция 052).
// Сайт не может сам подключить телефон к сети (браузеры этого не разрешают), поэтому показываем
// название сети и пароль с кнопкой «Скопировать» и короткой подсказкой, где его вставить.
// Пароль — только гостю у карты: страница открыта с NFC/QR (или есть метка касания tap.js), не роботам превью.
//   cleanWifi(input)            — проверка полей для админки и настроек владельца
//   wifiVisible(request, ...)   — показывать ли пароль этому открытию страницы
//   wifiItem(business, cls)     — пункт «Wi-Fi» для переходника на странице заведения

// Без импорта public-page.js (он сам подключает этот модуль)
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export const WIFI_COLUMNS = "wifi_name,wifi_password";

export class WifiError extends Error {}

// → { wifi_name, wifi_password } (null — пусто). Без названия сети пароль не храним.
export function cleanWifi(input) {
  const name = String(input.wifi_name ?? "").trim();
  const pass = String(input.wifi_password ?? "").trim();
  if ([...name].length > 32) throw new WifiError("Wi-Fi: название сети — не больше 32 символов");
  if ([...pass].length > 63) throw new WifiError("Wi-Fi: пароль — не больше 63 символов");
  if (pass && !name) throw new WifiError("Wi-Fi: укажите название сети (или сотрите пароль)");
  if (/[\u0000-\u001f]/.test(name + pass)) throw new WifiError("Wi-Fi: в названии или пароле лишние символы");
  return { wifi_name: name || null, wifi_password: name && pass ? pass : null };
}

export function wifiVisible({ bot, tap, source }) {
  return !bot && (Boolean(tap) || source === "nfc" || source === "qr");
}

const WIFI_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.3a9.5 9.5 0 0 1 13 0M8.6 15.5a5 5 0 0 1 6.8 0M12 19h.01" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const GO = `<svg class="hub-go" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Раскрывающийся пункт (без скриптов): сеть, пароль (выделяется целиком по нажатию), подсказка.
// Кнопка «Скопировать» появляется, только если скрипт страницы её включит (WIFI_SCRIPT).
export function wifiItem(business, cls = "hub-row") {
  if (!business.wifiOn || !business.wifi_name) return "";
  const pass = business.wifi_password;
  return `<details class="hub-call hub-wifi">
        <summary class="${cls}"><span class="hub-ico">${WIFI_ICON}</span><span class="hub-label">Wi-Fi</span>${GO}</summary>
        <div class="wifi-body">
          <p class="wifi-line"><span>Сеть</span><b class="wifi-val">${escapeHtml(business.wifi_name)}</b></p>
          ${pass
            ? `<p class="wifi-line"><span>Пароль</span><b class="wifi-val wifi-pass">${escapeHtml(pass)}</b></p>
          <button class="wifi-copy" type="button" data-copy="${escapeHtml(pass)}" hidden>Скопировать пароль</button>
          <p class="wifi-hint">Откройте Настройки → Wi-Fi, выберите сеть «${escapeHtml(business.wifi_name)}» и вставьте пароль.</p>`
            : `<p class="wifi-hint">Сеть без пароля: Настройки → Wi-Fi → «${escapeHtml(business.wifi_name)}».</p>`}
        </div>
      </details>`;
}

export const WIFI_CSS = `
  .hub-wifi[open] > summary { border-color: var(--accent); }
  .wifi-body { display: grid; gap: 8px; margin: 10px 0 2px; padding: 14px; border-radius: 14px; border: 1px solid var(--btn-border); background: var(--btn-bg); text-align: left; }
  .wifi-line { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin: 0; font-size: 14px; color: var(--muted); }
  .wifi-val { min-width: 0; font-size: 16px; font-weight: 700; color: var(--text); text-align: right; overflow-wrap: anywhere; user-select: all; -webkit-user-select: all; }
  .wifi-pass { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 0.02em; }
  .wifi-copy { min-height: 44px; margin-top: 2px; border: 0; border-radius: 12px; background: var(--text); color: var(--card, #fff); font: inherit; font-size: 15px; font-weight: 700; cursor: pointer; }
  .wifi-copy[hidden] { display: none; }
  .wifi-copy.is-done { background: #2f7a55; color: #fff; }
  .wifi-hint { margin: 0; font-size: 13px; line-height: 1.45; color: var(--muted); }
`;

// Кнопка «Скопировать пароль» (страница подключает скрипт с nonce)
export const WIFI_SCRIPT = `(function () {
  var b = document.querySelector(".wifi-copy");
  if (!b) return;
  b.hidden = false;
  b.addEventListener("click", function () {
    var v = b.getAttribute("data-copy");
    var done = function () { b.textContent = "Скопировано ✓"; b.classList.add("is-done"); setTimeout(function () { b.textContent = "Скопировать пароль"; b.classList.remove("is-done"); }, 2000); };
    var fallback = function () {
      var t = document.createElement("textarea"); t.value = v; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select(); try { if (document.execCommand("copy")) done(); } catch (e) {} t.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, fallback); else fallback();
  });
})();`;
