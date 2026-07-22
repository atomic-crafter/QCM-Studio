// js/ui/leaderboard.js
// Affiche le leaderboard depuis Firebase, avec filtres par sujet.

import { getLeaderboard } from "../data-access/firebase.js";
import { SUBJECTS }        from "../core/subjects.js";
import { state }           from "../core/runtime.js";
import { t, getLang }      from "../core/i18n.js";

const LB_LOCALES = { fr: "fr", en: "en", zh: "zh" };

let currentFilter = null; // null = global

export async function renderLeaderboard() {
  renderFilters();
  await loadAndRender(currentFilter);
}

// ── FILTRES ──────────────────────────────────────────────────────────────────
function renderFilters() {
  const container = document.getElementById("lb-filters");
  container.innerHTML = "";

  const filters = [
    { id: null, label: t("lb.global") },
    ...SUBJECTS.map(s => ({ id: s.id, label: `${s.icon} ${s.name}` }))
  ];

  filters.forEach(f => {
    const btn = document.createElement("button");
    btn.className = "lb-filter-btn" + (f.id === currentFilter ? " active" : "");
    btn.textContent = f.label;
    btn.onclick = async () => {
      currentFilter = f.id;
      document.querySelectorAll(".lb-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      await loadAndRender(f.id);
    };
    container.appendChild(btn);
  });
}

// ── DATA + RENDER ─────────────────────────────────────────────────────────────
async function loadAndRender(subjectId) {
  const container = document.getElementById("lb-table");
  container.innerHTML = `<div class="empty-lb"><span class="spinner"></span> ${t("common.loading")}</div>`;

  let rows;
  try {
    rows = await getLeaderboard(subjectId);
  } catch (e) {
    container.innerHTML = `<div class="empty-lb">${t("lb.firebaseError")}</div>`;
    console.error(e);
    return;
  }

  if (!rows.length) {
    container.innerHTML = `<div class="empty-lb">${t("lb.noScoresForFilter")}</div>`;
    return;
  }

  const rankClass  = i => i === 0 ? "gold"   : i === 1 ? "silver" : i === 2 ? "bronze" : "";
  const rankSymbol = i => i === 0 ? "🥇"     : i === 1 ? "🥈"    : i === 2 ? "🥉"    : (i + 1);

  container.innerHTML = rows.map((row, i) => {
    const isMe = row.pseudo === state.user;
    const meta = subjectId
      ? `${row.correct}/${row.total} · ${formatDate(row.updatedAt)}`
      : `${row.subjectName} · ${row.correct}/${row.total}`;

    return `
      <div class="lb-row ${isMe ? "me" : ""}">
        <div class="lb-rank ${rankClass(i)}">${rankSymbol(i)}</div>
        <div class="lb-name">
          ${row.pseudo}
          ${isMe ? `<span style="color:var(--accent);font-size:.75rem"> ${t("lb.youTag")}</span>` : ""}
        </div>
        <div class="lb-score">${row.score}%</div>
        <div class="lb-meta">${meta}</div>
      </div>
    `;
  }).join("");
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function formatDate(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString(LB_LOCALES[getLang()] || "fr");
}
