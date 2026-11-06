'use strict';
/* Projection log, grading and retune report.
   node agent/projections.js            snapshot today's projections (once, after 8:07 AM ET), record ESPN game lines,
                                         grade earlier days from box scores, rebuild reports/model/summary.json
   node agent/projections.js --force    snapshot now even if one exists / before 8:07
   Weights are never changed automatically: the summary only suggests. Lines are only real ones (ESPN game odds,
   player main lines the odds agent actually fetched). */

const fs = require('fs');
const path = require('path');
const { loadBoardCode, boardDefaultWeights, buildBoardFor, ROOT } = require('./lib/board');

const MODEL_DIR = path.join(ROOT, 'reports', 'model');
const SNAP_DIR = path.join(MODEL_DIR, 'projections');
const GAMELINE_DIR = path.join(MODEL_DIR, 'gamelines');
const LINES_DIR = path.join(MODEL_DIR, 'lines');
const STATS6 = ['pts', 'reb', 'ast', 'tpm', 'stl', 'blk'];
const EXTRA = ['fga', 'tpa', 'fta'];
const MIN_ROWS_TO_SUGGEST = 300;   // player-games with all three inputs before a weight suggestion is called anything but tentative
const MIN_LINES_TO_CONCLUDE = 100; // graded line comparisons before calling a market comparison meaningful

const args = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)); };
const r2 = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
const pick = (o, keys) => o ? Object.fromEntries(keys.map(k => [k, r2(o[k])])) : null;

async function main() {
  const B = loadBoardCode();
  const now = B.etNowParts();
  const D = args.date || now.date;
  let changed = false;

  // ---- 1. game lines (free, ESPN scoreboard): open at snapshot time, close = last reading within 60 min of tip ----
  const sb = await B.fetchJSON(`${B.ESPN}/scoreboard?dates=${D.replace(/-/g, '')}`);
  const events = ((sb && sb.events) || []).filter(e => [2, 3, 5].includes(e.season && e.season.type));
  const glFile = path.join(GAMELINE_DIR, `${D}.json`);
  const gl = readJson(glFile, {});
  for (const e of events) {
    const c = e.competitions[0], o = (c.odds || [])[0];
    if (!o || (o.overUnder == null && !o.details)) continue;
    const pre = e.status && e.status.type && e.status.type.state === 'pre';
    if (!pre) continue;
    const reading = { total: o.overUnder != null ? +o.overUnder : null, spread: o.details || null, provider: (o.provider && (o.provider.displayName || o.provider.name)) || null, at: new Date().toISOString() };
    const g = gl[e.id] = gl[e.id] || { label: e.shortName, tip: e.date };
    if (!g.open) { g.open = reading; changed = true; }
    const mins = (Date.parse(e.date) - Date.now()) / 60000;
    if (mins <= 60 && mins > 0 && (!g.close || g.close.total !== reading.total || g.close.spread !== reading.spread || !g.closeFinal)) {
      g.close = reading; g.closeMinsBeforeTip = Math.round(mins); g.closeFinal = mins <= 20; changed = true;
    }
  }
  if (changed) writeJson(glFile, gl);

  // ---- 2. snapshot today's projections once ----
  const snapFile = path.join(SNAP_DIR, `${D}.json`);
  const due = events.length && (args.force || (!fs.existsSync(snapFile) && now.h * 60 + now.m >= 8 * 60 + 7 && D === now.date));
  if (due) {
    console.log(`Snapshotting projections for ${D}…`);
    const built = await buildBoardFor(B, D, m => console.log('  ' + m));
    if (!built.empty) {
      const W = boardDefaultWeights();
      const rows = [];
      for (const g of built.board.games) {
        for (const side of Object.values(g.sides)) for (const c of side.cards) {
          const bl = B.blendCard(c, W);
          rows.push({
            gid: g.id, pid: c.pid, name: c.name, team: side.team.abbr, opp: c.oppAbbr, pos: c.pos, status: c.status,
            min: { recent: r2(c.baseMin), restCut: r2(c.restCut), vacated: r2(c.vacMin), blowout: r2(c.trimMin), final: r2(c.finalMin) },
            pace: r2(c.paceFactor), paceSource: c.pace ? c.pace.source : null,
            proj: pick(bl.adj, [...STATS6, ...EXTRA]),
            inputs: { vt: pick(bl.inputProj.vt, [...STATS6, ...EXTRA]), l5: pick(bl.inputProj.l5, [...STATS6, ...EXTRA]), op: pick(bl.inputProj.op, [...STATS6, ...EXTRA]) },
            n: { vt: c.vt.n, own5: c.own5.length, oppGp: built.board.ctx.tvp[c.oid] ? built.board.ctx.tvp[c.oid].gp : 0 },
            defAdj: !!c.def.adj
          });
        }
      }
      const games = built.board.games.map(g => ({ gid: g.id, label: `${built.board.teams[g.away].abbr} @ ${built.board.teams[g.home].abbr}`, tip: g.date,
        modelTotal: g.proj ? r2(g.proj.total) : null, modelMargin: g.proj ? r2(g.proj.margin) : null, pace: g.pace ? r2(g.pace.pace) : null, paceSource: g.pace ? g.pace.source : null,
        marketAtSnapshot: g.odds ? { total: g.odds.total, spread: g.odds.details } : null }));
      writeJson(snapFile, { date: D, at: new Date().toISOString(), weights: W, boxScores: built.board.boxCount, games, rows });
      console.log(`  ${rows.length} player projections across ${games.length} games saved.`);
      changed = true;
      B.persist();
    }
  }

  // ---- 3. grade earlier snapshots from box scores ----
  const boxCache = {};
  const boxFor = async gid => {
    if (boxCache[gid] !== undefined) return boxCache[gid];
    try { boxCache[gid] = B.extractBox(await B.fetchJSON(`${B.ESPN}/summary?event=${gid}`)); } catch (e) { boxCache[gid] = null; }
    return boxCache[gid];
  };
  const snaps = fs.existsSync(SNAP_DIR) ? fs.readdirSync(SNAP_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
  for (const f of snaps) {
    const d = f.slice(0, 10);
    if (d >= D) continue;
    const s = readJson(path.join(SNAP_DIR, f), null);
    if (!s || s.graded) continue;
    let pending = 0;
    for (const g of s.games) {
      const box = await boxFor(g.gid);
      if (!box) { pending++; continue; }
      g.final = Object.fromEntries(Object.values(box.teams).map(t => [t.id, t.pts]));
      g.actualTotal = Object.values(box.teams).reduce((a, t) => a + t.pts, 0);
      for (const r of s.rows.filter(x => x.gid === g.gid)) {
        const p = box.players.find(x => x.id === r.pid);
        r.actual = p ? Object.fromEntries([['min', p.min], ...[...STATS6, ...EXTRA].map(k => [k, p[k]])]) : 'DNP';
      }
    }
    if (!pending) { s.graded = new Date().toISOString(); writeJson(path.join(SNAP_DIR, f), s); changed = true; console.log(`Graded ${d}.`); }
  }

  // ---- 4. summary ----
  if (changed || args.force || !fs.existsSync(path.join(MODEL_DIR, 'summary.json'))) {
    writeJson(path.join(MODEL_DIR, 'summary.json'), summarize(snaps.map(f => readJson(path.join(SNAP_DIR, f), null)).filter(Boolean)));
    console.log('Summary updated: reports/model/summary.json');
  }
}

function mae(pairs) { return pairs.length ? pairs.reduce((t, [p, a]) => t + Math.abs(p - a), 0) / pairs.length : null; }
function bias(pairs) { return pairs.length ? pairs.reduce((t, [p, a]) => t + (p - a), 0) / pairs.length : null; }

function summarize(snaps) {
  const graded = snaps.filter(s => s.graded);
  const rows = graded.flatMap(s => s.rows.map(r => ({ ...r, date: s.date, weights: s.weights })));
  const played = rows.filter(r => r.actual && r.actual !== 'DNP' && r.proj && r.proj.pts != null);
  const out = { updated: new Date().toISOString(), days: graded.length, pending: snaps.length - graded.length, playerGames: played.length, dnp: rows.filter(r => r.actual === 'DNP').length };

  // error by stat (final) and by input (each input's own projection at the same minutes and pace)
  out.byStat = {};
  const full = played.filter(r => r.inputs.vt && r.inputs.l5 && r.inputs.op);
  for (const s of [...STATS6, ...EXTRA]) {
    const e = { n: played.length, mae: r2(mae(played.map(r => [r.proj[s], r.actual[s]]))), bias: r2(bias(played.map(r => [r.proj[s], r.actual[s]]))),
      meanActual: r2(played.length ? played.reduce((t, r) => t + r.actual[s], 0) / played.length : null), inputs: {} };
    for (const k of ['vt', 'l5', 'op']) {
      const pr = full.map(r => [r.inputs[k][s], r.actual[s]]);
      e.inputs[k] = { n: pr.length, mae: r2(mae(pr)), bias: r2(bias(pr)) };
    }
    e.blendOnSameRows = { n: full.length, mae: r2(mae(full.map(r => [r.proj[s], r.actual[s]]))) };
    out.byStat[s] = e;
  }
  const minPairs = played.filter(r => r.min && r.min.final != null).map(r => [r.min.final, r.actual.min]);
  out.minutes = { n: minPairs.length, mae: r2(mae(minPairs)), bias: r2(bias(minPairs)) };
  out.bestInput = {};
  for (const s of STATS6) {
    const inp = out.byStat[s].inputs;
    const best = ['vt', 'l5', 'op'].filter(k => inp[k].mae != null).sort((a, b) => inp[a].mae - inp[b].mae)[0];
    out.bestInput[s] = best || null;
  }

  // weight suggestion: grid search (5% steps) on rows that have all three inputs; loss = Σ over six stats of MAE ÷ mean actual
  const cur = graded.length ? graded[graded.length - 1].weights : null;
  const loss = w => {
    if (!full.length) return null;
    let L = 0;
    for (const s of STATS6) {
      const m = full.reduce((t, r) => t + r.actual[s], 0) / full.length || 1;
      L += mae(full.map(r => [(w.vt * r.inputs.vt[s] + w.l5 * r.inputs.l5[s] + w.op * r.inputs.op[s]) / 100, r.actual[s]])) / m;
    }
    return L;
  };
  let best = null;
  for (let a = 0; a <= 100; a += 5) for (let b = 0; a + b <= 100; b += 5) {
    const w = { vt: a, l5: b, op: 100 - a - b }, L = loss(w);
    if (L != null && (!best || L < best.loss)) best = { w, loss: L };
  }
  const curNorm = cur ? (() => { const t = cur.vt + cur.l5 + cur.op; return { vt: 100 * cur.vt / t, l5: 100 * cur.l5 / t, op: 100 * cur.op / t }; })() : null;
  out.weights = {
    current: cur, n: full.length, threshold: MIN_ROWS_TO_SUGGEST,
    currentLoss: curNorm ? r2(loss(curNorm)) : null, suggested: best ? best.w : null, suggestedLoss: best ? r2(best.loss) : null,
    verdict: !full.length ? 'No graded player-games with all three inputs yet — nothing to suggest.'
      : full.length < MIN_ROWS_TO_SUGGEST ? `Tentative only: ${full.length} player-games with all three inputs (needs ${MIN_ROWS_TO_SUGGEST}+ before this means much).`
        : 'Suggestion from the misses so far — move the sliders (or W_DEFAULT in js/ui.js) yourself if you agree.'
  };

  // market: game totals (ESPN close) and player main lines the odds agent fetched
  const totals = [];
  for (const s of graded) {
    const glines = readJson(path.join(GAMELINE_DIR, `${s.date}.json`), {});
    for (const g of s.games) {
      const L = glines[g.gid];
      if (g.actualTotal == null || !L) continue;
      const close = L.close || null, open = L.open || null;
      totals.push({ model: g.modelTotal, open: open && open.total, close: close && close.total, actual: g.actualTotal });
    }
  }
  const withClose = totals.filter(t => t.close != null && t.model != null);
  out.market = {
    gameTotals: {
      n: withClose.length, threshold: MIN_LINES_TO_CONCLUDE,
      modelMae: r2(mae(withClose.map(t => [t.model, t.actual]))), closeMae: r2(mae(withClose.map(t => [t.close, t.actual]))),
      modelMinusClose: r2(bias(withClose.map(t => [t.model, t.close]))),
      sideRecord: (() => { const d = withClose.filter(t => t.actual !== t.close && t.model !== t.close); const w = d.filter(t => (t.model > t.close) === (t.actual > t.close)).length; return { decided: d.length, modelSideWon: w }; })(),
      openToCloseMoveTowardModel: (() => { const d = totals.filter(t => t.open != null && t.close != null && t.model != null && t.open !== t.close); return { moved: d.length, towardModel: d.filter(t => Math.abs(t.close - t.model) < Math.abs(t.open - t.model)).length }; })()
    },
    playerLines: playerLineSummary(graded)
  };
  for (const k of ['gameTotals', 'playerLines']) {
    const m = out.market[k];
    m.verdict = !m.n ? 'No graded comparisons yet.' : m.n < MIN_LINES_TO_CONCLUDE ? `n=${m.n} — too small to conclude anything (needs ${MIN_LINES_TO_CONCLUDE}+).` : `n=${m.n}.`;
  }
  out.days_list = graded.map(s => s.date);
  return out;
}

function playerLineSummary(graded) {
  const pairs = [];
  for (const s of graded) {
    const lines = readJson(path.join(LINES_DIR, `${s.date}.json`), {});
    for (const [key, L] of Object.entries(lines)) {
      const [gid, pid, stat] = key.split('|');
      const r = s.rows.find(x => x.gid === gid && x.pid === pid);
      if (!r || !r.actual || r.actual === 'DNP' || !r.proj || r.proj[stat] == null) continue;
      const line = (L.close || L.open || {}).line;
      if (line == null) continue;
      pairs.push({ stat, proj: r.proj[stat], line, actual: r.actual[stat], usedClose: !!L.close });
    }
  }
  const decided = pairs.filter(p => p.actual !== p.line && p.proj !== p.line);
  return {
    n: pairs.length, withClose: pairs.filter(p => p.usedClose).length,
    projMae: r2(mae(pairs.map(p => [p.proj, p.actual]))), lineMae: r2(mae(pairs.map(p => [p.line, p.actual]))),
    projMinusLine: r2(bias(pairs.map(p => [p.proj, p.line]))),
    sideRecord: { decided: decided.length, projSideWon: decided.filter(p => (p.proj > p.line) === (p.actual > p.line)).length },
    note: 'Lines come only from props the odds agent fetched (budget mode: a few stats per day), so this sample grows slowly.'
  };
}

main().catch(e => { console.error('projections failed:', e && e.message); process.exit(1); });
