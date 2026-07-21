// js/ai/qcmProviders.js
// Abstraction multi-fournisseur pour la génération de QCM :
//   - "gemini" : via le proxy Cloudflare existant (clé API côté serveur, zéro config utilisateur)
//   - "ollama" : instance Ollama locale (ou distante) — pas de clé, juste une URL + un modèle
//   - "openai" : toute API compatible OpenAI (OpenAI, OpenRouter, LM Studio, vLLM, Groq...) — URL + clé + modèle
//
// Les trois fournisseurs reçoivent le MÊME prompt système (voir qcmPromptBuilder.js) et doivent
// renvoyer un JSON de la forme {"questions":[...]} ou {"question":{...}} (pour un tweak).

import { normalizeAnswerIndices } from "../core/questionUtils.js";

const SETTINGS_KEY = "qcm_pdf_provider_settings";

const DEFAULT_SETTINGS = {
  provider: "gemini",
  ollama: { baseUrl: "http://localhost:11434", model: "llama3.1" },
  // "openai" = API compatible OpenAI générique (URL/clé/modèle libres — OpenRouter,
  // LM Studio, vLLM, Groq...). Distinct de "openaiOwn" ci-dessous (clé perso du
  // coffre, endpoint OpenAI officiel fixe) pour ne pas les confondre.
  openai: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
  // Ces quatre-là s'appuient sur le coffre chiffré (js/apiKeyVault.js) pour la
  // clé — on ne garde ici QUE des préférences non sensibles (modèle), jamais
  // la clé en clair dans localStorage.
  claude: { model: "claude-opus-4-8" },
  geminiOwn: { model: "gemini-2.5-flash" },
  deepseek: { model: "deepseek-chat" },
  openaiOwn: { model: "gpt-4o-mini" }
};

function looksLikeUrl(value) {
  return /^https?:\/\/[^\s]+$/i.test(value);
}

// Ne garde une valeur sauvegardée que si elle est non vide (et, pour "baseUrl", que si elle
// ressemble à une vraie URL) — sinon retombe sur le défaut. Évite qu'un champ laissé vide, ou
// qu'une commande de terminal collée par erreur (ex: OLLAMA_ORIGINS=... ollama serve), reste
// "mémorisé" indéfiniment au lieu de rendre la vraie valeur par défaut.
function withDefaults(saved, defaults) {
  const result = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const value = saved?.[key];
    if (typeof value !== "string" || !value.trim()) continue;
    if (key === "baseUrl" && !looksLikeUrl(value.trim())) continue;
    result[key] = value;
  }
  return result;
}

export function loadProviderSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw);
    return {
      provider: parsed.provider || DEFAULT_SETTINGS.provider,
      ollama: withDefaults(parsed.ollama, DEFAULT_SETTINGS.ollama),
      openai: withDefaults(parsed.openai, DEFAULT_SETTINGS.openai),
      claude: withDefaults(parsed.claude, DEFAULT_SETTINGS.claude),
      geminiOwn: withDefaults(parsed.geminiOwn, DEFAULT_SETTINGS.geminiOwn),
      deepseek: withDefaults(parsed.deepseek, DEFAULT_SETTINGS.deepseek),
      openaiOwn: withDefaults(parsed.openaiOwn, DEFAULT_SETTINGS.openaiOwn)
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveProviderSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function proxyBase() {
  return (window.__GIPHY_PROXY_URL || localStorage.getItem("qcm_giphy_proxy_url") || "").replace(/\/$/, "");
}

// ── APPELS RÉSEAU PAR FOURNISSEUR ─────────────────────────────────────────────

async function callGemini(systemPrompt, maxTokens) {
  const base = proxyBase();
  if (!base) throw new Error("URL du proxy non configurée (window.__GIPHY_PROXY_URL). Choisis un autre fournisseur ou configure le proxy.");

  const res = await fetch(`${base}/generate-qcm-advanced`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ systemPrompt, maxOutputTokens: maxTokens })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 429) throw new Error("Quota Gemini atteint (429). Réessaie dans quelques minutes ou réduis le nombre de questions.");
    throw new Error(data.error || `Erreur Gemini ${res.status}`);
  }
  return JSON.stringify(data);
}

// Attrape l'erreur classique "j'ai collé la commande du terminal au lieu de l'URL"
// (ex: OLLAMA_ORIGINS="*" ollama serve) avant de lancer un fetch() qui échouerait
// de façon confuse (URL relative, 404/405 sans rapport avec le vrai problème).
function validateBaseUrl(baseUrl, exampleUrl) {
  if (!looksLikeUrl(baseUrl)) {
    throw new Error(
      `URL invalide : "${baseUrl.slice(0, 60)}". Ce champ attend juste une URL, ex: "${exampleUrl}" — ` +
      `pas une commande de terminal (comme "OLLAMA_ORIGINS=... ollama serve", ça se lance dans Terminal, pas ici).`
    );
  }
}

// Estimation grossière (~4 caractères/token) — suffisante pour dimensionner num_ctx,
// pas pour de la facturation précise.
function estimateTokenCount(text) {
  return Math.ceil(String(text || "").length / 4);
}

// Ollama tronque SILENCIEUSEMENT le prompt si num_ctx est trop petit pour le
// contenu envoyé — et le défaut est souvent 2048 tokens, largement inférieur à un
// prompt "PDF → QCM" qui embarque un cours entier. Sur un long cours, ça coupe la
// quasi-totalité du texte source sans prévenir : le modèle ne voit qu'un petit
// bout du cours, d'où des questions répétitives (peu de matière réellement visible)
// ou, pour un tweak, une question "hors sujet" (la question à modifier + la
// consigne tombent hors de la fenêtre de contexte visible). On dimensionne donc
// num_ctx sur la taille réelle du prompt envoyé, au lieu de compter sur le défaut.
function estimateNumCtx(promptText, maxTokens) {
  const needed = estimateTokenCount(promptText) + maxTokens + 512; // marge de sécurité
  return Math.min(32768, Math.max(4096, Math.ceil(needed / 1024) * 1024));
}

async function callOllama(systemPrompt, maxTokens, config, jsonMode = true) {
  const baseUrl = String(config?.baseUrl || "").trim().replace(/\/$/, "");
  const model = String(config?.model || "").trim();
  if (!baseUrl) throw new Error("URL Ollama manquante (ex: http://localhost:11434)");
  validateBaseUrl(baseUrl, "http://localhost:11434");
  if (!model) throw new Error("Nom du modèle Ollama manquant (ex: llama3.1)");

  let res;
  try {
    res = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: systemPrompt,
        ...(jsonMode ? { format: "json" } : {}),
        stream: false,
        options: {
          temperature: 0.3,
          repeat_penalty: 1.2,
          num_predict: maxTokens,
          num_ctx: estimateNumCtx(systemPrompt, maxTokens)
        }
      })
    });
  } catch (err) {
    throw new Error(
      `Impossible de joindre Ollama sur ${baseUrl}. Vérifie que "ollama serve" tourne et que CORS est autorisé ` +
      `(variable d'environnement OLLAMA_ORIGINS="*" avant de lancer Ollama).`
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Erreur Ollama ${res.status} : ${text.slice(0, 200)}`);
  }

  const data = await res.json().catch(() => ({}));
  const text = String(data.response || "");
  if (!text) throw new Error("Réponse Ollama vide");
  return text;
}

async function callOpenAiCompatible(systemPrompt, maxTokens, config, jsonMode = true) {
  const baseUrl = String(config?.baseUrl || "").trim().replace(/\/$/, "");
  const apiKey = String(config?.apiKey || "").trim();
  const model = String(config?.model || "").trim();
  if (!baseUrl) throw new Error("URL de l'API manquante (ex: https://api.openai.com/v1)");
  validateBaseUrl(baseUrl, "https://api.openai.com/v1");
  if (!model) throw new Error("Nom du modèle manquant (ex: gpt-4o-mini)");

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: jsonMode ? "Génère le QCM demandé, au format JSON strict précisé ci-dessus." : "Réponds à la consigne ci-dessus." }
        ],
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        temperature: 0.3,
        max_tokens: maxTokens
      })
    });
  } catch (err) {
    throw new Error(`Impossible de joindre l'API sur ${baseUrl} (CORS ou réseau).`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || data.error || `Erreur API ${res.status}`);
  }

  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Réponse API vide ou format inattendu");
  return text;
}

// Appel Gemini DIRECT navigateur → Google, avec la clé perso de l'utilisateur
// (contrairement à callGemini() qui passe par le proxy Cloudflare + clé admin
// partagée). Pas de fallback multi-modèles ici (contrairement au Worker) —
// c'est un chemin "utilisateur avancé, sa propre clé", on reste simple.
async function callGeminiDirect(systemPrompt, maxTokens, config, jsonMode = true) {
  const apiKey = String(config?.apiKey || "").trim();
  const model = String(config?.model || "").trim() || "gemini-2.5-flash";
  if (!apiKey) throw new Error("Clé API Gemini manquante");

  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: systemPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: maxTokens,
            ...(jsonMode ? { responseMimeType: "application/json" } : {})
          }
        })
      }
    );
  } catch (err) {
    throw new Error("Impossible de joindre l'API Gemini (réseau/CORS).");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 429) throw new Error("Quota Gemini atteint (429). Réessaie dans quelques minutes.");
    if (res.status === 400 || res.status === 403) throw new Error(data?.error?.message || "Clé API Gemini invalide ou refusée.");
    throw new Error(data?.error?.message || `Erreur Gemini ${res.status}`);
  }

  const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  if (!text) throw new Error("Réponse Gemini vide");
  return text;
}

// Appel Claude (Anthropic Messages API) avec la clé perso de l'utilisateur.
async function callClaude(systemPrompt, maxTokens, config) {
  const apiKey = String(config?.apiKey || "").trim();
  const model = String(config?.model || "").trim() || "claude-opus-4-8";
  if (!apiKey) throw new Error("Clé API Claude manquante");

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: systemPrompt }]
      })
    });
  } catch (err) {
    throw new Error("Impossible de joindre l'API Claude (réseau/CORS).");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Erreur Claude ${res.status}`);
  }

  const text = Array.isArray(data?.content) ? data.content.map(c => c.text || "").join("") : "";
  if (!text) throw new Error("Réponse Claude vide");
  return text;
}

// ── EXTRACTION / RÉPARATION JSON ──────────────────────────────────────────────

function extractJsonObject(text) {
  if (!text) return "";
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const start = cleaned.indexOf("{");
  if (start === -1) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < cleaned.length; index++) {
    const char = cleaned[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return cleaned.slice(start, index + 1);
    }
  }
  return "";
}

function repairJson(text) {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
}

// Attache la réponse brute du modèle à l'erreur pour pouvoir l'afficher côté UI
// (sinon impossible de savoir si la réponse a été tronquée, mal formatée, etc.)
function throwWithRaw(message, rawText) {
  const error = new Error(message);
  error.rawResponse = rawText;
  throw error;
}

function parseJsonLoose(rawText) {
  const jsonText = extractJsonObject(rawText);
  if (!jsonText) {
    throwWithRaw(
      "Le modèle n'a pas renvoyé de JSON exploitable (probablement du texte libre autour, ou une réponse tronquée).",
      rawText
    );
  }
  try {
    return JSON.parse(jsonText);
  } catch {
    try {
      return JSON.parse(repairJson(jsonText));
    } catch {
      throwWithRaw(
        "JSON renvoyé par le modèle invalide (souvent une réponse coupée avant la fin — réduis le nombre de questions, ou réessaie).",
        rawText
      );
    }
  }
}

// ── VALIDATION / NORMALISATION DES QUESTIONS ──────────────────────────────────

function normalizeQuestionShape(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.q !== "string" || !raw.q.trim()) return null;
  // 4 options est la cible (voir JSON_FORMAT_SPEC), mais certains modèles — surtout
  // les petits modèles locaux — n'en génèrent parfois que 2 ou 3 malgré la consigne.
  // Rejeter ces questions en bloc videait des générations entières (10/10 questions
  // à 2-3 options → "aucune question valide"), donc on accepte 2 à 4 options plutôt
  // que d'exiger EXACTEMENT 4 ; l'UI de preview gère déjà un nombre variable d'options.
  if (!Array.isArray(raw.opts) || raw.opts.length < 2 || raw.opts.length > 4) return null;
  if (!raw.opts.every(opt => typeof opt === "string" && opt.trim())) return null;

  const indices = normalizeAnswerIndices(raw.ans).filter(index => index < raw.opts.length);
  if (indices.length === 0) return null;

  return {
    cat: String(raw.cat || "Général").trim().slice(0, 80) || "Général",
    q: String(raw.q).trim().slice(0, 500),
    opts: raw.opts.map(opt => String(opt).trim().slice(0, 300)),
    ans: indices.length === 1 ? indices[0] : indices,
    exp: String(raw.exp || "").trim().slice(0, 600)
  };
}

// Filtre les doublons EXACTS (même texte de question, en ignorant casse/espaces) —
// un filet de sécurité pour les modèles (surtout locaux) qui dégénèrent parfois en
// répétant la même question en boucle malgré la consigne. Ne détecte que les
// doublons stricts, pas les reformulations proches (ça demanderait une comparaison
// floue, hors scope ici) ; le résultat plus court déclenche naturellement l'alerte
// "moins de questions que demandé" côté UI.
function dedupeExactQuestions(questions) {
  const seen = new Set();
  const result = [];
  for (const q of questions) {
    const key = q.q.trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(q);
  }
  return result;
}

export function parseAndValidateQuestions(rawText) {
  const parsed = parseJsonLoose(rawText);
  const list = Array.isArray(parsed) ? parsed : parsed?.questions;
  if (!Array.isArray(list)) {
    throwWithRaw("Format inattendu : le JSON ne contient pas de tableau 'questions'.", rawText);
  }

  const valid = dedupeExactQuestions(list.map(normalizeQuestionShape).filter(Boolean));
  if (valid.length === 0) {
    throwWithRaw("Aucune question valide n'a pu être extraite de la réponse du modèle.", rawText);
  }
  return valid;
}

export function parseAndValidateSingleQuestion(rawText) {
  const parsed = parseJsonLoose(rawText);
  const raw = parsed?.question || parsed;
  const question = normalizeQuestionShape(raw);
  if (!question) throwWithRaw("La question renvoyée par le modèle est invalide.", rawText);
  return question;
}

// ── POINT D'ENTRÉE UNIQUE ─────────────────────────────────────────────────────

/**
 * @param {object} options
 * @param {string} options.systemPrompt
 * @param {"gemini"|"ollama"|"openai"|"claude"|"gemini-own"|"deepseek"|"openai-own"} options.provider
 * @param {object} [options.providerSettings] - résultat de loadProviderSettings()
 * @param {number} [options.maxTokens]
 * @param {boolean} [options.jsonMode] - true (défaut) pour la génération de QCM (JSON strict).
 *   Passe false pour un usage "texte libre" (ex: coach IA qui explique une réponse) — sinon
 *   certains fournisseurs (Ollama, OpenAI-compatible, Gemini) rejettent ou forcent une réponse
 *   JSON-only alors qu'on attend de la prose.
 * @returns {Promise<string>} texte brut renvoyé par le modèle (à parser ensuite)
 */
export async function callProvider({ systemPrompt, provider, providerSettings, maxTokens = 4096, jsonMode = true }) {
  const settings = providerSettings || loadProviderSettings();

  if (provider === "ollama") return callOllama(systemPrompt, maxTokens, settings.ollama, jsonMode);
  if (provider === "openai") return callOpenAiCompatible(systemPrompt, maxTokens, settings.openai, jsonMode);
  if (provider === "claude") return callClaude(systemPrompt, maxTokens, settings.claude);
  if (provider === "gemini-own") return callGeminiDirect(systemPrompt, maxTokens, settings.geminiOwn, jsonMode);
  if (provider === "deepseek") {
    return callOpenAiCompatible(systemPrompt, maxTokens, { ...settings.deepseek, baseUrl: "https://api.deepseek.com" }, jsonMode);
  }
  if (provider === "openai-own") {
    return callOpenAiCompatible(systemPrompt, maxTokens, { ...settings.openaiOwn, baseUrl: "https://api.openai.com/v1" }, jsonMode);
  }
  return callGemini(systemPrompt, maxTokens);
}
