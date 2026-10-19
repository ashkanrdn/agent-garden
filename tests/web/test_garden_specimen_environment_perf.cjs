const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const root = 'web/';
const art = require('../../' + root + 'specimen-environment.js');
function load(file, extra = {}) {
  const c = vm.createContext(extra);
  vm.runInContext(fs.readFileSync(root + file, 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, ''), c);
  return c;
}
function harness(extra = {}) {
  const calls = {}, canvases = [];
  class Canvas {
    constructor(w, h) {
      let width = w, height = h; this.assignments = 0;
      Object.defineProperties(this, {
        width: { get: () => width, set: v => { width = v; this.assignments++; } },
        height: { get: () => height, set: v => { height = v; this.assignments++; } },
      });
      const stack = [];
      const ctx = this.ctx = { canvas: this, globalAlpha: 1, globalCompositeOperation: 'source-over',
        save() { stack.push([this.globalAlpha, this.globalCompositeOperation]); },
        restore() { [this.globalAlpha, this.globalCompositeOperation] = stack.pop(); },
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        createPattern() { calls.pattern = (calls.pattern || 0) + 1; return {}; },
        createLinearGradient: () => ({ addColorStop() {} }),
      };
      for (const name of ['setTransform', 'transform', 'clearRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
        'rect', 'clip', 'fillRect', 'fill', 'stroke', 'drawImage', 'arc', 'ellipse', 'quadraticCurveTo', 'putImageData']) {
        ctx[name] = (...args) => { calls[name] = (calls[name] || 0) + 1; calls[name + 'Args'] = args; ctx[name + 'Args'] = args; };
      }
      canvases.push(this);
    }
    getContext() { return this.ctx; }
  }
  const env = load('garden-specimen-environment.js', { SpecimenEnvironment: art, OffscreenCanvas: Canvas, ...extra })
    .createGardenSpecimenEnvironment({ seed: 'test' });
  const project = (x, y, z = 0) => ({ x: x + 100, y: y + 100 - z });
  const config = { layout: { plots: [] }, contourGeometry: { rings: [] },
    terrain: { faces: [], water: { faces: [], wetPolygons: [], shoreSegments: [] } },
    project, width: 300, height: 300, dpr: 2 };
  return { env, config, calls, canvases, Canvas };
}
test('fresh content-identical plot views hit the environment cache', () => {
  const { env, config } = harness();
  const surface = load('garden-plot-hills.js').createPlotHills();
  const plot = { id: 'p', area: 40000, centroid: { x: 100, y: 100 },
    polygon: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }] };
  config.layout.plots = [plot];
  const view = () => surface.view([plot], config.project, { width: 300, height: 300 });
  const first = env.prepare({ ...config, plotHillView: view() });
  assert.equal(env.prepare({ ...config, plotHillView: view() }), first);
  assert.equal(env.stats().cacheHits, 1);
});
test('moving pan reuses the true view, while large zoom and rotation rebuild', () => {
  const { env, config, calls, Canvas } = harness();
  const base = env.prepare(config), before = env.stats();
  const pan = (x, y, z) => { const p = config.project(x, y, z); return { x: p.x + 5, y: p.y + 7 }; };
  const moving = env.prepare({ ...config, project: pan, moving: true });
  assert.equal(env.stats().preparations, before.preparations);
  assert.equal(env.stats().maskBuilds, before.maskBuilds);
  assert.equal(moving.marks, base.marks);
  moving.drawStatic(new Canvas(300, 300).ctx);
  assert.deepEqual(calls.transformArgs, [1, 0, 0, 1, 5, 7]);
  assert.equal(env.prepare(config), base);
  env.prepare({ ...config, moving: true, project: (x, y, z) => { const p = pan(x, y, z); return { x: p.x * 2, y: p.y * 2 }; } });
  assert.equal(env.stats().preparations, before.preparations + 1);
  env.prepare({ ...config, moving: true, project: (x, y, z) => { const p = pan(x, y, z); return { x: -p.y * 2, y: p.x * 2 }; } });
  assert.equal(env.stats().preparations, before.preparations + 2);
});
test('the static surface is sized only on resize and cached; drawWater is a no-op', () => {
  const { env, config, Canvas, canvases, calls } = harness();
  const plot = { id: 'flat', polygon: [{ x: -300, y: -300 }, { x: 500, y: -300 }, { x: 500, y: 500 }, { x: -300, y: 500 }], area: 640000 };
  const plotHillView = { faces: [{ plotId: 'flat', points: [] }],
    surfacePoint: (id, x, y) => ({ ...config.project(x, y), depth: 0, visible: true, opacity: 1 }),
    surfaceVisible: () => true, decorationVisible: () => true };
  const ctx = new Canvas(300, 300).ctx;
  const view = env.prepare({ ...config, layout: { plots: [plot] }, plotHillView });
  view.drawStatic(ctx); view.drawStatic(ctx);
  assert.equal(env.stats().staticRenders, 1);
  const before = { ...calls };
  for (let i = 0; i < 6; i++) view.drawWater(ctx, i * 15);
  view.drawWater(ctx, 300, { moving: true });
  assert.deepEqual(calls, before, 'drawWater touches nothing');
  assert.equal(env.stats().waterRenders, 0);
  assert.equal(view.animating, false); assert.equal(view.waterStepMs, 0);
  assert.equal(canvases.length, 2);
  assert.ok(canvases.every(c => c.assignments === 0));
  env.prepare({ ...config, layout: { plots: [plot] }, plotHillView, width: 310 });
  assert.equal(canvases.length, 2);
  assert.equal(canvases[1].assignments, 1);
  assert.equal(env.stats().maxRasterBytes, 2048 * 2048 * 4);
});

test('plot marks batch full visibility and merge partial clips into horizontal runs', () => {
  const { env, config, calls, Canvas } = harness();
  const polygon = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const plot = { id: 'flat', polygon, area: 10000 };
  const plotHillView = { faces: [{ plotId: 'flat', points: polygon.map(p => ({ ...config.project(p.x, p.y), depth: 0 })) }],
    surfacePoint: (id, x, y) => ({ ...config.project(x, y), depth: 0, visible: true, opacity: 1 }),
    surfaceVisible: x => x < 190, decorationVisible: x => x < 190 };
  const view = env.prepare({ ...config, layout: { plots: [plot] }, plotHillView });
  const ctx = new Canvas(300, 300).ctx;
  view.drawStatic(ctx);
  assert.ok(view.marks.ground.length > 20);
  assert.ok((calls.rect || 0) < 200, `rect count ${calls.rect}`);
  assert.ok((calls.clip || 0) < 20, `clip count ${calls.clip}`);
  assert.ok(calls.clip > 0, 'fixture includes partially visible marks');
  const rects = calls.rect, clips = calls.clip, draws = calls.drawImage;
  view.drawStatic(ctx);
  assert.equal(calls.rect, rects); assert.equal(calls.clip, clips);
  assert.equal(calls.drawImage, draws + 1);
});
test('paper patterns are cached per context and tile; null patterns are retried', () => {
  const { Canvas, calls } = harness();
  const primitives = load('specimen-environment.js', { OffscreenCanvas: Canvas }).SpecimenEnvironment;
  const ctx = new Canvas(300, 300).ctx, rect = { x: 0, y: 0, w: 300, h: 300 };
  for (let i = 0; i < 10; i++) primitives.drawPaperGrain(ctx, rect, { seed: 42 });
  assert.equal(calls.pattern, 1);
  primitives.drawPaperGrain(ctx, rect, { seed: 43 }); assert.equal(calls.pattern, 2);
  primitives.drawPaperGrain(new Canvas(300, 300).ctx, rect, { seed: 42 }); assert.equal(calls.pattern, 3);
  let attempts = 0; ctx.createPattern = () => { attempts++; return null; };
  primitives.drawPaperGrain(ctx, rect, { seed: 44 }); primitives.drawPaperGrain(ctx, rect, { seed: 44 });
  assert.equal(attempts, 2);
});
test('changed fractional face opacity invalidates the content cache', () => {
  const { env, config } = harness();
  const face = { plotId: 'p', opacity: .2, points: [{ x: 0, y: 0, depth: 0 }, { x: 20, y: 0, depth: 0 }, { x: 0, y: 20, depth: 0 }] };
  const view = env.prepare({ ...config, plotHillView: { faces: [face] } });
  assert.notEqual(env.prepare({ ...config, plotHillView: { faces: [{ ...face, opacity: .3 }] } }), view);
});
test('moving viewport overlap and degenerate ground bases force rebuilds', () => {
  const { env, config } = harness();
  env.prepare(config);
  env.prepare({ ...config, moving: true, project: (x, y, z) => { const p = config.project(x, y, z); return { x: p.x + 200, y: p.y }; } });
  assert.equal(env.stats().movingReuses, 0); assert.equal(env.stats().preparations, 2);
  const flat = { ...config, project: (x, y, z = 0) => ({ x: x + y, y: -z }) };
  env.prepare(flat); env.prepare({ ...flat, moving: true, project: (x, y, z = 0) => ({ x: x + y + 1, y: -z }) });
  assert.equal(env.stats().movingReuses, 0); assert.equal(env.stats().preparations, 4);
});


test('the static surface covers a quarter viewport on every side and respects the pixel cap', () => {
  const { env, config, canvases, Canvas, calls } = harness();
  const plot = { id: 'flat', polygon: [{ x: -300, y: -300 }, { x: 500, y: -300 }, { x: 500, y: 500 }, { x: -300, y: 500 }], area: 640000 };
  const plotHillView = { faces: [{ plotId: 'flat', points: [] }],
    surfacePoint: (id, x, y) => ({ ...config.project(x, y), depth: 0, visible: true, opacity: 1 }),
    surfaceVisible: () => true, decorationVisible: () => true };
  const full = { ...config, layout: { plots: [plot] }, plotHillView };
  const target = new Canvas(300, 300).ctx, view = env.prepare(full);
  view.drawStatic(target);
  assert.equal(canvases[1].width, 900); assert.equal(canvases[1].height, 900);
  assert.deepEqual(calls.drawImageArgs.slice(1), [0, 0, 900, 900, -75, -75, 450, 450]);
  assert.deepEqual(canvases[1].ctx.setTransformArgs, [2, 0, 0, 2, 150, 150]);
  env.prepare({ ...full, width: 4000, height: 2000, dpr: 3 }).drawStatic(target);
  assert.equal(canvases[1].width, 2048); assert.equal(canvases[1].height, 1024);
  assert.ok(env.stats().rasterBytes <= env.stats().maxRasterBytes);
});

test('expanded moving coverage accepts a 20 percent pan and rejects a 40 percent pan', () => {
  for (const axis of ['x', 'y']) for (const sign of [-1, 1]) {
    const { env, config } = harness();
    const base = env.prepare(config);
    const pan = amount => (x, y, z) => {
      const p = config.project(x, y, z); p[axis] += sign * amount * config.width; return p;
    };
    assert.equal(env.prepare({ ...config, project: pan(.2), moving: true }).marks, base.marks);
    assert.equal(env.stats().movingReuses, 1);
    env.prepare({ ...config, project: pan(.4), moving: true });
    assert.equal(env.stats().preparations, 2);
  }
});


test('ground marks cover the overscan ring while plot depth queries stay in the viewport', () => {
  const { env, config } = harness();
  const plot = { id: 'flat', polygon: [{ x: -300, y: -300 }, { x: 500, y: -300 }, { x: 500, y: 500 }, { x: -300, y: 500 }], area: 640000 };
  const plotHillView = { faces: [{ plotId: 'flat', points: [] }],
    surfacePoint: (id, x, y) => ({ ...config.project(x, y), depth: 0, visible: true, opacity: 1 }),
    surfaceVisible(x, y) { assert.ok(x >= 0 && y >= 0 && x < 300 && y < 300, 'no depth probes outside the viewport'); return true; },
    decorationVisible(x, y) { assert.ok(x >= 0 && y >= 0 && x < 300 && y < 300); return true; } };
  const view = env.prepare({ ...config, layout: { plots: [plot] }, plotHillView });
  const inside = p => p.x >= 0 && p.y >= 0 && p.x < 300 && p.y < 300;
  assert.ok(view.marks.ground.length > 0 && view.marks.ground.every(inside));
  assert.ok(view.marks.margin.length > 0 && view.marks.margin.every(p => !inside(p) && p.x >= -75 && p.x < 375 && p.y >= -75 && p.y < 375));
  assert.ok(view.marks.margin.some(p => p.x < 0) && view.marks.margin.some(p => p.x >= 300));
  assert.equal(env.stats().margin, view.marks.margin.length);
  assert.equal(JSON.stringify([view.marks.shore, view.marks.reeds, view.wetPolygons, view.shoreSegments]), '[[],[],[],[]]');
  view.drawStatic(new (harness().Canvas)(300, 300).ctx);
});
