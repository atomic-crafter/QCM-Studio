// js/core/app.js
import { initFirebase }           from "../data-access/firebase.js";
import { renderHome, renderOnlineUsers, initRoomsPanel, teardownRoomsPanel } from "../ui/home.js";
import { renderLeaderboard }      from "../ui/leaderboard.js";
import { initPresence, goOnline, goOffline } from "../data-access/presence.js";
import { initChallenge, listenForChallenges, stopListeningChallenges } from "../data-access/challenge.js";
import { initMultiplayer, nextMultiQuestion, stopMultiplayer } from "../data-access/multiplayer.js";
import { initRoom, nextRoomQuestion, stopRoomGame } from "../data-access/room.js";
import { initLiveChat, closeLiveChat } from "../data-access/liveChat.js";
import * as authApi from "../auth/auth.js";
import { openQcmCreatorModal, openQcmEditorModal } from "../ai/qcmCreator.js";
import { openPdfQcmModal } from "../ai/qcmFromPdf.js";
import { initAiAccess, canUseAi } from "../auth/aiAccess.js";
import { initApiKeyVault, unlockVault, lockVault } from "../ai/apiKeyVault.js";
import { initSharedKeyVault } from "../ai/sharedKeyVault.js";
import { hasAnyOwnOrSharedKey } from "../ai/aiKeyOrchestrator.js";
import { state, showScreen, toast, configureRuntimeHandlers, setNextQuestionHandler, invokeNextQuestion } from "./runtime.js";
import { t } from "./i18n.js";

const COOKIE_USER = "qcm_auth_user";
const COOKIE_MODE = "qcm_auth_mode";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 jours
const GUEST_PSEUDO_KEY = "qcm_guest_pseudo";
let ignoreSessionRestore = false;

// ── PSEUDO INVITÉ ─────────────────────────────────────────────────────────────
function generateGuestPseudo() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `Invité-${suffix}`;
}

// Garde le même pseudo invité le temps de l'onglet (évite de se dupliquer
// dans une salle si la page est rechargée par erreur).
function getOrCreateGuestPseudo() {
  let pseudo = sessionStorage.getItem(GUEST_PSEUDO_KEY);
  if (!pseudo) {
    pseudo = generateGuestPseudo();
    sessionStorage.setItem(GUEST_PSEUDO_KEY, pseudo);
  }
  return pseudo;
}

configureRuntimeHandlers({ renderHome, renderLeaderboard });

// Prévient (mais ne bloque JAMAIS l'accès à l'interface) quand l'utilisateur
// n'est ni l'admin, ni sur l'allowlist (voir js/aiAccess.js), et n'a configuré
// aucune clé API perso/partagée — ces deux ressources sont les seules qui
// coûtent quelque chose à quelqu'un d'autre (quota admin, clé partagée), donc
// c'est la seule chose qu'on gate. On ne bloque PAS l'ouverture de
// l'interface elle-même : un utilisateur qui préfère ne pas enregistrer de
// clé dans Firebase peut très bien n'utiliser que son Ollama local (aucune
// clé, aucune ressource partagée) — le sélectionner dans le modal fonctionne
// très bien sans passer par cette vérification.
async function guardAiAccess(onAllowed) {
  const allowed = (await canUseAi(state.user, state.isGuest)) || (await hasAnyOwnOrSharedKey(state.uid, state.user, state.isGuest));
  if (!allowed) {
    toast(t("app.aiAccessRestrictedHint"));
  }
  onAllowed();
}

export function bootstrap() {
  window.login        = login;
  window.register     = register;
  window.enterGuestMode = enterGuestMode;
  window.showAuthTab  = showAuthTab;
  window.logout       = logout;
  window.showScreen   = showScreen;
  window.confirmQuit  = confirmQuit;
  setNextQuestionHandler(() => import("../ui/quiz.js").then(m => m.nextQuestion()));
  window.nextQuestion = () => invokeNextQuestion();
  window.toast = toast;

  initFirebase(window.__db);
  authApi.initAuth?.(window.__firebaseApp, window.__db);
  initChallenge(window.__db);
  initMultiplayer(window.__db);
  initPresence(window.__db, null, null);
  initRoom(window.__db);
  initLiveChat(window.__db);
  initAiAccess(window.__db);
  initApiKeyVault(window.__db);
  initSharedKeyVault(window.__db);

  const saved = localStorage.getItem("qcm_user");
  if (saved) document.getElementById("username-input").value = saved;

  const cookieMode = getCookie(COOKIE_MODE);
  ignoreSessionRestore = cookieMode === "guest";

  bindEnterFlow(["username-input", "login-password-input"], login);
  bindEnterFlow(["reg-username-input", "reg-password-input", "reg-confirm-input"], register);

  initCursorGlow();

  authApi.onAuthChange?.((sessionUser) => {
    if (ignoreSessionRestore) return;
    if (!sessionUser) return;
    afterAuth(sessionUser.username, sessionUser.uid);
  });

  if (cookieMode === "guest") {
    enterGuestMode(true);
  }
}

function bindEnterFlow(inputIds, submitAction) {
  const inputs = inputIds
    .map(id => document.getElementById(id))
    .filter(Boolean);

  inputs.forEach((input, index) => {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;

      event.preventDefault();

      const nextInput = inputs[index + 1];
      if (nextInput) {
        nextInput.focus();
        return;
      }

      submitAction();
    });
  });
}

// ── AUTH TABS ─────────────────────────────────────────────────────────────────

export function showAuthTab(tab) {
  const loginPane    = document.getElementById("auth-login-pane");
  const registerPane = document.getElementById("auth-register-pane");
  const tabLogin     = document.getElementById("tab-login");
  const tabRegister  = document.getElementById("tab-register");
  const loginUsernameInput = document.getElementById("username-input");
  const registerUsernameInput = document.getElementById("reg-username-input");

  if (tab === "login") {
    loginPane.style.display    = "block";
    registerPane.style.display = "none";
    tabLogin.classList.add("active");
    tabRegister.classList.remove("active");
    requestAnimationFrame(() => loginUsernameInput?.focus());
  } else {
    loginPane.style.display    = "none";
    registerPane.style.display = "block";
    tabRegister.classList.add("active");
    tabLogin.classList.remove("active");
    requestAnimationFrame(() => registerUsernameInput?.focus());
  }
}

// ── AUTH ─────────────────────────────────────────────────────────────────────

async function login() {
  const username = document.getElementById("username-input").value.trim();
  const password = document.getElementById("login-password-input").value;
  const errEl    = document.getElementById("login-error");
  const btn      = document.getElementById("login-btn");

  errEl.style.display = "none";
  btn.disabled        = true;
  btn.textContent     = t("app.signingIn");

  try {
    ignoreSessionRestore = false;
    if (!authApi.loginUser) throw new Error(t("app.staleAuthModule"));
    await authApi.loginUser(username, password);
    const sessionUser = await authApi.getCurrentSessionUser?.();
    if (sessionUser?.username && sessionUser?.uid) {
      await unlockVault(password, sessionUser.uid);
      afterAuth(sessionUser.username, sessionUser.uid);
    }
  } catch (e) {
    errEl.textContent   = e.message;
    errEl.style.display = "block";
  } finally {
    btn.disabled    = false;
    btn.textContent = t("auth.loginBtn");
  }
}

async function register() {
  const username = document.getElementById("reg-username-input").value.trim();
  const password = document.getElementById("reg-password-input").value;
  const confirm  = document.getElementById("reg-confirm-input").value;
  const errEl    = document.getElementById("register-error");
  const btn      = document.getElementById("register-btn");

  errEl.style.display = "none";

  if (password !== confirm) {
    errEl.textContent   = t("app.passwordMismatch");
    errEl.style.display = "block";
    return;
  }

  btn.disabled    = true;
  btn.textContent = t("app.creatingAccount");

  try {
    ignoreSessionRestore = false;
    if (!authApi.registerUser) throw new Error(t("app.staleAuthModule"));
    await authApi.registerUser(username, password);
    const sessionUser = await authApi.getCurrentSessionUser?.();
    if (sessionUser?.username && sessionUser?.uid) {
      await unlockVault(password, sessionUser.uid);
      afterAuth(sessionUser.username, sessionUser.uid);
    }
  } catch (e) {
    errEl.textContent   = e.message;
    errEl.style.display = "block";
  } finally {
    btn.disabled    = false;
    btn.textContent = t("auth.registerBtn");
  }
}

function afterAuth(displayName, uid) {
  if (!displayName || !uid) return;
  if (!state.isGuest && state.user === displayName && state.uid === uid) return;

  state.user = displayName;
  state.uid = uid;
  state.isGuest = false;
  localStorage.setItem("qcm_user", displayName);
  deleteCookie(COOKIE_MODE);
  deleteCookie(COOKIE_USER);

  document.getElementById("home-pseudo").textContent = displayName;
  document.getElementById("home-avatar").textContent = displayName[0].toUpperCase();

  // Wire up the QCM creator button
  window.__openQcmCreator = () => guardAiAccess(() => openQcmCreatorModal(state.user, state.uid));
  window.__openQcmScratch = () => openQcmEditorModal(state.user, null, state.uid);
  window.__openPdfQcm = () => guardAiAccess(() => openPdfQcmModal(state.user, state.uid));
  window.__openPromptOnlyQcm = () => guardAiAccess(() => openPdfQcmModal(state.user, state.uid, { promptOnly: true }));

  initPresence(window.__db, displayName, renderOnlineUsers);
  goOnline();
  listenForChallenges(displayName);
  initRoomsPanel();
  showScreen("home-screen");
  renderHome(displayName, false, uid);
}

async function enterGuestMode() {
  state.user = getOrCreateGuestPseudo();
  state.uid = null;
  state.isGuest = true;

  setCookie(COOKIE_MODE, "guest", COOKIE_MAX_AGE);

  await authApi.logoutUser?.().catch(() => {});

  goOffline();
  stopListeningChallenges();
  closeLiveChat();

  document.getElementById("home-pseudo").textContent = state.user;
  document.getElementById("home-avatar").textContent = state.user[0].toUpperCase();

  window.__openQcmCreator = () => toast(t("app.guestCannotCreateQcm"));
  window.__openQcmScratch = () => toast(t("app.guestCannotCreateQcm"));

  initRoomsPanel();
  showScreen("home-screen");
  renderHome(null, true);
}

function logout() {
  authApi.logoutUser?.().catch(() => {});
  goOffline();
  stopListeningChallenges();
  closeLiveChat();
  teardownRoomsPanel();
  sessionStorage.removeItem(GUEST_PSEUDO_KEY);
  lockVault();
  state.user = null;
  state.uid = null;
  state.isGuest = false;
  deleteCookie(COOKIE_USER);
  deleteCookie(COOKIE_MODE);
  document.getElementById("username-input").value        = "";
  document.getElementById("login-password-input").value  = "";
  document.getElementById("login-error").style.display   = "none";
  showAuthTab("login");
  showScreen("login-screen");
}

// ── QUIT QUIZ ────────────────────────────────────────────────────────────────
function confirmQuit() {
  if (confirm(t("app.confirmQuitQuiz"))) {
    if (state.isMultiplayer) {
      stopMultiplayer();
      state.isMultiplayer = false;
    } else if (state.isRoomGame) {
      stopRoomGame();
    } else {
      import("../ui/quiz.js").then(m => m.stopQuiz());
    }
    showScreen("home-screen");
  }
}

// ── CURSOR GLOW ─────────────────────────────────────────────────────────────
function initCursorGlow() {
  const glow = document.getElementById('cursor-glow');
  if (!glow) return;

  document.addEventListener('mousemove', e => {
    glow.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;

    document.querySelectorAll('.subject-card,.login-card,.question-card,.result-card,.lobby-card,.room-res-row').forEach(el => {
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        el.style.setProperty('--my', (e.clientY - r.top) + 'px');
      } else {
        el.style.setProperty('--mx', '-9999px');
        el.style.setProperty('--my', '-9999px');
      }
    });
  });

  document.addEventListener('mouseleave', () => { glow.style.opacity = '0'; });
  document.addEventListener('mouseenter', () => { glow.style.opacity = '1'; });
}

function setCookie(name, value, maxAgeSeconds) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; samesite=lax`;
}

function getCookie(name) {
  const prefix = `${name}=`;
  const found = document.cookie
    .split(";")
    .map(v => v.trim())
    .find(v => v.startsWith(prefix));
  if (!found) return "";
  return decodeURIComponent(found.slice(prefix.length));
}

function deleteCookie(name) {
  document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
}
