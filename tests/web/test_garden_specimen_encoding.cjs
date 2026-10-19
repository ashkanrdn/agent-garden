const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { encodeGardenSpecimens } = require('../../web/garden-specimen-encoding.js');

const at = (day, hour = 0) => `2026-01-${String(day + 1).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const options = day => ({ day, cutoffMs: Date.parse(at(day, 23)) + 3599999 });
const member = (id, extra = {}) => ({ id, createdAt: at(0), activity: [], ...extra });
function root(id = 'root', extra = {}) {
  return {
    id, projectId: 'project', birth: 0, createdAt: at(0), updatedAt: at(0, 1),
    workByDay: new Float64Array([4, 5, 6]), members: [member(id)], fileMap: new Map(), ...extra
  };
}

test('derived roots use canonical work and merged paths, counting each real descendant once', () => {
  const child = member('child', { isSubagent: true, rootSessionId: 'root',
    activity: [{ kind: 'tool', count: 4, at: at(0, 1) }] });
  const nested = member('nested', { isSubagent: true, rootSessionId: 'root', parentSessionId: 'child',
    activity: [{ kind: 'turn', count: 2, at: at(0, 2) }] });
  const session = root('root', {
    // These are already aggregated evidence and must never be folded again.
    activity: [{ kind: 'tool', count: 999, at: at(0) }], tools: 999, ownedCommits: 999,
    commits: [{ day: 0, ownership: 'verified' }, { day: 0, ownership: 'unknown' }],
    members: [member('root', { activity: [{ kind: 'tool', count: 3, at: at(0) }] }), child, nested, child,
      member('guardian', { isSubagent: true, isGuardian: true,
        activity: [{ kind: 'tool', count: 999, at: at(0) }] })],
    fileMap: new Map([['src/a.js', { events: [{ kind: 'add', day: 0 }, { kind: 'modify', day: 0 },
      { kind: 'add', day: 0 }] }], ['src/b.js', { events: [{ kind: 'modify', day: 0 }] }]])
  });
  const encoded = encodeGardenSpecimens([session, child, root('guardian-root', { isGuardian: true })], options(0));
  assert.ok(encoded instanceof Map);
  assert.equal(encoded.size, 1);
  assert.deepEqual(encoded.get('root'), {
    id: 'root', project: 'project', species: 'orchestration', sizeClass: 0, density: 'sparse', fruit: 2,
    subagents: ['child', 'nested'],
    metrics: { workScore: 4, tools: 7, turns: 2, agents: 2, durationHours: 1,
      toolsPerHour: 7, distinctFiles: 2, filesCreated: 2 },
    visualKey: 'orchestration:0:sparse:2'
  });
});

test('hourly activity buckets on the birth day retain work before the exact birth minute', () => {
  const session = root('root', { createdAt: at(0).replace('00:00:00', '00:30:00'),
    members: [member('root', { activity: [{ kind: 'tool', count: 3, at: at(0) }] })] });
  assert.equal(encodeGardenSpecimens([session], options(0)).get('root').metrics.tools, 3);
});

test('history excludes future births and file events, clamps duration, and rewinds exactly', () => {
  const session = root('root', { updatedAt: at(2, 20), members: [member('root', { activity: [
    { kind: 'tool', count: 3, at: at(0) }, { kind: 'tool', count: 7, at: at(1) }
  ] }), member('child', { isSubagent: true, rootSessionId: 'root', createdAt: at(1) })],
  fileMap: new Map([
    ['existing', { events: [{ kind: 'modify', day: 0, at: at(0) }, { kind: 'add', day: 1, at: at(1) }] }],
    ['future', { events: Array.from({ length: 8 }, () => ({ kind: 'add', day: 1, at: at(1) })) }]
  ]) });
  const cohort = [session, root('future-root', { birth: 1, createdAt: at(1) })];
  const firstOptions = { day: 0, cutoffMs: Date.parse(at(0, 2)) };
  const before = structuredClone(cohort);
  const first = encodeGardenSpecimens(cohort, firstOptions);
  assert.equal(first.size, 1);
  assert.equal(first.get('root').species, 'build');
  assert.equal(first.get('root').metrics.durationHours, 2);
  assert.equal(first.get('root').metrics.tools, 3);
  assert.equal(first.get('root').metrics.distinctFiles, 1);
  assert.equal(first.get('root').fruit, 0);
  assert.deepEqual(first.get('root').subagents, []);
  const next = encodeGardenSpecimens(cohort, options(1));
  assert.equal(next.size, 2);
  assert.equal(next.get('root').metrics.workScore, 5);
  assert.equal(next.get('root').metrics.tools, 10);
  assert.equal(next.get('root').metrics.distinctFiles, 2);
  assert.equal(next.get('root').metrics.filesCreated, 9);
  assert.equal(next.get('root').fruit, 5);
  assert.deepEqual(next.get('root').subagents, ['child']);
  assert.equal(encodeGardenSpecimens(cohort, options(2)).get('root').metrics.durationHours, 68);
  assert.deepEqual(encodeGardenSpecimens(cohort, firstOptions), first);
  assert.deepEqual(cohort, before);
});

test('cohort ranks and map order remain stable under input, member, and path reordering', () => {
  const cohort = Array.from({ length: 15 }, (_, i) => root(`s${String(i).padStart(2, '0')}`));
  const encoded = encodeGardenSpecimens(cohort, options(0));
  assert.deepEqual(encodeGardenSpecimens(cohort.slice().reverse(), options(0)), encoded);
  assert.deepEqual([...encoded.values()].map(item => item.sizeClass), [0,0,0,1,1,1,2,2,2,3,3,3,4,4,4]);
  const session = root('root', { members: [member('root'),
    member('b', { isSubagent: true, rootSessionId: 'root' }),
    member('a', { isSubagent: true, rootSessionId: 'root' })],
    fileMap: new Map([['b', { events: [{ kind: 'add', day: 0 }] }], ['a', { events: [{ kind: 'add', day: 0 }] }]]) });
  const original = encodeGardenSpecimens([session], options(0));
  session.members.reverse();
  session.fileMap = new Map([...session.fileMap].reverse());
  assert.deepEqual(encodeGardenSpecimens([session], options(0)), original);
});

test('visibility and metadata cannot rerank the full cohort or change visual keys', () => {
  const cohort = Array.from({ length: 10 }, (_, i) => root(`s${i}`, { projectId: i < 5 ? 'a' : 'b' }));
  const original = encodeGardenSpecimens(cohort, options(0));
  const decorated = cohort.map(session => ({ ...session, title: 'Changed title', visible: false,
    matchesSearch: false, inDateBrush: false, projectSelected: false }));
  assert.deepEqual(encodeGardenSpecimens(decorated, { ...options(0), projectFilter: 'a', searchFilter: 'missing',
    timeRange: [1, 2] }), original);
  const updated = encodeGardenSpecimens(cohort.map(session => ({ ...session, updatedAt: at(0, 2) })), options(0));
  assert.notEqual(updated.get('s0').metrics.durationHours, original.get('s0').metrics.durationHours);
  assert.equal(updated.get('s0').visualKey, original.get('s0').visualKey);
});

test('duration, membership, work, density, and add-event changes update the visible channels', () => {
  const session = root();
  const get = value => encodeGardenSpecimens([value], options(0)).get('root');
  const original = get(session);
  assert.equal(get({ ...session, updatedAt: at(0, 4) }).species, 'slow-burn');
  assert.notEqual(get({ ...session, updatedAt: at(0, 4) }).visualKey, original.visualKey);
  const members = [member('root'), ...['a', 'b'].map(id => member(id, { isSubagent: true, rootSessionId: 'root' }))];
  assert.equal(get({ ...session, members }).species, 'orchestration');
  assert.notEqual(get({ ...session, members }).visualKey, original.visualKey);
  assert.equal(get({ ...session, workByDay: [1] }).species, 'quick');
  assert.notEqual(get({ ...session, fileMap: new Map([['new', { events: [{ kind: 'add', day: 0 }] }]]) }).visualKey,
    original.visualKey);
  const cohort = [root('a'), root('b'), root('c')];
  const before = encodeGardenSpecimens(cohort, options(0));
  cohort[0].fileMap.set('new', { events: [{ kind: 'modify', day: 0 }] });
  cohort[0].workByDay[0] = 10;
  const after = encodeGardenSpecimens(cohort, options(0));
  assert.equal(after.get('a').density, 'dense');
  assert.equal(after.get('a').sizeClass, 3);
  assert.notEqual(before.get('b').visualKey, after.get('b').visualKey);
});

test('malformed dates and empty cohorts have deterministic results without a wall clock', () => {
  assert.deepEqual(encodeGardenSpecimens([], options(0)), new Map());
  assert.deepEqual(encodeGardenSpecimens(null, options(0)), new Map());
  assert.deepEqual(encodeGardenSpecimens([root()], { day: 0, cutoffMs: NaN }), new Map());
  assert.deepEqual(encodeGardenSpecimens([root()], { day: -1, cutoffMs: 0 }), new Map());
  const session = root('root', { createdAt: 'invalid', updatedAt: 'invalid', members: [
    member('bad-child', { isSubagent: true, rootSessionId: 'root', createdAt: 'invalid' }),
    member('root', { activity: [{ kind: 'tool', count: 3, at: 'invalid' },
      { kind: 'turn', count: -3, at: at(0) }, { kind: 'turn', count: Infinity, at: at(0) }] })
  ], fileMap: new Map([['bad', { events: [{ kind: 'add', day: 0, at: 'invalid' }] }]]) });
  const encoded = encodeGardenSpecimens([session, root('unknown-birth', { createdAt: 'invalid', birth: undefined })], options(0));
  assert.equal(encoded.size, 1);
  assert.equal(encoded.get('root').metrics.durationHours, 0);
  assert.equal(encoded.get('root').metrics.tools, 0);
  assert.equal(encoded.get('root').metrics.turns, 0);
  assert.equal(encoded.get('root').metrics.distinctFiles, 0);
  assert.deepEqual(encoded.get('root').subagents, []);
});

test('browser side-effect modules expose encoding without a DOM or wall clock', () => {
  const context = vm.createContext({ Date: class extends Date { static now() { throw Error('Wall clock used'); } } });
  for (const file of ['garden-specimen-data.js', 'garden-specimen-encoding.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../web', file), 'utf8'), context);
  }
  const encoded = context.GardenSpecimenEncoding.encodeGardenSpecimens([root()], options(0));
  assert.equal(encoded.get('root').species, 'build');
  assert.equal(encoded.get('root').metrics.workScore, 4);
});
