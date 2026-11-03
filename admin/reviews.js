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

// ================= Вкладка «Mini App»: статистика платформы и пользователи =================

const maState = { days: 30, filter: "all", q: "", offset: 0 };

document.addEventListener("DOMContentLoaded", () => {
  for (const chip of document.querySelectorAll("[data-madays]")) {
    chip.addEventListener("click", () => {
      maState.days = Number(chip.dataset.madays);
      for (const c of document.querySelectorAll("[data-madays]")) c.classList.toggle("active", c === chip);
      loadMiniAppStats();
    });
  }
  for (const chip of document.querySelectorAll("[data-mafilter]")) {
    chip.addEventListener("click", () => {
      maState.filter = chip.dataset.mafilter;
      for (const c of document.querySelectorAll("[data-mafilter]")) c.classList.toggle("active", c === chip);
      loadMiniAppUsers();
    });
  }
  let timer;
  $("ma-q").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      maState.q = $("ma-q").value.trim();
      loadMiniAppUsers();
    }, 350);
  });
  $("ma-more").addEventListener("click", () => loadMiniAppUsers(true));
});

function loadMiniApp() {
  loadMiniAppStats();
  loadMiniAppUsers();
}

async function loadMiniAppStats() {
  hideError("ma-error");
  try {
    const s = await api(`/api/admin/app/stats?days=${maState.days}`);
    const tile = (label, value, sub) => {
      const t = el("div", "ma-kpi");
      t.append(el("div", "ma-kpi-label", label), el("div", "ma-kpi-value", String(value)));
      if (sub) t.append(el("div", "ma-kpi-sub", sub));
      return t;
    };
    const h = s.reviews.medianModerationHours;
    $("ma-kpis").replaceChildren(
      tile("Пользователей", s.users.total, `+${s.users.new} новых · ${s.users.active} заходили`),
      tile("Новых отзывов", s.reviews.new, `опубл. ${s.reviews.published} · откл. ${s.reviews.rejected}`),
      tile("Ждут проверки", s.reviews.pending, h === null ? "время проверки: нет данных" : `проверка обычно ${h < 1 ? "меньше часа" : `${h} ч`}`),
      tile("Заведений в каталоге", s.places.inCatalog, `из ${s.places.total} активных`),
      tile("Отзывов по карте", s.reviews.viaCard, `с фото: ${s.reviews.withPhoto}`),
      tile("Жалоб", s.reports.new, `открыто: ${s.reports.open}`),
      tile("Голосов «Полезно»", s.votes, `в избранном: ${s.favorites}`),
      tile("Сообщения включили", s.users.notify, `заблокировано: ${s.users.banned}`)
    );

    // Один ряд — новые отзывы по дням; число — по наведению (title) и над столбиком, если он не нулевой и дней мало
    const max = Math.max(1, ...s.daily.map((d) => d.reviews));
    const fmt = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
    $("ma-chart").replaceChildren(
      ...s.daily.map((d) => {
        const col = el("div", "ma-col");
        col.title = `${fmt(d.day)}: отзывов ${d.reviews}, новых пользователей ${d.users}`;
        const bar = el("div", `ma-bar${d.reviews ? "" : " zero"}`);
        bar.style.height = `${d.reviews ? Math.max(4, (d.reviews / max) * 100) : 0}%`;
        if (s.days <= 30 && d.reviews) col.append(el("span", "ma-val", String(d.reviews)));
        col.append(bar);
        return col;
      })
    );
    $("ma-chart").dataset.first = fmt(s.daily[0].day);
    $("ma-chart").dataset.last = "сегодня";

    $("ma-top").replaceChildren(
      ...(s.top.length
        ? s.top.map((p) => {
            const tr = document.createElement("tr");
            tr.append(el("td", "cell-name", p.name), el("td", "", String(p.reviews)), el("td", "", `★ ${String(p.avg).replace(".", ",")}`));
            return tr;
          })
        : [(() => {
            const tr = document.createElement("tr");
            const td = el("td", "muted", "За период опубликованных отзывов нет");
            td.colSpan = 3;
            tr.append(td);
            return tr;
          })()])
    );
  } catch (error) {
    showError("ma-error", `Не удалось загрузить: ${error.message}`);
  }
}

async function loadMiniAppUsers(more = false) {
  maState.offset = more ? maState.offset + 50 : 0;
  try {
    const qs = new URLSearchParams({ q: maState.q.replace(/^#/, ""), filter: maState.filter, offset: String(maState.offset) });
    const data = await api(`/api/admin/app/users?${qs}`);
    const rows = data.users.map((u) => {
      const tr = document.createElement("tr");
      const who = el("td");
      who.append(el("div", "cell-name", `#${u.id}${u.notify ? " · 🔔" : ""}`), el("div", "cell-sub", `с ${new Date(u.created).toLocaleDateString("ru-RU")}`));
      if (u.banned) who.append(el("div", "cell-gaps", `Заблокирован${u.banReason ? `: ${u.banReason}` : ""}`));
      const rv = u.reviews;
      const act = el("td", "cell-actions");
      const b = el("button", "btn btn-ghost btn-small", u.banned ? "Разблокировать" : "Заблокировать");
      b.type = "button";
      b.addEventListener("click", async () => {
        let reason = "";
        if (!u.banned) {
          reason = prompt(`Причина блокировки #${u.id} (для себя). Его отзывы на проверке будут отклонены:`, "Накрутка / спам");
          if (reason === null) return;
        }
        b.disabled = true;
        try {
          await api(`/api/admin/app/users/${u.id}`, { method: "PATCH", body: { banned: !u.banned, reason } });
          loadMiniAppUsers();
        } catch (error) {
          alert(error.message);
          b.disabled = false;
        }
      });
      act.append(b);
      tr.append(
        who,
        el("td", "", `${rv.published} опубл. · ${rv.pending} на пров. · ${rv.rejected} откл.`),
        el("td", "", String(u.reportsMade)),
        el("td", "cell-sub", new Date(u.lastSeen).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })),
        act
      );
      return tr;
    });
    if (more) $("ma-users").append(...rows);
    else $("ma-users").replaceChildren(...rows);
    if (!more && !rows.length) {
      const tr = document.createElement("tr");
      const td = el("td", "muted", "Никого не нашли");
      td.colSpan = 5;
      tr.append(td);
      $("ma-users").append(tr);
    }
    $("ma-more").hidden = !data.more;
  } catch (error) {
    showError("ma-error", `Пользователи: ${error.message}`);
  }
}
