import { setPresenceStatus } from "../data-access/presence.js";

let renderHomeHandler = null;
let renderLeaderboardHandler = null;
let toastTimeout;
let nextQuestionHandler = null;

export const state = {
  user: null,
  currentSubject: null,
  isMultiplayer: false,
  isRoomGame: false,
  isGuest: false,
  uid: null
};

export function configureRuntimeHandlers({ renderHome, renderLeaderboard } = {}) {
  renderHomeHandler = renderHome || null;
  renderLeaderboardHandler = renderLeaderboard || null;
}

export function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  // Reflect in presence whether user is currently playing a quiz.
  setPresenceStatus(id === "quiz-screen" ? "playing" : "online");
  if (id === "lb-screen") renderLeaderboardHandler?.();
  if (id === "home-screen") renderHomeHandler?.(state.user, state.isGuest, state.uid);
}

export function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove("show"), 2500);
}

export function setNextQuestionHandler(handler) {
  nextQuestionHandler = typeof handler === "function" ? handler : null;
}

export function invokeNextQuestion() {
  return nextQuestionHandler?.();
}