// js/ai/qcmFromPdf.js
// Modal "PDF → QCM" : sélectionne des PDF, décrit ce que tu veux, choisis un fournisseur IA
// (Gemini intégré, Ollama local, ou toute API compatible OpenAI), génère un QCM complet,
// tweak les questions une par une, tague le QCM avec une date d'examen, puis sauvegarde.

import { toast } from "../core/runtime.js";
import { saveCustomQcm } from "../data-access/firebase.js";
import { renderLatexHtml, ensureKatexReady } from "../core/latex.js";
import { getCorrectAnswerIndices, isoDateToDDMMYYYY } from "../core/questionUtils.js";
import { extractTextFromPdfs } from "./pdfExtract.js";
import { buildGenerationPrompt, buildTweakPrompt, getQuestionCountPresets, estimateMaxTokens, getExpectedMinCount } from "./qcmPromptBuilder.js";
import {
  loadProviderSettings,
  saveProviderSettings,
  callProvider,
  parseAndValidateQuestions,
  parseAndValidateSingleQuestion
} from "./qcmProviders.js";
import { isVaultUnlocked, unlockVault, getApiKey, VaultLockedError } from "./apiKeyVault.js";
import { callWithAutoFallback, callSharedKey, listAvailableKeyOptions } from "./aiKeyOrchestrator.js";

let selectedFiles = [];
let generatedQuestions = [];
let lastSourceText = "";

// Fournisseurs "ma propre clé" : la clé vient du coffre chiffré (js/apiKeyVault.js)
// au lieu d'être tapée à chaque fois. vaultKey = nom du champ dans le coffre,
// dispatch = valeur passée à callProvider(), settingsKey = préférences non
// sensibles (modèle) dans js/qcmProviders.js.
const OWN_KEY_PROVIDERS = [
  { vaultKey: "claude", dispatch: "claude", settingsKey: "claude", label: "Claude (ma clé)", icon: "🟣", modelPlaceholder: "claude-opus-4-8" },
  { vaultKey: "gemini", dispatch: "gemini-own", settingsKey: "geminiOwn", label: "Gemini (ma clé)", icon: "🔵", modelPlaceholder: "gemini-2.5-flash" },
  { vaultKey: "deepseek", dispatch: "deepseek", settingsKey: "deepseek", label: "DeepSeek (ma clé)", icon: "🟢", modelPlaceholder: "deepseek-chat" },
  { vaultKey: "openai", dispatch: "openai-own", settingsKey: "openaiOwn", label: "OpenAI (ma clé)", icon: "⚪", modelPlaceholder: "gpt-4o-mini" }
];

export function openPdfQcmModal(username, uid) {
  document.getElementById("pdf-qcm-modal")?.remove();
  selectedFiles = [];
  generatedQuestions = [];
  lastSourceText = "";

  const settings = loadProviderSettings();

  const modal = document.createElement("div");
  modal.id = "pdf-qcm-modal";
  modal.className = "picker-overlay";
  modal.innerHTML = `
    <div class="picker-modal qcm-creator-inner pdf-qcm-inner">
      <div class="picker-modal-header">
        <h3>📄 PDF → QCM</h3>
        <button class="picker-close" id="pdf-qcm-close">✕</button>
      </div>

      <!-- Étape 1 : source + options -->
      <div id="pdf-step-source" class="qcm-step">
        <div class="field">
          <label>Cours en PDF (un ou plusieurs fichiers)</label>
          <div class="pdf-drop-zone" id="pdf-drop-zone">
            <input type="file" id="pdf-file-input" accept="application/pdf" multiple style="display:none">
            <button type="button" class="btn secondary sm" id="pdf-pick-btn">📎 Choisir des PDF</button>
            <span class="pdf-drop-hint">ou glisse-dépose tes fichiers ici</span>
          </div>
          <div id="pdf-file-list" class="pdf-file-list"></div>
        </div>

        <div class="field">
          <label>Instructions (ce que tu veux dans le QCM)</label>
          <textarea id="pdf-prompt-input" class="qcm-textarea" rows="3" maxlength="1000"
            placeholder="ex: Concentre-toi sur le chapitre 3 (les protocoles réseau), questions orientées TP, pas de questions sur l'historique."></textarea>
        </div>

        <div class="qcm-options-row pdf-options-grid">
          <div class="field">
            <label>Nombre de questions</label>
            <select id="pdf-count-mode" class="field-select">
              ${Object.entries(getQuestionCountPresets()).map(([key, preset]) =>
                `<option value="${key}" ${key === "medium" ? "selected" : ""}>${preset.label}</option>`
              ).join("")}
              <option value="exact">Nombre exact...</option>
            </select>
          </div>
          <div class="field" id="pdf-exact-count-field" style="display:none">
            <label>Combien exactement ?</label>
            <input type="number" id="pdf-exact-count" min="1" max="100" value="15">
          </div>
          <div class="field">
            <label>Langue</label>
            <select id="pdf-language" class="field-select">
              <option value="fr" selected>Français</option>
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="de">Deutsch</option>
              <option value="it">Italiano</option>
              <option value="zh">中文</option>
              <option value="pt">Português</option>
              <option value="nl">Nederlands</option>
            </select>
          </div>
          <div class="field">
            <label>Difficulté</label>
            <select id="pdf-difficulty" class="field-select">
              <option value="easy">Facile</option>
              <option value="medium" selected>Intermédiaire</option>
              <option value="hard">Difficile</option>
              <option value="mixed">Mélangée</option>
            </select>
          </div>
        </div>

        <div class="field pdf-latex-field">
          <label class="pdf-checkbox-label">
            <input type="checkbox" id="pdf-latex-toggle" checked>
            Formules mathématiques en LaTeX/KaTeX (activé par défaut — décoche si ton cours n'a pas de formules)
          </label>
        </div>

        <div class="field">
          <label>Fournisseur IA</label>
          <div class="room-type-toggle pdf-provider-toggle">
            <button type="button" class="room-type-btn ${settings.provider === "gemini" ? "active" : ""}" id="pdf-provider-gemini" data-provider="gemini">✨ Gemini (intégré)</button>
            <button type="button" class="room-type-btn ${settings.provider === "ollama" ? "active" : ""}" id="pdf-provider-ollama" data-provider="ollama">🖥️ Ollama (local)</button>
            <button type="button" class="room-type-btn ${settings.provider === "openai" ? "active" : ""}" id="pdf-provider-openai" data-provider="openai">🔌 API compatible OpenAI</button>
            ${OWN_KEY_PROVIDERS.map(p => `
              <button type="button" class="room-type-btn ${settings.provider === p.dispatch ? "active" : ""}" id="pdf-provider-${p.dispatch}" data-provider="${p.dispatch}">${p.icon} ${p.label}</button>
            `).join("")}
            <button type="button" class="room-type-btn ${settings.provider === "shared" ? "active" : ""}" id="pdf-provider-shared" data-provider="shared">🌐 Clé partagée</button>
            <button type="button" class="room-type-btn ${settings.provider === "manual" ? "active" : ""}" id="pdf-provider-manual" data-provider="manual">✋ Manuel (copier/coller)</button>
          </div>

          <div id="pdf-provider-shared-fields" class="pdf-provider-fields" style="display:${settings.provider === "shared" ? "block" : "none"}">
            <div class="field">
              <label>Qui emprunter ?</label>
              <select id="pdf-shared-picker"></select>
            </div>
            <p class="pdf-provider-hint">🔒 La clé n'est jamais visible, ni pour toi ni pour personne d'autre : le serveur l'utilise à ta place et ne te renvoie que le résultat. "Auto" essaie d'abord ta propre clé (si configurée), puis bascule sur les clés partagées disponibles en cas d'échec.</p>
          </div>

          <div id="pdf-provider-ollama-fields" class="pdf-provider-fields" style="display:${settings.provider === "ollama" ? "block" : "none"}">
            <div class="field">
              <label>URL du serveur Ollama</label>
              <input type="text" id="pdf-ollama-url" value="${escAttr(settings.ollama.baseUrl)}" placeholder="http://localhost:11434">
            </div>
            <div class="field">
              <label>Modèle</label>
              <input type="text" id="pdf-ollama-model" value="${escAttr(settings.ollama.model)}" placeholder="llama3.1">
            </div>
            <p class="pdf-provider-hint">⚠️ Lance Ollama avec <code>OLLAMA_ORIGINS="*" ollama serve</code> pour autoriser les requêtes depuis ce site.</p>
          </div>

          <div id="pdf-provider-openai-fields" class="pdf-provider-fields" style="display:${settings.provider === "openai" ? "block" : "none"}">
            <div class="field">
              <label>URL de base de l'API</label>
              <input type="text" id="pdf-openai-url" value="${escAttr(settings.openai.baseUrl)}" placeholder="https://api.openai.com/v1">
            </div>
            <div class="field">
              <label>Clé API</label>
              <input type="password" id="pdf-openai-key" value="${escAttr(settings.openai.apiKey)}" placeholder="sk-...">
            </div>
            <div class="field">
              <label>Modèle</label>
              <input type="text" id="pdf-openai-model" value="${escAttr(settings.openai.model)}" placeholder="gpt-4o-mini">
            </div>
            <p class="pdf-provider-hint">🔒 Ta clé reste uniquement dans ton navigateur (localStorage) et part directement vers l'URL indiquée ci-dessus — jamais vers nos serveurs.</p>
          </div>

          ${OWN_KEY_PROVIDERS.map(p => `
            <div id="pdf-provider-${p.dispatch}-fields" class="pdf-provider-fields" data-vault-key="${p.vaultKey}" data-settings-key="${p.settingsKey}" style="display:${settings.provider === p.dispatch ? "block" : "none"}">
              <div class="field pdf-own-key-status" id="pdf-own-key-status-${p.dispatch}"></div>
              <div class="field">
                <label>Modèle</label>
                <input type="text" id="pdf-model-${p.dispatch}" value="${escAttr(settings[p.settingsKey]?.model || p.modelPlaceholder)}" placeholder="${p.modelPlaceholder}">
              </div>
              <p class="pdf-provider-hint">🔒 Clé gérée dans "🔑 Mes clés IA" (chiffrée) — appelée directement depuis ton navigateur, jamais via nos serveurs.</p>
            </div>
          `).join("")}

          <div id="pdf-provider-manual-fields" class="pdf-provider-fields" style="display:${settings.provider === "manual" ? "block" : "none"}">
            <p class="pdf-provider-hint">✋ Aucun appel réseau : on te génère le prompt complet (règles LaTeX, format JSON, instructions...) à copier dans le LLM de ton choix (ChatGPT, Claude, Gemini, un modèle local en ligne de commande...). Tu colles ensuite sa réponse JSON pour l'importer.</p>
          </div>
        </div>

        <div id="pdf-gen-error" class="error-msg" style="margin-bottom:.5rem"></div>
        <div id="pdf-gen-progress" class="pdf-gen-progress" style="display:none"></div>
        <button class="btn" id="pdf-generate-btn">✨ Générer le QCM →</button>
      </div>

      <!-- Étape 1bis (mode manuel) : copier le prompt / coller le JSON -->
      <div id="pdf-step-manual" class="qcm-step" style="display:none">
        <div class="field">
          <label>Prompt à copier-coller dans ton LLM (ChatGPT, Claude, Gemini, modèle local...)</label>
          <textarea id="pdf-manual-prompt" class="qcm-textarea pdf-manual-prompt-box" rows="10" readonly></textarea>
          <button type="button" class="btn secondary sm" id="pdf-manual-copy-btn" style="align-self:flex-start">📋 Copier le prompt</button>
        </div>
        <div class="field">
          <label>Réponse JSON du modèle (colle-la ici)</label>
          <textarea id="pdf-manual-json-input" class="qcm-textarea" rows="8" placeholder='{"questions": [...]}'></textarea>
        </div>
        <div id="pdf-manual-error" class="error-msg" style="margin-bottom:.5rem"></div>
        <div class="qcm-preview-actions">
          <button class="btn secondary" id="pdf-manual-back-btn">← Retour aux options</button>
          <button class="btn" id="pdf-manual-import-btn">📥 Importer le JSON →</button>
        </div>
      </div>

      <!-- Étape 2 : prévisualisation + tweak + sauvegarde -->
      <div id="pdf-step-preview" class="qcm-step" style="display:none">
        <div class="field">
          <label>Titre du QCM</label>
          <input id="pdf-title-input" type="text" maxlength="60" placeholder="ex: Réseaux — Chapitre 3">
        </div>
        <div class="qcm-options-row pdf-options-grid">
          <div class="field">
            <label>Date d'examen (optionnel)</label>
            <input type="date" id="pdf-exam-date">
          </div>
          <div class="field">
            <label>Visibilité</label>
            <div class="room-type-toggle" style="margin-top:.1rem">
              <button type="button" class="room-type-btn active" id="pdf-btn-public">🌐 Public</button>
              <button type="button" class="room-type-btn" id="pdf-btn-private">🔒 Privé</button>
            </div>
          </div>
        </div>

        <div id="pdf-questions-preview" class="qcm-questions-preview"></div>

        <div id="pdf-save-error" class="error-msg" style="margin-bottom:.5rem"></div>
        <div class="qcm-preview-actions">
          <button class="btn secondary" id="pdf-retry-btn">← Nouveau prompt</button>
          <button class="btn" id="pdf-save-btn">💾 Sauvegarder</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  let isPublic = true;
  let latexEnabled = true;

  // ── Close ───────────────────────────────────────────────────────────────
  document.getElementById("pdf-qcm-close").onclick = () => modal.remove();
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });

  // ── File picking ────────────────────────────────────────────────────────
  const fileInput = document.getElementById("pdf-file-input");
  const dropZone = document.getElementById("pdf-drop-zone");
  document.getElementById("pdf-pick-btn").onclick = () => fileInput.click();

  fileInput.onchange = () => {
    addFiles([...fileInput.files]);
    fileInput.value = "";
  };

  dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); };
  dropZone.ondragleave = () => dropZone.classList.remove("drag-over");
  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const files = [...(e.dataTransfer?.files || [])].filter(f => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
    addFiles(files);
  };

  function addFiles(files) {
    selectedFiles = [...selectedFiles, ...files];
    renderFileList();
  }

  function renderFileList() {
    const listEl = document.getElementById("pdf-file-list");
    if (!selectedFiles.length) {
      listEl.innerHTML = "";
      return;
    }
    listEl.innerHTML = selectedFiles.map((file, index) => `
      <div class="pdf-file-item">
        <span class="pdf-file-icon">📄</span>
        <span class="pdf-file-name">${escHtml(file.name)}</span>
        <span class="pdf-file-size">${formatFileSize(file.size)}</span>
        <button type="button" class="pdf-file-remove" data-index="${index}" title="Retirer">✕</button>
      </div>
    `).join("");

    listEl.querySelectorAll(".pdf-file-remove").forEach(btn => {
      btn.onclick = () => {
        selectedFiles.splice(Number(btn.dataset.index), 1);
        renderFileList();
      };
    });
  }

  // ── Count mode ──────────────────────────────────────────────────────────
  document.getElementById("pdf-count-mode").onchange = (e) => {
    document.getElementById("pdf-exact-count-field").style.display = e.target.value === "exact" ? "block" : "none";
  };

  // ── LaTeX toggle ────────────────────────────────────────────────────────
  document.getElementById("pdf-latex-toggle").onchange = (e) => {
    latexEnabled = e.target.checked;
  };

  // ── Provider toggle ─────────────────────────────────────────────────────
  let currentProvider = settings.provider;
  const OWN_KEY_DISPATCH_VALUES = OWN_KEY_PROVIDERS.map(p => p.dispatch);
  const ephemeralKeyOverrides = {}; // dispatch -> clé tapée juste pour cette session (jamais persistée)

  function setProvider(provider) {
    currentProvider = provider;
    ["gemini", "ollama", "openai", ...OWN_KEY_DISPATCH_VALUES, "shared", "manual"].forEach(p => {
      document.getElementById(`pdf-provider-${p}`).classList.toggle("active", p === provider);
    });
    document.getElementById("pdf-provider-ollama-fields").style.display = provider === "ollama" ? "block" : "none";
    document.getElementById("pdf-provider-openai-fields").style.display = provider === "openai" ? "block" : "none";
    OWN_KEY_DISPATCH_VALUES.forEach(dispatch => {
      document.getElementById(`pdf-provider-${dispatch}-fields`).style.display = provider === dispatch ? "block" : "none";
    });
    document.getElementById("pdf-provider-shared-fields").style.display = provider === "shared" ? "block" : "none";
    document.getElementById("pdf-provider-manual-fields").style.display = provider === "manual" ? "block" : "none";
    document.getElementById("pdf-generate-btn").textContent = provider === "manual" ? "📋 Générer le prompt →" : "✨ Générer le QCM →";

    const ownKeyInfo = OWN_KEY_PROVIDERS.find(p => p.dispatch === provider);
    if (ownKeyInfo) refreshOwnKeyStatus(ownKeyInfo);
    if (provider === "shared") refreshSharedPicker();
  }
  document.getElementById("pdf-provider-gemini").onclick = () => setProvider("gemini");
  document.getElementById("pdf-provider-ollama").onclick = () => setProvider("ollama");
  document.getElementById("pdf-provider-openai").onclick = () => setProvider("openai");
  OWN_KEY_PROVIDERS.forEach(p => {
    document.getElementById(`pdf-provider-${p.dispatch}`).onclick = () => setProvider(p.dispatch);
  });
  document.getElementById("pdf-provider-shared").onclick = () => setProvider("shared");
  document.getElementById("pdf-provider-manual").onclick = () => setProvider("manual");

  const OWN_KEY_ICONS = Object.fromEntries(OWN_KEY_PROVIDERS.map(p => [p.vaultKey, p.icon]));
  const OWN_KEY_LABELS = { claude: "Claude", gemini: "Gemini", deepseek: "DeepSeek", openai: "OpenAI" };

  async function refreshSharedPicker() {
    const select = document.getElementById("pdf-shared-picker");
    select.innerHTML = `<option value="auto">🔄 Auto (ma clé, puis les clés partagées disponibles)</option>`;

    const options = await listAvailableKeyOptions(uid, username);
    const sharedOnly = options.filter(o => o.kind === "shared");

    sharedOnly.forEach(o => {
      const option = document.createElement("option");
      option.value = `${o.provider}::${o.ownerUid}`;
      option.textContent = `${OWN_KEY_ICONS[o.provider] || ""} ${OWN_KEY_LABELS[o.provider] || o.provider} — partagée par ${o.sharedBy}`;
      select.appendChild(option);
    });

    if (!sharedOnly.length) {
      const option = document.createElement("option");
      option.disabled = true;
      option.textContent = "(aucune clé partagée disponible pour l'instant — le mode Auto utilisera quand même ta propre clé si tu en as une)";
      select.appendChild(option);
    }
  }

  setProvider(settings.provider);

  function renderEphemeralInput(providerInfo) {
    return `<input type="password" class="pdf-own-key-ephemeral-input" data-dispatch="${providerInfo.dispatch}" placeholder="sk-... (pas sauvegardée)" value="${escAttr(ephemeralKeyOverrides[providerInfo.dispatch] || "")}">`;
  }

  function wireEphemeralInput(providerInfo) {
    const input = document.querySelector(`.pdf-own-key-ephemeral-input[data-dispatch="${providerInfo.dispatch}"]`);
    if (!input) return;
    input.oninput = () => { ephemeralKeyOverrides[providerInfo.dispatch] = input.value; };
  }

  async function refreshOwnKeyStatus(providerInfo) {
    const statusEl = document.getElementById(`pdf-own-key-status-${providerInfo.dispatch}`);
    if (!statusEl) return;
    statusEl.innerHTML = `<p class="pdf-provider-hint">// Vérification du coffre...</p>`;

    if (!isVaultUnlocked()) {
      statusEl.innerHTML = `
        <label>🔒 Coffre verrouillé</label>
        <div style="display:flex; gap:.5rem; margin-bottom:.5rem;">
          <input type="password" class="pdf-own-key-unlock-input" data-dispatch="${providerInfo.dispatch}" placeholder="Mot de passe" style="flex:1">
          <button type="button" class="btn secondary sm pdf-own-key-unlock-btn" data-dispatch="${providerInfo.dispatch}">Déverrouiller</button>
        </div>
        <p class="pdf-provider-hint">Ou tape une clé juste pour cette fois (pas sauvegardée) :</p>
        ${renderEphemeralInput(providerInfo)}
      `;
      wireEphemeralInput(providerInfo);
      document.querySelector(`.pdf-own-key-unlock-btn[data-dispatch="${providerInfo.dispatch}"]`).onclick = async () => {
        const input = document.querySelector(`.pdf-own-key-unlock-input[data-dispatch="${providerInfo.dispatch}"]`);
        const ok = await unlockVault(input.value, uid);
        if (ok) { toast("🔓 Coffre déverrouillé"); refreshOwnKeyStatus(providerInfo); }
        else toast("❌ Mot de passe incorrect");
      };
      return;
    }

    let key = null;
    try {
      key = await getApiKey(uid, providerInfo.vaultKey);
    } catch (e) {
      key = null;
    }

    if (key) {
      statusEl.innerHTML = `
        <p class="pdf-provider-hint">✅ Clé enregistrée trouvée pour ${providerInfo.label} — utilisée automatiquement.</p>
        <button type="button" class="btn secondary sm pdf-own-key-override-toggle" data-dispatch="${providerInfo.dispatch}">✏️ Utiliser une autre clé juste pour cette fois</button>
        <div class="pdf-own-key-override-box" data-dispatch="${providerInfo.dispatch}" style="display:none; margin-top:.5rem;">
          ${renderEphemeralInput(providerInfo)}
        </div>
      `;
      document.querySelector(`.pdf-own-key-override-toggle[data-dispatch="${providerInfo.dispatch}"]`).onclick = () => {
        const box = document.querySelector(`.pdf-own-key-override-box[data-dispatch="${providerInfo.dispatch}"]`);
        box.style.display = box.style.display === "none" ? "block" : "none";
      };
      wireEphemeralInput(providerInfo);
    } else {
      statusEl.innerHTML = `
        <p class="pdf-provider-hint">⚠️ Aucune clé enregistrée pour ${providerInfo.label}. Ajoute-la dans "🔑 Mes clés IA" pour la retrouver la prochaine fois, ou tape-en une juste pour cette session :</p>
        ${renderEphemeralInput(providerInfo)}
      `;
      wireEphemeralInput(providerInfo);
    }
  }

  async function resolveOwnKeyApiKey(providerInfo) {
    if (ephemeralKeyOverrides[providerInfo.dispatch]) return ephemeralKeyOverrides[providerInfo.dispatch];
    if (!isVaultUnlocked()) return "";
    try {
      return (await getApiKey(uid, providerInfo.vaultKey)) || "";
    } catch (e) {
      return "";
    }
  }

  // Renvoie les settings à envoyer à callProvider() — pour un fournisseur "ma
  // clé", inclut la clé résolue (coffre ou saisie ponctuelle). NE PAS passer
  // ce résultat tel quel à saveProviderSettings() (voir stripSecretsForPersist).
  async function currentProviderSettings() {
    const result = {
      provider: currentProvider,
      ollama: {
        baseUrl: document.getElementById("pdf-ollama-url").value.trim(),
        model: document.getElementById("pdf-ollama-model").value.trim()
      },
      openai: {
        baseUrl: document.getElementById("pdf-openai-url").value.trim(),
        apiKey: document.getElementById("pdf-openai-key").value.trim(),
        model: document.getElementById("pdf-openai-model").value.trim()
      }
    };

    const ownKeyInfo = OWN_KEY_PROVIDERS.find(p => p.dispatch === currentProvider);
    if (ownKeyInfo) {
      const apiKey = await resolveOwnKeyApiKey(ownKeyInfo);
      const modelInput = document.getElementById(`pdf-model-${ownKeyInfo.dispatch}`);
      result[ownKeyInfo.settingsKey] = { model: modelInput.value.trim() || ownKeyInfo.modelPlaceholder, apiKey };
    }

    return result;
  }

  // Jamais la clé "ma propre clé" en clair dans localStorage — seul le modèle
  // (préférence non sensible) est mémorisé pour ces fournisseurs.
  function stripSecretsForPersist(providerSettings) {
    const clone = structuredClone(providerSettings);
    OWN_KEY_PROVIDERS.forEach(p => {
      if (clone[p.settingsKey]) delete clone[p.settingsKey].apiKey;
    });
    return clone;
  }

  function applyDefaultTitle() {
    const promptVal = document.getElementById("pdf-prompt-input").value.trim();
    document.getElementById("pdf-title-input").value =
      promptVal ? (promptVal.length > 55 ? promptVal.slice(0, 52) + "..." : promptVal) : selectedFiles[0].name.replace(/\.pdf$/i, "");
  }

  async function goToPreview() {
    if (latexEnabled) await ensureKatexReady();
    applyDefaultTitle();
    renderPreview();
    document.getElementById("pdf-step-source").style.display = "none";
    document.getElementById("pdf-step-manual").style.display = "none";
    document.getElementById("pdf-step-preview").style.display = "block";
  }

  // ── Generate ────────────────────────────────────────────────────────────
  document.getElementById("pdf-generate-btn").onclick = async () => {
    const errEl = document.getElementById("pdf-gen-error");
    const progressEl = document.getElementById("pdf-gen-progress");
    errEl.style.display = "none";

    if (selectedFiles.length === 0) {
      errEl.textContent = "Ajoute au moins un fichier PDF";
      errEl.style.display = "block";
      return;
    }

    const providerSettings = await currentProviderSettings();
    saveProviderSettings(stripSecretsForPersist(providerSettings));
    const isManual = currentProvider === "manual";

    const btn = document.getElementById("pdf-generate-btn");
    btn.disabled = true;
    btn.textContent = "⏳ Extraction des PDF...";
    progressEl.style.display = "block";
    progressEl.textContent = `Extraction en cours (0 / ${selectedFiles.length} fichiers)...`;

    try {
      const { text } = await extractTextFromPdfs(selectedFiles, ({ fileIndex, fileName, totalFiles }) => {
        progressEl.textContent = `Extraction en cours : ${fileName} (${fileIndex + 1} / ${totalFiles})...`;
      });

      if (!text.trim()) {
        throw new Error("Aucun texte n'a pu être extrait de ces PDF (peut-être des scans/images sans texte sélectionnable).");
      }
      lastSourceText = text;

      const systemPrompt = buildGenerationPrompt({
        sourceText: text,
        userInstructions: document.getElementById("pdf-prompt-input").value,
        countMode: document.getElementById("pdf-count-mode").value,
        exactCount: document.getElementById("pdf-exact-count").value,
        language: document.getElementById("pdf-language").value,
        difficulty: document.getElementById("pdf-difficulty").value,
        latexEnabled
      });

      if (isManual) {
        document.getElementById("pdf-manual-prompt").value = systemPrompt;
        document.getElementById("pdf-manual-json-input").value = "";
        document.getElementById("pdf-manual-error").style.display = "none";
        document.getElementById("pdf-step-source").style.display = "none";
        document.getElementById("pdf-step-manual").style.display = "block";
        return;
      }

      btn.textContent = "⏳ Génération en cours...";
      progressEl.textContent = "Le modèle rédige les questions, ça peut prendre jusqu'à une minute...";

      const maxTokens = estimateMaxTokens(
        document.getElementById("pdf-count-mode").value,
        document.getElementById("pdf-exact-count").value
      );

      let rawResponse;
      if (currentProvider === "shared") {
        const picked = document.getElementById("pdf-shared-picker").value;
        if (picked === "auto") {
          rawResponse = await callWithAutoFallback({ uid, username, systemPrompt, maxTokens, jsonMode: true });
        } else {
          const [sharedProvider, ownerUid] = picked.split("::");
          rawResponse = await callSharedKey({ ownerUid, provider: sharedProvider, systemPrompt, maxTokens, jsonMode: true });
        }
      } else {
        rawResponse = await callProvider({ systemPrompt, provider: currentProvider, providerSettings, maxTokens });
      }

      generatedQuestions = parseAndValidateQuestions(rawResponse);

      const expectedMin = getExpectedMinCount(
        document.getElementById("pdf-count-mode").value,
        document.getElementById("pdf-exact-count").value
      );
      if (generatedQuestions.length < expectedMin) {
        toast(`⚠️ Tu as demandé au moins ${expectedMin} questions, seulement ${generatedQuestions.length} ont été générées/validées. Le PDF source est peut-être trop court, ou le modèle n'a pas respecté la consigne — tu peux réessayer ou changer de modèle.`);
      }

      await goToPreview();
    } catch (e) {
      renderErrorWithRaw(errEl, e);
    } finally {
      btn.disabled = false;
      btn.textContent = currentProvider === "manual" ? "📋 Générer le prompt →" : "✨ Générer le QCM →";
      progressEl.style.display = "none";
    }
  };

  // ── Mode manuel : copier le prompt / coller le JSON ────────────────────
  document.getElementById("pdf-manual-copy-btn").onclick = async () => {
    const ok = await copyToClipboard(document.getElementById("pdf-manual-prompt").value);
    toast(ok ? "📋 Prompt copié !" : "❌ Copie impossible, sélectionne le texte manuellement");
  };

  document.getElementById("pdf-manual-back-btn").onclick = () => {
    document.getElementById("pdf-step-manual").style.display = "none";
    document.getElementById("pdf-step-source").style.display = "block";
  };

  document.getElementById("pdf-manual-import-btn").onclick = async () => {
    const errEl = document.getElementById("pdf-manual-error");
    errEl.style.display = "none";
    const raw = document.getElementById("pdf-manual-json-input").value.trim();

    if (!raw) {
      errEl.textContent = "Colle la réponse JSON du modèle avant d'importer";
      errEl.style.display = "block";
      return;
    }

    try {
      generatedQuestions = parseAndValidateQuestions(raw);

      const expectedMin = getExpectedMinCount(
        document.getElementById("pdf-count-mode").value,
        document.getElementById("pdf-exact-count").value
      );
      if (generatedQuestions.length < expectedMin) {
        toast(`⚠️ Tu as demandé au moins ${expectedMin} questions, seulement ${generatedQuestions.length} ont été trouvées dans le JSON collé.`);
      }

      await goToPreview();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = "block";
    }
  };

  // ── Retry ───────────────────────────────────────────────────────────────
  document.getElementById("pdf-retry-btn").onclick = () => {
    document.getElementById("pdf-step-preview").style.display = "none";
    document.getElementById("pdf-step-source").style.display = "block";
  };

  // ── Visibility toggle ───────────────────────────────────────────────────
  document.getElementById("pdf-btn-public").onclick = () => {
    isPublic = true;
    document.getElementById("pdf-btn-public").classList.add("active");
    document.getElementById("pdf-btn-private").classList.remove("active");
  };
  document.getElementById("pdf-btn-private").onclick = () => {
    isPublic = false;
    document.getElementById("pdf-btn-private").classList.add("active");
    document.getElementById("pdf-btn-public").classList.remove("active");
  };

  // ── Preview rendering (+ per-question tweak/delete) ────────────────────
  let manualTweakPanel = null; // { idx, prompt } — un seul panneau ouvert à la fois en mode manuel

  function renderPreview() {
    const el = document.getElementById("pdf-questions-preview");
    const letters = ["A", "B", "C", "D"];
    const isManual = currentProvider === "manual";

    el.innerHTML = generatedQuestions.map((q, i) => `
      <div class="qcm-preview-q" data-idx="${i}">
        <div class="qcm-preview-q-header">
          <span class="qcm-preview-q-num">Q${i + 1}</span>
          <span class="q-category pdf-editable" data-idx="${i}" data-field="cat" title="Cliquer pour modifier">${escHtml(q.cat || "")}</span>
          <button type="button" class="btn-delete-qcm pdf-q-remove" data-idx="${i}" title="Supprimer">🗑️</button>
        </div>
        <div class="qcm-preview-q-text pdf-editable" data-idx="${i}" data-field="q" title="Cliquer pour modifier">${renderLatexHtml(q.q, { latexEnabled })}</div>
        <div class="qcm-preview-q-opts">
          ${q.opts.map((o, j) => `
            <div class="qcm-preview-opt${getCorrectAnswerIndices(q).includes(j) ? " correct" : ""}">
              <span class="option-letter">${letters[j]}</span>
              <span class="option-text pdf-editable" data-idx="${i}" data-field="opt" data-opt="${j}" title="Cliquer pour modifier">${renderLatexHtml(o, { latexEnabled })}</span>
            </div>
          `).join("")}
        </div>
        <div class="qcm-preview-exp pdf-editable${q.exp ? "" : " qcm-preview-exp-empty"}" data-idx="${i}" data-field="exp" title="Cliquer pour modifier">${q.exp ? `💡 ${renderLatexHtml(q.exp, { latexEnabled })}` : "+ Ajouter une explication"}</div>

        <div class="pdf-tweak-row">
          <input type="text" class="pdf-tweak-input" data-idx="${i}" placeholder="Tweak : ex: 'rends-la plus difficile', 'corrige la formulation'...">
          <button type="button" class="btn secondary sm pdf-tweak-btn" data-idx="${i}">${isManual ? "📋 Prompt de tweak" : "🔄 Tweaker"}</button>
        </div>
        <div class="error-msg pdf-tweak-error" data-idx="${i}" style="display:none"></div>

        ${manualTweakPanel?.idx === i ? `
          <div class="pdf-manual-tweak-panel" data-idx="${i}">
            <label>Prompt à copier-coller dans ton LLM</label>
            <textarea class="qcm-textarea pdf-manual-tweak-prompt" rows="5" readonly>${escHtml(manualTweakPanel.prompt)}</textarea>
            <button type="button" class="btn secondary sm pdf-manual-tweak-copy" data-idx="${i}">📋 Copier</button>
            <label>Réponse JSON du modèle</label>
            <textarea class="qcm-textarea pdf-manual-tweak-json" data-idx="${i}" rows="4" placeholder='{"question": {...}}'></textarea>
            <div class="error-msg pdf-manual-tweak-error" data-idx="${i}" style="display:none"></div>
            <div class="pdf-manual-tweak-actions">
              <button type="button" class="btn secondary sm pdf-manual-tweak-cancel" data-idx="${i}">Annuler</button>
              <button type="button" class="btn sm pdf-manual-tweak-apply" data-idx="${i}">📥 Importer →</button>
            </div>
          </div>
        ` : ""}
      </div>
    `).join("");

    el.querySelectorAll(".pdf-q-remove").forEach(btn => {
      btn.onclick = () => {
        generatedQuestions.splice(Number(btn.dataset.idx), 1);
        if (manualTweakPanel?.idx === Number(btn.dataset.idx)) manualTweakPanel = null;
        renderPreview();
      };
    });

    el.querySelectorAll(".pdf-tweak-btn").forEach(btn => {
      btn.onclick = () => isManual ? openManualTweakPanel(Number(btn.dataset.idx)) : tweakQuestion(Number(btn.dataset.idx));
    });

    el.querySelectorAll(".pdf-manual-tweak-copy").forEach(btn => {
      btn.onclick = async () => {
        const ok = await copyToClipboard(manualTweakPanel?.prompt || "");
        toast(ok ? "📋 Prompt copié !" : "❌ Copie impossible, sélectionne le texte manuellement");
      };
    });

    el.querySelectorAll(".pdf-manual-tweak-cancel").forEach(btn => {
      btn.onclick = () => {
        manualTweakPanel = null;
        renderPreview();
      };
    });

    el.querySelectorAll(".pdf-manual-tweak-apply").forEach(btn => {
      btn.onclick = () => applyManualTweak(Number(btn.dataset.idx));
    });

    el.querySelectorAll(".pdf-editable").forEach(node => {
      node.onclick = () => startInlineEdit(node);
    });
  }

  // ── Édition manuelle en un clic (sans repasser par l'IA) ─────────────────
  function startInlineEdit(node) {
    if (node.dataset.editing === "1") return;
    node.dataset.editing = "1";

    const idx = Number(node.dataset.idx);
    const field = node.dataset.field;
    const optIdx = node.dataset.opt !== undefined ? Number(node.dataset.opt) : null;
    const q = generatedQuestions[idx];
    if (!q) return;

    let currentValue = "";
    if (field === "cat") currentValue = q.cat || "";
    else if (field === "q") currentValue = q.q || "";
    else if (field === "opt") currentValue = q.opts[optIdx] || "";
    else if (field === "exp") currentValue = q.exp || "";

    const multiline = field === "q" || field === "exp";
    const input = document.createElement(multiline ? "textarea" : "input");
    if (!multiline) input.type = "text";
    else input.rows = field === "q" ? 2 : 3;
    input.className = "pdf-inline-edit-input";
    input.value = currentValue;

    node.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;

      if (save) {
        const newValue = input.value.trim();
        // "q" et "opt" sont obligatoires : un champ vidé par erreur ne doit pas
        // casser la question, on garde l'ancienne valeur dans ce cas.
        if ((field === "q" || field === "opt") && !newValue) {
          toast("⚠️ Ce champ ne peut pas être vide, modification annulée");
        } else if (field === "cat") q.cat = newValue;
        else if (field === "q") q.q = newValue;
        else if (field === "opt") q.opts[optIdx] = newValue;
        else if (field === "exp") q.exp = newValue;
      }
      renderPreview();
    };

    input.addEventListener("blur", () => commit(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        commit(false);
      } else if (e.key === "Enter" && !multiline) {
        e.preventDefault();
        commit(true);
      } else if (e.key === "Enter" && multiline && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit(true);
      }
    });
  }

  function openManualTweakPanel(idx) {
    const input = el_(`.pdf-tweak-input[data-idx="${idx}"]`);
    const errEl = el_(`.pdf-tweak-error[data-idx="${idx}"]`);
    errEl.style.display = "none";

    const instruction = input.value.trim();
    if (!instruction) {
      errEl.textContent = "Décris ce que tu veux changer sur cette question";
      errEl.style.display = "block";
      return;
    }

    const prompt = buildTweakPrompt({
      sourceText: lastSourceText,
      question: generatedQuestions[idx],
      tweakInstruction: instruction,
      language: document.getElementById("pdf-language")?.value || "fr",
      latexEnabled
    });

    manualTweakPanel = { idx, prompt };
    renderPreview();
  }

  async function applyManualTweak(idx) {
    const errEl = el_(`.pdf-manual-tweak-error[data-idx="${idx}"]`);
    const jsonInput = el_(`.pdf-manual-tweak-json[data-idx="${idx}"]`);
    errEl.style.display = "none";

    const raw = jsonInput.value.trim();
    if (!raw) {
      errEl.textContent = "Colle la réponse JSON du modèle avant d'importer";
      errEl.style.display = "block";
      return;
    }

    try {
      generatedQuestions[idx] = parseAndValidateSingleQuestion(raw);
      manualTweakPanel = null;
      if (latexEnabled) await ensureKatexReady();
      renderPreview();
      toast("✅ Question mise à jour");
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = "block";
    }
  }

  async function tweakQuestion(idx) {
    const input = el_(`.pdf-tweak-input[data-idx="${idx}"]`);
    const btn = el_(`.pdf-tweak-btn[data-idx="${idx}"]`);
    const errEl = el_(`.pdf-tweak-error[data-idx="${idx}"]`);
    errEl.style.display = "none";

    const instruction = input.value.trim();
    if (!instruction) {
      errEl.textContent = "Décris ce que tu veux changer sur cette question";
      errEl.style.display = "block";
      return;
    }

    btn.disabled = true;
    btn.textContent = "⏳...";

    try {
      const tweakPrompt = buildTweakPrompt({
        sourceText: lastSourceText,
        question: generatedQuestions[idx],
        tweakInstruction: instruction,
        language: document.getElementById("pdf-language")?.value || "fr",
        latexEnabled
      });

      let rawResponse;
      if (currentProvider === "shared") {
        const picked = document.getElementById("pdf-shared-picker").value;
        if (picked === "auto") {
          rawResponse = await callWithAutoFallback({ uid, username, systemPrompt: tweakPrompt, maxTokens: 1024, jsonMode: true });
        } else {
          const [sharedProvider, ownerUid] = picked.split("::");
          rawResponse = await callSharedKey({ ownerUid, provider: sharedProvider, systemPrompt: tweakPrompt, maxTokens: 1024, jsonMode: true });
        }
      } else {
        rawResponse = await callProvider({
          systemPrompt: tweakPrompt,
          provider: currentProvider,
          providerSettings: await currentProviderSettings(),
          maxTokens: 1024
        });
      }

      generatedQuestions[idx] = parseAndValidateSingleQuestion(rawResponse);
      if (latexEnabled) await ensureKatexReady();
      renderPreview();
      toast("✅ Question mise à jour");
    } catch (e) {
      renderErrorWithRaw(errEl, e);
      btn.disabled = false;
      btn.textContent = "🔄 Tweaker";
    }
  }

  function el_(selector) {
    return document.getElementById("pdf-questions-preview").querySelector(selector);
  }

  // ── Save ────────────────────────────────────────────────────────────────
  document.getElementById("pdf-save-btn").onclick = async () => {
    const title = document.getElementById("pdf-title-input").value.trim();
    const errEl = document.getElementById("pdf-save-error");
    errEl.style.display = "none";

    if (!title) {
      errEl.textContent = "Donne un titre à ton QCM";
      errEl.style.display = "block";
      return;
    }
    if (generatedQuestions.length === 0) {
      errEl.textContent = "Il ne reste plus aucune question à sauvegarder";
      errEl.style.display = "block";
      return;
    }

    const btn = document.getElementById("pdf-save-btn");
    btn.disabled = true;
    btn.textContent = "⏳ Sauvegarde...";

    try {
      const examDateRaw = document.getElementById("pdf-exam-date").value;
      const examDate = examDateRaw ? isoDateToDDMMYYYY(examDateRaw) : null;

      await saveCustomQcm({
        title,
        questions: generatedQuestions,
        createdBy: username,
        createdByUid: uid,
        isPublic,
        examDate,
        latex: latexEnabled
      });
      toast("✅ QCM sauvegardé !");
      modal.remove();
      import("../ui/home.js").then(m => m.renderCustomQcms(username, uid));
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = "block";
    } finally {
      btn.disabled = false;
      btn.textContent = "💾 Sauvegarder";
    }
  };
}

// Affiche le message d'erreur + (si dispo) un panneau dépliable avec la réponse
// brute du modèle, pour pouvoir diagnostiquer une réponse tronquée/mal formée.
function renderErrorWithRaw(errEl, error) {
  const raw = error?.rawResponse;
  if (!raw) {
    errEl.textContent = error?.message || String(error);
    errEl.style.display = "block";
    return;
  }

  const truncated = raw.length > 4000 ? raw.slice(0, 4000) + "\n[...tronqué...]" : raw;
  errEl.innerHTML = `
    <div>${escHtml(error.message)}</div>
    <button type="button" class="pdf-raw-toggle-btn">🔍 Voir la réponse brute du modèle</button>
    <textarea class="qcm-textarea pdf-raw-response-box" rows="8" readonly style="display:none; margin-top:.5rem">${escHtml(truncated)}</textarea>
  `;
  errEl.style.display = "block";

  const toggleBtn = errEl.querySelector(".pdf-raw-toggle-btn");
  const box = errEl.querySelector(".pdf-raw-response-box");
  toggleBtn.onclick = () => {
    const isHidden = box.style.display === "none";
    box.style.display = isHidden ? "block" : "none";
    toggleBtn.textContent = isHidden ? "🔍 Masquer la réponse brute" : "🔍 Voir la réponse brute du modèle";
  };
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

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
