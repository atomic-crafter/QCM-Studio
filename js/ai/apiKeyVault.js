// js/ai/apiKeyVault.js
// Coffre-fort client-side pour les clés API perso de chaque utilisateur
// (Claude, Gemini, DeepSeek, OpenAI...), stockées CHIFFRÉES dans Firestore
// (userApiKeys/{uid}) — pour que chacun puisse utiliser les fonctionnalités IA
// avec SA PROPRE clé plutôt que de dépendre uniquement de la clé Gemini
// partagée par l'admin (voir js/aiAccess.js).
//
// ── MODÈLE DE SÉCURITÉ ────────────────────────────────────────────────────────
// - Chiffrement AES-256-GCM. La clé de chiffrement est dérivée (PBKDF2-SHA256,
//   150 000 itérations) du MOT DE PASSE de connexion + de l'uid (comme "sel"
//   stable — pas besoin d'être secret, seul le mot de passe l'est).
// - Le mot de passe n'est JAMAIS stocké ni envoyé nulle part. Seule la clé
//   dérivée reste en mémoire, et une copie exportée dans sessionStorage pour
//   survivre à un rechargement de page DANS LE MÊME ONGLET.
// - Firestore ne voit jamais que du ciphertext opaque (iv + ciphertext en hex).
//   Même un accès en lecture à la base (bug de règles, accès admin, dump...)
//   ne permet de déchiffrer rien du tout sans le mot de passe.
// - Contrepartie assumée : si la session Firebase est restaurée automatiquement
//   sans ressaisir le mot de passe (nouvel onglet, navigateur relancé), le
//   coffre est "verrouillé" — l'utilisateur doit resaisir son mot de passe
//   pour déverrouiller ses clés. On ne triche jamais là-dessus en affaiblissant
//   le chiffrement pour éviter ce prompt.

import {
  doc,
  getDoc,
  setDoc,
  deleteField,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const VAULT_SESSION_KEY = "qcm_vault_key_v1";
const PBKDF2_ITERATIONS = 150_000;

export const PROVIDERS = ["claude", "gemini", "deepseek", "openai"];

let db;
let cachedKey = null; // CryptoKey AES-GCM, en mémoire uniquement (jamais le mot de passe)

export function initApiKeyVault(firestoreDb) {
  db = firestoreDb;
  restoreFromSessionStorage();
}

export class VaultLockedError extends Error {
  constructor() {
    super("Coffre verrouillé : ressaisis ton mot de passe pour déverrouiller tes clés IA.");
    this.name = "VaultLockedError";
  }
}

async function restoreFromSessionStorage() {
  try {
    const raw = sessionStorage.getItem(VAULT_SESSION_KEY);
    if (!raw) return;
    const rawBytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    cachedKey = await crypto.subtle.importKey("raw", rawBytes, "AES-GCM", true, ["encrypt", "decrypt"]);
  } catch (e) {
    cachedKey = null;
  }
}

async function deriveVaultKey(password, uid) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(`qcm-vault-${uid}`), iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

// Appelé juste après un login/register réussi (pendant qu'on a encore le mot
// de passe en mémoire), ou explicitement par l'utilisateur pour redéverrouiller.
export async function unlockVault(password, uid) {
  if (!password || !uid) return false;
  try {
    const key = await deriveVaultKey(password, uid);
    const raw = await crypto.subtle.exportKey("raw", key);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
    sessionStorage.setItem(VAULT_SESSION_KEY, b64);
    cachedKey = key;
    return true;
  } catch (e) {
    return false;
  }
}

export function lockVault() {
  cachedKey = null;
  sessionStorage.removeItem(VAULT_SESSION_KEY);
}

export function isVaultUnlocked() {
  return !!cachedKey;
}

function bufToHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function hexToBuf(hex) {
  const bytes = String(hex || "").match(/.{2}/g) || [];
  return new Uint8Array(bytes.map(h => parseInt(h, 16)));
}

async function encryptValue(plaintext) {
  if (!cachedKey) throw new VaultLockedError();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cachedKey, enc.encode(plaintext));
  return { iv: bufToHex(iv), ciphertext: bufToHex(ciphertext) };
}

async function decryptValue(entry) {
  if (!cachedKey) throw new VaultLockedError();
  const iv = hexToBuf(entry.iv);
  const ciphertext = hexToBuf(entry.ciphertext);
  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cachedKey, ciphertext);
  return new TextDecoder().decode(dec);
}

export async function saveApiKey(uid, provider, apiKeyPlaintext) {
  const entry = await encryptValue(apiKeyPlaintext);
  await setDoc(doc(db, "userApiKeys", uid), {
    [provider]: entry,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

export async function deleteApiKey(uid, provider) {
  await setDoc(doc(db, "userApiKeys", uid), {
    [provider]: deleteField(),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

// Liste des fournisseurs pour lesquels une clé est enregistrée (ne déchiffre
// rien, se contente de vérifier la présence du champ).
export async function getConfiguredProviders(uid) {
  if (!uid) return [];
  try {
    const snap = await getDoc(doc(db, "userApiKeys", uid));
    if (!snap.exists()) return [];
    const data = snap.data() || {};
    return PROVIDERS.filter(p => data[p]?.iv && data[p]?.ciphertext);
  } catch (e) {
    return [];
  }
}

export async function hasAnyApiKey(uid) {
  const providers = await getConfiguredProviders(uid);
  return providers.length > 0;
}

// Renvoie la clé en clair, ou null si aucune clé enregistrée pour ce
// fournisseur. Lève VaultLockedError si une clé existe mais que le coffre est
// verrouillé (permet à l'appelant de proposer un déverrouillage plutôt que
// d'afficher une erreur générique).
export async function getApiKey(uid, provider) {
  const snap = await getDoc(doc(db, "userApiKeys", uid));
  if (!snap.exists()) return null;
  const entry = snap.data()?.[provider];
  if (!entry?.iv || !entry?.ciphertext) return null;
  return decryptValue(entry);
}
