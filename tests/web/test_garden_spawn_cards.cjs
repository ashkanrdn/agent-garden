const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('web/garden-spawn-cards.js', 'utf8');
const ready = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const record = (id, day) => ({ id, createdAt: `2026-09-${String(day).padStart(2, '0')}T12:00:00Z`, title: `Task ${id}`, project: 'Garden', branch: 'feature/trees', model: 'recorded-model' });

test('initial history is quiet; arrivals enter newest first without duplicate upserts', async () => {
  const { createSpawnCardQueue } = await ready;
  const queue = createSpawnCardQueue();
  const old = [record('a', 1), record('b', 2)];
  assert.deepEqual(queue.sync(old).arrivals, []);
  const all = [...old, record('d', 4), record('c', 3)];
  let state = queue.sync(all);
  assert.deepEqual(state.cards.map(card => card.id), ['d', 'c', 'b', 'a']);
  assert.deepEqual(state.arrivals.map(card => card.id), ['d', 'c']);
  all[2] = { ...all[2], model: 'updated-model' };
  state = queue.sync(all);
  assert.deepEqual(state.arrivals, []);
  assert.equal(state.cards[0].model, 'updated-model');
  assert.deepEqual(state.cards.map(card => card.id), ['d', 'c', 'b', 'a']);
});

test('rewind and Latest reset the baseline; a reconnect never announces existing trees', async () => {
  const { createSpawnCardQueue } = await ready;
  const queue = createSpawnCardQueue(), a = record('a', 1), b = record('b', 2);
  queue.sync([a, b]);
  assert.deepEqual(queue.sync([a], { reset: true }).cards, [a]);
  assert.deepEqual(queue.sync([a, b]).arrivals, [b]);
  assert.deepEqual(queue.sync([a, b], { reset: true }).arrivals, []);
  const c = record('c', 3);
  assert.deepEqual(queue.sync([a, b, c], { notify: false }).arrivals, []);
  assert.deepEqual(queue.sync([a, b, c]).arrivals, []);
  assert.deepEqual(queue.sync([], { reset: true }).cards, []);
});

test('cards use actual branch and model evidence with explicit missing values', async () => {
  const { spawnCardRecord } = await ready;
  let card = spawnCardRecord({ id: 'a', model: 'saved', gitContext: { branch: 'codex/trees' } }, { name: 'Garden' }, { model: 'current' });
  assert.equal(card.project, 'Garden');
  assert.equal(card.model, 'current');
  assert.equal(card.branch, 'codex/trees');
  card = spawnCardRecord({ id: 'b' });
  assert.equal(card.branch, 'Branch unavailable');
  assert.equal(card.model, 'Model unavailable');
});

test('history integration resets on scrub and announces playback without camera or motion gates', () => {
  const app = fs.readFileSync('web/canvas-garden.js', 'utf8');
  const start = app.indexOf('function updateDay('), end = app.indexOf('\nfunction ', start + 1);
  const calls = [];
  const context = vm.createContext({
    growthDay: 1, day: 2, arrival: null, camera: {}, driftBase: null, scrubbing: false,
    hoverSession: null, hoverProject: null, hoverPath: null,
    hoverTreeId:'tree', botanical:{setHovered(){}}, performance:{now:()=>100},
    layoutMotion: { settle() {} }, treeGrowth: { settle() {} }, stopFlight() {},
    prepareWorld() {}, syncSpawnCards: options => { calls.push(options); },
    cloudArrivals: { sync() { throw new Error('stop after card integration'); } }, visibleSessions: [], motion: false,
  });
  const hoverStart=app.indexOf('function setTreeHover('),hoverEnd=app.indexOf('\nfunction ',hoverStart+1);
  vm.runInContext(app.slice(hoverStart,hoverEnd)+'\n'+app.slice(start, end), context);
  assert.throws(() => context.updateDay(), /stop after/);
  assert.equal(calls[0].reset, false);
  assert.equal(calls[0].notify, true);
  assert.throws(() => context.updateDay({ cause: 'scrub' }), /stop after/);
  assert.equal(calls[1].reset, true);
  assert.equal(calls[1].notify, false);
  context.day = 0;
  assert.throws(() => context.updateDay(), /stop after/);
  assert.equal(calls[2].reset, true);
});

function stackDOM() {
  class Node {
    get offsetHeight() { return this.children.length * 144; }
    constructor() { this.scrollTop = 0; this.children = []; this.dataset = {}; this.handlers = {}; this.attributes = {}; this.style = { setProperty() {} }; this.textContent = ''; }
    addEventListener(type, callback) { (this.handlers[type] ||= []).push(callback); }
    emit(type, event = {}) { for (const callback of this.handlers[type] || []) callback(event); }
    setAttribute(name, value) { this.attributes[name] = value; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    append(...nodes) { nodes.forEach(node => this.insertBefore(node, null)); }
    insertBefore(node, next) { node.remove(); this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, node); node.parent = this; }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  }
  const host = new Node(), list = new Node(), announcement = new Node(), context = new Node(), toggle = new Node();
  host.ownerDocument = { createElement: () => new Node() };
  host.querySelector = selector => selector === 'ol' ? list : selector === '[role="status"]' ? announcement : selector === '[data-spawn-toggle]' ? toggle : context;
  host.append(list, announcement, context, toggle);
  return { host, list, announcement, context, toggle };
}

test('reading pauses replacements, retains metadata updates, and selects the original card', async () => {
  const { createSpawnCardStack } = await ready;
  const dom = stackDOM(), selected = [];
  const stack = createSpawnCardStack({ host: dom.host, onSelect: id => selected.push(id) });
  const options = { mode: 'live', motion: true };
  const all = [record('a', 1), record('b', 2), record('c', 3)];
  stack.sync(all, options);
  const original = dom.list.children[0];
  dom.host.emit('pointerenter');
  all.push(record('d', 4));
  stack.sync(all, options);
  all[3] = { ...all[3], model: 'updated-model' };
  stack.sync(all, options);
  assert.equal(dom.list.children[0], original, 'the card stays under the pointer');
  original.children[0].emit('click');
  assert.deepEqual(selected, ['c']);
  dom.host.emit('pointerleave');
  assert.deepEqual(dom.list.children.map(node => node.dataset.session), ['d', 'c', 'b', 'a']);
  assert.equal(dom.list.children[1], original, 'retained cards keep their nodes during insertion');
  assert.match(dom.announcement.textContent, /New tree/);
  assert.equal(dom.list.children[0].children[0].children[3].children[1].textContent, 'updated-model');
  dom.host.emit('focusin');
  all.push(record('e', 5));
  stack.sync(all, options);
  dom.host.emit('focusout', { relatedTarget: original.children[0] });
  assert.equal(dom.list.children[0].dataset.session, 'd', 'focus inside the stack keeps it still');
  dom.host.emit('focusout', { relatedTarget: null });
  assert.equal(dom.list.children[0].dataset.session, 'e');
});

test('motion off preserves arrivals; scrubbing resets without movement or announcements', async () => {
  const { createSpawnCardStack } = await ready;
  const dom = stackDOM(), stack = createSpawnCardStack({ host: dom.host, onSelect() {} });
  const a = record('a', 1), b = record('b', 2);
  stack.sync([a], { mode: 'history', motion: true });
  assert.equal(dom.host.dataset.motion, 'false');
  stack.sync([a, b], { mode: 'history', motion: false });
  assert.equal(dom.host.dataset.motion, 'false');
  assert.equal(dom.list.children[0].dataset.session, 'b');
  assert.match(dom.announcement.textContent, /New tree/);
  stack.sync([a], { mode: 'history', reset: true, motion: true });
  assert.equal(dom.host.dataset.motion, 'false');
  assert.equal(dom.announcement.textContent, '');
  stack.sync([a, b], { mode: 'live', motion: true });
  assert.equal(dom.context.textContent, 'Live');
  assert.equal(dom.announcement.textContent, '');
});

test('live upserts announce arrivals with motion off; snapshots and model updates stay quiet', () => {
  const app = fs.readFileSync('web/canvas-garden.js', 'utf8');
  const extract = name => {
    const start = app.indexOf(`function ${name}(`), end = app.indexOf('\nfunction ', start + 1);
    return app.slice(start, end);
  };
  const calls = [], raw = { id: 'new', projectId: 'garden' };
  const context = vm.createContext({
    sourceData: { sessions: [], projects: [] }, allSessions: [], sessions: [], visibleSessions: [], selected: null,
    liveState: { snapshot: () => ({ sessions: [raw], projects: [] }) }, liveMode: true,
    motion: false, motionPreference: { matches: true }, document: { hidden: false }, maxDay: 2,
    playback: { pause() {} }, performance: { now: () => 0 },
    deriveGardenRecords(data) { context.sessions = data.sessions; },
    prepareWorld() { context.visibleSessions = context.sessions; },
    cloudArrivals:{sync(){}},spawnHold:{size:0,has:()=>false,hold(){},release:()=>[]},treeGrowth:{has:()=>true,restart(){},sync() {}, settle() {} }, buildWorldScene() {}, gardenLayout: {}, treePlacements: [],
    layoutMotion: { retarget() {} }, modelCache: { clear() {} }, botanical: { clear() {} },
    rebuild() {}, updateCard() {}, updateMap() {}, drawArcs() {}, renderProjectSelect() {}, syncPlaybackControls() {},
    syncSpawnCards: options => calls.push(options), work: () => 0,
  });
  vm.runInContext(extract('liveGeometryKey') + '\n' + extract('mergeLiveEvidence'), context);
  const change = { projectIds: [], sessionIds: ['new'], agentIds: ['new'], snapshot: false };
  context.mergeLiveEvidence(change);
  assert.equal(calls.at(-1).notify, true, 'a new tree produces a card without motion');
  context.mergeLiveEvidence({ ...change, sessionIds: [] });
  assert.equal(calls.at(-1).notify, false, 'agent metadata refresh does not create a new toast');
  context.sourceData = { sessions: [], projects: [] };
  context.sessions = [];
  context.mergeLiveEvidence({ ...change, snapshot: true });
  assert.equal(calls.at(-1).notify, false, 'connection snapshots stay quiet');
});

test('the default queue keeps only the latest twenty actual sessions', async () => {
  const { createSpawnCardQueue } = await ready;
  const queue = createSpawnCardQueue();
  const all = Array.from({ length: 25 }, (_, i) => record(String(i + 1), i + 1));
  const state = queue.sync(all);
  assert.equal(state.cards.length, 20);
  assert.deepEqual(state.cards.map(card => card.id), all.slice(5).reverse().map(card => card.id));
  const next = queue.sync([...all, record('26', 26)]);
  assert.equal(next.cards.length, 20);
  assert.equal(next.cards[0].id, '26');
  assert.equal(next.cards.at(-1).id, '7');
});

test('hover labels stay outside the left card column at wide screen and narrow widths', () => {
  const app = fs.readFileSync('web/canvas-garden.js', 'utf8');
  const start = app.indexOf('function selectionLabelBounds('), end = app.indexOf('\nfunction ', start + 1);
  for (const width of [1280, 700, 390]) {
    const world = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
    const cards = { hidden: false, getBoundingClientRect: () => ({ left: 0, right: 282, top: 0, bottom: 600, width: 282 }) };
    const identity = { style: {}, getBoundingClientRect: () => ({ height: 110 }) };
    const context = vm.createContext({ W: width, H: 600, hoverSession: 'tree', pinnedMap: null, mapSession: null,
      hoverProject: null, visibleSessions: [{ id: 'tree' }], anchorsOnScreen: new Map([['tree', {x: width/2, y: 300}]]),
      camera: { x: 0, y: 0, zoom: 1 }, baseCamera: { x: 0, y: 0, zoom: 1 },
      labelMeasureKey: '', labelMeasuredHeight: 0, hoverSummary: () => 'Tree summary',
      $: id => id === 'spawn-cards' ? cards : id === 'world' ? world : identity });
    vm.runInContext(app.slice(start, end), context);
    const bounds = context.selectionLabelBounds();
    assert.ok(bounds.x >= 294 || bounds.stacked, 'hover must move right, or reserve space above the stack');
    assert.ok(bounds.x >= 0 && bounds.x + bounds.w <= width);
  }
});

test('new arrivals preserve the scrolled reading position and retain only twenty DOM cards', async () => {
  const { createSpawnCardStack } = await ready;
  const dom = stackDOM(), stack = createSpawnCardStack({ host: dom.host, onSelect() {} });
  const records = Array.from({length: 25}, (_, i) => record(String(i+1), i+1));
  stack.sync(records, {mode: 'live', motion: true});
  assert.equal(dom.list.children.length, 20);
  dom.host.scrollTop = 720;
  const reading = dom.list.children[5];
  stack.sync([...records, record('26',26)], {mode:'live',motion:true});
  assert.equal(dom.host.scrollTop, 864);
  assert.equal(dom.list.children[6], reading);
  assert.equal(dom.list.children.length, 20);
  assert.equal(dom.host.dataset.motion, 'false');
  stack.sync(records, {mode:'history', reset:true, motion:true});
  assert.equal(dom.host.scrollTop, 0);
});


test('recent trees collapse independently of card data and keep their state on arrivals', async () => {
  const { createSpawnCardStack } = await ready;
  const dom = stackDOM(), stack = createSpawnCardStack({ host: dom.host, onSelect() {} });
  stack.sync([record('a',1)], {mode:'live',motion:true});
  dom.toggle.emit('click');
  assert.equal(dom.list.hidden,true);
  assert.equal(dom.toggle.attributes['aria-expanded'],'false');
  stack.sync([record('a',1),record('b',2)], {mode:'live',motion:true});
  assert.equal(dom.host.dataset.collapsed,'true');
  assert.equal(dom.list.hidden,true);
  assert.equal(dom.list.children.length,2);
  dom.toggle.emit('click');
  assert.equal(dom.list.hidden,false);
  assert.equal(dom.toggle.attributes['aria-expanded'],'true');
});
