'use strict';
/* UI layer: renders the board; weights are live (re-render only, no refetch). */

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f1 = v => v == null || !isFinite(v) ? '–' : (Math.round(v * 10) / 10).toFixed(1);
const f0 = v => v == null || !isFinite(v) ? '–' : String(Math.round(v));
const pc = v => v == null ? '–' : v.toFixed(1) + '%';
const md = d => d ? d.slice(5).replace('-', '/') : '';
const nTag = (n, full = 5) => `<span class="badge ${n < full ? 'b-warn' : 'b-n'}">n=${n}</span>`;

const W_DEFAULT = { vt: 50, l5: 25, op: 25 };
let W = { ...W_DEFAULT };
try { const s = JSON.parse(localStorage.getItem('nba-board-weights') || 'null'); if (s && ['vt', 'l5', 'op'].every(k => typeof s[k] === 'number')) W = s; } catch (e) { }

let BOARD = null, RAW = null, VIEW_DATE = null, FOLLOW_TODAY = true, BUILDING = false, LAST_BUILD = null;

function setStatus(t) { $('#status').textContent = t; }

/* ---------- build ---------- */

async function build(D) {
  if (BUILDING) return;
  BUILDING = true;
  VIEW_DATE = D;
  $('#date').value = D;
  $('#board').innerHTML = '';
  $('#nav').innerHTML = '';
  try {
    const raw = await loadRaw(D, setStatus);
    if (raw.empty) {
      BOARD = null;
      const nx = raw.next;
      $('#board').innerHTML = `<div class="quiet">No games on ${fmtDay(D)}.${nx ? ` <a href="#" id="gonext">Next slate: ${fmtDay(nx)}</a>` : ''}</div>`;
      if (nx) $('#gonext').onclick = e => { e.preventDefault(); FOLLOW_TODAY = false; build(nx); };
      setStatus(`Checked ${new Date().toLocaleTimeString()} — no games.`);
      return;
    }
    setStatus('Computing rotations…');
    const pids = prepareTeams(raw);
    const gl = await loadGamelogs(pids, [raw.seasonYear - 1, raw.seasonYear - 2], setStatus);
    setStatus('Building board…');
    RAW = raw;
    BOARD = buildBoard(raw, gl);
    LAST_BUILD = new Date();
    render();
    const pastNote = D < etNowParts().date ? ' · past date: injuries/rosters are as of today, not that day' : '';
    setStatus(`Built ${LAST_BUILD.toLocaleString()} from ${BOARD.boxCount} completed box scores${pastNote}`);
  } catch (e) {
    console.error(e);
    $('#board').innerHTML = `<div class="quiet">Could not build the board: ${esc(e.message)}<br><small>Nothing is shown rather than partial or guessed data. Try Refresh.</small></div>`;
    setStatus('Build failed.');
  } finally { BUILDING = false; }
}

function fmtDay(d) { return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); }

/* ---------- render ---------- */

function render() {
  if (!BOARD) return;
  const nav = BOARD.games.map(g => `<a href="#g-${g.id}">${esc(BOARD.teams[g.away].abbr)} @ ${esc(BOARD.teams[g.home].abbr)} · ${etTime(g.date).replace(' ET', '')}</a>`).join('');
  $('#nav').innerHTML = nav;
  $('#board').innerHTML = `<div class="status" style="margin:-4px 0 10px">${fmtDay(BOARD.D)} · ${BOARD.games.length} games · season ${seasonLabel(BOARD.seasonYear)}</div>` + BOARD.games.map(renderGame).join('');
  $('#board').classList.toggle('hide-unflagged', $('#flagged').checked);
}

function renderGame(g) {
  const T = BOARD.teams, A = T[g.away], H = T[g.home];
  const p = g.proj;
  const projHtml = p ? `<div class="blk"><span class="lbl">Projected score · model <span class="badge b-mod">MODELED</span></span>
      <b>${esc(A.abbr)} ${f1(p.away)} – ${esc(H.abbr)} ${f1(p.home)}</b> · Total ${f1(p.total)} · ${esc(p.margin >= 0 ? H.abbr : A.abbr)} −${f1(Math.abs(p.margin))} · pace ${f1(p.pace)}</div>` :
    `<div class="blk"><span class="lbl">Projected score</span>Not enough completed games to model.</div>`;
  const o = g.odds;
  const mkt = o && (o.details || o.total != null) ? `<div class="blk"><span class="lbl">Market · ${esc(o.provider)}</span><b>${esc(o.details || '—')}</b>${o.total != null ? ` · O/U ${o.total}` : ''}</div>` :
    `<div class="blk"><span class="lbl">Market line</span>Not posted at source — none shown.</div>`;
  const script = g.trim > 0 ? `Game script: ${g.scriptSource} ${f1(g.scriptMargin)} → blowout risk; projected starters on both sides trimmed ${f1(g.trim)} min (fourth-quarter stats lost) <span class="badge b-mod">MODELED</span>` :
    `Game script: ${g.scriptSource} ${f1(g.scriptMargin)} — no blowout trim applied.`;
  return `<section class="game" id="g-${g.id}">
    <div class="ghead">
      <div class="matchup">${esc(A.short)}<span class="at">@</span>${esc(H.short)}<span class="tip">${etTime(g.date)}</span></div>
      <div class="score">${projHtml}${mkt}</div>
      <div class="script">${script}</div>
      <div class="script">Scheme tags <span class="badge b-mod">MODELED BUCKET</span>: ${[g.away, g.home].map(t => `<b>${esc(T[t].abbr)}</b> ${tagChips(g.sides[t])}`).join(' &nbsp;·&nbsp; ')} <span style="color:var(--ink3)">— numbers and rule on each team panel</span></div>
    </div>
    <div class="teams">${[g.away, g.home].map(t => renderTeamSide(g, t)).join('')}</div>
    <div class="cols">${[g.away, g.home].map(t => renderCol(g, t)).join('')}</div>
  </section>`;
}

function renderTeamSide(g, tid) {
  const s = g.sides[tid], team = s.team, R = s.rating, Tm = s.T;
  const tags = tagChips(s);
  const rest = s.rest.rest == null ? '' : s.rest.b2b ? '<span class="badge b-down">BACK-TO-BACK</span>' : `${s.rest.rest} day${s.rest.rest === 1 ? '' : 's'} rest`;
  const meta = R && R.gp ? `${R.gp} GP · pace ${f1(R.pace)} (#${R.paceRank}) · ORtg ${f1(R.ortg)} (#${R.ortgRank}) · DRtg ${f1(R.drtg)} (#${R.drtgRank}) · ${rest}${s.rest.threeInFour && !s.rest.b2b ? ' · 3 games in 4 nights' : ''}` : 'No completed games yet';
  const outs = Tm.outs.length ? Tm.outs.map(v => `${esc(v.name)} (${esc(v.status)}${v.min > 0.05 ? `, vacates ${f1(v.min)} min` : v.apps === 0 ? ', already out of recent games' : ''})`).join('; ') : 'none';
  const recon = Tm.vacTotal > 0.05 ? `<div class="recon">Vacated ${f1(Tm.vacTotal)} min = placed ${f1(Tm.placed)} on rotation players + ${f1(Tm.unallocated)} unallocated (no backfill players invented) <span class="badge b-mod">MODELED</span></div>` : '';
  const ret = Tm.returning.length ? `<div class="recon">Returning to rotation: ${Tm.returning.map(x => `${esc(x.r.name)} (last played ${md(x.lastPlayed)})`).join(', ')} — teammates' recent minutes may be inflated by his absence; not adjusted.</div>` : '';
  return `<div class="tside">
    <div class="tname">${esc(team.name)} ${tags}</div>
    <div class="tmeta">${meta}</div>
    <div class="outline"><b>Out:</b> ${outs}</div>${recon}${ret}
    ${renderTvp(s)}
  </div>`;
}

function tagChips(s) {
  return s.tags.length ? s.tags.map(t => `<span class="tag ${t.tag[0] === 'P' ? 'p' : 'i'}">${t.tag}</span>`).join(' ') : '<span class="tag none">NO WEAKNESS TAG</span>';
}

const TAG_RULE_TXT = `Rule: a tag fires when BOTH of its numbers are ≥ ${Math.round(TAG_MIN_PCT * 100)}% above the league average for the same buckets this season.`;

function renderTagChecks(s) {
  const pct = m => `${m.pct >= 0 ? '+' : ''}${Math.round(m.pct * 100)}%`;
  const rows = s.tagChecks.map(r => {
    const nums = r.metrics.map(m => `<span class="${m.pct >= TAG_MIN_PCT ? 'hitm' : ''}">${SL[m.s]} ${f1(m.v)}/g vs lg ${f1(m.lg)} (${pct(m)})</span>`).join(' · ');
    return `<div class="tagd">${r.fired ? `<span class="tag ${r.tag[0] === 'P' ? 'p' : 'i'}">${r.tag}</span>` : `<span class="tag none">${r.tag}: not fired</span>`} ${r.label} allowed — ${nums}</div>`;
  }).join('');
  return `<div class="tagbox"><div class="tagd"><b>Scheme tags</b> — team tendencies from box scores, not defensive assignments or coverage schemes (those aren't measurable from box scores and aren't shown) <span class="badge b-mod">MODELED BUCKET</span>${s.tvp.gp < SMALL_GP ? ' <span class="badge b-warn">SMALL SAMPLE</span>' : ''}</div>
    ${rows}<div class="tagd">${TAG_RULE_TXT}</div></div>`;
}

function renderTvp(s) {
  const tv = s.tvp, lg = BOARD.ctx.tvpLg;
  if (!tv || !tv.gp) return '<div class="empty">Team-vs-position: n=0 games.</div>';
  const cell = (P, k) => {
    const v = tv[P][k], L = lg[P][k];
    const r = tv[P][k + 'Rank'];
    const cls = r <= 6 ? 'soft' : r >= 25 ? 'tough' : '';
    return `<td class="${cls}" title="League avg ${f1(L)} · #${r} most allowed">${f1(v)}</td>`;
  };
  return `<table class="tvp"><caption>What <b>${esc(s.team.abbr)}</b> allows per game to each position — <b>TEAM TOTAL</b> (all opposing players at the position combined, not a single-player rate) · GP ${tv.gp} ${tv.gp < SMALL_GP ? '<span class="badge b-warn">SMALL SAMPLE</span>' : ''} <span class="badge b-mod">MODELED BUCKET</span> · <span class="soft">&nbsp;soft: 6 most allowed&nbsp;</span> <span class="tough">&nbsp;tough: 6 fewest&nbsp;</span></caption>
    <tr><th>Pos</th><th>GP</th><th>MIN</th>${STATS.map(k => `<th>${SL[k]}</th>`).join('')}</tr>
    ${POS5.map(P => `<tr><td>${P}</td><td>${tv.gp}</td><td>${f0(tv[P].min)}</td>${STATS.map(k => cell(P, k)).join('')}</tr>`).join('')}
  </table>${renderTagChecks(s)}`;
}

function renderCol(g, tid) {
  const s = g.sides[tid], Tm = s.T;
  const short = s.cards.length < 9 ? `Only ${s.cards.length} real rotation players available — no ninth invented` : '9-man projected rotation';
  return `<div class="col">
    <div class="colhead">${esc(s.team.name)} <span>${short}</span></div>
    ${s.cards.map(c => renderCard(c, g)).join('') || '<div class="empty">No projectable players.</div>'}
  </div>`;
}

function statCells(r, cls = '') {
  return STATS.map(s => `<td class="${cls}">${r ? (Number.isInteger(r[s]) ? r[s] : f1(r[s])) : '–'}</td>`).join('');
}
const STH = STATS.map(s => `<th>${SL[s]}</th>`).join('');

function renderCard(c, g) {
  const bl = blendCard(c, W);
  const notes = cardNotes(c);
  const env = environmentNote(c);
  const scr = screenFlags(c, bl);
  const cau = cautions(c, bl);
  const opp = BOARD.teams[c.oid].abbr;

  // header
  const status = c.status ? `<span class="badge b-warn" title="${esc(c.statusComment)}">${esc(c.status.toUpperCase())}</span>` : '';
  const rest = c.rest.b2b ? `<span class="badge b-down">B2B${c.yesterdayMin != null ? ` · ${c.yesterdayMin} min last night` : ''}</span>` : (c.rest.rest != null ? `<span class="badge b-n">${c.rest.rest}d rest</span>` : '');
  const ret = c.returning ? `<span class="badge b-warn">RETURNING · last played ${md(c.lastPlayed)}</span>` : '';
  const minParts = [`base ${f1(c.baseMin)}`];
  if (c.vacMin > 0.05) minParts.push(`+${f1(c.vacMin)} vacated`);
  if (c.trimMin > 0) minParts.push(`−${f1(c.trimMin)} blowout`);
  const pos = `${c.pos}${c.posInferred ? ' <span class="badge b-mod" title="' + esc(c.posNote) + '">INFERRED</span>' : ''}`;

  // projection strip
  const proj = STATS.map(s => {
    const a = bl.adj[s], b = bl.base[s];
    const sub = bl.adjusted ? `<div class="b">base ${f1(b)}${(c.bump[s] || 0) > 0.05 ? ` · +${f1(c.bump[s])} usage` : ''}</div>` : '<div class="b">&nbsp;</div>';
    return `<div><div class="k">${SL[s]}</div><div class="v">${f1(a)}</div>${sub}</div>`;
  }).join('');

  // blend table
  const lineN = { vt: c.vt.n, l5: c.own5.length, op: c.log.n };
  const usedTxt = k => bl.used[k] != null ? bl.used[k] + '%' : lineN[k] ? '0%' : '0% (n=0)';
  const blend = `<table class="t blend">
    <tr><th class="l">Per 36</th><th>wt</th>${STH}</tr>
    <tr><td class="l">Vs ${esc(opp)} ${nTag(c.vt.n)}</td><td>${usedTxt('vt')}</td>${statCells(c.vt.n ? c.vt.p36 : null)}</tr>
    <tr><td class="l">Own last 5 ${nTag(c.own5.length)}</td><td>${usedTxt('l5')}</td>${statCells(c.own5.length ? c.l5p36 : null)}</tr>
    <tr><td class="l">Opp ${c.pos} log ${nTag(c.log.n)}</td><td>${usedTxt('op')}</td>${statCells(c.log.n ? c.log.p36 : null)}</tr>
    <tr class="fin"><td class="l">Blend /36 → × ${f1(c.finalMin)} min</td><td></td>${statCells(bl.b36)}</tr>
  </table>${bl.renormalized ? `<div class="rates">A line with n=0 is dropped; weights renormalized to ${['vt', 'l5', 'op'].filter(k => bl.used[k] != null).map(k => ({ vt: 'vs-team', l5: 'own L5', op: 'opp log' })[k] + ' ' + bl.used[k] + '%').join(' / ')}.</div>` : ''}`;

  // line 1: own last 5, per 36
  const r = c.rates;
  const l1rows = c.own5.map(x => `<tr title="Raw: ${STATS.map(s => SL[s] + ' ' + x[s]).join(', ')}"><td class="l">${md(x.date)}</td><td class="l">${x.oppId === c.oid ? '<b>' : ''}${esc(BOARD.teams[x.oppId] ? BOARD.teams[x.oppId].abbr : '?')}${x.oppId === c.oid ? '</b>' : ''}${x.teamId !== c.tid ? '*' : ''}</td><td>${x.min}</td>${STATS.map(s => `<td>${f1(x[s] / x.min * 36)}</td>`).join('')}</tr>`).join('');
  const line1 = `<div class="sec"><div class="sech">1 · Own last 5 this season — per 36 ${nTag(c.own5.length)}${c.priorClubInL5 ? '<span class="sub">* = with prior club</span>' : ''}</div>
    ${c.own5.length ? `<table class="t"><tr><th class="l">Date</th><th class="l">Opp</th><th>MIN</th>${STH}</tr>${l1rows}
      <tr class="sum"><td class="l" colspan="2">Per 36 (aggregate)</td><td>${f1(c.l5raw.min)}</td>${statCells(c.l5p36)}</tr>
      <tr class="sum2"><td class="l" colspan="2">Raw avg</td><td></td>${statCells(c.l5raw)}</tr></table>
      <div class="rates">USG L5 ${pc(r.usg5)} · FGA ${f1(r.fgaPg)}/g, ${f1(r.fga36)}/36 · 3PA ${f1(r.tpaPg)}/g, ${f1(r.tpa36)}/36 · FTA ${f1(r.fta36)}/36<br>
      FG% L5 ${pc(r.s5.fg)} · L${r.s10.n} ${pc(r.s10.fg)} · season ${pc(r.sSeason.fg)} &nbsp; 3P% L5 ${pc(r.s5.tp)} · L${r.s10.n} ${pc(r.s10.tp)} · season ${pc(r.sSeason.tp)} &nbsp; FT% season ${pc(r.sSeason.ft)}</div>` : '<div class="empty">n=0 — no games this season.</div>'}</div>`;

  // line 2: opponent positional log
  const L = c.log;
  const l2rows = L.rows.map(x => x.missing ? `<tr class="split"><td class="l">${md(x.date)}</td><td class="l" colspan="9">no ${c.pos} bucketed in this game — not filled</td></tr>` :
    `<tr class="${x.blowout || x.shortMin ? 'flag' : ''}"><td class="l">${md(x.date)}</td><td class="l nm" title="${esc(x.name)} (${esc(BOARD.teams[x.teamId] ? BOARD.teams[x.teamId].abbr : '')})">${x.pid === c.pid ? '<b>him</b>' : esc(x.name.split(' ').slice(-1)[0])} <span style="color:var(--ink3)">${esc(BOARD.teams[x.teamId] ? BOARD.teams[x.teamId].abbr : '')}</span></td><td>${x.min}</td>${statCells(x)}<td class="l">${x.blowout ? `±${Math.abs(x.margin)}` : ''}${x.shortMin ? ' &lt;20m' : ''}</td></tr>`).join('');
  const S = L.summary;
  const srow = (lab, k) => `<tr class="sum2"><td class="l" colspan="3">${lab}</td>${STATS.map(s => `<td>${f1(S[s][k])}</td>`).join('')}<td></td></tr>`;
  const hits = STATS.map(s => `${SL[s]} ${S[s].hits.map(h => `${h.t}+ ${h.k}/${L.n}`).join(', ')}`).join(' · ');
  const line2 = `<div class="sec"><div class="sech">2 · ${esc(opp)} vs last 5 ${c.pos}s ${nTag(L.n)} <span class="badge b-mod">MODELED BUCKET</span><span class="sub">primary ${c.pos} each game, raw</span></div>
    ${L.n ? `<table class="t"><tr><th class="l">Date</th><th class="l">Player</th><th>MIN</th>${STH}<th class="l"></th></tr>${l2rows}
      <tr class="sum"><td class="l" colspan="3">Per 36 (both sides)</td>${statCells(L.p36)}<td></td></tr>
      ${srow('Avg', 'avg')}${srow('Median', 'med')}${srow('High', 'hi')}${srow('Low', 'lo')}
      ${L.vsNorm.pts ? `<tr class="sum2" title="Each opposing player's actual line vs his own season rate (excluding that game) at the same minutes"><td class="l" colspan="3">vs their own norm (n=${L.vsNorm.pts.n})</td>${STATS.map(s => { const v = L.vsNorm[s]; return `<td>${v && v.ratio != null ? (v.ratio >= 1 ? '+' : '') + Math.round((v.ratio - 1) * 100) + '%' : '–'}</td>`; }).join('')}<td></td></tr>` : ''}</table>
      <div class="hits">Hits: ${hits}</div>` : `<div class="empty">n=0 — no ${c.pos} found in ${esc(opp)}'s recent box scores.</div>`}
    ${(() => {
      const own = L.used.filter(x => x.pid === c.pid);
      const fl = own.length ? [...L.flags, `Includes his own game${own.length > 1 ? 's' : ''} vs ${opp} (${own.map(x => md(x.date)).join(', ')}) — the same game also appears in line 3, so it counts twice in the blend`] : L.flags;
      return fl.length ? `<ul class="flags">${fl.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : '';
    })()}</div>`;

  // line 3: vs this team
  const V = c.vt;
  const vrow = x => `<tr class="${x.seg !== 'current' ? 'split' : ''}${x.margin != null && Math.abs(x.margin) >= BLOWOUT ? ' flag' : ''}"><td class="l">${md(x.date)}/${x.date.slice(2, 4)}</td><td class="l">${esc(BOARD.teams[x.teamId] ? BOARD.teams[x.teamId].abbr : '?')}${x.typ === 'PO' ? ' PO' : ''}</td><td>${x.min}</td>${statCells(x)}<td class="l">${x.margin != null ? (x.margin > 0 ? '+' : '') + x.margin : ''}</td></tr>`;
  const segHtml = V.segs.map(sg => `<div class="segl">${esc(sg.label)} ${nTag(sg.rows.length)}</div>
    <table class="t"><tr><th class="l">Date</th><th class="l">For</th><th>MIN</th>${STH}<th class="l">Mgn</th></tr>${sg.rows.map(vrow).join('')}
    <tr class="sum"><td class="l" colspan="3">Per 36</td>${statCells(sg.p36)}<td></td></tr></table>`).join('');
  const line3 = `<div class="sec"><div class="sech">3 · Last 5 vs ${esc(opp)} ${nTag(V.total)}<span class="sub">this season + ${seasonLabel(BOARD.seasonYear - 1)}, ${seasonLabel(BOARD.seasonYear - 2)}; incl. prior clubs</span></div>
    ${V.total ? segHtml : `<div class="empty">n=0 — no meetings in that window${V.priorAvailable ? '' : ' (prior-season log unavailable)'}.</div>`}</div>`;

  // notes
  const allNotes = [];
  scr.forEach(f => {
    const arrow = f.dir === 'up' ? '▲' : '▼';
    const badges = `${f.matchup ? '<span class="badge b-n">MATCHUP FLAG</span>' : ''}${f.pattern ? ' <span class="badge b-pat">PATTERN</span>' : ''}`;
    const body = [
      f.matchup ? `Tonight: ${esc(f.matchup)}` : '',
      f.pattern ? `Pattern (3+ separate games): ${esc(f.pattern)}${f.matchup ? '' : ' — tonight\'s three lines don\'t all agree'}` : ''
    ].filter(Boolean).join('<br>');
    allNotes.push(`<li class="n-scr-${f.dir}"><b>${SL[f.stat]} ${arrow}</b> ${badges} <span class="sig">matchup signal, not a pick</span><br>${body}</li>`);
  });
  cau.forEach(t => allNotes.push(`<li class="n-cau">${esc(t)}</li>`));
  notes.forEach(n => allNotes.push(`<li class="n-${n.kind}">${esc(n.text)}</li>`));
  if (env) allNotes.push(`<li class="n-${env.kind}">${esc(env.text)}</li>`);
  if (c.status) allNotes.push(`<li class="n-div">Listed ${esc(c.status)}${c.statusComment ? ': ' + esc(c.statusComment) : ''} — projected as if he plays.</li>`);

  return `<article class="card ${scr.length ? 'has-flag' : ''}">
    <div class="chead"><span class="pname">${esc(c.name)}</span><span class="ppos">${pos}</span>${status}${rest}${ret}
      <span class="pmin">MIN <b>${f1(c.finalMin)}</b> <span>(${minParts.join(' ')})</span></span></div>
    <div class="proj">${proj}</div>
    <div class="cbody">
      ${blend}
      ${allNotes.length ? `<ul class="notes">${allNotes.join('')}</ul>` : ''}
      ${line1}${line2}${line3}
    </div>
  </article>`;
}

/* ---------- controls ---------- */

function syncWeights() {
  for (const k of ['vt', 'l5', 'op']) { $('#w-' + k).value = W[k]; }
  const tot = W.vt + W.l5 + W.op || 1;
  for (const k of ['vt', 'l5', 'op']) $('#wv-' + k).textContent = Math.round(100 * W[k] / tot) + '%';
}
let rT = null;
function onWeights() {
  for (const k of ['vt', 'l5', 'op']) W[k] = +$('#w-' + k).value;
  syncWeights();
  try { localStorage.setItem('nba-board-weights', JSON.stringify(W)); } catch (e) { }
  clearTimeout(rT);
  rT = setTimeout(() => { const y = window.scrollY; render(); window.scrollTo(0, y); }, 120);
}
['vt', 'l5', 'op'].forEach(k => $('#w-' + k).addEventListener('input', onWeights));
$('#wreset').onclick = () => { W = { ...W_DEFAULT }; syncWeights(); onWeights(); };
$('#flagged').onchange = () => $('#board').classList.toggle('hide-unflagged', $('#flagged').checked);
$('#prev').onclick = () => { FOLLOW_TODAY = false; build(addDays(VIEW_DATE, -1)); };
$('#next').onclick = () => { FOLLOW_TODAY = false; build(addDays(VIEW_DATE, 1)); };
$('#today').onclick = () => { FOLLOW_TODAY = true; build(etNowParts().date); };
$('#date').onchange = e => { if (e.target.value) { FOLLOW_TODAY = false; build(e.target.value); } };
$('#refresh').onclick = () => build(VIEW_DATE);

/* 8:07 AM ET daily rebuild while the page is open */
function scheduleMorning() {
  const n = etNowParts();
  const nowMin = n.h * 60 + n.m, target = 8 * 60 + 7;
  let mins = target - nowMin;
  if (mins <= 0) mins += 24 * 60;
  setTimeout(() => {
    if (FOLLOW_TODAY) build(etNowParts().date);
    scheduleMorning();
  }, mins * 60000);
}

(function init() {
  syncWeights();
  const q = new URLSearchParams(location.search).get('date');
  if (q && /^\d{4}-\d{2}-\d{2}$/.test(q)) FOLLOW_TODAY = false;
  build(FOLLOW_TODAY ? etNowParts().date : q);
  scheduleMorning();
})();
