# 📚 Paper Deck

A low-friction paper-reading library that makes reading papers a fast daily habit.

- **Notion** is the source of truth for structured fields (title, tags, status, notes…).
- **Cloudflare R2** stores your PDF files.
- **One Cloudflare Worker** is the entire backend: it talks to Notion and R2, enriches
  arXiv links with metadata server-side, and serves everything with CORS so the app
  and a bookmarklet can call it.
- **The PWA** (this repo's `app/`) is the reader and annotator: card-based library,
  PDF.js reader with stylus highlighting/ink (stored locally in IndexedDB), and
  debounced autosave of notes back to Notion.

No login, no analytics, no secrets in the app. The Notion token lives only in the
Worker; the app stores just your Worker URL in localStorage.

```
paper-deck/
├── app/                  ← the PWA (static files, no build step)
│   ├── index.html
│   ├── app.js            ← React app (loaded as ES modules from esm.sh)
│   ├── styles.css
│   ├── sw.js             ← service worker (offline shell + share target)
│   ├── manifest.json
│   └── icons/
├── worker/
│   ├── worker.js         ← the Cloudflare Worker backend
│   └── wrangler.toml
└── README.md
```

---

## One-time setup

You need: a free Notion account, a free Cloudflare account, and Node.js on the
machine you deploy from.

### 1. Create the Notion database

Create a new **database** (full page) in Notion, e.g. "Paper Library", with **exactly**
these properties (names and types must match — the default "Name" title property
should be renamed to "Title"):

| Property name      | Type          |
| ------------------ | ------------- |
| Title              | Title         |
| Authors            | Text          |
| Venue              | Text          |
| Year               | Number        |
| Tags               | Multi-select  |
| Status             | Select        |
| arXiv Link         | URL           |
| PDF URL            | URL           |
| Notes              | Text          |
| Remarks            | Text          |
| Gaps               | Text          |
| Key Contribution   | Text          |
| Relevance          | Text          |
| Citation Key       | Text          |
| Rating             | Number        |

Add the four Status options: **To Read**, **Reading**, **Read**, **Revisit**.
Tags options are created automatically as you use them (the app ships with a starter
list: Agentic Systems, Memory, Software Engineering, Benchmarking, CloudOps,
Evaluation — plus a free-text add-tag input). `date_added` comes from Notion's
built-in created time; no property needed.

### Custom fields (no code changes needed)

Need an extra field for a specific reading pass — e.g. an extraction column
for a literature review? Just add a column in the Notion database UI, of
type **Text**, **Number**, **Checkbox**, **URL**, **Select**, or
**Multi-select**. It shows up automatically as an editable, autosaving
section in the Reader the next time you open a paper — nothing to configure,
nothing to redeploy. (Other Notion property types — Files, People, Date,
Formula, Relation — aren't supported and are silently ignored, since the app
wouldn't know how to write them back.)

### 2. Create a Notion integration and connect it

1. Go to <https://www.notion.so/my-integrations> → **New integration**.
   Give it a name (e.g. "Paper Deck"), pick your workspace, capabilities:
   Read + Insert + Update content.
2. Copy the **Internal Integration Secret** — this is your `NOTION_TOKEN`.
3. Open your database page in Notion → **⋯ menu → Connections → add your
   integration**. (Without this step the Worker gets a 404 from Notion.)

### 3. Find the database ID

Open the database **as a full page** in your browser. The URL looks like:

```
https://www.notion.so/yourname/25c1f0a884d9804a9e0bd6ae7dcbd28a?v=...
                              └────────── DATABASE_ID ──────────┘
```

The 32 hex characters before `?v=` are your `DATABASE_ID` (dashes optional).

### 4. Create the R2 bucket

In the Cloudflare dashboard → **R2** → **Create bucket**, name it
`paper-deck-pdfs` (or edit `bucket_name` in `wrangler.toml` to match yours).

**Public access (recommended):** open the bucket → **Settings** →
**Public access → r2.dev subdomain → Allow**. Copy the URL
(`https://pub-xxxxxxxx.r2.dev`) — this is `PUBLIC_R2_URL`.
Then, under the bucket's **CORS policy**, add:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["*"]
  }
]
```

(so the in-app PDF reader can fetch files cross-origin).

**Or skip public access:** leave `PUBLIC_R2_URL = ""` in `wrangler.toml` and
the Worker will serve PDFs itself at `/file/<key>` — slightly slower, zero extra
config.

### 5. Deploy the Worker

```bash
cd worker
npm install -g wrangler        # or use: npx wrangler ...
npx wrangler login             # opens the browser once

# edit wrangler.toml: paste your DATABASE_ID and PUBLIC_R2_URL

npx wrangler secret put NOTION_TOKEN     # paste the integration secret
npx wrangler deploy
```

The deploy prints your Worker URL, e.g.
`https://paper-deck-api.yourname.workers.dev`. Opening it should show
`{"ok":true,"service":"paper-deck"}`.

### 6. Host the app

The `app/` folder is plain static files — host it anywhere with HTTPS (required
for service workers and the share target). Easiest, staying inside Cloudflare:

```bash
npx wrangler pages deploy app --project-name paper-deck --branch production
```

This gives you `https://paper-deck.pages.dev`. (GitHub Pages, Netlify, etc.
work just as well.)

**`--branch production` is required**, not optional — Cloudflare Pages treats
only the project's designated production branch as "live" at the bare
`pages.dev` domain; any other branch name (including a git branch literally
called `main`) deploys to a separate preview URL instead
(`https://<hash>.paper-deck.pages.dev`) that the app never uses. Forgetting
this flag is the single most common cause of "I changed the code but the app
still looks old" — the Worker and the app are two separate deploys, and this
one silently lands on the wrong environment without it. Re-run this command
every time `app/` changes; it's a separate step from `npx wrangler deploy`
in `worker/`, which only updates the backend.

### 7. Connect the app

Open the app URL → **Settings** → paste your Worker URL → **Save** →
**Test connection**. That's the whole configuration; it's stored only on that
device, so repeat on each device you use.

### 8. Drag the bookmarklet to your laptop's bookmarks bar

In **Settings → Web Capture**, drag the **“📥 Save to Paper Deck”** link onto
your browser's bookmarks bar (View → Always Show Bookmarks Bar if hidden).
Clicking it on any paper page files the paper into Notion as **To Read** and
shows a small confirmation toast. On arXiv pages the Worker fetches title,
authors and year automatically — the paper arrives fully populated even if you
never open the app.

### 9. Install to your tablet's home screen

- **iPad (Safari):** open the app URL → Share button → **Add to Home Screen**.
  It launches full-screen and works offline for the app shell.
- **Android (Chrome):** open the app URL → you'll get an install prompt, or
  **⋮ menu → Add to Home screen / Install app**. Installing also registers
  Paper Deck in the system **share sheet**.

---

## Daily use

- **Library** — card grid of your papers; search by title/author/tag, filter by
  tag or status chips, sort by date added / rating / status. Auto-refreshes on
  launch, on focus, and every 5 minutes.
- **Reader** — tap a card. The PDF renders on the left with pen ✏️, highlighter 🖍
  and eraser (stylus draws, finger scrolls; toggle 👆 to draw with a finger).
  Ink is saved on-device in IndexedDB, keyed to the Notion page. Notes, remarks,
  gaps, key contribution, relevance, rating and status live on the right and
  autosave back to Notion as you type. The ⛶ button gives the PDF full width.
- **Add** — paste an arXiv URL/ID and hit **Auto-fill**, or **Import PDF** to
  upload a file to R2, then **Add to Notion**.

### Capture paths (lowest friction first)

1. **Phone share sheet (Android/Chrome):** share any arXiv page or a PDF file to
   *Paper Deck* — the Add view opens pre-filled (arXiv metadata fetched, PDFs
   uploaded to R2 automatically). ⚠️ iOS Safari doesn't support PWA share
   targets; on iPhone/iPad, copy the link and use the Add tab's paste field
   instead.
2. **Laptop bookmarklet:** one click on any page (see step 8).
3. **In-app paste:** the Add tab's "Add via link" field and "Import PDF" button
   always work everywhere.

---

## Notes & troubleshooting

- **"Notion 404" from the Worker** — you forgot to connect the integration to
  the database (step 2.3), or the `DATABASE_ID` is wrong.
- **New app features not showing up after a deploy** — two separate causes,
  check both: (1) you deployed the Worker (`worker/`) but not the app
  (`app/`), or vice versa — they're independent deploys, see step 5 and 6;
  (2) you deployed the app to a Pages *preview* URL instead of production
  because `--branch production` was left off (see step 6) — check
  `npx wrangler pages deployment list --project-name paper-deck` and confirm
  the latest deployment says `Production`, not `Preview`. Once production is
  right, the service worker still caches the app shell (stale-while-revalidate)
  — the very next load may serve the cached version while it fetches the new
  one in the background, so a **second** reload (or close/reopen the
  installed PWA) picks it up.
- **Bookmarklet says "Save failed (network)"** — this means the request never
  left the page. The usual cause: you're on a browser's *built-in PDF viewer*
  (e.g. Firefox opens `arxiv.org/pdf/...` links in an internal `resource://pdf.js`
  page with a `connect-src resource:` CSP that blocks every outbound request,
  bookmarklets included — this is a browser sandbox, not something the Worker
  or the bookmarklet can bypass). Fix: run the bookmarklet from the arXiv
  **abstract** page (`arxiv.org/abs/...`) instead of the raw PDF page. If it
  still fails there, open DevTools → Console right before clicking to see the
  real error, and check that Settings → the URL printed under the bookmarklet
  matches your deployed Worker URL exactly (re-save and re-drag if not — old
  bookmarklet copies keep whatever URL was baked in when you dragged them).
- **PDF won't render** — the PDF's host must allow cross-origin reads. R2 needs
  the CORS policy from step 4; for arXiv PDFs the app automatically falls back
  to the Worker's `/fetchpdf` proxy.
- **Rows without a PDF** are fine: the Reader shows an "Import PDF" button and
  everything else (notes, status, rating) works normally.
- **Annotations are per-device** by design — Notion holds metadata and the PDF
  link; the ink layer stays in the device's IndexedDB.
- **CORS is `*` on the Worker** so the bookmarklet works from any site. The
  Worker exposes only your paper database; if you want to lock it down, add a
  shared-secret header check in `worker.js` and the app/bookmarklet.
- The app pins its CDN dependencies (React 18.3.1, PDF.js 3.11.174) and the
  service worker caches them, so it keeps working offline after first load.

---

Built as a self-contained kit: zip this folder and send it to a friend — their
instance uses *their* Notion, *their* R2 and *their* Worker.
