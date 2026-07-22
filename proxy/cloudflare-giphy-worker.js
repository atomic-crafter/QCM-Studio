// Cloudflare Worker - Proxy for GIPHY GIFs and Gemini AI QCM generation
// Secrets required:
//   GIPHY_API_KEY               – for GET /trending and GET /search
//   GEMINI_API_KEY               – for POST /generate-qcm
//   GEMINI_CHAT_KEY              – for POST /explain-answer
//   SHARED_KEY_VAULT_PRIVATE_KEY – for POST /use-shared-key (JSON JWK, RSA-OAEP
//     private key — pair to the public key embedded in js/ai/sharedKeyVault.js.
//     Generate your own pair with scripts/generate-shared-key-pair.mjs).
//     Only this Worker can ever decrypt a shared key; it's used here only to
//     make the AI call server-side and is never returned to any client.
//   RESEND_API_KEY (optional)    – for POST /report-bug: sends an email via
//     Resend (https://resend.com, free tier) when a user submits a bug
//     report. The report is ALWAYS saved to Firestore (bugReports/{id}) by
//     the client regardless of this — this secret only adds an email nudge
//     on top. If unset, /report-bug just no-ops with { ok: true, skipped: true }.

// Défauts pour ce déploiement — configurables sans toucher au code via les
// [vars] de wrangler.toml (FIREBASE_PROJECT_ID / ADMIN_USERNAME / BUG_REPORT_EMAIL),
// lues à chaque requête ci-dessous. FIREBASE_PROJECT_ID/ADMIN_USERNAME doivent
// correspondre à l'email admin dans firestore.rules et à adminUsername dans
// js/config/site.config.js.
// CHANGE THESE to your own Firebase project ID, admin account username, and notification email.
let FIREBASE_PROJECT_ID = 'YOUR_PROJECT_ID';
let AI_ADMIN_USERNAME = 'YourAdminUsername';
let BUG_REPORT_EMAIL = 'your@email.com';

const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash-latest',
  'gemini-1.5-flash',
];

// Même liste que js/ai/qcmPromptBuilder.js (LANGUAGE_NAMES) — dupliquée ici car
// ce Worker est un fichier isolé, sans accès aux modules ES du site.
const QCM_LANGUAGE_NAMES = {
  fr: 'français',
  en: 'anglais',
  es: 'espagnol',
  de: 'allemand',
  it: 'italien',
  zh: 'chinois (mandarin simplifié)',
  pt: 'portugais',
  nl: 'néerlandais'
};

export default {
  async fetch(request, env) {
    FIREBASE_PROJECT_ID = env.FIREBASE_PROJECT_ID || FIREBASE_PROJECT_ID;
    AI_ADMIN_USERNAME = env.ADMIN_USERNAME || AI_ADMIN_USERNAME;
    BUG_REPORT_EMAIL = env.BUG_REPORT_EMAIL || BUG_REPORT_EMAIL;

    const url = new URL(request.url);
    const pathname = normalizePath(url.pathname);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // ── POST routes ───────────────────────────────────────────────────────────
    if (request.method === 'POST') {
      const aiRoutes = new Set(['/generate-qcm', '/generate-qcm-advanced', '/explain-answer']);

      if (aiRoutes.has(pathname)) {
        const access = await checkAiAccess(request);
        if (!access.allowed) {
          return json({ error: access.reason || 'Accès IA restreint' }, 403);
        }
      }

      if (pathname === '/generate-qcm') {
        return handleGemini(request, env);
      }
      if (pathname === '/generate-qcm-advanced') {
        return handleGeminiAdvanced(request, env);
      }
      if (pathname === '/explain-answer') {
        return handleExplainAnswer(request, env);
      }
      if (pathname === '/use-shared-key') {
        return handleUseSharedKey(request, env);
      }
      // Pas de gate checkAiAccess ici : un invité (sans session Firebase) doit
      // pouvoir signaler un bug lui aussi.
      if (pathname === '/report-bug') {
        return handleReportBug(request, env);
      }
      return json({ error: 'Not found' }, 404);
    }

    // ── GET routes (Giphy) ────────────────────────────────────────────────────
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const apiKey = env.GIPHY_API_KEY;
    if (!apiKey) {
      return json({ error: 'Missing GIPHY_API_KEY secret' }, 500);
    }

    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 18)));
    const rating = 'pg-13';

    let upstream;
    if (pathname === '/search') {
      const q = (url.searchParams.get('q') || '').trim();
      upstream = new URL('https://api.giphy.com/v1/gifs/search');
      upstream.searchParams.set('api_key', apiKey);
      upstream.searchParams.set('q', q);
      upstream.searchParams.set('limit', String(limit));
      upstream.searchParams.set('rating', rating);
    } else if (pathname === '/trending') {
      upstream = new URL('https://api.giphy.com/v1/gifs/trending');
      upstream.searchParams.set('api_key', apiKey);
      upstream.searchParams.set('limit', String(limit));
      upstream.searchParams.set('rating', rating);
    } else {
      return json({ error: 'Not found' }, 404);
    }

    try {
      const res = await fetch(upstream.toString(), {
        headers: { 'Accept': 'application/json' }
      });

      const data = await res.text();
      return new Response(data, {
        status: res.status,
        headers: {
          ...corsHeaders(),
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=60'
        }
      });
    } catch (err) {
      return json({ error: 'Upstream error' }, 502);
    }
  }
};

// ── GEMINI QCM GENERATION ─────────────────────────────────────────────────────
async function handleGemini(request, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: 'Missing GEMINI_API_KEY secret' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const prompt = String(body.prompt || '').trim().slice(0, 500);
  const count  = Math.min(20, Math.max(3, parseInt(body.count) || 10));
  const requestedLanguage = String(body.language || 'fr').toLowerCase();
  const languageName = QCM_LANGUAGE_NAMES[requestedLanguage] || QCM_LANGUAGE_NAMES.fr;

  if (prompt.length < 3) return json({ error: 'Prompt trop court (min 3 caractères)' }, 400);

  const systemPrompt =
    `Tu es un expert en création de QCM pédagogiques. Génère exactement ${count} questions de QCM sur le sujet suivant : "${prompt}".\n\n` +
    `CONTRAINTES STRICTES :\n` +
    `- Écris INTÉGRALEMENT en ${languageName} : les questions, les options de réponse, les catégories et les explications. N'utilise aucune autre langue, sauf pour les termes techniques qui n'ont pas de traduction standard.\n` +
    `- Réponds UNIQUEMENT avec un tableau JSON valide, sans aucun texte avant ou après, sans balises markdown\n` +
    `- Si le sujet contient des maths/physique/quantique, utilise du LaTeX standard dans q/opts/exp avec des délimiteurs $...$ (ou $$...$$)\n` +
    `- Dans le JSON, échappe les antislashs LaTeX correctement (ex: \\\\alpha, \\\\frac{1}{2}, |0\\\\rangle, \\\\langle\\\\psi|)\n` +
    `- N'utilise jamais des approximations comme |0angle, sigma x sans backslash, ou des symboles cassés\n` +
    `- Chaque question doit avoir exactement 4 options de réponse\n` +
    `- L'index de la bonne réponse (ans) est 0-indexé (0, 1, 2 ou 3)\n` +
    `- Les questions doivent être variées, précises et pédagogiques\n` +
    `- L'explication doit être concise (1-2 phrases max)\n\n` +
    `FORMAT JSON EXACT :\n` +
    `[{"cat":"Nom catégorie","q":"Texte de la question ?","opts":["Option A","Option B","Option C","Option D"],"ans":0,"exp":"Explication courte."}]`;

  let lastStatus = 0;
  let lastErrText = '';

  try {
    for (const model of GEMINI_MODELS) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: systemPrompt }] }],
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 3072,
                responseMimeType: 'application/json'
              }
            })
          }
        );

        if (!res.ok) {
          lastStatus = res.status;
          lastErrText = await res.text().catch(() => '');
          console.error('Gemini API error:', model, res.status, lastErrText);

          if (res.status === 429 || res.status >= 500) {
            if (attempt < 2) {
              await sleep(500 * (attempt + 1));
              continue;
            }
            break; // try next model
          }

          if (res.status === 404) {
            break; // model not found, try next model
          }

          return json({ error: `Gemini API error ${res.status}` }, 502);
        }

        const data = await res.json();
        const text = extractGeminiText(data);
        const jsonText = extractJsonArray(text);
        if (!jsonText) {
          console.error('Gemini returned non-JSON content:', model, text.slice(0, 500));
          if (attempt < 2) {
            await sleep(350 * (attempt + 1));
            continue;
          }
          break;
        }

        let questions;
        try {
          questions = JSON.parse(jsonText);
        } catch {
          const repaired = repairJsonArray(jsonText);
          try {
            questions = JSON.parse(repaired);
          } catch {
            console.error('Gemini JSON parse failed:', model, jsonText.slice(0, 500));
            if (attempt < 2) {
              await sleep(350 * (attempt + 1));
              continue;
            }
            break;
          }
        }

        if (!Array.isArray(questions)) {
          if (attempt < 2) {
            await sleep(350 * (attempt + 1));
            continue;
          }
          break;
        }

        const valid = questions
          .filter(q =>
            q &&
            typeof q.cat === 'string' &&
            typeof q.q === 'string' &&
            Array.isArray(q.opts) && q.opts.length === 4 &&
            q.opts.every(o => typeof o === 'string') &&
            typeof q.ans === 'number' && q.ans >= 0 && q.ans <= 3
          )
          .map(q => ({
            cat: String(q.cat).slice(0, 80),
            q: String(q.q).slice(0, 300),
            opts: q.opts.map(o => String(o).slice(0, 200)),
            ans: q.ans,
            exp: String(q.exp || '').slice(0, 400)
          }));

        if (valid.length === 0) {
          if (attempt < 2) {
            await sleep(350 * (attempt + 1));
            continue;
          }
          break;
        }

        return json({ questions: valid });
      }
    }

    if (lastStatus === 429) {
      return json({ error: 'Quota Gemini atteint (429). Réessaie dans quelques minutes ou réduit le nombre de questions.' }, 429);
    }

    if (lastStatus) {
      return json({ error: `Gemini API error ${lastStatus}` }, 502);
    }

    return json({ error: 'Impossible de générer le QCM' }, 502);
  } catch (err) {
    console.error('Gemini handler error:', err);
    return json({ error: 'Erreur serveur' }, 502);
  }
}

// ── GEMINI QCM GENERATION (PROMPT PRÉ-CONSTRUIT CÔTÉ CLIENT) ─────────────────
// Utilisé par le générateur "PDF → QCM" : le client construit lui-même le prompt
// système complet (règles LaTeX, format JSON, instructions utilisateur, texte
// source extrait des PDF...) et l'envoie tel quel, sans re-wrapping côté worker.
async function handleGeminiAdvanced(request, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: 'Missing GEMINI_API_KEY secret' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const systemPrompt = String(body.systemPrompt || '').trim().slice(0, 400000);
  const maxOutputTokens = Math.min(8192, Math.max(512, parseInt(body.maxOutputTokens) || 4096));
  const pdfParts = sanitizePdfParts(body.pdfParts);

  if (systemPrompt.length < 20) return json({ error: 'Prompt système trop court' }, 400);

  // Les PDF joints passent en inline_data AVANT le texte : Gemini les lit
  // nativement (voir js/ai/qcmFromPdf.js — option "envoyer le PDF directement").
  const parts = [
    ...pdfParts.map(p => ({ inline_data: { mime_type: p.mimeType, data: p.data } })),
    { text: systemPrompt }
  ];

  let lastStatus = 0;

  try {
    for (const model of GEMINI_MODELS) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts }],
              generationConfig: {
                temperature: 0.3,
                maxOutputTokens,
                responseMimeType: 'application/json'
              }
            })
          }
        );

        if (!res.ok) {
          lastStatus = res.status;
          const errText = await res.text().catch(() => '');
          console.error('Gemini advanced API error:', model, res.status, errText);

          if (res.status === 429 || res.status >= 500) {
            if (attempt < 2) { await sleep(500 * (attempt + 1)); continue; }
            break;
          }
          if (res.status === 404) break;
          return json({ error: `Gemini API error ${res.status}` }, 502);
        }

        const data = await res.json();
        const text = extractGeminiText(data);
        const jsonText = extractJsonObject(text);
        if (!jsonText) {
          console.error('Gemini advanced returned non-JSON content:', model, text.slice(0, 500));
          if (attempt < 2) { await sleep(350 * (attempt + 1)); continue; }
          break;
        }

        let parsed;
        try {
          parsed = JSON.parse(jsonText);
        } catch {
          try {
            parsed = JSON.parse(repairJsonArray(jsonText));
          } catch {
            console.error('Gemini advanced JSON parse failed:', model, jsonText.slice(0, 500));
            if (attempt < 2) { await sleep(350 * (attempt + 1)); continue; }
            break;
          }
        }

        const list = Array.isArray(parsed) ? parsed : parsed?.questions;
        if (!Array.isArray(list)) {
          if (attempt < 2) { await sleep(350 * (attempt + 1)); continue; }
          break;
        }

        const valid = list.map(validateAndNormalizeQuestion).filter(Boolean);

        if (valid.length === 0) {
          if (attempt < 2) { await sleep(350 * (attempt + 1)); continue; }
          break;
        }

        return json({ questions: valid });
      }
    }

    if (lastStatus === 429) {
      return json({ error: 'Quota Gemini atteint (429). Réessaie dans quelques minutes ou réduit le nombre de questions.' }, 429);
    }
    if (lastStatus) {
      return json({ error: `Gemini API error ${lastStatus}` }, 502);
    }
    return json({ error: 'Impossible de générer le QCM' }, 502);
  } catch (err) {
    console.error('Gemini advanced handler error:', err);
    return json({ error: 'Erreur serveur' }, 502);
  }
}

function validateAndNormalizeQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  if (typeof q.q !== 'string' || !q.q.trim()) return null;
  if (!Array.isArray(q.opts) || q.opts.length !== 4) return null;
  if (!q.opts.every(o => typeof o === 'string' && o.trim())) return null;

  const rawAns = Array.isArray(q.ans) ? q.ans : [q.ans];
  const indices = [...new Set(rawAns
    .map(v => parseInt(v, 10))
    .filter(v => Number.isInteger(v) && v >= 0 && v < 4))]
    .sort((a, b) => a - b);
  if (indices.length === 0) return null;

  return {
    cat: String(q.cat || 'Général').slice(0, 80),
    q: String(q.q).slice(0, 500),
    opts: q.opts.map(o => String(o).slice(0, 300)),
    ans: indices.length === 1 ? indices[0] : indices,
    exp: String(q.exp || '').slice(0, 600)
  };
}

function extractJsonObject(text) {
  if (!text) return '';
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const start = cleaned.indexOf('{');
  if (start === -1) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < cleaned.length; index++) {
    const char = cleaned[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return cleaned.slice(start, index + 1);
    }
  }
  return '';
}

// ── GEMINI WRONG-ANSWER EXPLANATION ─────────────────────────────────────────
// NB: l'authentification/autorisation (checkAiAccess) est déjà vérifiée par le
// routeur avant d'appeler ce handler — voir la définition de `aiRoutes` plus haut.
async function handleExplainAnswer(request, env) {
  const chatKey = String(env.GEMINI_CHAT_KEY || '').trim();
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  const keyCandidates = [];
  if (chatKey) keyCandidates.push({ label: 'GEMINI_CHAT_KEY', key: chatKey });
  if (apiKey && apiKey !== chatKey) keyCandidates.push({ label: 'GEMINI_API_KEY', key: apiKey });
  if (!keyCandidates.length) {
    return json({ error: 'Missing GEMINI_CHAT_KEY / GEMINI_API_KEY secret' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const question = String(body.question || '').trim().slice(0, 700);
  const options = Array.isArray(body.options)
    ? body.options.slice(0, 4).map(o => String(o || '').slice(0, 220))
    : [];
  const correctIndex = Number(body.correctIndex);
  const selectedIndex = Number(body.selectedIndex);
  const officialExplanation = String(body.officialExplanation || '').trim().slice(0, 500);
  const requestedLanguage = String(body.language || 'fr').toLowerCase();
  const language = ['fr', 'en', 'zh'].includes(requestedLanguage) ? requestedLanguage : 'fr';

  if (!question || options.length !== 4) {
    return json({ error: 'Question/options invalides' }, 400);
  }
  if (![0, 1, 2, 3].includes(correctIndex)) {
    return json({ error: 'correctIndex invalide' }, 400);
  }

  const letters = ['A', 'B', 'C', 'D'];
  const selectedLabel = [0, 1, 2, 3].includes(selectedIndex)
    ? `${letters[selectedIndex]}: ${options[selectedIndex]}`
    : (
      language === 'en'
        ? 'No answer (timeout)'
        : language === 'zh'
          ? '未作答（时间到）'
          : 'Aucune réponse (temps écoulé)'
    );
  const correctLabel = `${letters[correctIndex]}: ${options[correctIndex]}`;

  const maxChars = 1800;

  const prompt = language === 'en'
    ? (
      `You are a pedagogical AI tutor. Explain clearly and kindly why the player's answer is wrong.
You MUST answer ONLY in English. Do not use French or Chinese.
Return plain text only (no markdown), 4 to 8 short sentences, and keep the total response under ${maxChars} characters.

Question: ${question}
Options:
- A: ${options[0]}
- B: ${options[1]}
- C: ${options[2]}
- D: ${options[3]}

Player answer: ${selectedLabel}
Correct answer: ${correctLabel}
${officialExplanation ? `Official explanation: ${officialExplanation}` : ''}

Rules:
- Be concise and concrete.
- Explain why the player answer is incorrect.
- Explain why the correct answer is correct.
- If you write formulas, use standard LaTeX with $...$ delimiters (example: $P(0)=|\\alpha|^2$).
- Use proper commands (\\alpha, \\beta, \\langle, \\rangle, \\frac, \\sqrt, \\sigma_x), never broken text like |0angle.
- End with one practical memory tip.
- Strictly respect the ${maxChars}-character maximum.`
    )
    : language === 'zh'
      ? (
  `你是一位友善的教学辅导 AI。请清晰说明为什么玩家的答案是错的。
你必须只使用中文（简体中文）回答，不得使用法语或英语。
仅使用纯文本回复（不要 Markdown），4 到 8 句短句，总长度不超过 ${maxChars} 个字符。

题目：${question}
选项：
- A：${options[0]}
- B：${options[1]}
- C：${options[2]}
- D：${options[3]}

玩家答案：${selectedLabel}
正确答案：${correctLabel}
${officialExplanation ? `官方解析：${officialExplanation}` : ''}

规则：
- 简洁、具体。
- 说明玩家答案为什么错。
- 说明正确答案为什么对。
- 如果写公式，请使用标准 LaTeX 并用 $...$ 包裹（例如：$P(0)=|\\alpha|^2$）。
- 使用规范命令（\\alpha, \\beta, \\langle, \\rangle, \\frac, \\sqrt, \\sigma_x），不要写成 |0angle 这类损坏形式。
- 最后给出 1 条实用记忆技巧。
- 严格遵守不超过 ${maxChars} 个字符。`
      )
    : (
  `Tu es un coach pédagogique bienveillant. Explique clairement pourquoi la réponse du joueur est fausse.
Tu dois répondre UNIQUEMENT en français. N'utilise ni anglais ni chinois.
Réponds en texte brut uniquement (pas de markdown), 4 à 8 phrases courtes, et garde la réponse sous ${maxChars} caractères.

Question : ${question}
Options :
- A : ${options[0]}
- B : ${options[1]}
- C : ${options[2]}
- D : ${options[3]}

Réponse du joueur : ${selectedLabel}
Bonne réponse : ${correctLabel}
${officialExplanation ? `Explication officielle : ${officialExplanation}` : ''}

Règles :
- Sois concis et concret.
- Explique pourquoi la réponse du joueur est incorrecte.
- Explique pourquoi la bonne réponse est la bonne.
- Si tu écris des formules, utilise du LaTeX standard avec délimiteurs $...$ (ex: $P(0)=|\\alpha|^2$).
- Utilise les commandes correctes (\\alpha, \\beta, \\langle, \\rangle, \\frac, \\sqrt, \\sigma_x), jamais des formes cassées comme |0angle.
- Termine par une astuce mémo en 1 ligne.
- Respecte strictement la limite de ${maxChars} caractères.`
    );

  let lastStatus = 0;
  let lastKeyLabel = '';
  try {
    // Modèle en boucle externe, clé en boucle interne : si GEMINI_CHAT_KEY est
    // cassée/à quota, on bascule sur GEMINI_API_KEY dès le premier modèle au
    // lieu d'épuiser les 7 modèles sur la clé morte avant de se rabattre
    // (ça pouvait faire traîner une requête ~20s et déclencher un 502 côté
    // plateforme avant même d'atteindre la clé qui marche).
    for (const model of GEMINI_MODELS) {
      for (const keyEntry of keyCandidates) {
        let res;
        try {
          res = await fetchWithTimeout(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keyEntry.key}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                  temperature: 0.7,
                  maxOutputTokens: 1600
                }
              })
            },
            10000
          );
        } catch (fetchErr) {
          lastStatus = 0;
          lastKeyLabel = keyEntry.label;
          continue;
        }

        if (!res.ok) {
          lastStatus = res.status;
          lastKeyLabel = keyEntry.label;
          continue;
        }

        const data = await res.json();
        const explanation = extractGeminiText(data).slice(0, 2200);
        if (!explanation) continue;

        return json({ explanation, keySource: keyEntry.label });
      }
    }

    if (lastStatus === 429) {
      return json({ error: 'Quota Gemini atteint (429)' }, 429);
    }

    if (lastStatus) {
      return json({ error: `Gemini API error ${lastStatus}${lastKeyLabel ? ` (${lastKeyLabel})` : ''}` }, 502);
    }

    return json({ error: 'Impossible de générer une explication IA' }, 502);
  } catch (err) {
    console.error('Gemini explain handler error:', err);
    return json({ error: 'Erreur serveur' }, 502);
  }
}

// ── SIGNALEMENT DE BUG (best-effort, jamais bloquant) ─────────────────────────
// Le rapport est de toute façon déjà écrit dans Firestore (bugReports/{id})
// côté client avant cet appel — cette route ne fait qu'ENVOYER UN EMAIL en
// plus, via Resend. Si RESEND_API_KEY n'est pas configuré (ex: template
// QCM Studio pas encore mis en place), on répond juste { ok: true, skipped }
// plutôt que de faire planter quoi que ce soit côté client.
async function handleReportBug(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const message = String(body.message || '').trim().slice(0, 2000);
  if (message.length < 3) {
    return json({ error: 'Message trop court' }, 400);
  }
  const username = String(body.username || 'anonyme').trim().slice(0, 40);
  const page = String(body.page || '').trim().slice(0, 100);
  const userAgent = String(body.userAgent || '').trim().slice(0, 300);
  const appBuild = String(body.appBuild || '').trim().slice(0, 40);
  const pageUrl = String(body.url || '').trim().slice(0, 300);

  const resendKey = String(env.RESEND_API_KEY || '').trim();
  if (!resendKey) {
    return json({ ok: true, skipped: true });
  }

  const escapeHtml = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  try {
    const res = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        from: 'QCM Bug Reports <onboarding@resend.dev>',
        to: [BUG_REPORT_EMAIL],
        subject: `🐛 Nouveau rapport de bug — ${username}`,
        html:
          `<p><strong>De :</strong> ${escapeHtml(username)}</p>` +
          `<p><strong>Page :</strong> ${escapeHtml(page)}</p>` +
          `<p><strong>Build :</strong> ${escapeHtml(appBuild)}</p>` +
          `<p><strong>URL :</strong> ${escapeHtml(pageUrl)}</p>` +
          `<p><strong>Navigateur :</strong> ${escapeHtml(userAgent)}</p>` +
          `<hr><p style="white-space:pre-wrap">${escapeHtml(message)}</p>`
      })
    }, 8000);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('Resend error:', res.status, errText);
      // On ne fait pas échouer la requête pour l'utilisateur — le rapport est
      // déjà sauvegardé côté Firestore, seul l'email de notif a raté.
      return json({ ok: true, emailFailed: true });
    }
    return json({ ok: true });
  } catch (err) {
    console.error('Bug report email error:', err);
    return json({ ok: true, emailFailed: true });
  }
}

// ── ACCÈS IA (admin + allowlist) ──────────────────────────────────────────────
// Vérifie que l'appelant est authentifié ET autorisé (admin ou allowlist),
// pour de vrai — pas juste "un Authorization: Bearer ... existe".
//
// Comment ça marche sans implémenter nous-mêmes la vérif de signature JWT :
// on relit le doc Firestore users/{uid} et config/aiAccess en réutilisant
// LE MÊME token que l'appelant nous a envoyé comme identifiant Firestore.
// Firestore vérifie lui-même l'authenticité du token pour évaluer ses propres
// règles de sécurité (users/{uid}: request.auth.uid == uid) — si le token est
// invalide, expiré, ou ne correspond pas au uid réclamé, la lecture échoue et
// on refuse l'accès. On ne fait JAMAIS confiance au contenu du JWT tant que
// Firestore n'a pas confirmé qu'il est valide via cette lecture.
function decodeJwtPayloadUnsafe(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function firestoreStringField(doc, name) {
  return doc?.fields?.[name]?.stringValue || null;
}

function firestoreStringArrayField(doc, name) {
  const values = doc?.fields?.[name]?.arrayValue?.values;
  if (!Array.isArray(values)) return [];
  return values.map(v => v.stringValue).filter(v => typeof v === 'string');
}

async function fetchFirestoreDoc(path, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }, 8000);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function checkAiAccess(request) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { allowed: false, reason: 'Non authentifié.' };
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return { allowed: false, reason: 'Non authentifié.' };

  const payload = decodeJwtPayloadUnsafe(token);
  const uid = payload?.user_id || payload?.sub;
  if (!uid) return { allowed: false, reason: 'Token invalide.' };

  const userDoc = await fetchFirestoreDoc(`users/${uid}`, token);
  if (!userDoc) return { allowed: false, reason: 'Session invalide ou expirée — reconnecte-toi.' };

  const username = firestoreStringField(userDoc, 'username');
  if (!username) return { allowed: false, reason: 'Profil introuvable.' };

  if (username === AI_ADMIN_USERNAME) {
    return { allowed: true, username };
  }

  const accessDoc = await fetchFirestoreDoc('config/aiAccess', token);
  if (accessDoc?.fields?.openToAll?.booleanValue === true) {
    return { allowed: true, username };
  }

  const allowedUsers = firestoreStringArrayField(accessDoc, 'allowedUsers');
  if (allowedUsers.includes(username)) {
    return { allowed: true, username };
  }

  return {
    allowed: false,
    username,
    reason: "Accès IA restreint — demande à l'admin de t'ajouter à la liste autorisée."
  };
}

// Comme checkAiAccess, mais SANS le gate admin/allowlist — prouve juste que
// l'appelant est un compte réel (signature du token vérifiée par Firestore en
// relisant son propre profil). C'est volontaire : le partage de clé sert
// justement à donner l'accès IA à des comptes qui NE SONT PAS sur l'allowlist
// admin — sinon le partage ne servirait à rien.
async function resolveSignedInUsername(request) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;

  const payload = decodeJwtPayloadUnsafe(token);
  const uid = payload?.user_id || payload?.sub;
  if (!uid) return null;

  const userDoc = await fetchFirestoreDoc(`users/${uid}`, token);
  if (!userDoc) return null;
  const username = firestoreStringField(userDoc, 'username');
  if (!username) return null;

  return { uid, username, token };
}

// ── PARTAGE DE CLÉ (jamais révélée en clair à l'emprunteur) ──────────────────
// La clé partagée est chiffrée (RSA-OAEP) avec une clé PUBLIQUE côté client
// (js/ai/sharedKeyVault.js) ; seule la clé PRIVÉE correspondante (ce secret)
// permet de la déchiffrer. Ce Worker est donc le SEUL endroit capable de la
// lire, et seulement pour faire l'appel IA lui-même — jamais pour la renvoyer.
let cachedSharedVaultPrivateKey = null;
async function getSharedVaultPrivateKey(env) {
  if (cachedSharedVaultPrivateKey) return cachedSharedVaultPrivateKey;
  const jwkStr = env.SHARED_KEY_VAULT_PRIVATE_KEY;
  if (!jwkStr) throw new Error('Missing SHARED_KEY_VAULT_PRIVATE_KEY secret');
  const jwk = JSON.parse(jwkStr);
  cachedSharedVaultPrivateKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['decrypt']
  );
  return cachedSharedVaultPrivateKey;
}

async function decryptSharedKey(ciphertextB64, env) {
  const privateKey = await getSharedVaultPrivateKey(env);
  const ciphertext = Uint8Array.from(atob(ciphertextB64), c => c.charCodeAt(0));
  const plainBuf = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, ciphertext);
  return new TextDecoder().decode(plainBuf);
}

async function callGeminiServerSide(systemPrompt, maxTokens, apiKey, jsonMode, model, pdfParts) {
  const m = model || 'gemini-2.5-flash';
  const parts = [
    ...(pdfParts || []).map(p => ({ inline_data: { mime_type: p.mimeType, data: p.data } })),
    { text: systemPrompt }
  ];
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: maxTokens,
          ...(jsonMode ? { responseMimeType: 'application/json' } : {})
        }
      })
    },
    20000
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Erreur Gemini ${res.status}`);
  const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw new Error('Réponse Gemini vide');
  return text;
}

async function callClaudeServerSide(systemPrompt, maxTokens, apiKey, model, pdfParts) {
  const m = model || 'claude-opus-4-8';
  const content = pdfParts?.length
    ? [
        ...pdfParts.map(p => ({
          type: 'document',
          source: { type: 'base64', media_type: p.mimeType, data: p.data }
        })),
        { type: 'text', text: systemPrompt }
      ]
    : systemPrompt;
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: m, max_tokens: maxTokens, messages: [{ role: 'user', content }] })
  }, 20000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Erreur Claude ${res.status}`);
  const text = Array.isArray(data?.content) ? data.content.map(c => c.text || '').join('') : '';
  if (!text) throw new Error('Réponse Claude vide');
  return text;
}

// o1/o3/o4-mini et la famille gpt-5 : seuls modèles OpenAI connus qui exigent
// `max_completion_tokens` au lieu de `max_tokens` et rejettent toute
// `temperature` autre que la valeur par défaut. Volontairement conservateur
// pour ne pas se déclencher sur un modèle DeepSeek (même fonction, provider
// différent) ou un nom tiers qui contiendrait ces lettres par hasard.
function isOpenAiReasoningModel(model) {
  const m = String(model || '');
  return /gpt-5/i.test(m) || /(^|\/)(o1|o3|o4-mini)(-|$)/i.test(m);
}

async function callOpenAiCompatibleServerSide(systemPrompt, maxTokens, apiKey, baseUrl, defaultModel, jsonMode, model) {
  const m = model || defaultModel;
  const reasoning = isOpenAiReasoningModel(m);
  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: m,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: jsonMode ? 'Génère le QCM demandé, au format JSON strict précisé ci-dessus.' : 'Réponds à la consigne ci-dessus.' }
      ],
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(reasoning ? {} : { temperature: 0.3 }),
      ...(reasoning ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens })
    })
  }, 20000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || data?.error || `Erreur API ${res.status}`);
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Réponse API vide');
  return text;
}

async function callProviderServerSide(provider, systemPrompt, maxTokens, apiKey, jsonMode, model, pdfParts) {
  if (provider === 'gemini') return callGeminiServerSide(systemPrompt, maxTokens, apiKey, jsonMode, model, pdfParts);
  if (provider === 'claude') return callClaudeServerSide(systemPrompt, maxTokens, apiKey, model, pdfParts);
  if (provider === 'deepseek') return callOpenAiCompatibleServerSide(systemPrompt, maxTokens, apiKey, 'https://api.deepseek.com', 'deepseek-chat', jsonMode, model);
  if (provider === 'openai') return callOpenAiCompatibleServerSide(systemPrompt, maxTokens, apiKey, 'https://api.openai.com/v1', 'gpt-4o-mini', jsonMode, model);
  throw new Error('Fournisseur inconnu: ' + provider);
}

async function handleUseSharedKey(request, env) {
  const borrower = await resolveSignedInUsername(request);
  if (!borrower) {
    return json({ error: 'Non authentifié — reconnecte-toi.' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const ownerUid = String(body.ownerUid || '').trim();
  const provider = String(body.provider || '').trim();
  const model = String(body.model || '').trim() || undefined;
  const systemPrompt = String(body.systemPrompt || '');
  const maxTokens = Math.min(12000, Math.max(256, Number(body.maxTokens) || 4096));
  const jsonMode = body.jsonMode !== false;
  // PDF joints natifs : n'a de sens que pour gemini/claude (lecture native de
  // documents) — ignoré silencieusement pour les autres fournisseurs, voir
  // callProviderServerSide/callOpenAiCompatibleServerSide.
  const pdfParts = (provider === 'gemini' || provider === 'claude') ? sanitizePdfParts(body.pdfParts) : [];

  if (!ownerUid || !provider || !systemPrompt) {
    return json({ error: 'Requête invalide (ownerUid/provider/systemPrompt manquant).' }, 400);
  }

  const sharedDoc = await fetchFirestoreDoc(`sharedApiKeys/${ownerUid}`, borrower.token);
  const providerEntry = sharedDoc?.fields?.[provider]?.mapValue?.fields;
  const ciphertextB64 = providerEntry?.ciphertext?.stringValue;
  if (!ciphertextB64) {
    return json({ error: "Cette clé n'est plus partagée." }, 404);
  }

  const isPublic = providerEntry?.public?.booleanValue === true;
  const allowedUsernames = (providerEntry?.allowedUsernames?.arrayValue?.values || [])
    .map(v => v.stringValue).filter(v => typeof v === 'string');
  const isAllowed = isPublic || allowedUsernames.some(u => u.toLowerCase() === borrower.username.toLowerCase());
  if (!isAllowed) {
    return json({ error: "Cette clé n'est pas partagée avec toi." }, 403);
  }

  let apiKey;
  try {
    apiKey = await decryptSharedKey(ciphertextB64, env);
  } catch (e) {
    console.error('decryptSharedKey failed:', e?.message);
    return json({ error: 'Impossible de déchiffrer la clé partagée (configuration serveur).' }, 500);
  }

  try {
    const text = await callProviderServerSide(provider, systemPrompt, maxTokens, apiKey, jsonMode, model, pdfParts);
    return json({ text });
  } catch (e) {
    return json({ error: e?.message || 'Erreur du fournisseur IA' }, 502);
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

// Valide/borne les PDF joints envoyés par le client pour le mode "lecture native"
// (voir js/ai/qcmFromPdf.js) — limite le nombre de fichiers et la taille de
// chacun (base64) pour éviter qu'une requête abuse du Worker ou de l'API amont.
function sanitizePdfParts(raw) {
  if (!Array.isArray(raw)) return [];
  const MAX_PARTS = 5;
  const MAX_PART_BASE64_CHARS = 15 * 1024 * 1024; // ~15M chars base64 (~11MB de PDF)
  return raw
    .filter(p => p && typeof p.data === 'string' && p.data.length > 0 && p.data.length <= MAX_PART_BASE64_CHARS)
    .slice(0, MAX_PARTS)
    .map(p => ({
      mimeType: typeof p.mimeType === 'string' && p.mimeType ? p.mimeType : 'application/pdf',
      data: p.data
    }));
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizePath(pathname) {
  const cleaned = String(pathname || '/').replace(/\/+$|^$/g, '');
  return cleaned ? `/${cleaned.replace(/^\/+/, '')}` : '/';
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map(part => typeof part?.text === 'string' ? part.text : '')
    .join('')
    .trim();
}

function extractJsonArray(text) {
  if (!text) return '';

  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const start = cleaned.indexOf('[');
  if (start === -1) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < cleaned.length; index++) {
    const char = cleaned[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '[') depth++;
    if (char === ']') {
      depth--;
      if (depth === 0) return cleaned.slice(start, index + 1);
    }
  }

  return '';
}

function repairJsonArray(text) {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}
