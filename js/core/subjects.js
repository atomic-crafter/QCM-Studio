// js/core/subjects.js
// ════════════════════════════════════════════════════════════════════════════
//  REGISTRE DES MODULES QCM
//  Pour ajouter un nouveau sujet :
//    1. Crée data/monsujet.js avec tes questions (copie le format de data/demo-teachers.js)
//    2. Importe-le ici
//    3. Ajoute une entrée dans le tableau SUBJECTS
//  Pour en retirer un : supprime son entrée dans SUBJECTS (et son import),
//  et éventuellement le fichier data/*.js correspondant s'il ne sert plus.
//  Voir le README (section "Adding your own quiz content") pour un tutoriel
//  complet : écrire/retirer un sujet, LaTeX, et l'archivage automatique.
//
// IMPORTANT: Par défaut le rendu LaTeX est désactivé pour tous les sujets.
// Pour activer KaTeX pour un sujet, ajoute `latex: true` dans l'entrée
// correspondante du tableau `SUBJECTS`.
// ════════════════════════════════════════════════════════════════════════════

import { DEMO_TEACHERS_QUESTIONS } from "../../data/demo-teachers.js";

const EXAM_DATE_PATTERN = /^\d{2}\/\d{2}\/\d{4}$/;

function normalizeExamDateValue(dateValue) {
  if (typeof dateValue !== "string") return null;
  const trimmed = dateValue.trim();
  return EXAM_DATE_PATTERN.test(trimmed) ? trimmed : null;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseExamDate(dateValue) {
  const normalized = normalizeExamDateValue(dateValue);
  if (!normalized) return null;

  const [day, month, year] = normalized.split("/").map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;

  return new Date(year, month - 1, day);
}

export function getSubjectExamDate(subjectId) {
  const subject = SUBJECTS.find(entry => entry.id === subjectId) || null;
  return normalizeExamDateValue(subject?.examDate || null);
}

export function isSubjectArchivedByDate(subject, referenceDate = new Date()) {
  const examDate = parseExamDate(getSubjectExamDate(subject.id));
  if (!examDate) return false;

  const archiveDate = new Date(examDate);
  archiveDate.setDate(archiveDate.getDate() + 1);

  return startOfDay(referenceDate) >= startOfDay(archiveDate);
}

export function getArchivedSubjectIds(referenceDate = new Date()) {
  const archived = new Set(ARCHIVED_SUBJECT_IDS);

  SUBJECTS.forEach(subject => {
    if (isSubjectArchivedByDate(subject, referenceDate)) {
      archived.add(subject.id);
    }
  });

  return [...archived];
}

export const SUBJECTS = [
  {
    id:          "demo-teachers",
    name:        "Showcase: English & Maths",
    icon:        "🎓",
    description: "Demo quiz — replace this with your own subjects. See the README for a full tutorial.",
    tagClass:    "purple",
    latex:       true,
    examDate:    null, // DD/MM/YYYY ou null
    questions:   DEMO_TEACHERS_QUESTIONS,
    modes: [
      { label: "Quiz complet · 7 Q", count: 7, timed: false },
      { label: "Mode examen · 7 Q", count: 7, timed: true },
      { label: "English only · 6 Q", count: 6, timed: false, filter: "📘 English Language" },
      { label: "Maths only · 4 Q", count: 4, timed: false, filter: "🧮 Mathematics" }
    ]
  },

  // ── Ajoute tes prochains sujets ici — voir le README pour le tutoriel ────
  // {
  //   id:          "monsujet",
  //   name:        "Mon Sujet",
  //   icon:        "📘",
  //   description: "Description du sujet...",
  //   tagClass:    "cyan",
  //   examDate:    "15/09/2026", // DD/MM/YYYY ou null
  //   questions:   MON_SUJET_QUESTIONS,
  //   modes: [
  //     { label: "Quiz rapide · 15 Q", count: 15, timed: false },
  //   ]
  // },
];

// Archive config is code-driven.
// Ajoute ici les IDs des sujets que tu veux déplacer dans la section "Archives".
export const ARCHIVED_SUBJECT_IDS = [
];

export function getActiveSubjects() {
  const archived = new Set(getArchivedSubjectIds());
  return SUBJECTS.filter(subject => !archived.has(subject.id));
}

export function getArchivedSubjects() {
  const archived = new Set(getArchivedSubjectIds());
  return SUBJECTS.filter(subject => archived.has(subject.id));
}

export function findSubjectById(subjectId) {
  return SUBJECTS.find(subject => subject.id === subjectId) || null;
}
