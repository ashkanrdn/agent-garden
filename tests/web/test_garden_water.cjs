const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const root = 'web/';
function load(file, extra = {}) {
  const c = vm.createContext(extra);
  vm.runInContext(fs.readFileSync(root + file, 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, ''), c);
  return c;
}
const primitives = require('../../web/specimen-environment.js');
const { buildWaterBasin, waterContours, waterValue } = primitives;
const hills = load('garden-hill-environment.js');
const { buildIslandContours } = load('garden-island-contours.js');
const island = buildIslandContours([{ x: -400, y: -300 }, { x: 400, y: -300 }, { x: 400, y: 300 }, { x: -400, y: 300 }]);

function synthRing(n = 256) {
  const at = (r, i) => ({ x: Math.cos(i / n * Math.PI * 2) * r * (1 + .12 * Math.sin(i / 9)), y: Math.sin(i / n * Math.PI * 2) * r * (1 + .12 * Math.sin(i / 9)) });
  return { level: 0, count: n, center: { x: 0, y: 0 },
    inner: Array.from({ length: n }, (_, i) => at(3000, i)), outer: Array.from({ length: n }, (_, i) => at(5000, i)) };
}
function recorder() {
  const log = { paths: [], ops: [], images: 0, ellipses: [] };
  let path = null;
  const ctx = new Proxy({ globalAlpha: 1, getTransform: () => ({ a: 1 }) }, {
    get(target, name) {
      if (name in target) return target[name];
      if (name === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (name === 'beginPath') return () => { path = []; };
      if (name === 'moveTo' || name === 'lineTo') return (x, y) => { path?.push([name, x, y]); };
      if (name === 'stroke') return () => { if (path) log.paths.push({ style: target.strokeStyle, width: target.lineWidth, alpha: target.globalAlpha, path }); };
      if (name === 'drawImage') return () => { log.images++; };
      return (...args) => { log.ops.push(name); if (name === 'ellipse') log.ellipses.push(args); };
    },
    set(target, name, value) { target[name] = value; return true; },
  });
  return { ctx, log };
}
function adapter(extra = {}) {
  return load('garden-specimen-environment.js', { SpecimenEnvironment: primitives, ...extra }).createGardenSpecimenEnvironment({ seed: 'test' });
}
const layout = { plots: [] }, contourGeometry = { rings: [] };
function projection(zoom, yaw = 0, ox = 100, oy = 80) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return (x, y, z = 0) => ({ x: ox + (x * c - y * s) * zoom, y: oy + (x * s + y * c) * zoom * .5 - z * zoom });
}
const HUGE = 400000;
function prepare(env, ring, project, extra = {}) {
  return env.prepare({ layout, contourGeometry, terrain: { baseZ: 0, waterRing: ring, vertices: [], faces: [] }, project, camera: {}, width: HUGE, height: HUGE, dpr: 1, ...extra });
}

test('water field is anchored to world space and deterministic', () => {
  const ring = synthRing();
  const basin = buildWaterBasin(ring), again = buildWaterBasin(synthRing());
  assert.equal(basin.cell, again.cell);
  assert.deepEqual(Array.from(basin.cells), Array.from(again.cells));
  const a = waterContours(basin, 12.3, { seed: 'x' }), b = waterContours(again, 12.3, { seed: 'x' });
  assert.equal(a.segments, b.segments);
  assert.ok(a.segments > 3000, 'dense iso-line field');
  assert.deepEqual(Array.from(a.levels[6]), Array.from(b.levels[6]));
  assert.ok(waterValue(10, 20, 1, 5, 500) === waterValue(10, 20, 1, 5, 500));
  const half = basin.cell * basin.cols / 2;
  for (const list of a.levels) for (let i = 0; i < list.length; i += 2) assert.ok(Math.abs(list[i]) < 6000 + half && Math.abs(list[i + 1]) < 6000 + half);
});

test('lines stay inside the annulus band around the ring (only near cells are sampled)', () => {
  const ring = synthRing(), basin = buildWaterBasin(ring), { levels } = waterContours(basin, 3, { seed: 1 });
  let checked = 0;
  for (const list of levels) for (let i = 0; i < list.length; i += 4) {
    const r = Math.hypot(list[i], list[i + 1]);
    assert.ok(r > 3000 * .8 - basin.cell * 6 && r < 5000 * 1.12 + basin.cell * 6, 'segment radius ' + r);
    checked++;
  }
  assert.ok(checked > 3000);
});

test('the field drifts slowly: a 100 ms step barely moves, 30 s changes it', () => {
  const pts = Array.from({ length: 300 }, (_, i) => [Math.cos(i) * 4000, Math.sin(i * 1.7) * 4000]);
  const mean = (t0, t1) => pts.reduce((s, [x, y]) => s + Math.abs(waterValue(x, y, t0, 9, 1200) - waterValue(x, y, t1, 9, 1200)), 0) / pts.length;
  assert.ok(mean(5, 5.1) < .003, `step change ${mean(5, 5.1)}`);
  assert.ok(mean(5, 35) > .03, `long change ${mean(5, 35)}`);
  const basin = buildWaterBasin(synthRing());
  const a = waterContours(basin, 5, { seed: 1 }), b = waterContours(basin, 5.1, { seed: 1 });
  assert.ok(Math.abs(a.segments - b.segments) / a.segments < .02, 'no popping between steps');
});

test('adapter advertises the 100 ms cadence only when a ring exists', () => {
  const env = adapter(), ring = synthRing();
  const withWater = prepare(env, ring, projection(.05));
  assert.equal(withWater.animating, true);
  assert.equal(withWater.waterStepMs, 100);
  const none = adapter().prepare({ layout, contourGeometry, terrain: { baseZ: 0, vertices: [], faces: [] }, project: projection(.05), camera: {}, width: 300, height: 300, dpr: 1 });
  assert.equal(none.animating, false); assert.equal(none.waterStepMs, 0);
  const { ctx, log } = recorder(); none.drawWater(ctx, 500); assert.equal(log.ops.length + log.paths.length, 0);
});

// Un-project the recorded contour segments of one draw back to world units.
function worldSegments(project) {
  const env = adapter(), view = prepare(env, synthRing(), project);
  const { ctx, log } = recorder(); view.drawWater(ctx, 1234);
  const o = project(0, 0, 0), px = project(1, 0, 0), py = project(0, 1, 0);
  const ax = px.x - o.x, ay = px.y - o.y, bx = py.x - o.x, by = py.y - o.y, det = ax * by - ay * bx;
  const inv = (x, y) => { const sx = x - o.x, sy = y - o.y; return [(sx * by - sy * bx) / det, (sy * ax - sx * ay) / det]; };
  const lines = log.paths.filter(p => p.width < 1.2 && p.path.length > 500 && p.path.some(q => q[0] === 'lineTo'));
  const segs = [];
  for (const { path } of lines) for (let i = 0; i + 1 < path.length; i += 2) segs.push([...inv(path[i][1], path[i][2]), ...inv(path[i + 1][1], path[i + 1][2])]);
  return { segs, strokes: lines.length };
}
test('iso-line world shapes are identical under different zoom, yaw and pan', () => {
  const one = worldSegments(projection(.05, 0, 3000, 2000)), two = worldSegments(projection(.05, 0, 30000, 5000));
  assert.ok(one.segs.length > 3000);
  assert.equal(one.segs.length, two.segs.length);
  const key = s => s.map(v => Math.round(v / 2)).join(',');
  const set = new Set(one.segs.map(key)); let hit = 0;
  for (const s of two.segs) if (set.has(key(s))) hit++;
  assert.ok(hit / two.segs.length > .95, 'panning keeps the shapes');
  // Zoom re-projects the same world segments; both zooms draw the identical segment count.
  const zoomed = worldSegments(projection(.2, .4, 9000, 6000));
  assert.equal(zoomed.segs.length, one.segs.length);
  const zset = new Set(zoomed.segs.map(key)); let same = 0;
  for (const s of one.segs) if (zset.has(key(s))) same++;
  assert.ok(same / one.segs.length > .95, 'zoom and yaw keep the shapes');
});

class FakeCanvas {
  constructor(w, h) { this.width = w; this.height = h; this.ctx = recorder(); }
  getContext() { return this.ctx.ctx; }
}
test('bitmap path: one render per 100 ms step, reused every frame in between, and per view', () => {
  const env = adapter({ OffscreenCanvas: FakeCanvas }), ring = synthRing();
  const view = prepare(env, ring, projection(.05), { width: 800, height: 600 });
  const { ctx, log } = recorder();
  for (const t of [0, 16, 33, 50, 99]) view.drawWater(ctx, t);
  assert.equal(env.stats().waterRenders, 1);
  assert.equal(env.stats().shoreRenders, 1);
  assert.equal(log.images, 10, 'water and shore bitmaps drawn each frame');
  view.drawWater(ctx, 100); view.drawWater(ctx, 180);
  assert.equal(env.stats().waterRenders, 2);
  assert.equal(env.stats().shoreRenders, 1, 'shore bitmap is static');
  view.drawWater(ctx, 350, { moving: true }); view.drawWater(ctx, 360, { moving: true });
  assert.equal(env.stats().waterRenders, 2, 'no new step renders while moving');
  view.drawWater(ctx, 350);
  assert.equal(env.stats().waterRenders, 3);
  const next = prepare(env, ring, projection(.06), { width: 800, height: 600 });
  next.drawWater(ctx, 350);
  assert.equal(env.stats().waterRenders, 4, 'a new camera basis re-renders once');
  assert.equal(env.stats().shoreRenders, 2);
});

test('a worker-cloned ring (new identity, same content) keeps the cached view', () => {
  const env = adapter({ OffscreenCanvas: FakeCanvas });
  const project = projection(.05), a = prepare(env, synthRing(), project, { width: 800, height: 600 });
  const b = prepare(env, JSON.parse(JSON.stringify(synthRing())), project, { width: 800, height: 600 });
  assert.equal(a, b);
  const moved = synthRing(); moved.outer[0].x += 500;
  assert.notEqual(prepare(env, moved, project, { width: 800, height: 600 }), a);
});

test('moving-camera reuse applies the same affine to the water', () => {
  const env = adapter(), ring = synthRing();
  prepare(env, ring, projection(.05, 0, 100, 80), { width: 800, height: 600 });
  const reused = prepare(env, ring, projection(.052, 0, 110, 84), { width: 800, height: 600, moving: true });
  const transforms = [], { ctx } = recorder();
  const wrapped = new Proxy(ctx, { get: (t, n) => n === 'transform' ? (...a) => transforms.push(a) : t[n], set: (t, n, v) => (t[n] = v, true) });
  reused.drawWater(wrapped, 0);
  assert.equal(transforms.length, 1);
  assert.equal(env.stats().movingReuses, 1);
});

test('zooming out fades the minor lines and thins pebbles by nested power-of-two ranks', () => {
  const alphaAt = zoom => { const env = adapter(), view = prepare(env, synthRing(), projection(zoom));
    const { ctx, log } = recorder(); view.drawWater(ctx, 0);
    return Math.max(0, ...log.paths.filter(p => p.width < .8 && p.path.length > 200 && p.path.some(q => q[0] === 'lineTo')).map(p => p.alpha)); };
  assert.ok(alphaAt(.002) < alphaAt(.05) + 1e-9);
  assert.equal(alphaAt(.0005), 0, 'no minor lines once the island is a few pixels wide');
  const pebbles = zoom => {
    const env = adapter(), { ctx, log } = recorder();
    prepare(env, synthRing(), projection(zoom, 0, 3000, 3000), { width: 6000, height: 6000 }).drawWater(ctx, 0);
    return log.ellipses.map(a => `${Math.round(a[0])}/${Math.round(a[1])}`);
  };
  const near = pebbles(.1), far = pebbles(.012), farther = pebbles(.003);
  assert.ok(near.length > 1500, 'gravel band has thousands of rings up close: ' + near.length);
  assert.ok(far.length < near.length && farther.length <= far.length, 'fewer pebbles when zoomed out');
});
