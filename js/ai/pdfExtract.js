// js/ai/pdfExtract.js
// Extraction de texte depuis des fichiers PDF, côté navigateur, via PDF.js (CDN).
// Aucune dépendance de build : PDF.js est chargé dynamiquement au premier besoin.

const PDFJS_VERSION = "3.11.174";
const PDFJS_SCRIPT_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`;
const PDFJS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;

let pdfjsLoadPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-pdfjs-loader="${src}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Échec de chargement de PDF.js")));
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.pdfjsLoader = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Échec de chargement de PDF.js (CDN indisponible)"));
    document.head.appendChild(script);
  });
}

async function ensurePdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  if (!pdfjsLoadPromise) {
    pdfjsLoadPromise = loadScript(PDFJS_SCRIPT_URL).then(() => {
      if (!window.pdfjsLib) throw new Error("PDF.js chargé mais indisponible (pdfjsLib manquant)");
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return window.pdfjsLib;
    });
  }
  return pdfjsLoadPromise;
}

/**
 * Extrait le texte brut d'un unique fichier PDF (File / Blob).
 * @param {File} file
 * @param {(info: {page: number, totalPages: number}) => void} [onProgress]
 * @returns {Promise<{text: string, pageCount: number}>}
 */
export async function extractTextFromPdf(file, onProgress) {
  const pdfjsLib = await ensurePdfJs();
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;

  const pageTexts = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str || "").join(" ");
    pageTexts.push(pageText.trim());
    if (typeof onProgress === "function") {
      onProgress({ page: pageNumber, totalPages: pdf.numPages });
    }
  }

  await pdf.destroy();

  return {
    text: pageTexts.join("\n\n"),
    pageCount: pdf.numPages
  };
}

/**
 * Extrait et concatène le texte de plusieurs PDF, avec un séparateur nommé par fichier.
 * @param {File[]} files
 * @param {(info: {fileIndex: number, fileName: string, page: number, totalPages: number, totalFiles: number}) => void} [onProgress]
 */
export async function extractTextFromPdfs(files, onProgress) {
  const sections = [];
  let totalPages = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    const { text, pageCount } = await extractTextFromPdf(file, ({ page, totalPages: fileTotalPages }) => {
      if (typeof onProgress === "function") {
        onProgress({
          fileIndex,
          fileName: file.name,
          page,
          totalPages: fileTotalPages,
          totalFiles: files.length
        });
      }
    });

    totalPages += pageCount;
    sections.push(`── Document : ${file.name} ──\n${text}`);
  }

  return {
    text: sections.join("\n\n"),
    totalPages,
    totalFiles: files.length
  };
}

/**
 * Encode un fichier PDF en base64 pour l'envoyer tel quel à une API qui lit
 * les PDF nativement (Gemini inline_data, Claude document block) — utilisé
 * par le mode "envoyer le PDF directement à l'IA" (voir js/ai/qcmFromPdf.js),
 * alternative à l'extraction de texte côté navigateur (plus fiable pour les
 * tableaux/schémas/formules, puisque le modèle lit le PDF lui-même).
 * @param {File} file
 * @returns {Promise<string>} base64 sans le préfixe "data:...;base64,"
 */
export async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Encode plusieurs fichiers PDF en base64, prêts à être envoyés comme pièces
 * jointes natives à une API (voir fileToBase64).
 * @param {File[]} files
 * @returns {Promise<{mimeType: string, data: string, name: string}[]>}
 */
export async function filesToBase64Parts(files) {
  return Promise.all(files.map(async file => ({
    mimeType: "application/pdf",
    data: await fileToBase64(file),
    name: file.name
  })));
}
