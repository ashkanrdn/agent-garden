const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test, before } = require('node:test');
let createTreeGrowth;
before(async () => {
  const source = fs.readFileSync('web/tree-growth.js', 'utf8');
  ({ createTreeGrowth } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')));
});
const tree = (score = 3) => [{ id: 'session-a', score }];

test('a new tree rises from its root before branches and leaves unfold', () => {
  const growth = createTreeGrowth(); growth.sync(tree(), 0);
  const seed = growth.sample('session-a', 0);
  const stem = growth.sample('session-a', 250);
  const leaves = growth.sample('session-a', 800);
  assert.equal(seed.trunk, 0); assert.equal(seed.crown, 0);
  assert.ok(stem.trunk > 0 && stem.trunk > stem.branches);
  assert.equal(stem.crown, 0);
  assert.ok(leaves.crown > 0 && leaves.crown < leaves.trunk);
  assert.deepEqual(growth.sample('session-a', 1200), { trunk: 1, branches: 1, crown: 1, size: 1, active: false });
});

test('daily updates do not restart an emerging tree', () => {
  const growth = createTreeGrowth(); growth.sync(tree(), 0);
  const before = growth.sample('session-a', 350);
  growth.sync(tree(5), 350);
  const after = growth.sample('session-a', 350);
  assert.equal(after.trunk, before.trunk);
  assert.equal(after.crown, before.crown);
  assert.ok(after.size < 1);
  assert.equal(growth.sample('session-a', 1200).active, false);
});

test('recorded work growth retargets continuously without replaying birth', () => {
  const growth = createTreeGrowth(); growth.sync(tree(1), 0, { animate: false });
  growth.sync(tree(3), 1000);
  const mid = growth.sample('session-a', 1160);
  growth.sync(tree(5), 1160);
  const retarget = growth.sample('session-a', 1160);
  const size = score => Math.max(.23, Math.min(1.3, .24 + score / 7));
  assert.ok(Math.abs(mid.size * size(3) - retarget.size * size(5)) < 1e-10);
  assert.equal(retarget.trunk, 1); assert.equal(retarget.crown, 1);
  assert.equal(growth.sample('session-a', 1600).size, 1);
});

test('rewinding removes future trees and lets them emerge on the next replay', () => {
  const growth = createTreeGrowth(); growth.sync(tree(), 0, { animate: false });
  growth.sync([], 100, { reset: true }); growth.sync(tree(), 200);
  assert.equal(growth.sample('session-a', 200).trunk, 0);
});

test('reduced motion and Motion off show the complete historical state', () => {
  const growth = createTreeGrowth(); growth.sync(tree(), 0);
  assert.equal(growth.sample('session-a', 100, false).active, false);
  growth.settle();
  assert.deepEqual(growth.sample('session-a', 100), { trunk: 1, branches: 1, crown: 1, size: 1, active: false });
  growth.sync(tree(7), 200, { animate: false });
  assert.equal(growth.sample('session-a', 200).active, false);
});

test('completed fast weather settles only its own tree', () => {
  const growth = createTreeGrowth();
  growth.sync(Array.from({ length: 7 }, (_, i) => ({ id: `session-${i}`, score: 3 })), 0);
  assert.ok(growth.sample('session-6', 1400).crown < 1, 'late tree still has its arrival stagger');
  growth.settle(['session-6']);
  assert.equal(growth.sample('session-6', 1400).crown, 1);
  assert.equal(growth.sample('session-6', 1400).active, false);
  assert.equal(growth.sample('session-0', 300).active, true, 'other trees keep growing');
});
