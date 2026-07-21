// js/data-access/firebase.js
// Abstraction Firebase : toutes les interactions Firestore passent par ici.
// Si un jour tu changes de backend, tu ne touches qu'à CE fichier.

import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  addDoc,
  deleteDoc,
  getDocs,
  query,
  orderBy,
  limit,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { isAiAdmin } from "../auth/aiAccess.js";

let db;

export function initFirebase(firestoreInstance) {
  db = firestoreInstance;
}

// ── LEADERBOARD ─────────────────────────────────────────────────────────────

/**
 * Sauvegarde ou met à jour le meilleur score d'un utilisateur pour un sujet donné.
 * On ne garde que le meilleur score par (pseudo, subjectId).
 */
export async function saveScore({ pseudo, subjectId, subjectName, score, correct, total }) {
  const pct = Math.round((correct / total) * 100);
  const docId = `${pseudo}__${subjectId}`;
  const ref = doc(db, "leaderboard", docId);

  const existing = await getDoc(ref);
  if (existing.exists() && existing.data().score >= pct) {
    // Ne met à jour que si le nouveau score est meilleur
    return;
  }

  await setDoc(ref, {
    pseudo,
    subjectId,
    subjectName,
    score: pct,
    correct,
    total,
    updatedAt: serverTimestamp()
  });
}

/**
 * Récupère le leaderboard global (top 50 par score).
 * Si subjectId est fourni, filtre par sujet.
 */
export async function getLeaderboard(subjectId = null) {
  let q;
  if (subjectId) {
    q = query(
      collection(db, "leaderboard"),
      where("subjectId", "==", subjectId),
      orderBy("score", "desc"),
      limit(50)
    );
  } else {
    // Pour le global, on prend le meilleur score tous sujets confondus par pseudo
    q = query(
      collection(db, "leaderboard"),
      orderBy("score", "desc"),
      limit(100)
    );
  }

  const snapshot = await getDocs(q);
  const rows = [];
  snapshot.forEach(d => rows.push({ id: d.id, ...d.data() }));

  if (!subjectId) {
    // Déduplique par pseudo : garde le meilleur score toutes matières confondues
    const best = {};
    for (const row of rows) {
      if (!best[row.pseudo] || row.score > best[row.pseudo].score) {
        best[row.pseudo] = row;
      }
    }
    return Object.values(best)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
  }

  return rows;
}

// ── CUSTOM QCMS ───────────────────────────────────────────────────────────────

/**
 * Sauvegarde un QCM généré par l'utilisateur.
 */
export async function saveCustomQcm({ title, questions, createdBy, createdByUid, isPublic, examDate = null, latex = true }) {
  const ref = await addDoc(collection(db, "customQcms"), {
    title,
    questions,
    createdBy,
    createdByUid: createdByUid || null,
    isPublic,
    examDate: examDate || null,
    latex: latex !== false,
    createdAt: serverTimestamp()
  });
  return ref.id;
}

/**
 * Récupère les QCM publics (toute la communauté), triés par date décroissante.
 */
export async function getPublicQcms() {
  const q = query(
    collection(db, "customQcms"),
    where("isPublic", "==", true),
    orderBy("createdAt", "desc"),
    limit(50)
  );
  const snap = await getDocs(q);
  const results = [];
  snap.forEach(d => results.push({ id: d.id, ...d.data() }));
  return results;
}

/**
 * Récupère tous les QCM créés par un utilisateur (publics + privés).
 */
export async function getUserQcms(username, uid = null) {
  if (uid) {
    try {
      const qUid = query(
        collection(db, "customQcms"),
        where("createdByUid", "==", uid),
        orderBy("createdAt", "desc"),
        limit(50)
      );
      const snapUid = await getDocs(qUid);
      const uidResults = [];
      snapUid.forEach(d => uidResults.push({ id: d.id, ...d.data() }));
      if (uidResults.length > 0) return uidResults;
    } catch (e) {
      // index manquant ou permission refusée: fallback sur createdBy
      if (e?.code !== "permission-denied" && e?.code !== "failed-precondition") {
        console.warn("getUserQcms (uid) failed:", e?.code);
      }
    }
  }

  try {
    const q = query(
      collection(db, "customQcms"),
      where("createdBy", "==", username),
      orderBy("createdAt", "desc"),
      limit(50)
    );
    const snap = await getDocs(q);
    const results = [];
    snap.forEach(d => results.push({ id: d.id, ...d.data() }));
    return results;
  } catch (e) {
    if (e?.code === "permission-denied") return [];
    throw e;
  }
}

/**
 * Récupère tous les QCM (publics + privés), triés par date décroissante.
 * Utilisé pour la vue admin.
 */
export async function getAllCustomQcms() {
  const q = query(
    collection(db, "customQcms"),
    orderBy("createdAt", "desc"),
    limit(200)
  );
  const snap = await getDocs(q);
  const results = [];
  snap.forEach(d => results.push({ id: d.id, ...d.data() }));
  return results;
}

/**
 * Met à jour un QCM existant (créateur uniquement, ou admin).
 */
export async function updateCustomQcm({ id, title, questions, isPublic, username, uid, examDate, latex }) {
  const ref  = doc(db, "customQcms", id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("QCM introuvable");

  const data = snap.data();
  const isOwnerByUid = uid && data.createdByUid === uid;
  const isOwnerByLegacyName = data.createdBy === username;
  const isOwner = isOwnerByUid || isOwnerByLegacyName;
  const isAdmin = isAiAdmin(username);
  if (!isOwner && !isAdmin) throw new Error("Non autorisé");

  await updateDoc(ref, {
    title,
    questions,
    isPublic,
    examDate: examDate !== undefined ? (examDate || null) : (data.examDate || null),
    latex: latex !== undefined ? latex !== false : (data.latex !== false),
    createdByUid: data.createdByUid || uid || null,
    updatedBy: username,
    updatedAt: serverTimestamp()
  });
}

/**
 * Supprime un QCM (verfie que l'appelant en est le créateur).
 */
export async function deleteCustomQcm(id, username, uid = null) {
  const ref  = doc(db, "customQcms", id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("QCM introuvable");
  const data = snap.data();
  const isOwnerByUid = uid && data.createdByUid === uid;
  const isOwnerByLegacyName = data.createdBy === username;
  const isOwner = isOwnerByUid || isOwnerByLegacyName;
  const isAdmin = isAiAdmin(username);
  if (!isOwner && !isAdmin) throw new Error("Non autorisé");
  await deleteDoc(ref);
}
