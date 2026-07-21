// js/ai/apiKeySettingsPanel.js
// Panneau "🔑 Mes clés IA" : chaque utilisateur peut enregistrer sa propre clé
// API (Claude, Gemini, DeepSeek, OpenAI) pour utiliser les fonctionnalités IA
// (PDF → QCM notamment) sans dépendre de l'autorisation admin sur la clé
// partagée — voir js/aiAccess.js. Les clés sont chiffrées côté client avant
// d'être stockées (voir js/apiKeyVault.js) ; ce fichier ne gère que l'UI.

import { toast } from "../core/runtime.js";
import {
  isVaultUnlocked,
  unlockVault,
  getConfiguredProviders,
  getApiKey,
  saveApiKey,
  deleteApiKey,
  VaultLockedError
} from "./apiKeyVault.js";
import { loadProviderSettings, saveProviderSettings } from "./qcmProviders.js";
import {
  listAllowedUsernames,
  shareApiKeyWithUser,
  revokeApiKeyFromUser,
  shareApiKeyWithAll,
  unshareApiKeyFromAll,
  isSharedWithAll,
  unshareApiKey
} from "./sharedKeyVault.js";

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(s) {
  return String(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const PROVIDER_INFO = {
  claude: {
    label: "Claude (Anthropic)",
    icon: "🟣",
    defaultModel: "claude-opus-4-8",
    modelHint: "ex: claude-opus-4-8, claude-sonnet-5, claude-haiku-4-5",
    getKeyUrl: "https://console.anthropic.com/settings/keys",
    getKeyHint: "Payant (au token). Crée une clé sur console.anthropic.com → Settings → API Keys."
  },
  gemini: {
    label: "Gemini (Google)",
    icon: "🔵",
    defaultModel: "gemini-2.5-flash",
    modelHint: "ex: gemini-2.5-flash, gemini-2.0-flash",
    getKeyUrl: "https://aistudio.google.com/apikey",
    getKeyHint: "Gratuit (quota généreux). Voir le tuto ci-dessous ⬇️"
  },
  deepseek: {
    label: "DeepSeek",
    icon: "🟢",
    defaultModel: "deepseek-chat",
    modelHint: "ex: deepseek-chat, deepseek-reasoner",
    getKeyUrl: "https://platform.deepseek.com/api_keys",
    getKeyHint: "Payant, très bon marché. Crée une clé sur platform.deepseek.com → API keys."
  },
  openai: {
    label: "OpenAI",
    icon: "⚪",
    defaultModel: "gpt-4o-mini",
    modelHint: "ex: gpt-4o-mini, gpt-4.1-mini",
    getKeyUrl: "https://platform.openai.com/api-keys",
    getKeyHint: "Payant (au token). Crée une clé sur platform.openai.com → API keys."
  }
};

// Correspondance avec les clés de settings non sensibles (js/qcmProviders.js) —
// "gemini"/"openai" (coffre) correspondent à "geminiOwn"/"openaiOwn" (settings),
// pour ne pas se marcher sur les pieds avec "gemini" (partagé/admin) et
// "openai" (API compatible générique, URL libre) qui existaient déjà.
const SETTINGS_KEY_BY_PROVIDER = { claude: "claude", gemini: "geminiOwn", deepseek: "deepseek", openai: "openaiOwn" };

export function openApiKeysPanel(username, uid) {
  document.getElementById("api-keys-modal")?.remove();

  const wrap = document.createElement("div");
  wrap.id = "api-keys-modal";
  wrap.className = "picker-overlay";
  wrap.innerHTML = `
    <div class="picker-modal" style="width:min(560px,94vw)">
      <div class="picker-modal-header">
        <h3>🔑 Mes clés IA</h3>
        <button class="picker-close" id="api-keys-close">✕</button>
      </div>
      <p style="color:var(--text-dim); font-size:.82rem; margin:-0.5rem 0 1rem; line-height:1.5;">
        Ajoute ta propre clé API pour utiliser "PDF → QCM" avec ton propre compte, sans dépendre de
        l'autorisation admin. Tes clés sont <strong>chiffrées avant d'être envoyées</strong> — voir le détail en bas de ce panneau.
      </p>
      <div id="api-keys-unlock-box"></div>
      <div id="api-keys-list"></div>
      <details style="margin-top:1.2rem;">
        <summary style="cursor:pointer; color:var(--accent2); font-size:.85rem; font-weight:700;">📘 Comment obtenir une clé Gemini gratuite</summary>
        <div style="margin-top:.7rem; font-size:.85rem; line-height:1.7; color:var(--text-dim);">
          <ol style="padding-left:1.2rem; margin:0;">
            <li>Va sur <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> et connecte-toi avec un compte Google.</li>
            <li>Clique sur <strong>"Create API key"</strong> (ou "Créer une clé API").</li>
            <li>Choisis un projet Google Cloud existant, ou laisse Google en créer un automatiquement.</li>
            <li>Copie la clé générée (elle commence par <code>AIza...</code>).</li>
            <li>Colle-la ci-dessus dans le champ <strong>Gemini</strong> et clique "Enregistrer".</li>
          </ol>
          <p style="margin-top:.6rem;">
            Le niveau gratuit de Google AI Studio donne accès à un quota quotidien généreux sur les modèles
            <code>gemini-2.5-flash</code>/<code>gemini-2.0-flash</code> — largement suffisant pour générer des QCM.
            Aucune carte bancaire n'est demandée pour ce niveau gratuit.
          </p>
        </div>
      </details>
      <p style="margin-top:1rem; font-size:.72rem; color:var(--text-dim); line-height:1.5;">
        🔒 Détail sécurité : tes clés sont chiffrées (AES-256) avec une clé dérivée de <em>ton mot de passe de connexion</em>,
        jamais envoyé ni stocké nulle part. Firestore ne voit que du texte chiffré illisible — même un accès à la base ne
        permettrait pas de les lire. Contrepartie : si tu ouvres un nouvel onglet/navigateur sans ressaisir ton mot de
        passe, il faudra le resaisir ici pour déverrouiller tes clés (rien n'est perdu, juste verrouillé).
      </p>
    </div>
  `;

  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  document.body.appendChild(wrap);
  document.getElementById("api-keys-close").onclick = () => wrap.remove();

  renderUnlockBox(uid, username);
  renderProviderList(uid, username);
}

function renderUnlockBox(uid, username) {
  const box = document.getElementById("api-keys-unlock-box");
  if (!box) return;

  if (isVaultUnlocked()) {
    box.innerHTML = "";
    return;
  }

  box.innerHTML = `
    <div class="pdf-manual-tweak-panel" style="margin-bottom:1rem;">
      <label>🔒 Coffre verrouillé — resaisis ton mot de passe pour voir/modifier tes clés</label>
      <div style="display:flex; gap:.5rem; margin-top:.4rem;">
        <input id="api-keys-unlock-password" type="password" placeholder="Mot de passe" autocomplete="current-password" style="flex:1">
        <button class="btn sm" id="api-keys-unlock-btn">Déverrouiller</button>
      </div>
      <div class="error-msg" id="api-keys-unlock-error" style="display:none"></div>
    </div>
  `;

  const doUnlock = async () => {
    const pwd = document.getElementById("api-keys-unlock-password").value;
    const errEl = document.getElementById("api-keys-unlock-error");
    errEl.style.display = "none";
    if (!pwd) return;

    const ok = await unlockVault(pwd, uid);
    if (!ok) {
      errEl.textContent = "Mot de passe incorrect";
      errEl.style.display = "block";
      return;
    }
    toast("🔓 Coffre déverrouillé");
    renderUnlockBox(uid, username);
    renderProviderList(uid, username);
  };

  document.getElementById("api-keys-unlock-btn").onclick = doUnlock;
  document.getElementById("api-keys-unlock-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doUnlock(); }
  });
}

async function renderProviderList(uid, username) {
  const listEl = document.getElementById("api-keys-list");
  if (!listEl) return;

  listEl.innerHTML = `<div class="picker-custom-loading">// Chargement...</div>`;
  const configured = new Set(await getConfiguredProviders(uid));
  const settings = loadProviderSettings();
  const unlocked = isVaultUnlocked();

  const sharedWith = {};
  const sharedAll = {};
  await Promise.all(
    Object.keys(PROVIDER_INFO)
      .filter(p => configured.has(p))
      .map(async p => {
        sharedWith[p] = await listAllowedUsernames(uid, p);
        sharedAll[p] = await isSharedWithAll(uid, p);
      })
  );

  listEl.innerHTML = Object.entries(PROVIDER_INFO).map(([provider, info]) => {
    const isConfigured = configured.has(provider);
    const settingsKey = SETTINGS_KEY_BY_PROVIDER[provider];
    const currentModel = settings[settingsKey]?.model || info.defaultModel;
    const recipients = sharedWith[provider] || [];
    const isPublic = !!sharedAll[provider];

    return `
      <div class="qcm-preview-q" style="margin-bottom:.8rem;" data-provider="${provider}">
        <div class="qcm-preview-q-header" style="justify-content:space-between;">
          <span>${info.icon} <strong>${info.label}</strong></span>
          <span class="tag ${isConfigured ? "cyan" : ""}">${isConfigured ? "✅ Configurée" : "Non configurée"}</span>
        </div>
        <p style="font-size:.75rem; color:var(--text-dim); margin:.3rem 0 .6rem;">
          ${info.getKeyHint} <a href="${info.getKeyUrl}" target="_blank" rel="noopener">Obtenir une clé →</a>
        </p>
        ${unlocked ? `
          <div class="field" style="margin-bottom:.5rem;">
            <label>Clé API</label>
            <input type="password" class="api-key-input" data-provider="${provider}" placeholder="${isConfigured ? "•••••••••••••• (laisser vide = ne pas changer)" : "Colle ta clé ici"}" autocomplete="off">
          </div>
          <div class="field" style="margin-bottom:.6rem;">
            <label>Modèle</label>
            <input type="text" class="api-model-input" data-provider="${provider}" value="${currentModel}" placeholder="${info.modelHint}">
          </div>
          <div style="display:flex; gap:.5rem;">
            <button class="btn sm api-key-save" data-provider="${provider}">💾 Enregistrer</button>
            ${isConfigured ? `<button class="btn secondary sm api-key-remove" data-provider="${provider}">🗑️ Retirer</button>` : ""}
          </div>
          ${isConfigured ? `
            <div class="field" style="margin-top:.7rem;">
              <label>🌐 Partager cette clé (jamais en clair — voir détail sécurité en bas)</label>
              <label class="pdf-checkbox-label" style="display:flex; align-items:center; gap:.5rem; margin:.3rem 0; font-size:.82rem;">
                <input type="checkbox" class="share-all-toggle" data-provider="${provider}" ${isPublic ? "checked" : ""}>
                🌍 Partager avec tout le monde (n'importe quel utilisateur connecté pourra l'emprunter)
              </label>
              <p style="font-size:.72rem; color:var(--text-dim); margin:.4rem 0 .3rem;">Ou partage avec des personnes précises :</p>
              <div class="share-chip-list" data-provider="${provider}" style="display:flex; flex-wrap:wrap; gap:.4rem; margin:.4rem 0;">
                ${recipients.length ? recipients.map(u => `
                  <span class="tag" style="display:inline-flex; align-items:center; gap:.3rem;">
                    ${escHtml(u)}
                    <button class="share-revoke-btn" data-provider="${provider}" data-user="${escAttr(u)}" title="Retirer le partage" style="background:none; border:none; cursor:pointer; color:inherit; font-size:.85rem; line-height:1;">✕</button>
                  </span>
                `).join("") : `<span style="font-size:.75rem; color:var(--text-dim);">Pas encore partagée avec personne en particulier</span>`}
              </div>
              <div style="display:flex; gap:.5rem;">
                <input type="text" class="share-target-input" data-provider="${provider}" placeholder="pseudo exact" maxlength="20" autocomplete="off" style="flex:1">
                <button class="btn sm share-target-btn" data-provider="${provider}">Partager</button>
              </div>
            </div>
          ` : ""}
        ` : (isConfigured ? `<p style="font-size:.78rem; color:var(--text-dim);">🔒 Déverrouille le coffre ci-dessus pour la modifier.</p>` : "")}
      </div>
    `;
  }).join("");

  listEl.querySelectorAll(".api-key-save").forEach(btn => {
    btn.onclick = async () => {
      const provider = btn.dataset.provider;
      const keyInput = listEl.querySelector(`.api-key-input[data-provider="${provider}"]`);
      const modelInput = listEl.querySelector(`.api-model-input[data-provider="${provider}"]`);
      const newKey = keyInput.value.trim();
      const model = modelInput.value.trim() || PROVIDER_INFO[provider].defaultModel;

      btn.disabled = true;
      btn.textContent = "⏳...";

      try {
        if (newKey) {
          await saveApiKey(uid, provider, newKey);
        }
        const settingsKey = SETTINGS_KEY_BY_PROVIDER[provider];
        const current = loadProviderSettings();
        current[settingsKey] = { ...current[settingsKey], model };
        saveProviderSettings(current);

        toast(`✅ ${PROVIDER_INFO[provider].label} enregistrée`);
        renderProviderList(uid, username);
      } catch (e) {
        if (e instanceof VaultLockedError) {
          toast("🔒 Coffre verrouillé, déverrouille-le d'abord");
        } else {
          toast(`❌ ${e?.message || "Erreur d'enregistrement"}`);
        }
        btn.disabled = false;
        btn.textContent = "💾 Enregistrer";
      }
    };
  });

  listEl.querySelectorAll(".api-key-remove").forEach(btn => {
    btn.onclick = async () => {
      const provider = btn.dataset.provider;
      if (!confirm(`Retirer ta clé ${PROVIDER_INFO[provider].label} ?`)) return;
      try {
        await deleteApiKey(uid, provider);
        await unshareApiKey(uid, provider);
        toast(`🗑️ Clé ${PROVIDER_INFO[provider].label} retirée`);
        renderProviderList(uid, username);
      } catch (e) {
        toast(`❌ ${e?.message || "Erreur"}`);
      }
    };
  });

  listEl.querySelectorAll(".share-all-toggle").forEach(checkbox => {
    checkbox.onchange = async () => {
      const provider = checkbox.dataset.provider;
      checkbox.disabled = true;
      try {
        if (checkbox.checked) {
          await shareApiKeyWithAll(uid, username, provider);
          toast(`🌍 Clé ${PROVIDER_INFO[provider].label} partagée avec tout le monde`);
        } else {
          await unshareApiKeyFromAll(uid, provider);
          toast(`🔒 Clé ${PROVIDER_INFO[provider].label} retirée du partage public`);
        }
        renderProviderList(uid, username);
      } catch (e) {
        checkbox.checked = !checkbox.checked;
        if (e instanceof VaultLockedError) {
          toast("🔒 Coffre verrouillé, déverrouille-le d'abord");
        } else {
          toast(`❌ ${e?.message || "Erreur"}`);
        }
        checkbox.disabled = false;
      }
    };
  });

  listEl.querySelectorAll(".share-target-btn").forEach(btn => {
    const doShare = async () => {
      const provider = btn.dataset.provider;
      const input = listEl.querySelector(`.share-target-input[data-provider="${provider}"]`);
      const target = input.value.trim();
      if (!target) return;

      btn.disabled = true;
      try {
        await shareApiKeyWithUser(uid, username, provider, target);
        toast(`🌐 Clé ${PROVIDER_INFO[provider].label} partagée avec ${target}`);
        renderProviderList(uid, username);
      } catch (e) {
        if (e instanceof VaultLockedError) {
          toast("🔒 Coffre verrouillé, déverrouille-le d'abord");
        } else {
          toast(`❌ ${e?.message || "Erreur"}`);
        }
        btn.disabled = false;
      }
    };

    btn.onclick = doShare;
    const input = listEl.querySelector(`.share-target-input[data-provider="${btn.dataset.provider}"]`);
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doShare(); }
    });
  });

  listEl.querySelectorAll(".share-revoke-btn").forEach(btn => {
    btn.onclick = async () => {
      const provider = btn.dataset.provider;
      const target = btn.dataset.user;
      btn.disabled = true;
      try {
        await revokeApiKeyFromUser(uid, provider, target);
        toast(`🔒 Partage retiré pour ${target}`);
        renderProviderList(uid, username);
      } catch (e) {
        toast(`❌ ${e?.message || "Erreur"}`);
        btn.disabled = false;
      }
    };
  });
}
