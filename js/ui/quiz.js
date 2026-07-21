// js/ui/quiz.js
// Moteur de quiz : rendu des questions, timer, scoring, résultats.

import { state, toast, showScreen, setNextQuestionHandler } from "../core/runtime.js";
import { saveScore } from "../data-access/firebase.js";
import { requestAiWrongAnswerExplanation } from "../ai/aiCoach.js";
import { canUseAi } from "../auth/aiAccess.js";
import { hasAnyOwnOrSharedKey } from "../ai/aiKeyOrchestrator.js";
import { renderLatexHtml } from "../core/latex.js";
import { areAnswersEqual, getCorrectAnswerIndices, isMultiAnswerQuestion, normalizeSelectedAnswer } from "../core/questionUtils.js";

// ── ÉTAT LOCAL DU QUIZ ────────────────────────────────────────────────────────
let questions    = [];
let subject      = null;
let currentIndex = 0;
let score        = 0;
let streak       = 0;
let maxStreak    = 0;
let answered     = false;
let timerInterval = null;
let timeLeft     = 0;
let timedMode    = false;
let optionOrderByQuestion = new Map();
let answerReview = [];
let currentSelection = [];

// ── HELPERS ──────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getOptionOrder(questionIndex, optionCount) {
  const existingOrder = optionOrderByQuestion.get(questionIndex);
  if (Array.isArray(existingOrder) && existingOrder.length === optionCount) {
    return existingOrder;
  }

  const indices = Array.from({ length: optionCount }, (_, i) => i);
  const shuffledIndices = shuffle(indices);
  optionOrderByQuestion.set(questionIndex, shuffledIndices);
  return shuffledIndices;
}

function isLatexEnabled() {
  return subject?.latex === true;
}

// ── START ─────────────────────────────────────────────────────────────────────
export function startQuiz(subjectObj, count, timed = false, filter = null) {
  stopQuiz();
  if (!subjectObj || !Array.isArray(subjectObj.questions)) {
    console.warn("startQuiz invalid subject:", { subjectObj, count, timed, filter });
    toast("❌ Quiz invalide");
    return false;
  }

  subject   = subjectObj;
  timedMode = timed;

  let pool = filter
    ? subjectObj.questions.filter(q => q.cat === filter)
    : [...subjectObj.questions];

  const effectiveCount = (timed && !filter)
    ? pool.length
    : Math.min(count, pool.length);

  pool = shuffle(pool).slice(0, effectiveCount);

  if (pool.length === 0) {
    console.warn("startQuiz empty pool:", {
      subjectId: subjectObj.id,
      subjectName: subjectObj.name,
      requestedCount: count,
      timed,
      filter,
      availableQuestions: subjectObj.questions.length
    });
    toast("❌ Aucun quiz disponible pour cette sélection");
    questions = [];
    currentIndex = 0;
    score = 0;
    streak = 0;
    maxStreak = 0;
    return false;
  }

  questions    = pool;
  currentIndex = 0;
  score        = 0;
  streak       = 0;
  maxStreak    = 0;
  optionOrderByQuestion = new Map();
  answerReview = new Array(questions.length).fill(null);

  document.getElementById("quiz-subject-label").textContent = subjectObj.name;
  document.getElementById("q-total").textContent = questions.length;
  setNextQuestionHandler(nextQuestion);

  renderQuestion();
  return true;
}

export function stopQuiz() {
  clearInterval(timerInterval);
}

// ── RENDER QUESTION ──────────────────────────────────────────────────────────
function renderQuestion() {
  clearInterval(timerInterval);
  answered = false;
  currentSelection = [];

  const q = questions[currentIndex];
  if (!q || !Array.isArray(q.opts)) {
    console.warn("renderQuestion invalid question:", currentIndex, q);
    showResults();
    return;
  }

  document.getElementById("q-num").textContent = currentIndex + 1;
  document.getElementById("q-category").textContent = q.cat || "";
  document.getElementById("q-text").innerHTML = renderLatexHtml(q.q, { latexEnabled: isLatexEnabled() });
  document.getElementById("explanation").classList.remove("show");
  document.getElementById("explanation").innerHTML = "";
  document.getElementById("btn-next").classList.remove("show");
  document.getElementById("streak-badge").textContent = streak >= 3 ? `🔥 Série : ${streak}` : "";

  const pct = (currentIndex / questions.length) * 100;
  document.getElementById("progress-bar").style.width = pct + "%";

  // Render options
  const optsEl  = document.getElementById("options");
  optsEl.innerHTML = "";

  const optionOrder = getOptionOrder(currentIndex, q.opts.length);
  optionOrder.forEach((answerIndex, displayIndex) => {
    const opt = q.opts[answerIndex];
    const div = document.createElement("div");
    div.className = "option";
    div.dataset.answerIndex = String(answerIndex);
    div.innerHTML = `<div class="option-letter">${String.fromCharCode(65 + displayIndex)}</div><span class="option-text">${renderLatexHtml(opt, { latexEnabled: isLatexEnabled() })}</span>`;
    div.onclick = () => selectAnswer(answerIndex, div);
    optsEl.appendChild(div);
  });

  updateActionButton();

  // Timer
  if (timedMode) {
    timeLeft = 60;
    updateTimer();
    timerInterval = setInterval(() => {
      timeLeft--;
      updateTimer();
      if (timeLeft <= 0) {
        clearInterval(timerInterval);
        revealAnswer(-1); // Temps écoulé = mauvaise réponse
      }
    }, 1000);
  } else {
    document.getElementById("timer").textContent = "";
  }
}

function updateTimer() {
  const el = document.getElementById("timer");
  el.textContent = `⏱ ${timeLeft}s`;
  el.className = "timer";
  if (timeLeft <= 10) el.classList.add("warn");
  if (timeLeft <= 5)  el.classList.add("danger");
}

function updateActionButton() {
  const nextBtn = document.getElementById("btn-next");
  if (!nextBtn) return;

  const q = questions[currentIndex];
  if (!q) return;

  const multi = isMultiAnswerQuestion(q);

  if (!answered && multi) {
    nextBtn.classList.add("show");
    nextBtn.disabled = currentSelection.length === 0;
    nextBtn.textContent = "Valider →";
    return;
  }

  if (!answered) {
    nextBtn.classList.remove("show");
    nextBtn.disabled = false;
    nextBtn.textContent = currentIndex < questions.length - 1 ? "Suivant →" : "Voir les résultats →";
    return;
  }

  nextBtn.classList.add("show");
  nextBtn.disabled = false;
  nextBtn.textContent = currentIndex < questions.length - 1 ? "Suivant →" : "Voir les résultats →";
}

// ── ANSWER LOGIC ─────────────────────────────────────────────────────────────
function selectAnswer(index, el) {
  if (answered) return;

  const q = questions[currentIndex];
  if (isMultiAnswerQuestion(q)) {
    const currentIndexInSelection = currentSelection.indexOf(index);
    if (currentIndexInSelection >= 0) {
      currentSelection.splice(currentIndexInSelection, 1);
      el.classList.remove("selected");
    } else {
      currentSelection.push(index);
      el.classList.add("selected");
    }

    updateActionButton();
    return;
  }

  document.querySelectorAll(".option").forEach(o => o.classList.remove("selected"));
  el.classList.add("selected");
  revealAnswer(index);
}

function revealAnswer(selected) {
  clearInterval(timerInterval);
  answered = true;

  const q = questions[currentIndex];
  const options = document.querySelectorAll(".option");
  const selectedIndices = normalizeSelectedAnswer(selected);
  const correctIndices = getCorrectAnswerIndices(q);

  answerReview[currentIndex] = {
    questionNumber: currentIndex + 1,
    category: q.cat || "",
    question: q.q || "",
    options: Array.isArray(q.opts) ? q.opts : [],
    selectedIndex: Array.isArray(selected) ? [...selectedIndices] : (selectedIndices[0] ?? -1),
    correctIndex: Array.isArray(q.ans) ? [...correctIndices] : (correctIndices[0] ?? -1),
    isCorrect: areAnswersEqual(q, selected),
    explanation: q.exp || ""
  };

  options.forEach((o) => {
    const answerIndex = Number.parseInt(o.dataset.answerIndex || "-1", 10);
    if (correctIndices.includes(answerIndex)) o.classList.add("correct");
    else if (selectedIndices.includes(answerIndex) && !correctIndices.includes(answerIndex)) o.classList.add("wrong");
  });

  // Explication
  const expEl = document.getElementById("explanation");
  if (q.exp) {
    expEl.innerHTML = `<strong>💡 Explication :</strong> ${renderLatexHtml(q.exp, { latexEnabled: isLatexEnabled() })}`;
    expEl.classList.add("show");
  }

  // Scoring
  if (areAnswersEqual(q, selected)) {
    score++;
    streak++;
    maxStreak = Math.max(maxStreak, streak);
    if (streak >= 3) toast(`🔥 Série de ${streak} !`);
  } else {
    streak = 0;
    if (selected === -1 || (Array.isArray(selected) && selected.length === 0)) toast("⏱ Temps écoulé !");
    renderAskAiAction(q, selected);
  }

  document.getElementById("streak-badge").textContent = streak >= 3 ? `🔥 Série : ${streak}` : "";

  const nextBtn = document.getElementById("btn-next");
  nextBtn.classList.add("show");
  nextBtn.textContent = currentIndex < questions.length - 1
    ? "Suivant →"
    : "Voir les résultats →";

  updateActionButton();
}

function renderAskAiAction(q, selected) {
  const expEl = document.getElementById("explanation");
  if (!expEl) return;

  if (isMultiAnswerQuestion(q)) {
    const note = document.createElement("div");
    note.style.marginTop = "0.8rem";
    note.className = "btn secondary";
    note.style.display = "inline-flex";
    note.textContent = "🤖 IA indisponible pour les réponses multiples";
    expEl.appendChild(note);
    expEl.classList.add("show");
    return;
  }

  const row = document.createElement("div");
  row.style.marginTop = "0.8rem";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn secondary";
  btn.textContent = "🤖 Demander à l'IA pourquoi";

  const controls = document.createElement("div");
  controls.style.display = "flex";
  controls.style.alignItems = "center";
  controls.style.gap = "0.5rem";
  controls.style.marginBottom = "0.5rem";

  const langLabel = document.createElement("label");
  langLabel.textContent = "Langue :";
  langLabel.style.fontSize = "0.9rem";

  const langSelect = document.createElement("select");
  langSelect.className = "btn secondary";
  langSelect.style.padding = "0.35rem 0.5rem";
  langSelect.style.minWidth = "130px";

  const languageOptions = [
    { value: "fr", label: "Français" },
    { value: "en", label: "English" },
    { value: "zh", label: "中文 (Mandarin)" }
  ];

  const storedLanguage = localStorage.getItem("qcm_ai_explain_language") || "fr";
  const initialLanguage = languageOptions.some(opt => opt.value === storedLanguage) ? storedLanguage : "fr";

  for (const opt of languageOptions) {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === initialLanguage) option.selected = true;
    langSelect.appendChild(option);
  }

  langSelect.onchange = () => {
    localStorage.setItem("qcm_ai_explain_language", langSelect.value || "fr");
  };

  langLabel.appendChild(langSelect);
  controls.appendChild(langLabel);

  const aiAnswer = document.createElement("div");
  aiAnswer.style.marginTop = "0.6rem";
  aiAnswer.style.whiteSpace = "pre-wrap";
  aiAnswer.style.fontSize = "0.95rem";

  btn.onclick = async () => {
    if (btn.dataset.loading === "1") return;

    const allowed = (await canUseAi(state.user, state.isGuest)) || (await hasAnyOwnOrSharedKey(state.uid, state.user, state.isGuest));
    if (!allowed) {
      toast("🔒 Accès IA restreint — demande à l'admin de t'ajouter à la liste autorisée, ou ajoute ta propre clé API dans 🔑 Mes clés IA.");
      return;
    }

    btn.dataset.loading = "1";
    btn.disabled = true;
    btn.textContent = "⏳ IA en cours...";
    aiAnswer.textContent = "";

    try {
      const explanation = await requestAiWrongAnswerExplanation({
        question: q.q,
        options: q.opts,
        correctIndex: q.ans,
        selectedIndex: selected,
        officialExplanation: q.exp || "",
        language: langSelect.value || "fr",
        uid: state.uid,
        username: state.user
      });
      aiAnswer.innerHTML = renderLatexHtml(`🤖 Coach IA : ${explanation}`, { latexEnabled: isLatexEnabled() });
    } catch (e) {
      aiAnswer.textContent = "";
      toast(`❌ IA: ${e?.message || "erreur"}`);
    } finally {
      btn.dataset.loading = "0";
      btn.disabled = false;
      btn.textContent = "🤖 Demander à l'IA pourquoi";
    }
  };

  row.appendChild(controls);
  row.appendChild(btn);
  row.appendChild(aiAnswer);
  expEl.appendChild(row);
  expEl.classList.add("show");
}

// ── NEXT QUESTION ────────────────────────────────────────────────────────────
export function nextQuestion() {
  const q = questions[currentIndex];
  if (q && !answered && isMultiAnswerQuestion(q)) {
    if (!currentSelection.length) {
      toast("Sélectionne au moins une réponse");
      return;
    }
    revealAnswer([...currentSelection]);
    return;
  }

  currentIndex++;
  if (currentIndex >= questions.length) {
    showResults();
  } else {
    renderQuestion();
  }
}

// ── RESULTS ──────────────────────────────────────────────────────────────────
async function showResults() {
  stopQuiz();

  const total = questions.length;
  const pct   = total > 0 ? Math.round((score / total) * 100) : 0;

  document.getElementById("res-pct").textContent     = pct + "%";
  document.getElementById("res-correct").textContent = score;
  document.getElementById("res-wrong").textContent   = total - score;
  document.getElementById("res-streak").textContent  = maxStreak;

  const levels = [
    [90, "🏆 Excellent !",        "Tu maîtrises ce sujet. Prêt pour l'examen."],
    [70, "👍 Bien joué !",        "Quelques points à revoir et tu seras au top."],
    [50, "📚 Peut mieux faire",   "Revois les thèmes ratés avant l'examen."],
    [0,  "💪 Courage !",          "Recommence, chaque essai compte."],
  ];
  const [, title, msg] = levels.find(([min]) => pct >= min) || levels[levels.length - 1];
  document.getElementById("res-title").textContent = title;
  document.getElementById("res-msg").textContent   = msg;
  renderAnswerRecap();

  // Sauvegarde dans Firebase
  if (state.user && subject) {
    try {
      await saveScore({
        pseudo:      state.user,
        subjectId:   subject.id,
        subjectName: subject.name,
        score:       pct,
        correct:     score,
        total
      });
    } catch (e) {
      console.warn("Impossible de sauvegarder le score Firebase :", e);
    }
  }

  showScreen("result-screen");
}

function renderAnswerRecap() {
  const recapEl = document.getElementById("res-review-list");
  if (!recapEl) return;

  const rows = answerReview
    .filter(Boolean)
    .sort((left, right) => {
      if (left.isCorrect !== right.isCorrect) return left.isCorrect ? 1 : -1;
      return left.questionNumber - right.questionNumber;
    });

  if (!rows.length) {
    recapEl.innerHTML = "<div class='result-review-empty'>// Aucune réponse à afficher</div>";
    return;
  }

  recapEl.innerHTML = rows.map((entry) => {
    const selectedIndices = Array.isArray(entry.selectedIndex)
      ? entry.selectedIndex
      : (entry.selectedIndex === -1 ? [] : [entry.selectedIndex]);
    const correctIndices = Array.isArray(entry.correctIndex)
      ? entry.correctIndex
      : (entry.correctIndex === -1 ? [] : [entry.correctIndex]);

    const selectedText = selectedIndices.length === 0
      ? "⏱ Temps écoulé"
      : selectedIndices.map(index => `${String.fromCharCode(65 + index)}. ${entry.options?.[index] ?? "Option indisponible"}`).join(" · ");
    const correctText = correctIndices.length === 0
      ? "Réponse correcte indisponible"
      : correctIndices.map(index => `${String.fromCharCode(65 + index)}. ${entry.options?.[index] ?? "Option indisponible"}`).join(" · ");

    return `
      <article class="result-review-row ${entry.isCorrect ? "correct" : "wrong"}">
        <div class="result-review-head">
          <span class="result-review-badge">Q${entry.questionNumber}</span>
          <span class="result-review-state">${entry.isCorrect ? "✅ Bonne réponse" : "❌ Mauvaise réponse"}</span>
        </div>
        ${entry.category ? `<div class="result-review-category">${entry.category}</div>` : ""}
        <div class="result-review-question">${renderLatexHtml(entry.question, { latexEnabled: isLatexEnabled() })}</div>
        <div class="result-review-line"><strong>Ta réponse :</strong> ${renderLatexHtml(selectedText, { latexEnabled: isLatexEnabled() })}</div>
        <div class="result-review-line"><strong>Bonne réponse :</strong> ${renderLatexHtml(correctText, { latexEnabled: isLatexEnabled() })}</div>
      </article>
    `;
  }).join("");
}
