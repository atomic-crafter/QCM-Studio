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
import { t } from "../core/i18n.js";

let auth;
let db;

export function initAuth(firebaseApp, firestoreDb) {
  auth = getAuth(firebaseApp);
  db = firestoreDb;
}

function normalizeUsername(username) {
  return String(username || "").trim();
}

// Renvoie un ID token TOUJOURS frais (Firebase le rafraîchit sous le capot si
// besoin) — à appeler juste avant chaque requête au Worker, jamais mis en
// cache nous-mêmes. Un ID token Firebase expire au bout d'1h ; le mettre en
// cache (ex: dans localStorage à la connexion) fait échouer silencieusement
// toute requête Worker passé ce délai avec "non authentifié", alors que
// l'utilisateur est toujours bien connecté côté client.
export async function getFreshAuthToken() {
  if (!auth?.currentUser) return "";
  try {
    return await getIdToken(auth.currentUser);
  } catch (e) {
    console.error("Failed to get fresh auth token:", e);
    return "";
  }
}

function validateUsername(username) {
  if (!username || username.length < 2 || username.length > 20) {
    throw new Error(t("auth.err.usernameLength"));
  }
  if (!/^[a-zA-Z0-9_\-]+$/.test(username)) {
    throw new Error(t("auth.err.usernameChars"));
  }
}

function usernameToAuthEmail(username) {
  return `${username.toLowerCase()}@qcm.local`;
}

function authEmailToUsername(email) {
  return String(email || "").split("@")[0] || "";
}

function formatAuthError(error, fallbackKey) {
  const code = error?.code || "";

  if (code === "auth/operation-not-allowed") {
    return t("auth.err.emailNotEnabled");
  }
  if (code === "auth/too-many-requests") {
    return t("auth.err.tooManyRequests");
  }
  if (code === "auth/network-request-failed") {
    return t("auth.err.networkFailed");
  }
  if (code === "auth/user-disabled") {
    return t("auth.err.userDisabled");
  }
  if (code === "auth/invalid-api-key") {
    return t("auth.err.invalidApiKey");
  }
  if (code === "auth/invalid-email") {
    return t("auth.err.invalidEmail");
  }
  if (code === "auth/weak-password") {
    return t("auth.err.weakPasswordFirebase");
  }

  // Include the raw code so the user can report exactly what went wrong
  return t("auth.err.withCode", { fallback: t(fallbackKey), code: code || t("auth.err.unknownCode") });
}

export async function registerUser(usernameRaw, password) {
  const username = normalizeUsername(usernameRaw);
  validateUsername(username);

  if (!password || password.length < 6) {
    throw new Error(t("auth.err.passwordLength"));
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

    return username;
  } catch (error) {
    if (error?.code === "auth/email-already-in-use") {
      throw new Error(t("auth.err.usernameTaken"));
    }
    if (error?.code === "auth/weak-password") {
      throw new Error(t("auth.err.weakPassword"));
    }
    throw new Error(formatAuthError(error, "auth.err.registerFailedFallback"));
  }
}

export async function loginUser(usernameRaw, password) {
  const username = normalizeUsername(usernameRaw);
  if (!username || !password) {
    throw new Error(t("auth.err.fillAllFields"));
  }

  const email = usernameToAuthEmail(username);
  try {
    await signInWithEmailAndPassword(auth, email, password);
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
      throw new Error(t("auth.err.badCredentials"));
    }

    throw new Error(formatAuthError(error, "auth.err.loginFailedFallback"));
  }
}

export async function logoutUser() {
  if (!auth) return;
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
      callback(null);
      return;
    }

    const resolved = await resolveUserSession(user);
    if (!resolved) {
      callback(null);
      return;
    }

    callback(resolved);
  });
}
