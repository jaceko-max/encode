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
function words(s) { return norm(s).split(' ').filter((w) => (/\d/.test(w) || w.length > 2) && !STOP.has(w)); }
const wordCount = (s) => (String(s || '').match(/\S+/g) || []).length;
const TOUCH = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
// AI text: show typed arrows as real arrows
const tx = (s) => esc(s).replace(/-&gt;/g, '→').replace(/&lt;-(?!-)/g, '←');
// "Source 1"-style labels mean nothing to a student: show the source's name, or nothing for a one-source notebook
function refLabel(nb, ref) {
  const m = String(ref || '').match(/^\s*source\s*(\d+)\s*$/i); if (!m) return String(ref || '');
  const srcs = (nb.sources || []).filter((s) => s.kind !== 'guide'); if (srcs.length <= 1) return '';
  return String(srcs[+m[1] - 1]?.name || '').slice(0, 28);
}
const CARD_KIND = { define: 'Define it', explain: 'Explain why', compare: 'Compare', apply: 'Apply it', sequence: 'Put in order' };
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
  if (S.status?.public) return; // the web version has no dashboard to send this to
  clearTimeout(summaryTimer);
  summaryTimer = setTimeout(() => {
    const nbs = [...S.notebooks].sort((a, b) => dueCards(b).length - dueCards(a).length || b.updated - a.updated);
    const weak = nbs.flatMap((nb) => weakConcepts(nb, 3).map((w) => ({ concept: w.c.name, cid: w.c.id, notebook: nb.title, nb: nb.id, mastery: Math.round(w.m * 100) })))
      .sort((a, b) => a.mastery - b.mastery).slice(0, 3);
    const nextDue = nbs.flatMap((nb) => nb.cards.map((c) => c.srs.due)).filter((t) => t > Date.now()).sort((a, b) => a - b)[0] || null;
    const body = {
      updated: Date.now(), streak: streak(), studiedToday: !!S.meta.days[dayKey()], xp: S.meta.xp, level: level(), rank: rankInfo().label,
      due: nbs.reduce((a, n) => a + dueCards(n).length, 0), nextDue,
      days: Object.keys(S.meta.days).sort().slice(-90),
      notebooks: nbs.slice(0, 6).map((nb) => ({ id: nb.id, title: nb.title, course: nb.course, due: dueCards(nb).length, dues: nb.cards.map((c) => c.srs.due), mastery: Math.round(nbMastery(nb) * 100), next: nextStep(nb).label, nextTab: nextStep(nb).tab })),
      weak,
    };
    fetch('/api/summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  }, 1200);
}

// XP, levels, streaks
// ───────────── Ranks: XP climbs a crystal ladder. Each step unlocks something cosmetic (studying is never locked). ─────────────
const RANKS = [
  { id: 'shard', name: 'Shard', c: '#aab6cc', step: 100 },
  { id: 'quartz', name: 'Quartz', c: '#ff9cc8', step: 150 },
  { id: 'topaz', name: 'Topaz', c: '#f7b94a', step: 200 },
  { id: 'amethyst', name: 'Amethyst', c: '#b18cff', step: 300 },
  { id: 'sapphire', name: 'Sapphire', c: '#4f8dff', step: 400 },
  { id: 'emerald', name: 'Emerald', c: '#34d98a', step: 500 },
  { id: 'ruby', name: 'Ruby', c: '#ff5470', step: 650 },
  { id: 'diamond', name: 'Diamond', c: '#c9f6ff', step: 800 },
  { id: 'prism', name: 'Prism', c: '#e0e7ff', top: true },
];
const TIERS = (() => { const out = []; let xp = 0; RANKS.forEach((r, ri) => { if (r.top) { out.push({ ri, tier: 0, min: xp }); return; } for (let t = 1; t <= 3; t++) { out.push({ ri, tier: t, min: xp }); xp += r.step; } }); return out; })();
function tierAt(xp) { let i = 0; while (i + 1 < TIERS.length && xp >= TIERS[i + 1].min) i++; return i; }
const tierLabel = (i) => { const t = TIERS[i]; const r = RANKS[t.ri]; return r.top ? r.name : `${r.name} ${t.tier}`; };
function rankInfo(xp = S.meta.xp) {
  const i = tierAt(xp); const t = TIERS[i]; const nx = TIERS[i + 1];
  return { i, r: RANKS[t.ri], ri: t.ri, tier: t.tier, label: tierLabel(i), into: xp - t.min, need: nx ? nx.min - t.min : 0, next: !!nx, nextLabel: nx ? tierLabel(i + 1) : '' };
}
function level() { return tierAt(S.meta.xp) + 1; } // kept for the dashboard summary
const PRISM_GRAD = 'linear-gradient(120deg, #ff5f8f, #ffd166, #5cf28a, #5ff2ff, #a78bfa)';
const THEMES = [
  { id: 'crystal', name: 'Crystal', g1: '#4f7dff', g2: '#3dd6f5', a: '#4fa8ff', at: 0 },
  { id: 'quartz', name: 'Rose Quartz', g1: '#ff7eb6', g2: '#ffc2dc', a: '#ff9cc8', at: 3 },
  { id: 'topaz', name: 'Topaz', g1: '#f59e0b', g2: '#fde68a', a: '#fbbf24', at: 6 },
  { id: 'amethyst', name: 'Amethyst', g1: '#a78bfa', g2: '#e9d5ff', a: '#c4b5fd', at: 9 },
  { id: 'sapphire', name: 'Sapphire', g1: '#3b82f6', g2: '#93c5fd', a: '#60a5fa', at: 12 },
  { id: 'emerald', name: 'Emerald', g1: '#10b981', g2: '#6ee7b7', a: '#34d399', at: 15 },
  { id: 'ruby', name: 'Ruby', g1: '#fb3b5c', g2: '#fda4af', a: '#fb7185', at: 18 },
  { id: 'diamond', name: 'Diamond', g1: '#a5f3fc', g2: '#ffffff', a: '#cffafe', at: 21 },
  { id: 'prism', name: 'Prism', g1: '#ff5f8f', g2: '#5ff2ff', a: '#a5b4fc', at: 24, prism: true },
];
const TITLES = [
  { id: 'fresh', name: 'Fresh Mind', at: 0 }, { id: 'notes', name: 'Note Taker', at: 1 }, { id: 'flipper', name: 'Card Flipper', at: 4 },
  { id: 'pretest', name: 'Pretest Pro', at: 7 }, { id: 'recall', name: 'Recall Machine', at: 10 }, { id: 'mapper', name: 'Concept Mapper', at: 13 },
  { id: 'teacher', name: 'Teach-Back Star', at: 16 }, { id: 'slayer', name: 'Exam Slayer', at: 19 }, { id: 'palace', name: 'Memory Palace', at: 22 },
  { id: 'prism', name: 'Prism Mind', at: 24 },
];
const PLATES = [{ id: 'basic', name: 'Basic', at: 0, style: 'basic' },
  ...RANKS.map((r, ri) => ({ id: r.id, name: `${r.name} nameplate`, ri, at: r.top ? 24 : ri * 3 + 2, style: r.top ? 'prism' : ri >= 6 ? 'shine' : ri >= 3 ? 'glow' : 'line' }))];
// Weekly-prize items: owned once you've finished a week at #1 on the leaderboard.
const WON = () => (S.meta.lbWins || []).some((w) => w.place === 1);
TITLES.push({ id: 'champion', name: 'Weekly Champion', at: 999, special: true });
PLATES.push({ id: 'champion', name: 'Champion nameplate', at: 999, special: true, style: 'gold', c: '#f5c542' });
const owned = (item) => (item.special ? WON() : tierAt(S.meta.xp) >= item.at);
const lockText = (item) => (item.special ? '🔒 Win a week' : `🔒 ${esc(tierLabel(item.at))}`);
const plateColor = (p) => p.c || (p.ri !== undefined ? RANKS[p.ri].c : 'var(--border)');
function unlocksAt(i) {
  if (!i) return [];
  return [...THEMES.filter((t) => t.at === i).map((t) => `${t.name} theme`), ...TITLES.filter((t) => t.at === i).map((t) => `title “${t.name}”`),
    ...PLATES.filter((p) => p.at === i).map((p) => p.name)];
}
const prof = () => (S.meta.profile ||= { name: '', title: 'fresh', theme: 'crystal', plate: 'basic' });
const myTheme = () => { const t = THEMES.find((x) => x.id === prof().theme); return t && owned(t) ? t : THEMES[0]; };
const myTitle = () => { const t = TITLES.find((x) => x.id === prof().title); return t && owned(t) ? t : TITLES[0]; };
const myPlate = () => { const p = PLATES.find((x) => x.id === prof().plate); return p && owned(p) ? p : PLATES[0]; };
let themeKey = '';
function applyTheme() {
  const t = myTheme(); if (themeKey === t.id) return; themeKey = t.id;
  const st = document.documentElement.style;
  st.setProperty('--grad', t.prism ? PRISM_GRAD : `linear-gradient(135deg, ${t.g1}, ${t.g2})`);
  st.setProperty('--accent', t.a); st.setProperty('--accent-2', t.a); st.setProperty('--glow-tint', t.g1);
}
let EMB = 0;
function emblem(i = tierAt(S.meta.xp), size = 20) {
  const t = TIERS[i]; const r = RANKS[t.ri]; const id = 'emb' + (++EMB);
  const grad = r.top
    ? `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5f8f"/><stop offset=".35" stop-color="#ffd166"/><stop offset=".65" stop-color="#5cf28a"/><stop offset="1" stop-color="#5ff2ff"/></linearGradient>`
    : `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".42" stop-color="${r.c}"/><stop offset="1" stop-color="${r.c}" stop-opacity=".55"/></linearGradient>`;
  const pips = r.top ? '' : [...Array(t.tier)].map((_, k) => { const x = 32 + (k - (t.tier - 1) / 2) * 11; return `<path d="M${x} 60l4.5 4.5-4.5 4.5-4.5-4.5z" fill="${r.c}"/>`; }).join('');
  return `<svg class="emblem" width="${size}" height="${Math.round(size * 72 / 64)}" viewBox="0 0 64 72" aria-hidden="true"><defs>${grad}</defs>
    <path d="M32 4 54 20 46 54H18L10 20Z" fill="url(#${id})" stroke="rgba(255,255,255,.6)" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M10 20 22 24 32 4 42 24 54 20M22 24 18 54M42 24 46 54M22 24H42" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M22 24 32 54 42 24" fill="none" stroke="rgba(0,0,0,.2)" stroke-width="1.2" stroke-linejoin="round"/>${pips}</svg>`;
}
function rankUp(i) {
  confetti();
  const u = unlocksAt(i);
  const el = document.createElement('div'); el.className = 'rankup'; el.setAttribute('role', 'status');
  el.innerHTML = `${emblem(i, 54)}<div class="spacer"><div class="rankup-k">RANK UP</div><b>${esc(tierLabel(i))}</b>${u.length ? `<div class="small">Unlocked: ${u.map(esc).join(', ')}</div>` : ''}</div>
    <a class="btn sm" href="#/profile">View</a><button type="button" class="icon-btn quiet" aria-label="Close">✕</button>`;
  el.querySelectorAll('a, button').forEach((b) => b.addEventListener('click', () => el.remove()));
  document.body.appendChild(el); setTimeout(() => el.remove(), 9000);
}
function streak() {
  let n = 0; const d = new Date();
  if (!S.meta.days[dayKey(d)]) d.setDate(d.getDate() - 1); // today not studied yet → count up to yesterday
  while (S.meta.days[dayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
// Repeating the same exercise on the same day only earns XP if you beat your earlier score (stops XP farming).
function xpGain(nb, key, amount) {
  const day = dayKey(); const log = (nb.xpLog && nb.xpLog.day === day) ? nb.xpLog : (nb.xpLog = { day, best: {} });
  const prev = log.best[key] || 0; if (amount <= prev) return 0;
  log.best[key] = amount; return amount - prev;
}
async function gainXP(n, label) {
  if (!n) return;
  const before = tierAt(S.meta.xp); const k = dayKey();
  const wasFirstToday = !S.meta.days[k];
  S.meta.xp += n; S.meta.days[k] = (S.meta.days[k] || 0) + n;
  await saveMeta();
  toast(`+${n} XP${label ? ' · ' + label : ''}`, 'xp');
  if (wasFirstToday && streak() > 1) setTimeout(() => toast(`🔥 ${streak()}-day streak!`), 600);
  if (tierAt(S.meta.xp) > before) { const now = tierAt(S.meta.xp); setTimeout(() => rankUp(now), 900); }
  renderTop();
  if (route().view === 'home' || route().view === 'profile') render(); // keep the rank tile / profile current
  lbSync();
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
function newSrs() { return { due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0, state: 'new' }; }
const MAX_GAP_DAYS = 40;
// ───────────── Spaced repetition: Anki's scheduler (SM-2 with learning steps, default settings) ─────────────
const ANKI = {
  learn: [1, 10],        // learning steps (minutes) for new cards
  relearn: [10],         // relearning steps (minutes) after you forget a learned card
  gradIvl: 1,            // days after the last learning step (Good)
  easyIvl: 4,            // days when you press Easy on a new card
  startEase: 2.5, minEase: 1.3,
  hardMult: 1.2, easyBonus: 1.3, newIvlMult: 0, minIvl: 1,
  maxIvl: MAX_GAP_DAYS,  // Anki's "maximum interval", set for a semester
};
const MIN = 60e3;
const BTNS = ['again', 'hard', 'good', 'easy'];
const BTN_LABEL = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };
const BTN_V = { again: 'incorrect', hard: 'partial', good: 'correct', easy: 'correct' };
function srsState(card) {
  const s = card.srs; if (s.state) return s.state;
  if (s.reps > 0) return 'review';
  return card.history?.length ? 'learn' : 'new';
}
function fuzzDays(ivl) { // Anki spreads reviews a little so cards don't bunch up on one day
  if (ivl < 2.5) return ivl;
  const r = Math.max(1, Math.round(ivl * (ivl < 7 ? 0.15 : ivl < 20 ? 0.1 : 0.05)));
  return ivl + Math.floor(Math.random() * (2 * r + 1)) - r;
}
/** What pressing `btn` would do to this card. Pure: used for the button previews and for scheduling. */
function ankiNext(card, btn, now = Date.now(), fuzz = false) {
  const s = { ease: ANKI.startEase, lapses: 0, reps: 0, interval: 0, ...card.srs }; let st = srsState(card);
  if (st === 'new') { st = 'learn'; s.step = 0; }
  const cap = (d) => Math.max(ANKI.minIvl, Math.min(ANKI.maxIvl, Math.round(d)));
  const toReview = (days) => { const d = fuzz ? cap(fuzzDays(days)) : cap(days); return { ...s, state: 'review', step: null, interval: d, reps: (s.reps || 0) + 1, due: now + d * DAY, last: now }; };
  if (st === 'learn' || st === 'relearn') {
    const steps = st === 'learn' ? ANKI.learn : ANKI.relearn;
    const i = Math.min(s.step ?? 0, steps.length - 1);
    const stay = (mins, step) => ({ ...s, state: st, step, interval: 0, due: now + mins * MIN, last: now });
    if (btn === 'again') return stay(steps[0], 0);
    if (btn === 'hard') return stay(i === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2 : i === 0 ? Math.min(steps[0] * 1.5, steps[0] + 1440) : steps[i], i);
    if (btn === 'good') return i + 1 < steps.length ? stay(steps[i + 1], i + 1) : toReview(st === 'learn' ? ANKI.gradIvl : (s.lapseIvl || ANKI.minIvl));
    return toReview(st === 'learn' ? ANKI.easyIvl : (s.lapseIvl || ANKI.minIvl) + 1); // easy
  }
  // review card
  const ivl = Math.max(1, s.interval || 1);
  const late = Math.max(0, (now - (s.due || now)) / DAY);
  const early = (s.due || 0) > now;
  const elapsed = s.last ? Math.max(1, (now - s.last) / DAY) : ivl;
  if (btn === 'again') {
    return { ...s, state: 'relearn', step: 0, lapses: (s.lapses || 0) + 1, ease: Math.max(ANKI.minEase, s.ease - 0.2),
      lapseIvl: Math.max(ANKI.minIvl, Math.round(ivl * ANKI.newIvlMult)), interval: 0, due: now + ANKI.relearn[0] * MIN, last: now };
  }
  if (early) { // reviewing before it's due (cramming): keep the schedule, just push the due date out a little if needed
    const keep = { ...s, last: now, due: Math.max(s.due || now, now + Math.max(1, Math.min(ivl, elapsed * (btn === 'hard' ? 1 : s.ease))) * DAY) };
    return btn === 'hard' ? { ...keep, ease: Math.max(ANKI.minEase, s.ease - 0.15) } : btn === 'easy' ? { ...keep, ease: s.ease + 0.05 } : keep;
  }
  const base = ivl;
  const hard = Math.max(ivl + 1, base * ANKI.hardMult);
  const good = Math.max(hard + 1, early ? Math.max(ivl, elapsed * s.ease) : (ivl + late / 2) * s.ease);
  const easy = Math.max(good + 1, early ? Math.max(ivl, elapsed * s.ease * ANKI.easyBonus) : (ivl + late) * s.ease * ANKI.easyBonus);
  if (btn === 'hard') return { ...toReview(hard), ease: Math.max(ANKI.minEase, s.ease - 0.15) };
  if (btn === 'good') return toReview(good);
  return { ...toReview(easy), ease: s.ease + 0.15 };
}
function schedule(card, btn, conf = null) {
  if (!BTNS.includes(btn)) btn = { correct: 'good', partial: 'hard', incorrect: 'again' }[btn] || 'again'; // old callers
  card.srs = ankiNext(card, btn, Date.now(), true);
  card.history.push({ t: Date.now(), v: BTN_V[btn], b: btn, c: conf });
}
function fmtIvl(ms) {
  const m = ms / MIN;
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  const d = m / 1440; if (d < 60) return `${Math.round(d)}d`;
  return `${(d / 30).toFixed(1)}mo`;
}
// The AI's grade (and how sure you were) suggests a button; you decide, like in Anki.
function suggestBtn(R) {
  const v = R.result?.verdict; if (!v) return null;
  if (v === 'incorrect') return 'again';
  if (v === 'partial' || R.conf === 'guess') return 'hard';
  return 'good';
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
  try { S.status = await api('/api/status', null, 'GET'); S.status.checked = true; } catch { S.status = { claude: false, gemini: false, local: true, offline: true }; }
  renderBanner();
}

// ───────────────────────── chrome: top bar, toasts, modal ─────────────────────────
function renderTop() {
  applyTheme(); const rk = rankInfo();
  $('#topStats').innerHTML = `
    <span class="chip" title="Study streak">${icon('flame', 'flame')} ${streak()}</span>
    <a class="chip rank-chip" href="#/profile" title="${S.meta.xp} XP · your rank and profile">${emblem(rk.i, 16)} ${esc(rk.label)} <span class="bar"><i style="width:${rk.next ? pct(rk.into / rk.need) : 100}%"></i></span></a>`;
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
  const m = $('#modal'); const wasOpen = !m.classList.contains('hidden');
  if (!wasOpen) UI.modalReturn = document.activeElement; // put focus back here when it closes
  m.innerHTML = `<div class="box ${wide ? 'wide' : ''}">${html}</div>`; m.classList.remove('hidden');
  document.documentElement.classList.add('modal-open'); // the page behind doesn't scroll
  if (!wasOpen) setTimeout(() => { if (!m.contains(document.activeElement)) m.querySelector('input:not([type=hidden]), textarea, select, button')?.focus({ preventScroll: true }); }, 30);
  return m;
}
function closeModal() {
  const m = $('#modal'); if (m.classList.contains('hidden')) return;
  m.classList.add('hidden'); m.innerHTML = ''; document.documentElement.classList.remove('modal-open');
  try { UI.modalReturn?.focus?.({ preventScroll: true }); } catch { /* element gone */ } UI.modalReturn = null;
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.nb-card[tabindex]')) { e.preventDefault(); ACT['open-nb'](e.target); }
  if (e.key === 'Enter' && !e.shiftKey && e.target.matches?.('#modal input[type=text], #modal input[type=password], #modal input:not([type])')) {
    const btn = $('#modal .btn.primary'); if (btn) { e.preventDefault(); btn.click(); }
  }
});

// ───────────────────────── routing ─────────────────────────
function route() {
  const p = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (p[0] === 'nb' && p[1]) return { view: 'nb', id: p[1], tab: p[2] || '', arg: p[3] || '' };
  if (p[0] === 'course' && p[1]) return { view: 'course', course: p[1] };
  if (p[0] === 'profile') return { view: 'profile' };
  if (p[0] === 'leaderboard') return { view: 'leaderboard', admin: p[1] === 'admin' };
  return { view: 'home' };
}
const go = (h) => { if (location.hash === h) render(); else location.hash = h; };
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

// Re-drawing the page you're on keeps your place: the old height is held while new content
// (concept map, pictures) settles, and the scroll position is put back. Moving to a new page starts at the top.
let lastRenderKey = '';
const ANCHOR_SEL = '.card, .section, .tabs-bar';
function pickAnchor(view) {
  const line = 140; // just under the pinned header + tabs
  const els = [...view.querySelectorAll(ANCHOR_SEL)];
  for (let i = 0; i < els.length; i++) { const r = els[i].getBoundingClientRect(); if (r.bottom > line && r.height) return { i, id: els[i].id, top: r.top }; }
  return null;
}
function findAnchor(view, a) { return (a.id && document.getElementById(a.id)) || view.querySelectorAll(ANCHOR_SEL)[a.i] || null; }
// When you scroll, the page must never fight you. LAST_SCROLL marks when the page last moved; a re-render that happens
// while you're scrolling (or during iPhone momentum after your finger lifts) doesn't touch the scroll position at all.
let LAST_SCROLL = 0;
const HOVER = (() => { try { return matchMedia('(hover: hover)').matches; } catch { return false; } })();
window.addEventListener('scroll', () => {
  LAST_SCROLL = performance.now();
  if (!HOVER) return;
  // no hover "lift" effects while the page is moving (stops cards jumping under a still mouse)
  if (!document.documentElement.classList.contains('scrolling')) document.documentElement.classList.add('scrolling');
  clearTimeout(UI.scrollEndT); UI.scrollEndT = setTimeout(() => document.documentElement.classList.remove('scrolling'), 160);
}, { passive: true });
function render() {
  const key = location.hash; const same = key === lastRenderKey; lastRenderKey = key;
  const view = $('#view');
  if (!same || !view) { clearTimeout(UI.holdT); UI.anchorStop?.(); UI.anchorStop = null; if (view) view.style.minHeight = ''; return renderPage(); }
  steady(view, renderPage);
}
// Let go of the page's held height only when that can't pull the page up under you (e.g. while the AI is
// still thinking and the card is shorter than before). Otherwise try again a little later.
function releaseHold(view) {
  clearTimeout(UI.holdT);
  if (!view.isConnected || !view.style.minHeight) return;
  const held = view.style.minHeight; const y = window.scrollY;
  view.style.minHeight = '';
  if (window.scrollY < y - 1) { view.style.minHeight = held; window.scrollTo(0, y); UI.holdT = setTimeout(() => releaseHold(view), 1500); }
}
function steady(view, draw) {
  const y = window.scrollY; const anchor = pickAnchor(view);
  view.style.minHeight = Math.max(view.offsetHeight, parseFloat(view.style.minHeight) || 0) + 'px'; clearTimeout(UI.holdT); UI.anchorStop?.();
  const busyScrolling = performance.now() - LAST_SCROLL < 300;
  try { draw(); } finally {
    if (busyScrolling) { UI.holdT = setTimeout(() => releaseHold(view), 1200); } // you're scrolling: leave your position alone
    else {
      let expectY = window.scrollY;
      const fix = () => { const el = anchor && findAnchor(view, anchor); if (!el) return; const d = el.getBoundingClientRect().top - anchor.top; if (Math.abs(d) > 1) { window.scrollBy(0, d); } expectY = window.scrollY; };
      if (anchor) fix(); else if (Math.abs(window.scrollY - y) > 1) { window.scrollTo(0, y); expectY = window.scrollY; }
      // keep the card steady while pictures/maps above it finish loading, until you scroll yourself
      let live = true; const ro = 'ResizeObserver' in window ? new ResizeObserver(() => live && fix()) : null; ro?.observe(view);
      const onLoad = () => live && fix(); view.addEventListener('load', onLoad, true);
      // any scroll we didn't make ourselves (wheel, touch, momentum, scrollbar, keys) ends the steadying at once
      const onScroll = () => { if (Math.abs(window.scrollY - expectY) > 2) stop(); };
      const stop = () => { if (!live) return; live = false; ro?.disconnect(); view.removeEventListener('load', onLoad, true); window.removeEventListener('scroll', onScroll); ['wheel', 'touchstart', 'keydown'].forEach((ev) => window.removeEventListener(ev, stop)); };
      ['wheel', 'touchstart', 'keydown'].forEach((ev) => window.addEventListener(ev, stop, { passive: true }));
      window.addEventListener('scroll', onScroll, { passive: true });
      [30, 120, 300, 700, 1400].forEach((ms) => setTimeout(() => live && fix(), ms)); // maps and pictures that settle without a load event
      UI.anchorStop = stop;
      UI.holdT = setTimeout(() => { stop(); releaseHold(view); }, 2500);
    }
  }
}
// Half-typed text survives any redraw (uploads finishing, XP toasts, pictures loading…)
const DRAFT_SEL = '#guideText, #pasteName, #pasteText, #urlIn, [data-pre], [data-cr]';
const draftKey = (el) => `${location.hash}|${el.id || (el.dataset.pre !== undefined ? 'pre' + el.dataset.pre : 'cr' + el.dataset.cr)}`;
document.addEventListener('input', (e) => { if (e.target.matches?.(DRAFT_SEL)) (UI.drafts ||= {})[draftKey(e.target)] = e.target.value; });
function restoreDrafts() { if (!UI.drafts) return; document.querySelectorAll(DRAFT_SEL).forEach((el) => { const v = UI.drafts[draftKey(el)]; if (v != null && !el.value) el.value = v; }); }
function clearDraft(sel) { const el = typeof sel === 'string' ? document.querySelector(sel) : sel; if (el && UI.drafts) delete UI.drafts[draftKey(el)]; }
function renderPage() {
  try { renderPageInner(); } finally { restoreDrafts(); }
}
function renderPageInner() {
  renderTop();
  const r = route();
  if (r.view === 'nb') {
    const nb = getNb(r.id);
    if (!nb) return go('#/');
    return renderNotebook(nb, TABS.some(([k]) => k === r.tab) ? r.tab : nextStep(nb).tab, r.arg);
  }
  if (r.view === 'course') return go('#/'); // mixed-course review was removed; old links go home
  if (r.view === 'profile') return renderProfile();
  if (r.view === 'leaderboard') return renderLeaderboard();
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

// ───────────────────────── appearance: background ─────────────────────────
// Default is the black perspective grid. Photos come from Wikimedia Commons (free licenses; credit shown in the corner and in Settings).
const BGS = [{ id: 'grid', name: 'Grid', css: 'grid-floor' }, ...[{"id": "longroom", "name": "Long Room library", "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4b/Long_Room_Interior%2C_Trinity_College_Dublin%2C_Ireland_-_Diliff.jpg/1920px-Long_Room_Interior%2C_Trinity_College_Dublin%2C_Ireland_-_Diliff.jpg", "page": "https://commons.wikimedia.org/wiki/File:Long_Room_Interior,_Trinity_College_Dublin,_Ireland_-_Diliff.jpg", "by": "Diliff", "license": "CC BY-SA 4.0", "pos": "50% 45%"}, {"id": "peabody", "name": "Peabody Library", "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c1/George-peabody-library.jpg/1920px-George-peabody-library.jpg", "page": "https://commons.wikimedia.org/wiki/File:George-peabody-library.jpg", "by": "Matthew Petroff", "license": "CC BY-SA 3.0", "pos": "50% 40%"}, {"id": "moraine", "name": "Moraine Lake", "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c5/Moraine_Lake_17092005.jpg/1920px-Moraine_Lake_17092005.jpg", "page": "https://commons.wikimedia.org/wiki/File:Moraine_Lake_17092005.jpg", "by": "Gorgo", "license": "Public domain", "pos": "50% 50%"}, {"id": "clearwater", "name": "Lake Clearwater", "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/52/Lake_Clearwater%2C_Canterbury%2C_New_Zealand_02.jpg/1920px-Lake_Clearwater%2C_Canterbury%2C_New_Zealand_02.jpg", "page": "https://commons.wikimedia.org/wiki/File:Lake_Clearwater,_Canterbury,_New_Zealand_02.jpg", "by": "Michal Klajban", "license": "CC BY-SA 4.0", "pos": "50% 50%"}, {"id": "archway", "name": "Sea arch", "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/da/Island_Archway%2C_Great_Ocean_Rd%2C_Victoria%2C_Australia_-_Nov_08.jpg/1920px-Island_Archway%2C_Great_Ocean_Rd%2C_Victoria%2C_Australia_-_Nov_08.jpg", "page": "https://commons.wikimedia.org/wiki/File:Island_Archway,_Great_Ocean_Rd,_Victoria,_Australia_-_Nov_08.jpg", "by": "Diliff", "license": "CC BY-SA 3.0", "pos": "50% 50%"}, {"id": "dunes", "name": "Dunes at dawn", "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/cb/Utah_Dunes_Landscape_-_West_Desert_District.jpg/1920px-Utah_Dunes_Landscape_-_West_Desert_District.jpg", "page": "https://commons.wikimedia.org/wiki/File:Utah_Dunes_Landscape_-_West_Desert_District.jpg", "by": "Bob Wick, BLM", "license": "Public domain", "pos": "50% 60%"}, {"id": "forest", "name": "Pine forest (painting)", "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1e/Shishkin%2C_Ivan_-_Morning_in_a_Pine_Forest.jpg/1920px-Shishkin%2C_Ivan_-_Morning_in_a_Pine_Forest.jpg", "page": "https://commons.wikimedia.org/wiki/File:Shishkin,_Ivan_-_Morning_in_a_Pine_Forest.jpg", "by": "Ivan Shishkin & Konstantin Savitsky", "license": "Public domain", "pos": "50% 50%"}, {"id": "aurora", "name": "Aurora", "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a6/Aurora_in_Abisko_near_Tornetr%C3%A4sk.jpg/1920px-Aurora_in_Abisko_near_Tornetr%C3%A4sk.jpg", "page": "https://commons.wikimedia.org/wiki/File:Aurora_in_Abisko_near_Tornetr%C3%A4sk.jpg", "by": "Pavel.shyshkouski", "license": "CC BY-SA 4.0", "pos": "50% 40%"}, {"id": "stars", "name": "Starry night", "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b4/ALMA_and_a_Starry_Night.jpg/1920px-ALMA_and_a_Starry_Night.jpg", "page": "https://commons.wikimedia.org/wiki/File:ALMA_and_a_Starry_Night.jpg", "by": "ESO/B. Tafreshi (twanight.org)", "license": "CC BY 4.0", "pos": "50% 50%"}, {"id": "moonlight", "name": "Moonlit boathouse", "url": "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8f/Holma_Boat_Club_by_the_light_of_the_moon.jpg/1920px-Holma_Boat_Club_by_the_light_of_the_moon.jpg", "page": "https://commons.wikimedia.org/wiki/File:Holma_Boat_Club_by_the_light_of_the_moon.jpg", "by": "W.carter", "license": "CC0", "pos": "40% 50%"}]];
// Your own picture: uploads are shrunk and kept only in this browser (IndexedDB); links are used as-is.
const OWN = { data: null, thumb: null, loaded: false };
function ownDB() { return new Promise((ok, no) => { const r = indexedDB.open('encode-bg', 1); r.onupgradeneeded = () => r.result.createObjectStore('img'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); }
async function ownGet() { const db = await ownDB(); return new Promise((ok, no) => { const q = db.transaction('img').objectStore('img').get('own'); q.onsuccess = () => ok(q.result || null); q.onerror = () => no(q.error); }); }
async function ownPut(v) { const db = await ownDB(); return new Promise((ok, no) => { const tx = db.transaction('img', 'readwrite'); tx.objectStore('img').put(v, 'own'); tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); }); }
async function loadOwn() { if (OWN.loaded) return; try { const v = await ownGet(); if (v) { OWN.data = v.data; OWN.thumb = v.thumb; } } catch { /* storage blocked */ } OWN.loaded = true; }
function ownBg() {
  const o = LOOK.own; if (!o) return null;
  if (o.kind === 'link') return /^https?:\/\/\S+$/i.test(o.url || '') ? { id: 'own', key: 'own:' + o.v, name: 'My picture', url: o.url, thumb: o.url, own: true } : null;
  return { id: 'own', key: 'own:' + o.v, name: 'My picture', url: OWN.data, thumb: OWN.thumb, own: true };
}
async function shrinkImage(file) {
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
    const draw = (max, q) => {
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
      const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', q);
    };
    return { data: draw(2560, 0.86), thumb: draw(400, 0.8) };
  } finally { URL.revokeObjectURL(src); }
}
const FIT_SIZE = { fill: 'cover', fit: 'contain', stretch: '100% 100%' };
const LOOK_KEY = 'encode-look-v2';
const LOOK = { theme: 'dark', bg: 'grid', strength: 'balanced', custom: null, own: null, fit: 'fill' };
try { const saved = JSON.parse(localStorage.getItem(LOOK_KEY) || 'null'); if (saved) Object.assign(LOOK, { bg: saved.bg || 'grid', strength: saved.strength || 'balanced', custom: saved.custom || null, own: saved.own || null, fit: FIT_SIZE[saved.fit] ? saved.fit : 'fill' }); } catch { /* private mode */ }
const okPhoto = (u) => /^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(String(u || ''));
const cssUrl = (u) => `url(${String(u).replace(/["'()\\\s]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))})`;
const okBg = (b) => !!b && (okPhoto(b.url) || (b.web && /^https:\/\/\S+$/i.test(String(b.url || ''))));
function findBg(id) { if (id === 'own') return ownBg(); return BGS.find((x) => x.id === id) || (LOOK.custom && LOOK.custom.id === id && okBg(LOOK.custom) ? LOOK.custom : null); }
if (LOOK.bg !== 'none' && !findBg(LOOK.bg)) LOOK.bg = 'grid';
const thumbUrl = (b) => b.thumb || b.url.replace('/1920px-', '/500px-');
// small preview of a Commons file: …/commons/a/ab/Name.jpg → …/commons/thumb/a/ab/Name.jpg/500px-Name.jpg
const commonsThumb = (orig) => { const m = String(orig).match(/^(https:\/\/upload\.wikimedia\.org\/wikipedia\/commons)\/([0-9a-f]\/[0-9a-f]{2})\/([^/?#]+)$/); return m ? `${m[1]}/thumb/${m[2]}/${m[3]}/500px-${m[3]}` : orig; };
function applyLook() {
  const root = document.documentElement;
  root.dataset.theme = 'dark';
  root.dataset.strength = LOOK.strength;
  const b = LOOK.bg === 'none' ? null : findBg(LOOK.bg);
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
  if (!b || b.css) { layer.style.backgroundImage = ''; layer.style.backgroundSize = ''; layer.dataset.bg = b ? b.id : ''; layer.classList.toggle('ready', !!b); credit.hidden = true; return; }
  layer.style.backgroundSize = FIT_SIZE[LOOK.fit] || 'cover';
  if (b.own && LOOK.own?.kind === 'upload' && !OWN.loaded) { loadOwn().then(() => { if (LOOK.bg === 'own') applyLook(); }); return; }
  if (b.own && !b.url) { LOOK.bg = 'grid'; saveLook(); return; }
  credit.hidden = !!b.own;
  if (!b.own) credit.hidden = false; credit.href = /^https:\/\/commons\.wikimedia\.org\//.test(b.page || '') || (b.web && /^https:\/\//.test(b.page || '')) ? b.page : 'https://commons.wikimedia.org/';
  credit.textContent = `Photo: ${b.by}${b.license && b.license !== 'Public domain' ? ' · ' + b.license : ''}`;
  layer.style.backgroundPosition = b.pos || 'center';
  const key = b.key || b.id;
  if (layer.dataset.bg === key) return;
  layer.dataset.bg = key; layer.classList.remove('ready');
  const img = new Image();
  img.onload = () => { if (layer.dataset.bg !== key) return; layer.style.backgroundImage = cssUrl(b.url); requestAnimationFrame(() => layer.classList.add('ready')); };
  img.onerror = () => { if (layer.dataset.bg !== key) return; LOOK.bg = 'grid'; saveLook(); refreshLook(); toast(b.web || b.own ? 'That picture’s website won’t share it, so the grid is back. Save the picture and tap Upload a picture instead.' : 'That background couldn’t load, so the grid is back.'); };
  img.src = b.url;
}
function saveLook() { try { localStorage.setItem(LOOK_KEY, JSON.stringify({ bg: LOOK.bg, strength: LOOK.strength, custom: LOOK.custom, own: LOOK.own, fit: LOOK.fit })); } catch { /* private mode */ } applyLook(); }

// Search Wikimedia Commons for big, free landscape photos (no AI, no key; runs in the browser).
const htmlText = (h) => new DOMParser().parseFromString(String(h || ''), 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
async function commonsSearch(q, cat) {
  const p = new URLSearchParams({ action: 'query', format: 'json', origin: '*', generator: 'search', gsrnamespace: '6', gsrlimit: '40',
    gsrsearch: `${q}${cat ? ` incategory:"${cat}"` : ''} filetype:bitmap`, prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1920',
    iiextmetadatafilter: 'LicenseShortName|Artist' });
  const r = await fetch('https://commons.wikimedia.org/w/api.php?' + p);
  if (!r.ok) throw new Error('commons ' + r.status);
  const d = await r.json();
  return Object.values(d.query?.pages || {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((pg) => {
    const ii = pg.imageinfo?.[0];
    if (!ii || Math.max(ii.width, ii.height) < 1000) return null; // any shape, just not tiny
    const url = String(ii.thumburl || '').split('?')[0];
    if (!okPhoto(url)) return null;
    const orig = String(ii.url || '').split('?')[0];
    const thumb = url.includes('/1920px-') ? url.replace('/1920px-', '/500px-') : (ii.width > 500 ? commonsThumb(orig) : url);
    const md = ii.extmetadata || {};
    const name = String(pg.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    return { id: 'c' + pg.pageid, name, url, thumb, page: String(ii.descriptionurl || ''), by: htmlText(md.Artist?.value).slice(0, 60) || 'Unknown',
      license: htmlText(md.LicenseShortName?.value) || 'see source', pos: '50% 50%' };
  }).filter(Boolean);
}
// Google Images (through the site's serper.dev key) when it's set up; otherwise free Wikimedia photos.
async function googleImages(q) {
  const r = await fetch('/edge/images?q=' + encodeURIComponent(q), { headers: { 'x-encode': '1' } });
  if (!r.ok) throw new Error('images ' + r.status);
  const j = await r.json();
  return (j.images || []).slice(0, 18).map((i, n) => ({ id: 'g' + Date.now().toString(36) + n, web: true, name: i.title || i.source || 'Picture', url: i.url, thumb: i.thumb,
    page: i.page, by: i.source || 'the web', license: '', pos: '50% 50%' }));
}
async function searchBackgrounds(q) {
  if (S.status?.googleImages) {
    try { const g = await googleImages(q); if (g.length) return { list: g, source: 'google' }; } catch { /* fall back to Wikimedia */ }
  }
  return { list: await wikiBackgrounds(q), source: 'wikimedia' };
}
async function wikiBackgrounds(q) {
  let out = await commonsSearch(q, 'Featured_pictures_on_Wikimedia_Commons');
  if (out.length < 6) {
    try { const more = await commonsSearch(q, 'Quality_images'); out = [...out, ...more.filter((m) => !out.some((o) => o.id === m.id))]; } catch { /* keep what we have */ }
  }
  if (out.length < 6) { // still thin: search all of Wikimedia Commons
    try { const more = await commonsSearch(q, ''); out = [...out, ...more.filter((m) => !out.some((o) => o.id === m.id))]; } catch { /* keep what we have */ }
  }
  return out.slice(0, 12);
}

function bgButton(b, act, attrs) {
  const on = LOOK.bg === b.id ? 'on' : '';
  if (b.css) return `<button type="button" class="bg-opt grid-thumb ${on}" data-act="look-bg" data-v="${b.id}" title="Grid (default)"><span>Grid · default</span></button>`;
  return `<button type="button" class="bg-opt ${on}" data-act="${act}" ${attrs} title="${esc(b.name)}" style="background-image:${cssUrl(thumbUrl(b))};background-position:${esc(b.pos || 'center')}"><span>${esc(b.name)}</span></button>`;
}
function lookSection() {
  const seg = (act, cur, opts) => `<div class="seg">${opts.map(([v, l]) => `<button type="button" class="${cur === v ? 'on' : ''}" data-act="${act}" data-v="${v}">${l}</button>`).join('')}</div>`;
  const cur = LOOK.bg === 'none' ? null : findBg(LOOK.bg);
  const custom = okBg(LOOK.custom) ? LOOK.custom : null;
  const R = UI.bgSearch || {};
  const own = ownBg();
  return `<div class="look" id="lookBox">
    <h3 style="margin:0">Background</h3>
    <div class="bg-grid">
      ${bgButton(BGS[0])}
      <button type="button" class="bg-opt plain ${LOOK.bg === 'none' ? 'on' : ''}" data-act="look-bg" data-v="none"><span>Plain</span></button>
      ${own?.thumb ? bgButton(own, 'look-bg', 'data-v="own"') : ''}
      ${custom ? bgButton(custom, 'look-bg', `data-v="${esc(custom.id)}"`) : ''}
      ${BGS.slice(1).map((b) => bgButton(b, 'look-bg', `data-v="${b.id}"`)).join('')}
    </div>
    <div class="small muted">Your own picture</div>
    <div class="row bg-own"><label class="btn sm" style="position:relative">📁 Upload a picture<input type="file" id="bgFile" accept="image/*" class="file-hidden"></label>
      <input type="url" id="bgLink" placeholder="…or paste an image link" autocomplete="off" inputmode="url" enterkeyhint="go"><button type="button" class="btn sm" data-act="bg-link">Use link</button></div>
    <div class="small muted">Find more on the web</div>
    <div class="row bg-search"><input type="search" id="bgQ" placeholder="e.g. ocean, mountains, city at night, space" value="${esc(R.q || '')}" enterkeyhint="search" autocomplete="off">
      <button type="button" class="btn sm" data-act="bg-search" ${R.busy ? 'disabled' : ''}>${R.busy ? '<span class="spinner"></span> Searching' : '🔎 Search'}</button></div>
    ${R.err ? `<div class="small muted">${esc(R.err)}</div>` : ''}
    ${R.results?.length ? `<div class="bg-grid">${R.results.map((b, i) => bgButton(b, 'bg-pick', `data-i="${i}"`)).join('')}</div>
      <div class="small muted">${R.source === 'google' ? 'Pictures from Google Images. Tap one to use it. If one won’t load, save it and tap <b>Upload a picture</b>.' : 'Free-to-use photos from Wikimedia Commons. Tap one to use it.'}</div>` : ''}
    ${R.done && R.q && R.source !== 'google' ? `<div class="bg-google"><a class="btn sm" href="https://www.google.com/search?udm=2&amp;q=${encodeURIComponent(R.q + ' wallpaper')}" target="_blank" rel="noopener">Search Google Images for “${esc(R.q)}” ↗</a>
      <div class="small muted">Games, shows and anything else live there. Open a picture, then copy its image address (long-press on a phone, right-click on a computer) and paste it in the link box above. Or save it and tap <b>Upload a picture</b>.</div></div>` : ''}
    ${cur && !cur.css ? `<div class="row between"><span class="small muted">Picture fit</span>${seg('look-fit', LOOK.fit, [['fill', 'Fill'], ['fit', 'Fit'], ['stretch', 'Stretch']])}</div>
      <div class="row between"><span class="small muted">Photo strength</span>${seg('look-strength', LOOK.strength, [['subtle', 'Subtle'], ['balanced', 'Balanced'], ['vivid', 'Vivid']])}</div>
      ${cur.own ? '<div class="small muted">Your picture is saved only in this browser. Nobody else sees it.</div>' : cur.web ? `<div class="small muted">“${esc(cur.name)}” from ${/^https:\/\//.test(cur.page || '') ? `<a href="${esc(cur.page)}" target="_blank" rel="noopener">${esc(cur.by)}</a>` : esc(cur.by)}</div>` : `<div class="small muted">“${esc(cur.name)}” by ${esc(cur.by)} (${esc(cur.license)}), <a href="${esc(cur.page)}" target="_blank" rel="noopener">Wikimedia Commons</a></div>`}` : ''}
  </div>`;
}
function refreshLook() {
  if (LOOK.own?.kind === 'upload' && !OWN.loaded) loadOwn().then(refreshLook);
  const q = document.getElementById('bgQ'); if (q) (UI.bgSearch ||= {}).q = q.value;
  const el = document.getElementById('lookBox'); if (el) el.outerHTML = lookSection();
}
ACT['look-bg'] = (el) => { LOOK.bg = el.dataset.v; saveLook(); refreshLook(); };
ACT['look-fit'] = (el) => { LOOK.fit = el.dataset.v; saveLook(); refreshLook(); };
ACT['bg-link'] = () => {
  const inp = document.getElementById('bgLink'); const u = (inp?.value || '').trim();
  if (!/^https?:\/\/\S+$/i.test(u)) { toast('Paste a full link that starts with https://'); inp?.focus(); return; }
  const img = new Image();
  img.onload = () => { LOOK.own = { kind: 'link', url: u, v: Date.now() }; LOOK.bg = 'own'; saveLook(); refreshLook(); toast('Background set ✓'); };
  img.onerror = () => toast('That link isn’t a picture. Open the image by itself and copy that address, or save the picture and upload it.', 'err');
  img.src = u;
};
document.addEventListener('change', async (e) => {
  if (e.target?.id !== 'bgFile') return;
  const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
  if (file.type && !/^image\//.test(file.type)) { toast('That file isn’t a picture.', 'err'); return; }
  toast('Setting your background…');
  try {
    const { data, thumb } = await shrinkImage(file);
    await ownPut({ data, thumb }); OWN.data = data; OWN.thumb = thumb; OWN.loaded = true;
    LOOK.own = { kind: 'upload', v: Date.now() }; LOOK.bg = 'own'; saveLook(); refreshLook(); toast('Background set ✓');
  } catch { toast('Couldn’t open that picture. Try a JPG or PNG.', 'err'); }
});
ACT['look-strength'] = (el) => { LOOK.strength = el.dataset.v; saveLook(); refreshLook(); };
ACT['bg-pick'] = (el) => { const b = UI.bgSearch?.results?.[+el.dataset.i]; if (!b) return; LOOK.custom = b; LOOK.bg = b.id; saveLook(); refreshLook(); };
ACT['bg-search'] = async () => {
  const R = (UI.bgSearch ||= {}); const q = (document.getElementById('bgQ')?.value || '').trim(); R.q = q;
  if (!q) { document.getElementById('bgQ')?.focus(); return; }
  if (R.busy) return;
  R.busy = true; R.err = ''; refreshLook();
  try {
    const found = await searchBackgrounds(q); R.results = found.list; R.source = found.source;
    if (!R.results.length) R.err = found.source === 'google' ? `No pictures found for “${q}”.` : `Wikimedia has no free pictures for “${q}”. Try Google Images below.`;
  } catch { R.results = []; R.err = 'Couldn’t reach Wikimedia right now. Check your connection and try again.'; }
  R.busy = false; R.done = true; refreshLook();
};
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target?.id === 'bgQ') { e.preventDefault(); ACT['bg-search'](); } if (e.key === 'Enter' && e.target?.id === 'bgLink') { e.preventDefault(); ACT['bg-link'](); } });
applyLook();
if (LOOK.own?.kind === 'upload') loadOwn(); // so its preview is ready in Settings

// ═════════════════════════ HOME ═════════════════════════
// Donation note on the home page (email assembled at runtime so simple scrapers don't pick it up).
const DONATE_TO = ['kojace263', 'gmail.com'].join('@');
function donateCard() {
  return `<div class="card donate"><span class="donate-ico">${icon('coffee')}</span>
    <div class="spacer"><b>Help keep Etch free</b><div class="small muted">The AI costs real money to run. If Etch helps you study, please donate $1 on Zelle to <b class="donate-to">${DONATE_TO}</b>. <span style="white-space:nowrap">Thank you! – Ko</span></div></div>
    <button class="btn sm" data-act="copy-donate">Copy email</button></div>`;
}
ACT['copy-donate'] = async () => {
  try { await navigator.clipboard.writeText(DONATE_TO); toast('Email copied. Paste it in Zelle 💜'); }
  catch { toast(DONATE_TO); }
};
// Live clock with seconds on the home page (only ticks while home is showing)
const clockParts = (d = new Date()) => ({
  time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }),
  date: d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
  iso: d.toISOString(),
});
function clockHTML() { const c = clockParts(); return `<time class="home-clock" id="homeClock" datetime="${c.iso}"><b>${c.time}</b><span>${c.date}</span></time>`; }
function startClock() {
  clearTimeout(UI.clockT); clearInterval(UI.clockI);
  const tick = () => {
    const el = document.getElementById('homeClock'); if (!el) { clearInterval(UI.clockI); return; }
    const c = clockParts(); el.querySelector('b').textContent = c.time; el.querySelector('span').textContent = c.date; el.setAttribute('datetime', c.iso);
  };
  UI.clockT = setTimeout(() => { tick(); UI.clockI = setInterval(tick, 1000); }, 1000 - (Date.now() % 1000)); // line up with the real second
}
// ── Today's plan: the next three things worth doing, in the order that helps memory most ──
function planSteps(nbs, single = false) {
  const steps = [];
  const withKit = nbs.filter((n) => n.digest && n.digest.cards?.length);
  const learnNb = withKit.find((n) => !lessonsDone(n));
  if (learnNb) { const i = lessonNext(learnNb); steps.push({ icon: 'lessons', label: `Learn: ${learnNb.digest.cards[i].title}`, sub: single ? `Section ${i + 1} of ${learnNb.digest.cards.length}` : learnNb.title, href: `#/nb/${learnNb.id}/lessons/${i}` }); }
  else steps.push({ icon: 'lessons', label: 'Learn', sub: withKit.length ? 'Every section learned ✓' : 'Add a lecture to start', done: !!withKit.length, ...(withKit.length ? {} : { act: 'new-nb' }) });
  const due = nbs.reduce((a, n) => a + dueCards(n).length, 0);
  steps.push(due ? { icon: 'recall', label: `Review ${due} due card${due > 1 ? 's' : ''}`, sub: `about ${Math.max(1, Math.round(due * 20 / 60))} min · spaced review`, ...(single ? { href: `#/nb/${nbs[0].id}/recall` } : { act: 'review-all' }) }
    : { icon: 'recall', label: 'Reviews', sub: 'All caught up ✓', done: true });
  let teach = null;
  for (const nb of withKit) { for (const [i, L] of Object.entries(nb.lessons || {})) if (L?.done && !L.teach && nb.digest.cards[i] && L.title === nb.digest.cards[i].title) { teach = { nb, i: +i }; break; } if (teach) break; }
  if (teach) steps.push({ icon: 'teach', label: `Teach back: ${teach.nb.digest.cards[teach.i].title}`, sub: 'Explain it to a 12-year-old in 3 sentences', href: `#/nb/${teach.nb.id}/lessons/${teach.i}` });
  else {
    const examNb = withKit.find((n) => (n.lessons && Object.values(n.lessons).some((L) => L?.done)) && !(n.exams || []).some((x) => Date.now() - (x.at || x.date || 0) < 3 * 86400e3));
    steps.push(examNb ? { icon: 'exam', label: `Practice exam: ${examNb.title}`, sub: 'Mixed questions across the whole lecture', href: `#/nb/${examNb.id}/exam` }
      : { icon: 'teach', label: 'Teach back', sub: withKit.length ? 'Unlocks after you finish a section' : 'Unlocks after learning', done: true, muted: true });
  }
  return steps;
}
function planCardHTML(nbs) {
  const steps = planSteps(nbs); const first = steps.findIndex((s) => !s.done);
  return `<section class="section"><div class="card plan-card">
    <div class="row between"><h2 style="margin:0">${hIcon('plan')}Today’s plan</h2>${first >= 0 ? `<button class="btn primary" data-act="plan-go" data-n="${first}">Start: ${esc(steps[first].label.split(':')[0])} →</button>` : '<span class="tag good">All done for today ✓</span>'}</div>
    <ol class="plan">${steps.map((s, n) => `<li class="${s.done ? 'done' : ''} ${s.muted ? 'muted' : ''}"><span class="plan-n">${s.muted ? icon('lock') : s.done ? '✓' : n + 1}</span><span class="plan-ico">${icon(s.icon)}</span>
      <div class="plan-txt"><b>${esc(s.label)}</b><span class="small muted">${esc(s.sub)}</span></div>
      ${s.done ? '' : `<button class="btn sm" data-act="plan-go" data-n="${n}">Go</button>`}</li>`).join('')}</ol>
    <div class="small muted">Learn something new, then review what’s due (spaced recall), then explain it back.</div></div></section>`;
}
ACT['plan-go'] = (el) => {
  const nbs = route().view === 'nb' ? [curNb()] : [...S.notebooks].sort((a, b) => b.updated - a.updated);
  const s = planSteps(nbs, route().view === 'nb')[+el.dataset.n]; if (!s) return;
  if (s.act) return ACT[s.act]?.(el); if (s.href) go(s.href);
};
function nbPlanStrip(nb) {
  if (!nb.digest) return '';
  const steps = planSteps([nb], true).map((s, n) => ({ ...s, n })).filter((s) => !s.done);
  if (!steps.length) return '<div class="plan-strip"><span class="small muted">Today:</span> <span class="small">All done for this lecture ✓</span></div>';
  return `<div class="plan-strip"><span class="small muted">Today:</span>${steps.map((s, k) => `${k ? '<span class="plan-arrow">→</span>' : ''}<button class="plan-chip ${k ? '' : 'first'}" data-act="plan-go" data-n="${s.n}">${icon(s.icon)}${esc(s.label.length > 34 ? s.label.slice(0, 32) + '…' : s.label)}</button>`).join('')}</div>`;
}

function renderHome() {
  startClock(); setTimeout(homeLbCard, 0);
  const nbs = [...S.notebooks].sort((a, b) => b.updated - a.updated);
  const due = nbs.reduce((a, n) => a + dueCards(n).length, 0);
  const avgM = nbs.filter((n) => n.digest).map(nbMastery);
  const weak = nbs.flatMap((nb) => weakConcepts(nb, 6).map((w) => ({ ...w, nb }))).sort((a, b) => a.m - b.m).slice(0, 6);
  // this calendar week, Sunday → Saturday (days still ahead are shown faded)
  const sun = new Date(); sun.setHours(12, 0, 0, 0); sun.setDate(sun.getDate() - sun.getDay());
  const week = [...Array(7)].map((_, i) => { const d = new Date(sun); d.setDate(sun.getDate() + i); return { k: dayKey(d), l: d.toLocaleDateString('en-US', { weekday: 'narrow' }), full: d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }), future: dayKey(d) > dayKey() }; });
  const oneNb = new Set(weak.map((w) => w.nb.id)).size === 1;
  const pastDays = week.filter((d) => !d.future); const studied = pastDays.filter((d) => S.meta.days[d.k]).length;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  $('#view').innerHTML = `
  <section class="hero">
    <div class="card overview">
      ${clockHTML()}
      <h1>${greet}${prof().name ? `, ${esc(prof().name)}` : ''} 👋</h1>
      ${prof().name ? '' : '<a class="small hero-name-link" href="#/profile">Add your name and see your rank →</a>'}
      ${nbs.length ? ''
        : '<p class="muted">Add a lecture, see it as pictures and maps, then pull it back out of your head. Retrieval is what makes it stick.</p>'}
      <p class="small muted" style="margin:-4px 0 12px;${nbs.length ? 'display:none' : ''}">🔒 Free, no account. Your notebooks stay private in this browser on this device. Back them up anytime in ⚙︎ Settings.</p>
      <div class="row">
        <button class="btn ${nbs.length ? '' : 'primary lg'}" data-act="new-nb">＋ New notebook</button>
        ${nbs.some((n) => n.sample) ? '' : '<button class="btn ghost" data-act="sample">Try a sample lecture</button>'}
      </div>
    </div>
    ${nbs.length ? '' : `<div class="card how">
      <h2>How it works</h2>
      <ol class="how-steps">
        <li><b>Add a lecture</b><span>Slides, a PDF, your notes, photos of the board or a YouTube link.</span></li>
        <li><b>Build your study kit</b><span>About 30 seconds: visual cards, a concept map, flashcards and a pretest.</span></li>
        <li><b>Study by recalling</b><span>Answer from memory, teach it back, take practice exams. Earn XP and rank up.</span></li>
      </ol></div>`}
    <div class="card" style="${nbs.length ? '' : 'display:none'}">
      <div class="stat-grid">
        <div class="stat"><b>${icon('flame', 'flame')}${streak()}</b><span>day streak</span></div>
        <a class="stat rank-stat" href="#/profile"><b>${emblem(tierAt(S.meta.xp), 22)} ${esc(rankInfo().label)}</b><span>rank · ${S.meta.xp.toLocaleString()} XP</span></a>
        <div class="stat"><b>${due}</b><span>cards due</span></div>
        <div class="stat"><b>${avgM.length ? pct(avgM.reduce((a, b) => a + b, 0) / avgM.length) + '%' : '—'}</b><span>avg mastery</span></div>
      </div>
      <div class="week-cap small muted"><span>This week</span><span>${studied} of ${pastDays.length} day${pastDays.length === 1 ? '' : 's'} studied</span></div>
      <div class="week" aria-label="This week: ${studied} of ${pastDays.length} days studied">${week.map((d) => `<div class="d ${S.meta.days[d.k] ? 'on' : ''} ${d.k === dayKey() ? 'today' : ''} ${d.future ? 'future' : ''}" title="${d.full}${d.future ? '' : `: ${S.meta.days[d.k] || 0} XP`}"><i></i>${d.l}</div>`).join('')}</div>
    </div>
  </section>
  ${nbs.length ? planCardHTML(nbs) : ''}


  <section class="section">
    <div class="row between"><h2>Your notebooks</h2></div>
    ${nbs.length ? `<div class="grid">${nbs.map(nbCard).join('')}</div>` : `
      <div class="card empty"><div class="big">📚</div><h3>No notebooks yet</h3>
      <p class="muted" style="margin:0">One notebook per lecture or topic. Tap <b>＋ New notebook</b> above to start, or try the sample first.</p></div>`}
  </section>
  ${weak.length ? `<section class="section"><h2>${hIcon('target')}Weak spots</h2><p class="muted small">Concepts you’ve missed most. Drilling these is the fastest way to raise your score.</p>
    <div class="card flat bars">${weak.map((w) => `<div class="b"><div><b>${esc(w.c.name)}</b>${oneNb ? '' : `<div class="small muted">${esc(w.nb.title)}</div>`}</div>
      <div class="meter ${lvl(w.m)}"><i style="width:${pct(w.m)}%"></i></div><span class="small">${pct(w.m)}%</span>
      <a class="btn sm" href="#/nb/${w.nb.id}/recall/${w.c.id}">Drill</a></div>`).join('')}</div></section>` : ''}
  <section class="section" id="pomoHome">${UI.pmOpen ? pomoHomeHTML() : pomoBarHTML()}</section>
  ${S.status.public ? '<section class="section" id="homeLb"></section>' : ''}
  ${nbs.some((n) => n.digest) ? donateCard() : ''}
`;
}
function nbCard(nb) {
  const due = dueCards(nb).length; const step = nextStep(nb);
  return `<div class="card nb-card" data-act="open-nb" data-id="${esc(nb.id)}" role="link" tabindex="0" aria-label="Open ${esc(nb.title)}">
    <div class="row between"><span class="tag accent">${esc(nb.course || 'Lecture')}</span><span class="row" style="gap:6px">${due ? `<span class="tag warn">${due} due</span>` : ''}<button class="nb-del" data-act="del-nb" data-id="${nb.id}" title="Delete this notebook" aria-label="Delete ${esc(nb.title)}">${icon('trash')}</button></span></div>
    <h3>${esc(nb.title)}</h3>
    <div class="meta"><span>${icon('sources')}${nb.sources.length} source${nb.sources.length === 1 ? '' : 's'}</span><span>${icon('cards')}${nb.cards.length} cards</span><span>${icon('target')}${pct(nbMastery(nb))}% mastery</span></div>
    <div class="meter ${lvl(nbMastery(nb))}"><i style="width:${pct(nbMastery(nb))}%"></i></div>
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
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  flame: '<path d="M12 22a7 7 0 0 0 7-7c0-4-3-6-4-10-2 2-2 4-2 6-1-1-2-2-2-4-3 2-6 5-6 8a7 7 0 0 0 7 7z"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  sources: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  pretest: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  lessons: '<path d="M22 9 12 4 2 9l10 5 10-5z"/><path d="M6 11.5V16c3 2.2 9 2.2 12 0v-4.5M22 9v5"/>',
  learn: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  videos: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/>',
  recall: '<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  teach: '<path d="M3 4h18M5 4v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4M12 16v4M8 20h8"/>',
  tutor: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/>',
  exam: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="m9 13 2 2 4-4"/>',
  progress: '<path d="M3 20h18M7 16v-5M12 16V6M17 16v-8"/>',
  plan: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/>',
  cards: '<rect x="3" y="7" width="14" height="13" rx="2"/><path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  coffee: '<path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 2v3M12 2v3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
};
const icon = (k, cls = '') => ICON_PATHS[k] ? `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[k]}</svg>` : '';
const hIcon = (k) => icon(k, 'h-ico');
// mastery → bar colour, so a weak 25% doesn't look the same as a solid 85%
const lvl = (m) => (m < 0.5 ? 'lvl-low' : m < 0.75 ? 'lvl-mid' : 'lvl-high');

// Small celebration for a strong session or a new level (skipped when "reduce motion" is on).
function confetti() {
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch { /* old browser */ }
  const box = document.createElement('div'); box.className = 'confetti'; box.setAttribute('aria-hidden', 'true');
  const colors = ['#4f7dff', '#3dd6f5', '#a5f3fc', '#facc15', '#4ade80'];
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
  ['sources', '📄 Sources'], ['pretest', '🤔 Pretest'], ['lessons', '🎓 Learn'], ['learn', '🖼️ Revise'], ['videos', '🎬 Videos'], ['recall', '🧠 Recall'],
  ['teach', '🗣️ Teach back'], ['tutor', '💬 Tutor'], ['exam', '📝 Exam'], ['progress', '📈 Progress'],
];
function pathSteps(nb) {
  return [
    { tab: 'sources', label: 'Add material', done: nb.sources.length > 0 },
    { tab: 'sources', label: 'Build kit', done: !!nb.digest },
    { tab: 'pretest', label: 'Pretest', done: nb.pretest.done },
    { tab: 'lessons', label: 'Learn step by step', done: nb.progress.learn || lessonsDone(nb) },
    { tab: 'recall', label: 'Recall', done: nb.progress.reviews > 0 && dueCards(nb).length === 0 },
    { tab: 'teach', label: 'Teach back', done: Object.keys(nb.feynman).length > 0 },
    { tab: 'exam', label: 'Practice exam', done: nb.exams.length > 0 },
  ];
}
function nextStep(nb) { return pathSteps(nb).find((s) => !s.done) || { tab: dueCards(nb).length ? 'recall' : 'exam', label: dueCards(nb).length ? 'Review due cards' : 'Another practice exam' }; }

// Tabs grouped into the order you study in: learn it → practice it → everything else
const STAGES = [
  { k: 'learn', label: 'Learn', ico: 'lessons', tabs: ['pretest', 'lessons', 'learn', 'videos'], home: 'lessons' },
  { k: 'practice', label: 'Practice', ico: 'recall', tabs: ['recall', 'teach', 'exam'], home: 'recall' },
  { k: 'more', label: 'More', ico: 'more', tabs: ['sources', 'tutor', 'progress'], home: 'sources' },
];
const stageOf = (tab) => (tab === 'deep' ? STAGES[0] : STAGES.find((s) => s.tabs.includes(tab)) || STAGES[2]);
const KIT_TABS = ['pretest', 'lessons', 'deep', 'learn', 'videos', 'recall', 'teach', 'exam', 'progress'];
function renderNotebook(nb, tab, arg) {
  if (tab === 'learn' && nb.digest && !nb.progress.learn) { nb.progress.learn = true; save(nb); }
  const steps = pathSteps(nb); const next = nextStep(nb); const due = dueCards(nb).length;
  $('#view').innerHTML = `
    <div class="nb-head"><div style="flex:1;min-width:240px">
      <a href="#/" class="small">← All notebooks</a>
      <div><input class="nb-title-input" id="nbTitleEdit" value="${esc(nb.title)}" size="${Math.max(12, nb.title.length + 2)}" aria-label="Notebook title"></div>
      <div class="small muted">${esc(nb.course || '')}${nb.course ? ' · ' : ''}${pct(nbMastery(nb))}% mastery</div></div>
      <button class="icon-btn quiet" data-act="del-nb" data-id="${nb.id}" title="Delete notebook" aria-label="Delete notebook">${icon('trash')}</button>
    </div>
    ${nbPlanStrip(nb)}
    <div class="tabs-sentinel" aria-hidden="true"></div>
    <div class="tabs-bar">
      <div class="stage-row" role="tablist" aria-label="Study stage">${STAGES.map((sg, n) => { const on = stageOf(tab).k === sg.k; const target = sg.k === 'learn' && !sg.tabs.includes(next.tab) ? 'lessons' : sg.tabs.includes(next.tab) ? next.tab : sg.home;
        return `<a href="#/nb/${nb.id}/${on ? tab : target}" class="stage ${on ? 'on' : ''}" role="tab" aria-selected="${on}"><span class="stage-n">${n < 2 ? n + 1 : ''}</span>${icon(sg.ico)}${sg.label}${sg.k === 'practice' && due ? `<span class="badge">${due}</span>` : ''}${!on && sg.tabs.includes(next.tab) ? '<span class="next-dot"></span>' : ''}</a>`; }).join('<span class="stage-arrow">→</span>')}</div>
      <nav class="tabs">${TABS.filter(([k]) => stageOf(tab).tabs.includes(k)).sort((x, y) => stageOf(tab).tabs.indexOf(x[0]) - stageOf(tab).tabs.indexOf(y[0])).map(([k, l]) => `<a href="#/nb/${nb.id}/${k}" class="${k === tab ? 'on' : ''} ${!nb.digest && KIT_TABS.includes(k) ? 'needs-kit' : ''}" ${!nb.digest && KIT_TABS.includes(k) ? 'title="Build the study kit first"' : ''}>${icon(k)}<span>${l.replace(/^\S+\s/, '')}</span>${k === 'recall' && due ? `<span class="badge">${due}</span>` : ''}${k === next.tab && k !== tab && !(k === 'recall' && due) ? `<span class="next-dot" title="Suggested next: ${esc(next.label)}"></span>` : ''}</a>`).join('')}</nav></div>
    <div id="tab"></div>`;
  const tabsEl = $('.tabs');
  if (tabsEl) {
    const fades = () => { tabsEl.classList.toggle('fade-l', tabsEl.scrollLeft > 4); tabsEl.classList.toggle('fade-r', tabsEl.scrollLeft + tabsEl.clientWidth < tabsEl.scrollWidth - 4); };
    const on = tabsEl.querySelector('a.on');
    if (on) { tabsEl.style.scrollBehavior = 'auto'; tabsEl.scrollLeft = Math.max(0, on.offsetLeft - (tabsEl.clientWidth - on.offsetWidth) / 2); tabsEl.style.scrollBehavior = ''; }
    fades(); tabsEl.addEventListener('scroll', fades, { passive: true });
    // solid strip behind the tabs once they're pinned under the header
    UI.tabsIO?.disconnect(); const bar = tabsEl.closest('.tabs-bar'); const mark = $('.tabs-sentinel');
    const topbar = $('.topbar'); if (topbar) document.documentElement.style.setProperty('--topbar-h', topbar.offsetHeight + 'px');
    if (mark && bar && 'IntersectionObserver' in window) {
      const pin = parseFloat(getComputedStyle(bar).top) || 56;
      UI.tabsIO = new IntersectionObserver(([e]) => bar.classList.toggle('stuck', !e.isIntersecting && e.boundingClientRect.top < pin + 1), { rootMargin: `-${Math.round(pin) + 1}px 0px 0px 0px`, threshold: 0 });
      UI.tabsIO.observe(mark);
    }
  }
  $('#nbTitleEdit').addEventListener('change', async (e) => { nb.title = e.target.value.trim() || 'Untitled notebook'; await save(nb); });
  const needsKit = KIT_TABS.includes(tab) && !nb.digest;
  const el = $('#tab');
  if (needsKit) return renderNeedKit(nb, el);
  ({ sources: renderSources, pretest: renderPretest, lessons: renderLessons, deep: renderDeep, learn: renderLearn, videos: renderVideos, recall: renderRecall, teach: renderTeach, tutor: renderTutor, exam: renderExam, progress: renderProgress }[tab] || renderSources)(nb, el, arg);
  if (tab === 'videos' && UI.vidFocus) {
    const id = UI.vidFocus; UI.vidFocus = null;
    const card = [...el.querySelectorAll('[data-vid]')].find((x) => x.dataset.vid === String(id));
    if (card) { card.classList.add('just-added'); setTimeout(() => card.classList.remove('just-added'), 2500); requestAnimationFrame(() => card.scrollIntoView({ block: 'start', behavior: 'smooth' })); lastRenderKey = ''; }
  }
  if (tab === 'learn' && nb.digest) el.insertAdjacentHTML('beforeend', `<div class="card overview row between learn-next"><div><h3 style="margin:0">Done reading?</h3><div class="small muted">Now pull it back out of your head. That’s what makes it stick.</div></div><a class="btn primary" href="#/nb/${nb.id}/recall">🧠 Start recall →</a></div>`);
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
      <div class="small muted">${nb.sources.length} source${nb.sources.length === 1 ? '' : 's'} · ${nb.sources.reduce((a, s) => a + wordCount(s.text), 0).toLocaleString()} words${nb.digest ? ` · ${nb.digest.concepts.length} concepts · ${nb.cards.length} recall cards` : ''}</div></div>
      ${nb.digest && !stale ? `<div class="row"><button class="btn" data-act="build">↻ Rebuild</button><a class="btn primary" href="#/nb/${nb.id}/${nextStep(nb).tab}">Continue → ${esc(nextStep(nb).label)}</a></div>`
        : `<button class="btn primary lg" data-act="build">✨ ${nb.digest ? 'Rebuild' : 'Build'} study kit</button>`}
    </div>` : ''}

    ${nb.sources.length ? `<div class="card flat" style="padding:0">${nb.sources.map((s) => `
      <div class="src"><span class="ic">${KIND_ICON[s.kind] || '📄'}</span>
        <div style="flex:1;min-width:0"><div class="nm">${esc(s.name)}</div><div class="small muted">${s.kind} · ${s.text.length.toLocaleString()} chars${s.images ? ` · 🖼️ ${s.images} picture${s.images === 1 ? '' : 's'}` : ['pdf', 'pptx'].includes(s.kind) && s.images === undefined ? ' · <span style="color:var(--warn)">no pictures yet: drop this file again to add them</span>' : ''}</div>
        ${UI.preview === s.id ? `<pre>${esc(s.text.slice(0, 6000))}${s.text.length > 6000 ? '\n…' : ''}</pre>` : ''}</div>
        <button class="btn sm ghost" data-act="preview-src" data-id="${s.id}">${UI.preview === s.id ? 'Hide' : 'Preview'}</button>
        <button class="btn sm ghost" data-act="del-src" data-id="${s.id}" aria-label="Remove">✕</button></div>`).join('')}</div>` : ''}

    <label class="drop" id="drop">
      <div class="big">⬆️</div>
      ${TOUCH ? '<b>Tap to add lecture files</b>' : '<b>Drop lecture files here</b> or click to choose'}
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
  const nb = curNb(); const idx = nb.sources.findIndex((s) => s.id === el.dataset.id); if (idx < 0) return; const src = nb.sources[idx];
  nb.sources.splice(idx, 1); VIS.delete(src.id); // remove first, so a second tap finds nothing to delete
  const vis = await DB.get('visuals', src.id).catch(() => null);
  await save(nb); if (src.images) await DB.del('visuals', src.id).catch(() => {});
  render();
  toast(`Removed “${src.name}”`, '', { label: 'Undo', fn: async () => {
    if (nb.sources.some((s) => s.id === src.id)) return; nb.sources.splice(Math.min(idx, nb.sources.length), 0, src); if (vis?.items?.length) await putVisuals(src.id, vis.numbering, vis.items); await save(nb); render(); toast('Restored ✓');
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
  const nb = curNb(); const text = $('#guideText').value.trim(); clearDraft('#guideText');
  const old = nb.sources.find((x) => x.kind === 'guide');
  if (!text) { if (old) { nb.sources = nb.sources.filter((x) => x !== old); await save(nb); toast('Study guide removed'); render(); } return; }
  if (old) { old.text = text; old.chars = text.length; old.added = Date.now(); await save(nb); }
  else await addSource(nb, 'Study guide', 'guide', text);
  toast(nb.digest ? 'Saved. Rebuild the kit to focus it on the guide.' : 'Study guide saved ✓'); render();
};
ACT['add-paste'] = async () => {
  const nb = curNb(); const text = $('#pasteText').value; clearDraft('#pasteText'); clearDraft('#pasteName');
  if (!text.trim()) return toast('Paste some text first', 'err');
  await addSource(nb, $('#pasteName').value.trim() || 'Pasted notes', 'text', text); toast('Added'); render();
};
ACT['add-url'] = async (btn) => {
  const nb = curNb(); const url = $('#urlIn').value.trim(); if (!url) return; clearDraft('#urlIn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Fetching…';
  try { const r = await api('/api/fetch', { url }); await addSource(nb, r.title, r.kind, r.text); toast('Link added'); }
  catch (e) { aiError(e); }
  render();
};

const ingestRender = (nb) => { const r = route(); if (r.view === 'nb' && r.id === nb.id && (r.tab || 'sources') === 'sources') render(); };
async function ingestFiles(nb, files) {
  const useAI = $('#aiRead')?.checked && S.status.claude;
  UI.ingest = files.map((f) => ({ name: f.name, status: 'work', msg: 'reading…' }));
  ingestRender(nb);
  for (let i = 0; i < files.length; i++) {
    const f = files[i]; const item = UI.ingest[i];
    try {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      // Re-adding a deck that's already in the notebook only fills in its pictures (keeps the study kit as is).
      const existing = ['pdf', 'pptx'].includes(ext) && nb.sources.find((s) => s.name === f.name);
      if (existing) {
        item.msg = 'pulling slide pictures…'; ingestRender(nb);
        const numbering = existing.numbering || (ext === 'pptx' ? 'file' : 'page');
        const items = ext === 'pdf' ? (await pdfRead(await f.arrayBuffer(), true)).visuals : (await pptxRead(f)).visuals;
        await putVisuals(existing.id, numbering, items);
        existing.numbering = numbering; existing.images = items.length; await save(nb);
        item.status = 'ok'; item.msg = `added ${items.length} slide picture${items.length === 1 ? '' : 's'}`; ingestRender(nb);
        continue;
      }
      if (ext === 'pdf') {
        const buf = await f.arrayBuffer();
        item.msg = 'reading pages…'; ingestRender(nb);
        const { text, pages, visuals } = await pdfRead(buf.slice(0), true);
        const sparse = text.replace(/\[Page \d+\]/g, '').trim().length < pages * 60;
        let final = text;
        if ((useAI || sparse) && S.status.claude) {
          if (f.size > 14e6) item.msg = 'too large for AI reading, using text only';
          else {
            item.msg = `AI reading ${pages} pages + diagrams…`; ingestRender(nb);
            try { final = (await ai('transcribe', { media_type: 'application/pdf', data: b64FromBuffer(buf) })).text; }
            catch (e) { if (sparse) throw e; item.msg = 'AI read failed, using text only'; }
          }
        } else if (sparse) throw new Error('This PDF looks scanned. Turn on the AI tutor (Settings) to read it.');
        const src = await addSource(nb, f.name, 'pdf', final, { numbering: 'page', images: visuals.length });
        await putVisuals(src.id, 'page', visuals);
        item.msg = `${pages} pages`;
      } else if (ext === 'pptx') {
        item.msg = 'reading slides & pictures…'; ingestRender(nb);
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
        item.msg = 'AI reading image…'; ingestRender(nb);
        const data = await imageToJpeg(f);
        const r = await ai('transcribe', { media_type: 'image/jpeg', data });
        const src = await addSource(nb, r.title || f.name, 'image', r.text, { numbering: 'page', images: 1 });
        await putVisuals(src.id, 'page', [{ slide: 1, file: 1, src: 'data:image/jpeg;base64,' + await imageToJpeg(f, 1400) }]);
      } else {
        await addSource(nb, f.name, 'text', await f.text());
      }
      item.status = 'ok'; if (item.msg === 'reading…') item.msg = 'added';
    } catch (e) { item.status = 'err'; item.msg = e.message; if (e.code === 'no_key') openSettings(); }
    ingestRender(nb);
  }
  setTimeout(() => { if (UI.ingest?.every((x) => x.status !== 'work')) { UI.ingest = UI.ingest.filter((x) => x.status === 'err'); ingestRender(nb); } }, 5000);
}

// PDF: text per page + a picture of every page (that's what the lecture actually looks like).
async function pdfRead(buf, withPictures) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const out = []; const visuals = [];
  try {
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
        c.width = c.height = 0; // release the canvas right away
      } catch (e) { console.warn('page render failed', i, e); }
    }
    try { page.cleanup(); } catch { /* ignore */ }
  }
  return { text: out.join('\n\n'), pages: doc.numPages, visuals };
  } finally { try { await doc.destroy(); } catch { /* ignore */ } }
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
  const nb = curNb(); const w = nb ? nb.sources.reduce((a, s) => a + wordCount(s.text), 0) : 0;
  const est = S.status.public ? (w < 3000 ? 35 : w < 8000 ? 60 : 110) : (w < 3000 ? 90 : 150);
  const estText = est < 50 ? 'about 30 seconds' : est < 100 ? 'about a minute' : 'a minute or two';
  el.innerHTML = `<div class="card building"><div class="spinner lg" style="margin:0 auto"></div><h2 style="margin-top:16px">Building your study kit</h2>
    <div class="step" id="buildStep">${BUILD_STEPS[0]}</div>
    <div class="meter build-bar"><i style="animation-duration:${est}s"></i></div>
    <p class="small muted">Usually ${estText} for this much material. Keep this tab open: it jumps to a quick pretest when it’s ready.</p></div>`;
  let i = 0; clearInterval(UI.buildTimer);
  UI.buildTimer = setInterval(() => { const s = $('#buildStep'); if (!s) return clearInterval(UI.buildTimer); i = Math.min(i + 1, BUILD_STEPS.length - 1); s.textContent = BUILD_STEPS[i]; }, Math.max(4000, est * 1000 / BUILD_STEPS.length));
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
    UI.building = null; if (route().view === 'nb' && route().id === nb.id) { toast('Study kit ready ✨'); go(`#/nb/${nb.id}/pretest`); } else toast(`Study kit ready for “${nb.title}” ✨`, '', { label: 'Open', fn: () => go(`#/nb/${nb.id}/pretest`) });
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
  // ids come from the AI and end up inside HTML attributes and links: keep them to safe characters
  const SAFE = /^[A-Za-z0-9_-]{1,24}$/; const rid = {};
  d.concepts.forEach((c, k) => { if (!SAFE.test(String(c.id))) { rid[c.id] = `c${k + 1}`; c.id = `c${k + 1}`; } });
  const rc = (x) => rid[x] ?? x;
  d.cards.forEach((c) => (c.concept_ids = (c.concept_ids || []).map(rc)));
  [d.recall, d.pretest, d.feynman_prompts, d.picture_questions].forEach((list) => (list || []).forEach((r) => (r.concept_id = rc(r.concept_id))));
  const nid = {}; (d.concept_map?.nodes || []).forEach((n, k) => { if (!SAFE.test(String(n.id))) { nid[n.id] = `n${k + 1}`; n.id = `n${k + 1}`; } });
  (d.concept_map?.edges || []).forEach((e) => { e.from = nid[e.from] ?? e.from; e.to = nid[e.to] ?? e.to; });
  // rebuilding: carry progress over to the same concepts by NAME (ids are just c1, c2… in lecture order)
  if (nb.digest) {
    const byName = new Map(nb.digest.concepts.map((c) => [norm(c.name), c.id]));
    const o2n = {}; d.concepts.forEach((c) => { const o = byName.get(norm(c.name)); if (o) o2n[o] = c.id; });
    const stats = {}; for (const [o, s] of Object.entries(nb.conceptStats || {})) if (o2n[o]) stats[o2n[o]] = s; nb.conceptStats = stats;
    const ill = {};
    for (const [k, v] of Object.entries(nb.illustrations || {})) {
      const m = k.match(/^card(\d+):(.*)$/);
      if (m) { const title = nb.digest.cards[+m[1]]?.title; const ni = d.cards.findIndex((c) => norm(c.title) === norm(title || '')); if (ni >= 0) ill[`card${ni}:${m[2]}`] = v; continue; }
      const [cid, ...rest] = k.split(':'); if (o2n[cid]) ill[[o2n[cid], ...rest].join(':')] = v;
    }
    nb.illustrations = ill;
    const fey = {}; for (const [k, v] of Object.entries(nb.feynman || {})) { const [cid, idx] = k.split(':'); const n = o2n[cid]; if (n && d.feynman_prompts?.[+idx]?.concept_id === n) fey[`${n}:${idx}`] = v; } nb.feynman = fey;
    (nb.videos || []).forEach((v) => { v.concept_id = o2n[v.concept_id] || ''; });
    nb.cards.forEach((c) => { if ((c.from === 'lesson' || c.from === 'deep') && c.concept_id) c.concept_id = o2n[c.concept_id] || d.concepts[0]?.id; });
  }
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
  const kitCards = [...d.recall, ...pictureCards].map((r) => { const o = old.get(norm(r.question)); return o ? { ...o, ...r } : { id: uid(), ...r, srs: newSrs(), history: [] }; });
  const kitQs = new Set(kitCards.map((c) => norm(c.question)));
  nb.cards = [...kitCards, ...nb.cards.filter((c) => (c.from === 'lesson' || c.from === 'deep') && !kitQs.has(norm(c.question)))];
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
      <a class="btn primary" href="#/nb/${nb.id}/lessons">Start learning →</a></div>
    ${qs.map((q, i) => { const raw = nb.pretest.answers[i] || ''; const a = /^\s*(idk|i ?d(on|o)n?'?t know|no idea|not sure|dunno|n\/?a|\?+|-+)\s*$/i.test(raw) ? '' : raw;
      const close = !!a && (coverage(a, q.answer) >= 0.3 || (words(a).length >= 2 && coverage(q.answer, a) >= 0.6));
      return `<div class="card"><div class="row between"><span class="tag">${esc(conceptName(nb, q.concept_id))}</span>${a ? `<span class="tag ${close ? 'good' : 'warn'}">${close ? 'Good instinct!' : 'Now you know'}</span>` : ''}</div>
      <div class="q-text">${esc(q.question)}</div>
      <div class="small muted">Your guess</div><div>${a ? esc(a) : '<i class="muted">skipped</i>'}</div>
      <div class="answer-box"><div class="small muted">Answer</div>${esc(q.answer)}</div></div>`; }).join('')}
    <div class="row" style="justify-content:space-between"><button class="btn ghost" data-act="redo-pretest">Retake pretest</button><a class="btn primary" href="#/nb/${nb.id}/lessons">Start learning →</a></div></div>`;
}
ACT['submit-pretest'] = async () => {
  const nb = curNb();
  nb.pretest.answers = $$('[data-pre]').map((t) => t.value.trim()); $$('[data-pre]').forEach(clearDraft);
  nb.pretest.done = true; await save(nb);
  const tried = nb.pretest.answers.filter((x) => x && wordCount(x) >= 2).length;
  const px = tried ? xpGain(nb, 'pretest', 4 * tried) : 0; if (px) { await save(nb); await gainXP(px, 'pretest guesses'); } else toast('No XP for a blank pretest. A wrong guess still helps you learn, so try one next time!');
  render();
};
ACT['skip-pretest'] = async () => { const nb = curNb(); nb.pretest.done = true; await save(nb); go(`#/nb/${nb.id}/lessons`); };
ACT['redo-pretest'] = async () => { const nb = curNb(); nb.pretest = { done: false, answers: [] }; await save(nb); render(); };

// ═════════════════════════ LEARN (visual) ═════════════════════════
// ═════════════════════════ LEARN: guided lessons ═════════════════════════
// The Learn tab is for learning a lecture for the first time: one section at a time, a few small steps each,
// a quick check (multiple choice or short answer) after every step, then cover-and-recall of the whole section.
// Gemini writes each section's lesson the first time it's opened; it's saved in the notebook (nb.lessons).
// The old all-at-once cards page is now the Revise tab.
// Before writing a lesson or test, make sure we know whether the AI is on (right after a reload it may not be checked yet).
async function aiReady() { if (!S.status.checked) { try { await refreshStatus(); } catch { /* offline */ } } return !!S.status.claude; }
const onLesson = (nb, i) => { const r = route(); return r.view === 'nb' && r.tab === 'lessons' && r.id === nb.id && r.arg !== '' && +r.arg === i; };
const onDeep = (nb, i) => { const r = route(); return r.view === 'nb' && r.tab === 'deep' && r.id === nb.id && r.arg !== '' && +r.arg === i; };
const LESSON_V = 4; // v2 shorter; v3 harder checks + concept ids; v4 plain-words line, hints, fact-check pass
function lessonOf(nb, i) {
  const L = (nb.lessons || {})[i]; const c = nb.digest?.cards[i];
  return L && c && L.title === c.title ? L : null;
}
function lessonStages(d) {
  const st = [{ k: 'intro' }];
  (d.steps || []).forEach((s, j) => { st.push({ k: 'step', j }); if (s.check?.question) st.push({ k: 'check', j }); });
  st.push({ k: 'recall' }, { k: 'test' }, { k: 'done' });
  return st;
}
function lessonInfo(nb, i) {
  const L = lessonOf(nb, i);
  if (!L?.data) return { state: 'new', pct: 0, label: 'Not started' };
  const st = lessonStages(L.data); const checks = Object.values(L.checks || {});
  const right = checks.filter((x) => (x.first ?? x.ok) >= 1).length; const total = st.filter((s) => s.k === 'check').length;
  if (L.retaking) { const sc0 = st[L.pos || 0]?.k; return { state: 'going', pct: Math.round((100 * (L.pos || 0)) / (st.length - 1)), label: sc0 === 'test' ? 'Retake · test waiting' : `Retake · step ${Math.min(L.pos || 0, st.length - 1)} of ${st.length - 1}` }; }
  if (L.done) return { state: 'done', pct: 100, label: total && checks.length ? `Done ✓ · ${right}/${total} quick checks right` : 'Done ✓' };
  if (st[L.pos || 0]?.k === 'test') return { state: 'going', pct: 90, label: 'Section test waiting' };
  return { state: 'going', pct: Math.round((100 * (L.pos || 0)) / (st.length - 1)), label: `In progress · step ${Math.min(L.pos || 0, st.length - 1)} of ${st.length - 1}` };
}
const lessonNext = (nb) => { const n = nb.digest.cards.length; for (let i = 0; i < n; i++) if (lessonInfo(nb, i).state !== 'done') return i; return 0; };
const lessonsDone = (nb) => nb.digest && nb.digest.cards.length > 0 && nb.digest.cards.every((_, i) => lessonInfo(nb, i).state === 'done');
function cardShots(nb, c, n = 3) { const picked = refShots(nb, c.image_refs); return (picked.length ? picked : visualsFor(nb, c.source_ref, n)).slice(0, n); }

// Paper and pen: writing in your own words, quick sketches (the "drawing effect") and writing from memory on a blank
// page all make material stick better than rereading or copying. Lessons ask for one small paper task per step.
const PAPER_KEY = 'encode-paper';
const paperReady = () => { try { return localStorage.getItem(PAPER_KEY) === '1'; } catch { return false; } };
const PAPER_WHY = `<details class="paper-why"><summary>Why paper?</summary><ul>
  <li><b>Sketching sticks.</b> People remember about twice as much of what they draw. Skill doesn’t matter.</li>
  <li><b>Own words beat copying.</b> A pen makes you slow down and summarize.</li>
  <li><b>A blank page is a test.</b> Writing from memory is one of the best-proven study methods.</li></ul></details>`;
function paperPrompt(x, j) {
  if (x.paper) return x.paper;
  return j % 2 === 0 ? `Sketch “${x.title}”: a quick labeled drawing or flowchart with arrows. Messy is fine.`
    : `Cover the screen and write “${x.title}” in your own words, in one or two sentences.`;
}
ACT['paper-ready'] = () => { try { localStorage.setItem(PAPER_KEY, '1'); } catch { /* private mode */ } const nb = curNb(); if (route().arg !== '') lessonShow(nb, +route().arg); else render(); };
ACT['paper-recall'] = () => { const nb = curNb(); UI.paperRecall = `${nb.id}:${route().arg}`; lessonShow(nb, +route().arg); };
ACT['paper-recall-cancel'] = () => { UI.paperRecall = null; lessonShow(curNb(), +route().arg); };
ACT['paper-recall-done'] = async () => {
  const nb = curNb(); const i = +route().arg; const c = nb.digest.cards[i];
  const hits = c.points.map((_, j) => !!document.querySelector(`#lessonStage input[data-pp="${j}"]`)?.checked);
  UI.cardRecall[`${nb.id}:${i}`] = { revealed: true, text: '', hits, paper: true }; UI.paperRecall = null;
  const ratio = hits.filter(Boolean).length / c.points.length;
  const rk = `${nb.id}:${i}:${dayKey()}`; if (!(UI.recordedRecall ||= new Set()).has(rk)) { UI.recordedRecall.add(rk); (c.concept_ids || []).forEach((cid) => record(nb, cid, ratio)); }
  const xp = xpGain(nb, `recall:${i}`, 2 + 3 * hits.filter(Boolean).length);
  await save(nb); lessonShow(nb, i);
  if (xp) await gainXP(xp, 'paper recall');
};

function renderLessons(nb, el, arg) {
  nb.lessons ||= {}; UI.cardRecall ||= {}; UI.shots = UI.shots || {};
  loadVisuals(nb).then((changed) => { if (changed && route().tab === 'lessons') render(); });
  if (arg !== '' && arg !== undefined && nb.digest.cards[+arg]) return renderLesson(nb, el, +arg);
  const cards = nb.digest.cards; const infos = cards.map((_, i) => lessonInfo(nb, i));
  const done = infos.filter((x) => x.state === 'done').length; const nx = lessonNext(nb);
  const started = infos.some((x) => x.state !== 'new');
  el.innerHTML = `<div class="stack">
    <div class="card overview lesson-hero">
      <h2>🎓 Learn it step by step</h2>
      <p class="muted" style="margin:0">Small steps, a quick check after each, a short test at the end.</p>
      <div class="paper-strip slim"><span class="paper-ico">📝</span><span><b>Have paper and a pen ready.</b> <span class="small muted">You’ll sketch and jot as you go.</span></span></div>
      <div class="lesson-sum"><div class="meter"><i style="width:${pct(done / Math.max(1, cards.length))}%"></i></div><span class="small muted">${done} of ${cards.length} sections done</span></div>
      <div class="row">${done === cards.length
        ? `<a class="btn primary" href="#/nb/${nb.id}/recall">🧠 All done! Start recall →</a><button class="btn" data-act="lesson-retake" data-i="0">↻ Retake from section 1</button>`
        : `<button class="btn primary lg" data-act="lesson-open" data-i="${nx}">${started ? 'Continue' : 'Start'}: ${esc(cards[nx].title)} →</button>`}</div>
      <div class="small muted">Already know it? <a href="#/nb/${nb.id}/learn">Revise →</a></div>
    </div>
    <div class="lesson-path">${cards.map((c, i) => {
      const inf = infos[i]; const shot = cardShots(nb, c, 1)[0];
      return `<button class="card lesson-tile ${inf.state}" data-act="lesson-open" data-i="${i}" aria-label="Section ${i + 1}: ${esc(c.title)}. ${esc(inf.label)}">
        <span class="lt-num">${inf.state === 'done' ? '✓' : i + 1}</span>
        <span class="lt-pic">${shot ? `<img loading="lazy" alt="" src="${shot.src}">` : `<span class="lt-emoji">${esc(c.emoji)}</span>`}</span>
        <span class="lt-body"><b>${shot ? `${esc(c.emoji)} ` : ''}${esc(c.title)}</b><span class="small muted">${esc(inf.label)}</span>
          <span class="lt-meter"><i style="width:${inf.pct}%"></i></span></span>
        ${i === nx && done < cards.length ? '<span class="lt-next">Up next</span>' : ''}
      </button>`;
    }).join('')}</div>
  </div>`;
}

// Zoom from the tapped tile into the lesson.
ACT['lesson-open'] = (el) => {
  const nb = curNb(); const i = +el.dataset.i; const hash = `#/nb/${nb.id}/lessons/${i}`;
  let reduce = false; try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* old browser */ }
  const r = el.getBoundingClientRect();
  if (reduce || !r.width || !document.body.animate) return go(hash);
  const z = document.createElement('div'); z.className = 'lesson-zoom'; z.setAttribute('aria-hidden', 'true');
  const pic = el.querySelector('img'); if (pic) z.innerHTML = `<img alt="" src="${pic.src}">`;
  Object.assign(z.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  document.body.appendChild(z);
  const W = document.documentElement.clientWidth, H = window.innerHeight;
  const a = z.animate([
    { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', borderRadius: '18px' },
    { left: '0px', top: '0px', width: W + 'px', height: H + 'px', borderRadius: '0px' },
  ], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
  let opened = false;
  const open = () => {
    if (opened) return; opened = true; UI.lessonDir = 'in'; go(hash);
    requestAnimationFrame(() => { const f = z.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: 'ease-out', fill: 'forwards' }); f.onfinish = () => z.remove(); });
    setTimeout(() => z.remove(), 900); // in case the fade never runs (background tab)
  };
  a.onfinish = open; setTimeout(open, 650);
};

function localLesson(nb, c) { // used when the AI isn't available: built from the study kit itself
  const cons = (c.concept_ids || []).map((id) => nb.digest.concepts.find((x) => x.id === id)).filter(Boolean);
  const qs = nb.digest.recall.filter((q) => (c.concept_ids || []).includes(q.concept_id));
  return {
    fallback: true, intro: cons[0]?.why_it_matters || nb.digest.overview, prior: [],
    steps: c.points.map((p, j) => ({
      title: p.split(/\s+/).slice(0, 5).join(' ').replace(/[.,;:]$/, ''),
      explain: p + (cons[j] ? `\n\n**${cons[j].name}**: ${cons[j].definition}` : ''),
      example: j === c.points.length - 1 ? c.analogy || '' : cons[j]?.mnemonic || '', terms: [],
      check: qs[j] ? { type: 'short', question: qs[j].question, options: [], answer: qs[j].answer, explanation: '' } : null,
    })),
    summary: c.points, mnemonic: cons[0]?.mnemonic || '',
  };
}
function cleanLesson(d) { // make sure every multiple-choice check really has its answer among the options
  for (const s of d.steps || []) {
    const ch = s.check; if (!ch?.question) { s.check = null; continue; }
    if (ch.type === 'mcq') {
      const opts = (ch.options || []).filter(Boolean);
      const hit = opts.find((o) => norm(o) === norm(ch.answer)) || opts.find((o) => similar(o, ch.answer) > 0.85);
      if (opts.length >= 2 && hit) {
        for (let k = opts.length - 1; k > 0; k--) { const r = Math.floor(Math.random() * (k + 1)); [opts[k], opts[r]] = [opts[r], opts[k]]; } // shuffle once; saved with the lesson
        ch.options = opts; ch.answer = hit;
      } else { ch.type = 'short'; ch.options = []; }
    } else ch.options = [];
  }
  d.steps = (d.steps || []).filter((s) => s.title || s.explain);
  return d;
}
// ── after the AI writes something: tidy it, then a second AI pass fixes facts and over-complicated sentences ──
const SLIDE_RX = /\s*\((?:see\s+)?(?:slides?|p\.|pages?)\s*[\d,\s–-]+\)/gi;
const OPTION_RX = /\b(?:option|choice)\s+(?:one|two|three|four|[1-4]|[A-D])\b/i;
const CAUSE_RX = /\b(ECG|EKG|electrocardiogram|P[- ]wave|QRS(?: complex)?|T[- ]wave)\b((?:(?!\b(?:which|that|and|but|while|then)\b)[^.,;]){0,25}?)\b(trigger|cause|control|drive|initiate|produce|start)(s|ed|ing)?\b/gi;
function tidyText(s, bullets = false) {
  let x = String(s || '').replace(SLIDE_RX, '');
  if (bullets && !/\n\s*-\s/.test(x) && /[.:!?]\s+-\s+\S/.test(x)) x = x.replace(/\s+-\s+(?=[A-Z*(])/g, '\n- '); // bullets that came out on one line
  return x.trim();
}
function tidyDeep(o, key = '') {
  if (typeof o === 'string') return tidyText(o, key === 'explain');
  if (Array.isArray(o)) return o.map((v) => tidyDeep(v, key));
  if (o && typeof o === 'object') { for (const k of Object.keys(o)) o[k] = tidyDeep(o[k], k); return o; }
  return o;
}
function textOf(o) { return typeof o === 'string' ? o : Array.isArray(o) ? o.map(textOf).join(' \n') : o && typeof o === 'object' ? Object.values(o).map(textOf).join(' \n') : ''; }
function applyFixes(o, fixes) {
  let n = 0; const good = (fixes || []).filter((f) => f.find && f.find.length >= 4 && f.find !== f.replace);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = walk(v[k]); return v; }
    if (typeof v !== 'string') return v;
    let s = v; for (const f of good) if (s.includes(f.find)) { s = s.split(f.find).join(f.replace); n++; }
    return s;
  };
  walk(o); return n;
}
// last resort if a cause-claim survives: an ECG wave shows electrical activity, it doesn't cause anything
function fixCauseClaims(o) {
  const swap = { trigger: 'show', cause: 'show', control: 'track', drive: 'show', initiate: 'mark', produce: 'show' };
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = walk(v[k]); return v; }
    if (typeof v !== 'string') return v;
    return v.replace(CAUSE_RX, (m, who, mid, verb, end) => {
      const up = verb[0] === verb[0].toUpperCase(); const C = (x) => (up ? x[0].toUpperCase() + x.slice(1) : x);
      if (verb.toLowerCase() === 'start') return `${who}${mid}${C(end === 'ed' ? 'came before' : end === 'ing' ? 'coming before' : end ? 'comes before' : 'come before')}`;
      const w = swap[verb.toLowerCase()];
      return `${who}${mid}${C(w)}${end === 'ed' ? 'ed' : end === 'ing' ? 'ing' : end ? 's' : ''}`;
    });
  };
  walk(o);
}
async function factCheck(nb, obj) {
  try { const r = await ai('lesson_review', { sources: aiSources(nb), lesson: obj }); return applyFixes(obj, r.fixes); }
  catch { return 0; }
}

async function buildLesson(nb, i, { force = false, keep = null } = {}) {
  const c = nb.digest.cards[i]; const key = `${nb.id}:${i}`;
  if (UI.lessonBusy?.[key]) return; (UI.lessonBusy ||= {})[key] = true;
  const prev = lessonOf(nb, i);
  let data = null;
  if (await aiReady()) {
    try {
      const cards = nb.digest.cards;
      data = cleanLesson(await ai('lesson', {
        sources: aiSources(nb), index: i + 1, count: cards.length, title: c.title, points: c.points, analogy: c.analogy,
        concepts: (c.concept_ids || []).map((id) => nb.digest.concepts.find((x) => x.id === id)).filter(Boolean).map((x) => ({ id: x.id, name: x.name, definition: x.definition })),
        before: cards.slice(0, i).map((x) => x.title), after: cards.slice(i + 1).map((x) => x.title),
      }));
      if (!data.steps.length) throw new Error('The lesson came back empty. Try again.');
      tidyDeep(data);
      UI.lessonPhase = 'check';
      if (location.hash.endsWith(`/lessons/${i}`)) { const p = document.querySelector('.lesson-phase'); if (p) p.textContent = 'Double-checking the facts and making it simpler…'; }
      await factCheck(nb, data);
      fixCauseClaims(data); tidyDeep(data); data = cleanLesson(data);
    } catch (e) {
      data = null;
      if (e.code === 'no_key') aiError(e); else toast(`Couldn’t write the lesson with AI (${e.message}). Showing a simpler one from your study cards.`, 'err');
    }
  }
  if (!data) data = localLesson(nb, c);
  const good = keep || prev?.data; if (data.fallback && good && !good.fallback) data = good; // a failed rewrite keeps the good lesson
  nb.lessons[i] = { v: LESSON_V, title: c.title, data, pos: force ? 0 : prev?.pos || 0, checks: force ? {} : prev?.checks || {}, help: force ? {} : prev?.help || {}, done: !force && !!prev?.done };
  delete UI.lessonBusy[key];
  await save(nb);
}
ACT['lesson-rewrite'] = async () => {
  const nb = curNb(); const i = +route().arg;
  if (!S.status.claude) { toast('Writing lessons needs the AI tutor. See Settings.', 'err'); return openSettings(); }
  const p = buildLesson(nb, i, { force: true, keep: nb.lessons[i]?.data }); render(); // marks itself busy before the redraw
  await p;
  if (onLesson(nb, i)) lessonShow(nb, i);
};

function renderLesson(nb, el, i) {
  const c = nb.digest.cards[i]; const key = `${nb.id}:${i}`; let L = lessonOf(nb, i);
  // an older, wordier lesson nobody has started yet gets rewritten in the newer, shorter style
  if (L?.data && !L.data.fallback && (L.v || 1) < LESSON_V && !L.done && !(L.pos > 0) && !Object.keys(L.checks || {}).length && S.status.claude && !UI.lessonBusy?.[key]) {
    buildLesson(nb, i, { keep: L.data }).then(() => { if (onLesson(nb, i)) lessonShow(nb, i); });
  }
  if (UI.lessonBusy?.[key]) L = null; // show the "writing…" card while a build runs
  if (!L?.data) {
    el.innerHTML = `<div class="lesson-top"><a href="#/nb/${nb.id}/lessons" class="small">← All sections</a><span class="small muted">Section ${i + 1} of ${nb.digest.cards.length}</span></div>
      <div class="card building lesson-card"><div style="font-size:2.6rem">${esc(c.emoji)}</div><h2 style="margin:6px 0">${esc(c.title)}</h2>
      <div class="spinner lg" style="margin:14px auto"></div>
      <p class="muted lesson-phase" style="margin:0">Writing a beginner-friendly lesson for this section…</p>
      <p class="small muted">Usually 15–40 seconds (it’s written, then fact-checked). It’s saved, so next time it opens instantly.</p></div>`;
    if (!UI.lessonBusy?.[key]) buildLesson(nb, i).then(() => { if (onLesson(nb, i)) lessonShow(nb, i); });
    return;
  }
  const d = L.data; const st = lessonStages(d); L.pos = Math.min(L.pos || 0, st.length - 1);
  const s = st[L.pos]; const steps = d.steps.length;
  const dots = st.filter((x) => x.k !== 'check').map((x, k) => { const at = st.indexOf(x); return `<i class="${at < L.pos ? 'f' : ''} ${at === L.pos || (s.k === 'check' && x.k === 'step' && x.j === s.j) ? 'on' : ''}"></i>`; }).join('');
  el.innerHTML = `<div class="lesson-wrap">
    <div class="lesson-top"><a href="#/nb/${nb.id}/lessons" class="small">← All sections</a>
      <span class="small muted">Section ${i + 1} of ${nb.digest.cards.length} · ${esc(c.title)}</span></div>
    <div class="lesson-dots" aria-label="Lesson progress">${dots}</div>
    <div class="card lesson-card ${UI.lessonDir === 'back' ? 'stage-back' : UI.lessonDir ? 'stage-in' : ''}" id="lessonStage">${lessonStageHTML(nb, i, L, s, steps)}</div>
    <div class="lesson-nav">${L.pos > 0 && s.k !== 'done' ? '<button class="btn ghost" data-act="lesson-back">‹ Back</button>' : '<span></span>'}${lessonNextBtn(nb, i, L, s)}</div>
  </div>`;
  UI.lessonDir = '';
  if ((s.k === 'intro' || s.k === 'step') && !picsFor(L) && S.status.claude) lessonPics(nb, i);
}
// ── Pictures for lesson steps ──
// One AI call per section looks at the lecture's slides and picks the slide that best SHOWS each step (with a
// "look at this" pointer). Steps with no good slide get a labeled diagram or photo from an image library
// (Google Images when the site has it, otherwise Wikimedia Commons), which the student can swap or hide.
const stepSig = (L) => (L?.data?.steps || []).map((x) => x.title).join('|');
const picsFor = (L) => (L?.pics && L.pics.sig === stepSig(L) ? L.pics : null);
const WEB_IMG = /^https:\/\/[^\s"'<>\\]+$/;
async function lessonPicCandidates(nb, i, max = 14) {
  await loadVisuals(nb);
  const c = nb.digest.cards[i]; const near = new Set(refNums(c.source_ref).flatMap((n) => [n - 1, n, n + 1]));
  const picked = new Set((c.image_refs || []).map((r) => `${r.sid}:${r.idx}`));
  const all = [];
  for (const src of nb.sources) {
    const v = VIS.get(src.id); if (!v) continue;
    v.items.forEach((it, idx) => {
      const n = v.numbering === 'file' ? it.file : it.slide;
      all.push({ sid: src.id, idx, it, n, name: src.name, kind: src.kind, pri: picked.has(`${src.id}:${idx}`) ? 0 : near.has(n) ? 1 : 2 });
    });
  }
  const first = all.filter((x) => x.pri < 2).sort((a, b) => a.pri - b.pri).slice(0, Math.min(10, max));
  const rest = all.filter((x) => x.pri === 2); const room = max - first.length;
  const fill = rest.length > room ? Array.from({ length: room }, (_, k) => rest[Math.floor((k * rest.length) / room)]) : rest;
  return [...first, ...fill];
}
async function stepWebPics(q) {
  q = String(q || '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80); if (!q) return [];
  if (S.status?.googleImages) {
    try { const g = await googleImages(q); const ok = g.filter((x) => WEB_IMG.test(x.url || '') || WEB_IMG.test(x.thumb || '')).slice(0, 6); if (ok.length) return ok.map((x) => ({ url: x.url, thumb: x.thumb, page: x.page, by: x.by, name: x.name, from: 'web' })); } catch { /* fall back to Wikimedia */ }
  }
  const p = new URLSearchParams({ action: 'query', format: 'json', origin: '*', generator: 'search', gsrnamespace: '6', gsrlimit: '12', gsrsearch: q,
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '900', iiextmetadatafilter: 'LicenseShortName|Artist' });
  const r = await fetch('https://commons.wikimedia.org/w/api.php?' + p); if (!r.ok) return [];
  const d = await r.json();
  return Object.values(d.query?.pages || {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((pg) => {
    const ii = pg.imageinfo?.[0];
    if (!ii || !/^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(ii.mime || '') || Math.max(ii.width, ii.height) < 300) return null;
    const url = String(ii.thumburl || ii.url || '').split('?')[0]; if (!okPhoto(url)) return null;
    const md = ii.extmetadata || {};
    return { url, thumb: url, page: String(ii.descriptionurl || ''), by: htmlText(md.Artist?.value).slice(0, 60) || 'Unknown', license: htmlText(md.LicenseShortName?.value) || '',
      name: String(pg.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 60), from: 'Wikimedia Commons' };
  }).filter(Boolean).slice(0, 6);
}
// specific words first, then broader ones, then the section itself
async function findStepPics(o, x, section) {
  const tries = [o.q, o.q2 && `${o.q2} diagram`, o.q2, o.q && o.q.split(' ').slice(0, 2).join(' ') + ' diagram', `${section} diagram`]
    .filter(Boolean).filter((q, k, all) => all.indexOf(q) === k);
  const out = [];
  for (const q of tries) { for (const r of await stepWebPics(q)) if (!out.some((o) => o.url === r.url)) out.push(r); if (out.length >= 8) break; }
  return out.slice(0, 10);
}
async function lessonPics(nb, i) {
  const key = `${nb.id}:${i}`; if ((UI.lessonPicsBusy ||= {})[key]) return;
  const L = lessonOf(nb, i); if (!L?.data?.steps?.length) return;
  UI.lessonPicsBusy[key] = true;
  const sig = stepSig(L); const out = {};
  try {
    const cands = await lessonPicCandidates(nb, i); const images = []; const map = [];
    for (const x of cands) { try { images.push({ n: images.length + 1, label: `${x.kind === 'pdf' ? 'Page' : 'Slide'} ${x.n} of ${x.name}`, data: await shrinkDataUrl(x.it.src, 640, 0.7) }); map.push(x); } catch { /* skip */ } }
    const steps = L.data.steps.map((x) => ({ title: x.title, text: [x.plain, String(x.explain || '').replace(/[*_#>`]/g, '')].filter(Boolean).join(' ').slice(0, 500) }));
    const r = await ai('lesson_pics', { title: nb.digest.cards[i].title, steps, images });
    const used = {};
    for (const row of r.steps || []) {
      const j = Math.round(+row.step) - 1; if (!(j >= 0 && j < steps.length) || out[j]) continue;
      const k = Math.round(+row.image) - 1; const m = map[k];
      if (m && (used[k] || 0) < 2) { used[k] = (used[k] || 0) + 1; out[j] = { slide: { sid: m.sid, idx: m.idx }, look: String(row.look || '').slice(0, 160), q: String(row.search || '').slice(0, 80), q2: String(row.search_broad || '').slice(0, 60) }; }
      else out[j] = { look: String(row.look || '').slice(0, 160), q: String(row.search || '').slice(0, 80), q2: String(row.search_broad || '').slice(0, 60) };
    }
    // steps without a slide: a real diagram or photo from an image library
    await Promise.all(steps.map(async (x, j) => {
      const o = (out[j] ||= { look: '', q: '' }); if (o.slide) return;
      try { const alts = await findStepPics(o, x, nb.digest.cards[i].title); if (alts.length) { o.alts = alts; o.at = 0; } } catch { /* no picture */ }
    }));
    // keep only library pictures whose names say they fit the step (an off-topic picture is worse than none)
    const vet = steps.map((x, j) => ({ step: j + 1, title: x.title, look: out[j]?.look, options: (out[j]?.alts || []).map((w) => w.name) })).filter((v) => v.options.length);
    if (vet.length) {
      try {
        const r = await ai('pic_vet', { title: nb.digest.cards[i].title, steps: vet });
        const pick = {}; for (const row of r.steps || []) pick[Math.round(+row.step) - 1] = Math.round(+row.pick);
        for (const v of vet) {
          const o = out[v.step - 1]; const k = pick[v.step - 1];
          if (k >= 1 && k <= o.alts.length) { o.alts.unshift(...o.alts.splice(k - 1, 1)); o.at = 0; } else { o.extra = o.alts; delete o.alts; } // none fit: offer them only on request
        }
      } catch { /* couldn't check: show the first result */ }
    }
  } catch (e) { console.warn('lesson pictures', e); delete UI.lessonPicsBusy[key]; return; } // try again next time the lesson opens
  delete UI.lessonPicsBusy[key];
  const L2 = lessonOf(nb, i); if (!L2 || stepSig(L2) !== sig) return; // the lesson was rewritten meanwhile
  L2.pics = { sig, steps: out }; await save(nb);
  if (onLesson(nb, i) && lessonStages(L2.data)[L2.pos]?.k === 'step') { const slot = $('#stepPic'); if (slot) slot.outerHTML = stepPicHTML(nb, i, L2, lessonStages(L2.data)[L2.pos].j); }
}
function stepPicHTML(nb, i, L, j) {
  const P = picsFor(L); const o = P?.steps?.[j];
  if (!P) return UI.lessonPicsBusy?.[`${nb.id}:${i}`] ? '<div class="step-pic loading" id="stepPic"><span class="spinner"></span> Finding a picture for this step…</div>' : '<div id="stepPic" hidden></div>';
  const look = o?.look ? `<figcaption>👀 ${esc(o.look)}</figcaption>` : '';
  if (o?.hidden) return `<div class="step-pic-off" id="stepPic"><button class="btn sm ghost" data-act="step-pic-show" data-j="${j}">🖼️ Show the picture</button></div>`;
  if (o?.slide) {
    const sh = refShots(nb, [o.slide])[0];
    if (sh) { (UI.shots ||= {})[`lstep${i}_${j}`] = [sh];
      return `<figure class="step-pic" id="stepPic"><button class="step-pic-img" data-act="zoom-shot" data-key="lstep${i}_${j}" data-k="0" aria-label="Enlarge"><img src="${TRIMMED.get(sh.src) || sh.src}" data-trim="${TRIMMED.has(sh.src) ? '' : '1'}" alt=""${esc(sh.kind === 'pdf' ? 'Page' : 'Slide')} ${sh.n}"></button>
        ${look}<div class="step-pic-src"><span>From your ${sh.kind === 'pdf' ? 'page' : 'slide'} ${sh.n} · tap to enlarge</span><button class="linklike" data-act="step-pic-hide" data-j="${j}">Hide</button></div></figure>`; }
  }
  const w = o?.alts?.[o.at || 0];
  if (w) {
    const src = WEB_IMG.test(w.url || '') ? w.url : w.thumb; const fb = WEB_IMG.test(w.thumb || '') ? w.thumb : '';
    return `<figure class="step-pic" id="stepPic"><button class="step-pic-img" data-act="zoom-web" data-j="${j}" aria-label="Enlarge"><img src="${esc(src)}" data-fb="${esc(fb)}" alt="${esc(w.name || 'Picture')}" referrerpolicy="no-referrer" loading="lazy"></button>
      ${look}<div class="step-pic-src"><span>🌐 Not from your slides · ${w.page && WEB_IMG.test(w.page) ? `<a href="${esc(w.page)}" target="_blank" rel="noopener noreferrer">${esc(w.from)}${w.by ? `, ${esc(w.by)}` : ''}</a>` : esc(w.from)}${w.license ? ` (${esc(w.license)})` : ''}</span>
      <span class="row" style="gap:10px">${o.alts.length > 1 ? `<button class="linklike" data-act="step-pic-next" data-j="${j}">↻ Another (${(o.at || 0) + 1}/${o.alts.length})</button>` : ''}<button class="linklike" data-act="step-pic-hide" data-j="${j}">Hide</button></span></div></figure>`;
  }
  if (UI.stepPicFind === `${nb.id}:${i}:${j}`) return '<div class="step-pic loading" id="stepPic"><span class="spinner"></span> Searching for a picture…</div>';
  return `<div class="step-pic-off" id="stepPic"><button class="btn sm ghost" data-act="step-pic-find" data-j="${j}">🖼️ Find a picture of this</button></div>`;
}
function stepPicCtx(el) { const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); const P = picsFor(L); const j = +el.dataset.j; return { nb, i, L, j, o: P ? (P.steps[j] ||= { look: '', q: '' }) : null }; }
const redrawStepPic = (nb, i, L, j) => { const slot = $('#stepPic'); if (slot) slot.outerHTML = stepPicHTML(nb, i, L, j); };
ACT['step-pic-hide'] = async (el) => { const { nb, i, L, j, o } = stepPicCtx(el); if (!o) return; o.hidden = true; await save(nb); redrawStepPic(nb, i, L, j); };
ACT['step-pic-show'] = async (el) => { const { nb, i, L, j, o } = stepPicCtx(el); if (!o) return; o.hidden = false; await save(nb); redrawStepPic(nb, i, L, j); };
ACT['step-pic-next'] = async (el) => { const { nb, i, L, j, o } = stepPicCtx(el); if (!o?.alts?.length) return; o.at = ((o.at || 0) + 1) % o.alts.length; await save(nb); redrawStepPic(nb, i, L, j); };
ACT['step-pic-find'] = async (el) => {
  const { nb, i, L, j, o } = stepPicCtx(el); if (!o) return; const x = L.data.steps[j];
  UI.stepPicFind = `${nb.id}:${i}:${j}`; redrawStepPic(nb, i, L, j);
  let alts = o.extra || []; delete o.extra;
  if (!alts.length) try { alts = await findStepPics(o, x, nb.digest.cards[i].title); } catch { /* none */ }
  UI.stepPicFind = null;
  if (alts.length) { o.alts = alts; o.at = 0; o.hidden = false; await save(nb); } else toast('Couldn’t find a good picture for this step.');
  if (onLesson(nb, i)) redrawStepPic(nb, i, L, j);
};
ACT['zoom-web'] = (el) => {
  const { o } = stepPicCtx(el); const w = o?.alts?.[o.at || 0]; if (!w) return;
  const src = WEB_IMG.test(w.url || '') ? w.url : w.thumb;
  modal(`<div class="row between" style="margin-bottom:8px"><b>${esc(w.name || 'Picture')}</b><span class="small muted">🌐 ${esc(w.from)}</span></div>
    <img src="${esc(src)}" alt="" referrerpolicy="no-referrer">
    ${o.look ? `<p class="small" style="margin:10px 0 0">👀 ${esc(o.look)}</p>` : ''}
    <div class="row" style="justify-content:space-between;margin-top:10px">${w.page && WEB_IMG.test(w.page) ? `<a class="small" href="${esc(w.page)}" target="_blank" rel="noopener noreferrer">Source${w.by ? `: ${esc(w.by)}` : ''}${w.license ? ` (${esc(w.license)})` : ''}</a>` : '<span></span>'}<button class="btn" data-act="close-modal">Close</button></div>`);
};
// Slide pictures often sit in a sea of white (a tall figure on a wide slide): crop the empty margins so the
// figure itself fills the box. Slides are local data: URLs, so reading their pixels is allowed.
const TRIMMED = new Map();
function trimSlide(img) {
  const W = img.naturalWidth, H = img.naturalHeight; if (!W || !H) return null;
  const s = Math.min(1, 400 / Math.max(W, H)); const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h); const px = g.getImageData(0, 0, w, h).data;
  const at = (x, y) => { const k = (y * w + x) * 4; return [px[k], px[k + 1], px[k + 2]]; };
  const bg = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)].reduce((a, b) => a.map((v, n) => v + b[n] / 4), [0, 0, 0]);
  const off = (x, y) => { const p = at(x, y); return Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 60; };
  const rowHas = (y) => { let n = 0; for (let x = 0; x < w; x++) if (off(x, y)) n++; return n > w * 0.004; };
  const colHas = (x) => { let n = 0; for (let y = 0; y < h; y++) if (off(x, y)) n++; return n > h * 0.004; };
  let t0 = 0, b0 = h - 1, l0 = 0, r0 = w - 1;
  while (t0 < b0 && !rowHas(t0)) t0++; while (b0 > t0 && !rowHas(b0)) b0--;
  while (l0 < r0 && !colHas(l0)) l0++; while (r0 > l0 && !colHas(r0)) r0--;
  const pad = Math.round(Math.max(w, h) * 0.02);
  t0 = Math.max(0, t0 - pad); l0 = Math.max(0, l0 - pad); b0 = Math.min(h - 1, b0 + pad); r0 = Math.min(w - 1, r0 + pad);
  const cw = r0 - l0 + 1, ch = b0 - t0 + 1;
  if (cw * ch > w * h * 0.8 || cw < w * 0.1 || ch < h * 0.1) return null; // little to gain, or it found nothing sensible
  const X = Math.floor(l0 / s), Y = Math.floor(t0 / s), CW = Math.ceil(cw / s), CH = Math.ceil(ch / s);
  const k = Math.min(1, 1600 / Math.max(CW, CH)); const out = document.createElement('canvas');
  out.width = Math.round(CW * k); out.height = Math.round(CH * k);
  const o = out.getContext('2d'); o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height);
  o.drawImage(img, X, Y, CW, CH, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.9);
}
document.addEventListener('load', (e) => {
  const img = e.target; if (!(img instanceof HTMLImageElement) || img.dataset.trim !== '1') return;
  img.dataset.trim = ''; const orig = img.src;
  try { const cut = trimSlide(img); TRIMMED.set(orig, cut || orig); if (cut) img.src = cut; } catch { TRIMMED.set(orig, orig); }
}, true);
// a web picture that won't load falls back to its thumbnail, then hides itself
document.addEventListener('error', (e) => {
  const img = e.target; if (!(img instanceof HTMLImageElement) || !img.closest?.('.step-pic')) return;
  if (img.dataset.fb && img.src !== img.dataset.fb) { img.src = img.dataset.fb; img.dataset.fb = ''; } else img.closest('.step-pic').hidden = true;
}, true);
const checkFinal = (r) => !!r?.verdict && (r.verdict === 'correct' || !!r.revealed || (r.tries || 1) >= 2);
function lessonNextBtn(nb, i, L, s) {
  const ch = s.k === 'check' ? L.data.steps[s.j].check : null;
  if (s.k === 'intro') return `<button class="btn primary lg" data-act="lesson-next">Start lesson →</button>`;
  if (s.k === 'step') return `<button class="btn primary" data-act="lesson-next">${L.data.steps[s.j].check?.question ? 'Got it → quick check' : 'Next →'}</button>`;
  if (s.k === 'check') return checkFinal(L.checks[s.j]) ? '<button class="btn primary" data-act="lesson-next">Next →</button>' : `<button class="btn ghost" data-act="lesson-next">Skip this question</button>`;
  if (s.k === 'test') { const sc = testScore(L); const all = sc && sc.answered === sc.total && sc.para !== null; return all ? '<button class="btn primary" data-act="lesson-next">See my results →</button>' : `<a class="btn ghost" href="#/nb/${nb.id}/lessons">Finish later</a>`; }
  if (s.k === 'recall') return `<button class="btn ${UI.cardRecall[`${nb.id}:${i}`]?.revealed ? 'primary' : 'ghost'}" data-act="lesson-next">${UI.cardRecall[`${nb.id}:${i}`]?.revealed ? 'Next: section test →' : 'Skip to the test'}</button>`;
  return '';
}
function lessonStageHTML(nb, i, L, s, steps) {
  const c = nb.digest.cards[i]; const d = L.data;
  if (s.k === 'intro') {
    const shots = cardShots(nb, c, 3);
    return `<div class="lesson-emoji">${esc(c.emoji)}</div><h2>${esc(c.title)}</h2>
      <div class="lesson-text">${md(d.intro)}</div>
      ${shots.length ? shotStrip(`lesson${i}`, shots) : ''}
      <div class="lesson-outline-row">${d.steps.map((x, k) => `<span class="lesson-chip"><b>${k + 1}</b>${esc(x.title)}</span>`).join('')}</div>
      <div class="small muted">${steps} steps · about ${Math.max(3, steps * 2)} min</div>
      ${d.prior?.length ? `<details class="lesson-refresh"><summary>🧩 Quick refresher (${d.prior.length})</summary><ul>${d.prior.map((p) => `<li>${md(p).replace(/^<p>|<\/p>\s*$/g, '')}</li>`).join('')}</ul></details>` : ''}
      ${paperReady() ? ''
        : `<div class="paper-box"><div class="paper-ico big">📝</div><div><b>Grab paper and a pen</b>
          <p class="small" style="margin:2px 0 0">Each step has one thing to sketch or jot down.</p>
          ${PAPER_WHY}<div class="row" style="margin-top:8px"><button class="btn primary sm" data-act="paper-ready">✓ Ready</button></div></div></div>`}
      <div class="small muted">Already know the basics? <a href="#/nb/${nb.id}/deep/${i}">🔎 Go deeper on this section</a></div>
      ${d.fallback ? `<div class="small muted">This is a simpler lesson made from your study cards. <a href="#" data-act="lesson-rewrite">✨ Rewrite it with AI</a></div>` : ''}`;
  }
  if (s.k === 'step') {
    const x = d.steps[s.j]; const help = (L.help || {})[s.j] || []; const busy = UI.lessonHelpBusy === `${nb.id}:${i}:${s.j}`;
    const lab = { simpler: '🧒 Simpler', example: '💡 Another example', question: '❓ You asked' };
    return `<div class="lesson-kicker">Step ${s.j + 1} of ${steps}</div><h2>${esc(x.title)}</h2>
      ${x.plain ? `<div class="lesson-plain"><span>🗣️ In plain words</span>${esc(x.plain)}</div>` : ''}
      <div class="lesson-text">${md(x.explain)}</div>
      ${stepPicHTML(nb, i, L, s.j)}
      ${x.example ? `<div class="lesson-box ex"><b>💡 Example</b><div>${md(x.example)}</div></div>` : ''}
      <div class="paper-task"><span class="paper-ico">✍️</span><div>${esc(paperPrompt(x, s.j))}</div></div>
      ${x.terms?.length ? `<dl class="lesson-terms">${x.terms.map((t) => `<div><dt>${esc(t.term)}</dt><dd>${esc(t.meaning)}</dd></div>`).join('')}</dl>` : ''}
      ${help.map((h) => `<div class="lesson-box help"><b>${lab[h.mode] || '💬'}${h.q ? `: “${esc(h.q)}”` : ''}</b>${h.guess ? `<div class="small muted">Your guess: “${esc(h.guess)}”</div>` : ''}<div>${md(h.a)}</div></div>`).join('')}
      ${busy ? '<div class="lesson-box help"><span class="spinner"></span> Thinking…</div>' : ''}
      <div class="lesson-help-row">
        <button class="btn sm ghost" data-act="lesson-guess" data-mode="simpler" ${busy ? 'disabled' : ''}>🧒 Simpler</button>
        <button class="btn sm ghost" data-act="lesson-guess" data-mode="example" ${busy ? 'disabled' : ''}>💡 Example</button>
        <button class="btn sm ghost" data-act="lesson-ask" ${busy ? 'disabled' : ''}>❓ Ask</button>
        <a class="btn sm ghost" href="#/nb/${nb.id}/deep/${i}" title="The mechanism in depth, picture walk-through, common mistakes and harder questions">🔎 Go deeper</a></div>
      ${UI.lessonGuess?.key === `${nb.id}:${i}:${s.j}` ? `<div class="lesson-ask guess-box"><b>🤔 Quick guess first</b>
        <div class="small muted">In your own words, what do you think this step is saying? A rough guess is fine. Guessing first makes the explanation stick.</div>
        <textarea id="lessonGuessIn" rows="2" placeholder="I think it means…"></textarea>
        <div class="row"><button class="btn primary sm" data-act="lesson-help" data-mode="${UI.lessonGuess.mode}">${UI.lessonGuess.mode === 'example' ? 'Show an example' : 'Explain it simpler'}</button><button class="btn ghost sm" data-act="lesson-help" data-mode="${UI.lessonGuess.mode}" data-skip="1">Skip guess</button></div></div>` : ''}
      ${UI.lessonAsk === `${nb.id}:${i}:${s.j}` ? `<div class="lesson-ask"><textarea id="lessonQ" rows="2" placeholder="What’s confusing?"></textarea>
        <div class="row"><button class="btn primary sm" data-act="lesson-help" data-mode="question">Ask</button><button class="btn ghost sm" data-act="lesson-ask-cancel">Cancel</button></div></div>` : ''}`;
  }
  if (s.k === 'check') {
    // First wrong answer: no answer shown, just a hint and a second try. The answer appears after the second try,
    // or when you tap "Show me the answer".
    const x = d.steps[s.j]; const ch = x.check; const raw = (L.checks || {})[s.j]; const grading = UI.lessonGrading === `${nb.id}:${i}:${s.j}`;
    const fin = checkFinal(raw); const hinting = !!raw?.verdict && !fin;
    const ckey = `${nb.id}:${i}:${s.j}`; const conf = (UI.lessonConf ||= {})[ckey];
    const confRow = raw?.verdict ? '' : `<div class="conf-row"><span class="small muted">How sure are you?</span>${[['guess', 'Guessing'], ['think', 'Think so'], ['sure', 'Sure']].map(([k, l]) => `<button class="chip-btn ${conf === k ? 'on' : ''}" data-act="lesson-conf" data-c="${k}">${l}</button>`).join('')}</div>`;
    const wrong = raw?.wrong || [];
    let body;
    if (ch.type === 'mcq') {
      body = `<div class="lesson-opts">${ch.options.map((o, k) => {
        const cls = fin ? (o === ch.answer ? 'right' : wrong.includes(k) ? 'wrong' : 'dim') : wrong.includes(k) ? 'wrong crossed' : '';
        const off = fin || wrong.includes(k);
        const sel = !fin && UI.lessonPick?.[ckey] === k && !wrong.includes(k) ? 'sel' : '';
        return `<button class="opt ${cls} ${sel}" data-act="lesson-pick" data-o="${k}" ${off ? 'disabled' : ''} aria-pressed="${!!sel}"><span class="opt-l">${'ABCD'[k] || k + 1}</span><span>${esc(o)}</span></button>`;
      }).join('')}</div>
      ${fin ? '' : `<div class="row"><button class="btn primary" data-act="lesson-mcq-check" ${UI.lessonPick?.[ckey] === undefined || wrong.includes(UI.lessonPick?.[ckey]) ? 'disabled' : ''}>Check answer</button><span class="small muted">${hinting ? 'Pick another option.' : 'Pick one, say how sure you are, then check.'}</span></div>`}`;
    } else if (fin) {
      body = `<div class="lesson-mine"><span class="small muted">Your answer</span><div>${esc(raw.text)}</div></div>`;
    } else {
      const draft = grading ? UI.lessonDraft || '' : UI.lessonTyped?.[ckey] ?? (hinting ? raw.text || '' : '');
      body = `<textarea id="lessonA" rows="3" placeholder="Answer in your own words…" ${grading ? 'disabled' : ''}>${esc(draft)}</textarea>
        <div class="row"><button class="btn primary" data-act="lesson-short" ${grading ? 'disabled' : ''}>${grading ? '<span class="spinner"></span> Checking…' : hinting ? 'Check again' : 'Check my answer'}</button></div>`;
    }
    const v = raw?.verdict; const head = { correct: '✓ Correct', partial: '◐ Partly right', incorrect: '✗ Not quite' }[v] || '';
    const hintBox = hinting ? `<div class="verdict ${v} hint-box"><h3>${v === 'partial' ? '◐ Almost there' : '✗ Not quite'}</h3>
        <div>💡 <b>Hint:</b> ${esc(ch.hint || `Reread step ${s.j + 1} and look at the bold words.`)}</div>
        <div class="small muted" style="margin-top:4px">${ch.type === 'mcq' ? 'Pick another option.' : 'Change your answer and check again.'}</div>
        <div class="row" style="margin-top:8px"><button class="btn sm" data-act="lesson-back">‹ Reread the step</button><button class="btn sm ghost" data-act="lesson-reveal">Show me the answer</button>${ch.type === 'short' && v !== 'correct' ? '<button class="btn sm ghost" data-act="lesson-override" title="If the grader got it wrong, count your answer as correct">✋ I was right, count it</button>' : ''}</div></div>` : '';
    const finalBox = fin ? `<div class="verdict ${v}"><h3>${raw.revealed && v !== 'correct' ? '👀 Here’s the answer' : head}${raw.tries > 1 && v === 'correct' ? ' on the second try' : ''}</h3>
        ${raw.feedback && !raw.revealed ? `<div>${esc(raw.feedback)}</div>` : ''}
        ${ch.type === 'short' || raw.revealed ? `<div class="small" style="margin-top:6px"><b>Answer:</b> ${esc(ch.answer)}</div>` : ''}
        ${ch.explanation ? `<div class="small" style="margin-top:6px">${esc(ch.explanation)}</div>` : ''}
        ${raw.overridden ? '<div class="small muted" style="margin-top:6px">✋ You marked this correct.</div>' : ''}
        ${v !== 'correct' && ch.type === 'short' ? `<div class="row" style="margin-top:8px">${'<button class="btn sm ghost" data-act="lesson-override" title="If the grader got it wrong, count your answer as correct">✋ I was right, count it</button>'}</div>` : ''}
        ${raw.conf === 'sure' && (raw.first ?? raw.ok) < 1 ? '<div class="small" style="margin-top:6px">⚠️ You were sure at first, so this one comes back in Recall today.</div>' : (raw.first ?? raw.ok) < 1 ? '<div class="small muted" style="margin-top:6px">🧠 This one comes back in Recall tomorrow.</div>' : ''}</div>` : '';
    return `<div class="lesson-kicker">Quick check · step ${s.j + 1} of ${steps} · ${ch.type === 'mcq' ? 'multiple choice' : 'short answer'}${hinting ? ' · second try' : ''}</div>
      <h2 class="lesson-q">${esc(ch.question)}</h2>${confRow}${body}${hintBox}${finalBox}`;
  }
  if (s.k === 'recall') {
    const stR = UI.cardRecall[`${nb.id}:${i}`];
    if (!stR?.revealed) {
      return `<div class="lesson-kicker">Put it together</div><h2>Cover & recall</h2>
        <p class="muted" style="margin:0">Notes face down. Write the ${c.points.length} key points of <b>${esc(c.title)}</b> from memory.</p>
        ${UI.paperRecall === `${nb.id}:${i}` ? `<div class="paper-box"><div class="paper-ico big">✍️</div><div><b>Check your page</b>
          <p class="small" style="margin:2px 0 8px">Tick what you wrote (close enough counts).</p>
          <div class="paper-checks">${c.points.map((p, j) => `<label class="check"><input type="checkbox" data-pp="${j}"> <span>${esc(p)}</span></label>`).join('')}</div>
          <div class="row" style="margin-top:10px"><button class="btn primary" data-act="paper-recall-done">Done checking</button><button class="btn ghost sm" data-act="paper-recall-cancel">Back</button></div></div></div>`
        : `<div class="row"><button class="btn primary" data-act="paper-recall">✍️ Done on paper, check it</button></div>
        <div class="small muted">Or type it:</div>
        <textarea data-cr="${i}" rows="4" placeholder="From memory…">${esc(stR?.text || '')}</textarea>
        <div class="row"><button class="btn" data-act="card-reveal" data-i="${i}">Reveal & compare</button></div>`}`;
    }
    const got = stR.hits.filter(Boolean).length;
    return `<div class="lesson-kicker">Put it together</div><h2>Cover & recall</h2>
      <ul class="lesson-hits">${c.points.map((p, j) => `<li class="${stR.hits[j] ? 'hit' : 'miss'}">${stR.hits[j] ? '✓' : '✗'} ${esc(p)}</li>`).join('')}</ul>
      <div class="small"><b>${got}/${c.points.length}</b> recalled. ${got === c.points.length ? 'Perfect! 🎉' : stR.paper ? 'Add the red ones to your page in another color.' : 'Red = gaps. Reread them, then try again.'}</div>
      <div class="row"><button class="btn sm" data-act="card-retry" data-i="${i}">Try again</button></div>`;
  }
  if (s.k === 'test') return testStageHTML(nb, i, L);
  // done
  const inf = lessonInfo(nb, i); const n = nb.digest.cards.length; const nx = i + 1 < n ? i + 1 : null;
  return `<div class="lesson-done"><div class="pm-big-ico">✓</div><h2>Section complete</h2>
    <p class="pm-xp">${esc(inf.label.replace(/^Done ✓ ·? ?/, '')) || 'Nice work'}</p>
    ${(() => { const cs = Object.values(L.checks || {}).filter((c) => c.conf === 'sure'); if (!cs.length) return ''; const ok = cs.filter((c) => (c.first ?? c.ok) >= 1).length;
      return `<div class="small" style="text-align:center">🎯 When you felt sure, you were right ${ok} of ${cs.length}${ok < cs.length ? '. The sure-but-wrong ones come back in Recall today.' : '. Nicely calibrated!'}</div>`; })()}
    ${(() => { const sc = testScore(L); if (!sc || !sc.answered && sc.para === null) return ''; return `<div class="test-results"><span><b>${sc.right}/${sc.total}</b> multiple choice</span>${sc.para !== null ? `<span><b>${Math.round(sc.para)}%</b> free response</span>` : ''}</div>`; })()}</div>
    ${d.summary?.length ? `<div class="lesson-box plain"><b>Takeaways</b><ul>${d.summary.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${d.mnemonic ? `<div class="lesson-box ex"><b>🧠 Memory hook</b><div>${esc(d.mnemonic)}</div></div>` : ''}
    ${teachBackHTML(nb, i, L)}
    <div class="small muted" style="text-align:center">📄 Keep your page. Tomorrow, redraw the sketches from memory.</div>
    <div class="row lesson-done-row">${nx !== null ? `<button class="btn primary lg" data-act="lesson-open" data-i="${nx}">Next: ${esc(nb.digest.cards[nx].title)} →</button>`
      : `<a class="btn primary lg" href="#/nb/${nb.id}/recall">🧠 Last section done! Start recall →</a>`}
      <a class="btn" href="#/nb/${nb.id}/lessons">All sections</a>
      <a class="btn" href="#/nb/${nb.id}/deep/${i}">🔎 Go deeper</a>
      <button class="btn ghost" data-act="lesson-retake" data-i="${i}">↻ Retake this section</button></div>
    <div class="small muted" style="text-align:center">A retake runs the lesson again with a brand-new test, so you’re recalling, not remembering the same questions.</div>`;
}

// ── end-of-section test: 10 varied multiple-choice questions + 2 free-response questions, written by the AI the first
// time you reach it. Nothing may repeat a quick check, an earlier section's question, or another question in the test. ──
const TEST_MCQ = 10, TEST_FR = 2;
function shuffleOpts(q) {
  const opts = (q.options || []).filter(Boolean);
  const hit = opts.find((o) => norm(o) === norm(q.answer)) || opts.find((o) => similar(o, q.answer) > 0.85);
  if (opts.length < 2 || !hit) return null;
  for (let k = opts.length - 1; k > 0; k--) { const r = Math.floor(Math.random() * (k + 1)); [opts[k], opts[r]] = [opts[r], opts[k]]; }
  return { question: q.question, options: opts, answer: hit, explanation: q.explanation || '', concept_id: q.concept_id || '', review: !!q.review };
}
// older saved tests had one "paragraph"; newer ones have a list of free responses
function testFRs(T) { if (!T) return []; if (!T.paragraphs && T.paragraph) T.paragraphs = [T.paragraph]; return T.paragraphs || []; }
function testFRAnswers(T) { if (!T.paras) T.paras = T.para ? { 0: T.para } : {}; return T.paras; }
function localTest(nb, i, L) {
  const c = nb.digest.cards[i];
  const mcq = (L.data.steps || []).map((s) => s.check).filter((ch) => ch?.type === 'mcq').map(shuffleOpts).filter(Boolean).slice(0, 4);
  return { fallback: true, mcq, paragraphs: [
    { prompt: `In a paragraph, explain ${c.title.toLowerCase()} step by step in your own words, and say why each step happens.`, key_points: c.points, model: '' },
    { prompt: `Describe a situation (in the body or a patient) where ${c.title.toLowerCase()} matters, and explain what would go wrong if it didn't work.`, key_points: c.points.slice(0, 3), model: '' },
  ] };
}
function seenQuestions(nb, skip) {
  const out = [];
  for (const [k, L] of Object.entries(nb.lessons || {})) {
    if (!L?.data) continue;
    if (+k !== skip) for (const s of L.data.steps || []) if (s.check?.question) out.push({ q: s.check.question, a: s.check.answer });
    if (+k !== skip) for (const q of L.test?.mcq || []) out.push({ q: q.question, a: q.answer });
    if (+k !== skip) for (const p of testFRs(L.test)) out.push({ q: p.prompt, a: '' });
    for (const q of L.pastTests || []) if (+k === skip) out.push(q);
  }
  return out;
}
async function buildTest(nb, i) {
  const L = lessonOf(nb, i); const c = nb.digest.cards[i]; const key = `${nb.id}:${i}`;
  (UI.testBusy ||= {})[key] = true;
  let t = null;
  if (await aiReady()) {
    try {
      const r = await ai('section_test', { sources: aiSources(nb), title: c.title, points: c.points,
        steps: (L.data.steps || []).map((s) => `${s.title}: ${String(s.explain || '').slice(0, 220)}`),
        used: (L.data.steps || []).map((s) => s.check?.question).filter(Boolean),
        seen: seenQuestions(nb, i).slice(-40).map((x) => x.q.slice(0, 160)),
        concepts: nb.digest.concepts.map((x) => ({ id: x.id, name: x.name })),
        earlier: nb.digest.cards.slice(0, i).sort(() => Math.random() - 0.5).slice(0, 3).map((x) => ({ title: x.title, points: x.points })) });
      const ownChecks = (L.data.steps || []).map((s) => s.check).filter((ch) => ch?.question).map((ch) => ({ q: ch.question, a: ch.answer }));
      const used = [...seenQuestions(nb, i).slice(-(40 - ownChecks.length)), ...ownChecks]; // keep this section's own checks in every comparison
      // only this section and earlier ones: drop questions about concepts that are first taught in a later section
      const known = new Set(nb.digest.cards.slice(0, i + 1).flatMap((x) => x.concept_ids || []));
      const allIds = new Set(nb.digest.concepts.map((x) => x.id));
      const all = (r.mcq || []).map(shuffleOpts).filter(Boolean).filter((q) => !q.concept_id || !allIds.has(q.concept_id) || known.has(q.concept_id));
      // a repeat: close wording, or the same answer on a similar topic
      // word overlap only catches near-identical questions (both ways); repeats in different words are left to the AI check above
      const same = (q, u) => { const qq = Math.min(coverage(q.question, u.q), coverage(u.q, q.question)); const aa = u.a ? Math.min(coverage(q.answer, u.a), coverage(u.a, q.answer)) : 0; return qq >= 0.6 || (aa >= 0.7 && qq >= 0.35) || (!!u.a && norm(q.answer) === norm(u.a)); };
      // same meaning in different words (vs. what was already asked, and inside this test): ask the AI
      let aiRepeat = new Set();
      try {
        const d = await ai('dedupe', { asked: used.map((u) => (u.a ? `${u.q} (answer: ${u.a})` : u.q)), candidates: all.map((q) => `${q.question} (answer: ${q.answer})`) });
        aiRepeat = new Set((d.repeats || []).map((n) => n - 1));
      } catch { /* word-overlap check below still runs */ }
      const picked = [];
      all.forEach((q, n) => { if (!aiRepeat.has(n) && !used.some((u) => same(q, u)) && !picked.some((p) => same(q, { q: p.question, a: p.answer }))) picked.push(q); });
      const review = picked.filter((q) => q.review).slice(0, 2);
      let mcq = [...picked.filter((q) => !q.review).slice(0, TEST_MCQ - review.length), ...review];
      if (mcq.length < TEST_MCQ) { // top up only with questions that don't share wording or an answer with anything already in the test
        all.forEach((q, n) => { if (mcq.length >= TEST_MCQ || aiRepeat.has(n)) return; if (!mcq.includes(q) && !mcq.some((p) => same(q, { q: p.question, a: p.answer })) && !used.some((u) => same(q, u))) mcq.push(q); }); // never re-add a flagged repeat: fewer questions beats a repeat
      }
      // second, independent repeat check on the final picks (the AI judge isn't perfectly consistent, so two passes catch more)
      try {
        const d2 = await ai('dedupe', { asked: used.map((u) => (u.a ? `${u.q} (answer: ${u.a})` : u.q)), candidates: mcq.map((q) => `${q.question} (answer: ${q.answer})`) });
        const drop = new Set((d2.repeats || []).map((n) => n - 1));
        if (drop.size) {
          const dropped = new Set(mcq.filter((_, n) => drop.has(n)));
          mcq = mcq.filter((_, n) => !drop.has(n));
          all.forEach((q, n) => { if (mcq.length >= TEST_MCQ || aiRepeat.has(n) || dropped.has(q) || mcq.includes(q)) return; if (!mcq.some((p) => same(q, { q: p.question, a: p.answer })) && !used.some((u) => same(q, u))) mcq.push(q); });
        }
      } catch { /* keep the first pass */ }
      mcq.sort((x, y) => (x.review ? 1 : 0) - (y.review ? 1 : 0)); // review questions last
      const frs = (r.paragraphs || []).filter((p) => p?.prompt).slice(0, TEST_FR);
      if (mcq.length < 3 || !frs.length) throw new Error('The test came back incomplete. Try again.');
      t = tidyDeep({ mcq, paragraphs: frs });
      CAUSE_RX.lastIndex = 0;
      if (CAUSE_RX.test(textOf(t)) || OPTION_RX.test(textOf(t))) { const before = JSON.parse(JSON.stringify(t)); await factCheck(nb, t); fixCauseClaims(t); t.mcq = t.mcq.map(shuffleOpts).filter(Boolean); if (t.mcq.length < 3) { t = before; fixCauseClaims(t); } }
      CAUSE_RX.lastIndex = 0;
    } catch (e) { if (e.code === 'no_key') aiError(e); else toast(`Couldn’t write the section test with AI (${e.message}). Using a shorter one.`, 'err'); }
  }
  L.test = { ...(t || localTest(nb, i, L)), answers: {}, paras: {} };
  delete UI.testBusy[key]; await save(nb);
}
function testScore(L) {
  const T = L.test; if (!T) return null;
  const right = T.mcq.filter((q, k) => T.answers[k] === q.answer).length;
  const frs = testFRs(T); const fa = testFRAnswers(T);
  const graded = frs.map((_, p) => fa[p]?.result?.score).filter((x) => typeof x === 'number');
  return { right, total: T.mcq.length, answered: Object.keys(T.answers).length, frDone: graded.length, frTotal: frs.length,
    para: frs.length && graded.length === frs.length ? Math.round(graded.reduce((a, b) => a + b, 0) / graded.length) : null };
}
function frHTML(nb, i, T, p) {
  const key = `${nb.id}:${i}:${p}`; const P = testFRs(T)[p]; const A = testFRAnswers(T)[p]; const R = A?.result; const grading = !!UI.paraGrading?.[key];
  const body = R ? `<div class="lesson-mine"><span class="small muted">Your answer</span><div>${esc(A.text)}</div></div>
      <div class="verdict ${R.verdict}"><div class="row between"><h3>${{ correct: '✓ Strong answer', partial: '◐ Good start', incorrect: '✗ Needs more' }[R.verdict] || 'Graded'}</h3><b>${Math.round(R.score)}%</b></div>
        <div class="meter" style="margin:6px 0 8px"><i style="width:${Math.round(R.score)}%"></i></div>
        ${R.feedback ? `<div>${esc(R.feedback)}</div>` : ''}
        ${R.covered?.length ? `<div class="small fb-good" style="margin-top:8px"><b>✓ You covered</b><ul class="list-good">${R.covered.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${R.missing?.length ? `<div class="small fb-gap"><b>Work on next</b><ul class="list-gap">${R.missing.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${R.misconceptions?.length ? `<div class="small"><b>Watch out:</b><ul>${R.misconceptions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${P.model ? `<details class="small" style="margin-top:6px"><summary>See a model answer</summary><p style="margin:6px 0 0">${esc(P.model)}</p></details>` : ''}</div>`
    : `<textarea data-fr="${p}" rows="6" placeholder="Write 4–6 sentences…" ${grading ? 'disabled' : ''}>${esc(UI.paraDraft?.[key] || '')}</textarea>
      <div class="row"><button class="btn primary" data-act="test-para" data-p="${p}" ${grading ? 'disabled' : ''}>${grading ? '<span class="spinner"></span> Grading…' : 'Submit answer'}</button>
        <span class="small muted fr-count">${wordCount(UI.paraDraft?.[key] || '')} words</span></div>`;
  return `<div class="test-q"><div class="test-qh"><span class="test-n">${String.fromCharCode(65 + p)}</span><b>${esc(P.prompt)}</b></div>${body}</div>`;
}
function testStageHTML(nb, i, L) {
  const key = `${nb.id}:${i}`; const T = L.test;
  if (!T) {
    if (!UI.testBusy?.[key]) buildTest(nb, i).then(() => { if (onLesson(nb, i)) lessonShow(nb, i); });
    return `<div class="lesson-kicker">Section test</div><h2>Writing your test…</h2><div class="spinner lg" style="margin:10px auto"></div>
      <p class="muted" style="text-align:center;margin:0">${TEST_MCQ} multiple-choice questions and ${TEST_FR} free-response questions, all different. Usually 20–40 seconds.</p>`;
  }
  const sc = testScore(L); const frs = testFRs(T);
  const mcqHTML = T.mcq.map((q, k) => {
    const a = T.answers[k];
    return `<div class="test-q"><div class="test-qh"><span class="test-n">${k + 1}</span><b>${q.review ? '<span class="tag review-tag">Review · earlier section</span> ' : ''}${esc(q.question)}</b></div>
      <div class="lesson-opts">${q.options.map((o, n) => {
        const cls = a !== undefined ? (o === q.answer ? 'right' : a === o ? 'wrong' : 'dim') : '';
        return `<button class="opt ${cls}" data-act="test-mcq" data-q="${k}" data-o="${n}" ${a !== undefined ? 'disabled' : ''}><span class="opt-l">${'ABCD'[n] || n + 1}</span><span>${esc(o)}</span></button>`;
      }).join('')}</div>
      ${a !== undefined && q.explanation ? `<div class="small test-exp ${a === q.answer ? 'ok' : 'no'}">${a === q.answer ? '✓' : '✗'} ${esc(q.explanation)}</div>` : ''}</div>`;
  }).join('');
  return `<div class="lesson-kicker">Section test</div><h2>Show what you learned</h2>
    <p class="muted" style="margin:0">No peeking at your notes. Multiple choice: ${sc.answered}/${sc.total} answered${sc.answered ? ` · ${sc.right} right` : ''}. Free response: ${sc.frDone}/${sc.frTotal} done.</p>
    ${T.fallback && !sc.answered && !sc.frDone ? '<div class="small muted">This is a shorter test made from your lesson. <a href="#" data-act="test-rewrite">✨ Write a full test with AI</a></div>' : ''}
    <div class="test-part"><h3>Part 1 · Multiple choice (${T.mcq.length})</h3>${mcqHTML}</div>
    <div class="test-part"><h3>Part 2 · Free response (${frs.length})</h3>
      <div class="small muted" style="margin:-4px 0 0">📝 Jot 3 bullets on paper first, then write each answer here.</div>
      ${frs.map((_, p) => frHTML(nb, i, T, p)).join('')}</div>`;
}
ACT['test-rewrite'] = async () => {
  const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); if (!L) return;
  if (!(await aiReady())) { toast('Writing tests needs the AI tutor. See Settings.', 'err'); return openSettings(); }
  delete L.test; lessonShow(nb, i);
};
ACT['test-mcq'] = async (el) => {
  const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); const T = L?.test; if (!T) return;
  const k = +el.dataset.q; if (T.answers[k] !== undefined) return;
  const q = T.mcq[k]; const pick = q.options[+el.dataset.o]; T.answers[k] = pick;
  lessonRecord(nb, i, q, pick === q.answer ? 1 : 0); await save(nb);
  const y = window.scrollY; renderLesson(nb, $('#tab'), i); window.scrollTo(0, y);
  if (pick === q.answer) gainXP(3, 'section test');
};
document.addEventListener('input', (e) => {
  const p = e.target.dataset?.fr; if (p === undefined) return;
  (UI.paraDraft ||= {})[`${route().id}:${route().arg}:${p}`] = e.target.value;
  const w = e.target.parentElement.querySelector('.fr-count'); if (w) w.textContent = `${wordCount(e.target.value)} words`;
});
ACT['test-para'] = async (el) => {
  const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); const T = L?.test; if (!T) return;
  const p = +el.dataset.p; const P = testFRs(T)[p]; const fa = testFRAnswers(T); if (!P || fa[p]?.result) return;
  const key = `${nb.id}:${i}:${p}`; const text = (document.querySelector(`[data-fr="${p}"]`)?.value || '').trim();
  if (wordCount(text) < 8) { toast('Write a few sentences first (at least 8 words).'); document.querySelector(`[data-fr="${p}"]`)?.focus(); return; }
  if (UI.paraGrading?.[key]) return; (UI.paraDraft ||= {})[key] = text; (UI.paraGrading ||= {})[key] = true;
  const keep = () => lessonShow(nb, i);
  keep();
  let r = null;
  if (S.status.claude) { try { r = await ai('paragraph', { prompt: P.prompt, key_points: P.key_points, model: P.model, response: text }); } catch (e) { aiError(e); } }
  if (!r || typeof r.score !== 'number') {
    const hits = (P.key_points || []).filter((x) => coverage(text, x) >= 0.4);
    const score = Math.round(100 * hits.length / Math.max(1, (P.key_points || []).length));
    r = { score, verdict: score >= 80 ? 'correct' : score >= 40 ? 'partial' : 'incorrect', covered: hits, missing: (P.key_points || []).filter((x) => !hits.includes(x)), misconceptions: [], feedback: 'Checked by matching key points (the AI grader wasn’t available).' };
  }
  r.score = Math.max(0, Math.min(100, r.score));
  fa[p] = { text, result: r }; delete UI.paraGrading[key]; delete UI.paraDraft[key];
  (nb.digest.cards[i].concept_ids || []).forEach((cid) => record(nb, cid, r.score / 100));
  await save(nb);
  if (onLesson(nb, i)) keep();
  const xp = Math.round(r.score / 10); if (xp) gainXP(xp, 'free response');
};

// ── Teach it back: explaining in your own words (the Feynman technique) is one of the strongest ways to lock it in ──
function teachBackHTML(nb, i, L) {
  const c = nb.digest.cards[i]; const T = L.teach; const busy = UI.teachBackBusy === `${nb.id}:${i}`;
  if (T?.result) {
    const r = T.result;
    return `<div class="lesson-box teach-box"><b>🗣️ Teach it back · ${Math.round(r.score)}%</b>
      <div class="small muted">You wrote: “${esc(T.text)}”</div>
      ${r.nailed?.length ? `<div class="small fb-good"><b>✓ Nailed</b><ul class="list-good">${r.nailed.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${r.gaps?.length ? `<div class="small fb-gap"><b>Work on next</b><ul class="list-gap">${r.gaps.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${r.misconceptions?.length ? `<div class="small fb-bad"><b>Careful</b><ul class="list-bad">${r.misconceptions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${r.better_analogy ? `<div class="small">🔗 ${esc(r.better_analogy)}</div>` : ''}
      <div class="row"><button class="btn sm ghost" data-act="lesson-teach-again">Try explaining again</button></div></div>`;
  }
  return `<div class="lesson-box teach-box"><b>🗣️ Last step: teach it back</b>
    <div class="small">Explain <b>${esc(c.title)}</b> to a 12-year-old in about 3 sentences, without looking. Explaining it is one of the best ways to make it stick.</div>
    <textarea id="teachBackIn" rows="4" placeholder="So basically…" ${busy ? 'disabled' : ''}>${esc(UI.teachBackFor === `${nb.id}:${i}` ? UI.teachBackDraft || '' : '')}</textarea>
    <div class="row"><button class="btn primary sm" data-act="lesson-teach" ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner"></span> Reading…' : 'Check my explanation'}</button><span class="small muted">Up to +30 XP</span></div></div>`;
}
document.addEventListener('input', (e) => { if (e.target.id === 'teachBackIn') { UI.teachBackDraft = e.target.value; UI.teachBackFor = `${route().id}:${route().arg}`; } });
ACT['lesson-teach'] = async () => {
  const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); const c = nb.digest.cards[i];
  const text = ($('#teachBackIn')?.value || '').trim();
  if (wordCount(text) < 12) { toast('Write a bit more: about 3 sentences.'); $('#teachBackIn')?.focus(); return; }
  if (!S.status.claude) { toast('Checking explanations needs the AI tutor. See Settings.', 'err'); return openSettings(); }
  UI.teachBackBusy = `${nb.id}:${i}`; UI.teachBackDraft = text; lessonShow(nb, i);
  try {
    const r = await ai('feynman', { sources: aiSources(nb), concept: c.title, prompt: `Explain "${c.title}" to a 12-year-old in about 3 sentences. Key points: ${c.points.join('; ')}`, explanation: text, history: [] });
    L.teach = { text, result: r, at: Date.now() };
    (c.concept_ids || []).forEach((cid) => record(nb, cid, Math.min(1, (r.score || 0) / 100)));
    const xp = 5 + Math.round((r.score || 0) / 4); const gain = Math.max(0, xp - (L.teachXp || 0)); L.teachXp = Math.max(L.teachXp || 0, xp);
    UI.teachBackDraft = ''; await save(nb);
    if (gain) await gainXP(gain, 'teach-back');
  } catch (e) { aiError(e); }
  UI.teachBackBusy = null;
  if (onLesson(nb, i)) { const y = window.scrollY; renderLesson(nb, $('#tab'), i); window.scrollTo(0, y); }
};
ACT['lesson-teach-again'] = async () => { const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); UI.teachBackDraft = ''; delete L.teach; await save(nb); const y = window.scrollY; renderLesson(nb, $('#tab'), i); window.scrollTo(0, y); };

// ═════════════════════════ GO DEEPER: one section in depth ═════════════════════════
// For when the beginner lesson isn't enough: the mechanism step by step, a walk-through of the slide pictures,
// common mistakes and harder exam-style questions. Anything not from the student's own material is labelled.
function deepOf(nb, i) { const D = (nb.deep || {})[i]; const c = nb.digest?.cards[i]; return D && c && D.title === c.title ? D : null; }
const BEYOND = '<span class="tag beyond" title="Not in your uploaded material: general A&P knowledge. Check it against your professor’s slides.">🌐 Beyond your notes</span>';
async function buildDeep(nb, i) {
  const c = nb.digest.cards[i]; const key = `${nb.id}:${i}`; if (UI.deepBusy?.[key]) return; (UI.deepBusy ||= {})[key] = true; delete UI.deepErr?.[key];
  const prev = deepOf(nb, i) || (UI.deepPrev?.title === c.title ? UI.deepPrev : null); UI.deepPrev = null;
  try {
    if (!(await aiReady())) { const e = new Error('Going deeper needs the AI tutor. See Settings.'); e.code = 'no_key'; throw e; }
    await loadVisuals(nb);
    const allShots = cardShots(nb, c, 3); const images = []; const picMap = [];
    for (const sh of allShots) { try { const data = await shrinkDataUrl(sh.src, 900, 0.75); images.push({ n: images.length + 1, label: `${sh.kind === 'pdf' ? 'Page' : 'Slide'} ${sh.n}`, data }); picMap.push(allShots.indexOf(sh)); } catch { /* skip */ } }
    const shots = picMap.map((k) => allShots[k]);
    const L = lessonOf(nb, i);
    const asked = [...(L?.data?.steps || []).map((s) => s.check?.question).filter(Boolean), ...(L?.test?.mcq || []).map((q) => q.question),
      ...(prev?.asked || []), ...(prev?.data?.questions || []).map((q) => q.question)].slice(-40);
    const r = await ai('deep_dive', {
      sources: aiSources(nb), images, title: c.title, points: c.points,
      concepts: (c.concept_ids || []).map((id) => nb.digest.concepts.find((x) => x.id === id)).filter(Boolean).map((x) => ({ id: x.id, name: x.name, definition: x.definition })),
      lesson: (L?.data?.steps || []).map((s) => s.title), asked, others: nb.digest.cards.filter((_, k) => k !== i).map((x) => x.title), previous: prev?.count || 0,
    });
    tidyDeep(r); fixCauseClaims(r);
    r.questions = (r.questions || []).map((q) => {
      if (q.type !== 'mcq') return { ...q, options: [] };
      const s = shuffleOpts(q); return s ? { ...s, type: 'mcq', beyond: !!q.beyond } : { ...q, type: 'short', options: [] };
    });
    r.pictures = (r.pictures || []).filter((p) => p.image >= 1 && p.image <= shots.length && (p.walkthrough || []).length).map((p) => ({ ...p, image: picMap[p.image - 1] + 1 }));
    if (!(r.layers || []).length) throw new Error('The deep dive came back empty. Try again.');
    nb.deep ||= {};
    nb.deep[i] = { title: c.title, data: r, at: Date.now(), answers: {}, count: (prev?.count || 0) + 1, asked, toRecall: false };
    await save(nb);
  } catch (e) { (UI.deepErr ||= {})[key] = e.message || 'Something went wrong'; if (e.code === 'no_key') aiError(e); }
  delete UI.deepBusy[key];
}
function renderDeep(nb, el, arg) {
  const i = +arg; const c = nb.digest?.cards[i];
  if (!c) return go(`#/nb/${nb.id}/lessons`);
  let D = deepOf(nb, i); const key = `${nb.id}:${i}`;
  if (UI.deepBusy?.[key]) D = null; // a new deep dive is being written
  const top = `<div class="lesson-top"><a href="#/nb/${nb.id}/lessons" class="small">← All sections</a><a href="#/nb/${nb.id}/lessons/${i}" class="small">Back to the lesson</a></div>`;
  if (!D) {
    el.innerHTML = `<div class="lesson-wrap">${top}<div class="card building lesson-card"><div style="font-size:2.4rem">🔎</div><h2 style="margin:6px 0">Going deeper: ${esc(c.title)}</h2>
      <div class="spinner lg" style="margin:14px auto"></div><p class="muted" style="margin:0">Working out the mechanism, walking through the slide pictures, and writing harder questions…</p>
      <p class="small muted">Usually 20–45 seconds. It’s saved for next time.</p></div></div>`;
    if (UI.deepErr?.[key] && !UI.deepBusy?.[key]) {
      el.innerHTML = `<div class="lesson-wrap">${top}<div class="card lesson-card"><div style="font-size:2rem">⚠️</div><h2 style="margin:4px 0">Couldn’t go deeper right now</h2>
        <p class="muted" style="margin:0">${esc(UI.deepErr[key])}</p><div class="row"><button class="btn primary" data-act="deep-retry" data-i="${i}">Try again</button><a class="btn" href="#/nb/${nb.id}/lessons/${i}">Back to the lesson</a></div></div></div>`;
      return;
    }
    if (!UI.deepBusy?.[key]) buildDeep(nb, i).then(() => { if (onDeep(nb, i)) render(); });
    return;
  }
  const d = D.data; UI.shots = UI.shots || {};
  const shots = cardShots(nb, c, 3);
  const qs = d.questions || []; const done = Object.keys(D.answers).length; const right = qs.filter((q, k) => (D.answers[k]?.ok ?? 0) >= 1).length;
  el.innerHTML = `<div class="lesson-wrap deep">
    ${top}
    <div class="card lesson-card">
      <div class="lesson-kicker">🔎 Deep dive${D.count > 1 ? ` #${D.count}` : ''}</div><h2>${esc(c.title)}</h2>
      <div class="lesson-text">${md(d.overview)}</div>
      <div class="small muted">Unmarked = from your notes. ${BEYOND} = extra detail from general A&amp;P knowledge, so double-check it against your professor’s slides.</div>
      <div class="deep-toc">${[['dl', '🧩 How it really works'], d.pictures?.length ? ['dp', '🖼️ Picture walk-through'] : null, ['dm', '⚠️ Common mistakes'], ['dq', `🎯 Harder questions (${done}/${qs.length})`]].filter(Boolean).map(([id, l]) => `<a href="#" data-act="deep-jump" data-to="${id}">${l}</a>`).join('')}</div>
    </div>

    <section class="card lesson-card" id="dl"><div class="lesson-kicker">Part 1</div><h2>🧩 How it really works</h2>
      ${(d.layers || []).map((x, k) => `<div class="deep-layer"><div class="deep-n">${k + 1}</div><div class="deep-body">
        <h3>${esc(x.title)} ${x.beyond ? BEYOND : ''}</h3>
        ${x.plain ? `<div class="lesson-plain"><span>🗣️ In plain words</span>${esc(x.plain)}</div>` : ''}
        <div class="lesson-text">${md(x.explain)}</div></div></div>`).join('')}
      ${(d.connections || []).length ? `<div class="lesson-box plain"><b>🔗 How it connects</b><ul>${d.connections.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    </section>

    ${d.pictures?.length ? `<section class="card lesson-card" id="dp"><div class="lesson-kicker">Part 2</div><h2>🖼️ Picture walk-through</h2>
      <p class="small muted" style="margin:0">Look at each part in order. Tap a picture to zoom in.</p>
      ${d.pictures.map((p) => { const sh = shots[p.image - 1]; return `<div class="deep-pic">
        ${sh ? shotStrip(`deep${i}_${p.image}`, [sh]) : ''}
        <div><h3>${esc(p.title)}</h3><ol class="deep-walk">${p.walkthrough.map((w) => `<li><b>${esc(w.part)}</b><span>${esc(w.explain)}</span></li>`).join('')}</ol></div></div>`; }).join('')}
    </section>` : ''}

    <section class="card lesson-card" id="dm"><div class="lesson-kicker">Part ${d.pictures?.length ? 3 : 2}</div><h2>⚠️ Common mistakes</h2>
      ${(d.mistakes || []).map((m) => `<div class="deep-mistake">
        <div class="dm-wrong">❌ <span>${esc(m.mistake)}</span> ${m.beyond ? BEYOND : ''}</div>
        <div class="dm-right">✅ <span>${esc(m.truth)}</span></div>
        ${m.tip ? `<div class="dm-tip">💡 ${esc(m.tip)}</div>` : ''}</div>`).join('')}
    </section>

    <section class="card lesson-card" id="dq"><div class="lesson-kicker">Part ${d.pictures?.length ? 4 : 3}</div><h2>🎯 Harder questions</h2>
      <p class="small muted" style="margin:0">Exam-style: application and patient scenarios. No peeking.${done ? ` ${right}/${done} right so far.` : ''}</p>
      ${qs.map((q, k) => deepQHTML(nb, i, D, q, k)).join('')}
      ${done === qs.length && qs.length ? `<div class="lesson-box ex"><b>Done: ${right} of ${qs.length} right.</b><div class="small">${right === qs.length ? 'You really know this section. 🎉' : `The ${qs.length - right} you missed ${D.toRecall ? 'were added to Recall, so they come back tomorrow.' : 'are being added to Recall…'}`}</div></div>` : ''}
    </section>

    <div class="lesson-nav"><a class="btn ghost" href="#/nb/${nb.id}/lessons/${i}">‹ Back to the lesson</a><button class="btn" data-act="deep-again" data-i="${i}">↻ Go even deeper</button></div>
  </div>`;
}
function deepQHTML(nb, i, D, q, k) {
  const a = D.answers[k]; const grading = UI.deepGrading === `${nb.id}:${i}:${k}`;
  let body;
  if (q.type === 'mcq') {
    body = `<div class="lesson-opts">${q.options.map((o, n) => { const cls = a ? (o === q.answer ? 'right' : a.pick === n ? 'wrong' : 'dim') : '';
      return `<button class="opt ${cls}" data-act="deep-mcq" data-q="${k}" data-o="${n}" ${a ? 'disabled' : ''}><span class="opt-l">${'ABCD'[n] || n + 1}</span><span>${esc(o)}</span></button>`; }).join('')}</div>`;
  } else if (a) {
    body = `<div class="lesson-mine"><span class="small muted">Your answer</span><div>${esc(a.text)}</div></div>`;
  } else {
    body = `<textarea data-dq="${k}" rows="3" placeholder="Explain the cause → effect chain…" ${grading ? 'disabled' : ''}>${esc(UI.deepDraft?.[`${nb.id}:${i}:${k}`] || '')}</textarea>
      <div class="row"><button class="btn primary sm" data-act="deep-short" data-q="${k}" ${grading ? 'disabled' : ''}>${grading ? '<span class="spinner"></span> Checking…' : 'Check my answer'}</button></div>`;
  }
  const v = a?.verdict; const head = { correct: '✓ Correct', partial: '◐ Partly right', incorrect: '✗ Not quite' }[v] || '';
  return `<div class="test-q deep-q"><div class="test-qh"><span class="test-n">${k + 1}</span><b>${esc(q.question)} ${q.beyond ? BEYOND : ''}</b></div>${body}
    ${a ? `<div class="verdict ${v}"><h3>${head}</h3>${a.feedback ? `<div class="small">${esc(a.feedback)}</div>` : ''}
      ${q.type === 'short' ? `<div class="small" style="margin-top:6px"><b>Answer:</b> ${esc(q.answer)}</div>` : ''}
      ${q.explanation ? `<div class="small" style="margin-top:6px">${esc(q.explanation)}</div>` : ''}
      ${q.type === 'short' && v !== 'correct' ? `<div class="row" style="margin-top:8px"><button class="btn sm ghost" data-act="deep-override" data-q="${k}">✋ I was right, count it</button></div>` : a.overridden ? '<div class="small muted" style="margin-top:6px">✋ You marked this correct.</div>' : ''}</div>` : ''}</div>`;
}
ACT['deep-override'] = async (el) => {
  const nb = curNb(); const i = +route().arg; const D = deepOf(nb, i); const k = +el.dataset.q; const a = D?.answers[k]; if (!a || a.verdict === 'correct') return;
  Object.assign(a, { verdict: 'correct', ok: 1, overridden: true, feedback: '' });
  nb.cards = nb.cards.filter((c) => !(c.from === 'deep' && norm(c.question) === norm(D.data.questions[k].question))); // not a miss after all
  await save(nb); deepRedraw(nb, i); toast('Counted as correct ✓');
};
function deepRedraw(nb, i) { const y = window.scrollY; renderDeep(nb, $('#tab'), i); window.scrollTo(0, y); }
document.addEventListener('input', (e) => { const k = e.target.dataset?.dq; if (k !== undefined) (UI.deepDraft ||= {})[`${route().id}:${route().arg}:${k}`] = e.target.value; });
ACT['deep-jump'] = (el) => { const t = document.getElementById(el.dataset.to); if (t) window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 130, behavior: 'smooth' }); };
async function deepAnswered(nb, i, D) {
  const qs = D.data.questions || [];
  if (Object.keys(D.answers).length < qs.length || D.toRecall) return;
  D.toRecall = true;
  // missed questions come back in Recall tomorrow (multiple choice rewritten as open questions)
  const missed = qs.map((q, k) => ({ q, a: D.answers[k] })).filter((x) => (x.a?.ok ?? 0) < 1);
  if (missed.length) {
    const have = new Set(nb.cards.map((c) => norm(c.question)));
    const items = missed.filter((x) => !have.has(norm(x.q.question)));
    const mcqs = items.filter((x) => x.q.type === 'mcq'); let open = null;
    if (mcqs.length && S.status.claude) { try { const r = await ai('open_questions', { items: mcqs.map((x) => ({ question: x.q.question, options: x.q.options, answer: x.q.answer })) }); if (r.items?.length === mcqs.length) open = r.items; } catch { /* keep wording */ } }
    let m = 0;
    for (const x of items) {
      let question = x.q.question, answer = x.q.answer;
      if (x.q.type === 'mcq') { const o = open?.[m++]; if (o?.question) { question = o.question; answer = o.answer || answer; } else question = `${question}\n\nChoices: ${x.q.options.join(' · ')}`; }
      nb.cards.push({ id: uid(), question, answer, concept_id: itemConcept(nb, i, x.q), kind: 'apply', from: 'deep', srs: { ...newSrs(), due: Date.now() + 86400e3 }, history: [] });
    }
    toast(`🧠 ${items.length} missed question${items.length > 1 ? 's' : ''} added to Recall for tomorrow`);
  }
  await save(nb);
}
ACT['deep-mcq'] = async (el) => {
  const nb = curNb(); const i = +route().arg; const D = deepOf(nb, i); const k = +el.dataset.q; if (!D || D.answers[k]) return;
  const q = D.data.questions[k]; const pick = +el.dataset.o; const ok = q.options[pick] === q.answer;
  D.answers[k] = { pick, ok: ok ? 1 : 0, verdict: ok ? 'correct' : 'incorrect', feedback: ok ? '' : `The answer is: ${q.answer}` };
  record(nb, itemConcept(nb, i, q), ok ? 1 : 0); await save(nb); if (onDeep(nb, i)) deepRedraw(nb, i);
  if (ok) gainXP(3, 'deep-dive question');
  await deepAnswered(nb, i, D); if (onDeep(nb, i)) deepRedraw(nb, i);
};
ACT['deep-short'] = async (el) => {
  const nb = curNb(); const i = +route().arg; const D = deepOf(nb, i); const k = +el.dataset.q; if (!D || D.answers[k]) return;
  const q = D.data.questions[k]; const text = (document.querySelector(`[data-dq="${k}"]`)?.value || '').trim();
  if (wordCount(text) < 3) { toast('Write your answer first: a sentence or two.'); return; }
  UI.deepGrading = `${nb.id}:${i}:${k}`; if (onDeep(nb, i)) deepRedraw(nb, i);
  let r = quickGrade(text, q.answer);
  if (!r && S.status.claude) { try { r = await ai('grade', { concept: nb.digest.cards[i].title, question: q.question, answer: q.answer, response: text }); } catch (e) { aiError(e); } }
  if (!r?.verdict) { const cv = coverage(text, q.answer); r = { verdict: cv >= 0.6 ? 'correct' : cv >= 0.3 ? 'partial' : 'incorrect', feedback: 'Compare with the answer below.' }; }
  const ok = r.verdict === 'correct' ? 1 : r.verdict === 'partial' ? 0.5 : 0;
  D.answers[k] = { text, ok, verdict: r.verdict, feedback: r.feedback || '' }; UI.deepGrading = null;
  record(nb, itemConcept(nb, i, q), ok); await save(nb); if (onDeep(nb, i)) deepRedraw(nb, i);
  if (ok) gainXP(ok >= 1 ? 4 : 2, 'deep-dive question');
  await deepAnswered(nb, i, D); if (onDeep(nb, i)) deepRedraw(nb, i);
};
ACT['deep-retry'] = (el) => { const nb = curNb(); delete UI.deepErr?.[`${nb.id}:${el.dataset.i}`]; render(); };
ACT['deep-again'] = async (el) => {
  const nb = curNb(); const i = +el.dataset.i; const D = deepOf(nb, i); if (!D) return;
  if (!confirm('Make a new deep dive with fresh angles and new questions? This one will be replaced.')) return;
  D.asked = [...(D.asked || []), ...(D.data.questions || []).map((q) => q.question)].slice(-40);
  delete UI.deepErr?.[`${nb.id}:${i}`];
  const p = buildDeep(nb, i); render(); window.scrollTo(0, 0); // the old deep dive stays saved until the new one succeeds
  await p; if (UI.deepErr?.[`${nb.id}:${i}`]) { toast(`Couldn’t make a new deep dive (${UI.deepErr[`${nb.id}:${i}`]}). Kept your current one.`, 'err'); delete UI.deepErr[`${nb.id}:${i}`]; }
  if (onDeep(nb, i)) render();
};

// Moving between steps re-draws only the lesson and keeps it in view.
function lessonShow(nb, i, { top: toTop = false } = {}) {
  const el = $('#tab'); if (!el) return;
  const view = $('#view');
  if (!toTop && view) return steady(view, () => { renderLesson(nb, el, i); restoreDrafts(); });
  UI.anchorStop?.(); clearTimeout(UI.holdT); if (view) view.style.minHeight = '';
  renderLesson(nb, el, i);
  const top = $('.lesson-top'); if (top && top.getBoundingClientRect().top < 64) window.scrollTo({ top: Math.max(0, window.scrollY + top.getBoundingClientRect().top - 130), behavior: 'smooth' });
}
async function lessonMove(delta) {
  const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); if (!L) return;
  const st = lessonStages(L.data);
  L.pos = Math.max(0, Math.min(st.length - 1, (L.pos || 0) + delta));
  UI.lessonDir = delta > 0 ? 'in' : 'back'; UI.lessonAsk = null;
  if (st[L.pos].k === 'done' && (!L.done || L.retaking)) {
    const sc = testScore(L);
    if (!sc || sc.answered < sc.total || sc.para === null) { L.pos = st.findIndex((x) => x.k === 'test'); toast('Finish the section test to complete this section.'); save(nb); lessonShow(nb, i, { top: true }); return; }
    const retake = !!L.retaking; L.done = true; L.retaking = false; if (retake) L.retakes = (L.retakes || 0) + 1; nb.progress.learn = true;
    save(nb); lessonShow(nb, i, { top: true }); confetti(); await gainXP(retake ? 5 : 15, retake ? 'section retaken' : 'section learned');
    const added = await lessonToRecall(nb, i, L); await save(nb);
    if (added) setTimeout(() => toast(`🧠 ${added} question${added > 1 ? 's' : ''} added to Recall, so they come back for spaced review`), 1200);
    return;
  }
  save(nb); lessonShow(nb, i, { top: true });
}
// Spacing: what you missed comes back in Recall tomorrow (today if you were sure but wrong); two test questions you
// got right come back in 3 days, so the whole section gets re-quizzed later.
async function lessonToRecall(nb, i, L) {
  const day = 86400e3; const items = [];
  (L.data.steps || []).forEach((s, j) => { const ch = s.check; if (!ch?.question) return; const r = L.checks?.[j]; const first = r ? (r.first ?? r.ok) : 0; items.push({ q: ch.question, a: ch.answer, miss: first < 1, sure: r?.conf === 'sure', item: ch }); });
  (L.test?.mcq || []).forEach((q, k) => items.push({ q: q.question, a: q.answer, miss: L.test.answers[k] !== q.answer, test: true, item: q }));
  const have = new Set(nb.cards.flatMap((c) => [norm(c.question), c.srcQ].filter(Boolean))); let keep = 2;
  const chosen = [];
  for (const it of items) {
    if (have.has(norm(it.q))) continue;
    if (it.miss) it.due = Date.now() + (it.sure ? 0 : day);
    else if (it.test && keep > 0) { keep--; it.due = Date.now() + 3 * day; }
    else continue;
    chosen.push(it); have.add(norm(it.q));
  }
  // Recall shows no answer choices, so multiple-choice questions are rewritten as open questions
  const mcqs = chosen.filter((it) => (it.item?.options || []).length > 1);
  if (mcqs.length) {
    let open = null;
    try { if (S.status.claude) { const r = await ai('open_questions', { items: mcqs.map((it) => ({ question: it.q, options: it.item.options, answer: it.a })) }); if (r.items?.length === mcqs.length) open = r.items; } }
    catch { /* keep the fallback below */ }
    mcqs.forEach((it, k) => {
      if (open?.[k]?.question) { it.q = open[k].question; it.a = open[k].answer || it.a; }
      else it.q = `${it.q}\n\nChoices: ${it.item.options.join(' · ')}`;
    });
  }
  for (const it of chosen) nb.cards.push({ id: uid(), question: it.q, answer: it.a, srcQ: norm(it.item?.question || it.q), concept_id: itemConcept(nb, i, it.item), kind: 'explain', from: 'lesson', srs: { ...newSrs(), due: it.due }, history: [] });
  return chosen.length;
}
ACT['lesson-retake'] = async (el) => {
  const nb = curNb(); const i = +el.dataset.i; const L = lessonOf(nb, i);
  if (!L?.data) return ACT['lesson-open'](el);
  // remember the old test so the new one avoids it; reset the lesson to the start
  const old = (L.test?.mcq || []).map((q) => ({ q: q.question, a: q.answer }));
  L.pastTests = [...(L.pastTests || []), ...old].slice(-40);
  for (const p of testFRs(L.test)) if (p?.prompt) L.pastTests.push({ q: p.prompt, a: '' });
  L.test = null; L.checks = {}; L.pos = 0; L.retaking = true;
  delete UI.cardRecall[`${nb.id}:${i}`]; UI.paperRecall = null;
  for (const m of [UI.lessonConf, UI.lessonPick, UI.lessonTyped]) Object.keys(m || {}).filter((k) => k.startsWith(`${nb.id}:${i}:`)).forEach((k) => delete m[k]);
  if (UI.teachBackDraft) UI.teachBackDraft = '';
  await save(nb);
  if (route().tab === 'lessons' && route().arg !== '' && +route().arg === i) { UI.lessonDir = 'in'; lessonShow(nb, i, { top: true }); toast('Retake started: same lesson, brand-new test'); }
  else { ACT['lesson-open'](el); setTimeout(() => toast('Retake started: same lesson, brand-new test'), 700); }
};
ACT['lesson-next'] = () => lessonMove(1);
ACT['lesson-back'] = () => {
  const nb = curNb(); const L = lessonOf(nb, +route().arg); if (!L) return;
  const st = lessonStages(L.data); const s = st[L.pos];
  // from a check's "Review the step", go back to that step itself
  lessonMove(s?.k === 'check' ? -1 : -1);
};
ACT['lesson-guess'] = (el) => { const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); const s = lessonStages(L.data)[L.pos]; UI.lessonAsk = null; UI.lessonGuess = { key: `${nb.id}:${i}:${s.j}`, mode: el.dataset.mode }; lessonShow(nb, i); setTimeout(() => $('#lessonGuessIn')?.focus(), 30); };
ACT['lesson-ask'] = () => { const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); const s = lessonStages(L.data)[L.pos]; UI.lessonAsk = `${nb.id}:${i}:${s.j}`; lessonShow(nb, i); setTimeout(() => $('#lessonQ')?.focus(), 30); };
ACT['lesson-ask-cancel'] = () => { UI.lessonAsk = null; lessonShow(curNb(), +route().arg); };
ACT['lesson-help'] = async (el) => {
  const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); const s = lessonStages(L.data)[L.pos]; if (s.k !== 'step') return;
  const mode = el.dataset.mode; const q = mode === 'question' ? ($('#lessonQ')?.value || '').trim() : '';
  const guess = mode !== 'question' && !el.dataset.skip ? ($('#lessonGuessIn')?.value || '').trim() : '';
  UI.lessonGuess = null;
  if (mode === 'question' && !q) { toast('Type your question first'); $('#lessonQ')?.focus(); return; }
  if (!S.status.claude) { toast('The help buttons need the AI tutor. See Settings.', 'err'); return openSettings(); }
  const x = L.data.steps[s.j]; const tag = `${nb.id}:${i}:${s.j}`;
  UI.lessonHelpBusy = tag; UI.lessonAsk = null; lessonShow(nb, i);
  try {
    const r = await ai('lesson_help', { sources: aiSources(nb), title: nb.digest.cards[i].title, step_title: x.title, explain: x.explain, example: x.example, mode, question: q, guess, earlier: (L.help[s.j] || []).slice(-3) });
    const ans = String(r.answer || '').replace(/([.:!?])\s+[*•-]\s+/g, '$1\n- '); // bullets that came out on one line
    (L.help[s.j] ||= []).push({ mode, q, guess, a: ans }); await save(nb);
  } catch (e) { aiError(e); }
  UI.lessonHelpBusy = null;
  if (onLesson(nb, i)) {
    lessonShow(nb, i);
    const boxes = document.querySelectorAll('#lessonStage .lesson-box.help'); boxes[boxes.length - 1]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
};
// Which concept a question tests: the id the AI gave it, else the closest concept by wording (not its position).
function itemConcept(nb, i, item) {
  const all = nb.digest.concepts || []; if (item?.concept_id && all.some((c) => c.id === item.concept_id)) return item.concept_id;
  const ids = nb.digest.cards[i]?.concept_ids || [];
  const pool = item?.review || !ids.length ? all : ids.map((id) => all.find((c) => c.id === id)).filter(Boolean);
  let best = null, bs = -1;
  for (const c of pool) { const sc = coverage(`${item?.question || ''} ${item?.answer || ''}`, `${c.name} ${c.definition}`); if (sc > bs) { bs = sc; best = c; } }
  return best?.id || ids[0];
}
function lessonRecord(nb, i, item, ok) { const cid = itemConcept(nb, i, item); if (cid) record(nb, cid, ok); }
document.addEventListener('input', (e) => { // remember a half-typed answer through any redraw
  if (e.target.id !== 'lessonA') return; const nb = curNb(); const i = +route().arg; const L = nb && lessonOf(nb, i); if (!L) return;
  const s = lessonStages(L.data)[L.pos]; (UI.lessonTyped ||= {})[`${nb.id}:${i}:${s.j}`] = e.target.value;
});
ACT['lesson-pick'] = (el) => {
  const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); const s = lessonStages(L.data)[L.pos];
  if (s.k !== 'check' || checkFinal(L.checks[s.j]) || el.disabled) return;
  const k = +el.dataset.o; (UI.lessonPick ||= {})[`${nb.id}:${i}:${s.j}`] = k;
  document.querySelectorAll('#lessonStage [data-act="lesson-pick"]').forEach((b) => { const on = +b.dataset.o === k; b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on); });
  const c = $('#lessonStage [data-act="lesson-mcq-check"]'); if (c) c.disabled = false;
};
ACT['lesson-mcq-check'] = (el) => {
  const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); const s = lessonStages(L.data)[L.pos];
  const k = UI.lessonPick?.[`${nb.id}:${i}:${s.j}`]; if (k === undefined) return toast('Pick an answer first');
  delete UI.lessonPick[`${nb.id}:${i}:${s.j}`];
  return ACT['lesson-mcq']({ dataset: { o: k } });
};
ACT['lesson-mcq'] = async (el) => {
  const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); const s = lessonStages(L.data)[L.pos];
  const prev = L.checks[s.j]; if (s.k !== 'check' || checkFinal(prev)) return;
  const ch = L.data.steps[s.j].check; const k = +el.dataset.o; if ((prev?.wrong || []).includes(k)) return;
  const ok = ch.options[k] === ch.answer;
  const conf = prev?.conf ?? (UI.lessonConf?.[`${nb.id}:${i}:${s.j}`] || '');
  L.checks[s.j] = { pick: k, wrong: ok ? prev?.wrong || [] : [...(prev?.wrong || []), k], ok: ok ? 1 : 0, verdict: ok ? 'correct' : 'incorrect', feedback: '', conf, tries: (prev?.tries || 0) + 1, first: prev ? prev.first : (ok ? 1 : 0) };
  if (!prev) lessonRecord(nb, i, ch, ok ? 1 : 0);
  await save(nb); lessonShow(nb, i);
  if (ok) gainXP(L.retaking ? 1 : prev ? 2 : 4, prev ? 'got it on the retry' : 'quick check');
};
ACT['lesson-conf'] = (el) => {
  const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); const s = lessonStages(L.data)[L.pos];
  (UI.lessonConf ||= {})[`${nb.id}:${i}:${s.j}`] = el.dataset.c;
  el.closest('.conf-row')?.querySelectorAll('[data-act="lesson-conf"]').forEach((b) => b.classList.toggle('on', b === el)); // no redraw: keeps what you typed
};
// When the grader is too strict: the student can count their answer as correct (no XP for it, but it stops it
// counting as a miss, so it isn't scheduled as a mistake).
ACT['lesson-override'] = async () => {
  const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); const s = lessonStages(L.data)[L.pos]; const r = L.checks[s.j];
  if (s.k !== 'check' || !r?.verdict || r.verdict === 'correct') return;
  const firstTry = (r.tries || 1) === 1;
  if (firstTry) { const cid = itemConcept(nb, i, L.data.steps[s.j].check); const st = nb.conceptStats[cid]; if (st) st.right = Math.min(st.attempts, st.right + (1 - (r.ok || 0))); r.first = 1; }
  Object.assign(r, { verdict: 'correct', ok: 1, overridden: true, feedback: '' });
  await save(nb); lessonShow(nb, i); toast('Counted as correct ✓');
};
ACT['lesson-reveal'] = async () => {
  const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); const s = lessonStages(L.data)[L.pos]; const r = L.checks[s.j];
  if (s.k !== 'check' || !r?.verdict) return;
  r.revealed = true; await save(nb); lessonShow(nb, i);
};
ACT['lesson-short'] = async () => {
  const nb = curNb(); const i = +route().arg; const L = lessonOf(nb, i); const s = lessonStages(L.data)[L.pos];
  const prev = L.checks[s.j]; if (s.k !== 'check' || checkFinal(prev)) return;
  const ch = L.data.steps[s.j].check; const text = ($('#lessonA')?.value || '').trim();
  if (!text) { toast('Write an answer first, even a guess. Guessing helps you remember.'); $('#lessonA')?.focus(); return; }
  let r = quickGrade(text, ch.answer);
  if (!r && S.status.claude) {
    UI.lessonGrading = `${nb.id}:${i}:${s.j}`; UI.lessonDraft = text; lessonShow(nb, i);
    try { r = await ai('grade', { concept: nb.digest.cards[i].title, question: ch.question, answer: ch.answer, response: text }); }
    catch (e) { aiError(e); r = null; }
    UI.lessonGrading = null;
  }
  if (!r || !r.verdict) { const cv = coverage(text, ch.answer); r = { verdict: cv >= 0.6 ? 'correct' : cv >= 0.3 ? 'partial' : 'incorrect', feedback: 'Compare your answer with the key answer below.' }; }
  const ok = r.verdict === 'correct' ? 1 : r.verdict === 'partial' ? 0.5 : 0;
  const conf = prev?.conf ?? (UI.lessonConf?.[`${nb.id}:${i}:${s.j}`] || '');
  if (UI.lessonTyped) delete UI.lessonTyped[`${nb.id}:${i}:${s.j}`];
  L.checks[s.j] = { text, ok, verdict: r.verdict, feedback: r.feedback || '', conf, tries: (prev?.tries || 0) + 1, first: prev ? prev.first : ok };
  if (!prev) lessonRecord(nb, i, ch, ok);
  await save(nb);
  if (onLesson(nb, i)) lessonShow(nb, i);
  if (ok) gainXP(L.retaking ? 1 : prev ? 2 : ok >= 1 ? 5 : 2, prev ? 'got it on the retry' : 'quick check');
};
document.addEventListener('keydown', (e) => {
  if (route().tab !== 'lessons' || !$('#lessonStage') || !$('#modal').classList.contains('hidden') || document.getElementById('pomoScreen')) return;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    if (e.target.id === 'lessonA') { e.preventDefault(); ACT['lesson-short'](); }
    if (e.target.id === 'lessonQ') { e.preventDefault(); $('#lessonStage [data-mode="question"]')?.click(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const opt = { a: 0, b: 1, c: 2, d: 3, 1: 0, 2: 1, 3: 2, 4: 3 }[e.key.toLowerCase()];
  if (opt !== undefined) { const b = document.querySelectorAll('#lessonStage [data-act="lesson-pick"]')[opt]; if (b && !b.disabled) { e.preventDefault(); b.click(); } return; }
  if (e.key === 'Enter') { const c = $('#lessonStage [data-act="lesson-mcq-check"]'); if (c && !c.disabled) { e.preventDefault(); c.click(); return; } }
  if (e.key === 'ArrowRight') { const n = $('.lesson-nav [data-act="lesson-next"]'); if (n) { e.preventDefault(); n.click(); } }
  if (e.key === 'ArrowLeft') { const b = $('.lesson-nav [data-act="lesson-back"]'); if (b) { e.preventDefault(); b.click(); } }
});

function renderLearn(nb, el) {
  const d = nb.digest;
  const mode = UI.cardMode || 'recall'; // recalling first beats rereading; "Study" is one tap away
  UI.cardRecall ||= {};
  UI.shots = {};
  loadVisuals(nb).then((changed) => { if (changed && route().tab === 'learn') render(); });
  const noPics = nb.sources.filter((s) => ['pdf', 'pptx'].includes(s.kind) && s.images === undefined && !/\(sample\)/.test(s.name));
  el.innerHTML = `
  <div class="stack">
    <div class="card overview"><h2>${esc(d.title)}</h2><p style="margin:0">${esc(d.overview)}</p></div>
    ${noPics.length ? `<div class="card flat tight row" style="background:var(--warn-soft);border-color:transparent">🖼️ <span class="spacer small">This notebook was made before Etch kept slide pictures. Drop <b>${noPics.map((s) => esc(s.name)).join(', ')}</b> on the Sources tab again to add them. Your study kit and progress stay the same.</span><a class="btn sm" href="#/nb/${nb.id}/sources">Go to Sources</a></div>` : ''}

    <div class="row between section"><div><h2>🃏 Visual summary cards</h2><div class="small muted">Write what you remember first, then reveal it. Tap Study to just read.</div></div>
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
  const head = `<div class="row between"><span class="emoji">${esc(c.emoji)}</span><span class="ref">${esc(refLabel(nb, c.source_ref))}</span></div>${cardPictures(nb, c, i)}<h3 style="margin:0">${esc(c.title)}</h3>`;
  if (mode === 'study') {
    return `<div class="card scard">${head}<ul>${c.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      ${c.analogy ? `<div class="analogy">🔗 ${esc(c.analogy)}</div>` : ''}
      <a class="btn sm ghost deep-link" href="#/nb/${nb.id}/deep/${i}">🔎 Go deeper</a></div>`;
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
  const hasSlides = nb.sources.some((s) => ['pdf', 'pptx', 'image'].includes(s.kind) || s.images);
  return hasSlides ? `<button class="shot-empty" data-act="card-draw" data-i="${i}">🎨 No slide picture for this card. Draw a diagram</button>` : '';
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
    nb.illustrations[key] = r; await save(nb);
  } catch (e) { aiError(e); }
  delete UI.illBusy[key]; render();
};
ACT['card-mode'] = (el) => { UI.cardMode = el.dataset.m; render(); };
ACT['card-reveal'] = async (el) => {
  const nb = curNb(); const i = +el.dataset.i; const c = nb.digest.cards[i];
  const text = $(`[data-cr="${i}"]`).value; clearDraft($(`[data-cr="${i}"]`));
  let hits = null;
  if (wordCount(text) >= 3 && S.status.claude) {
    el.disabled = true; el.innerHTML = '<span class="spinner"></span> Checking…';
    try { const r = await ai('recall_check', { points: c.points, response: text }); if (Array.isArray(r.hits) && r.hits.length === c.points.length) hits = r.hits.map((h) => !!h.got); }
    catch { /* fall back to word matching */ }
  }
  if (!hits) hits = c.points.map((p) => coverage(text, p) >= 0.6);
  UI.cardRecall[`${nb.id}:${i}`] = { revealed: true, text, hits };
  const ratio = hits.filter(Boolean).length / c.points.length;
  const rk = `${nb.id}:${i}:${dayKey()}`; if (!(UI.recordedRecall ||= new Set()).has(rk)) { UI.recordedRecall.add(rk); (c.concept_ids || []).forEach((cid) => record(nb, cid, ratio)); }
  const xp = xpGain(nb, `recall:${i}`, 2 + 3 * hits.filter(Boolean).length);
  await save(nb);
  if (xp) await gainXP(xp, 'card recall');
  render();
};
ACT['card-retry'] = (el) => { const nb = curNb(); UI.cardRecall[`${nb.id}:${el.dataset.i}`] = { revealed: false, text: '' }; render(); };

function conceptCard(nb, c) {
  const m = mastery(nb, c.id);
  const ills = ['diagram', 'mnemonic'].map((s) => ({ s, v: nb.illustrations[`${c.id}:${s}`] })).filter((x) => x.v);
  const busy = UI.illBusy || {};
  return `<div class="card concept" id="concept-${c.id}">
    <div class="row between"><h3 style="margin:0">${esc(c.name)}</h3><div class="row">${m !== null ? `<span class="tag ${m >= .7 ? 'good' : m >= .4 ? 'warn' : 'bad'}">${pct(m)}%</span>` : ''}${refLabel(nb, c.source_ref) ? `<span class="tag">${esc(refLabel(nb, c.source_ref))}</span>` : ''}</div></div>
    <div>${esc(c.definition)}</div>
    <div class="small muted">Why it matters: ${esc(c.why_it_matters)}</div>
    ${c.mnemonic ? `<div class="mnemo">🤪 <b>Mnemonic:</b> ${esc(c.mnemonic)}</div>` : ''}
    ${(() => { const pk = refShots(nb, c.image_refs); const sh = pk.length ? pk : visualsFor(nb, c.source_ref, 4); return sh.length ? shotStrip(`concept-${c.id}`, sh) : ''; })()}
    ${ills.length ? `<div class="ill">${ills.map(({ s, v }) => `<figure data-act="zoom-ill" data-key="${c.id}:${s}"><img alt="${esc(c.name)} ${s}" src="${illSrc(v)}"><figcaption>${s === 'mnemonic' ? '🤪 ' : '🎨 '}${esc(v.caption || '')}</figcaption></figure>`).join('')}</div>` : ''}
    <div class="row concept-acts">
      ${['diagram', 'mnemonic'].map((s) => busy[`${c.id}:${s}`] ? `<button class="btn sm" disabled><span class="spinner"></span> Drawing…</button>`
        : `<button class="btn sm" data-act="illustrate" data-cid="${c.id}" data-style="${s}">${s === 'diagram' ? '🎨' : '🤪'} ${nb.illustrations[`${c.id}:${s}`] ? 'Redraw' : s === 'diagram' ? 'Diagram' : 'Mnemonic'}</button>`).join('')}
      <button class="btn sm" data-act="vid-concept" data-cid="${c.id}">🎬 Video</button>
      <a class="btn sm ghost" href="#/nb/${nb.id}/recall/${c.id}">🧠 Quiz me</a>
    </div></div>`;
}
const illSrc = (v) => (v.kind === 'svg' ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(v.svg || '') : /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(String(v.src || '')) ? v.src : '');
ACT.illustrate = async (el) => {
  const nb = curNb(); const c = nb.digest.concepts.find((x) => x.id === el.dataset.cid); const style = el.dataset.style; const key = `${c.id}:${style}`;
  if (!S.status.claude && !S.status.gemini) { toast('Illustrations need the AI tutor — see Settings', 'err'); return openSettings(); }
  (UI.illBusy ||= {})[key] = true; render();
  try {
    const r = await api('/api/illustrate', { ...c, style, sources: style === 'diagram' ? aiSources(nb) : [] });
    if (r.kind === 'svg' && !r.svg) throw new Error('The drawing came back empty. Try again.');
    nb.illustrations[key] = r; await save(nb);
    if (r.note) toast(r.note);
  } catch (e) { aiError(e); }
  delete UI.illBusy[key]; render();
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
  const key = `${nb.id}:${nb.builtAt || 0}`;
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
    let svg;
    if (UI.mapCache?.code === code) svg = UI.mapCache.svg; // same map: draw it back right away
    else { svg = (await mermaid.render('cmap' + Date.now(), code)).svg; UI.mapCache = { code, svg }; if (!host.isConnected) return drawMap(nb); }
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
    UI.hidden.set.delete(n.id); toast(`✓ ${n.label}`); const mx = xpGain(nb, `map:${n.id}`, 5); if (mx) { await save(nb); await gainXP(mx, 'map'); } drawMap(nb);
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
      <div class="row between"><span class="row" style="gap:6px"><span class="tag accent">${card.kind === 'picture' ? '🖼️ Picture' : esc(CARD_KIND[card.kind] || card.kind)}</span>${R.scope.startsWith('course:') ? `<span class="tag">${esc(nb.title)}</span>` : R.scope.startsWith('nb:') && R.scope.slice(3) !== nb.id ? `<span class="tag mix-tag" title="Mixed in from another notebook">🔀 ${esc(nb.title)}</span>` : ''}</span>
        <span class="small muted">${R.i + 1} / ${R.queue.length}${Object.values(R.requeued || {}).reduce((x, y) => x + y, 0) ? ` (incl. ${Object.values(R.requeued).reduce((x, y) => x + y, 0)} coming back)` : ''} · ${esc(conceptName(nb, card.concept_id))}</span></div>
      ${pic.length ? `<div style="margin-top:10px">${shotStrip('rc', pic)}</div>` : card.image ? (nb.sources.some((s) => s.id === card.image.sid) && !VIS.has(card.image.sid) ? '<div class="shot-empty" style="margin-top:10px"><span class="spinner"></span> Loading picture…</div>' : '<div class="shot-empty" style="margin-top:10px">🖼️ This picture isn’t available any more (its slides were removed). Answer from memory, or skip it.</div>') : ''}
      <div class="q-text">${tx(card.question)}</div>
      ${!res ? `<textarea id="ans" placeholder="Type your answer from memory…${TOUCH ? '' : ' (⌘/Ctrl + Enter to check)'}">${esc(R.draft || '')}</textarea>
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
        <div class="small muted" style="margin-top:14px">${res.verdict ? 'How well did you know it? (suggested from the grading)' : 'How well did you know it?'}</div>
        <div class="anki-row">${BTNS.map((b, k) => { const sug = suggestBtn(R) === b; return `<button class="anki-btn ${b} ${sug ? 'suggest' : ''}" data-act="rc-anki" data-b="${b}" title="Key ${k + 1}"><b>${BTN_LABEL[b]}</b><span>${fmtIvl(ankiNext(card, b).due - Date.now())}</span></button>`; }).join('')}</div>`}
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
  // Pick what matters most first: confident mistakes, then cards you've missed, then the most overdue.
  // Then shuffle the chosen cards so concepts (and lectures) alternate.
  const rank = ({ card }) => {
    const last = card.history[card.history.length - 1];
    if (last && last.v === 'incorrect' && last.c === 'sure') return 0;
    if ((last && last.v !== 'correct') || card.srs.lapses > 0) return 1;
    return 2;
  };
  const picked = [...items].map((x) => ({ x, r: rank(x), due: x.card.srs.due, k: Math.random() }))
    .sort((a, b) => a.r - b.r || a.due - b.due || a.k - b.k).slice(0, limit).map((o) => o.x);
  for (let i = picked.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [picked[i], picked[j]] = [picked[j], picked[i]]; }
  const queue = picked.map(({ nb, card }) => ({ nb: nb.id, card: card.id }));
  UI.recall = { scope, focus, queue, i: 0, result: null, draft: '', conf: null, tally: { correct: 0, partial: 0, incorrect: 0 }, xp: 0, confMistakes: 0, luckyGuesses: 0 };
  render();
  return true;
}
function startRecall(nb, mode, focus, routeFocus) {
  const items = poolFor(nb, mode, focus).map((card) => ({ nb, card }));
  // Interleaving: mix up to 3 due cards from your other notebooks into a normal review (switching topics helps memory)
  let mix = [];
  if (mode === 'due') {
    mix = S.notebooks.filter((n) => n.id !== nb.id && n.digest).flatMap((n) => dueCards(n).map((card) => ({ nb: n, card })))
      .sort(() => Math.random() - 0.5).slice(0, 3);
  }
  return beginSession('nb:' + nb.id, routeFocus, [...items, ...mix], (mode === 'cram' ? 40 : 20) + mix.length);
}
ACT['rc-conf'] = (el) => { UI.recall.conf = UI.recall.conf === el.dataset.c ? null : el.dataset.c; $$('[data-act="rc-conf"]').forEach((b) => b.classList.toggle('on', b.dataset.c === UI.recall.conf)); };
// Clear-cut answers are graded on the spot (saves AI): near-identical to the key, or covering its key words.
function quickGrade(response, answer) {
  const r = norm(response), a = norm(answer); if (!r) return null;
  const ok = { verdict: 'correct', score: 1, feedback: 'Matches the key points ✓ (checked instantly)', missing: [], instant: true };
  if (r === a) return ok;
  // Anything subtle goes to the AI grader: negations, numbers that differ, extra or missing pieces.
  const NEG = /\b(not|no|never|none|without|neither|nor|isn t|aren t|doesn t|don t|can t|won t|cannot)\b/;
  if (NEG.test(r) !== NEG.test(a)) return null;
  const nums = (s) => (String(s || '').match(/\d+(?:\.\d+)?/g) || []);
  const rn = nums(response), an = nums(answer);
  if (rn.length || an.length) { if (an.some((n) => !rn.includes(n)) || rn.some((n) => !an.includes(n))) return null; }
  // Only short, single-fact keys are graded instantly; longer answers carry relationships word-matching can't check.
  const kw = words(answer), rw = words(response);
  if (kw.length > 3 || rw.length > 6) return null;
  // Roman numerals (cranial nerves, "Type I/II") must match exactly
  const roman = (s) => (s.match(/\b[ivx]{1,4}\b/g) || []).filter((x) => /^(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)$/.test(x));
  const rr = roman(r), ar = roman(a); if (rr.length || ar.length) { if (rr.join() !== ar.join()) return null; }
  // exact words only: A&P is full of one-letter pairs (ileum/ilium, afferent/efferent, abduction/adduction),
  // so any spelling difference goes to the AI grader instead of being passed here
  const allKey = kw.every((k) => rw.includes(k));
  const extra = rw.filter((w) => !kw.includes(w)).length;
  return allKey && extra === 0 ? ok : null;
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
ACT['rc-anki'] = (el) => { const R = UI.recall; if (!R?.result) return; R.btn = el.dataset.b; ACT['rc-next'](); };
document.addEventListener('keydown', (e) => { // Anki keys: 1–4 to rate, Space/Enter takes the suggestion
  const R = UI.recall; if (!R?.result || R.advancing || e.target.closest?.('textarea, input, select, button, a') || route().tab !== 'recall') return;
  if (e.metaKey || e.ctrlKey || e.altKey || !$('#modal').classList.contains('hidden') || PM.screen || !$('#tab .anki-row')) return;
  const k = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' }[e.key] || ((e.key === ' ' || e.key === 'Enter') && suggestBtn(R));
  if (k) { e.preventDefault(); R.btn = k; ACT['rc-next'](); }
});
ACT['rc-self'] = (el) => {
  const R = UI.recall; R.result.verdict = el.dataset.v;
  // Stop on a confident mistake so the warning is seen; otherwise move straight on.
  if (R.conf === 'sure' && el.dataset.v === 'incorrect') { R.result.feedback = 'Marked by you.'; return render(); }
  ACT['rc-next']();
};
ACT['rc-override'] = (el) => { UI.recall.result.verdict = el.dataset.v; UI.recall.result.feedback = 'Marked by you.'; UI.recall.result.missing = []; render(); };
ACT['rc-next'] = async () => {
  const R = UI.recall; if (!R || R.advancing || !(R.btn || suggestBtn(R))) return;
  R.advancing = true;
  try { await recallApply(R); } finally { R.advancing = false; }
  render();
};
async function recallApply(R) {
  const { nb, card } = recallItem(R); const btn = R.btn || suggestBtn(R); const v = BTN_V[btn]; const wasDue = (card.srs?.due || 0) <= Date.now();
  schedule(card, btn, R.conf); record(nb, card.concept_id, { again: 0, hard: 0.5, good: R.conf === 'guess' ? 0.6 : 1, easy: 1 }[btn]);
  nb.progress.reviews++; R.tally[v]++;
  if (v === 'incorrect' && R.conf === 'sure') R.confMistakes++;
  if (R.conf === 'sure') { R.sureN = (R.sureN || 0) + 1; if (v === 'correct') R.sureRight = (R.sureRight || 0) + 1; }
  if (v === 'correct' && R.conf === 'guess') R.luckyGuesses++;
  // due again within a few minutes: bring it back a few cards later in this session (at most twice)
  const n = (R.requeued ||= {})[card.id] || 0;
  if (card.srs.due - Date.now() <= 20 * 60e3 && n < 2) { R.requeued[card.id] = n + 1; R.queue.splice(Math.min(R.queue.length, R.i + 1 + (v === 'incorrect' ? 3 : 5)), 0, { nb: nb.id, card: card.id }); }
  const RANKV = { incorrect: 0, partial: 1, correct: 2 }; const graded = R.result?.verdict;
  const vx = graded && RANKV[graded] < RANKV[v] ? graded : v; // pressing Easy after "I don't know" doesn't pay like a right answer
  let xp = (vx === 'correct' ? 10 : vx === 'partial' ? 5 : 2) + (vx === 'correct' && R.conf === 'sure' ? 2 : 0);
  if (!wasDue) xp = Math.min(xp, 2); // extra practice on cards that weren't due yet: still worth doing, small XP
  R.xp += xp;
  await save(nb); await gainXP(xp);
  R.i++; R.result = null; R.draft = ''; R.conf = null; R.btn = null;
}
ACT['rc-quit'] = async () => {
  const R = UI.recall; if (!R || R.advancing) return;
  if (R.result && (R.btn || suggestBtn(R))) { R.advancing = true; try { await recallApply(R); } finally { R.advancing = false; } } // keep the answer that's on screen
  R.queue = R.queue.slice(0, R.i); render();
};
function recallDone(el) {
  const R = UI.recall; const t = R.tally; const total = t.correct + t.partial + t.incorrect;
  if (total >= 3 && t.correct / total >= 0.8 && !R.cheered) { R.cheered = true; setTimeout(confetti, 150); }
  const nbs = [...new Set(R.queue.map((q) => q.nb))].map(getNb).filter(Boolean);
  const next = nbs.flatMap((nb) => nb.cards).filter((c) => c.srs.due > Date.now()).sort((a, b) => a.srs.due - b.srs.due)[0];
  const single = R.scope.startsWith('nb:') ? getNb(R.scope.slice(3)) : null;
  el.innerHTML = `<div class="q-card"><div class="card stack" style="text-align:center">
    <div style="font-size:2.6rem">${total && t.correct / total >= 0.8 ? '🏆' : '💪'}</div><h2>Session complete</h2>
    <div class="row" style="justify-content:center"><span class="tag good">✅ ${t.correct}</span><span class="tag warn">🟡 ${t.partial}</span><span class="tag bad">❌ ${t.incorrect}</span><span class="tag accent">+${R.xp} XP</span></div>
    ${R.confMistakes ? `<p style="color:var(--bad)">⚠️ ${R.confMistakes} confident mistake${R.confMistakes > 1 ? 's' : ''}: things you were sure about but got wrong. They’ll come back first.</p>` : ''}
    ${R.sureN ? `<p class="small">🎯 When you felt <b>sure</b>, you were right <b>${R.sureRight || 0} of ${R.sureN}</b> times${(R.sureRight || 0) / R.sureN >= 0.85 ? '. Your confidence matches what you know.' : '. Be careful: feeling sure isn’t the same as knowing it yet.'}</p>` : ''}
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
  const prompts = nb.digest.feynman_prompts || [];
  if (!prompts.length) { el.innerHTML = '<div class="card empty"><div class="big">🗣️</div><h3>No teach-back prompts yet</h3><p class="muted" style="margin:0">Rebuild the study kit on the Sources tab, or use the “Teach it back” step at the end of each Learn section.</p></div>'; return; }
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
      ${r.nailed?.length ? `<div class="small fb-good"><b>✓ You nailed</b><ul class="list-good">${r.nailed.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${r.gaps?.length ? `<div class="small fb-gap"><b>Work on next</b><ul class="list-gap">${r.gaps.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${r.misconceptions?.length ? `<div class="small fb-bad"><b>Careful</b><ul class="list-bad">${r.misconceptions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
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
    const tx = xpGain(nb, `teach:${UI.teachSel}`, 5 + Math.round(Math.max(0, Math.min(100, r.score || 0)) / 4));
    UI.teachDraft = ''; await save(nb); if (tx) await gainXP(tx, 'teach-back');
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
  record(nb, p.concept_id, v); UI.teachDraft = ''; closeModal(); const xp = xpGain(nb, `teach:${UI.teachSel}`, Math.round(6 * v)); await save(nb); if (xp) await gainXP(xp, 'teach-back'); render();
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
      <button class="btn primary" type="submit" ${S.status.claude && nb.sources.length && !UI.chatBusy ? '' : 'disabled'}>${UI.chatBusy ? 'Thinking…' : 'Send'}</button></form>
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
  const log = $('#chatLog') || document.createElement('div'); const bubble = document.createElement('div'); bubble.className = 'msg assistant'; bubble.innerHTML = '<span class="spinner"></span>'; log.appendChild(bubble); log.scrollTop = log.scrollHeight;
  let out = '';
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources: aiSources(nb), messages: nb.chat.slice(-12) }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); const e = new Error(j.error || 'Chat failed'); e.code = j.code; throw e; }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''; let streamErr = null;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let k; while ((k = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, k).replace(/^data: /, ''); buf = buf.slice(k + 2);
        let ev = null; try { ev = JSON.parse(line); } catch { /* partial */ }
        if (ev?.text) { out += ev.text; bubble.innerHTML = md(out); log.scrollTop = log.scrollHeight; }
        if (ev?.error) streamErr = ev;
      }
    }
    if (streamErr && !out) { const e = new Error(streamErr.error); e.code = streamErr.code; throw e; } // nothing came back: keep your question, offer the fix
    if (streamErr) toast(streamErr.error, 'err');
    if (out) { nb.chat.push({ role: 'assistant', content: out }); }
  } catch (e) { aiError(e); nb.chat.pop(); UI.chatDraft = text; }
  UI.chatBusy = false; await save(nb);
  if (route().tab === 'tutor' && route().id === nb.id) { render(); if (UI.chatDraft) { const i = $('#chatIn'); if (i) { i.value = UI.chatDraft; i.focus(); } UI.chatDraft = ''; } }
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
      <p style="margin:0 0 4px">${S.status.public && !S.status.youtube ? 'YouTube searches matched to each concept, aimed at trusted teaching channels.' : 'Short, trusted explainers matched to this lecture.'} Each one comes with <b>questions to watch for</b>. Read them first, watch, then prove it stuck by quizzing yourself or teaching it back.</p>
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
  return `<div class="card vid ${v.watched ? 'watched' : ''}" data-vid="${esc(v.id)}">
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
  return `<div class="card vid ${v.watched ? 'watched' : ''}" data-vid="${esc(v.id)}">
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
    nb.videos.push(...fresh); await save(nb); if (fresh.length) UI.vidFocus = fresh[0].id;
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
  gainXP(2, 'video watched');
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
      <div class="row" style="margin-top:12px">${X?.loading && X.nb === nb.id ? '<button class="btn primary lg" disabled><span class="spinner"></span> Writing your exam…</button>' : `<button class="btn primary lg" data-act="exam-gen">${S.status.claude ? 'Generate exam' : 'Start exam from my cards'}</button>`}</div></div>
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
  if (!questions.length) { UI.exam = null; toast('Couldn’t make exam questions this time. Try again.', 'err'); return render(); }
  UI.exam = { nb: nb.id, phase: 'take', questions, answers: questions.map(() => ''), i: 0, start: Date.now(), deadline: timed ? Date.now() + questions.length * 90e3 : 0 };
  render();
};
function examTake(nb, el) {
  const X = UI.exam; const q = X.questions[X.i];
  el.innerHTML = `<div class="q-card stack">
    <div class="progress-line"><i style="width:${pct((X.i + 1) / X.questions.length)}%"></i></div>
    <details class="qnav-wrap" ${TOUCH ? '' : 'open'}><summary><span>Question ${X.i + 1} of ${X.questions.length} · ${X.answers.filter(Boolean).length} answered</span>${X.deadline ? '<span class="timer" id="exTimerLbl"></span>' : ''}</summary>
      <div class="qnav">${X.questions.map((_, i) => `<button class="${X.answers[i] ? 'ans' : ''} ${i === X.i ? 'cur' : ''}" data-act="ex-go" data-i="${i}">${i + 1}</button>`).join('')}</div></details>
    <div class="card"><div class="small muted">Question ${X.i + 1} of ${X.questions.length} · ${q.image ? '🖼️ Picture question' : q.type === 'mcq' ? 'Multiple choice' : 'Short answer'}</div>
      ${q.image ? `<div style="margin-top:10px">${(UI.shots ||= {}, shotStrip('ex', refShots(nb, [q.image])))}</div>` : ''}
      <div class="q-text">${tx(q.question)}</div>
      ${q.type === 'mcq' ? q.options.map((o, j) => `<label class="opt ${X.answers[X.i] === o ? 'sel' : ''}"><input type="radio" name="exopt" value="${j}" ${X.answers[X.i] === o ? 'checked' : ''}> <span>${tx(o)}</span></label>`).join('')
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
  catch (e) { aiError(e); X.phase = 'take'; X.deadline = 0; return render(); } // no auto-resubmit loop when grading can't run
  X.results = results;
  const val = (r) => (r.verdict === 'correct' ? 1 : r.verdict === 'partial' ? 0.5 : 0);
  const byConcept = {};
  X.questions.forEach((q, i) => { const b = (byConcept[q.concept_id] ||= { got: 0, n: 0 }); b.got += val(results[i]); b.n++; record(nb, q.concept_id, val(results[i])); });
  const score = results.reduce((a, r) => a + val(r), 0) / results.length;
  nb.exams.push({ date: Date.now(), score, total: results.length, byConcept });
  nb.seenExamQs.push(...X.questions.map((q) => q.question)); nb.seenExamQs = nb.seenExamQs.slice(-150);
  X.score = score; X.byConcept = byConcept; X.phase = 'results';
  const answeredAny = results.some((r) => r && r.verdict && r.verdict !== 'incorrect') || (X.answers || []).some((a) => String(a || '').trim());
  await save(nb); { const ex = Math.round(results.reduce((a, r) => a + val(r) * 10, 0)) + (answeredAny ? 10 : 0); if (ex) await gainXP(ex, 'exam'); }
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

// ═════════════════════════ PROFILE & RANK ═════════════════════════
const XP_RULES = [['Recall answer: right / partly / tried', '+10 / +5 / +2'], ['Teach back', '+12 to +20'], ['Practice exam', '+10, plus up to +10 a question'],
  ['Pretest', '+5, plus +5 a guess'], ['Watch a video with its questions', '+10'], ['Concept map blank', '+5'], ['New diagram or picture', '+3'], ['Tutor chat reply', '+2']];
function renderProfile() {
  const P = prof(); const rk = rankInfo(); const plate = myPlate(); const title = myTitle();
  let nextU = null; for (let i = rk.i + 1; i < TIERS.length; i++) { const u = unlocksAt(i); if (u.length) { nextU = { i, u }; break; } }
  $('#view').innerHTML = `
  <a href="#/" class="small">← Home</a>
  <section class="card profile-head plate plate-${plate.style}" style="--pc:${plateColor(plate)}">
    <div class="emb-big">${emblem(rk.i, 96)}</div>
    <div class="spacer stack" style="gap:6px;min-width:0">
      <input class="name-input" id="profName" maxlength="20" placeholder="Tap to add your name" value="${esc(P.name)}" aria-label="Your name" autocomplete="nickname">
      <div class="p-title">${WON() ? '👑 ' : ''}${esc(title.name)}</div>
      <div class="p-rank"><b style="color:${rk.r.top ? 'var(--accent)' : rk.r.c}">${esc(rk.label)}</b> · ${S.meta.xp.toLocaleString()} XP</div>
      <div class="meter rr"><i style="width:${rk.next ? pct(rk.into / rk.need) : 100}%"></i></div>
      <div class="small muted">${rk.next ? `${rk.into} / ${rk.need} XP to <b>${esc(rk.nextLabel)}</b>` : 'You reached the top rank. Legendary. 💎'}</div>
      ${nextU ? `<div class="small">Next unlock at <b>${esc(tierLabel(nextU.i))}</b>: ${nextU.u.map(esc).join(', ')}</div>` : ''}
    </div>
  </section>
  <section class="card stack"><h2>Customize</h2>
    <div class="small muted">Theme (buttons, tabs and glow)</div>
    <div class="swatches">${THEMES.map((t) => `<button type="button" class="swatch ${myTheme().id === t.id ? 'on' : ''} ${owned(t) ? '' : 'locked'}" data-act="prof-theme" data-v="${t.id}" style="--sw:${t.prism ? PRISM_GRAD : `linear-gradient(135deg, ${t.g1}, ${t.g2})`}"><i></i><span>${owned(t) ? esc(t.name) : lockText(t)}</span></button>`).join('')}</div>
    <div class="small muted">Title</div>
    <div class="chips">${TITLES.map((t) => `<button type="button" class="${title.id === t.id ? 'on' : ''} ${owned(t) ? '' : 'locked'}" data-act="prof-title" data-v="${t.id}">${owned(t) ? esc(t.name) : `${lockText(t)} · ${esc(t.name)}`}</button>`).join('')}</div>
    <div class="small muted">Nameplate</div>
    <div class="plates">${PLATES.map((p) => `<button type="button" class="plate-opt plate plate-${p.style} ${plate.id === p.id ? 'on' : ''} ${owned(p) ? '' : 'locked'}" data-act="prof-plate" data-v="${p.id}" style="--pc:${plateColor(p)}">${owned(p) ? esc(p.name.replace(' nameplate', '')) : lockText(p)}</button>`).join('')}</div>
  </section>
  ${S.status.public ? `<section class="card stack lb-prof"><h2>🏆 Leaderboard</h2>
    ${S.meta.lbJoined ? `<p class="small muted" style="margin:0">You’re on the board as <b>${esc(P.name || '…')}</b>. Only your display name, rank and XP are shown.</p>
      <div class="row"><a class="btn primary" href="#/leaderboard">See the leaderboard</a><button class="btn ghost" data-act="lb-leave">Leave</button></div>`
    : `<p class="small muted" style="margin:0">Compete with everyone on Etch. It resets every Sunday, and the week’s #1 wins the 👑 Weekly Champion title and a gold nameplate. Only your display name, rank and XP are shown.</p>
      <div class="row"><button class="btn primary" data-act="lb-join">Join the leaderboard</button><a class="btn ghost" href="#/leaderboard">Just look</a></div>`}
  </section>` : ''}
  <section class="card stack"><h2>Rank road</h2>
    <p class="small muted" style="margin:0">Every rank has 3 tiers. Tier 1 unlocks a theme, tier 2 a title, tier 3 a nameplate.</p>
    <div class="road">${RANKS.map((r, ri) => {
      const first = TIERS.findIndex((t) => t.ri === ri); const here = rk.ri === ri; const got = rk.i >= first;
      const rewards = r.top ? unlocksAt(first) : [0, 1, 2].map((k) => unlocksAt(first + k)).flat();
      return `<div class="road-row ${here ? 'here' : ''} ${got ? '' : 'locked'}">${emblem(r.top ? first : first + (here ? rk.tier - 1 : 0), 34)}
        <div class="spacer"><b style="color:${r.top ? 'var(--text)' : r.c}">${esc(r.name)}</b>${here ? ' <span class="tag accent">you are here</span>' : ''}
        <div class="small muted">${TIERS[first].min.toLocaleString()} XP${r.top ? '+' : ` – ${(TIERS[first + 2].min + r.step - 1).toLocaleString()} XP`}</div>
        <div class="small">${rewards.map(esc).join(' · ') || 'Your starting rank'}</div></div></div>`;
    }).join('')}</div>
  </section>
  <section class="card stack"><h2>How to earn XP</h2>
    <table class="xp-table">${XP_RULES.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</table>
    <p class="small muted" style="margin:0">Your rank and XP live in this browser with your notebooks, and they’re included in backups.</p>
  </section>`;
  $('#profName').addEventListener('change', async (e) => {
    const nn = e.target.value.replace(/\s+/g, ' ').trim().slice(0, 20);
    if (S.meta.lbJoined && nn.length < 2) { toast('On the leaderboard your name needs at least 2 characters.', 'err'); e.target.value = P.name; return; }
    P.name = nn; await saveMeta();
    toast(P.name ? `Nice to meet you, ${P.name} 👋` : 'Name removed'); renderTop(); lbSync(true);
  });
}
function profPick(kind, list, el) {
  const item = list.find((x) => x.id === el.dataset.v); if (!item) return;
  if (!owned(item) && item.special) { toast('🔒 Finish a week at #1 on the leaderboard to unlock this'); return; }
  if (!owned(item)) { const need = TIERS[item.at].min - S.meta.xp; toast(`🔒 Unlocks at ${tierLabel(item.at)} (${need.toLocaleString()} XP to go)`); return; }
  prof()[kind] = item.id; saveMeta(); applyTheme(); render();
}
ACT['prof-theme'] = (el) => profPick('theme', THEMES, el);
ACT['prof-title'] = (el) => profPick('title', TITLES, el);
ACT['prof-plate'] = (el) => profPick('plate', PLATES, el);

// ═════════════════════════ LEADERBOARD (public site) ═════════════════════════
// Opt-in. The server only ever gets: a private random id (stored hashed), your display name, total XP and the
// last week of daily XP. Weekly board resets Sunday midnight (New York time); the top 3 go into the Hall of Champions.
function lbId() {
  if (!/^[a-f0-9]{32}$/.test(S.meta.lbId || '')) { const a = new Uint8Array(16); crypto.getRandomValues(a); S.meta.lbId = [...a].map((x) => x.toString(16).padStart(2, '0')).join(''); }
  return S.meta.lbId;
}
function lbDays() { const out = {}; for (let i = 0; i < 8; i++) { const d = new Date(); d.setDate(d.getDate() - i); const k = dayKey(d); if (S.meta.days[k]) out[k] = S.meta.days[k]; } return out; }
async function lbPost() {
  const r = await fetch('/edge/lb', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: lbId(), name: prof().name, total: S.meta.xp, days: lbDays() }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Leaderboard error ${r.status}`); UI.lb = null; return j;
}
let lbTimer = null;
function lbSync(now = false) {
  if (!S.status.public || !S.meta.lbJoined || !prof().name) return;
  clearTimeout(lbTimer);
  lbTimer = setTimeout(() => {
    lbPost().then((j) => {
      if (j?.throttled) { clearTimeout(lbTimer); lbTimer = setTimeout(() => lbSync(true), Math.min(20000, (j.retryIn || 15000) + 500)); return; }
      if (route().view === 'leaderboard') lbFetch(true).then(drawLeaderboard).catch(() => {});
    }).catch((e) => { if (now && !UI.lbWarned) { UI.lbWarned = true; toast(`Leaderboard didn’t update: ${e.message}`, 'err'); } });
  }, now ? 300 : 4000);
}
async function lbFetch(force) {
  if (!force && UI.lb && Date.now() - UI.lb.at < 20000) return UI.lb.data;
  const r = await fetch('/edge/lb', { headers: S.meta.lbId ? { 'x-lb-id': S.meta.lbId } : {}, cache: 'no-store' });
  if (!r.ok) throw new Error('leaderboard ' + r.status);
  const data = await r.json(); UI.lb = { at: Date.now(), data };
  const wins = data.me?.wins || []; const old = S.meta.lbWins || [];
  if (JSON.stringify(wins) !== JSON.stringify(old)) {
    const fresh = wins.filter((w) => !old.some((x) => x.week === w.week));
    S.meta.lbWins = wins; await saveMeta(); fresh.forEach((w) => celebrateWin(w));
  }
  return data;
}
function celebrateWin(w) {
  confetti();
  const el = document.createElement('div'); el.className = 'rankup'; el.setAttribute('role', 'status');
  el.innerHTML = `<div style="font-size:2.4rem">${['👑', '🥈', '🥉'][w.place - 1]}</div><div class="spacer"><div class="rankup-k">${w.place === 1 ? 'WEEKLY CHAMPION' : 'TOP 3 THIS WEEK'}</div><b>${w.place === 1 ? 'You won the week!' : `You finished #${w.place}!`}</b>
    <div class="small">${w.place === 1 ? 'Unlocked: Weekly Champion title + gold nameplate' : 'You’re in the Hall of Champions'}</div></div><a class="btn sm" href="#/profile">View</a><button type="button" class="icon-btn quiet" aria-label="Close">✕</button>`;
  el.querySelectorAll('a, button').forEach((b) => b.addEventListener('click', () => el.remove()));
  document.body.appendChild(el); setTimeout(() => el.remove(), 10000);
}
const fmtWeek = (k) => new Date(k + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
function fmtUntil(iso) {
  const ms = new Date(iso) - Date.now(); if (ms <= 0) return 'a moment';
  const d = Math.floor(ms / 86400e3), h = Math.floor(ms / 3600e3) % 24, m = Math.floor(ms / 60e3) % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
const MEDAL = ['🥇', '🥈', '🥉'];
function lbRows(rows, empty) {
  return rows.length ? rows.map((r, i) => `<div class="lb-row ${r.me ? 'me' : ''} ${i < 3 ? 'top' : ''}">
      <span class="lb-place">${MEDAL[i] || `#${i + 1}`}</span>${emblem(tierAt(r.total), 24)}
      <span class="lb-name">${esc(r.name)}${r.champ ? ' <span title="Weekly champion">👑</span>' : ''}${r.me ? ' <span class="tag accent">you</span>' : ''}</span>
      <b class="lb-xp">${r.xp.toLocaleString()}<span> XP</span></b>${route().admin ? `<button class="btn sm ghost lb-x" data-act="lb-admin-del" data-n="${esc(r.name)}" aria-label="Remove ${esc(r.name)}">✕</button>` : ''}</div>`).join('') : `<p class="muted" style="margin:0">${empty}</p>`;
}
function renderLeaderboard() {
  $('#view').innerHTML = `<a href="#/" class="small">← Home</a><div id="lbBox" style="margin-top:10px"><div class="card building"><div class="spinner lg" style="margin:0 auto"></div><p class="muted">Loading the leaderboard…</p></div></div>`;
  lbFetch(true).then(drawLeaderboard).catch(() => { const b = $('#lbBox'); if (b) b.innerHTML = '<div class="card">Couldn’t load the leaderboard right now. Check your connection and try again.</div>'; });
}
function drawLeaderboard(d) {
  const box = $('#lbBox'); if (!box || !d) return;
  const tab = UI.lbTab || 'week'; const rows = tab === 'week' ? d.weekly : d.allTime;
  const place = d.me?.joined ? (tab === 'week' ? d.me.weekPlace : d.me.allPlace) : 0;
  box.innerHTML = `
  <section class="card lb-head stack">
    <div class="row between"><h1 style="margin:0">🏆 Leaderboard</h1><span class="small muted">${d.players} player${d.players === 1 ? '' : 's'}</span></div>
    <div class="seg lb-tabs">${[['week', 'This week'], ['all', 'All time']].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-act="lb-tab" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="small muted">${tab === 'week' ? `Week of ${fmtWeek(d.week)} · resets Sunday at midnight (ET), in <b id="lbCountdown">${fmtUntil(d.resetsAt)}</b>` : 'Total XP earned on Etch.'}</div>
  </section>
  ${tab === 'week' ? `<section class="card lb-prize"><div class="lb-prize-ico">🎁</div><div class="spacer"><b>This week’s prize</b>
    <div class="small">🥇 <b>#1</b> when the week resets wins the <b>👑 Weekly Champion</b> title and the <b>gold Champion nameplate</b>, theirs to keep, plus a crown by their name. 🥈🥉 #2 and #3 make the Hall of Champions.</div></div></section>` : ''}
  ${S.meta.lbJoined ? '' : `<section class="card lb-join row between"><div><b>Want to be on the board?</b><div class="small muted">Only your display name, rank and XP are shown.</div></div>
    <button class="btn primary" data-act="lb-join">Join</button></section>`}
  <section class="card lb-list">${lbRows(rows, tab === 'week' ? 'No one has scored this week yet. Study a little and you’re #1!' : 'No one has joined yet. Be the first!')}</section>
  ${place > 50 ? `<p class="small muted" style="text-align:center">You’re #${place}. Keep going!</p>` : ''}
  ${d.champions.length ? `<section class="card stack"><h2>🏛️ Hall of Champions</h2>${d.champions.map((c) => `<div class="hall-row"><span class="small muted">Week of ${fmtWeek(c.week)}</span>
    <div>${c.top.map((x, i) => `<span class="hall-pl">${MEDAL[i]} ${esc(x.name)} <span class="muted small">${x.xp.toLocaleString()} XP</span></span>`).join('')}</div></div>`).join('')}</section>` : ''}
  ${S.meta.lbJoined ? `<p class="small muted" style="text-align:center">You’re on the board as <b>${esc(prof().name)}</b> · <a href="#" data-act="lb-leave">Leave the leaderboard</a></p>` : ''}`;
  clearInterval(UI.lbTick);
  UI.lbTick = setInterval(() => { const c = $('#lbCountdown'); if (!c) return clearInterval(UI.lbTick); c.textContent = fmtUntil(d.resetsAt); }, 30000);
}
function homeLbCard() {
  const host = $('#homeLb'); if (!host) return;
  lbFetch().then((d) => {
    const h = $('#homeLb'); if (!h) return;
    const tab = UI.lbHomeTab || 'week'; const rows = tab === 'week' ? d.weekly : d.allTime;
    const scroller = h.querySelector('.lb-scroll'); const keep = scroller && UI.lbHomeTabShown === tab ? scroller.scrollTop : null;
    h.innerHTML = `<div class="row between"><h2>${hIcon('trophy')}Leaderboard</h2><a class="small" href="#/leaderboard">Full page →</a></div>
      <div class="card lb-home">
        <div class="row between lb-home-top"><div class="seg">${[['week', 'This week'], ['all', 'All time']].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-act="lb-home-tab" data-v="${k}">${l}</button>`).join('')}</div>
          <span class="small muted">${rows.length} ${rows.length === 1 ? 'player' : 'players'}${tab === 'week' ? ` · resets in ${fmtUntil(d.resetsAt)}` : ''}</span></div>
        <div class="lb-list lb-scroll">${lbRows(rows, tab === 'week' ? 'No one has scored this week yet. Your next study session could put you at #1!' : 'No one has joined yet. Be the first!')}</div>
        ${S.meta.lbJoined ? '' : '<div class="row" style="margin-top:10px"><button class="btn sm primary" data-act="lb-join">Join the leaderboard</button><span class="small muted">Resets every Sunday · #1 wins a crown</span></div>'}</div>`;
    UI.lbHomeTabShown = tab;
    const box = h.querySelector('.lb-scroll');
    if (keep !== null) box.scrollTop = keep;
    else { const me = box.querySelector('.lb-row.me'); if (me && me.offsetTop + me.offsetHeight > box.clientHeight) box.scrollTop = me.offsetTop - box.clientHeight / 2 + me.offsetHeight / 2; }
  }).catch(() => { const h = $('#homeLb'); if (h) h.innerHTML = ''; });
}
ACT['lb-admin-del'] = async (el) => {
  const name = el.dataset.n; if (!name || !confirm(`Remove “${name}” from the leaderboard?`)) return;
  const k = UI.lbAdminKey || prompt('Admin key (LB_ADMIN_KEY from Netlify):') || ''; if (!k) return; UI.lbAdminKey = k;
  try {
    const r = await fetch('/edge/lb', { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-admin-key': k }, body: JSON.stringify({ name }) });
    const j = await r.json().catch(() => ({})); if (!r.ok || !j.removed) { UI.lbAdminKey = ''; throw new Error(j.error || 'Not removed (wrong key?)'); }
    toast(`Removed “${name}”`); UI.lb = null; renderLeaderboard();
  } catch (e) { toast(e.message, 'err'); }
};
ACT['lb-home-tab'] = (el) => { UI.lbHomeTab = el.dataset.v; homeLbCard(); };
ACT['lb-tab'] = (el) => { UI.lbTab = el.dataset.v; drawLeaderboard(UI.lb?.data); };
ACT['lb-join'] = () => {
  const go = async (name) => {
    const P = prof(); const before = P.name; P.name = name; S.meta.lbJoined = true; lbId();
    try { await lbPost(); await saveMeta(); toast(`You’re on the leaderboard as ${name} 🏆`); }
    catch (e) { S.meta.lbJoined = false; P.name = before; await saveMeta(); toast(e.message, 'err'); return false; }
    closeModal(); if (route().view === 'leaderboard') renderLeaderboard(); else render(); return true;
  };
  modal(`<h2>Join the leaderboard</h2><p class="muted">Pick the name everyone will see. Only your display name, rank and XP are shown, never your notebooks.</p>
    <label class="field"><span>Display name</span><input type="text" id="lbName" maxlength="20" placeholder="e.g. Ko" value="${esc(prof().name)}" autocomplete="nickname"></label>
    <p class="small muted">Keep it friendly. Scores reset every Sunday at midnight (ET), and the week’s #1 wins the 👑 Weekly Champion title.</p>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-act="lb-join-go">Join</button></div>`);
  setTimeout(() => $('#lbName')?.focus(), 50);
  ACT['lb-join-go'] = async () => { const n = ($('#lbName')?.value || '').replace(/\s+/g, ' ').trim(); if (n.length < 2) { toast('Pick a name with at least 2 characters'); return; } await go(n); };
};
ACT['lb-leave'] = async () => {
  if (!confirm('Leave the leaderboard? Your name and score will be removed from it. Your XP and rank stay.')) return;
  try { await fetch('/edge/lb', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: lbId() }) }); } catch { /* offline: still leave locally */ }
  S.meta.lbJoined = false; UI.lb = null; await saveMeta(); toast('You left the leaderboard'); render();
};

// ═════════════════════════ FOCUS TIMER (pomodoro) ═════════════════════════
// The running timer lives in localStorage as an end time, so reloads, locked phones and background tabs can't make it drift.
// A floating pill follows you to every page (drag it; it snaps to the nearest corner). When time is up a full-screen
// page opens over whatever you were doing; closing it puts you back exactly where you were.
const PM_KEY = 'encode-pomo', PMC_KEY = 'encode-pomo-cfg';
const PM_LAB = { focus: 'Focus', short: 'Short break', long: 'Long break' };
const PM_XP = 10, PM_XP_DAY = 8, PM_XP_MIN = 10; // XP per finished focus block, rewarded blocks per day, shortest block that earns XP (min)
const PM_TIPS = ['Stand up and stretch.', 'Drink some water.', 'Look at something far away for 20 seconds.', 'Walk around for a minute.', 'Take a few slow, deep breaths.', 'Rest your eyes. Skip the phone scroll.', 'Roll your shoulders and neck.', 'Grab a quick snack.'];
const pmRead = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const pmWrite = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const PMC = { focus: 25, short: 5, long: 15, every: 4, sound: true, auto: false, notify: false, corner: 'tr', ...(pmRead(PMC_KEY) || {}) };
const pmDur = (mode) => Math.round((mode === 'focus' ? PMC.focus : mode === 'short' ? PMC.short : PMC.long) * 60);
const pmFresh = (mode, base = {}) => ({ cycle: 0, nb: '', screen: '', last: null, ...base, mode, total: pmDur(mode), left: pmDur(mode), endsAt: 0, running: false, started: false });
let PM = { ...pmFresh('focus'), ...(pmRead(PM_KEY) || {}) };
const pmSave = () => pmWrite(PM_KEY, PM);
const pmLeft = () => (PM.running ? Math.max(0, Math.ceil((PM.endsAt - Date.now()) / 1000)) : PM.left);
const pmFmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const pmBreakNext = (cycle) => (cycle > 0 && cycle % PMC.every === 0 ? 'long' : 'short');
const pmRound = () => Math.min(PM.cycle + (PM.mode === 'focus' ? 1 : 0), PMC.every) || 1;
const pmStats = () => { const f = S.meta.focus || {}; const k = dayKey(); return { min: f.days?.[k] || 0, blocks: f.blocks?.[k] || 0, xp: f.xp?.[k] || 0, nb: f.nb || {} }; };

// sound: a soft three-note chime made in the browser (no file). iPhones only allow sound after a tap, so Start unlocks it.
function pmAudio() { try { UI.actx = UI.actx || new (window.AudioContext || window.webkitAudioContext)(); if (UI.actx.state === 'suspended') UI.actx.resume(); } catch { /* no audio */ } }
function pmChime(up = true) {
  if (!PMC.sound || !UI.actx) return;
  try {
    const a = UI.actx; const notes = up ? [784, 988, 1175] : [988, 784];
    notes.forEach((f, i) => {
      const o = a.createOscillator(), g = a.createGain(); const t = a.currentTime + i * 0.22;
      o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(a.destination); o.start(t); o.stop(t + 0.95);
    });
  } catch { /* ignore */ }
  try { navigator.vibrate?.([180, 90, 180]); } catch { /* ignore */ }
}
function pmNotify(title, body) {
  if (!PMC.notify || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { const n = new Notification(title, { body, icon: 'logo-mark.png', tag: 'encode-pomo' }); n.onclick = () => { window.focus(); n.close(); }; } catch { /* ignore */ }
}

// ── controls ──
function pmStart() { pmAudio(); const l = PM.left || PM.total; if (!PM.started && PM.mode === 'focus') PM.xpAtStart = S.meta.xp; PM.running = true; PM.started = true; PM.endsAt = Date.now() + l * 1000; pmSave(); pmDrawAll(); }
function pmPause() { PM.left = pmLeft(); PM.running = false; pmSave(); pmDrawAll(); }
function pmReset() { PM = pmFresh(PM.mode, { cycle: PM.cycle, nb: PM.nb, last: PM.last }); pmSave(); pmDrawAll(); }
function pmSkip() {
  if (PM.mode === 'focus') PM = pmFresh(pmBreakNext(PM.cycle + 1), { cycle: PM.cycle, nb: PM.nb, last: PM.last });
  else PM = pmFresh('focus', { cycle: PM.mode === 'long' ? 0 : PM.cycle, nb: PM.nb, last: PM.last });
  pmSave(); pmDrawAll();
}
function pmFinish() {
  const stored = pmRead(PM_KEY);
  if (stored && stored.endsAt !== PM.endsAt) { PM = { ...pmFresh('focus'), ...stored }; pmDrawAll(); return; } // another tab already handled it
  const was = PM.mode; const keep = { nb: PM.nb };
  if (was === 'focus') {
    const min = Math.round(PM.total / 60); const st = pmStats();
    const stale = PM.endsAt && Date.now() - PM.endsAt > 5 * 60e3; // you weren't here when it ended
    const active = !stale && S.meta.xp - (PM.xpAtStart ?? S.meta.xp) >= 5; // answered questions during the block
    const xp = min >= PM_XP_MIN && st.xp < PM_XP_DAY && active ? PM_XP : 0;
    const why = xp ? '' : min < PM_XP_MIN ? `Blocks under ${PM_XP_MIN} min don’t earn XP.` : stale ? 'This block ended while you were away, so its minutes count but it doesn’t earn XP.' : !active ? 'Focus XP is for active study: answer some questions (Recall, Learn checks, a test) during the block to earn it.' : `You’ve earned focus XP ${PM_XP_DAY} times today, the daily max. The timer still works.`;
    const cycle = PM.cycle + 1;
    PM = pmFresh(pmBreakNext(cycle), { ...keep, cycle, last: { min, xp, why, nb: PM.nb, round: cycle, at: Date.now() } });
    PM.screen = stale ? '' : 'focusDone';
    if (PMC.auto && !stale) { PM.running = true; PM.started = true; PM.endsAt = Date.now() + PM.total * 1000; PM.screen = 'break'; }
    pmSave(); // claim this block before anything async, so a second tab can't count it twice
    const f = (S.meta.focus = S.meta.focus || {}); const k = dayKey();
    for (const n of ['days', 'blocks', 'xp', 'nb']) f[n] = f[n] || {};
    f.days[k] = (f.days[k] || 0) + min; f.blocks[k] = (f.blocks[k] || 0) + 1; if (keep.nb) f.nb[keep.nb] = (f.nb[keep.nb] || 0) + min;
    if (xp) { f.xp[k] = (f.xp[k] || 0) + 1; gainXP(xp, 'focus block'); } else saveMeta();
    if (stale) toast(why); else pmChime(true), pmNotify('Focus done ✓', `${xp ? `+${xp} XP. ` : ''}Time for a ${Math.round(pmDur(PM.mode) / 60)}-minute break.`);
  } else {
    PM = pmFresh('focus', { ...keep, cycle: was === 'long' ? 0 : PM.cycle, last: PM.last });
    PM.screen = 'breakDone'; pmSave();
    pmChime(false); pmNotify('Break’s over', `Ready for round ${pmRound()} of ${PMC.every}?`);
  }
  pmDrawAll();
}
function pmCloseScreen() { if (!PM.screen) return; PM.screen = ''; pmSave(); pmDrawAll(); }

ACT['pomo-start'] = () => pmStart();
ACT['pomo-pause'] = () => pmPause();
ACT['pomo-toggle'] = () => (PM.running ? pmPause() : pmStart());
ACT['pomo-reset'] = () => pmReset();
ACT['pomo-skip'] = () => { if (PM.mode === 'focus' && PM.started && !confirm('Skip this focus block? It won’t count toward XP.')) return; pmSkip(); };
ACT['pomo-mode'] = (el) => {
  const m = el.dataset.v; if (m === PM.mode && !PM.started) return;
  if (PM.mode === 'focus' && PM.started && !confirm('Stop this focus block? It won’t count.')) return;
  PM = pmFresh(m, { cycle: PM.cycle, nb: PM.nb, last: PM.last }); pmSave(); pmDrawAll();
};
ACT['pomo-open'] = () => { PM.screen = 'control'; pmSave(); pmDrawAll(); };
ACT['pomo-close'] = () => pmCloseScreen();
ACT['pomo-break'] = () => { pmAudio(); PM.screen = 'break'; pmStart(); };
ACT['pomo-focus-now'] = () => { PM = pmFresh('focus', { cycle: PM.mode === 'long' ? 0 : PM.cycle, nb: PM.nb, last: PM.last }); pmStart(); };
ACT['pomo-end-break'] = () => { PM = pmFresh('focus', { cycle: PM.mode === 'long' ? 0 : PM.cycle, nb: PM.nb, last: PM.last }); PM.screen = 'breakDone'; pmSave(); pmDrawAll(); };

// ── drawing ──
const PM_ICON = {
  play: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>',
};
function pmRing(size, sw, cls = '') {
  const r = (size - sw) / 2; const c = +(2 * Math.PI * r).toFixed(1);
  return `<svg class="pm-ring ${cls}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" class="pm-track" stroke-width="${sw}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" class="pm-arc" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="0" data-pm="arc" data-c="${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
}
const pmDots = () => `<span class="pm-dots" aria-label="Round ${pmRound()} of ${PMC.every}">${[...Array(PMC.every)].map((_, i) => `<i class="${i < PM.cycle ? 'f' : ''}"></i>`).join('')}</span>`;
const pmMain = (cls = 'btn primary') => (PM.running ? `<button class="${cls}" data-act="pomo-pause">${PM_ICON.pause} Pause</button>`
  : `<button class="${cls}" data-act="pomo-start">${PM_ICON.play} ${PM.started ? 'Resume' : 'Start'}</button>`);

function pomoHomeHTML() {
  const st = pmStats(); const nbs = [...S.notebooks].sort((a, b) => b.updated - a.updated);
  const nbMin = PM.nb ? st.nb[PM.nb] || 0 : 0;
  return `<div class="row between"><h2>${hIcon('timer')}Focus timer</h2><span class="small muted">Round ${pmRound()} of ${PMC.every} ${pmDots()} · <a href="#" data-act="pomo-expand">Hide ▴</a></span></div>
  <div class="card pm-home mode-${PM.mode}">
    <div class="pm-home-ring">${pmRing(160, 11)}<div class="pm-center"><b data-pm="time">${pmFmt(pmLeft())}</b><span>${PM.running ? PM_LAB[PM.mode].toLowerCase() : PM.started ? 'paused' : PM_LAB[PM.mode].toLowerCase()}</span></div></div>
    <div class="pm-home-side">
      <div class="seg pm-modes">${['focus', 'short', 'long'].map((m) => `<button class="${PM.mode === m ? 'on' : ''}" data-act="pomo-mode" data-v="${m}">${m === 'focus' ? 'Focus' : m === 'short' ? 'Short' : 'Long'} ${m === 'focus' ? PMC.focus : m === 'short' ? PMC.short : PMC.long}</button>`).join('')}</div>
      <label class="field"><span>Studying</span><select id="pmNb"><option value="">Not tied to a notebook</option>${nbs.map((n) => `<option value="${esc(n.id)}" ${PM.nb === n.id ? 'selected' : ''}>${esc(n.title)}</option>`).join('')}</select></label>
      <div class="row">${pmMain()}${PM.started ? '<button class="btn" data-act="pomo-reset">Reset</button>' : ''}<button class="btn ghost" data-act="pomo-skip">Skip ›</button></div>
      <div class="small muted">Today: ${st.blocks} focus block${st.blocks === 1 ? '' : 's'} · ${st.min} min${st.xp ? ` · +${st.xp * PM_XP} XP` : ''}${nbMin ? ` · ${nbMin} min on this notebook so far` : ''}</div>
      <div class="small muted">+${PM_XP} XP per focus block where you answer questions (up to ${PM_XP_DAY} a day). Change the times in ⚙︎ Settings.</div>
    </div>
  </div>`;
}
function pomoBarHTML() {
  const st = pmStats();
  return `<div class="card pm-bar mode-${PM.mode}">
    ${pmRing(40, 5)}<div class="pm-bar-txt"><b>${icon('timer')}Focus timer</b><span class="small muted"><span data-pm="time">${pmFmt(pmLeft())}</span> · ${PM.running ? PM_LAB[PM.mode].toLowerCase() : PM.started ? 'paused' : PM_LAB[PM.mode].toLowerCase()}${st.blocks ? ` · ${st.blocks} today` : ''}</span></div>
    ${pmMain('btn sm primary')}<button class="btn sm ghost" data-act="pomo-expand" aria-label="Show timer options"><span class="hide-sm">Options </span>▾</button></div>`;
}
ACT['pomo-expand'] = () => { UI.pmOpen = !UI.pmOpen; drawPomoHome(); };
function drawPomoHome() { const h = document.getElementById('pomoHome'); if (h) h.innerHTML = UI.pmOpen ? pomoHomeHTML() : pomoBarHTML(); }

function drawPill() {
  let el = document.getElementById('pomoPill');
  const show = PM.started && !PM.screen;
  if (!show) { if (el) el.hidden = true; return; }
  if (!el) {
    el = document.createElement('div'); el.id = 'pomoPill'; el.className = 'pm-pill'; el.tabIndex = 0; el.setAttribute('role', 'button');
    document.body.appendChild(el); pmDragSetup(el);
  }
  el.hidden = false; el.className = `pm-pill mode-${PM.mode} ${PM.running ? '' : 'paused'}`;
  el.setAttribute('aria-label', `${PM_LAB[PM.mode]} timer, ${pmFmt(pmLeft())} left. Tap to open, drag to move.`);
  el.innerHTML = `<span class="pm-grip" aria-hidden="true"></span>${pmRing(28, 3.5)}<b data-pm="time">${pmFmt(pmLeft())}</b><span class="pm-lab">${PM.running ? (PM.mode === 'focus' ? 'focus' : 'break') : 'paused'}</span>
    <button class="pm-pp" data-act="pomo-toggle" aria-label="${PM.running ? 'Pause' : 'Resume'}">${PM.running ? PM_ICON.pause : PM_ICON.play}</button>`;
  pmPlace();
}
// corners sit below the header at the top and above the home bar at the bottom
function pmPlace() {
  const el = document.getElementById('pomoPill'); if (!el || el.hidden || el.classList.contains('drag')) return;
  const pad = 12, W = document.documentElement.clientWidth, H = window.innerHeight;
  const bar = document.querySelector('.topbar'); let top = (bar ? bar.offsetHeight : 56) + 10;
  const tabs = document.querySelector('.tabs-bar'); // on notebook pages, sit below where the tab bar pins, so it never needs to move while you scroll
  if (tabs && tabs.offsetHeight) top += tabs.offsetHeight;
  const probe = UI.pmProbe || (UI.pmProbe = Object.assign(document.createElement('div'), { style: 'position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);pointer-events:none;visibility:hidden' }));
  if (!probe.isConnected) document.body.appendChild(probe);
  const bottom = (probe.offsetHeight || 0) + 18;
  const c = PMC.corner || 'tr';
  el.style.left = Math.max(pad, c[1] === 'l' ? pad : W - el.offsetWidth - pad) + 'px';
  if (c[0] === 't') { el.style.top = top + 'px'; el.style.bottom = ''; }
  else { el.style.top = 'auto'; el.style.bottom = `calc(${bottom}px)`; }
}
function pmDragSetup(el) {
  let D = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button || e.target.closest('button')) return;
    const r = el.getBoundingClientRect(); D = { x: e.clientX, y: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, moved: false };
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  el.addEventListener('pointermove', (e) => {
    if (!D) return;
    if (!D.moved && Math.hypot(e.clientX - D.x, e.clientY - D.y) < 6) return;
    D.moved = true; el.classList.add('drag'); el.style.bottom = '';
    const W = document.documentElement.clientWidth, H = window.innerHeight;
    el.style.left = Math.min(W - el.offsetWidth - 4, Math.max(4, e.clientX - D.ox)) + 'px';
    el.style.top = Math.min(H - el.offsetHeight - 4, Math.max(4, e.clientY - D.oy)) + 'px';
  });
  const end = (e) => {
    if (!D) return; const d = D; D = null; el.classList.remove('drag');
    if (!d.moved) { if (e.type === 'pointerup') ACT['pomo-open'](); return; }
    const r = el.getBoundingClientRect();
    PMC.corner = (r.top + r.height / 2 < window.innerHeight / 2 ? 't' : 'b') + (r.left + r.width / 2 < document.documentElement.clientWidth / 2 ? 'l' : 'r');
    pmWrite(PMC_KEY, PMC); pmPlace();
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); ACT['pomo-open'](); } });
}
window.addEventListener('resize', () => pmPlace());
window.addEventListener('hashchange', () => setTimeout(pmPlace, 60)); // a new page may add or remove the tab bar
// (the pill no longer moves while scrolling; it's placed once per page and on resize)

function pmScreenHTML() {
  const L = PM.last; const nb = L?.nb ? getNb(L.nb) : null;
  const tips = (seed) => { const i = Math.abs(Math.floor(seed / 1000)) % PM_TIPS.length; return `${PM_TIPS[i]} ${PM_TIPS[(i + 3) % PM_TIPS.length]}`; };
  const brkMin = Math.round(PM.total / 60);
  if (PM.screen === 'focusDone') return `
    <div class="pm-big-ico">✓</div><h1>Focus done</h1>
    <p class="pm-xp">${L?.xp ? `+${L.xp} XP · ` : ''}round ${Math.min(L?.round || 1, PMC.every)} of ${PMC.every} done</p>
    <p class="muted">${L?.min || 0} min${nb ? ` on <b>${esc(nb.title)}</b>` : ''}. ${PM.mode === 'long' ? 'You finished a full set, so take a longer break.' : 'Nice work.'}</p>
    ${L?.why ? `<p class="small muted">${esc(L.why)}</p>` : ''}
    <p class="pm-tip">Take ${brkMin}: ${tips(L?.at || 0)}</p>
    <div class="pm-actions"><button class="btn primary lg" data-act="pomo-break">Start ${brkMin}-min break</button>
      <button class="btn" data-act="pomo-focus-now">Skip break, keep going</button></div>
    <button class="btn ghost" data-act="pomo-close">Back to studying</button>`;
  if (PM.screen === 'break') return `
    ${L && Date.now() - L.at < 60 * 60e3 && L.xp ? `<p class="pm-xp">Focus done · +${L.xp} XP</p>` : ''}
    <p class="pm-kicker">${PM_LAB[PM.mode]}</p>
    <div class="pm-screen-ring">${pmRing(220, 13)}<div class="pm-center"><b data-pm="time">${pmFmt(pmLeft())}</b><span>${PM.running ? 'left' : 'paused'}</span></div></div>
    <p class="pm-tip">${tips(L?.at || PM.endsAt)}</p>
    <div class="pm-actions">${pmMain('btn')}<button class="btn" data-act="pomo-end-break">End break early</button></div>
    <button class="btn ghost" data-act="pomo-close">Back to studying <span class="small muted">(break keeps running)</span></button>`;
  if (PM.screen === 'breakDone') return `
    <div class="pm-big-ico">⚡</div><h1>Break’s over</h1>
    <p class="muted">Ready for round ${pmRound()} of ${PMC.every}?${PM.nb && getNb(PM.nb) ? ` Back to <b>${esc(getNb(PM.nb).title)}</b>.` : ''}</p>
    <div class="pm-actions"><button class="btn primary lg" data-act="pomo-focus-now">Start ${PMC.focus}-min focus</button></div>
    <button class="btn ghost" data-act="pomo-close">Not now</button>`;
  return `
    <p class="pm-kicker">${PM_LAB[PM.mode]} · round ${pmRound()} of ${PMC.every}</p>
    <div class="pm-screen-ring">${pmRing(220, 13)}<div class="pm-center"><b data-pm="time">${pmFmt(pmLeft())}</b><span>${PM.running ? 'left' : PM.started ? 'paused' : 'ready'}</span></div></div>
    <div class="pm-actions">${pmMain('btn primary lg')}${PM.started ? '<button class="btn" data-act="pomo-reset">Reset</button>' : ''}<button class="btn" data-act="pomo-skip">Skip ›</button></div>
    <button class="btn ghost" data-act="pomo-close">Back to studying</button>`;
}
function drawScreen() {
  let el = document.getElementById('pomoScreen');
  if (!PM.screen) { if (el) el.remove(); document.documentElement.classList.remove('pm-open'); return; }
  if (!el) { el = document.createElement('div'); el.id = 'pomoScreen'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); document.body.appendChild(el); }
  el.className = `pm-screen mode-${PM.mode}`; el.setAttribute('aria-label', PM.screen === 'focusDone' ? 'Focus done' : PM.screen === 'breakDone' ? 'Break is over' : 'Focus timer');
  el.innerHTML = `<div class="pm-screen-in">${pmScreenHTML()}</div>`;
  document.documentElement.classList.add('pm-open');
  setTimeout(() => el.querySelector('.btn.primary, .btn')?.focus({ preventScroll: true }), 30);
}
function pmDrawAll() { drawScreen(); drawPill(); drawPomoHome(); pmTick(); }

// ── every second: count down, update the numbers in place (no page re-render, so nothing jumps) ──
const PM_TITLE = document.title;
function pmTick() {
  const left = pmLeft();
  if (PM.running && left <= 0) return pmFinish();
  const t = pmFmt(left);
  document.querySelectorAll('[data-pm="time"]').forEach((e) => { if (e.textContent !== t) e.textContent = t; });
  document.querySelectorAll('[data-pm="arc"]').forEach((e) => e.setAttribute('stroke-dashoffset', String((+e.dataset.c * (1 - left / (PM.total || 1))).toFixed(1))));
  let title = PM_TITLE;
  if ((PM.screen === 'focusDone' || PM.screen === 'breakDone') && document.hidden) title = Date.now() % 2000 < 1000 ? (PM.screen === 'focusDone' ? '⏰ Focus done!' : '⏰ Break’s over!') : PM_TITLE;
  else if (PM.running) title = `${t} · ${PM.mode === 'focus' ? 'Focus' : 'Break'} · Etch`;
  else if (PM.started) title = `⏸ ${t} · Etch`;
  if (document.title !== title) document.title = title;
}
document.addEventListener('change', (e) => {
  if (e.target.id === 'pmNb') { PM.nb = e.target.value; pmSave(); drawPomoHome(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && PM.screen) pmCloseScreen(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) pmTick(); });
window.addEventListener('storage', (e) => { if (e.key === PM_KEY) { PM = { ...pmFresh('focus'), ...(pmRead(PM_KEY) || {}) }; pmDrawAll(); } }); // other tabs stay in sync
function pomoInit() {
  if (PM.screen === 'control') PM.screen = '';
  if (!PM.started && !PM.running) { const d = pmDur(PM.mode); if (PM.total !== d) { PM.total = d; PM.left = d; } }
  pmDrawAll(); clearInterval(UI.pmI);
  setTimeout(() => { pmTick(); UI.pmI = setInterval(pmTick, 1000); }, 1000 - (Date.now() % 1000));
}

// settings section
function pomoSettingsHTML() {
  const num = (k, label, min, max) => `<label class="field"><span>${label}</span><input type="number" inputmode="numeric" min="${min}" max="${max}" step="1" data-pmc="${k}" value="${PMC[k]}"></label>`;
  return `<h3>⏳ Focus timer</h3>
    <div class="pm-set">${num('focus', 'Focus (min)', 1, 120)}${num('short', 'Short break', 1, 60)}${num('long', 'Long break', 1, 60)}${num('every', 'Long break every', 2, 8)}</div>
    <div class="small muted">“Long break every” counts focus blocks (4 means a long break after every 4th).</div>
    <div class="stack" style="margin-top:8px">
      <label class="check small"><input type="checkbox" data-pmc="sound" ${PMC.sound ? 'checked' : ''}> Play a chime when time’s up</label>
      <label class="check small"><input type="checkbox" data-pmc="auto" ${PMC.auto ? 'checked' : ''}> Start breaks automatically</label>
      ${'Notification' in window ? `<label class="check small"><input type="checkbox" data-pmc="notify" ${PMC.notify ? 'checked' : ''}> Show a notification when time’s up and you’re in another tab</label>` : ''}
    </div>`;
}
document.addEventListener('change', async (e) => {
  const k = e.target.dataset?.pmc; if (!k) return;
  if (e.target.type === 'checkbox') {
    PMC[k] = e.target.checked;
    if (k === 'notify' && PMC.notify && 'Notification' in window && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission().catch(() => 'denied');
      if (p !== 'granted') { PMC.notify = false; e.target.checked = false; toast('Notifications are blocked for this site in your browser settings'); }
    }
    if (k === 'sound' && PMC.sound) { pmAudio(); pmChime(true); }
  } else {
    const lim = { focus: [1, 120], short: [1, 60], long: [1, 60], every: [2, 8] }[k];
    const v = Math.min(lim[1], Math.max(lim[0], Math.round(+e.target.value || PMC[k]))); PMC[k] = v; e.target.value = v;
    if (!PM.started) { PM.total = pmDur(PM.mode); PM.left = PM.total; pmSave(); }
  }
  pmWrite(PMC_KEY, PMC); pmDrawAll();
});

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
    ${lookSection()}
    <hr style="border:0;border-top:1px solid var(--border)">
    ${pomoSettingsHTML()}
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
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `etch-backup-${dayKey()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
// Backups can come from anywhere (a classmate, an old device): check everything before saving any of it.
const SAFE_ID = /^[A-Za-z0-9_-]{3,64}$/;
const IMG_DATA = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
function validNotebook(nb) {
  if (!nb || typeof nb !== 'object' || !SAFE_ID.test(String(nb.id))) return false;
  if (!Array.isArray(nb.sources) || !Array.isArray(nb.cards)) return false;
  if (nb.sources.some((s) => !s || !SAFE_ID.test(String(s.id)))) return false;
  if (nb.digest) {
    if (!Array.isArray(nb.digest.concepts) || !Array.isArray(nb.digest.cards)) return false;
    if (nb.digest.concepts.some((c) => !SAFE_ID.test(String(c.id)))) return false;
    if ((nb.digest.concept_map?.nodes || []).some((n) => !SAFE_ID.test(String(n.id)))) return false;
  }
  return true;
}
async function importData(e) {
  const input = e.target; const f = input.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text()); if (data.app !== 'encode') throw new Error('Not an Etch backup');
    if (!Array.isArray(data.notebooks)) throw new Error('The file has no notebooks');
    const good = data.notebooks.filter(validNotebook); const bad = data.notebooks.length - good.length;
    // fill in fields older backups may not have, and drop anything that isn't real image data
    for (const nb of good) {
      Object.assign(nb, { illustrations: nb.illustrations || {}, feynman: nb.feynman || {}, chat: Array.isArray(nb.chat) ? nb.chat : [], exams: Array.isArray(nb.exams) ? nb.exams : [],
        videos: Array.isArray(nb.videos) ? nb.videos : [], seenExamQs: Array.isArray(nb.seenExamQs) ? nb.seenExamQs : [], conceptStats: nb.conceptStats || {},
        pretest: nb.pretest || { done: false, answers: [] }, progress: nb.progress || { learn: false, reviews: 0 }, updated: Number(nb.updated) || 0 });
      for (const [k, v] of Object.entries(nb.illustrations)) if (!v || (v.kind !== 'svg' && !IMG_DATA.test(String(v.src || '')))) delete nb.illustrations[k];
      nb.cards = nb.cards.filter((c) => c && c.question && c.srs);
    }
    const ids = new Set(good.flatMap((nb) => nb.sources.map((s) => s.id)));
    for (const v of data.visuals || []) {
      if (!v || !ids.has(v.id) || !Array.isArray(v.items)) continue;
      v.items = v.items.filter((it) => it && IMG_DATA.test(String(it.src || '')));
      await DB.put('visuals', v);
    }
    let kept = 0;
    for (const nb of good) {
      const i = S.notebooks.findIndex((n) => n.id === nb.id);
      if (i >= 0 && (S.notebooks[i].updated || 0) > (nb.updated || 0)) { kept++; continue; } // this device has newer work: keep it
      if (i >= 0) S.notebooks[i] = nb; else S.notebooks.push(nb);
      await DB.put('notebooks', nb);
    }
    const m = data.meta || {};
    if (Number.isFinite(+m.xp)) S.meta.xp = Math.max(S.meta.xp, Math.floor(+m.xp));
    const days = {}; for (const [k, v] of Object.entries(m.days || {})) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(+v)) days[k] = Math.max(0, Math.floor(+v));
    S.meta.days = { ...days, ...S.meta.days };
    // moving to a new device: bring your name, look and leaderboard identity along if this device has none yet
    if (m.profile && typeof m.profile === 'object' && !S.meta.profile?.name) S.meta.profile = { ...m.profile, name: String(m.profile.name || '').slice(0, 20) };
    if (!S.meta.lbId && /^[a-f0-9]{32}$/.test(String(m.lbId || ''))) { S.meta.lbId = m.lbId; S.meta.lbJoined = !!m.lbJoined; }
    if (Array.isArray(m.lbWins) && !S.meta.lbWins?.length) S.meta.lbWins = m.lbWins;
    await saveMeta();
    toast(`Imported ${good.length - kept} notebook(s)${kept ? ` · kept ${kept} newer one(s) already here` : ''}${bad ? ` · skipped ${bad} damaged one(s)` : ''}`);
    closeModal(); render();
  } catch (err) { toast('Import failed: ' + err.message, 'err'); }
  finally { input.value = ''; } // choosing the same file again works
}

// ───────────────────────── boot ─────────────────────────
(async function boot() {
  try {
    const data = await DB.load();
    S.notebooks = data.notebooks || [];
    if (data.meta) S.meta = { key: 'stats', xp: 0, days: {}, ...data.meta };
  } catch {
    $('#view').innerHTML = '<div class="card empty"><div class="big">🔒</div><h3>Etch can’t save in this browser</h3><p class="muted">Your browser is blocking website storage (private browsing, or cookies/site data turned off). Open Encode in a normal window, then reload.</p></div>';
    return;
  }
  render();
  pomoInit();
  await migrateFromBrowser();
  await refreshStatus();
  render();
  EncodeWeb.cleanTrash();
  lbSync(true);
  // Coming back to this tab: pick up anything changed on another device/tab (unless mid-session).
  document.addEventListener('visibilitychange', async () => {
    const busy = (m) => m && (typeof m !== 'object' || Object.values(m).some(Boolean));
    if (document.hidden || UI.recall?.queue?.length > UI.recall?.i || UI.exam?.phase || UI.building || UI.chatBusy || UI.teachBusy
      || [UI.lessonBusy, UI.deepBusy, UI.testBusy, UI.teachBackBusy, UI.illBusy, UI.vidBusy, UI.lessonHelpBusy, UI.paraGrading].some(busy)) return;
    try {
      const data = await DB.load();
      const stamp = (list) => list.map((n) => n.id + n.updated).sort().join();
      if (stamp(data.notebooks) !== stamp(S.notebooks) || (data.meta?.xp ?? 0) !== S.meta.xp) {
        S.notebooks = data.notebooks; if (data.meta) S.meta = { key: 'stats', ...data.meta }; render();
      }
    } catch { /* offline: keep what we have */ }
  });
})();
