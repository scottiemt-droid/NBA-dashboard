'use strict';
/* Edge-agent panel: reads the agent's own reports (reports/index.json + the per-run JSON) for the date being
   viewed. Nothing is recomputed here — the board only displays what the agent wrote. */

let AGENT = { D: null, entries: [], latest: null, data: null, legs: {}, error: null };

const AGENT_SL = { pts: 'PTS', reb: 'REB', ast: 'AST', tpm: '3PM' };
const agentPct = v => v == null ? '–' : (100 * v).toFixed(1) + '%';
const agentPts = v => v == null ? '–' : (v >= 0 ? '+' : '') + (100 * v).toFixed(1) + ' pts';
const agentLeg = l => `${l.side === 'over' ? l.threshold + '+' : '≤' + (l.threshold - 1)} ${AGENT_SL[l.stat]}`;

async function loadAgent(D) {
  AGENT = { D, entries: [], latest: null, data: null, legs: {}, error: null };
  try {
    const r = await fetch('reports/index.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('no agent reports published yet');
    const all = await r.json();
    AGENT.entries = all.filter(e => e.date === D).sort((a, b) => a.file < b.file ? 1 : -1);
    AGENT.latest = AGENT.entries[0] || null;
    if (AGENT.latest) {
      const j = await fetch(`reports/${D}/${AGENT.latest.file.replace(/\.html$/, '.json')}`, { cache: 'no-store' });
      if (j.ok) AGENT.data = await j.json();
    }
    for (const l of [...((AGENT.data && AGENT.data.ranked) || []), ...((AGENT.data && AGENT.data.held) || [])]) {
      (AGENT.legs[`${l.player}|${l.team}`] = AGENT.legs[`${l.player}|${l.team}`] || []).push(l);
    }
  } catch (e) { AGENT.error = e.message; }
  renderAgentPanel();
}

function agentPhaseLabel(phase) { return phase === 'morning' ? 'FLAG' : 'CLEARED'; }

function renderAgentPanel() {
  const el = $('#agent');
  if (!el) return;
  const A = AGENT, d = A.data;
  const all = '<a href="reports/index.html">all reports</a>';
  if (A.error) { el.innerHTML = `<b>Prop edge agent</b> — ${esc(A.error)} · ${all}`; return; }
  if (!A.latest) { el.innerHTML = `<b>Prop edge agent</b> — no report for ${fmtDay(A.D)} yet (morning scan runs after 8:07 AM ET on game days) · ${all}`; return; }
  const st = d && d.status;
  const odds = !st ? '' : st.odds.ok ? 'odds feed connected' : `<span class="agent-bad">odds feed: ${esc(st.odds.label)}</span>`;
  const phase = d ? d.phase : '';
  const morning = phase === 'morning';
  const top = d ? (d.ranked || []).slice(0, 5).map(l => `<li><b>${esc(l.player)}</b> ${agentLeg(l)} @ ${l.bestPrice.toFixed(2)} ${esc(l.bestBook)} — model ${agentPct(l.modelP)} vs ${agentPct(l.devigP)}, edge ${agentPts(l.edgeBest)}, ${l.booksClearing}/${l.booksOffering} books</li>`).join('') : '';
  const parlay = d && d.parlay ? `Parlay: ${d.parlay.legs.map(l => `${esc(l.player)} ${agentLeg(l)}`).join(' + ')} @ ${d.parlay.dec.toFixed(2)} (${esc(d.parlay.book)})` : 'No parlay';
  el.innerHTML = `<div><b>Prop edge agent</b> — latest: <a href="reports/${A.D}/${A.latest.file}">${esc(A.latest.label)}</a> · ${esc(A.latest.summary || '')} · ${odds} · ${all}</div>
    ${morning ? '<div class="agent-note">Morning scan: flags only — nothing is a cleared play until the 60/15-minute re-checks.</div>' : ''}
    ${top ? `<ul>${top}</ul>` : ''}
    ${d ? `<div class="agent-note">${parlay} · Agent uses the board's default 50/25/25 weights; moving the sliders doesn't change its numbers. Matchup signals, not picks.</div>` : ''}`;
}

function agentCardNote(c, teamAbbr) {
  const legs = AGENT.legs[`${c.name}|${teamAbbr}`];
  if (!legs || !AGENT.data) return '';
  const tag = agentPhaseLabel(AGENT.data.phase);
  const sorted = [...legs].sort((a, b) => (b.headline - a.headline) || ((b.edge3rdBook || 0) - (a.edge3rdBook || 0)));
  const shown = sorted.slice(0, 3).map(l => `${agentLeg(l)} @ ${l.bestPrice.toFixed(2)} ${esc(l.bestBook)} (model ${agentPct(l.modelP)} vs ${agentPct(l.devigP)}, ${agentPts(l.edgeBest)}, ${l.booksClearing}/${l.booksOffering} books${l.headline ? '' : ', not headlined — added minutes/bench'})`).join('<br>');
  const more = sorted.length > 3 ? ` · +${sorted.length - 3} more` : '';
  return `<li class="n-agent"><b>Agent ${tag}</b> — ${legs.length} leg${legs.length === 1 ? '' : 's'}${more} · <a href="reports/${AGENT.D}/${AGENT.latest.file}">full report & ladders</a><br>${shown}</li>`;
}
