/**
 * Paper Deck — React PWA (build-free: React + htm over ESM, PDF.js UMD).
 *
 * Views: Library (card grid) / Reader (PDF + ink + notes) / Add / Settings.
 * The only persistent client state is the Worker base URL (localStorage)
 * and the ink annotation layer (IndexedDB, keyed by Notion page id).
 * Everything structured lives in Notion, reached through the Worker.
 */

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';
import htm from 'https://esm.sh/htm@3.1.1';

const html = htm.bind(React.createElement);

/* ------------------------------------------------------------ constants */

const STATUSES = ['To Read', 'Reading', 'Read', 'Revisit'];
const STATUS_COLORS = {
  'To Read': 'var(--status-toread)',
  Reading: 'var(--status-reading)',
  Read: 'var(--status-read)',
  Revisit: 'var(--status-revisit)',
};
const STARTER_TAGS = [
  'Agentic Systems', 'Memory', 'Software Engineering',
  'Benchmarking', 'CloudOps', 'Evaluation',
];
const TEXT_SECTIONS = [
  ['notes', 'Notes'],
  ['remarks', 'Remarks'],
  ['gaps', 'Gaps'],
  ['key_contribution', 'Key Contribution'],
  ['relevance', 'Relevance'],
];
const PDFJS_WORKER =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ---------------------------------------------------------------- utils */

const getWorkerUrl = () =>
  (localStorage.getItem('pd_worker_url') || '').replace(/\/+$/, '');
const setWorkerUrl = (u) =>
  localStorage.setItem('pd_worker_url', (u || '').trim().replace(/\/+$/, ''));

// Accepts a pasted Worker URL, tolerates a missing "https://", and returns
// null if it still isn't a well-formed absolute URL. A malformed value here
// is the #1 cause of the bookmarklet's "Save failed (network)" toast: fetch()
// on a broken/relative URL rejects before any request ever leaves the page,
// so the failure looks identical to "no internet" even though it never was.
function normalizeWorkerUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function extractArxivId(str) {
  if (!str) return null;
  const s = String(str);
  const m =
    s.match(/(\d{4}\.\d{4,5})(v\d+)?/) ||
    s.match(/([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/);
  return m ? m[1] : null;
}

// stable pastel color per tag name
function tagColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return {
    background: `hsl(${h} 70% 92%)`,
    color: `hsl(${h} 55% 32%)`,
  };
}

function debounce(fn, ms) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.flush = () => { clearTimeout(t); };
  return d;
}

/* ------------------------------------------------------------------ api */

async function api(path, init = {}) {
  const base = getWorkerUrl();
  if (!base) throw new Error('No Worker URL set — open Settings first.');
  const res = await fetch(base + path, {
    headers: init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function fetchArxivMeta(idOrUrl) {
  const id = extractArxivId(idOrUrl);
  if (!id) throw new Error('Could not find an arXiv ID in that input.');
  const res = await fetch(
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`
  );
  if (!res.ok) throw new Error(`arXiv API error (${res.status})`);
  const xml = new DOMParser().parseFromString(await res.text(), 'text/xml');
  const entry = xml.querySelector('entry');
  const title = entry?.querySelector('title')?.textContent.replace(/\s+/g, ' ').trim();
  if (!entry || !title) throw new Error('arXiv returned no entry for that ID.');
  const authors = [...entry.querySelectorAll('author > name')]
    .map((n) => n.textContent.trim()).join(', ');
  const year = parseInt(
    (entry.querySelector('published')?.textContent || '').slice(0, 4), 10
  );
  return {
    title,
    authors,
    year: Number.isFinite(year) ? year : '',
    arxiv_link: `https://arxiv.org/abs/${id}`,
    pdf_url: `https://arxiv.org/pdf/${id}`,
  };
}

/* -------------------------------------------------- IndexedDB (ink layer) */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('paper-deck', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('annotations');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function loadInk(paperId) {
  const db = await openDb();
  return new Promise((resolve) => {
    const req = db.transaction('annotations').objectStore('annotations').get(paperId);
    req.onsuccess = () => resolve(req.result || { pages: {} });
    req.onerror = () => resolve({ pages: {} });
  });
}
async function saveInk(paperId, data) {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction('annotations', 'readwrite');
    tx.objectStore('annotations').put(data, paperId);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

/* ------------------------------------------------------- share target in */

async function consumeSharePayload() {
  if (!new URLSearchParams(location.search).has('shared')) return null;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('pd-shared');
    const metaRes = await cache.match('./pd-shared-meta');
    if (!metaRes) return null;
    const meta = await metaRes.json();
    let file = null;
    if (meta.hasFile) {
      const fileRes = await cache.match('./pd-shared-file');
      if (fileRes) {
        file = new File([await fileRes.blob()], meta.fileName || 'shared.pdf', {
          type: 'application/pdf',
        });
      }
    }
    await cache.delete('./pd-shared-meta');
    await cache.delete('./pd-shared-file');
    return { meta, file };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- small components */

const Stars = ({ n }) => html`
  <span class="stars" aria-label="rating ${n || 0} of 5">
    ${[1, 2, 3, 4, 5].map(
      (i) => html`<span key=${i} class=${i <= (n || 0) ? '' : 'off'}>★</span>`
    )}
  </span>`;

const StarInput = ({ value, onChange }) => html`
  <span class="star-input">
    ${[1, 2, 3, 4, 5].map(
      (i) => html`<button key=${i} class=${i <= (value || 0) ? 'on' : ''}
        onClick=${() => onChange(value === i ? null : i)} aria-label="${i} stars">★</button>`
    )}
  </span>`;

const TagChips = ({ tags }) => html`
  <span class="tag-row">
    ${(tags || []).map(
      (t) => html`<span key=${t} class="tag" style=${tagColor(t)}>${t}</span>`
    )}
  </span>`;

const MANUAL_TEXT_FIELDS = ['notes', 'remarks', 'gaps', 'key_contribution', 'relevance'];

// "Has content a user filled in", used to decide whether removing a paper needs
// the double confirm. Bibliographic fields (title/authors/venue/year/arxiv) are
// auto-imported, so they don't count; notes, rating, tags and any custom column do.
function hasManualContent(p) {
  if (MANUAL_TEXT_FIELDS.some((f) => (p[f] || '').trim())) return true;
  if (p.rating) return true;
  if ((p.tags || []).length) return true;
  for (const f of Object.values(p.extra || {})) {
    const v = f && f.value;
    if (Array.isArray(v) ? v.length : v !== '' && v != null && v !== false) return true;
  }
  return false;
}

// Chip editor for a multi-value category: built-in Tags and any Notion
// multi_select column. Known options render as toggle chips, plus a free-text
// add — same UX as the Add view's tag picker, so categories are chosen, not typed.
function TagPicker({ value, options, onChange }) {
  const [nt, setNt] = useState('');
  const sel = value || [];
  const all = useMemo(() => [...new Set([...(options || []), ...sel])], [options, sel]);
  const toggle = (t) =>
    onChange(sel.includes(t) ? sel.filter((x) => x !== t) : [...sel, t]);
  const add = () => {
    const t = nt.trim();
    if (t && !sel.includes(t)) onChange([...sel, t]);
    setNt('');
  };
  return html`
    <div class="tagpick">
      <div class="chip-row" style=${{ margin: 0 }}>
        ${all.length === 0 ? html`<span class="hint">No options yet — add one.</span>` : ''}
        ${all.map((t) => html`
          <button key=${t} type="button" class="chip ${sel.includes(t) ? 'on' : ''}"
            onClick=${() => toggle(t)}>${t}</button>`)}
      </div>
      <div class="inline-add">
        <input placeholder="New…" value=${nt} onChange=${(e) => setNt(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" class="btn ghost" onClick=${add}>Add</button>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------- Library */

function Library({ papers, loading, onOpen, onRefresh, onDelete }) {
  const [q, setQ] = useState('');
  const [tagFilter, setTagFilter] = useState(null);
  const [statusFilter, setStatusFilter] = useState(null);
  const [sort, setSort] = useState('date');

  const allTags = useMemo(() => {
    const s = new Set(STARTER_TAGS);
    papers.forEach((p) => (p.tags || []).forEach((t) => s.add(t)));
    return [...s];
  }, [papers]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = papers.filter((p) => {
      if (tagFilter && !(p.tags || []).includes(tagFilter)) return false;
      if (statusFilter && p.status !== statusFilter) return false;
      if (!needle) return true;
      return (
        (p.title || '').toLowerCase().includes(needle) ||
        (p.authors || '').toLowerCase().includes(needle) ||
        (p.tags || []).some((t) => t.toLowerCase().includes(needle))
      );
    });
    const statusOrder = (s) => STATUSES.indexOf(s);
    if (sort === 'rating') list = [...list].sort((a, b) => (b.rating || 0) - (a.rating || 0));
    else if (sort === 'status') list = [...list].sort((a, b) => statusOrder(a.status) - statusOrder(b.status));
    else list = [...list].sort((a, b) => (b.date_added || '').localeCompare(a.date_added || ''));
    return list;
  }, [papers, q, tagFilter, statusFilter, sort]);

  // Single click removes an empty paper straight away; if the paper has notes,
  // tags, a rating or any custom field filled in, confirm twice before removing.
  const askDelete = (e, p) => {
    e.stopPropagation();
    const title = p.title || 'Untitled';
    if (hasManualContent(p)) {
      if (!window.confirm(`"${title}" has notes/tags/fields you filled in.\n\nRemove it anyway? (1 of 2)`)) return;
      if (!window.confirm(`Really remove "${title}"?\nThis archives it in Notion and can't be undone from the app. (2 of 2)`)) return;
    }
    onDelete(p);
  };

  return html`
    <div class="page">
      <div class="lib-controls">
        <input class="search" type="search" placeholder="Search title, author, tag…"
          value=${q} onChange=${(e) => setQ(e.target.value)} />
        <select class="sort-select" value=${sort} onChange=${(e) => setSort(e.target.value)}>
          <option value="date">Newest first</option>
          <option value="rating">By rating</option>
          <option value="status">By status</option>
        </select>
        <button class="iconbtn" title="Refresh" onClick=${onRefresh}>↻</button>
      </div>
      <div class="chip-row">
        ${STATUSES.map((s) => html`
          <button key=${s} class="chip ${statusFilter === s ? 'on' : ''}"
            onClick=${() => setStatusFilter(statusFilter === s ? null : s)}>${s}</button>`)}
      </div>
      <div class="chip-row">
        ${allTags.map((t) => html`
          <button key=${t} class="chip ${tagFilter === t ? 'on' : ''}"
            onClick=${() => setTagFilter(tagFilter === t ? null : t)}>${t}</button>`)}
      </div>
      ${shown.length === 0
        ? html`<div class="empty">
            <div class="big">${loading ? '⏳' : '📚'}</div>
            ${loading ? 'Loading your library…'
              : papers.length ? 'Nothing matches those filters.'
              : 'No papers yet. Add one from the Add tab, the share sheet, or the bookmarklet.'}
          </div>`
        : html`<div class="grid">
            ${shown.map((p) => html`
              <div key=${p.id} class="card" role="button" tabindex="0"
                onClick=${() => onOpen(p)}
                onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(p); } }}>
                <button class="card-del" title="Remove paper" onClick=${(e) => askDelete(e, p)}>✕</button>
                <h3>${p.title || 'Untitled'}</h3>
                <div class="meta">
                  ${[p.venue, p.year].filter(Boolean).join(' · ') || ' '}
                </div>
                <${TagChips} tags=${p.tags} />
                <div class="foot">
                  <span class="status-pill" style=${{ background: STATUS_COLORS[p.status] || 'var(--status-toread)' }}>
                    ${p.status}
                  </span>
                  <${Stars} n=${p.rating} />
                </div>
              </div>`)}
          </div>`}
    </div>`;
}

/* --------------------------------------------------------------- PDF pane */

/**
 * Renders the PDF with PDF.js and an ink overlay per page (Pointer Events:
 * pen/mouse always draw when a tool is active; finger draws only when
 * finger-draw is toggled, otherwise it scrolls). Strokes are normalized to
 * page size and persisted in IndexedDB under the Notion page id.
 */
function PdfPane({ paper, onNeedPdf, showToast }) {
  const scrollRef = useRef(null);
  const [tool, setTool] = useState('none'); // none | pen | hl | erase
  const [penColor, setPenColor] = useState('#1d4ed8');
  const [fingerDraw, setFingerDraw] = useState(false);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const engine = useRef({ tool: 'none', penColor: '#1d4ed8', fingerDraw: false });
  const inkRef = useRef({ pages: {} });
  const pageCtx = useRef([]); // [{overlay, w, h}] per page (1-indexed)
  const undoStack = useRef([]);

  engine.current.tool = tool;
  engine.current.penColor = penColor;
  engine.current.fingerDraw = fingerDraw;

  const persist = useMemo(
    () => debounce(() => saveInk(paper.id, inkRef.current), 600),
    [paper.id]
  );

  const redraw = useCallback((pageNo) => {
    const ctx = pageCtx.current[pageNo];
    if (!ctx) return;
    const { overlay, w, h } = ctx;
    const g = overlay.getContext('2d');
    g.clearRect(0, 0, overlay.width, overlay.height);
    const dpr = overlay.width / w;
    for (const s of inkRef.current.pages[pageNo] || []) {
      g.beginPath();
      g.lineJoin = g.lineCap = 'round';
      g.strokeStyle = s.color;
      g.globalAlpha = s.tool === 'hl' ? 0.35 : 1;
      g.lineWidth = s.w * w * dpr;
      s.pts.forEach(([x, y], i) => {
        const px = x * w * dpr, py = y * h * dpr;
        i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
      });
      if (s.pts.length === 1) g.lineTo(s.pts[0][0] * w * dpr + 0.1, s.pts[0][1] * h * dpr);
      g.stroke();
    }
    g.globalAlpha = 1;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const container = scrollRef.current;
    container.innerHTML = '';
    pageCtx.current = [];
    setStatus('loading');

    (async () => {
      if (!paper.pdf_url) { setStatus('nopdf'); return; }
      if (!window.pdfjsLib) { setStatus('error'); return; }
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

      inkRef.current = await loadInk(paper.id);

      let doc;
      try {
        doc = await window.pdfjsLib.getDocument({ url: paper.pdf_url }).promise;
      } catch {
        // direct fetch blocked (CORS) — retry through the Worker proxy
        try {
          const proxied = `${getWorkerUrl()}/fetchpdf?url=${encodeURIComponent(paper.pdf_url)}`;
          doc = await window.pdfjsLib.getDocument({ url: proxied }).promise;
        } catch {
          if (!cancelled) setStatus('error');
          return;
        }
      }
      if (cancelled) return;
      setStatus('ready');

      const width = Math.min(container.clientWidth - 28, 1100);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      const renderPage = async (pageNo, holder) => {
        const page = await doc.getPage(pageNo);
        if (cancelled) return;
        const vp1 = page.getViewport({ scale: 1 });
        const scale = width / vp1.width;
        const vp = page.getViewport({ scale });
        const w = vp.width, h = vp.height;
        holder.style.width = `${w}px`;
        holder.style.height = `${h}px`;

        const canvas = document.createElement('canvas');
        canvas.width = w * dpr; canvas.height = h * dpr;
        canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
        const overlay = document.createElement('canvas');
        overlay.className = 'ink';
        overlay.width = w * dpr; overlay.height = h * dpr;
        overlay.style.width = `${w}px`; overlay.style.height = `${h}px`;
        holder.append(canvas, overlay);

        pageCtx.current[pageNo] = { overlay, w, h };
        attachInk(overlay, pageNo, w, h);

        await page.render({
          canvasContext: canvas.getContext('2d'),
          viewport: page.getViewport({ scale: scale * dpr }),
        }).promise;
        redraw(pageNo);
      };

      // lazy rendering: placeholders + IntersectionObserver
      const observer = new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            if (en.isIntersecting && !en.target.dataset.rendered) {
              en.target.dataset.rendered = '1';
              observer.unobserve(en.target);
              renderPage(Number(en.target.dataset.page), en.target);
            }
          }
        },
        { root: container, rootMargin: '600px' }
      );

      for (let i = 1; i <= doc.numPages; i++) {
        const holder = document.createElement('div');
        holder.className = 'pdf-page';
        holder.dataset.page = i;
        holder.style.width = `${width}px`;
        holder.style.height = `${width * 1.35}px`; // placeholder ratio
        container.appendChild(holder);
        observer.observe(holder);
      }
    })();

    return () => { cancelled = true; persist.flush(); saveInk(paper.id, inkRef.current); };
  }, [paper.id, paper.pdf_url]);

  function attachInk(overlay, pageNo, w, h) {
    let stroke = null;

    const norm = (e) => {
      const r = overlay.getBoundingClientRect();
      return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
    };

    const eraseAt = (pt) => {
      const list = inkRef.current.pages[pageNo] || [];
      const radius = 0.02;
      const keep = list.filter(
        (s) => !s.pts.some(([x, y]) => Math.hypot(x - pt[0], y - pt[1]) < radius)
      );
      if (keep.length !== list.length) {
        inkRef.current.pages[pageNo] = keep;
        redraw(pageNo);
        persist();
      }
    };

    overlay.addEventListener('pointerdown', (e) => {
      const { tool, penColor, fingerDraw } = engine.current;
      if (tool === 'none') return;
      if (e.pointerType === 'touch' && !fingerDraw) return; // finger scrolls
      e.preventDefault();
      overlay.setPointerCapture(e.pointerId);
      overlay.classList.add('drawing');
      const pt = norm(e);
      if (tool === 'erase') { eraseAt(pt); stroke = { erase: true }; return; }
      stroke = {
        tool,
        color: tool === 'hl' ? '#fde047' : penColor,
        w: tool === 'hl' ? 0.018 : 0.0035,
        pts: [pt],
        t: Date.now(),
      };
    });

    overlay.addEventListener('pointermove', (e) => {
      if (!stroke) return;
      const pts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of pts) {
        const pt = norm(ev);
        if (stroke.erase) { eraseAt(pt); continue; }
        stroke.pts.push(pt);
      }
      if (!stroke.erase) {
        // incremental draw of the active stroke
        const g = overlay.getContext('2d');
        const dpr = overlay.width / w;
        const n = stroke.pts.length;
        if (n >= 2) {
          const [x1, y1] = stroke.pts[n - 2];
          const [x2, y2] = stroke.pts[n - 1];
          g.beginPath();
          g.lineJoin = g.lineCap = 'round';
          g.strokeStyle = stroke.color;
          g.globalAlpha = stroke.tool === 'hl' ? 0.35 : 1;
          g.lineWidth = stroke.w * w * dpr;
          g.moveTo(x1 * w * dpr, y1 * h * dpr);
          g.lineTo(x2 * w * dpr, y2 * h * dpr);
          g.stroke();
          g.globalAlpha = 1;
        }
      }
    });

    const finish = (e) => {
      overlay.classList.remove('drawing');
      if (!stroke) return;
      if (!stroke.erase && stroke.pts.length > 0) {
        (inkRef.current.pages[pageNo] ||= []).push(stroke);
        undoStack.current.push(pageNo);
        redraw(pageNo); // clean redraw (highlighter overlaps blend once)
        persist();
      }
      stroke = null;
      try { overlay.releasePointerCapture(e.pointerId); } catch {}
    };
    overlay.addEventListener('pointerup', finish);
    overlay.addEventListener('pointercancel', finish);
  }

  const undo = () => {
    const pageNo = undoStack.current.pop();
    if (pageNo == null) return;
    (inkRef.current.pages[pageNo] || []).pop();
    redraw(pageNo);
    persist();
  };

  const toolBtn = (id, icon, title) => html`
    <button class="tool ${tool === id ? 'on' : ''}" title=${title}
      onClick=${() => setTool(tool === id ? 'none' : id)}>${icon}</button>`;

  return html`
    <div class="pdf-pane">
      <div class="pdf-toolbar">
        ${toolBtn('pen', '✏️', 'Pen')}
        ${toolBtn('hl', '🖍', 'Highlighter')}
        ${toolBtn('erase', '⌫', 'Eraser')}
        ${tool === 'pen' && html`
          ${['#1d4ed8', '#111111', '#dc2626'].map((c) => html`
            <button key=${c} class="tool" style=${{ color: c, fontSize: '22px' }}
              title="Pen color" onClick=${() => setPenColor(c)}>
              ${penColor === c ? '◉' : '●'}
            </button>`)}`}
        <button class="tool ${fingerDraw ? 'on' : ''}" title="Draw with finger (otherwise finger scrolls)"
          onClick=${() => setFingerDraw(!fingerDraw)}>👆</button>
        <button class="tool" title="Undo last stroke" onClick=${undo}>↩︎</button>
        <span class="tool-spacer"></span>
      </div>
      ${status === 'nopdf' && html`
        <div class="pdf-missing">
          <div style=${{ fontSize: '40px' }}>📄</div>
          <div>No PDF attached to this paper yet.</div>
          <label class="btn primary">
            Import PDF
            <input type="file" accept="application/pdf" style=${{ display: 'none' }}
              onChange=${(e) => e.target.files[0] && onNeedPdf(e.target.files[0])} />
          </label>
        </div>`}
      ${status === 'error' && html`
        <div class="pdf-missing">
          <div style=${{ fontSize: '40px' }}>⚠️</div>
          <div>Couldn't load the PDF (offline, or the URL blocks cross-origin reads).</div>
          <code class="mono">${paper.pdf_url}</code>
        </div>`}
      <div class="pdf-scroll" ref=${scrollRef}
        style=${{ display: status === 'ready' || status === 'loading' ? 'block' : 'none' }}></div>
    </div>`;
}

/**
 * One row for a Notion column that isn't part of the app's built-in schema
 * (see worker.js decodeExtraProp/encodeExtraProp). Adding a column in Notion
 * is enough to make it show up here — no code change needed. `field` is
 * `{type, value}` as returned by the Worker.
 */
function ExtraField({ name, field, options, open, onToggle, onChange }) {
  const { type, value } = field;
  if (type === 'rich_text') {
    return html`
      <div class="section">
        <button onClick=${onToggle}>
          <span>${name}</span><span>${open ? '▾' : '▸'}</span>
        </button>
        ${open && html`
          <textarea value=${value || ''} placeholder="Write ${name.toLowerCase()}…"
            onChange=${(e) => onChange(e.target.value)}></textarea>`}
      </div>`;
  }
  if (type === 'checkbox') {
    return html`
      <div class="field-row">
        <label>${name}</label>
        <input type="checkbox" checked=${!!value} onChange=${(e) => onChange(e.target.checked)} />
      </div>`;
  }
  if (type === 'multi_select') {
    return html`
      <div class="field">
        <label>${name}</label>
        <${TagPicker} value=${value} options=${options} onChange=${onChange} />
      </div>`;
  }
  if (type === 'select') {
    const listId = `dl-${name.replace(/\W+/g, '-')}`;
    return html`
      <div class="field-row">
        <label>${name}</label>
        <input list=${listId} value=${value || ''} placeholder="Choose or type…"
          onChange=${(e) => onChange(e.target.value)} />
        <datalist id=${listId}>
          ${(options || []).map((o) => html`<option key=${o} value=${o}></option>`)}
        </datalist>
      </div>`;
  }
  return html`
    <div class="field-row">
      <label>${name}</label>
      <input type=${type === 'number' ? 'number' : 'text'} value=${value ?? ''}
        onChange=${(e) => onChange(e.target.value)} />
    </div>`;
}

/* ---------------------------------------------------------------- Reader */

function Reader({ paper, onPatch, showToast, allTags, extraOptions }) {
  const [local, setLocal] = useState(paper);
  const [open, setOpen] = useState({ notes: true });
  const [notesVisible, setNotesVisible] = useState(true);
  const [saveState, setSaveState] = useState('');

  useEffect(() => setLocal(paper), [paper.id]);

  const push = useMemo(
    () =>
      debounce(async (id, fields) => {
        setSaveState('Saving…');
        try {
          await api(`/papers/${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
          setSaveState('Saved ✓');
          onPatch(id, fields);
        } catch (e) {
          setSaveState('Save failed — retrying on next edit');
        }
      }, 900),
    [onPatch]
  );
  const pending = useRef({});

  const edit = (field, value) => {
    setLocal((l) => ({ ...l, [field]: value }));
    pending.current[field] = value;
    push(paper.id, { ...pending.current });
  };

  // Dynamic fields: any Notion column beyond the built-in schema (see
  // worker.js decodeExtraProp/encodeExtraProp). type travels with the value
  // so the Worker knows how to write it back without a separate lookup.
  const editExtra = (name, type, value) => {
    setLocal((l) => ({ ...l, extra: { ...l.extra, [name]: { type, value } } }));
    pending.current.extra = { ...(pending.current.extra || {}), [name]: { type, value } };
    push(paper.id, { ...pending.current });
  };

  const importPdf = async (file) => {
    try {
      showToast('Uploading PDF…');
      const fd = new FormData();
      fd.append('file', file);
      const { pdf_url } = await api('/upload', { method: 'POST', body: fd });
      edit('pdf_url', pdf_url);
      showToast('PDF attached ✓');
    } catch (e) {
      showToast(`Upload failed: ${e.message}`);
    }
  };

  return html`
    <div class="reader">
      <${PdfPane} key=${paper.id + (local.pdf_url || '')} paper=${local}
        onNeedPdf=${importPdf} showToast=${showToast} />
      ${notesVisible && html`
        <div class="notes-pane">
          <div class="field">
            <label>Title</label>
            <input value=${local.title || ''} placeholder="Paper title"
              onChange=${(e) => edit('title', e.target.value)} />
          </div>
          <div class="field">
            <label>Authors</label>
            <input value=${local.authors || ''} placeholder="A. Author, B. Author"
              onChange=${(e) => edit('authors', e.target.value)} />
          </div>
          <div class="row">
            <div class="field">
              <label>Venue</label>
              <input value=${local.venue || ''} placeholder="ICSE, NeurIPS…"
                onChange=${(e) => edit('venue', e.target.value)} />
            </div>
            <div class="field">
              <label>Year</label>
              <input type="number" value=${local.year ?? ''} placeholder="2026"
                onChange=${(e) => edit('year', e.target.value === '' ? null : Number(e.target.value))} />
            </div>
          </div>
          <div class="field">
            <label>Tags</label>
            <${TagPicker} value=${local.tags} options=${allTags} onChange=${(v) => edit('tags', v)} />
          </div>
          <div class="field-row">
            <label>Status</label>
            <select value=${local.status} onChange=${(e) => edit('status', e.target.value)}>
              ${STATUSES.map((s) => html`<option key=${s} value=${s}>${s}</option>`)}
            </select>
          </div>
          <div class="field-row">
            <label>Rating</label>
            <${StarInput} value=${local.rating} onChange=${(v) => edit('rating', v)} />
          </div>
          ${TEXT_SECTIONS.map(([field, label]) => html`
            <div key=${field} class="section">
              <button onClick=${() => setOpen((o) => ({ ...o, [field]: !o[field] }))}>
                <span>${label}</span><span>${open[field] ? '▾' : '▸'}</span>
              </button>
              ${open[field] && html`
                <textarea value=${local[field] || ''} placeholder="Write ${label.toLowerCase()}…"
                  onChange=${(e) => edit(field, e.target.value)}></textarea>`}
            </div>`)}
          ${Object.entries(local.extra || {}).map(([name, f]) => html`
            <${ExtraField} key=${name} name=${name} field=${f}
              options=${(extraOptions || {})[name] || []}
              open=${!!open[name]}
              onToggle=${() => setOpen((o) => ({ ...o, [name]: !o[name] }))}
              onChange=${(v) => editExtra(name, f.type, v)} />`)}
          <div class="field">
            <label>arXiv link</label>
            <input value=${local.arxiv_link || ''} placeholder="https://arxiv.org/abs/…"
              onChange=${(e) => edit('arxiv_link', e.target.value)} />
          </div>
          ${local.arxiv_link && html`
            <a class="hint" href=${local.arxiv_link} target="_blank" rel="noopener">↗ open link</a>`}
          <div class="save-state">${saveState}</div>
        </div>`}
      <button class="iconbtn" title=${notesVisible ? 'Full-width PDF' : 'Show notes'}
        style=${{ position: 'fixed', right: '14px', bottom: 'max(14px, env(safe-area-inset-bottom))', zIndex: 40 }}
        onClick=${() => setNotesVisible(!notesVisible)}>
        ${notesVisible ? '⛶' : '📝'}
      </button>
    </div>`;
}

/* ------------------------------------------------------------------- Add */

function AddView({ prefill, onCreated, showToast }) {
  const blank = {
    title: '', authors: '', venue: '', year: '', tags: [],
    status: 'To Read', arxiv_link: '', pdf_url: '',
  };
  const [p, setP] = useState({ ...blank, ...(prefill || {}) });
  const [arxivInput, setArxivInput] = useState(prefill?.arxiv_link || '');
  const [newTag, setNewTag] = useState('');
  const [busy, setBusy] = useState('');
  const allTags = useMemo(() => {
    const s = new Set([...STARTER_TAGS, ...(p.tags || [])]);
    return [...s];
  }, [p.tags]);

  const set = (field) => (e) => setP((x) => ({ ...x, [field]: e.target.value }));
  const toggleTag = (t) =>
    setP((x) => ({
      ...x,
      tags: x.tags.includes(t) ? x.tags.filter((y) => y !== t) : [...x.tags, t],
    }));

  const autofill = async (input) => {
    const src = input ?? arxivInput;
    if (!src.trim()) return;
    setBusy('arxiv');
    try {
      const meta = await fetchArxivMeta(src);
      setP((x) => ({
        ...x,
        title: meta.title,
        authors: meta.authors,
        year: meta.year,
        arxiv_link: meta.arxiv_link,
        pdf_url: x.pdf_url || meta.pdf_url,
      }));
      setArxivInput(meta.arxiv_link);
      showToast('Filled from arXiv ✓');
    } catch (e) {
      showToast(e.message);
    } finally {
      setBusy('');
    }
  };

  const uploadFile = async (file) => {
    setBusy('upload');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { pdf_url } = await api('/upload', { method: 'POST', body: fd });
      setP((x) => ({ ...x, pdf_url }));
      showToast('PDF uploaded ✓');
    } catch (e) {
      showToast(`Upload failed: ${e.message}`);
    } finally {
      setBusy('');
    }
  };

  // shared payload from the share sheet: upload the PDF right away, and
  // auto-fill only when the shared link actually contains an arXiv id
  useEffect(() => {
    if (prefill?._file) uploadFile(prefill._file);
    if (prefill?.arxiv_link && extractArxivId(prefill.arxiv_link)) {
      autofill(prefill.arxiv_link);
    }
  }, []);

  const submit = async () => {
    if (!p.title.trim() && !p.arxiv_link.trim()) {
      showToast('Give it at least a title or an arXiv link.');
      return;
    }
    setBusy('save');
    try {
      const rec = { ...p, year: p.year ? Number(p.year) : undefined };
      delete rec._file;
      const { paper } = await api('/papers', { method: 'POST', body: JSON.stringify(rec) });
      showToast('Added to your library ✓');
      onCreated(paper);
    } catch (e) {
      showToast(`Could not add: ${e.message}`);
    } finally {
      setBusy('');
    }
  };

  return html`
    <div class="page">
      <div class="form-page">
        <h1>Add paper</h1>

        <div class="field">
          <label>Add via link — arXiv URL or ID</label>
          <div class="inline-add">
            <input placeholder="e.g. 2512.12791 or https://arxiv.org/abs/2512.12791"
              value=${arxivInput} onChange=${(e) => setArxivInput(e.target.value)} />
            <button class="btn ghost" disabled=${busy === 'arxiv'} onClick=${() => autofill()}>
              ${busy === 'arxiv' ? '…' : 'Auto-fill'}
            </button>
          </div>
        </div>

        <div class="field">
          <label>Title</label>
          <input value=${p.title} onChange=${set('title')} placeholder="Paper title" />
        </div>
        <div class="field">
          <label>Authors</label>
          <input value=${p.authors} onChange=${set('authors')} placeholder="A. Author, B. Author" />
        </div>
        <div class="row">
          <div class="field">
            <label>Venue</label>
            <input value=${p.venue} onChange=${set('venue')} placeholder="ICSE, NeurIPS…" />
          </div>
          <div class="field">
            <label>Year</label>
            <input type="number" value=${p.year} onChange=${set('year')} placeholder="2026" />
          </div>
        </div>

        <div class="field">
          <label>Tags</label>
          <div class="chip-row" style=${{ margin: 0 }}>
            ${allTags.map((t) => html`
              <button key=${t} class="chip ${p.tags.includes(t) ? 'on' : ''}"
                onClick=${() => toggleTag(t)}>${t}</button>`)}
          </div>
          <div class="inline-add">
            <input placeholder="New tag…" value=${newTag}
              onChange=${(e) => setNewTag(e.target.value)}
              onKeyDown=${(e) => {
                if (e.key === 'Enter' && newTag.trim()) {
                  toggleTag(newTag.trim()); setNewTag('');
                }
              }} />
            <button class="btn ghost" onClick=${() => {
              if (newTag.trim()) { toggleTag(newTag.trim()); setNewTag(''); }
            }}>Add tag</button>
          </div>
        </div>

        <div class="row">
          <div class="field">
            <label>Status</label>
            <select value=${p.status} onChange=${set('status')}>
              ${STATUSES.map((s) => html`<option key=${s} value=${s}>${s}</option>`)}
            </select>
          </div>
          <div class="field">
            <label>PDF</label>
            <label class="btn ghost" style=${{ textAlign: 'center' }}>
              ${busy === 'upload' ? 'Uploading…' : p.pdf_url ? 'PDF attached ✓ (replace)' : 'Import PDF'}
              <input type="file" accept="application/pdf" style=${{ display: 'none' }}
                onChange=${(e) => e.target.files[0] && uploadFile(e.target.files[0])} />
            </label>
          </div>
        </div>
        ${p.pdf_url && html`<p class="hint">PDF: <code class="mono">${p.pdf_url}</code></p>`}

        <button class="btn primary" disabled=${busy === 'save'} onClick=${submit}>
          ${busy === 'save' ? 'Adding…' : 'Add to Notion'}
        </button>
      </div>
    </div>`;
}

/* -------------------------------------------------------------- Settings */

function bookmarkletHref(worker) {
  const src =
    `(function(){var W=${JSON.stringify(worker)};` +
    `var u=location.href,t=document.title;` +
    `var m=u.match(/arxiv\\.org\\/(?:abs|pdf)\\/([0-9]{4}\\.[0-9]{4,5}|[a-z-]+(?:\\.[A-Z]{2})?\\/[0-9]{7})/);` +
    `var b={status:'To Read'};` +
    `if(m){b.arxiv_link='https://arxiv.org/abs/'+m[1];}` +
    `else{b.title=t;if(/\\.pdf($|[?#])/i.test(u)){b.pdf_url=u;}else{b.arxiv_link=u;}}` +
    `var d=document.createElement('div');d.textContent='Saving to Paper Deck…';` +
    `d.style.cssText='position:fixed;bottom:24px;right:24px;z-index:2147483647;background:#1f2333;color:#fff;padding:12px 20px;border-radius:999px;font:14px/1.4 -apple-system,Segoe UI,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.3)';` +
    `document.body.appendChild(d);` +
    `fetch(W+'/papers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})` +
    `.then(function(r){d.textContent=r.ok?'\\u2713 Saved to Paper Deck':'\\u2717 Save failed ('+r.status+')';})` +
    `.catch(function(){d.textContent='\\u2717 Save failed (network)';})` +
    `.then(function(){setTimeout(function(){d.remove();},2500);});})();`;
  return 'javascript:' + encodeURIComponent(src);
}

function Settings({ theme, onTheme, showToast }) {
  const [url, setUrl] = useState(getWorkerUrl());
  const [testState, setTestState] = useState('');
  const [saved, setSaved] = useState(getWorkerUrl());

  const save = () => {
    const normalized = normalizeWorkerUrl(url);
    if (!normalized) {
      showToast('That doesn’t look like a valid URL — check for typos.');
      return;
    }
    setWorkerUrl(normalized);
    setUrl(normalized);
    setSaved(normalized);
    showToast(
      normalized === url.trim() ? 'Worker URL saved ✓' : `Saved as ${normalized} ✓`
    );
  };
  const test = async () => {
    const normalized = normalizeWorkerUrl(url);
    if (!normalized) { setTestState('Not a valid URL'); return; }
    setTestState('Testing…');
    try {
      const res = await fetch(normalized + '/');
      const data = await res.json();
      setTestState(data.ok ? 'Connected ✓' : `Reached it, but got an unexpected response (HTTP ${res.status})`);
    } catch (e) {
      setTestState(
        `Could not reach it — check the URL is exactly right and the Worker is deployed (${e.message})`
      );
    }
  };

  return html`
    <div class="page">
      <div class="form-page">
        <h1>Settings</h1>

        <div class="settings-card">
          <h2>Worker URL</h2>
          <p class="hint">
            The base URL of your deployed Cloudflare Worker, e.g.
            <code class="mono">https://paper-deck-api.yourname.workers.dev</code>.
            This is the only thing stored on this device — no tokens, no secrets.
          </p>
          <input class="search" placeholder="https://paper-deck-api.…workers.dev"
            value=${url} onChange=${(e) => setUrl(e.target.value)} />
          <div class="row">
            <button class="btn primary" onClick=${save}>Save</button>
            <button class="btn ghost" onClick=${test}>Test connection</button>
          </div>
          <div class="save-state">${testState}</div>
        </div>

        <div class="settings-card">
          <h2>Web Capture — bookmarklet</h2>
          ${normalizeWorkerUrl(saved)
            ? html`
              <p class="hint">
                Drag this link to your laptop's bookmarks bar. Click it on any paper
                page (arXiv or otherwise) to file it into your library as
                “To Read” — no need to open this app.
              </p>
              <a class="bookmarklet" href=${bookmarkletHref(normalizeWorkerUrl(saved))}
                onClick=${(e) => { e.preventDefault(); showToast('Drag it to the bookmarks bar instead of clicking.'); }}>
                📥 Save to Paper Deck
              </a>
              <p class="hint">
                URL baked into this bookmarklet:
                <code class="mono">${normalizeWorkerUrl(saved)}</code>
                — if that's wrong, fix it above and re-save, then re-drag the
                bookmarklet (old copies on your bookmarks bar keep the old URL).
              </p>
              <p class="hint">
                On arXiv pages it captures the paper ID and the Worker fills in
                title, authors and year automatically. If a click ever shows
                “Save failed (network)”, that means the request never left the
                page — almost always a stale/mistyped Worker URL in an old
                bookmarklet copy, or a strict site blocking cross-site requests.
                The Add tab always works as a fallback.
              </p>`
            : html`<p class="hint">Save a valid Worker URL above first — the bookmarklet embeds it.</p>`}
        </div>

        <div class="settings-card">
          <h2>Appearance</h2>
          <div class="row">
            <button class="btn ${theme === 'light' ? 'primary' : 'ghost'}"
              onClick=${() => onTheme('light')}>☀️ Light</button>
            <button class="btn ${theme === 'dark' ? 'primary' : 'ghost'}"
              onClick=${() => onTheme('dark')}>🌙 Dark</button>
          </div>
        </div>

        <div class="settings-card">
          <h2>About</h2>
          <p class="hint">
            Paper Deck keeps structured fields in your Notion database, PDFs in
            your R2 bucket, and ink annotations on this device (IndexedDB).
            Install it to your home screen for a full-screen reading app.
          </p>
        </div>
      </div>
    </div>`;
}

/* -------------------------------------------------------------------- App */

function App() {
  const [route, setRoute] = useState(getWorkerUrl() ? 'library' : 'settings');
  const [papers, setPapers] = useState([]);
  const [current, setCurrent] = useState(null);
  const [prefill, setPrefill] = useState(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [theme, setTheme] = useState(
    localStorage.getItem('pd_theme') ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('pd_theme', theme);
  }, [theme]);

  const toastTimer = useRef(null);
  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2600);
  }, []);

  const refresh = useCallback(async (silent = false) => {
    if (!getWorkerUrl()) return;
    if (!silent) setLoading(true);
    try {
      const { papers } = await api('/papers');
      setPapers(papers);
    } catch (e) {
      if (!silent) showToast(`Could not load library: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  // load on launch, on window focus, and every 5 minutes
  useEffect(() => {
    refresh();
    const onFocus = () => refresh(true);
    const onVis = () => document.visibilityState === 'visible' && refresh(true);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    const timer = setInterval(() => refresh(true), 5 * 60 * 1000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(timer);
    };
  }, [refresh]);

  // Web Share Target payload → Add view, pre-filled
  useEffect(() => {
    consumeSharePayload().then((payload) => {
      if (!payload) return;
      const { meta, file } = payload;
      const sharedUrl =
        meta.url ||
        (meta.text || '').match(/https?:\/\/\S+/)?.[0] ||
        (meta.title || '').match(/https?:\/\/\S+/)?.[0] || '';
      const arxivId = extractArxivId(sharedUrl) || extractArxivId(meta.text);
      setPrefill({
        title: arxivId ? '' : (meta.title || ''),
        arxiv_link: arxivId ? `https://arxiv.org/abs/${arxivId}` : (sharedUrl || ''),
        tags: [],
        _file: file || undefined,
      });
      setRoute('add');
    });
  }, []);

  const allTags = useMemo(() => {
    const s = new Set(STARTER_TAGS);
    papers.forEach((p) => (p.tags || []).forEach((t) => s.add(t)));
    return [...s];
  }, [papers]);

  // Known option lists for custom select / multi_select columns, gathered
  // across all papers, so those fields render as pickers instead of free text.
  const extraOptions = useMemo(() => {
    const acc = {};
    for (const p of papers) {
      for (const [name, f] of Object.entries(p.extra || {})) {
        if (f.type !== 'select' && f.type !== 'multi_select') continue;
        const set = (acc[name] ||= new Set());
        if (f.type === 'select' && f.value) set.add(f.value);
        if (f.type === 'multi_select') (f.value || []).forEach((v) => set.add(v));
      }
    }
    const out = {};
    for (const k of Object.keys(acc)) out[k] = [...acc[k]];
    return out;
  }, [papers]);

  const removePaper = useCallback(async (p) => {
    try {
      await api(`/papers/${p.id}`, { method: 'DELETE' });
      setPapers((l) => l.filter((x) => x.id !== p.id));
      setCurrent((c) => (c && c.id === p.id ? null : c));
      showToast('Removed ✓');
    } catch (e) {
      showToast(`Could not remove: ${e.message}`);
    }
  }, [showToast]);

  const openPaper = (p) => { setCurrent(p); setRoute('reader'); };
  const applyPatch = useCallback((id, fields) => {
    setPapers((list) => list.map((p) => {
      if (p.id !== id) return p;
      const merged = { ...p, ...fields };
      if (fields.extra) merged.extra = { ...p.extra, ...fields.extra };
      return merged;
    }));
  }, []);

  const nav = (name, label) => html`
    <button class=${route === name ? 'active' : ''} onClick=${() => {
      setPrefill(null); setRoute(name);
    }}>${label}</button>`;

  return html`
    <div class="topbar">
      <span class="brand">📚 Paper Deck</span>
      <nav class="nav">
        ${nav('library', 'Library')}
        ${nav('add', 'Add')}
        ${nav('settings', 'Settings')}
      </nav>
      <button class="iconbtn" title="Toggle theme"
        onClick=${() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
        ${theme === 'dark' ? '☀️' : '🌙'}
      </button>
    </div>
    ${route === 'library' && html`
      <${Library} papers=${papers} loading=${loading}
        onOpen=${openPaper} onRefresh=${() => refresh()} onDelete=${removePaper} />`}
    ${route === 'reader' && current && html`
      <${Reader} paper=${current} onPatch=${applyPatch} showToast=${showToast}
        allTags=${allTags} extraOptions=${extraOptions} />`}
    ${route === 'add' && html`
      <${AddView} key=${prefill ? 'prefilled' : 'blank'} prefill=${prefill}
        showToast=${showToast}
        onCreated=${(paper) => {
          setPapers((l) => [paper, ...l]);
          setPrefill(null);
          setRoute('library');
        }} />`}
    ${route === 'settings' && html`
      <${Settings} theme=${theme} onTheme=${setTheme} showToast=${showToast} />`}
    ${toast && html`<div class="toast">${toast}</div>`}
  `;
}

createRoot(document.getElementById('root')).render(html`<${App} />`);
