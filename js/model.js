'use strict';
/* Model layer: everything here is computed from the box scores / game logs loaded in data.js.
   Anything that is an assumption rather than a measurement is tagged `modeled` and labelled in the UI. */

const STATS = ['pts', 'reb', 'ast', 'tpm', 'stl', 'blk'];
const MAIN = ['pts', 'reb', 'ast', 'tpm'];
const SL = { pts: 'PTS', reb: 'REB', ast: 'AST', tpm: '3PM', stl: 'STL', blk: 'BLK' };
const POS5 = ['PG', 'SG', 'SF', 'PF', 'C'];
const ADJ = { PG: ['SG'], SG: ['PG', 'SF'], SF: ['SG', 'PF'], PF: ['SF', 'C'], C: ['PF'] };
const HITS = {
  PG: { pts: [15, 20], reb: [4, 6], ast: [6, 8], tpm: [2, 3], stl: [1, 2], blk: [1, 2] },
  SG: { pts: [15, 20], reb: [4, 6], ast: [3, 5], tpm: [2, 3], stl: [1, 2], blk: [1, 2] },
  SF: { pts: [15, 20], reb: [5, 7], ast: [3, 5], tpm: [2, 3], stl: [1, 2], blk: [1, 2] },
  PF: { pts: [15, 20], reb: [6, 8], ast: [3, 5], tpm: [1, 2], stl: [1, 2], blk: [1, 2] },
  C:  { pts: [15, 20], reb: [8, 10], ast: [3, 5], tpm: [1, 2], stl: [1, 2], blk: [1, 2] }
};
const ABS_FLOOR = { pts: 4, reb: 2, ast: 1.5, tpm: 0.8, stl: 0.7, blk: 0.7 }; // per-36 gap needed before a ratio counts
const NORM_FLOOR = { pts: 3, reb: 1.5, ast: 1, tpm: 1, stl: 0.6, blk: 0.6 }; // per-game gap vs a player's own norm that counts
const BLOWOUT = 20;           // final margin that marks a game as minutes-distorted
const ROLE_MPG_SHIFT = 8;      // season MPG change that counts as a role change
const TAG_MIN_PCT = 0.08;      // scheme tag fires when BOTH of its metrics are >= 8% above the league average for those buckets
const TAG_DEFS = [
  { tag: 'PERIMETER-WEAK', label: 'PG+SG+SF', Ps: ['PG', 'SG', 'SF'], stats: ['pts', 'tpm'] },
  { tag: 'INTERIOR-WEAK', label: 'PF+C', Ps: ['PF', 'C'], stats: ['pts', 'reb'] }
];
// Tier-1 matchup flag: each line >= 5% past his season per-36 the same way, blend >= 15% past it, and a per-game gap at projected minutes of at least `floor`
const MATCHUP_RULE = { lineTol: 0.05, blendGap: 0.15, floor: { pts: 2.5, reb: 1.2, ast: 1, tpm: 0.5, stl: 0.4, blk: 0.4 } };
const SMALL_GP = 10;         // team-vs-position SMALL SAMPLE flag
const VS_SEASONS_BACK = 2;     // vs-team search window: current season + 2 prior
const MODEL = { hcaPerSide: 1.2, ratingPriorGames: 10, vacCapAdd: 8, vacCapMin: 38, blowoutStart: 10, blowoutPerPt: 0.5, blowoutMax: 4 };

/* Projection engine (minutes first, then rates; attempts first, then efficiency).
   Rated quantities are per-36 attempts/counts; points and threes come from attempts × shrunk shooting %. */
const QSTATS = ['fga', 'tpa', 'fta', 'reb', 'ast', 'stl', 'blk'];
const PROJ = {
  formK: 5,              // own form = (L5+L10)/2 shrunk toward season rate with weight n10/(n10+formK)
  oppPriorGames: 10,     // opponent positional factor shrunk toward 1 by GP/(GP+10)
  min: { l5: 0.5, l10: 0.3, season: 0.2 },   // recent-minutes blend (MODELED)
  rest: { b2bStarter: 1.5, b2bBench: 0.5, threeInFour: 0.5, starterMin: 28 },  // minutes cut on a back-to-back / 3-in-4 (MODELED)
  pace: { min: 0.9, max: 1.1 },               // pace factor bounds
  pct: { k3: 50, k2: 100, kft: 40, lg3: 100, lg2: 200, lgft: 50 },  // shrinkage priors in attempts
  def: { k: 5, cap: 0.10, minGames: 2 }       // defender in/out adjustment: shrink n/(n+5), cap ±10%, needs 2+ games
};

function per36q(rows, keys) {
  const m = sumBy(rows, 'min');
  if (!rows.length || !m) return null;
  const o = { min: m, n: rows.length };
  keys.forEach(k => o[k] = sumBy(rows, k) / m * 36);
  return o;
}
const shrinkPct = (made, att, prior, k) => (made + k * prior) / (att + k);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const sumBy = (a, k) => a.reduce((t, x) => t + (+x[k] || 0), 0);
const mean = a => a.length ? a.reduce((t, x) => t + x, 0) / a.length : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const isOut = st => !!st && /\bout\b|suspen/i.test(st);

function per36(rows) {
  const m = sumBy(rows, 'min');
  if (!rows.length || !m) return null;
  const o = { min: m, n: rows.length };
  STATS.forEach(s => o[s] = sumBy(rows, s) / m * 36);
  return o;
}
function rawAvg(rows) {
  if (!rows.length) return null;
  const o = { n: rows.length, min: sumBy(rows, 'min') / rows.length };
  STATS.forEach(s => o[s] = sumBy(rows, s) / rows.length);
  return o;
}
const shoot = rows => {
  const f = (m, a) => { const A = sumBy(rows, a); return A ? 100 * sumBy(rows, m) / A : null; };
  return { fg: f('fgm', 'fga'), tp: f('tpm', 'tpa'), ft: f('ftm', 'fta'), n: rows.length };
};
function usage(r) { // single game USG%
  if (!r.tMin || !r.min) return null;
  const den = r.tFga + 0.44 * r.tFta + r.tTov;
  if (!den) return null;
  return 100 * (r.fga + 0.44 * r.fta + r.tov) * (r.tMin / 5) / (r.min * den);
}

/* ---------- season index from box scores ---------- */

function indexSeason(raw) {
  const players = {}, teamGames = {};
  const boxes = Object.values(raw.boxes).sort((a, b) => a.date < b.date ? 1 : -1); // newest first
  for (const g of boxes) {
    const tids = Object.keys(g.teams);
    for (const tid of tids) {
      const oid = tids.find(x => x !== tid);
      const T = g.teams[tid], O = g.teams[oid];
      (teamGames[tid] = teamGames[tid] || []).push({ g, tid, oid, margin: T.pts - O.pts });
    }
    for (const p of g.players) {
      const oid = tids.find(x => x !== p.t);
      const T = g.teams[p.t], O = g.teams[oid];
      const pl = players[p.id] = players[p.id] || { id: p.id, name: p.n, posCounts: {}, games: [] };
      pl.posCounts[p.p] = (pl.posCounts[p.p] || 0) + 1;
      const r = {
        gid: g.id, date: g.d, season: raw.seasonYear, typ: 'RS', teamId: p.t, oppId: oid, margin: T.pts - O.pts, starter: p.st,
        min: p.min, pts: p.pts, reb: p.reb, ast: p.ast, tpm: p.tpm, stl: p.stl, blk: p.blk, tov: p.tov,
        fgm: p.fgm, fga: p.fga, tpa: p.tpa, ftm: p.ftm, fta: p.fta,
        tMin: T.min, tFga: T.fga, tFta: T.fta, tTov: T.tov
      };
      r.usg = usage(r);
      pl.games.push(r);
    }
  }
  for (const pl of Object.values(players)) {
    const listed = Object.entries(pl.posCounts).sort((a, b) => b[1] - a[1])[0][0];
    pl.listed = listed;
    Object.assign(pl, classifyPos(listed, pl.games));
  }
  return { players, teamGames };
}

function classifyPos(listed, games) {
  const L = (listed || '').toUpperCase();
  if (POS5.includes(L)) return { pos: L, posNote: 'ESPN listing' };
  const m = sumBy(games, 'min');
  const ast36 = m ? sumBy(games, 'ast') / m * 36 : 0, reb36 = m ? sumBy(games, 'reb') / m * 36 : 0;
  const thin = m < 40;
  const note = thin ? `ESPN lists "${L || '?'}"; PG/SG/SF/PF split defaulted (only ${Math.round(m)} min this season)` :
    `ESPN lists "${L || '?'}"; 5-position bucket inferred from box profile (AST/36 ${ast36.toFixed(1)}, REB/36 ${reb36.toFixed(1)})`;
  if (L === 'C') return { pos: 'C', posNote: 'ESPN listing' };
  // thresholds chosen so league minutes split roughly evenly across buckets (guards ~25% each, SF/PF/C ~15-18%)
  if (L === 'G') return { pos: !thin && ast36 >= 4.5 ? 'PG' : 'SG', posNote: note, inferred: true };
  if (L === 'F') return { pos: thin ? 'SF' : reb36 >= 10.5 ? 'C' : reb36 >= 7 ? 'PF' : 'SF', posNote: note, inferred: true };
  if (/^(G-F|F-G)$/.test(L)) return { pos: !thin && ast36 >= 4.5 ? 'SG' : 'SF', posNote: note, inferred: true };
  if (/^(F-C|C-F)$/.test(L)) return { pos: !thin && reb36 >= 10 ? 'C' : 'PF', posNote: note, inferred: true };
  return { pos: 'SF', posNote: note, inferred: true };
}

/* ---------- team-level: ratings, team-vs-position, scheme tags ---------- */

function teamContext(raw, idx) {
  const ratings = {}, tvp = {};
  for (const [tid, list] of Object.entries(idx.teamGames)) {
    let poss = 0, gmin = 0, pf = 0, pa = 0, opp3 = 0, oppPaint = 0;
    const posAgg = {};
    const AGG = [...new Set([...STATS, ...QSTATS])];
    POS5.forEach(P => { posAgg[P] = { min: 0 }; AGG.forEach(s => posAgg[P][s] = 0); });
    for (const { g, oid } of list) {
      const T = g.teams[tid], O = g.teams[oid];
      const pT = T.fga + 0.44 * T.fta - T.oreb + T.tov, pO = O.fga + 0.44 * O.fta - O.oreb + O.tov;
      poss += (pT + pO) / 2; gmin += T.min / 5; pf += T.pts; pa += O.pts; opp3 += O.tpm; oppPaint += O.paint;
      for (const p of g.players) {
        if (p.t !== oid) continue;
        const P = (idx.players[p.id] || {}).pos || 'SF';
        const a = posAgg[P];
        AGG.forEach(s => a[s] += p[s] || 0);
        a.min += p.min;
      }
    }
    const gp = list.length;
    ratings[tid] = { gp, pace: gmin ? poss / gmin * 48 : null, ortg: poss ? 100 * pf / poss : null, drtg: poss ? 100 * pa / poss : null,
      ppg: pf / gp, oppg: pa / gp, opp3: opp3 / gp, oppPaint: oppPaint / gp };
    tvp[tid] = { gp, poss };
    POS5.forEach(P => {
      const a = posAgg[P];
      tvp[tid][P] = { min: a.min / gp, per36: {}, sum: { min: a.min } };
      STATS.forEach(s => tvp[tid][P][s] = a[s] / gp);
      QSTATS.forEach(q => { tvp[tid][P].per36[q] = a.min ? a[q] / a.min * 36 : null; tvp[tid][P].sum[q] = a[q]; });
    });
  }
  const tids = Object.keys(ratings).filter(t => ratings[t].gp > 0);
  const lg = { pace: mean(tids.map(t => ratings[t].pace)), ortg: mean(tids.map(t => ratings[t].ortg)) };
  const rank = (key, desc) => {
    const s = [...tids].sort((a, b) => desc ? ratings[b][key] - ratings[a][key] : ratings[a][key] - ratings[b][key]);
    s.forEach((t, i) => ratings[t][key + 'Rank'] = i + 1);
  };
  rank('pace', true); rank('ortg', true); rank('drtg', false); // drtgRank 1 = best defense

  // league averages + ranks per position (rank 1 = allows the most)
  const tvpLg = {};
  POS5.forEach(P => {
    tvpLg[P] = { per36: {} };
    // pooled league rate per 36 minutes played at the position
    const lgMin = tids.reduce((x, t) => x + tvp[t][P].sum.min, 0);
    QSTATS.forEach(q => tvpLg[P].per36[q] = lgMin ? tids.reduce((x, t) => x + tvp[t][P].sum[q], 0) / lgMin * 36 : null);
    STATS.forEach(s => {
      tvpLg[P][s] = mean(tids.map(t => tvp[t][P][s]));
      [...tids].sort((a, b) => tvp[b][P][s] - tvp[a][P][s]).forEach((t, i) => tvp[t][P][s + 'Rank'] = i + 1);
    });
  });

  // scheme tags: team tendencies read off the team-vs-position panel (modeled buckets), each metric vs the league
  // average for the same buckets. Not defensive assignments or coverage schemes — box scores can't measure those.
  const grp = (t, Ps, s) => Ps.reduce((a, P) => a + tvp[t][P][s], 0);
  const tagLg = {};
  for (const d of TAG_DEFS) tagLg[d.tag] = Object.fromEntries(d.stats.map(s => [s, mean(tids.map(t => grp(t, d.Ps, s)))]));
  const tags = {}, tagChecks = {};
  for (const t of tids) {
    tags[t] = []; tagChecks[t] = [];
    for (const d of TAG_DEFS) {
      const metrics = d.stats.map(s => { const v = grp(t, d.Ps, s), L = tagLg[d.tag][s]; return { s, v, lg: L, pct: L ? v / L - 1 : 0 }; });
      const row = { tag: d.tag, label: d.label, metrics, fired: metrics.every(m => m.pct >= TAG_MIN_PCT), gp: ratings[t].gp };
      tagChecks[t].push(row);
      if (row.fired) tags[t].push(row);
    }
  }
  // league shooting, used as the prior when a player's own season sample is small
  let m3 = 0, a3 = 0, m2 = 0, a2 = 0, mft = 0, aft = 0;
  for (const pl of Object.values(idx.players)) for (const r of pl.games) {
    m3 += r.tpm; a3 += r.tpa; m2 += r.fgm - r.tpm; a2 += r.fga - r.tpa; mft += r.ftm; aft += r.fta;
  }
  lg.tp = a3 ? m3 / a3 : 0.36; lg.fg2 = a2 ? m2 / a2 : 0.53; lg.ft = aft ? mft / aft : 0.78;
  return { ratings, tvp, tvpLg, lg, tags, tagChecks };
}

/* Opponent positional factor for one rated quantity: what the opponent allows to this position per 100 possessions,
   relative to the league average for the position, shrunk toward 1 by GP/(GP+10). Full season, from box scores. */
function oppFactor(ctx, oid, P, q) {
  const t = ctx.tvp[oid], L = ctx.tvpLg[P];
  if (!t || !t.gp || !L || !L.per36[q] || t[P].per36[q] == null) return null;
  // per 36 position-minutes (removes how many minutes the opponent happened to face at this bucket), with the
  // opponent's own pace taken out because tonight's pace is applied separately
  const R = ctx.ratings[oid];
  const raw = t[P].per36[q] / L.per36[q] * (R && R.pace ? ctx.lg.pace / R.pace : 1);
  return { raw, f: 1 + (raw - 1) * t.gp / (t.gp + PROJ.oppPriorGames), gp: t.gp };
}

/* Defender matchup (MODELED — no tracking data is reachable): the likely defender is the opponent's top projected-minutes
   rotation player at this position tonight; the "usual" defender is the opponent's season minutes leader at the position.
   If the usual defender's status tonight differs from some past games, compare what the opponent allowed to the position
   per 100 possessions in games matching tonight (with / without him) vs the full season, shrunk and capped. */
function defenderInfo(idx, ctx, oid, P, O, cache) {
  const key = oid + ':' + P;
  if (cache[key]) return cache[key];
  const games = idx.teamGames[oid] || [];
  const mins = {};
  for (const { g } of games) for (const p of g.players) if (p.t === oid && (idx.players[p.id] || {}).pos === P) {
    const x = mins[p.id] = mins[p.id] || { id: p.id, name: p.n, min: 0, gp: 0 }; x.min += p.min; x.gp++;
  }
  const usual = Object.values(mins).sort((a, b) => b.min - a.min)[0] || null;
  const pick = Ps => O.rotation.filter(x => Ps.includes(x.pl.pos)).sort((a, b) => b.baseMin - a.baseMin)[0];
  const lk = pick([P]) || pick(ADJ[P] || []);
  const likely = lk ? { id: lk.pid, name: lk.r.name, pos: lk.pl.pos, samePos: lk.pl.pos === P } : null;
  const res = { P, usual, likely, usualOut: false, adj: null, reason: '' };
  if (!usual) { res.reason = `no ${P} has played for this opponent yet`; return cache[key] = res; }
  const listedOut = O.outs.some(v => v.pid === usual.id), inRot = O.rotation.some(x => x.pid === usual.id);
  res.usualOut = listedOut || !inRot;
  res.usualStatus = listedOut ? 'OUT tonight' : !inRot ? 'not in tonight\'s projected rotation' : 'in tonight';
  const played = new Set(games.filter(({ g }) => g.players.some(p => p.t === oid && p.id === usual.id)).map(({ g }) => g.id));
  const subset = games.filter(({ g }) => res.usualOut ? !played.has(g.id) : played.has(g.id));
  const nSub = subset.length;
  res.nWith = played.size; res.nWithout = games.length - played.size;
  if (nSub === games.length) { res.reason = res.usualOut ? `no games without him to compare` : `he played every game, so the season factor already reflects him`; return cache[key] = res; }
  if (nSub < PROJ.def.minGames) { res.reason = `only n=${nSub} game${nSub === 1 ? '' : 's'} ${res.usualOut ? 'without' : 'with'} him — too few to adjust`; return cache[key] = res; }
  const perPos36 = (list, q) => { // allowed per 36 minutes at the position
    let m = 0, v = 0;
    for (const { g } of list) for (const p of g.players) if (p.t !== oid && (idx.players[p.id] || {}).pos === P) { v += p[q] || 0; m += p.min; }
    return m ? v / m * 36 : null;
  };
  res.adj = {};
  for (const q of QSTATS) {
    const sub = perPos36(subset, q), all = perPos36(games, q);
    res.adj[q] = sub != null && all ? clamp(1 + (sub / all - 1) * nSub / (nSub + PROJ.def.k), 1 - PROJ.def.cap, 1 + PROJ.def.cap) : 1;
  }
  res.reason = `${res.usualStatus}: opponent allowed ${P}s ${(() => { const v = Math.round(((perPos36(subset, "fga") || 0) / (perPos36(games, "fga") || 1) - 1) * 100); return (v >= 0 ? '+' : '') + v; })()}% FGA per 36 position-minutes in the ${nSub} game${nSub === 1 ? '' : 's'} ${res.usualOut ? 'without' : 'with'} him vs the full season (shrunk n/(n+${PROJ.def.k}), capped ±${PROJ.def.cap * 100}%)`;
  return cache[key] = res;
}

function gamePace(game, proj, ctx) {
  if (!proj) return null;
  const mkt = game.odds && game.odds.total != null ? game.odds.total : null;
  return { pace: mkt ? proj.pace * mkt / proj.total : proj.pace, source: mkt ? 'market' : 'model', total: mkt != null ? mkt : proj.total, modelPace: proj.pace };
}

function projectScore(game, ctx) {
  const A = ctx.ratings[game.away], H = ctx.ratings[game.home];
  if (!A || !H || !A.gp || !H.gp) return null;
  // small samples regressed toward league average: weight GP / (GP + prior)
  const reg = (t, k, lg) => lg + (t[k] - lg) * t.gp / (t.gp + MODEL.ratingPriorGames);
  const pace = reg(A, 'pace', ctx.lg.pace) * reg(H, 'pace', ctx.lg.pace) / ctx.lg.pace;
  const away = (reg(A, 'ortg', ctx.lg.ortg) * reg(H, 'drtg', ctx.lg.ortg) / ctx.lg.ortg) * pace / 100 - MODEL.hcaPerSide;
  const home = (reg(H, 'ortg', ctx.lg.ortg) * reg(A, 'drtg', ctx.lg.ortg) / ctx.lg.ortg) * pace / 100 + MODEL.hcaPerSide;
  return { away, home, total: away + home, margin: home - away, pace };
}

function parseSpread(details, teams, game) {
  if (!details) return null;
  if (/^(even|pk|pick)/i.test(details.trim())) return { fav: null, pts: 0 };
  const m = details.match(/^([A-Z]{2,4})\s*([-+]?\d+(\.\d+)?)/i);
  if (!m) return null;
  const ab = m[1].toUpperCase();
  const fav = [game.home, game.away].find(t => teams[t].abbr.toUpperCase() === ab);
  return fav ? { fav, pts: Math.abs(+m[2]) } : null;
}

/* ---------- per-team: rotation, outs, vacated minutes ---------- */

function teamStatus(raw, tid) {
  const map = {};
  for (const r of raw.rosters[tid] || []) {
    const feed = raw.injFeed[r.id];
    const status = (r.inj && r.inj.status) || (feed && feed.status) || null;
    map[r.id] = { ...r, status, comment: feed ? feed.short : '' };
  }
  return map;
}

function buildTeam(raw, idx, tid, D) {
  const roster = teamStatus(raw, tid);
  const tg = (idx.teamGames[tid] || []);
  const last5 = tg.slice(0, 5);
  const last5ids = new Set(last5.map(x => x.g.id));
  const info = [];
  for (const [pid, r] of Object.entries(roster)) {
    const pl = idx.players[pid];
    const games = pl ? pl.games : [];
    const own5 = games.slice(0, 5);
    const apps = games.filter(x => last5ids.has(x.gid) && x.teamId === tid);
    const appMin = apps.length ? sumBy(apps, 'min') / apps.length : 0;
    const seasonMin = games.length ? sumBy(games, 'min') / games.length : 0;
    // recent minutes (before rest / injuries / game script): L5, L10 and season averages of games played, blended
    const avgMin = rows => rows.length ? sumBy(rows, 'min') / rows.length : null;
    const m5 = avgMin(own5), m10 = avgMin(games.slice(0, 10));
    const baseMin = m5 == null ? 0 : PROJ.min.l5 * m5 + PROJ.min.l10 * m10 + PROJ.min.season * seasonMin;
    const returning = !apps.length && games.length >= 1 && seasonMin >= 20;
    const real = (apps.length >= 2 && appMin >= 10) || (apps.length === 1 && appMin >= 15) || returning;
    info.push({ pid, r, pl, own5, apps, appMin, baseMin, seasonMin, returning, real, lastPlayed: games[0] ? games[0].date : null });
  }
  const outs = info.filter(x => isOut(x.r.status));
  const avail = info.filter(x => !isOut(x.r.status) && x.real && x.pl).sort((a, b) => b.baseMin - a.baseMin);
  const rotation = avail.slice(0, 9);
  const nG = Math.max(1, last5.length);

  // vacated minutes from OUT players: only the share not already reflected in teammates' recent minutes
  const vac = outs.map(x => {
    const frac = x.apps.length / nG;
    const prod = {};
    MAIN.forEach(s => prod[s] = x.apps.length ? sumBy(x.apps, s) / x.apps.length * frac : 0);
    return { pid: x.pid, name: x.r.name, status: x.r.status, comment: x.r.comment, pos: x.pl ? x.pl.pos : (x.r.pos || '?'),
      appMin: x.appMin, apps: x.apps.length, nG, min: x.appMin * frac, prod, lastPlayed: x.lastPlayed };
  });
  const vacTotal = vac.reduce((t, v) => t + v.min, 0);

  // distribute: same position → adjacent positions → any rotation player; capped; remainder stays unallocated
  const add = {};
  rotation.forEach(x => add[x.pid] = 0);
  const cap = x => Math.max(0, Math.min(MODEL.vacCapAdd - add[x.pid], MODEL.vacCapMin - x.baseMin - add[x.pid]));
  let remaining = vacTotal;
  const vacPositions = new Set(vac.filter(v => v.min > 0).map(v => v.pos));
  const passes = [
    x => vacPositions.has(x.pl.pos),
    x => [...vacPositions].some(P => (ADJ[P] || []).includes(x.pl.pos)),
    () => true
  ];
  for (const ok of passes) {
    for (let it = 0; it < 20 && remaining > 0.05; it++) {
      const el = rotation.filter(x => ok(x) && cap(x) > 0.05);
      if (!el.length) break;
      const share = remaining / el.length;
      for (const x of el) { const g = Math.min(share, cap(x)); add[x.pid] += g; remaining -= g; }
    }
  }
  const placed = vacTotal - Math.max(0, remaining);

  // Injuries move minutes, not rates: no usage bump. (`bump` kept empty so older readers of the card still work.)
  const bump = {};
  rotation.forEach(x => bump[x.pid] = {});

  const nonRotationOut = vac.filter(v => v.min <= 0.05);
  return {
    tid, roster, last5, rotation, outs: vac, vacTotal, placed, unallocated: Math.max(0, remaining), add, bump,
    realCount: avail.length, nonRotationOut, returning: rotation.filter(x => x.returning)
  };
}

function restInfo(raw, tid, D) {
  const prior = (raw.schedByTeam[tid] || []).filter(d => d < D).sort();
  const prev = prior[prior.length - 1];
  if (!prev) return { rest: null, b2b: false, threeInFour: false, prev: null };
  const rest = dayDiff(D, prev) - 1;
  const inLast3 = prior.filter(d => dayDiff(D, d) <= 3).length;
  return { rest, b2b: rest === 0, threeInFour: inLast3 >= 2, prev };
}

/* ---------- player lines ---------- */

function oppKeyPlayers(idx, oid) {
  const tot = {};
  for (const { g } of (idx.teamGames[oid] || [])) for (const p of g.players) if (p.t === oid) {
    const x = tot[p.id] = tot[p.id] || { id: p.id, name: p.n, min: 0, gp: 0 }; x.min += p.min; x.gp++;
  }
  return Object.values(tot).filter(x => x.gp >= 3).sort((a, b) => b.min - a.min).slice(0, 3);
}

function outlierNotes(rows) {
  const notes = [];
  if (rows.length < 4) return notes;
  for (const s of MAIN) {
    const vals = rows.map(r => r[s]);
    const hi = Math.max(...vals), k = vals.indexOf(hi);
    const others = vals.filter((_, i) => i !== k);
    const med = median(others);
    if (hi - med >= { pts: 8, reb: 4, ast: 3, tpm: 2 }[s] && hi >= 1.75 * Math.max(med, { pts: 8, reb: 3, ast: 2, tpm: 1.5 }[s])) {
      notes.push(`${SL[s]} log inflated by one game: ${rows[k].name.split(' ').slice(-1)[0]} ${hi} on ${rows[k].date.slice(5)} — avg ${mean(vals).toFixed(1)} incl., ${mean(others).toFixed(1)} without it`);
    }
  }
  return notes;
}

function oppPosLog(idx, oid, P, cache, tonightOut) {
  const key = oid + ':' + P;
  if (cache[key]) return cache[key];
  const keys = oppKeyPlayers(idx, oid);
  const rows = [];
  for (const { g, margin } of (idx.teamGames[oid] || []).slice(0, 5)) {
    const cands = g.players.filter(p => p.t !== oid && (idx.players[p.id] || {}).pos === P).sort((a, b) => b.min - a.min);
    const absent = keys.filter(k => !g.players.some(p => p.t === oid && p.id === k.id)).map(k => k.name);
    if (!cands.length) { rows.push({ date: g.d, gid: g.id, missing: true, absent }); continue; }
    const p = cands[0];
    rows.push({ date: g.d, gid: g.id, pid: p.id, name: p.n, teamId: p.t, min: p.min, pts: p.pts, reb: p.reb, ast: p.ast, tpm: p.tpm, stl: p.stl, blk: p.blk,
      margin: -margin, blowout: Math.abs(margin) >= BLOWOUT, shortMin: p.min < 20, absent, others: cands.length - 1 });
  }
  const used = rows.filter(r => !r.missing);
  // each opposing player's own season rate excluding this game, so the log can be read as "above/below their norm"
  for (const r of used) {
    const pg = (idx.players[r.pid] || { games: [] }).games.filter(x => x.gid !== r.gid);
    const m = sumBy(pg, 'min');
    if (m < 60) continue;
    r.exp = {};
    STATS.forEach(s => r.exp[s] = sumBy(pg, s) / m * r.min);
  }
  const normed = used.filter(r => r.exp);
  const vsNorm = {};
  STATS.forEach(s => {
    const a = sumBy(normed, s), e = normed.reduce((t, r) => t + r.exp[s], 0);
    vsNorm[s] = normed.length ? { n: normed.length, diff: (a - e) / normed.length, ratio: e ? a / e : null,
      above: normed.filter(r => r[s] >= r.exp[s] * 1.15 && r[s] - r.exp[s] >= NORM_FLOOR[s]).length,
      below: normed.filter(r => r[s] <= r.exp[s] * 0.85 && r.exp[s] - r[s] >= NORM_FLOOR[s]).length } : null;
  });
  const summary = {};
  STATS.forEach(s => {
    const v = used.map(r => r[s]);
    summary[s] = { avg: mean(v), med: median(v), hi: v.length ? Math.max(...v) : null, lo: v.length ? Math.min(...v) : null,
      hits: HITS[P][s].map(t => ({ t, k: v.filter(x => x >= t).length })) };
  });
  const flags = outlierNotes(used);
  const blow = used.filter(r => r.blowout);
  if (blow.length) flags.push(`${blow.length} game${blow.length > 1 ? 's' : ''} decided by ${BLOWOUT}+ (${blow.map(r => r.date.slice(5)).join(', ')}) — raw totals there reflect cut minutes; per-36 corrects volume, not role`);
  const absentGames = used.filter(r => r.absent.length);
  if (absentGames.length) flags.push(`Opponent's top-minute players missing in ${absentGames.length} of these games: ${absentGames.map(r => r.date.slice(5) + ' (' + r.absent.map(n => n.split(' ').slice(-1)[0]).join(', ') + ')').join('; ')}`);
  const tonightMissing = keys.filter(k => tonightOut.has(k.id));
  if (tonightMissing.length) {
    const playedIn = tonightMissing.map(k => `${k.name} (OUT tonight; played ${used.filter(r => !r.absent.includes(k.name)).length}/${used.length} of these)`);
    flags.push(`Tonight differs from the log: ${playedIn.join('; ')} — log may understate what this team allows tonight`);
  }
  if (rows.some(r => r.missing)) flags.push(`${rows.filter(r => r.missing).length} game(s) had no opposing player bucketed at ${P} — n reduced, not filled`);
  const res = { rows, used, summary, vsNorm, p36: per36(used), flags, n: used.length, keys };
  cache[key] = res;
  return res;
}

function seasonMpg(rows, season, teamId) {
  const r = rows.filter(x => x.season === season && x.typ === 'RS' && (!teamId || x.teamId === teamId));
  return r.length ? sumBy(r, 'min') / r.length : null;
}
const seasonLabel = y => `${y - 1}-${String(y).slice(2)}`;

function vsTeamLine(raw, pl, gl, tid, oid, curMpg) {
  const cur = pl.games.map(r => ({ ...r }));
  const prior = (gl || []).filter(r => r.season >= raw.seasonYear - VS_SEASONS_BACK && r.season < raw.seasonYear);
  const all = [...cur, ...prior];
  const meetings = all.filter(r => r.oppId === oid).sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 5);
  for (const r of meetings) {
    const smpg = r.season === raw.seasonYear ? curMpg : seasonMpg(all, r.season, r.teamId);
    r.seasonMpg = smpg;
    if (r.teamId !== tid) { r.seg = 'prior'; r.segLabel = `With ${raw.teams[r.teamId] ? raw.teams[r.teamId].abbr : 'prior club'}`; }
    else if (smpg != null && curMpg && Math.abs(smpg - curMpg) >= ROLE_MPG_SHIFT) { r.seg = 'role'; r.segLabel = `${seasonLabel(r.season)} role (${smpg.toFixed(0)} mpg then vs ${curMpg.toFixed(0)} now)`; }
    else r.seg = 'current';
  }
  const curRows = meetings.filter(r => r.seg === 'current');
  const segs = [];
  const cr = curRows; if (cr.length) segs.push({ key: 'current', label: 'Current role (blended)', rows: cr, p36: per36(cr) });
  const groups = {};
  for (const r of meetings.filter(r => r.seg !== 'current')) (groups[r.segLabel] = groups[r.segLabel] || []).push(r);
  for (const [label, rows] of Object.entries(groups)) segs.push({ key: 'split', label: label + ' — split out, not blended', rows, p36: per36(rows) });
  return { meetings, cur: curRows, p36: per36(curRows), n: curRows.length, total: meetings.length, segs, priorAvailable: !!gl };
}

function ratesBlock(pl) {
  const g = pl.games;
  const l5 = g.slice(0, 5), l10 = g.slice(0, 10);
  const m5 = sumBy(l5, 'min');
  const usgRows = l5.filter(r => r.usg != null);
  return {
    usg5: usgRows.length ? usgRows.reduce((t, r) => t + r.usg * r.min, 0) / sumBy(usgRows, 'min') : null,
    fga36: m5 ? sumBy(l5, 'fga') / m5 * 36 : null, tpa36: m5 ? sumBy(l5, 'tpa') / m5 * 36 : null, fta36: m5 ? sumBy(l5, 'fta') / m5 * 36 : null,
    fgaPg: l5.length ? sumBy(l5, 'fga') / l5.length : null, tpaPg: l5.length ? sumBy(l5, 'tpa') / l5.length : null,
    s5: shoot(l5), s10: shoot(l10), sSeason: shoot(g)
  };
}

/* ---------- the board ---------- */

function buildBoard(raw, gamelogs) {
  const D = raw.D;
  const idx = raw._idx || indexSeason(raw);
  const ctx = raw._ctx || teamContext(raw, idx);
  const logCache = {}, defCache = {};
  const games = [];
  for (const game of raw.slate) {
    const proj = projectScore(game, ctx);
    const spread = game.odds ? parseSpread(game.odds.details, raw.teams, game) : null;
    const scriptMargin = spread ? spread.pts : (proj ? Math.abs(proj.margin) : 0);
    const scriptSource = spread ? 'market spread' : 'model margin';
    const trim = scriptMargin >= MODEL.blowoutStart ? Math.min(MODEL.blowoutMax, (scriptMargin - MODEL.blowoutStart + 1) * MODEL.blowoutPerPt) : 0;
    const sides = {};
    const pace = gamePace(game, proj, ctx);
    const teamsBuilt = { [game.home]: raw._teams[game.home], [game.away]: raw._teams[game.away] };
    for (const tid of [game.away, game.home]) {
      const oid = tid === game.home ? game.away : game.home;
      const T = teamsBuilt[tid], O = teamsBuilt[oid];
      const rest = restInfo(raw, tid, D);
      const tonightOutOpp = new Set(O.outs.map(v => v.pid));
      const starters = new Set(T.rotation.slice(0, 5).map(x => x.pid));
      const cards = T.rotation.map(x => {
        const pl = x.pl;
        const own5 = x.own5;
        const vt = vsTeamLine(raw, pl, gamelogs[pl.id], tid, oid, x.baseMin);
        const log = oppPosLog(idx, oid, pl.pos, logCache, tonightOutOpp);
        const l5p36 = per36(own5);
        const vac = T.add[x.pid] || 0;
        const tr = starters.has(x.pid) ? trim : 0;
        const big = x.baseMin >= PROJ.rest.starterMin;
        const restCut = rest.b2b ? (big ? PROJ.rest.b2bStarter : PROJ.rest.b2bBench) : rest.threeInFour && big ? PROJ.rest.threeInFour : 0;
        const finalMin = Math.max(0, x.baseMin + vac - tr - restCut);
        const st = x.r.status;
        const priorClubInL5 = own5.filter(r => r.teamId !== tid).length;
        const yesterday = rest.b2b ? pl.games.find(r => r.date === rest.prev) : null;

        // ---- the three inputs, per 36 (rated quantities) ----
        const KEYS = [...new Set([...QSTATS, ...STATS])];
        const l10 = pl.games.slice(0, 10);
        const l5q = per36q(own5, KEYS), l10q = per36q(l10, KEYS), seasonQ = per36q(pl.games, KEYS);
        let own = null;
        if (l5q) {
          const lam = l10.length / (l10.length + PROJ.formK);
          own = {};
          KEYS.forEach(k => own[k] = lam * (0.5 * l5q[k] + 0.5 * l10q[k]) + (1 - lam) * seasonQ[k]);
          own.lam = lam;
        }
        const vtq = vt.n ? per36q(vt.cur, KEYS) : null;
        const def = defenderInfo(idx, ctx, oid, pl.pos, O, defCache);
        let op = null, opFactors = null;
        if (own && ctx.tvp[oid] && ctx.tvp[oid].gp) {
          op = {}; opFactors = {};
          for (const q of QSTATS) {
            const f = oppFactor(ctx, oid, pl.pos, q);
            const d = def.adj ? def.adj[q] : 1;
            opFactors[q] = { season: f ? f.f : 1, raw: f ? f.raw : null, def: d, total: (f ? f.f : 1) * d };
            op[q] = own[q] * opFactors[q].total;
          }
        }
        // ---- shooting: L10 shrunk toward his season %, season shrunk toward league if his sample is small ----
        const S = rows => ({ m3: sumBy(rows, 'tpm'), a3: sumBy(rows, 'tpa'), m2: sumBy(rows, 'fgm') - sumBy(rows, 'tpm'), a2: sumBy(rows, 'fga') - sumBy(rows, 'tpa'), mft: sumBy(rows, 'ftm'), aft: sumBy(rows, 'fta') });
        const sz = S(pl.games), s10 = S(l10);
        const season3 = shrinkPct(sz.m3, sz.a3, ctx.lg.tp, PROJ.pct.lg3), season2 = shrinkPct(sz.m2, sz.a2, ctx.lg.fg2, PROJ.pct.lg2), seasonFt = shrinkPct(sz.mft, sz.aft, ctx.lg.ft, PROJ.pct.lgft);
        const eff = {
          tp: shrinkPct(s10.m3, s10.a3, season3, PROJ.pct.k3), fg2: shrinkPct(s10.m2, s10.a2, season2, PROJ.pct.k2), ft: shrinkPct(s10.mft, s10.aft, seasonFt, PROJ.pct.kft),
          raw10: { tp: s10.a3 ? s10.m3 / s10.a3 : null, fg2: s10.a2 ? s10.m2 / s10.a2 : null, ft: s10.aft ? s10.mft / s10.aft : null, a3: s10.a3, a2: s10.a2, aft: s10.aft, n: l10.length },
          rawSeason: { tp: sz.a3 ? sz.m3 / sz.a3 : null, fg2: sz.a2 ? sz.m2 / sz.a2 : null, ft: sz.aft ? sz.mft / sz.aft : null, a3: sz.a3, a2: sz.a2, aft: sz.aft },
          season: { tp: season3, fg2: season2, ft: seasonFt }
        };
        // implied per-36 of the six stats for an input's attempt/count rates (points & threes via attempts × efficiency)
        const implied = q => q && {
          fga: q.fga, tpa: Math.min(q.tpa, q.fga), fta: q.fta,
          tpm: Math.min(q.tpa, q.fga) * eff.tp,
          pts: 2 * Math.max(0, q.fga - q.tpa) * eff.fg2 + 3 * Math.min(q.tpa, q.fga) * eff.tp + q.fta * eff.ft,
          reb: q.reb, ast: q.ast, stl: q.stl, blk: q.blk
        };
        const teamPace = ctx.ratings[tid] && ctx.ratings[tid].pace;
        const paceFactor = pace && teamPace ? clamp(pace.pace / teamPace, PROJ.pace.min, PROJ.pace.max) : 1;
        return {
          pid: x.pid, name: x.r.name, pos: pl.pos, posNote: pl.posNote, posInferred: !!pl.inferred, tid, oid, oppAbbr: raw.teams[oid].abbr,
          status: st && !isOut(st) ? st : null, statusComment: x.r.comment,
          baseMin: x.baseMin, vacMin: vac, trimMin: tr, restCut, finalMin, bump: T.bump[x.pid] || {},
          minParts: { l5: own5.length ? sumBy(own5, 'min') / own5.length : null, l10: l10.length ? sumBy(l10, 'min') / l10.length : null, season: x.seasonMin, n5: own5.length, n10: l10.length, nSeason: pl.games.length },
          returning: x.returning, lastPlayed: x.lastPlayed, priorClubInL5,
          own5, l5p36, l5raw: rawAvg(own5), season36: per36(pl.games), rates: ratesBlock(pl),
          own10: l10, l10q, seasonQ, inputs: { vt: implied(vtq), own: implied(own), op: implied(op) }, rawInputs: { vt: vtq, own, op }, opFactors, ownLam: own ? own.lam : null,
          eff, def, pace, paceFactor, teamPace,
          vt, log, rest, yesterdayMin: yesterday ? yesterday.min : null,
          oppRating: ctx.ratings[oid], oppTvp: ctx.tvp[oid] && ctx.tvp[oid][pl.pos], tvpLg: ctx.tvpLg[pl.pos]
        };
      });
      sides[tid] = { tid, oid, team: raw.teams[tid], T, rest, cards, tags: ctx.tags[tid] || [], tagChecks: ctx.tagChecks[tid] || [], rating: ctx.ratings[tid], tvp: ctx.tvp[tid] };
    }
    games.push({ ...game, proj, pace, spread, scriptMargin, scriptSource, trim, sides });
  }
  return { D, games, ctx, teams: raw.teams, fetchedAt: raw.fetchedAt, seasonYear: raw.seasonYear, boxCount: Object.keys(raw.boxes).length };
}

function prepareTeams(raw) {
  raw._idx = indexSeason(raw);
  raw._ctx = teamContext(raw, raw._idx);
  raw._teams = {};
  for (const g of raw.slate) for (const tid of [g.home, g.away]) raw._teams[tid] = buildTeam(raw, raw._idx, tid, raw.D);
  const pids = new Set();
  for (const T of Object.values(raw._teams)) T.rotation.forEach(x => pids.add(x.pid));
  return [...pids];
}

/* ---------- per-render (weights are live) ---------- */

/* Weight keys: vt = vs this team, l5 = own form (L5 + L10 shrunk toward season; key kept for compatibility),
   op = opponent positional (full season). Everything is linear in the inputs, so the blended projection equals
   the weighted average of each input's own projection — which is what the daily log grades. */
const BLEND_KEYS = [['vt', 'vt'], ['l5', 'own'], ['op', 'op']];
const PROJ_KEYS = ['pts', 'reb', 'ast', 'tpm', 'stl', 'blk', 'fga', 'tpa', 'fta'];

function blendCard(c, w) {
  const lines = BLEND_KEYS.map(([k, ik]) => ({ k, w: w[k], r: c.inputs[ik] }));
  const live = lines.filter(l => l.r && l.w > 0);
  const W = live.reduce((t, l) => t + l.w, 0);
  const b36 = {}, base = {}, adj = {}, noPace = {}, inputProj = {};
  for (const [k, ik] of BLEND_KEYS) {
    const r = c.inputs[ik];
    inputProj[k] = r ? Object.fromEntries(PROJ_KEYS.map(s => [s, r[s] * c.finalMin / 36 * c.paceFactor])) : null;
  }
  PROJ_KEYS.forEach(s => {
    b36[s] = W ? live.reduce((t, l) => t + l.w * l.r[s], 0) / W : null;
    base[s] = b36[s] == null ? null : b36[s] * c.baseMin / 36 * c.paceFactor;
    adj[s] = b36[s] == null ? null : b36[s] * c.finalMin / 36 * c.paceFactor;
    noPace[s] = b36[s] == null ? null : b36[s] * c.finalMin / 36;
  });
  const used = {};
  live.forEach(l => used[l.k] = Math.round(100 * l.w / W));
  const adjusted = c.vacMin > 0.05 || c.trimMin > 0 || c.restCut > 0;
  return { b36, base, adj, noPace, inputProj, used, adjusted, renormalized: lines.some(l => !l.r && l.w > 0) };
}

function cardNotes(c) {
  const notes = [];
  const vt = c.inputs.vt, l5 = c.inputs.own, op = c.inputs.op;
  // consistency / divergence on the main four
  const consistent = [], diverge = [];
  for (const s of MAIN) {
    const vals = [vt, l5, op].filter(Boolean).map(r => r[s]);
    if (vals.length === 3) {
      const hi = Math.max(...vals), lo = Math.min(...vals);
      if (hi - lo < ABS_FLOOR[s] || (lo > 0 && hi / lo <= 1.25)) consistent.push(`${SL[s]} ${vals.map(v => v.toFixed(1)).join(' / ')}`);
    }
    if (vt && l5) {
      const a = vt[s], b = l5[s];
      const big = Math.abs(a - b) >= ABS_FLOOR[s] && (b === 0 || a / b >= 1.35 || a / b <= 0.74);
      if (big) diverge.push(`${SL[s]} ${a.toFixed(1)} vs ${b.toFixed(1)} (${a > b ? 'above' : 'below'})`);
    }
  }
  if (consistent.length) notes.push({ kind: 'con', text: `Consistent across all three inputs (vs-team / own form / opp positional, per 36): ${consistent.join(' · ')} — strengthens the projection.` });
  if (diverge.length) notes.push({ kind: 'div', text: `Vs-team line diverges from current form (per 36): ${diverge.join(', ')}. ${divergenceReasons(c)}` });
  for (const seg of c.vt.segs.filter(s => s.key === 'split')) notes.push({ kind: 'split', text: `${seg.rows.length} meeting(s) ${seg.label.split(' — ')[0]} shown separately and kept out of the blend (role/club change).` });
  return notes;
}

function divergenceReasons(c) {
  const r = [];
  const rows = c.vt.cur;
  if (rows.length < 3) r.push(`only n=${rows.length} current-role meeting${rows.length === 1 ? '' : 's'} — weak evidence`);
  const blow = rows.filter(x => x.margin != null && Math.abs(x.margin) >= BLOWOUT);
  if (blow.length) r.push(`${blow.length} meeting(s) were ${BLOWOUT}+ point games (${blow.map(x => x.date).join(', ')})`);
  const short = rows.filter(x => x.min < 20);
  if (short.length) r.push(`${short.length} short-minute meeting(s) (<20 min) inflate/deflate per-36`);
  const curSeason = c.own5.length ? c.own5[0].season : null;
  const seasons = [...new Set(rows.map(x => x.season))];
  if (seasons.some(y => y !== curSeason)) {
    const mp = rows.filter(x => x.seasonMpg != null && x.season !== curSeason).map(x => `${seasonLabel(x.season)} ${x.seasonMpg.toFixed(0)} mpg`);
    r.push(`sample includes ${seasons.filter(y => y !== curSeason).map(seasonLabel).join(', ')} (${[...new Set(mp)].join(', ')} vs ${c.baseMin.toFixed(0)} now) — teammates and the defenders he saw then may differ`);
  }
  const outNow = c.log.keys.filter(k => c.log.flags.some(f => f.includes(k.name) && f.includes('OUT tonight')));
  if (outNow.length) r.push(`opponent is without ${outNow.map(k => k.name).join(', ')} tonight — present in some past meetings`);
  if (!r.length) r.push('no role, minutes, blowout or roster explanation in the data — could be matchup-specific or noise');
  return 'Why it may be real or stale: ' + r.join('; ') + '.';
}

/* Tier 1 — MATCHUP FLAG: tonight's three lines all point the same way vs his season per-36 rate and the
   blended gap is clear after minutes/context adjustments. No pattern history required. */
function matchupSignal(c, s, bl) {
  const R = c.season36 && c.season36[s];
  if (R == null || !c.vt.n || !c.log.n || !c.own5.length || bl.b36[s] == null) return null;
  const l5 = c.l5p36[s];
  // vs-team: current-role meetings per 36, blowouts dropped when other meetings remain
  const calm = c.vt.cur.filter(r => r.margin == null || Math.abs(r.margin) < BLOWOUT);
  const vtRows = calm.length ? calm : c.vt.cur;
  const vt = per36(vtRows)[s];
  // opponent log: each opposing player vs his own norm, and still true without its single most extreme game
  const normed = c.log.used.filter(r => r.exp);
  if (!normed.length) return null;
  const ratio = rows => { const e = rows.reduce((t, r) => t + r.exp[s], 0); return e ? sumBy(rows, s) / e : null; };
  const full = ratio(normed);
  const ex = normed.length > 1 ? [...normed].sort((a, b) => Math.abs(b[s] - b.exp[s]) - Math.abs(a[s] - a.exp[s])).slice(1) : normed;
  const robust = ratio(ex);
  if (full == null || robust == null) return null;
  const T = MATCHUP_RULE;
  const gapPg = (bl.b36[s] - R) * c.finalMin / 36;
  const b = bl.b36[s] / (R || 1e-9);
  let dir = null;
  if (l5 >= R && vt >= R * (1 + T.lineTol) && full >= 1 + T.lineTol && robust >= 1 + T.lineTol && b >= 1 + T.blendGap && gapPg >= T.floor[s]) dir = 'up';
  if (l5 <= R && vt <= R * (1 - T.lineTol) && full <= 1 - T.lineTol && robust <= 1 - T.lineTol && b <= 1 - T.blendGap && -gapPg >= T.floor[s]) dir = 'down';
  if (!dir) return null;
  const pct = v => `${v >= 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`;
  return { dir, text: `all three lines ${dir === 'up' ? 'above' : 'below'} his season ${R.toFixed(1)}/36 — own L5 ${l5.toFixed(1)}, vs ${c.oppAbbr} ${vt.toFixed(1)} (n=${vtRows.length}${vtRows.length < c.vt.cur.length ? ', blowouts excluded' : ''}), ${c.oppAbbr} vs ${c.pos}s ${pct(full)} on their norm (${pct(robust)} without its most extreme game) → blend ${bl.b36[s].toFixed(1)}/36 (${pct(b)}, ${gapPg >= 0 ? '+' : ''}${gapPg.toFixed(1)} at ${c.finalMin.toFixed(0)} min)` };
}

/* Tier 2 — PATTERN: the gap repeated in 3+ separate matchups and most of the sample (rule unchanged). */
function patternSignals(c) {
  const l5 = c.l5p36;
  const strong = {};
  const push = (s, o) => (strong[s] = strong[s] || []).push(o);
  const need = n => Math.max(3, Math.ceil(0.75 * n)); // repeats in >=3 separate games and most of the sample (4 of 5)
  for (const s of STATS) {
    const base = l5[s];
    // opponent positional log, read against each opposing player's own norm (so bench-vs-starter role gaps don't count)
    const N = c.log.vsNorm && c.log.vsNorm[s];
    if (N && N.n >= 3 && N.ratio != null) {
      const pct = `${N.ratio >= 1 ? '+' : ''}${Math.round((N.ratio - 1) * 100)}%`;
      const gap = c.log.p36 ? ` · log ${c.log.p36[s].toFixed(1)}/36 vs his ${base.toFixed(1)}/36` : '';
      if (N.above >= need(N.n) && N.ratio >= 1.2 && N.diff >= NORM_FLOOR[s] * 0.67)
        push(s, { dir: 'up', text: `${c.oppAbbr} let ${N.above}/${N.n} opposing ${c.pos}s beat their own ${SL[s]} norm (${pct}, ${N.diff >= 0 ? '+' : ''}${N.diff.toFixed(1)}/g)${gap}` });
      if (N.below >= need(N.n) && N.ratio <= 0.8 && -N.diff >= NORM_FLOOR[s] * 0.67)
        push(s, { dir: 'down', text: `${c.oppAbbr} held ${N.below}/${N.n} opposing ${c.pos}s under their own ${SL[s]} norm (${pct}, ${N.diff.toFixed(1)}/g)${gap}` });
    }
    // vs-team history: repetition across >=3 separate meetings
    if (c.vt.n >= 3) {
      const per = c.vt.cur.map(r => r.min ? r[s] / r.min * 36 : 0);
      const above = per.filter(v => v >= base * 1.25 && v - base >= ABS_FLOOR[s]).length, below = per.filter(v => v <= base * 0.8 && base - v >= ABS_FLOOR[s]).length;
      const agg = base ? c.vt.p36[s] / base : null;
      if (above >= need(per.length) && agg >= 1.2 && c.vt.p36[s] - base >= ABS_FLOOR[s]) push(s, { dir: 'up', text: `vs ${c.oppAbbr} ${above}/${per.length} meetings above his current rate (${c.vt.p36[s].toFixed(1)} vs ${base.toFixed(1)}/36)` });
      if (below >= need(per.length) && agg != null && agg <= 0.8 && base - c.vt.p36[s] >= ABS_FLOOR[s]) push(s, { dir: 'down', text: `vs ${c.oppAbbr} ${below}/${per.length} meetings below his current rate (${c.vt.p36[s].toFixed(1)} vs ${base.toFixed(1)}/36)` });
    }
  }
  const res = {};
  for (const s of STATS) {
    if (!strong[s]) continue;
    const dirs = new Set(strong[s].map(x => x.dir));
    if (dirs.size > 1) continue; // lines disagree → no flag
    res[s] = { dir: [...dirs][0], text: strong[s].map(x => x.text).join('; ') };
  }
  return res;
}

function screenFlags(c, bl) {
  const out = [];
  const l5 = c.own5.length ? c.l5p36 : null;
  if (!l5) return out;
  const pattern = patternSignals(c);
  const merged = {};
  for (const s of STATS) {
    const m = matchupSignal(c, s, bl), p = pattern[s];
    if (!m && !p) continue;
    if (m && p && m.dir !== p.dir) continue; // tiers disagree → no flag
    merged[s] = { stat: s, dir: (m || p).dir, matchup: m ? m.text : null, pattern: p ? p.text : null };
  }
  const mainHit = MAIN.some(s => merged[s]);
  for (const s of STATS) {
    if (!merged[s]) continue;
    if ((s === 'stl' || s === 'blk') && !mainHit) continue; // secondary lens unless exception below
    out.push(merged[s]);
  }
  // STL/BLK exception: consistently strong vs-team line with positional-log backing
  for (const s of ['stl', 'blk']) {
    if (out.some(f => f.stat === s)) continue;
    const k = c.vt.cur.filter(r => r[s] >= 2).length;
    if (c.vt.n >= 4 && k >= c.vt.n - 1 && c.log.p36 && c.log.p36[s] >= l5[s]) out.push({ stat: s, dir: 'up', matchup: null, pattern: `${SL[s]} 2+ in ${k}/${c.vt.n} vs this team, opp log ${c.log.p36[s].toFixed(1)}/36 backs it` });
  }
  return out;
}

function environmentNote(c) {
  const R = c.oppRating;
  if (!R || !R.gp) return null;
  const fast = R.paceRank <= 10, slow = R.paceRank >= 21, poorD = R.drtgRank >= 21, eliteD = R.drtgRank <= 10;
  const base = `Opp pace #${R.paceRank} (${R.pace.toFixed(1)}), DRtg #${R.drtgRank} (${R.drtg.toFixed(1)})`;
  if (fast && poorD) return { kind: 'env-up', text: `${base}: fast and poor-defending — lifts everyone.` };
  if (slow && eliteD) return { kind: 'env-down', text: `${base}: slow and elite — suppresses even soft positional slices.` };
  return { kind: 'env', text: base + '.' };
}

function cautions(c, bl) {
  const out = [];
  if (c.baseMin < 18 && bl.adj.pts != null) {
    const lowMinSample = sumBy(c.own5, 'min') < 60;
    const big = c.l5raw && bl.adj.pts > 1.4 * c.l5raw.pts + 2;
    if (lowMinSample || big) out.push(`Minutes-scaling caution: bench role (${c.baseMin.toFixed(1)} mpg${lowMinSample ? `, only ${sumBy(c.own5, 'min')} total min in last 5` : ''}). Projection${big ? ` (${bl.adj.pts.toFixed(1)} pts vs ${c.l5raw.pts.toFixed(1)} actual avg)` : ''} may overstate — treat as unlikely.`);
  }
  return out;
}
