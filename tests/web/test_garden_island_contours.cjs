const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
for (const file of ['garden-layout.js', 'garden-island-contours.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../web', file), 'utf8').replace(/export /g, ''), context);
}
const { buildGardenLayout, buildIslandContours, createIslandContourCache } = context;
const area = points => Math.abs(points.reduce((sum, a, i) => {
  const b = points[(i + 1) % points.length]; return sum + a.x * b.y - b.x * a.y;
}, 0)) / 2;
function inside(p, polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

test('terraces enclose the actual shore without changing island or plot geometry', () => {
  for (const seed of ['garden', 'long-shore', '483765r937n']) {
    const layout = buildGardenLayout([{ id: 'a', sessionCount: 10 }, { id: 'b', sessionCount: 300 }], { seed });
    const before = JSON.stringify(layout), relief = buildIslandContours(layout.outline);
    assert.equal(JSON.stringify(layout), before);
    let inner = layout.outline, elevation = 0;
    for (const ring of relief.rings) {
      assert.ok(area(ring.points) > area(inner));
      assert.ok(inner.every(p => inside(p, ring.points)), 'Each terrace contains its preceding shore');
      assert.ok(ring.z < elevation);
      assert.ok(ring.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
      inner = ring.points; elevation = ring.z;
    }
  }
});

test('relief follows translated and resized historical outlines without stale geometry', () => {
  const outline = buildGardenLayout([{ id: 'a', sessionCount: 50 }]).outline;
  const relief = buildIslandContours(outline), factor = 2.5;
  const moved = outline.map(p => ({ x: p.x * factor + 71, y: p.y * factor - 38 }));
  const grown = buildIslandContours(moved);
  relief.rings.forEach((ring, i) => {
    assert.ok(Math.abs(grown.rings[i].z - ring.z * factor) < 1e-8);
    ring.points.forEach((p, j) => {
      assert.ok(Math.abs(grown.rings[i].points[j].x - (p.x * factor + 71)) < 1e-8);
      assert.ok(Math.abs(grown.rings[i].points[j].y - (p.y * factor - 38)) < 1e-8);
    });
  });
  const cached = createIslandContourCache();
  assert.equal(cached(outline), cached(outline));
  assert.notEqual(cached(outline), cached(moved));
});

test('camera envelope includes every contour at all orbit angles', () => {
  const outline = buildGardenLayout([{ id: 'a', sessionCount: 50 }]).outline;
  const relief = buildIslandContours(outline);
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 24) {
    const project = p => {
      const x = p.x * Math.cos(angle) - p.y * Math.sin(angle);
      const y = p.x * Math.sin(angle) + p.y * Math.cos(angle);
      return { x: x - y, y: (x + y) * .43 - (p.z || 0) };
    };
    const envelope = relief.extent.map(project);
    const minX = Math.min(...envelope.map(p => p.x)), maxX = Math.max(...envelope.map(p => p.x));
    const minY = Math.min(...envelope.map(p => p.y)), maxY = Math.max(...envelope.map(p => p.y));
    for (const ring of relief.rings) for (const p of ring.points) {
      const q = project({ ...p, z: ring.z });
      assert.ok(q.x >= minX - 1e-7 && q.x <= maxX + 1e-7);
      assert.ok(q.y >= minY - 1e-7 && q.y <= maxY + 1e-7);
    }
  }
});

test('empty and degenerate historical outlines produce no contours', () => {
  for (const outline of [[], [{ x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]]) {
    const relief = buildIslandContours(outline);
    assert.equal(relief.rings.length, 0); assert.equal(relief.extent.length, 0);
  }
});

test('deep hills have many angular creases and uneven slopes down to the base', () => {
  const outline = buildGardenLayout([{ id: 'a', sessionCount: 80 }]).outline;
  const relief = buildIslandContours(outline), outer = relief.rings.at(-1);
  assert.ok(relief.depth >= relief.span * .4, 'Relief must reach a deep base');
  assert.equal(outer.z, -relief.depth);
  assert.ok(relief.rings.length >= 32, 'Contours continue through the full hillside');
  assert.ok(outer.points.length >= 280 && outer.points.length <= 280 + outline.length);
  const first = relief.rings[0];
  const widths = outer.points.map((p, i) => Math.hypot(p.x - first.points[i].x, p.y - first.points[i].y));
  assert.ok(Math.max(...widths) > relief.span * .3, 'Foothills extend beyond the former narrow skirt');
  assert.ok(Math.max(...widths) / Math.min(...widths) > 2, 'Ridges and gullies have distinct slopes');
  let turningPoints = 0;
  for (let i = 0; i < widths.length; i++) {
    const previous = widths[(i + widths.length - 1) % widths.length], next = widths[(i + 1) % widths.length];
    if ((widths[i] - previous) * (next - widths[i]) < 0) turningPoints++;
  }
  assert.ok(turningPoints >= 30, `Expected many irregular creases, found ${turningPoints}`);
});

test('angular sampling stays attached when the shore vertex order changes', () => {
  const outline = buildGardenLayout([{ id: 'a' }]).outline;
  const original = buildIslandContours(outline);
  for (const changed of [outline.slice(17).concat(outline.slice(0, 17)), [...outline].reverse()]) {
    const reordered = buildIslandContours(changed);
    assert.equal(reordered.rings[0].points.length, original.rings[0].points.length);
    for (let i = 0; i < original.rings.length; i++) {
      original.rings[i].points.forEach((p, j) => {
        const q = reordered.rings[i].points[j];
        assert.ok(Math.hypot(p.x - q.x, p.y - q.y) < 1e-7, 'Ridges must not rotate or jump with vertex ordering');
      });
    }
  }
});

test('dashed terrace styling preserves geometry and contour hierarchy', () => {
  const geometry = buildIslandContours(buildGardenLayout([{ id: 'a' }]).outline), before = JSON.stringify(geometry);
  const calls = [], ctx = { save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, fill() {} };
  context.drawIslandContours(ctx, geometry, (x, y, z) => ({ x, y: y - z }), {
    drawContour(target, points, options) { calls.push({ points, options }); }
  });
  assert.equal(calls.length, 40);
  assert.ok(calls.every(call => call.options.closed));
  assert.equal(calls.filter(call => call.options.width === 1).length, 5);
  assert.equal(new Set(calls.map(call => call.options.id)).size, 40);
  assert.ok(calls.every(call => call.options.zoom === 1 && call.options.origin.x === 0));
  assert.equal(JSON.stringify(geometry), before);
});


test('contour cache reuses equal content and keeps four recently used outlines', () => {
  const cache = createIslandContourCache();
  const outline = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const copy = shift => outline.map(p => ({ x: p.x + shift, y: p.y }));
  const first = cache(outline);
  assert.equal(cache(copy(0)), first);
  assert.equal(cache(copy(.01)), first, 'quarter-unit quantization ignores tiny noise');
  assert.notEqual(cache(copy(1)), first);
  cache(copy(2)); cache(copy(3));
  assert.equal(cache(copy(0)), first, 'hits refresh LRU order');
  cache(copy(4));
  assert.equal(cache(copy(0)), first);
  cache(copy(5)); cache(copy(6)); cache(copy(7)); cache(copy(8));
  assert.notEqual(cache(copy(0)), first, 'least recent geometry is evicted');
  const changed = copy(0), before = cache(changed); changed[1].x += 1;
  assert.notEqual(cache(changed), before, 'in-place edits also invalidate geometry');
});


test('island draw passes fade locally and ignore old shared solid and alpha fields', () => {
  const local = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../web/garden-island-contours.js'), 'utf8').replace(/export /g, ''), local);
  const geometry = { rings: [{ z: 0, major: false, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }] }] };
  for (const [devicePeriod, t] of [[2, 0], [3, 0], [4.5, .5], [6, 1], [8, 1], [3.01, .00003325925925925784]]) {
    local.SpecimenEnvironment = { contourDashStyle: () => ({ period: devicePeriod / 2, phase: .7, solid: true, alpha: .123 }) };
    for (const baseAlpha of [.8, .005]) for (const callback of [false, true]) {
      const strokes = [], fills = [], passes = [];
      const ctx = { globalAlpha: baseAlpha, save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
        getTransform: () => ({ a: 2 }), setLineDash() {},
        fill() { fills.push(this.globalAlpha); }, stroke() { strokes.push(this.globalAlpha); } };
      local.drawIslandContours(ctx, geometry, (x, y) => ({ x, y }), {
        drawContour: callback ? (target, points, options) => { strokes.push(target.globalAlpha); passes.push(options); } : null
      });
      const expected = [baseAlpha * t, baseAlpha * Math.max(.32, Math.min(.75, devicePeriod / 4)) * (1 - t)].filter(a => a >= .01);
      assert.equal(strokes.length, expected.length);
      strokes.forEach((a, i) => assert.ok(Math.abs(a - expected[i]) < 1e-10));
      assert.deepEqual(fills, [baseAlpha]);
      if (callback) assert.ok(passes.every(pass => pass.period === devicePeriod / 2 && pass.phase === .7));
    }
  }
});

test('island shared contour painter receives explicit passes without fading twice', () => {
  const local = vm.createContext({});
  for (const file of ['specimen-environment.js', 'garden-island-contours.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../web', file), 'utf8').replace(/export /g, ''), local);
  }
  const geometry = { rings: [{ z: 0, major: false, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }] }] };
  const style = local.SpecimenEnvironment.contourDashStyle('island/0', 1, 1);
  const zoom = 4.5 / style.period, strokes = [], stack = [];
  const ctx = { globalAlpha: .8, save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, fill() {}, stroke() { strokes.push(this.globalAlpha); } };
  local.drawIslandContours(ctx, geometry, (x, y) => ({ x: x * zoom, y: y * zoom }));
  assert.equal(strokes.length, 2);
  assert.ok(Math.abs(strokes[0] - .4) < 1e-10);
  assert.ok(Math.abs(strokes[1] - .3) < 1e-10);
  assert.equal(ctx.globalAlpha, .8);
});

test('height labels stay pinned to fixed world anchors through orbit, pan and zoom', () => {
  const outline = buildGardenLayout([{ id: 'a', sessionCount: 50 }]).outline;
  const geometry = buildIslandContours(outline);
  const anchors = context.islandLabelAnchors(geometry);
  assert.equal(anchors.length, 5);
  assert.equal(context.islandLabelAnchors(geometry), anchors, 'anchors are cached per geometry');
  const before = JSON.stringify(anchors.map(a => [a.ring, a.vertex, a.point]));
  const ctx = { save() {}, restore() {}, translate() {}, rotate() {}, fillRect() {}, fillText() {},
    measureText: t => ({ width: t.length * 6 }) };
  const cx = geometry.center.x, cy = geometry.center.y;
  const run = (yaw, zoom, panX) => context.drawIslandSurvey(ctx, geometry, outline, (x, y, z) => {
    const dx = x - cx, dy = y - cy, c = Math.cos(yaw), s = Math.sin(yaw);
    return { x: 600 + panX + (dx * c - dy * s) * zoom, y: 400 + ((dx * s + dy * c) * .6 - z) * zoom };
  }, { width: 1200, height: 800 });
  const seen = new Set();
  for (let yaw = 0; yaw < Math.PI * 2; yaw += .1) for (const zoom of [.14, .2, .3]) for (const panX of [-80, 0, 80]) {
    for (const l of run(yaw, zoom, panX).placed) {
      const a = anchors.find(q => q.ring === l.ring);
      assert.ok(a && a.vertex === l.vertex, 'label rides its fixed vertex');
      seen.add(l.ring);
    }
  }
  assert.ok(seen.size >= 2, 'labels are visible at some orbit angles');
  assert.equal(JSON.stringify(anchors.map(a => [a.ring, a.vertex, a.point])), before);
});

test('labelled ring set is stable across small zoom changes', () => {
  const outline = buildGardenLayout([{ id: 'a', sessionCount: 50 }]).outline;
  const geometry = buildIslandContours(outline);
  const ctx = { save() {}, restore() {}, translate() {}, rotate() {}, fillRect() {}, fillText() {},
    measureText: t => ({ width: t.length * 6 }) };
  const at = zoom => context.drawIslandSurvey(ctx, geometry, outline,
    (x, y, z) => ({ x: 2000 + (x - geometry.center.x) * zoom, y: 1500 + ((y - geometry.center.y) * .6 - z) * zoom }),
    { width: 4000, height: 3000 }).placed.map(l => l.ring).join();
  const base = at(.2);
  assert.ok(base.length > 0);
  for (let z = .19; z <= .21; z += .001) assert.equal(at(z), base);
});
