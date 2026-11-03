'use strict';
/* Data layer: ESPN public endpoints + IndexedDB cache.
   Completed box scores and prior-season game logs never change, so they are cached permanently.
   Slate, schedules, rosters and injuries are fetched fresh on every build. */

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const ESPN_WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba';
const CACHE_V = 'v1';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const Store = (() => {
  let dbp = null;
  const mem = new Map();
  function open() {
    if (!dbp) dbp = new Promise(res => {
      try {
        const r = indexedDB.open('nba-matchup-board', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      } catch (e) { res(null); }
    });
    return dbp;
  }
  async function get(k) {
    if (mem.has(k)) return mem.get(k);
    const db = await open();
    if (!db) return undefined;
    return new Promise(res => {
      try {
        const q = db.transaction('kv').objectStore('kv').get(k);
        q.onsuccess = () => { if (q.result !== undefined) mem.set(k, q.result); res(q.result); };
        q.onerror = () => res(undefined);
      } catch (e) { res(undefined); }
    });
  }
  async function set(k, v) {
    mem.set(k, v);
    const db = await open();
    if (!db) return;
    return new Promise(res => {
      try {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(v, k);
        tx.oncomplete = () => res();
        tx.onerror = () => res();
      } catch (e) { res(); }
    });
  }
  return { get, set };
})();

async function fetchJSON(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) return await r.json();
      if (r.status === 404 || r.status === 400) return null;
      last = new Error('HTTP ' + r.status);
    } catch (e) { last = e; }
    await sleep(500 * (i + 1));
  }
  throw new Error('Fetch failed: ' + url + ' (' + (last && last.message) + ')');
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const splitMA = s => {
  if (!s || typeof s !== 'string' || s.indexOf('-') < 0) return [0, 0];
  const [m, a] = s.split('-').map(Number);
  return [m || 0, a || 0];
};

const etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const etDate = iso => etFmt.format(new Date(iso));
const etTime = iso => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET';
function etNowParts() {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date()).forEach(x => p[x.type] = x.value);
  return { date: `${p.year}-${p.month}-${p.day}`, h: +p.hour, m: +p.minute };
}
function addDays(d, n) {
  const t = new Date(d + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const dayDiff = (a, b) => Math.round((new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 864e5);

/* ---------- extraction ---------- */

function extractBox(s) {
  const comp = s && s.header && s.header.competitions && s.header.competitions[0];
  if (!comp || !comp.status || !comp.status.type || !comp.status.type.completed) return null;
  const g = { id: String(s.header.id), date: comp.date, teams: {}, players: [] };
  for (const c of comp.competitors) g.teams[String(c.team.id)] = { id: String(c.team.id), ha: c.homeAway, pts: +c.score || 0 };
  for (const tb of (s.boxscore && s.boxscore.teams) || []) {
    const t = g.teams[String(tb.team.id)];
    if (!t) continue;
    const m = {};
    for (const st of tb.statistics || []) m[st.name] = st.displayValue;
    const [fgm, fga] = splitMA(m['fieldGoalsMade-fieldGoalsAttempted']);
    const [tpm, tpa] = splitMA(m['threePointFieldGoalsMade-threePointFieldGoalsAttempted']);
    const [ftm, fta] = splitMA(m['freeThrowsMade-freeThrowsAttempted']);
    Object.assign(t, {
      fgm, fga, tpm, tpa, ftm, fta,
      oreb: +m.offensiveRebounds || 0, reb: +m.totalRebounds || 0,
      tov: +(m.totalTurnovers != null ? m.totalTurnovers : m.turnovers) || 0,
      paint: +m.pointsInPaint || 0
    });
  }
  for (const pb of (s.boxscore && s.boxscore.players) || []) {
    const tid = String(pb.team.id);
    const st = pb.statistics && pb.statistics[0];
    if (!st) continue;
    const ix = {};
    (st.names || st.labels || []).forEach((n, i) => ix[n] = i);
    for (const a of st.athletes || []) {
      const v = a.stats || [];
      if (a.didNotPlay || !v.length) continue;
      const min = +v[ix.MIN] || 0;
      if (min <= 0) continue;
      const [fgm, fga] = splitMA(v[ix.FG]);
      const [tpm, tpa] = splitMA(v[ix['3PT']]);
      const [ftm, fta] = splitMA(v[ix.FT]);
      g.players.push({
        id: String(a.athlete.id), n: a.athlete.displayName, p: (a.athlete.position && a.athlete.position.abbreviation) || '',
        t: tid, st: !!a.starter, min,
        pts: +v[ix.PTS] || 0, reb: +v[ix.REB] || 0, ast: +v[ix.AST] || 0, stl: +v[ix.STL] || 0, blk: +v[ix.BLK] || 0, tov: +v[ix.TO] || 0,
        fgm, fga, tpm, tpa, ftm, fta
      });
    }
  }
  for (const tid of Object.keys(g.teams)) g.teams[tid].min = g.players.filter(p => p.t === tid).reduce((a, p) => a + p.min, 0);
  if (!g.players.length) return null;
  return g;
}

function parseGamelog(j, season) {
  if (!j || !j.labels) return [];
  const ix = {};
  j.labels.forEach((l, i) => ix[l] = i);
  const seen = new Set(), out = [];
  for (const st of j.seasonTypes || []) {
    const dn = st.displayName || '';
    if (/preseason|all-?star/i.test(dn)) continue;
    const typ = /postseason/i.test(dn) ? 'PO' : /play.?in/i.test(dn) ? 'PI' : 'RS';
    for (const cat of st.categories || []) {
      for (const ev of cat.events || []) {
        const meta = j.events && j.events[ev.eventId];
        if (!meta || seen.has(ev.eventId)) continue;
        seen.add(ev.eventId);
        const v = ev.stats || [];
        const [fgm, fga] = splitMA(v[ix.FG]);
        const [tpm, tpa] = splitMA(v[ix['3PT']]);
        const [ftm, fta] = splitMA(v[ix.FT]);
        const teamId = String((meta.team && meta.team.id) || '');
        const home = String(meta.homeTeamId) === teamId;
        const ts = +(home ? meta.homeTeamScore : meta.awayTeamScore), os = +(home ? meta.awayTeamScore : meta.homeTeamScore);
        const min = +v[ix.MIN] || 0;
        if (min <= 0) continue;
        out.push({
          gid: String(ev.eventId), date: (meta.gameDate || '').slice(0, 10), season, typ, teamId,
          oppId: String((meta.opponent && meta.opponent.id) || ''), min,
          pts: +v[ix.PTS] || 0, reb: +v[ix.REB] || 0, ast: +v[ix.AST] || 0, stl: +v[ix.STL] || 0, blk: +v[ix.BLK] || 0, tov: +v[ix.TO] || 0,
          fgm, fga, tpm, tpa, ftm, fta,
          margin: (isFinite(ts) && isFinite(os) && (ts || os)) ? ts - os : null
        });
      }
    }
  }
  return out;
}

/* ---------- loaders ---------- */

async function findNextSlate(D, maxDays = 12) {
  for (let i = 1; i <= maxDays; i++) {
    const d = addDays(D, i);
    const sb = await fetchJSON(`${ESPN}/scoreboard?dates=${d.replace(/-/g, '')}`);
    if (sb && sb.events && sb.events.some(e => [2, 3, 5].includes(e.season && e.season.type))) return d;
  }
  return null;
}

async function loadRaw(D, progress) {
  progress('Loading slate…');
  const sb = await fetchJSON(`${ESPN}/scoreboard?dates=${D.replace(/-/g, '')}`);
  const events = ((sb && sb.events) || []).filter(e => [2, 3, 5].includes(e.season && e.season.type));
  if (!events.length) return { empty: true, D, next: await findNextSlate(D) };
  const seasonYear = (events[0].season && events[0].season.year) || (sb.season && sb.season.year);

  const slate = events.map(e => {
    const c = e.competitions[0];
    const home = c.competitors.find(x => x.homeAway === 'home'), away = c.competitors.find(x => x.homeAway === 'away');
    const o = (c.odds || [])[0];
    return {
      id: String(e.id), date: e.date, status: e.status && e.status.type && e.status.type.shortDetail,
      home: String(home.team.id), away: String(away.team.id),
      odds: o ? { provider: (o.provider && (o.provider.displayName || o.provider.name)) || 'Market', details: o.details || null, total: o.overUnder != null ? +o.overUnder : null } : null
    };
  });

  // ESPN's /teams list has no CORS header; the 30 NBA franchises are ESPN team ids 1–30, and each schedule response carries its team.
  progress('Loading schedules (30 teams)…');
  const teams = {};
  const shortNames = {};
  for (const e of events) for (const c of e.competitions[0].competitors) shortNames[String(c.team.id)] = c.team.shortDisplayName;
  const games = {};
  const schedByTeam = {};
  await pool(Array.from({ length: 30 }, (_, i) => String(i + 1)), 8, async tid => {
    const s = await fetchJSON(`${ESPN}/teams/${tid}/schedule?season=${seasonYear}`);
    if (s && s.team) teams[tid] = { id: tid, abbr: s.team.abbreviation, name: s.team.displayName, short: shortNames[tid] || s.team.shortDisplayName || s.team.displayName };
    schedByTeam[tid] = [];
    for (const e of (s && s.events) || []) {
      const c = e.competitions && e.competitions[0];
      if (!c) continue;
      const d = etDate(e.date);
      schedByTeam[tid].push(d);
      const completed = c.status && c.status.type && c.status.type.completed;
      if (completed && d < D) games[String(e.id)] = { id: String(e.id), date: e.date, d };
    }
  });

  const ids = Object.keys(games);
  let done = 0;
  const boxes = {};
  await pool(ids, 10, async id => {
    const key = `box:${CACHE_V}:${id}`;
    let b = await Store.get(key);
    if (!b) {
      const s = await fetchJSON(`${ESPN}/summary?event=${id}`);
      b = extractBox(s);
      if (b) await Store.set(key, b);
    }
    if (b) { b.d = games[id].d; boxes[id] = b; }
    done++;
    if (done % 5 === 0 || done === ids.length) progress(`Box scores ${done}/${ids.length} (cached after first load)…`);
  });

  progress('Loading rosters & injuries…');
  const slateTeams = [...new Set(slate.flatMap(g => [g.home, g.away]))];
  const rosters = {};
  await pool(slateTeams, 8, async tid => {
    const r = await fetchJSON(`${ESPN}/teams/${tid}/roster`);
    rosters[tid] = ((r && r.athletes) || []).map(a => ({
      id: String(a.id), name: a.displayName, pos: (a.position && a.position.abbreviation) || '',
      inj: (a.injuries && a.injuries[0]) ? { status: a.injuries[0].status, date: a.injuries[0].date } : null
    }));
  });
  const injFeed = {};
  try {
    const ij = await fetchJSON(`${ESPN}/injuries`);
    for (const tb of (ij && ij.injuries) || []) {
      for (const x of tb.injuries || []) {
        const href = ((x.athlete && x.athlete.links) || []).map(l => l.href).join(' ');
        const m = href.match(/\/id\/(\d+)/);
        if (m) injFeed[m[1]] = { status: x.status, short: x.shortComment || '', date: x.date };
      }
    }
  } catch (e) { /* roster statuses still apply */ }

  return { D, seasonYear, slate, teams, schedByTeam, boxes, rosters, injFeed, fetchedAt: new Date().toISOString() };
}

async function loadGamelogs(pids, seasons, progress) {
  const jobs = [];
  for (const pid of pids) for (const s of seasons) jobs.push([pid, s]);
  const out = {};
  let done = 0;
  await pool(jobs, 10, async ([pid, s]) => {
    const key = `gl:${CACHE_V}:${pid}:${s}`;
    let rows = await Store.get(key);
    if (!rows) {
      let j = null;
      try { j = await fetchJSON(`${ESPN_WEB}/athletes/${pid}/gamelog?season=${s}`); } catch (e) { j = undefined; }
      if (j === undefined) rows = null; // network failure: don't cache
      else { rows = parseGamelog(j, s); await Store.set(key, rows); }
    }
    (out[pid] = out[pid] || []).push(...(rows || []));
    done++;
    if (done % 10 === 0 || done === jobs.length) progress(`Prior-season game logs ${done}/${jobs.length} (cached after first load)…`);
  });
  return out;
}
