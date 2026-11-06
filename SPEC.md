# NBA Matchup Board — Spec

The source of truth for what the board must do. Where a later change replaced an earlier rule, the current rule is written here and the change is noted in the history at the bottom. Keep this file and `CLAUDE.md` in sync with the code.

## 1. The board

A full-slate board for each game day: every game at once, not pick-a-game-first. Design and layout are free; these rules are not.

### Each game
- Game header: both teams, tip time, a projected score, and the game pace and total (see §4).
- Market spread/total next to the projected score when a real one can be sourced. Never invent a line.
- **Scheme tags** per team, on the game header and on the team-vs-position panel:
  - **PERIMETER-WEAK**: PG+SG+SF points *and* threes allowed are both ≥ 8% above the league average for those buckets.
  - **INTERIOR-WEAK**: PF+C points *and* rebounds allowed are both ≥ 8% above the league average for those buckets.
  - A team can carry both tags or neither. The numbers behind each check are shown whether or not the tag fired.
  - These are team tendencies computed from box scores, not defensive assignments or coverage schemes (drop/switch/zone), which are never shown. They carry the MODELED BUCKET label.
- **Team-vs-position panel**: what each team allows to PG, SG, SF, PF and C this season, from box scores, with GP and a SMALL SAMPLE flag (GP < 10). A total across all players at a position is labelled TEAM TOTAL; it is not a single-player rate.

### Player cards
- Each team's projected rotation: 9 players. If a team has only 8 real rotation players, show 8 and say so. Never invent a ninth.
- Six stats projected as single values, never ranges: PTS, REB, AST, 3PM, STL, BLK.
- Every card shows, game by game and next to the projection (never hidden behind a tap):
  1. **Own form**: his last 5 games this season per 36, plus L10 and season per 36.
  2. **Opponent positional**: the full-season factor table that drives the projection. The opponent's last-5 positional log is shown underneath as context only: the primary player at his position in each game, with avg, median, high, low and hit counts. Outlier games, blowouts and games the opponent's key players missed are noted, never averaged away silently.
  3. **Vs this team**: his last 5 meetings with this opponent, with dates and minutes, across this season and the two prior seasons, including prior clubs. A sample that spans a role change (trade, position change, ≥ 8 mpg role change) is split before/after, and only the current role is blended.
- **Consistency vs divergence**: when all three inputs agree, say so and show the numbers. When the vs-team input diverges from current form, the card explains why it might be real or stale (role, teammates, defenders, blowouts, injury-shortened games, small n).
- Projected minutes and rest/back-to-back flags on each card.
- Bench-scaling sanity check: if a bench player's projection looks surprisingly big, flag it rather than present it as likely.
- **Defender matchup** row (MODELED): likely defender tonight, whether the opponent's usual defender at his position is in or out, and any adjustment with its reason (§4).

## 2. Projection method (current numbers)

**Minutes first.** Then per-36 rates × minutes ÷ 36 × pace factor.
- Recent minutes = 50% L5 + 30% L10 + 20% season (games played).
- Rest: −1.5 min on a back-to-back for 28+ mpg players, −0.5 otherwise; −0.5 on a 3-in-4 for 28+ mpg players.
- Injuries: players ruled OUT are removed (no card, no projection) and listed on a per-team Out line. Their vacated minutes go to remaining rotation players: same position, then adjacent, then any, with caps of **+8 min per player and 38 min total**. Placed + unallocated must reconcile to the vacated total. Never invent backfill players. Base (recent minutes) vs adjusted is shown on every affected card.
- Game script: if |spread| ≥ 10 (market spread when available, else model margin), projected starters on both sides lose minutes (0.5 per point above 9, max 4).
- **Injuries and game script move minutes, not rates.** There is no usage bump.
- Doubtful/questionable players stay on the board with projections, flagged with their status.

**Rates: blend of three inputs** (live weight control on the board; weights shown on the board):
- Default **30% vs this team / 40% own form / 30% opponent positional**. These are starting values for the retune in §5.
- Own form = (L5 + L10)/2 per 36, shrunk toward his season rate with weight n10/(n10 + 5).
- Opponent positional = his own form × what the opponent allows to his position per 36 position-minutes over the **full season**, relative to the league, with the opponent's pace removed, shrunk toward 1 by GP/(GP + 10), times the defender adjustment.
- Vs this team = his last 5 meetings, current role only.
- An input with n=0 is dropped and the remaining weights renormalized, and the card says so.
- No last-season baseline. Prior seasons are used only for vs-team meetings.

**Attempts, then efficiency.**
- FGA, 3PA and FTA are projected as rates.
- 2P%, 3P% and FT% are his last-10 % shrunk toward his season % (priors of 100 2PA, 50 3PA and 40 FTA). His season % is itself shrunk toward the league average when his sample is small.
- PTS = 2 × 2PM + 3 × 3PM + FTM. 3PM = 3PA × 3P%.
- Rebound chances and assist opportunities are not modeled, because they need tracking data (§6).

## 3. Sample and honesty rules (non-negotiable)

- Samples under 5 are labelled with their real n (n=3, n=2, n=1). Never pad them with older games from a different era or against other teams. An empty line is labelled n=0.
- All numbers come from actual box scores. A split that is not computed from box scores is labelled UNVERIFIED / MODELED. Position buckets are inferred (ESPN lists only G/F/C), so every position-split number carries MODELED BUCKET.
- Never invent a stat, a line, a status or a score. If something can't be verified, leave it out and label the sample smaller.
- Use true rates (per 36, usage, attempts, shooting % over L5/L10/season), not just raw averages.
- **The board does not generate picks.** Screen flags are matchup signals, not picks.

## 4. Pace, total and defender matchups

- Game pace = model pace (team pace and ratings from box scores, regressed by GP/(GP+10)) × market total ÷ model total when a real total exists. With no total, the model pace is used and labelled MODELED.
- Each player's counting stats are multiplied by game pace ÷ his team's average game pace, bounded 0.9–1.1. The card shows what pace adds or removes per stat.
- Defender matchup (MODELED unless verified tracking data becomes reachable):
  - Likely defender = the opponent's top projected-minutes player at his position tonight (adjacent position if none).
  - Usual defender = the opponent's season minutes leader at the position, shown as in, OUT, or not in the projected rotation.
  - If 2+ opponent games match tonight's status (with or without him), the opponent input is adjusted by what the opponent allowed to the position in those games vs the full season, shrunk n/(n+5) and capped ±10%. Otherwise there is no adjustment, and the reason is shown.

## 5. Projection log, retune and market tracking

- Every game day, after the 8:07 AM ET refresh, store each projection: six stats, attempts, the three inputs' own projections, minutes breakdown and weights.
- The next morning, grade each projection against the box score. Report error (MAE and bias) by stat and by input, and which input predicts best.
- Suggest new weights from the misses (grid search, loss = Σ MAE ÷ mean actual over the six stats). **Never change weights automatically**; show the suggestion and wait. Below 300 graded player-games with all three inputs, the suggestion is labelled tentative.
- Track against the market only with real lines:
  - Game totals and spreads: ESPN/DraftKings at open and close (last reading within 60 minutes of tip).
  - Player main lines: only those the odds agent actually fetched.
  - Report how projections compare to the close over time, always with the sample size. Under 100 comparisons, say plainly it is too small to conclude anything.

## 6. Data access

- Real box scores and schedules only. ESPN's public JSON endpoints are the working source.
- NBA.com's stats API (and therefore the `nba_api` package) and its CDN are blocked from this connection (checked Nov 6, 2026: timeouts and 403s). No tracking data is available.
- Raw data is cached locally: in the browser's IndexedDB for the board, and in `.cache/` for the Node scripts. Reruns are cheap.
- If a source can't be reached, say so and label the sample smaller. Never fill a gap with an estimate presented as measured.

## 7. Refresh

The whole board refreshes every game-day morning (around 8:07 AM ET) with the latest completed box scores and injury statuses. It stays quiet on days with no games.

## 8. Screen flags (matchup signals, not picks)

- The edge lives in the gap between a player's true rate and what the opponent gives up at his position, after adjusting for minutes, injuries and who was on the floor.
- **MATCHUP FLAG** (tonight, no pattern history needed): his own last 5 per 36 is at or past his season rate, his current-role vs-team per 36 is ≥ 5% past it in the same direction (blowout meetings dropped when others remain), and the opponent's last-5 positional log is ≥ 5% past its players' own norms in the same direction, still true without its most extreme game. The blend must also be ≥ 15% past his season rate, and the gap at projected minutes must be at least 2.5 PTS / 1.2 REB / 1.0 AST / 0.5 3PM / 0.4 STL or BLK.
- **PATTERN** badge: the gap also repeated in ≥ 3 separate games and most of the sample. A pattern without tonight's agreement still shows, labelled.
- STL/BLK flags appear only alongside a PTS/REB/AST/3PM flag, unless a vs-team STL/BLK line is consistently 2+ with positional-log backing.

## History

- **Nov 3, 2026**: original spec; full-slate board built on ESPN data.
- **Nov 3, 2026**: scheme tags rebuilt from the team-vs-position buckets (the 8% rule); screen flags split into MATCHUP FLAG and PATTERN tiers.
- **Nov 6, 2026**: blend 50/25/25 → 30/40/30 with own form = L5 + L10 shrunk toward season; minutes-first projection (usage bump removed); pace from the market total; full-season opponent positional data drives the projection (last-5 log becomes context); attempts × shrunk efficiency for points and threes; MODELED defender matchups; daily projection log, grading, weight suggestions and market tracking. Not possible: rebound-chance and assist-opportunity models, and verified defender matchups (no tracking data reachable).
