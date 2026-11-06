# NBA Matchup Board

Full-slate matchup board: every game of the day, every projected rotation player, with all three input lines shown next to each projection. It shows matchups and projections only. It does not make picks.

## Run it

Double-click `start-board.cmd`. It starts a tiny local server (`serve.ps1`, PowerShell only, no installs) and opens http://localhost:8077/.

- The board opens on today's ET date. On a day with no games it shows one line and a link to the next slate.
- `?date=YYYY-MM-DD` or the date picker shows any other slate. For past dates, injuries and rosters are as of today.
- **Refresh:** the board rebuilds every time it opens. If the tab is left open, it rebuilds again at 8:07 AM ET. The Refresh button re-pulls on demand.
- The first load downloads every completed box score of the season plus two prior seasons of game logs for slate players. These are cached in the browser (IndexedDB), so later loads take seconds.

## Files

| File | Role |
|---|---|
| `js/data.js` | ESPN fetches + cache; box-score and game-log extraction |
| `js/model.js` | Positions, team-vs-position, scheme tags, ratings, rotations, vacated minutes, the three lines, blend, notes, screen flags |
| `js/ui.js` | Rendering, live weight sliders, date controls, 8:07 AM ET timer |
| `js/accuracy.js` | Model-accuracy panel (reads `reports/model/summary.json`) |
| `js/agent.js` | Edge-agent panel (reads `reports/`) |
| `agent/projections.js` | Daily projection snapshot, next-morning grading, game-line open/close, accuracy + weight suggestion |
| `index.html` | Layout, styles, method notes |

Tunable constants live at the top of `js/model.js` (`MODEL`, `PROJ`, `BLOWOUT`, `ROLE_MPG_SHIFT`, `SMALL_GP`, `HITS`, thresholds). Default blend weights are `W_DEFAULT` in `js/ui.js`. The full rules are in [SPEC.md](SPEC.md).

## Projection log and retune

`agent/projections.js` runs on the same GitHub schedule as the edge agent. You can also run it locally with `node agent/projections.js`; it caches raw ESPN data in `.cache/`.

- Once per game day after 8:07 AM ET it saves every projection to `reports/model/projections/DATE.json`: six stats, attempts, all three inputs, minutes and weights.
- The next morning it grades them against the box scores.
- It writes `reports/model/summary.json`: error by stat, error by input, minutes error, and a suggested weight mix. The suggestion is a grid search on the graded misses, labelled tentative under 300 player-games. **It never changes weights automatically.**
- It tracks against real lines only. Game totals and spreads come from ESPN/DraftKings at open and close (last reading within 60 minutes of tip). Player main lines come from what the odds agent fetched. Each comparison states its sample size and says when it is too small (under 100) to conclude anything.

The board shows all of this in the **Model accuracy & retune** panel.

## What is measured vs modeled

**Measured (box scores):** every game row, per-36 rates, usage, shooting splits, team totals allowed, pace/ORtg/DRtg, hit counts.

**Modeled (labelled on the board):**
- 5-position buckets. ESPN lists only G/F/C, so PG/SG and SF/PF/C are inferred from AST/36 and REB/36. Every position-split number is tagged `MODELED BUCKET`.
- Projected score. Pace × ratings, regressed toward league average by GP/(GP+10), with ±1.2 home court per side.
- Recent-minutes blend, rest cut, vacated-minutes allocation and blowout trim (minutes, never rates).
- Pace estimate when there is no market total, and the defender-matchup adjustment.

**Not available, so not shown:** defensive assignments and coverage scheme (drop/switch/zone), verified defender matchups, rebound chances and assist opportunities. These need NBA tracking data; NBA.com (and the `nba_api` package, which uses it) is blocked from this connection.

## Known limits

- Statuses come from ESPN's feed as written (`Out`, `Day-To-Day`, etc.). Only `Out` and suspensions remove a player.
- Rotation = players with ≥2 of the team's last 5 games at ≥10 min (or 1 game at ≥15), plus players returning from absence who average ≥20 min this season.
- The vs-team window is this season plus two prior seasons, including playoffs. It never pads beyond that.
- Team schedules are pulled for the regular season. Playoff box scores would need `seasontype=3` added in `loadRaw`.

---

# Edge agent (player props)

A separate scheduled agent (`agent/`) that compares the board's projections with live player-prop prices at FanDuel, DraftKings, BetMGM and Caesars. It flags, ranks and builds ladders and parlays only from legs that clear a strict bar. **It never places a bet.** The board itself is unchanged; the agent runs the board's own `js/data.js` + `js/model.js` in Node, so its projections are the board's numbers, not a copy.

**Read the reports:** https://scottiemt-droid.github.io/NBA-dashboard/reports/ (also in `reports/` in the repo). Full play log: `reports/log/plays.csv`.

## Odds feed and plan (read first)

- Feed: [The Odds API](https://the-odds-api.com). Markets used: `player_points`, `player_rebounds`, `player_assists`, `player_threes` and their `_alternate` versions (the alt-line ladders), region `us`, fetched once per game per run.
- **Plan check (Nov 2026, from the-odds-api.com):** the free Starter plan is 500 credits/month. A props call costs about 8 credits per game (8 markets × 1 region), so one morning scan of a 14-game slate is ~112 credits and a full day with re-checks is ~300+. **The free tier cannot cover daily use — you need at least the 20K plan ($30/month).** The site lists "all betting markets" on every plan but does not explicitly confirm player props/alt lines per tier. The agent checks this on every run: if the feed rejects the prop markets, the report says so in the status block. It never falls back to game lines or made-up props.
- Without a key the agent still runs its self-check and writes a report that says **NO KEY**. No edges are computed.

## Setup

1. Get a key at https://the-odds-api.com (pick the 20K plan or higher, see above).
2. Add it to the repo as a secret — never commit it: GitHub → this repo → **Settings → Secrets and variables → Actions → New repository secret** → name `ODDS_API_KEY`, value = your key. (For a cloud Claude session, add `ODDS_API_KEY` to that session's environment/secrets the same way.)
3. Confirm it works: GitHub → **Actions → Edge agent → Run workflow** with mode `morning`. The run log starts with `DATA SOURCE STATUS` — you want `Odds feed: connected`, each book listed with `props for N/N games`, and a `Quota:` line with credits remaining. A report appears under `reports/`.
4. Local run (optional, needs Node 18+): `ODDS_API_KEY=... node agent/run.js --mode morning`. The key is read only from the environment and is scrubbed from every error message.

**Check your setup for free:** Actions → Edge agent → Run workflow → mode `status`. It confirms the key and probes one market on the next game (at most 1 credit, 0 if props aren't posted yet). It writes `reports/status.json` with the books returning props and the credits left. A push that changes `agent/` runs the same check automatically.

## Budget mode (free 500-credit plan)

The agent runs in budget mode whenever the plan is 5,000 credits a month or less. That's the default: `ODDS_PLAN_CREDITS` = 500. If you upgrade, set a repo **variable** `ODDS_PLAN_CREDITS` to the new monthly figure (Settings → Secrets and variables → Actions → Variables). Set `ODDS_RESET_DAY` too if your quota doesn't reset on the 1st.

- **Daily budget** = (credits left − 10 kept in reserve) ÷ days until reset, which is about 16–18 a day on 500 credits. Credits left come from the feed's own quota header.
- **Morning scan** (up to half the day's credits): the board's screen flags rank the games. Each top game gets main lines only, for its 2 most-flagged stats (1 credit per stat). Games with no board signal, or past the budget, aren't scanned; each one is listed in the report with the reason.
- **60-minute re-check: skipped** in budget mode.
- **15-minute re-check:** only for stats that qualified in the morning, pulling main + alt lines (2 credits per stat), so the ladder is built at tip time. Only legs that clear here count as cleared. Games with nothing flagged cost nothing and write no report.
- **What this gives up:** full-slate coverage, the 60-minute check, and morning ladders. Nothing is estimated in place of a game that wasn't scanned. A day where the budget covers nothing useful is reported as such.

## Schedule (`.github/workflows/edge-agent.yml`)

- **Morning scan** after the board's 8:07 AM ET refresh: **flags only. A morning flag is never a cleared play.**
- **Re-checks** every 10 minutes through the evening. On each run the agent works out whether any game is ~60 minutes (45–75) or ~15 minutes (3–25) from tip. Only then does it fetch that game's props and write a re-check report. Only legs that clear at a re-check count as cleared. Scheduled Actions can start late; a missed 60-minute window is reported as missed.
- Days with no games: the agent exits quietly and writes nothing. Most re-check runs exit after one free ESPN call and don't touch the odds quota.
- GitHub pauses scheduled workflows after 60 days without repo activity; the agent's own report commits normally keep it alive.

## How an edge is computed

- **Projection:** the board's projection (minutes first, attempts × shrunk %, pace; blend default 30/40/30 read from `js/ui.js`) for points, rebounds, assists and threes.
- **Probability per rung:** every game in his current-role vs-team meetings and his last 10 games (the base of the own-form and opponent-positional inputs) is turned into per-36 × projected minutes. Games are weighted by the blend weights, split across each line's games, and rescaled so the mean equals the projection. P(stat ≥ rung) then comes from a Gaussian-kernel smooth of that distribution. Samples are small, so treat these as noisy.
- **Devig:** two-way (over + under, same book and line) → proportional. One-sided alt rungs → that book's own main-line margin for the player/stat. A rung that can't be devigged doesn't count.
- **Qualifies:** model probability − devigged implied probability ≥ 3 points at **at least 3 books**. Rungs a book doesn't offer are skipped, never filled from another book.
- **Not headlined:** legs that only clear because of added minutes (vacated minutes, rest/blowout changes — the base projection at recent minutes fails the bar), and legs the board marks with a minutes-scaling caution. These are shown separately, with base vs adjusted.
- **Ladders:** points 10/15/20/25 (30+ when the projection supports it), rebounds 5/6/8/10, assists 5/6/8/10, threes 3/4/5, plus the main line. Each rung shows best verified price, model p, devigged p, edge and EV, so the payout vs hit-rate trade-off is visible.
- **Parlays:** only when every leg qualifies. Combined probability uses lifts measured from actual joint game outcomes (same player: his own games; same game: games both played), shrunk toward 1 for small samples. Pairs without enough shared games are not built. Cross-game legs are treated as independent and labelled as such. Priced at one book that offers every leg; same-game parlay prices at the book will usually be lower than the product shown. If nothing qualifies: "No parlay today".
- **Stakes:** quarter-Kelly as a % of bankroll, capped at 1% per single and 0.5% per parlay. Never a dollar amount.
- **Log:** every flagged and cleared leg/parlay goes into `reports/log/plays.csv`, with the price seen at the last check (closing-line proxy and CLV) and the result graded from ESPN box scores the next morning. Each report shows a 7-day ROI/CLV review.
