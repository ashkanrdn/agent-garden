const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('web/canvas-garden.js', 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

// The production updateMap builds the DOM here. Only browser layout is stubbed.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.hidden = false;
    this.clientWidth = 304;
    this.clientHeight = 245;
    this.classList = { toggle() {} };
  }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(key, callback) { this.listeners[key] = callback; }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith('.')
      ? node.className.split(' ').includes(selector.slice(1))
      : selector === '[data-file-path]' ? 'filePath' in node.dataset
      : selector === '[data-folder-path]' ? 'folderPath' in node.dataset : false;
    return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function harness({ day = 1, entries } = {}) {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const records = entries || [
    { path: 'src/garden.js', bytes: 1024, firstDay: 1 },
    { path: 'notes/design.md', bytes: 512, firstDay: 1 },
    { path: 'src/future.js', bytes: 2048, firstDay: 2 },
  ];
  const session = {
    id: 'test-session', p: 0, birth: 0,
    fileEvents: records.map(f => [f.path, f.firstDay]),
    fileMap: new Map(records.map(f => [f.path, {
      ...f, bytesObservedAt: '2026-06-03T12:00:00Z', bytesSource: 'synthetic',
      events: [{ day: f.firstDay }],
    }])),
  };
  $('file-map').append($('map-tiles'), $('map-unknown'));
  const meta = new Element();
  const query = $('file-map').querySelector.bind($('file-map'));
  $('file-map').querySelector = selector => selector === '.map-meta span' ? meta : query(selector);
  const context = vm.createContext({
    $, document: { createElement: tag => new Element(tag), querySelector: () => $('rail') },
    day, maxDay: 2, startTime: Date.parse('2026-06-01'), endTime: Date.parse('2026-06-03T13:00:00Z'),
    DAY: 86400000, visibleSessions: [session], mapSession: session.id, pinnedMap: session.id,
    selected: session, hoverPath: null, pinnedPath: null, mapKey: '', dirty: false,
    projects: [{ name: 'Generated garden' }], positionMap() {}, activeSession: () => session,
    pin(s, path) { context.pinnedPath = path; }, updateCard() {}, drawArcs() {}, clearTimeout() {}, leaveTimer: null,
  });
  for (const name of ['files', 'snapshot', 'dateText', 'type', 'createOption', 'cutoff', 'partition', 'renderFileTree', 'updateMap']) {
    vm.runInContext(functionSource(name), context);
  }
  // atDay shares a source line with constants in this compact application.
  context.atDay = at => Math.floor((Date.parse(at) - context.startTime) / context.DAY);
  const render = () => vm.runInContext('updateMap()', context);
  render();
  return { $, context, meta, render };
}

test('historical changed files render the existing treemap using current measured sizes', () => {
  const h = harness();
  assert.equal(h.$('map-title').textContent, '2 changed files');
  assert.equal(h.$('map-tiles').dataset.measuredFiles, '2');
  assert.deepEqual(h.$('map-tiles').querySelectorAll('.file-tile').map(n => n.dataset.filePath).sort(),
    ['notes/design.md', 'src/garden.js']);
  assert.equal(h.$('map-tiles').querySelectorAll('.map-folder').length, 2);
  assert.equal(h.$('map-tiles').querySelectorAll('.file-tree-file').length, 0);
  assert.match(h.meta.textContent, /CURRENT BYTES/);
  for (const tile of h.$('map-tiles').querySelectorAll('.file-tile')) {
    assert.match(tile.getAttribute('aria-label'), /measured .*not historical/);
  }
});

test('seeking changes treemap membership without hiding measured files or introducing future paths', () => {
  const h = harness({ day: 2 });
  assert.equal(h.$('map-tiles').querySelectorAll('.file-tile').length, 3);
  h.context.day = 1;
  h.render();
  assert.equal(h.$('map-tiles').querySelectorAll('.file-tile').length, 2);
  h.context.day = 2;
  h.render();
  assert.equal(h.$('map-tiles').querySelectorAll('.file-tile').length, 3);
  assert.equal(h.$('map-tiles').querySelectorAll('.file-tree-file').length, 0);
});

test('unknown and zero-byte paths stay selectable without receiving invented tile area', () => {
  const entries = [{ path: 'src/main.js', bytes: 1024, firstDay: 1 },
    ...Array.from({ length: 5 }, (_, i) => ({ path: `notes/file-${i}.md`, bytes: i ? null : 0, firstDay: 1 }))];
  const h = harness({ day: 2, entries });
  assert.equal(h.$('map-tiles').querySelectorAll('.file-tile').length, 1);
  assert.equal(h.$('map-file-select').children.length, 7, 'all six files remain in the selector');
  assert.equal(h.$('map-tiles').dataset.unknownFiles, '5');
  const tile = h.$('map-tiles').querySelector('.file-tile');
  tile.listeners.click();
  assert.equal(h.context.pinnedPath, 'src/main.js');
});

test('the treemap partitions sibling rectangle area by byte size', () => {
  const h = harness({ entries: [
    { path: 'src/small.js', bytes: 1024, firstDay: 1 },
    { path: 'src/large.js', bytes: 4096, firstDay: 1 },
  ] });
  const tiles = h.$('map-tiles').querySelectorAll('.file-tile');
  assert.equal(tiles.length, 2);
  // Recover each partition cell before the existing one-pixel tile inset.
  const cellArea = tile => {
    const width = Number(tile.style.cssText.match(/(?:^|;)width:([\d.]+)px/)[1]) + 2;
    const height = Number(tile.style.cssText.match(/(?:^|;)height:([\d.]+)px/)[1]) + 2;
    return width * height;
  };
  assert.ok(Math.abs(cellArea(tiles[1]) / cellArea(tiles[0]) - 4) < 1e-9);
  assert.equal(tiles[0].dataset.fileType, 'code');
  assert.equal(tiles[0].dataset.activity, 'recent');
});

test('sessions without recorded file changes keep an explicit empty state', () => {
  const h = harness({ day: 0 });
  assert.equal(h.$('map-tiles').querySelectorAll('[data-file-path]').length, 0);
  assert.equal(h.$('map-tiles').querySelector('.map-empty').textContent, 'No file changes recorded by this date.');
});

test('new unknown-size files update the selector before measurement arrives', () => {
  const h = harness({ entries: [{ path: 'src/first.js', bytes: null, firstDay: 1 }] });
  const session = h.context.selected;
  session.fileEvents.push(['src/new.js', 1]);
  session.fileMap.set('src/new.js', { path: 'src/new.js', bytes: null, events: [{ day: 1 }] });
  h.render();
  assert.equal(h.$('map-file-select').children.length, 3);
  assert.equal(h.$('map-tiles').dataset.unknownFiles, '2');
  Object.assign(session.fileMap.get('src/new.js'), {
    bytes: 128, bytesObservedAt: '2026-06-03T12:00:00Z', bytesSource: 'current-file-stat',
  });
  h.render();
  assert.equal(h.$('map-tiles').dataset.measuredFiles, '1');
  assert.equal(h.$('map-tiles').querySelector('.file-tile').dataset.filePath, 'src/new.js');
});
