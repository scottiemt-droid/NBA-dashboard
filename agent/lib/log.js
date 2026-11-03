'use strict';
/* Running play log (reports/log/plays.csv): every flagged and cleared leg/parlay, closing price from the last
   check, result graded from ESPN box scores the next morning, and a 7-day ROI / CLV review. */

const fs = require('fs');
const path = require('path');

const COLS = ['date', 'run_at_et', 'phase', 'check', 'game_id', 'game', 'player_id', 'player', 'stat', 'side', 'line', 'threshold',
  'book', 'odds_dec', 'odds_am', 'model_p', 'devig_p', 'edge_best', 'edge_3rd_book', 'books_clearing', 'headline', 'minutes_dependent',
  'stake_pct', 'legs', 'close_odds_dec', 'clv_pct', 'result', 'actual'];

function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (ch !== '\r') f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

class PlayLog {
  constructor(root) {
    this.file = path.join(root, 'reports', 'log', 'plays.csv');
    this.rows = [];
    if (fs.existsSync(this.file)) {
      const [head, ...body] = parseCsv(fs.readFileSync(this.file, 'utf8'));
      if (head) this.rows = body.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] || ''])));
    }
    this.changed = false;
  }
  add(row) { this.rows.push(Object.fromEntries(COLS.map(c => [c, row[c] == null ? '' : row[c]]))); this.changed = true; }
  save() {
    if (!this.changed) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, [COLS.join(','), ...this.rows.map(r => COLS.map(c => cell(r[c])).join(','))].join('\n') + '\n');
  }

  // Closing price: the latest live price seen for the same leg at the same book (last check before tip wins).
  updateClose(date, legs) {
    for (const r of this.rows) {
      if (r.date !== date || r.stat === 'parlay') continue;
      const leg = legs.find(l => l.gameId === r.game_id && l.pid === r.player_id && l.s === r.stat && l.side === r.side && String(l.point) === r.line);
      const b = leg && leg.books.find(x => x.book === r.book);
      if (!b) continue;
      r.close_odds_dec = b.price.toFixed(3);
      r.clv_pct = (100 * (+r.odds_dec / b.price - 1)).toFixed(1);
      this.changed = true;
    }
  }

  // Grade earlier rows from completed box scores (board raw.boxes holds every completed game before today).
  grade(boxes, today) {
    const statOf = (box, pid, s) => { const p = box.players.find(x => x.id === pid); return p ? p[s] : null; };
    const legResult = (box, pid, s, side, T) => {
      const v = statOf(box, pid, s);
      if (v == null) return { res: 'VOID', v: 'DNP' };
      return { res: (side === 'over' ? v >= T : v <= T - 1) ? 'W' : 'L', v };
    };
    for (const r of this.rows) {
      if (r.result || r.date >= today) continue;
      if (r.stat === 'parlay') {
        const legs = r.legs.split(';').map(x => { const [gid, pid, s, side, T] = x.split(':'); return { gid, pid, s, side, T: +T }; });
        if (!legs.every(l => boxes[l.gid])) continue;
        const res = legs.map(l => legResult(boxes[l.gid], l.pid, l.s, l.side, l.T));
        r.result = res.some(x => x.res === 'L') ? 'L' : res.every(x => x.res === 'W') ? 'W' : 'VOID';
        r.actual = res.map(x => x.v).join('/');
      } else {
        const box = boxes[r.game_id];
        if (!box) continue;
        const x = legResult(box, r.player_id, r.stat, r.side, +r.threshold);
        r.result = x.res; r.actual = String(x.v);
      }
      this.changed = true;
    }
  }

  weekly(today, addDays) {
    const from = addDays(today, -7);
    const recent = this.rows.filter(r => r.date >= from && r.date < today);
    const sum = rows => {
      const graded = rows.filter(r => r.result === 'W' || r.result === 'L');
      const w = graded.filter(r => r.result === 'W').length;
      const profit = graded.reduce((t, r) => t + (r.result === 'W' ? +r.odds_dec - 1 : -1), 0);
      const clv = rows.filter(r => r.clv_pct !== '').map(r => +r.clv_pct);
      return { n: rows.length, graded: graded.length, w, l: graded.length - w, roi: graded.length ? profit / graded.length : null,
        clv: clv.length ? clv.reduce((a, b) => a + b, 0) / clv.length : null, clvN: clv.length };
    };
    return { from, cleared: sum(recent.filter(r => r.phase === 'cleared')), flagged: sum(recent.filter(r => r.phase === 'flag')) };
  }
}

module.exports = { PlayLog };
