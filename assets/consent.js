// Плашка согласия на cookie и Яндекс Метрика (только страницы для владельцев: главная, /order/, /vladeltsam/).
// Метрика грузится ТОЛЬКО после «Принять». Выбор хранится в localStorage tr_cookie {v: "yes"|"no", at} на 365 дней.
// Цель «заявка отправлена»: window.trGoal("lead") — без согласия ничего не отправляет.
// Сменить выбор: ссылка с data-cookie-settings (в политике) — снова показывает плашку.
(function () {
  var COUNTER = 114415679; // номер счётчика Метрики; 0 — Метрика выключена, плашка всё равно работает
  var KEY = "tr_cookie";
  var KEEP = 365 * 864e5;
  var root = document.documentElement;
  var loaded = false;

  function saved() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || "null");
      return s && Date.now() - s.at < KEEP ? s : null;
    } catch (e) { return null; }
  }
  function remember(v) { try { localStorage.setItem(KEY, JSON.stringify({ v: v, at: Date.now() })); } catch (e) {} }

  function loadMetrika() {
    if (loaded || !COUNTER) return;
    loaded = true;
    (function (m, e, t, r, i, k, a) {
      m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
      m[i].l = 1 * new Date();
      k = e.createElement(t); a = e.getElementsByTagName(t)[0]; k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
    })(window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");
    // Вебвизор не записывает содержимое полей форм (класс ym-hide-content на формах заявки)
    window.ym(COUNTER, "init", { ssr: true, clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: true });
  }

  window.trGoal = function (name) {
    if (loaded && window.ym) window.ym(COUNTER, "reachGoal", name);
  };

  var css =
    ".cc{position:fixed;z-index:60;left:20px;bottom:20px;width:min(400px,calc(100% - 24px));padding:18px 18px 16px;" +
    "border-radius:18px;background:#fff;color:#2b3346;box-shadow:0 0 0 1px #e7eaf0,0 24px 50px -20px rgba(10,42,92,.4);" +
    "font:500 14px/1.5 Montserrat,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;transform:translateY(12px);opacity:0;" +
    "transition:transform .3s cubic-bezier(.2,.7,.2,1),opacity .3s}" +
    ".cc.show{transform:none;opacity:1}" +
    ".cc p{margin:0 0 14px}.cc a{color:#0a2a5c;font-weight:650}" +
    ".cc-row{display:flex;gap:8px}" +
    ".cc button{flex:1;min-height:44px;padding:0 16px;border:0;border-radius:99px;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer}" +
    ".cc-yes{background:#0a2a5c;color:#fff}.cc-no{background:#f6f7fa;color:#0a2a5c;box-shadow:0 0 0 1px #e7eaf0 inset}" +
    ".cc button:focus-visible{outline:2px solid #0a2a5c;outline-offset:2px}" +
    "@media (max-width:560px){.cc{left:12px;right:12px;width:auto;bottom:calc(12px + env(safe-area-inset-bottom))}}" +
    "@media (prefers-reduced-motion:reduce){.cc{transition:none}}";

  function showBanner() {
    if (document.getElementById("cc")) return;
    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    var box = document.createElement("div");
    box.className = "cc";
    box.id = "cc";
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", "Cookie");
    box.innerHTML =
      '<p>Мы используем cookie и Яндекс Метрику, чтобы понимать, как улучшить сайт. ' +
      '<a href="/privacy/#metrika">Подробнее</a></p>' +
      '<div class="cc-row"><button class="cc-no" type="button">Отказаться</button>' +
      '<button class="cc-yes" type="button">Принять</button></div>';
    document.body.appendChild(box);
    root.classList.add("cc-open");
    requestAnimationFrame(function () { requestAnimationFrame(function () { box.classList.add("show"); }); });
    function done(v) {
      remember(v);
      if (v === "yes") loadMetrika();
      box.classList.remove("show");
      setTimeout(function () { box.remove(); }, 300);
      root.classList.remove("cc-open");
      // Окно заявки на главной ждёт, пока плашка закроется (на телефоне они в одном месте)
      document.dispatchEvent(new Event("tr-cc"));
    }
    box.querySelector(".cc-yes").addEventListener("click", function () { done("yes"); });
    box.querySelector(".cc-no").addEventListener("click", function () { done("no"); });
  }

  function start() {
    var s = saved();
    if (s && s.v === "yes") loadMetrika();
    else if (!s) showBanner();
    document.querySelectorAll("[data-cookie-settings]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        try { localStorage.removeItem(KEY); } catch (e2) {}
        showBanner();
      });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
