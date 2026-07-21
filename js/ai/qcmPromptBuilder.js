// js/ai/qcmPromptBuilder.js
// Construit les prompts envoyés aux modèles (Gemini / Ollama / API compatible OpenAI)
// pour transformer le texte extrait de PDF en QCM, et pour "tweaker" une question isolée.
//
// Toute la logique de prompt vit ici (source unique) pour que Gemini, Ollama et les API
// compatibles OpenAI reçoivent exactement les mêmes règles.

const QUESTION_COUNT_PRESETS = {
  few:    { label: "Peu (5–8)",              min: 5,  max: 8,  instruction: "Génère un petit nombre de questions (entre 5 et 8), en ne gardant que les notions les plus importantes." },
  medium: { label: "Moyen (12–18)",          min: 12, max: 18, instruction: "Génère un nombre moyen de questions (entre 12 et 18), en couvrant les notions principales sans être exhaustif." },
  many:   { label: "Beaucoup (25–35)",       min: 25, max: 35, instruction: "Génère beaucoup de questions (entre 25 et 35), en couvrant la majorité des notions du contenu source." },
  max:    { label: "Maximum (exhaustif)",     min: 20, max: 80, instruction: "Génère le plus grand nombre de questions pertinentes possible pour couvrir EXHAUSTIVEMENT tout le contenu source, sans jamais inventer de contenu ni te répéter. Utilise ton jugement sur la richesse du contenu source pour décider du nombre exact (ça peut aller jusqu'à 80 si le contenu le justifie)." }
};

// Rappel ajouté à CHAQUE consigne de comptage : sans ça, certains modèles
// (surtout les petits modèles locaux) s'arrêtent après 2-3 questions dès que
// le contenu source est court (ex: un TD d'une page), au lieu de considérer
// le nombre demandé comme un minimum à atteindre en variant les angles.
const COUNT_MINIMUM_REMINDER =
  " Ce nombre est un MINIMUM à respecter même si le contenu source semble court : " +
  "varie les angles pour chaque notion (définition, application pratique, comparaison, calcul, piège classique, cas particulier) " +
  "plutôt que de t'arrêter tôt sous prétexte que le contenu source est limité.";

export function getQuestionCountPresets() {
  return QUESTION_COUNT_PRESETS;
}

// Nombre minimum de questions attendu pour countMode/exactCount — utilisé
// côté UI pour détecter et signaler un sous-remplissage (ex: "medium" demandé,
// seulement 3 questions valides reçues).
export function getExpectedMinCount(countMode, exactCount) {
  if (countMode === "exact") {
    return Math.min(100, Math.max(1, parseInt(exactCount, 10) || 10));
  }
  return (QUESTION_COUNT_PRESETS[countMode] || QUESTION_COUNT_PRESETS.medium).min;
}

function buildCountInstruction(countMode, exactCount) {
  if (countMode === "exact") {
    const n = Math.min(100, Math.max(1, parseInt(exactCount, 10) || 10));
    return `Génère EXACTEMENT ${n} questions. Ni plus, ni moins.` + COUNT_MINIMUM_REMINDER;
  }
  const preset = QUESTION_COUNT_PRESETS[countMode] || QUESTION_COUNT_PRESETS.medium;
  return preset.instruction + COUNT_MINIMUM_REMINDER;
}

// Budget de tokens de sortie, dimensionné sur le nombre de questions attendu.
// Un budget trop court coupe le JSON avant la fin (cause n°1 des échecs de parsing
// avec les modèles locaux) ; on vise large plutôt que de tronquer.
const TOKENS_PER_QUESTION = 220;
const TOKENS_OVERHEAD = 300;

export function estimateMaxTokens(countMode, exactCount) {
  const expectedCount = countMode === "exact"
    ? Math.min(100, Math.max(1, parseInt(exactCount, 10) || 10))
    : (QUESTION_COUNT_PRESETS[countMode] || QUESTION_COUNT_PRESETS.medium).max;

  return Math.min(12000, Math.max(1536, TOKENS_OVERHEAD + expectedCount * TOKENS_PER_QUESTION));
}

const LANGUAGE_NAMES = {
  fr: "français",
  en: "anglais",
  es: "espagnol",
  de: "allemand",
  it: "italien",
  zh: "chinois (mandarin simplifié)",
  pt: "portugais",
  nl: "néerlandais"
};

function languageInstruction(languageCode) {
  const name = LANGUAGE_NAMES[languageCode] || languageCode || "français";
  return `Écris INTÉGRALEMENT en ${name} : les questions, les options de réponse, les catégories (cat) et les explications (exp). N'utilise aucune autre langue, sauf pour les termes techniques qui n'ont pas de traduction standard.`;
}

const DIFFICULTY_INSTRUCTIONS = {
  easy:   "Niveau facile : questions de restitution directe et de compréhension de base, peu de pièges.",
  medium: "Niveau intermédiaire : mélange de restitution et d'application, quelques questions pièges classiques.",
  hard:   "Niveau difficile : questions d'application et d'analyse, distracteurs plausibles et proches du concept correct.",
  mixed:  "Mélange de niveaux : varie la difficulté d'une question à l'autre (facile, intermédiaire, difficile) pour couvrir tous les profils."
};

function difficultyInstruction(difficulty) {
  return DIFFICULTY_INSTRUCTIONS[difficulty] || DIFFICULTY_INSTRUCTIONS.medium;
}

// Règles LaTeX/KaTeX reprises du README ("Écrire des questions avec LaTeX").
const LATEX_RULES_ON = `
RÈGLES LATEX / KATEX (formules mathématiques) — ACTIVÉES PAR DÉFAUT :
- Le moteur de rendu est KaTeX. Utilise du LaTeX standard pour TOUTE formule, notation mathématique, physique ou bra-ket.
- Délimiteurs : "$...$" pour une formule en ligne, "$$...$$" pour une formule mise en avant (affichée seule).
- Utilise les commandes standard : "\\\\frac{a}{b}", "\\\\sqrt{x}", "\\\\alpha", "\\\\beta", "\\\\sigma_x", "\\\\langle" et "\\\\rangle" pour la notation bra-ket, "\\\\begin{pmatrix} ... \\\\ ... \\\\end{pmatrix}" pour les matrices (retours à la ligne avec "\\\\").
- Comme le résultat final est un STRING JSON, ÉCHAPPE chaque antislash LaTeX en double antislash dans le JSON (ex: la commande LaTeX "\\alpha" doit apparaître comme "\\\\alpha" dans la valeur JSON, "|0\\rangle" doit apparaître comme "|0\\\\rangle").
- N'invente JAMAIS de notation approximative (interdit : "|0angle", "sigma x" sans backslash, "alpha" sans backslash) : reste sur du LaTeX standard valide.
- Ne mets du LaTeX QUE sur les symboles/formules mathématiques ; garde le reste du texte en langage naturel.
- Si le contenu source ne contient aucune formule, n'invente pas de notation mathématique artificielle : du texte simple sans LaTeX est parfaitement acceptable.
- Exception : si les instructions de l'utilisateur ci-dessous demandent explicitement de NE PAS utiliser de LaTeX/formules, ignore ces règles LaTeX et écris tout en texte brut.`.trim();

const LATEX_RULES_OFF = `
RÈGLES LATEX / KATEX : DÉSACTIVÉES.
- N'utilise AUCUNE notation LaTeX (pas de "$...$", pas de "\\\\frac", pas de "\\\\langle", etc.).
- Écris toutes les formules ou notations en texte brut lisible (ex: "racine carrée de x", "alpha", "P(A|B)").`.trim();

const JSON_FORMAT_SPEC = `
FORMAT DE SORTIE — JSON STRICT :
Réponds UNIQUEMENT avec un objet JSON valide de la forme {"questions": [...]}, sans aucun texte avant/après, sans balises markdown (pas de \`\`\`), sans commentaires.

Chaque question de "questions" doit avoir EXACTEMENT cette forme :
{
  "cat": "Nom de catégorie/thème court (ex: '🔑 RSA', 'Chapitre 2 - Cinématique')",
  "q": "Texte de la question, clair et autonome (compréhensible sans revoir le PDF)",
  "opts": ["Option A", "Option B", "Option C", "Option D"],
  "ans": 0,
  "exp": "Explication pédagogique (voir règles ci-dessous)"
}

Règles strictes :
- "opts" DOIT contenir 4 propositions dans l'immense majorité des cas — c'est la cible à respecter systématiquement. Ne descends JAMAIS en dessous de 3 propositions, sauf cas absolument extrême où même un 3ᵉ distracteur plausible est impossible à formuler à partir du contenu source (2 propositions doit rester l'exception rarissime, pas une solution de facilité) ; n'invente JAMAIS une option bidon/hors-sujet juste pour atteindre 4 — dans le doute, préfère 3 bonnes options à 4 dont une hors-sujet. Toutes les options doivent être plausibles, de longueur comparable (évite qu'une option soit visiblement plus longue/détaillée que les autres, ce qui la trahirait comme correcte).
- "ans" est l'INDEX 0-based de la bonne réponse (0, 1, 2 ou 3). Si — et seulement si — plusieurs réponses sont correctes pour une question à choix multiple, remplace "ans" par un TABLEAU d'index triés (ex: [0, 2]). Dans ce cas, précise dans "q" que plusieurs réponses sont attendues.
- Ne fabrique jamais une question dont la réponse ne peut pas être déduite du contenu source ou des connaissances standard du domaine.
- Varie les catégories ("cat") pour refléter les différentes sections/thèmes du contenu source.
- INTERDIT de générer deux fois la même question (même reformulée) ou de recycler la même structure/les mêmes options en changeant juste un mot : avant d'écrire chaque question, vérifie mentalement qu'elle porte sur une notion, un exemple ou un angle différent de TOUTES les questions précédentes de la liste.
- Si tu remarques que tu es sur le point de répéter une question déjà posée, choisis une autre notion du contenu source plutôt que de la reformuler.`.trim();

const SOURCE_EXTRACTION_CAVEAT = `
NOTE SUR L'EXTRACTION DU TEXTE SOURCE :
Le contenu source a été extrait automatiquement d'un PDF. Le texte normal est généralement fiable,
mais les formules mathématiques/physiques peuvent apparaître corrompues ou approximatives (glyphes
mal convertis, symboles manquants, exposants/indices aplatis, séquences bizarres) à cause des
limites de l'extraction de texte PDF — c'est un problème connu, PAS une information du cours.
- Ne recopie JAMAIS tel quel un symbole visiblement corrompu : reconstruis la formule la plus
  probable à partir du contexte (nom de la formule, unités, variables citées autour).
- Si une formule reste réellement ambiguë après reconstruction, ne l'invente pas : pose la question
  sur le concept ou la méthode plutôt que sur les détails exacts de cette formule.
- Ignore aussi le texte manifestement parasite (numéros de page, en-têtes/pieds de page répétés,
  artefacts de mise en page).`.trim();

const EXPLANATION_RULES = `
RÈGLE CRITIQUE POUR "exp" (explication) :
L'objectif n'est PAS que l'utilisateur mémorise "la bonne réponse est B". L'objectif est qu'il COMPRENNE pourquoi.
Pour chaque question, "exp" doit :
1. Expliquer le raisonnement ou le principe qui rend la bonne réponse correcte (le "pourquoi", pas juste "quoi").
2. Mentionner brièvement pourquoi le distracteur le plus proche/tentant est un piège (l'erreur de raisonnement qu'il induit), quand c'est pertinent.
3. Rester concis : 1 à 3 phrases, denses en information, jamais une simple reformulation de la question.
Interdiction : ne JAMAIS écrire une explication du type "La réponse correcte est X" sans justification du raisonnement.`.trim();

function truncateSourceText(sourceText, maxChars) {
  const text = String(sourceText || "");
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/**
 * Construit le prompt système complet envoyé au modèle pour générer un QCM
 * à partir du texte extrait de PDF + des instructions utilisateur.
 */
export function buildGenerationPrompt({
  sourceText,
  userInstructions,
  countMode = "medium",
  exactCount,
  language = "fr",
  difficulty = "medium",
  latexEnabled = true,
  maxSourceChars = 220000
}) {
  const { text: truncatedSource, truncated } = truncateSourceText(sourceText, maxSourceChars);

  const parts = [
    "Tu es un expert en pédagogie et en création de QCM d'entraînement à partir de supports de cours (PDF).",
    "Utilise le CONTENU SOURCE ci-dessous comme base factuelle principale pour générer les questions. Ne te contredis jamais avec ce contenu.",
    "",
    "── CONTENU SOURCE (extrait des PDF fournis) ──",
    truncatedSource,
    truncated ? "\n[... contenu source tronqué car trop long, base-toi sur ce qui précède ...]" : "",
    "── FIN DU CONTENU SOURCE ──",
    "",
    SOURCE_EXTRACTION_CAVEAT,
    "",
    userInstructions?.trim()
      ? `── INSTRUCTIONS SPÉCIFIQUES DE L'UTILISATEUR (priment sur le reste si contradiction) ──\n${userInstructions.trim()}\n── FIN DES INSTRUCTIONS ──`
      : "",
    "",
    "NOMBRE DE QUESTIONS :",
    buildCountInstruction(countMode, exactCount),
    "",
    "LANGUE :",
    languageInstruction(language),
    "",
    "DIFFICULTÉ :",
    difficultyInstruction(difficulty),
    "",
    latexEnabled ? LATEX_RULES_ON : LATEX_RULES_OFF,
    "",
    EXPLANATION_RULES,
    "",
    JSON_FORMAT_SPEC
  ];

  return parts.filter(Boolean).join("\n");
}

/**
 * Construit le prompt pour "tweaker" (régénérer) une seule question existante,
 * en gardant le contexte de la source et la consigne libre de l'utilisateur.
 */
export function buildTweakPrompt({
  sourceText,
  question,
  tweakInstruction,
  language = "fr",
  latexEnabled = true,
  maxSourceChars = 4000
}) {
  const { text: truncatedSource, truncated } = truncateSourceText(sourceText, maxSourceChars);

  // La question à modifier + la consigne passent EN PREMIER (juste après
  // l'intro), avant l'extrait de source : un tweak n'a besoin que d'un peu de
  // contexte factuel, pas du cours entier, et si jamais un modèle local tronque
  // le prompt (fenêtre de contexte trop petite), ce qui compte vraiment ne doit
  // jamais être la partie coupée — sinon on obtient une question sans aucun
  // rapport avec celle qu'on voulait modifier.
  const parts = [
    "Tu es un expert en pédagogie et en création de QCM. On te donne UNE question existante d'un QCM et une consigne de modification.",
    "Réécris UNIQUEMENT cette question selon la consigne, en gardant le même sujet général sauf si la consigne dit le contraire.",
    "",
    "── QUESTION ACTUELLE (celle à modifier, et UNIQUEMENT celle-là) ──",
    JSON.stringify(question),
    "── FIN DE LA QUESTION ACTUELLE ──",
    "",
    "── CONSIGNE DE MODIFICATION ──",
    String(tweakInstruction || "").trim() || "Améliore la clarté et la qualité pédagogique de cette question.",
    "── FIN DE LA CONSIGNE ──",
    "",
    truncatedSource
      ? `── EXTRAIT DE LA SOURCE (contexte factuel, pas la question à traiter) ──\n${truncatedSource}${truncated ? "\n[... tronqué ...]" : ""}\n── FIN DE L'EXTRAIT ──\n\n${SOURCE_EXTRACTION_CAVEAT}\n`
      : "",
    "LANGUE :",
    languageInstruction(language),
    "",
    latexEnabled ? LATEX_RULES_ON : LATEX_RULES_OFF,
    "",
    EXPLANATION_RULES,
    "",
    "FORMAT DE SORTIE — JSON STRICT :",
    `Réponds UNIQUEMENT avec un objet JSON valide de la forme {"question": {"cat": "...", "q": "...", "opts": ["...","...","...","..."], "ans": 0, "exp": "..."}}, sans aucun texte avant/après, sans balises markdown.`,
    `"opts" doit contenir EXACTEMENT 4 propositions. "ans" est un index 0-based (ou un tableau d'index si plusieurs bonnes réponses).`
  ];

  return parts.filter(Boolean).join("\n");
}

/**
 * Construit le prompt pour le simple flux "Créer un QCM" (un sujet libre, pas
 * de PDF source) — reprend les mêmes règles qualité (LaTeX, explications
 * "pourquoi", format JSON) que buildGenerationPrompt, sans la partie "contenu
 * source" qui n'a pas de sens ici.
 */
export function buildTopicPrompt({ topic, count = 10, language = "fr", latexEnabled = true }) {
  const n = Math.min(50, Math.max(1, parseInt(count, 10) || 10));

  const parts = [
    "Tu es un expert en pédagogie et en création de QCM d'entraînement.",
    `Génère EXACTEMENT ${n} questions de QCM sur le sujet suivant : "${String(topic || "").trim()}".` + COUNT_MINIMUM_REMINDER,
    "",
    "LANGUE :",
    languageInstruction(language),
    "",
    latexEnabled ? LATEX_RULES_ON : LATEX_RULES_OFF,
    "",
    EXPLANATION_RULES,
    "",
    JSON_FORMAT_SPEC
  ];

  return parts.filter(Boolean).join("\n");
}

// Prompt du coach IA "pourquoi ma réponse est fausse" — repris fidèlement du
// prompt existant côté Worker (proxy/cloudflare-giphy-worker.js,
// handleExplainAnswer) pour que le résultat soit identique qu'on passe par la
// clé partagée (Worker) ou par sa propre clé (appel direct navigateur).
export function buildExplainAnswerPrompt({ question, options, correctIndex, selectedIndex, officialExplanation = "", language = "fr" }) {
  const lang = ["fr", "en", "zh"].includes(language) ? language : "fr";
  const letters = ["A", "B", "C", "D"];
  const opts = (options || []).slice(0, 4);
  const maxChars = 1800;

  const noAnswerLabel = lang === "en" ? "No answer (timeout)" : lang === "zh" ? "未作答（时间到）" : "Aucune réponse (temps écoulé)";
  const selectedLabel = [0, 1, 2, 3].includes(selectedIndex) ? `${letters[selectedIndex]}: ${opts[selectedIndex]}` : noAnswerLabel;
  const correctLabel = `${letters[correctIndex]}: ${opts[correctIndex]}`;

  if (lang === "en") {
    return `You are a pedagogical AI tutor. Explain clearly and kindly why the player's answer is wrong.
You MUST answer ONLY in English. Do not use French or Chinese.
Return plain text only (no markdown), 4 to 8 short sentences, and keep the total response under ${maxChars} characters.

Question: ${question}
Options:
- A: ${opts[0]}
- B: ${opts[1]}
- C: ${opts[2]}
- D: ${opts[3]}

Player answer: ${selectedLabel}
Correct answer: ${correctLabel}
${officialExplanation ? `Official explanation: ${officialExplanation}` : ""}

Rules:
- Be concise and concrete.
- Explain why the player answer is incorrect.
- Explain why the correct answer is correct.
- If you write formulas, use standard LaTeX with $...$ delimiters (example: $P(0)=|\\alpha|^2$).
- Use proper commands (\\alpha, \\beta, \\langle, \\rangle, \\frac, \\sqrt, \\sigma_x), never broken text like |0angle.
- End with one practical memory tip.
- Strictly respect the ${maxChars}-character maximum.`;
  }

  if (lang === "zh") {
    return `你是一位友善的教学辅导 AI。请清晰说明为什么玩家的答案是错的。
你必须只使用中文（简体中文）回答，不得使用法语或英语。
仅使用纯文本回复（不要 Markdown），4 到 8 句短句，总长度不超过 ${maxChars} 个字符。

题目：${question}
选项：
- A：${opts[0]}
- B：${opts[1]}
- C：${opts[2]}
- D：${opts[3]}

玩家答案：${selectedLabel}
正确答案：${correctLabel}
${officialExplanation ? `官方解析：${officialExplanation}` : ""}

规则：
- 简洁、具体。
- 说明玩家答案为什么错。
- 说明正确答案为什么对。
- 如果写公式，请使用标准 LaTeX 并用 $...$ 包裹（例如：$P(0)=|\\alpha|^2$）。
- 使用规范命令（\\alpha, \\beta, \\langle, \\rangle, \\frac, \\sqrt, \\sigma_x），不要写成 |0angle 这类损坏形式。
- 最后给出 1 条实用记忆技巧。
- 严格遵守不超过 ${maxChars} 个字符。`;
  }

  return `Tu es un coach pédagogique bienveillant. Explique clairement pourquoi la réponse du joueur est fausse.
Tu dois répondre UNIQUEMENT en français. N'utilise ni anglais ni chinois.
Réponds en texte brut uniquement (pas de markdown), 4 à 8 phrases courtes, et garde la réponse sous ${maxChars} caractères.

Question : ${question}
Options :
- A : ${opts[0]}
- B : ${opts[1]}
- C : ${opts[2]}
- D : ${opts[3]}

Réponse du joueur : ${selectedLabel}
Bonne réponse : ${correctLabel}
${officialExplanation ? `Explication officielle : ${officialExplanation}` : ""}

Règles :
- Sois concis et concret.
- Explique pourquoi la réponse du joueur est incorrecte.
- Explique pourquoi la bonne réponse est la bonne.
- Si tu écris des formules, utilise du LaTeX standard avec délimiteurs $...$ (ex: $P(0)=|\\alpha|^2$).
- Utilise les commandes correctes (\\alpha, \\beta, \\langle, \\rangle, \\frac, \\sqrt, \\sigma_x), jamais des formes cassées comme |0angle.
- Termine par une astuce mémo en 1 ligne.
- Respecte strictement la limite de ${maxChars} caractères.`;
}
