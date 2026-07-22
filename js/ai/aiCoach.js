// js/ai/aiCoach.js
// Coach IA "pourquoi ma réponse est fausse" — utilisé en quiz solo, duel et salle.
// Ordre d'essai : 1) ma propre clé (si configurée et coffre déverrouillé),
// 2) une clé qu'un autre utilisateur m'a partagée directement (voir
// js/aiKeyOrchestrator.js), 3) repli sur la clé Gemini partagée par l'admin
// via le Worker Cloudflare (gated par l'allowlist admin, voir js/aiAccess.js).

import { buildExplainAnswerPrompt } from "./qcmPromptBuilder.js";
import { callWithAutoFallback } from "./aiKeyOrchestrator.js";
import { t } from "../core/i18n.js";
import { getFreshAuthToken } from "../auth/auth.js";

function proxyBase() {
  return (window.__GIPHY_PROXY_URL || localStorage.getItem("qcm_giphy_proxy_url") || "").replace(/\/$/, "");
}

export async function requestAiWrongAnswerExplanation({
  question,
  options,
  correctIndex,
  selectedIndex,
  officialExplanation = "",
  language = "fr",
  uid = null,
  username = null
}) {
  const systemPrompt = buildExplainAnswerPrompt({ question, options, correctIndex, selectedIndex, officialExplanation, language });

  // 1) & 2) Ma propre clé, puis les clés partagées disponibles — en
  // best-effort : si tout ça échoue (aucune clé configurée/partagée, ou
  // toutes en erreur), on retombe sur la clé partagée par l'admin ci-dessous
  // plutôt que d'échouer directement.
  try {
    const ownOrSharedResult = await callWithAutoFallback({ uid, username, systemPrompt, maxTokens: 1024, jsonMode: false });
    const trimmed = String(ownOrSharedResult || "").trim();
    if (trimmed) return trimmed.slice(0, 2200);
  } catch (e) {
    // silencieux : on retente avec la clé partagée par l'admin ci-dessous
  }

  // 3) Repli : clé Gemini partagée par l'admin via le Worker (gated admin/allowlist).
  const base = proxyBase();
  if (!base) {
    throw new Error(t("qcmCreator.proxyNotConfigured"));
  }

  const token = await getFreshAuthToken();

  const res = await fetch(`${base}/explain-answer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": token ? `Bearer ${token}` : ""
    },
    body: JSON.stringify({
      question,
      options,
      correctIndex,
      selectedIndex,
      officialExplanation,
      language
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 429) {
      throw new Error(t("aiCoach.quotaError"));
    }
    if (res.status === 403) {
      throw new Error(data.error || t("aiCoach.accessRestricted"));
    }
    throw new Error(data.error || t("qcmCreator.httpError", { status: res.status }));
  }

  const explanation = String(data.explanation || "").trim();
  if (!explanation) throw new Error(t("aiCoach.emptyResponse"));
  return explanation;
}
