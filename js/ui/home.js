// js/ui/home.js
import {
  SUBJECTS,
  getActiveSubjects,
  getArchivedSubjects,
  findSubjectById,
  getSubjectExamDate,
  isSubjectArchivedByDate
} from "../core/subjects.js";
import { startQuiz }     from "./quiz.js";
import { showScreen, state } from "../core/runtime.js";
import { sendChallenge, sendCustomChallenge } from "../data-access/challenge.js";
import { getPublicQcms, getUserQcms, getAllCustomQcms, deleteCustomQcm } from "../data-access/firebase.js";
import { isAiAdmin, getAllowedAiUsers, setAllowedAiUsers, isAiOpenToAll, setAiOpenToAll, AI_ADMIN_USERNAME } from "../auth/aiAccess.js";
import { openApiKeysPanel } from "../ai/apiKeySettingsPanel.js";
import { listAllSharedEntries, unshareApiKey } from "../ai/sharedKeyVault.js";
import { renderLatexHtml } from "../core/latex.js";
import { loadCustomQcmPickerInto } from "./customQcmPicker.js";
import { t, getLang, onLanguageChange } from "../core/i18n.js";
import {
  createRoom,
  joinRoom,
  listenPublicRooms,
  stopListeningPublicRooms,
  openRoomSubjectPicker,
  startRoomGame,
  leaveRoom
} from "../data-access/room.js";

const CALENDAR_LOCALES = { fr: "fr-FR", en: "en-US", zh: "zh-CN" };
function getCalendarMonthFormatter() {
  return new Intl.DateTimeFormat(CALENDAR_LOCALES[getLang()] || "fr-FR", {
    month: "long",
    year: "numeric"
  });
}

let examCalendarMonthOffset = 0;
let homeRefreshTimer = null;
// QCM personnalisés/générés par IA avec une date d'examen — alimenté par
// renderCustomQcms (déjà en train de les charger pour la grille de cartes),
// réutilisé ici pour éviter un second appel Firestore. Vide pour les invités.
let calendarCustomQcms = [];

// Rejoue le dernier rendu connu de chaque section dynamique de l'accueil
// quand la langue change en cours de session (les data-i18n statiques sont
// déjà gérés par applyStaticTranslations, mais tout ce qui est généré en JS
// — calendrier, salons, utilisateurs en ligne — a besoin d'un re-rendu explicite).
let lastRenderHomeArgs = null;
let lastOnlineUsers = null;
let lastRoomsList = null;

function isHomeScreenActive() {
  return document.getElementById("home-screen")?.classList.contains("active") === true;
}

onLanguageChange(() => {
  if (!isHomeScreenActive()) return;
  if (lastRenderHomeArgs) {
    renderHome(lastRenderHomeArgs.username, lastRenderHomeArgs.isGuest, lastRenderHomeArgs.uid);
  }
  if (lastOnlineUsers) renderOnlineUsers(lastOnlineUsers);
  if (lastRoomsList) renderRoomsPanel(lastRoomsList);
});

function formatDateDDMMYYYY(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function parseExamDateValue(dateValue) {
  if (!dateValue) return null;
  const [day, month, year] = String(dateValue).split("/").map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;
  return new Date(year, month - 1, day);
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date, offset) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + offset);
  return next;
}

function getCalendarStart(date) {
  const firstDay = startOfMonth(date);
  const mondayIndex = (firstDay.getDay() + 6) % 7;
  firstDay.setDate(firstDay.getDate() - mondayIndex);
  return firstDay;
}

function formatCalendarDayLabel(date) {
  return formatDateDDMMYYYY(date);
}

function formatExamDateChip(dateValue) {
  const date = parseExamDateValue(dateValue);
  return date ? formatDateDDMMYYYY(date) : t("home.noExamDate");
}

function getSortedActiveSubjects(subjects) {
  const locale = CALENDAR_LOCALES[getLang()] || "fr-FR";
  return [...subjects].sort((left, right) => {
    const leftDate = parseExamDateValue(getSubjectExamDate(left.id));
    const rightDate = parseExamDateValue(getSubjectExamDate(right.id));

    if (leftDate && rightDate) {
      const diff = leftDate.getTime() - rightDate.getTime();
      if (diff !== 0) return diff;
      return left.name.localeCompare(right.name, locale);
    }

    if (leftDate && !rightDate) return -1;
    if (!leftDate && rightDate) return 1;
    return left.name.localeCompare(right.name, locale);
  });
}

function getSubjectExamStatus(subject) {
  const examDateValue = getSubjectExamDate(subject.id);
  if (!examDateValue) {
    return {
      label: t("home.noExamDate"),
      tone: "neutral",
      detail: t("home.toSchedule")
    };
  }

  const examDate = parseExamDateValue(examDateValue);
  const archived = examDate ? isSubjectArchivedByDate(subject) : false;

  return {
    label: archived ? t("home.autoArchived") : t("home.examOn", { date: formatExamDateChip(examDateValue) }),
    tone: archived ? "danger" : "highlight",
    detail: archived ? t("home.dayAfterExam") : t("home.visibleInCalendar")
  };
}

function scheduleHomeRefresh(username, isGuest, uid) {
  if (homeRefreshTimer) {
    clearTimeout(homeRefreshTimer);
  }

  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5, 0);
  const delay = Math.max(1000, nextMidnight.getTime() - now.getTime());

  homeRefreshTimer = setTimeout(() => {
    if (!document.getElementById("home-screen")?.classList.contains("active")) {
      scheduleHomeRefresh(username, isGuest, uid);
      return;
    }

    renderHome(username, isGuest, uid);
  }, delay);
}

function openCalendarSubjectModePicker(subjectId) {
  const subject = findSubjectById(subjectId);
  if (!subject) return;

  document.getElementById("calendar-subject-picker")?.remove();

  const wrap = document.createElement("div");
  wrap.id = "calendar-subject-picker";
  wrap.className = "picker-overlay";

  wrap.innerHTML = `
    <div class="picker-modal">
      <div class="picker-modal-header">
        <h3>🎯 ${subject.icon} ${subject.name}</h3>
        <button class="picker-close" onclick="document.getElementById('calendar-subject-picker')?.remove()">✕</button>
      </div>
      <div class="picker-target" style="margin-bottom: .9rem;">
        <div>
          <div class="picker-target-sub">${t("home.chooseModeHint")}</div>
        </div>
      </div>
      <div class="picker-modes">
        ${subject.modes.map((mode, modeIndex) => `
          <button
            class="picker-mode-btn ${mode.timed ? "timed" : ""}"
            onclick="window.__startCalendarMode('${subject.id}', ${modeIndex})">
            ${mode.timed ? "⏱ " : ""}${mode.label}
          </button>
        `).join("")}
      </div>
    </div>
  `;

  wrap.onclick = (event) => {
    if (event.target === wrap) wrap.remove();
  };

  document.body.appendChild(wrap);
}

// Lance directement un QCM personnalisé/généré par IA depuis le calendrier —
// même logique que le bouton "▶ Jouer" d'une carte QCM (renderCustomQcmCard),
// pas de picker de mode intermédiaire puisque ces QCM n'en ont qu'un seul.
function openCalendarCustomQcm(id) {
  const qcm = calendarCustomQcms.find(q => q.id === id);
  if (!qcm) return;

  const qs = Array.isArray(qcm.questions) ? qcm.questions : [];
  const subject = {
    id: `custom_${qcm.id}`,
    name: qcm.title || t("home.customQcmFallbackTitle"),
    icon: "✨",
    description: t("home.qcmGeneratedBy", { author: qcm.createdBy }),
    latex: qcm.latex !== false,
    questions: qs,
    modes: [{ label: t("home.quizModeLabel", { count: qs.length }), count: qs.length, timed: false }]
  };

  if (!startQuiz(subject, qs.length, false, null)) return;
  showScreen("quiz-screen");
}

// Construit une liste unifiée d'entrées calendrier à partir des sujets
// intégrés (js/core/subjects.js) ET des QCM personnalisés/générés par IA qui
// ont une date d'examen renseignée (voir renderCustomQcms, qui alimente
// calendarCustomQcms). Les QCM personnalisés n'ont pas de notion d'archivage
// automatique — ils restent affichés indéfiniment.
function buildCalendarEntries(subjects, customQcms) {
  const subjectEntries = subjects
    .map(subject => {
      const examDateValue = getSubjectExamDate(subject.id);
      const examDate = parseExamDateValue(examDateValue);
      if (!examDate) return null;
      return {
        kind: "subject",
        id: subject.id,
        icon: subject.icon,
        name: subject.name,
        examDate,
        examDateValue,
        dateKey: toDateKey(examDate),
        archived: isSubjectArchivedByDate(subject)
      };
    })
    .filter(Boolean);

  const customEntries = (customQcms || [])
    .map(qcm => {
      const examDate = parseExamDateValue(qcm.examDate);
      if (!examDate) return null;
      return {
        kind: "custom",
        id: qcm.id,
        icon: "✨",
        name: qcm.title || t("home.customQcmFallbackTitle"),
        examDate,
        examDateValue: qcm.examDate,
        dateKey: toDateKey(examDate),
        archived: false
      };
    })
    .filter(Boolean);

  return [...subjectEntries, ...customEntries];
}

function renderExamCalendar(entries) {
  const shell = document.getElementById("exam-calendar-shell");
  if (!shell) return;

  const now = new Date();
  const monthDate = addMonths(startOfMonth(now), examCalendarMonthOffset);

  const entriesByDay = new Map();
  entries.forEach(entry => {
    if (!entriesByDay.has(entry.dateKey)) entriesByDay.set(entry.dateKey, []);
    entriesByDay.get(entry.dateKey).push(entry);
  });

  const gridStart = getCalendarStart(monthDate);
  const dayNames = t("home.calendarDayNames").split(",");
  const cells = [];
  const cursor = new Date(gridStart);

  for (let index = 0; index < 42; index += 1) {
    const dayKey = toDateKey(cursor);
    const inMonth = cursor.getMonth() === monthDate.getMonth();
    const isToday = toDateKey(cursor) === toDateKey(now);
    const entries = entriesByDay.get(dayKey) || [];

    cells.push(`
      <div class="exam-calendar-day ${inMonth ? "in-month" : "out-month"} ${isToday ? "today" : ""} ${entries.length ? "has-exam" : ""}">
        <div class="exam-calendar-day-head">
          <span class="exam-calendar-day-number">${cursor.getDate()}</span>
          ${isToday ? `<span class="exam-calendar-day-pill">${t("common.today")}</span>` : ""}
        </div>
        <div class="exam-calendar-events">
          ${entries.length ? entries.map(entry => `
            <button class="exam-calendar-event ${entry.archived ? "archived" : ""}" type="button" title="${entry.name} · ${formatCalendarDayLabel(entry.examDate)}" onclick="window.__openCalendarEntry('${entry.kind}', '${entry.id}')">
              <span class="exam-calendar-event-icon">${entry.icon}</span>
              <span class="exam-calendar-event-text">${entry.name}</span>
            </button>
          `).join("") : `<span class="exam-calendar-empty-day">${inMonth ? "" : ""}</span>`}
        </div>
      </div>
    `);

    cursor.setDate(cursor.getDate() + 1);
  }

  const upcoming = entries
    .filter(entry => entry.examDate.getTime() >= now.getTime())
    .sort((left, right) => left.examDate - right.examDate)
    .slice(0, 4);

  shell.innerHTML = `
    <section class="exam-calendar-card">
      <div class="exam-calendar-header">
        <div>
          <div class="exam-calendar-kicker">${t("home.calendarKicker")}</div>
          <h2>${getCalendarMonthFormatter().format(monthDate)}</h2>
          <p>${t("home.calendarHint")}</p>
        </div>
        <div class="exam-calendar-controls">
          <button class="exam-calendar-nav" type="button" onclick="window.__shiftExamCalendar(-1)">←</button>
          <button class="exam-calendar-nav secondary" type="button" onclick="window.__shiftExamCalendar(0)">${t("common.today")}</button>
          <button class="exam-calendar-nav" type="button" onclick="window.__shiftExamCalendar(1)">→</button>
        </div>
      </div>
      <div class="exam-calendar-grid-head">
        ${dayNames.map(dayName => `<div>${dayName}</div>`).join("")}
      </div>
      <div class="exam-calendar-grid">
        ${cells.join("")}
      </div>
      <div class="exam-calendar-footer">
        <div class="exam-calendar-legend">
          <span><i class="legend-dot live"></i> ${t("common.today")}</span>
          <span><i class="legend-dot exam"></i> ${t("home.legendExamDate")}</span>
          <span><i class="legend-dot archived"></i> ${t("home.autoArchived")}</span>
        </div>
        <div class="exam-calendar-upcoming">
          ${upcoming.length ? upcoming.map(entry => `
            <button class="exam-calendar-upcoming-item ${entry.archived ? "archived" : ""}" type="button" onclick="window.__openCalendarEntry('${entry.kind}', '${entry.id}')">
              <span>${entry.icon} ${entry.name}</span>
              <strong>${formatCalendarDayLabel(entry.examDate)}</strong>
            </button>
          `).join("") : `<div class="exam-calendar-upcoming-empty">${t("home.addExamDateHint")}</div>`}
        </div>
      </div>
    </section>
  `;
}

function renderSubjectCard(subject) {
  const latexEnabled = subject?.latex === true;
  const modeButtons = subject.modes.map(mode => `
    <button
      class="mode-btn ${mode.timed ? "timed" : ""}"
      onclick="window.__startQuiz('${subject.id}', ${mode.count}, ${mode.timed || false}, ${mode.filter ? `'${mode.filter}'` : null})">
      ${mode.timed ? "⏱ " : ""}${mode.label}
    </button>
  `).join("");

  const status = getSubjectExamStatus(subject);

  return `
    <div class="subject-card ${status.tone === "danger" ? "subject-card-archived" : ""}">
      <div class="subject-card-header">
        <span class="subject-icon">${subject.icon}</span>
        <div>
          <h3>${subject.name}</h3>
          <span class="tag ${subject.tagClass || ""}">${t("home.questionsCount", { count: subject.questions.length })}</span>
          <span class="tag ${status.tone === "danger" ? "amber" : "cyan"}">${status.label}</span>
        </div>
      </div>
      <p>${renderLatexHtml(subject.description, { latexEnabled })}</p>
      <div class="mode-buttons">${modeButtons}</div>
    </div>
  `;
}

export function renderHome(username, isGuest = false, uid = null) {
  lastRenderHomeArgs = { username, isGuest, uid };
  const grid = document.getElementById("subjects-grid");
  const homeScreen = document.getElementById("home-screen");
  const guestWarning = document.getElementById("guest-warning");
  const onlinePanel = document.getElementById("online-panel");
  const roomsPanel = document.getElementById("rooms-panel");
  const customSection = document.getElementById("custom-qcms-section");
  const createAiBtn = document.getElementById("btn-create-qcm-ai");
  const createScratchBtn = document.getElementById("btn-create-qcm-scratch");
  const leaderboardBtn = document.getElementById("btn-leaderboard");
  const aiAccessBtn = document.getElementById("btn-ai-access");
  const apiKeysBtn = document.getElementById("btn-my-api-keys");

  const activeSubjects = getActiveSubjects();
  const archivedSubjects = getArchivedSubjects();
  const scheduledCount = SUBJECTS.filter(subject => getSubjectExamDate(subject.id)).length;

  let totalQ = 0;
  activeSubjects.forEach(s => totalQ += s.questions.length);
  const activeCount = activeSubjects.length;
  const archivedCount = archivedSubjects.length;
  document.getElementById("home-subtitle").textContent = t("home.subtitle", {
    totalQ,
    activeCount,
    scheduledPart: scheduledCount ? t("home.subtitleScheduledPart", { count: scheduledCount }) : "",
    archivedPart: archivedCount ? t("home.subtitleArchivedPart", { count: archivedCount }) : ""
  });

  if (guestWarning) {
    if (isGuest) {
      guestWarning.textContent = t("home.guestWarning");
      guestWarning.style.display = "block";
    } else {
      guestWarning.style.display = "none";
    }
  }

  if (onlinePanel) onlinePanel.style.display = isGuest ? "none" : "block";
  if (roomsPanel) roomsPanel.style.display = "block";
  if (customSection) {
    customSection.style.display = isGuest ? "none" : "block";
    if (isGuest) customSection.innerHTML = "";
  }

  if (createAiBtn) createAiBtn.disabled = isGuest;
  if (createScratchBtn) createScratchBtn.disabled = isGuest;
  if (leaderboardBtn) leaderboardBtn.style.display = isGuest ? "none" : "inline-flex";

  if (aiAccessBtn) {
    aiAccessBtn.style.display = (!isGuest && isAiAdmin(username)) ? "inline-flex" : "none";
  }
  window.__openAiAccessPanel = () => openAiAccessPanel(username);

  if (apiKeysBtn) {
    apiKeysBtn.style.display = isGuest ? "none" : "inline-flex";
  }
  window.__openApiKeysPanel = () => openApiKeysPanel(username, uid);

  window.__shiftExamCalendar = (direction) => {
    if (direction === 0) {
      examCalendarMonthOffset = 0;
    } else {
      examCalendarMonthOffset += direction;
    }
    renderExamCalendar(buildCalendarEntries(SUBJECTS, calendarCustomQcms));
  };

  window.__openCalendarEntry = (kind, id) => {
    if (kind === "custom") {
      openCalendarCustomQcm(id);
    } else {
      openCalendarSubjectModePicker(id);
    }
  };

  window.__startCalendarMode = (subjectId, modeIndex) => {
    const subject = findSubjectById(subjectId);
    const mode = subject?.modes?.[modeIndex] || null;
    if (!subject || !mode) return;

    document.getElementById("calendar-subject-picker")?.remove();
    if (!startQuiz(subject, mode.count, mode.timed || false, mode.filter || null)) return;
    showScreen("quiz-screen");
  };

  grid.innerHTML = "";

  const oldArchiveSection = document.getElementById("archived-subjects-section");
  if (oldArchiveSection) oldArchiveSection.remove();

  renderExamCalendar(buildCalendarEntries(SUBJECTS, calendarCustomQcms));

  if (!activeSubjects.length) {
    grid.innerHTML = `<div class="custom-qcms-empty">${t("home.allModulesArchived")}</div>`;
  }

  const sortedActiveSubjects = getSortedActiveSubjects(activeSubjects);
  sortedActiveSubjects.forEach(subject => {
    grid.insertAdjacentHTML("beforeend", renderSubjectCard(subject));
  });

  if (archivedSubjects.length && homeScreen) {
    const section = document.createElement("div");
    section.id = "archived-subjects-section";
    section.className = "archived-subjects";
    section.innerHTML = `
      <details>
        <summary>${t("home.archivesSectionTitle", { count: archivedSubjects.length })}</summary>
        <div class="archived-subjects-hint">${t("home.archivedSubjectsHint")}</div>
        <div class="archived-subjects-list">
          ${archivedSubjects.map(subject => `
            <div class="archived-subject-row">
              <div class="archived-subject-info">
                <span>${subject.icon}</span>
                <div>
                  <div class="archived-subject-name">${subject.name}</div>
                  <div class="archived-subject-desc">${renderLatexHtml(subject.description, { latexEnabled: subject?.latex === true })}</div>
                </div>
              </div>
              <div class="mode-buttons">
                ${subject.modes.map(mode => `
                  <button
                    class="mode-btn ${mode.timed ? "timed" : ""}"
                    onclick="window.__startQuiz('${subject.id}', ${mode.count}, ${mode.timed || false}, ${mode.filter ? `'${mode.filter}'` : null})">
                    ${mode.timed ? "⏱ " : ""}${mode.label}
                  </button>
                `).join("")}
              </div>
            </div>
          `).join("")}
        </div>
      </details>
    `;
    grid.insertAdjacentElement("afterend", section);
  }

  window.__startQuiz = (subjectId, count, timed, filter) => {
    const subject = findSubjectById(subjectId);
    if (!subject) return;
    if (!startQuiz(subject, count, timed, filter)) return;
    showScreen("quiz-screen");
  };

  // Charge les QCM communauté / perso en arrière-plan
  if (!isGuest && username) renderCustomQcms(username, uid);

  scheduleHomeRefresh(username, isGuest, uid);
}

// ── PANNEAU ADMIN : ACCÈS IA ──────────────────────────────────────────────────
async function openAiAccessPanel(adminUsername) {
  if (!isAiAdmin(adminUsername)) return;

  document.getElementById("ai-access-modal")?.remove();

  const wrap = document.createElement("div");
  wrap.id = "ai-access-modal";
  wrap.className = "picker-overlay";
  wrap.innerHTML = `
    <div class="picker-modal" style="width:min(420px,92vw)">
      <div class="picker-modal-header">
        <h3>${t("home.btnAiAccess")}</h3>
        <button class="picker-close" id="ai-access-close">✕</button>
      </div>
      <p style="color:var(--text-dim); font-size:.82rem; margin:-0.5rem 0 1rem; line-height:1.5;">
        ${t("home.aiAccessIntro", { admin: escHtml(AI_ADMIN_USERNAME) })}
      </p>
      <div id="ai-access-list" class="picker-subjects" style="max-height:40vh;"></div>
      <div class="field" style="margin-top:1rem;">
        <label>${t("home.addAccountLabel")}</label>
        <div style="display:flex; gap:.5rem;">
          <input id="ai-access-input" type="text" placeholder="${t("home.exactUsernamePlaceholder")}" maxlength="20" autocomplete="off" style="flex:1">
          <button class="btn sm" id="ai-access-add-btn">${t("home.addBtn")}</button>
        </div>
      </div>

      <hr style="border-color:var(--border); margin:1.2rem 0;">
      <h3 style="font-size:.95rem; margin-bottom:.4rem;">${t("home.keySharingTitle")}</h3>
      <label class="pdf-checkbox-label" style="display:flex; align-items:center; gap:.5rem; margin:.4rem 0; font-size:.85rem;">
        <input type="checkbox" id="ai-open-to-all-toggle">
        ${t("home.openToAllLabel")}
      </label>
      <p style="color:var(--text-dim); font-size:.75rem; margin:0 0 .8rem; line-height:1.5;">
        ${t("home.keySharingHint")}
      </p>
      <div id="shared-keys-admin-list" style="max-height:30vh; overflow:auto;"></div>
    </div>
  `;

  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  document.body.appendChild(wrap);
  document.getElementById("ai-access-close").onclick = () => wrap.remove();

  const listEl = document.getElementById("ai-access-list");

  async function refreshList() {
    listEl.innerHTML = `<div class="picker-custom-loading">${t("common.loadingSlash")}</div>`;
    const allowed = await getAllowedAiUsers();

    if (!allowed.length) {
      listEl.innerHTML = `<div class="picker-custom-empty">${t("home.noOtherUsersYet")}</div>`;
      return;
    }

    listEl.innerHTML = allowed.map(u => `
      <div class="picker-subject-block" style="display:flex; align-items:center; justify-content:space-between; padding:.6rem 1rem;">
        <span>${escHtml(u)}</span>
        <button class="btn-delete-qcm" data-user="${escAttr(u)}" title="${t("home.removeAiAccessTitle")}">🗑️</button>
      </div>
    `).join("");

    listEl.querySelectorAll("button[data-user]").forEach(btn => {
      btn.onclick = async () => {
        const current = await getAllowedAiUsers();
        await setAllowedAiUsers(current.filter(u => u !== btn.dataset.user), adminUsername);
        toast(t("home.toastAiAccessRemoved", { user: btn.dataset.user }));
        refreshList();
      };
    });
  }

  document.getElementById("ai-access-add-btn").onclick = async () => {
    const input = document.getElementById("ai-access-input");
    const newUser = input.value.trim();
    if (!newUser) return;

    if (isAiAdmin(newUser)) {
      toast(t("home.toastAdminAlreadyHasAccess"));
      input.value = "";
      return;
    }

    const current = await getAllowedAiUsers();
    if (current.includes(newUser)) {
      toast(t("home.toastAlreadyAllowed"));
      input.value = "";
      return;
    }

    await setAllowedAiUsers([...current, newUser], adminUsername);
    toast(t("home.toastUserGrantedAi", { user: newUser }));
    input.value = "";
    refreshList();
  };

  const openToAllCheckbox = document.getElementById("ai-open-to-all-toggle");
  openToAllCheckbox.onchange = async () => {
    openToAllCheckbox.disabled = true;
    try {
      await setAiOpenToAll(openToAllCheckbox.checked, adminUsername);
      toast(openToAllCheckbox.checked
        ? t("home.toastOpenToAllOn")
        : t("home.toastOpenToAllOff"));
    } catch (e) {
      openToAllCheckbox.checked = !openToAllCheckbox.checked;
      toast(`❌ ${e?.message || t("common.genericError")}`);
    } finally {
      openToAllCheckbox.disabled = false;
    }
  };

  const SHARE_ICONS = { claude: "🟣", gemini: "🔵", deepseek: "🟢", openai: "⚪" };

  async function refreshSharedKeysAdminList() {
    const el = document.getElementById("shared-keys-admin-list");
    el.innerHTML = `<div class="picker-custom-loading">${t("common.loadingSlash")}</div>`;
    const entries = await listAllSharedEntries();

    if (!entries.length) {
      el.innerHTML = `<div class="picker-custom-empty">${t("home.noSharedKeysYet")}</div>`;
      return;
    }

    el.innerHTML = entries.map(e => `
      <div class="picker-subject-block" style="display:flex; align-items:center; justify-content:space-between; padding:.5rem 1rem; gap:.5rem;">
        <span style="font-size:.8rem; line-height:1.4;">
          ${SHARE_ICONS[e.provider] || ""} <strong>${escHtml(e.provider)}</strong>${t("home.sharedByLabel", { user: escHtml(e.sharedBy) })}
          ${e.public ? ` <span class="tag cyan">${t("home.publicTag")}</span>` : ""}
          ${e.allowedUsernames.length ? ` <span style="color:var(--text-dim);">${t("home.sharedWithLabel", { users: escHtml(e.allowedUsernames.join(", ")) })}</span>` : (e.public ? "" : ` <span style="color:var(--text-dim);">${t("home.sharedWithNobody")}</span>`)}
        </span>
        <button class="btn-delete-qcm" data-owner="${escAttr(e.ownerUid)}" data-provider="${escAttr(e.provider)}" title="${t("home.forceRevokeTitle")}">🗑️</button>
      </div>
    `).join("");

    el.querySelectorAll("button[data-owner]").forEach(btn => {
      btn.onclick = async () => {
        if (!confirm(t("home.confirmForceRevoke"))) return;
        await unshareApiKey(btn.dataset.owner, btn.dataset.provider);
        toast(t("home.toastShareRevoked"));
        refreshSharedKeysAdminList();
      };
    });
  }

  isAiOpenToAll().then(v => { openToAllCheckbox.checked = v; });
  refreshList();
  refreshSharedKeysAdminList();
}

// ── QCM PERSONNALISÉS ─────────────────────────────────────────────────────────

export async function renderCustomQcms(username, uid = null) {
  const section = document.getElementById("custom-qcms-section");
  if (!section) return;

  section.innerHTML = `<div class="custom-qcms-loading">${t("home.loadingQcms")}</div>`;

  try {
    const isAdmin = isAiAdmin(username);
    const [userRes, publicRes, allRes] = await Promise.allSettled([
      getUserQcms(username, uid),
      getPublicQcms(),
      isAdmin ? getAllCustomQcms() : Promise.resolve([])
    ]);

    const userQcms = userRes.status === "fulfilled" ? userRes.value : [];
    const publicQcms = publicRes.status === "fulfilled" ? publicRes.value : [];
    const allQcms = allRes.status === "fulfilled" ? allRes.value : [];

    if (userRes.status === "rejected") {
      console.warn("getUserQcms denied:", userRes.reason);
    }
    if (publicRes.status === "rejected") {
      console.warn("getPublicQcms denied:", publicRes.reason);
    }
    if (allRes.status === "rejected") {
      console.warn("getAllCustomQcms denied:", allRes.reason);
    }

    // Community = public QCMs by OTHER users
    const communityQcms = publicQcms.filter(q => q.createdBy !== username);

    // Réutilise ce fetch (déjà fait pour la grille de cartes ci-dessous) pour
    // alimenter le calendrier d'examens avec les QCM ayant une date — pas de
    // requête Firestore supplémentaire. N'inclut pas la vue admin "tous les
    // QCM" (privés d'autrui) pour rester cohérent avec leur visibilité ailleurs.
    calendarCustomQcms = [...userQcms, ...communityQcms].filter(q => q.examDate);
    renderExamCalendar(buildCalendarEntries(SUBJECTS, calendarCustomQcms));

    let html = "";

    if (userQcms.length > 0) {
      html += `
        <div class="custom-qcms-block">
          <div class="custom-qcms-header">${t("home.myQcmsHeader")} <span class="custom-qcms-count">${userQcms.length}</span></div>
          <div class="custom-qcms-grid">
            ${userQcms.map(q => renderCustomQcmCard(q, username)).join("")}
          </div>
        </div>`;
    }

    if (communityQcms.length > 0) {
      html += `
        <div class="custom-qcms-block">
          <div class="custom-qcms-header">${t("home.communityHeader")} <span class="custom-qcms-count">${communityQcms.length}</span></div>
          <div class="custom-qcms-grid">
            ${communityQcms.map(q => renderCustomQcmCard(q, username)).join("")}
          </div>
        </div>`;
    }

    if (isAdmin) {
      const adminOnly = allQcms.filter(q => q.createdBy !== username);
      html += `
        <div class="custom-qcms-block">
          <div class="custom-qcms-header">${t("home.adminAllQcmsHeader")} <span class="custom-qcms-count">${adminOnly.length}</span></div>
          <div class="custom-qcms-grid">
            ${adminOnly.map(q => renderCustomQcmCard(q, username)).join("")}
          </div>
        </div>`;
    }

    if (!html) {
      html = `<div class="custom-qcms-empty">${t("home.noQcmsYet")}</div>`;
    }

    section.innerHTML = html;

    // Attach delete handlers
    section.querySelectorAll(".btn-delete-qcm").forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!confirm(t("home.confirmDeleteQcm"))) return;
        try {
          await deleteCustomQcm(id, username, uid);
          toast(t("home.toastQcmDeleted"));
          renderCustomQcms(username, uid);
        } catch (err) {
          toast("❌ " + err.message);
        }
      };
    });

    // Attach edit handlers
    section.querySelectorAll(".btn-edit-qcm").forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const qcm = {
          id: btn.dataset.id,
          title: btn.dataset.title,
          createdBy: btn.dataset.author,
          isPublic: btn.dataset.public === "true",
          examDate: btn.dataset.examdate || null,
          latex: btn.dataset.latex === "true",
          questions: JSON.parse(btn.dataset.questions || "[]")
        };
        const { openQcmEditorModal } = await import("../ai/qcmCreator.js");
        openQcmEditorModal(username, qcm, uid);
      };
    });

    // Attach play handlers
    section.querySelectorAll(".btn-play-custom-qcm").forEach(btn => {
      btn.onclick = () => {
        const id    = btn.dataset.id;
        const title = btn.dataset.title;
        let qs = [];
        try {
          const parsed = JSON.parse(btn.dataset.questions || "[]");
          qs = Array.isArray(parsed) ? parsed : [];
        } catch (err) {
          console.warn("Invalid custom QCM payload:", err);
        }
        const subject = {
          id:          `custom_${id}`,
          name:        title,
          icon:        "✨",
          description: t("home.qcmGeneratedBy", { author: btn.dataset.author }),
          latex:       btn.dataset.latex === "true",
          questions:   qs,
          modes:       [{ label: t("home.quizModeLabel", { count: qs.length }), count: qs.length, timed: false }]
        };
        if (!startQuiz(subject, qs.length, false, null)) return;
        showScreen("quiz-screen");
      };
    });

  } catch (err) {
    console.error("renderCustomQcms error:", err);
    section.innerHTML = `<div class="custom-qcms-empty">${t("common.loadError")}</div>`;
  }
}

function renderCustomQcmCard(qcm, currentUser) {
  const isAdmin = isAiAdmin(currentUser);
  const isOwner = qcm.createdBy === currentUser;
  const canEdit = isOwner || isAdmin;
  const vis     = qcm.isPublic ? t("home.qcmPublic") : t("home.qcmPrivate");
  const latexEnabled  = qcm.latex !== false;
  const safeTitle     = renderLatexHtml(qcm.title || t("home.untitled"), { latexEnabled });
  const safeAuthor    = escHtml(qcm.createdBy || "?");
  const safeQuestions = escAttr(JSON.stringify(qcm.questions || []));
  const count         = (qcm.questions || []).length;
  const examDate      = parseExamDateValue(qcm.examDate);

  return `
    <div class="custom-qcm-card subject-card">
      <div class="custom-qcm-card-header">
        <div>
          <h3>${safeTitle}</h3>
          <span class="tag cyan">${t("home.questionsCount", { count })}</span>
          <span class="tag">${vis}</span>
          ${examDate ? `<span class="tag amber">${t("home.examOn", { date: formatCalendarDayLabel(examDate) })}</span>` : ""}
        </div>
        <div style="display:flex; gap:.45rem; align-items:center">
          ${canEdit ? `<button class="btn-delete-qcm btn-edit-qcm" data-id="${qcm.id}" data-title="${escAttr(qcm.title || "")}" data-author="${escAttr(qcm.createdBy || "")}" data-public="${qcm.isPublic ? "true" : "false"}" data-examdate="${escAttr(qcm.examDate || "")}" data-latex="${latexEnabled ? "true" : "false"}" data-questions="${safeQuestions}" title="${t("common.editTitle")}">✏️</button>` : ""}
          ${canEdit ? `<button class="btn-delete-qcm" data-id="${qcm.id}" title="${t("common.deleteTitle")}">🗑️</button>` : ""}
        </div>
      </div>
      <p class="custom-qcm-author">${t("home.byAuthor", { author: safeAuthor })}</p>
      <div class="mode-buttons">
        <button class="mode-btn btn-play-custom-qcm"
          data-id="${qcm.id}"
          data-title="${escAttr(qcm.title || "")}"
          data-author="${escAttr(qcm.createdBy || "")}"
          data-latex="${latexEnabled ? "true" : "false"}"
          data-questions="${safeQuestions}">
          ${t("home.playQuizBtn", { count })}
        </button>
      </div>
    </div>
  `;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(s) {
  return String(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── PANNEAU UTILISATEURS EN LIGNE ────────────────────────────────────────────
export function renderOnlineUsers(users) {
  lastOnlineUsers = users;
  const panel = document.getElementById("online-panel");
  if (!panel) return;

  const entries = Array.isArray(users)
    ? users
      .map((u) => {
        if (!u) return null;
        if (typeof u === "string") {
          return { pseudo: u, status: "online" };
        }
        return {
          pseudo: u.pseudo,
          status: u.status === "playing" ? "playing" : "online"
        };
      })
      .filter((u) => u && u.pseudo)
    : [];

  if (!entries.length) {
    panel.innerHTML = `
      <div class="online-header">
        <span class="online-dot"></span> ${t("home.onlineLabelPlain")}
      </div>
      <div class="online-empty">${t("home.noOneElseOnline")}</div>
    `;
    return;
  }

  const onlineCount = entries.filter((u) => u.status === "online").length;
  const playingCount = entries.filter((u) => u.status === "playing").length;

  panel.innerHTML = `
    <div class="online-header">
      <span class="online-dot"></span> ${t("home.connectedCount", { count: entries.length })}
      <span class="online-header-breakdown">${t("home.onlineBreakdown", { onlineCount, playingCount })}</span>
    </div>
    <div class="online-users-list">
      ${entries.map(u => {
        const isPlaying = u.status === "playing";
        const statusLabel = isPlaying ? t("home.statusInQuiz") : t("home.statusOnlineBadge");
        return `
        <div class="online-user-chip">
          <div class="online-avatar">${u.pseudo[0].toUpperCase()}</div>
          <span class="online-name">${u.pseudo}</span>
          <span class="online-status-badge ${isPlaying ? "playing" : "online"}">${statusLabel}</span>
          <button class="btn-challenge ${isPlaying ? "disabled" : ""}" ${isPlaying ? "disabled" : ""} onclick="window.__openPicker('${u.pseudo}')">${isPlaying ? t("home.busyLabel") : t("home.challengeBtn")}</button>
        </div>
      `;
      }).join("")}
    </div>
  `;

  window.__openPicker = (targetPseudo) => {
    // Supprime un éventuel modal existant
    document.getElementById("picker-modal-wrap")?.remove();

    const wrap = document.createElement("div");
    wrap.id = "picker-modal-wrap";
    wrap.className = "picker-overlay";

    const renderSubjectBlock = (s) => `
      <div class="picker-subject-block">
        <div class="picker-subject-title">
          ${s.icon} ${s.name}
        </div>
        <div class="picker-modes">
          ${s.modes.map(m => `
            <button
              class="picker-mode-btn ${m.timed ? 'timed' : ''}"
              onclick="window.__sendChallengeMode('${targetPseudo}', '${s.id}', ${m.count}, ${m.timed || false}, ${m.filter ? `'${m.filter}'` : null})">
              ${m.timed ? '⏱ ' : ''}${m.label}
            </button>
          `).join("")}
        </div>
      </div>
    `;

    const subjects = getActiveSubjects().map(renderSubjectBlock).join("");
    const archivedSubjects = getArchivedSubjects();
    const archivedHtml = archivedSubjects.length ? `
      <details class="picker-archived-details">
        <summary>${t("home.archivedListTitle", { count: archivedSubjects.length })}</summary>
        <div class="picker-archived-list">${archivedSubjects.map(renderSubjectBlock).join("")}</div>
      </details>
    ` : "";

    wrap.innerHTML = `
      <div class="picker-modal">
        <div class="picker-modal-header">
          <h3>${t("home.challengeModalTitle")}</h3>
          <button class="picker-close" onclick="document.getElementById('picker-modal-wrap').remove()">✕</button>
        </div>
        <div class="picker-target">
          <div class="picker-target-avatar">${targetPseudo[0].toUpperCase()}</div>
          <div>
            <div class="picker-target-name">${targetPseudo}</div>
            <div class="picker-target-sub">${t("home.chooseGameModeHint")}</div>
          </div>
        </div>
        <div class="picker-subjects">${subjects}</div>
        ${archivedHtml}
        <div class="picker-custom-section">
          <details open>
            <summary>${t("home.myQcmsAndCommunity")}</summary>
            <div class="picker-custom-loading" id="duel-picker-custom-list">${t("common.loadingSlash")}</div>
          </details>
        </div>
      </div>
    `;

    // Ferme en cliquant sur l'overlay
    wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
    document.body.appendChild(wrap);

    loadCustomQcmPickerInto(
      wrap.querySelector("#duel-picker-custom-list"),
      state.user,
      state.uid,
      (qcm) => {
        document.getElementById("picker-modal-wrap")?.remove();
        sendCustomChallenge(targetPseudo, qcm);
      }
    );
  };

  window.__sendChallengeMode = (targetPseudo, subjectId, count, timed, filter) => {
    document.getElementById("picker-modal-wrap")?.remove();
    sendChallenge(targetPseudo, subjectId, count, filter, timed);
  };
}

// ── ROOMS PANEL ───────────────────────────────────────────────────────────────
export function initRoomsPanel() {
  listenPublicRooms(renderRoomsPanel);

  // Create room modal logic
  let _roomIsPublic = true;
  let _roomTimerSec = 60;

  window.__setRoomTimer = (seconds) => {
    const parsed = Number.parseInt(seconds, 10);
    _roomTimerSec = Number.isFinite(parsed) ? Math.max(10, Math.min(120, parsed)) : 60;
    const timerValueEl = document.getElementById('room-timer-value');
    if (timerValueEl) timerValueEl.textContent = `${_roomTimerSec}s`;
  };

  window.__setRoomType = (isPublic) => {
    _roomIsPublic = isPublic;
    document.getElementById('btn-public').classList.toggle('active', isPublic);
    document.getElementById('btn-private').classList.toggle('active', !isPublic);
    document.getElementById('room-password-field').style.display = isPublic ? 'none' : 'block';
  };

  window.__openCreateRoom = () => {
    _roomIsPublic = true;
    _roomTimerSec = 60;
    document.getElementById('btn-public').classList.add('active');
    document.getElementById('btn-private').classList.remove('active');
    document.getElementById('room-password-field').style.display = 'none';
    document.getElementById('room-name-input').value = '';
    document.getElementById('room-password-input').value = '';
    const timerInput = document.getElementById('room-timer-input');
    if (timerInput) timerInput.value = '60';
    window.__setRoomTimer(60);
    document.getElementById('create-room-modal').style.display = 'flex';
  };

  window.__confirmCreateRoom = async () => {
    const name     = document.getElementById('room-name-input').value.trim();
    const password = document.getElementById('room-password-input').value.trim();

    if (!_roomIsPublic && !password) {
      toast(t("home.toastPasswordRequired"));
      return;
    }

    try {
      await createRoom(name, _roomIsPublic, _roomIsPublic ? null : password, _roomTimerSec);
      document.getElementById('create-room-modal').style.display = 'none';
    } catch (e) {
      console.error("Room creation failed:", e);
      const msg = e?.code ? `${e.code}` : (e?.message || t("home.unknownError"));
      toast(t("home.toastCreateRoomFailed", { msg }));
    }
  };

  window.__openJoinRoom = () => {
    document.getElementById('join-code-input').value = '';
    document.getElementById('join-password-input').value = '';
    document.getElementById('join-password-field').style.display = 'block';
    document.getElementById('join-room-modal').style.display = 'flex';
  };

  window.__confirmJoinRoom = async () => {
    const code     = document.getElementById('join-code-input').value.toUpperCase().trim();
    const password = document.getElementById('join-password-input').value.trim();
    if (!code) return;
    try {
      const ok = await joinRoom(code, password);
      if (ok) {
        document.getElementById('join-room-modal').style.display = 'none';
      }
    } catch (e) {
      console.error("Room join failed:", e);
      const msg = e?.code ? `${e.code}` : (e?.message || t("home.unknownError"));
      toast(t("home.toastJoinRoomFailed", { msg }));
    }
  };

  window.__leaveRoomLobby    = async () => { await leaveRoom(true); showScreen('home-screen'); };
  window.__openRoomSubjectPicker = () => openRoomSubjectPicker();
  window.__startRoomGame     = () => startRoomGame();
}

export function teardownRoomsPanel() {
  stopListeningPublicRooms();
}

function renderRoomsPanel(rooms) {
  lastRoomsList = rooms;
  const el = document.getElementById('rooms-list');
  if (!el) return;
  const now = Date.now();
  const OFFLINE_THRESHOLD = 30000; // garder en phase avec ROOM_OFFLINE_THRESHOLD (js/room.js)

  const visibleRooms = rooms.filter(r => r.status !== 'finished');

  if (!visibleRooms.length) {
    el.innerHTML = `<div class="rooms-empty">${t("home.noPublicRooms")}</div>`;
    return;
  }

  el.innerHTML = `<div class="rooms-list">` + visibleRooms.map(r => {
    const players = Array.isArray(r.players) ? r.players : [];
    const heartbeats = r.playerHeartbeat || {};
    const connectedCount = players.filter(p => {
      const ts = heartbeats[p];
      if (!ts?.toMillis) return true;
      return (now - ts.toMillis()) < OFFLINE_THRESHOLD;
    }).length;
    const connectedWord = connectedCount > 1 ? t("home.connectedPlural") : t("home.connectedSingular");
    const statusWord = r.status === 'playing' ? t("home.statusPlaying") : t("home.statusWaiting");

    return `
    <div class="room-chip">
      <div>
        <div class="room-chip-name">${r.name}</div>
        <div class="room-chip-meta">${connectedCount} ${connectedWord}${players.length > connectedCount ? t("home.totalSuffix", { count: players.length }) : ''} · ${r.subjectName || t("home.themeToDefine")} · ⏱ ${r.questionTimeSec || 60}s/q · ${statusWord}</div>
      </div>
      <span class="room-chip-code">${r.id}</span>
      <button class="btn-join-room" onclick="window.__quickJoinRoom('${r.id}')">${t("home.joinBtnShort")}</button>
    </div>
  `;
  }).join('') + `</div>`;

  window.__quickJoinRoom = async (code) => {
    await joinRoom(code, null);
  };
}
