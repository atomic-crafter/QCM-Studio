// js/ai/aiKeyOrchestrator.js
// Politique "quelle clé utiliser" pour le mode Auto : essaie d'abord MA propre
// clé (dans un ordre de préférence), sans jamais l'oublier, puis bascule sur
// les clés partagées disponibles (voir js/sharedKeyVault.js) si besoin —
// jamais l'inverse. S'arrête au premier appel réussi ; lève une erreur
// récapitulative si tout échoue.

import { callProvider, loadProviderSettings } from "./qcmProviders.js";
import { isVaultUnlocked, getConfiguredProviders, getApiKey, hasAnyApiKey } from "./apiKeyVault.js";
import { listSharersForProvider, hasAnySharedKeyAvailable, ALL_PROVIDERS } from "./sharedKeyVault.js";
import { t } from "../core/i18n.js";
import { getFreshAuthToken } from "../auth/auth.js";

// Vrai si l'utilisateur a de quoi utiliser l'IA sans passer par la clé
// admin/allowlist : sa propre clé, OU une clé qu'un autre utilisateur lui a
// partagée directement. Sert de gate côté UI (boutons IA) partout dans l'app.
export async function hasAnyOwnOrSharedKey(uid, username, isGuest = false) {
  if (isGuest || !uid) return false;
  if (await hasAnyApiKey(uid)) return true;
  return hasAnySharedKeyAvailable(username);
}

const OWN_KEY_PRIORITY = [
  { vaultKey: "gemini", dispatch: "gemini-own", settingsKey: "geminiOwn" },
  { vaultKey: "claude", dispatch: "claude", settingsKey: "claude" },
  { vaultKey: "deepseek", dispatch: "deepseek", settingsKey: "deepseek" },
  { vaultKey: "openai", dispatch: "openai-own", settingsKey: "openaiOwn" }
];

function proxyBase() {
  return (window.__GIPHY_PROXY_URL || localStorage.getItem("qcm_giphy_proxy_url") || "").replace(/\/$/, "");
}

// Appelle une clé PARTAGÉE par un autre utilisateur — jamais la clé en clair
// ici : le Worker la déchiffre et fait l'appel IA lui-même (voir
// proxy/cloudflare-giphy-worker.js → handleUseSharedKey), on ne récupère que
// le texte final.
export async function callSharedKey({ ownerUid, provider, systemPrompt, maxTokens = 4096, jsonMode = true, model, pdfParts = null }) {
  const base = proxyBase();
  if (!base) throw new Error(t("qcmCreator.proxyNotConfigured"));
  const token = await getFreshAuthToken();

  const res = await fetch(`${base}/use-shared-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token ? `Bearer ${token}` : "" },
    body: JSON.stringify({ ownerUid, provider, systemPrompt, maxTokens, jsonMode, model, pdfParts: pdfParts || undefined })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || t("qcmCreator.httpError", { status: res.status }));
  if (!data.text) throw new Error(t("aiKeyOrchestrator.emptyResponse"));
  return data.text;
}

/**
 * Renvoie la liste ordonnée des options disponibles pour le mode Auto — sert
 * aussi à peupler le picker "choisir qui emprunter" côté UI.
 * [{ kind: "own", vaultKey }, ...] puis [{ kind: "shared", provider, ownerUid, sharedBy }, ...]
 */
export async function listAvailableKeyOptions(uid, username) {
  const options = [];

  if (uid && isVaultUnlocked()) {
    const configured = await getConfiguredProviders(uid);
    for (const p of OWN_KEY_PRIORITY) {
      if (configured.includes(p.vaultKey)) options.push({ kind: "own", ...p });
    }
  }

  for (const provider of ALL_PROVIDERS) {
    const sharers = await listSharersForProvider(provider, username);
    for (const sharer of sharers) {
      options.push({ kind: "shared", provider, ownerUid: sharer.ownerUid, sharedBy: sharer.sharedBy });
    }
  }

  return options;
}

export async function callWithAutoFallback({ uid, username, systemPrompt, maxTokens = 4096, jsonMode = true }) {
  const errors = [];

  if (uid && isVaultUnlocked()) {
    const configured = await getConfiguredProviders(uid);
    const settings = loadProviderSettings();
    for (const p of OWN_KEY_PRIORITY) {
      if (!configured.includes(p.vaultKey)) continue;
      try {
        const apiKey = await getApiKey(uid, p.vaultKey);
        if (!apiKey) continue;
        const providerSettings = { ...settings, [p.settingsKey]: { ...settings[p.settingsKey], apiKey } };
        return await callProvider({ systemPrompt, provider: p.dispatch, providerSettings, maxTokens, jsonMode });
      } catch (e) {
        errors.push(t("aiKeyOrchestrator.ownKeyErrorEntry", { vaultKey: p.vaultKey, message: e.message }));
      }
    }
  }

  for (const provider of ALL_PROVIDERS) {
    const sharers = await listSharersForProvider(provider, username);
    for (const sharer of sharers) {
      try {
        return await callSharedKey({ ownerUid: sharer.ownerUid, provider, systemPrompt, maxTokens, jsonMode });
      } catch (e) {
        errors.push(t("aiKeyOrchestrator.sharedKeyErrorEntry", { provider, sharedBy: sharer.sharedBy, message: e.message }));
      }
    }
  }

  throw new Error(
    errors.length
      ? t("aiKeyOrchestrator.allKeysFailed", { errors: errors.join(" · ") })
      : t("aiKeyOrchestrator.noKeyAvailable")
  );
}
