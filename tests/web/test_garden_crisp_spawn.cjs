const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const folder = 'web/';
const dataURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const themeURL = dataURL(fs.readFileSync(folder + 'observatory-theme.js', 'utf8'));
const painterURL = dataURL(fs.readFileSync(folder + 'specimen-tree-painter.js', 'utf8').replace("'./observatory-theme.js'", JSON.stringify(themeURL)));
async function modules() {
  const source = fs.readFileSync(folder + 'garden-specimen-renderer.js', 'utf8')
    .replace("'./observatory-theme.js'", JSON.stringify(themeURL))
    .replace("'./specimen-tree-painter.js'", JSON.stringify(painterURL))
    .replace("import './specimen-environment.js';", '');
  return { ...await import(dataURL(source)), ...await import(painterURL) };
}
function canvasFactory(log = []) {
  return (width, height) => {
    const canvas = { width, height }, stack = [];
    const ctx = { canvas, globalAlpha: 1, globalCompositeOperation: 'source-over',
      save() { stack.push({ globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation }); },
      restore() { Object.assign(this, stack.pop()); },
      drawImage(...args) { log.push({ kind: 'image', alpha: this.globalAlpha, composite: this.globalCompositeOperation, smoothing: this.imageSmoothingEnabled, quality: this.imageSmoothingQuality, args }); },
      scale(x, y) { log.push({ kind: 'scale', x, y }); },
      fill() { log.push({ kind: 'fill', composite: this.globalCompositeOperation, alpha: this.globalAlpha }); },
      stroke() { log.push({ kind: 'stroke', composite: this.globalCompositeOperation, alpha: this.globalAlpha }); },
      createRadialGradient() { return { addColorStop() {} }; },
    };
    for (const method of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'bezierCurveTo', 'ellipse', 'arc', 'translate', 'rotate', 'rect', 'clip', 'clearRect', 'fillRect', 'setTransform']) ctx[method] = () => {};
    canvas.getContext = () => ctx;
    return canvas;
  };
}
function cohort(n = 794) {
  const species = ['build', 'conversation', 'orchestration', 'slow-burn', 'quick'];
  return Array.from({ length: n }, (_, i) => ({ id: `session-${i}`, species: species[i % 5], sizeClass: Math.floor(i / 5) % 5,
    density: ['sparse', 'medium', 'dense'][Math.floor(i / 25) % 3], fruit: i % 6, visualKey: `visual-${i % 150}` }));
}
async function setup(records = cohort(25), ratio = 1) {
  const api = await modules(), encodings = new Map(records.map(r => [r.id, r])), allocations = [], rasterLog = [];
  const factory = canvasFactory(rasterLog);
  const renderer = api.createGardenSpecimenRenderer({ encoding: id => encodings.get(id), scale: () => 1, dpr: () => ratio,
    treeSize: () => 2.8, createCanvas: (w, h) => { allocations.push([w, h]); return factory(w, h); },
    shadow: (ctx, x, y, radius) => { ctx.beginPath(); ctx.ellipse(x, y, radius, radius / 2, 0, 0, Math.PI * 2); ctx.fill(); } });
  return { ...api, renderer, allocations, encodings, records, rasterLog };
}


const grow = (a, size = 1) => ({ trunk: Math.min(1, a * 1.4), branches: Math.max(0, Math.min(1, a * 1.4 - .3)), crown: Math.max(0, Math.min(1, a * 1.4 - .6)), size, active: a < 1 });
const settledGrowth = { trunk: 1, branches: 1, crown: 1, size: 1, active: false };
const canvasStub = log => { const c = canvasFactory(log)(800, 800); return c.getContext('2d'); };
const origin = { x: 300, y: 600, renderScale: 1 };
const plan = { zoom: 1, dpr: 1 };

test('a growing tree is drawn native vector while the camera moves, with no atlas raster', async () => {
  const { renderer, records } = await setup(cohort(6));
  const rec = { s: records[2], screen: origin }; 
  renderer.prepare([rec], { ...plan, moving: true });
  renderer.beginFrame([rec], { zoom: 1, dpr: 1, moving: true, now: 0 });
  const log = [], ctx = canvasStub(log);
  const before = renderer.stats().rasterDraws;
  assert.equal(renderer.usesVector(records[2]), false);
  const result = renderer.tree(ctx, records[2], origin, grow(.3));
  assert.equal(result.renderPath, 'vector');
  assert.equal(renderer.stats().rasterDraws, before);
  assert.equal(renderer.stats().focusVectorDraws, 1);
  // A settled non-focus tree still uses the atlas while moving.
  renderer.beginFrame([{ s: records[3], screen: origin }], { zoom: 1, dpr: 1, moving: true, now: 16 });
  assert.notEqual(renderer.tree(ctx, records[3], origin, settledGrowth).renderPath, 'vector');
});

test('declared focus subjects are crisp while moving and the focus set is capped', async () => {
  const { renderer, records, api } = await setup(cohort(20));
  const recs = records.map(s => ({ s, screen: origin }));
  renderer.prepare(recs, { ...plan, moving: true });
  renderer.beginFrame(recs, { zoom: 1, dpr: 1, moving: true, now: 0, focusIds: records.map(r => r.id) });
  const ctx = canvasStub([]);
  let vector = 0;
  for (const s of records) { renderer.usesVector(s); if (renderer.tree(ctx, s, origin, settledGrowth).renderPath === 'vector') vector++; }
  assert.equal(vector, 8);
  assert.equal(renderer.stats().focusLimit, 8);
});

test('effective upscale of a spawning tree stays <= 1.05 across growth and dive', async () => {
  const { renderer, records } = await setup(cohort(6), 2);
  const s = records[4], ctx = canvasStub([]);
  let worst = 0, frames = 0;
  for (let i = 0; i <= 60; i++) {
    const t = i / 60, zoom = 1 + 1.6 * t, moving = t < .95, rec = { s, screen: { ...origin, renderScale: zoom } };
    renderer.prepare([rec], { zoom, dpr: 2, moving });
    renderer.beginFrame([rec], { zoom, dpr: 2, moving, now: i * 16 });
    const r = renderer.tree(ctx, s, { ...origin, renderScale: zoom }, grow(t));
    if (t > 0) { assert.equal(r.renderPath, 'vector', `frame ${i}`); worst = Math.max(worst, r.upscale); frames++; }
  }
  assert.ok(frames > 50); assert.ok(worst <= 1.05, `upscale ${worst}`);
});

test('growth end hands off without a size or offset jump', async () => {
  const { renderer, records } = await setup(cohort(6));
  const s = records[4], rec = { s, screen: origin };
  const rects = [];
  const log = [], ctx = canvasStub(log);
  for (let i = 0; i < 12; i++) {
    const growth = i < 3 ? grow(.9 + i * .04) : settledGrowth;
    renderer.prepare([rec], { ...plan, moving: false, budgetMs: Infinity });
    renderer.beginFrame([rec], { zoom: 1, dpr: 1, moving: false, now: i * 200 });
    log.length = 0;
    const r = renderer.tree(ctx, s, origin, growth);
    const imgs = log.filter(e => e.kind === 'image' && e.args.length === 9);
    const last = imgs.sort((a, b) => b.args[7] * b.args[8] - a.args[7] * a.args[8])[0];
    if (i >= 2 && last) {
      const box = last.args.slice(5, 9).map(Number);
      if (r.renderPath !== 'vector') { box[0] += origin.x; box[1] += origin.y; } // atlas draws in origin-relative space
      rects.push({ path: r.renderPath, box });
    }
  }
  assert.ok(rects.length > 4);
  const settled = renderer.settledBounds(s, origin, 1).bounds;
  for (const r of rects.slice(1)) {
    const [x, y, w, h] = r.box;
    assert.ok(Math.abs(x - Math.floor(settled.x)) <= 1 && Math.abs(y - Math.floor(settled.y)) <= 1, JSON.stringify([r.path, r.box, settled]));
    assert.ok(Math.abs(w - settled.w) <= 2 && Math.abs(h - settled.h) <= 2);
  }
});

test('hover rim still builds on a settled tree after it grew (focus does not break drawHover)', async () => {
  const { renderer, records } = await setup(cohort(4));
  const rec = { s: records[1], screen: origin };
  renderer.prepare([rec], plan); renderer.beginFrame([rec], { zoom: 1, dpr: 1, now: 0 });
  renderer.tree(canvasStub([]), records[1], origin, grow(.4));
  renderer.setHovered(records[1].id, 0);
  renderer.beginFrame([rec], { zoom: 1, dpr: 1, now: 500 });
  const out = renderer.drawHover(canvasStub([]), [rec], { now: 500, zoom: 1, dpr: 1, growthFor: () => settledGrowth });
  assert.deepEqual(out.drawnIds, [records[1].id]);
});
