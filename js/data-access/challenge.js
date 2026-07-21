// js/data-access/challenge.js
// Gère l'envoi et la réception de défis entre joueurs.
// Un défi est un document Firestore dans la collection "challenges".
// Structure : { from, to, subjectId, subjectName, questions, status, createdAt }

import {
  doc,
  setDoc,
  onSnapshot,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  collection,
  query,
  where,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { findSubjectById } from "../core/subjects.js";
import { state }         from "../core/runtime.js";
import { startMultiplayer } from "./multiplayer.js";
import { showScreen, toast } from "../core/runtime.js";

let db;
let challengeUnsub = null;
let currentChallengeId = null;
let activeIncomingChallengeCleanup = null;

export function initChallenge(firestoreDb) {
  db = firestoreDb;
}

// ── ÉCOUTE DES DÉFIS ENTRANTS ────────────────────────────────────────────────
export function listenForChallenges(pseudo) {
  if (challengeUnsub) challengeUnsub();

  challengeUnsub = onSnapshot(
    query(
      collection(db, "challenges"),
      where("to", "==", pseudo),
      where("status", "==", "pending")
    ),
    (snapshot) => {
      snapshot.docChanges().forEach(change => {
        if (change.type === "added") {
          const data = change.doc.data();
          currentChallengeId = change.doc.id;
          showChallengeModal(data, change.doc.id);
        }
      });
    },
    (err) => {
      console.warn("listenForChallenges error:", err?.code);
    }
  );
}

// ── ENVOYER UN DÉFI (interne, commun sujet/QCM perso) ────────────────────────
async function _dispatchChallenge(targetPseudo, { subjectId, subjectName, subjectIcon, subjectLatex, questions, subjectForMultiplayer }) {
  const challengeId = `${state.user}__${targetPseudo}__${Date.now()}`;
  currentChallengeId = challengeId;

  await setDoc(doc(db, "challenges", challengeId), {
    from:        state.user,
    to:          targetPseudo,
    subjectId,
    subjectName,
    subjectIcon,
    subjectLatex: subjectLatex === true,
    questions,
    status:      "pending",
    createdAt:   serverTimestamp()
  });

  toast(`⚔️ Défi envoyé à ${targetPseudo} !`);

  // Écoute la réponse de l'adversaire
  const unsub = onSnapshot(doc(db, "challenges", challengeId), (snap) => {
    if (!snap.exists()) { unsub(); return; }
    const data = snap.data();
    if (data.status === "accepted") {
      unsub();
      toast(`✅ ${targetPseudo} a accepté ! C'est parti !`);
      startMultiplayer(challengeId, data.questions, subjectForMultiplayer, state.user, targetPseudo, true);
      showScreen("quiz-screen");
    } else if (data.status === "declined") {
      unsub();
      toast(`❌ ${targetPseudo} a refusé le défi.`);
      deleteDoc(doc(db, "challenges", challengeId));
    }
  }, (err) => {
    console.warn("sendChallenge listener error:", err?.code);
    unsub();
  });

  // Auto-annulation après 60s sans réponse
  setTimeout(async () => {
    unsub();
    try {
      const snap = await getDocs(query(
        collection(db, "challenges"),
        where("status", "==", "pending")
      ));
      snap.forEach(d => { if (d.id === challengeId) deleteDoc(d.ref); });
    } catch(e) {}
  }, 60000);
}

export async function sendChallenge(targetPseudo, subjectId, questionCount, filter = null, timed = false) {
  const subject = findSubjectById(subjectId);
  if (!subject) return;

  let pool = filter
    ? subject.questions.filter(q => q.cat === filter)
    : [...subject.questions];

  const effectiveCount = (timed && !filter)
    ? pool.length
    : Math.min(questionCount, pool.length);

  const questions = shuffle(pool).slice(0, effectiveCount).map(q => ({
    cat: q.cat, q: q.q, opts: q.opts, ans: q.ans, exp: q.exp
  }));

  await _dispatchChallenge(targetPseudo, {
    subjectId,
    subjectName: subject.name,
    subjectIcon: subject.icon,
    subjectLatex: subject.latex === true,
    questions,
    subjectForMultiplayer: subject
  });
}

// ── ENVOYER UN DÉFI SUR UN QCM PERSO/COMMUNAUTÉ ──────────────────────────────
export async function sendCustomChallenge(targetPseudo, customQcm) {
  const pool = [...(customQcm.questions || [])];
  if (!pool.length) return;

  const questions = shuffle(pool).map(q => ({
    cat: q.cat, q: q.q, opts: q.opts, ans: q.ans, exp: q.exp
  }));

  const subjectId = `custom_${customQcm.id}`;

  await _dispatchChallenge(targetPseudo, {
    subjectId,
    subjectName: customQcm.title,
    subjectIcon: '✨',
    subjectLatex: customQcm.latex === true,
    questions,
    subjectForMultiplayer: { id: subjectId, name: customQcm.title, icon: '✨', latex: customQcm.latex === true }
  });
}

// ── MODAL DÉFI REÇU ──────────────────────────────────────────────────────────
function showChallengeModal(data, challengeId) {
  activeIncomingChallengeCleanup?.();
  document.getElementById("challenge-notification")?.remove();

  const from = data?.from || "Un joueur";
  const subjectName = data?.subjectName || "Quiz";
  const subjectIcon = data?.subjectIcon || "⚔️";
  const questions = Array.isArray(data?.questions) ? data.questions : [];
  const questionCount = questions.length;

  const notification = document.createElement("div");
  notification.id = "challenge-notification";
  notification.className = "challenge-notification";

  try {
    notification.innerHTML = `
      <div class="challenge-notification-icon">⚔️</div>
      <div class="challenge-notification-content">
        <div class="challenge-notification-title">Défi reçu</div>
        <div class="challenge-notification-text"><strong>${from}</strong> te défie sur <strong>${subjectIcon} ${subjectName}</strong> (${questionCount} questions)</div>
      </div>
      <div class="challenge-notification-actions">
        <button class="challenge-response-btn accept" data-action="accept" title="Accepter">✅</button>
        <button class="challenge-response-btn reject" data-action="decline" title="Refuser">❌</button>
      </div>
    `;
    document.body.appendChild(notification);
  } catch (e) {
    console.warn("challenge notification render failed:", e?.message || e);
    toast(`⚔️ Défi reçu de ${from}`);
    return;
  }

  const cleanup = () => {
    notification.remove();
  };

  const acceptBtn = notification.querySelector('[data-action="accept"]');
  const declineBtn = notification.querySelector('[data-action="decline"]');

  if (!acceptBtn || !declineBtn) {
    cleanup();
    toast(`⚔️ Défi reçu de ${from}`);
    return;
  }

  acceptBtn.onclick = async () => {
    cleanup();
    try {
      await updateDoc(doc(db, "challenges", challengeId), { status: "accepted" });
      const subject = findSubjectById(data.subjectId);
      startMultiplayer(challengeId, questions, subject || { id: data.subjectId, name: subjectName, icon: subjectIcon, latex: data.subjectLatex === true }, data.to, from, false);
      showScreen("quiz-screen");
    } catch (e) {
      console.warn("accept challenge failed:", e?.code || e?.message || e);
      toast("❌ Impossible d'accepter le défi");
    }
  };

  declineBtn.onclick = async () => {
    cleanup();
    try {
      await updateDoc(doc(db, "challenges", challengeId), { status: "declined" });
    } catch (e) {
      console.warn("decline challenge failed:", e?.code || e?.message || e);
      toast("❌ Impossible de refuser le défi");
    }
  };

  const challengeRef = doc(db, "challenges", challengeId);
  const unsub = onSnapshot(challengeRef, (snap) => {
    if (!snap.exists() || snap.data().status !== "pending") {
      cleanup();
    }
  }, (err) => {
    console.warn("challenge modal listener error:", err?.code);
    cleanup();
  });

  activeIncomingChallengeCleanup = () => {
    unsub();
    cleanup();
    activeIncomingChallengeCleanup = null;
  };
}

// ── UTILS ────────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function stopListeningChallenges() {
  if (challengeUnsub) challengeUnsub();
  activeIncomingChallengeCleanup?.();
}
