const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const directory = 'web/';
const source = fs.readFileSync(directory + 'canvas-garden.js', 'utf8');
const extract = name => { const start = source.indexOf(`function ${name}(`), end = source.indexOf('\nfunction ', start + 1); assert.ok(start >= 0); return source.slice(start, end < 0 ? undefined : end); };
const urls = new Map();
function moduleURL(name) { if (!urls.has(name)) urls.set(name, 'data:text/javascript;base64,' + Buffer.from(fs.readFileSync(directory + name, 'utf8').replace(/(import[^;]*?)(['"])[.]\/([^'"]+)\2/g, (_, prefix, quote, dependency) => prefix + quote + moduleURL(dependency) + quote)).toString('base64')); return urls.get(name); }
const load = name => import(moduleURL(name));
const terrainSource = () => source.slice(source.indexOf('function terrainWorkerMain('), source.indexOf("(()=>{'use strict'"));

async function realTerrain() {
  const [{ buildIslandContours }, { createHillEnvironment }, { unprojectGround }] = await Promise.all(['garden-island-contours.js', 'garden-hill-environment.js', 'garden-robot-camera.js'].map(load));
  const geometry = buildIslandContours([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }]);
  const zoom = .3, unproject = (x, y, z) => unprojectGround((x - 400) / zoom + 200, (y - 300) / zoom + 150 + z, .37);
  const basis = [unproject(0, 0, 0), unproject(1, 0, 0), unproject(0, 1, 0), unproject(0, 0, 1)];
  return { geometry, basis, createHillEnvironment };
}
const strip = value => JSON.parse(JSON.stringify(value, (key, v) => key === 'value' ? undefined : v));

test('terrain codec round trips the real terrain through transferable typed arrays', async () => {
  const { geometry, basis, createHillEnvironment } = await realTerrain();
  const c = vm.createContext({ performance }); vm.runInContext(terrainSource(), c);
  let reply, transfer, listener;
  c.terrainWorkerMain(createHillEnvironment, (value, list) => { reply = value; transfer = list; }, fn => { listener = fn; });
  listener({ geometry, generation: 3, basis, width: 800, height: 600, key: 'k' });
  assert.ok(reply.packed && !reply.terrain, 'sent flat arrays, not the object graph');
  assert.equal(reply.packed.floats.constructor.name, 'Float64Array');assert.equal(reply.packed.uints.constructor.name, 'Uint32Array');
  assert.equal(transfer.length, 2);assert.ok(transfer[0] === reply.packed.floats.buffer && transfer[1] === reply.packed.uints.buffer);
  const original = createHillEnvironment()(geometry, { width: 800, height: 600, unproject: (sx, sy, sz) => ({ x: basis[0].x + sx * (basis[1].x - basis[0].x) + sy * (basis[2].x - basis[0].x) + sz * (basis[3].x - basis[0].x), y: basis[0].y + sx * (basis[1].y - basis[0].y) + sy * (basis[2].y - basis[0].y) + sz * (basis[3].y - basis[0].y) }) });
  const unpacked = c.unpackTerrain(reply.packed);
  assert.deepEqual(strip(unpacked), strip(original));
  assert.equal(unpacked.water.wetPolygons.length, original.water.wetPolygons.length);
});

test('terrain preparation unpacks in time slices, keeps the old terrain, and dissolves to the new one', async () => {
  const { geometry, basis, createHillEnvironment } = await realTerrain();
  const timers = [];
  const c = vm.createContext({ performance, setTimeout: fn => timers.push(fn) || timers.length, clearTimeout() {} }); vm.runInContext(terrainSource(), c);
  let listener; const replies = [];
  c.terrainWorkerMain(createHillEnvironment, value => replies.push(value), fn => { listener = fn; });
  let ready = 0; const sent = [];
  const worker = { postMessage: m => { sent.push(m); listener(m); }, terminate() {} };
  const prep = c.createTerrainPreparation({ makeWorker: () => worker, onReady: () => ready++, sliceMs: 0, fadeMs: 100 });
  const options = { width: 800, height: 600, unproject: (sx, sy, sz) => ({ x: basis[0].x + sx * (basis[1].x - basis[0].x) + sy * (basis[2].x - basis[0].x) + sz * (basis[3].x - basis[0].x), y: basis[0].y + sx * (basis[1].y - basis[0].y) + sy * (basis[2].y - basis[0].y) + sz * (basis[3].y - basis[0].y) }) };
  assert.equal(prep.request(geometry, options), null, 'nothing exists on a cold start');
  worker.onmessage({ data: replies.shift() });
  assert.equal(ready, 0, 'zero-budget slice leaves the unpack unfinished');
  assert.ok(timers.length >= 1 && prep.stats().pending);
  assert.equal(prep.request(geometry, options), null, 'request does not re-post the terrain being unpacked');
  assert.equal(sent.length, 1);
  while (timers.length) timers.shift()();
  assert.equal(ready, 1);
  const first = prep.request(geometry, options);
  assert.ok(first.vertices.length > 0 && !prep.fade());
  // A new layout keeps drawing the old terrain until the replacement lands, then fades.
  const next = { ...geometry };
  assert.equal(prep.request(next, options), first, 'previous terrain is not blanked by a new geometry');
  worker.onmessage({ data: replies.shift() });
  while (timers.length) timers.shift()();
  const second = prep.request(next, options);
  assert.notEqual(second, first);
  const fade = prep.fade(performance.now());
  assert.equal(fade.from, first);
  assert.ok(fade.alpha >= 0 && fade.alpha < 1);
  assert.equal(prep.fade(performance.now() + 500), null);
});

test('a geometry replaced mid-unpack abandons the stale job', async () => {
  const { geometry, basis, createHillEnvironment } = await realTerrain();
  const timers = [];
  const c = vm.createContext({ performance, setTimeout: fn => timers.push(fn) || 1, clearTimeout() {} }); vm.runInContext(terrainSource(), c);
  let listener; const replies = [];
  c.terrainWorkerMain(createHillEnvironment, value => replies.push(value), fn => { listener = fn; });
  const worker = { postMessage: m => listener(m), terminate() {} }; let ready = 0;
  const prep = c.createTerrainPreparation({ makeWorker: () => worker, onReady: () => ready++, sliceMs: 0 });
  const options = { width: 800, height: 600, unproject: (sx, sy, sz) => ({ x: basis[0].x + sx * (basis[1].x - basis[0].x) + sy * (basis[2].x - basis[0].x) + sz * (basis[3].x - basis[0].x), y: basis[0].y + sx * (basis[1].y - basis[0].y) + sy * (basis[2].y - basis[0].y) + sz * (basis[3].y - basis[0].y) }) };
  prep.request(geometry, options); worker.onmessage({ data: replies.shift() });
  prep.request({ ...geometry }, options);
  while (timers.length) timers.shift()();
  assert.equal(ready, 0, 'the superseded layout never installs');
});

test('level-of-detail gates use hysteresis and a dwell so one tree cannot flip the forest', () => {
  const c = vm.createContext({}); vm.runInContext(extract('selectDetailedTreeIds'), c);
  const trees = height => Array.from({ length: 40 }, (_, i) => ({ s: { id: 't' + i }, screenHeight: height }));
  const memory = { close: false, few: false, held: false, changedAt: -Infinity };
  const run = (height, now, count = 40) => c.selectDetailedTreeIds(trees(height).slice(0, count), { proxyView: true, zoomed: true, memory, now }).size;
  assert.equal(run(66, 0), 0, 'below the 72 px entry threshold nothing is promoted');
  assert.equal(run(73, 1000), 40, 'entering close view');
  assert.equal(run(60, 1100), 40, 'inside the band the state holds');
  assert.equal(run(50, 1200), 40, 'dwell holds the state for 300 ms');
  assert.equal(memory.held, true);
  assert.equal(run(50, 1400), 0, 'leaves below 56 px after the dwell');
  // The 30-tree gate: enter under 26, leave over 34.
  assert.equal(run(20, 2000, 29), 0, '29 trees do not enter');
  assert.equal(run(20, 3000, 25), 25, '25 trees enter');
  assert.equal(run(20, 3500, 33), 33, '33 trees stay');
  assert.equal(run(20, 4000, 35), 0, '35 trees leave');
});

test('settleScene repaints once after motion, dissolves terrain, pumps rasters, then goes idle', () => {
  let rebuilds = 0, pumps = 0, pending = 3;
  const c = vm.createContext({ performance, flight: null, spotlight: null, overviewFit: null, layoutMotion: { active: false }, pointerGesture: null, dirty: false, forestCache: {},
    rebuild() { rebuilds++; c.lastRebuildMoving = false; }, botanical: { pump() { pumps++; pending = Math.max(0, pending - 1); }, stats: () => ({ pendingRasters: pending }) } });
  vm.runInContext(source.slice(source.indexOf('const MOTION_SETTLE_MS'), source.indexOf('\n', source.indexOf('function invalidateRects'))).replace(/^let /m, 'var ') + '\n' + extract('settleScene'), c);
  c.lastMotionAt = 1000; c.lastRebuildMoving = true; c.rasterPending = 0;
  c.settleScene(1050, false); assert.equal(rebuilds, 0, 'still inside the settle window');
  c.settleScene(1200, false); assert.equal(rebuilds, 1, 'one crisp repaint after the camera rests');
  c.settleScene(1216, false); assert.equal(rebuilds, 1);
  c.terrainFading = true; c.settleScene(1232, false); assert.equal(rebuilds, 2, 'terrain fade keeps repainting');
  c.settleScene(1232, true); assert.equal(rebuilds, 2, 'never rebuilds twice in one frame');
  c.terrainFading = false; c.rasterPending = 3;
  for (let i = 0; i < 3; i++) { c.dirty = false; c.settleScene(1300 + i, false); assert.equal(c.dirty, true, 'queue keeps the loop alive'); }
  assert.equal(pumps, 3); assert.equal(c.rasterPending, 0);
  c.dirty = false; c.settleScene(1400, false); assert.equal(c.dirty, false, 'idle once the queue and fades are empty');
  assert.equal(pumps, 3);
});

test('dataset writes are skipped when nothing changed and diagnostics throttle while moving', () => {
  const c = vm.createContext({ performance }); vm.runInContext(source.slice(source.indexOf('const MOTION_SETTLE_MS'), source.indexOf('\n', source.indexOf('function invalidateRects'))), c);
  let writes = 0; const dataset = new Proxy({}, { set(t, k, v) { writes++; t[k] = v; return true; } });
  const element = { dataset };
  c.setDataset(element, { a: '1', b: '2' }); c.setDataset(element, { a: '1', b: '3' });
  assert.equal(writes, 3);
  assert.equal(c.diagnosticsDue('rebuild', 1000, true), true);
  assert.equal(c.diagnosticsDue('rebuild', 1100, true), false);
  assert.equal(c.diagnosticsDue('rebuild', 1100, false), true, 'settled frames always report');
  assert.equal(c.diagnosticsDue('rebuild', 1400, true), true);
});

test('flight rebuilds crossfade over reusable ghost buffers and stagger base and forest', () => {
  const helpers = source.slice(source.indexOf('const MOTION_SETTLE_MS'), source.indexOf('\n', source.indexOf('function invalidateRects'))).replace(/^let /m, 'var ');
  const events = [];
  const layer = (name, w = 200, h = 100) => ({ name, width: w, height: h, getContext: () => ({ setTransform() {}, clearRect() {}, drawImage: src => events.push('copy:' + src.name + '>' + name) }) });
  const ctx = { globalAlpha: 1, save() {}, restore() {}, setTransform() {}, translate() {}, scale() {}, drawImage: img => events.push('draw:' + img.name + '@' + ctx.globalAlpha.toFixed(2)) };
  const clock = { t: 1000 };
  const c = vm.createContext({ performance: { now: () => clock.t }, ctx, DPR: 1, W: 200, H: 100, camera: { x: 0, y: 0, zoom: .1 }, baseCamera: { x: 5, y: 0, zoom: .1 },
    base: layer('base'), forestCanvas: layer('forest'), ghostBase: layer('gb'), ghostForest: layer('gf'), FLIGHT_FADE_MS: 120,
    flightFade: { active: false, cam: null, start: 0, forestStart: null, defer: 0 } });
  vm.runInContext(helpers + '\n' + extract('snapshotLayers') + '\n' + extract('flightFadeAlpha') + '\n' + extract('drawGhostLayer'), c);
  const ghostBase = c.ghostBase, ghostForest = c.ghostForest;
  assert.equal(c.flightFadeAlpha(1000), null, 'no fade before a flight rebuild');
  c.snapshotLayers(1000);
  assert.deepEqual(events.splice(0), ['copy:base>gb', 'copy:forest>gf']);
  assert.ok(c.ghostBase === ghostBase && c.ghostForest === ghostForest, 'the same two canvases are reused');
  assert.equal(c.flightFade.cam.x, 5, 'ghost remembers the camera it was rendered at');
  let f = c.flightFadeAlpha(1060);
  assert.ok(f.base > 0 && f.base < 1 && f.forest === 0, 'forest waits one frame behind the base');
  c.flightFade.defer = 0; c.flightFade.forestStart = 1060;
  f = c.flightFadeAlpha(1120); assert.equal(f.base, 1); assert.ok(f.forest > 0 && f.forest < 1);
  c.drawGhostLayer(c.ghostBase); assert.deepEqual(events.splice(0), ['draw:gb@1.00']);
  assert.equal(c.flightFadeAlpha(1200), null, 'fade completes and goes inactive');
  assert.equal(c.flightFade.active, false);
  c.snapshotLayers(2000); c.snapshotLayers(2200);
  assert.ok(c.ghostBase === ghostBase, 'repeated snapshots never allocate a canvas');
  // Wiring: the flight rebuild snapshots first; drawDynamic holds the forest for one frame.
  assert.match(source, /snapshotLayers\(now\);rebuild\(\);lastSceneTime=now/);
  assert.match(source, /if\(fade&&flightFade\.defer>0\)\{flightFade\.defer--;drawGhostLayer\(ghostForest\)\}/);
});
