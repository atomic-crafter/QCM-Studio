// js/data-access/presence.js
// Gère la présence en ligne des utilisateurs via Firestore.
// Chaque utilisateur connecté écrit un document dans la collection "presence"
// et le met à jour toutes les 20s. Si le document n'est pas mis à jour depuis
// 45s, l'utilisateur est considéré hors ligne.

import {
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  collection,
  serverTimestamp,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getLang } from "../core/i18n.js";

const SORT_LOCALES = { fr: "fr-FR", en: "en-US", zh: "zh-CN" };

let db;
let pseudo;
let heartbeatInterval = null;
let presenceUnsub = null;
let onUsersChange = null; // callback appelé quand la liste change
let currentStatus = "online";

const HEARTBEAT_INTERVAL = 20000; // 20s
const OFFLINE_THRESHOLD  = 45000; // 45s

function normalizeStatus(status) {
  return status === "playing" ? "playing" : "online";
}

async function writePresence() {
  if (!db || !pseudo) return;
  await setDoc(doc(db, "presence", pseudo), {
    pseudo,
    lastSeen: serverTimestamp(),
    status: currentStatus
  });
}

export function initPresence(firestoreDb, userPseudo, onChange) {
  db           = firestoreDb;
  pseudo       = userPseudo;
  onUsersChange = onChange;
  currentStatus = "online";
}

// ── CONNEXION ────────────────────────────────────────────────────────────────
export async function goOnline(status = "online") {
  if (!db || !pseudo) return;
  currentStatus = normalizeStatus(status);

  try {
    await writePresence();
  } catch (e) {
    console.warn("goOnline setDoc failed:", e?.code);
    // Si le réseau est bloqué (ex: bloqueur de pub), on continue quand même
  }

  // Heartbeat toutes les 20s
  heartbeatInterval = setInterval(async () => {
    try {
      await writePresence();
    } catch (e) {
      console.warn("Heartbeat failed:", e);
    }
  }, HEARTBEAT_INTERVAL);

  // Écoute la liste des utilisateurs en ligne
  presenceUnsub = onSnapshot(collection(db, "presence"), (snapshot) => {
    const now   = Date.now();
    const users = [];
    snapshot.forEach(d => {
      const data = d.data();
      // Filtre les utilisateurs actifs (lastSeen < 45s)
      const lastSeen = data.lastSeen?.toMillis?.() || 0;
      if (data.pseudo !== pseudo && (now - lastSeen) < OFFLINE_THRESHOLD) {
        users.push({
          pseudo: data.pseudo,
          status: normalizeStatus(data.status)
        });
      }
    });
    users.sort((left, right) => {
      if (left.status !== right.status) return left.status === "playing" ? -1 : 1;
      return String(left.pseudo || "").localeCompare(String(right.pseudo || ""), SORT_LOCALES[getLang()] || "fr-FR");
    });
    if (onUsersChange) onUsersChange(users);
  }, (err) => {
    console.warn("presence listener error:", err?.code);
    // Erreur réseau (bloqueur de pub) : on désactive silencieusement la présence
    presenceUnsub = null;
  });

  // Nettoyage si la page est fermée
  window.addEventListener("beforeunload", goOffline);
}

// ── DÉCONNEXION ──────────────────────────────────────────────────────────────
export async function goOffline() {
  clearInterval(heartbeatInterval);
  if (presenceUnsub) presenceUnsub();
  window.removeEventListener("beforeunload", goOffline);
  currentStatus = "online";
  try {
    await deleteDoc(doc(db, "presence", pseudo));
  } catch (e) { /* ignore */ }
}

export async function setPresenceStatus(status) {
  const normalized = normalizeStatus(status);
  if (currentStatus === normalized) return;
  currentStatus = normalized;

  try {
    await writePresence();
  } catch (e) {
    console.warn("setPresenceStatus failed:", e?.code || e);
  }
}
