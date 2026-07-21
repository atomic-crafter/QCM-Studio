// js/ui/customQcmPicker.js
// Bloc réutilisable listant les QCM perso/communauté sélectionnables dans les
// pickers "Salle" (room.js) et "Défi" (home.js). Un QCM perso couvre aussi bien
// ceux créés à la main (qcmCreator.js) que ceux générés depuis un PDF
// (qcmFromPdf.js) — les deux finissent dans la même collection Firestore
// "customQcms", donc un seul fetch suffit pour les deux.

import { getUserQcms, getPublicQcms } from "../data-access/firebase.js";

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function fetchPickableCustomQcms(username, uid) {
  if (!username) return { userQcms: [], communityQcms: [] };

  const [userRes, publicRes] = await Promise.allSettled([
    getUserQcms(username, uid),
    getPublicQcms()
  ]);

  const userQcms = userRes.status === "fulfilled" ? userRes.value : [];
  const publicQcms = publicRes.status === "fulfilled" ? publicRes.value : [];
  const communityQcms = publicQcms.filter(q => q.createdBy !== username);

  return { userQcms, communityQcms };
}

function renderCustomQcmRow(qcm) {
  const count = (qcm.questions || []).length;
  const latex = qcm.latex !== false;
  const safeQuestions = escAttr(JSON.stringify(qcm.questions || []));

  return `
    <div class="picker-subject-block">
      <div class="picker-subject-title">✨ ${escAttr(qcm.title || "Sans titre")}</div>
      <div class="picker-custom-author">// par ${escAttr(qcm.createdBy || "?")}</div>
      <div class="picker-modes">
        <button class="picker-mode-btn btn-picker-custom-qcm"
          data-id="${escAttr(qcm.id)}"
          data-title="${escAttr(qcm.title || "")}"
          data-latex="${latex ? "true" : "false"}"
          data-questions="${safeQuestions}">
          ▶ Jouer · ${count} Q
        </button>
      </div>
    </div>
  `;
}

export function renderCustomQcmPickerHtml({ userQcms, communityQcms }) {
  if (!userQcms.length && !communityQcms.length) {
    return `<div class="picker-custom-empty">// Aucun QCM perso/communauté pour l'instant.</div>`;
  }

  let html = "";
  if (userQcms.length) {
    html += `<div class="picker-custom-group-title">📚 Mes QCM</div>${userQcms.map(renderCustomQcmRow).join("")}`;
  }
  if (communityQcms.length) {
    html += `<div class="picker-custom-group-title">🌐 Communauté</div>${communityQcms.map(renderCustomQcmRow).join("")}`;
  }
  return html;
}

/**
 * Charge les QCM perso/communauté dans `containerEl`, puis attache les
 * handlers de clic qui appellent `onPick({ id, title, latex, questions })`.
 */
export async function loadCustomQcmPickerInto(containerEl, username, uid, onPick) {
  if (!containerEl) return;

  try {
    const { userQcms, communityQcms } = await fetchPickableCustomQcms(username, uid);
    containerEl.innerHTML = renderCustomQcmPickerHtml({ userQcms, communityQcms });
  } catch (e) {
    containerEl.innerHTML = `<div class="picker-custom-empty">// Erreur de chargement des QCM perso.</div>`;
    return;
  }

  containerEl.querySelectorAll(".btn-picker-custom-qcm").forEach(btn => {
    btn.onclick = () => {
      let questions = [];
      try {
        const parsed = JSON.parse(btn.dataset.questions || "[]");
        questions = Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        questions = [];
      }
      onPick({
        id: btn.dataset.id,
        title: btn.dataset.title,
        latex: btn.dataset.latex === "true",
        questions
      });
    };
  });
}
