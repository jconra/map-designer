// RMRF Map Designer — standalone WYSIWYG map editor.
// Layer 1 (this file so far): the BASE terrain layer — drives the game's own
// IslandMap generator + renderer from a live controls panel so what you tune is
// exactly what the game draws. Layers 2 (hand-placed assets) and 3 (AI/difficulty
// rules) hang off the same shell next.
//
// ONE-WAY dependency: this tool imports from https://rmrfbase.com/; the game never
// imports from here (keeps the shipped game self-contained for Amplify).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { IslandMap, DEFAULTS, TILE } from 'https://rmrfbase.com/js/IslandMap.js';
import { ASSETS } from 'https://rmrfbase.com/js/assets.manifest.js';

const CELL = 5;   // world units per build cell — matches the game's BuildGrid(map, 5)
// Teams are identity-only ('a' / 'b'), NEVER named by colour — players choose
// their colour in-game, so the map must not bake one in (naming teams red/blue
// is what caused mismatched flags/messages). These tints are EDITOR-ONLY, picked
// off the game's red/blue palette on purpose, just to tell the two bases apart.
const TEAM_ACCENT = { neutral: '#8a8f8a', a: '#b88a2e', b: '#2e8a96' };

// --- Renderer (matches the game's setup so colours/tone read the same) -------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color('#bfe4f5');
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 400, 1100);   // pushed back vs the game; we view whole maps

// Sky environment map — same procedural sky the game uses, so metal/water reflect
// the sky instead of rendering dark (the water material samples scene.environment).
function makeSkyEnv() {
  const W = 512, H = 256;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.00, '#4f93c8');
  g.addColorStop(0.45, '#bfe4f5');
  g.addColorStop(0.50, '#eaf5fb');
  g.addColorStop(0.56, '#cdd9d0');
  g.addColorStop(1.00, '#8fa39a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const sx = W * 0.62, sy = H * 0.30, sr = H * 0.18;
  const rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
  rg.addColorStop(0.0, 'rgba(255,251,238,1)');
  rg.addColorStop(0.3, 'rgba(255,244,214,0.85)');
  rg.addColorStop(1.0, 'rgba(255,244,214,0)');
  ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const _pmrem = new THREE.PMREMGenerator(renderer);
const _skySrc = makeSkyEnv();
scene.environment = _pmrem.fromEquirectangular(_skySrc).texture;
_skySrc.dispose(); _pmrem.dispose();

const sun = new THREE.DirectionalLight('#fff3d6', 2.1);
sun.position.set(80, 202, -25);
scene.add(sun);
scene.add(new THREE.HemisphereLight('#dff1ff', '#c2a86a', 0.95));

// --- Camera + orbit ----------------------------------------------------------
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 4000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;   // don't drop under the horizon
// Mouse: LEFT drag = pan the map, MIDDLE = orbit, RIGHT = pan, wheel = zoom. A
// left CLICK (no drag) still places/selects — the pointerup handler tells a tap
// from a drag, so dragging pans and tapping places without conflict.
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
// Touch (mirrors the mouse): ONE finger drags the map, TWO fingers zoom + orbit.
// A one-finger TAP (no drag) still places/selects via the pointerup handler.
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };

// WASD pans the view across the map relative to where the camera faces; speed
// scales with zoom distance so it feels the same up close and far out.
const keys = new Set();
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'a' || k === 's' || k === 'd') keys.add(k);
});
window.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _move = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
function panFromKeys(dt) {
  if (!keys.size) return;
  camera.getWorldDirection(_fwd); _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-6) return;
  _fwd.normalize();
  _right.crossVectors(_fwd, _up).normalize();   // screen-right on the ground plane
  _move.set(0, 0, 0);
  if (keys.has('w')) _move.add(_fwd);
  if (keys.has('s')) _move.sub(_fwd);
  if (keys.has('d')) _move.add(_right);
  if (keys.has('a')) _move.sub(_right);
  if (_move.lengthSq() === 0) return;
  const dist = camera.position.distanceTo(controls.target);
  _move.normalize().multiplyScalar(dist * 1.1 * dt);
  camera.position.add(_move);
  controls.target.add(_move);   // move target with the camera → a pan, not an orbit
}

// --- The map -----------------------------------------------------------------
const map = new IslandMap();
scene.add(map.group);

// Square build grid overlay (toggleable) — sized to the map, sits just above sea.
let gridHelper = null;
function rebuildGrid() {
  if (gridHelper) { scene.remove(gridHelper); gridHelper.geometry.dispose(); gridHelper.material.dispose(); gridHelper = null; }
  if (!document.getElementById('p-grid').checked) return;
  const w = map.worldW;
  const divs = Math.round(w / CELL);   // one line per 5-unit build cell (the snap grid)
  gridHelper = new THREE.GridHelper(w, divs, 0x2b6f4a, 0x16402c);
  gridHelper.position.y = (map.params.beachHeight || 1) + 2;   // lifted so the lines float clear of the land instead of sinking into it
  gridHelper.material.transparent = true;
  gridHelper.material.opacity = 0.5;
  scene.add(gridHelper);
}

// Frame the whole island in view.
function frameMap() {
  const w = map.worldW, h = map.worldH;
  const span = Math.max(w, h);
  controls.target.set(0, 0, 0);
  camera.position.set(span * 0.0, span * 0.62, span * 0.62);
  camera.near = 1;
  camera.far = span * 6;
  camera.updateProjectionMatrix();
  scene.fog.near = span * 0.9;
  scene.fog.far = span * 2.6;
  controls.update();
}

// (Re)generate the terrain from the current control values. IslandMap.generate
// rebuilds its chunk meshes in place under map.group.
function regenerate(reframe = false) {
  const patch = readParams();
  map.generate(patch);
  rebuildGrid();
  repositionPlacements();   // terrain height changed → re-sit placed assets on it
  rebuildRoads();           // …and re-drape the roads/bridges onto the new terrain
  if (reframe) frameMap();
  updateHud();
}

// --- Controls wiring ---------------------------------------------------------
// Maps a control id-suffix to a DEFAULTS key. Sliders show a live value readout.
const SLIDERS = ['size', 'tile', 'noiseScale', 'seaLevel', 'edgeFalloff', 'heightScale', 'beachHeight', 'grassAmount'];
const $ = id => document.getElementById(id);

function readParams() {
  const cells = parseInt($('p-size').value, 10);
  return {
    seed: parseInt($('p-seed').value, 10) || 0,
    cols: cells, rows: cells,
    tile: parseFloat($('p-tile').value),
    noiseScale: parseFloat($('p-noiseScale').value),
    seaLevel: parseFloat($('p-seaLevel').value),
    edgeFalloff: parseFloat($('p-edgeFalloff').value),
    heightScale: parseFloat($('p-heightScale').value),
    beachHeight: parseFloat($('p-beachHeight').value),
    grassAmount: parseFloat($('p-grassAmount').value),
    flatLand: $('p-flatLand').checked,
  };
}

// Seed the controls from the game's DEFAULTS.
function initControls() {
  $('p-seed').value = DEFAULTS.seed;
  $('p-size').value = 192;                          // editable default; smaller than the game's 480 so live re-gen is snappy
  $('p-tile').value = DEFAULTS.tile;
  $('p-noiseScale').value = DEFAULTS.noiseScale;
  $('p-seaLevel').value = DEFAULTS.seaLevel;
  $('p-edgeFalloff').value = DEFAULTS.edgeFalloff;
  $('p-heightScale').value = DEFAULTS.heightScale;
  $('p-beachHeight').value = DEFAULTS.beachHeight;
  $('p-grassAmount').value = DEFAULTS.grassAmount;
  $('p-flatLand').checked = DEFAULTS.flatLand;
  refreshReadouts();
}

function refreshReadouts() {
  for (const s of SLIDERS) { const v = $('v-' + s); if (v) v.textContent = $('p-' + s).value; }
}

// Debounced regen so dragging a slider doesn't rebuild the mesh every pixel.
let regenTimer = null;
function scheduleRegen(reframe = false) {
  refreshReadouts();
  clearTimeout(regenTimer);
  regenTimer = setTimeout(() => regenerate(reframe), 140);
}

for (const s of SLIDERS) {
  const reframe = (s === 'size' || s === 'tile');   // size/tile change the extent → reframe
  $('p-' + s).addEventListener('input', () => scheduleRegen(reframe));
}
$('p-seed').addEventListener('change', () => regenerate(false));
$('p-flatLand').addEventListener('change', () => regenerate(false));
$('p-grid').addEventListener('change', rebuildGrid);
$('randomize').addEventListener('click', () => { $('p-seed').value = (Math.random() * 2147483647) | 0; regenerate(false); });
$('frame-cam').addEventListener('click', () => frameMap());

// Collapsible widgets.
for (const id of ['gen', 'export', 'maps']) {
  $(id + '-btn').addEventListener('click', () => $('w-' + id).classList.toggle('open'));
}

// --- The 3-layer map config (export / import) --------------------------------
// Layer 1 (base) is filled; layers 2/3 are scaffolded empty for the next phases.
function exportConfig() {
  return {
    version: 1,
    name: rules.campaign.name || 'untitled',
    base: readParams(),          // IslandMap generator params (deterministic terrain)
    overrides: {                 // hand-placed manifest assets (id + grid cell + rot + team)
      // flag HQs also carry `real` (the one true objective for its team; the rest decoys)
      assets: placements.map(p => isFlagHQ(p)
        ? { id: p.id, cx: p.cx, cz: p.cz, rot: p.rot, team: p.team, real: !!p.real }
        : { id: p.id, cx: p.cx, cz: p.cz, rot: p.rot, team: p.team }),
      roads: [...roads].map(k => k.split(',').map(Number)),   // [cx, cz] cells carrying road/bridge
    },
    rules: JSON.parse(JSON.stringify(rules)),   // per-team AI / difficulty / campaign — Layer 3
  };
}
function clearPlacements() {
  for (const pl of placements.slice()) removePlacement(pl);
}
function importConfig(cfg) {
  const b = cfg.base || cfg;   // tolerate a bare params object
  if (b.seed != null) $('p-seed').value = b.seed;
  if (b.cols != null) $('p-size').value = b.cols;
  if (b.tile != null) $('p-tile').value = b.tile;
  if (b.noiseScale != null) $('p-noiseScale').value = b.noiseScale;
  if (b.seaLevel != null) $('p-seaLevel').value = b.seaLevel;
  if (b.edgeFalloff != null) $('p-edgeFalloff').value = b.edgeFalloff;
  if (b.heightScale != null) $('p-heightScale').value = b.heightScale;
  if (b.beachHeight != null) $('p-beachHeight').value = b.beachHeight;
  if (b.grassAmount != null) $('p-grassAmount').value = b.grassAmount;
  if (b.flatLand != null) $('p-flatLand').checked = b.flatLand;
  refreshReadouts();
  regenerate(true);
  // restore hand-placed assets (after terrain exists so heights sample correctly)
  clearPlacements();
  for (const a of (cfg.overrides && cfg.overrides.assets) || []) {
    if (!a.id || !Number.isFinite(a.cx) || !Number.isFinite(a.cz)) continue;   // skip malformed entries
    addPlacement(a.id, a.cx, a.cz, a.rot || 0, a.team || 'neutral', a.real);
  }
  for (const t of ['neutral', 'a', 'b']) ensureRealHQ(t);   // old/odd maps: guarantee one real HQ per team
  // restore hand-placed roads
  roads.clear(); roadAnchor = null;
  for (const r of (cfg.overrides && cfg.overrides.roads) || []) {
    if (Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1])) roads.add(rkey(r[0], r[1]));
  }
  rebuildRoads();
  applyRules(cfg.rules);
}
$('do-export').addEventListener('click', () => { $('cfg-text').value = JSON.stringify(exportConfig(), null, 2); });
$('do-import').addEventListener('click', () => {
  try { importConfig(JSON.parse($('cfg-text').value)); }
  catch (e) { alert('Bad config JSON: ' + e.message); }
});

// --- Saved maps (a named library in localStorage, selectable from the MAPS menu) ---
// Each saved map is a full exportConfig (terrain + placements + roads + rules). The
// index lists {id,name}; SAVE upserts by NAME (re-saving the same name overwrites it);
// the last-opened map id is remembered so a reload picks up where you left off.
const MAPS_KEY = 'mapdesigner:maps';
const MAP_KEY = id => 'mapdesigner:map:' + id;
const LAST_KEY = 'mapdesigner:_last';
function loadMapIndex() { try { const a = JSON.parse(localStorage.getItem(MAPS_KEY)); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function saveMapIndex() { try { localStorage.setItem(MAPS_KEY, JSON.stringify(savedMaps)); } catch (e) { /* private/full */ } }
let savedMaps = loadMapIndex();
let currentMapId = null;
const mapMsg = t => { const el = $('map-msg'); if (el) el.textContent = t; };

function saveCurrentMap(nameArg) {
  const name = ((nameArg != null ? nameArg : $('map-name').value) || '').trim() || 'Untitled';
  rules.campaign.name = name;                 // keep the campaign name in sync with the map name
  let entry = savedMaps.find(m => m.name.toLowerCase() === name.toLowerCase());
  if (!entry) { entry = { id: 'map-' + Date.now().toString(36) + ((Math.random() * 1e3) | 0), name }; savedMaps.push(entry); }
  else entry.name = name;                      // re-saving the same name overwrites that map
  currentMapId = entry.id;
  try {
    localStorage.setItem(MAP_KEY(entry.id), JSON.stringify(exportConfig()));
    localStorage.setItem(LAST_KEY, entry.id);
  } catch (e) { mapMsg('save failed: ' + (e && e.name === 'QuotaExceededError' ? 'storage full' : (e && e.message))); return; }
  saveMapIndex(); buildRulesUI(); rebuildMapList(); mapMsg('saved “' + name + '”');
}
function loadSavedMap(id) {
  const raw = (() => { try { return localStorage.getItem(MAP_KEY(id)); } catch (e) { return null; } })();
  if (!raw) { mapMsg('map not found'); return; }
  try { importConfig(JSON.parse(raw)); } catch (e) { mapMsg('load failed: ' + e.message); return; }
  currentMapId = id;
  const entry = savedMaps.find(m => m.id === id);
  if (entry && $('map-name')) $('map-name').value = entry.name;
  try { localStorage.setItem(LAST_KEY, id); } catch (e) { /* ignore */ }
  rebuildMapList(); mapMsg(entry ? 'loaded “' + entry.name + '”' : 'loaded');
}
function deleteSavedMap(id) {
  const i = savedMaps.findIndex(m => m.id === id); if (i < 0) return;
  if (typeof window.confirm === 'function' && !window.confirm('Delete map “' + savedMaps[i].name + '”? This can’t be undone.')) return;
  try { localStorage.removeItem(MAP_KEY(id)); } catch (e) { /* ignore */ }
  savedMaps.splice(i, 1);
  if (currentMapId === id) { currentMapId = null; try { localStorage.removeItem(LAST_KEY); } catch (e) {} }
  saveMapIndex(); rebuildMapList(); mapMsg('deleted');
}
function rebuildMapList() {
  const list = $('maps-list'); if (!list) return;
  list.innerHTML = '';
  if (!savedMaps.length) {
    const d = document.createElement('div'); d.className = 'maps-empty';
    d.textContent = 'No saved maps yet — name it and SAVE.'; list.appendChild(d); return;
  }
  for (const m of savedMaps) {
    const row = document.createElement('div'); row.className = 'map-row' + (m.id === currentMapId ? ' current' : '');
    const load = document.createElement('span'); load.className = 'map-load'; load.textContent = m.name;
    load.title = m.name; load.addEventListener('click', () => loadSavedMap(m.id));
    const del = document.createElement('span'); del.className = 'map-del'; del.textContent = '✕'; del.title = 'delete';
    del.addEventListener('click', e => { e.stopPropagation(); deleteSavedMap(m.id); });
    row.appendChild(load); row.appendChild(del); list.appendChild(row);
  }
}
$('map-save').addEventListener('click', () => saveCurrentMap());
$('map-name').addEventListener('keydown', e => { if (e.key === 'Enter') saveCurrentMap(); });

// --- Play this map in the game ----------------------------------------------
// The game lives on a different origin (rmrfbase.com) from this tool, so the map
// travels in the URL. Phase 1 honours TERRAIN + AI RULES only; placed assets/roads
// are authored but not yet read by the game, so we drop overrides to keep the URL
// short. Unicode-safe base64 (matches the game's decodeURIComponent(escape(atob…))).
const GAME_URL = 'https://rmrfbase.com/';
function playUrl() {
  const cfg = exportConfig();
  const slim = { version: cfg.version, name: cfg.name, base: cfg.base, rules: cfg.rules };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(slim))));
  return GAME_URL + '?mapcfg=' + encodeURIComponent(b64);
}
function playInGame() {
  try { window.open(playUrl(), '_blank'); mapMsg('opening game…'); }
  catch (e) { mapMsg('play failed: ' + e.message); }
}
$('map-play').addEventListener('click', playInGame);

function updateHud() {
  $('hud-info').textContent = `${map.params.cols}×${map.params.rows} cells · ${Math.round(map.worldW)}u · seed ${map.params.seed}`;
}

// --- Render loop -------------------------------------------------------------
let last = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = (now - last) / 1000; last = now;
  map.tickWater(now / 1000);   // animated water ripples (same call the game makes)
  panFromKeys(dt);
  controls.update();
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Layer 2: asset placement ------------------------------------------------
// Hand-placed manifest assets live in `placedRoot`. Each placement records the
// manifest id + grid cell + 90° rotation step + team accent, which is exactly
// what `overrides.assets` serialises (the game rebuilds the same makers from it).
const placedRoot = new THREE.Group();
scene.add(placedRoot);

// Every asset is placeable in the designer — including the 'special' ones
// (flagHQ + elevator). The game only auto-places those when it GENERATES a map;
// a hand-crafted campaign map sets them itself (their team comes from the team
// toggle, and the game wires the flag/elevator behaviour at load). Grouped by a
// fixed category order so the palette sections read cleanly.
const CAT_ORDER = ['special', 'structure', 'supply'];
const PLACEABLE = ASSETS.slice().sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category));
const CAT_LABEL = { special: 'BASE CORE', structure: 'STRUCTURES', supply: 'SUPPLY' };

let brushId = null;         // active palette asset id (the "brush"), or null
let team = 'neutral';
let ghost = null;           // translucent preview group following the cursor
let ghostRot = 0;           // rotation steps (×90°) applied to the ghost / next placement
let ghostCell = null;       // { cx, cz } the ghost is hovering, or null (off terrain)
const placements = [];      // { id, cx, cz, rot, team, group }
let selected = null;        // a selected placement (for rotate/delete), or null
let selBox = null;          // BoxHelper around the selection

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function accentColor() { return new THREE.Color(TEAM_ACCENT[team]); }

// Build one asset group from its maker, sized to the cell. Makers that ignore the
// accent arg (depot/supply) just drop it.
function buildAsset(id) {
  const a = ASSETS.find(x => x.id === id);
  if (!a) return null;
  // The gate is canonically 3 cells wide in-game (a 1-wide road threads its centre
  // cell), but its standalone maker defaults to span 2 — which left gaps on the sides
  // here. Pass the real span so the designer matches the game.
  const g = id === 'gate' ? a.make(CELL, accentColor(), 3) : a.make(CELL, accentColor());
  return g;
}

// World centre of a build cell, sitting on the terrain.
function cellWorld(cx, cz) {
  const x = cx * CELL, z = cz * CELL;
  return new THREE.Vector3(x, map.heightAt(x, z), z);
}

// Raycast the pointer against the terrain chunks → the build cell under it.
function cellUnderPointer(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(map.chunks, false)[0];
  if (!hit) return null;
  return { cx: Math.round(hit.point.x / CELL), cz: Math.round(hit.point.z / CELL) };
}

// --- ghost (placement preview) ---
function clearGhost() { if (ghost) { placedRoot.remove(ghost); ghost = null; } ghostCell = null; }
function makeGhost() {
  clearGhost();
  if (!brushId) return;
  ghost = buildAsset(brushId);
  ghost.traverse(o => {
    if (o.material) {
      o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { m.transparent = true; m.opacity = 0.5; m.depthWrite = false; }
    }
  });
  ghost.rotation.y = ghostRot * Math.PI / 2;
  ghost.visible = false;
  placedRoot.add(ghost);
}
function moveGhost(ev) {
  if (!ghost) return;
  const c = cellUnderPointer(ev);
  ghostCell = c;
  if (!c) { ghost.visible = false; return; }
  ghost.position.copy(cellWorld(c.cx, c.cz));
  ghost.rotation.y = ghostRot * Math.PI / 2;
  ghost.visible = true;
}

// --- Flag-HQ "real vs decoy" -------------------------------------------------
// A map can hold MANY flag HQs per team; exactly ONE is the real objective (holds
// the capturable flag) and the rest are decoys, so a harder map keeps the player
// guessing which to attack. In-game the HQs look identical (Jacob's flagless HQ
// model) — the `real` bit is invisible data. An editor-only floating marker shows
// the designer which one is real. If a saved map marks NONE real, the game is free
// to pick one at random at load (mystery even to the author).
const FLAGHQ_ID = 'flagHQ';
const isFlagHQ = pl => pl.id === FLAGHQ_ID;
const teamHQs = team => placements.filter(p => isFlagHQ(p) && p.team === team);
function makeRealMarker(pl) {
  const box = new THREE.Box3().setFromObject(pl.group);
  const topY = Math.max(8, (box.max.y - pl.group.position.y) + 3);
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(1.2), new THREE.MeshBasicMaterial({ color: 0xffe14d }));
  m.position.y = topY; m.userData.realMarker = true;
  return m;
}
function setHQMarker(pl, real) {
  pl.real = !!real;
  if (real && !pl._marker) { pl._marker = makeRealMarker(pl); pl.group.add(pl._marker); }
  else if (!real && pl._marker) { pl.group.remove(pl._marker); pl._marker.geometry.dispose(); pl._marker.material.dispose(); pl._marker = null; }
}
// Make `pl` the team's real HQ (clears the flag off the team's other HQs — one per team).
function setRealHQ(pl, real) {
  if (!isFlagHQ(pl)) return;
  if (real) for (const o of teamHQs(pl.team)) if (o !== pl) setHQMarker(o, false);
  setHQMarker(pl, real);
  if (selected === pl) refreshSelBar();
}
// Guarantee each team that has any HQ has exactly one real one (after edits/imports).
function ensureRealHQ(team) {
  const hqs = teamHQs(team); if (!hqs.length) return;
  if (!hqs.some(p => p.real)) setHQMarker(hqs[0], true);
}

// --- placement model ---
function addPlacement(id, cx, cz, rot, tm, real) {
  const g = buildAsset(id);
  if (!g) return null;
  g.position.copy(cellWorld(cx, cz));
  g.rotation.y = rot * Math.PI / 2;
  placedRoot.add(g);
  const pl = { id, cx, cz, rot, team: tm, group: g, real: false };
  placements.push(pl);
  // first HQ for a team defaults to the real one; later ones are decoys (import sets it explicitly)
  if (isFlagHQ(pl)) setHQMarker(pl, real != null ? real : !teamHQs(tm).some(p => p !== pl && p.real));
  return pl;
}
function removePlacement(pl) {
  const i = placements.indexOf(pl); if (i < 0) return;
  placedRoot.remove(pl.group);
  placements.splice(i, 1);
  if (selected === pl) selectPlacement(null);
  if (isFlagHQ(pl) && pl.real) ensureRealHQ(pl.team);   // lost the real HQ → promote another
}
function repositionPlacements() {
  for (const pl of placements) pl.group.position.copy(cellWorld(pl.cx, pl.cz));
  if (selBox) selBox.update();
}

// --- selection ---
function selectPlacement(pl) {
  selected = pl;
  if (selBox) { scene.remove(selBox); selBox.geometry.dispose(); selBox = null; }
  const bar = $('sel-bar');
  if (!pl) { bar.classList.remove('show'); return; }
  selBox = new THREE.BoxHelper(pl.group, 0xffe14d);
  scene.add(selBox);
  $('sel-name').textContent = (ASSETS.find(a => a.id === pl.id)?.name || pl.id).toUpperCase();
  refreshSelBar();
  bar.classList.add('show');
}
// Show the REAL-HQ toggle only for a selected flag HQ; reflect its current state.
function refreshSelBar() {
  const btn = $('sel-real'), pl = selected;
  if (!btn) return;
  if (pl && isFlagHQ(pl)) {
    btn.style.display = '';
    btn.classList.toggle('active', !!pl.real);
    btn.textContent = pl.real ? '★ REAL HQ' : '☆ DECOY';
  } else btn.style.display = 'none';
}

// Pick the placement whose group is under the pointer (for selecting/deleting).
function placementUnderPointer(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(placedRoot, true);
  for (const h of hits) {
    if (ghost && (h.object === ghost || ghost.children.includes(h.object))) continue;
    let o = h.object;
    while (o && o.parent !== placedRoot) o = o.parent;
    const pl = placements.find(p => p.group === o);
    if (pl) return pl;
  }
  return null;
}

// Cancel the current action: drop the active brush, or if none, deselect. Shared
// by Esc, right-click, and closing the palette on mobile.
function clearBrushOrSelection() {
  if (roadMode) { roadAnchor = null; return; }   // in road mode, Esc/right-click just lifts the pen
  if (brushId) setBrush(null); else selectPlacement(null);
}

function setBrush(id) {
  if (id && roadMode) setRoadMode(false);   // picking an asset brush leaves road mode
  brushId = id;
  ghostRot = 0;
  if (id) selectPlacement(null);   // brush and selection are mutually exclusive
  makeGhost();
  for (const t of palTiles) t.classList.toggle('active', t.dataset.id === id);
}

// --- palette UI ---
const palTiles = [];
function buildPalette() {
  const grid = $('pal-grid');
  let lastCat = null;
  for (const a of PLACEABLE) {
    if (a.category !== lastCat) {
      lastCat = a.category;
      const h = document.createElement('div'); h.className = 'pcat';
      h.textContent = CAT_LABEL[a.category] || a.category.toUpperCase();
      h.style.gridColumn = '1 / -1';
      grid.appendChild(h);
    }
    const tile = document.createElement('div');
    tile.className = 'pal-tile'; tile.dataset.id = a.id; tile.title = a.desc || a.name;
    const img = document.createElement('img');
    img.src = `https://rmrfbase.com/thumbnails/${a.id}.png`;
    img.onerror = () => img.remove();   // no thumbnail (e.g. perimeter kit) → label only
    const lbl = document.createElement('span'); lbl.textContent = a.name;
    tile.appendChild(img); tile.appendChild(lbl);
    tile.addEventListener('click', () => setBrush(brushId === a.id ? null : a.id));
    grid.appendChild(tile);
    palTiles.push(tile);
  }
}
buildPalette();

// team toggle
for (const btn of document.querySelectorAll('.team-btn')) {
  btn.addEventListener('click', () => {
    team = btn.dataset.team;
    document.querySelectorAll('.team-btn').forEach(b => b.classList.toggle('active', b === btn));
    if (brushId) makeGhost();   // re-tint the ghost
  });
}
$('palette-btn').addEventListener('click', () => {
  const w = $('w-palette');
  w.classList.toggle('open');
  // Closing the palette clears the brush — gives mobile (no right-click / Esc) a cancel.
  if (!w.classList.contains('open') && brushId) setBrush(null);
});

// Arrow keys nudge the SELECTED placement one cell, in the on-screen direction
// (snapped to whichever world grid axis best matches the camera facing, so "up"
// always moves it away from you regardless of how the view is orbited).
function nudgeSelected(screenDir) {
  if (!selected) return false;
  camera.getWorldDirection(_fwd); _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-6) return false;
  _fwd.normalize();
  _right.crossVectors(_fwd, _up).normalize();
  if (screenDir === 'up') _move.copy(_fwd);
  else if (screenDir === 'down') _move.copy(_fwd).negate();
  else if (screenDir === 'right') _move.copy(_right);
  else _move.copy(_right).negate();
  let dcx = 0, dcz = 0;
  if (Math.abs(_move.x) >= Math.abs(_move.z)) dcx = Math.sign(_move.x); else dcz = Math.sign(_move.z);
  selected.cx += dcx; selected.cz += dcz;
  selected.group.position.copy(cellWorld(selected.cx, selected.cz));
  if (selBox) selBox.update();
  return true;
}

// rotate / delete (buttons + keys)
function rotateSel() {
  if (selected) { selected.rot = (selected.rot + 1) % 4; selected.group.rotation.y = selected.rot * Math.PI / 2; if (selBox) selBox.update(); }
  else if (brushId) { ghostRot = (ghostRot + 1) % 4; if (ghost) ghost.rotation.y = ghostRot * Math.PI / 2; }
}
$('sel-rotate').addEventListener('click', rotateSel);
$('sel-delete').addEventListener('click', () => { if (selected) removePlacement(selected); });
$('sel-real').addEventListener('click', () => { if (selected && isFlagHQ(selected)) setRealHQ(selected, !selected.real); });
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'r' || e.key === 'R') rotateSel();
  else if (e.key === 'Delete' || e.key === 'Backspace') { if (selected) removePlacement(selected); }
  else if (e.key === 'Escape') clearBrushOrSelection();
  else if (e.key.startsWith('Arrow')) {
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    if (dir && nudgeSelected(dir)) e.preventDefault();   // move the selected asset; stop the page scrolling
  }
});

// --- canvas pointer: distinguish a click (place/select) from an orbit drag ---
let down = null;   // { x, y, button } pointer-down state
renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, button: e.button }; });
renderer.domElement.addEventListener('pointermove', e => { if (brushId && !down) moveGhost(e); });
renderer.domElement.addEventListener('pointerup', e => {
  const moved = down && (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y)) > 6;
  const btn = down ? down.button : 0;
  down = null;
  if (moved) return;   // a drag (pan/orbit) — not a click
  if (btn === 2) { clearBrushOrSelection(); return; }   // right-click cancels, like Esc
  if (btn !== 0) return;   // middle/other → not a placement click
  if (roadMode) {   // road paint mode: tap lays/erases a cell
    const c = cellUnderPointer(e);
    if (c) paintRoad(c);
    return;
  }
  if (brushId) {
    const c = cellUnderPointer(e);
    if (c) addPlacement(brushId, c.cx, c.cz, ghostRot, team);
  } else {
    selectPlacement(placementUnderPointer(e));
  }
});

// --- Roads + bridges (hand-painted onto the build grid) ----------------------
// A self-contained renderer (the game's RoadTiles isn't exported from rmrfbase.com):
// flat asphalt slabs on land, raised plank decks with rails over water. Connectivity
// (n/s/e/w) of the painted set decides which bridge sides get rails. Painting is by
// TAP (drag pans the camera): consecutive taps auto-connect via an orthogonal path,
// so you tap the corners of a route and it fills the straights between them.
const ROAD_T = 0.5;                  // slab thickness — its side covers the drop on rough shore cells
const roads = new Set();             // "cx,cz" cells carrying road
let roadMode = false, roadErase = false, roadAnchor = null;
const roadRoot = new THREE.Group(); scene.add(roadRoot);
const ROAD_MAT = new THREE.MeshStandardMaterial({ color: '#5b5e63', roughness: 0.92, flatShading: true });
const DECK_SLAB_MAT = new THREE.MeshStandardMaterial({ color: '#5f5640', roughness: 0.95, flatShading: true });
const DECK_TOP_MAT = new THREE.MeshStandardMaterial({ color: '#7a6e57', roughness: 0.92, flatShading: true });
const RAIL_MAT = new THREE.MeshStandardMaterial({ color: '#544c3b', roughness: 0.9, flatShading: true });
const PILLAR_MAT = new THREE.MeshStandardMaterial({ color: '#4a3f2c', roughness: 0.9, flatShading: true });

const rkey = (cx, cz) => cx + ',' + cz;
function isWaterCell(cx, cz) { const t = map.tileAt(cx * CELL, cz * CELL); return t === TILE.SHALLOW || t === TILE.DEEP; }

function clearRoadMeshes() {
  roadRoot.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
  roadRoot.clear();
}
function buildRoadTile(x, z, gradeY) {
  const slab = new THREE.Mesh(new THREE.BoxGeometry(CELL, ROAD_T, CELL), ROAD_MAT);
  slab.position.set(x, gradeY - ROAD_T / 2, z);
  roadRoot.add(slab);
}
function buildBridgeTile(x, z, deckY, n, s, e, w) {
  const W = CELL, grp = new THREE.Group();
  grp.add(new THREE.Mesh(new THREE.BoxGeometry(W, 0.16, W), DECK_SLAB_MAT));
  const top = new THREE.Mesh(new THREE.BoxGeometry(W * 0.98, 0.06, W * 0.98), DECK_TOP_MAT);
  top.position.y = 0.11; grp.add(top);
  const railX = () => new THREE.Mesh(new THREE.BoxGeometry(W, 0.45, 0.14), RAIL_MAT);   // caps a north/south edge
  const railZ = () => new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.45, W), RAIL_MAT);   // caps an east/west edge
  const addRail = (m, px, pz) => { m.position.set(px, 0.3, pz); grp.add(m); };
  if (!n) addRail(railX(), 0, -W / 2);
  if (!s) addRail(railX(), 0, W / 2);
  if (!e) addRail(railZ(), W / 2, 0);
  if (!w) addRail(railZ(), -W / 2, 0);
  grp.position.set(x, deckY, z);
  roadRoot.add(grp);
  // pillars from the deck down to the seabed
  const h = map.heightAt(x, z), ph = Math.max(0.5, deckY - h);
  for (const [ox, oz] of [[-0.34, -0.34], [0.34, -0.34], [-0.34, 0.34], [0.34, 0.34]]) {
    const pil = new THREE.Mesh(new THREE.BoxGeometry(0.5, ph, 0.5), PILLAR_MAT);
    pil.position.set(x + ox * W, h + ph / 2, z + oz * W);
    roadRoot.add(pil);
  }
}
function rebuildRoads() {
  clearRoadMeshes();
  const beach = map.params.beachHeight || 1, bridgeY = beach + 1.2;
  for (const key of roads) {
    const [cx, cz] = key.split(',').map(Number);
    const x = cx * CELL, z = cz * CELL, h = map.heightAt(x, z);
    const n = roads.has(rkey(cx, cz - 1)), s = roads.has(rkey(cx, cz + 1)),
      e = roads.has(rkey(cx + 1, cz)), w = roads.has(rkey(cx - 1, cz));
    if (isWaterCell(cx, cz)) buildBridgeTile(x, z, Math.max(h + 1.2, bridgeY), n, s, e, w);
    else buildRoadTile(x, z, h + 0.06);
  }
}
// Orthogonal L-path (horizontal then vertical) between two cells, inclusive.
function lineCells(a, b) {
  const out = [], sx = Math.sign(b.cx - a.cx);
  for (let x = a.cx; x !== b.cx; x += sx) out.push([x, a.cz]);
  const sz = Math.sign(b.cz - a.cz);
  for (let z = a.cz; z !== b.cz; z += sz) out.push([b.cx, z]);
  out.push([b.cx, b.cz]);
  return out;
}
function paintRoad(c) {
  if (roadErase) { roads.delete(rkey(c.cx, c.cz)); roadAnchor = null; rebuildRoads(); return; }
  if (roadAnchor && (roadAnchor.cx !== c.cx || roadAnchor.cz !== c.cz)) {
    for (const [x, z] of lineCells(roadAnchor, c)) roads.add(rkey(x, z));   // connect from the last tap
  } else roads.add(rkey(c.cx, c.cz));
  roadAnchor = { cx: c.cx, cz: c.cz };
  rebuildRoads();
}
function setRoadMode(on) {
  roadMode = on; roadAnchor = null;
  $('w-roads').classList.toggle('open', on);
  $('roads-btn').classList.toggle('roadmode-on', on);
  if (on) { setBrush(null); selectPlacement(null); }
}
function setRoadErase(on) {
  roadErase = on; roadAnchor = null;
  $('road-draw').classList.toggle('active', !on);
  $('road-erase').classList.toggle('active', on);
}
$('roads-btn').addEventListener('click', () => setRoadMode(!roadMode));
$('road-draw').addEventListener('click', () => setRoadErase(false));
$('road-erase').addEventListener('click', () => setRoadErase(true));
$('road-clear').addEventListener('click', () => { roads.clear(); roadAnchor = null; rebuildRoads(); });

// --- Layer 3: rules (per-team AI / difficulty / campaign) --------------------
// A pure DATA layer — no 3D, just a form that writes `rules` into the config. The
// GAME applies it at load: archetype + personality feed each AICommander, roster
// sets its fleet (GARAGE_COUNTS), difficulty maps to the AI aim/fire handicap.
// Nothing reads it yet (the load bridge is the next milestone); this authors it.
const ARCHETYPES = ['warrior', 'rogue', 'hunter', 'turtle'];
const ARCH_LABEL = {
  warrior: 'Warrior — presses the attack',
  rogue:   'Rogue — sneaks to the flag',
  hunter:  'Hunter — hunts your units',
  turtle:  'Turtle — digs in & defends',
};
const VEH = ['firebrat', 'lurcher', 'valkyrie', 'jotun'];
const VEH_LABEL = { firebrat: 'Firebrat', lurcher: 'Lurcher', valkyrie: 'Valkyrie', jotun: 'Jotun' };
const DEFAULT_ROSTER = { firebrat: 6, lurcher: 3, valkyrie: 2, jotun: 2 };   // = the game's GARAGE_COUNTS
function defaultTeam(arch) { return { archetype: arch, aggression: 0.6, defensiveness: 0.4, triggerHappy: 0.5, roster: { ...DEFAULT_ROSTER } }; }
// Default to a contrast (attacker vs defender) so a fresh map already reads as a matchup.
let rules = { campaign: { name: '', order: 1 }, difficulty: 'normal', teams: { a: defaultTeam('warrior'), b: defaultTeam('turtle') } };

function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
function textRow(label, val, onChange) {
  const row = el('div', 'prow'); row.appendChild(el('label', null, label));
  const i = el('input'); i.type = 'text'; i.value = val || '';
  i.addEventListener('input', () => onChange(i.value));
  row.appendChild(i); return row;
}
function numRow(label, val, onChange) {
  const row = el('div', 'prow'); row.appendChild(el('label', null, label));
  const i = el('input'); i.type = 'number'; i.value = val; i.min = 1; i.max = 99;
  i.addEventListener('input', () => onChange(parseInt(i.value, 10) || 1));
  row.appendChild(i); return row;
}
function sliderRow(label, val, onChange) {
  const row = el('div', 'prow'); row.appendChild(el('label', null, label));
  const r = el('input'); r.type = 'range'; r.min = 0; r.max = 1; r.step = 0.05; r.value = val;
  const v = el('span', 'val', (+val).toFixed(2));
  r.addEventListener('input', () => { onChange(parseFloat(r.value)); v.textContent = (+r.value).toFixed(2); });
  row.appendChild(r); row.appendChild(v); return row;
}
function selectRow(label, opts, labels, val, onChange) {
  const row = el('div', 'prow'); row.appendChild(el('label', null, label));
  const s = el('select');
  for (const o of opts) { const op = el('option', null, labels[o] || o); op.value = o; if (o === val) op.selected = true; s.appendChild(op); }
  s.addEventListener('change', () => onChange(s.value));
  row.appendChild(s); return row;
}
function rosterCell(label, val, onChange) {
  const c = el('div', 'rost-cell'); c.appendChild(el('span', null, label));
  const i = el('input'); i.type = 'number'; i.min = 0; i.max = 20; i.value = val;
  i.addEventListener('input', () => onChange(Math.max(0, parseInt(i.value, 10) || 0)));
  c.appendChild(i); return c;
}

function buildRulesUI() {
  const panel = $('rules-panel'); panel.innerHTML = '';

  panel.appendChild(el('div', 'seclbl', 'CAMPAIGN'));
  panel.appendChild(textRow('name', rules.campaign.name, v => rules.campaign.name = v));
  panel.appendChild(numRow('order', rules.campaign.order, v => rules.campaign.order = v));

  panel.appendChild(el('div', 'seclbl', 'DIFFICULTY'));
  const dr = el('div', 'diff-row');
  for (const d of ['easy', 'normal', 'hard']) {
    const btn = el('button', 'diff-btn' + (rules.difficulty === d ? ' active' : ''), d.toUpperCase());
    btn.addEventListener('click', () => { rules.difficulty = d; dr.querySelectorAll('.diff-btn').forEach(x => x.classList.toggle('active', x === btn)); });
    dr.appendChild(btn);
  }
  panel.appendChild(dr);

  for (const t of ['a', 'b']) {
    const T = rules.teams[t];
    panel.appendChild(el('div', 'team-hdr', 'TEAM ' + t.toUpperCase()));
    panel.appendChild(selectRow('style', ARCHETYPES, ARCH_LABEL, T.archetype, v => T.archetype = v));
    panel.appendChild(sliderRow('aggression', T.aggression, v => T.aggression = v));
    panel.appendChild(sliderRow('defensive', T.defensiveness, v => T.defensiveness = v));
    panel.appendChild(sliderRow('trigger', T.triggerHappy, v => T.triggerHappy = v));
    panel.appendChild(el('div', 'rost-lbl', 'FLEET (vehicles)'));
    const rg = el('div', 'roster-grid');
    for (const v of VEH) rg.appendChild(rosterCell(VEH_LABEL[v], T.roster[v], n => T.roster[v] = n));
    panel.appendChild(rg);
  }
}

// Load rules from an imported config (tolerant of partial/old configs), then rebuild the form.
function applyRules(r) {
  r = r || {};
  rules.campaign = { name: (r.campaign && r.campaign.name) || '', order: (r.campaign && r.campaign.order) || 1 };
  rules.difficulty = r.difficulty || 'normal';
  for (const t of ['a', 'b']) {
    const src = (r.teams && r.teams[t]) || {};
    const def = defaultTeam(t === 'a' ? 'warrior' : 'turtle');
    rules.teams[t] = {
      archetype: ARCHETYPES.includes(src.archetype) ? src.archetype : def.archetype,
      aggression: src.aggression != null ? src.aggression : def.aggression,
      defensiveness: src.defensiveness != null ? src.defensiveness : def.defensiveness,
      triggerHappy: src.triggerHappy != null ? src.triggerHappy : def.triggerHappy,
      roster: { ...DEFAULT_ROSTER, ...(src.roster || {}) },
    };
  }
  buildRulesUI();
}

$('rules-btn').addEventListener('click', () => $('w-rules').classList.toggle('open'));

// Headless hooks for the test/screenshot rig.
window.MD = {
  map, scene, camera,
  params: () => ({ ...map.params }),
  generate: patch => { importConfig({ base: { ...readParams(), ...patch } }); },
  randomizeSeed: () => $('randomize').click(),
  chunkCount: () => map.chunks.length,
  worldW: () => map.worldW,
  exportConfig,
  importConfig,
  frameMap,
  // Layer 2: placement
  palette: () => PLACEABLE.map(a => a.id),
  setBrush, setTeam: t => { team = t; },
  place: (id, cx, cz, rot = 0, tm = team) => addPlacement(id, cx, cz, rot, tm),
  placeCount: () => placements.length,
  placementAt: i => { const p = placements[i]; return p && { id: p.id, cx: p.cx, cz: p.cz, rot: p.rot, team: p.team, real: !!p.real, y: p.group.position.y }; },
  setRealHQ: (i, real) => { const p = placements[i]; if (p) setRealHQ(p, real); },
  realHQCount: team => teamHQs(team).filter(p => p.real).length,
  removeAt: i => { const p = placements[i]; if (p) removePlacement(p); },
  selectFirst: () => { selectPlacement(placements[0] || null); return !!selected; },
  rotateSel: rotateSel,
  nudge: nudgeSelected,
  deleteSel: () => { if (selected) removePlacement(selected); },
  // Roads
  setRoadMode, setRoadErase, paintRoad: (cx, cz) => paintRoad({ cx, cz }),
  roadCount: () => roads.size, clearRoads: () => { roads.clear(); roadAnchor = null; rebuildRoads(); },
  isWaterCell,
  // Layer 3: rules
  rules: () => JSON.parse(JSON.stringify(rules)),
  applyRules,
  // Saved maps
  saveMap: name => { saveCurrentMap(name); return currentMapId; },
  loadMap: loadSavedMap, deleteMap: deleteSavedMap,
  listMaps: () => savedMaps.map(m => ({ id: m.id, name: m.name })),
  mapCount: () => savedMaps.length, currentMapId: () => currentMapId,
  playUrl,
};

// --- Boot (after all placement state is initialised) -------------------------
buildRulesUI();
initControls();
regenerate(true);
// Saved-maps menu: list what's stored, and reopen the last map you had open.
rebuildMapList();
{
  const lastId = (() => { try { return localStorage.getItem(LAST_KEY); } catch (e) { return null; } })();
  if (lastId && savedMaps.find(m => m.id === lastId)) loadSavedMap(lastId);
}
