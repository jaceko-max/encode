/* Encode — personal active-learning tutor (public web version).
   Data lives in this browser (IndexedDB, via public-api.js). AI runs on Google Gemini through the site's edge function. */
'use strict';

// ───────────────────────── utils ─────────────────────────
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const DAY = 86400000;
const dayKey = (d = new Date()) => d.toLocaleDateString('en-CA');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => Math.round((x || 0) * 100);
function md(text) {
  try { return DOMPurify.sanitize(marked.parse(String(text || ''), { breaks: true })); }
  catch { return esc(text).replace(/\n/g, '<br>'); }
}
const STOP = new Set('the a an and or of to in on for with is are was were be by as at it its that this from into than then which who what when how why your you their they them our not but can will has have had do does did'.split(' '));
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function words(s) { return norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)); }
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function similar(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if ((b.includes(a) && a.length >= 4) || (a.includes(b) && b.length >= 4)) return 0.9;
  return 1 - lev(a, b) / Math.max(a.length, b.length);
}
/** Share of the key words in `target` that appear (fuzzily) in `attempt`. */
function coverage(attempt, target) {
  const tw = [...new Set(words(target))];
  if (!tw.length) return 0;
  const aw = words(attempt);
  let hit = 0;
  for (const w of tw) if (aw.some((x) => x === w || (w.length > 4 && x.length > 4 && (x.startsWith(w.slice(0, 5)) || lev(x, w) <= 1)))) hit++;
  return hit / tw.length;
}
function fmtDue(ts) {
  const d = ts - Date.now();
  if (d <= 0) return 'now';
  if (d < 3600e3) return `in ${Math.max(1, Math.round(d / 60e3))} min`;
  if (d < DAY) return `in ${Math.round(d / 3600e3)} h`;
  const n = Math.round(d / DAY); return `in ${n} day${n > 1 ? 's' : ''}`;
}
function b64FromBuffer(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ───────────────────────── storage ─────────────────────────
// Saved privately in this browser by public-api.js (each visitor has their own notebooks).
const DB = {
  failed: false,
  async call(path, body) {
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      if (this.failed) { this.failed = false; toast('Saving works again ✓'); }
      return j;
    } catch (e) {
      if (!this.failed) toast('Couldn’t save in this browser (private mode or storage full?). Your last change may be lost.', 'err');
      this.failed = true; throw e;
    }
  },
  async load() { const r = await fetch('/api/data', { cache: 'no-store' }); if (!r.ok) throw new Error('load failed'); return r.json(); },
  async get(store, k) { if (store === 'visuals') return (await fetch(`/api/visuals/${encodeURIComponent(k)}`, { cache: 'no-store' })).json(); },
  async all(store) {
    if (store !== 'visuals') return [];
    const ids = S.notebooks.flatMap((n) => n.sources.filter((x) => x.images).map((x) => x.id));
    return (await Promise.all(ids.map((id) => this.get('visuals', id)))).filter((v) => v.items?.length);
  },
  async put(store, v) {
    if (store === 'notebooks') return this.call('/api/nb/save', { nb: v });
    if (store === 'meta') return this.call('/api/meta/save', { meta: v });
    if (store === 'visuals') return this.call('/api/visuals/save', { rec: v });
  },
  async del(store, k) {
    if (store === 'notebooks') return this.call('/api/nb/delete', { id: k });
    if (store === 'visuals') return this.call('/api/visuals/delete', { id: k });
  },
};

// One-time move of notebooks that were stored in this browser (before Encode saved to the Mac).
const BrowserDB = {
  open() {
    return new Promise((res) => {
      let done = false; const finish = (v) => { if (!done) { done = true; res(v); } };
      setTimeout(() => finish(null), 4000); // another old tab blocking it: skip this time, try next load
      try {
        const r = indexedDB.open('encode', 2);
        r.onupgradeneeded = () => {
          const d = r.result;
          for (const [name, keyPath] of [['notebooks', 'id'], ['meta', 'key'], ['visuals', 'id']]) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath });
        };
        r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); finish(r.result); };
        r.onerror = () => finish(null); r.onblocked = () => finish(null);
      } catch { finish(null); }
    });
  },
  req(db, store, fn) { return new Promise((res) => { try { const q = fn(db.transaction(store, 'readonly').objectStore(store)); q.onsuccess = () => res(q.result); q.onerror = () => res(null); } catch { res(null); } }); },
};
async function migrateFromBrowser() {
  return; // web version: nothing to move
  try { if (localStorage.getItem('encode-moved-to-mac')) return; } catch { return; }
  const db = await BrowserDB.open(); if (!db) return;
  const local = (await BrowserDB.req(db, 'notebooks', (st) => st.getAll())) || [];
  let moved = 0;
  for (const nb of local) {
    const remote = getNb(nb.id);
    if (remote && (remote.updated || 0) >= (nb.updated || 0)) continue;
    for (const src of nb.sources || []) {
      const v = await BrowserDB.req(db, 'visuals', (st) => st.get(src.id));
      if (v) await DB.put('visuals', v);
    }
    await DB.put('notebooks', nb);
    if (remote) S.notebooks[S.notebooks.indexOf(remote)] = nb; else S.notebooks.push(nb);
    moved++;
  }
  const lm = await BrowserDB.req(db, 'meta', (st) => st.get('stats'));
  if (lm) {
    S.meta.xp = Math.max(S.meta.xp || 0, lm.xp || 0);
    for (const [k, v] of Object.entries(lm.days || {})) S.meta.days[k] = Math.max(S.meta.days[k] || 0, v);
    await DB.put('meta', S.meta);
  }
  db.close();
  try { localStorage.setItem('encode-moved-to-mac', String(Date.now())); } catch { /* private mode */ }
  if (moved) toast(`Moved ${moved} notebook${moved > 1 ? 's' : ''} into your Encode folder on this Mac ✓`);
}

// ───────────────────────── state ─────────────────────────
const S = { status: { claude: false, gemini: false, local: true }, meta: { key: 'stats', xp: 0, days: {} }, notebooks: [] };
const UI = {}; // transient per-view state (not saved)
const getNb = (id) => S.notebooks.find((n) => n.id === id);

function newNotebook(title = 'Untitled notebook', course = '') {
  return {
    id: uid(), title, course, created: Date.now(), updated: Date.now(),
    sources: [], digest: null, cards: [], conceptStats: {}, pretest: { done: false, answers: [] },
    illustrations: {}, feynman: {}, chat: [], exams: [], videos: [], seenExamQs: [], progress: { learn: false, reviews: 0 },
  };
}
async function save(nb) { nb.updated = Date.now(); await DB.put('notebooks', nb); pushSummary(); }
async function saveMeta() { await DB.put('meta', S.meta); pushSummary(); }

// Small study snapshot for Jace's Dashboard (it can't read this browser's storage itself).
let summaryTimer = null;
function pushSummary() {
  clearTimeout(summaryTimer);
  summaryTimer = setTimeout(() => {
    const nbs = [...S.notebooks].sort((a, b) => dueCards(b).length - dueCards(a).length || b.updated - a.updated);
    const weak = nbs.flatMap((nb) => weakConcepts(nb, 3).map((w) => ({ concept: w.c.name, cid: w.c.id, notebook: nb.title, nb: nb.id, mastery: Math.round(w.m * 100) })))
      .sort((a, b) => a.mastery - b.mastery).slice(0, 3);
    const nextDue = nbs.flatMap((nb) => nb.cards.map((c) => c.srs.due)).filter((t) => t > Date.now()).sort((a, b) => a - b)[0] || null;
    const body = {
      updated: Date.now(), streak: streak(), studiedToday: !!S.meta.days[dayKey()], xp: S.meta.xp, level: level(),
      due: nbs.reduce((a, n) => a + dueCards(n).length, 0), nextDue,
      days: Object.keys(S.meta.days).sort().slice(-90),
      notebooks: nbs.slice(0, 6).map((nb) => ({ id: nb.id, title: nb.title, course: nb.course, due: dueCards(nb).length, dues: nb.cards.map((c) => c.srs.due), mastery: Math.round(nbMastery(nb) * 100), next: nextStep(nb).label, nextTab: nextStep(nb).tab })),
      weak,
    };
    fetch('/api/summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  }, 1200);
}

// XP, levels, streaks
const LEVEL_XP = 250;
function level() { return Math.floor(S.meta.xp / LEVEL_XP) + 1; }
function streak() {
  let n = 0; const d = new Date();
  if (!S.meta.days[dayKey(d)]) d.setDate(d.getDate() - 1); // today not studied yet → count up to yesterday
  while (S.meta.days[dayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
async function gainXP(n, label) {
  if (!n) return;
  const before = level(); const k = dayKey();
  const wasFirstToday = !S.meta.days[k];
  S.meta.xp += n; S.meta.days[k] = (S.meta.days[k] || 0) + n;
  await saveMeta();
  toast(`+${n} XP${label ? ' · ' + label : ''}`, 'xp');
  if (wasFirstToday && streak() > 1) setTimeout(() => toast(`🔥 ${streak()}-day streak!`), 600);
  if (level() > before) setTimeout(() => { toast(`⭐ Level ${level()} reached!`, 'xp'); confetti(); }, 900);
  renderTop();
}

// Concept mastery (fed by every graded attempt in every mode)
function record(nb, cid, ok) {
  if (!cid) return;
  const st = (nb.conceptStats[cid] ||= { right: 0, attempts: 0, last: 0 });
  st.attempts++; st.right += ok; st.last = Date.now();
}
function mastery(nb, cid) {
  const st = nb.conceptStats[cid];
  if (!st || !st.attempts) return null;
  return (st.right + 0.5) / (st.attempts + 1); // gently smoothed
}
function nbMastery(nb) {
  const cs = nb.digest?.concepts || []; if (!cs.length) return 0;
  return cs.reduce((a, c) => a + (mastery(nb, c.id) ?? 0), 0) / cs.length;
}
function weakConcepts(nb, limit = 99) {
  return (nb.digest?.concepts || []).map((c) => ({ c, m: mastery(nb, c.id) }))
    .filter((x) => x.m !== null && x.m < 0.7).sort((a, b) => a.m - b.m).slice(0, limit);
}
const conceptName = (nb, id) => nb.digest?.concepts.find((c) => c.id === id)?.name || '';
const dueCards = (nb) => nb.cards.filter((c) => c.srs.due <= Date.now());
const aiSources = (nb) => nb.sources.map((s) => ({ name: s.name, kind: s.kind, text: s.text }));

// Spaced repetition (SM-2 style). q: 5 perfect … 0 blank.
function newSrs() { return { due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0 }; }
function schedule(card, verdict, conf = null) {
  let q = verdict === 'correct' ? 5 : verdict === 'partial' ? 3 : 1;
  if (verdict === 'correct' && conf === 'guess') q = 3; // a lucky guess isn't learned yet
  else if (verdict === 'correct' && conf === 'unsure') q = 4;
  const s = card.srs;
  if (q < 3) { s.reps = 0; s.lapses++; s.interval = 0; s.due = Date.now() + 10 * 60e3; }
  else {
    s.reps++;
    s.interval = s.reps === 1 ? (q === 3 ? 1 : 2) : s.reps === 2 ? (q === 3 ? 3 : 6) : Math.round(s.interval * s.ease * (q === 3 ? 0.8 : 1));
    s.due = Date.now() + s.interval * DAY;
  }
  s.ease = Math.max(1.3, s.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  card.history.push({ t: Date.now(), v: verdict, c: conf });
}

// ───────────────────────── API ─────────────────────────
async function api(path, body, method = 'POST') {
  const r = await fetch(path, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({ error: `Server error (${r.status})` }));
  if (!r.ok || j.error) { const e = new Error(j.error || `HTTP ${r.status}`); e.code = j.code; throw e; }
  return j;
}
const ai = (task, body) => api(`/api/ai/${task}`, body);
function aiError(e) {
  toast(e.message, 'err');
  if (e.code === 'no_key') openSettings();
}
async function refreshStatus() {
  try { S.status = await api('/api/status', null, 'GET'); } catch { S.status = { claude: false, gemini: false, local: true, offline: true }; }
  renderBanner();
}

// ───────────────────────── chrome: top bar, toasts, modal ─────────────────────────
function renderTop() {
  const xpIn = S.meta.xp % LEVEL_XP;
  $('#topStats').innerHTML = `
    <span class="chip" title="Study streak">🔥 ${streak()}</span>
    <span class="chip" title="${S.meta.xp} XP total">⭐ Lv ${level()} <span class="bar"><i style="width:${pct(xpIn / LEVEL_XP)}%"></i></span></span>`;
}
function renderBanner() {
  const st = S.status;
  let msg = '';
  if (st.edgeOffline) msg = 'Can’t reach the AI service right now. Your notebooks and cards still work; try the AI again later.';
  else if (!st.claude) msg = 'The AI tutor needs a free Gemini key. Add yours in Settings (it takes a minute). Until then you can explore the sample lecture and grade yourself.';
  $('#banner').innerHTML = msg ? `<div class="banner"><div class="card"><span>⚠️</span><span class="spacer small">${msg}</span><button class="btn sm" data-act="settings">Settings</button></div></div>` : '';
}
function toast(text, kind = '', action = null) {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = text;
  if (action) {
    const b = document.createElement('button'); b.className = 'toast-act'; b.textContent = action.label;
    b.onclick = () => { el.remove(); action.fn(); }; el.appendChild(b);
  }
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), action ? 9000 : kind === 'err' ? 6000 : 2600);
}
function modal(html, wide = false) {
  const m = $('#modal'); m.innerHTML = `<div class="box ${wide ? 'wide' : ''}">${html}</div>`; m.classList.remove('hidden');
  return m;
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal').innerHTML = ''; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && !e.shiftKey && e.target.matches?.('#modal input[type=text], #modal input:not([type])')) {
    const btn = $('#modal .btn.primary'); if (btn) { e.preventDefault(); btn.click(); }
  }
});

// ───────────────────────── routing ─────────────────────────
function route() {
  const p = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (p[0] === 'nb' && p[1]) return { view: 'nb', id: p[1], tab: p[2] || '', arg: p[3] || '' };
  if (p[0] === 'course' && p[1]) return { view: 'course', course: p[1] };
  return { view: 'home' };
}
const go = (h) => { if (location.hash === h) render(); else location.hash = h; };
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

function render() {
  renderTop();
  const r = route();
  if (r.view === 'nb') {
    const nb = getNb(r.id);
    if (!nb) return go('#/');
    return renderNotebook(nb, r.tab || nextStep(nb).tab, r.arg);
  }
  if (r.view === 'course') return renderCourse(r.course);
  renderHome();
}

// ───────────────────────── actions (event delegation) ─────────────────────────
const ACT = {};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const fn = ACT[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});

// ───────────────────────── appearance: theme + background photo ─────────────────────────
// Photos: Wikimedia Commons (free licenses; credit shown in the corner and in Settings).
const BGS = [{"id": "grid", "name": "Grid", "css": "grid-floor"}];
const LOOK_KEY = 'encode-look';
const LOOK = { theme: 'dark', bg: 'grid', strength: 'balanced' }; // fixed look: black grid background
const thumbUrl = (b) => b.url.replace('/1920px-', '/960px-');
function applyLook() {
  const root = document.documentElement;
  if (LOOK.theme === 'auto') root.removeAttribute('data-theme'); else root.dataset.theme = LOOK.theme;
  root.dataset.strength = LOOK.strength;
  const b = BGS.find((x) => x.id === LOOK.bg);
  let layer = document.getElementById('bgLayer');
  if (!layer) {
    layer = document.createElement('div'); layer.id = 'bgLayer'; layer.className = 'bg-layer'; layer.setAttribute('aria-hidden', 'true');
    document.body.prepend(layer);
    const veil = document.createElement('div'); veil.className = 'bg-veil'; veil.setAttribute('aria-hidden', 'true'); layer.after(veil);
  }
  let credit = document.getElementById('bgCredit');
  if (!credit) { credit = document.createElement('a'); credit.id = 'bgCredit'; credit.className = 'bg-credit'; credit.target = '_blank'; credit.rel = 'noopener'; document.body.appendChild(credit); }
  root.classList.toggle('has-photo', !!b);
  root.classList.toggle('grid-bg', !!b?.css);
  layer.classList.toggle('grid-floor', b?.css === 'grid-floor');
  if (!b || b.css) { layer.style.backgroundImage = ''; layer.dataset.bg = b ? b.id : ''; layer.classList.toggle('ready', !!b); credit.hidden = true; return; }
  credit.hidden = false; credit.href = b.page;
  credit.textContent = `Photo: ${b.by}${b.license && b.license !== 'Public domain' ? ' · ' + b.license : ''}`;
  layer.style.backgroundPosition = b.pos || 'center';
  if (layer.dataset.bg === b.id) return;
  layer.dataset.bg = b.id; layer.classList.remove('ready');
  const img = new Image();
  img.onload = () => { if (layer.dataset.bg !== b.id) return; layer.style.backgroundImage = `url("${b.url}")`; requestAnimationFrame(() => layer.classList.add('ready')); };
  img.src = b.url;
}
function saveLook() { try { localStorage.setItem(LOOK_KEY, JSON.stringify(LOOK)); } catch { /* private mode */ } applyLook(); }
function lookSection() {
  const seg = (act, cur, opts) => `<div class="seg">${opts.map(([v, l]) => `<button type="button" class="${cur === v ? 'on' : ''}" data-act="${act}" data-v="${v}">${l}</button>`).join('')}</div>`;
  return `<div class="look" id="lookBox">
    <h3 style="margin:0">Appearance</h3>
    <div class="row between"><span class="small muted">Theme</span>${seg('look-theme', LOOK.theme, [['auto', 'Auto'], ['light', '☀️ Light'], ['dark', '🌙 Dark']])}</div>
    <div class="small muted">Background</div>
    <div class="bg-grid">
      <button type="button" class="bg-opt plain ${LOOK.bg === 'none' ? 'on' : ''}" data-act="look-bg" data-v="none"><span>Plain</span></button>
      ${BGS.map((b) => b.css
        ? `<button type="button" class="bg-opt grid-thumb ${LOOK.bg === b.id ? 'on' : ''}" data-act="look-bg" data-v="${b.id}" title="${esc(b.name)}"><span>${esc(b.name)}</span></button>`
        : `<button type="button" class="bg-opt ${LOOK.bg === b.id ? 'on' : ''}" data-act="look-bg" data-v="${b.id}" title="${esc(b.name)}" style="background-image:url('${thumbUrl(b)}');background-position:${b.pos}"><span>${esc(b.name)}</span></button>`).join('')}
    </div>
    ${LOOK.bg !== 'none' && !BGS.find((x) => x.id === LOOK.bg)?.css ? `<div class="row between"><span class="small muted">Photo strength</span>${seg('look-strength', LOOK.strength, [['subtle', 'Subtle'], ['balanced', 'Balanced'], ['vivid', 'Vivid']])}</div>
      <div class="small muted">${(() => { const b = BGS.find((x) => x.id === LOOK.bg); return b ? `“${esc(b.name)}” by ${esc(b.by)} (${esc(b.license)}), <a href="${b.page}" target="_blank" rel="noopener">Wikimedia Commons</a>` : ''; })()}</div>` : ''}
  </div>`;
}
function refreshLook() { const el = document.getElementById('lookBox'); if (el) el.outerHTML = lookSection(); }
ACT['look-theme'] = (el) => { LOOK.theme = el.dataset.v; saveLook(); refreshLook(); };
ACT['look-bg'] = (el) => { LOOK.bg = el.dataset.v; saveLook(); refreshLook(); };
ACT['look-strength'] = (el) => { LOOK.strength = el.dataset.v; saveLook(); refreshLook(); };
applyLook();

// ═════════════════════════ HOME ═════════════════════════
function renderHome() {
  const nbs = [...S.notebooks].sort((a, b) => b.updated - a.updated);
  const due = nbs.reduce((a, n) => a + dueCards(n).length, 0);
  const avgM = nbs.filter((n) => n.digest).map(nbMastery);
  const weak = nbs.flatMap((nb) => weakConcepts(nb, 6).map((w) => ({ ...w, nb }))).sort((a, b) => a.m - b.m).slice(0, 6);
  const week = [...Array(7)].map((_, i) => { const d = new Date(Date.now() - (6 - i) * DAY); return { k: dayKey(d), l: d.toLocaleDateString('en-US', { weekday: 'narrow' }) }; });
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  $('#view').innerHTML = `
  <section class="hero">
    <div class="card overview">
      <h1>${greet} 👋</h1>
      <p class="muted">Add a lecture, see it as pictures and maps, then pull it back out of your head. Retrieval is what makes it stick.</p>
      <p class="small muted" style="margin:-4px 0 12px">🔒 Free, no account. Your notebooks stay private in this browser on this device. Back them up anytime in ⚙︎ Settings.</p>
      <div class="row">
        ${due ? `<button class="btn primary lg" data-act="review-all">Review ${due} due card${due > 1 ? 's' : ''}</button>` : ''}
        <button class="btn ${due ? '' : 'primary lg'}" data-act="new-nb">＋ New notebook</button>
        ${nbs.some((n) => n.sample) ? '' : '<button class="btn ghost" data-act="sample">Try a sample lecture</button>'}
      </div>
    </div>
    <div class="card">
      <div class="stat-grid">
        <div class="stat"><b>🔥 ${streak()}</b><span>day streak</span></div>
        <div class="stat"><b>⭐ ${level()}</b><span>level · ${S.meta.xp} XP</span></div>
        <div class="stat"><b>${due}</b><span>cards due</span></div>
        <div class="stat"><b>${avgM.length ? pct(avgM.reduce((a, b) => a + b, 0) / avgM.length) + '%' : '—'}</b><span>avg mastery</span></div>
      </div>
      <div class="week">${week.map((d) => `<div class="d ${S.meta.days[d.k] ? 'on' : ''} ${d.k === dayKey() ? 'today' : ''}" title="${d.k}: ${S.meta.days[d.k] || 0} XP"><i></i>${d.l}</div>`).join('')}</div>
    </div>
  </section>

  ${(() => {
    const courses = [...new Set(nbs.filter((n) => n.digest).map((n) => n.course || 'Other'))].map((c) => ({ c, list: courseNotebooks(c) })).filter((x) => x.list.length > 1);
    return courses.length ? `<section class="section"><h2>📚 Courses</h2><p class="muted small">Cumulative exam coming? Review every lecture in a course mixed together.</p><div class="grid">${courses.map(({ c, list }) => {
      const due = list.reduce((a, n) => a + dueCards(n).length, 0); const m = list.reduce((a, n) => a + nbMastery(n), 0) / list.length;
      return `<a class="card nb-card" href="#/course/${encodeURIComponent(c)}" style="color:inherit"><h3>${esc(c)}</h3><div class="meta"><span>📄 ${list.length} lectures</span><span>🧠 ${due} due</span><span>🎯 ${pct(m)}%</span></div><div class="meter"><i style="width:${pct(m)}%"></i></div><div class="small" style="color:var(--accent);font-weight:600">Mixed review →</div></a>`; }).join('')}</div></section>` : '';
  })()}

  <section class="section">
    <div class="row between"><h2>Your notebooks</h2></div>
    ${nbs.length ? `<div class="grid">${nbs.map(nbCard).join('')}</div>` : `
      <div class="card empty"><div class="big">📚</div><h3>No notebooks yet</h3>
      <p class="muted">A notebook = one lecture or topic. Add slides, PDFs, notes, photos or links to it.</p>
      <div class="row" style="justify-content:center"><button class="btn primary" data-act="new-nb">Create your first notebook</button><button class="btn" data-act="sample">Try the sample</button></div></div>`}
  </section>

  ${weak.length ? `<section class="section"><h2>🎯 Weak spots</h2><p class="muted small">Concepts you’ve missed most. Drilling these is the fastest way to raise your score.</p>
    <div class="card flat bars">${weak.map((w) => `<div class="b"><div><b>${esc(w.c.name)}</b><div class="small muted">${esc(w.nb.title)}</div></div>
      <div class="meter"><i style="width:${pct(w.m)}%"></i></div><span class="small">${pct(w.m)}%</span>
      <a class="btn sm" href="#/nb/${w.nb.id}/recall/${w.c.id}">Drill</a></div>`).join('')}</div></section>` : ''}`;
}
function nbCard(nb) {
  const due = dueCards(nb).length; const step = nextStep(nb);
  return `<div class="card nb-card" data-act="open-nb" data-id="${nb.id}">
    <div class="row between"><span class="tag accent">${esc(nb.course || 'Lecture')}</span><span class="row" style="gap:6px">${due ? `<span class="tag warn">${due} due</span>` : ''}<button class="nb-del" data-act="del-nb" data-id="${nb.id}" title="Delete this notebook" aria-label="Delete ${esc(nb.title)}">🗑</button></span></div>
    <h3>${esc(nb.title)}</h3>
    <div class="meta"><span>📄 ${nb.sources.length} source${nb.sources.length === 1 ? '' : 's'}</span><span>🧠 ${nb.cards.length} cards</span><span>🎯 ${pct(nbMastery(nb))}% mastery</span></div>
    <div class="meter"><i style="width:${pct(nbMastery(nb))}%"></i></div>
    <div class="small" style="color:var(--accent);font-weight:600">Next: ${esc(step.label)} →</div>
  </div>`;
}
ACT['open-nb'] = (el) => go(`#/nb/${el.dataset.id}`);
ACT['new-nb'] = () => {
  modal(`<h2>New notebook</h2><p class="muted small">One notebook per lecture or topic works best.</p>
    <div class="stack"><label class="field"><span>Lecture / topic</span><input type="text" id="nbTitle" placeholder="e.g. Lecture 14 — Cardiac Cycle"></label>
    <label class="field"><span>Course (optional)</span><input type="text" id="nbCourse" placeholder="e.g. A&P II" list="courseList"></label>
    <datalist id="courseList">${[...new Set(S.notebooks.map((n) => n.course).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-act="create-nb">Create</button></div></div>`);
  setTimeout(() => $('#nbTitle')?.focus(), 30);
};
ACT['create-nb'] = async () => {
  const nb = newNotebook($('#nbTitle').value.trim() || 'Untitled notebook', $('#nbCourse').value.trim());
  S.notebooks.push(nb); await save(nb); closeModal(); go(`#/nb/${nb.id}/sources`);
};
ACT['close-modal'] = closeModal;
ACT.sample = async () => {
  const s = window.ENCODE_SAMPLE;
  const nb = newNotebook(s.title, s.course); nb.sample = true;
  nb.sources = s.sources.map((x) => ({ ...x, id: uid(), added: Date.now(), chars: x.text.length }));
  applyDigest(nb, structuredClone(s.digest));
  S.notebooks.push(nb); await save(nb); toast('Sample lecture added'); go(`#/nb/${nb.id}/pretest`);
};
ACT['review-all'] = () => {
  const nb = [...S.notebooks].sort((a, b) => dueCards(b).length - dueCards(a).length)[0];
  if (nb) go(`#/nb/${nb.id}/recall`);
};

// ───────────────────────── line icons (tabs) ─────────────────────────
const ICON_PATHS = {
  sources: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  pretest: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  learn: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  videos: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/>',
  recall: '<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  teach: '<path d="M3 4h18M5 4v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4M12 16v4M8 20h8"/>',
  tutor: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/>',
  exam: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="m9 13 2 2 4-4"/>',
  progress: '<path d="M3 20h18M7 16v-5M12 16V6M17 16v-8"/>',
};
const icon = (k) => ICON_PATHS[k] ? `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[k]}</svg>` : '';

// Small celebration for a strong session or a new level (skipped when "reduce motion" is on).
function confetti() {
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch { /* old browser */ }
  const box = document.createElement('div'); box.className = 'confetti'; box.setAttribute('aria-hidden', 'true');
  const colors = ['#8b5cf6', '#22d3ee', '#ec4899', '#facc15', '#4ade80'];
  for (let i = 0; i < 70; i++) {
    const p = document.createElement('i');
    p.style.left = `${Math.random() * 100}vw`; p.style.background = colors[i % colors.length];
    p.style.animationDelay = `${Math.random() * 0.35}s`; p.style.animationDuration = `${1.4 + Math.random() * 0.8}s`;
    p.style.setProperty('--dx', `${Math.round(Math.random() * 200 - 100)}px`); p.style.setProperty('--r', `${Math.round(Math.random() * 900 - 450)}deg`);
    box.appendChild(p);
  }
  document.body.appendChild(box); setTimeout(() => box.remove(), 2600);
}

// ═════════════════════════ NOTEBOOK SHELL ═════════════════════════
const TABS = [
  ['sources', '📄 Sources'], ['pretest', '🤔 Pretest'], ['learn', '🖼️ Learn'], ['videos', '🎬 Videos'], ['recall', '🧠 Recall'],
  ['teach', '🗣️ Teach back'], ['tutor', '💬 Tutor'], ['exam', '📝 Exam'], ['progress', '📈 Progress'],
];
function pathSteps(nb) {
  return [
    { tab: 'sources', label: 'Add material', done: nb.sources.length > 0 },
    { tab: 'sources', label: 'Build kit', done: !!nb.digest },
    { tab: 'pretest', label: 'Pretest', done: nb.pretest.done },
    { tab: 'learn', label: 'Learn visually', done: nb.progress.learn },
    { tab: 'recall', label: 'Recall', done: nb.progress.reviews > 0 && dueCards(nb).length === 0 },
    { tab: 'teach', label: 'Teach back', done: Object.keys(nb.feynman).length > 0 },
    { tab: 'exam', label: 'Practice exam', done: nb.exams.length > 0 },
  ];
}
function nextStep(nb) { return pathSteps(nb).find((s) => !s.done) || { tab: dueCards(nb).length ? 'recall' : 'exam', label: dueCards(nb).length ? 'Review due cards' : 'Another practice exam' }; }

function renderNotebook(nb, tab, arg) {
  if (tab === 'learn' && nb.digest && !nb.progress.learn) { nb.progress.learn = true; save(nb); }
  const steps = pathSteps(nb); const next = nextStep(nb); const due = dueCards(nb).length;
  $('#view').innerHTML = `
    <div class="nb-head"><div style="flex:1;min-width:240px">
      <a href="#/" class="small">← All notebooks</a>
      <div><input class="nb-title-input" id="nbTitleEdit" value="${esc(nb.title)}" size="${Math.max(12, nb.title.length + 2)}" aria-label="Notebook title"></div>
      <div class="small muted">${esc(nb.course || '')}${nb.course ? ' · ' : ''}${pct(nbMastery(nb))}% mastery</div></div>
      <button class="btn sm ghost" data-act="del-nb" data-id="${nb.id}">🗑 Delete notebook</button>
    </div>
    <nav class="tabs">${TABS.map(([k, l]) => `<a href="#/nb/${nb.id}/${k}" class="${k === tab ? 'on' : ''}">${icon(k)}<span>${l.replace(/^\S+\s/, '')}</span>${k === 'recall' && due ? `<span class="badge">${due}</span>` : ''}${k === next.tab && k !== tab && !(k === 'recall' && due) ? `<span class="next-dot" title="Suggested next: ${esc(next.label)}"></span>` : ''}</a>`).join('')}</nav>
    <div id="tab"></div>`;
  $('#nbTitleEdit').addEventListener('change', async (e) => { nb.title = e.target.value.trim() || 'Untitled notebook'; await save(nb); });
  const needsKit = ['pretest', 'learn', 'videos', 'recall', 'teach', 'exam', 'progress'].includes(tab) && !nb.digest;
  const el = $('#tab');
  if (needsKit) return renderNeedKit(nb, el);
  ({ sources: renderSources, pretest: renderPretest, learn: renderLearn, videos: renderVideos, recall: renderRecall, teach: renderTeach, tutor: renderTutor, exam: renderExam, progress: renderProgress }[tab] || renderSources)(nb, el, arg);
}
function renderNeedKit(nb, el) {
  el.innerHTML = `<div class="card empty"><div class="big">✨</div><h3>Build your study kit first</h3>
    <p class="muted">${nb.sources.length ? 'You have material — turn it into visuals, questions and a concept map.' : 'Add your lecture slides, PDFs, notes, photos or links.'}</p>
    <a class="btn primary" href="#/nb/${nb.id}/sources">${nb.sources.length ? 'Build the kit' : 'Add material'}</a></div>`;
}
ACT['del-nb'] = async (el) => {
  const nb = getNb(el?.dataset?.id || route().id); if (!nb) return;
  UI.delNb = nb.id;
  modal(`<h2>Delete “${esc(nb.title)}”?</h2><p class="muted">Its sources, cards and progress are removed from this browser. You’ll get an <b>Undo</b> button for a few seconds; after that it can’t be brought back (unless you exported a backup).</p>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-act="close-modal">Cancel</button><button class="btn bad" data-act="del-nb-yes">Delete</button></div>`);
};
ACT['del-nb-yes'] = async () => {
  const id = UI.delNb; const nb = getNb(id); if (!nb) return closeModal();
  try { await DB.del('notebooks', id); } catch { return; } // kept in the trash, restorable
  for (const s of nb.sources || []) VIS.delete(s.id);
  S.notebooks = S.notebooks.filter((n) => n.id !== id); closeModal(); pushSummary();
  if (route().view === 'home' || !location.hash || location.hash === '#/') render(); else go('#/');
  toast(`Deleted “${nb.title}”`, '', { label: 'Undo', fn: async () => {
    try { const r = await DB.call('/api/nb/restore', { id }); S.notebooks.push(r.nb); pushSummary(); render(); toast('Restored ✓'); } catch { /* toast shown */ }
  } });
};

// ═════════════════════════ SOURCES ═════════════════════════
const KIND_ICON = { pdf: '📕', pptx: '📊', docx: '📘', text: '📝', image: '🖼️', web: '🌐', youtube: '▶️', guide: '📋' };
function renderSources(nb, el) {
  const ing = UI.ingest || [];
  const totalChars = nb.sources.reduce((a, s) => a + s.text.length, 0);
  const stale = nb.digest && nb.sources.some((s) => s.added > (nb.builtAt || 0));
  if (UI.building === nb.id) return renderBuilding(el);
  el.innerHTML = `
  <div class="stack">
    ${nb.sources.length ? `<div class="card overview row between">
      <div><h3 style="margin:0">${nb.digest ? (stale ? 'New material added' : 'Study kit ready ✓') : 'Ready to build your study kit'}</h3>
      <div class="small muted">${nb.sources.length} source(s) · ~${Math.round(totalChars / 5).toLocaleString()} words${nb.digest ? ` · ${nb.digest.concepts.length} concepts · ${nb.cards.length} recall cards` : ''}</div></div>
      ${nb.digest && !stale ? `<div class="row"><button class="btn" data-act="build">↻ Rebuild</button><a class="btn primary" href="#/nb/${nb.id}/${nextStep(nb).tab}">Continue → ${esc(nextStep(nb).label)}</a></div>`
        : `<button class="btn primary lg" data-act="build">✨ ${nb.digest ? 'Rebuild' : 'Build'} study kit</button>`}
    </div>` : ''}

    <label class="drop" id="drop">
      <div class="big">⬆️</div>
      <b>Drop lecture files here</b> or click to choose
      <div class="small muted">PDF · PowerPoint (.pptx) · Word (.docx) · images/photos · .txt/.md</div>
      <input type="file" id="fileIn" multiple accept=".pdf,.pptx,.docx,.txt,.md,image/*" class="file-hidden">
    </label>
    <p class="small muted" style="margin:8px 0 0">Your material is sent to Google Gemini to build the kit. Please don’t upload anything private.</p>
    <label class="check small"><input type="checkbox" id="aiRead" ${S.status.claude ? 'checked' : 'disabled'}> Read diagrams & scanned pages in PDFs with AI (slower, captures figures)</label>
    ${ing.length ? `<div class="card tight">${ing.map((i) => `<div class="ingest-item">${i.status === 'work' ? '<span class="spinner"></span>' : i.status === 'ok' ? '✅' : '⚠️'}<span>${esc(i.name)}</span><span class="muted small">${esc(i.msg || '')}</span></div>`).join('')}</div>` : ''}

    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      <div class="card stack" style="grid-column:1/-1;border-color:var(--accent)"><h3>📋 Study guide / what’s on the exam <span class="tag accent">optional</span></h3>
        <p class="small muted" style="margin:0">Paste your professor’s study guide, learning objectives, review sheet or a past quiz. The kit and practice exams will focus on exactly these and make sure every objective is covered.</p>
        <textarea id="guideText" placeholder="e.g. 1. Describe the structure of a neuron and the function of each part. 2. Compare graded vs action potentials…">${esc(nb.sources.find((x) => x.kind === 'guide')?.text || '')}</textarea>
        <div class="row"><button class="btn" data-act="save-guide">${nb.sources.some((x) => x.kind === 'guide') ? 'Update study guide' : 'Save study guide'}</button>${nb.digest && nb.sources.some((x) => x.kind === 'guide' && x.added > (nb.builtAt || 0)) ? '<span class="small" style="color:var(--warn)">Rebuild the kit to apply it</span>' : ''}</div></div>
      <div class="card stack"><h3>📝 Paste notes or text</h3>
        <input type="text" id="pasteName" placeholder="Name (e.g. My notes, Ch. 18 summary)">
        <textarea id="pasteText" placeholder="Paste lecture notes, a transcript, textbook text…"></textarea>
        <button class="btn" data-act="add-paste">Add text</button></div>
      <div class="card stack"><h3>🌐 Add a web link or YouTube lecture</h3>
        <input type="url" id="urlIn" placeholder="https://…">
        <button class="btn" data-act="add-url">Fetch link</button>
        <p class="small muted">Articles are read as text. For a YouTube lecture, Gemini watches the video and writes timestamped study notes (about a minute).</p></div>
    </div>

    ${nb.sources.length ? `<div class="card flat" style="padding:0">${nb.sources.map((s) => `
      <div class="src"><span class="ic">${KIND_ICON[s.kind] || '📄'}</span>
        <div style="flex:1;min-width:0"><div class="nm">${esc(s.name)}</div><div class="small muted">${s.kind} · ${s.text.length.toLocaleString()} chars${s.images ? ` · 🖼️ ${s.images} picture${s.images === 1 ? '' : 's'}` : ['pdf', 'pptx'].includes(s.kind) && s.images === undefined ? ' · <span style="color:var(--warn)">no pictures yet: drop this file again to add them</span>' : ''}</div>
        ${UI.preview === s.id ? `<pre>${esc(s.text.slice(0, 6000))}${s.text.length > 6000 ? '\n…' : ''}</pre>` : ''}</div>
        <button class="btn sm ghost" data-act="preview-src" data-id="${s.id}">${UI.preview === s.id ? 'Hide' : 'Preview'}</button>
        <button class="btn sm ghost" data-act="del-src" data-id="${s.id}" aria-label="Remove">✕</button></div>`).join('')}</div>` : ''}
    ${totalChars > 700000 ? '<p class="small" style="color:var(--bad)">That’s a lot of material for one notebook. Splitting it into separate lectures gives better questions.</p>' : ''}
  </div>`;
  const drop = $('#drop'); const fileIn = $('#fileIn');
  fileIn.addEventListener('change', () => ingestFiles(nb, [...fileIn.files]));
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => ingestFiles(nb, [...e.dataTransfer.files]));
}
const curNb = () => getNb(route().id);
ACT['preview-src'] = (el) => { UI.preview = UI.preview === el.dataset.id ? null : el.dataset.id; render(); };
ACT['del-src'] = async (el) => {
  const nb = curNb(); const idx = nb.sources.findIndex((s) => s.id === el.dataset.id); const src = nb.sources[idx];
  const vis = await DB.get('visuals', src.id).catch(() => null);
  nb.sources.splice(idx, 1); VIS.delete(src.id); await save(nb); if (src.images) await DB.del('visuals', src.id).catch(() => {});
  render();
  toast(`Removed “${src.name}”`, '', { label: 'Undo', fn: async () => {
    nb.sources.splice(idx, 0, src); if (vis?.items?.length) await putVisuals(src.id, vis.numbering, vis.items); await save(nb); render(); toast('Restored ✓');
  } });
};
async function addSource(nb, name, kind, text, extra = {}) {
  text = String(text || '').replace(/\u0000/g, '').trim();
  if (!text) throw new Error('No readable text found');
  const src = { id: uid(), name, kind, text, chars: text.length, added: Date.now(), ...extra };
  nb.sources.push(src);
  if (nb.title === 'Untitled notebook') nb.title = name.replace(/\.[a-z0-9]+$/i, '');
  await save(nb);
  return src;
}
ACT['save-guide'] = async () => {
  const nb = curNb(); const text = $('#guideText').value.trim();
  const old = nb.sources.find((x) => x.kind === 'guide');
  if (!text) { if (old) { nb.sources = nb.sources.filter((x) => x !== old); await save(nb); toast('Study guide removed'); render(); } return; }
  if (old) { old.text = text; old.chars = text.length; old.added = Date.now(); await save(nb); }
  else await addSource(nb, 'Study guide', 'guide', text);
  toast(nb.digest ? 'Saved. Rebuild the kit to focus it on the guide.' : 'Study guide saved ✓'); render();
};
ACT['add-paste'] = async () => {
  const nb = curNb(); const text = $('#pasteText').value;
  if (!text.trim()) return toast('Paste some text first', 'err');
  await addSource(nb, $('#pasteName').value.trim() || 'Pasted notes', 'text', text); toast('Added'); render();
};
ACT['add-url'] = async (btn) => {
  const nb = curNb(); const url = $('#urlIn').value.trim(); if (!url) return;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Fetching…';
  try { const r = await api('/api/fetch', { url }); await addSource(nb, r.title, r.kind, r.text); toast('Link added'); }
  catch (e) { aiError(e); }
  render();
};

async function ingestFiles(nb, files) {
  const useAI = $('#aiRead')?.checked && S.status.claude;
  UI.ingest = files.map((f) => ({ name: f.name, status: 'work', msg: 'reading…' }));
  render();
  for (let i = 0; i < files.length; i++) {
    const f = files[i]; const item = UI.ingest[i];
    try {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      // Re-adding a deck that's already in the notebook only fills in its pictures (keeps the study kit as is).
      const existing = ['pdf', 'pptx'].includes(ext) && nb.sources.find((s) => s.name === f.name);
      if (existing) {
        item.msg = 'pulling slide pictures…'; render();
        const numbering = existing.numbering || (ext === 'pptx' ? 'file' : 'page');
        const items = ext === 'pdf' ? (await pdfRead(await f.arrayBuffer(), true)).visuals : (await pptxRead(f)).visuals;
        await putVisuals(existing.id, numbering, items);
        existing.numbering = numbering; existing.images = items.length; await save(nb);
        item.status = 'ok'; item.msg = `added ${items.length} slide picture${items.length === 1 ? '' : 's'}`; render();
        continue;
      }
      if (ext === 'pdf') {
        const buf = await f.arrayBuffer();
        item.msg = 'reading pages…'; render();
        const { text, pages, visuals } = await pdfRead(buf.slice(0), true);
        const sparse = text.replace(/\[Page \d+\]/g, '').trim().length < pages * 60;
        let final = text;
        if ((useAI || sparse) && S.status.claude) {
          if (f.size > 30e6) item.msg = 'too large for AI reading, using text only';
          else {
            item.msg = `AI reading ${pages} pages + diagrams…`; render();
            try { final = (await ai('transcribe', { media_type: 'application/pdf', data: b64FromBuffer(buf) })).text; }
            catch (e) { if (sparse) throw e; item.msg = 'AI read failed, using text only'; }
          }
        } else if (sparse) throw new Error('This PDF looks scanned. Turn on the AI tutor (Settings) to read it.');
        const src = await addSource(nb, f.name, 'pdf', final, { numbering: 'page', images: visuals.length });
        await putVisuals(src.id, 'page', visuals);
        item.msg = `${pages} pages`;
      } else if (ext === 'pptx') {
        item.msg = 'reading slides & pictures…'; render();
        const { text, visuals } = await pptxRead(f);
        const src = await addSource(nb, f.name, 'pptx', text, { numbering: 'order', images: visuals.length });
        await putVisuals(src.id, 'order', visuals);
        item.msg = `slides + ${visuals.length} picture${visuals.length === 1 ? '' : 's'}`;
      } else if (ext === 'ppt') {
        throw new Error('Old .ppt format: open it in PowerPoint/Keynote and save as .pptx or PDF first.');
      } else if (ext === 'docx') {
        await addSource(nb, f.name, 'docx', await docxText(f));
      } else if (f.type.startsWith('image/') || /^(png|jpe?g|gif|webp|heic)$/.test(ext)) {
        if (!S.status.claude) throw new Error('Reading photos needs the AI tutor — see Settings');
        item.msg = 'AI reading image…'; render();
        const data = await imageToJpeg(f);
        const r = await ai('transcribe', { media_type: 'image/jpeg', data });
        const src = await addSource(nb, r.title || f.name, 'image', r.text, { numbering: 'page', images: 1 });
        await putVisuals(src.id, 'page', [{ slide: 1, file: 1, src: 'data:image/jpeg;base64,' + await imageToJpeg(f, 1400) }]);
      } else {
        await addSource(nb, f.name, 'text', await f.text());
      }
      item.status = 'ok'; if (item.msg === 'reading…') item.msg = 'added';
    } catch (e) { item.status = 'err'; item.msg = e.message; if (e.code === 'no_key') openSettings(); }
    render();
  }
  setTimeout(() => { if (UI.ingest?.every((x) => x.status !== 'work')) { UI.ingest = UI.ingest.filter((x) => x.status === 'err'); render(); } }, 5000);
}

// PDF: text per page + a picture of every page (that's what the lecture actually looks like).
async function pdfRead(buf, withPictures) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const out = []; const visuals = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const lines = []; let line = '';
    for (const it of tc.items) { line += it.str; if (it.hasEOL) { lines.push(line); line = ''; } else line += ' '; }
    if (line.trim()) lines.push(line);
    out.push(`[Page ${i}]\n` + lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'));
    if (withPictures && i <= 200) {
      try {
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(2, 1100 / Math.max(base.width, base.height)) });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        visuals.push({ slide: i, file: i, src: c.toDataURL('image/jpeg', 0.78) });
      } catch (e) { console.warn('page render failed', i, e); }
    }
  }
  return { text: out.join('\n\n'), pages: doc.numPages, visuals };
}
function xmlDoc(xml) { return new DOMParser().parseFromString(xml, 'application/xml'); }
function xmlParas(xml, pTag, tTag) {
  return [...xmlDoc(xml).getElementsByTagName(pTag)].map((p) => [...p.getElementsByTagName(tTag)].map((t) => t.textContent).join('').trim()).filter(Boolean);
}
function resolvePath(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (baseDir + target).split('/'); const out = [];
  for (const x of parts) { if (x === '..') out.pop(); else if (x && x !== '.') out.push(x); }
  return out.join('/');
}
async function relsOf(zip, path) {
  const dir = path.slice(0, path.lastIndexOf('/') + 1);
  const rf = zip.file(dir + '_rels/' + path.slice(dir.length) + '.rels');
  if (!rf) return [];
  return [...xmlDoc(await rf.async('string')).getElementsByTagName('Relationship')].map((r) => ({
    id: r.getAttribute('Id'), type: r.getAttribute('Type') || '', mode: r.getAttribute('TargetMode'), target: resolvePath(dir, r.getAttribute('Target') || ''),
  }));
}
// Slides in the order PowerPoint shows them (file names can be out of order after reordering).
async function slideOrder(zip) {
  const fileNum = (f) => +f.match(/(\d+)\.xml$/)[1];
  try {
    const rels = await relsOf(zip, 'ppt/presentation.xml');
    const byId = Object.fromEntries(rels.map((r) => [r.id, r.target]));
    const ids = [...xmlDoc(await zip.file('ppt/presentation.xml').async('string')).getElementsByTagName('p:sldId')].map((e) => e.getAttribute('r:id'));
    const paths = ids.map((id) => byId[id]).filter((p) => p && zip.file(p));
    if (paths.length) return paths.map((p) => ({ path: p, file: fileNum(p) }));
  } catch (e) { console.warn('slide order fallback', e); }
  return Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => fileNum(a) - fileNum(b)).map((p) => ({ path: p, file: fileNum(p) }));
}
// PowerPoint: slide text + speaker notes + the pictures placed on each slide.
async function pptxRead(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const order = await slideOrder(zip);
  const texts = []; const perSlide = []; const usage = new Map();
  for (const [idx, sl] of order.entries()) {
    const rels = await relsOf(zip, sl.path);
    const paras = xmlParas(await zip.file(sl.path).async('string'), 'a:p', 'a:t');
    const nrel = rels.find((r) => r.type.endsWith('/notesSlide'));
    const nf = nrel && zip.file(nrel.target);
    const notes = nf ? xmlParas(await nf.async('string'), 'a:p', 'a:t').filter((p) => !/^\d+$/.test(p)).join(' ') : '';
    texts.push(`[Slide ${idx + 1}]\n${paras.join('\n')}${notes ? `\n(Speaker notes: ${notes})` : ''}`);
    const imgs = [...new Set(rels.filter((r) => r.type.endsWith('/image') && r.mode !== 'External').map((r) => r.target))];
    perSlide.push(imgs); imgs.forEach((t) => usage.set(t, (usage.get(t) || 0) + 1));
  }
  const visuals = [];
  const repeatLimit = order.length > 6 ? 3 : 99; // logos/backgrounds repeated on many slides aren't content
  for (const [idx, imgs] of perSlide.entries()) {
    for (const t of imgs) {
      if (usage.get(t) > repeatLimit || !/\.(png|jpe?g|gif|webp|bmp)$/i.test(t)) continue;
      try {
        const blob = await zip.file(t).async('blob');
        const bmp = await createImageBitmap(blob);
        if (bmp.width < 140 || bmp.height < 100) continue; // icons, bullets
        visuals.push({ slide: idx + 1, file: order[idx].file, src: 'data:image/jpeg;base64,' + bitmapToJpeg(bmp, 1100, 0.82) });
      } catch { /* unsupported image type */ }
    }
  }
  return { text: texts.join('\n\n'), visuals };
}
async function docxText(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  return xmlParas(await zip.file('word/document.xml').async('string'), 'w:p', 'w:t').join('\n');
}
function bitmapToJpeg(bmp, max, q = 0.88) {
  const sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q).split(',')[1];
}
async function imageToJpeg(file, max = 2000) { return bitmapToJpeg(await createImageBitmap(file), max); }

// Slide pictures live in their own store (kept out of the notebook so saves stay fast).
const VIS = new Map(); // sourceId → { id, numbering, items: [{slide, file, src}] }
async function putVisuals(sourceId, numbering, items) {
  const rec = { id: sourceId, numbering, items };
  VIS.set(sourceId, rec); await DB.put('visuals', rec);
}
async function loadVisuals(nb) {
  const missing = nb.sources.filter((s) => s.images && !VIS.has(s.id));
  if (!missing.length) return false;
  for (const s of missing) { const rec = await DB.get('visuals', s.id); VIS.set(s.id, rec || { id: s.id, items: [] }); }
  return true;
}
/** Slide numbers mentioned in a reference like "Slides 25–30, 50" or "p. 3". */
function refNums(ref) {
  const out = [];
  for (const m of String(ref || '').replace(/source\s*\d+/gi, '').matchAll(/(\d+)\s*(?:[–—-]\s*(\d+))?/g)) {
    const a = +m[1]; const b = m[2] ? +m[2] : a;
    for (let i = a; i <= Math.min(b, a + 6); i++) out.push(i);
  }
  return [...new Set(out)];
}
function visualsFor(nb, ref, limit = 4) {
  const nums = refNums(ref); const res = [];
  for (const n of nums) for (const s of nb.sources) {
    const v = VIS.get(s.id); if (!v) continue;
    for (const it of v.items) if ((v.numbering === 'file' ? it.file : it.slide) === n) res.push({ ...it, n, name: s.name, kind: s.kind });
  }
  return res.slice(0, limit);
}

// Build the study kit
const BUILD_STEPS = ['Reading your material…', 'Finding the most testable concepts…', 'Designing visual summary cards…', 'Drawing the concept map…', 'Writing pretest & recall questions…', 'Preparing teach-back prompts…', 'Almost there — checking everything lines up…'];
function renderBuilding(el) {
  el.innerHTML = `<div class="card building"><div class="spinner lg" style="margin:0 auto"></div><h2 style="margin-top:16px">Building your study kit</h2>
    <div class="step" id="buildStep">${BUILD_STEPS[0]}</div><p class="small muted">Usually 1–3 minutes for a full lecture. While you wait: what do you already know about this topic?</p></div>`;
  let i = 0; clearInterval(UI.buildTimer);
  UI.buildTimer = setInterval(() => { const s = $('#buildStep'); if (!s) return clearInterval(UI.buildTimer); i = Math.min(i + 1, BUILD_STEPS.length - 1); s.textContent = BUILD_STEPS[i]; }, 14000);
}
ACT.build = async () => {
  const nb = curNb();
  if (!S.status.claude) { toast('Building a kit needs the AI tutor — see Settings', 'err'); return openSettings(); }
  UI.building = nb.id; render();
  try {
    const { images, map } = await kitPictures(nb);
    UI.buildPics = images.length; const st = $('#buildStep'); if (st && images.length) st.textContent = `Reading your material + ${images.length} slide pictures…`;
    const d = await ai('digest', { sources: aiSources(nb), images });
    applyDigest(nb, d, map); await save(nb);
    toast('Study kit ready ✨'); UI.building = null; go(`#/nb/${nb.id}/pretest`);
  } catch (e) { UI.building = null; aiError(e); render(); }
  clearInterval(UI.buildTimer);
};
// Slide pictures for the AI: up to 60, shrunk to ~800px so a whole deck fits in one request.
async function kitPictures(nb, max = 30) {
  await loadVisuals(nb);
  const all = [];
  for (const src of nb.sources) {
    const v = VIS.get(src.id); if (!v) continue;
    v.items.forEach((it, idx) => all.push({ sid: src.id, idx, it, n: v.numbering === 'file' ? it.file : it.slide, name: src.name, kind: src.kind }));
  }
  const pick = all.length > max ? Array.from({ length: max }, (_, k) => all[Math.floor((k * all.length) / max)]) : all;
  const images = []; const map = {};
  for (const [k, x] of pick.entries()) {
    const id = `img${k + 1}`; map[id] = { sid: x.sid, idx: x.idx };
    try { images.push({ id, label: `${x.kind === 'pdf' ? 'Page' : 'Slide'} ${x.n} of ${x.name}`, data: await shrinkDataUrl(x.it.src, 640, 0.7) }); } catch { delete map[id]; }
  }
  return { images, map };
}
async function shrinkDataUrl(src, max, q) {
  const img = new Image(); img.src = src; await img.decode();
  return bitmapToJpeg(img.width ? img : await createImageBitmap(img), max, q);
}
function applyDigest(nb, d, map = {}) {
  d.picture_questions ||= [];
  const toRefs = (ids) => (ids || []).map((id) => map[id]).filter(Boolean);
  d.cards.forEach((c) => (c.image_refs = toRefs(c.image_ids)));
  d.concepts.forEach((c) => (c.image_refs = toRefs(c.image_ids)));
  const ids = new Set(d.concepts.map((c) => c.id));
  const fix = (cid) => (ids.has(cid) ? cid : d.concepts[0]?.id);
  d.recall.forEach((r) => (r.concept_id = fix(r.concept_id)));
  d.pretest.forEach((r) => (r.concept_id = fix(r.concept_id)));
  d.feynman_prompts.forEach((r) => (r.concept_id = fix(r.concept_id)));
  const pictureCards = d.picture_questions.filter((q) => map[q.image_id]).map((q) => ({ question: q.question, answer: q.answer, concept_id: fix(q.concept_id), kind: 'picture', image: map[q.image_id] }));
  const nodeIds = new Set(d.concept_map.nodes.map((n) => n.id));
  d.concept_map.edges = d.concept_map.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
  const old = new Map(nb.cards.map((c) => [norm(c.question), c]));
  nb.cards = [...d.recall, ...pictureCards].map((r) => { const o = old.get(norm(r.question)); return o ? { ...o, ...r } : { id: uid(), ...r, srs: newSrs(), history: [] }; });
  if (nb.title === 'Untitled notebook' || nb.sources.some((s) => s.name.replace(/\.[a-z0-9]+$/i, '') === nb.title)) nb.title = d.title;
  if (nb.digest) nb.pretest = { done: nb.pretest.done, answers: [] }; // rebuilding doesn't make you redo the pretest
  nb.digest = d; nb.builtAt = Date.now();
}

// ═════════════════════════ PRETEST ═════════════════════════
function renderPretest(nb, el) {
  const qs = nb.digest.pretest;
  if (!nb.pretest.done) {
    el.innerHTML = `<div class="q-card stack">
      <div class="card overview"><h2>🤔 Guess before you learn</h2>
      <p>Take a quick shot at these <b>before</b> studying. It’s not graded. Trying to answer first (even wrongly) primes your brain to notice and remember the real answer. This is called the <i>pretesting effect</i>.</p></div>
      ${qs.map((q, i) => `<div class="card"><div class="small muted">Question ${i + 1} of ${qs.length}</div><div class="q-text">${esc(q.question)}</div>
        <textarea data-pre="${i}" placeholder="Your best guess (a few words is fine)…"></textarea></div>`).join('')}
      <div class="row" style="justify-content:flex-end"><button class="btn" data-act="skip-pretest">Skip</button><button class="btn primary lg" data-act="submit-pretest">See answers</button></div></div>`;
    return;
  }
  el.innerHTML = `<div class="q-card stack">
    <div class="card overview row between"><div><h2>Pretest done ✓</h2><p class="muted" style="margin:0">Keep these answers in mind. You’ll meet them again in the visual lesson.</p></div>
      <a class="btn primary" href="#/nb/${nb.id}/learn">Learn it visually →</a></div>
    ${qs.map((q, i) => { const a = nb.pretest.answers[i] || ''; const close = a && coverage(a, q.answer) >= 0.3;
      return `<div class="card"><div class="row between"><span class="tag">${esc(conceptName(nb, q.concept_id))}</span>${a ? `<span class="tag ${close ? 'good' : 'warn'}">${close ? 'Good instinct!' : 'Now you know'}</span>` : ''}</div>
      <div class="q-text">${esc(q.question)}</div>
      <div class="small muted">Your guess</div><div>${a ? esc(a) : '<i class="muted">skipped</i>'}</div>
      <div class="answer-box"><div class="small muted">Answer</div>${esc(q.answer)}</div></div>`; }).join('')}
    <div class="row" style="justify-content:space-between"><button class="btn ghost" data-act="redo-pretest">Retake pretest</button><a class="btn primary" href="#/nb/${nb.id}/learn">Learn it visually →</a></div></div>`;
}
ACT['submit-pretest'] = async () => {
  const nb = curNb();
  nb.pretest.answers = $$('[data-pre]').map((t) => t.value.trim());
  nb.pretest.done = true; await save(nb);
  await gainXP(5 * nb.pretest.answers.filter(Boolean).length + 5, 'pretest');
  render();
};
ACT['skip-pretest'] = async () => { const nb = curNb(); nb.pretest.done = true; await save(nb); go(`#/nb/${nb.id}/learn`); };
ACT['redo-pretest'] = async () => { const nb = curNb(); nb.pretest = { done: false, answers: [] }; await save(nb); render(); };

// ═════════════════════════ LEARN (visual) ═════════════════════════
function renderLearn(nb, el) {
  const d = nb.digest;
  const mode = UI.cardMode || 'study';
  UI.cardRecall ||= {};
  UI.shots = {};
  loadVisuals(nb).then((changed) => { if (changed && route().tab === 'learn') render(); });
  const noPics = nb.sources.filter((s) => ['pdf', 'pptx'].includes(s.kind) && s.images === undefined && !/\(sample\)/.test(s.name));
  el.innerHTML = `
  <div class="stack">
    <div class="card overview"><h2>${esc(d.title)}</h2><p style="margin:0">${esc(d.overview)}</p></div>
    ${noPics.length ? `<div class="card flat tight row" style="background:var(--warn-soft);border-color:transparent">🖼️ <span class="spacer small">This notebook was made before 3nc0de kept slide pictures. Drop <b>${noPics.map((s) => esc(s.name)).join(', ')}</b> on the Sources tab again to add them. Your study kit and progress stay the same.</span><a class="btn sm" href="#/nb/${nb.id}/sources">Go to Sources</a></div>` : ''}

    <div class="row between section"><div><h2>🃏 Visual summary cards</h2><div class="small muted">Study a card, then flip to recall mode and write what you remember.</div></div>
      <div class="seg"><button class="${mode === 'study' ? 'on' : ''}" data-act="card-mode" data-m="study">Study</button><button class="${mode === 'recall' ? 'on' : ''}" data-act="card-mode" data-m="recall">Cover & recall</button></div></div>
    <div class="grid">${d.cards.map((c, i) => summaryCard(nb, c, i, mode)).join('')}</div>

    <div class="row between section"><div><h2>🗺️ Concept map</h2><div class="small muted">${UI.mapMode === 'blanks' ? 'Click a dashed box and type what belongs there. Use its connections as clues.' : 'How the ideas connect. Switch to fill-the-blanks to test yourself.'}</div></div>
      <div class="seg"><button class="${UI.mapMode !== 'blanks' ? 'on' : ''}" data-act="map-mode" data-m="explore">Explore</button><button class="${UI.mapMode === 'blanks' ? 'on' : ''}" data-act="map-mode" data-m="blanks">Fill the blanks</button></div></div>
    <div class="map-wrap ${UI.mapMode === 'blanks' ? 'blanks' : ''}" id="map"><div class="spinner"></div></div>
    <div id="mapQuiz"></div>

    <div class="section"><h2>💡 Key concepts</h2><div class="small muted">Generate a diagram or a silly mnemonic picture for anything that isn’t sticking. Illustrations are made by Gemini.</div></div>
    <div class="stack">${d.concepts.map((c) => conceptCard(nb, c)).join('')}</div>
  </div>`;
  drawMap(nb);
}
function summaryCard(nb, c, i, mode) {
  const st = UI.cardRecall[`${nb.id}:${i}`];
  const head = `<div class="row between"><span class="emoji">${esc(c.emoji)}</span><span class="ref">${esc(c.source_ref)}</span></div>${cardPictures(nb, c, i)}<h3 style="margin:0">${esc(c.title)}</h3>`;
  if (mode === 'study') {
    return `<div class="card scard">${head}<ul>${c.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      ${c.analogy ? `<div class="analogy">🔗 ${esc(c.analogy)}</div>` : ''}</div>`;
  }
  if (!st?.revealed) {
    return `<div class="card scard">${head}<div class="small muted">What were the ${c.points.length} key points? Write everything you can recall.</div>
      <textarea data-cr="${i}" placeholder="From memory…">${esc(st?.text || '')}</textarea>
      <button class="btn primary sm" data-act="card-reveal" data-i="${i}">Reveal & compare</button></div>`;
  }
  return `<div class="card scard">${head}<ul>${c.points.map((p, j) => `<li class="${st.hits[j] ? 'hit' : 'miss'}">${st.hits[j] ? '✓ ' : ''}${esc(p)}</li>`).join('')}</ul>
    <div class="small"><b>${st.hits.filter(Boolean).length}/${c.points.length}</b> recalled. ${st.hits.every(Boolean) ? 'Perfect! 🎉' : 'Red ones are your gaps; reread them now.'}</div>
    <button class="btn sm" data-act="card-retry" data-i="${i}">Try again</button></div>`;
}
function shotStrip(key, shots) {
  UI.shots[key] = shots;
  return `<div class="shots ${shots.length === 1 ? 'one' : ''}">${shots.map((v, k) => `<figure data-act="zoom-shot" data-key="${esc(key)}" data-k="${k}"><img loading="lazy" alt="${esc(v.kind === 'pdf' ? 'Page' : 'Slide')} ${v.n}" src="${v.src}"><span>${v.kind === 'pdf' ? 'p.' : 'Slide'} ${v.n}</span></figure>`).join('')}</div>`;
}
function cardPictures(nb, c, i) {
  const picked = refShots(nb, c.image_refs);
  const shots = picked.length ? picked : visualsFor(nb, c.source_ref, 3);
  if (shots.length) return shotStrip(`card${i}`, shots);
  const ill = nb.illustrations[`card${i}:diagram`];
  if (ill) return `<div class="shots one"><figure data-act="zoom-ill" data-key="card${i}:diagram"><img alt="${esc(c.title)} diagram" src="${illSrc(ill)}"><span>🎨 drawn</span></figure></div>`;
  if (UI.illBusy?.[`card${i}:diagram`]) return '<div class="shot-empty"><span class="spinner"></span> Drawing a diagram…</div>';
  return `<button class="shot-empty" data-act="card-draw" data-i="${i}">🎨 No slide picture for this card. Draw a diagram</button>`;
}
ACT['zoom-shot'] = (el) => { UI.zoom = { list: UI.shots[el.dataset.key] || [], i: +el.dataset.k }; showZoom(); };
function showZoom() {
  const { list, i } = UI.zoom; const v = list[i]; if (!v) return;
  modal(`<div class="row between" style="margin-bottom:8px"><b>${v.kind === 'pdf' ? 'Page' : 'Slide'} ${v.n}</b><span class="small muted">${esc(v.name)}</span></div>
    <img src="${v.src}" alt="">
    <div class="row" style="justify-content:space-between;margin-top:10px">
      <button class="btn" data-act="zoom-step" data-d="-1" ${i ? '' : 'disabled'}>‹ Prev</button>
      <span class="small muted">${i + 1} / ${list.length}</span>
      <button class="btn" data-act="zoom-step" data-d="1" ${i < list.length - 1 ? '' : 'disabled'}>Next ›</button></div>`, true);
}
ACT['zoom-step'] = (el) => { UI.zoom.i = Math.max(0, Math.min(UI.zoom.list.length - 1, UI.zoom.i + +el.dataset.d)); showZoom(); };
document.addEventListener('keydown', (e) => {
  if ($('#modal').classList.contains('hidden') || !UI.zoom || !$('#modal [data-act="zoom-step"]')) return;
  if (e.key === 'ArrowRight') $('#modal [data-act="zoom-step"][data-d="1"]')?.click();
  if (e.key === 'ArrowLeft') $('#modal [data-act="zoom-step"][data-d="-1"]')?.click();
});
ACT['card-draw'] = async (el) => {
  const nb = curNb(); const i = +el.dataset.i; const c = nb.digest.cards[i]; const key = `card${i}:diagram`;
  if (!S.status.claude && !S.status.gemini) { toast('Drawing needs the AI tutor — see Settings', 'err'); return openSettings(); }
  (UI.illBusy ||= {})[key] = true; render();
  try {
    const r = await api('/api/illustrate', { name: c.title, definition: c.points.join('; '), visual_hint: `A labeled teaching diagram of: ${c.title}. Show ${c.points.join('; ')}`, mnemonic: c.analogy, style: 'diagram', engine: 'svg', sources: aiSources(nb) });
    if (r.kind === 'svg' && !r.svg) throw new Error('The drawing came back empty. Try again.');
    nb.illustrations[key] = r; await save(nb); await gainXP(3, 'visual');
  } catch (e) { aiError(e); }
  delete UI.illBusy[key]; render();
};
ACT['card-mode'] = (el) => { UI.cardMode = el.dataset.m; render(); };
ACT['card-reveal'] = async (el) => {
  const nb = curNb(); const i = +el.dataset.i; const c = nb.digest.cards[i];
  const text = $(`[data-cr="${i}"]`).value;
  const hits = c.points.map((p) => coverage(text, p) >= 0.4);
  UI.cardRecall[`${nb.id}:${i}`] = { revealed: true, text, hits };
  const ratio = hits.filter(Boolean).length / c.points.length;
  c.concept_ids.forEach((cid) => record(nb, cid, ratio));
  await save(nb);
  await gainXP(2 + 3 * hits.filter(Boolean).length, 'card recall');
  render();
};
ACT['card-retry'] = (el) => { const nb = curNb(); UI.cardRecall[`${nb.id}:${el.dataset.i}`] = { revealed: false, text: '' }; render(); };

function conceptCard(nb, c) {
  const m = mastery(nb, c.id);
  const ills = ['diagram', 'mnemonic'].map((s) => ({ s, v: nb.illustrations[`${c.id}:${s}`] })).filter((x) => x.v);
  const busy = UI.illBusy || {};
  return `<div class="card concept" id="concept-${c.id}">
    <div class="row between"><h3 style="margin:0">${esc(c.name)}</h3><div class="row">${m !== null ? `<span class="tag ${m >= .7 ? 'good' : m >= .4 ? 'warn' : 'bad'}">${pct(m)}%</span>` : ''}<span class="tag">${esc(c.source_ref)}</span></div></div>
    <div>${esc(c.definition)}</div>
    <div class="small muted">Why it matters: ${esc(c.why_it_matters)}</div>
    ${c.mnemonic ? `<div class="mnemo">🤪 <b>Mnemonic:</b> ${esc(c.mnemonic)}</div>` : ''}
    ${(() => { const pk = refShots(nb, c.image_refs); const sh = pk.length ? pk : visualsFor(nb, c.source_ref, 4); return sh.length ? shotStrip(`concept-${c.id}`, sh) : ''; })()}
    ${ills.length ? `<div class="ill">${ills.map(({ s, v }) => `<figure data-act="zoom-ill" data-key="${c.id}:${s}"><img alt="${esc(c.name)} ${s}" src="${illSrc(v)}"><figcaption>${s === 'mnemonic' ? '🤪 ' : '🎨 '}${esc(v.caption || '')}</figcaption></figure>`).join('')}</div>` : ''}
    <div class="row">
      ${['diagram', 'mnemonic'].map((s) => busy[`${c.id}:${s}`] ? `<button class="btn sm" disabled><span class="spinner"></span> Drawing…</button>`
        : `<button class="btn sm" data-act="illustrate" data-cid="${c.id}" data-style="${s}">${s === 'diagram' ? '🎨' : '🤪'} ${nb.illustrations[`${c.id}:${s}`] ? 'Redraw' : s === 'diagram' ? 'Draw diagram' : 'Mnemonic picture'}</button>`).join('')}
      <button class="btn sm" data-act="vid-concept" data-cid="${c.id}">🎬 ${(nb.videos || []).some((v) => v.concept_id === c.id) ? 'See video' : 'Find a video'}</button>
      <a class="btn sm ghost" href="#/nb/${nb.id}/recall/${c.id}">🧠 Quiz me on this</a>
    </div></div>`;
}
const illSrc = (v) => (v.kind === 'svg' ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(v.svg) : v.src);
ACT.illustrate = async (el) => {
  const nb = curNb(); const c = nb.digest.concepts.find((x) => x.id === el.dataset.cid); const style = el.dataset.style; const key = `${c.id}:${style}`;
  if (!S.status.claude && !S.status.gemini) { toast('Illustrations need the AI tutor — see Settings', 'err'); return openSettings(); }
  (UI.illBusy ||= {})[key] = true; render(); $(`#concept-${c.id}`)?.scrollIntoView({ block: 'center' });
  try {
    const r = await api('/api/illustrate', { ...c, style, sources: style === 'diagram' ? aiSources(nb) : [] });
    if (r.kind === 'svg' && !r.svg) throw new Error('The drawing came back empty. Try again.');
    nb.illustrations[key] = r; await save(nb);
    if (r.note) toast(r.note);
    await gainXP(3, 'visual');
  } catch (e) { aiError(e); }
  delete UI.illBusy[key]; render(); $(`#concept-${c.id}`)?.scrollIntoView({ block: 'center' });
};
ACT['zoom-ill'] = (el) => {
  const nb = curNb(); const v = nb.illustrations[el.dataset.key];
  modal(`<img src="${illSrc(v)}" alt=""><p style="margin-top:10px">${esc(v.caption || '')}</p><div class="row" style="justify-content:flex-end"><button class="btn" data-act="close-modal">Close</button></div>`, true);
};

// Concept map (mermaid) with fill-in-the-blank mode
let mermaidReady = false;
function mermaidInit() {
  if (mermaidReady || !window.mermaid) return;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', flowchart: { curve: 'basis', htmlLabels: true, useMaxWidth: false }, fontFamily: 'Helvetica, Arial, sans-serif' });
  mermaidReady = true;
}
const GROUP_COLORS = [['#e0e7ff', '#4f46e5'], ['#dcfce7', '#15803d'], ['#fef3c7', '#b45309'], ['#fce7f3', '#be185d'], ['#e0f2fe', '#0369a1'], ['#ede9fe', '#6d28d9'], ['#ffedd5', '#c2410c']];
async function drawMap(nb) {
  const host = $('#map'); if (!host) return;
  if (!window.mermaid) { host.innerHTML = '<p class="muted">Concept map library didn’t load (offline?).</p>'; return; }
  mermaidInit();
  const map = nb.digest.concept_map;
  const blanks = UI.mapMode === 'blanks';
  const key = nb.id;
  if (blanks && (!UI.hidden || UI.hidden.key !== key)) {
    const ids = map.nodes.map((n) => n.id).sort(() => Math.random() - 0.5);
    UI.hidden = { key, set: new Set(ids.slice(0, Math.max(3, Math.round(ids.length * 0.4)))), tries: {} };
  }
  const groups = [...new Set(map.nodes.map((n) => n.group))];
  const label = (n) => (blanks && UI.hidden.set.has(n.id) ? '❓' : n.label).replace(/"/g, '#quot;');
  const safeId = (id) => 'N_' + String(id).replace(/[^A-Za-z0-9_]/g, '_');
  let code = `flowchart ${map.nodes.length > 8 ? 'TD' : 'LR'}\n`;
  map.nodes.forEach((n) => { code += `  ${safeId(n.id)}["${label(n)}"]\n`; });
  map.edges.forEach((e) => { const l = (e.label || '').replace(/["|]/g, ''); code += `  ${safeId(e.from)} -->${l ? `|"${l}"|` : ''} ${safeId(e.to)}\n`; });
  groups.forEach((g, i) => { const [f, s] = GROUP_COLORS[i % GROUP_COLORS.length]; code += `  classDef g${i} fill:${f},stroke:${s},color:#1c1b2e,stroke-width:1.5px\n`; });
  map.nodes.forEach((n) => { code += `  class ${safeId(n.id)} g${groups.indexOf(n.group)}\n`; });
  try {
    const { svg } = await mermaid.render('cmap' + Date.now(), code);
    host.innerHTML = svg + `<div class="row small muted" style="margin-top:8px">${groups.map((g, i) => `<span><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${GROUP_COLORS[i % GROUP_COLORS.length][0]};border:1px solid ${GROUP_COLORS[i % GROUP_COLORS.length][1]}"></span> ${esc(g)}</span>`).join('')}</div>`;
  } catch (e) { host.innerHTML = `<p class="muted">Couldn’t draw the map (${esc(e.message)}).</p>`; return; }
  if (!blanks) return;
  const byId = new Map(map.nodes.map((n) => [safeId(n.id), n]));
  $$('g.node', host).forEach((g) => {
    const m = (g.id || '').match(/flowchart-(N_[A-Za-z0-9_]+)-\d+/); const n = m && byId.get(m[1]);
    if (!n || !UI.hidden.set.has(n.id)) return;
    g.classList.add('hidden-node');
    g.addEventListener('click', () => { $$('.picked', host).forEach((x) => x.classList.remove('picked')); g.classList.add('picked'); mapQuiz(nb, n); });
  });
  const left = UI.hidden.set.size;
  $('#mapQuiz').innerHTML = left ? `<p class="small muted">${left} blank${left > 1 ? 's' : ''} left. Click one to answer.</p>` : `<div class="card overview">🎉 Map complete! <button class="btn sm" data-act="map-reshuffle">New blanks</button></div>`;
}
function mapQuiz(nb, n) {
  const map = nb.digest.concept_map; const nm = (id) => { const x = map.nodes.find((k) => k.id === id); return UI.hidden.set.has(id) ? '❓' : x.label; };
  const clues = [...map.edges.filter((e) => e.to === n.id).map((e) => `${nm(e.from)} —${e.label}→ <b>?</b>`), ...map.edges.filter((e) => e.from === n.id).map((e) => `<b>?</b> —${e.label}→ ${nm(e.to)}`)];
  $('#mapQuiz').innerHTML = `<div class="card stack"><h3>What goes in this box?</h3>
    <div class="small">${clues.map(esc).join('<br>').replace(/&lt;b&gt;\?&lt;\/b&gt;/g, '<b>?</b>')}</div>
    <div class="small muted">Group: ${esc(n.group)}</div>
    <div class="row"><input type="text" id="mapAns" placeholder="Type the concept" style="flex:1;min-width:180px"><button class="btn primary" data-act="map-check" data-id="${esc(n.id)}">Check</button>
    ${(UI.hidden.tries[n.id] || 0) >= 2 ? `<button class="btn" data-act="map-reveal" data-id="${esc(n.id)}">Reveal</button>` : ''}</div></div>`;
  const inp = $('#mapAns'); inp.focus(); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('[data-act="map-check"]').click(); });
}
ACT['map-mode'] = (el) => { UI.mapMode = el.dataset.m; render(); };
ACT['map-reshuffle'] = () => { UI.hidden = null; render(); };
ACT['map-check'] = async (el) => {
  const nb = curNb(); const n = nb.digest.concept_map.nodes.find((x) => x.id === el.dataset.id); const ans = $('#mapAns').value;
  if (similar(ans, n.label) >= 0.72 || coverage(ans, n.label) >= 0.75) {
    UI.hidden.set.delete(n.id); toast(`✓ ${n.label}`); await gainXP(5, 'map'); drawMap(nb);
  } else {
    UI.hidden.tries[n.id] = (UI.hidden.tries[n.id] || 0) + 1; $('#mapAns').classList.add('shake'); setTimeout(() => $('#mapAns')?.classList.remove('shake'), 400);
    if (UI.hidden.tries[n.id] === 2) mapQuiz(nb, n);
  }
};
ACT['map-reveal'] = (el) => { const nb = curNb(); const n = nb.digest.concept_map.nodes.find((x) => x.id === el.dataset.id); UI.hidden.set.delete(n.id); toast(`It was: ${n.label}`); drawMap(nb); };

// ═════════════════════════ RECALL (spaced repetition) ═════════════════════════
// A session is a queue of {nb, card} so it can mix cards from several lectures (course review).
const CONF = { sure: '😎 Sure', unsure: '🤔 Unsure', guess: '🎲 Guessing' };
function renderRecall(nb, el, focus) {
  const R = UI.recall;
  if (!R || R.scope !== 'nb:' + nb.id || R.focus !== (focus || '')) return recallStart(nb, el, focus);
  recallSession(el);
}
function recallItem(R) {
  const q = R.queue[R.i]; const nb = getNb(q.nb);
  return { nb, card: nb?.cards.find((c) => c.id === q.card) };
}
function recallSession(el) {
  const R = UI.recall;
  if (R.i >= R.queue.length) return recallDone(el);
  const { nb, card } = recallItem(R);
  if (!card) { R.i++; return recallSession(el); }
  const res = R.result;
  if (card.image) loadVisuals(nb).then((changed) => { if (changed) render(); });
  UI.shots = UI.shots || {};
  const pic = card.image ? refShots(nb, [card.image]) : [];
  el.innerHTML = `<div class="q-card">
    <div class="progress-line"><i style="width:${pct(R.i / R.queue.length)}%"></i></div>
    <div class="card">
      <div class="row between"><span class="row" style="gap:6px"><span class="tag accent">${card.kind === 'picture' ? '🖼️ picture' : esc(card.kind)}</span>${R.scope.startsWith('course:') ? `<span class="tag">${esc(nb.title)}</span>` : ''}</span>
        <span class="small muted">${R.i + 1} / ${R.queue.length} · ${esc(conceptName(nb, card.concept_id))}</span></div>
      ${pic.length ? `<div style="margin-top:10px">${shotStrip('rc', pic)}</div>` : card.image ? '<div class="shot-empty" style="margin-top:10px"><span class="spinner"></span> Loading picture…</div>' : ''}
      <div class="q-text">${esc(card.question)}</div>
      ${!res ? `<textarea id="ans" placeholder="Type your answer from memory… (⌘/Ctrl + Enter to check)">${esc(R.draft || '')}</textarea>
        <div class="row" style="margin-top:10px"><span class="small muted">How sure are you?</span>
          <div class="seg">${Object.entries(CONF).map(([k, l]) => `<button class="${R.conf === k ? 'on' : ''}" data-act="rc-conf" data-c="${k}">${l}</button>`).join('')}</div></div>
        <div class="row" style="margin-top:10px"><button class="btn ghost" data-act="rc-idk">I don’t know</button>${micBtn('ans')}<span class="spacer"></span>
        <button class="btn primary" data-act="rc-check" ${R.grading ? 'disabled' : ''}>${R.grading ? '<span class="spinner"></span> Grading…' : 'Check'}</button></div>`
      : `<div class="answer-box"><div class="small muted">Your answer${R.conf ? ` · you felt ${CONF[R.conf].split(' ')[1].toLowerCase()}` : ''}</div>${R.draft ? esc(R.draft) : '<i class="muted">(blank)</i>'}</div>
        ${res.verdict === 'incorrect' && R.conf === 'sure' ? `<div class="verdict incorrect" style="border:2px solid var(--bad)"><h3>⚠️ Confident mistake</h3><div>You were sure, but this is wrong. These are the most valuable errors to catch: read the answer, then say out loud <b>why</b> your version was wrong. Fixing a confident mistake tends to stick better than learning something new.</div></div>` : ''}
        ${res.verdict === 'correct' && R.conf === 'guess' ? `<div class="small" style="margin-top:8px;color:var(--warn)">🎲 Right, but you guessed, so this card comes back sooner until you actually know it.</div>` : ''}
        ${res.verdict ? `<div class="verdict ${res.verdict}"><h3>${{ correct: '✅ Correct', partial: '🟡 Partly right', incorrect: '❌ Not quite' }[res.verdict]}</h3>
          ${res.feedback ? `<div>${esc(res.feedback)}</div>` : ''}${res.missing?.length ? `<div class="small" style="margin-top:6px"><b>Missing:</b> ${res.missing.map(esc).join('; ')}</div>` : ''}</div>` : ''}
        <div class="answer-box"><div class="small muted">Model answer</div>${esc(card.answer)}</div>
        ${res.verdict ? `<div class="row" style="margin-top:12px"><span class="small muted">Disagree?</span>
          ${['correct', 'partial', 'incorrect'].filter((v) => v !== res.verdict).map((v) => `<button class="btn sm ghost" data-act="rc-override" data-v="${v}">Mark ${v}</button>`).join('')}
          <span class="spacer"></span><button class="btn primary" data-act="rc-next">Next →</button></div>`
        : `<div class="small muted" style="margin-top:12px">How did you do?</div><div class="row" style="margin-top:6px">
          <button class="btn bad" data-act="rc-self" data-v="incorrect">Missed it</button><button class="btn warn" data-act="rc-self" data-v="partial">Partly</button><button class="btn good" data-act="rc-self" data-v="correct">Got it</button></div>`}`}
    </div>
    <div class="row" style="justify-content:center;margin-top:12px"><button class="btn sm ghost" data-act="rc-quit">End session</button></div></div>`;
  const ta = $('#ans');
  if (ta) { ta.focus(); ta.addEventListener('input', () => (R.draft = ta.value)); ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('[data-act="rc-check"]').click(); }); }
}
function refShots(nb, refs) {
  return (refs || []).map((ref) => {
    const v = VIS.get(ref.sid); const it = v?.items?.[ref.idx]; const src = nb.sources.find((x) => x.id === ref.sid);
    return it && src ? { ...it, n: v.numbering === 'file' ? it.file : it.slide, name: src.name, kind: src.kind } : null;
  }).filter(Boolean);
}
function recallStart(nb, el, focus) {
  const due = dueCards(nb); const fresh = nb.cards.filter((c) => c.srs.reps === 0 && !c.history.length);
  const later = nb.cards.filter((c) => c.srs.due > Date.now()).sort((a, b) => a.srs.due - b.srs.due);
  const pics = nb.cards.filter((c) => c.kind === 'picture').length;
  const fc = focus ? nb.digest.concepts.find((c) => c.id === focus) : null;
  const courseMates = nb.course ? S.notebooks.filter((n) => n.course === nb.course && n.digest).length : 0;
  UI.aiGrade ??= true;
  el.innerHTML = `<div class="q-card stack">
    <div class="card overview"><h2>🧠 Active recall</h2>
      <p>Type answers from memory. Generating the answer yourself is what builds memory, not rereading. Before checking, tap how sure you are: catching <b>confident mistakes</b> is one of the fastest ways to improve.</p>
      ${fc ? `<p><span class="tag accent">Focus: ${esc(fc.name)}</span> <a class="small" href="#/nb/${nb.id}/recall">clear</a></p>` : ''}
      <div class="row">
        ${fc ? `<button class="btn primary lg" data-act="rc-start" data-mode="focus" data-focus="${fc.id}">Drill this concept</button>`
          : due.length ? `<button class="btn primary lg" data-act="rc-start" data-mode="due">Start review (${Math.min(due.length, 20)})</button>` : '<span class="tag good">Nothing due. Nice work!</span>'}
        <button class="btn" data-act="rc-start" data-mode="cram" ${fc ? `data-focus="${fc.id}"` : ''}>Cram everything (ignore schedule)</button>
        <button class="btn" data-act="rc-start" data-mode="weak">Weakest concepts</button>
        ${pics ? '<button class="btn" data-act="rc-start" data-mode="pictures">🖼️ Picture questions</button>' : ''}
      </div>
      ${courseMates > 1 ? `<p class="small" style="margin:10px 0 0">📚 Studying for a cumulative exam? <a href="#/course/${encodeURIComponent(nb.course)}">Mix all ${courseMates} ${esc(nb.course)} lectures →</a></p>` : ''}
      <label class="check small" style="margin-top:10px"><input type="checkbox" id="aiGrade" ${UI.aiGrade && S.status.claude ? 'checked' : ''} ${S.status.claude ? '' : 'disabled'}> AI grades my typed answers (otherwise I grade myself)</label>
    </div>
    <div class="grid" style="grid-template-columns:repeat(4,1fr)">
      <div class="card tight"><b style="font-size:1.4rem">${due.length}</b><div class="small muted">due now</div></div>
      <div class="card tight"><b style="font-size:1.4rem">${fresh.length}</b><div class="small muted">new</div></div>
      <div class="card tight"><b style="font-size:1.4rem">${pics}</b><div class="small muted">picture cards</div></div>
      <div class="card tight"><b style="font-size:1.4rem">${nb.cards.filter((c) => c.srs.interval >= 6).length}</b><div class="small muted">well-learned</div></div>
    </div>
    ${later.length ? `<div class="small muted">Next card due ${fmtDue(later[0].srs.due)}.</div>` : ''}</div>`;
  $('#aiGrade')?.addEventListener('change', (e) => (UI.aiGrade = e.target.checked));
}
ACT['rc-start'] = (el) => startRecall(curNb(), el.dataset.mode, el.dataset.focus, route().arg || '');
ACT['drill-weak'] = () => { const nb = curNb(); UI.exam = null; if (startRecall(nb, 'weak', '', '')) go(`#/nb/${nb.id}/recall`); };
function poolFor(nb, mode, focus) {
  if (mode === 'due') return dueCards(nb);
  if (mode === 'focus') return nb.cards.filter((c) => c.concept_id === focus);
  if (mode === 'pictures') return nb.cards.filter((c) => c.kind === 'picture');
  if (mode === 'weak') {
    const weak = new Set(weakConcepts(nb, 5).map((w) => w.c.id));
    const pool = nb.cards.filter((c) => weak.has(c.concept_id) || c.srs.lapses > 0 || c.history.some((h) => h.c === 'sure' && h.v === 'incorrect'));
    return pool.length ? pool : nb.cards.filter((c) => !c.history.length);
  }
  return nb.cards.filter((c) => !focus || c.concept_id === focus);
}
function beginSession(scope, focus, items, limit) {
  if (!items.length) { toast('No cards in that set yet'); return false; }
  // interleave: shuffle so concepts (and lectures) alternate
  const queue = [...items].sort(() => Math.random() - 0.5).slice(0, limit).map(({ nb, card }) => ({ nb: nb.id, card: card.id }));
  UI.recall = { scope, focus, queue, i: 0, result: null, draft: '', conf: null, tally: { correct: 0, partial: 0, incorrect: 0 }, xp: 0, confMistakes: 0, luckyGuesses: 0 };
  render();
  return true;
}
function startRecall(nb, mode, focus, routeFocus) {
  return beginSession('nb:' + nb.id, routeFocus, poolFor(nb, mode, focus).map((card) => ({ nb, card })), mode === 'cram' ? 40 : 20);
}
ACT['rc-conf'] = (el) => { UI.recall.conf = UI.recall.conf === el.dataset.c ? null : el.dataset.c; $$('[data-act="rc-conf"]').forEach((b) => b.classList.toggle('on', b.dataset.c === UI.recall.conf)); };
// Clear-cut answers are graded on the spot (saves AI): near-identical to the key, or covering its key words.
function quickGrade(response, answer) {
  if (!norm(response)) return null;
  if (similar(response, answer) >= 0.9 || coverage(response, answer) >= 0.85) {
    return { verdict: 'correct', score: 1, feedback: 'Matches the key points ✓ (checked instantly)', missing: [], instant: true };
  }
  return null;
}
ACT['rc-check'] = async () => {
  const R = UI.recall; const { nb, card } = recallItem(R);
  R.draft = $('#ans').value.trim();
  if (!R.draft) return ACT['rc-idk']();
  const quick = quickGrade(R.draft, card.answer);
  if (quick) R.result = quick;
  else if (UI.aiGrade && S.status.claude) {
    R.grading = true; render();
    try { R.result = await ai('grade', { sources: aiSources(nb), concept: conceptName(nb, card.concept_id), question: card.question, answer: card.answer, response: R.draft }); }
    catch (e) { aiError(e); R.result = { verdict: null }; }
    R.grading = false;
  } else R.result = { verdict: null };
  render();
};
ACT['rc-idk'] = () => { const R = UI.recall; R.draft = ''; R.conf = null; R.result = { verdict: 'incorrect', feedback: 'No worries. Read the answer, then say it to yourself once. It’ll come back soon.' }; render(); };
ACT['rc-self'] = (el) => {
  const R = UI.recall; R.result.verdict = el.dataset.v;
  // Stop on a confident mistake so the warning is seen; otherwise move straight on.
  if (R.conf === 'sure' && el.dataset.v === 'incorrect') { R.result.feedback = 'Marked by you.'; return render(); }
  ACT['rc-next']();
};
ACT['rc-override'] = (el) => { UI.recall.result.verdict = el.dataset.v; UI.recall.result.feedback = 'Marked by you.'; UI.recall.result.missing = []; render(); };
ACT['rc-next'] = async () => {
  const R = UI.recall; const { nb, card } = recallItem(R); const v = R.result.verdict;
  schedule(card, v, R.conf); record(nb, card.concept_id, v === 'correct' ? (R.conf === 'guess' ? 0.6 : 1) : v === 'partial' ? 0.5 : 0);
  nb.progress.reviews++; R.tally[v]++;
  if (v === 'incorrect' && R.conf === 'sure') R.confMistakes++;
  if (v === 'correct' && R.conf === 'guess') R.luckyGuesses++;
  if (v === 'incorrect' && !R.requeued?.[card.id]) { (R.requeued ||= {})[card.id] = 1; R.queue.push({ nb: nb.id, card: card.id }); } // see it again this session
  const xp = v === 'correct' ? 10 : v === 'partial' ? 5 : 2; R.xp += xp;
  await save(nb); await gainXP(xp);
  R.i++; R.result = null; R.draft = ''; R.conf = null; render();
};
ACT['rc-quit'] = () => { const R = UI.recall; R.queue = R.queue.slice(0, R.i); render(); };
function recallDone(el) {
  const R = UI.recall; const t = R.tally; const total = t.correct + t.partial + t.incorrect;
  if (total >= 3 && t.correct / total >= 0.8 && !R.cheered) { R.cheered = true; setTimeout(confetti, 150); }
  const nbs = [...new Set(R.queue.map((q) => q.nb))].map(getNb).filter(Boolean);
  const next = nbs.flatMap((nb) => nb.cards).filter((c) => c.srs.due > Date.now()).sort((a, b) => a.srs.due - b.srs.due)[0];
  const single = R.scope.startsWith('nb:') ? nbs[0] : null;
  el.innerHTML = `<div class="q-card"><div class="card stack" style="text-align:center">
    <div style="font-size:2.6rem">${total && t.correct / total >= 0.8 ? '🏆' : '💪'}</div><h2>Session complete</h2>
    <div class="row" style="justify-content:center"><span class="tag good">✅ ${t.correct}</span><span class="tag warn">🟡 ${t.partial}</span><span class="tag bad">❌ ${t.incorrect}</span><span class="tag accent">+${R.xp} XP</span></div>
    ${R.confMistakes ? `<p style="color:var(--bad)">⚠️ ${R.confMistakes} confident mistake${R.confMistakes > 1 ? 's' : ''}: things you were sure about but got wrong. They’ll come back first.</p>` : ''}
    ${R.luckyGuesses ? `<p class="small" style="color:var(--warn)">🎲 ${R.luckyGuesses} lucky guess${R.luckyGuesses > 1 ? 'es' : ''}, scheduled to come back sooner.</p>` : ''}
    <p class="muted">${next ? `Next review ${fmtDue(next.srs.due)}. Coming back then is what moves this into long-term memory.` : ''}</p>
    <div class="row" style="justify-content:center"><button class="btn" data-act="rc-reset">Back</button>${single ? `<a class="btn primary" href="#/nb/${single.id}/teach">Try teaching it back →</a>` : ''}</div></div></div>`;
}
ACT['rc-reset'] = () => { UI.recall = null; render(); };

// ═════════════════════════ COURSE REVIEW (mix lectures) ═════════════════════════
function courseNotebooks(course) { return S.notebooks.filter((n) => (n.course || 'Other') === course && n.digest); }
function renderCourse(course) {
  const R = UI.recall; const el = $('#view');
  if (R && R.scope === 'course:' + course) {
    el.innerHTML = `<div class="nb-head"><div><a href="#/" class="small">← All notebooks</a><h1>📚 ${esc(course)} · mixed review</h1></div></div><div id="tab" style="margin-top:14px"></div>`;
    return recallSession($('#tab'));
  }
  const nbs = courseNotebooks(course);
  const due = nbs.reduce((a, n) => a + dueCards(n).length, 0);
  const weak = nbs.flatMap((nb) => weakConcepts(nb, 4).map((w) => ({ ...w, nb }))).sort((a, b) => a.m - b.m).slice(0, 8);
  UI.aiGrade ??= true;
  el.innerHTML = `<div class="nb-head"><div><a href="#/" class="small">← All notebooks</a><h1>📚 ${esc(course)}</h1><div class="small muted">${nbs.length} lecture${nbs.length === 1 ? '' : 's'} with study kits</div></div></div>
  <div class="q-card stack" style="margin-top:16px">
    <div class="card overview"><h2>Mixed review across lectures</h2>
      <p>Cumulative exams don’t ask questions one lecture at a time, so practice the same way. Mixing topics forces you to work out <i>which</i> idea applies, which is exactly what the exam tests (this is called interleaving).</p>
      <div class="row">
        ${due ? `<button class="btn primary lg" data-act="course-start" data-mode="due">Mixed review (${Math.min(due, 30)} due)</button>` : '<span class="tag good">Nothing due across this course</span>'}
        <button class="btn" data-act="course-start" data-mode="weak">Weak spots from every lecture</button>
        <button class="btn" data-act="course-start" data-mode="cram">Cumulative cram (40 mixed)</button>
      </div>
      <label class="check small" style="margin-top:10px"><input type="checkbox" id="aiGrade" ${UI.aiGrade && S.status.claude ? 'checked' : ''} ${S.status.claude ? '' : 'disabled'}> AI grades my typed answers</label>
    </div>
    <div class="card bars"><h3>Lectures</h3>${nbs.map((nb) => `<div class="b"><a href="#/nb/${nb.id}"><b>${esc(nb.title)}</b></a><div class="meter"><i style="width:${pct(nbMastery(nb))}%"></i></div><span class="small">${pct(nbMastery(nb))}%</span><span class="small muted">${dueCards(nb).length} due</span></div>`).join('')}</div>
    ${weak.length ? `<div class="card bars"><h3>🎯 Weakest concepts in ${esc(course)}</h3>${weak.map((w) => `<div class="b"><span><b>${esc(w.c.name)}</b><div class="small muted">${esc(w.nb.title)}</div></span><div class="meter"><i style="width:${pct(w.m)}%"></i></div><span class="small">${pct(w.m)}%</span><a class="btn sm" href="#/nb/${w.nb.id}/recall/${w.c.id}">Drill</a></div>`).join('')}</div>` : ''}
  </div>`;
  $('#aiGrade')?.addEventListener('change', (e) => (UI.aiGrade = e.target.checked));
}
ACT['course-start'] = (el) => {
  const course = decodeURIComponent(location.hash.split('/')[2] || ''); const mode = el.dataset.mode;
  const items = courseNotebooks(course).flatMap((nb) => poolFor(nb, mode).map((card) => ({ nb, card })));
  beginSession('course:' + course, '', items, mode === 'due' ? 30 : 40);
};

// Voice dictation (Web Speech API) for typed answers
function micBtn(target) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  return SR ? `<button class="btn mic ${UI.mic === target ? 'on' : ''}" data-act="mic" data-target="${target}" title="Dictate">🎤${UI.mic === target ? ' Listening…' : ''}</button>` : '';
}
ACT.mic = (el) => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition; const target = el.dataset.target;
  if (UI.recog) { UI.recog.stop(); UI.recog = null; UI.mic = null; el.classList.remove('on'); el.textContent = '🎤'; return; }
  const r = new SR(); r.continuous = true; r.interimResults = false; r.lang = 'en-US';
  r.onresult = (e) => { const ta = $('#' + target); if (!ta) return; for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) ta.value += (ta.value && !/\s$/.test(ta.value) ? ' ' : '') + e.results[i][0].transcript.trim(); ta.dispatchEvent(new Event('input')); };
  r.onend = () => { UI.recog = null; UI.mic = null; const b = $(`[data-act="mic"][data-target="${target}"]`); if (b) { b.classList.remove('on'); b.textContent = '🎤'; } };
  r.onerror = (e) => toast('Mic: ' + e.error, 'err');
  r.start(); UI.recog = r; UI.mic = target; el.classList.add('on'); el.textContent = '🎤 Listening…';
};

// ═════════════════════════ TEACH BACK (Feynman) ═════════════════════════
function renderTeach(nb, el) {
  const prompts = nb.digest.feynman_prompts;
  UI.teachSel = Math.min(UI.teachSel ?? 0, prompts.length - 1);
  const p = prompts[UI.teachSel]; const hist = nb.feynman[p.concept_id + ':' + UI.teachSel] || [];
  const last = [...hist].reverse().find((h) => h.result);
  const followUp = last?.result?.follow_up_question;
  const best = (i) => Math.max(0, ...(nb.feynman[prompts[i].concept_id + ':' + i] || []).map((h) => h.result?.score || 0));
  el.innerHTML = `<div class="split">
    <div class="card tight prompt-list"><h3 style="padding:4px 8px">Pick a concept</h3>${prompts.map((x, i) => `<a href="#" data-act="teach-sel" data-i="${i}" class="${i === UI.teachSel ? 'on' : ''}">
      <div class="row between"><b class="small">${esc(conceptName(nb, x.concept_id))}</b>${best(i) ? `<span class="tag ${best(i) >= 75 ? 'good' : 'warn'}">${Math.round(best(i))}</span>` : ''}</div></a>`).join('')}</div>
    <div class="stack">
      <div class="card overview"><div class="small muted">🗣️ Feynman technique: if you can explain it simply, you understand it.</div><h2 style="margin-top:6px">${esc(p.prompt)}</h2>
        <div class="small muted">Explain in your own words, without looking. Use an example or analogy. Say it out loud with 🎤 if you like.</div></div>
      ${hist.map((h) => h.who === 'student' ? `<div class="card tight"><div class="small muted">You explained</div>${esc(h.text)}</div>` : h.result ? feynmanResult(h.result) : '').join('')}
      <div class="card stack">
        ${followUp ? `<div><span class="tag accent">Follow-up</span> <b>${esc(followUp)}</b></div>` : ''}
        <textarea id="teachIn" style="min-height:140px" placeholder="${followUp ? 'Answer the follow-up, or improve your explanation…' : 'Start explaining like you’re teaching it…'}">${esc(UI.teachDraft || '')}</textarea>
        <div class="row">${micBtn('teachIn')}<span class="spacer"></span>
          ${S.status.claude ? `<button class="btn primary" data-act="teach-submit" ${UI.teachBusy ? 'disabled' : ''}>${UI.teachBusy ? '<span class="spinner"></span> Reviewing…' : 'Get feedback'}</button>`
            : '<button class="btn primary" data-act="teach-self">Compare with the lecture</button>'}</div>
      </div></div></div>`;
  $('#teachIn').addEventListener('input', (e) => (UI.teachDraft = e.target.value));
}
function feynmanResult(r) {
  const vlabel = { mastered: 'Mastered', solid: 'Solid', developing: 'Getting there', needs_work: 'Needs work' }[r.verdict] || r.verdict;
  return `<div class="card verdict ${r.verdict}" style="margin:0"><div class="row" style="align-items:flex-start;gap:16px">
    <div class="score-ring" style="--p:${Math.round(r.score)}"><b>${Math.round(r.score)}</b></div>
    <div style="flex:1;min-width:220px"><h3>${esc(vlabel)}</h3>
      ${r.nailed?.length ? `<div class="small"><b>You nailed</b><ul class="list-good">${r.nailed.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${r.gaps?.length ? `<div class="small"><b>Gaps to fill</b><ul class="list-gap">${r.gaps.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${r.misconceptions?.length ? `<div class="small"><b>Misconceptions</b><ul class="list-bad">${r.misconceptions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${r.better_analogy ? `<div class="small mnemo">🔗 ${esc(r.better_analogy)}</div>` : ''}</div></div></div>`;
}
ACT['teach-sel'] = (el) => { UI.teachSel = +el.dataset.i; UI.teachDraft = ''; render(); };
ACT['teach-submit'] = async () => {
  const nb = curNb(); const p = nb.digest.feynman_prompts[UI.teachSel]; const key = p.concept_id + ':' + UI.teachSel;
  const text = $('#teachIn').value.trim(); if (text.length < 15) return toast('Write a bit more — at least a couple of sentences', 'err');
  const hist = (nb.feynman[key] ||= []);
  UI.teachBusy = true; render();
  try {
    const r = await ai('feynman', { sources: aiSources(nb), concept: conceptName(nb, p.concept_id), prompt: p.prompt, explanation: text,
      history: hist.map((h) => ({ who: h.who, text: h.who === 'student' ? h.text : `score ${h.result?.score}; follow-up asked: ${h.result?.follow_up_question}` })) });
    hist.push({ who: 'student', text }, { who: 'tutor', result: r });
    record(nb, p.concept_id, Math.min(1, r.score / 100));
    UI.teachDraft = ''; await save(nb); await gainXP(20, 'teach-back');
  } catch (e) { aiError(e); }
  UI.teachBusy = false; render();
};
ACT['teach-self'] = () => {
  const nb = curNb(); const p = nb.digest.feynman_prompts[UI.teachSel]; const c = nb.digest.concepts.find((x) => x.id === p.concept_id);
  const text = $('#teachIn').value; const cov = coverage(text, c.definition + ' ' + c.why_it_matters);
  modal(`<h2>Compare your explanation</h2><div class="answer-box"><div class="small muted">Lecture definition</div>${esc(c.definition)}<div class="small muted" style="margin-top:6px">Why it matters</div>${esc(c.why_it_matters)}</div>
    <p class="small">Your explanation covered about <b>${pct(cov)}%</b> of the key terms. Did you explain the <i>why</i>, not just the <i>what</i>?</p>
    <div class="row" style="justify-content:flex-end"><button class="btn bad" data-act="teach-rate" data-v="0">Missed a lot</button><button class="btn warn" data-act="teach-rate" data-v="0.5">Partly</button><button class="btn good" data-act="teach-rate" data-v="1">Nailed it</button></div>`);
};
ACT['teach-rate'] = async (el) => {
  const nb = curNb(); const p = nb.digest.feynman_prompts[UI.teachSel]; const key = p.concept_id + ':' + UI.teachSel; const v = +el.dataset.v;
  (nb.feynman[key] ||= []).push({ who: 'student', text: $('#teachIn')?.value || UI.teachDraft || '' }, { who: 'tutor', result: { score: v * 100, verdict: v === 1 ? 'solid' : v ? 'developing' : 'needs_work', nailed: [], gaps: [], misconceptions: [], follow_up_question: '', better_analogy: '' } });
  record(nb, p.concept_id, v); UI.teachDraft = ''; closeModal(); await save(nb); await gainXP(12, 'teach-back'); render();
};

// ═════════════════════════ TUTOR (Socratic chat) ═════════════════════════
function renderTutor(nb, el) {
  const cs = nb.digest?.concepts || [];
  const weak = nb.digest ? weakConcepts(nb, 1)[0]?.c : null;
  const pick = weak || cs[Math.floor(Math.random() * cs.length)];
  const starters = nb.digest ? [
    'Quiz me on the hardest idea in this lecture',
    pick ? `Help me understand ${pick.name} with an analogy` : 'Give me an analogy for the main idea',
    'Walk me through the main process step by step, asking me as we go',
    'What would a tricky exam question on this look like?',
  ] : ['Summarize this material', 'Quiz me on it'];
  el.innerHTML = `<div class="card chat">
    <div class="row between" style="padding-bottom:8px;border-bottom:1px solid var(--border)"><div><b>💬 Socratic tutor</b><div class="small muted">Answers with guiding questions so you do the thinking. Say “just tell me” when you’re stuck.</div></div>
      ${nb.chat.length ? '<button class="btn sm ghost" data-act="chat-clear">Clear</button>' : ''}</div>
    <div class="log" id="chatLog">${nb.chat.length ? nb.chat.map((m) => `<div class="msg ${m.role}">${m.role === 'user' ? esc(m.content) : md(m.content)}</div>`).join('')
      : `<div class="muted small" style="margin:auto;text-align:center">Ask anything about <b>${esc(nb.title)}</b>.</div>`}</div>
    <div class="chips" style="padding:8px 0">${starters.map((s) => `<button data-act="chat-starter">${esc(s)}</button>`).join('')}</div>
    <form id="chatForm"><textarea id="chatIn" placeholder="${nb.sources.length ? 'Ask or answer… (Enter to send, Shift+Enter for new line)' : 'Add material first'}" ${S.status.claude && nb.sources.length ? '' : 'disabled'}></textarea>
      <button class="btn primary" type="submit" ${S.status.claude && nb.sources.length ? '' : 'disabled'}>Send</button></form>
    ${S.status.claude ? '' : '<div class="small muted" style="margin-top:6px">The tutor needs the AI — see Settings.</div>'}</div>`;
  const log = $('#chatLog'); log.scrollTop = log.scrollHeight;
  const inp = $('#chatIn');
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); } });
  $('#chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendChat(nb, inp.value.trim()); });
}
ACT['chat-starter'] = (el) => sendChat(curNb(), el.textContent);
ACT['chat-clear'] = async () => { const nb = curNb(); nb.chat = []; await save(nb); render(); };
async function sendChat(nb, text) {
  if (!text || UI.chatBusy) return;
  if (!S.status.claude) return openSettings();
  nb.chat.push({ role: 'user', content: text }); UI.chatBusy = true; render();
  const log = $('#chatLog'); const bubble = document.createElement('div'); bubble.className = 'msg assistant'; bubble.innerHTML = '<span class="spinner"></span>'; log.appendChild(bubble); log.scrollTop = log.scrollHeight;
  let out = '';
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources: aiSources(nb), messages: nb.chat.slice(-12) }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); const e = new Error(j.error || 'Chat failed'); e.code = j.code; throw e; }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let k; while ((k = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, k).replace(/^data: /, ''); buf = buf.slice(k + 2);
        try { const ev = JSON.parse(line); if (ev.text) { out += ev.text; bubble.innerHTML = md(out); log.scrollTop = log.scrollHeight; } if (ev.error) toast(ev.error, 'err'); } catch { /* partial */ }
      }
    }
    if (out) { nb.chat.push({ role: 'assistant', content: out }); await gainXP(2); }
  } catch (e) { aiError(e); nb.chat.pop(); }
  UI.chatBusy = false; await save(nb);
  if (route().tab === 'tutor') render();
}

// ═════════════════════════ VIDEOS (found on YouTube by Gemini + Google Search) ═════════════════════════
const VID_PER_SEARCH = 6;
function renderVideos(nb, el) {
  nb.videos ||= [];
  const busy = UI.vidBusy?.nb === nb.id ? UI.vidBusy : null;
  const weak = weakConcepts(nb, 5);
  const order = ['', ...nb.digest.concepts.map((c) => c.id)];
  const groups = order.map((cid) => ({ cid, list: nb.videos.filter((v) => (order.includes(v.concept_id) ? v.concept_id : '') === cid) })).filter((g) => g.list.length);
  const watched = nb.videos.filter((v) => v.watched).length;
  el.innerHTML = `<div class="stack">
    <div class="card overview"><h2>🎬 Videos</h2>
      <p style="margin:0 0 4px">Short, trusted explainers matched to this lecture. Each one comes with <b>questions to watch for</b>. Read them first, watch, then prove it stuck by quizzing yourself or teaching it back.</p>
      <div class="small muted">${S.status.youtube ? 'Gemini picks what to search and real YouTube videos are found for you (about 30 seconds).' : 'Gemini picks the best YouTube search for each concept, with questions to watch for. Tap a card to see the results on YouTube.'}</div>
      ${busy ? `<div class="row" style="margin-top:12px"><span class="spinner"></span><span>Searching YouTube${busy.label ? ' for <b>' + esc(busy.label) + '</b>' : ''} and checking each link…</span></div>`
        : `<div class="row" style="margin-top:12px;flex-wrap:wrap;gap:8px">
        <button class="btn primary" data-act="vid-find">${nb.videos.length ? '🔎 Find more videos' : '🔎 Find videos for this lecture'}</button>
        ${weak.length ? `<button class="btn" data-act="vid-find" data-weak="1">🎯 Videos for my weak spots</button>` : ''}
      </div>
      <form class="row" id="vidSearch" style="margin-top:10px;gap:8px"><input type="text" id="vidQ" placeholder="Or search a topic, e.g. “accommodation of the lens”" style="flex:1;min-width:200px"><button class="btn" type="submit">Search</button></form>`}
    </div>
    ${!nb.videos.length && !busy ? `<div class="card empty"><div class="big">🎬</div><h3>No videos yet</h3><p class="muted">Tap “Find videos for this lecture” and Gemini will pick one good video for each key concept.</p></div>` : ''}
    ${nb.videos.length ? `<div class="small muted">${watched}/${nb.videos.length} watched</div>` : ''}
    ${groups.map((g) => `<div class="section"><div class="row between"><h3 style="margin:0">${g.cid ? esc(conceptName(nb, g.cid)) : 'Whole lecture'}</h3>${g.cid ? `<button class="btn sm ghost" data-act="vid-find" data-cid="${g.cid}">🔎 Another video</button>` : ''}</div></div>
      <div class="vids">${g.list.map((v) => videoCard(nb, v)).join('')}</div>`).join('')}
  </div>`;
  $('#vidSearch')?.addEventListener('submit', (e) => { e.preventDefault(); const q = $('#vidQ').value.trim(); if (q) findVideos(nb, { focus: q, label: q }); });
}
function videoCard(nb, v) {
  if (v.search) return searchCard(nb, v);
  const playing = UI.vidPlay === v.id;
  const tp = nb.digest.feynman_prompts?.findIndex((p) => p.concept_id === v.concept_id) ?? -1;
  return `<div class="card vid ${v.watched ? 'watched' : ''}">
    <div class="vid-frame">${playing
      ? `<iframe src="https://www.youtube-nocookie.com/embed/${esc(v.id)}?autoplay=1&rel=0&modestbranding=1" title="${esc(v.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`
      : `<button class="vid-thumb" data-act="vid-play" data-id="${esc(v.id)}" aria-label="Play ${esc(v.title)}"><img loading="lazy" alt="" src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg"><span class="vid-play">▶</span>${v.watched ? '<span class="vid-done">✓ Watched</span>' : ''}</button>`}</div>
    <div class="stack" style="gap:6px">
      <b>${esc(v.title)}</b>
      <div class="small muted">${esc(v.channel)}${v.level ? ` · ${esc(v.level)}` : ''}</div>
      ${v.why ? `<div class="small">${esc(v.why)}</div>` : ''}
      ${v.watch_for?.length ? `<div class="watch-for"><b class="small">🎯 Watch for</b><ol>${v.watch_for.map((q) => `<li>${esc(q)}</li>`).join('')}</ol></div>` : ''}
      <div class="row" style="flex-wrap:wrap;gap:6px">
        ${v.watched ? `${v.concept_id && nb.cards.some((c) => c.concept_id === v.concept_id) ? `<a class="btn sm primary" href="#/nb/${nb.id}/recall/${esc(v.concept_id)}">🧠 Quiz me on this</a>` : ''}${tp >= 0 ? `<button class="btn sm" data-act="vid-teach" data-i="${tp}">🗣️ Teach it back</button>` : ''}`
          : `<button class="btn sm primary" data-act="vid-watched" data-id="${esc(v.id)}">✓ I watched it</button>`}
        <a class="btn sm ghost" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener">Open on YouTube ↗</a>
        <button class="btn sm ghost" data-act="vid-remove" data-id="${esc(v.id)}" title="Remove this video">✕</button>
      </div>
    </div></div>`;
}
function searchCard(nb, v) {
  const tp = nb.digest.feynman_prompts?.findIndex((p) => p.concept_id === v.concept_id) ?? -1;
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(v.query)}`;
  return `<div class="card vid ${v.watched ? 'watched' : ''}">
    <a class="vid-search" href="${url}" target="_blank" rel="noopener"><span class="vid-search-icon">▶</span><span>🔎 Find on YouTube</span><b>“${esc(v.query)}”</b>${v.watched ? '<span class="vid-done">✓ Watched</span>' : ''}</a>
    <div class="stack" style="gap:6px">
      <div class="small muted">${v.level ? esc(v.level) + ' · ' : ''}pick one of the top results</div>
      ${v.why ? `<div class="small">${esc(v.why)}</div>` : ''}
      ${v.watch_for?.length ? `<div class="watch-for"><b class="small">🎯 Watch for</b><ol>${v.watch_for.map((q) => `<li>${esc(q)}</li>`).join('')}</ol></div>` : ''}
      <div class="row" style="flex-wrap:wrap;gap:6px">
        ${v.watched ? `${v.concept_id && nb.cards.some((c) => c.concept_id === v.concept_id) ? `<a class="btn sm primary" href="#/nb/${nb.id}/recall/${esc(v.concept_id)}">🧠 Quiz me on this</a>` : ''}${tp >= 0 ? `<button class="btn sm" data-act="vid-teach" data-i="${tp}">🗣️ Teach it back</button>` : ''}`
          : `<button class="btn sm primary" data-act="vid-watched" data-id="${esc(v.id)}">✓ I watched one</button>`}
        <button class="btn sm ghost" data-act="vid-remove" data-id="${esc(v.id)}" title="Remove">✕</button>
      </div>
    </div></div>`;
}
async function findVideos(nb, { focus = '', cid = '', weak = false, label = '' } = {}) {
  if (UI.vidBusy) return toast('Already searching. One moment');
  if (!S.status.claude) { toast('Finding videos needs the AI tutor. See Settings', 'err'); return openSettings(); }
  nb.videos ||= [];
  const c = cid && nb.digest.concepts.find((x) => x.id === cid);
  const weakNames = weakConcepts(nb, 5).map((w) => w.c.name);
  let wanted = VID_PER_SEARCH;
  if (c) { focus = `${c.name}: ${c.definition}`; label = c.name; wanted = 2; }
  else if (weak) { focus = `my weakest concepts: ${weakNames.join('; ')}`; label = 'your weak spots'; wanted = Math.min(VID_PER_SEARCH, weakNames.length + 1); }
  else if (!focus) {
    // first pass covers concepts that don't have a video yet
    const covered = new Set(nb.videos.map((v) => v.concept_id));
    const left = nb.digest.concepts.filter((x) => !covered.has(x.id));
    if (nb.videos.length && left.length) focus = `concepts that don't have a video yet: ${left.slice(0, 8).map((x) => x.name).join('; ')}`;
  }
  UI.vidBusy = { nb: nb.id, label }; if (route().tab === 'videos') render();
  try {
    const r = await ai('videos', {
      title: nb.digest.title || nb.title, course: nb.course, count: wanted, focus, weak: weakNames,
      concepts: nb.digest.concepts.map((x) => ({ id: x.id, name: x.name, definition: x.definition })),
      have: nb.videos.map((v) => v.id), haveTopics: nb.videos.map((v) => v.query || v.title).slice(-30),
    });
    const fresh = (r.videos || []).filter((v) => !nb.videos.some((x) => x.id === v.id)).map((v) => ({ ...v, concept_id: c ? c.id : v.concept_id, added: Date.now(), watched: false }));
    nb.videos.push(...fresh); await save(nb);
    toast(fresh.length ? `Added ${fresh.length} video${fresh.length === 1 ? '' : 's'} ✓` : 'Nothing new found. Try a different search', fresh.length ? '' : 'err');
  } catch (e) { aiError(e); }
  UI.vidBusy = null;
  if (route().tab === 'videos' && route().id === nb.id) render();
}
ACT['vid-find'] = (el) => findVideos(curNb(), { cid: el.dataset.cid || '', weak: !!el.dataset.weak });
ACT['vid-play'] = (el) => { UI.vidPlay = el.dataset.id; render(); };
ACT['vid-watched'] = async (el) => {
  const nb = curNb(); const v = nb.videos.find((x) => x.id === el.dataset.id); if (!v) return;
  v.watched = Date.now(); UI.vidPlay = null; await save(nb); render();
  gainXP(10, 'Watched with a purpose');
};
ACT['vid-concept'] = (el) => {
  const nb = curNb(); const cid = el.dataset.cid;
  go(`#/nb/${nb.id}/videos`);
  if (!(nb.videos || []).some((v) => v.concept_id === cid)) findVideos(nb, { cid });
};
ACT['vid-teach'] = (el) => { UI.teachSel = +el.dataset.i; UI.teachDraft = ''; go(`#/nb/${curNb().id}/teach`); };
ACT['vid-remove'] = async (el) => {
  const nb = curNb(); const i = nb.videos.findIndex((x) => x.id === el.dataset.id); if (i < 0) return;
  const [v] = nb.videos.splice(i, 1); if (UI.vidPlay === v.id) UI.vidPlay = null;
  await save(nb); render();
  toast('Video removed', '', { label: 'Undo', fn: async () => { nb.videos.splice(i, 0, v); await save(nb); render(); } });
};

// ═════════════════════════ PRACTICE EXAM ═════════════════════════
function renderExam(nb, el) {
  const X = UI.exam;
  if (X && X.nb === nb.id && X.phase === 'take') return examTake(nb, el);
  if (X && X.nb === nb.id && X.phase === 'grading') { el.innerHTML = `<div class="card building"><div class="spinner lg" style="margin:0 auto"></div><h2 style="margin-top:14px">Grading your exam…</h2></div>`; return; }
  if (X && X.nb === nb.id && X.phase === 'results') return examResults(nb, el);
  const weak = weakConcepts(nb, 6);
  el.innerHTML = `<div class="q-card stack">
    <div class="card overview"><h2>📝 Practice exam</h2><p>A fresh, mixed exam: multiple choice + short answer, topics interleaved like the real thing. ${weak.length ? `About half will target your weak spots: <b>${weak.map((w) => esc(w.c.name)).join(', ')}</b>.` : ''}</p>
      <div class="row" style="align-items:flex-end;gap:16px"><div class="field"><span>Questions</span><div class="seg" role="group" aria-label="Number of questions">${[5, 10, 15, 20, 25, 30].map((n) => `<button type="button" class="${(UI.exCount || 15) === n ? 'on' : ''}" data-act="ex-count" data-n="${n}" aria-pressed="${(UI.exCount || 15) === n}">${n}</button>`).join('')}</div></div>
        <label class="check" style="margin-bottom:8px"><input type="checkbox" id="exTimer" checked> Timed (~1.5 min / question)</label></div>
      <div class="row" style="margin-top:12px">${X?.loading ? '<button class="btn primary lg" disabled><span class="spinner"></span> Writing your exam…</button>' : `<button class="btn primary lg" data-act="exam-gen">${S.status.claude ? 'Generate exam' : 'Start exam from my cards'}</button>`}</div></div>
    ${nb.exams.length ? `<div class="card"><h3>Past exams</h3><div class="row" style="align-items:flex-end;gap:6px;height:110px">${nb.exams.slice(-12).map((x) => `<div title="${new Date(x.date).toLocaleDateString()}: ${pct(x.score)}%" style="flex:1;max-width:40px;height:${Math.max(6, pct(x.score))}%;background:var(--accent);border-radius:6px 6px 2px 2px"></div>`).join('')}</div>
      <div class="small muted" style="margin-top:6px">Last: ${pct(nb.exams.at(-1).score)}% · Best: ${pct(Math.max(...nb.exams.map((x) => x.score)))}%</div></div>` : ''}</div>`;
}
ACT['exam-gen'] = async () => {
  const nb = curNb(); const count = UI.exCount || 15; const timed = $('#exTimer').checked;
  UI.exam = { nb: nb.id, loading: true }; render();
  let questions;
  try {
    if (S.status.claude) {
      const r = await ai('exam', { sources: aiSources(nb), concepts: nb.digest.concepts.map((c) => ({ id: c.id, name: c.name })), weak: weakConcepts(nb, 6).map((w) => w.c.name), count, seen: nb.seenExamQs.slice(-60) });
      questions = r.questions.filter((q) => q.type === 'short' || (q.options?.length >= 2 && q.options.includes(q.answer)));
    } else {
      questions = [...nb.cards].sort(() => Math.random() - 0.5).slice(0, count).map((c) => ({ type: 'short', question: c.question, options: [], answer: c.answer, explanation: '', concept_id: c.concept_id }));
    }
  } catch (e) { UI.exam = null; aiError(e); return render(); }
  if (S.status.claude) {
    const pics = nb.cards.filter((c) => c.kind === 'picture').sort(() => Math.random() - 0.5).slice(0, Math.min(3, Math.ceil(count / 5)));
    pics.forEach((c) => questions.splice(Math.floor(Math.random() * (questions.length + 1)), 0, { type: 'short', question: c.question, options: [], answer: c.answer, explanation: '', concept_id: c.concept_id, image: c.image }));
  } else questions.forEach((q, k) => { const c = nb.cards.find((x) => x.question === q.question); if (c?.image) questions[k].image = c.image; });
  await loadVisuals(nb);
  questions.forEach((q) => { if (q.type === 'mcq') q.options = [...q.options].sort(() => Math.random() - 0.5); });
  UI.exam = { nb: nb.id, phase: 'take', questions, answers: questions.map(() => ''), i: 0, start: Date.now(), deadline: timed ? Date.now() + questions.length * 90e3 : 0 };
  render();
};
function examTake(nb, el) {
  const X = UI.exam; const q = X.questions[X.i];
  el.innerHTML = `<div class="q-card stack">
    <div class="row between"><div class="qnav">${X.questions.map((_, i) => `<button class="${X.answers[i] ? 'ans' : ''} ${i === X.i ? 'cur' : ''}" data-act="ex-go" data-i="${i}">${i + 1}</button>`).join('')}</div>
      ${X.deadline ? '<span class="timer" id="exTimerLbl"></span>' : ''}</div>
    <div class="card"><div class="small muted">Question ${X.i + 1} of ${X.questions.length} · ${q.image ? '🖼️ Picture question' : q.type === 'mcq' ? 'Multiple choice' : 'Short answer'}</div>
      ${q.image ? `<div style="margin-top:10px">${(UI.shots ||= {}, shotStrip('ex', refShots(nb, [q.image])))}</div>` : ''}
      <div class="q-text">${esc(q.question)}</div>
      ${q.type === 'mcq' ? q.options.map((o, j) => `<label class="opt ${X.answers[X.i] === o ? 'sel' : ''}"><input type="radio" name="exopt" value="${j}" ${X.answers[X.i] === o ? 'checked' : ''}> <span>${esc(o)}</span></label>`).join('')
        : `<textarea id="exShort" placeholder="Your answer…">${esc(X.answers[X.i])}</textarea>`}
      <div class="row" style="margin-top:14px"><button class="btn" data-act="ex-go" data-i="${X.i - 1}" ${X.i === 0 ? 'disabled' : ''}>← Back</button><span class="spacer"></span>
        ${X.i < X.questions.length - 1 ? `<button class="btn primary" data-act="ex-go" data-i="${X.i + 1}">Next →</button>` : ''}
        <button class="btn ${X.i === X.questions.length - 1 ? 'primary' : ''}" data-act="ex-submit">Submit exam</button></div></div></div>`;
  $$('input[name=exopt]').forEach((r) => r.addEventListener('change', () => { X.answers[X.i] = q.options[+r.value]; $$('.opt').forEach((o, j) => o.classList.toggle('sel', j === +r.value)); $$('.qnav button')[X.i].classList.add('ans'); }));
  $('#exShort')?.addEventListener('input', (e) => { X.answers[X.i] = e.target.value; });
  clearInterval(UI.exTick);
  if (X.deadline) {
    const tick = () => { const l = $('#exTimerLbl'); if (!l || UI.exam?.phase !== 'take') return clearInterval(UI.exTick); const s = Math.max(0, Math.round((X.deadline - Date.now()) / 1000)); l.textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; l.classList.toggle('low', s < 60); if (!s) { clearInterval(UI.exTick); toast('Time’s up!'); ACT['ex-submit'](null, null, true); } };
    tick(); UI.exTick = setInterval(tick, 1000);
  }
}
ACT['ex-go'] = (el) => { const X = UI.exam; const i = +el.dataset.i; if (i < 0 || i >= X.questions.length) return; X.i = i; render(); };
ACT['ex-submit'] = async (_el, _e, force) => {
  const nb = curNb(); const X = UI.exam;
  const blank = X.answers.filter((a) => !a.trim()).length;
  if (!force && blank && !confirm(`${blank} question(s) unanswered. Submit anyway?`)) return;
  clearInterval(UI.exTick); X.phase = 'grading'; X.elapsed = Date.now() - X.start; render();
  const results = new Array(X.questions.length);
  const jobs = X.questions.map((q, i) => async () => {
    const a = X.answers[i].trim();
    if (q.type === 'mcq') return (results[i] = { verdict: a === q.answer ? 'correct' : 'incorrect' });
    if (!a) return (results[i] = { verdict: 'incorrect', feedback: 'Left blank.' });
    if (S.status.claude) {
      const quick = quickGrade(a, q.answer); if (quick) return (results[i] = quick);
      try { return (results[i] = await ai('grade', { sources: aiSources(nb), concept: conceptName(nb, q.concept_id), question: q.question, answer: q.answer, response: a })); }
      catch (e) { if (e.code === 'no_key') throw e; }
    }
    const c = coverage(a, q.answer); results[i] = { verdict: c >= 0.6 ? 'correct' : c >= 0.35 ? 'partial' : 'incorrect', feedback: 'Auto-checked by keyword overlap. Compare with the answer below.' };
  });
  try { for (let k = 0; k < jobs.length; k += 4) await Promise.all(jobs.slice(k, k + 4).map((f) => f())); }
  catch (e) { aiError(e); X.phase = 'take'; return render(); }
  X.results = results;
  const val = (r) => (r.verdict === 'correct' ? 1 : r.verdict === 'partial' ? 0.5 : 0);
  const byConcept = {};
  X.questions.forEach((q, i) => { const b = (byConcept[q.concept_id] ||= { got: 0, n: 0 }); b.got += val(results[i]); b.n++; record(nb, q.concept_id, val(results[i])); });
  const score = results.reduce((a, r) => a + val(r), 0) / results.length;
  nb.exams.push({ date: Date.now(), score, total: results.length, byConcept });
  nb.seenExamQs.push(...X.questions.map((q) => q.question)); nb.seenExamQs = nb.seenExamQs.slice(-150);
  X.score = score; X.byConcept = byConcept; X.phase = 'results';
  await save(nb); await gainXP(Math.round(results.reduce((a, r) => a + val(r) * 10, 0)) + 10, 'exam');
  render();
};
function examResults(nb, el) {
  const X = UI.exam;
  el.innerHTML = `<div class="q-card stack">
    <div class="card row" style="gap:20px"><div class="score-ring" style="--p:${pct(X.score)}"><b>${pct(X.score)}%</b></div>
      <div style="flex:1"><h2>${X.score >= 0.9 ? 'Outstanding! 🏆' : X.score >= 0.75 ? 'Solid work 💪' : X.score >= 0.6 ? 'Getting there 📈' : 'Good practice, now target the gaps 🎯'}</h2>
      <div class="small muted">${X.questions.length} questions · ${Math.round(X.elapsed / 60000)} min</div>
      <div class="row" style="margin-top:8px"><button class="btn primary" data-act="ex-new">New exam</button><button class="btn" data-act="drill-weak">Drill weak spots</button></div></div></div>
    <div class="card bars"><h3>By concept</h3>${Object.entries(X.byConcept).sort((a, b) => a[1].got / a[1].n - b[1].got / b[1].n).map(([cid, b]) => `<div class="b"><span>${esc(conceptName(nb, cid))}</span><div class="meter"><i style="width:${pct(b.got / b.n)}%"></i></div><span class="small">${b.got}/${b.n}</span><span></span></div>`).join('')}</div>
    ${X.questions.map((q, i) => { const r = X.results[i]; return `<div class="card"><div class="row between"><span class="small muted">Q${i + 1} · ${esc(conceptName(nb, q.concept_id))}</span><span class="tag ${r.verdict === 'correct' ? 'good' : r.verdict === 'partial' ? 'warn' : 'bad'}">${r.verdict}</span></div>
      ${q.image ? (UI.shots ||= {}, shotStrip(`exr${i}`, refShots(nb, [q.image]))) : ''}
      <div class="q-text" style="font-size:1.05rem">${esc(q.question)}</div>
      ${q.type === 'mcq' ? q.options.map((o) => `<div class="opt ${o === q.answer ? 'right' : o === X.answers[i] ? 'wrong' : ''}" style="cursor:default">${o === q.answer ? '✓' : o === X.answers[i] ? '✗' : '•'} ${esc(o)}</div>`).join('')
        : `<div class="answer-box"><div class="small muted">Your answer</div>${esc(X.answers[i]) || '<i class="muted">blank</i>'}</div><div class="answer-box"><div class="small muted">Answer</div>${esc(q.answer)}</div>`}
      ${r.feedback ? `<p class="small" style="margin-top:8px">${esc(r.feedback)}</p>` : ''}${q.explanation ? `<p class="small muted">${esc(q.explanation)}</p>` : ''}</div>`; }).join('')}</div>`;
}
ACT['ex-count'] = (el) => { UI.exCount = +el.dataset.n; $$('[data-act="ex-count"]').forEach((b) => { const on = b === el; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }); };
ACT['ex-new'] = () => { UI.exam = null; render(); };

// ═════════════════════════ PROGRESS ═════════════════════════
function renderProgress(nb, el) {
  const cs = nb.digest.concepts.map((c) => ({ c, m: mastery(nb, c.id), st: nb.conceptStats[c.id] })).sort((a, b) => (a.m ?? -1) - (b.m ?? -1));
  const reviews = nb.cards.reduce((a, c) => a + c.history.length, 0);
  el.innerHTML = `<div class="stack">
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      <div class="card tight"><b style="font-size:1.5rem">${pct(nbMastery(nb))}%</b><div class="small muted">overall mastery</div></div>
      <div class="card tight"><b style="font-size:1.5rem">${reviews}</b><div class="small muted">recall attempts</div></div>
      <div class="card tight"><b style="font-size:1.5rem">${Object.values(nb.feynman).flat().filter((h) => h.result).length}</b><div class="small muted">teach-backs</div></div>
      <div class="card tight"><b style="font-size:1.5rem">${nb.exams.length ? pct(nb.exams.at(-1).score) + '%' : '—'}</b><div class="small muted">last exam</div></div>
    </div>
    ${(() => {
      const hs = nb.cards.flatMap((c) => c.history).filter((h) => h.c);
      if (hs.length < 5) return '<div class="card tight small muted">📏 Rate how sure you are before checking answers in Recall. After a few, you’ll see how well your confidence matches reality here.</div>';
      const row = (k) => { const x = hs.filter((h) => h.c === k); const ok = x.filter((h) => h.v === 'correct').length; return { k, n: x.length, r: x.length ? ok / x.length : null }; };
      const rows = ['sure', 'unsure', 'guess'].map(row); const sure = rows[0];
      return `<div class="card bars"><h3>📏 Confidence check</h3><p class="small muted">How often you’re actually right when you feel sure, unsure or guessing. ${sure.n >= 3 ? (sure.r >= 0.85 ? 'Your “sure” is trustworthy. Nice calibration.' : `When you feel sure you’re right only ${pct(sure.r)}% of the time, so double-check what feels obvious.`) : ''}</p>
        ${rows.filter((x) => x.n).map((x) => `<div class="b"><span>${CONF[x.k]}</span><div class="meter"><i style="width:${pct(x.r)}%"></i></div><span class="small">${pct(x.r)}%</span><span class="small muted">${x.n}×</span></div>`).join('')}</div>`;
    })()}
    <div class="card bars"><h3>Concept mastery</h3><p class="small muted">Built from every recall card, card-recall, teach-back and exam answer. Untested concepts count as 0%.</p>
      ${cs.map(({ c, m, st }) => `<div class="b"><span><b>${esc(c.name)}</b><div class="small muted">${st ? `${st.attempts} attempt${st.attempts > 1 ? 's' : ''}` : 'not tested yet'}</div></span>
        <div class="meter"><i style="width:${pct(m ?? 0)}%;${m !== null && m < 0.4 ? 'background:var(--bad)' : ''}"></i></div><span class="small">${m === null ? '—' : pct(m) + '%'}</span>
        <a class="btn sm" href="#/nb/${nb.id}/recall/${c.id}">Drill</a></div>`).join('')}</div></div>`;
}

// ═════════════════════════ SETTINGS ═════════════════════════
function openSettings() {
  const st = S.status;
  modal(`<h2>Settings</h2><div class="stack">
    <div class="card flat tight"><b>AI tutor: Google Gemini</b><div class="small" style="margin-top:4px">${st.ownKey
      ? '<span class="tag good">✓ your key</span> Using your own free Gemini key. It’s saved only in this browser and is only passed on to Google.'
      : st.sharedKey ? '<span class="tag good">✓ on</span> Using this site’s free shared allowance. If it ever runs out for the day, you can add your own free key below.'
      : '<span class="tag bad">off</span> Add a free Gemini key below to turn on the AI tutor.'}</div></div>
    <label class="field"><span>Your Gemini API key (optional)</span><input type="password" id="kGemini" placeholder="${st.ownKey ? '•••••••• saved (leave blank to keep)' : 'Paste your key'}" autocomplete="off"></label>
    <div class="small muted">Get one free in about a minute at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>.${st.ownKey ? ' <a href="#" data-act="forget-key">Remove my key</a>' : ''}</div>
    <div class="field"><span>Gemini model</span><select id="kModel"><option value="auto">Automatic (Lite for quick tasks, Flash for kits &amp; exams)</option>${st.model ? `<option value="${esc(st.model)}" selected>${esc(st.model)}</option>` : ''}</select></div>
    <div class="small muted">On Gemini’s free tier Google may use what you send to improve its products, so don’t upload anything private.</div>
    <div class="row" style="justify-content:flex-end"><button class="btn primary" data-act="save-settings">Save</button></div>
    <hr style="border:0;border-top:1px solid var(--border)">
    <h3>Your data</h3><p class="small muted">Your notebooks, pictures and progress are saved privately in this browser on this device. Nobody else can see them, not even the site owner. Clearing this site’s data in your browser erases them, so export a backup now and then (you can import it on another device too).</p>
    <div class="row"><button class="btn" data-act="export">⬇️ Export backup</button><label class="btn" style="position:relative">⬆️ Import backup<input type="file" id="importIn" accept=".json" class="file-hidden"></label></div>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-act="close-modal">Close</button></div></div>`);
  $('#importIn')?.addEventListener('change', importData);
  if (st.claude) {
    api('/api/models', null, 'GET').then((r) => {
      const sel = $('#kModel'); if (!sel) return;
      const cur = EncodeWeb.model();
      sel.innerHTML = `<option value="auto">Automatic (Lite for quick tasks, Flash for kits &amp; exams)</option>` + r.models.map((m) => `<option value="${esc(m.id)}" ${cur === m.id ? 'selected' : ''}>${esc(m.label)} (${esc(m.id)})</option>`).join('');
    }).catch(() => {});
  }
}
ACT.settings = openSettings;
ACT['save-settings'] = async () => {
  const body = { model: $('#kModel').value };
  const g = $('#kGemini').value.trim(); if (g) body.gemini_key = g;
  try { await api('/api/settings', body); await refreshStatus(); toast('Saved'); closeModal(); render(); } catch (e) { toast(e.message, 'err'); }
};
ACT['forget-key'] = async () => { await api('/api/settings', { gemini_key: '' }); await refreshStatus(); toast('Your key was removed from this browser'); openSettings(); };
ACT.export = async () => {
  const visuals = await DB.all('visuals');
  const blob = new Blob([JSON.stringify({ app: 'encode', version: 2, exported: Date.now(), meta: S.meta, notebooks: S.notebooks, visuals })], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `3nc0de-backup-${dayKey()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
async function importData(e) {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text()); if (data.app !== 'encode') throw new Error('Not a 3nc0de backup');
    for (const v of data.visuals || []) await DB.put('visuals', v);
    for (const nb of data.notebooks) { const i = S.notebooks.findIndex((n) => n.id === nb.id); if (i >= 0) S.notebooks[i] = nb; else S.notebooks.push(nb); await DB.put('notebooks', nb); }
    S.meta.xp = Math.max(S.meta.xp, data.meta?.xp || 0); S.meta.days = { ...(data.meta?.days || {}), ...S.meta.days }; await saveMeta();
    toast(`Imported ${data.notebooks.length} notebook(s)`); closeModal(); render();
  } catch (err) { toast('Import failed: ' + err.message, 'err'); }
}

// ───────────────────────── boot ─────────────────────────
(async function boot() {
  try {
    const data = await DB.load();
    S.notebooks = data.notebooks || [];
    if (data.meta) S.meta = { key: 'stats', xp: 0, days: {}, ...data.meta };
  } catch {
    $('#view').innerHTML = '<div class="card empty"><div class="big">🔒</div><h3>3nc0de can’t save in this browser</h3><p class="muted">Your browser is blocking website storage (private browsing, or cookies/site data turned off). Open Encode in a normal window, then reload.</p></div>';
    return;
  }
  render();
  await migrateFromBrowser();
  await refreshStatus();
  render();
  EncodeWeb.cleanTrash();
  // Coming back to this tab: pick up anything changed on another device/tab (unless mid-session).
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || UI.recall?.queue?.length > UI.recall?.i || UI.exam?.phase === 'take' || UI.building || UI.chatBusy || UI.teachBusy) return;
    try {
      const data = await DB.load();
      const stamp = (list) => list.map((n) => n.id + n.updated).sort().join();
      if (stamp(data.notebooks) !== stamp(S.notebooks) || (data.meta?.xp ?? 0) !== S.meta.xp) {
        S.notebooks = data.notebooks; if (data.meta) S.meta = { key: 'stats', ...data.meta }; render();
      }
    } catch { /* offline: keep what we have */ }
  });
})();
