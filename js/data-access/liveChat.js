import {
  collection,
  addDoc,
  deleteDoc,
  getDocs,
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { toast } from "../core/runtime.js";
import { renderLatexHtml } from "../core/latex.js";
import { t } from "../core/i18n.js";

let db;
let unsub = null;
let current = null;
let unreadCount = 0;
let initialLoaded = false;
let searchTimer = null;
let fallbackPollInterval = null;

const CHAT_MAX_MESSAGES = 120;
const CHAT_PRUNE_SCAN_LIMIT = 300;
const PRUNE_COOLDOWN_MS = 20000;
const pruneLastRun = new Map();

const GIPHY_PROXY_URL = (window.__GIPHY_PROXY_URL || localStorage.getItem("qcm_giphy_proxy_url") || "").trim();
const CINEMAX_GIF_URL = new URL("./cinemax.gif", import.meta.url).href;

export function initLiveChat(firestoreDb) {
  db = firestoreDb;
}

export function openLiveChat({ mode, id, pseudo, label }) {
  const screen = document.getElementById("quiz-screen");
  const panel = document.getElementById("quiz-chat");
  const messagesEl = document.getElementById("quiz-chat-messages");
  const form = document.getElementById("quiz-chat-form");
  const input = document.getElementById("quiz-chat-input");
  const labelEl = document.getElementById("quiz-chat-room-label");
  const unreadEl = document.getElementById("quiz-chat-unread");
  const gifToggle = document.getElementById("quiz-chat-gif-toggle");
  const gifPicker = document.getElementById("quiz-chat-gif-picker");
  const gifSearch = document.getElementById("quiz-chat-gif-search");
  const gifResults = document.getElementById("quiz-chat-gif-results");

  if (!db || !screen || !panel || !messagesEl || !form || !input || !labelEl || !unreadEl || !gifToggle || !gifPicker || !gifSearch || !gifResults) return;

  closeLiveChat(false);
  current = { mode, id, pseudo };
  unreadCount = 0;
  initialLoaded = false;
  updateUnreadBadge(unreadEl);

  screen.classList.add("chat-enabled");
  panel.style.display = "flex";
  labelEl.textContent = label || "";
  input.placeholder = t("chat.inputPlaceholder");
  messagesEl.innerHTML = `<div class='quiz-chat-empty'>${t("chat.liveChatEmpty")}</div>`;
  gifPicker.style.display = "none";

  if (!GIPHY_PROXY_URL) {
    gifToggle.classList.add("disabled");
    gifToggle.title = t("chat.gifProxyMissingTitle");
  } else {
    gifToggle.classList.remove("disabled");
    gifToggle.title = t("chat.sendGifTitle");
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !current) return;

    // if (text.toLowerCase() === "/cinemax") {
    //   try {
    //     const messagesRef = mode === "duel"
    //       ? collection(db, "challenges", id, "messages")
    //       : collection(db, "rooms", id, "messages");

    //     await addDoc(messagesRef, {
    //       pseudo,
    //       text: "cinemax",
    //       type: "gif",
    //       gifUrl: CINEMAX_GIF_URL,
    //       createdAt: serverTimestamp()
    //     });
    //     input.value = "";
    //   } catch (err) {
    //     const msg = err?.code ? err.code : "erreur";
    //     toast(`❌ Chat: ${msg}`);
    //   }
    //   return;
    // }

    try {
      const messagesRef = mode === "duel"
        ? collection(db, "challenges", id, "messages")
        : collection(db, "rooms", id, "messages");

      await addDoc(messagesRef, {
        pseudo,
        text,
        type: "text",
        createdAt: serverTimestamp()
      });
      input.value = "";
    } catch (err) {
      const msg = err?.code ? err.code : t("chat.unknownError");
      toast(t("chat.sendErrorToast", { msg }));
    }
  };

  gifToggle.onclick = async () => {
    if (!GIPHY_PROXY_URL) {
      toast(t("chat.gifProxyMissingToast"));
      return;
    }

    const open = gifPicker.style.display !== "none";
    gifPicker.style.display = open ? "none" : "block";

    if (!open && !gifResults.dataset.loaded) {
      await loadGifs("", gifResults);
      gifResults.dataset.loaded = "1";
    }
  };

  gifSearch.oninput = () => {
    if (!GIPHY_PROXY_URL) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      loadGifs(gifSearch.value.trim(), gifResults);
    }, 220);
  };

  messagesEl.onscroll = () => {
    if (isNearBottom(messagesEl)) {
      unreadCount = 0;
      updateUnreadBadge(unreadEl);
    }
  };

  const messagesRef = mode === "duel"
    ? collection(db, "challenges", id, "messages")
    : collection(db, "rooms", id, "messages");

  maybePruneMessages(messagesRef, `${mode}:${id}`);

  const messagesQuery = query(messagesRef, orderBy("createdAt", "desc"), limit(CHAT_MAX_MESSAGES));

  unsub = onSnapshot(
    messagesQuery,
    (snap) => {
      stopFallbackPolling();
      const docs = [];
      snap.forEach(d => docs.push(d.data()));
      docs.reverse();

      const nearBottom = isNearBottom(messagesEl);
      const addedFromOthers = snap.docChanges().filter(c => c.type === "added" && c.doc.data()?.pseudo !== pseudo).length;
      const addedFromMe = snap.docChanges().some(c => c.type === "added" && c.doc.data()?.pseudo === pseudo);

      renderMessages(docs, pseudo, messagesEl);

      if (!initialLoaded) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
        initialLoaded = true;
        unreadCount = 0;
      } else if (nearBottom || addedFromMe) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
        unreadCount = 0;
      } else if (addedFromOthers > 0) {
        unreadCount += addedFromOthers;
      }

      updateUnreadBadge(unreadEl);
    },
    (err) => {
      console.error("liveChat listener error:", err);
      toast(t("chat.realtimeUnavailableToast"));
      startFallbackPolling(messagesQuery, pseudo, messagesEl, unreadEl);
    }
  );
}

export function closeLiveChat(hide = true) {
  if (unsub) {
    unsub();
    unsub = null;
  }
  stopFallbackPolling();

  const screen = document.getElementById("quiz-screen");
  const panel = document.getElementById("quiz-chat");
  const form = document.getElementById("quiz-chat-form");
  const input = document.getElementById("quiz-chat-input");
  const messagesEl = document.getElementById("quiz-chat-messages");
  const gifToggle = document.getElementById("quiz-chat-gif-toggle");
  const gifSearch = document.getElementById("quiz-chat-gif-search");
  const gifPicker = document.getElementById("quiz-chat-gif-picker");
  const unreadEl = document.getElementById("quiz-chat-unread");

  if (form) form.onsubmit = null;
  if (messagesEl) messagesEl.onscroll = null;
  if (gifToggle) gifToggle.onclick = null;
  if (gifSearch) gifSearch.oninput = null;
  if (gifPicker) gifPicker.style.display = "none";
  clearTimeout(searchTimer);
  unreadCount = 0;
  if (unreadEl) updateUnreadBadge(unreadEl);
  if (hide && panel) panel.style.display = "none";
  if (hide && screen) screen.classList.remove("chat-enabled");
  if (input) input.placeholder = t("chat.inputPlaceholder");

  current = null;
}

export async function postAiCoachMessage(text, options = {}) {
  if (!db || !current || !text) return;

  const messagesRef = current.mode === "duel"
    ? collection(db, "challenges", current.id, "messages")
    : collection(db, "rooms", current.id, "messages");

  await addDoc(messagesRef, {
    pseudo: t("chat.aiCoachAuthor"),
    text: String(text).slice(0, 1800),
    latexEnabled: options.latexEnabled !== false,
    type: "text",
    createdAt: serverTimestamp()
  });
}

function renderMessages(messages, me, el) {
  if (!messages.length) {
    el.innerHTML = `<div class='quiz-chat-empty'>${t("chat.noMessagesYet")}</div>`;
    return;
  }

  el.innerHTML = "";
  messages.forEach(msg => {
    const row = document.createElement("div");
    row.className = `chat-msg ${msg.pseudo === me ? "me" : ""}`;

    const author = document.createElement("div");
    author.className = "chat-author";
    author.textContent = msg.pseudo || "?";

    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    if (msg.type === "gif" && msg.gifUrl) {
      const img = document.createElement("img");
      img.src = msg.gifUrl;
      img.alt = msg.text || "GIF";
      img.className = "chat-gif";
      bubble.appendChild(img);
    } else {
      bubble.innerHTML = renderLatexHtml(msg.text || "", { latexEnabled: msg.latexEnabled !== false });
    }

    row.appendChild(author);
    row.appendChild(bubble);
    el.appendChild(row);
  });

}

function startFallbackPolling(messagesQuery, me, messagesEl, unreadEl) {
  stopFallbackPolling();

  let previousCount = 0;

  const poll = async () => {
    try {
      const snap = await getDocs(messagesQuery);
      const docs = [];
      snap.forEach(d => docs.push(d.data()));
      docs.reverse();

      const nearBottom = isNearBottom(messagesEl);
      const added = Math.max(0, docs.length - previousCount);

      renderMessages(docs, me, messagesEl);

      if (!initialLoaded) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
        initialLoaded = true;
        unreadCount = 0;
      } else if (nearBottom) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
        unreadCount = 0;
      } else if (added > 0) {
        unreadCount += added;
      }

      previousCount = docs.length;
      updateUnreadBadge(unreadEl);
    } catch (e) {
      console.error("liveChat fallback poll error:", e);
    }
  };

  poll();
  fallbackPollInterval = setInterval(poll, 2500);
}

function stopFallbackPolling() {
  if (fallbackPollInterval) {
    clearInterval(fallbackPollInterval);
    fallbackPollInterval = null;
  }
}

function updateUnreadBadge(el) {
  if (!el) return;
  if (unreadCount > 0) {
    el.style.display = "inline-flex";
    el.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
  } else {
    el.style.display = "none";
    el.textContent = "0";
  }
}

function isNearBottom(el) {
  return (el.scrollHeight - el.scrollTop - el.clientHeight) < 20;
}

async function loadGifs(search, targetEl) {
  if (!GIPHY_PROXY_URL || !targetEl) return;

  const base = GIPHY_PROXY_URL.replace(/\/$/, "");
  const endpoint = search
    ? `${base}/search?q=${encodeURIComponent(search)}&limit=18`
    : `${base}/trending?limit=18`;

  try {
    const res = await fetch(endpoint);
    const json = await res.json();
    const gifs = Array.isArray(json?.data) ? json.data : [];

    if (!gifs.length) {
      targetEl.innerHTML = `<div class='quiz-chat-empty'>${t("chat.noGifsFound")}</div>`;
      return;
    }

    targetEl.innerHTML = gifs.map(gif => `
      <button type="button" class="gif-item" data-id="${gif.id}">
        <img src="${gif.images?.fixed_height_small?.url || gif.images?.preview_gif?.url || ''}" alt="${(gif.title || 'gif').replace(/"/g, '&quot;')}">
      </button>
    `).join("");

    targetEl.querySelectorAll(".gif-item").forEach(btn => {
      btn.onclick = async () => {
        if (!current) return;
        const gif = gifs.find(g => g.id === btn.dataset.id);
        if (!gif) return;

        try {
          const messagesRef = current.mode === "duel"
            ? collection(db, "challenges", current.id, "messages")
            : collection(db, "rooms", current.id, "messages");

          await addDoc(messagesRef, {
            pseudo: current.pseudo,
            type: "gif",
            text: gif.title || "GIF",
            gifUrl: gif.images?.fixed_height?.url || gif.images?.original?.url || "",
            createdAt: serverTimestamp()
          });

          const picker = document.getElementById("quiz-chat-gif-picker");
          if (picker) picker.style.display = "none";
        } catch (err) {
          const msg = err?.code ? err.code : t("chat.unknownError");
          toast(t("chat.gifSendErrorToast", { msg }));
        }
      };
    });
  } catch (e) {
    console.error("Giphy fetch error:", e);
    targetEl.innerHTML = `<div class='quiz-chat-empty'>${t("chat.gifApiError")}</div>`;
  }
}

async function maybePruneMessages(messagesRef, key) {
  const now = Date.now();
  const lastRun = pruneLastRun.get(key) || 0;
  if ((now - lastRun) < PRUNE_COOLDOWN_MS) return;
  pruneLastRun.set(key, now);

  try {
    const snap = await getDocs(
      query(messagesRef, orderBy("createdAt", "desc"), limit(CHAT_PRUNE_SCAN_LIMIT))
    );

    if (snap.size <= CHAT_MAX_MESSAGES) return;

    const docs = [];
    snap.forEach(d => docs.push(d));
    const toDelete = docs.slice(CHAT_MAX_MESSAGES);

    await Promise.allSettled(toDelete.map(d => deleteDoc(d.ref)));
  } catch (e) {
    console.error("chat prune error:", e);
  }
}
