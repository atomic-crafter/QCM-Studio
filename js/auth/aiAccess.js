// js/auth/aiAccess.js
// Contrôle d'accès aux fonctionnalités IA (génération de QCM, PDF → QCM,
// coach IA "pourquoi c'est faux") : seul le compte admin y a accès par défaut ;
// l'admin peut autoriser d'autres comptes via une allowlist stockée dans
// Firestore (config/aiAccess), gérée depuis le panneau admin de l'écran d'accueil.
//
// IMPORTANT — portée de cette protection : ce contrôle est appliqué côté
// client (masque les boutons/actions IA dans l'UI) et les règles Firestore
// empêchent un non-admin de modifier la liste elle-même. Ça arrête l'usage
// normal via l'interface. Ça n'empêche PAS un utilisateur techniquement motivé
// d'appeler directement le Worker Cloudflare avec son propre token — le Worker
// ne vérifie pas encore l'identité de l'appelant contre cette liste.

import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Lu depuis js/config/site.config.js — seule source de vérité côté client
// pour le nom du compte admin. Doit correspondre à l'email admin dans
// firestore.rules et à ADMIN_USERNAME dans le Worker (voir README).
const ADMIN_USERNAME = window.__SITE_CONFIG?.adminUsername || "YourAdminUsername";

let db;

export function initAiAccess(firestoreDb) {
  db = firestoreDb;
}

export function isAiAdmin(username) {
  return username === ADMIN_USERNAME;
}

export async function getAllowedAiUsers() {
  try {
    const snap = await getDoc(doc(db, "config", "aiAccess"));
    const list = snap.exists() ? snap.data()?.allowedUsers : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn("getAllowedAiUsers failed:", e?.code || e?.message);
    return [];
  }
}

// true si l'admin a rendu l'IA intégrée (clé Gemini de l'admin, gérée via le
// Worker) accessible à TOUT LE MONDE, même hors allowlist.
export async function isAiOpenToAll() {
  try {
    const snap = await getDoc(doc(db, "config", "aiAccess"));
    return snap.data()?.openToAll === true;
  } catch (e) {
    return false;
  }
}

export async function setAiOpenToAll(openToAll, adminUsername) {
  await setDoc(doc(db, "config", "aiAccess"), {
    openToAll: !!openToAll,
    updatedBy: adminUsername,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

// Guest ou pas de username => jamais d'accès IA (pas d'identité à vérifier).
export async function canUseAi(username, isGuest = false) {
  if (isGuest || !username) return false;
  if (isAiAdmin(username)) return true;
  if (await isAiOpenToAll()) return true;
  const allowed = await getAllowedAiUsers();
  return allowed.includes(username);
}

export async function setAllowedAiUsers(usernames, adminUsername) {
  const clean = [...new Set(
    (Array.isArray(usernames) ? usernames : [])
      .map(u => String(u || "").trim())
      .filter(Boolean)
  )];

  await setDoc(doc(db, "config", "aiAccess"), {
    allowedUsers: clean,
    updatedBy: adminUsername,
    updatedAt: serverTimestamp()
  }, { merge: true });

  return clean;
}

export const AI_ADMIN_USERNAME = ADMIN_USERNAME;
