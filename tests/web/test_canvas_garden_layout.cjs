const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before } = require('node:test');

let buildGardenLayout, TREE_SPACING;
before(async () => {
  // Load the browser ES module without imposing a package type on the Python repo.
  const source = fs.readFileSync(path.join(__dirname, '../../web/garden-layout.js'), 'utf8');
  ({ buildGardenLayout, TREE_SPACING } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')));
});

function projects(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: 'repo-' + String(index).padStart(4, '0'), birth: index,
    work: (index % 17) * 6, sessionCount: 1 + index % 11,
  }));
}

function signedArea(polygon) {
  return polygon.reduce((sum, a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    return sum + a.x * b.y - b.x * a.y;
  }, 0) / 2;
}

function insideConvex(point, polygon, epsilon = 1e-6) {
  return polygon.every((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x) >= -epsilon;
  });
}

function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

// The shore is jagged (non-convex), so containment is a polygon test that
// accepts points on the boundary.
function insideOutline(point, polygon, tolerance) {
  let inside = false;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    if (segmentDistance(point, a, b) <= tolerance) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// A parcel clipped by a non-convex shore is disconnected exactly when its ring
// pinches into a zero-width bridge, so a vertex touches a non-adjacent edge.
function pinched(polygon, tolerance) {
  return polygon.some((p, i) => polygon.some((a, j) => {
    const b = polygon[(j + 1) % polygon.length];
    if (j === i || (j + 1) % polygon.length === i) return false;
    return segmentDistance(p, a, b) <= tolerance && Math.hypot(p.x - a.x, p.y - a.y) > tolerance
      && Math.hypot(p.x - b.x, p.y - b.y) > tolerance;
  }));
}

function overlapInterior(a, b) {
  // Separating-axis test permits shared edges but rejects overlapping interiors.
  for (const polygon of [a, b]) {
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i], q = polygon[(i + 1) % polygon.length];
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      if (length < 1e-8) continue;
      const nx = (q.y - p.y) / length, ny = (p.x - q.x) / length;
      const left = a.map(v => v.x * nx + v.y * ny), right = b.map(v => v.x * nx + v.y * ny);
      if (Math.min(Math.max(...left), Math.max(...right)) - Math.max(Math.min(...left), Math.min(...right)) <= 1e-6) return false;
    }
  }
  return true;
}

function verifyGeometry(layout) {
  const epsilon = 1e-6;
  assert.ok(layout.outline.length >= 64, 'the boundary has many jagged vertices');
  assert.ok(signedArea(layout.outline) > 0, 'the outline is counterclockwise');
  assert.ok(Math.abs(signedArea(layout.outline) - layout.area) < epsilon * layout.area);
  for (const plot of layout.plots) {
    for (const name of ['x', 'y', 'w', 'h', 'area', 'targetArea', 'power']) assert.ok(Number.isFinite(plot[name]), name);
    assert.ok(plot.polygon.length >= 3);
    assert.ok(plot.w > 0 && plot.h > 0);
    assert.ok(plot.area > 0);
    assert.ok(Math.abs(signedArea(plot.polygon) - plot.area) < epsilon * plot.area);
    assert.equal(pinched(plot.polygon, layout.area ** .5 * 1e-6), false, `${plot.id} stays one connected parcel`);
    assert.ok(insideOutline(plot.centroid, plot.polygon, 1e-6), 'the centroid belongs to its cell');
    assert.ok(Math.abs(plot.area - plot.targetArea) / plot.targetArea <= layout.fitting.tolerance,
      `${plot.id} meets the explicit area tolerance`);
    for (const vertex of plot.polygon) {
      assert.ok(insideOutline(vertex, layout.outline, layout.area ** .5 * 1e-6), 'cells stay inside the shore');
      assert.ok(vertex.x >= plot.x - epsilon && vertex.x <= plot.x + plot.w + epsilon);
      assert.ok(vertex.y >= plot.y - epsilon && vertex.y <= plot.y + plot.h + epsilon);
      const ownerDistance = (vertex.x - plot.site.x) ** 2 + (vertex.y - plot.site.y) ** 2 - plot.power;
      for (const other of layout.plots) {
        const distance = (vertex.x - other.site.x) ** 2 + (vertex.y - other.site.y) ** 2 - other.power;
        assert.ok(ownerDistance <= distance + layout.area * 1e-8, 'every vertex belongs to its true power cell');
      }
    }
  }
  for (let index = 0; index < layout.plots.length; index++) {
    const a = layout.plots[index];
    for (const b of layout.plots.slice(index + 1)) {
      if (a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y) continue;
      assert.equal(overlapInterior(a.polygon, b.polygon), false, `${a.id} overlaps ${b.id}`);
    }
  }
  const sum = layout.plots.reduce((area, plot) => area + plot.area, 0);
  assert.ok(Math.abs(sum - layout.area) < epsilon * layout.area, 'nonoverlapping cells cover the entire outline');
}

// Before replacement, executing the real preparePages function with 116 distinct
// project fixtures produced 6 visible lots, 6 sessions, and 20 pages. This test
// guards the replacement geometry seam, rather than matching old source strings.
test('all project lots persist as the world grows from 3 to 12 to 116 to 200', () => {
  let previous = { bounds: { w: 0, h: 0 }, plots: [], area: 0 };
  for (const count of [3, 12, 116, 200]) {
    const input = projects(count);
    const layout = buildGardenLayout(input);
    const ids = new Set(layout.plots.map(plot => plot.id));
    assert.equal(layout.plots.length, count);
    assert.deepEqual([...ids], input.map(project => project.id));
    for (const plot of previous.plots) assert.ok(ids.has(plot.id));
    assert.ok(layout.area >= previous.area);
    assert.ok(layout.bounds.w >= previous.bounds.w);
    assert.ok(layout.bounds.h >= previous.bounds.h);
    verifyGeometry(layout);
    previous = layout;
  }
});

test('growing work and session counts expands both world dimensions', () => {
  const input = projects(116);
  const initial = buildGardenLayout(input);
  const moreWork = buildGardenLayout(input.map(project => ({ ...project, work: project.work + 1000 })));
  const moreTrees = buildGardenLayout(input.map(project => ({ ...project, sessionCount: project.sessionCount + 10 })));
  for (const expanded of [moreWork, moreTrees]) {
    assert.ok(expanded.area > initial.area);
    assert.ok(expanded.bounds.w > initial.bounds.w);
    assert.ok(expanded.bounds.h > initial.bounds.h);
    verifyGeometry(expanded);
  }
});

test('seeded geometry is identical after shuffling input and changing recency fields', () => {
  const input = projects(116);
  const shuffled = [...input.slice(33), ...input.slice(0, 33)].reverse().map(project => ({
    ...project, updatedAt: '2099-12-31', latestActivity: Math.random(),
  }));
  assert.deepEqual(buildGardenLayout(input), buildGardenLayout(shuffled));
  assert.deepEqual(buildGardenLayout(input), buildGardenLayout(input));
  assert.notDeepEqual(buildGardenLayout(input, { seed: 'another-seed' }).bounds, buildGardenLayout(input).bounds);
});

test('future projects cannot change a historical garden', () => {
  const input = projects(200);
  for (const day of [0, 2, 11, 60, 115]) {
    const prefix = input.filter(project => project.birth <= day);
    const future = input.map(project => project.birth > day ? { ...project, work: 1000000, sessionCount: 10000 } : project);
    assert.deepEqual(buildGardenLayout(future, { day }), buildGardenLayout(prefix, { day }));
  }
});

test('a born project without primary trees retains its own lot', () => {
  const layout = buildGardenLayout([
    { id: 'child-only', birth: 2, work: 20, sessionCount: 0 },
    { id: 'future', birth: 4, work: 100, sessionCount: 3 },
  ], { day: 2 });
  assert.deepEqual(layout.plots.map(plot => plot.id), ['child-only']);
  assert.equal(layout.plots[0].sessionCount, 0);
  verifyGeometry(layout);
});

test('empty dates and malformed identity have explicit results', () => {
  assert.deepEqual(buildGardenLayout(projects(3), { day: -1 }), {
    bounds: { x: 0, y: 0, w: 0, h: 0 }, outline: [], plots: [], area: 0,
  });
  assert.throws(() => buildGardenLayout([{ id: 'same' }, { id: 'same' }]), /Duplicate/);
  assert.throws(() => buildGardenLayout([{ id: 'unknown-birth', birth: NaN }]), /birth/);
});


test('large projects share an organic shore with every small project', () => {
  const input = projects(116).map((p, i) => ({ ...p, birth: 0, sessionCount: [123, 99, 93][i] ?? i % 3 }));
  const layout = buildGardenLayout(input);
  const unscaled = buildGardenLayout(input, { spacing: 1 });
  verifyGeometry(layout);
  assert.ok(layout.plots.some(p => p.polygon.length > 4), 'cells have natural multi-sided boundaries');
  assert.ok(layout.area < layout.bounds.w * layout.bounds.h * .9, 'the outer shape is not a disguised rectangle');
  const unscaledWeight = unscaled.plots.reduce((sum, plot) => sum + plot.weight, 0);
  assert.ok(unscaledWeight > unscaled.area * .99, 'fixture exceeds the minimum world area');
  assert.ok(Math.abs(unscaled.area - unscaledWeight) < 1e-6, 'factor one uses the current lot weights');
  assert.ok(Math.abs(layout.area - unscaled.area * TREE_SPACING ** 2) < 1e-6,
    'world capacity scales the unscaled recorded-work formula');
  for (const lot of unscaled.plots) {
    const scaled = layout.plots.find(plot => plot.id === lot.id);
    assert.ok(Math.abs(scaled.area - lot.area * TREE_SPACING ** 2) < lot.area * 1e-6,
      `${lot.id} area scales with spacing squared`);
  }
});

test('power fitting preserves tiny cells beside an extreme workload', () => {
  const input = Array.from({ length: 116 }, (_, i) => ({ id: 'extreme-' + i, sessionCount: i ? 0 : 500 }));
  // ~4x the busiest real project (123 sessions). The jagged shore stays fitted and connected at this
  // scale; far beyond it (>~1000 sessions beside 115 empty lots) thin slivers can pinch or miss tolerance.
  const layout = buildGardenLayout(input);
  assert.equal(layout.plots.length, input.length);
  verifyGeometry(layout);
});

test('synthetic distribution keeps every project cell', () => {
  const input = Array.from({ length: 37 }, (_, i) => ({
    id: `synthetic-plot-${i}`, sessionCount: i === 0 ? 120 : (i * 7) % 19,
  }));
  const layout = buildGardenLayout(input);
  assert.equal(layout.plots.length, input.length);
  verifyGeometry(layout);
  for (const seed of ['a', 'b', 'c']) verifyGeometry(buildGardenLayout(input, { seed }));
});

test('the outer shore is jagged, deterministic, and much larger than the old island', () => {
  const input = projects(116);
  const layout = buildGardenLayout(input);
  const outline = layout.outline;
  verifyGeometry(layout);
  let sharp = 0, reflex = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[(i + outline.length - 1) % outline.length], b = outline[i], c = outline[(i + 1) % outline.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const turn = Math.abs(Math.atan2(cross, (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)));
    if (turn > .35) sharp++;
    if (cross < 0) reflex++;
  }
  assert.ok(sharp >= outline.length * .3, `many sharp corners (${sharp}/${outline.length})`);
  assert.ok(reflex >= outline.length * .15, 'the coastline has inward bays, not a convex blob');
  assert.deepEqual(buildGardenLayout(input).outline, outline);
  assert.notDeepEqual(buildGardenLayout(input, { seed: 'other-shore' }).outline, outline);
  // Old constants: 105k base, 8.9k per session, 2.8k per work log, 350k floor.
  const oldWeight = input.reduce((sum, p) => sum + 105_000 + 8_900 * p.sessionCount + 2_800 * Math.log1p(p.work), 0);
  assert.ok(layout.area > 2 * Math.max(350_000, oldWeight) * TREE_SPACING ** 2, 'the island is far larger than before');
});

test('every seed keeps real-scale lots connected inside a jagged shore', () => {
  const input = projects(77).map((p, i) => ({ ...p, sessionCount: i % 9 === 0 ? 40 : i % 5 }));
  for (const seed of ['483765r937n', 'a', 'b', 'c', 'd', 'e']) verifyGeometry(buildGardenLayout(input, { seed }));
});
