'use strict';
/* Edge math. Everything starts from the board's projection card for a player (the board's 50/25/25 blend).
   No numbers are invented: a rung that a book doesn't offer is skipped; a price that can't be devigged is shown
   as such and doesn't count toward the 3-book bar. */

const EDGE_MIN = 0.03;      // a book "clears" when model prob − devigged implied prob ≥ 3 points
const MIN_BOOKS = 3;        // a leg qualifies only when ≥3 books clear
const STATS4 = ['pts', 'reb', 'ast', 'tpm'];
const LADDER = { pts: [10, 15, 20, 25], reb: [5, 6, 8, 10], ast: [5, 6, 8, 10], tpm: [3, 4, 5] };
const BW_FLOOR = { pts: 2.5, reb: 1.2, ast: 1.0, tpm: 0.6 }; // KDE bandwidth floor, in stat units
const STAKE_CAP_SINGLE = 0.01, STAKE_CAP_PARLAY = 0.005, KELLY_FRACTION = 0.25;
const CORR_MIN_GAMES = { same: 15, pair: 8 };

const SLN = { pts: 'PTS', reb: 'REB', ast: 'AST', tpm: '3PM' };

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/* Distribution: every game in his current-role vs-team meetings and his last 10 games (the base of the own-form and
   opponent-positional inputs) → per-36 rate × projected minutes, weighted by the board's line weights split evenly
   across each line's games, then rescaled so the weighted mean equals the board's projection. */
function distribution(card, s, weights, minutes, projection) {
  const lines = [
    { k: 'vt', w: weights.vt, rows: card.vt.n ? card.vt.cur : [] },
    // own form and opponent-positional inputs are both built on his own games, so both draw their shape from his last 10
    { k: 'l5', w: weights.l5, rows: card.own10 || card.own5 },
    { k: 'op', w: weights.op, rows: card.inputs && card.inputs.op ? (card.own10 || card.own5) : [] }
  ].filter(l => l.w > 0 && l.rows.some(r => r.min > 0));
  const W = lines.reduce((t, l) => t + l.w, 0);
  if (!W || projection == null) return null;
  const pts = [];
  for (const l of lines) {
    const rows = l.rows.filter(r => r.min > 0);
    for (const r of rows) pts.push({ v: r[s] / r.min * minutes, w: l.w / W / rows.length, line: l.k });
  }
  const wsum = pts.reduce((t, p) => t + p.w, 0);
  const m = pts.reduce((t, p) => t + p.w * p.v, 0) / wsum;
  const k = m > 0 ? projection / m : 0;
  pts.forEach(p => p.v *= k);
  const sd = Math.sqrt(pts.reduce((t, p) => t + p.w * (p.v - projection) ** 2, 0) / wsum);
  const h = Math.max(BW_FLOOR[s], 1.06 * sd * Math.pow(pts.length, -0.2));
  return { pts, wsum, h, n: pts.length, byLine: Object.fromEntries(lines.map(l => [l.k, l.rows.filter(r => r.min > 0).length])) };
}

// P(X ≥ T) for an integer T, Gaussian kernel with continuity correction, clamped to [1%, 99%].
function probAtLeast(dist, T) {
  if (!dist) return null;
  const p = dist.pts.reduce((t, x) => t + x.w * (1 - normCdf((T - 0.5 - x.v) / dist.h)), 0) / dist.wsum;
  return Math.min(0.99, Math.max(0.01, p));
}

const toAmerican = d => d >= 2 ? `+${Math.round((d - 1) * 100)}` : `${Math.round(-100 / (d - 1))}`;

/* Devig. Two-way (over and under at the same point, same book) → proportional devig. One-sided alt rung → that
   book's own margin on the player's main two-way line for the stat, applied proportionally (labelled). */
function devig(side, offerSides, mainMargin) {
  const o = offerSides.over, u = offerSides.under;
  const mine = side === 'over' ? o : u, other = side === 'over' ? u : o;
  if (!mine) return null;
  if (other) return { p: (1 / mine) / (1 / mine + 1 / other), method: 'two-way' };
  if (mainMargin) return { p: (1 / mine) / mainMargin, method: 'one-way (book main-line margin)' };
  return null;
}

function threeLineNote(card, s, point) {
  const lineP36 = card.finalMin ? point / card.finalMin * 36 : null;
  if (lineP36 == null) return { agree: null, text: 'no projected minutes' };
  const lines = [['vs-team', card.vt.n ? card.vt.p36 : null], ['own L5', card.own5.length ? card.l5p36 : null], ['opp log', card.log.n ? card.log.p36 : null]]
    .filter(x => x[1]).map(([k, r]) => ({ k, v: r[s], over: r[s] > lineP36 }));
  if (lines.length < 3) return { agree: null, text: `only ${lines.length} of 3 lines have data` };
  const overs = lines.filter(l => l.over).length;
  const desc = lines.map(l => `${l.k} ${l.v.toFixed(1)}`).join(', ');
  if (overs === 3) return { agree: 'over', text: `all three lines point over (line ≈ ${lineP36.toFixed(1)}/36 vs ${desc})` };
  if (overs === 0) return { agree: 'under', text: `all three lines point under (line ≈ ${lineP36.toFixed(1)}/36 vs ${desc})` };
  return { agree: 'split', text: `lines disagree: ${lines.filter(l => l.over).map(l => l.k).join(', ')} over vs ${lines.filter(l => !l.over).map(l => l.k).join(', ')} under (line ≈ ${lineP36.toFixed(1)}/36; ${desc})` };
}

function kellyPct(p, dec, cap) {
  const b = dec - 1;
  const f = (b * p - (1 - p)) / b;
  return Math.max(0, Math.min(cap, KELLY_FRACTION * f));
}

/* Evaluate every offered point for one player-stat. Returns rung rows (over + under where offered). */
function evaluatePlayerStat(ctx) {
  const { card, s, offers, weights, bl, caution } = ctx;
  const distAdj = distribution(card, s, weights, card.finalMin, bl.adj[s]);
  const distBase = distribution(card, s, weights, card.baseMin, bl.base[s]);
  if (!distAdj) return { rungs: [], note: 'no distribution (all lines n=0)' };

  // book → point → {over, under, alt}
  const byBook = {};
  for (const o of offers) {
    const b = byBook[o.book] = byBook[o.book] || { name: o.bookName, points: {} };
    const pt = b.points[o.point] = b.points[o.point] || { alt: o.alt };
    // prefer the main market's price when a point appears in both main and alt markets
    if (!pt[o.side] || (pt.alt && !o.alt)) { pt[o.side] = o.price; if (!o.alt) pt.alt = false; }
  }
  // each book's main two-way margin for this player-stat (closest-to-even main line)
  for (const b of Object.values(byBook)) {
    let best = null;
    for (const [pt, x] of Object.entries(b.points)) if (!x.alt && x.over && x.under) {
      const m = 1 / x.over + 1 / x.under;
      const bal = Math.abs(x.over - x.under);
      if (!best || bal < best.bal) best = { m, bal, point: +pt };
    }
    b.mainMargin = best ? best.m : null;
    b.mainPoint = best ? best.point : null;
  }
  const points = [...new Set(offers.map(o => o.point))].sort((a, b) => a - b);
  const rungs = [];
  for (const point of points) {
    if (Number.isInteger(point)) continue; // whole-number line: push possible, skipped rather than mis-priced
    const T = Math.floor(point) + 1;
    const pOverAdj = probAtLeast(distAdj, T), pOverBase = probAtLeast(distBase, T);
    for (const side of ['over', 'under']) {
      const pm = side === 'over' ? pOverAdj : 1 - pOverAdj;
      const pb = pOverBase == null ? null : side === 'over' ? pOverBase : 1 - pOverBase;
      const books = [];
      for (const [bk, b] of Object.entries(byBook)) {
        const x = b.points[point];
        if (!x || !x[side]) continue;
        const dv = devig(side, x, b.mainMargin);
        books.push({ book: bk, name: b.name, price: x[side], alt: x.alt, devig: dv, edge: dv ? pm - dv.p : null, edgeBase: dv && pb != null ? pb - dv.p : null });
      }
      if (!books.length) continue;
      const clearing = books.filter(b => b.edge != null && b.edge >= EDGE_MIN);
      const clearingBase = books.filter(b => b.edgeBase != null && b.edgeBase >= EDGE_MIN);
      const sortedEdges = books.filter(b => b.edge != null).map(b => b.edge).sort((a, b) => b - a);
      const best = [...books].sort((a, b) => b.price - a.price)[0];
      const qualified = clearing.length >= MIN_BOOKS;
      const baseQualified = clearingBase.length >= MIN_BOOKS;
      const addedMinutes = card.vacMin > 0.05 || Object.values(card.bump || {}).some(v => v > 0.05);
      const minutesDependent = qualified && !baseQualified && addedMinutes;
      const isMain = Object.values(byBook).some(b => b.mainPoint === point);
      rungs.push({
        s, point, T, side, isMain, pModel: pm, pBase: pb, books, clearing, verified: books.length,
        best, bestEdge: best.edge, edge3: sortedEdges.length >= MIN_BOOKS ? sortedEdges[MIN_BOOKS - 1] : null,
        qualified, baseQualified, minutesDependent, benchCaution: qualified && caution,
        headline: qualified && !minutesDependent && !caution,
        ev: best.price * pm - 1,
        stake: qualified ? kellyPct(pm, best.price, STAKE_CAP_SINGLE) : 0,
        lines: threeLineNote(card, s, point)
      });
    }
  }
  return { rungs, dist: distAdj, proj: bl.adj[s], base: bl.base[s] };
}

function ladderRows(ev, proj) {
  const targets = new Set(LADDER[ev.s]);
  const extend = ev.s === 'pts' && proj >= 22; // extend points ladder to 30+ only when the projection supports it
  return ev.rungs.filter(r => r.side === 'over' && (targets.has(r.T) || r.isMain || (extend && r.T >= 30 && r.T % 5 === 0)))
    .sort((a, b) => a.T - b.T);
}

/* ---------- correlation from actual joint outcomes ---------- */

function hit(row, leg) { const v = row[leg.s]; return leg.side === 'over' ? v >= leg.T : v <= leg.T - 1; }

function playerRows(raw, gl, pid) {
  const cur = ((raw._idx.players[pid] || {}).games || []);
  const prior = (gl[pid] || []).filter(r => r.typ === 'RS');
  const seen = new Set(), out = [];
  for (const r of [...cur, ...prior]) { if (seen.has(r.gid) || r.min < 15) continue; seen.add(r.gid); out.push(r); }
  return out;
}

// Small samples exaggerate co-movement: pull the measured lift toward 1 by n/(n+20), then bound it to [0.6, 1.6].
const shrinkLift = (raw, n) => Math.min(1.6, Math.max(0.6, 1 + (raw - 1) * n / (n + 20)));

function pairLift(a, b, data) {
  if (a.gameId !== b.gameId) return { lift: 1, method: 'different games — treated as independent', n: null, estimable: true };
  if (a.pid === b.pid) {
    const rows = playerRows(data.raw, data.gl, a.pid);
    const n = rows.length, nA = rows.filter(r => hit(r, a)).length, nB = rows.filter(r => hit(r, b)).length, nAB = rows.filter(r => hit(r, a) && hit(r, b)).length;
    if (n < CORR_MIN_GAMES.same || nA < 3 || nB < 3) return { estimable: false, n, method: `same player: only ${n} games (${nA} hit leg A, ${nB} hit leg B) — correlation not estimable` };
    const raw = (nAB / n) / ((nA / n) * (nB / n)), lift = shrinkLift(raw, n);
    return { lift, n, estimable: true, method: `same player, ${n} games (this + last season, 15+ min): A hit ${nA}, B hit ${nB}, both ${nAB}; in games he hit A he hit B ${(100 * nAB / nA).toFixed(0)}% vs ${(100 * nB / n).toFixed(0)}% overall; raw lift ${raw.toFixed(2)} → ${lift.toFixed(2)} after shrinking for n=${n}` };
  }
  const ra = new Map(playerRows(data.raw, data.gl, a.pid).map(r => [r.gid, r]));
  const shared = playerRows(data.raw, data.gl, b.pid).filter(r => ra.has(r.gid)).map(r => [ra.get(r.gid), r]);
  const n = shared.length, nA = shared.filter(([x]) => hit(x, a)).length, nB = shared.filter(([, y]) => hit(y, b)).length, nAB = shared.filter(([x, y]) => hit(x, a) && hit(y, b)).length;
  if (n < CORR_MIN_GAMES.pair || nA < 2 || nB < 2) return { estimable: false, n, method: `same game, ${n} shared games (${nA}/${nB} hits) — correlation not estimable` };
  const raw = (nAB / n) / ((nA / n) * (nB / n)), lift = shrinkLift(raw, n);
  return { lift, n, estimable: true, method: `same game, ${n} shared games: A hit ${nA}, B hit ${nB}, both ${nAB}; raw lift ${raw.toFixed(2)} → ${lift.toFixed(2)} after shrinking for n=${n}` };
}

function scriptNote(a, b, pl) {
  if (a.gameId !== b.gameId) return 'different games — no shared game script';
  const together = pl.lift > 1.05 ? 'legs tend to hit together' : pl.lift < 0.95 ? 'legs tend to fight each other' : 'roughly independent in his/their games';
  if (a.pid === b.pid) return `same player — ${together}`;
  if (a.tid === b.tid) return `teammates — share usage; ${together}`;
  return `opponents — ${a.side === b.side ? 'both need the same game script (pace/competitive game)' : 'opposite sides of the same script'}; ${together}`;
}

function buildParlays(legs, data) {
  const pool = legs.filter(l => l.headline).sort((a, b) => (b.edge3 || 0) - (a.edge3 || 0)).slice(0, 12);
  const seen = new Set(), uniq = [];
  for (const l of pool) { const k = `${l.pid}:${l.s}`; if (!seen.has(k)) { seen.add(k); uniq.push(l); } }
  const combos = [];
  for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) {
    combos.push([uniq[i], uniq[j]]);
    for (let k = j + 1; k < uniq.length; k++) combos.push([uniq[i], uniq[j], uniq[k]]);
  }
  const results = [], rejected = [];
  for (const c of combos) {
    const pairs = [];
    let ok = true;
    for (let i = 0; i < c.length && ok; i++) for (let j = i + 1; j < c.length; j++) {
      const pl = pairLift(c[i], c[j], data);
      if (!pl.estimable) { ok = false; rejected.push({ legs: c, why: pl.method }); break; }
      pairs.push({ a: c[i], b: c[j], ...pl, script: scriptNote(c[i], c[j], pl) });
    }
    if (!ok) continue;
    const indep = c.reduce((t, l) => t * l.pModel, 1);
    const joint = Math.min(Math.min(...c.map(l => l.pModel)), indep * pairs.reduce((t, p) => t * p.lift, 1));
    // a parlay is placed at one book: every leg must be offered there at the same line/side
    let bestBook = null;
    const books = new Set(c[0].books.map(b => b.book));
    for (const bk of books) {
      const prices = c.map(l => (l.books.find(b => b.book === bk) || {}).price);
      if (prices.some(p => !p)) continue;
      const dec = prices.reduce((t, p) => t * p, 1);
      if (!bestBook || dec > bestBook.dec) bestBook = { book: bk, name: c[0].books.find(b => b.book === bk).name, dec, prices };
    }
    if (!bestBook) { rejected.push({ legs: c, why: 'no single book offers every leg' }); continue; }
    const ev = joint * bestBook.dec - 1;
    results.push({ legs: c, pairs, indep, joint, book: bestBook, ev, sameGame: pairs.some(p => p.a.gameId === p.b.gameId),
      stake: ev > 0 ? kellyPct(joint, bestBook.dec, STAKE_CAP_PARLAY) : 0 });
  }
  results.sort((a, b) => b.ev - a.ev);
  return { best: results.find(r => r.ev > 0) || null, considered: results.length, rejected, poolSize: uniq.length };
}

module.exports = { evaluatePlayerStat, ladderRows, buildParlays, toAmerican, EDGE_MIN, MIN_BOOKS, STATS4, SLN, KELLY_FRACTION, STAKE_CAP_SINGLE, STAKE_CAP_PARLAY };
