const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

async function load(name) {
  const source = fs.readFileSync(path.join(__dirname, '../../web', name), 'utf8');
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

const projects = [
  { id: 'dense', birth: 0, work: 72, sessionCount: 80 },
  { id: 'medium', birth: 1, work: 24, sessionCount: 35 },
  { id: 'small', birth: 2, work: 6, sessionCount: 12 },
];
const ids = Array.from({ length: 80 }, (_, i) => 'tree-' + String(i).padStart(3, '0'));

function distances(points) {
  const nearest = points.map((p, i) => Math.min(...points.filter((_, j) => j !== i)
    .map(q => Math.hypot(q.x - p.x, q.y - p.y)))).sort((a, b) => a - b);
  return { minimum: nearest[0], median: (nearest[39] + nearest[40]) / 2 };
}

function close(actual, expected, label) {
  assert.ok(Math.abs(actual / expected - 1) < 1e-6, `${label}: ${actual} != ${expected}`);
}

test('spacing grows each lot area and both nearest-tree distances without changing the factor-one layout', async () => {
  const [{ buildGardenLayout, TREE_SPACING }, { plantTrees, pointInPolygon }] = await Promise.all([
    load('garden-layout.js'), load('tree-placement.js'),
  ]);
  const measure = spacing => {
    const layout = buildGardenLayout(projects, { seed: 'spacing-fixture', spacing });
    const lot = layout.plots.find(p => p.id === 'dense');
    const planting = plantTrees(ids, lot.polygon, {
      seed: 'spacing-fixture/dense', edgeInset: Math.min(18 * spacing, Math.sqrt(lot.area / ids.length) * .15),
    });
    assert.ok(planting.points.every(p => pointInPolygon(p, lot.polygon)));
    return { layout, lot, planting, ...distances(planting.points) };
  };
  const baseline = measure(1), grown = measure(TREE_SPACING);
  assert.ok(Number.isFinite(TREE_SPACING) && TREE_SPACING > 1, 'spacing factor enlarges the world');
  const unscaledWeight = baseline.layout.plots.reduce((sum, plot) => sum + plot.weight, 0);
  assert.ok(unscaledWeight > baseline.layout.area * 0.99, 'fixture exceeds the minimum world area');
  close(baseline.layout.area, unscaledWeight, 'factor-one world area uses current lot weights');
  close(baseline.lot.targetArea, baseline.lot.weight, 'factor-one dense lot target area');
  assert.ok(Math.abs(baseline.lot.area - baseline.lot.targetArea) / baseline.lot.targetArea
    <= baseline.layout.fitting.tolerance, 'factor-one dense lot fits its target area');
  close(grown.layout.area, baseline.layout.area * TREE_SPACING ** 2, 'world area');
  for (const lot of baseline.layout.plots) {
    close(grown.layout.plots.find(p => p.id === lot.id).area, lot.area * TREE_SPACING ** 2, `${lot.id} area`);
  }
  assert.ok(baseline.minimum > 0 && baseline.median >= baseline.minimum, 'factor-one distances are valid');
  close(grown.minimum, baseline.minimum * TREE_SPACING, 'minimum distance');
  close(grown.median, baseline.median * TREE_SPACING, 'median distance');
  assert.deepEqual(measure(TREE_SPACING).planting, grown.planting, 'planting is deterministic');
  assert.deepEqual(buildGardenLayout(projects, { seed: 'spacing-fixture' }), grown.layout, 'default uses spacing factor');
});
