const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const directory = 'web/';
const source = fs.readFileSync(directory + 'canvas-garden.js', 'utf8');
const moduleReady = import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(directory + 'garden-live-messages.js', 'utf8')).toString('base64'));
const growthReady = import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(directory + 'tree-growth.js', 'utf8')).toString('base64'));
const cameraReady = import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(directory + 'garden-robot-camera.js', 'utf8')).toString('base64'));
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

test('overlapping bird buttons select the nearest moving bird while keyboard keeps its own identity', () => {
  const context = vm.createContext({ liveState: { agent: () => ({}) } });
  vm.runInContext(functionSource('birdKeyAtPointer'), context);
  const host = { offsetWidth: 200, offsetHeight: 100,
    getBoundingClientRect: () => ({ left: 120, top: 60, width: 400, height: 200 }) };
  const birds = [{ key: 'visible-a', screen: { x: 30, y: 40 } },
    { key: 'top-dom-b', screen: { x: 42, y: 40 } }];
  const pick = (detail, x, y) => context.birdKeyAtPointer({ detail, clientX: x, clientY: y }, 'top-dom-b', host, birds);
  assert.equal(pick(1, 180, 140), 'visible-a');
  assert.equal(pick(1, 204, 140), 'top-dom-b');
  assert.equal(pick(0, 180, 140), 'top-dom-b');
  assert.equal(pick(1, 120, 60), 'top-dom-b');
});

test('message refresh fills every new page before the old reading range', async () => {
  const { createGardenMessagePager } = await moduleReady;
  let records = Array.from({ length: 80 }, (_, i) => ({ id: `old-${80 - i}` }));
  const pager = createGardenMessagePager({ fetchPage: async (_root, _agent, cursor) => {
    const start = cursor ? records.findIndex(item => item.id === cursor) + 1 : 0;
    const page = records.slice(start, start + 20);
    return { messages: page, nextCursor: records[start + 20] ? page.at(-1).id : null };
  } });
  await pager.select('root', 'agent');
  await pager.older();
  assert.equal(pager.state().messages.length, 40);
  records = [...Array.from({ length: 30 }, (_, i) => ({ id: `new-${30 - i}` })), ...records];
  await pager.refresh();
  while (pager.state().nextCursor) await pager.older();
  assert.equal(pager.state().messages.length, 110);
  assert.equal(new Set(pager.state().messages.map(item => item.id)).size, 110);
  assert.deepEqual(pager.state().messages.slice(0, 30).map(item => item.id), records.slice(0, 30).map(item => item.id));
});

test('refresh merging an in-flight Older page keeps its records and matching stable cursor', async () => {
  const { createGardenMessagePager } = await moduleReady;
  const original = Array.from({ length: 80 }, (_, i) => ({ id: `old-${80 - i}` }));
  let records = original, firstPageCalls = 0, releaseOlder, releaseRefresh;
  const opaque = id => Buffer.from(`2026-09-24T10:00:00.000Z|${id}`).toString('base64url');
  const cursorId = cursor => Buffer.from(cursor, 'base64url').toString().split('|').at(-1);
  const pager = createGardenMessagePager({ fetchPage: (_root, _agent, cursor) => {
    if (!cursor) {
      if (++firstPageCalls === 1) return Promise.resolve({ messages: records.slice(0, 20), nextCursor: opaque(records[19].id) });
      const page = records.slice(0, 20);
      return Promise.resolve({ messages: page, nextCursor: records[20] ? opaque(page.at(-1).id) : null });
    }
    const lastId = cursorId(cursor);
    const start = records.findIndex(item => item.id === lastId) + 1;
    const page = records.slice(start, start + 20);
    const result = { messages: page, nextCursor: records[start + 20] ? opaque(page.at(-1).id) : null };
    if (lastId === 'new-11' && !releaseRefresh) return new Promise(resolve => { releaseRefresh = () => resolve(result); });
    if (lastId === 'old-61' && !releaseOlder) return new Promise(resolve => { releaseOlder = () => resolve(result); });
    return Promise.resolve(result);
  } });
  await pager.select('root', 'agent');
  records = [...Array.from({ length: 30 }, (_, i) => ({ id: `new-${30 - i}` })), ...original];
  const refresh = pager.refresh();
  await new Promise(resolve => setTimeout(resolve, 0));
  const older = pager.older();
  assert.ok(releaseRefresh, 'refresh is waiting for its overlap page');
  releaseOlder();
  await older;
  assert.equal(pager.state().messages.length, 40);
  assert.equal(pager.state().nextCursor, opaque('old-41'));
  releaseRefresh();
  await refresh;
  assert.ok(pager.state().messages.some(item => item.id === 'old-41'));
  assert.equal(pager.state().nextCursor, opaque('old-41'));
  while (pager.state().nextCursor) await pager.older();
  assert.equal(pager.state().messages.length, 110);
  assert.equal(new Set(pager.state().messages.map(item => item.id)).size, 110);
  assert.deepEqual(pager.state().messages.slice(0, 30).map(item => item.id), records.slice(0, 30).map(item => item.id));
});

test('refresh replaces removed or disjoint message sources when no old boundary overlaps', async () => {
  const { createGardenMessagePager } = await moduleReady;
  async function assertReplacement(replacement, expected) {
    let records = [{ id: 'old-newest' }, { id: 'old-oldest' }];
    const pager = createGardenMessagePager({ fetchPage: async (_root, _agent, cursor) => {
      const start = cursor ? records.findIndex(item => item.id === cursor) + 1 : 0;
      const page = records.slice(start, start + 20);
      return { messages: page, nextCursor: records[start + 20] ? page.at(-1).id : null };
    } });
    await pager.select('root', 'agent');
    records = replacement;
    await pager.refresh();
    assert.deepEqual(pager.state().messages.map(item => item.id), expected);
    assert.equal(pager.state().nextCursor, null);
  }
  await assertReplacement([], []);
  await assertReplacement([{ id: 'replacement-newest' }, { id: 'replacement-oldest' }],
    ['replacement-newest', 'replacement-oldest']);
});

test('late response from a previous agent or previous refresh cannot replace newer messages', async () => {
  const { createGardenMessagePager } = await moduleReady;
  const pending = [];
  const pager = createGardenMessagePager({ fetchPage: (_root, agent) => new Promise(resolve => pending.push({ agent, resolve })) });
  const first = pager.select('root', 'agent-a');
  const second = pager.select('root', 'agent-b');
  pending[1].resolve({ messages: [{ id: 'b1' }], nextCursor: null });
  await second;
  pending[0].resolve({ messages: [{ id: 'a1' }], nextCursor: null });
  await first;
  assert.deepEqual(pager.state().messages.map(item => item.id), ['b1']);
  const stale = pager.refresh(), newest = pager.refresh();
  pending[3].resolve({ messages: [{ id: 'b2' }, { id: 'b1' }], nextCursor: null });
  await newest;
  pending[2].resolve({ messages: [{ id: 'stale' }, { id: 'b1' }], nextCursor: null });
  await stale;
  assert.deepEqual(pager.state().messages.map(item => item.id), ['b2', 'b1']);
});

test('settled arrivals queue behind one real showcase and keep camera gates', async () => {
  const [{ createTreeGrowth, TREE_EMERGENCE_MS }, { canShowcaseTree }] = await Promise.all([growthReady, cameraReady]);
  const clock = { now: 0 }, timers = [];
  const growth = createTreeGrowth();
  const tree = id => ({ s: { id } });
  const context = vm.createContext({
    liveMode: true, sessions: ['tree-a', 'tree-b'].map(id => ({ id })),
    treePlacements: ['tree-a', 'tree-b'].map(tree), motion: true,
    treeGrowth: growth, cloudArrivals: { entries: () => [] },
    performance: { now: () => clock.now }, TREE_EMERGENCE_MS,
    setTimeout(callback, delay) { timers.push({ callback, at: clock.now + delay }); },
    canShowcaseTree, motionPreference: { matches: false }, document: { hidden: false },
    pointerGesture: null, flight: null, tour: null, spotlight: null, arrival: null, showcase: null,
    overviewFit: null, mapSession: null, pinnedMap: null, hoverSession: null, hoverProject: null,
    scrubbing: false, playback: { state: () => ({ playing: false }) }, camera: { auto: true },
    ambientSuspended: false, driftEnabled: true, centralOrbitFraming: () => ({ zoom: 1, center: { x: 0, y: 0 }, lift: 0 }),
    orbitBasePose: () => ({ zoom: 1, center: { x: 0, y: 0 }, lift: 0 }),
    closeOrbitFraming: () => ({ zoom: 2 }), idleAfter: 0, dirty: false,
  });
  vm.runInContext([
    functionSource('waitForLiveGrowth'), functionSource('liveTreeGrowthActive'),
    functionSource('canDeferShowcase'), functionSource('showcaseTree'),
  ].join('\n'), context);
  growth.sync([{ id: 'tree-a', score: 8 }, { id: 'tree-b', score: 8 }], 0);
  vm.runInContext("waitForLiveGrowth('tree-a'); waitForLiveGrowth('tree-b')", context);
  function advanceTo(time) {
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > time) break;
      const next = timers.shift(); clock.now = next.at; next.callback();
    }
    clock.now = time;
  }
  advanceTo(1160);
  assert.equal(context.showcase.anchorId, 'tree-a');
  assert.ok(timers.length, 'the second tree remains pending while the first showcase is active');

  // A completed camera move clears this real gate in advanceVisualScene.
  clock.now = 14000; context.showcase = null; advanceTo(14080);
  assert.equal(context.showcase.anchorId, 'tree-b', 'the second settled tree starts after the first showcase');

  context.sessions.push({ id: 'tree-c' }); context.treePlacements.push(tree('tree-c'));
  growth.sync(['tree-a', 'tree-b', 'tree-c'].map(id => ({ id, score: 8 })), clock.now);
  context.mapSession = 'root';
  vm.runInContext("waitForLiveGrowth('tree-c')", context);
  advanceTo(clock.now + TREE_EMERGENCE_MS);
  assert.equal(context.showcase.anchorId, 'tree-b');
  assert.equal(timers.length, 0, 'inspection blocks and clears the deferred showcase');
  context.mapSession = null; context.showcase = null; advanceTo(clock.now + 1000);
  assert.equal(context.showcase, null, 'clearing inspection does not force a camera move later');

  for (const [id, gate] of [['tree-d', 'motion'], ['tree-e', 'history']]) {
    context.sessions.push({ id }); context.treePlacements.push(tree(id));
    growth.sync(context.sessions.map(item => ({ id: item.id, score: 8 })), clock.now);
    if (gate === 'motion') context.motion = false;
    else context.liveMode = false;
    vm.runInContext(`waitForLiveGrowth('${id}')`, context);
    advanceTo(clock.now + TREE_EMERGENCE_MS);
    assert.equal(context.showcase, null, `${gate} gate prevents camera movement`);
    context.motion = true; context.liveMode = true;
  }
});

test('History keeps a child and its reading position only while the same root is selected', () => {
  let refreshes = 0;
  const messageList = { scrollTop: 91 };
  const context = vm.createContext({
    liveMode: true, playback: { seek() {} }, maxDay: 4, day: 4,
    selected: { id: 'root-a' }, selectedAgentId: 'child-a',
    agentRecord: id => id === 'child-a' ? { rootSessionId: 'root-a' } : null,
    messagesPager: { refresh() { refreshes++; } }, liveStream: { readyState: 1 },
    clearTimeRange() {}, pauseReplay() {}, updateDay() {}, renderAgentDetails() {}, setConnection() {},
    $: id => id === 'message-list' ? messageList : { textContent: '' }, dirty: false,
  });
  vm.runInContext(functionSource('leaveLive') + '\n' + functionSource('enterLive'), context);
  vm.runInContext('leaveLive(); enterLive()', context);
  assert.equal(context.selectedAgentId, 'child-a');
  assert.equal(messageList.scrollTop, 91);
  assert.equal(refreshes, 1);
  vm.runInContext('leaveLive()', context);
  context.selected = { id: 'root-b' };
  vm.runInContext('enterLive()', context);
  assert.equal(context.selectedAgentId, null);
  assert.equal(refreshes, 2, 'the newly selected root conversation refreshes on return to Live');
});

test('agent-only event and idle clock advance the live date and slider across UTC days', () => {
  const start = Date.parse('2026-09-23T00:00:00Z');
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', value: '', max: '', replaceChildren() {} });
    return nodes.get(id);
  };
  const context = vm.createContext({
    sourceData: {}, sessions: [{ workByDay: new Float64Array([2]), dailyWorkByDay: new Float64Array([0]) }],
    startTime: start, endTime: Date.parse('2026-09-23T23:59:00Z'), DAY: 86400000,
    maxDay: 0, day: 0, liveMode: true, dirty: false,
    playback: { state: () => ({ playing: false }), getSpeed: () => 1 },
    createGardenPlayback: () => ({ setSpeed() {}, seek() {}, state: () => ({ playing: false }) }),
    $: node, document: { createElement: () => ({ textContent: '' }) },
    refreshSpecimenEncodings:()=>false, rebuild(){}, dateText: day => `day-${day}`, updateCard() {}, updateMap() {}, syncPlaybackControls() {},
    liveState: { apply: () => ({ agentIds: [], sessionIds: [], projectIds: [] }) },
    mergeLiveEvidence() {}, setConnection() {}, renderAgentDetails() {}, selected: null, selectedAgentId: null, liveReady: false,
  });
  vm.runInContext(functionSource('advanceLiveClock') + '\n' + functionSource('acceptLiveEvent'), context);
  vm.runInContext("acceptLiveEvent({observedAt:'2026-09-24T00:10:00Z'},false)", context);
  assert.equal(context.maxDay, 1);
  assert.equal(context.day, 1);
  assert.equal(node('time').max, '1');
  assert.equal(node('time').value, '1');
  assert.match(node('date').textContent, /Sep 24, 2026/);
  assert.deepEqual(Array.from(context.sessions[0].workByDay), [2, 2]);
  vm.runInContext("advanceLiveClock('2026-09-25T00:01:00Z')", context);
  assert.equal(context.maxDay, 2);
  assert.equal(node('time').max, '2');
});

test('Play on a one-day garden returns to Live immediately', () => {
  let entered = 0, starts = 0;
  const context = vm.createContext({
    sessions: [{}], maxDay: 0, liveMode: true,
    playback: { state: () => ({ playing: false }), play() { starts++; } },
    enterLive() { entered++; }, dismiss() {}, leaveLive() {},
    resumeAmbientCamera() {}, syncPlaybackControls() {}, day: 0,
  });
  vm.runInContext(functionSource('playHistory'), context);
  vm.runInContext('playHistory()', context);
  assert.equal(entered, 1);
  assert.equal(starts, 0);
});

function inspectionNodes() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, children: [], dataset: {}, style: {},
      appendChild(child) { this.children.push(child); }, setAttribute() {},
      getAttribute() { return null; }, addEventListener() {}, remove() {} });
    return nodes.get(id);
  };
  return { node, document: { createElement: () => node(Symbol()), querySelector: () => node('rail') } };
}

test('tree inspection opens its own conversation in History and Live without choosing a child', () => {
  for (const liveMode of [false, true]) {
    const { node, document } = inspectionNodes(), requests = [];
    const root = { id: 'root', members: [], createdAt: '2026-09-24T00:00:00Z' };
    const context = vm.createContext({ liveMode, selected: root, selectedAgentId: null,
      sessions: [root], mapSession: 'root', pinnedMap: 'root',
      liveState: { agentsFor: () => [], agentState: () => null },
      treeAgents: () => [], agentRecord: () => null,
      messagesPager: { state: () => ({}), select: (...ids) => requests.push(ids) },
      $: node, document });
    vm.runInContext(functionSource('renderAgentDetails'), context);
    context.renderAgentDetails();
    assert.equal(node('live-messages').hidden, false, 'the selected tree shows its conversation');
    assert.deepEqual(requests, [['root', 'root']], 'request the primary session, not an arbitrary child');
  }
});

test('history draws every real child and keeps the same birds on entry to Live', async () => {
  const { createGardenFlock } = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(directory + 'garden-flock.js')).toString('base64'));
  const agents = Array.from({ length: 5 }, (_, i) => ({ id: 'child-' + i, isSubagent: true, rootSessionId: 'root' }));
  const root = { id: 'root', agents: [0, 0, 0, 0, 0], members: agents };
  const flock = createGardenFlock();
  const context = vm.createContext({ liveMode: false, pinnedMap: null, hoverSession: null,
    renderedTrees: [{ s: root, distance: 0 }], day: 0, anchorsOnScreen: new Map([['root', { x: 20, y: 80, bounds: { w: 30, h: 50 } }]]),
    treeGrowth: { sample: () => ({ crown: 1 }) }, cloudArrivals: { entries: () => [] },
    performance: { now: () => 100 }, motion: true, motionPreference: { matches: false },
    boidTrails: true, liveState: { agentsFor: () => agents }, treeAgents: () => agents,
    flock, updateBirdTargets() {}, canvas: { dataset: {} },
    ctx: { globalAlpha: 1, setLineDash() {}, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {}, fill() {}, translate() {}, rotate() {} } });
  vm.runInContext(functionSource('drawMoths'), context);
  context.drawMoths(0); context.drawMoths(100);
  assert.deepEqual(flock.state().map(bird => bird.key), agents.map(agent => agent.id));
  const before = flock.state();
  context.liveMode = true; context.drawMoths(100);
  assert.deepEqual(flock.state(), before, 'mode change preserves positions, trails, and identity');
});

test('historical boids have clickable targets for their real subagent', () => {
  const { node, document } = inspectionNodes(), buttons = new Map();
  const child = { id: 'child', nickname: 'Builder' };
  const context = vm.createContext({ liveMode: false, flock: { state: () => [{ key: 'child', screen: { x: 20, y: 40 } }] },
    liveState: { agent: () => child }, agentRecord: () => child, selectedAgentId: null,
    birdTargetButtons: buttons, $: node, document });
  vm.runInContext(functionSource('updateBirdTargets'), context);
  context.updateBirdTargets();
  assert.equal(buttons.size, 1, 'each historical child has a target');
});

test('boid selection pauses history and a same-tree click restores the primary conversation', () => {
  const { node, document } = inspectionNodes(), requests = [];
  const child = { id: 'child', rootSessionId: 'root', isSubagent: true };
  const root = { id: 'root', members: [child] };
  let paused = 0;
  document.querySelectorAll = () => [];
  const context = vm.createContext({ liveMode: false, selected: root, selectedAgentId: null,
    hoverTreeId:'root', botanical:{setHovered(){}}, performance:{now:()=>100},
    sessions: [root], mapSession: null, pinnedMap: null, pinnedPath: null, leaveTimer: null,
    liveState: { agentState: () => null }, agentRecord: id => id === 'child' ? child : root,
    treeAgents: () => [child], messagesPager: { state: () => ({}), select: (...ids) => requests.push(ids) },
    playback: { pause() { paused++; } }, stopFlight() {}, syncPlaybackControls() {}, clearTimeout() {},
    files: () => [], revealMap() {}, rebuild() {}, updateMap() {}, drawArcs() {}, updateBirdTargets() {},
    updateCard() { context.renderAgentDetails(); }, $: node, document });
  vm.runInContext(['setTreeHover', 'selectAgent', 'pin', 'parentDepth', 'formatDuration', 'renderAgentDetails'].map(functionSource).join('\n'), context);
  context.selectAgent('child');
  assert.equal(paused, 1);
  assert.equal(context.selectedAgentId, 'child');
  assert.equal(node('rail').hidden, false);
  assert.deepEqual(requests, [['root', 'child']]);
  context.pin(root);
  assert.equal(context.selectedAgentId, null);
  assert.equal(node('agent-detail').hidden, true);
  assert.deepEqual(requests.at(-1), ['root', 'root']);
});

test('real agent membership follows the history date and excludes guardian records', () => {
  const past = { id: 'past', isSubagent: true, createdAt: '2026-09-22' };
  const future = { id: 'future', isSubagent: true, createdAt: '2026-09-24' };
  const guardian = { id: 'guardian', isSubagent: true, isGuardian: true, createdAt: '2026-09-22' };
  const records = new Map([past, future, guardian].map(a => [a.id, a]));
  const context = vm.createContext({ liveMode: false, day: 0, sessionRecords: records,
    atDay: at => (Date.parse(at)-Date.parse('2026-09-22'))/86400000,
    liveState: { agent: () => null } });
  vm.runInContext(functionSource('agentRecord')+'\n'+functionSource('treeAgents'), context);
  const tree = { members: [past, future, guardian] };
  assert.deepEqual(Array.from(context.treeAgents(tree), a => a.id), ['past']);
  context.day = 2;
  assert.deepEqual(Array.from(context.treeAgents(tree), a => a.id), ['past', 'future']);
  context.liveMode = true;
  assert.deepEqual(Array.from(context.treeAgents(tree), a => a.id), ['past', 'future']);
});
