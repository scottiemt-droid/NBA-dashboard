'use strict';
/* The Odds API client. Key comes only from ODDS_API_KEY and is never logged: every error message is scrubbed.
   One call per event per run (all four books come back together), cached for the rest of the run. */

const BASE = 'https://api.the-odds-api.com/v4/sports/basketball_nba';
const BOOKS = { fanduel: 'FanDuel', draftkings: 'DraftKings', betmgm: 'BetMGM', caesars: 'Caesars', williamhill_us: 'Caesars' };
const STAT_MARKETS = {
  pts: ['player_points', 'player_points_alternate'],
  reb: ['player_rebounds', 'player_rebounds_alternate'],
  ast: ['player_assists', 'player_assists_alternate'],
  tpm: ['player_threes', 'player_threes_alternate']
};
const MARKET_STAT = {};
for (const [s, ms] of Object.entries(STAT_MARKETS)) ms.forEach((m, i) => MARKET_STAT[m] = { stat: s, alt: i === 1 });
const ALL_MARKETS = Object.values(STAT_MARKETS).flat();
const COST_PER_EVENT = ALL_MARKETS.length; // markets × 1 region (upper bound: cost counts markets actually returned)

class OddsClient {
  constructor(key) {
    this.key = key || null;
    this.remaining = null; this.used = null; this.lastCost = null;
    this.stopped = null;    // reason the feed stopped (quota, auth, rate limit)
    this.planIssue = null;  // message if the plan rejects props/alt markets
    this.cache = new Map();
    this.calls = 0;
  }
  scrub(s) { return this.key ? String(s).split(this.key).join('***') : String(s); }

  async get(pathq) {
    if (!this.key) throw new Error('NO KEY');
    if (this.stopped) throw new Error(this.stopped);
    const url = `${BASE}${pathq}${pathq.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(this.key)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try { r = await fetch(url); } catch (e) { throw new Error('network error contacting the odds feed'); }
      this.calls++;
      const h = k => r.headers.get(k);
      if (h('x-requests-remaining') != null) this.remaining = +h('x-requests-remaining');
      if (h('x-requests-used') != null) this.used = +h('x-requests-used');
      if (h('x-requests-last') != null) this.lastCost = +h('x-requests-last');
      if (r.ok) return r.json();
      const body = this.scrub((await r.text().catch(() => '')).slice(0, 300));
      if (r.status === 429 && attempt === 0 && !/quota|credit|usage/i.test(body)) { await new Promise(res => setTimeout(res, 2500)); continue; }
      if (/quota|credit|usage/i.test(body) || r.status === 429) this.stopped = `Odds API quota exhausted or rate-limited (HTTP ${r.status}): ${body}`;
      else if (r.status === 401) this.stopped = `Odds API rejected the key (HTTP 401): ${body}`;
      const err = new Error(`HTTP ${r.status}: ${body}`);
      err.status = r.status; err.body = body;
      throw err;
    }
  }

  // Free endpoint (does not count against quota).
  async events() { return this.get('/events?dateFormat=iso'); }

  async eventProps(eventId) {
    if (this.cache.has(eventId)) return this.cache.get(eventId);
    if (this.remaining != null && this.remaining < COST_PER_EVENT) {
      this.stopped = `Odds API quota too low to continue (${this.remaining} credits left, ~${COST_PER_EVENT} needed per game)`;
      throw new Error(this.stopped);
    }
    try {
      const j = await this.get(`/events/${eventId}/odds?regions=us&markets=${ALL_MARKETS.join(',')}&oddsFormat=decimal&dateFormat=iso`);
      this.cache.set(eventId, j);
      return j;
    } catch (e) {
      if (e.status === 422 || /market|plan|subscription/i.test(e.body || '')) this.planIssue = this.planIssue || e.message;
      throw e;
    }
  }
}

const normName = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[.'’`-]/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

// Flatten one event's response into offers: { book, bookName, stat, alt, player, side, point, price }
function parseOffers(eventJson) {
  const offers = [];
  const booksSeen = new Set();
  for (const bk of (eventJson && eventJson.bookmakers) || []) {
    if (!BOOKS[bk.key]) continue;
    for (const mk of bk.markets || []) {
      const ms = MARKET_STAT[mk.key];
      if (!ms) continue;
      booksSeen.add(bk.key);
      for (const o of mk.outcomes || []) {
        if (o.point == null || !o.price || !/^(over|under)$/i.test(o.name)) continue;
        offers.push({ book: bk.key, bookName: BOOKS[bk.key], stat: ms.stat, alt: ms.alt, player: o.description, key: normName(o.description),
          side: o.name.toLowerCase(), point: +o.point, price: +o.price });
      }
    }
  }
  return { offers, booksSeen: [...booksSeen] };
}

module.exports = { OddsClient, parseOffers, normName, BOOKS, ALL_MARKETS, COST_PER_EVENT };
