// Админ-панель: вкладка «Отзывы» — отзывы из Telegram Mini App (миграция 034, src/app-api.js).
// Подключается после admin.js и пользуется его функциями: $, el, api, showError, hideError.
// Отзыв виден в каталоге только после «Опубликовать». Жалобы: 3 жалобы — отзыв снова на проверке.

const rvState = { status: "pending", offset: 0 };
const RV_REASONS = { spam: "Спам или реклама", offensive: "Оскорбления", fake: "Неправда / накрутка", personal: "Личные данные", other: "Другое" };
const RV_STATUS = { pending: "На проверке", published: "Опубликован", rejected: "Отклонён" };

document.addEventListener("DOMContentLoaded", () => {
  $("rv-refresh").addEventListener("click", () => loadAppReviews());
  $("rv-more").addEventListener("click", () => loadAppReviews(true));
  for (const chip of document.querySelectorAll("[data-rvstatus]")) {
    chip.addEventListener("click", () => {
      rvState.status = chip.dataset.rvstatus;
      for (const c of document.querySelectorAll("[data-rvstatus]")) c.classList.toggle("active", c === chip);
      loadAppReviews();
    });
  }
});

async function loadAppSummary() {
  try {
    const s = await api("/api/admin/app/summary");
    const todo = (s.reviews.pending || 0) + (s.reportedReviews || 0);
    $("reviews-badge").textContent = String(todo);
    $("reviews-badge").hidden = todo === 0;
    $("rv-summary").textContent =
      `В каталоге: ${s.places} · пользователей: ${s.users}${s.banned ? ` (заблокировано ${s.banned})` : ""} · ` +
      `опубликовано: ${s.reviews.published || 0} · на проверке: ${s.reviews.pending || 0} · с жалобами: ${s.reportedReviews || 0}`;
  } catch {
    // миграция 034 ещё не применена — вкладка просто пустая
  }
}

async function loadAppReviews(more = false) {
  rvState.offset = more ? rvState.offset + 50 : 0;
  hideError("rv-error");
  $("rv-loading").hidden = false;
  if (!more) $("rv-list").replaceChildren();
  try {
    const data = await api(`/api/admin/app/reviews?status=${rvState.status}&offset=${rvState.offset}`);
    $("rv-list").append(...data.reviews.map(reviewCard));
    $("rv-empty").hidden = $("rv-list").children.length > 0;
    $("rv-more").hidden = !data.more;
  } catch (error) {
    showError("rv-error", `Не удалось загрузить: ${error.message}`);
  } finally {
    $("rv-loading").hidden = true;
  }
  loadAppSummary();
}

function rvDate(iso) {
  return iso ? new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
}

function reviewCard(r) {
  const box = el("article", "rv-card");
  const head = el("div", "rv-head");
  const place = el("a", "rv-place", r.place ? r.place.name : "—");
  if (r.place) {
    place.href = `/app/#/place/${encodeURIComponent(r.place.slug)}`;
    place.target = "_blank";
    place.rel = "noopener";
  }
  head.append(
    el("span", "rv-stars", "★".repeat(r.score) + "☆".repeat(5 - r.score)),
    place,
    el("span", `rv-status rv-${r.status}`, RV_STATUS[r.status] || r.status)
  );
  if (r.card) head.append(el("span", "rv-tag", `по карте ${r.card}`));
  box.append(head);

  const meta = `Пользователь #${r.user ? r.user.id : "?"}${r.user && r.user.banned ? " (заблокирован)" : ""} · ${rvDate(r.created)}` +
    (r.updated && r.updated !== r.created ? ` · изменён ${rvDate(r.updated)}` : "");
  box.append(el("p", "muted rv-meta", meta));
  box.append(el("p", "rv-text", r.text || "(без текста)"));
  if (r.photo) {
    const a = el("a", "rv-photo");
    a.href = r.photo;
    a.target = "_blank";
    a.rel = "noopener";
    a.style.backgroundImage = `url(${r.photo})`;
    box.append(a);
  }
  if (r.flags && r.flags.length) {
    // Подсказки (src/app-api.js → suspicionFlags): не решение, а повод присмотреться
    const list = el("ul", "rv-flags");
    for (const f of r.flags) list.append(el("li", "", `⚠ ${f}`));
    box.append(list);
  }
  if (typeof r.helpful === "number" && r.helpful) box.append(el("p", "muted rv-meta", `👍 Полезно: ${r.helpful}`));
  if (r.rejectReason) box.append(el("p", "muted", `Причина отказа: ${r.rejectReason}`));
  if (r.reply) box.append(el("p", "rv-reply", `Ответ заведения: ${r.reply.text}`));
  if (r.reports.length) {
    const list = el("ul", "rv-reports");
    for (const rep of r.reports) list.append(el("li", "", `Жалоба: ${RV_REASONS[rep.reason] || rep.reason}${rep.comment ? ` — «${rep.comment}»` : ""} (${rvDate(rep.created_at)})`));
    box.append(list);
  }

  const actions = el("div", "rv-actions");
  const btn = (text, cls, fn) => {
    const b = el("button", `btn btn-small ${cls}`, text);
    b.type = "button";
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (error) {
        alert(error.message);
      } finally {
        b.disabled = false;
      }
    });
    actions.append(b);
  };
  const moderate = async (status, reason) => {
    await api(`/api/admin/app/reviews/${r.id}`, { method: "PATCH", body: { status, reject_reason: reason } });
    box.remove();
    loadAppSummary();
  };
  if (r.status !== "published") btn("Опубликовать", "btn-primary", () => moderate("published"));
  if (r.status !== "rejected") {
    btn("Отклонить", "btn-secondary", async () => {
      const reason = prompt("Причина (её увидит автор):", "Нарушает правила: оскорбления или нецензурная лексика");
      if (reason) await moderate("rejected", reason);
    });
  }
  if (r.status === "published" && rvState.status === "reported") {
    btn("Оставить, закрыть жалобы", "btn-secondary", async () => {
      await api(`/api/admin/app/reviews/${r.id}/resolve`, { method: "POST" });
      box.remove();
      loadAppSummary();
    });
  }
  if (r.status === "pending" && r.reports.length) {
    btn("Закрыть жалобы", "btn-ghost", async () => {
      await api(`/api/admin/app/reviews/${r.id}/resolve`, { method: "POST" });
      loadAppReviews();
    });
  }
  if (r.reply) {
    btn("Удалить ответ заведения", "btn-ghost", async () => {
      if (!confirm("Удалить ответ заведения на этот отзыв?")) return;
      await api(`/api/admin/app/reviews/${r.id}`, { method: "PATCH", body: { reply: null } });
      loadAppReviews();
    });
  }
  if (r.user) {
    const banned = r.user.banned;
    btn(banned ? "Разблокировать автора" : "Заблокировать автора", "btn-ghost", async () => {
      let reason = "";
      if (!banned) {
        reason = prompt("Причина блокировки (для себя). Его отзывы на проверке будут отклонены:", "Накрутка / спам");
        if (reason === null) return;
      }
      await api(`/api/admin/app/users/${r.user.id}`, { method: "PATCH", body: { banned: !banned, reason } });
      loadAppReviews();
    });
  }
  box.append(actions);
  return box;
}
