// Encode's only server code: a small relay to Google Gemini that keeps the site's key secret.
// Routes (all under /edge/):
//   GET  /edge/status          -> { sharedKey: bool }   is the site's own key set?
//   GET  /edge/models          -> Gemini model list for the key in use
//   POST /edge/gemini?model=…  -> streams Gemini's answer (server-sent events) back to the browser
//   GET  /edge/fetch?url=…     -> reads a public web page / YouTube oEmbed for "add a link" and the video check
//   GET  /edge/youtube?q=…     -> optional real YouTube search (needs YOUTUBE_API_KEY)
//   (leaderboard: see leaderboard.js, path /edge/lb)
//   GET  /edge/fund            -> { enabled, total, spent, left, donate }   the shared AI fund (public numbers)
//   POST /edge/fund {add} | {total} | {resetSpent}  + header x-admin-key -> site owner adjusts the fund
//   GET  /edge/images?q=…      -> optional Google Images results for backgrounds (needs SERPER_API_KEY from serper.dev)
// The key: a visitor's own key (x-user-key header) if they added one in Settings, else GEMINI_API_KEY
// from Netlify's environment variables. It's never sent to the browser.

import { getStore } from '@netlify/blobs';

const GOOGLE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_BODY = 20 * 1024 * 1024;
const MAX_PAGE = 3 * 1024 * 1024;

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

function privateHost(host) {
  host = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.1[89]\.)/.test(host)) return true;
  if (/^\d+$/.test(host) || /^0x/.test(host)) return true; // decimal/hex-encoded IPs
  if (/(^|\.)(nip\.io|sslip\.io|xip\.io|localtest\.me)$/.test(host)) return true; // names that point at private addresses
  if (host.includes(':') && (host === '::1' || host === '::' || /^(fc|fd|fe80|::ffff:)/.test(host))) return true;
  return false;
}

// A light per-visitor limit (each edge instance keeps its own count): stops one person hammering the site's key.
const HITS = new Map();
function limited(request, max = 40, windowMs = 60000, bucket = '') {
  const ip = bucket + (request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for') || 'anon');
  const now = Date.now(); const h = HITS.get(ip) || { n: 0, t: now };
  if (now - h.t > windowMs) { h.n = 0; h.t = now; }
  h.n++; HITS.set(ip, h);
  if (HITS.size > 5000) for (const [k, v] of HITS) if (now - v.t > windowMs) HITS.delete(k);
  return h.n > max;
}
const SITE_MODELS = /^gemini-[\d.]+-flash(-lite)?(-image[\w.-]*)?$/; // what the app uses on the site's key (no Pro)

// ── The AI fund ──────────────────────────────────────────────────────────────────────────────
// The site's key is paid for by the owner (plus donations). Every request on the site's key adds its cost
// (from the token counts Gemini reports) to a running total in Netlify Blobs; when the spend reaches the fund,
// the site's key stops and visitors are asked to add their own free key (or chip in).
// The fund starts at AI_FUND_USD (Netlify env var) and the owner can raise it from #/leaderboard/admin.
// Prices are USD per 1M tokens, rounded UP on purpose so the meter runs a little ahead of Google's bill.
function price(model, now = Date.now()) {
  if (/image/.test(model)) return { in: 0.5, out: 30 };            // picture output is the expensive part
  if (/flash-lite/.test(model)) return { in: 0.25, out: 1.5 };
  if (/^gemini-2\.5-flash$/.test(model)) return { in: 0.3, out: 2.5 };
  const x = now >= Date.UTC(2027, 0, 1) ? 2 : 1;                   // Google doubles 3.6/3.8 Flash prices on Jan 1, 2027
  return { in: 0.75 * x, out: 3.75 * x };
}
function costOf(model, u) {
  const p = price(model); const cached = +u.cachedContentTokenCount || 0; const prompt = +u.promptTokenCount || 0;
  // output so far; if the answer was cut off, totalTokenCount still says how much came out
  const out = ((+u.candidatesTokenCount || 0) + (+u.thoughtsTokenCount || 0)) || Math.max(0, (+u.totalTokenCount || 0) - prompt);
  return (Math.max(0, prompt - cached) * p.in + cached * p.in * 0.1 + out * p.out) / 1e6;
}
// total: null = no cap set; 0 = paused; otherwise dollars in the fund
const FUND = { state: null, at: 0, pending: 0, flushing: null };
const fundStore = () => getStore({ name: 'fund', consistency: 'strong' });
const envTotal = () => { const v = (Netlify.env.get('AI_FUND_USD') || '').trim(); const n = parseFloat(v); return v !== '' && Number.isFinite(n) && n >= 0 ? n : null; };
function fundShape(st) {
  st = st && typeof st === 'object' ? st : {};
  const total = st.total === null || st.total === undefined ? envTotal() : Math.max(0, +st.total || 0);
  return { total, spent: Math.max(0, +st.spent || 0), since: st.since || new Date().toISOString(), log: Array.isArray(st.log) ? st.log : [] };
}
async function fundState(force = false) { // for reading only (the cap check and the public meter)
  if (!force && FUND.state && Date.now() - FUND.at < 15000) return FUND.state;
  try { FUND.state = fundShape(await fundStore().get('state', { type: 'json' })); FUND.at = Date.now(); }
  catch { if (!FUND.state) return fundShape(null); } // storage hiccup: keep the AI working, but never save this guess
  return FUND.state;
}
// read → change → write only if nobody else wrote in between (several edge servers run at once); retry otherwise.
// A failed read throws, so a storage hiccup can never overwrite the real numbers with blanks.
async function fundSave(change) {
  const store = fundStore();
  for (let k = 0; k < 6; k++) {
    const got = await store.getWithMetadata('state', { type: 'json' });
    const st = fundShape(got?.data); change(st);
    const res = got ? await store.setJSON('state', st, { onlyIfMatch: got.etag }) : await store.setJSON('state', st, { onlyIfNew: true });
    if (res?.modified !== false) { FUND.state = st; FUND.at = Date.now(); return st; }
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
  }
  throw new Error('The fund is busy. Try again.');
}
function fundCharge(usd) {
  if (!(usd > 0)) return Promise.resolve();
  FUND.pending += usd;
  if (FUND.flushing) return FUND.flushing;
  FUND.flushing = (async () => {
    try {
      while (FUND.pending > 0) {
        const add = FUND.pending; FUND.pending = 0;
        try { await fundSave((st) => { st.spent = Math.round((st.spent + add) * 1e6) / 1e6; }); }
        catch { FUND.pending += add; break; } // kept for the next request's save
      }
    } finally { FUND.flushing = null; }
  })();
  return FUND.flushing;
}
const fundOpen = (st) => st.total === null || st.spent < st.total * 0.98; // stop a hair early; 0 = paused
const donateUrl = () => { const u = Netlify.env.get('DONATE_URL') || ''; return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : ''; };
const fundPublic = (st) => ({ enabled: st.total !== null, total: r2(st.total || 0), spent: r2(st.spent), left: r2(Math.max(0, (st.total || 0) - st.spent)) });
// The last "usageMetadata" in Gemini's stream has the final token counts. Only the end of each line is kept
// (a picture answer is one line of several MB), which is where usageMetadata sits.
function usageFrom(lineEnd) {
  const k = lineEnd.lastIndexOf('"usageMetadata"'); if (k < 0) return null;
  const a = lineEnd.indexOf('{', k); if (a < 0) return null;
  for (let i = a, depth = 0; i < lineEnd.length; i++) {
    if (lineEnd[i] === '{') depth++;
    else if (lineEnd[i] === '}' && --depth === 0) { try { return JSON.parse(lineEnd.slice(a, i + 1)); } catch { return null; } }
  }
  return null;
}
const r2 = (x) => Math.round(x * 100) / 100;

export default async (request, context) => {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/edge\//, '');
  const siteKey = Netlify.env.get('GEMINI_API_KEY') || '';

  // Only this site's own pages may use the relay.
  const origin = request.headers.get('origin'); const sfs = request.headers.get('sec-fetch-site');
  if ((origin && origin !== url.origin) || (sfs && sfs !== 'same-origin' && sfs !== 'none')) return json({ error: 'Forbidden' }, 403);

  if (route === 'fund') {
    if (request.method === 'GET') {
      return json({ ...fundPublic(await fundState()), donate: donateUrl() });
    }
    if (request.method === 'POST') {
      if (limited(request, 6, 60000, 'fund:')) return json({ error: 'Too many tries. Wait a minute.' }, 429);
      const admin = Netlify.env.get('FUND_ADMIN_KEY') || Netlify.env.get('LB_ADMIN_KEY');
      if (!admin || request.headers.get('x-admin-key') !== admin) return json({ error: 'Wrong admin key.' }, 403);
      const b = await request.json().catch(() => ({}));
      const amt = (v) => (Number.isFinite(+v) && +v >= 0 && +v <= 100000 ? Math.round(+v * 100) / 100 : null);
      let st;
      try { st = await fundSave((st) => {
        const when = new Date().toISOString();
        if (amt(b.add) > 0) { st.total = r2((st.total || 0) + amt(b.add)); st.log.push({ when, add: amt(b.add), note: String(b.note || '').slice(0, 80) }); }
        if (amt(b.total) !== null && b.total !== undefined) { st.total = amt(b.total); st.log.push({ when, total: st.total }); }
        if (b.resetSpent) { st.log.push({ when, reset: r2(st.spent) }); st.spent = 0; st.since = when; }
        st.log = st.log.slice(-50);
      }); } catch (e) { return json({ error: `Not saved: ${e.message}` }, 503); }
      return json({ ok: true, ...fundPublic(st), log: st.log.slice(-10) });
    }
    return json({ error: 'Not found' }, 404);
  }

  if (route === 'status') return json({ sharedKey: !!siteKey, youtube: !!Netlify.env.get('YOUTUBE_API_KEY'), images: !!Netlify.env.get('SERPER_API_KEY') });

  if (route === 'images') {
    // Optional: Google Images results (via serper.dev) for the background picker, if SERPER_API_KEY is set.
    const sk = Netlify.env.get('SERPER_API_KEY');
    if (request.headers.get('x-encode') !== '1') return json({ error: 'Forbidden' }, 403);
    if (!sk) return json({ error: 'No image-search key on this site' }, 501);
    const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
    if (!q) return json({ images: [] });
    if (limited(request, 20)) return json({ error: 'Too many searches. Try again in a minute.' }, 429);
    let r; try { r = await fetch('https://google.serper.dev/images', { method: 'POST', headers: { 'X-API-KEY': sk, 'content-type': 'application/json' }, body: JSON.stringify({ q, num: 30 }), signal: AbortSignal.timeout(10000) }); }
    catch { return json({ error: 'Image search failed' }, 502); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: j?.message || `Image search error ${r.status}` }, r.status === 401 || r.status === 403 ? 502 : r.status);
    const https = (u) => /^https:\/\/\S+$/i.test(String(u || ''));
    return json({ images: (j.images || []).filter((i) => https(i.imageUrl) && Math.max(i.imageWidth || 0, i.imageHeight || 0) >= 600)
      .map((i) => ({ title: String(i.title || '').slice(0, 80), url: i.imageUrl, thumb: https(i.thumbnailUrl) ? i.thumbnailUrl : i.imageUrl,
        w: i.imageWidth || 0, h: i.imageHeight || 0, source: String(i.domain || i.source || '').slice(0, 60), page: https(i.link) ? i.link : '' })) });
  }

  if (route === 'youtube') {
    // Optional: real video search with the YouTube Data API (free, ~100 searches/day), if YOUTUBE_API_KEY is set.
    const ytKey = Netlify.env.get('YOUTUBE_API_KEY');
    if (request.headers.get('x-encode') !== '1') return json({ error: 'Forbidden' }, 403);
    if (!ytKey) return json({ error: 'No YouTube key on this site' }, 501);
    const q = (url.searchParams.get('q') || '').slice(0, 120);
    const api = new URL('https://www.googleapis.com/youtube/v3/search');
    Object.entries({ part: 'snippet', type: 'video', maxResults: '5', q, videoEmbeddable: 'true', relevanceLanguage: 'en',
      safeSearch: 'strict', videoDuration: url.searchParams.get('long') === '1' ? 'medium' : 'any' })
      .forEach(([k, v]) => api.searchParams.set(k, v));
    if (limited(request, 20)) return json({ error: 'Too many searches. Try again in a minute.' }, 429);
    let r; try { r = await fetch(api, { headers: { 'x-goog-api-key': ytKey }, signal: AbortSignal.timeout(10000) }); }
    catch { return json({ error: 'YouTube search failed' }, 502); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: j?.error?.message || `YouTube error ${r.status}` }, r.status);
    return json({ videos: (j.items || []).map((it) => ({ id: it.id?.videoId, title: it.snippet?.title, channel: it.snippet?.channelTitle })).filter((v) => v.id) });
  }

  if (route === 'fetch') {
    if (request.headers.get('x-encode') !== '1') return json({ error: 'Forbidden' }, 403);
    let target;
    try { target = new URL(url.searchParams.get('url') || ''); } catch { return json({ error: 'Please paste a full http(s) link.' }, 400); }
    if (limited(request, 20)) return json({ error: 'Too many links at once. Try again in a minute.' }, 429);
    try {
      for (let hop = 0; hop < 5; hop++) {
        if (!/^https?:$/.test(target.protocol) || privateHost(target.hostname)) return json({ error: 'That link can’t be opened.' }, 400);
        const r = await fetch(target, {
          redirect: 'manual', signal: AbortSignal.timeout(12000),
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; EncodeStudyBot/1.0)', 'accept-language': 'en-US,en;q=0.9' },
        });
        if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { target = new URL(r.headers.get('location'), target); continue; }
        const type = r.headers.get('content-type') || '';
        if (!/text|json|xml|html/.test(type)) { r.body?.cancel().catch(() => {}); return json({ status: r.status, contentType: type, text: '' }); }
        // read at most MAX_PAGE bytes, then stop
        const reader = r.body.getReader(); const parts = []; let size = 0;
        for (;;) { const { value, done } = await reader.read(); if (done) break; parts.push(value); size += value.length; if (size >= MAX_PAGE) { reader.cancel().catch(() => {}); break; } }
        const buf = new Uint8Array(Math.min(size, MAX_PAGE)); let o = 0; for (const p of parts) { const take = Math.min(p.length, buf.length - o); buf.set(p.subarray(0, take), o); o += take; if (o >= buf.length) break; }
        return json({ status: r.status, contentType: type, text: new TextDecoder().decode(buf) });
      }
      return json({ error: 'Too many redirects.' }, 400);
    } catch { return json({ error: 'Couldn’t open that link.' }, 502); }
  }

  const key = request.headers.get('x-user-key') || siteKey;
  if (!key) return json({ error: { message: 'No Gemini API key is set up.' } }, 401);

  if (route === 'models') {
    const r = await fetch(`${GOOGLE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }

  if (route === 'gemini' && request.method === 'POST') {
    if (request.headers.get('x-encode') !== '1') return json({ error: { message: 'Forbidden' } }, 403);
    const model = url.searchParams.get('model') || '';
    if (!/^gemini-[a-z0-9.\-]+$/.test(model)) return json({ error: { message: 'Unknown model' } }, 400);
    if (+(request.headers.get('content-length') || 0) > MAX_BODY) return json({ error: { message: 'Request too large' } }, 413);
    let body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY) return json({ error: { message: 'Request too large' } }, 413);
    const usingSiteKey = !request.headers.get('x-user-key');
    if (usingSiteKey) {
      // the site's key pays for this request: keep it to what the app itself sends
      if (!SITE_MODELS.test(model)) return json({ error: { message: 'That model isn’t available on this site.' } }, 404); // 404 = the app moves on to the next model
      if (limited(request, 90)) return json({ error: { message: 'Too many AI requests at once. Wait a minute and try again.' } }, 429);
      if (!fundOpen(await fundState())) return json({ error: { message: 'AI fund used up', code: 'fund_empty' } }, 402);
      let b; try { b = JSON.parse(new TextDecoder().decode(body)); } catch { return json({ error: { message: 'Bad request' } }, 400); }
      delete b.tools; delete b.toolConfig; delete b.cachedContent;
      const g = (b.generationConfig ||= {});
      if (!(g.maxOutputTokens > 0) || g.maxOutputTokens > 65536) g.maxOutputTokens = Math.min(65536, Math.max(1, g.maxOutputTokens || 8192));
      if (g.thinkingConfig && g.thinkingConfig.thinkingBudget > 4096) g.thinkingConfig.thinkingBudget = 4096;
      if (g.candidateCount) g.candidateCount = 1;
      body = new TextEncoder().encode(JSON.stringify(b));
    }

    // Start answering right away (edge functions must respond within 40 s) and keep the line alive
    // while Gemini thinks, then pipe Gemini's own event stream through.
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter(); const enc = new TextEncoder(); let usage = null; let started = false;
    const job = (async () => {
      const ping = setInterval(() => { w.write(enc.encode(': ping\n\n')).catch(() => {}); }, 8000);
      try {
        await w.write(enc.encode(': start\n\n'));
        const r = await fetch(`${GOOGLE}/models/${model}:streamGenerateContent?alt=sse`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body,
          signal: request.signal, // the student left or the app gave up: stop generating (and paying)
        });
        if (!r.ok) {
          clearInterval(ping);
          const text = await r.text();
          await w.write(enc.encode(`event: error\ndata: ${JSON.stringify({ status: r.status, body: text.slice(0, 4000) })}\n\n`));
        } else {
          started = true; // Google accepted it: from here on it costs money
          const reader = r.body.getReader(); const dec = new TextDecoder();
          let first = true; let lineEnd = '';
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            if (first) { clearInterval(ping); first = false; }
            if (usingSiteKey) {
              const parts = dec.decode(value, { stream: true }).split('\n');
              parts.forEach((part, n) => { lineEnd = (lineEnd + part).slice(-16384); if (n < parts.length - 1) { usage = usageFrom(lineEnd) || usage; lineEnd = ''; } });
            }
            await w.write(value);
          }
          if (usingSiteKey) usage = usageFrom(lineEnd) || usage;
        }
      } catch (e) {
        await w.write(enc.encode(`event: error\ndata: ${JSON.stringify({ status: 502, body: JSON.stringify({ error: { message: String(e?.message || e) } }) })}\n\n`)).catch(() => {});
      } finally {
        clearInterval(ping);
        if (usingSiteKey && started) { // counted before the stream closes (and waitUntil keeps it running if the student left)
          // no token counts (the student left mid-answer): charge a rough guess for the input that was sent
          const usd = usage ? costOf(model, usage) : costOf(model, { promptTokenCount: Math.min(body.byteLength / 4, 40000) });
          await fundCharge(usd).catch(() => {});
        }
        await w.close().catch(() => {});
      }
    })();
    context?.waitUntil?.(job);
    return new Response(readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
  }

  return json({ error: 'Not found' }, 404);
};

// /edge/lb is handled by leaderboard.js (kept separate so the AI relay never depends on storage)
export const config = { path: '/edge/*', excludedPath: ['/edge/lb'] };
