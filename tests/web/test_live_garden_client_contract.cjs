const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const fs = require('node:fs');

let createGardenLiveState, createGardenFlock;
before(async () => {
  const load = async path => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path, 'utf8')).toString('base64'));
  ({ createGardenLiveState } = await load('web/garden-live-state.js'));
  ({ createGardenFlock } = await load('web/garden-flock.js'));
});

const agent = (id, state, extra = {}) => ({
  id, rootSessionId: 'root', parentId: 'root', isSubagent: true,
  state, lastEventAt: '2026-09-24T10:00:00.000Z',
  turnStartedAt: '2026-09-24T09:59:00.000Z', turnEndedAt: null,
  ...extra,
});
const packet = (revision, agents, extra = {}) => ({
  schemaVersion: 1, revision, observedAt: '2026-09-24T10:00:00.000Z',
  projects: [], sessions: [], agents, ...extra,
});

test('snapshot, upserts, and reconnect preserve each child identity without duplicate agents', () => {
  const live = createGardenLiveState();
  const first = live.apply(packet(4, [agent('child-a', 'working'), agent('child-b', 'waiting')]), { snapshot: true });
  assert.equal(first.snapshot, true);
  assert.deepEqual(live.agentsFor('root').map(a => a.id).sort(), ['child-a', 'child-b']);

  live.apply(packet(5, [agent('child-a', 'turn-ended', { turnEndedAt: '2026-09-24T10:00:01.000Z' })]));
  assert.deepEqual(live.agentsFor('root').map(a => [a.id, a.state]).sort(), [
    ['child-a', 'turn-ended'], ['child-b', 'waiting'],
  ]);
  assert.equal(live.apply(packet(5, [agent('child-a', 'error')])) , null, 'duplicate revision is ignored');

  live.apply(packet(6, [agent('child-a', 'working')]));
  const reconnect = live.apply(packet(6, [agent('child-a', 'working'), agent('child-b', 'waiting')]), { snapshot: true });
  assert.equal(reconnect.snapshot, true);
  assert.deepEqual(live.agentsFor('root').map(a => a.id).sort(), ['child-a', 'child-b']);
  assert.equal(live.snapshot().agents.length, 2);
});

test('a restarted server may replace state with a lower revision and stale upserts stay rejected', () => {
  const live = createGardenLiveState();
  live.apply(packet(14, [agent('child-a', 'working'), agent('child-old', 'waiting')]), { snapshot: true });
  assert.ok(live.apply(packet(15, [agent('child-a', 'turn-ended')])));
  const restarted = live.apply(packet(2, [agent('child-a', 'working')]), { snapshot: true });
  assert.ok(restarted, 'a full reconnect snapshot resets the old revision');
  assert.equal(live.snapshot().revision, 2);
  assert.deepEqual(live.snapshot().agents.map(a => a.id), ['child-a']);
  assert.equal(live.apply(packet(2, [agent('child-a', 'error')])), null, 'old or duplicate upserts stay rejected');
});

test('quiet is separate from ended and error, and begins at sixty seconds of silence', () => {
  const live = createGardenLiveState();
  live.apply(packet(1, [
    agent('working', 'working'),
    agent('ended', 'turn-ended', { turnEndedAt: '2026-09-24T10:00:00.000Z' }),
    agent('failed', 'error', { turnEndedAt: '2026-09-24T10:00:00.000Z' }),
  ]), { snapshot: true });
  const now = Date.parse('2026-09-24T10:01:00.000Z');
  assert.equal(live.agentState('working', now).quiet, true);
  assert.equal(live.agentState('working', now - 1).quiet, false);
  assert.equal(live.agentState('ended', now).quiet, false);
  assert.equal(live.agentState('failed', now).state, 'error');
});

test('a child bird keeps its key and motion across recorded state changes', () => {
  const flock = createGardenFlock();
  const tree = { id: 'root', x: 100, y: 100, width: 60, height: 50, agents: [agent('child-a', 'working')] };
  const ctx = { setLineDash(){}, save(){}, restore(){}, beginPath(){}, moveTo(){}, lineTo(){}, closePath(){}, stroke(){}, translate(){}, rotate(){}, arc(){}, fill(){} };
  flock.draw(ctx, [tree], 1000);
  const initial = flock.state().find(b => b.key === 'child-a');
  assert.ok(initial);
  assert.equal(initial.perched, false);

  tree.agents = [agent('child-a', 'turn-ended')];
  flock.draw(ctx, [tree], 1100);
  const ended = flock.state().find(b => b.key === 'child-a');
  assert.equal(ended.perched, false);
  assert.notEqual(ended.x, initial.x);
  assert(ended.trailPoints > 0);
  tree.agents = [agent('child-a', 'working')];
  flock.draw(ctx, [tree], 1200);
  assert.deepEqual(flock.state().map(b => [b.key, b.perched]), [['child-a', false]]);
  assert.notEqual(flock.state()[0].x, ended.x);
});
