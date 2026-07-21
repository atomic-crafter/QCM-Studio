// js/ai/qcmCreator.js
// Génération de QCM via Gemini AI (proxy Cloudflare Worker, clé partagée) ou via
// sa propre clé (Claude/Gemini/DeepSeek/OpenAI, voir js/apiKeyVault.js) + sauvegarde Firebase.

import { toast } from "../core/runtime.js";
import { saveCustomQcm, updateCustomQcm } from "../data-access/firebase.js";
import { renderLatexHtml, ensureKatexReady } from "../core/latex.js";
import { getCorrectAnswerIndices, normalizeAnswerIndices, isoDateToDDMMYYYY, ddmmyyyyToIsoDate } from "../core/questionUtils.js";
import { buildTopicPrompt } from "./qcmPromptBuilder.js";
import { callProvider, parseAndValidateQuestions, loadProviderSettings, saveProviderSettings } from "./qcmProviders.js";
import { OWN_KEY_PROVIDERS, renderOwnKeyToggleButtons, renderOwnKeyFieldPanels, wireOwnKeyProviders } from "./ownKeyProviderUI.js";
import { callWithAutoFallback, callSharedKey, listAvailableKeyOptions } from "./aiKeyOrchestrator.js";

const OWN_KEY_ICONS = Object.fromEntries(OWN_KEY_PROVIDERS.map(p => [p.vaultKey, p.icon]));
const OWN_KEY_LABELS = { claude: "Claude", gemini: "Gemini", deepseek: "DeepSeek", openai: "OpenAI" };

function proxyBase() {
  return (window.__GIPHY_PROXY_URL || "").replace(/\/$/, "");
}

// ── GÉNÉRATION ────────────────────────────────────────────────────────────────

// Fournisseur partagé (Gemini, clé admin via le Worker) — gated par
// l'allowlist admin (voir js/aiAccess.js).
export async function generateQcmFromPrompt(prompt, count = 10) {
  const base = proxyBase();
  if (!base) throw new Error("URL du proxy non configurée (window.__GIPHY_PROXY_URL)");

  const res = await fetch(`${base}/generate-qcm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, count })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 429) {
      throw new Error("Quota Gemini atteint (429). Réessaie dans quelques minutes ou génère moins de questions.");
    }
    throw new Error(data.error || `Erreur ${res.status}`);
  }
  return data.questions;
}

// Fournisseur "ma propre clé" — appel direct navigateur → Claude/Gemini/DeepSeek/OpenAI,
// jamais via le Worker, jamais gated par l'allowlist admin.
async function generateQcmWithOwnKey({ provider, providerSettings, prompt, count }) {
  const systemPrompt = buildTopicPrompt({ topic: prompt, count, language: "fr", latexEnabled: true });
  const rawResponse = await callProvider({ systemPrompt, provider, providerSettings, maxTokens: 4096 });
  return parseAndValidateQuestions(rawResponse);
}

// ── MODAL ─────────────────────────────────────────────────────────────────────

export function openQcmCreatorModal(username, uid) {
  document.getElementById("qcm-creator-modal")?.remove();

  const settings = loadProviderSettings();
  const validInitialProviders = new Set(["gemini", "shared", ...OWN_KEY_PROVIDERS.map(p => p.dispatch)]);
  const initialProvider = validInitialProviders.has(settings.provider) ? settings.provider : "gemini";

  const modal = document.createElement("div");
  modal.id = "qcm-creator-modal";
  modal.className = "picker-overlay";
  modal.innerHTML = `
    <div class="picker-modal qcm-creator-inner">
      <div class="picker-modal-header">
        <h3>✨ Créer un QCM</h3>
        <button class="picker-close" id="qcm-creator-close">✕</button>
      </div>

      <!-- Étape 1 : prompt -->
      <div id="qcm-step-prompt" class="qcm-step">
        <div class="field">
          <label>Sujet / Prompt</label>
          <textarea id="qcm-prompt-input" class="qcm-textarea" rows="3" maxlength="500"
            placeholder="ex: Les hooks React (useState, useEffect) pour développeurs débutants, questions pratiques en français"></textarea>
        </div>
        <div class="qcm-options-row">
          <div class="field" style="flex:1">
            <label>Nombre de questions</label>
            <select id="qcm-count-input" class="field-select">
              <option value="5">5 questions</option>
              <option value="10" selected>10 questions</option>
              <option value="15">15 questions</option>
              <option value="20">20 questions</option>
            </select>
          </div>
        </div>

        <div class="field">
          <label>Fournisseur IA</label>
          <div class="room-type-toggle" id="qcm-provider-toggle">
            <button type="button" class="room-type-btn ${initialProvider === "gemini" ? "active" : ""}" id="qcm-provider-gemini" data-provider="gemini">✨ Gemini (intégré)</button>
            ${renderOwnKeyToggleButtons(initialProvider, "qcm-provider")}
            <button type="button" class="room-type-btn ${initialProvider === "shared" ? "active" : ""}" id="qcm-provider-shared" data-provider="shared">🌐 Clé partagée</button>
          </div>
          ${renderOwnKeyFieldPanels(settings, initialProvider, "qcm-provider")}

          <div id="qcm-provider-shared-fields" class="pdf-provider-fields" style="display:${initialProvider === "shared" ? "block" : "none"}">
            <div class="field">
              <label>Qui emprunter ?</label>
              <select id="qcm-shared-picker"></select>
            </div>
            <p class="pdf-provider-hint">🔒 La clé n'est jamais visible : le serveur l'utilise pour toi et ne te renvoie que le résultat. "Auto" essaie d'abord ta propre clé (si configurée), puis les clés partagées disponibles en cas d'échec.</p>
          </div>
        </div>

        <div id="qcm-gen-error" class="error-msg" style="margin-bottom:.5rem"></div>
        <button class="btn" id="qcm-generate-btn">✨ Générer →</button>
      </div>

      <!-- Étape 2 : prévisualisation + sauvegarde -->
      <div id="qcm-step-preview" class="qcm-step" style="display:none">
        <div class="field">
          <label>Titre du QCM</label>
          <input id="qcm-title-input" type="text" maxlength="60" placeholder="ex: React Hooks — Débutant">
        </div>
        <div class="field">
          <label>Date d'examen (optionnel)</label>
          <input type="date" id="qcm-exam-date">
        </div>
        <div class="qcm-visibility-row">
          <label>Visibilité</label>
          <div class="room-type-toggle" style="margin-top:.5rem">
            <button class="room-type-btn active" id="qcm-btn-public">🌐 Public</button>
            <button class="room-type-btn" id="qcm-btn-private">🔒 Privé</button>
          </div>
        </div>
        <div id="qcm-questions-preview" class="qcm-questions-preview"></div>
        <div id="qcm-save-error" class="error-msg" style="margin-bottom:.5rem"></div>
        <div class="qcm-preview-actions">
          <button class="btn secondary" id="qcm-retry-btn">← Nouveau prompt</button>
          <button class="btn" id="qcm-save-btn">💾 Sauvegarder</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  let generatedQuestions = [];
  let isPublic = true;

  // ── Close
  document.getElementById("qcm-creator-close").onclick = () => modal.remove();
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });

  // ── Provider toggle (Gemini partagé vs. ma propre clé) ──────────────────
  let currentProvider = initialProvider;
  const OWN_KEY_DISPATCH_VALUES = OWN_KEY_PROVIDERS.map(p => p.dispatch);

  function setProvider(provider) {
    currentProvider = provider;
    ["gemini", ...OWN_KEY_DISPATCH_VALUES, "shared"].forEach(p => {
      document.getElementById(`qcm-provider-${p}`).classList.toggle("active", p === provider);
    });
    OWN_KEY_DISPATCH_VALUES.forEach(dispatch => {
      document.getElementById(`qcm-provider-${dispatch}-fields`).style.display = provider === dispatch ? "block" : "none";
    });
    document.getElementById("qcm-provider-shared-fields").style.display = provider === "shared" ? "block" : "none";

    const ownKeyInfo = OWN_KEY_PROVIDERS.find(p => p.dispatch === provider);
    if (ownKeyInfo) ownKeyUI.refreshStatus(ownKeyInfo);
    if (provider === "shared") refreshSharedPicker();
  }

  async function refreshSharedPicker() {
    const select = document.getElementById("qcm-shared-picker");
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

  const ownKeyUI = wireOwnKeyProviders({ idPrefix: "qcm-provider", uid, onSelect: setProvider });
  document.getElementById("qcm-provider-gemini").onclick = () => setProvider("gemini");
  document.getElementById("qcm-provider-shared").onclick = () => setProvider("shared");
  setProvider(initialProvider);

  // ── Visibility toggle
  document.getElementById("qcm-btn-public").onclick = () => {
    isPublic = true;
    document.getElementById("qcm-btn-public").classList.add("active");
    document.getElementById("qcm-btn-private").classList.remove("active");
  };
  document.getElementById("qcm-btn-private").onclick = () => {
    isPublic = false;
    document.getElementById("qcm-btn-private").classList.add("active");
    document.getElementById("qcm-btn-public").classList.remove("active");
  };

  // ── Generate
  document.getElementById("qcm-generate-btn").onclick = async () => {
    const promptVal = document.getElementById("qcm-prompt-input").value.trim();
    const count     = parseInt(document.getElementById("qcm-count-input").value);
    const errEl     = document.getElementById("qcm-gen-error");
    errEl.style.display = "none";

    if (promptVal.length < 5) {
      errEl.textContent = "Décris le sujet en au moins 5 caractères";
      errEl.style.display = "block";
      return;
    }

    const btn = document.getElementById("qcm-generate-btn");
    btn.disabled = true;
    btn.textContent = "⏳ Génération en cours...";

    try {
      if (currentProvider === "gemini") {
        generatedQuestions = await generateQcmFromPrompt(promptVal, count);
      } else if (currentProvider === "shared") {
        const systemPrompt = buildTopicPrompt({ topic: promptVal, count, language: "fr", latexEnabled: true });
        const picked = document.getElementById("qcm-shared-picker").value;
        let rawResponse;
        if (picked === "auto") {
          rawResponse = await callWithAutoFallback({ uid, username, systemPrompt, maxTokens: 4096, jsonMode: true });
        } else {
          const [sharedProvider, ownerUid] = picked.split("::");
          rawResponse = await callSharedKey({ ownerUid, provider: sharedProvider, systemPrompt, maxTokens: 4096, jsonMode: true });
        }
        generatedQuestions = parseAndValidateQuestions(rawResponse);
      } else {
        const ownKeyInfo = OWN_KEY_PROVIDERS.find(p => p.dispatch === currentProvider);
        const apiKey = await ownKeyUI.resolveApiKey(ownKeyInfo);
        const modelInput = document.getElementById(`qcm-provider-model-${ownKeyInfo.dispatch}`);
        const providerSettings = loadProviderSettings();
        providerSettings[ownKeyInfo.settingsKey] = {
          ...providerSettings[ownKeyInfo.settingsKey],
          model: modelInput?.value.trim() || ownKeyInfo.modelPlaceholder,
          apiKey
        };
        // Jamais la clé en clair dans localStorage — seul le modèle est mémorisé.
        const toPersist = structuredClone(providerSettings);
        delete toPersist[ownKeyInfo.settingsKey].apiKey;
        toPersist.provider = currentProvider;
        saveProviderSettings(toPersist);

        generatedQuestions = await generateQcmWithOwnKey({
          provider: currentProvider,
          providerSettings,
          prompt: promptVal,
          count
        });
      }
      await ensureKatexReady();
      document.getElementById("qcm-title-input").value =
        promptVal.length > 55 ? promptVal.slice(0, 52) + "..." : promptVal;
      renderPreview(generatedQuestions);
      document.getElementById("qcm-step-prompt").style.display  = "none";
      document.getElementById("qcm-step-preview").style.display = "block";
    } catch (e) {
      errEl.textContent      = e.message;
      errEl.style.display    = "block";
    } finally {
      btn.disabled    = false;
      btn.textContent = "✨ Générer avec Gemini →";
    }
  };

  // ── Retry
  document.getElementById("qcm-retry-btn").onclick = () => {
    document.getElementById("qcm-step-preview").style.display = "none";
    document.getElementById("qcm-step-prompt").style.display  = "block";
  };

  // ── Save
  document.getElementById("qcm-save-btn").onclick = async () => {
    const title = document.getElementById("qcm-title-input").value.trim();
    const errEl = document.getElementById("qcm-save-error");
    errEl.style.display = "none";

    if (!title) {
      errEl.textContent   = "Donne un titre à ton QCM";
      errEl.style.display = "block";
      return;
    }

    const btn = document.getElementById("qcm-save-btn");
    btn.disabled    = true;
    btn.textContent = "⏳ Sauvegarde...";

    try {
      const examDateRaw = document.getElementById("qcm-exam-date").value;
      const examDate = examDateRaw ? isoDateToDDMMYYYY(examDateRaw) : null;
      await saveCustomQcm({ title, questions: generatedQuestions, createdBy: username, createdByUid: uid, isPublic, examDate, latex: true });
      toast("✅ QCM sauvegardé !");
      modal.remove();
      import("../ui/home.js").then(m => m.renderCustomQcms(username, uid));
    } catch (e) {
      errEl.textContent   = e.message;
      errEl.style.display = "block";
    } finally {
      btn.disabled    = false;
      btn.textContent = "💾 Sauvegarder";
    }
  };
}

export function openQcmEditorModal(username, qcm = null, uid = null) {
  document.getElementById("qcm-editor-modal")?.remove();

  const isEdit = !!qcm?.id;
  const modal = document.createElement("div");
  modal.id = "qcm-editor-modal";
  modal.className = "picker-overlay";
  modal.innerHTML = `
    <div class="picker-modal qcm-creator-inner">
      <div class="picker-modal-header">
        <h3>${isEdit ? "✏️ Modifier le QCM" : "🧩 Créer un QCM (from scratch)"}</h3>
        <button class="picker-close" id="qcm-editor-close">✕</button>
      </div>

      <div class="field">
        <label>Titre</label>
        <input id="qcm-edit-title" type="text" maxlength="60" placeholder="ex: JavaScript Avancé">
      </div>

      <div class="field">
        <label>Date d'examen (optionnel)</label>
        <input type="date" id="qcm-edit-exam-date" value="${escAttr(ddmmyyyyToIsoDate(qcm?.examDate))}">
      </div>

      <div class="qcm-visibility-row">
        <label>Visibilité</label>
        <div class="room-type-toggle" style="margin-top:.5rem">
          <button class="room-type-btn active" id="qcm-edit-public">🌐 Public</button>
          <button class="room-type-btn" id="qcm-edit-private">🔒 Privé</button>
        </div>
      </div>

      <div id="qcm-edit-list" class="qcm-questions-preview" style="max-height:50vh; overflow:auto"></div>
      <div style="display:flex; gap:.6rem; margin-top:.8rem">
        <button class="btn secondary" id="qcm-add-question">+ Ajouter une question</button>
      </div>

      <div id="qcm-edit-error" class="error-msg" style="margin-top:.7rem"></div>
      <div class="qcm-preview-actions" style="margin-top:1rem">
        <button class="btn secondary" id="qcm-editor-cancel">Annuler</button>
        <button class="btn" id="qcm-editor-save">${isEdit ? "💾 Sauvegarder" : "✅ Créer"}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const initialQuestions = Array.isArray(qcm?.questions) && qcm.questions.length
    ? qcm.questions
    : [emptyQuestion()];
  const state = {
    title: qcm?.title || "",
    isPublic: qcm?.isPublic ?? true,
    questions: initialQuestions.map(normalizeQuestion)
  };

  const titleEl = document.getElementById("qcm-edit-title");
  titleEl.value = state.title;

  function setVisibility() {
    document.getElementById("qcm-edit-public").classList.toggle("active", state.isPublic);
    document.getElementById("qcm-edit-private").classList.toggle("active", !state.isPublic);
  }

  function renderList() {
    const listEl = document.getElementById("qcm-edit-list");
    listEl.innerHTML = state.questions.map((question, index) => `
      <div class="qcm-preview-q" data-idx="${index}">
        <div class="qcm-preview-q-header">
          <span class="qcm-preview-q-num">Q${index + 1}</span>
          <button class="btn-delete-qcm q-remove" data-idx="${index}" title="Supprimer">🗑️</button>
        </div>
        <input class="q-edit-cat" data-idx="${index}" maxlength="80" placeholder="Catégorie" value="${escAttr(question.cat)}" style="margin-bottom:.5rem; width:100%">
        <textarea class="q-edit-text" data-idx="${index}" rows="2" maxlength="300" placeholder="Question" style="width:100%; margin-bottom:.5rem">${escHtml(question.q)}</textarea>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:.5rem">
          ${question.opts.map((option, optIndex) => `
            <div style="display:flex; gap:.45rem; align-items:center; border:1px solid rgba(255,255,255,.08); border-radius:.7rem; padding:.45rem .55rem;">
              <input class="q-edit-correct" type="checkbox" data-idx="${index}" data-opt="${optIndex}" ${Array.isArray(question.ans) ? question.ans.includes(optIndex) ? "checked" : "" : question.ans === optIndex ? "checked" : ""}>
              <input class="q-edit-opt" data-idx="${index}" data-opt="${optIndex}" maxlength="200" placeholder="Option ${optIndex + 1}" value="${escAttr(option)}" style="flex:1; border:none; background:transparent; padding:0; min-width:0;">
            </div>
          `).join("")}
        </div>
        <div style="display:flex; gap:.6rem; margin-top:.6rem; align-items:center">
          <span style="font-size:.82rem; color:var(--text-dim)">Coche une ou plusieurs bonnes réponses</span>
        </div>
        <textarea class="q-edit-exp" data-idx="${index}" rows="2" maxlength="400" placeholder="Explication (optionnel)" style="width:100%; margin-top:.6rem">${escHtml(question.exp || "")}</textarea>
      </div>
    `).join("");

    listEl.querySelectorAll(".q-remove").forEach(button => {
      button.onclick = () => {
        const idx = Number(button.dataset.idx);
        if (state.questions.length <= 1) return;
        state.questions.splice(idx, 1);
        renderList();
      };
    });

    listEl.querySelectorAll(".q-edit-cat").forEach(input => input.oninput = () => {
      state.questions[Number(input.dataset.idx)].cat = input.value;
    });

    listEl.querySelectorAll(".q-edit-text").forEach(input => input.oninput = () => {
      state.questions[Number(input.dataset.idx)].q = input.value;
    });

    listEl.querySelectorAll(".q-edit-opt").forEach(input => input.oninput = () => {
      const idx = Number(input.dataset.idx);
      const opt = Number(input.dataset.opt);
      state.questions[idx].opts[opt] = input.value;
    });

    listEl.querySelectorAll(".q-edit-correct").forEach(checkbox => checkbox.onchange = () => {
      const idx = Number(checkbox.dataset.idx);
      const opt = Number(checkbox.dataset.opt);
      const current = normalizeAnswerIndices(state.questions[idx].ans);

      if (checkbox.checked) {
        state.questions[idx].ans = normalizeAnswerIndices([...current, opt]);
      } else {
        state.questions[idx].ans = current.filter(value => value !== opt);
      }

      if (Array.isArray(state.questions[idx].ans) && state.questions[idx].ans.length === 1) {
        state.questions[idx].ans = state.questions[idx].ans[0];
      }
    });

    listEl.querySelectorAll(".q-edit-exp").forEach(input => input.oninput = () => {
      state.questions[Number(input.dataset.idx)].exp = input.value;
    });
  }

  function validate() {
    const title = titleEl.value.trim();
    if (!title) return "Donne un titre au QCM";
    if (state.questions.length < 1) return "Ajoute au moins une question";

    for (const [index, question] of state.questions.entries()) {
      if (!question.q.trim()) return `Question ${index + 1} vide`;
      if (!Array.isArray(question.opts) || question.opts.length !== 4) return `Question ${index + 1}: 4 options obligatoires`;
      if (question.opts.some(option => !String(option).trim())) return `Question ${index + 1}: toutes les options sont obligatoires`;
      if (getCorrectAnswerIndices(question).length === 0) return `Question ${index + 1}: coche au moins une bonne réponse`;
    }

    return "";
  }

  function sanitizedQuestions() {
    return state.questions.map(question => ({
      cat: String(question.cat || "Général").trim().slice(0, 80) || "Général",
      q: String(question.q || "").trim().slice(0, 300),
      opts: question.opts.map(option => String(option || "").trim().slice(0, 200)),
      ans: normalizeAnswerIndices(question.ans).length <= 1 ? (normalizeAnswerIndices(question.ans)[0] ?? 0) : normalizeAnswerIndices(question.ans),
      exp: String(question.exp || "").trim().slice(0, 400)
    }));
  }

  document.getElementById("qcm-editor-close").onclick = () => modal.remove();
  document.getElementById("qcm-editor-cancel").onclick = () => modal.remove();
  modal.addEventListener("click", event => { if (event.target === modal) modal.remove(); });

  document.getElementById("qcm-edit-public").onclick = () => { state.isPublic = true; setVisibility(); };
  document.getElementById("qcm-edit-private").onclick = () => { state.isPublic = false; setVisibility(); };
  document.getElementById("qcm-add-question").onclick = () => {
    state.questions.push(emptyQuestion());
    renderList();
  };

  document.getElementById("qcm-editor-save").onclick = async () => {
    const errEl = document.getElementById("qcm-edit-error");
    errEl.style.display = "none";

    const error = validate();
    if (error) {
      errEl.textContent = error;
      errEl.style.display = "block";
      return;
    }

    const btn = document.getElementById("qcm-editor-save");
    btn.disabled = true;
    btn.textContent = isEdit ? "⏳ Sauvegarde..." : "⏳ Création...";

    try {
      const examDateRaw = document.getElementById("qcm-edit-exam-date").value;
      const payload = {
        title: titleEl.value.trim(),
        questions: sanitizedQuestions(),
        isPublic: state.isPublic,
        examDate: examDateRaw ? isoDateToDDMMYYYY(examDateRaw) : null,
        latex: qcm?.latex !== false
      };

      if (isEdit) {
        await updateCustomQcm({ id: qcm.id, username, uid, ...payload });
        toast("✅ QCM mis à jour");
      } else {
        await saveCustomQcm({ createdBy: username, createdByUid: uid, ...payload });
        toast("✅ QCM créé");
      }

      modal.remove();
      import("../ui/home.js").then(module => module.renderCustomQcms(username, uid));
    } catch (errorSave) {
      errEl.textContent = errorSave.message || "Erreur de sauvegarde";
      errEl.style.display = "block";
    } finally {
      btn.disabled = false;
      btn.textContent = isEdit ? "💾 Sauvegarder" : "✅ Créer";
    }
  };

  setVisibility();
  renderList();
}

function emptyQuestion() {
  return { cat: "Général", q: "", opts: ["", "", "", ""], ans: 0, exp: "" };
}

function normalizeQuestion(question) {
  const opts = Array.isArray(question?.opts) ? question.opts.slice(0, 4) : [];
  while (opts.length < 4) opts.push("");
  const correctIndices = normalizeAnswerIndices(question?.ans);
  return {
    cat: question?.cat || "Général",
    q: question?.q || "",
    opts,
    ans: correctIndices.length <= 1 ? (correctIndices[0] ?? 0) : correctIndices,
    exp: question?.exp || ""
  };
}

// ── PREVIEW RENDERER ──────────────────────────────────────────────────────────

function renderPreview(questions, latexEnabled = true) {
  const el      = document.getElementById("qcm-questions-preview");
  const letters = ["A", "B", "C", "D"];
  el.innerHTML  = questions.map((q, i) => `
    <div class="qcm-preview-q">
      <div class="qcm-preview-q-header">
        <span class="qcm-preview-q-num">Q${i + 1}</span>
        <span class="q-category">${q.cat || ""}</span>
      </div>
      <div class="qcm-preview-q-text">${renderLatexHtml(q.q, { latexEnabled })}</div>
      <div class="qcm-preview-q-opts">
        ${q.opts.map((o, j) => `
          <div class="qcm-preview-opt${getCorrectAnswerIndices(q).includes(j) ? " correct" : ""}">
            <span class="option-letter">${letters[j]}</span>
              <span class="option-text">${renderLatexHtml(o, { latexEnabled })}</span>
          </div>
        `).join("")}
      </div>
      ${q.exp ? `<div class="qcm-preview-exp">💡 ${renderLatexHtml(q.exp, { latexEnabled })}</div>` : ""}
    </div>
  `).join("");
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
