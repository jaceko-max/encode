// Encode's only server code: a small relay to Google Gemini that keeps the site's key secret.
// Routes (all under /edge/):
//   GET  /edge/status          -> { sharedKey: bool }   is the site's own key set?
//   GET  /edge/models          -> Gemini model list for the key in use
//   POST /edge/gemini?model=…  -> streams Gemini's answer (server-sent events) back to the browser
//   GET  /edge/fetch?url=…     -> reads a public web page / YouTube oEmbed for "add a link" and the video check
//   GET  /edge/youtube?q=…     -> optional real YouTube search (needs YOUTUBE_API_KEY)
//   (leaderboard: see leaderboard.js, path /edge/lb)
//   GET  /edge/images?q=…      -> optional Google Images results for backgrounds (needs SERPER_API_KEY from serper.dev)
// The key: a visitor's own key (x-user-key header) if they added one in Settings, else GEMINI_API_KEY
// from Netlify's environment variables. It's never sent to the browser.

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
function limited(request, max = 40, windowMs = 60000) {
  const ip = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for') || 'anon';
  const now = Date.now(); const h = HITS.get(ip) || { n: 0, t: now };
  if (now - h.t > windowMs) { h.n = 0; h.t = now; }
  h.n++; HITS.set(ip, h);
  if (HITS.size > 5000) for (const [k, v] of HITS) if (now - v.t > windowMs) HITS.delete(k);
  return h.n > max;
}
const SITE_MODELS = /^gemini-[\d.]+-flash(-lite)?(-image[\w.-]*)?$/; // what the app uses on the site's key (no Pro)

export default async (request) => {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/edge\//, '');
  const siteKey = Netlify.env.get('GEMINI_API_KEY') || '';

  // Only this site's own pages may use the relay.
  const origin = request.headers.get('origin'); const sfs = request.headers.get('sec-fetch-site');
  if ((origin && origin !== url.origin) || (sfs && sfs !== 'same-origin' && sfs !== 'none')) return json({ error: 'Forbidden' }, 403);

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
    const w = writable.getWriter(); const enc = new TextEncoder();
    (async () => {
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
          const reader = r.body.getReader();
          let first = true;
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            if (first) { clearInterval(ping); first = false; }
            await w.write(value);
          }
        }
      } catch (e) {
        await w.write(enc.encode(`event: error\ndata: ${JSON.stringify({ status: 502, body: JSON.stringify({ error: { message: String(e?.message || e) } }) })}\n\n`)).catch(() => {});
      } finally {
        clearInterval(ping);
        await w.close().catch(() => {});
      }
    })();
    return new Response(readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
  }

  return json({ error: 'Not found' }, 404);
};

// /edge/lb is handled by leaderboard.js (kept separate so the AI relay never depends on storage)
export const config = { path: '/edge/*', excludedPath: ['/edge/lb'] };
