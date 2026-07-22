// js/ai/sharedKeyVault.js
// Partage de clé API entre utilisateurs SANS jamais révéler la clé en clair à
// l'emprunteur. Contrairement au coffre perso (js/ai/apiKeyVault.js — chiffré
// avec une clé dérivée du MOT DE PASSE du propriétaire, donc utilisable
// seulement par lui), une clé "partagée" est rechiffrée avec une clé PUBLIQUE
// RSA-OAEP dont la clé PRIVÉE correspondante n'existe que côté Worker
// Cloudflare (secret d'environnement SHARED_KEY_VAULT_PRIVATE_KEY, jamais
// exposé au client). Résultat : même le propriétaire ne peut plus déchiffrer
// sa copie "partagée" une fois chiffrée — seul le Worker le peut, et
// seulement pour faire l'appel IA lui-même (voir proxy/cloudflare-giphy-worker.js
// → handleUseSharedKey), jamais pour la renvoyer en clair à qui que ce soit.
//
// Chaque utilisateur choisit LUI-MÊME à qui il partage sa clé (pas de gate
// admin sur les fournisseurs) : chaque clé partagée porte une liste
// "allowedUsernames" — seuls ces comptes peuvent l'emprunter — OU un flag
// "public" (partage avec tout le monde). Le Worker vérifie ça côté serveur
// avant de déchiffrer/utiliser la clé (voir handleUseSharedKey), donc ce
// n'est pas qu'un filtre d'affichage.

import {
  doc,
  getDoc,
  getDocs,
  collection,
  setDoc,
  deleteField,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getApiKey } from "./apiKeyVault.js";
import { t } from "../core/i18n.js";

// Clé PUBLIQUE uniquement — safe à distribuer (elle ne permet QUE de chiffrer,
// jamais de déchiffrer). La clé privée correspondante vit uniquement dans le
// secret Cloudflare SHARED_KEY_VAULT_PRIVATE_KEY, jamais dans ce dépôt.
const SHARING_PUBLIC_KEY_JWK = {
  key_ops: ["encrypt"],
  ext: true,
  alg: "RSA-OAEP-256",
  kty: "RSA",
  n: "6gWjULo6Ang-MJWx2VDQ_fd2Ah_j7vXGWBHXTF4P2Fa9nXlXpi5MlNS2m3tUfB6FmnqLZoQTdYcEti7GiikPXqDffv1ifKjlNApNjIUF-B4boDsoEatVOrT4V0nQIXjUzEqNj-sOskOmYSlJV_-6qQR_i11Pf5sStQ1vbLBpces6R77D3DA13Z92a4UhzPtFDby5uxNsH21Knnqy75DhG0Nhh7lRBY22qJwwkwjCSZNYepCk8U1VEasSRueN8ALqsEhUzNGtsw9DunVYo38Aa6TW7slg3iObQ6OTEeyW4sSbibWIv-5nqPP_M2YPXI4eow2AnLrbRGi9ryGzTgBZCw",
  e: "AQAB"
};

export const ALL_PROVIDERS = ["claude", "gemini", "deepseek", "openai"];

let db;
let cachedPublicKey = null;

export function initSharedKeyVault(firestoreDb) {
  db = firestoreDb;
}

async function getPublicKey() {
  if (cachedPublicKey) return cachedPublicKey;
  cachedPublicKey = await crypto.subtle.importKey(
    "jwk", SHARING_PUBLIC_KEY_JWK, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]
  );
  return cachedPublicKey;
}

function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function sameUsername(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

/**
 * Partage la clé "provider" avec UN destinataire précis choisi par le
 * propriétaire (pas de diffusion à tous les utilisateurs). Déchiffre depuis
 * SON PROPRE coffre perso (nécessite que ce coffre soit déverrouillé — lève
 * VaultLockedError sinon) seulement si ce n'est pas déjà partagé (le
 * ciphertext une fois créé est réutilisé pour chaque nouveau destinataire).
 */
export async function shareApiKeyWithUser(uid, username, provider, targetUsername) {
  const target = String(targetUsername || "").trim();
  if (!target) throw new Error(t("sharedKeyVault.needExactUsername"));
  if (sameUsername(target, username)) throw new Error(t("sharedKeyVault.cannotShareWithSelf"));

  const ref = doc(db, "sharedApiKeys", uid);
  const snap = await getDoc(ref);
  const existing = snap.data()?.[provider];

  let ciphertext = existing?.ciphertext;
  if (!ciphertext) {
    const plaintext = await getApiKey(uid, provider);
    if (!plaintext) throw new Error(t("sharedKeyVault.noKeyForProvider"));
    const publicKey = await getPublicKey();
    const enc = new TextEncoder();
    const buf = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, enc.encode(plaintext));
    ciphertext = bufToBase64(buf);
  }

  const currentList = Array.isArray(existing?.allowedUsernames) ? existing.allowedUsernames : [];
  const allowedUsernames = currentList.some(u => sameUsername(u, target)) ? currentList : [...currentList, target];

  await setDoc(ref, {
    [provider]: { ciphertext, sharedBy: username, allowedUsernames, public: !!existing?.public },
    updatedAt: serverTimestamp()
  }, { merge: true });
}

/** Retire UN destinataire précis (la clé reste partagée avec les autres). */
export async function revokeApiKeyFromUser(uid, provider, targetUsername) {
  const ref = doc(db, "sharedApiKeys", uid);
  const snap = await getDoc(ref);
  const existing = snap.data()?.[provider];
  if (!existing) return;

  const allowedUsernames = (existing.allowedUsernames || []).filter(u => !sameUsername(u, targetUsername));
  await setDoc(ref, {
    [provider]: { ...existing, allowedUsernames },
    updatedAt: serverTimestamp()
  }, { merge: true });
}

/**
 * Partage la clé "provider" avec TOUT LE MONDE (n'importe quel utilisateur
 * connecté pourra l'emprunter, pas seulement les destinataires listés dans
 * allowedUsernames). Comme shareApiKeyWithUser, réutilise le ciphertext s'il
 * existe déjà plutôt que de re-déchiffrer/re-chiffrer.
 */
export async function shareApiKeyWithAll(uid, username, provider) {
  const ref = doc(db, "sharedApiKeys", uid);
  const snap = await getDoc(ref);
  const existing = snap.data()?.[provider];

  let ciphertext = existing?.ciphertext;
  if (!ciphertext) {
    const plaintext = await getApiKey(uid, provider);
    if (!plaintext) throw new Error(t("sharedKeyVault.noKeyForProvider"));
    const publicKey = await getPublicKey();
    const enc = new TextEncoder();
    const buf = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, enc.encode(plaintext));
    ciphertext = bufToBase64(buf);
  }

  await setDoc(ref, {
    [provider]: { ciphertext, sharedBy: username, allowedUsernames: existing?.allowedUsernames || [], public: true },
    updatedAt: serverTimestamp()
  }, { merge: true });
}

/** Retire le partage public (les destinataires précis, s'il y en a, restent autorisés). */
export async function unshareApiKeyFromAll(uid, provider) {
  const ref = doc(db, "sharedApiKeys", uid);
  const snap = await getDoc(ref);
  const existing = snap.data()?.[provider];
  if (!existing) return;

  await setDoc(ref, {
    [provider]: { ...existing, public: false },
    updatedAt: serverTimestamp()
  }, { merge: true });
}

export async function isSharedWithAll(uid, provider) {
  try {
    const snap = await getDoc(doc(db, "sharedApiKeys", uid));
    return snap.data()?.[provider]?.public === true;
  } catch (e) {
    return false;
  }
}

/** Retire complètement le partage de ce fournisseur (tous destinataires). */
export async function unshareApiKey(uid, provider) {
  await setDoc(doc(db, "sharedApiKeys", uid), {
    [provider]: deleteField(),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

export async function isProviderShared(uid, provider) {
  try {
    const snap = await getDoc(doc(db, "sharedApiKeys", uid));
    return !!snap.data()?.[provider]?.ciphertext;
  } catch (e) {
    return false;
  }
}

/** Liste les pseudos avec qui CE propriétaire a partagé ce fournisseur — sert au panneau "Mes clés IA". */
export async function listAllowedUsernames(uid, provider) {
  try {
    const snap = await getDoc(doc(db, "sharedApiKeys", uid));
    const list = snap.data()?.[provider]?.allowedUsernames;
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

/**
 * Liste, pour un fournisseur donné, tous les partageurs qui ont explicitement
 * autorisé myUsername — sert au picker "choisir qui emprunter". Ne lit jamais
 * le ciphertext lui-même côté client (inutile : ce client ne peut pas le
 * déchiffrer de toute façon).
 */
export async function listSharersForProvider(provider, myUsername) {
  if (!myUsername) return [];
  try {
    const snap = await getDocs(collection(db, "sharedApiKeys"));
    const result = [];
    snap.forEach(d => {
      const entry = d.data()?.[provider];
      const allowed = entry?.allowedUsernames || [];
      const authorized = entry?.public === true || allowed.some(u => sameUsername(u, myUsername));
      if (entry?.ciphertext && entry?.sharedBy && authorized) {
        result.push({ ownerUid: d.id, sharedBy: entry.sharedBy });
      }
    });
    return result;
  } catch (e) {
    return [];
  }
}

/**
 * Liste TOUTES les clés actuellement partagées, tous propriétaires et tous
 * fournisseurs confondus — sert au panneau admin (modération / vue d'ensemble,
 * voir js/home.js). Ne lit jamais le ciphertext lui-même.
 */
export async function listAllSharedEntries() {
  try {
    const snap = await getDocs(collection(db, "sharedApiKeys"));
    const result = [];
    snap.forEach(d => {
      const data = d.data() || {};
      for (const provider of ALL_PROVIDERS) {
        const entry = data[provider];
        if (entry?.ciphertext) {
          result.push({
            ownerUid: d.id,
            provider,
            sharedBy: entry.sharedBy || "?",
            public: entry.public === true,
            allowedUsernames: Array.isArray(entry.allowedUsernames) ? entry.allowedUsernames : []
          });
        }
      }
    });
    return result;
  } catch (e) {
    return [];
  }
}

/** true si AU MOINS UN utilisateur a partagé AU MOINS UNE clé avec myUsername. */
export async function hasAnySharedKeyAvailable(myUsername) {
  if (!myUsername) return false;
  try {
    const snap = await getDocs(collection(db, "sharedApiKeys"));
    let found = false;
    snap.forEach(d => {
      const data = d.data() || {};
      for (const provider of ALL_PROVIDERS) {
        const entry = data[provider];
        if (!entry?.ciphertext) continue;
        const authorized = entry.public === true || (entry.allowedUsernames || []).some(u => sameUsername(u, myUsername));
        if (authorized) {
          found = true;
          break;
        }
      }
    });
    return found;
  } catch (e) {
    return false;
  }
}
