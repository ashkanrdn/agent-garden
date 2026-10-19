const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'web/demo/agent-garden-demo.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'web/canvas-garden.js'), 'utf8');

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\nfunction ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

test('demo dataset parses through the garden data path', () => {
  const context = vm.createContext({
    DAY: 86400000,
    dataSource: { mode: 'hosted' },
    timelineBrush: { clear() {} },
    createGardenPlayback: () => ({ pause() {}, seek() {} }),
    syncPlaybackControls() {}, refreshActivityStrip() {}, setTreeHover() {},
    layoutMotion: { settle() {} }, treeGrowth: { clear() {} }, modelCache: { clear() {} },
    botanical: { clear() {} }, specimenEnvironment: { clear() {} }, flock: { clear() {} },
    motion: false, motionPreference: { matches: false }, camera: { auto: true, yaw: 0 },
    gardenOrbit: { reset() {} }, performance: { now: () => 0 },
    $: () => ({ max: '', value: '', replaceChildren() {} }),
    document: { querySelector: () => ({ replaceChildren() {} }), createElement: () => ({ textContent: '' }) },
    renderImportDetails() {}, renderProjectSelect() {},
  });
  vm.runInContext(`
    var sourceData, allSessions = [], sessions = [], projects = [], sessionRecords = new Map();
    var startTime, endTime, maxDay = 0, day = 0, playback, liveMode = false;
    var selected, hoverSession, scrubbing = false, seenCommits, commitPulses = [];
    var overviewFit, driftBase, spotlight, ambientSuspended = false, driftEnabled = false;
    var projectFilter = '', searchFilter = '', sceneKey = '', displayScene, mapKey = '';
    var selectedAgentId = null;
    var evidenceGeneration = 0;
    var arrival, showcase, lastArrivalAt, idleAfter, cloudArrivals = { active: false, sync() {}, clear() {} };
    var cloudTextureRequested = false, spawnShots = new Map(), spawnReturn, robotTime = 0;
    var spinCoast = false, orbitFrameCache, orbitLastTime = 0, loadError = '', loading = false;
    var camera = { auto: true, yaw: 0 }, DAY = 86400000, SEED = 1;
    function atDay(value) { const time = Date.parse(value); return Number.isFinite(time) ? Math.floor((time - startTime) / DAY) : null; }
    function dateText(value) { return String(value); }
  `, context);
  vm.runInContext(functionSource('parseData', 'deriveGardenRecords'), context);
  const deriveStart = source.indexOf('function deriveGardenRecords(');
  const deriveEnd = source.indexOf('\nfunction renderImportDetails(', deriveStart);
  assert.notEqual(deriveStart, -1);
  assert.notEqual(deriveEnd, -1);
  vm.runInContext(source.slice(deriveStart, deriveEnd), context);
  context.renderImportDetails = () => {};
  context.renderProjectSelect = () => {};
  context.data = data;
  assert.doesNotThrow(() => vm.runInContext('parseData(data)', context));
  const parsed = JSON.parse(JSON.stringify(vm.runInContext('({ imported: allSessions.length, primary: sessions.length, projects: projects.length })', context)));
  assert.deepEqual(parsed, { imported: 240, primary: 148, projects: 9 });
});
