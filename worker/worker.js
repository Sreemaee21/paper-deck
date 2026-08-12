/**
 * Paper Deck — Cloudflare Worker backend.
 *
 * The only backend for the Paper Deck PWA and bookmarklet.
 * Talks to Notion (source of truth for structured fields) and R2 (PDF files).
 *
 * Env:
 *   NOTION_TOKEN   (secret)  — Notion internal integration token
 *   DATABASE_ID    (var)     — Notion database id
 *   PUBLIC_R2_URL  (var)     — public base URL of the R2 bucket (r2.dev or custom
 *                              domain). Optional: if empty, uploads are served
 *                              through this Worker at GET /file/:key instead.
 *   PDFS           (binding) — R2 bucket
 *
 * Routes:
 *   GET    /papers        — all rows, mapped to the paper schema
 *   POST   /papers        — create row (server-side arXiv enrichment)
 *   PATCH  /papers/:id    — update fields on a row
 *   POST   /upload        — multipart PDF upload -> R2 -> { pdf_url }
 *   GET    /file/:key     — serve a PDF from R2 (CORS-safe fallback)
 *   GET    /fetchpdf?url= — proxy an arxiv.org PDF with CORS (for the reader)
 *   GET    /              — health check
 */

const NOTION_VERSION = '2022-06-28';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/' && request.method === 'GET') {
        return json({ ok: true, service: 'paper-deck' });
      }
      if (path === '/papers' && request.method === 'GET') {
        return await listPapers(env);
      }
      if (path === '/papers' && request.method === 'POST') {
        return await createPaper(env, await request.json());
      }
      const patch = path.match(/^\/papers\/([\w-]+)$/);
      if (patch && request.method === 'PATCH') {
        return await updatePaper(env, patch[1], await request.json());
      }
      if (path === '/upload' && request.method === 'POST') {
        return await uploadPdf(request, env, url.origin);
      }
      const file = path.match(/^\/file\/(.+)$/);
      if (file && request.method === 'GET') {
        return await serveFile(env, decodeURIComponent(file[1]));
      }
      if (path === '/fetchpdf' && request.method === 'GET') {
        return await proxyPdf(url.searchParams.get('url'), env);
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  },
};

/* ---------------------------------------------------------------- Notion */

async function notion(env, path, init = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Notion ${res.status}: ${body.message || 'unknown error'}`);
  }
  return body;
}

// Notion property name <-> app field name
const PROPS = {
  title: 'Title',
  authors: 'Authors',
  venue: 'Venue',
  year: 'Year',
  tags: 'Tags',
  status: 'Status',
  arxiv_link: 'arXiv Link',
  pdf_url: 'PDF URL',
  notes: 'Notes',
  remarks: 'Remarks',
  gaps: 'Gaps',
  key_contribution: 'Key Contribution',
  relevance: 'Relevance',
  citation_key: 'Citation Key',
  rating: 'Rating',
};

const RICH_TEXT_FIELDS = [
  'authors', 'venue', 'notes', 'remarks', 'gaps',
  'key_contribution', 'relevance', 'citation_key',
];

const plain = (arr) => (arr || []).map((t) => t.plain_text).join('');

const KNOWN_PROP_NAMES = new Set(Object.values(PROPS));

// Notion returns every property (with its type) on every page regardless of
// whether it has a value, so any column added in the Notion UI shows up here
// automatically — no code change needed to surface a new field in the app.
// Only these types are supported for round-tripping; anything else (files,
// people, formula, relation, date…) is silently skipped since we wouldn't
// know how to write it back.
function decodeExtraProp(prop) {
  switch (prop.type) {
    case 'rich_text': return plain(prop.rich_text);
    case 'number': return prop.number ?? null;
    case 'checkbox': return !!prop.checkbox;
    case 'url': return prop.url || '';
    case 'select': return (prop.select || {}).name || '';
    case 'multi_select': return (prop.multi_select || []).map((t) => t.name);
    default: return undefined;
  }
}

function encodeExtraProp(type, value) {
  switch (type) {
    case 'rich_text': return { rich_text: toRichText(value) };
    case 'number': {
      const n = Number(value);
      return { number: Number.isFinite(n) ? n : null };
    }
    case 'checkbox': return { checkbox: !!value };
    case 'url': return { url: value || null };
    case 'select': return value ? { select: { name: String(value) } } : { select: null };
    case 'multi_select': {
      const list = Array.isArray(value) ? value : String(value || '').split(',');
      return {
        multi_select: list.map((s) => String(s).trim()).filter(Boolean)
          .map((name) => ({ name: name.slice(0, 100) })),
      };
    }
    default: return null;
  }
}

function pageToPaper(page) {
  const p = page.properties;
  const rt = (field) => plain((p[PROPS[field]] || {}).rich_text);

  const extra = {};
  for (const [name, prop] of Object.entries(p)) {
    if (KNOWN_PROP_NAMES.has(name)) continue;
    const value = decodeExtraProp(prop);
    if (value !== undefined) extra[name] = { type: prop.type, value };
  }

  return {
    id: page.id,
    title: plain((p[PROPS.title] || {}).title),
    authors: rt('authors'),
    venue: rt('venue'),
    year: (p[PROPS.year] || {}).number ?? null,
    tags: ((p[PROPS.tags] || {}).multi_select || []).map((t) => t.name),
    status: ((p[PROPS.status] || {}).select || {}).name || 'To Read',
    arxiv_link: (p[PROPS.arxiv_link] || {}).url || '',
    pdf_url: (p[PROPS.pdf_url] || {}).url || '',
    notes: rt('notes'),
    remarks: rt('remarks'),
    gaps: rt('gaps'),
    key_contribution: rt('key_contribution'),
    relevance: rt('relevance'),
    citation_key: rt('citation_key'),
    rating: (p[PROPS.rating] || {}).number ?? null,
    date_added: page.created_time,
    extra,
  };
}

// Notion caps each rich_text item at 2000 chars — chunk long strings.
function toRichText(str) {
  const s = String(str ?? '');
  if (!s) return [];
  const chunks = [];
  for (let i = 0; i < s.length; i += 2000) {
    chunks.push({ type: 'text', text: { content: s.slice(i, i + 2000) } });
  }
  return chunks;
}

function paperToProperties(rec) {
  const props = {};
  if ('title' in rec) props[PROPS.title] = { title: toRichText(rec.title || 'Untitled') };
  for (const f of RICH_TEXT_FIELDS) {
    if (f in rec) props[PROPS[f]] = { rich_text: toRichText(rec[f]) };
  }
  if ('year' in rec) {
    const n = Number(rec.year);
    props[PROPS.year] = { number: Number.isFinite(n) ? n : null };
  }
  if ('rating' in rec) {
    const n = Number(rec.rating);
    props[PROPS.rating] = { number: Number.isFinite(n) && n > 0 ? n : null };
  }
  if ('tags' in rec) {
    props[PROPS.tags] = {
      multi_select: (rec.tags || []).filter(Boolean).map((name) => ({ name: String(name).slice(0, 100) })),
    };
  }
  if ('status' in rec) {
    props[PROPS.status] = rec.status ? { select: { name: rec.status } } : { select: null };
  }
  if ('arxiv_link' in rec) props[PROPS.arxiv_link] = { url: rec.arxiv_link || null };
  if ('pdf_url' in rec) props[PROPS.pdf_url] = { url: rec.pdf_url || null };

  // Dynamic fields: any Notion column not in PROPS. The client echoes back
  // the {type, value} pair it was given by GET/PATCH so we know how to
  // encode it without needing a separate schema lookup here.
  if (rec.extra && typeof rec.extra === 'object') {
    for (const [name, field] of Object.entries(rec.extra)) {
      if (!field || KNOWN_PROP_NAMES.has(name)) continue;
      const enc = encodeExtraProp(field.type, field.value);
      if (enc) props[name] = enc;
    }
  }
  return props;
}

async function listPapers(env) {
  const papers = [];
  let cursor;
  do {
    const body = {
      page_size: 100,
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    };
    if (cursor) body.start_cursor = cursor;
    const res = await notion(env, `/databases/${env.DATABASE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    papers.push(...res.results.map(pageToPaper));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return json({ papers });
}

async function createPaper(env, rec) {
  rec = await enrichFromArxiv(rec);
  if (!('status' in rec)) rec.status = 'To Read';
  const page = await notion(env, '/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: env.DATABASE_ID },
      properties: paperToProperties(rec),
    }),
  });
  return json({ paper: pageToPaper(page) }, 201);
}

async function updatePaper(env, id, rec) {
  const page = await notion(env, `/pages/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: paperToProperties(rec) }),
  });
  return json({ paper: pageToPaper(page) });
}

/* ----------------------------------------------------- arXiv enrichment */

// Matches new-style (2401.12345) and old-style (cs.AI/0112017) arXiv ids.
function extractArxivId(str) {
  if (!str) return null;
  const s = String(str);
  const m =
    s.match(/(\d{4}\.\d{4,5})(v\d+)?/) ||
    s.match(/([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/);
  return m ? m[1] : null;
}

const xmlText = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m
    ? m[1].replace(/\s+/g, ' ').trim()
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    : '';
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// export.arxiv.org occasionally 429s/5xxs under light bursts (its documented
// courtesy limit is ~1 req/3s); a couple of short retries clears almost all
// of those transient failures instead of silently giving up.
async function fetchArxivEntry(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(attempt * 1200);
    try {
      const res = await fetch(
        `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`,
        { headers: { 'User-Agent': 'paper-deck-worker' } }
      );
      if (!res.ok) continue;
      const xml = await res.text();
      const entry = (xml.match(/<entry>([\s\S]*?)<\/entry>/) || [])[1];
      if (entry) return entry;
    } catch {
      // network hiccup — fall through and retry
    }
  }
  return null;
}

/**
 * If the record has an arXiv link/id but is missing title, authors or year,
 * fetch the Atom feed and fill them in — so bookmarklet captures arrive
 * fully populated even if the app is never opened. Title is never left
 * blank: if arXiv can't be reached after retries, we fall back to the
 * arXiv id so the row is still identifiable instead of showing "Untitled".
 */
async function enrichFromArxiv(rec) {
  const id = extractArxivId(rec.arxiv_link) || extractArxivId(rec.arxiv_id);
  if (!id) return rec;

  rec.arxiv_link = rec.arxiv_link || `https://arxiv.org/abs/${id}`;
  if (!rec.pdf_url) rec.pdf_url = `https://arxiv.org/pdf/${id}`;

  const needs = !rec.title || !rec.authors || !rec.year;
  if (!needs) return rec;

  const entry = await fetchArxivEntry(id);
  if (entry) {
    if (!rec.title) rec.title = xmlText(entry, 'title');
    if (!rec.authors) {
      const names = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) =>
        m[1].trim()
      );
      rec.authors = names.join(', ');
    }
    if (!rec.year) {
      const published = xmlText(entry, 'published');
      const y = parseInt(published.slice(0, 4), 10);
      if (Number.isFinite(y)) rec.year = y;
    }
  }
  if (!rec.title) rec.title = `arXiv:${id} (metadata pending — reopen and re-save to retry)`;
  return rec;
}

/* ------------------------------------------------------------------- R2 */

async function uploadPdf(request, env, origin) {
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return json({ error: 'No file in form field "file"' }, 400);
  }
  const safeName = (file.name || 'paper.pdf').replace(/[^\w.-]+/g, '_');
  const key = `${Date.now()}-${safeName}`;
  await env.PDFS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/pdf' },
  });
  const base = (env.PUBLIC_R2_URL || '').replace(/\/+$/, '');
  const pdf_url = base
    ? `${base}/${encodeURIComponent(key)}`
    : `${origin}/file/${encodeURIComponent(key)}`;
  return json({ pdf_url, key }, 201);
}

async function serveFile(env, key) {
  const obj = await env.PDFS.get(key);
  if (!obj) return json({ error: 'File not found' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/pdf',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...CORS,
    },
  });
}

// CORS proxy for arXiv PDFs only (arxiv.org does not send CORS headers,
// which would otherwise block PDF.js in the reader).
async function proxyPdf(target, env) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return json({ error: 'Invalid url' }, 400);
  }
  const allowed =
    /(^|\.)arxiv\.org$/.test(u.hostname) ||
    (env.PUBLIC_R2_URL && u.origin === new URL(env.PUBLIC_R2_URL).origin);
  if (u.protocol !== 'https:' || !allowed) {
    return json({ error: 'Host not allowed' }, 403);
  }
  const res = await fetch(u.toString(), {
    headers: { 'User-Agent': 'paper-deck-worker' },
  });
  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'application/pdf',
      'Cache-Control': 'public, max-age=86400',
      ...CORS,
    },
  });
}
