const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const load = file => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync('web/' + file, 'utf8')).toString('base64'));

test('range includes boundary days, sorts reverse drags, clamps, and clears', async () => {
  const { normalizeTimeRange, sessionInTimeRange } = await load('garden-timeline-brush.js');
  const range = normalizeTimeRange(7, 3, 10);
  assert.deepEqual(range, { start: 3, end: 7 });
  assert.deepEqual(normalizeTimeRange(-4, 90, 10), { start: 0, end: 10 });
  assert.deepEqual(normalizeTimeRange(3, 3, 0), { start: 0, end: 0 });
  assert.deepEqual([2, 3, 5, 7, 8].filter(birth => sessionInTimeRange({ birth }, range)), [3, 5, 7]);
  assert.equal(sessionInTimeRange({ birth: 2 }, null), true);
  assert.equal(sessionInTimeRange({ birth: 3 }, { start: 3, end: 3 }), true);
});

test('pointer brush, cancellation, keyboard handles, and reset deliver ranges', async () => {
  const module = await load('garden-timeline-brush.js');
  const callbacks = new Map(); let nextFrame = 0;
  const previousRAF = global.requestAnimationFrame, previousCancel = global.cancelAnimationFrame;
  global.requestAnimationFrame = fn => { callbacks.set(++nextFrame, fn); return nextFrame; };
  global.cancelAnimationFrame = id => callbacks.delete(id);
  try {
    const node = () => ({ style: {}, dataset: {}, events: {}, attrs: {}, hidden: false,
      addEventListener(type, fn) { this.events[type] = fn; },
      setAttribute(key, value) { this.attrs[key] = value; }, closest() { return null; } });
    const element = node(), selection = node(), clearButton = node(), summary = node();
    const handles = ['start', 'end'].map(bound => Object.assign(node(), { dataset: { bound } }));
    element.querySelector = () => selection; element.querySelectorAll = () => handles;
    element.getBoundingClientRect = () => ({ left: 0, width: 116 });
    element.setPointerCapture = id => { element.capture = id; };
    element.hasPointerCapture = id => element.capture === id;
    element.releasePointerCapture = () => { element.capture = null; };
    const changes = [], brush = module.createTimelineBrush({ element, clearButton, summary, maxDay: () => 10, dateText: String, onChange: range => changes.push(range) });
    const event = (type, day) => ({ type, clientX: 8 + day * 10, pointerId: 1, button: 0, target: element, preventDefault() {} });
    const flush = () => { for (const [id, fn] of [...callbacks]) { callbacks.delete(id); fn(); } };
    brush.render();
    assert.equal(handles[0].hidden, false);
    element.events.pointerdown(event('pointerdown', 7));
    element.events.pointermove(event('pointermove', 3));
    element.events.pointerup(event('pointerup', 3));
    assert.deepEqual(changes.at(-1), { start: 3, end: 7 });
    assert.equal(handles[0].attrs['aria-valuenow'], '3');
    element.events.pointerdown(event('pointerdown', 1));
    element.events.pointercancel(event('pointercancel', 1));
    assert.deepEqual(changes.at(-1), { start: 3, end: 7 });
    handles[0].events.keydown({ key: 'ArrowRight', preventDefault() {} }); flush();
    assert.deepEqual(changes.at(-1), { start: 4, end: 7 });
    handles[1].events.keydown({ key: 'Home', preventDefault() {} }); flush();
    assert.deepEqual(changes.at(-1), { start: 4, end: 4 });
    clearButton.events.click(); flush();
    assert.equal(changes.at(-1), null); assert.equal(selection.hidden, true);
    element.events.pointerdown(event('pointerdown', 2)); brush.clear(); flush();
    assert.equal(changes.at(-1), null, 'reset cancels pending filter updates');
  } finally { global.requestAnimationFrame = previousRAF; global.cancelAnimationFrame = previousCancel; }
});

test('rendered roots filter without changing layout positions and restore on clear', async () => {
  const { sessionInTimeRange } = await load('garden-timeline-brush.js');
  const source = fs.readFileSync('web/canvas-garden.js', 'utf8');
  const start = source.indexOf('function displayedTrees('), end = source.indexOf('\nfunction ', start + 1);
  const treePlacements = [1, 4, 8].map(birth => ({ s: { id: String(birth), birth }, x: birth * 10, y: 20 }));
  const context = vm.createContext({ spawnHold: { size: 0, has: () => false }, treePlacements, displayScene: null, timeRange: { start: 3, end: 6 }, sessionInTimeRange });
  vm.runInContext(source.slice(start, end), context);
  assert.deepEqual(vm.runInContext('displayedTrees()', context), [treePlacements[1]]);
  context.displayScene = { trees: treePlacements };
  context.timeRange = { start: 5, end: 6 };
  assert.equal(vm.runInContext('displayedTrees().length', context), 0);
  context.timeRange = null;
  assert.deepEqual(vm.runInContext('displayedTrees()', context), treePlacements);
});

