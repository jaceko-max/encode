// 3nc0de leaderboard: opt-in, display names only, weekly reset (Sunday midnight, New York time).
// Storage: Netlify Blobs store "leaderboard".
//   p/<hash>  one player: { name, total, weekKey, weekXp, updated, created }
//   meta      { week: current week key, champions: [{ week, top: [{ name, xp, h }] }] }
// Each browser keeps a private random id; only its SHA-256 hash is stored, and hashes are never sent back out.
// Routes:
//   GET    /edge/lb            -> { week, resetsAt, weekly, allTime, champions, me }   (header x-lb-id marks "you")
//   POST   /edge/lb  {id, name, total, days}  -> join / update your score
//   DELETE /edge/lb  {id}      -> leave (removes your entry)
//   DELETE /edge/lb  {name}    + header x-admin-key = LB_ADMIN_KEY -> remove an entry by name (site owner)
import { getStore } from '@netlify/blobs';

const TZ = 'America/New_York';
const DAY_CAP = 1500;          // most XP a real study day plausibly earns
const FIRST_JOIN_CAP = 15000;  // most XP accepted the first time someone joins
const MIN_GAP_MS = 15000;      // ignore updates more often than this

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const nyDate = (d) => d.toLocaleDateString('en-CA', { timeZone: TZ });
function weekKey(now = new Date()) { // the Sunday that starts this week, as YYYY-MM-DD (New York time)
  const [y, m, d] = nyDate(now).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return new Date(Date.UTC(y, m - 1, d - dow, 12)).toISOString().slice(0, 10);
}
function nextReset(now = new Date()) { // next Sunday 00:00 New York time, as an ISO string
  const wk = weekKey(now); const [y, m, d] = wk.split('-').map(Number);
  for (const off of [4, 5]) { // EDT is UTC-4, EST is UTC-5
    const t = new Date(Date.UTC(y, m - 1, d + 7, off)); if (weekKey(t) !== wk && weekKey(new Date(t.getTime() - 3600e3)) === wk) return t.toISOString();
  }
  return new Date(Date.UTC(y, m - 1, d + 7, 5)).toISOString();
}
async function sha(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('3nc0de-lb:' + s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32); }
function cleanName(raw) {
  const n = String(raw || '').replace(/\s+/g, ' ').trim();
  if (n.length < 2 || n.length > 20) return { err: 'Use a display name of 2–20 characters.' };
  if (!/^[\p{L}\p{N} ._'’-]+$/u.test(n)) return { err: 'Use letters, numbers, spaces, dots, dashes or apostrophes.' };
  return { name: n };
}
const num = (x) => (Number.isFinite(+x) ? Math.max(0, Math.floor(+x)) : 0);

async function allPlayers(store) {
  const { blobs } = await store.list({ prefix: 'p/' });
  const rows = await Promise.all(blobs.map(async (b) => ({ h: b.key.slice(2), ...(await store.get(b.key, { type: 'json' })) })));
  return rows.filter((r) => r && r.name);
}
async function rollWeek(store, players, wk) { // close out finished weeks: keep the top 3 as champions
  const meta = (await store.get('meta', { type: 'json' })) || { week: wk, champions: [] };
  if (meta.week && meta.week !== wk) {
    const top = players.filter((p) => p.weekKey === meta.week && p.weekXp > 0).sort((a, b) => b.weekXp - a.weekXp).slice(0, 3)
      .map((p) => ({ name: p.name, xp: p.weekXp, h: p.h }));
    if (top.length) meta.champions = [{ week: meta.week, top }, ...(meta.champions || [])].slice(0, 12);
    meta.week = wk; await store.setJSON('meta', meta);
  } else if (!meta.week) { meta.week = wk; await store.setJSON('meta', meta); }
  return meta;
}

export default async (request) => {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'Forbidden' }, 403);
  const store = getStore({ name: 'leaderboard', consistency: 'strong' });
  const now = new Date(); const wk = weekKey(now);
  let body = {};
  if (request.method !== 'GET') { try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); } }

  if (request.method === 'GET') {
    const players = await allPlayers(store);
    const meta = await rollWeek(store, players, wk);
    const id = request.headers.get('x-lb-id') || '';
    const me = /^[a-f0-9]{32}$/.test(id) ? await sha(id) : '';
    const row = (p, xp) => ({ name: p.name, xp, total: p.total, me: p.h === me, champ: (meta.champions || []).some((c) => c.top[0]?.h === p.h) });
    const weekly = players.filter((p) => p.weekKey === wk && p.weekXp > 0).sort((a, b) => b.weekXp - a.weekXp).map((p) => row(p, p.weekXp));
    const allTime = players.sort((a, b) => b.total - a.total).map((p) => row(p, p.total));
    const myWins = me ? (meta.champions || []).flatMap((c) => c.top.map((t, i) => (t.h === me ? { week: c.week, place: i + 1 } : null)).filter(Boolean)) : [];
    return json({
      week: wk, resetsAt: nextReset(now), players: players.length,
      weekly: weekly.slice(0, 50), allTime: allTime.slice(0, 50),
      me: me ? { joined: players.some((p) => p.h === me), weekPlace: weekly.findIndex((r) => r.me) + 1, allPlace: allTime.findIndex((r) => r.me) + 1, wins: myWins } : null,
      champions: (meta.champions || []).map((c) => ({ week: c.week, top: c.top.map((t) => ({ name: t.name, xp: t.xp })) })),
    });
  }

  if (request.method === 'POST') {
    if (!/^[a-f0-9]{32}$/.test(String(body.id || ''))) return json({ error: 'Bad id' }, 400);
    const nm = cleanName(body.name); if (nm.err) return json({ error: nm.err }, 400);
    const h = await sha(body.id); const key = 'p/' + h;
    const prev = await store.get(key, { type: 'json' });
    const t = now.getTime();
    if (prev && t - (prev.updated || 0) < MIN_GAP_MS && prev.name === nm.name) return json({ ok: true, total: prev.total, weekXp: prev.weekKey === wk ? prev.weekXp : 0 });
    // keep scores believable: a capped amount per day since the last update
    const days = prev ? Math.max(1, Math.ceil((t - (prev.updated || t)) / 86400e3)) : 0;
    const maxTotal = prev ? prev.total + DAY_CAP * days + 200 : FIRST_JOIN_CAP;
    const total = Math.min(num(body.total), maxTotal);
    // this week's XP = the days from Sunday on (each day capped)
    let weekXp = 0;
    for (const [d, xp] of Object.entries(body.days || {})) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d >= wk && d <= nyDate(new Date(t + 86400e3))) weekXp += Math.min(num(xp), DAY_CAP);
    weekXp = Math.min(weekXp, total);
    const rec = { name: nm.name, total, weekKey: wk, weekXp, updated: t, created: prev?.created || t };
    await store.setJSON(key, rec);
    return json({ ok: true, total, weekXp, clamped: total < num(body.total) });
  }

  if (request.method === 'DELETE') {
    const admin = Netlify.env.get('LB_ADMIN_KEY');
    if (body.name && admin && request.headers.get('x-admin-key') === admin) {
      const target = String(body.name).trim().toLowerCase();
      const players = await allPlayers(store); let removed = 0;
      for (const p of players) if (p.name.toLowerCase() === target) { await store.delete('p/' + p.h); removed++; }
      return json({ ok: true, removed });
    }
    if (!/^[a-f0-9]{32}$/.test(String(body.id || ''))) return json({ error: 'Bad id' }, 400);
    await store.delete('p/' + (await sha(body.id)));
    return json({ ok: true });
  }
  return json({ error: 'Not found' }, 404);
};

export const config = { path: '/edge/lb' };
