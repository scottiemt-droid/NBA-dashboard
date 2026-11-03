'use strict';
/* Loads the board's own data + model code (js/data.js, js/model.js) unchanged inside a Node VM and runs the
   same pipeline the page runs (loadRaw → prepareTeams → loadGamelogs → buildBoard). Projections are therefore
   the board's numbers, not a re-implementation. The board's IndexedDB cache is backed by a JSON file so
   completed box scores and prior-season logs are not re-downloaded on every scheduled run. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'board-cache.json');

// Minimal IndexedDB stand-in covering exactly the calls js/data.js makes (open / transaction / get / put).
function idbShim(map, state) {
  const later = f => setTimeout(f, 0);
  return {
    open() {
      const req = {};
      later(() => {
        req.result = {
          transaction() {
            const tx = {
              objectStore() {
                return {
                  get(k) { const q = {}; later(() => { q.result = map.get(k); q.onsuccess && q.onsuccess(); }); return q; },
                  put(v, k) { map.set(k, v); state.dirty = true; later(() => tx.oncomplete && tx.oncomplete()); }
                };
              }
            };
            return tx;
          }
        };
        req.onsuccess && req.onsuccess();
      });
      return req;
    }
  };
}

function loadCache() {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')))); } catch (e) { return new Map(); }
}

function saveCache(map, state) {
  if (!state.dirty) return false;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(map)));
  fs.writeFileSync(path.join(CACHE_DIR, '.dirty'), new Date().toISOString());
  return true;
}

function loadBoardCode() {
  try { fs.unlinkSync(path.join(CACHE_DIR, '.dirty')); } catch (e) { } // marker is rewritten only if this run adds cache entries
  const map = loadCache();
  const state = { dirty: false };
  const ctx = {
    console, setTimeout, clearTimeout,
    // Node's fetch rejects some browser-only init fields; the board only passes `cache`.
    fetch: (u, o = {}) => { const { cache, ...rest } = o; return fetch(u, rest); },
    indexedDB: idbShim(map, state)
  };
  vm.createContext(ctx);
  const src = ['js/data.js', 'js/model.js'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');
  const B = vm.runInContext(src + `
;({ ESPN, fetchJSON, extractBox, loadRaw, loadGamelogs, prepareTeams, buildBoard, blendCard, cautions,
    per36, etNowParts, etDate, etTime, addDays, STATS, MAIN, SL, BLOWOUT, seasonLabel });`, ctx, { filename: 'board-code' });
  B.persist = () => saveCache(map, state);
  return B;
}

// The board's default blend weights, read from js/ui.js so the agent can never drift from the page.
function boardDefaultWeights() {
  const ui = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
  const m = ui.match(/const W_DEFAULT = \{ vt: (\d+), l5: (\d+), op: (\d+) \}/);
  if (!m) throw new Error('Could not read W_DEFAULT from js/ui.js');
  return { vt: +m[1], l5: +m[2], op: +m[3] };
}

async function buildBoardFor(B, D, log) {
  const raw = await B.loadRaw(D, log);
  if (raw.empty) return { empty: true, next: raw.next };
  log('Computing rotations…');
  const pids = B.prepareTeams(raw);
  const gl = await B.loadGamelogs(pids, [raw.seasonYear - 1, raw.seasonYear - 2], log);
  const board = B.buildBoard(raw, gl);
  return { empty: false, raw, board, gl };
}

module.exports = { loadBoardCode, boardDefaultWeights, buildBoardFor, ROOT };
