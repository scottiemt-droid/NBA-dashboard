'use strict';
/* Report pages (reports/YYYY-MM-DD/*.html) and the index (reports/index.html), readable on a phone. */

const { toAmerican, SLN, EDGE_MIN, MIN_BOOKS, KELLY_FRACTION, STAKE_CAP_SINGLE, STAKE_CAP_PARLAY } = require('./edge');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pc = (v, d = 1) => v == null ? '–' : `${(100 * v).toFixed(d)}%`;
const sp = v => v == null ? '–' : `${v >= 0 ? '+' : ''}${(100 * v).toFixed(1)}`;
const legName = l => `${l.side === 'over' ? `${l.T}+` : `≤${l.T - 1}`} ${SLN[l.s]}`;
const price = p => `${p.toFixed(2)} (${toAmerican(p)})`;

const CSS = `
:root{--bg:#f4f3ef;--panel:#fff;--panel2:#f8f7f4;--ink:#1b1d22;--ink2:#555a64;--ink3:#8a8f99;--line:#e1dfd8;--up:#1d7a46;--up-bg:#e3f3e8;--down:#b4372f;--down-bg:#fbe7e4;--warn:#9a6200;--warn-bg:#fdf1d8;--acc:#2d5bd7}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121418;--panel:#1b1e24;--panel2:#20242b;--ink:#e8e9ec;--ink2:#a9aeb8;--ink3:#737985;--line:#2e333c;--up:#5fd08f;--up-bg:#183526;--down:#ff8a80;--down-bg:#3b1d1b;--warn:#f2c26b;--warn-bg:#3a2e14;--acc:#7ea2ff}}
:root[data-theme="dark"]{--bg:#121418;--panel:#1b1e24;--panel2:#20242b;--ink:#e8e9ec;--ink2:#a9aeb8;--ink3:#737985;--line:#2e333c;--up:#5fd08f;--up-bg:#183526;--down:#ff8a80;--down-bg:#3b1d1b;--warn:#f2c26b;--warn-bg:#3a2e14;--acc:#7ea2ff}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink)}
body{font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:14px 16px 60px}
h1{font-size:19px;margin:4px 0}h2{font-size:15px;margin:20px 0 6px}h3{font-size:13.5px;margin:12px 0 4px}
a{color:var(--acc)}
.sub{color:var(--ink2);font-size:12.5px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-top:8px}
.banner{padding:8px 12px;border-radius:8px;font-weight:600;margin-top:8px}
.b-flag{background:var(--warn-bg);color:var(--warn)}.b-clear{background:var(--up-bg);color:var(--up)}.b-none{background:var(--panel2);color:var(--ink2)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}
th,td{padding:3px 6px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--ink3);font-weight:600;font-size:11.5px}td.l,th.l{text-align:left}td.w{white-space:normal;min-width:220px}
tr.q td{background:var(--up-bg)}
.badge{display:inline-block;font-size:10.5px;font-weight:700;padding:0 5px;border-radius:3px;background:var(--panel2);border:1px solid var(--line);color:var(--ink2)}
.ok{color:var(--up);font-weight:600}.bad{color:var(--down);font-weight:600}.warn{color:var(--warn)}
ul{margin:4px 0;padding-left:18px}li{margin:2px 0}
.leg div{margin:2px 0}.leg .big{font-size:15px;font-weight:600}
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

function statusHtml(st) {
  const books = Object.entries(st.books || {}).map(([k, v]) => `<li>${esc(v.name)}: ${v.games ? `<span class="ok">props for ${v.games}/${st.oddsGames} games</span>` : '<span class="bad">NO PROPS returned</span>'}</li>`).join('');
  return `<div class="panel"><b>Data-source status (startup check)</b><ul>
    <li>Board projections: ${st.board.ok ? `<span class="ok">OK</span> — ${esc(st.board.detail)}` : `<span class="bad">MISSING</span> — ${esc(st.board.detail)}`}</li>
    <li>Odds feed: ${st.odds.ok ? `<span class="ok">connected</span>` : `<span class="bad">${esc(st.odds.label)}</span>`} — ${esc(st.odds.detail)}</li>
    ${books ? `<li>Books:<ul>${books}</ul></li>` : ''}
    <li>Quota: ${st.quota ? esc(st.quota) : 'not reported'}</li>
    ${(st.notes || []).map(n => `<li class="warn">${esc(n)}</li>`).join('')}
  </ul></div>`;
}

function legCard(l, i) {
  const why = l.minutesDependent ? ' <span class="badge">clears only with added minutes</span>' : l.benchCaution ? ' <span class="badge">bench-scaling caution</span>' : '';
  return `<div class="panel leg">
    <div><b>${i + 1}. ${esc(l.name)}</b> <span class="sub">${esc(l.team)} vs ${esc(l.opp)}</span>${l.status ? ` <span class="badge">${esc(l.status)}</span>` : ''}${why}</div>
    <div class="big">${legName(l)} <span class="sub">(line ${l.point})</span> · ${price(l.best.price)} <span class="sub">${esc(l.best.name)}</span></div>
    <div>Model <b>${pc(l.pModel)}</b> vs devigged <b>${l.best.devig ? pc(l.best.devig.p) : '–'}</b> → edge <b>${sp(l.bestEdge)} pts</b> <span class="sub">(3rd-best book ${sp(l.edge3)} pts) · ${l.clearing.length} of ${l.verified} books ≥ 3% (${esc(l.clearing.map(b => b.name).join(', '))})</span></div>
    <div>Stake ${pc(l.stake, 2)} of bankroll <span class="sub">(¼ Kelly, capped)</span> · EV ${sp(l.ev)}% per unit staked</div>
    <div class="sub">${esc(l.lines.text)}</div>
    <div class="sub">Projection ${l.proj.toFixed(1)} at ${l.finalMin.toFixed(1)} min vs base ${l.base.toFixed(1)} at ${l.baseMin.toFixed(1)} min${l.vacMin > 0.05 ? ` (+${l.vacMin.toFixed(1)} vacated min)` : ''} · model p at base ${l.pBase == null ? '–' : pc(l.pBase)}</div>
  </div>`;
}

function ladderHtml(L) {
  const rows = L.rows.map(r => `<tr class="${r.qualified ? 'q' : ''}">
    <td class="l">${r.T}+ ${SLN[r.s]} <span class="sub">(o${r.point}${r.isMain ? ', main' : ''})</span></td>
    <td>${price(r.best.price)} <span class="sub">${esc(r.best.name)}</span></td>
    <td>${r.verified}</td>
    <td>${pc(r.pModel)}</td>
    <td>${r.best.devig ? pc(r.best.devig.p) : '<span class="warn">can’t devig</span>'}</td>
    <td>${sp(r.bestEdge)}</td>
    <td>${r.clearing.length}</td>
    <td>${sp(r.ev)}%</td>
    <td class="l">${r.qualified ? (r.headline ? '<b>clears</b>' : r.minutesDependent ? 'clears only with added minutes' : 'bench caution') : ''}</td>
  </tr>`).join('');
  return `<h3>${esc(L.name)} — ${SLN[L.s]} <span class="sub">${esc(L.team)} vs ${esc(L.opp)} · projection ${L.proj.toFixed(1)} (base ${L.base.toFixed(1)})</span></h3>
    <div class="scroll"><table><tr><th class="l">Rung</th><th>Best verified price</th><th>Books</th><th>Model p</th><th>Devig p</th><th>Edge (pts)</th><th>Books ≥3%</th><th>EV / unit</th><th class="l"></th></tr>${rows}</table></div>
    <div class="sub">Trade-off: higher rungs pay more but hit less often — compare EV per unit, not just the price. Rungs a book doesn't offer are skipped, never filled.</div>`;
}

function parlayHtml(P, phase) {
  if (!P || !P.best) {
    const why = !P ? 'no legs cleared the bar' : P.poolSize < 2 ? `only ${P.poolSize} leg${P.poolSize === 1 ? '' : 's'} cleared the 3%-at-3-books bar` : `no combination of qualifying legs had positive value at a single book (${P.considered} considered${P.rejected.length ? `, ${P.rejected.length} rejected for un-estimable correlation or no common book` : ''})`;
    return `<div class="banner b-none">No parlay today — ${esc(why)}.</div>`;
  }
  const b = P.best;
  return `<div class="panel">
    <b>${phase === 'morning' ? 'Candidate parlay (FLAG ONLY — not cleared)' : 'Parlay (all legs cleared at this check)'}</b> · ${b.legs.length} legs at ${esc(b.book.name)}
    <ul>${b.legs.map((l, i) => `<li>${esc(l.name)} ${legName(l)} @ ${price(b.book.prices[i])} — model ${pc(l.pModel)}, edge ${sp(l.bestEdge)} pts, clears at ${l.clearing.length} books</li>`).join('')}</ul>
    <div>Combined odds (product of ${esc(b.book.name)} leg prices): <b>${price(b.book.dec)}</b>${b.sameGame ? ' <span class="warn">— same-game legs: the book prices SGPs with its own correlation engine, so the real price will usually be lower than this product</span>' : ''}</div>
    <div>Independent product ${pc(b.indep)} → correlation-adjusted joint probability <b>${pc(b.joint)}</b> · EV ${sp(b.ev)}% per unit · stake ${pc(b.stake, 2)} (¼ Kelly, capped ${pc(STAKE_CAP_PARLAY)})</div>
    <div class="sub">Correlation method: joint ≈ product of leg probabilities × each pair's lift, where lift = P(both hit) ÷ (P(A)·P(B)) measured from actual game-by-game outcomes (his own games for same-player legs; games both players played for same-game legs), shrunk toward 1 by n/(n+20) and bounded 0.6–1.6 because small samples exaggerate co-movement. 3-leg parlays multiply the pairwise lifts (an approximation). Capped at the weakest leg. Same-game pairs with too few shared games are not built.</div>
    <ul>${b.pairs.map(p => `<li>${esc(p.a.name)} ${legName(p.a)} + ${esc(p.b.name)} ${legName(p.b)}: lift ${p.lift.toFixed(2)} — ${esc(p.method)}. ${esc(p.script)}.</li>`).join('')}</ul>
  </div>`;
}

function weeklyHtml(w) {
  const line = (lab, s) => `<li>${lab}: ${s.n} logged, ${s.graded} graded (${s.w}-${s.l}), ROI ${s.roi == null ? '–' : sp(s.roi) + '%'} per 1-unit flat stake, avg CLV ${s.clv == null ? '–' : (s.clv >= 0 ? '+' : '') + s.clv.toFixed(1) + '%'}${s.clvN ? ` (n=${s.clvN})` : ''}</li>`;
  return `<div class="panel"><b>Last 7 days</b> <span class="sub">(since ${w.from}; full log: <a href="../log/plays.csv">plays.csv</a>)</span><ul>${line('Cleared plays', w.cleared)}${line('Morning flags', w.flagged)}</ul></div>`;
}

function renderReport(d) {
  const isMorning = d.phase === 'morning';
  const banner = isMorning ? '<div class="banner b-flag">MORNING SCAN — FLAGS ONLY. Nothing here is a cleared play. Legs clear only at the 60- and 15-minute re-checks.</div>'
    : `<div class="banner b-clear">${esc(d.phase)} RE-CHECK — legs below cleared the ${pc(EDGE_MIN, 0)} edge bar at ${MIN_BOOKS}+ books at this check (${esc(d.gamesLabel)}).</div>`;
  const ranked = d.ranked.length ? d.ranked.map(legCard).join('')
    : `<div class="banner b-none">Nothing ${isMorning ? 'flagged' : 'cleared'} — no leg reached a ${pc(EDGE_MIN, 0)} edge at ${MIN_BOOKS}+ books${d.oddsOk ? '' : ' (no live odds this run, so no edges could be computed)'}. That is a valid result.</div>`;
  const held = d.held.length ? `<h2>Clears only with added minutes or bench scaling — not headlined</h2>${d.held.map(legCard).join('')}` : '';
  const ladders = d.ladders.length ? `<h2>Ladders</h2>${d.ladders.map(ladderHtml).join('')}` : '';
  const gaps = d.gaps.length ? `<h2>Gaps this run</h2><div class="panel"><ul>${d.gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul></div>` : '';
  return page(`Edges ${d.D} ${d.phase}`, `
    <h1>NBA prop edges — ${esc(d.D)} · ${esc(d.phase)}</h1>
    <div class="sub">Run ${esc(d.runAt)} ET · <a href="../index.html">all reports</a> · <a href="../../index.html">matchup board</a></div>
    ${banner}
    ${statusHtml(d.status)}
    <h2>${isMorning ? 'Flagged legs' : 'Cleared legs'} — ranked by edge at the 3rd-best book</h2>
    ${ranked}
    ${held}
    <h2>Parlay</h2>${parlayHtml(d.parlay, d.phase)}
    ${ladders}
    ${gaps}
    <h2>Review</h2>${weeklyHtml(d.weekly)}
    <h2>Method</h2><div class="panel sub"><ul>
      <li>Projection = the board's own projection (minutes first, attempts × efficiency, pace), blending vs-team ${d.weights.vt} / own form ${d.weights.l5} / opponent positional (full season) ${d.weights.op}, read from the board code, not recomputed.</li>
      <li>Probability: every game in his current-role vs-team meetings and his last 10 → per-36 × projected minutes, weighted by the blend weights split across each line's games, rescaled so the mean equals the projection; P(stat ≥ rung) from a Gaussian-kernel smooth of that weighted distribution (continuity-corrected, clamped 1–99%). Small samples make these probabilities noisy — check n on the board card.</li>
      <li>Devig: two-way (over + under at the same book and line) → proportional. One-sided alt rungs → that book's own main-line margin for the player/stat, applied proportionally. A rung that can't be devigged doesn't count toward the bar.</li>
      <li>Edge = model probability − devigged implied probability. A leg qualifies when ≥ ${MIN_BOOKS} books each show an edge ≥ ${pc(EDGE_MIN, 0)}. "Edge 3rd book" is the edge at the third-best book — the honest strength of the 3-book bar.</li>
      <li>Not headlined: legs that clear only with vacated minutes / usage bump added (base projection fails the bar), or that the board flags with a minutes-scaling caution.</li>
      <li>Stake: ¼ Kelly at the best verified price, capped ${pc(STAKE_CAP_SINGLE, 0)} per single and ${pc(STAKE_CAP_PARLAY)} per parlay, as % of bankroll. Never a dollar amount.</li>
      <li>The agent never places bets. These are matchup-based opportunities to review, not locks.</li>
    </ul></div>`);
}

function renderIndex(entries) {
  const byDay = {};
  for (const e of entries) (byDay[e.date] = byDay[e.date] || []).push(e);
  const days = Object.keys(byDay).sort().reverse();
  const body = days.length ? days.map(d => `<h2>${d}</h2><ul>${byDay[d].sort((a, b) => a.file < b.file ? 1 : -1).map(e => `<li><a href="${e.date}/${e.file}">${esc(e.label)}</a> <span class="sub">${esc(e.summary || '')}</span></li>`).join('')}</ul>`).join('')
    : '<div class="banner b-none">No reports yet.</div>';
  return page('NBA prop edges', `<h1>NBA prop edges — reports</h1><div class="sub"><a href="../index.html">matchup board</a> · <a href="log/plays.csv">play log (CSV)</a> · morning scans are flags only; re-check reports list cleared legs</div>${body}`);
}

module.exports = { renderReport, renderIndex };
