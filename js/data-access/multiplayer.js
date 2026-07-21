// js/data-access/multiplayer.js
import {
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  deleteDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { state, toast, showScreen, setNextQuestionHandler } from "../core/runtime.js";
import { saveScore }                from "./firebase.js";
import { openLiveChat, closeLiveChat, postAiCoachMessage } from "./liveChat.js";
import { DEFAULT_SCORING, toMillis, computeStreakBonus, computeSpeedBonus } from "../core/scoring.js";
import { requestAiWrongAnswerExplanation } from "../ai/aiCoach.js";
import { canUseAi } from "../auth/aiAccess.js";
import { hasAnyOwnOrSharedKey } from "../ai/aiKeyOrchestrator.js";
import { renderLatexHtml } from "../core/latex.js";

let db;
let challengeId;
let questions;
let subject;
let myPseudo;
let opponentPseudo;
let isHost;

let currentIndex     = 0;
let myAnswers        = [];
let opponentAnswers  = [];
let myReady          = [];  // true quand j'ai cliqué Suivant sur cette question
let opponentReady    = [];  // true quand l'adversaire a cliqué Suivant
let myAnswerAtByQ    = {};
let opponentAnswerAtByQ = {};
let answered         = false;
let opponentUnsub    = null;
let timerInterval    = null;
let timeLeft         = 0;
let optionOrderByQuestion = new Map();

let myScore          = 0;
let myStreak         = 0;
let myMaxStreak      = 0;

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

export function initMultiplayer(firestoreDb) {
  db = firestoreDb;
}

// ── START ─────────────────────────────────────────────────────────────────────
export function startMultiplayer(cId, qs, subj, me, opponent, host) {
  state.isMultiplayer = true;
  challengeId         = cId;
  questions           = qs;
  subject             = subj;
  myPseudo            = me;
  opponentPseudo      = opponent;
  isHost              = host;
  currentIndex        = 0;
  myAnswers           = new Array(qs.length).fill(null);
  opponentAnswers     = new Array(qs.length).fill(null);
  myReady             = new Array(qs.length).fill(false);
  opponentReady       = new Array(qs.length).fill(false);
  myAnswerAtByQ       = {};
  opponentAnswerAtByQ = {};
  myScore             = 0;
  myStreak            = 0;
  myMaxStreak         = 0;
  answered            = false;
  optionOrderByQuestion = new Map();
  setNextQuestionHandler(nextMultiQuestion);

  openLiveChat({
    mode: "duel",
    id: challengeId,
    pseudo: myPseudo,
    label: `${myPseudo} vs ${opponentPseudo}`
  });

  // Initialise mon document
  setDoc(doc(db, "challenges", challengeId, "answers", myPseudo), {
    answers:   myAnswers,
    ready:     myReady,
    answerAtByQ: {},
    updatedAt: serverTimestamp()
  });

  // Écoute l'adversaire
  opponentUnsub = onSnapshot(
    doc(db, "challenges", challengeId, "answers", opponentPseudo),
    (snap) => {
      if (!snap.exists()) return;
      const data       = snap.data();
      opponentAnswers  = data.answers || [];
      opponentReady    = data.ready   || [];
      opponentAnswerAtByQ = data.answerAtByQ || {};
      onOpponentUpdate();
    },
    (err) => {
      console.warn("opponent listener error:", err?.code);
    }
  );

  renderMultiQuestion();
}

export function stopMultiplayer() {
  clearInterval(timerInterval);
  if (opponentUnsub) opponentUnsub();
  closeLiveChat();
  state.isMultiplayer = false;
  setNextQuestionHandler(null);
}

// ── RENDER QUESTION ───────────────────────────────────────────────────────────
function renderMultiQuestion() {
  clearInterval(timerInterval);
  answered = false;

  const q = questions[currentIndex];

  document.getElementById("quiz-subject-label").textContent = `⚔️ vs ${opponentPseudo}`;
  document.getElementById("q-num").textContent              = currentIndex + 1;
  document.getElementById("q-total").textContent            = questions.length;
  document.getElementById("q-category").textContent         = q.cat || "";
  document.getElementById("q-text").innerHTML               = renderLatexHtml(q.q, { latexEnabled: isLatexEnabled() });
  document.getElementById("explanation").classList.remove("show");
  document.getElementById("explanation").innerHTML           = "";
  const nextBtn = document.getElementById("btn-next");
  nextBtn.classList.remove("show");
  nextBtn.disabled = false;
  nextBtn.dataset.pending = "0";
  nextBtn.textContent = "Suivant →";
  document.getElementById("streak-badge").textContent       = myStreak >= 3 ? `🔥 ${myStreak}` : "";

  const pct = (currentIndex / questions.length) * 100;
  document.getElementById("progress-bar").style.width = pct + "%";

  const optsEl  = document.getElementById("options");
  optsEl.innerHTML = "";

  document.getElementById("duel-live-scoreboard")?.remove();
  const scoreboard = document.createElement("div");
  scoreboard.className = "duel-live-scoreboard";
  scoreboard.id = "duel-live-scoreboard";
  scoreboard.innerHTML = `
    <div class="duel-live-row me">
      <span class="duel-live-name">${myPseudo} (toi)</span>
      <span class="duel-live-stats" id="duel-live-me">0 pts · 0/${questions.length}</span>
    </div>
    <div class="duel-live-row">
      <span class="duel-live-name">${opponentPseudo}</span>
      <span class="duel-live-stats" id="duel-live-opp">0 pts · 0/${questions.length}</span>
    </div>
  `;

  document.getElementById("opponent-status")?.remove();
  const opponentStatus = document.createElement("div");
  opponentStatus.className = "opponent-status";
  opponentStatus.id = "opponent-status";
  opponentStatus.innerHTML = `
    <span class="opp-avatar">${opponentPseudo[0].toUpperCase()}</span>
    <span id="opp-status-text">${opponentPseudo} réfléchit...</span>
  `;

  optsEl.before(scoreboard);
  scoreboard.after(opponentStatus);

  const optionOrder = getOptionOrder(currentIndex, q.opts.length);
  optionOrder.forEach((answerIndex, displayIndex) => {
    const opt = q.opts[answerIndex];
    const div = document.createElement("div");
    div.className    = "option";
    div.dataset.answerIndex = String(answerIndex);
    div.innerHTML    = `<div class="option-letter">${String.fromCharCode(65 + displayIndex)}</div><span class="option-text">${renderLatexHtml(opt, { latexEnabled: isLatexEnabled() })}</span>`;
    div.onclick      = () => selectAnswer(answerIndex, div);
    optsEl.appendChild(div);
  });

  updateDuelLiveScoreboard();

  // Timer 60s
  timeLeft = 60;
  updateTimer();
  timerInterval = setInterval(() => {
    timeLeft--;
    updateTimer();
    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      revealAnswer(-1);
    }
  }, 1000);
}

// ── QUAND L'ADVERSAIRE MET À JOUR ─────────────────────────────────────────────
function onOpponentUpdate() {
  const oppAnswer = opponentAnswers[currentIndex];
  const oppRdy    = opponentReady[currentIndex];
  const statusEl  = document.getElementById("opp-status-text");

  // Affiche la réponse adversaire seulement si MOI j'ai déjà répondu
  if (answered && oppAnswer !== null && oppAnswer !== undefined) {
    const q       = questions[currentIndex];
    const correct = oppAnswer === q.ans;
    statusEl.textContent = `${opponentPseudo} a répondu ${correct ? "✅" : "❌"}`;
    statusEl.style.color = correct ? "var(--success)" : "var(--danger)";
    markOpponentAnswer(oppAnswer);
  } else if (!answered) {
    // L'adversaire a répondu mais pas moi encore
    if (oppAnswer !== null && oppAnswer !== undefined) {
      statusEl.textContent = `${opponentPseudo} a répondu ⏳`;
      statusEl.style.color = "var(--accent3)";
    }
  }

  // Les deux ont répondu → affiche le bouton Suivant
  if (answered && oppAnswer !== null && oppAnswer !== undefined) {
    const nextBtn = document.getElementById("btn-next");
    nextBtn.classList.add("show");
    nextBtn.disabled = false;
    nextBtn.dataset.pending = "0";
    nextBtn.textContent =
      currentIndex < questions.length - 1 ? "Suivant →" : "Voir les résultats →";
  }

  // Les deux ont cliqué Suivant → passe à la question suivante
  if (myReady[currentIndex] && oppRdy) {
    goToNext();
  }

  updateDuelLiveScoreboard();
}

function markOpponentAnswer(oppIndex) {
  document.querySelectorAll(".option").forEach((o) => {
    const answerIndex = Number.parseInt(o.dataset.answerIndex || "-1", 10);
    if (answerIndex === oppIndex && !o.classList.contains("correct") && !o.classList.contains("wrong")) {
      o.classList.add("opponent-answer");
    }
  });
}

// ── RÉPONDRE ──────────────────────────────────────────────────────────────────
function selectAnswer(index, el) {
  if (answered) return;
  document.querySelectorAll(".option").forEach(o => o.classList.remove("selected"));
  el.classList.add("selected");
  revealAnswer(index);
}

async function revealAnswer(selected) {
  clearInterval(timerInterval);
  answered = true;

  const q = questions[currentIndex];

  // Sauvegarde ma réponse (mais pas encore ready)
  myAnswers[currentIndex] = selected;
  myAnswerAtByQ[currentIndex] = Date.now();
  await setDoc(doc(db, "challenges", challengeId, "answers", myPseudo), {
    answers:   myAnswers,
    ready:     myReady,
    answerAtByQ: {
      [currentIndex]: serverTimestamp()
    },
    updatedAt: serverTimestamp()
  }, { merge: true });

  // Affiche le résultat local
  document.querySelectorAll(".option").forEach((o) => {
    const answerIndex = Number.parseInt(o.dataset.answerIndex || "-1", 10);
    if (answerIndex === q.ans) o.classList.add("correct");
    else if (answerIndex === selected && selected !== q.ans) o.classList.add("wrong");
  });

  if (q.exp) {
    const expEl = document.getElementById("explanation");
    expEl.innerHTML = `<strong>💡 Explication :</strong> ${renderLatexHtml(q.exp, { latexEnabled: isLatexEnabled() })}`;
    expEl.classList.add("show");
  }

  // Scoring
  if (selected === q.ans) {
    myStreak++;
    myMaxStreak = Math.max(myMaxStreak, myStreak);
    myScore += DEFAULT_SCORING.baseCorrectPoints + computeStreakBonus(myStreak);
    if (myStreak >= 3) toast(`🔥 Série de ${myStreak} !`);
  } else {
    myStreak = 0;
    if (selected === -1) toast("⏱ Temps écoulé !");
    renderAskAiInChatAction(q, selected);
  }

  document.getElementById("streak-badge").textContent = myStreak >= 3 ? `🔥 ${myStreak}` : "";
  updateDuelLiveScoreboard();

  // Maintenant que j'ai répondu, affiche la réponse adversaire si elle est déjà là
  const oppAnswer = opponentAnswers[currentIndex];
  if (oppAnswer !== null && oppAnswer !== undefined) {
    const correct = oppAnswer === q.ans;
    const statusEl = document.getElementById("opp-status-text");
    if (statusEl) {
      statusEl.textContent = `${opponentPseudo} a répondu ${correct ? "✅" : "❌"}`;
      statusEl.style.color = correct ? "var(--success)" : "var(--danger)";
    }
    markOpponentAnswer(oppAnswer);
    // Les deux ont répondu → bouton Suivant
    const nextBtn = document.getElementById("btn-next");
    nextBtn.classList.add("show");
    nextBtn.disabled = false;
    nextBtn.dataset.pending = "0";
    nextBtn.textContent =
      currentIndex < questions.length - 1 ? "Suivant →" : "Voir les résultats →";
  } else {
    // J'attends l'adversaire
    const statusEl = document.getElementById("opp-status-text");
    if (statusEl) {
      statusEl.textContent = `En attente de ${opponentPseudo}...`;
      statusEl.style.color = "var(--text-dim)";
    }
  }
}

function computeDuelLiveScores() {
  let mePoints = 0;
  let oppPoints = 0;
  let meCorrect = 0;
  let oppCorrect = 0;
  let meStreakRun = 0;
  let oppStreakRun = 0;

  for (let i = 0; i <= currentIndex && i < questions.length; i++) {
    const goodAnswer = questions[i]?.ans;
    if (goodAnswer === undefined) continue;

    const meAnswer = myAnswers?.[i];
    const oppAnswer = opponentAnswers?.[i];

    const meAnswered = meAnswer !== null && meAnswer !== undefined;
    const oppAnswered = oppAnswer !== null && oppAnswer !== undefined;

    const meIsCorrect = meAnswered && meAnswer === goodAnswer;
    const oppIsCorrect = oppAnswered && oppAnswer === goodAnswer;

    let firstCorrectAt = null;
    if (meIsCorrect) {
      const t = toMillis(myAnswerAtByQ?.[i]);
      if (t !== null) firstCorrectAt = t;
    }
    if (oppIsCorrect) {
      const t = toMillis(opponentAnswerAtByQ?.[i]);
      if (t !== null && (firstCorrectAt === null || t < firstCorrectAt)) {
        firstCorrectAt = t;
      }
    }

    if (meAnswered) {
      if (meIsCorrect) {
        meCorrect++;
        meStreakRun++;
        const answeredAt = toMillis(myAnswerAtByQ?.[i]);
        const speedBonus = (firstCorrectAt === null || answeredAt === null)
          ? 0
          : computeSpeedBonus(answeredAt - firstCorrectAt);
        mePoints += DEFAULT_SCORING.baseCorrectPoints + computeStreakBonus(meStreakRun) + speedBonus;
      } else {
        meStreakRun = 0;
      }
    }

    if (oppAnswered) {
      if (oppIsCorrect) {
        oppCorrect++;
        oppStreakRun++;
        const answeredAt = toMillis(opponentAnswerAtByQ?.[i]);
        const speedBonus = (firstCorrectAt === null || answeredAt === null)
          ? 0
          : computeSpeedBonus(answeredAt - firstCorrectAt);
        oppPoints += DEFAULT_SCORING.baseCorrectPoints + computeStreakBonus(oppStreakRun) + speedBonus;
      } else {
        oppStreakRun = 0;
      }
    }
  }

  return { mePoints, oppPoints, meCorrect, oppCorrect };
}

function updateDuelLiveScoreboard() {
  const meEl = document.getElementById("duel-live-me");
  const oppEl = document.getElementById("duel-live-opp");
  if (!meEl || !oppEl) return;

  const { mePoints, oppPoints, meCorrect, oppCorrect } = computeDuelLiveScores();
  meEl.textContent = `${mePoints} pts · ${meCorrect}/${questions.length}`;
  oppEl.textContent = `${oppPoints} pts · ${oppCorrect}/${questions.length}`;
}

function renderAskAiInChatAction(q, selected) {
  const expEl = document.getElementById("explanation");
  if (!expEl) return;

  if (!q.exp) {
    expEl.innerHTML = "";
    expEl.classList.add("show");
  }

  const row = document.createElement("div");
  row.style.marginTop = "0.8rem";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn secondary";
  btn.textContent = "🤖 Demander à l'IA (chat)";

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

    try {
      const explanation = await requestAiWrongAnswerExplanation({
        question: q.q,
        options: q.opts,
        correctIndex: q.ans,
        selectedIndex: selected,
        officialExplanation: q.exp || "",
        language: "fr",
        uid: state.uid,
        username: state.user
      });

      await postAiCoachMessage(`Q${currentIndex + 1} — ${explanation}`, { latexEnabled: isLatexEnabled() });
      toast("🤖 Explication envoyée dans le chat");
    } catch (e) {
      toast(`❌ IA: ${e?.message || "erreur"}`);
    } finally {
      btn.dataset.loading = "0";
      btn.disabled = false;
      btn.textContent = "🤖 Demander à l'IA (chat)";
    }
  };

  row.appendChild(btn);
  expEl.appendChild(row);
}

// ── BOUTON SUIVANT ────────────────────────────────────────────────────────────
export async function nextMultiQuestion() {
  const nextBtn = document.getElementById("btn-next");
  if (!nextBtn || !challengeId || !myPseudo) {
    toast("❌ Duel invalide, retourne au menu puis relance un défi");
    return;
  }

  if (nextBtn.dataset.pending === "1") return;

  nextBtn.dataset.pending = "1";
  nextBtn.disabled = true;
  nextBtn.textContent = `En attente de ${opponentPseudo}...`;

  try {
    // Marque que je suis prêt pour la prochaine question
    myReady[currentIndex] = true;
    await setDoc(doc(db, "challenges", challengeId, "answers", myPseudo), {
      answers:   myAnswers,
      ready:     myReady,
      answerAtByQ: myAnswerAtByQ,
      updatedAt: serverTimestamp()
    }, { merge: true });

    // Cache le bouton et affiche l'attente
    nextBtn.classList.remove("show");
    const statusEl = document.getElementById("opp-status-text");
    if (statusEl) {
      statusEl.textContent = `En attente de ${opponentPseudo}...`;
      statusEl.style.color = "var(--text-dim)";
    }

    // Si l'adversaire est déjà prêt, on passe directement
    if (opponentReady[currentIndex]) {
      goToNext();
    }
  } catch (e) {
    console.error("nextMultiQuestion failed:", e);
    toast(`❌ Impossible de valider cette manche (${e?.code || e?.message || 'erreur'})`);
    nextBtn.dataset.pending = "0";
    nextBtn.disabled = false;
    nextBtn.textContent = currentIndex < questions.length - 1 ? "Suivant →" : "Voir les résultats →";
  }
}

function goToNext() {
  currentIndex++;
  if (currentIndex >= questions.length) {
    showMultiResults();
  } else {
    renderMultiQuestion();
  }
}

// ── RÉSULTATS ─────────────────────────────────────────────────────────────────
async function showMultiResults() {
  stopMultiplayer();
  state.isMultiplayer = false;

  const total = questions.length;

  const myDocData = {
    answers: myAnswers,
    answerAtByQ: {}
  };

  const oppDocData = {
    answers: opponentAnswers,
    answerAtByQ: {}
  };

  try {
    const mySnap = await getDoc(doc(db, "challenges", challengeId, "answers", myPseudo));
    if (mySnap.exists()) {
      const d = mySnap.data() || {};
      myDocData.answers = d.answers || myDocData.answers;
      myDocData.answerAtByQ = d.answerAtByQ || {};
    }

    const oppSnap = await getDoc(doc(db, "challenges", challengeId, "answers", opponentPseudo));
    if (oppSnap.exists()) {
      const d = oppSnap.data() || {};
      oppDocData.answers = d.answers || oppDocData.answers;
      oppDocData.answerAtByQ = d.answerAtByQ || {};
    }
  } catch (e) {
    // fallback to in-memory values when reads fail
  }

  let myPoints = 0;
  let oppPoints = 0;
  let myCorrect = 0;
  let oppCorrect = 0;
  let myStreakRun = 0;
  let oppStreakRun = 0;
  let myBestStreak = 0;
  let oppBestStreak = 0;

  for (let i = 0; i < total; i++) {
    const q = questions[i];

    const myIsCorrect = areAnswersEqual(q, myDocData.answers?.[i]);
    const oppIsCorrect = areAnswersEqual(q, oppDocData.answers?.[i]);

    let firstCorrectAt = null;
    if (myIsCorrect) {
      const t = toMillis(myDocData.answerAtByQ?.[i]);
      if (t !== null) firstCorrectAt = t;
    }
    if (oppIsCorrect) {
      const t = toMillis(oppDocData.answerAtByQ?.[i]);
      if (t !== null) {
        if (firstCorrectAt === null || t < firstCorrectAt) firstCorrectAt = t;
      }
    }

    if (myIsCorrect) {
      myCorrect++;
      myStreakRun++;
      myBestStreak = Math.max(myBestStreak, myStreakRun);
      const myAnsweredAt = toMillis(myDocData.answerAtByQ?.[i]);
      const speedBonus = (firstCorrectAt === null || myAnsweredAt === null)
        ? 0
        : computeSpeedBonus(myAnsweredAt - firstCorrectAt);
      myPoints += DEFAULT_SCORING.baseCorrectPoints + computeStreakBonus(myStreakRun) + speedBonus;
    } else {
      myStreakRun = 0;
    }

    if (oppIsCorrect) {
      oppCorrect++;
      oppStreakRun++;
      oppBestStreak = Math.max(oppBestStreak, oppStreakRun);
      const oppAnsweredAt = toMillis(oppDocData.answerAtByQ?.[i]);
      const speedBonus = (firstCorrectAt === null || oppAnsweredAt === null)
        ? 0
        : computeSpeedBonus(oppAnsweredAt - firstCorrectAt);
      oppPoints += DEFAULT_SCORING.baseCorrectPoints + computeStreakBonus(oppStreakRun) + speedBonus;
    } else {
      oppStreakRun = 0;
    }
  }

  const myPct = Math.round((myCorrect / total) * 100);

  const won = myPoints > oppPoints || (myPoints === oppPoints && myCorrect > oppCorrect);
  const tie = myPoints === oppPoints && myCorrect === oppCorrect;

  document.getElementById("res-pct").textContent     = myPct + "%";
  document.getElementById("res-correct").textContent = myCorrect;
  document.getElementById("res-wrong").textContent   = total - myCorrect;
  document.getElementById("res-streak").textContent  = myBestStreak;
  document.getElementById("res-title").textContent   = won ? "🏆 Victoire !" : tie ? "🤝 Égalité !" : "😤 Défaite !";
  document.getElementById("res-msg").textContent     =
    `${myPseudo} ${myPoints} pts (${myCorrect}/${total}) · ${opponentPseudo} ${oppPoints} pts (${oppCorrect}/${total})`;

  myScore = myPoints;
  myMaxStreak = myBestStreak;

  if (subject) {
    try {
      await saveScore({
        pseudo: myPseudo, subjectId: subject.id, subjectName: subject.name,
        score: myPct, correct: myCorrect, total
      });
    } catch(e) {}
  }

  if (isHost) {
    try { await deleteDoc(doc(db, "challenges", challengeId)); } catch(e) {}
  }

  showScreen("result-screen");
}

// ── TIMER ─────────────────────────────────────────────────────────────────────
function updateTimer() {
  const el = document.getElementById("timer");
  el.textContent = `⏱ ${timeLeft}s`;
  el.className   = "timer";
  if (timeLeft <= 10) el.classList.add("warn");
  if (timeLeft <= 5)  el.classList.add("danger");
}