# CLAUDE.md — NBA Matchup Board

Read `SPEC.md` first. It holds the rules (honesty rules, n-labels, MODELED/UNVERIFIED labels, OUT players removed, per-36 rates, no picks) and the current projection numbers. **Keep SPEC.md and this file in sync with every behavior change**, and add a dated line to SPEC.md's History.

## Layout

- `index.html`, `js/*.js`: the board. It is static and runs in the browser, pulling ESPN data directly with an IndexedDB cache. It is served by GitHub Pages at https://scottiemt-droid.github.io/NBA-dashboard/, and locally by `start-board.cmd` / `serve.ps1` on http://localhost:8077/.
  - `js/data.js`: ESPN fetches, box-score and game-log extraction.
  - `js/model.js`: everything computed (positions, team context, rotations, minutes, inputs, efficiency, pace, defender, blend, notes, screen flags). Constants are at the top (`MODEL`, `PROJ`, thresholds).
  - `js/ui.js`: rendering, weight sliders (`W_DEFAULT`, saved under the `nba-board-weights-v2` key), date controls, the 8:07 AM ET rebuild.
  - `js/agent.js`, `js/accuracy.js`: panels that read files under `reports/`.
- `agent/`: Node scripts, run by `.github/workflows/edge-agent.yml` (and locally with `node agent/...`).
  - `agent/lib/board.js` runs the board's own `js/data.js` + `js/model.js` in a Node VM, so the scripts use the board's numbers. Never reimplement the model there. It reads `W_DEFAULT` from `js/ui.js` by regex, so keep that line's format: `const W_DEFAULT = { vt: N, l5: N, op: N };`.
  - `agent/projections.js`: daily projection snapshot, grading, game-line open/close, `reports/model/summary.json`.
  - `agent/run.js` + `agent/lib/*`: the player-prop edge agent (The Odds API; key only in the `ODDS_API_KEY` secret, never committed or printed). Free 500-credit plan → budget mode. The plan returns FanDuel, DraftKings and BetMGM; not Caesars.
- `reports/`: generated output committed by the workflow. Don't hand-edit it, and don't commit test runs into it.

## Environment

- Windows. Node is installed (`C:\Program Files\nodejs\node.exe`); Python is not.
- NBA.com (stats API, CDN, `nba_api`) is blocked from this connection. ESPN is the only data source. No tracking data.
- Git pushes to `origin/main` go through Git Credential Manager. The workflow's bot commits reports often, so `git pull --rebase` before pushing.

## Working rules

- Weight keys stay `vt` / `l5` / `op` (`l5` now means "own form") so saved settings, the scripts and the logs stay compatible.
- Weights are never changed automatically from the retune; only suggested.
- Test changes by building a real slate. In Node, use `agent/lib/board.js` (`loadBoardCode` + `buildBoardFor`). In the browser, use `start-board.cmd`. Check that there are no console errors and that cards render at phone width.
- Throwaway test output, such as synthetic prices or forced past-date snapshots, goes in a scratch folder, never in `reports/`. A projection snapshot built after tip or with later injury info would contaminate the accuracy record.
