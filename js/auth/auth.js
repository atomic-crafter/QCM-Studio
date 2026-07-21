// js/auth/auth.js
// Authentification sécurisée via Firebase Authentication.
// On conserve le login par username dans l'UI en le convertissant en email interne.

import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  getIdToken
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let auth;
let db;

export function initAuth(firebaseApp, firestoreDb) {
  auth = getAuth(firebaseApp);
  db = firestoreDb;
}

function normalizeUsername(username) {
  return String(username || "").trim();
}

async function storeAuthToken(user) {
  if (!user) return;
  try {
    const token = await getIdToken(user);
    localStorage.setItem("qcm_auth_token", token);
  } catch (e) {
    console.error("Failed to store auth token:", e);
  }
}

function validateUsername(username) {
  if (!username || username.length < 2 || username.length > 20) {
    throw new Error("Le nom d'utilisateur doit faire 2 à 20 caractères");
  }
  if (!/^[a-zA-Z0-9_\-]+$/.test(username)) {
    throw new Error("Seuls les lettres, chiffres, _ et - sont autorisés");
  }
}

function usernameToAuthEmail(username) {
  return `${username.toLowerCase()}@qcm.local`;
}

function authEmailToUsername(email) {
  return String(email || "").split("@")[0] || "";
}

function formatAuthError(error, fallback) {
  const code = error?.code || "";

  if (code === "auth/operation-not-allowed") {
    return "Email/Password n'est pas activé dans Firebase Console → Authentication → Sign-in method";
  }
  if (code === "auth/too-many-requests") {
    return "Trop de tentatives. Réessaie dans quelques minutes";
  }
  if (code === "auth/network-request-failed") {
    return "Problème réseau. Vérifie ta connexion";
  }
  if (code === "auth/user-disabled") {
    return "Ce compte est désactivé";
  }
  if (code === "auth/invalid-api-key") {
    return "Configuration Firebase invalide (API key)";
  }
  if (code === "auth/invalid-email") {
    return "Format d'email interne invalide — contacte l'admin [auth/invalid-email]";
  }
  if (code === "auth/weak-password") {
    return "Mot de passe trop court pour Firebase (minimum 6 caractères)";
  }

  // Include the raw code so the user can report exactly what went wrong
  return `${fallback} [${code || "inconnu"}]`;
}

export async function registerUser(usernameRaw, password) {
  const username = normalizeUsername(usernameRaw);
  validateUsername(username);

  if (!password || password.length < 6) {
    throw new Error("Le mot de passe doit faire au moins 6 caractères");
  }

  const email = usernameToAuthEmail(username);

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName: username });

    await setDoc(doc(db, "users", cred.user.uid), {
      username,
      usernameLower: username.toLowerCase(),
      createdAt: serverTimestamp()
    });

    // Store auth token for API requests
    await storeAuthToken(cred.user);

    return username;
  } catch (error) {
    if (error?.code === "auth/email-already-in-use") {
      throw new Error("Ce nom d'utilisateur est déjà pris");
    }
    if (error?.code === "auth/weak-password") {
      throw new Error("Mot de passe trop faible");
    }
    throw new Error(formatAuthError(error, "Inscription impossible"));
  }
}

export async function loginUser(usernameRaw, password) {
  const username = normalizeUsername(usernameRaw);
  if (!username || !password) {
    throw new Error("Remplis tous les champs");
  }

  const email = usernameToAuthEmail(username);
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    
    // Store auth token for API requests
    await storeAuthToken(cred.user);
    
    return username;
  } catch (error) {
    const code = error?.code || "";

    // Firebase v10 uses auth/invalid-credential as the unified "bad username
    // or password" code; older SDKs return auth/user-not-found or
    // auth/wrong-password separately.
    const badCredentialCodes = new Set([
      "auth/invalid-credential",
      "auth/invalid-login-credentials",
      "auth/user-not-found",
      "auth/wrong-password",
    ]);

    if (badCredentialCodes.has(code)) {
      throw new Error("Nom d'utilisateur ou mot de passe incorrect");
    }

    throw new Error(formatAuthError(error, "Connexion impossible"));
  }
}

export async function logoutUser() {
  if (!auth) return;
  localStorage.removeItem("qcm_auth_token");
  await signOut(auth);
}

async function resolveUserSession(user) {
  if (!user) return null;

  let username = user.displayName || "";

  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists()) {
      username = snap.data().username || username;
    }
  } catch (_) {
    // fallback on displayName / email below
  }

  if (!username) {
    username = authEmailToUsername(user.email);
  }

  if (!username) return null;
  return { uid: user.uid, username, email: user.email || "" };
}

export async function getCurrentSessionUser() {
  if (!auth?.currentUser) return null;
  return resolveUserSession(auth.currentUser);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      localStorage.removeItem("qcm_auth_token");
      callback(null);
      return;
    }

    const resolved = await resolveUserSession(user);
    if (!resolved) {
      localStorage.removeItem("qcm_auth_token");
      callback(null);
      return;
    }

    // Store auth token for API requests
    await storeAuthToken(user);

    callback(resolved);
  });
}
