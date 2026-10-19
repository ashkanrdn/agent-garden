const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('web/canvas-garden.js', 'utf8');
const start = source.indexOf('function selectDetailedTreeIds(');
const end = source.indexOf('\nfunction rebuild(', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
const select = (trees, options) => vm.runInContext('selectDetailedTreeIds(trees, options)',
  vm.createContext({ trees, options, selectDetailedTreeIds: context.selectDetailedTreeIds }));

test('wide dense views retain proxies until close enough; proxy off promotes all', () => {
  const trees = Array.from({ length: 696 }, (_, i) => ({ s: { id: `session-${i}` }, plotId: `plot-${i % 20}`, distance: i }));
  const options = { proxyView: true, zoomed: false, hoverSession: null, selectedId: 'session-12', focusedProject: null };
  const condensed = select(trees, options);
  assert.equal(condensed.size, 1);
  const zoomed = select(trees, { ...options, zoomed: true });
  assert.equal(zoomed.size, 1);
  const full = select(trees, { ...options, proxyView: false });
  assert.equal(full.size, trees.length);
  assert.ok(trees.every(tree => full.has(tree.s.id)));
});

test('proxy mode leaves selected and focused trees detailed at overview scale', () => {
  const trees = Array.from({ length: 60 }, (_, i) => ({ s: { id: `session-${i}` }, plotId: i % 2 ? 'focused' : 'other', distance: i }));
  const detailed = select(trees, { proxyView: true, zoomed: false,
    hoverSession: 'session-0', selectedId: 'session-2', focusedProject: 'focused' });
  assert.ok(detailed.has('session-0'));
  assert.ok(detailed.has('session-2'));
  assert.ok(detailed.has('session-59'));
  assert.equal(detailed.size, 32);
});

 test('a detailed viewport tree requests the real canopy even when proxy mode is enabled', () => {
  const start = source.indexOf('function drawTree('), end = source.indexOf('\n', start);
  let fullDetail;
  const ctx = vm.createContext({ activeCameraMove: () => null, proxyView: true,
    botanical: { tree: (c, s, origin, growth, full) => { fullDetail = full; return { bounds: {} }; } },
    anchorsOnScreen: new Map(), hitBounds: new Map() });
  vm.runInContext(source.slice(start, end), ctx);
  ctx.drawTree({}, { id: 'visible-tree' }, 0, 0, null, { x: 100, y: 100 });
  assert.equal(fullDetail, true);
 });

test('zoomed viewport with fewer than 30 trees promotes every visible tree', () => {
  for (const count of [0, 1, 29]) {
    const trees = Array.from({ length: count }, (_, i) => ({ s: { id: `visible-${i}` }, distance: i }));
    const detailed = select(trees, { proxyView: true, zoomed: true });
    assert.equal(detailed.size, count);
    assert.ok(trees.every(tree => detailed.has(tree.s.id)));
  }
});

test('dense close views render every tree, independent of distance ordering', () => {
  const trees = Array.from({ length: 80 }, (_, i) => ({ s: { id: `close-${i}` }, screenHeight: 180, distance: i }));
  const detailed = select(trees, { proxyView: true, zoomed: true });
  assert.equal(detailed.size, 80);
});

test('detail switches for the whole viewport at the projected size threshold', () => {
  const trees = Array.from({ length: 80 }, (_, i) => ({ s: { id: `tree-${i}` }, screenHeight: 63, distance: i }));
  assert.equal(select(trees, { proxyView: true, zoomed: true }).size, 0);
  for (const tree of trees) tree.screenHeight = 64;
  assert.equal(select(trees, { proxyView: true, zoomed: false }).size, 80);
  trees.reverse();
  assert.equal(select(trees, { proxyView: true, zoomed: true }).size, 80);
});

test('specimen viewport sizing uses the real height and unwraps proxy bounds',()=>{
 assert.match(source,/screenHeight:measured.actualHeight/);
 assert.doesNotMatch(source,/screenHeight:bounds.h\/2/);
 assert.match(source,/botanical.symbolBounds\(t.s,t.screen,scale\).bounds/);
 assert.match(source,/const botanical=createGardenSpecimenRenderer/);
});
