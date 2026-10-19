const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { before, test } = require('node:test');
const dir = path.join(__dirname, '../../web/');
let robot, growth, layoutMotionMod, hillsMod, layoutMod, placeMod;
before(async () => {
  const load = name => import(pathToFileURL(dir + name).href);
  [robot, growth, layoutMotionMod, hillsMod, layoutMod, placeMod] = await Promise.all(
    ['garden-robot-camera.js', 'tree-growth.js', 'garden-layout-motion.js', 'garden-plot-hills.js', 'garden-layout.js', 'tree-placement.js'].map(load));
});

function scene(counts) {
  const inputs = counts.map((n, i) => ({ id: 'p' + i, birth: 0, work: n * 3, sessionCount: n }));
  const layout = layoutMod.buildGardenLayout(inputs, { day: 1, seed: 's' }), trees = [];
  for (const lot of layout.plots) {
    const ids = Array.from({ length: counts[+lot.id.slice(1)] }, (_, i) => lot.id + 's' + i);
    lot.planting = placeMod.plantTrees(ids, lot.polygon, { seed: 's/' + lot.id, edgeInset: 10 });
    lot.labelAnchor = lot.centroid;
    for (const p of lot.planting.points) trees.push({ s: { id: p.id }, x: p.x, y: p.y, plotId: lot.id });
  }
  return { layout, trees };
}

for (const [before_, after, label] of [[[3, 3], [3, 4], 'existing lot'], [[3, 3], [3, 3, 1], 'new lot']]) {
  test(`spawned tree in a ${label} first appears on the final hill surface`, () => {
    const hills = hillsMod.createPlotHills(), lm = layoutMotionMod.createLayoutMotion();
    const A = scene(before_), B = scene(after);
    lm.retarget(A.layout, A.trees, 0, { animate: false });
    const known = new Set(A.trees.map(t => t.s.id));
    const grow = growth.createTreeGrowth(), hold = growth.createSpawnHold();
    grow.sync(A.trees.map(t => ({ id: t.s.id, score: 3 })), 0, { animate: false });
    const fresh = B.trees.filter(t => !known.has(t.s.id)).map(t => t.s.id);
    grow.sync(B.trees.map(t => ({ id: t.s.id, score: 3 })), 1000, { animate: true });
    let shown = lm.retarget(B.layout, B.trees, 1000, { animate: true });
    hold.hold(fresh, lm.active);
    assert.ok(lm.active && hold.size === fresh.length, 'layout morphs, spawn is held');
    let firstVisible = null;
    for (let ms = 0; ms <= 1400 && !firstVisible; ms += 16) {
      shown = lm.sample(1000 + ms);
      const released = hold.release(lm.active);
      if (released.length) grow.restart(released, 1000 + ms);
      for (const id of fresh) {
        if (hold.has(id)) continue;
        const tree = shown.trees.find(t => t.s.id === id), plot = shown.layout.plots.find(p => p.id === tree.plotId);
        firstVisible = { id, tree, plot, ms };
      }
    }
    assert.ok(firstVisible, 'spawn became visible');
    const { tree, plot } = firstVisible, final = B.layout.plots.find(p => p.id === tree.plotId);
    const finalTree = B.trees.find(t => t.s.id === tree.s.id);
    assert.equal(lm.active, false, 'ground stopped moving before the first visible frame');
    const shownZ = 3 + (tree.lift || 0) + hills.height(plot, tree.x, tree.y);
    const surfaceZ = 3 + hills.height(final, finalTree.x, finalTree.y);
    assert.ok(Math.abs(shownZ - surfaceZ) < 1e-6, `${shownZ} vs ${surfaceZ}`);
    assert.ok(surfaceZ > 3, 'the hill actually lifts the root off flat ground');
    assert.equal(grow.sample(tree.s.id, 1000 + firstVisible.ms).trunk, 0, 'growth starts from the settled surface');
  });
}

test('spawn hold is inert without a layout morph', () => {
  const hold = growth.createSpawnHold();
  hold.hold(['a'], false);
  assert.equal(hold.size, 0);
  hold.hold(['a'], true);
  assert.deepEqual(hold.release(true), []);
  assert.deepEqual(hold.release(false), ['a']);
  assert.equal(hold.size, 0);
});

const treeAt = (x, y, w = 60, h = 200) => ({ id: `t${x}`, x, y, treeBounds: { x: -w / 2, y: -h, w, h } });
const viewport = { x: 32, y: 32, w: 1200, h: 700 };

test('a single spawn fills 60-75% of the viewport height', () => {
  for (const island of [.05, .2, .5]) {
    for (const size of [[40, 140], [60, 200], [90, 320]]) {
      const frame = robot.frameSpawnSubjects([treeAt(0, 0, ...size)], viewport, island);
      const fill = size[1] * frame.zoom / viewport.h;
      assert.ok(fill >= .6 && fill <= .75, `island ${island} size ${size}: fill ${fill}`);
      assert.ok(size[0] * frame.zoom <= viewport.w * .9 + 1e-6);
    }
  }
});

test('several concurrent spawns fit their group bounds tightly with padding', () => {
  const trees = [treeAt(0, 0), treeAt(120, 40), treeAt(-100, 60)];
  const frame = robot.frameSpawnSubjects(trees, viewport, .1);
  const w = frame.bounds.w * frame.zoom, h = frame.bounds.h * frame.zoom;
  assert.ok(w <= viewport.w * .88 + 1e-6 && h <= viewport.h * .84 + 1e-6, 'group fits with padding');
  assert.ok(w >= viewport.w * .8 || h >= viewport.h * .75, 'group is fitted tightly, not left small');
  const bounds = trees.map(t => t.treeBounds);
  assert.equal(frame.bounds.x, Math.min(...bounds.map(b => b.x)), 'weather never widens the fit');
});

test('spawn framing ignores weather bounds and keeps the soft island floor', () => {
  const weathered = { ...treeAt(0, 0), weatherBounds: { x: -400, y: -900, w: 800, h: 1000 } };
  assert.equal(robot.frameSpawnSubjects([weathered], viewport, .3).zoom, robot.frameSpawnSubjects([treeAt(0, 0)], viewport, .3).zoom);
  assert.equal(robot.frameSpawnSubjects([], viewport, .3), null);
});

test('canvas-garden wires the spawn hold and the spawn framing', () => {
  const source = require('node:fs').readFileSync(dir + 'canvas-garden.js', 'utf8');
  assert.match(source, /function displayedTrees\(\)\{[^\n]*spawnHold\.has\(t\.s\.id\)/);
  assert.equal((source.match(/spawnHold\.hold\(animate\?freshIds:\[\],layoutMotion\.active\)/g) || []).length, 2, 'live and playback spawn paths');
  assert.match(source, /treeGrowth\.restart\(released,now\)/);
  assert.match(source, /move\.kind==='dive'\?frameSpawnSubjects\(/);
});
