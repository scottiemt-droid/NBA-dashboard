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
| `index.html` | Layout, styles, method notes |

Tunable constants live at the top of `js/model.js` (`MODEL`, `BLOWOUT`, `ROLE_MPG_SHIFT`, `SMALL_GP`, `HITS`, thresholds).

## What is measured vs modeled

**Measured (box scores):** every game row, per-36 rates, usage, shooting splits, team totals allowed, pace/ORtg/DRtg, hit counts.

**Modeled (labelled on the board):**
- 5-position buckets. ESPN lists only G/F/C, so PG/SG and SF/PF/C are inferred from AST/36 and REB/36. Every position-split number is tagged `MODELED BUCKET`.
- Projected score. Pace × ratings, regressed toward league average by GP/(GP+10), with ±1.2 home court per side.
- Vacated-minutes allocation and the usage bump.
- Blowout minutes trim.

**Not available, so not shown:** defensive assignments and coverage scheme (drop/switch/zone).

## Known limits

- Statuses come from ESPN's feed as written (`Out`, `Day-To-Day`, etc.). Only `Out` and suspensions remove a player.
- Rotation = players with ≥2 of the team's last 5 games at ≥10 min (or 1 game at ≥15), plus players returning from absence who average ≥20 min this season.
- The vs-team window is this season plus two prior seasons, including playoffs. It never pads beyond that.
- Team schedules are pulled for the regular season. Playoff box scores would need `seasontype=3` added in `loadRaw`.
