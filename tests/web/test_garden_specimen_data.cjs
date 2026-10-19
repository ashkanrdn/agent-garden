const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  THRESHOLDS, FRUIT_CAP, workScore, sessionMetrics, classifySpecies, sizeClasses,
  densityLevel, fruitCount, encodeSessions, encodeMetrics
} = require('../../web/garden-specimen-data.js');

function metrics(overrides = {}) {
  return {
    workScore: 3,
    tools: 0,
    turns: 0,
    agents: 0,
    durationHours: 0,
    toolsPerHour: 0,
    distinctFiles: 0,
    filesCreated: 0,
    ...overrides
  };
}

function rawSession(overrides = {}) {
  return {
    id: 'session',
    activity: [],
    files: [],
    agentIds: [],
    commits: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

test('work score mirrors the garden formula and metrics count events and unique touched paths', () => {
  const session = rawSession({
    activity: [{ kind: 'tool', count: 10 }, { kind: 'turn', count: 2 }, { kind: 'ignored', count: 80 }],
    files: [
      { path: 'a.js', events: [{ kind: 'add' }, { kind: 'modify' }] },
      { path: 'a.js', events: [{ kind: 'add' }] },
      { path: 'b.js', events: [{ kind: 'delete' }] }
    ],
    agentIds: ['agent-a', 'agent-b'],
    commits: [{ ownership: 'verified' }, { ownership: 'unknown' }],
    ownedCommits: 1,
    updatedAt: '2026-01-01T02:00:00.000Z'
  });
  assert.equal(workScore(session), Math.log1p(10 + 2 * 2 + 3 * 2 + 4 * 2 + 5));
  assert.deepEqual(sessionMetrics(session), {
    workScore: workScore(session), tools: 10, turns: 2, agents: 2, durationHours: 2,
    toolsPerHour: 5, distinctFiles: 2, filesCreated: 2
  });
});

test('species rules apply in brief order and honor each strict or inclusive boundary', () => {
  const threshold = THRESHOLDS.quickWorkScore;
  assert.equal(classifySpecies(metrics({ workScore: threshold - 1e-9, agents: 99 })), 'quick');
  assert.equal(classifySpecies(metrics({ workScore: threshold, agents: THRESHOLDS.orchestrationAgents })), 'orchestration');
  assert.equal(classifySpecies(metrics({ agents: THRESHOLDS.orchestrationAgents - 1,
    turns: THRESHOLDS.conversationTurns, tools: THRESHOLDS.conversationToolsPerTurn * THRESHOLDS.conversationTurns - 1 })), 'conversation');
  assert.equal(classifySpecies(metrics({ agents: THRESHOLDS.orchestrationAgents - 1,
    turns: THRESHOLDS.conversationTurns, tools: THRESHOLDS.conversationToolsPerTurn * THRESHOLDS.conversationTurns })), 'build');
  assert.equal(classifySpecies(metrics({ turns: THRESHOLDS.conversationTurns - 1, tools: 0 })), 'build');
  assert.equal(classifySpecies(metrics({ durationHours: THRESHOLDS.slowBurnDurationHours,
    toolsPerHour: THRESHOLDS.slowBurnToolsPerHour - 1 })), 'build');
  assert.equal(classifySpecies(metrics({ durationHours: THRESHOLDS.slowBurnDurationHours + 1,
    toolsPerHour: THRESHOLDS.slowBurnToolsPerHour })), 'build');
  assert.equal(classifySpecies(metrics({ durationHours: THRESHOLDS.slowBurnDurationHours + 1,
    toolsPerHour: THRESHOLDS.slowBurnToolsPerHour - 1 })), 'slow-burn');
  assert.equal(classifySpecies(metrics({ workScore: threshold, agents: 0,
    turns: THRESHOLDS.conversationTurns, tools: 0, durationHours: 8, toolsPerHour: 0 })), 'conversation');
});

test('five work score rank classes are balanced, ordered, and deterministic for ties', () => {
  const sessions = Array.from({ length: 25 }, (_, i) => ({ id: `s${String(i).padStart(2, '0')}`, workScore: i % 3 }));
  const classes = sizeClasses(sessions);
  const counts = [0, 0, 0, 0, 0];
  sessions.forEach(session => counts[classes[session.id]]++);
  assert.deepEqual(counts, [5, 5, 5, 5, 5]);
  const ascending = sessions.slice().sort((a, b) => a.workScore - b.workScore || a.id.localeCompare(b.id));
  for (let i = 1; i < ascending.length; i++) assert.ok(classes[ascending[i - 1].id] <= classes[ascending[i].id]);
  const tied = Array.from({ length: 10 }, (_, i) => ({ id: `tie-${i}`, workScore: 4 }));
  assert.deepEqual(sizeClasses(tied), sizeClasses(tied.slice().reverse()));
  assert.deepEqual(sizeClasses([]), {});
});

test('density ranks distinct file counts into three repeatable groups', () => {
  const population = Array.from({ length: 9 }, (_, i) => ({ id: `d${i}`, ...metrics({ distinctFiles: i }) }));
  const levels = population.map(item => densityLevel(item, population));
  assert.deepEqual(levels, ['sparse', 'sparse', 'sparse', 'medium', 'medium', 'medium', 'dense', 'dense', 'dense']);
  assert.equal(densityLevel(metrics({ distinctFiles: 20 }), []), 'sparse');
});

test('fruit count uses the exported cap and never returns a negative number', () => {
  assert.equal(FRUIT_CAP, 5);
  assert.equal(fruitCount(metrics({ filesCreated: 2 })), 2);
  assert.equal(fruitCount(metrics({ filesCreated: 500 })), FRUIT_CAP);
  assert.equal(fruitCount(metrics({ filesCreated: -3 })), 0);
});

test('encoding excludes subagent trees and folds their recorded work into the primary', () => {
  const primary = rawSession({ id: 'root', projectId: 'project-1', agentIds: ['child'] });
  const child = rawSession({ id: 'child', isSubagent: true, rootSessionId: 'root',
    activity: [{ kind: 'tool', count: 4 }], files: [{ path: 'new.txt', events: [{ kind: 'add' }] }] });
  const unrelated = rawSession({ id: 'other', projectId: 'project-2' });
  const encoded = encodeSessions([primary, child, unrelated]);
  assert.equal(encoded.length, 2);
  assert.deepEqual(encoded.map(item => item.id), ['root', 'other']);
  assert.deepEqual(encoded[0].subagents, ['child']);
  assert.equal(encoded[0].metrics.tools, 4);
  assert.equal(encoded[0].metrics.distinctFiles, 1);
  assert.equal(encoded[0].fruit, 1);
  assert.equal(encoded[0].project, 'project-1');
});

test('browser script publishes the same pure API without a DOM', () => {
  const context = vm.createContext({});
  const source = fs.readFileSync(path.join(__dirname, '../../web/garden-specimen-data.js'), 'utf8');
  vm.runInContext(source, context);
  assert.equal(typeof context.GardenSpecimenData.encodeSessions, 'function');
  assert.equal(context.GardenSpecimenData.classifySpecies(metrics({ workScore: 1 })), 'quick');
});

test('batch metrics rank ties by ID without folding evidence a second time', () => {
  const records = Array.from({ length: 15 }, (_, i) => ({
    id: `s${String(i).padStart(2, '0')}`, project: 'project', subagents: ['child'],
    metrics: metrics({ workScore: 4, distinctFiles: 2, filesCreated: i })
  }));
  const encoded = encodeMetrics(records);
  assert.deepEqual(encoded.map(item => item.sizeClass), [0,0,0,1,1,1,2,2,2,3,3,3,4,4,4]);
  assert.deepEqual(encoded.map(item => item.density), [
    'sparse','sparse','sparse','sparse','sparse','medium','medium','medium','medium','medium',
    'dense','dense','dense','dense','dense'
  ]);
  assert.deepEqual(encodeMetrics(records.slice().reverse()).reverse(), encoded);
  assert.equal(encoded[0].metrics.workScore, 4);
  assert.equal(encoded[14].fruit, 5);
  assert.deepEqual(encodeMetrics([]), []);
});

test('raw sheet encoding retains its record shape and ranks tied density by ID', () => {
  const records = ['c', 'a', 'b'].map(id => rawSession({ id, updatedAt: 'invalid' }));
  const encoded = encodeSessions(records);
  assert.deepEqual(encoded.map(item => item.id), ['c', 'a', 'b']);
  assert.deepEqual(encoded.map(item => item.density), ['dense', 'sparse', 'medium']);
  assert.deepEqual(encodeSessions(records.slice().reverse()).reverse(), encoded);
  assert.deepEqual(Object.keys(encoded[0]).sort(),
    ['density', 'fruit', 'id', 'metrics', 'project', 'sizeClass', 'species', 'subagents']);
  assert.equal(encoded[0].metrics.durationHours, 0);
  assert.deepEqual(encodeSessions([]), []);
});
