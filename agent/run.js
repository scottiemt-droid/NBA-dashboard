'use strict';
/* NBA prop edge agent.
   node agent/run.js                 auto: morning scan once after 8:07 AM ET, re-checks when a game is ~60 / ~15 min from tip
   node agent/run.js --mode morning  force a morning (flags-only) scan now
   node agent/run.js --mode recheck --window T-60|T-15   force a re-check of every game not yet started
   node agent/run.js --date YYYY-MM-DD                    run against another slate date (testing)
   It never places a bet. */

const fs = require('fs');
const path = require('path');
const { loadBoardCode, boardDefaultWeights, buildBoardFor, ROOT } = require('./lib/board');
const { OddsClient, parseOffers, normName, BOOKS } = require('./lib/odds');
const E = require('./lib/edge');
const { PlayLog } = require('./lib/log');
const { renderReport, renderIndex } = require('./lib/report');

const args = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
const MODE = args.mode || 'auto';
const REPORTS = path.join(ROOT, 'reports');
const log = m => console.log('  ' + m);
const lastWord = s => String(s || '').trim().split(/\s+/).pop().toLowerCase();

function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); }

async function main() {
  const B = loadBoardCode();
  const now = B.etNowParts();
  const D = args.date || now.date;
  const runAt = `${now.date} ${String(now.h).padStart(2, '0')}:${String(now.m).padStart(2, '0')}`;
  const stateFile = path.join(REPORTS, D, 'state.json');
  const state = readJson(stateFile, { morning: null, checks: {}, missed: {} });

  // ---- what is due this run (one cheap ESPN call) ----
  const sb = await B.fetchJSON(`${B.ESPN}/scoreboard?dates=${D.replace(/-/g, '')}`);
  const events = ((sb && sb.events) || []).filter(e => [2, 3, 5].includes(e.season && e.season.type));
  if (!events.length) { console.log(`No NBA games on ${D} — nothing to do (quiet day).`); return; }
  const nowMs = Date.now();
  const slate = events.map(e => ({ id: String(e.id), tip: e.date, pre: e.status && e.status.type && e.status.type.state === 'pre', label: e.shortName,
    mins: (Date.parse(e.date) - nowMs) / 60000 }));

  const passes = [];
  const morningDue = MODE === 'morning' || (MODE === 'auto' && !state.morning && now.h * 60 + now.m >= 8 * 60 + 7 && D === now.date);
  if (morningDue) passes.push({ phase: 'morning', games: slate.filter(g => g.pre).map(g => g.id) });
  if (MODE === 'recheck') {
    const w = args.window === 'T-15' ? 'T-15' : 'T-60';
    passes.push({ phase: w, games: slate.filter(g => g.pre).map(g => g.id) });
  } else if (MODE === 'auto' && D === now.date) {
    const t60 = [], t15 = [];
    for (const g of slate.filter(x => x.pre)) {
      const c = state.checks[g.id] = state.checks[g.id] || {};
      if (g.mins > 45 && g.mins <= 75 && !c.t60) t60.push(g.id);
      if (g.mins > 3 && g.mins <= 25 && !c.t15) t15.push(g.id);
      if (g.mins <= 45 && !c.t60 && !state.missed[g.id + ':t60']) state.missed[g.id + ':t60'] = runAt;
    }
    if (t60.length) passes.push({ phase: 'T-60', games: t60 });
    if (t15.length) passes.push({ phase: 'T-15', games: t15 });
  }
  if (!passes.length) { console.log(`${runAt} ET — ${slate.length} games on ${D}; no morning scan or re-check window due this run.`); return; }
  console.log(`${runAt} ET — due: ${passes.map(p => `${p.phase} (${p.games.length} game${p.games.length === 1 ? '' : 's'})`).join(', ')}`);

  // ---- startup self-check ----
  const status = { board: { ok: false, detail: '' }, odds: { ok: false, label: '', detail: '' }, books: {}, quota: null, notes: [], oddsGames: 0 };
  let built = null;
  try {
    built = await buildBoardFor(B, D, log);
    if (built.empty) status.board.detail = `ESPN shows no games for ${D}`;
    else {
      const cards = built.board.games.reduce((t, g) => t + Object.values(g.sides).reduce((u, s) => u + s.cards.length, 0), 0);
      status.board = { ok: true, detail: `${built.board.games.length} games, ${cards} projected players, built from ${built.board.boxCount} completed box scores` };
    }
  } catch (e) { status.board.detail = `board build failed: ${e.message}`; }
  const weights = boardDefaultWeights();

  const key = process.env.ODDS_API_KEY;
  const odds = new OddsClient(key);
  let oddsEvents = null;
  if (!key) Object.assign(status.odds, { label: 'NO KEY', detail: 'ODDS_API_KEY is not set — no player props, so no edges, ladders or parlays this run. See README → Edge agent setup.' });
  else {
    try {
      oddsEvents = await odds.events();
      Object.assign(status.odds, { ok: true, detail: `The Odds API, ${oddsEvents.length} NBA events listed` });
    } catch (e) { Object.assign(status.odds, { label: 'ERROR', detail: odds.scrub(e.message) }); }
  }

  // match board games ↔ odds events, fetch each scoped game's props once (cached for the run)
  const scoped = [...new Set(passes.flatMap(p => p.games))];
  const propsByGame = {};
  const gaps = [];
  if (built && !built.empty && oddsEvents) {
    for (const k of Object.keys(BOOKS)) if (!status.books[BOOKS[k]]) status.books[BOOKS[k]] = { name: BOOKS[k], games: 0 };
    for (const gid of scoped) {
      const g = built.board.games.find(x => x.id === gid);
      if (!g) continue;
      const H = built.board.teams[g.home], A = built.board.teams[g.away];
      const ev = oddsEvents.find(e => lastWord(e.home_team) === lastWord(H.name) && lastWord(e.away_team) === lastWord(A.name) && Math.abs(Date.parse(e.commence_time) - Date.parse(g.date)) < 6 * 3600e3);
      if (!ev) { gaps.push(`${A.abbr} @ ${H.abbr}: no matching event in the odds feed`); continue; }
      status.oddsGames++;
      try {
        const j = await odds.eventProps(ev.id);
        const parsed = parseOffers(j);
        propsByGame[gid] = parsed.offers;
        for (const name of new Set(parsed.booksSeen.map(k => BOOKS[k]))) status.books[name].games++;
        const missing = Object.keys(BOOKS).filter(k => k !== 'williamhill_us' && !parsed.booksSeen.includes(k) && !(k === 'caesars' && parsed.booksSeen.includes('williamhill_us')));
        if (!parsed.offers.length) gaps.push(`${A.abbr} @ ${H.abbr}: odds feed returned no player props from any of the four books (props may not be posted yet)`);
        else if (missing.length) gaps.push(`${A.abbr} @ ${H.abbr}: no props from ${missing.map(k => BOOKS[k]).join(', ')}`);
      } catch (e) {
        gaps.push(`${A.abbr} @ ${H.abbr}: props fetch failed — ${odds.scrub(e.message)}`);
        if (odds.stopped) { status.notes.push(`Stopped fetching: ${odds.stopped}. Games after this point have no odds this run.`); break; }
      }
    }
    if (odds.planIssue) status.notes.push(`Plan check: the odds feed rejected the props/alt-line markets (${odds.planIssue}). Player props and alt lines need a plan that includes them — see README.`);
    if (status.odds.ok && !Object.values(propsByGame).some(o => o.length)) status.notes.push('No player props came back for any scoped game — no edges computed. Nothing is substituted (no game lines, no estimates).');
  }
  if (odds.remaining != null) status.quota = `${odds.remaining.toLocaleString()} credits remaining (used ${odds.used != null ? odds.used.toLocaleString() : '?'}; ${odds.calls} calls this run)`;

  console.log('DATA SOURCE STATUS');
  console.log(`  Board projections: ${status.board.ok ? 'OK' : 'MISSING'} — ${status.board.detail}`);
  console.log(`  Odds feed: ${status.odds.ok ? 'connected' : status.odds.label} — ${status.odds.detail}`);
  for (const b of Object.values(status.books)) console.log(`  ${b.name}: ${b.games ? `props for ${b.games}/${status.oddsGames} games` : 'NO PROPS'}`);
  console.log(`  Quota: ${status.quota || 'not reported'}`);
  status.notes.forEach(n => console.log('  NOTE: ' + n));
  gaps.forEach(g => console.log('  GAP: ' + g));

  // ---- edges ----
  const allLegs = [];
  const ladderSrc = [];
  const unmatched = {};
  if (built && !built.empty) {
    for (const g of built.board.games) {
      const offers = propsByGame[g.id];
      if (!offers || !offers.length) continue;
      const cardsByKey = {};
      for (const side of Object.values(g.sides)) for (const c of side.cards) cardsByKey[normName(c.name)] = { c, side };
      for (const o of offers) if (!cardsByKey[o.key]) unmatched[o.player] = `${built.board.teams[g.away].abbr} @ ${built.board.teams[g.home].abbr}`;
      for (const { c, side } of Object.values(cardsByKey)) {
        const bl = B.blendCard(c, weights);
        const caution = B.cautions(c, bl).length > 0;
        for (const s of E.STATS4) {
          const mine = offers.filter(o => o.key === normName(c.name) && o.stat === s);
          if (!mine.length) continue;
          const ev = E.evaluatePlayerStat({ card: c, s, offers: mine, weights, bl, caution });
          const meta = { gameId: g.id, pid: c.pid, tid: c.tid, name: c.name, team: side.team.abbr, opp: c.oppAbbr, status: c.status,
            proj: bl.adj[s], base: bl.base[s], baseMin: c.baseMin, finalMin: c.finalMin, vacMin: c.vacMin };
          ev.rungs.forEach(r => allLegs.push(Object.assign(r, meta)));
          if (ev.rungs.some(r => r.qualified)) ladderSrc.push({ ...meta, s, proj: bl.adj[s], base: bl.base[s], rows: E.ladderRows(ev, bl.adj[s]) });
        }
      }
    }
  }
  const unmatchedList = Object.entries(unmatched);
  if (unmatchedList.length) gaps.push(`${unmatchedList.length} prop player(s) not in tonight's projected rotations (OUT, outside the 9-man rotation, or a name mismatch) — skipped: ${unmatchedList.slice(0, 15).map(([n, gm]) => `${n} (${gm})`).join(', ')}${unmatchedList.length > 15 ? ', …' : ''}`);

  // ---- log, reports ----
  const playLog = new PlayLog(ROOT);
  if (built && !built.empty) playLog.grade(built.raw.boxes, D);
  playLog.updateClose(D, allLegs);
  const index = readJson(path.join(REPORTS, 'index.json'), []);
  const stamp = runAt.slice(11).replace(':', '');

  for (const pass of passes) {
    const legs = allLegs.filter(l => pass.games.includes(l.gameId));
    const byEdge = (a, b) => (b.edge3 || 0) - (a.edge3 || 0);
    const ranked = legs.filter(l => l.headline).sort(byEdge);
    const held = legs.filter(l => l.qualified && !l.headline).sort(byEdge);
    const parlay = ranked.length ? E.buildParlays(ranked, { raw: built.raw, gl: built.gl }) : null;
    const ladders = ladderSrc.filter(L => pass.games.includes(L.gameId));
    const phaseKind = pass.phase === 'morning' ? 'flag' : 'cleared';
    const gameLabel = id => { const g = slate.find(x => x.id === id); return g ? g.label : id; };

    for (const l of [...ranked, ...held]) playLog.add({
      date: D, run_at_et: runAt, phase: phaseKind, check: pass.phase, game_id: l.gameId, game: gameLabel(l.gameId), player_id: l.pid, player: l.name,
      stat: l.s, side: l.side, line: l.point, threshold: l.T, book: l.best.book, odds_dec: l.best.price.toFixed(3), odds_am: E.toAmerican(l.best.price),
      model_p: l.pModel.toFixed(4), devig_p: l.best.devig ? l.best.devig.p.toFixed(4) : '', edge_best: l.bestEdge != null ? l.bestEdge.toFixed(4) : '',
      edge_3rd_book: l.edge3 != null ? l.edge3.toFixed(4) : '', books_clearing: l.clearing.length, headline: l.headline ? 'yes' : 'no',
      minutes_dependent: l.minutesDependent ? 'yes' : 'no', stake_pct: (100 * l.stake).toFixed(2)
    });
    if (parlay && parlay.best) {
      const p = parlay.best;
      playLog.add({ date: D, run_at_et: runAt, phase: phaseKind, check: pass.phase, game_id: [...new Set(p.legs.map(l => l.gameId))].join('|'),
        game: [...new Set(p.legs.map(l => gameLabel(l.gameId)))].join(' + '), player: p.legs.map(l => `${l.name} ${l.side === 'over' ? l.T + '+' : '≤' + (l.T - 1)} ${E.SLN[l.s]}`).join(' | '),
        stat: 'parlay', book: p.book.book, odds_dec: p.book.dec.toFixed(3), odds_am: E.toAmerican(p.book.dec), model_p: p.joint.toFixed(4),
        headline: 'yes', stake_pct: (100 * p.stake).toFixed(2), legs: p.legs.map(l => `${l.gameId}:${l.pid}:${l.s}:${l.side}:${l.T}`).join(';') });
    }

    const missed = pass.phase !== 'morning' ? [] : Object.keys(state.missed).map(k => k.split(':')[0]).filter(id => slate.some(g => g.id === id)).map(id => `${gameLabel(id)}: no run landed inside its 60-minute window`);
    const html = renderReport({
      D, runAt: runAt.slice(11), phase: pass.phase, status, weights, ranked, held, parlay,
      ladders, gaps: [...gaps, ...missed], weekly: playLog.weekly(D, B.addDays), oddsOk: Object.values(propsByGame).some(o => o.length),
      gamesLabel: pass.games.map(gameLabel).join(', ')
    });
    const file = `${stamp}-${pass.phase.toLowerCase()}.html`;
    fs.mkdirSync(path.join(REPORTS, D), { recursive: true });
    fs.writeFileSync(path.join(REPORTS, D, file), html);
    writeJson(path.join(REPORTS, D, file.replace('.html', '.json')), {
      date: D, runAt, phase: pass.phase, status, weights,
      ranked: ranked.map(slim), held: held.map(slim),
      parlay: parlay && parlay.best ? { legs: parlay.best.legs.map(slim), book: parlay.best.book.name, dec: parlay.best.book.dec, joint: parlay.best.joint, ev: parlay.best.ev, stake: parlay.best.stake } : null,
      gaps
    });
    const summary = !status.odds.ok ? `odds feed ${status.odds.label}` : `${ranked.length} ${phaseKind === 'flag' ? 'flagged' : 'cleared'}${parlay && parlay.best ? ', parlay' : ', no parlay'}`;
    index.push({ date: D, file, label: `${runAt.slice(11)} ET — ${pass.phase === 'morning' ? 'Morning scan (flags only)' : pass.phase + ' re-check'}`, summary });
    console.log(`Report: reports/${D}/${file} — ${summary}`);

    if (pass.phase === 'morning') state.morning = runAt;
    else for (const id of pass.games) { const c = state.checks[id] = state.checks[id] || {}; c[pass.phase === 'T-60' ? 't60' : 't15'] = runAt; }
  }

  playLog.save();
  writeJson(stateFile, state);
  writeJson(path.join(REPORTS, 'index.json'), index);
  fs.writeFileSync(path.join(REPORTS, 'index.html'), renderIndex(index));
  B.persist();
}

function slim(l) {
  return { player: l.name, team: l.team, opp: l.opp, stat: l.s, side: l.side, line: l.point, threshold: l.T, bestBook: l.best.name, bestPrice: l.best.price,
    modelP: l.pModel, devigP: l.best.devig ? l.best.devig.p : null, edgeBest: l.bestEdge, edge3rdBook: l.edge3, booksClearing: l.clearing.length, booksOffering: l.verified,
    headline: l.headline, minutesDependent: l.minutesDependent, proj: l.proj, base: l.base, stakePct: l.stake, threeLines: l.lines.text };
}

main().catch(e => { console.error('Agent failed:', e && e.message ? e.message.split(process.env.ODDS_API_KEY || '\u0000').join('***') : e); process.exit(1); });
