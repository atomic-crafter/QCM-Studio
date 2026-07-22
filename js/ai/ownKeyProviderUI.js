// js/ai/ownKeyProviderUI.js
// UI réutilisable "fournisseur IA avec ma propre clé" (Claude/Gemini/DeepSeek/OpenAI),
// partagée entre les fonctionnalités IA qui proposent un choix de fournisseur
// (ex: "✨ Créer un QCM"). La clé vient du coffre chiffré (js/apiKeyVault.js) ;
// ce fichier ne gère que le rendu + les interactions, jamais le chiffrement.
//
// NB: js/qcmFromPdf.js a sa propre implémentation inline équivalente (déjà en
// prod et testée) — elle n'a pas été migrée vers ce module pour ne pas prendre
// de risque sur du code qui marche déjà. Tout NOUVEAU consommateur devrait
// utiliser ce module plutôt que dupliquer une 3e fois cette logique.

import { toast } from "../core/runtime.js";
import { isVaultUnlocked, unlockVault, getApiKey } from "./apiKeyVault.js";
import { t } from "../core/i18n.js";

export const OWN_KEY_PROVIDERS = [
  { vaultKey: "claude", dispatch: "claude", settingsKey: "claude", label: "Claude (ma clé)", icon: "🟣", modelPlaceholder: "claude-opus-4-8" },
  { vaultKey: "gemini", dispatch: "gemini-own", settingsKey: "geminiOwn", label: "Gemini (ma clé)", icon: "🔵", modelPlaceholder: "gemini-2.5-flash" },
  { vaultKey: "deepseek", dispatch: "deepseek", settingsKey: "deepseek", label: "DeepSeek (ma clé)", icon: "🟢", modelPlaceholder: "deepseek-chat" },
  { vaultKey: "openai", dispatch: "openai-own", settingsKey: "openaiOwn", label: "OpenAI (ma clé)", icon: "⚪", modelPlaceholder: "gpt-4o-mini" }
];

function escAttr(s) {
  return String(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function renderOwnKeyToggleButtons(activeProvider, idPrefix) {
  return OWN_KEY_PROVIDERS.map(p => `
    <button type="button" class="room-type-btn ${activeProvider === p.dispatch ? "active" : ""}" id="${idPrefix}-${p.dispatch}" data-provider="${p.dispatch}">${p.icon} ${p.label}</button>
  `).join("");
}

export function renderOwnKeyFieldPanels(settings, activeProvider, idPrefix) {
  return OWN_KEY_PROVIDERS.map(p => `
    <div id="${idPrefix}-${p.dispatch}-fields" class="pdf-provider-fields" style="display:${activeProvider === p.dispatch ? "block" : "none"}">
      <div class="field own-key-status" id="${idPrefix}-status-${p.dispatch}"></div>
      <div class="field">
        <label>${t("pdfQcm.modelLabel")}</label>
        <input type="text" id="${idPrefix}-model-${p.dispatch}" value="${escAttr(settings?.[p.settingsKey]?.model || p.modelPlaceholder)}" placeholder="${p.modelPlaceholder}">
      </div>
      <p class="pdf-provider-hint">${t("pdfQcm.ownKeyHint")}</p>
    </div>
  `).join("");
}

/**
 * Attache le comportement interactif pour un groupe de boutons "ma clé"
 * identifié par idPrefix (ex: "qcm-provider"). onSelect(dispatch) est appelé
 * quand l'utilisateur clique un des boutons "ma clé" — à l'appelant de gérer
 * le changement d'onglet/fournisseur actif (masquer/afficher les panneaux).
 *
 * Renvoie { refreshStatus(providerInfo), resolveApiKey(providerInfo) }.
 */
export function wireOwnKeyProviders({ idPrefix, uid, onSelect }) {
  const ephemeralKeyOverrides = {};

  function renderEphemeralInput(providerInfo) {
    return `<input type="password" class="own-key-ephemeral-input" data-prefix="${idPrefix}" data-dispatch="${providerInfo.dispatch}" placeholder="${t("pdfQcm.ephemeralKeyPlaceholder")}" value="${escAttr(ephemeralKeyOverrides[providerInfo.dispatch] || "")}">`;
  }

  function wireEphemeralInput(providerInfo) {
    const input = document.querySelector(`.own-key-ephemeral-input[data-prefix="${idPrefix}"][data-dispatch="${providerInfo.dispatch}"]`);
    if (!input) return;
    input.oninput = () => { ephemeralKeyOverrides[providerInfo.dispatch] = input.value; };
  }

  async function refreshStatus(providerInfo) {
    const statusEl = document.getElementById(`${idPrefix}-status-${providerInfo.dispatch}`);
    if (!statusEl) return;
    statusEl.innerHTML = `<p class="pdf-provider-hint">${t("pdfQcm.checkingVault")}</p>`;

    if (!isVaultUnlocked()) {
      statusEl.innerHTML = `
        <label>${t("pdfQcm.vaultLockedLabel")}</label>
        <div style="display:flex; gap:.5rem; margin-bottom:.5rem;">
          <input type="password" class="own-key-unlock-input" data-prefix="${idPrefix}" data-dispatch="${providerInfo.dispatch}" placeholder="${t("common.passwordLabel")}" style="flex:1">
          <button type="button" class="btn secondary sm own-key-unlock-btn" data-prefix="${idPrefix}" data-dispatch="${providerInfo.dispatch}">${t("pdfQcm.unlockBtn")}</button>
        </div>
        <p class="pdf-provider-hint">${t("pdfQcm.ephemeralKeyHint")}</p>
        ${renderEphemeralInput(providerInfo)}
      `;
      wireEphemeralInput(providerInfo);
      document.querySelector(`.own-key-unlock-btn[data-prefix="${idPrefix}"][data-dispatch="${providerInfo.dispatch}"]`).onclick = async () => {
        const input = document.querySelector(`.own-key-unlock-input[data-prefix="${idPrefix}"][data-dispatch="${providerInfo.dispatch}"]`);
        const ok = await unlockVault(input.value, uid);
        if (ok) { toast(t("pdfQcm.vaultUnlockedToast")); refreshStatus(providerInfo); }
        else toast(t("pdfQcm.wrongPasswordToast"));
      };
      return;
    }

    let key = null;
    try { key = await getApiKey(uid, providerInfo.vaultKey); } catch (e) { key = null; }

    if (key) {
      statusEl.innerHTML = `
        <p class="pdf-provider-hint">${t("pdfQcm.keyFoundHint", { label: providerInfo.label })}</p>
        <button type="button" class="btn secondary sm own-key-override-toggle" data-prefix="${idPrefix}" data-dispatch="${providerInfo.dispatch}">${t("pdfQcm.useOtherKeyBtn")}</button>
        <div class="own-key-override-box" data-prefix="${idPrefix}" data-dispatch="${providerInfo.dispatch}" style="display:none; margin-top:.5rem;">
          ${renderEphemeralInput(providerInfo)}
        </div>
      `;
      document.querySelector(`.own-key-override-toggle[data-prefix="${idPrefix}"][data-dispatch="${providerInfo.dispatch}"]`).onclick = () => {
        const box = document.querySelector(`.own-key-override-box[data-prefix="${idPrefix}"][data-dispatch="${providerInfo.dispatch}"]`);
        box.style.display = box.style.display === "none" ? "block" : "none";
      };
      wireEphemeralInput(providerInfo);
    } else {
      statusEl.innerHTML = `
        <p class="pdf-provider-hint">${t("pdfQcm.noKeyFoundHint", { label: providerInfo.label })}</p>
        ${renderEphemeralInput(providerInfo)}
      `;
      wireEphemeralInput(providerInfo);
    }
  }

  OWN_KEY_PROVIDERS.forEach(p => {
    const btn = document.getElementById(`${idPrefix}-${p.dispatch}`);
    if (btn) btn.onclick = () => onSelect(p.dispatch);
  });

  async function resolveApiKey(providerInfo) {
    if (ephemeralKeyOverrides[providerInfo.dispatch]) return ephemeralKeyOverrides[providerInfo.dispatch];
    if (!isVaultUnlocked()) return "";
    try { return (await getApiKey(uid, providerInfo.vaultKey)) || ""; } catch (e) { return ""; }
  }

  return { refreshStatus, resolveApiKey };
}
