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
const hills = load('garden-hill-environment.js');
function adapter() { return load('garden-specimen-environment.js', { SpecimenEnvironment: primitives }).createGardenSpecimenEnvironment({ seed: 'test' }); }
const project = (x, y, z = 0) => ({ x: x + 100, y: y + 100 - z });
function terrain() {
  const t = { baseZ: 0, rise: 10, vertices: [
    { x: 0, y: 0, z: 0 }, { x: 80, y: 0, z: 0 }, { x: 0, y: 80, z: 0 },
    { x: 10, y: 10, z: 10 }, { x: 50, y: 10, z: 10 }, { x: 10, y: 50, z: 10 }],
  faces: [{ indices: [0, 1, 2], x: 26, y: 26 }, { indices: [3, 4, 5], x: 24, y: 24 }] };
  t.water = hills.buildTerrainWater(t, [], 5);
  return t;
}
test('water is gone: drawWater is a no-op, nothing animates, and the mask never claims water', () => {
  const env = adapter();
  const config = { terrain: terrain(), project, width: 300, height: 300, camera: { yaw: 0 }, layout: { plots: [] }, contourGeometry: { rings: [] } };
  const view = env.prepare(config);
  assert.equal(view.animating, false);
  assert.equal(view.waterStepMs, 0);
  assert.equal(JSON.stringify([view.wetPolygons, view.shoreSegments, view.marks.shore, view.marks.reeds]), '[[],[],[],[]]');
  for (const [x, y] of [[105, 105], [120, 110], [-50, 100], [170, 99]]) assert.equal(view.waterMask.contains(x, y), false);
  const draws = [];
  const ctx = new Proxy({}, { get: (_, name) => (...args) => draws.push(name), set: () => true });
  view.drawWater(ctx, 1234); view.drawWater(ctx, 5678, { moving: true });
  assert.equal(draws.length, 0);
  assert.equal(env.stats().waterDraws, 0);
  assert.equal(env.stats().shore, 0); assert.equal(env.stats().reeds, 0);
});

test('empty history clears marks; camera-only changes retain world-rooted samples and bounded storage', () => {
  const env = adapter();
  const { createPlotHills } = load('garden-plot-hills.js');
  const plot = { id: 'meadow', area: 40000, centroid: { x: 100, y: 100 },
    polygon: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }] };
  const surface = createPlotHills();
  const config = { terrain: { faces: [], vertices: [], water: { wetPolygons: [], shoreSegments: [], faces: [] } },
    layout: { plots: [plot] }, contourGeometry: { rings: [] }, width: 800, height: 800, camera: { yaw: 0 }, project };
  config.plotHillView = surface.view([plot], project, { width: 800, height: 800 });
  const first = env.prepare(config);
  assert.ok(first.marks.ground.length > 10);
  assert.equal(env.prepare(config), first);
  const shifted = (x, y, z) => { const p = project(x, y, z); return { x: p.x + 5, y: p.y + 7 }; };
  const next = env.prepare({ ...config, project: shifted,
    plotHillView: surface.view([plot], shifted, { width: 800, height: 800 }) });
  const common = next.marks.ground.filter(p => first.marks.ground.some(q => q.seed === p.seed));
  assert.ok(common.length > first.marks.ground.length * .95, 'only visibility edge samples can change');
  for (const p of common) assert.deepEqual(p.world, first.marks.ground.find(q => q.seed === p.seed).world);
  assert.ok(first.marks.ground.every(p => Math.abs(p.world.z - (surface.height(plot, p.world.x, p.world.y) + 2)) < 1e-7));
  for (let i = 0; i < 5; i++) env.prepare({ ...config, width: 800 + i });
  assert.ok(env.stats().views <= 1);
  assert.ok(env.stats().ground <= 1600 && env.stats().flowers <= 64 && env.stats().shore <= 768 && env.stats().reeds <= 64);
  const empty = env.prepare({ ...config, layout: { plots: [] }, plotHillView: null });
  assert.equal(empty.marks.ground.length, 0);
  env.clear(); assert.equal(env.stats().views, 0);
});

test('ground marks render once into one overscanned static bitmap and repeat draws only blit it', () => {
  let allocations = 0;
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; allocations++; }
    getContext() {
      if (this.ctx) return this.ctx;
      const stack = [], draws = [];
      return this.ctx = { globalAlpha: 1, globalCompositeOperation: 'source-over', draws,
        save() { stack.push([this.globalAlpha, this.globalCompositeOperation]); },
        restore() { [this.globalAlpha, this.globalCompositeOperation] = stack.pop(); },
        setTransform() {}, transform() {}, clearRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, rect() {}, clip() {},
        fillRect() {}, fill() {}, stroke() {}, arc() {}, ellipse() {}, quadraticCurveTo() {}, bezierCurveTo() {},
        createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
        drawImage() { draws.push({ alpha: this.globalAlpha, composite: this.globalCompositeOperation }); } };
    }
  }
  const env = load('garden-specimen-environment.js', { SpecimenEnvironment: primitives, OffscreenCanvas: Canvas })
    .createGardenSpecimenEnvironment({ seed: 41 });
  const { createPlotHills } = load('garden-plot-hills.js');
  const plot = { id: 'meadow', area: 400000, centroid: { x: 100, y: 100 },
    polygon: [{ x: -300, y: -300 }, { x: 500, y: -300 }, { x: 500, y: 500 }, { x: -300, y: 500 }] };
  const surface = createPlotHills();
  const config = { terrain: terrain(), project, width: 300, height: 300, dpr: 2, layout: { plots: [plot] }, contourGeometry: { rings: [] } };
  config.plotHillView = surface.view([plot], project, { width: 300, height: 300 });
  const view = env.prepare(config), target = new Canvas(300, 300).getContext(); target.globalAlpha = .23;
  assert.ok(view.marks.ground.length > 0 && view.marks.margin.length > 0, 'margin ground marks fill the overscan ring');
  view.drawStatic(target); view.drawStatic(target);
  assert.equal(allocations, 2, 'one static surface plus the target');
  assert.equal(env.stats().staticRenders, 1);
  assert.equal(env.stats().maskBuilds, 0);
  assert.equal(target.draws.length, 2);
  assert.ok(target.draws.every(d => d.alpha === .23 && d.composite === 'source-over'));
  assert.equal(env.prepare(config), view);
  env.prepare({ ...config, width: 10000, height: 10000, dpr: 3 });
  assert.ok(env.stats().rasterBytes <= 2048 * 2048 * 4);
  assert.equal(allocations, 2, 'resize the same surface');
});

test('a 20 percent pan reuses the view while moving and keeps its marks', () => {
  const env = adapter(), { createPlotHills } = load('garden-plot-hills.js');
  const plot = { id: 'meadow', area: 40000, centroid: { x: 100, y: 100 },
    polygon: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }] };
  const surface = createPlotHills();
  const config = { terrain: terrain(), project, width: 300, height: 300, layout: { plots: [plot] }, contourGeometry: { rings: [] } };
  config.plotHillView = surface.view([plot], project, { width: 300, height: 300 });
  const base = env.prepare(config), preparations = env.stats().preparations;
  const pan = (x, y, z) => { const p = project(x, y, z); return { x: p.x + 60, y: p.y }; };
  const moving = env.prepare({ ...config, project: pan, moving: true });
  assert.equal(moving.marks, base.marks);
  assert.equal(moving.animating, false);
  assert.equal(env.stats().movingReuses, 1);
  assert.equal(env.stats().preparations, preparations);
});
