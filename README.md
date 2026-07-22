# QCM Studio

*[Version française plus bas / French version below](#version-française)*

QCM Studio is a static, no-build web app for practicing multiple-choice quizzes (QCM), with an optional AI layer for generating new questions from a topic or a PDF, and a shared leaderboard backed by Firebase. It's built to run entirely on free infrastructure: GitHub Pages for hosting, Firebase Firestore for data, and a small Cloudflare Worker as a proxy for anything that needs a server-side API key.

This repository is a template. It has no build step, no bundler, and no framework — every file is loaded directly by the browser as an ES module. That keeps it simple to read and to adapt, but it also means every piece of configuration (Firebase project, Worker URL, admin account) lives in a small number of clearly marked places instead of environment variables. The sections below walk through all of them.

## What's inside

```text
├── index.html                    # Entry point, boots the app
├── css/
│   └── style.css
├── js/
│   ├── config/
│   │   ├── site.config.js        # Your Firebase config, Worker URL, admin username
│   │   └── site.config.example.js
│   ├── core/                     # Bootstrap, shared state, quiz registry, scoring
│   ├── auth/                     # Login/signup, AI-access allowlist
│   ├── data-access/              # Everything that talks to Firestore, presence, rooms, chat
│   ├── ai/                       # AI providers, personal API key vault, key sharing, QCM generation
│   └── ui/                       # Home screen, quiz engine, leaderboard, custom-QCM picker
├── data/                         # Quiz content, one file per subject
├── proxy/
│   └── cloudflare-giphy-worker.js  # The Worker: GIFs, AI generation, shared-key proxy
├── scripts/
│   └── generate-shared-key-pair.mjs
├── firestore.rules
├── wrangler.toml
└── .github/workflows/            # GitHub Actions: deploy Pages + deploy the Worker
```

## Requirements

- A GitHub account (for Pages hosting and Actions)
- A Firebase project (free tier is enough — Firestore only, no other services needed)
- A Cloudflare account (free tier — the Worker is small and stays well within the free limits)
- Optionally, API keys for whichever AI providers you want to enable (Gemini has a generous free tier)

Nothing here requires Node, npm, or a build tool to run the site itself. `scripts/generate-shared-key-pair.mjs` and the GitHub Actions workflows are the only places Node gets used, and only for setup/deploy tasks.

## Quick start

1. Fork or clone this repository.
2. Create a Firebase project and a Cloudflare Worker (see the two sections below).
3. Fill in `js/config/site.config.js` with your own values.
4. Deploy `firestore.rules` to your Firebase project, after editing the admin email in it.
5. Push to GitHub — the included workflow deploys the site to GitHub Pages and the Worker to Cloudflare automatically.

## Setting up Firebase

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a project (analytics are optional, you don't need them).
2. In the left menu, open **Firestore Database** and create a database in **production mode**. Any region works; pick one close to your users.
3. In **Project settings → Your apps**, register a new **Web app** and copy the config object it gives you (`apiKey`, `authDomain`, `projectId`, etc.). This is not a secret — it identifies which project to talk to, and access control is entirely handled by `firestore.rules`, not by hiding this object.
4. Copy `js/config/site.config.example.js` to `js/config/site.config.js` and paste your Firebase config into the `firebase` field:

```js
window.__SITE_CONFIG = {
  firebase: {
    apiKey: "AIzaSy...",
    authDomain: "your-project.firebaseapp.com",
    projectId: "your-project",
    storageBucket: "your-project.firebasestorage.app",
    messagingSenderId: "123456789",
    appId: "1:123:web:abc"
  },
  workerUrl: "https://your-worker.workers.dev",
  adminUsername: "YourUsername"
};
```

5. Deploy `firestore.rules` to your project. Before you do, open the file and change the admin email in `isAdmin()`:

```js
function isAdmin() {
  return isSignedIn() && request.auth.token.email == 'youradmin@qcm.local';
}
```

Accounts in this app authenticate through Firebase Auth using a synthetic email built from the username (`username.toLowerCase() + "@qcm.local"`), so if your admin account's username is `Alice`, the email to put here is `alice@qcm.local`. Firestore rules are a separate deployable artifact from the rest of the app — they can't read `site.config.js` — so this value has to be kept in sync by hand with the `adminUsername` in your config and the `ADMIN_USERNAME` Worker variable below.

Deploy with the Firebase CLI:

```bash
npm install -g firebase-tools
firebase login
cp .firebaserc.example .firebaserc   # then edit the project id inside
firebase deploy --only firestore:rules
```

## Setting up the Cloudflare Worker

The Worker in `proxy/cloudflare-giphy-worker.js` handles anything that needs a server-side secret: fetching GIFs, calling Gemini to generate quizzes, and decrypting API keys that users choose to share with each other.

1. Install Wrangler and log in:

```bash
npm install -g wrangler
wrangler login
```

2. Edit `wrangler.toml`: give the Worker a name, and fill in `FIREBASE_PROJECT_ID` and `ADMIN_USERNAME` under `[vars]` (same admin username as in `site.config.js`, same project id as your Firebase project).

3. Generate a keypair for the shared-API-key feature:

```bash
node scripts/generate-shared-key-pair.mjs
```

Paste the printed public key into `SHARING_PUBLIC_KEY_JWK` in `js/ai/sharedKeyVault.js`. Keep the private key aside — you'll set it as a secret in the next step, and nowhere else. If you don't plan to use the key-sharing feature you can skip this and leave the placeholder, but the feature will error out for anyone who tries to use it.

4. Set the Worker's secrets (each command will prompt for the value):

```bash
wrangler secret put GIPHY_API_KEY
wrangler secret put GEMINI_API_KEY
wrangler secret put GEMINI_CHAT_KEY
wrangler secret put SHARED_KEY_VAULT_PRIVATE_KEY
```

- `GIPHY_API_KEY` — free key from [developers.giphy.com](https://developers.giphy.com/), used for the GIF picker in chat.
- `GEMINI_API_KEY` — used for the built-in "create a QCM from a topic" feature, gated by the admin allowlist.
- `GEMINI_CHAT_KEY` — used for the "explain why this answer is wrong" AI coach.
- `SHARED_KEY_VAULT_PRIVATE_KEY` — the private half of the keypair from step 3, as a single-line JSON string.

5. Deploy:

```bash
wrangler deploy
```

Or push to GitHub — `.github/workflows/deploy-worker.yml` does this automatically on every push that touches `proxy/` or `wrangler.toml`, provided you've added the same secrets under **Settings → Secrets and variables → Actions** in your GitHub repository (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, plus the four Worker secrets above).

### Running the proxy on your own server instead of Cloudflare

The Worker is a single exported handler, `{ async fetch(request, env) { ... } }`, and doesn't use any Cloudflare-specific API beyond that shape and `crypto.subtle` (standard Web Crypto, available in Node, Deno, and Bun too). To run it elsewhere:

- Wrap it in whatever your platform expects for an HTTP handler (an Express/Fastify route, a Deno.serve callback, etc.), passing in a `request` and an `env`-shaped object with the same keys (`GIPHY_API_KEY`, `GEMINI_API_KEY`, `GEMINI_CHAT_KEY`, `SHARED_KEY_VAULT_PRIVATE_KEY`, `FIREBASE_PROJECT_ID`, `ADMIN_USERNAME`) sourced from your platform's own secret/env mechanism.
- All Firestore access happens through plain REST calls to `firestore.googleapis.com` with a bearer token forwarded from the client — nothing Cloudflare-specific there either.
- Point `workerUrl` in `site.config.js` at wherever you end up hosting it.

## Configuring your admin account

There's a single admin account, identified by username. Because the app spans three independently deployed pieces (the static site, Firestore rules, and the Worker), the username has to be set in three places and kept in sync by hand:

1. `adminUsername` in `js/config/site.config.js` — used client-side to show admin-only UI.
2. `isAdmin()`'s email check in `firestore.rules` — used to gate Firestore writes.
3. `ADMIN_USERNAME` under `[vars]` in `wrangler.toml` — used by the Worker to gate the built-in AI routes.

**Create the account first, then wire up the config.** Usernames aren't reserved — anyone who opens the deployed site can sign up with any username via the "Create account" tab. If you set `adminUsername` to a name nobody has registered yet, whoever signs up with it first becomes admin, not necessarily you. So:

1. Open the app (locally or once deployed) and sign up for an account using the exact username you want as admin.
2. Only then set that same username in the three places above, and (re)deploy `firestore.rules` and the Worker so the checks actually match.

The admin account has full access to AI features by default and can manage the allowlist for other accounts, moderate shared API keys, and edit any custom QCM.

## Adding and removing subjects

Subjects are the built-in quiz modules shipped with the app (as opposed to custom QCMs, which users create from the UI — see the next section). This repo ships with exactly one, `data/demo-teachers.js`, as a working example to copy from.

### Adding a subject

1. Create `data/yoursubject.js`, copying the shape of `data/demo-teachers.js` — an exported array of question objects:

```js
export const YOUR_SUBJECT_QUESTIONS = [
  {
    q:   "What does CSS stand for?",
    opts: ["Cascading Style Sheets", "Creative Style System", "Computer Styled Sections", "Colorful Style Sheets"],
    ans: 0,      // 0-based index of the correct option
    exp: "CSS stands for Cascading Style Sheets, used to style HTML documents."
  },
  // ...more questions
];
```

2. Open `js/core/subjects.js`, import it, and add an entry to the `SUBJECTS` array:

```js
import { YOUR_SUBJECT_QUESTIONS } from "../../data/yoursubject.js";

export const SUBJECTS = [
  // ...existing subjects...
  {
    id:          "yoursubject",       // unique, used internally — no spaces
    name:        "Your Subject",      // shown in the UI
    icon:        "📘",
    description: "A short description shown on the subject card.",
    tagClass:    "cyan",              // a color accent, see css/style.css for available classes
    latex:       false,               // set true to enable KaTeX rendering for this subject
    examDate:    null,                // "DD/MM/YYYY" or null — see below
    questions:   YOUR_SUBJECT_QUESTIONS,
    modes: [
      { label: "Quick quiz · 15 Q", count: 15, timed: false },
      { label: "Exam mode · all questions", count: YOUR_SUBJECT_QUESTIONS.length, timed: true },
      // "filter" restricts a mode to questions whose "cat" field matches — optional
      { label: "Just the basics · 5 Q", count: 5, timed: false, filter: "Basics" }
    ]
  },
];
```

That's the whole registration step — no other file needs to know about a new subject.

### Removing a subject

Delete its entry from the `SUBJECTS` array in `js/core/subjects.js` (and the corresponding `import` line at the top of the file). Delete `data/yoursubject.js` too if nothing else references it. There's no other place in the codebase that needs updating — subjects are only ever referenced through this one array.

### Exam dates and the calendar

Setting `examDate` (format `"DD/MM/YYYY"`) on a subject makes it show up in the home screen's exam calendar, and automatically moves it into the "Archives" section the day after that date (configurable per-subject; a subject with no exam date is never auto-archived). You can also archive a subject manually regardless of date by adding its `id` to the `ARCHIVED_SUBJECT_IDS` array at the bottom of `js/core/subjects.js`.

The calendar isn't limited to built-in subjects: any custom or AI-generated QCM (see the next section) that has an exam date set — from either the create or edit form — appears on the calendar too, for its owner and for anyone who can see it as a community QCM. Custom QCMs don't auto-archive the way built-in subjects do; they simply stay on the calendar until their owner removes the date or deletes the QCM.

LaTeX is supported in questions, options, and explanations via `$...$` and `$$...$$` delimiters (rendered with KaTeX), on both built-in subjects and custom QCMs. Inside `.js` files, escape backslashes as usual (`\\frac{1}{2}`, not `\frac{1}{2}`).

## AI-generated QCMs and the AI coach

Users can either rely on the admin's built-in AI access (gated by the allowlist and, optionally, an "open to everyone" toggle in the admin panel), or add their own API key for Claude, Gemini, DeepSeek, or OpenAI from the "My AI keys" panel — encrypted client-side with a key derived from their login password, never sent anywhere in plaintext. From there, they can also choose to share a key with a specific person or with everyone: the key is re-encrypted with the Worker's public RSA key before being shared, so it can only ever be *used* server-side, never read back in plaintext by anyone, including its own owner once shared.

## Local development

No build step, no dev server dependency — any static file server works:

```bash
python3 -m http.server 5500
# or: npx serve
```

Then open `http://localhost:5500`. Because ES modules require `http(s)://`, opening `index.html` directly as a `file://` URL will not work.

## License

Licensed under a [custom noncommercial license with an internal-use exception](LICENSE). In short:

- **Free to use and modify**, including keeping your own changes private — as long as it's for internal use within your own organization (e.g. a school running its own version for its own students).
- **No money can be made from it**: nobody may sell this project, monetize it, or charge for access to a modified version, without a separate agreement.
- **Distributing a modified version outside your organization** (giving it to another organization, hosting it for an external audience, publishing it, etc.) requires you to publish your source under the same license, no matter how small the changes.
- The original credit ("Based on QCM Studio, created by Antonin Rossin") must always be kept.
- For anything outside these terms (commercial use, paid custom work...): contact **[antoninrossinpro@gmail.com](mailto:antoninrossinpro@gmail.com)**.

---

## Version française

QCM Studio est une application web statique, sans étape de build, pour s'entraîner sur des QCM, avec une couche IA optionnelle pour générer des questions à partir d'un sujet ou d'un PDF, et un leaderboard partagé via Firebase. Elle est pensée pour tourner entièrement sur de l'infrastructure gratuite : GitHub Pages pour l'hébergement, Firebase Firestore pour les données, et un petit Worker Cloudflare comme proxy pour tout ce qui nécessite une clé API côté serveur.

Ce dépôt est un template. Il n'y a ni build, ni bundler, ni framework — chaque fichier est chargé directement par le navigateur comme module ES. Ça garde le code simple à lire et à adapter, mais ça veut aussi dire que chaque configuration (projet Firebase, URL du Worker, compte admin) vit dans un petit nombre d'endroits bien identifiés plutôt que dans des variables d'environnement. Les sections ci-dessous détaillent chacun de ces endroits.

## Ce que contient le dépôt

```text
├── index.html                    # Point d'entrée, démarre l'app
├── css/
│   └── style.css
├── js/
│   ├── config/
│   │   ├── site.config.js        # Ta config Firebase, l'URL du Worker, le pseudo admin
│   │   └── site.config.example.js
│   ├── core/                     # Bootstrap, état partagé, registre des sujets, scoring
│   ├── auth/                     # Connexion/inscription, allowlist d'accès IA
│   ├── data-access/               # Tout ce qui parle à Firestore, présence, salons, chat
│   ├── ai/                       # Fournisseurs IA, coffre de clés perso, partage de clés, génération de QCM
│   └── ui/                       # Accueil, moteur de quiz, leaderboard, picker de QCM perso
├── data/                         # Contenu des QCM, un fichier par sujet
├── proxy/
│   └── cloudflare-giphy-worker.js  # Le Worker : GIFs, génération IA, proxy de clé partagée
├── scripts/
│   └── generate-shared-key-pair.mjs
├── firestore.rules
├── wrangler.toml
└── .github/workflows/            # GitHub Actions : déploiement Pages + déploiement du Worker
```

## Prérequis

- Un compte GitHub (pour l'hébergement Pages et les Actions)
- Un projet Firebase (le plan gratuit suffit — Firestore uniquement, aucun autre service requis)
- Un compte Cloudflare (plan gratuit — le Worker est petit et reste largement dans les limites gratuites)
- Éventuellement, des clés API pour les fournisseurs IA que tu veux activer (Gemini a un plan gratuit généreux)

Rien ici ne nécessite Node, npm ou un outil de build pour faire tourner le site lui-même. `scripts/generate-shared-key-pair.mjs` et les workflows GitHub Actions sont les seuls endroits où Node est utilisé, uniquement pour la configuration et le déploiement.

## Démarrage rapide

1. Fork ou clone ce dépôt.
2. Crée un projet Firebase et un Worker Cloudflare (voir les deux sections ci-dessous).
3. Remplis `js/config/site.config.js` avec tes propres valeurs.
4. Déploie `firestore.rules` sur ton projet Firebase, après avoir modifié l'email admin dedans.
5. Pousse sur GitHub — le workflow inclus déploie automatiquement le site sur GitHub Pages et le Worker sur Cloudflare.

## Configurer Firebase

1. Va sur [console.firebase.google.com](https://console.firebase.google.com) et crée un projet (les analytics sont facultatifs).
2. Dans le menu de gauche, ouvre **Firestore Database** et crée une base en **mode production**. N'importe quelle région fonctionne ; choisis-en une proche de tes utilisateurs.
3. Dans **Paramètres du projet → Vos applications**, enregistre une nouvelle **application Web** et copie la config qu'elle te donne (`apiKey`, `authDomain`, `projectId`, etc.). Ce n'est pas un secret — elle identifie juste à quel projet parler, et le contrôle d'accès est entièrement géré par `firestore.rules`, pas en cachant cet objet.
4. Copie `js/config/site.config.example.js` vers `js/config/site.config.js` et colle ta config Firebase dans le champ `firebase` :

```js
window.__SITE_CONFIG = {
  firebase: {
    apiKey: "AIzaSy...",
    authDomain: "ton-projet.firebaseapp.com",
    projectId: "ton-projet",
    storageBucket: "ton-projet.firebasestorage.app",
    messagingSenderId: "123456789",
    appId: "1:123:web:abc"
  },
  workerUrl: "https://ton-worker.workers.dev",
  adminUsername: "TonPseudo"
};
```

5. Déploie `firestore.rules` sur ton projet. Avant ça, ouvre le fichier et change l'email admin dans `isAdmin()` :

```js
function isAdmin() {
  return isSignedIn() && request.auth.token.email == 'tonadmin@qcm.local';
}
```

Les comptes de l'app s'authentifient via Firebase Auth avec un email synthétique construit à partir du pseudo (`pseudo.toLowerCase() + "@qcm.local"`) — donc si le pseudo de ton compte admin est `Alice`, l'email à mettre ici est `alice@qcm.local`. Les règles Firestore sont déployées séparément du reste de l'app — elles ne peuvent pas lire `site.config.js` — donc cette valeur doit être tenue à jour manuellement, en cohérence avec `adminUsername` dans ta config et `ADMIN_USERNAME` côté Worker (voir plus bas).

Déploiement avec la CLI Firebase :

```bash
npm install -g firebase-tools
firebase login
cp .firebaserc.example .firebaserc   # puis édite l'id du projet dedans
firebase deploy --only firestore:rules
```

## Configurer le Worker Cloudflare

Le Worker dans `proxy/cloudflare-giphy-worker.js` gère tout ce qui nécessite un secret côté serveur : récupérer des GIFs, appeler Gemini pour générer des QCM, et déchiffrer les clés API que les utilisateurs choisissent de partager entre eux.

1. Installe Wrangler et connecte-toi :

```bash
npm install -g wrangler
wrangler login
```

2. Édite `wrangler.toml` : donne un nom au Worker, et remplis `FIREBASE_PROJECT_ID` et `ADMIN_USERNAME` dans `[vars]` (même pseudo admin que dans `site.config.js`, même id de projet que ton projet Firebase).

3. Génère une paire de clés pour la fonctionnalité de partage de clé API :

```bash
node scripts/generate-shared-key-pair.mjs
```

Colle la clé publique affichée dans `SHARING_PUBLIC_KEY_JWK` dans `js/ai/sharedKeyVault.js`. Garde la clé privée de côté — tu la définiras comme secret à l'étape suivante, et nulle part ailleurs. Si tu ne comptes pas utiliser le partage de clé, tu peux passer cette étape et laisser le placeholder, mais la fonctionnalité renverra une erreur pour quiconque essaie de l'utiliser.

4. Définis les secrets du Worker (chaque commande demandera la valeur) :

```bash
wrangler secret put GIPHY_API_KEY
wrangler secret put GEMINI_API_KEY
wrangler secret put GEMINI_CHAT_KEY
wrangler secret put SHARED_KEY_VAULT_PRIVATE_KEY
```

- `GIPHY_API_KEY` — clé gratuite sur [developers.giphy.com](https://developers.giphy.com/), utilisée pour le picker de GIFs dans le chat.
- `GEMINI_API_KEY` — utilisée pour la fonctionnalité intégrée "créer un QCM à partir d'un sujet", gérée par l'allowlist admin.
- `GEMINI_CHAT_KEY` — utilisée pour le coach IA "pourquoi cette réponse est fausse".
- `SHARED_KEY_VAULT_PRIVATE_KEY` — la moitié privée de la paire de clés de l'étape 3, en JSON sur une seule ligne.

5. Déploie :

```bash
wrangler deploy
```

Ou pousse sur GitHub — `.github/workflows/deploy-worker.yml` le fait automatiquement à chaque push touchant `proxy/` ou `wrangler.toml`, à condition d'avoir ajouté les mêmes secrets dans **Settings → Secrets and variables → Actions** de ton dépôt GitHub (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, plus les quatre secrets du Worker ci-dessus).

### Faire tourner le proxy sur ton propre serveur plutôt que Cloudflare

Le Worker est un unique handler exporté, `{ async fetch(request, env) { ... } }`, et n'utilise aucune API spécifique à Cloudflare au-delà de cette forme et de `crypto.subtle` (Web Crypto standard, disponible aussi dans Node, Deno et Bun). Pour le faire tourner ailleurs :

- Enveloppe-le dans ce qu'attend ta plateforme comme handler HTTP (une route Express/Fastify, un callback `Deno.serve`, etc.), en lui passant une `request` et un objet `env` avec les mêmes clés (`GIPHY_API_KEY`, `GEMINI_API_KEY`, `GEMINI_CHAT_KEY`, `SHARED_KEY_VAULT_PRIVATE_KEY`, `FIREBASE_PROJECT_ID`, `ADMIN_USERNAME`) issues du mécanisme de secrets/env de ta plateforme.
- Tout l'accès à Firestore passe par de simples appels REST à `firestore.googleapis.com` avec un jeton bearer transmis par le client — rien de spécifique à Cloudflare là non plus.
- Fais pointer `workerUrl` dans `site.config.js` vers l'endroit où tu l'héberges finalement.

## Configurer ton compte admin

Il y a un seul compte admin, identifié par son pseudo. Comme l'app est répartie sur trois éléments déployés indépendamment (le site statique, les règles Firestore, et le Worker), le pseudo doit être renseigné à trois endroits et tenu à jour manuellement :

1. `adminUsername` dans `js/config/site.config.js` — utilisé côté client pour afficher l'UI réservée à l'admin.
2. Le contrôle d'email dans `isAdmin()` de `firestore.rules` — utilisé pour restreindre les écritures Firestore.
3. `ADMIN_USERNAME` dans `[vars]` de `wrangler.toml` — utilisé par le Worker pour restreindre les routes IA intégrées.

**Crée d'abord le compte, configure ensuite.** Les pseudos ne sont pas réservés : n'importe qui peut s'inscrire avec n'importe quel pseudo via l'onglet "Créer un compte" une fois le site déployé. Si tu mets `adminUsername` sur un pseudo que personne n'a encore pris, la première personne à s'inscrire avec ce pseudo devient admin — pas forcément toi. Donc :

1. Ouvre l'app (en local ou une fois déployée) et inscris-toi avec exactement le pseudo que tu veux comme admin.
2. Seulement ensuite, renseigne ce même pseudo aux trois endroits ci-dessus, et redéploie `firestore.rules` et le Worker pour que les contrôles correspondent bien.

Le compte admin a accès par défaut à toutes les fonctionnalités IA, peut gérer l'allowlist des autres comptes, modérer les clés API partagées, et modifier n'importe quel QCM personnalisé.

## Ajouter et retirer des sujets

Les sujets sont les modules de quiz intégrés fournis avec l'app (à ne pas confondre avec les QCM personnalisés, que les utilisateurs créent depuis l'interface — voir la section suivante). Ce dépôt en fournit un seul, `data/demo-teachers.js`, comme exemple à copier.

### Ajouter un sujet

1. Crée `data/tonsujet.js` en copiant la forme de `data/demo-teachers.js` — un tableau exporté d'objets question :

```js
export const TON_SUJET_QUESTIONS = [
  {
    q:   "Que signifie CSS ?",
    opts: ["Cascading Style Sheets", "Creative Style System", "Computer Styled Sections", "Colorful Style Sheets"],
    ans: 0,      // index 0-indexé de la bonne réponse
    exp: "CSS signifie Cascading Style Sheets, utilisé pour styliser les documents HTML."
  },
  // ...d'autres questions
];
```

2. Ouvre `js/core/subjects.js`, importe-le, et ajoute une entrée dans le tableau `SUBJECTS` :

```js
import { TON_SUJET_QUESTIONS } from "../../data/tonsujet.js";

export const SUBJECTS = [
  // ...sujets existants...
  {
    id:          "tonsujet",           // unique, usage interne — pas d'espaces
    name:        "Ton Sujet",          // affiché dans l'UI
    icon:        "📘",
    description: "Une courte description affichée sur la carte du sujet.",
    tagClass:    "cyan",               // un accent de couleur, voir css/style.css pour les classes disponibles
    latex:       false,                // passe à true pour activer le rendu KaTeX sur ce sujet
    examDate:    null,                 // "DD/MM/YYYY" ou null — voir plus bas
    questions:   TON_SUJET_QUESTIONS,
    modes: [
      { label: "Quiz rapide · 15 Q", count: 15, timed: false },
      { label: "Examen · toutes les questions", count: TON_SUJET_QUESTIONS.length, timed: true },
      // "filter" restreint un mode aux questions dont le champ "cat" correspond — optionnel
      { label: "Les bases · 5 Q", count: 5, timed: false, filter: "Bases" }
    ]
  },
];
```

C'est toute l'étape d'enregistrement — aucun autre fichier n'a besoin de connaître le nouveau sujet.

### Retirer un sujet

Supprime son entrée dans le tableau `SUBJECTS` de `js/core/subjects.js` (et la ligne `import` correspondante en haut du fichier). Supprime aussi `data/tonsujet.js` si rien d'autre ne l'utilise. Il n'y a aucun autre endroit dans le code à mettre à jour — les sujets ne sont référencés que via ce tableau.

### Dates d'examen et calendrier

Renseigner `examDate` (format `"DD/MM/YYYY"`) sur un sujet le fait apparaître dans le calendrier d'examens de l'écran d'accueil, et le déplace automatiquement dans la section "Archives" le lendemain de cette date (un sujet sans date d'examen n'est jamais archivé automatiquement). Tu peux aussi archiver un sujet manuellement, indépendamment de la date, en ajoutant son `id` au tableau `ARCHIVED_SUBJECT_IDS` en bas de `js/core/subjects.js`.

Le calendrier ne se limite pas aux sujets intégrés : tout QCM personnalisé ou généré par IA (voir la section suivante) qui a une date d'examen renseignée — depuis le formulaire de création ou d'édition — apparaît aussi dans le calendrier, pour son propriétaire et pour quiconque peut le voir en tant que QCM communautaire. Les QCM personnalisés ne s'archivent pas automatiquement comme les sujets intégrés ; ils restent simplement dans le calendrier jusqu'à ce que leur propriétaire retire la date ou supprime le QCM.

Le LaTeX est supporté dans les questions, options et explications via les délimiteurs `$...$` et `$$...$$` (rendu avec KaTeX), aussi bien sur les sujets intégrés que sur les QCM personnalisés. Dans les fichiers `.js`, échappe les antislashs comme d'habitude (`\\frac{1}{2}`, pas `\frac{1}{2}`).

## QCM générés par IA et coach IA

Les utilisateurs peuvent soit s'appuyer sur l'accès IA intégré de l'admin (contrôlé par l'allowlist et, en option, un interrupteur "ouvert à tout le monde" dans le panneau admin), soit ajouter leur propre clé API pour Claude, Gemini, DeepSeek ou OpenAI depuis le panneau "Mes clés IA" — chiffrée côté client avec une clé dérivée de leur mot de passe de connexion, jamais envoyée en clair nulle part. À partir de là, ils peuvent aussi choisir de partager une clé avec une personne précise ou avec tout le monde : la clé est rechiffrée avec la clé publique RSA du Worker avant d'être partagée, donc elle ne peut plus jamais qu'être *utilisée* côté serveur, jamais relue en clair par qui que ce soit, pas même son propriétaire une fois partagée.

## Développement local

Pas de build, pas de dépendance à un serveur de dev particulier — n'importe quel serveur de fichiers statiques fonctionne :

```bash
python3 -m http.server 5500
# ou : npx serve
```

Puis ouvre `http://localhost:5500`. Comme les modules ES nécessitent `http(s)://`, ouvrir `index.html` directement en `file://` ne fonctionnera pas.

## Licence

Sous [licence maison, non commerciale, avec exception d'usage interne](LICENSE). En résumé :

- **Gratuit et libre à modifier**, y compris pour garder tes propres modifications privées — tant que c'est pour un usage interne à ta seule organisation (ex : ton établissement fait tourner sa propre version pour ses élèves).
- **Pas d'argent** : personne ne peut vendre ce projet ni le monétiser, ni facturer l'accès à une version modifiée, sans un accord séparé.
- **Diffuser une version modifiée à l'extérieur** de ton organisation (la donner à un autre établissement, l'héberger pour un public externe, la publier, etc.) t'oblige à publier ton code source sous la même licence, quelle que soit l'ampleur des changements.
- La mention d'origine ("Basé sur QCM Studio, créé par Antonin Rossin") doit toujours être conservée.
- Pour tout ce qui sort de ce cadre (usage commercial, adaptation payante sur mesure...) : contact à **[antoninrossinpro@gmail.com](mailto:antoninrossinpro@gmail.com)**.
