// js/core/bugReport.js
// Bouton "signaler un bug" toujours visible (comme le sélecteur de langue),
// ouvre un petit formulaire qui enregistre le rapport dans Firestore
// (bugReports/{id} — voir firestore.rules) ET tente, en best-effort, de
// notifier l'admin par email via le Worker Cloudflare (POST /report-bug).
// L'écriture Firestore est la source de vérité : elle marche même si le
// Worker ou l'email échoue, donc rien n'est jamais perdu pour l'utilisateur.

import {
  collection,
  addDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { state, toast } from "./runtime.js";
import { t } from "./i18n.js";

let db;

export function initBugReport(firestoreDb) {
  db = firestoreDb;
}

function proxyBase() {
  return (window.__GIPHY_PROXY_URL || localStorage.getItem("qcm_giphy_proxy_url") || "").replace(/\/$/, "");
}

function currentContext() {
  return {
    username: state.isGuest ? "guest" : (state.user || ""),
    page: document.querySelector(".screen.active")?.id || "",
    userAgent: String(navigator.userAgent || "").slice(0, 300),
    appBuild: String(window.__APP_BUILD || ""),
    url: String(location.href || "").slice(0, 300)
  };
}

export function mountBugReportButton(container) {
  if (!container) return;
  container.innerHTML = `<button type="button" class="bug-report-btn" id="bug-report-open-btn" title="${t("bugReport.buttonTitle")}">🐛</button>`;
  document.getElementById("bug-report-open-btn").onclick = openBugReportModal;
}

function openBugReportModal() {
  document.getElementById("bug-report-modal")?.remove();

  const wrap = document.createElement("div");
  wrap.id = "bug-report-modal";
  wrap.className = "picker-overlay";
  wrap.innerHTML = `
    <div class="picker-modal" style="width:min(420px,92vw)">
      <div class="picker-modal-header">
        <h3>${t("bugReport.title")}</h3>
        <button class="picker-close" id="bug-report-close">✕</button>
      </div>
      <p style="color:var(--text-dim); font-size:.82rem; margin:-0.5rem 0 1rem; line-height:1.5;">
        ${t("bugReport.intro")}
      </p>
      <div class="field">
        <textarea id="bug-report-text" rows="5" maxlength="2000" placeholder="${t("bugReport.placeholder")}" style="width:100%; resize:vertical;"></textarea>
      </div>
      <button class="btn" id="bug-report-submit-btn" style="margin-top:.8rem; width:100%;">${t("bugReport.submitBtn")}</button>
    </div>
  `;

  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  document.body.appendChild(wrap);
  document.getElementById("bug-report-close").onclick = () => wrap.remove();

  const submitBtn = document.getElementById("bug-report-submit-btn");
  submitBtn.onclick = async () => {
    const textEl = document.getElementById("bug-report-text");
    const message = textEl.value.trim();
    if (message.length < 3) {
      textEl.focus();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = t("bugReport.sending");

    const context = currentContext();
    let saved = false;
    try {
      await addDoc(collection(db, "bugReports"), {
        message: message.slice(0, 2000),
        ...context,
        createdAt: serverTimestamp()
      });
      saved = true;
    } catch (e) {
      console.error("Bug report Firestore write failed:", e);
    }

    // Best-effort : notifie par email via le Worker — jamais bloquant, le
    // rapport ci-dessus est déjà sauvegardé même si ça échoue.
    try {
      const base = proxyBase();
      if (base) {
        await fetch(`${base}/report-bug`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: message.slice(0, 2000), ...context })
        });
      }
    } catch (e) {
      console.error("Bug report email notify failed:", e);
    }

    wrap.remove();
    toast(saved ? t("bugReport.thanks") : t("bugReport.failed"));
  };
}
