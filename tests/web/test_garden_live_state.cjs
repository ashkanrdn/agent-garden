const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('web/garden-live-state.js', 'utf8');
const ready = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('live snapshots replace a restarted server revision, while stale upserts stay ignored', async () => {
  const { createGardenLiveState } = await ready;
  const state = createGardenLiveState();
  state.apply({ schemaVersion: 1, revision: 9, agents: [{ id: 'old', isSubagent: true, rootSessionId: 'root' }] }, { snapshot: true });
  state.apply({ schemaVersion: 1, revision: 2, agents: [
    { id: 'new', isSubagent: true, rootSessionId: 'root' },
    { id: 'guardian', isSubagent: true, isGuardian: true, rootSessionId: 'root' },
  ] }, { snapshot: true });
  assert.equal(state.agent('old'), undefined);
  assert.deepEqual(state.agentsFor('root').map(agent => agent.id), ['new']);
  assert.equal(state.apply({ schemaVersion: 1, revision: 2, agents: [{ id: 'stale' }] }), null);
  state.apply({ schemaVersion: 1, revision: 3, agents: [{ id: 'later', isSubagent: true, rootSessionId: 'root' }] });
  assert.deepEqual(state.agentsFor('root').map(agent => agent.id), ['new', 'later']);
});

test('quiet and turn time stay separate from the last recorded state', async () => {
  const { createGardenLiveState } = await ready;
  const state = createGardenLiveState();
  state.apply({ schemaVersion: 1, revision: 1, agents: [
    { id: 'working', isSubagent: true, rootSessionId: 'root', state: 'waiting', lastEventAt: '2026-09-24T12:00:00Z', turnStartedAt: '2026-09-24T11:59:00Z', tokensUsed: 120 },
    { id: 'ended', isSubagent: true, rootSessionId: 'root', state: 'turn-ended', lastEventAt: '2026-09-24T12:00:00Z', turnStartedAt: '2026-09-24T11:58:00Z', turnEndedAt: '2026-09-24T12:00:00Z', tokensUsed: 30 },
  ] }, { snapshot: true });
  const now = Date.parse('2026-09-24T12:01:01Z');
  assert.deepEqual([state.agentState('working', now).state, state.agentState('working', now).quiet, state.agentState('working', now).elapsedMs], ['waiting', true, 121000]);
  assert.deepEqual([state.agentState('ended', now).quiet, state.agentState('ended', now).elapsedMs], [false, 120000]);
  assert.equal(state.agentState('working', now).tokensUsed, 120);
});
