const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load(file) {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../web', file), 'utf8')
    .replace(/export /g, ''), context);
  return context;
}
const { perlinNoise, hillHeight, contourHulls, createHillEnvironment, drawHillEnvironment, buildWaterRing } = load('garden-hill-environment.js');
const { buildIslandContours } = load('garden-island-contours.js');
const { buildTerrainWater } = load('garden-hill-environment.js');
const { projectGround, unprojectGround } = load('garden-robot-camera.js');
const outline = [{ x: -400, y: -300 }, { x: 400, y: -300 }, { x: 400, y: 300 }, { x: -400, y: 300 }];
const island = buildIslandContours(outline);

test('water clips crossing triangles, retains basin holes, and excludes the finite skirt', () => {
  const vertices = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 10 }, { x: 0, y: 10, z: 10 }];
  const terrain = { vertices, faces: [{ indices: [0, 1, 2] }], baseZ: 0, rise: 10 };
  const water = buildTerrainWater(terrain, [], 5);
  assert.equal(water.wetPolygons.length, 1);
  assert.equal(water.shoreSegments.length, 1);
  assert.equal(water.wetPolygons[0].length, 3);
  assert.ok(water.wetPolygons.flat().every(p => p.z === 5 && p.x + p.y <= 5));
  const skirt = [{ x: -1, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 12 }, { x: -1, y: 12 }];
  const excluded = buildTerrainWater(terrain, skirt, 5);
  assert.ok(excluded.wetPolygons.length > 0);
  assert.ok(excluded.wetPolygons.flat().every(p => p.x >= 2 - 1e-8));
  assert.ok(excluded.shoreSegments.flatMap(s => s.points).every(p => p.x >= 2 - 1e-8));
  const basin = { vertices: [{ x: 0, y: 0, z: 0 }, { x: -10, y: -10, z: 10 },
    { x: 10, y: -10, z: 10 }, { x: 10, y: 10, z: 10 }, { x: -10, y: 10, z: 10 }],
    faces: [1, 2, 3, 4].map((i, j) => ({ indices: [0, i, (j + 1) % 4 + 1] })), baseZ: 0, rise: 10 };
  const pond = buildTerrainWater(basin, [], 5);
  assert.equal(pond.wetPolygons.length, 4);
  assert.equal(pond.shoreSegments.length, 4);
  const ends = pond.shoreSegments.flatMap(s => s.points).map(p => `${p.x}/${p.y}`);
  assert.ok(ends.every(p => ends.filter(q => q === p).length === 2), 'shore joins across mesh seams');
});
function view(zoom, yaw = 0, pan = 0) {
  const width = 1280, height = 720;
  return { width, height, unproject: (x, y, z) => unprojectGround((x - width / 2) / zoom + pan,
    (y - height / 2) / zoom + pan + z, yaw), project: (x, y, z) => {
    const p = projectGround(x, y, yaw, z);
    return { x: width / 2 + (p.x - pan) * zoom, y: height / 2 + (p.y - pan) * zoom };
  } };
}

test('seeded gradient noise is repeatable and continuous across lattice boundaries', () => {
  let low = 1, high = -1;
  for (let i = -100; i <= 100; i++) {
    const x = i * .137, y = i * .073 + .4, value = perlinNoise(x, y);
    assert.equal(value, perlinNoise(x, y));
    assert.ok(Math.abs(value) <= 1);
    low = Math.min(low, value); high = Math.max(high, value);
    const edge = Math.round(x);
    assert.ok(Math.abs(perlinNoise(edge - 1e-7, y) - perlinNoise(edge + 1e-7, y)) < 1e-6);
  }
  assert.ok(high - low > .5);
  assert.notEqual(perlinNoise(.42, .79, 1), perlinNoise(.42, .79, 2));
});

test('contour hulls separate neighboring summits and retain a basin inside a ridge', () => {
  const columns = 41, rows = 25, values = new Float64Array(columns * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    values[y * columns + x] = Math.max(0, 1 - Math.hypot(x - 10, y - 12) / 7,
      1 - Math.hypot(x - 30, y - 12) / 7);
  }
  const hulls = contourHulls(values, columns, rows, .5, { x: 0, y: 0, step: 1 });
  assert.equal(hulls.length, 2);
  assert.ok(hulls.some(h => h.every(p => p.x < 20)));
  assert.ok(hulls.some(h => h.every(p => p.x > 20)));
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    values[y * columns + x] = Math.max(0, 1 - Math.abs(Math.hypot(x - 20, y - 12) - 6) / 3);
  }
  assert.equal(contourHulls(values, columns, rows, .5, { x: 0, y: 0, step: 1 }).length, 2);
});

test('terrain sampling follows world coordinates and produces independent peaks', () => {
  const options = { center: { x: 0, y: 0 }, span: 1000 };
  let peaks = 0;
  for (let y = -20; y <= 20; y++) for (let x = -20; x <= 20; x++) {
    const px = x * 140, py = y * 140, h = hillHeight(px, py, options);
    assert.equal(h, hillHeight(px, py, options));
    assert.ok(h >= 0 && h <= 1);
    if ([[140, 0], [-140, 0], [0, 140], [0, -140]].every(([dx, dy]) => h > hillHeight(px + dx, py + dy, options))) peaks++;
  }
  assert.ok(peaks > 20, `Expected independent summits, found ${peaks}`);
});

test('finite padded grids cover extreme zoom, pan, and rotation without growing memory per field', () => {
  const environment = createHillEnvironment(), before = JSON.stringify(island);
  for (const [zoom, yaw, pan] of [[.25, 0, 0], [.003, 1.4, 2e5], [1e-9, 4.2, -3e11]]) {
    const camera = view(zoom, yaw, pan), terrain = environment(island, camera), b = terrain.bounds;
    assert.equal(environment(island, camera), terrain, 'Same visible tile reuses its geometry');
    assert.ok(terrain.stats.gridCells <= 113 ** 2);
    assert.ok(terrain.faces.length <= 112 ** 2 * 2);
    assert.ok(terrain.layers.length > 10 && terrain.stats.hulls > 20);
    for (const z of [terrain.baseZ, terrain.baseZ + terrain.rise]) {
      for (const x of [0, camera.width]) for (const y of [0, camera.height]) {
        const p = camera.unproject(x, y, z);
        assert.ok(p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h);
      }
    }
    for (const vertex of terrain.vertices) assert.ok(Number.isFinite(vertex.x + vertex.y + vertex.z));
  }
  assert.equal(JSON.stringify(island), before, 'Environment must not change the island');
});

test('hills stay below the island top and contour segments have constant elevation', () => {
  const terrain = createHillEnvironment()(island, view(.4));
  assert.ok(terrain.vertices.every(p => p.z < 0));
  const center = terrain.vertices.filter(p => Math.hypot(p.x, p.y) < 250);
  assert.ok(center.length > 0 && center.every(p => p.z === terrain.baseZ));
  let segments = 0;
  for (const face of terrain.faces) for (const segment of face.segments) {
    const [a, b] = segment.points;
    assert.equal(a.z, b.z);
    assert.ok(Number.isFinite(a.x + a.y + b.x + b.y));
    segments++;
  }
  assert.ok(segments > 1000);
});

test('drawing uses the affine camera consistently and accepts an empty historical island', () => {
  const environment = createHillEnvironment(), camera = view(.2, .7), terrain = environment(island, camera);
  const ctx = { save() {}, restore() {}, fillRect() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {},
    moveTo(x, y) { assert.ok(Number.isFinite(x + y)); }, lineTo(x, y) { assert.ok(Number.isFinite(x + y)); } };
  let projections = 0;
  const dashes = new Map();
  drawHillEnvironment(ctx, terrain, (...args) => { projections++; return camera.project(...args); },
    { ...camera, traceContour(_target, _points, options) { dashes.set(options.id, options); } });
  assert.equal(projections, 4, 'Projection basis avoids trigonometry for every contour segment');
  assert.ok(dashes.size > 5);
  assert.ok([...dashes.values()].every(style => style.origin.x === camera.project(0, 0, 0).x));
  const empty = environment(buildIslandContours([]), camera);
  assert.equal(empty.faces.length, 0);
  assert.doesNotThrow(() => drawHillEnvironment(ctx, empty, camera.project, camera));
});

test('water fields share the three-entry geometry cache and empty history releases it', () => {
  const environment = createHillEnvironment();
  const first = environment(island, view(.3));
  assert.equal(environment(island, view(.3)).water, first.water);
  for (const pan of [1e4, 2e4, 3e4]) environment(island, view(.3, .4, pan));
  assert.equal(environment.stats().fields, 3);
  assert.notEqual(environment(island, view(.3)), first, 'oldest field is evicted');
  const empty = environment(buildIslandContours([]), view(.3));
  assert.equal(environment.stats().fields, 0);
  assert.equal(empty.water.wetPolygons.length, 0);
});


function fadeTerrain() {
  const vertices = [{ x: 20, y: 400, z: 0 }, { x: 120, y: 500, z: 0 }, { x: 20, y: 550, z: 0 }];
  return { vertices, faces: [{ indices: [0, 1, 2], x: 50, y: 480, tone: 1,
    segments: Array.from({ length: 30 }, (_, i) => ({ level: 5, major: true,
      points: [{ x: 25 + i, y: 450, z: 0 }, { x: 80 + i, y: 480, z: 0 }] })) }] };
}
function fadeContext(alpha = .8, dpr = 2) {
  const strokes = [], points = [], fills = [];
  return { strokes, points, fills, globalAlpha: alpha,
    save() {}, restore() {}, beginPath() {}, closePath() {}, fillRect() {},
    fill() { fills.push(this.globalAlpha); }, stroke() { strokes.push(this.globalAlpha); },
    moveTo(x, y) { points.push([x, y]); }, lineTo(x, y) { points.push([x, y]); },
    getTransform() { return { a: dpr }; }, setLineDash() {}
  };
}

test('hill contour passes match the exact fade with and without a shared tracer', () => {
  const local = load('garden-hill-environment.js'), terrain = fadeTerrain();
  for (const [devicePeriod, t] of [[2, 0], [3, 0], [4.5, .5], [6, 1], [8, 1], [3.01, .00003325925925925784]]) {
    local.SpecimenEnvironment = { contourDashStyle: () => ({ period: devicePeriod / 2, phase: .7, solid: true, alpha: .123 }) };
    for (const baseAlpha of [.8, .005]) for (const traced of [false, true]) {
      const ctx = fadeContext(baseAlpha), passes = [];
      const traceContour = traced ? (target, points, options) => {
        passes.push({ solid: options.solid, alpha: target.globalAlpha });
        target.moveTo(points[0].x, points[0].y); target.lineTo(points[1].x, points[1].y);
      } : null;
      local.drawHillEnvironment(ctx, terrain, (x, y) => ({ x, y }), { width: 600, height: 600, traceContour });
      const expected = [baseAlpha * t, baseAlpha * Math.max(.32, Math.min(.75, devicePeriod / 4)) * (1 - t)].filter(a => a >= .01);
      assert.equal(ctx.strokes.length, expected.length, 'thirty segments share one stroke per level and pass');
      ctx.strokes.forEach((a, i) => assert.ok(Math.abs(a - expected[i]) < 1e-10));
      assert.deepEqual(ctx.fills, [baseAlpha], 'fade does not change the opaque face pass');
      if (traced) assert.equal(passes.length, expected.length * 30);
    }
  }
});

test('hill fallback uses the same period fade and world-anchored dashes standalone', () => {
  const local = load('garden-hill-environment.js'), terrain = fadeTerrain();
  const period = 15 * (.8 + .4 * ((5 * .754877666) % 1));
  const fade = local.hillDashFade(period, .2), ctx = fadeContext(.8, .2);
  local.drawHillEnvironment(ctx, terrain, (x, y) => ({ x, y }), { width: 600, height: 600, traceContour: null });
  const expected = [.8 * fade.dashAlpha, .8 * fade.solidAlpha].filter(a => a >= .01);
  assert.deepEqual(ctx.strokes, expected);
  const a = fadeContext(1), b = fadeContext(1);
  local.drawHillEnvironment(a, terrain, (x, y) => ({ x, y }), { width: 600, height: 600, traceContour: null });
  local.drawHillEnvironment(b, terrain, (x, y) => ({ x: x + 13, y: y + 7 }), { width: 600, height: 600, traceContour: null });
  assert.equal(a.points.length, b.points.length);
  a.points.forEach((point, i) => {
    assert.ok(Math.abs(point[0] - (b.points[i][0] - 13)) < 1e-8);
    assert.ok(Math.abs(point[1] - (b.points[i][1] - 7)) < 1e-8);
  });
});

test('WATER_GAP is a wide flat calm gap with no water geometry', () => {
  const wide = createHillEnvironment()(island, view(.4));
  const ring = island.rings.at(-1).points, rmin = Math.min(...ring.map(p => Math.hypot(p.x - island.center.x, p.y - island.center.y)));
  const limit = rmin * .98 + island.span * .60 * .9;
  const inside = wide.vertices.filter(p => Math.hypot(p.x - island.center.x, p.y - island.center.y) < limit);
  assert.ok(inside.length > 0 && inside.every(p => p.z === wide.baseZ), 'flat ground inside the widened gap');
  assert.deepEqual(JSON.parse(JSON.stringify(wide.water)), { level: wide.baseZ, wetPolygons: [], shoreSegments: [], faces: [] });
});

// Ridge water: a geometric annulus that depends on the island footprint only.
const ringSignature = ring => JSON.stringify([ring.inner, ring.outer]);

test('ridge water outline is identical across zooms, yaws, pans, octaves and tile keys', () => {
  const environment = createHillEnvironment();
  const views = [view(.05), view(.2), view(.4, .7), view(1.5, 1.2, 3000), view(.02, 0, -50000)];
  const terrains = views.map(v => environment(island, v));
  assert.ok(new Set(terrains.map(t => t.key)).size > 2, 'different tile keys');
  assert.ok(new Set(terrains.map(t => t.stats.octave)).size > 1, 'different octaves');
  for (const t of terrains) assert.equal(t.waterRing, terrains[0].waterRing, 'cached by geometry, not tile key');
  assert.equal(ringSignature(createHillEnvironment()(island, view(.9)).waterRing), ringSignature(terrains[0].waterRing));
  assert.deepEqual(JSON.parse(JSON.stringify(terrains[0].water)), { level: terrains[0].baseZ, wetPolygons: [], shoreSegments: [], faces: [] });
});

test('ridge water lies between the island shore and the hill ramp start', () => {
  const terrain = createHillEnvironment()(island, view(.4)), ring = terrain.waterRing;
  const shore = island.rings.at(-1).points, c = island.center;
  assert.equal(ring.inner.length, 256); assert.equal(ring.outer.length, 256);
  const radii = ring.inner.map(p => Math.hypot(p.x - c.x, p.y - c.y) / .985);
  buildWaterRing(island, radii, .60).outer.forEach((p, i) => assert.ok(Math.hypot(p.x - ring.outer[i].x, p.y - ring.outer[i].y) < 1e-6, 'pure function of footprint and gap'));
  ring.outer.forEach((p, i) => {
    const inner = Math.hypot(ring.inner[i].x - c.x, ring.inner[i].y - c.y), outer = Math.hypot(p.x - c.x, p.y - c.y);
    const shoreR = inner / .985, ramp = shoreR * .98 + island.span * .60;
    assert.ok(outer > shoreR + island.span * .3, 'wide band outside the shore');
    assert.ok(outer < ramp, 'outer edge is inside the ramp start so hills overlap');
    assert.ok(outer > ramp - island.span * .60 * .1, 'stays close to the ridge');
    assert.ok(inner < shoreR + 1e-9, 'inner edge tucks under the island');
  });
  assert.ok(shore.length > 3);
  // Terrain vertices at the outer edge are flat (value 0): the ring never crosses a raised face.
  const near = terrain.vertices.filter(p => { const d = Math.hypot(p.x - c.x, p.y - c.y); return d < Math.min(...ring.outer.map(o => Math.hypot(o.x - c.x, o.y - c.y))); });
  assert.ok(near.length > 0 && near.every(p => p.value === 0));
});

test('hills are drawn after the water and flat faces never cover it', () => {
  const environment = createHillEnvironment(), camera = view(.2, .7), terrain = environment(island, camera);
  const order = [];
  const ctx = { globalAlpha: 1, save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillRect() { order.push('paper'); }, set fillStyle(v) { this._fill = v; },
    createLinearGradient() { return { addColorStop() {} }; },
    fill(rule) { order.push(rule === 'evenodd' ? 'water' : 'hill'); } };
  drawHillEnvironment(ctx, terrain, camera.project, { ...camera, traceContour() {} });
  assert.equal(order[0], 'paper'); assert.equal(order[1], 'water');
  assert.equal(order.filter(o => o === 'water').length, 1);
  assert.ok(order.length > 3 && order.slice(2).every(o => o === 'hill'), 'every hill face follows the water');
  const raised = terrain.faces.filter(f => f.indices.some(i => terrain.vertices[i].value > 0)).length;
  assert.equal(order.filter(o => o === 'hill').length <= raised, true, 'flat faces are skipped so water stays visible');
});

test('waterHole leaves the annulus transparent (destination-out) instead of filling it', () => {
  const terrain = createHillEnvironment()(island, view(.4));
  const camera = view(.4), calls = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {}, setLineDash() {},
    fillRect() { calls.push('paper'); }, set fillStyle(v) {}, set globalCompositeOperation(v) { calls.push('op:' + v); },
    createLinearGradient() { return { addColorStop() {} }; },
    fill(rule) { calls.push(rule === 'evenodd' ? 'hole' : 'hill'); } };
  drawHillEnvironment(ctx, terrain, camera.project, { ...camera, waterHole: true, traceContour() {} });
  assert.deepEqual(calls.slice(0, 4), ['paper', 'op:destination-out', 'hole', 'op:source-over']);
  assert.equal(calls.filter(c => c === 'hole').length, 1);
  assert.ok(terrain.waterRing.center && Number.isFinite(terrain.waterRing.center.x), 'ring carries its world center');
});

test('drawWater is fed by the world-anchored water layer, not the old no-op', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '../../web/garden-specimen-environment.js'), 'utf8');
  assert.doesNotMatch(src, /drawWater\(\) \{\}/);
  assert.match(src, /waterStepMs: water \? WATER_STEP_MS : 0/);
});
