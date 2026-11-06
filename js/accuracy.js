'use strict';
/* Model-accuracy panel: reads reports/model/summary.json written by agent/projections.js (daily snapshot, graded the
   next morning from box scores). Display only — weights are never changed from here. */

async function loadAccuracy() {
  const el = $('#accuracy');
  if (!el) return;
  let s = null;
  try { const r = await fetch('reports/model/summary.json', { cache: 'no-store' }); if (r.ok) s = await r.json(); } catch (e) { }
  if (!s) { el.innerHTML = '<summary><b>Model accuracy & retune</b> — no projection log published yet.</summary>'; return; }
  const n = v => v == null ? '–' : (+v).toFixed(2);
  const sg = v => v == null ? '–' : (v >= 0 ? '+' : '') + (+v).toFixed(2);
  const W = s.weights || {};
  const wtxt = w => w ? `${w.vt}/${w.l5}/${w.op}` : '–';
  const IN = { vt: 'vs-team', l5: 'own form', op: 'opp positional' };
  const rows = ['pts', 'reb', 'ast', 'tpm', 'stl', 'blk'].map(k => {
    const e = s.byStat[k];
    return `<tr><td class="l">${SL[k]}</td><td>${e.n}</td><td><b>${n(e.mae)}</b></td><td>${sg(e.bias)}</td><td>${n(e.inputs.vt.mae)}</td><td>${n(e.inputs.l5.mae)}</td><td>${n(e.inputs.op.mae)}</td><td>${n(e.blendOnSameRows.mae)}</td><td class="l">${s.bestInput[k] ? IN[s.bestInput[k]] : '–'}</td></tr>`;
  }).join('');
  const gt = s.market.gameTotals, pl = s.market.playerLines;
  const head = s.days ? `${s.days} graded day${s.days === 1 ? '' : 's'} · ${s.playerGames} player-games${s.pending ? ` · ${s.pending} day${s.pending === 1 ? '' : 's'} awaiting grading` : ''}` : `nothing graded yet${s.pending ? ` — ${s.pending} day${s.pending === 1 ? '' : 's'} logged, graded the morning after` : ''}`;
  el.innerHTML = `<summary><b>Model accuracy & retune</b> — ${head}</summary>
    <div class="acc">
      ${s.days ? `<div class="scroll"><table class="t"><tr><th class="l">Stat</th><th>n</th><th>Final MAE</th><th>Bias</th><th>Vs-team MAE</th><th>Own form MAE</th><th>Opp pos MAE</th><th>Blend, same rows</th><th class="l">Best input</th></tr>${rows}</table></div>
      <div class="rates">Input columns use only player-games where all three inputs existed (n=${W.n}); each input is projected at the same minutes and pace, so the columns compare rates, not minutes. Minutes MAE ${n(s.minutes.mae)} (bias ${sg(s.minutes.bias)}, n=${s.minutes.n}).</div>` : ''}
      <div class="rates"><b>Weights</b> (vs-team / own form / opp positional): logged with <b>${wtxt(W.current)}</b>${W.suggested ? ` · suggested from the misses: <b>${wtxt(W.suggested)}</b> (loss ${n(W.suggestedLoss)} vs ${n(W.currentLoss)} now; loss = Σ MAE ÷ mean actual over six stats)` : ''}. ${esc(W.verdict || '')} <i>Not applied automatically.</i></div>
      <div class="rates"><b>Vs the market — game totals</b> (ESPN/DraftKings close, last reading within 60 min of tip): ${gt.n ? `model MAE ${n(gt.modelMae)} vs close MAE ${n(gt.closeMae)} · model − close ${sg(gt.modelMinusClose)} · model's side of the close won ${gt.sideRecord.modelSideWon}/${gt.sideRecord.decided} · open→close moved toward the model ${gt.openToCloseMoveTowardModel.towardModel}/${gt.openToCloseMoveTowardModel.moved}. ` : ''}${esc(gt.verdict)}</div>
      <div class="rates"><b>Vs the market — player lines</b> (main lines the odds agent actually fetched): ${pl.n ? `projection MAE ${n(pl.projMae)} vs line MAE ${n(pl.lineMae)} · projection − line ${sg(pl.projMinusLine)} · projection's side won ${pl.sideRecord.projSideWon}/${pl.sideRecord.decided} (${pl.withClose} at a closing check). ` : ''}${esc(pl.verdict)} ${esc(pl.note || '')}</div>
      <div class="rates sub">Updated ${esc(new Date(s.updated).toLocaleString())}. Raw files: reports/model/.</div>
    </div>`;
}
