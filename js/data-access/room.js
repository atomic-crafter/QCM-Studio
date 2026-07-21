// js/data-access/room.js
// Gère les salles de jeu multijoueur (N joueurs, sync complète).
// Structure Firestore :
//   rooms/{roomId}  → doc principal (liste joueurs, statut, question courante)
//   rooms/{roomId}/answers/{pseudo} → réponses de chaque joueur (pour scoring)

import {
  doc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  deleteField,
  onSnapshot,
  collection,
  query,
  where,
  arrayUnion,
  arrayRemove,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { getActiveSubjects, getArchivedSubjects, findSubjectById } from "../core/subjects.js";
import { state, toast, showScreen, setNextQuestionHandler } from "../core/runtime.js";
import { saveScore }      from "./firebase.js";
import { openLiveChat, closeLiveChat, postAiCoachMessage } from "./liveChat.js";
import { getCurrentSessionUser } from "../auth/auth.js";
import { DEFAULT_SCORING, toMillis, computeStreakBonus, computeSpeedBonus } from "../core/scoring.js";
import { requestAiWrongAnswerExplanation } from "../ai/aiCoach.js";
import { canUseAi } from "../auth/aiAccess.js";
import { hasAnyOwnOrSharedKey } from "../ai/aiKeyOrchestrator.js";
import { renderLatexHtml } from "../core/latex.js";
import { loadCustomQcmPickerInto } from "../ui/customQcmPicker.js";

// ── MODULE STATE ──────────────────────────────────────────────────────────────
let db;
let myPseudo;
let roomId;
let isHost       = false;
let roomData     = null;   // last room doc snapshot
let roomUnsub    = null;
let roomAnswersUnsub = null;
let publicUnsub  = null;
let roomHeartbeatInterval = null;

const ROOM_HEARTBEAT_INTERVAL = 8000;
const ROOM_OFFLINE_THRESHOLD  = 30000;

// Quiz state
let questions    = [];
let myAnswers    = [];
let answered     = false;
let currentIndex = 0;
let timerInterval = null;
let timeLeft      = 0;
let questionTimeSec = 60;
let myScore       = 0;
let myStreak      = 0;
let myMaxStreak   = 0;
let advancingQ    = false;  // évite la double-avance côté host
let roomAnswersByPseudo = new Map();
let optionOrderByQuestion = new Map();

// ── INIT ──────────────────────────────────────────────────────────────────────
export function initRoom(firestoreDb) {
  db = firestoreDb;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

// Les pseudos invités sont générés au hasard (voir app.js), donc deux invités
// peuvent en théorie tomber sur le même nom. Ça ne casse rien tant qu'ils ne
// rejoignent pas la MÊME salle (players/answers/heartbeat sont keyés par pseudo,
// donc une vraie collision dans une salle ferait fusionner deux joueurs en un
// seul slot). On ne re-tire un nom que pour les invités, jamais pour un compte
// (un pseudo de compte déjà présent = c'est bien la même personne qui reconnecte).
function _disambiguateGuestPseudo(pseudo, existingPlayers) {
  if (!state.isGuest) return pseudo;
  if (!existingPlayers.includes(pseudo)) return pseudo;

  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let candidate = pseudo;
  let attempts = 0;
  while (existingPlayers.includes(candidate) && attempts < 20) {
    let suffix = '';
    for (let i = 0; i < 4; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
    candidate = `Invité-${suffix}`;
    attempts++;
  }
  return candidate;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isLatexEnabled() {
  if (roomData && typeof roomData.subjectLatex === "boolean") return roomData.subjectLatex;
  return findSubjectById(roomData?.subjectId)?.latex === true;
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

async function _pingRoom() {
  if (!db || !roomId || !myPseudo) return;
  try {
    await updateDoc(doc(db, 'rooms', roomId), {
      [`playerHeartbeat.${myPseudo}`]: serverTimestamp()
    });
  } catch (e) {
    // room deleted / disconnected
  }
}

function _startRoomHeartbeat() {
  clearInterval(roomHeartbeatInterval);
  _pingRoom();
  roomHeartbeatInterval = setInterval(_pingRoom, ROOM_HEARTBEAT_INTERVAL);
}

function _stopRoomHeartbeat() {
  clearInterval(roomHeartbeatInterval);
  roomHeartbeatInterval = null;
}

function _isPlayerConnected(pseudo) {
  return _isPlayerConnectedInData(roomData, pseudo);
}

function _isPlayerConnectedInData(data, pseudo) {
  const ts = data?.playerHeartbeat?.[pseudo];
  if (!ts?.toMillis) return true;
  return (Date.now() - ts.toMillis()) < ROOM_OFFLINE_THRESHOLD;
}

function _getConnectedPlayersInData(data) {
  if (!data?.players?.length) return [];
  return data.players.filter(p => _isPlayerConnectedInData(data, p));
}

function _isRoomOrphaned(data) {
  if (!data?.players?.length) return true;
  return _getConnectedPlayersInData(data).length === 0;
}

async function _pruneOfflinePlayers(roomRef, data) {
  if (!roomRef || !data?.players?.length) return;

  const offline = data.players.filter(p => !_isPlayerConnectedInData(data, p));
  if (!offline.length) return;

  const patch = {
    players: arrayRemove(...offline)
  };

  offline.forEach(p => {
    patch[`playerReady.${p}`] = deleteField();
    patch[`playerHeartbeat.${p}`] = deleteField();
  });

  try {
    await updateDoc(roomRef, patch);
  } catch (e) {
    // Best-effort cleanup only
  }
}

function _getConnectedPlayers() {
  if (!roomData?.players?.length) return [];
  const connected = roomData.players.filter(p => _isPlayerConnected(p));
  if (myPseudo && roomData.players.includes(myPseudo) && !connected.includes(myPseudo)) {
    connected.push(myPseudo);
  }
  return connected;
}

async function _resolveLoggedPseudo() {
  if (state.user) return state.user;

  const sessionUser = await getCurrentSessionUser?.();
  if (sessionUser?.username && sessionUser?.uid) {
    state.user = sessionUser.username;
    state.uid = sessionUser.uid;
    state.isGuest = false;
    return sessionUser.username;
  }

  throw new Error('User not logged in');
}

// ── CREATE ROOM ───────────────────────────────────────────────────────────────
export async function createRoom(name, isPublic, password, questionTime = 60) {
  if (!db) throw new Error('Firestore not initialized');
  myPseudo = await _resolveLoggedPseudo();
  isHost   = true;
  roomId   = genCode();
  const safeQuestionTimeSec = Math.max(10, Math.min(120, Number.parseInt(questionTime, 10) || 60));

  await setDoc(doc(db, 'rooms', roomId), {
    name:        name || `Salle de ${myPseudo}`,
    host:        myPseudo,
    password:    isPublic ? null : (password || null),
    isPublic,
    subjectId:   null,
    subjectName: null,
    subjectIcon: null,
    subjectLatex: false,
    questions:   [],
    players:     [myPseudo],
    status:      'waiting',
    questionTimeSec: safeQuestionTimeSec,
    currentQuestion: 0,
    playerReady: { [myPseudo]: -1 },
    playerHeartbeat: { [myPseudo]: serverTimestamp() },
    createdAt:   serverTimestamp()
  });

  _startRoomHeartbeat();
  _startLobbyListener();
  showScreen('room-lobby-screen');
}

// ── JOIN ROOM ─────────────────────────────────────────────────────────────────
export async function joinRoom(code, passwordAttempt) {
  if (!db) throw new Error('Firestore not initialized');
  myPseudo = await _resolveLoggedPseudo();
  isHost   = false;
  roomId   = (code || '').toUpperCase().trim();

  const snap = await getDoc(doc(db, 'rooms', roomId));
  if (!snap.exists())                           { toast('❌ Salle introuvable');             return false; }
  const roomRef = doc(db, 'rooms', roomId);
  const data = snap.data();

  await _pruneOfflinePlayers(roomRef, data);

  const freshSnap = await getDoc(roomRef);
  if (!freshSnap.exists())                      { toast('❌ Salle introuvable');             return false; }
  const freshData = freshSnap.data();

  if (_isRoomOrphaned(freshData)) {
    try { await deleteDoc(roomRef); } catch (e) {}
    toast('⚠️ Salle expirée (plus aucun joueur connecté)');
    return false;
  }

  if (freshData.status === 'finished')               { toast('⚠️ Partie terminée');               return false; }
  if (!freshData.isPublic && freshData.password !== passwordAttempt) { toast('❌ Mot de passe incorrect'); return false; }

  if (!freshData.players.includes(myPseudo)) {
    const disambiguated = _disambiguateGuestPseudo(myPseudo, freshData.players);
    if (disambiguated !== myPseudo) {
      myPseudo = disambiguated;
      state.user = disambiguated;
      try { sessionStorage.setItem('qcm_guest_pseudo', disambiguated); } catch (e) {}
      const pseudoEl = document.getElementById('home-pseudo');
      if (pseudoEl) pseudoEl.textContent = disambiguated;
      toast(`ℹ️ Pseudo déjà pris dans cette salle, tu es "${disambiguated}"`);
    }

    const readyValue = freshData.status === 'playing'
      ? Math.max(-1, (freshData.currentQuestion ?? 0) - 1)
      : -1;

    await updateDoc(roomRef, {
      players: arrayUnion(myPseudo),
      [`playerReady.${myPseudo}`]: readyValue,
      [`playerHeartbeat.${myPseudo}`]: serverTimestamp()
    });
  } else {
    await updateDoc(roomRef, {
      [`playerHeartbeat.${myPseudo}`]: serverTimestamp()
    });
  }

  _startRoomHeartbeat();
  _startLobbyListener();
  showScreen('room-lobby-screen');
  return true;
}

// ── LEAVE ROOM ────────────────────────────────────────────────────────────────
export async function leaveRoom(updateFirestore = true) {
  const leavingRoomId = roomId;
  const leavingPseudo = myPseudo;
  const wasHost = isHost;

  _stopRoomHeartbeat();
  clearInterval(timerInterval);
  closeLiveChat();
  if (roomUnsub) { roomUnsub(); roomUnsub = null; }
  if (roomAnswersUnsub) { roomAnswersUnsub(); roomAnswersUnsub = null; }
  document.getElementById('room-host-skip-btn')?.remove();
  document.getElementById('room-players-panel')?.remove();
  document.getElementById('room-live-scoreboard')?.remove();

  roomId    = null;
  roomData  = null;
  roomAnswersByPseudo = new Map();
  questions = [];
  myAnswers = [];
  currentIndex = 0;
  myScore = 0; myStreak = 0; myMaxStreak = 0;
  optionOrderByQuestion = new Map();
  isHost = false;
  myPseudo = null;
  state.isRoomGame = false;
  setNextQuestionHandler(null);

  if (updateFirestore && db && leavingRoomId) {
    try {
      if (wasHost) {
        await deleteDoc(doc(db, 'rooms', leavingRoomId));
      } else {
        await updateDoc(doc(db, 'rooms', leavingRoomId), {
          players: arrayRemove(leavingPseudo)
        });
      }
    } catch (e) { /* room may already be gone */ }
  }
}

// ── LISTEN PUBLIC ROOMS ───────────────────────────────────────────────────────
export function listenPublicRooms(callback) {
  if (publicUnsub) publicUnsub();
  publicUnsub = onSnapshot(
    query(
      collection(db, 'rooms'),
      where('isPublic', '==', true)
    ),
    snap => {
      // Un snapshot "from cache" (reconnexion, veille, reprise d'onglet...) peut
      // contenir des heartbeats obsolètes qui semblent périmés alors que tout le
      // monde est en fait bien connecté côté serveur. On ne prune/supprime
      // jamais sur la base d'un snapshot local — seulement une fois confirmé
      // par le serveur — pour éviter de fermer une salle active par erreur.
      const isFresh = !snap.metadata.fromCache;

      const rooms = [];
      snap.forEach(d => {
        const data = d.data();

        if (isFresh) {
          _pruneOfflinePlayers(d.ref, data);

          if (_isRoomOrphaned(data)) {
            // Nettoyage opportuniste: si tout le monde est offline, on supprime la salle.
            deleteDoc(d.ref).catch(() => {});
            return;
          }
        }

        rooms.push({ id: d.id, ...data });
      });
      callback(rooms);
    },
    err => {
      console.error('listenPublicRooms error:', err);
      toast('❌ Rooms Firestore bloqué (règles)');
      callback([]);
    }
  );
}

export function stopListeningPublicRooms() {
  if (publicUnsub) { publicUnsub(); publicUnsub = null; }
}

// ── LOBBY LISTENER ────────────────────────────────────────────────────────────
function _startLobbyListener() {
  if (roomUnsub) roomUnsub();

  roomUnsub = onSnapshot(
    doc(db, 'rooms', roomId),
    snap => {
      if (!snap.exists()) {
        toast('⚠️ La salle a été fermée par l\'hôte');
        leaveRoom(false);
        showScreen('home-screen');
        return;
      }

      roomData = snap.data();

      // Un snapshot "from cache" (reconnexion réseau, veille, onglet remis au
      // premier plan...) peut contenir des heartbeats obsolètes qui font croire
      // que plus personne n'est connecté, alors que la salle est bien active
      // côté serveur. On ne prune/ferme la salle que sur un snapshot confirmé
      // par le serveur, jamais sur un simple cache local.
      if (!snap.metadata.fromCache) {
        _pruneOfflinePlayers(doc(db, 'rooms', roomId), roomData);

        if (_isRoomOrphaned(roomData)) {
          if (roomId) {
            deleteDoc(doc(db, 'rooms', roomId)).catch(() => {});
          }
          toast('⚠️ Salle fermée (plus aucun joueur connecté)');
          leaveRoom(false);
          showScreen('home-screen');
          return;
        }
      }

      if (roomData.status === 'waiting') {
        _renderLobby();
        return;
      }

      if (roomData.status === 'playing') {
        const lobbyEl = document.getElementById('room-lobby-screen');
        if (lobbyEl?.classList.contains('active')) {
          // First entry into game from lobby
          _initLocalGame();
        } else {
          // Already in quiz: check for question advance or panel update
          _onRoomDocUpdate();
        }
        return;
      }

      if (roomData.status === 'finished') {
        _showRoomResults();
      }
    },
    err => {
      console.error('room listener error:', err);
      toast('❌ Accès salle refusé (règles Firestore)');
      leaveRoom(false);
      showScreen('home-screen');
    }
  );
}

// ── LOBBY RENDER ──────────────────────────────────────────────────────────────
function _renderLobby() {
  if (!roomData) return;
  const { name, host, players, isPublic, subjectId, subjectName, subjectIcon, questionTimeSec: roomQuestionTimeSec } = roomData;

  document.getElementById('lobby-title').textContent = name;
  document.getElementById('lobby-code').textContent  = roomId;
  document.getElementById('lobby-type').textContent  = isPublic ? '🌐 Publique' : '🔒 Privée';

  document.getElementById('lobby-players-list').innerHTML = players.map(p => `
    <div class="lobby-player-chip">
      <div class="lobby-player-avatar">${p[0].toUpperCase()}</div>
      <span class="lobby-player-name">${p}${_isPlayerConnected(p) ? '' : ' (hors ligne)'}</span>
      ${p === host ? '<span class="lobby-host-badge">👑</span>' : ''}
    </div>
  `).join('');

  const subjectDisplay = document.getElementById('lobby-subject-display');
  subjectDisplay.textContent = subjectId
    ? `${subjectIcon} ${subjectName} · ⏱ ${roomQuestionTimeSec || 60}s / question`
    : `// Aucun thème sélectionné · ⏱ ${roomQuestionTimeSec || 60}s / question`;

  const isMe = (myPseudo === host);
  document.getElementById('lobby-host-controls').style.display = isMe ? 'flex' : 'none';
  document.getElementById('lobby-guest-waiting').style.display = isMe ? 'none' : 'flex';

  const startBtn = document.getElementById('lobby-start-btn');
  startBtn.disabled = !subjectId;
  startBtn.style.opacity = subjectId ? '1' : '.5';
}

// ── HOST: PICK SUBJECT ────────────────────────────────────────────────────────
function _renderRoomSubjectBlock(s) {
  return `
    <div class="picker-subject-block">
      <div class="picker-subject-title">${s.icon} ${s.name}</div>
      <div class="picker-modes">
        ${s.modes.map(m => `
          <button class="picker-mode-btn ${m.timed ? 'timed' : ''}"
            onclick="window.__roomPickMode('${s.id}','${s.name}','${s.icon}',${m.count},${m.timed||false},${m.filter ? `'${m.filter}'` : null})">
            ${m.timed ? '⏱ ' : ''}${m.label}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

export function openRoomSubjectPicker() {
  document.getElementById('room-subject-picker')?.remove();
  const wrap = document.createElement('div');
  wrap.id        = 'room-subject-picker';
  wrap.className = 'picker-overlay';

  const subjects = getActiveSubjects().map(_renderRoomSubjectBlock).join('');
  const archivedSubjects = getArchivedSubjects();
  const archivedHtml = archivedSubjects.length ? `
    <details class="picker-archived-details">
      <summary>🗂️ Archivés (${archivedSubjects.length})</summary>
      <div class="picker-archived-list">${archivedSubjects.map(_renderRoomSubjectBlock).join('')}</div>
    </details>
  ` : '';

  wrap.innerHTML = `
    <div class="picker-modal">
      <div class="picker-modal-header">
        <h3>🎮 Choisir le thème</h3>
        <button class="picker-close" onclick="document.getElementById('room-subject-picker').remove()">✕</button>
      </div>
      <div class="picker-subjects">${subjects}</div>
      ${archivedHtml}
      <div class="picker-custom-section">
        <details open>
          <summary>✨ Mes QCM & communauté</summary>
          <div class="picker-custom-loading" id="room-picker-custom-list">// Chargement...</div>
        </details>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  wrap.scrollTop = 0;
  const pickerModal = wrap.querySelector('.picker-modal');
  if (pickerModal) pickerModal.scrollTop = 0;

  window.__roomPickMode = async (subjectId, subjectName, subjectIcon, count, timed, filter) => {
    document.getElementById('room-subject-picker')?.remove();
    const subject = findSubjectById(subjectId);
    if (!subject) return;
    const pool = filter ? subject.questions.filter(q => q.cat === filter) : [...subject.questions];
    const effectiveCount = (timed && !filter)
      ? pool.length
      : Math.min(count, pool.length);
    const qs   = shuffle(pool).slice(0, effectiveCount).map(q => ({
      cat: q.cat, q: q.q, opts: q.opts, ans: q.ans, exp: q.exp
    }));
    await updateDoc(doc(db, 'rooms', roomId), {
      subjectId, subjectName, subjectIcon, subjectLatex: subject.latex === true, questions: qs
    });
    toast(`✅ Thème : ${subjectName}`);
  };

  loadCustomQcmPickerInto(
    wrap.querySelector('#room-picker-custom-list'),
    state.user,
    state.uid,
    async (qcm) => {
      document.getElementById('room-subject-picker')?.remove();
      const qs = shuffle(qcm.questions).map(q => ({
        cat: q.cat, q: q.q, opts: q.opts, ans: q.ans, exp: q.exp
      }));
      await updateDoc(doc(db, 'rooms', roomId), {
        subjectId:   `custom_${qcm.id}`,
        subjectName: qcm.title,
        subjectIcon: '✨',
        subjectLatex: qcm.latex === true,
        questions:   qs
      });
      toast(`✅ Thème : ${qcm.title}`);
    }
  );
}

// ── HOST: START GAME ──────────────────────────────────────────────────────────
export async function startRoomGame() {
  if (!isHost || !roomData?.subjectId) return;
  const playerReady = Object.fromEntries(roomData.players.map(p => [p, -1]));
  await updateDoc(doc(db, 'rooms', roomId), {
    status:          'playing',
    currentQuestion: 0,
    playerReady
  });
}

// ── INIT LOCAL GAME (all players, called once) ────────────────────────────────
function _initLocalGame() {
  questions    = roomData.questions;
  currentIndex = roomData.currentQuestion;
  questionTimeSec = Math.max(10, Math.min(120, Number.parseInt(roomData?.questionTimeSec, 10) || 60));
  myAnswers    = new Array(questions.length).fill(null);
  myScore      = 0; myStreak = 0; myMaxStreak = 0;
  answered     = false;
  advancingQ   = false;
  optionOrderByQuestion = new Map();
  state.isRoomGame = true;
  setNextQuestionHandler(nextRoomQuestion);

  setDoc(doc(db, 'rooms', roomId, 'answers', myPseudo), {
    pseudo: myPseudo, answers: myAnswers, score: 0, updatedAt: serverTimestamp()
  });

  _startRoomAnswersListener();

  openLiveChat({
    mode: "room",
    id: roomId,
    pseudo: myPseudo,
    label: `Salle ${roomId}`
  });

  showScreen('quiz-screen');
  _renderRoomQuestion();
}

// ── ROOM DOC UPDATE (while in quiz) ───────────────────────────────────────────
function _onRoomDocUpdate() {
  const newIdx = roomData.currentQuestion;
  if (newIdx > currentIndex) {
    currentIndex = newIdx;
    advancingQ   = false;
    answered     = false;
    _renderRoomQuestion();
    return;
  }
  // Same question — refresh player panel + host checks advance
  _updatePlayersPanel();
  _renderRoomLiveScoreboard();
  if (isHost) _checkAndAdvance();
}

function _startRoomAnswersListener() {
  if (roomAnswersUnsub) {
    roomAnswersUnsub();
    roomAnswersUnsub = null;
  }

  roomAnswersUnsub = onSnapshot(
    collection(db, 'rooms', roomId, 'answers'),
    snap => {
      const next = new Map();
      snap.forEach(d => {
        next.set(d.id, d.data() || {});
      });
      roomAnswersByPseudo = next;
      _renderRoomLiveScoreboard();
    },
    err => {
      console.warn('room answers listener error:', err?.code || err?.message || err);
    }
  );
}

function _computeRoomLiveScores() {
  if (!roomData) return [];

  const players = [...(roomData.players || [])];
  const pointsByPlayer = new Map(players.map(p => [p, 0]));
  const correctByPlayer = new Map(players.map(p => [p, 0]));
  const streakByPlayer = new Map(players.map(p => [p, 0]));

  for (let i = 0; i <= currentIndex && i < questions.length; i++) {
    const goodAnswer = questions[i]?.ans;
    if (goodAnswer === undefined) continue;

    let firstCorrectAt = null;

    players.forEach(pseudo => {
      const data = roomAnswersByPseudo.get(pseudo);
      const ans = data?.answers?.[i];
      if (ans !== goodAnswer) return;
      const answeredAt = toMillis(data?.answerAtByQ?.[i]);
      if (answeredAt === null) return;
      if (firstCorrectAt === null || answeredAt < firstCorrectAt) {
        firstCorrectAt = answeredAt;
      }
    });

    players.forEach(pseudo => {
      const data = roomAnswersByPseudo.get(pseudo);
      const ans = data?.answers?.[i];
      const hasAnswered = ans !== null && ans !== undefined;
      if (!hasAnswered) return;

      if (ans !== goodAnswer) {
        streakByPlayer.set(pseudo, 0);
        return;
      }

      const newStreak = (streakByPlayer.get(pseudo) || 0) + 1;
      streakByPlayer.set(pseudo, newStreak);
      correctByPlayer.set(pseudo, (correctByPlayer.get(pseudo) || 0) + 1);

      const answeredAt = toMillis(data?.answerAtByQ?.[i]);
      const speedBonus = (firstCorrectAt === null || answeredAt === null)
        ? 0
        : computeSpeedBonus(answeredAt - firstCorrectAt);

      const points =
        DEFAULT_SCORING.baseCorrectPoints +
        computeStreakBonus(newStreak) +
        speedBonus;

      pointsByPlayer.set(pseudo, (pointsByPlayer.get(pseudo) || 0) + points);
    });
  }

  return players
    .map(pseudo => ({
      pseudo,
      points: pointsByPlayer.get(pseudo) || 0,
      correct: correctByPlayer.get(pseudo) || 0
    }))
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return b.correct - a.correct;
    });
}

function _renderRoomLiveScoreboard() {
  const board = document.getElementById('room-live-scoreboard');
  if (!board || !roomData) return;

  const rows = _computeRoomLiveScores();
  if (!rows.length) {
    board.innerHTML = '';
    return;
  }

  board.innerHTML = rows.map((row, idx) => `
    <div class="room-live-row ${row.pseudo === myPseudo ? 'me' : ''}">
      <span class="room-live-rank">#${idx + 1}</span>
      <span class="room-live-name">${row.pseudo === myPseudo ? `${row.pseudo} (moi)` : row.pseudo}</span>
      <span class="room-live-stats">${row.points} pts · ${row.correct}/${questions.length}</span>
    </div>
  `).join('');
}

// ── RENDER QUESTION ───────────────────────────────────────────────────────────
function _renderRoomQuestion() {
  clearInterval(timerInterval);
  answered   = false;
  advancingQ = false;

  const q = questions[currentIndex];
  const { players, subjectIcon } = roomData;

  document.getElementById('quiz-subject-label').textContent = `🎮 Salle ${roomId}`;
  document.getElementById('q-num').textContent   = currentIndex + 1;
  document.getElementById('q-total').textContent = questions.length;
  document.getElementById('q-category').textContent = q.cat || '';
  document.getElementById('q-text').innerHTML       = renderLatexHtml(q.q, { latexEnabled: isLatexEnabled() });
  document.getElementById('explanation').classList.remove('show');
  document.getElementById('explanation').innerHTML  = '';
  const nextBtn = document.getElementById('btn-next');
  nextBtn.classList.remove('show');
  nextBtn.disabled = false;
  nextBtn.dataset.pending = '0';
  nextBtn.textContent = 'Suivant →';
  document.getElementById('streak-badge').textContent = myStreak >= 3 ? `🔥 ${myStreak}` : '';

  document.getElementById('progress-bar').style.width = (currentIndex / questions.length * 100) + '%';

  const optsEl = document.getElementById('options');
  optsEl.innerHTML = '';

  // Players status panel
  document.getElementById('room-players-panel')?.remove();
  const panel = document.createElement('div');
  panel.id        = 'room-players-panel';
  panel.className = 'room-players-panel';
  panel.innerHTML = players.map(p => `
    <div class="room-player-status" id="rps-${CSS.escape(p)}">
      <span class="rps-avatar">${p[0].toUpperCase()}</span>
      <span class="rps-name">${p === myPseudo ? `${p} (moi)` : p}</span>
      <span class="rps-icon" id="rps-icon-${CSS.escape(p)}">⏳</span>
    </div>
  `).join('');
  optsEl.before(panel);

  document.getElementById('room-live-scoreboard')?.remove();
  const board = document.createElement('div');
  board.id = 'room-live-scoreboard';
  board.className = 'room-live-scoreboard';
  panel.after(board);

  const optionOrder = getOptionOrder(currentIndex, q.opts.length);
  optionOrder.forEach((answerIndex, displayIndex) => {
    const opt = q.opts[answerIndex];
    const div  = document.createElement('div');
    div.className    = 'option';
    div.dataset.answerIndex = String(answerIndex);
    div.innerHTML    = `<div class="option-letter">${String.fromCharCode(65 + displayIndex)}</div><span class="option-text">${renderLatexHtml(opt, { latexEnabled: isLatexEnabled() })}</span>`;
    div.onclick      = () => _roomSelectAnswer(answerIndex, div);
    optsEl.appendChild(div);
  });

  // Bouton hôte : forcer le passage sans attendre tout le monde (ceux qui n'ont
  // pas encore répondu se retrouvent avec 0 point pour cette question, comme un
  // timeout normal — voir _computeRoomLiveScores/_showRoomResults).
  document.getElementById('room-host-skip-btn')?.remove();
  if (isHost) {
    const skipBtn = document.createElement('button');
    skipBtn.id        = 'room-host-skip-btn';
    skipBtn.type      = 'button';
    skipBtn.className = 'btn secondary sm';
    skipBtn.title     = "Passer à la question suivante sans attendre les autres joueurs. Ceux qui n'ont pas encore répondu auront 0 point pour cette question.";
    skipBtn.textContent = '⏭️ Forcer le passage';
    skipBtn.onclick   = () => forceAdvanceRoomQuestion();
    nextBtn.after(skipBtn);
  }

  // 60s timer
  timeLeft = questionTimeSec;
  _updateRoomTimer();
  timerInterval = setInterval(() => {
    timeLeft--;
    _updateRoomTimer();
    if (timeLeft <= 0) { clearInterval(timerInterval); _roomRevealAnswer(-1); }
  }, 1000);

  _updatePlayersPanel();
  _renderRoomLiveScoreboard();
}

function _updateRoomTimer() {
  const el = document.getElementById('timer');
  if (!el) return;
  const warnThreshold = Math.max(5, Math.floor(questionTimeSec * 0.25));
  const dangerThreshold = Math.max(3, Math.floor(questionTimeSec * 0.1));
  el.textContent = `⏱ ${timeLeft}s`;
  el.className   = 'timer' + (timeLeft <= dangerThreshold ? ' danger' : timeLeft <= warnThreshold ? ' warn' : '');
}

// ── PLAYERS PANEL ─────────────────────────────────────────────────────────────
function _updatePlayersPanel() {
  if (!roomData) return;
  const { players, playerReady, currentQuestion } = roomData;
  players.forEach(p => {
    const el = document.getElementById(`rps-icon-${CSS.escape(p)}`);
    if (!el) return;
    const connected = _isPlayerConnected(p);
    const ready = (playerReady?.[p] ?? -1) >= currentQuestion;
    if (!connected) {
      el.textContent = '📴';
    } else if (ready) {
      el.textContent = '✅';
    } else if (p === myPseudo && !answered) {
      el.textContent = '✏️';
    } else {
      el.textContent = '⏳';
    }
  });
}

// ── SELECT ANSWER ─────────────────────────────────────────────────────────────
function _roomSelectAnswer(index, el) {
  if (answered) return;
  document.querySelectorAll('.option').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  _roomRevealAnswer(index);
}

async function _roomRevealAnswer(selected) {
  clearInterval(timerInterval);
  answered = true;
  const q  = questions[currentIndex];
  myAnswers[currentIndex] = selected;

  document.querySelectorAll('.option').forEach((o) => {
    const answerIndex = Number.parseInt(o.dataset.answerIndex || '-1', 10);
    if (answerIndex === q.ans) o.classList.add('correct');
    else if (answerIndex === selected && selected !== q.ans) o.classList.add('wrong');
  });

  if (q.exp) {
    const el = document.getElementById('explanation');
    el.innerHTML = `<strong>💡 Explication :</strong> ${renderLatexHtml(q.exp, { latexEnabled: isLatexEnabled() })}`;
    el.classList.add('show');
  }

  if (selected === q.ans) {
    myStreak++;
    myMaxStreak = Math.max(myMaxStreak, myStreak);
    myScore += DEFAULT_SCORING.baseCorrectPoints + computeStreakBonus(myStreak);
    if (myStreak >= 3) toast(`🔥 Série de ${myStreak} !`);
  } else {
    myStreak = 0;
    if (selected === -1) toast('⏱ Temps écoulé !');
    renderAskAiInRoomChatAction(q, selected);
  }
  document.getElementById('streak-badge').textContent = myStreak >= 3 ? `🔥 ${myStreak}` : '';

  const localMine = roomAnswersByPseudo.get(myPseudo) || { pseudo: myPseudo, answers: [], answerAtByQ: {} };
  const localAnswers = Array.isArray(localMine.answers) ? [...localMine.answers] : [];
  localAnswers[currentIndex] = selected;
  roomAnswersByPseudo.set(myPseudo, {
    ...localMine,
    pseudo: myPseudo,
    answers: localAnswers,
    answerAtByQ: {
      ...(localMine.answerAtByQ || {}),
      [currentIndex]: Date.now()
    }
  });
  _renderRoomLiveScoreboard();

  // Persist answer
  await setDoc(doc(db, 'rooms', roomId, 'answers', myPseudo), {
    pseudo: myPseudo,
    answers: myAnswers,
    score: myScore,
    answerAtByQ: {
      [currentIndex]: serverTimestamp()
    },
    updatedAt: serverTimestamp()
  }, { merge: true });

  // Show Next button
  const nextBtn = document.getElementById('btn-next');
  nextBtn.classList.add('show');
  nextBtn.disabled = false;
  nextBtn.dataset.pending = '0';
  nextBtn.textContent =
    currentIndex < questions.length - 1 ? 'Suivant →' : 'Voir les résultats →';

  _updatePlayersPanel();
}

function renderAskAiInRoomChatAction(q, selected) {
  const expEl = document.getElementById('explanation');
  if (!expEl) return;

  if (!q.exp) {
    expEl.innerHTML = '';
  } else {
    expEl.innerHTML = `<strong>💡 Explication :</strong> ${renderLatexHtml(q.exp, { latexEnabled: isLatexEnabled() })}`;
  }

  const row = document.createElement('div');
  row.style.marginTop = '0.8rem';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn secondary';
  btn.textContent = "🤖 Demander à l'IA (chat)";

  btn.onclick = async () => {
    if (btn.dataset.loading === '1') return;

    const allowed = (await canUseAi(state.user, state.isGuest)) || (await hasAnyOwnOrSharedKey(state.uid, state.user, state.isGuest));
    if (!allowed) {
      toast('🔒 Accès IA restreint — demande à l\'admin de t\'ajouter à la liste autorisée, ou ajoute ta propre clé API dans 🔑 Mes clés IA.');
      return;
    }

    btn.dataset.loading = '1';
    btn.disabled = true;
    btn.textContent = '⏳ IA en cours...';

    try {
      const explanation = await requestAiWrongAnswerExplanation({
        question: q.q,
        options: q.opts,
        correctIndex: q.ans,
        selectedIndex: selected,
        officialExplanation: q.exp || '',
        language: 'fr',
        uid: state.uid,
        username: state.user
      });

      await postAiCoachMessage(`Q${currentIndex + 1} — ${explanation}`, { latexEnabled: isLatexEnabled() });
      toast('🤖 Explication envoyée dans le chat');
    } catch (e) {
      toast(`❌ IA: ${e?.message || 'erreur'}`);
    } finally {
      btn.dataset.loading = '0';
      btn.disabled = false;
      btn.textContent = "🤖 Demander à l'IA (chat)";
    }
  };

  row.appendChild(btn);
  expEl.appendChild(row);
}

// ── NEXT QUESTION (exported, called from app.js) ──────────────────────────────
export async function nextRoomQuestion() {
  const nextBtn = document.getElementById('btn-next');
  if (!roomId || !myPseudo || !nextBtn) {
    toast('❌ Salle invalide, retourne au menu puis rejoins la salle');
    return;
  }

  if (nextBtn.dataset.pending === '1') return;

  nextBtn.dataset.pending = '1';
  nextBtn.disabled = true;
  nextBtn.textContent = 'En attente des joueurs...';

  try {
    await updateDoc(doc(db, 'rooms', roomId), {
      [`playerReady.${myPseudo}`]: currentIndex
    });

    if (roomData) {
      roomData.playerReady = {
        ...(roomData.playerReady || {}),
        [myPseudo]: currentIndex
      };
    }

    // Update own icon immediately
    const el = document.getElementById(`rps-icon-${CSS.escape(myPseudo)}`);
    if (el) el.textContent = '✅';

    // Host: immediately attempt to advance from local state
    if (isHost) {
      _checkAndAdvance();
    }
  } catch (e) {
    console.error('nextRoomQuestion failed:', e);
    toast(`❌ Impossible de valider cette manche (${e?.code || e?.message || 'erreur'})`);
    nextBtn.dataset.pending = '0';
    nextBtn.disabled = false;
    nextBtn.textContent = currentIndex < questions.length - 1 ? 'Suivant →' : 'Voir les résultats →';
  }
}

// ── HOST: CHECK & ADVANCE ─────────────────────────────────────────────────────
function _advanceToNextQuestion() {
  advancingQ = true;
  const next = roomData.currentQuestion + 1;
  if (next >= roomData.questions.length) {
    updateDoc(doc(db, 'rooms', roomId), { status: 'finished' });
  } else {
    updateDoc(doc(db, 'rooms', roomId), { currentQuestion: next });
  }
}

function _checkAndAdvance() {
  if (!roomData || advancingQ) return;
  const { playerReady, currentQuestion } = roomData;
  const connectedPlayers = _getConnectedPlayers();
  if (!connectedPlayers.length) return;

  const allReady = connectedPlayers.every(p => (playerReady?.[p] ?? -1) >= currentQuestion);
  if (!allReady) return;

  _advanceToNextQuestion();
}

// ── HOST: FORCER LE PASSAGE (ne pas attendre les joueurs pas encore prêts) ───
// Les joueurs qui n'ont pas répondu n'ont simplement aucune entrée dans
// answers[currentIndex] pour cette question : _computeRoomLiveScores /
// _showRoomResults les traitent déjà comme "pas de bonne réponse" → 0 point,
// exactement comme un timeout normal. Rien à écrire de spécial pour eux.
export function forceAdvanceRoomQuestion() {
  if (!isHost || !roomData || advancingQ) return;
  const confirmed = confirm(
    "Forcer le passage à la question suivante ? Les joueurs qui n'ont pas encore répondu auront 0 point pour cette question."
  );
  if (!confirmed) return;
  _advanceToNextQuestion();
}

// ── ROOM RESULTS ─────────────────────────────────────────────────────────────
async function _showRoomResults() {
  _stopRoomHeartbeat();
  clearInterval(timerInterval);
  closeLiveChat();
  if (roomUnsub) { roomUnsub(); roomUnsub = null; }
  if (roomAnswersUnsub) { roomAnswersUnsub(); roomAnswersUnsub = null; }

  // Fetch all answers
  const answersSnap = await getDocs(collection(db, 'rooms', roomId, 'answers'));
  const participants = new Set(roomData?.players || []);
  const answersByPseudo = new Map();

  answersSnap.forEach(d => {
    const data = d.data() || {};
    const pseudo = data.pseudo || d.id;
    participants.add(pseudo);
    answersByPseudo.set(pseudo, data);
  });

  const playerList = [...participants];
  const pointsByPlayer = new Map(playerList.map(p => [p, 0]));
  const correctByPlayer = new Map(playerList.map(p => [p, 0]));
  const streakByPlayer = new Map(playerList.map(p => [p, 0]));
  const maxStreakByPlayer = new Map(playerList.map(p => [p, 0]));

  for (let i = 0; i < questions.length; i++) {
    let firstCorrectAt = null;

    playerList.forEach(pseudo => {
      const data = answersByPseudo.get(pseudo);
      const ans = data?.answers?.[i];
      if (ans !== questions[i]?.ans) return;
      const answeredAt = toMillis(data?.answerAtByQ?.[i]);
      if (answeredAt === null) return;
      if (firstCorrectAt === null || answeredAt < firstCorrectAt) {
        firstCorrectAt = answeredAt;
      }
    });

    playerList.forEach(pseudo => {
      const data = answersByPseudo.get(pseudo);
      const ans = data?.answers?.[i];
      const isCorrect = ans === questions[i]?.ans;

      if (!isCorrect) {
        streakByPlayer.set(pseudo, 0);
        return;
      }

      const newStreak = (streakByPlayer.get(pseudo) || 0) + 1;
      streakByPlayer.set(pseudo, newStreak);
      maxStreakByPlayer.set(pseudo, Math.max(maxStreakByPlayer.get(pseudo) || 0, newStreak));
      correctByPlayer.set(pseudo, (correctByPlayer.get(pseudo) || 0) + 1);

      const streakBonus = computeStreakBonus(newStreak);
      const answeredAt = toMillis(data?.answerAtByQ?.[i]);
      const speedBonus = (firstCorrectAt === null || answeredAt === null)
        ? 0
        : computeSpeedBonus(answeredAt - firstCorrectAt);

      const points =
        DEFAULT_SCORING.baseCorrectPoints +
        streakBonus +
        speedBonus;

      pointsByPlayer.set(pseudo, (pointsByPlayer.get(pseudo) || 0) + points);
    });
  }

  const scores = playerList.map(pseudo => ({
    pseudo,
    points: pointsByPlayer.get(pseudo) || 0,
    correct: correctByPlayer.get(pseudo) || 0,
    total: questions.length,
    maxStreak: maxStreakByPlayer.get(pseudo) || 0
  }));

  scores.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.correct !== a.correct) return b.correct - a.correct;
    return b.maxStreak - a.maxStreak;
  });

  // Save my score to leaderboard
  const myEntry = scores.find(s => s.pseudo === myPseudo);
  if (myEntry && roomData) {
    try {
      await saveScore({
        pseudo: myPseudo, subjectId: roomData.subjectId, subjectName: roomData.subjectName,
        score: Math.round((myEntry.correct / myEntry.total) * 100),
        correct: myEntry.correct, total: myEntry.total
      });
    } catch (e) { /* offline / rule issue */ }
  }

  // Host deletes the room
  if (isHost) {
    try { await deleteDoc(doc(db, 'rooms', roomId)); } catch (e) {}
  }

  const savedRoomData = roomData;
  roomId   = null;
  roomData = null;
  isHost = false;
  state.isRoomGame = false;
  setNextQuestionHandler(null);

  _renderRoomResults(scores, myPseudo, savedRoomData);
  showScreen('room-result-screen');
}

function _renderRoomResults(scores, me, rd) {
  const medals = ['🥇', '🥈', '🥉'];
  const myRank = scores.findIndex(s => s.pseudo === me);

  document.getElementById('room-res-title').textContent =
    myRank === 0 ? '🏆 Victoire !' : myRank === 1 ? '🥈 Podium !' : '🎯 Bien joué !';

  document.getElementById('room-res-subject').textContent =
    rd ? `${rd.subjectIcon || ''} ${rd.subjectName || ''}` : '';

  const list = document.getElementById('room-res-list');
  list.innerHTML = scores.map((s, i) => `
    <div class="room-res-row ${s.pseudo === me ? 'me' : ''}">
      <div class="room-res-rank">${medals[i] || `#${i + 1}`}</div>
      <div class="room-res-avatar">${s.pseudo[0].toUpperCase()}</div>
      <div class="room-res-info">
        <div class="room-res-name">
          ${s.pseudo}${s.pseudo === me ? ' <span class="you-tag">vous</span>' : ''}
        </div>
      </div>
      <div class="room-res-score-block">
        <div class="room-res-score">${s.points} pts</div>
        <div class="room-res-pct">${s.correct}/${s.total} · ${Math.round((s.correct / s.total) * 100)}%</div>
      </div>
    </div>
  `).join('');
}

// ── STOP (called on confirmQuit mid-game) ─────────────────────────────────────
export function stopRoomGame() {
  clearInterval(timerInterval);
  leaveRoom(true);
}
