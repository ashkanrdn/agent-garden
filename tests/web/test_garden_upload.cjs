const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const uploadSource = fs.readFileSync('web/garden-upload.js', 'utf8');
const canvasSource = fs.readFileSync('web/canvas-garden.js', 'utf8');
const ready = import('data:text/javascript;base64,' + Buffer.from(uploadSource).toString('base64'));
const valid = () => ({ schemaVersion: 1, sessions: [], projects: [], commits: [] });
const json = data => ({ ok: true, status: 200, json: async () => data });
const file = data => ({ text: async () => JSON.stringify(data) });
const flush = () => new Promise(resolve => setImmediate(resolve));
const pageURL = 'https://garden.example/releases/garden/index.html';

for (const [name, response, expected] of [
  ['200 JSON', () => json({ busy: false }), 'local'],
  ['404', () => ({ ok: false, status: 404, json: () => { throw Error('Do not parse a 404'); } }), 'hosted'],
  ['network failure', () => { throw TypeError('Network error'); }, 'hosted'],
  ['HTML 200', () => ({ ok: true, status: 200, json: async () => { throw SyntaxError('Unexpected <'); } }), 'hosted'],
]) test('loopback mode detection: ' + name, async () => {
  const { detectGardenMode } = await ready, calls = [];
  const mode = await detectGardenMode('http://127.0.0.1:8000/', async (...args) => { calls.push(args); return response(); });
  assert.equal(mode, expected);
  assert.deepEqual(calls, [['/api/status', { cache: 'no-store' }]]);
});

for (const host of ['garden.example', 'example.com']) test('hosted mode skips status probe on ' + host, async () => {
  const { detectGardenMode } = await ready, calls = [];
  assert.equal(await detectGardenMode('https://' + host + '/', async (...args) => { calls.push(args); }), 'hosted');
  assert.deepEqual(calls, []);
});

for (const host of ['localhost', '127.0.0.1', '[::1]']) test('mode detection probes loopback host ' + host, async () => {
  const { detectGardenMode } = await ready, calls = [];
  assert.equal(await detectGardenMode('http://' + host + '/', async (...args) => { calls.push(args); return json({}); }), 'local');
  assert.deepEqual(calls, [['/api/status', { cache: 'no-store' }]]);
});

test('validator accepts the minimal contract and additive fields', async () => {
  const { isGardenData } = await ready;
  assert.equal(isGardenData(valid()), true);
  assert.equal(isGardenData({ ...valid(), redacted: true, generator: { name: 'example' } }), true);
});

test('validator rejects nonobjects, schema mismatches, and missing or nonarray collections', async () => {
  const { isGardenData } = await ready;
  for (const value of [null, undefined, [], 'data', 1, true, {}, { ...valid(), schemaVersion: '1' }, { ...valid(), schemaVersion: 2 }]) {
    assert.equal(isGardenData(value), false, JSON.stringify(value));
  }
  for (const key of ['sessions', 'projects', 'commits']) {
    const missing = valid(); delete missing[key];
    assert.equal(isGardenData(missing), false, key + ' absent');
    for (const value of [null, {}, '', 0]) assert.equal(isGardenData({ ...valid(), [key]: value }), false, key);
  }
});

test('export commands use the page origin and root or subpath without query or hash', async () => {
  const { buildExportCommand } = await ready;
  for (const [page, base] of [
    ['https://garden.example/', 'https://garden.example/'],
    ['https://garden.example/index.html?demo#garden', 'https://garden.example/'],
    ['https://garden.example/agent-garden/', 'https://garden.example/agent-garden/'],
    ['https://garden.example/agent-garden', 'https://garden.example/agent-garden/'],
    ['https://garden.example/agent-garden/index.html?demo', 'https://garden.example/agent-garden/'],
    ['http://localhost:8080/sub/path/?demo', 'http://localhost:8080/sub/path/'],
  ]) assert.equal(buildExportCommand(page), 'curl -fsSL ' + base + 'agent_garden_export.py | python3 -');
});

test('export commands shell-quote unusual path characters', async () => {
  const { buildExportCommand } = await ready;
  assert.equal(buildExportCommand('https://garden.example/$garden/'),
    "curl -fsSL 'https://garden.example/$garden/agent_garden_export.py' | python3 -");
});

test('hosted data source sends only the status probe and explicitly requested demo', async () => {
  const { createGardenDataSource } = await ready, calls = [];
  const source = createGardenDataSource({ pageURL, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return url === '/api/status' ? { ok: false, status: 404 } : json(valid());
  } });
  assert.equal(await source.fetchLocal('/api/refresh', { method: 'POST' }), null);
  assert.deepEqual(await Promise.all([source.initialize(), source.initialize()]), ['hosted', 'hosted']);
  assert.equal(calls.length, 0, 'hosted detection makes no request');
  for (const url of ['/api/status', '/api/live/messages', '/api/refresh', 'local-session-data.json?refresh=1']) {
    assert.equal(await source.fetchLocal(url), null);
  }
  assert.deepEqual(await source.readFile(file(valid())), valid());
  assert.equal(calls.length, 0, 'reading a file and blocked local requests make no network requests');
  assert.deepEqual(await source.readDemo(), valid());
  assert.deepEqual(calls.map(call => call.url), ['https://garden.example/releases/garden/demo/agent-garden-demo.json']);
  assert.ok(calls.every(call => !call.options?.body), 'file contents never enter a request');
});

test('local data source permits refresh, status, and local dataset requests', async () => {
  const { createGardenDataSource } = await ready, calls = [];
  const source = createGardenDataSource({ pageURL: 'http://localhost:8080/', fetchImpl: async (...args) => { calls.push(args); return json({}); } });
  assert.equal(await source.initialize(), 'local');
  await source.fetchLocal('/api/refresh', { method: 'POST' });
  await source.fetchLocal('local-session-data.json?refresh=1', { cache: 'no-store' });
  assert.deepEqual(calls.map(call => call[0]), ['/api/status', '/api/refresh', 'local-session-data.json?refresh=1']);
  assert.equal(calls[1][1].method, 'POST');
});

function dom() {
  const nodes = new Map(), listeners = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: true, textContent: '', value: '', children: [], dataset: {}, style: {}, listeners: new Map(),
      addEventListener(type, callback) { this.listeners.set(type, callback); },
      setAttribute(name, value) { this[name] = value; },
      replaceChildren(...children) { this.children = children; },
      appendChild(child) { this.children.push(child); },
      click() { this.clicks = (this.clicks || 0) + 1; }, focus() {}, contains() { return false; },
      classList: { add() {}, toggle() {} },
    });
    return nodes.get(id);
  };
  const document = { body: { dataset: {} }, getElementById: node, activeElement: null,
    createElement: () => node(Symbol()), querySelector: node,
    addEventListener(type, callback) { listeners.set(type, callback); } };
  return { node, document, fire: (type, event) => listeners.get(type)(event) };
}

async function mounted({ local = false, demoOK = true, query = '', onData } = {}) {
  const { createGardenDataSource, mountGardenUpload } = await ready;
  const ui = dom(), calls = [], loaded = [], modes = [], localLoads = [];
  const currentPageURL = (local ? 'http://localhost:8000/' : pageURL) + query;
  const source = createGardenDataSource({ pageURL: currentPageURL, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return url === '/api/status' ? (local ? json({}) : { ok: false, status: 404 })
      : demoOK ? json(valid()) : { ok: false, status: 404 };
  } });
  const upload = mountGardenUpload({ source, document: ui.document, pageURL: currentPageURL,
    clipboard: { writeText: async text => { ui.copied = text; } },
    onMode: mode => modes.push(mode), onLocal: () => localLoads.push(true),
    onData: data => { onData?.(data); loaded.push(data); } });
  await upload.start();
  return { ...ui, source, upload, calls, loaded, modes, localLoads, copied: () => ui.copied };
}

const drop = (ui, dataFile) => {
  let prevented = false;
  ui.fire('drop', { preventDefault() { prevented = true; }, dataTransfer: { types: ['Files'], files: [dataFile] } });
  return prevented;
};

test('hosted arrival offers a command, script, demo, and file picker', async () => {
  const ui = await mounted();
  assert.deepEqual(ui.modes, ['hosted']); assert.deepEqual(ui.localLoads, []);
  assert.equal(ui.node('garden-arrival').hidden, false);
  assert.match(ui.node('export-command').textContent, /releases\/garden\/agent_garden_export\.py/);
  assert.equal(ui.node('export-script').href, 'https://garden.example/releases/garden/agent_garden_export.py');
  await ui.node('copy-export').listeners.get('click')();
  assert.equal(ui.copied(), ui.source.command);
  ui.node('choose-garden-file').listeners.get('click')();
  assert.equal(ui.node('garden-file').clicks, 1);
});

test('local arrival stays closed and delegates to the existing loader', async () => {
  const ui = await mounted({ local: true });
  assert.equal(ui.node('garden-arrival').hidden, true);
  assert.deepEqual(ui.localLoads, [true]);
  assert.equal(drop(ui, file(valid())), false);
  await flush(); assert.equal(ui.loaded.length, 0);
});

test('file selection and dropping another file swap data in memory without requests', async () => {
  const ui = await mounted();
  const first = { ...valid(), redacted: false }, second = { ...valid(), redacted: true };
  ui.node('garden-file').files = [file(first)];
  ui.node('garden-file').listeners.get('change')();
  await flush();
  assert.equal(ui.node('garden-arrival').hidden, true);
  assert.equal(ui.node('garden-support').hidden, false);
  assert.equal(drop(ui, file(second)), true);
  await flush();
  assert.deepEqual(ui.loaded, [first, second]);
  assert.equal(ui.calls.length, 0, 'hosted file actions make no requests');
});

test('invalid JSON, invalid shape, unreadable files, and parser errors keep arrival open', async () => {
  const { INVALID_GARDEN_FILE } = await ready;
  for (const dataFile of [{ text: async () => '{' }, file({ ...valid(), commits: null }),
    { text: async () => { throw Error('Unreadable'); } }]) {
    const ui = await mounted(); drop(ui, dataFile); await flush();
    assert.equal(ui.node('garden-arrival').hidden, false);
    assert.equal(ui.node('upload-status').textContent, INVALID_GARDEN_FILE);
    assert.equal(ui.loaded.length, 0);
  }
  const ui = await mounted({ onData() { throw Error('Unsupported history range'); } });
  drop(ui, file(valid())); await flush();
  assert.equal(ui.node('upload-status').textContent, INVALID_GARDEN_FILE);
});

test('the newest file wins when an earlier file read finishes late', async () => {
  const ui = await mounted(); let release;
  drop(ui, { text: () => new Promise(resolve => { release = resolve; }) });
  drop(ui, file({ ...valid(), redacted: true })); await flush();
  release(JSON.stringify(valid())); await flush();
  assert.deepEqual(ui.loaded, [{ ...valid(), redacted: true }]);
});

test('?demo loads the same-origin demo directly; a 404 remains a quiet inline message', async () => {
  const ui = await mounted({ query: '?demo' });
  assert.equal(ui.loaded.length, 1); assert.equal(ui.node('garden-arrival').hidden, true);
  assert.deepEqual(ui.calls.map(call => call.url), ['https://garden.example/releases/garden/demo/agent-garden-demo.json']);
  const missing = await mounted({ query: '?demo', demoOK: false });
  assert.equal(missing.loaded.length, 0); assert.equal(missing.node('garden-arrival').hidden, false);
  assert.equal(missing.node('upload-status').textContent, 'The demo garden is unavailable. Choose a file instead.');
});

function functionSource(name) {
  const start = canvasSource.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const rest = canvasSource.slice(start), end = rest.slice(1).search(/\n(?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

test('actual canvas loading, refresh, live, and message wiring cannot request local resources in hosted mode', async () => {
  const ui = await mounted(), callsBefore = ui.calls.length;
  let streams = 0, messageFetch;
  const pagerStart = canvasSource.indexOf('const messagesPager=');
  const pagerEnd = canvasSource.indexOf('\nconst upload=', pagerStart);
  const context = vm.createContext({ dataSource: ui.source, upload: ui.upload,
    window: { EventSource: true }, EventSource: function () { streams++; },
    createGardenMessagePager: options => { messageFetch = options.fetchPage; return {}; },
    $: ui.node, document: ui.document, selected: { id: 'example', agent: 'claude-code' }, selectedAgentId: null,
    treeAgents: () => [], renderMessages() {}, liveMode: false });
  vm.runInContext(canvasSource.slice(pagerStart, pagerEnd), context);
  vm.runInContext(['configureDataMode', 'loadData', 'refreshData', 'connectLive', 'enterLive', 'renderAgentDetails'].map(functionSource).join('\n'), context);
  context.configureDataMode('hosted');
  await context.loadData(); await context.refreshData(); context.connectLive(); context.enterLive(); context.renderAgentDetails();
  await messageFetch('root', 'agent', 'cursor');
  assert.equal(ui.calls.length, callsBefore);
  assert.equal(streams, 0); assert.equal(ui.node('garden-file').clicks, 1);
  assert.equal(ui.node('refresh-data').textContent, 'Open another file');
  assert.equal(ui.node('latest').hidden, true); assert.equal(ui.node('live-messages').hidden, true);
  assert.equal(ui.node('hosted-messages-note').hidden, false);
  assert.equal(ui.node('agent-detail').hidden, true);
  assert.equal(ui.node('session-agent').textContent, 'Claude Code');
  context.selected.agent = 'codex'; context.renderAgentDetails();
  assert.equal(ui.node('session-agent').textContent, 'Codex');
  delete context.selected.agent; context.renderAgentDetails();
  assert.equal(ui.node('session-agent').hidden, true);
});

test('actual local loader, refresh, and event stream retain local behavior', async () => {
  const { createGardenDataSource } = await ready, ui = dom(), requests = [], datasets = [], streams = [];
  const source = createGardenDataSource({ pageURL: 'http://127.0.0.1:8000/', fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    return json(String(url).startsWith('local-session') ? valid() : { busy: false });
  } });
  await source.initialize();
  const context = vm.createContext({ dataSource: source, $: ui.node, document: ui.document,
    applyDataset: data => datasets.push(data), setTimeout: resolve => resolve(),
    window: { EventSource: true }, liveStream: null,
    EventSource: function (url) { streams.push(url); this.addEventListener = () => {}; } });
  vm.runInContext(['loadData', 'refreshData', 'connectLive'].map(functionSource).join('\n'), context);
  await context.loadData(); await context.refreshData(); context.connectLive();
  assert.equal(datasets.length, 2);
  assert.deepEqual(streams, ['/api/events']);
  assert.equal(requests.filter(call => call.url.startsWith('local-session-data.json?refresh=')).length, 2);
  assert.equal(requests.find(call => call.url === '/api/refresh').options.method, 'POST');
});

test('hosted history never advances its saved time range on a live clock tick', () => {
  const context = vm.createContext({ document: { body: { dataset: { gardenMode: 'hosted' } } },
    sourceData: valid(), endTime: 100, maxDay: 1 });
  vm.runInContext(functionSource('advanceLiveClock'), context);
  assert.equal(context.advanceLiveClock(), false);
  assert.equal(context.endTime, 100); assert.equal(context.maxDay, 1);
});

test('redacted exports are labeled in hosted data details', () => {
  const ui = dom();
  const context = vm.createContext({ $: ui.node, document: ui.document,
    sourceData: { ...valid(), generatedAt: '2026-01-01', redacted: true }, allSessions: [], sessions: [], projects: [],
    dataSource: { mode: 'hosted', command: 'example' } });
  vm.runInContext(functionSource('renderImportDetails'), context);
  context.renderImportDetails();
  assert.match(ui.node('data-summary').textContent, /Redacted export/);
  context.sourceData.redacted = false; context.renderImportDetails();
  assert.doesNotMatch(ui.node('data-summary').textContent, /Redacted export/);
});

test('upload code has no persistence or telemetry mechanism', () => {
  assert.doesNotMatch(uploadSource, /localStorage|sessionStorage|indexedDB|sendBeacon|XMLHttpRequest/);
  assert.doesNotMatch(uploadSource, /console\.(?:error|warn|log)/);
});
