const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

// These camera/inspection fixtures hold weather idle; dedicated tests cover arrivals.
function createContext(values) {
  return vm.createContext({
    cloudArrivals: { active: false, sync() {}, advance() {}, entries: () => [] },
    cloudTextureRequested: true,
    arrival:null,spawnShots:{size:0},robotTime:0,
    liveMode:false,maxDay:10,selectedAgentId:null,updateBirdTargets(){},renderAgentDetails(){},enterLive(){},
    ...values,
  });
}


const source = fs.readFileSync('web/canvas-garden.js', 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

function harness() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: true,
      dataset: {},
      style: {},
      textContent: '',
      setAttribute(key, value) { this[key] = value; },
      replaceChildren() {},
      addEventListener() {},
      scrollTop: 0,
    });
    return nodes.get(id);
  };
  const session = { id: 'session-a', p: 0, birth: 0, fileEvents: [], commits: [], agents: [] };
  const playback = {
    paused: false,
    pause() { this.paused = true; },
    state() { return { playing: !this.paused }; },
  };
  const context = createContext({
    $: node,
    GARDEN_PLAYBACK_SPEEDS: [1, 2, 5, 10],
    document: {
      querySelector(selector) { return selector === '.inspector-rail' ? node('inspector-rail') : node(selector); },
      querySelectorAll() { return []; },
    },
    performance: { now: () => 100 },
    clearTimeout() {},
    setTimeout() {},
    sessions: [session],
    projects: [{ id: 'plot-a', name: 'Plot A' }],
    selected: session,
    playback,
    files: () => [],
    visibleSessions: [session],
    mapSession: null,
    pinnedMap: null,
    pinnedPath: null,
    hoverSession: null, hoverTreeId:null, botanical:{setHovered(){}},
    hoverPath: null,
    dismissUntil: 0,
    leaveTimer: null,
    day: 0,
    flight: null,
    tour: null,
    spotlight: null,
    ambientSuspended: false,
    stopAmbientCamera() { context.ambientSuspended = true; },
    resumeAmbientCamera() { context.ambientSuspended = false; },
    stopFlight() {},
    syncPlaybackControls() {},
    revealMap() {},
    updateCard() {},
    updateMap() { node('inspector-rail').hidden = !context.mapSession; },
    drawArcs() {},
    rebuild() {},
  });
  vm.runInContext([
    functionSource('setTreeHover'), functionSource('syncPlaybackControls'), functionSource('pauseReplay'),
    functionSource('revealMap'), functionSource('preview'), functionSource('leave'),
    functionSource('scheduleLeave'), functionSource('dismiss'), functionSource('pin'),
  ].join('\n'), context);
  return { context, node, session, playback };
}

test('hover reveals identity only and does not open the inspection panel', () => {
  const h = harness();
  vm.runInContext('preview(sessions[0])', h.context);
  assert.equal(h.context.hoverSession, 'session-a');
  assert.equal(h.context.mapSession, null);
  assert.equal(h.context.ambientSuspended, true);
});

test('tree inspection pauses playback and opens the side panel', () => {
  const h = harness();
  vm.runInContext('pin(sessions[0])', h.context);
  assert.equal(h.playback.paused, true);
  assert.equal(h.context.pinnedMap, 'session-a');
  assert.equal(h.context.mapSession, 'session-a');
  assert.equal(h.node('inspector-rail').hidden, false);
});

test('closing inspection keeps playback paused and resumes ambient camera travel', () => {
  const h = harness();
  vm.runInContext('pin(sessions[0]); dismiss()', h.context);
  assert.equal(h.playback.paused, true);
  assert.equal(h.context.mapSession, null);
  assert.equal(h.node('inspector-rail').hidden, true);
  assert.equal(h.context.ambientSuspended, false);
});

test('pauseReplay updates the actual play control state', () => {
  const h = harness();
  vm.runInContext('pauseReplay()', h.context);
  assert.equal(h.playback.paused, true);
  assert.equal(h.node('play').textContent, '▶');
  assert.equal(h.node('play')['aria-label'], 'Play historical replay');
});

test('drawMoths reports zero marks for a session with no agents', () => {
  const tree = { s: { id: 'session-a', agents: [] }, distance: 0 };
  const context = createContext({
    renderedTrees: [tree],
    anchorsOnScreen: new Map([['session-a', { x: 20, y: 20 }]]),
    treeGrowth: { sample: () => ({ crown: 1 }) },
    day: 0,
    motion: false,
    motionPreference: { matches: true },
    pinnedMap: null,
    hoverSession: null, hoverTreeId:null, botanical:{setHovered(){}},
    random: () => () => 0.5,
    performance: { now: () => 100 },
    scale: 1,
    W: 200,
    H: 200,
    canvas: { dataset: {} },
    ctx: { save() {}, restore() {}, translate() {}, rotate() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, fillStyle: '', globalAlpha: 1 },
  });
  const flockSource = fs.readFileSync('web/garden-flock.js', 'utf8').replace(/export function /g, 'function ');
  vm.runInContext(flockSource + '\nconst flock=createGardenFlock(); const boidTrails=true;', context);
  vm.runInContext(functionSource('treeAgents') + '\n' + functionSource('drawMoths'), context);
  vm.runInContext('drawMoths(0)', context);
  assert.equal(context.canvas.dataset.visibleBoids, '0');
  assert.equal(context.canvas.dataset.boidCap, '96');
});

test('frame does not advance playback while scrubbing', () => {
  let advances = 0;
  const playback = {
    state: () => ({ day: 0, phase: 'traversal' }),
    advance: () => { advances += 1; return { day: 0, phase: 'traversal' }; },
  };
  const context = createContext({
    document: { hidden: false },
    playback,
    scrubbing: false,
    lastFrame: 0,
    cameraFrame: 0, sceneRebuilds: 0,
    lastAnimationTime: 0,
    motion: false,
    flight: null,
    dirty: false,
    dynamicFrames: 0,
    decorationTime: 0,
    advanceCamera() {},
    settleScene() {},
    advanceVisualScene() {},
    drawDynamic() {},
    requestAnimationFrame() {},
    motionPreference: { matches: false },
    day: 0,
    updateDay() {},
    canvas: { dataset: {} },
    performance: { now: () => 100 },
  });
  const frameStart = source.indexOf('function frame(');
  vm.runInContext(source.slice(frameStart, source.indexOf('\nwindow.canvasGarden', frameStart)), context);
  vm.runInContext('frame(100); frame(200)', context);
  context.scrubbing = true;
  vm.runInContext('frame(300)', context);
  assert.equal(advances, 1);
});
