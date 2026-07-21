const KATEX_AUTORENDER_URL = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.mjs";
let katexRenderMathInElement = null;
let katexLoadAttempted = false;
let katexReadyPromise = null;

/**
 * Résout une fois que KaTeX est chargé (ou définitivement indisponible).
 * À utiliser avant un premier rendu de contenu LaTeX généré dynamiquement
 * (ex: prévisualisation d'un QCM généré par IA), pour éviter d'afficher du
 * "$...$" brut le temps que le CDN charge le renderer en arrière-plan.
 */
export function ensureKatexReady() {
  if (!katexReadyPromise) katexReadyPromise = loadKatexRenderer();
  return katexReadyPromise;
}

const LATEX_DELIMITERS = [
  { left: "$$", right: "$$", display: true },
  { left: "\\[", right: "\\]", display: true },
  { left: "\\(", right: "\\)", display: false },
  { left: "$", right: "$", display: false }
];

export function renderLatexHtml(value, options = {}) {
  const latexEnabled = options.latexEnabled === true;
  const wrapper = document.createElement("span");
  const text = String(value ?? "");

  wrapper.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");

  if (!latexEnabled) {
    return wrapper.innerHTML;
  }

  // Rendering falls back to escaped HTML if the KaTeX CDN is unavailable.
  if (katexRenderMathInElement) {
    try {
      katexRenderMathInElement(wrapper, {
        delimiters: LATEX_DELIMITERS,
        throwOnError: false,
        strict: "ignore"
      });
    } catch (error) {
      console.warn("LaTeX render failed:", error?.message || error);
    }
  } else if (!katexLoadAttempted) {
    ensureKatexReady();
  }

  return wrapper.innerHTML;
}

export function setLatexContent(element, value) {
  if (!element) return;
  element.innerHTML = renderLatexHtml(value);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadKatexRenderer() {
  katexLoadAttempted = true;
  try {
    const katexModule = await import(KATEX_AUTORENDER_URL);
    if (typeof katexModule?.default === "function") {
      katexRenderMathInElement = katexModule.default;
    }
  } catch (error) {
    console.warn("KaTeX CDN unavailable, continuing without LaTeX rendering:", error?.message || error);
  }
}
