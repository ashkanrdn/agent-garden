const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('web/canvas-garden.js', 'utf8');
const start = source.indexOf('function hoverSummary(');
const end = source.indexOf('\nfunction updateCard(', start);
const hoverSummarySource = source.slice(start, end);

function summary(session, project) {
  const context = vm.createContext({
    projects: [project],
    day: 12,
    files: () => session.fileEvents.filter(([, at]) => at <= 12).map(([path]) => path),
    shownScore: () => '7.4',
  });
  vm.runInContext(hoverSummarySource, context);
  context.session = session;
  return vm.runInContext('hoverSummary(session)', context);
}

test('hover summary states no files and unavailable Git without truncating the title', () => {
  const title = 'A very long session title remains readable in the hover summary';
  const text = summary({ p: 0, title, commits: [], agents: [], fileEvents: [] }, { name: 'Archive 5', gitAvailable: false });
  assert.match(text, /Archive 5 \/ A very long session title remains readable in the hover summary/);
  assert.match(text, /7\.4 work score/);
  assert.match(text, /no recorded changed files/);
  assert.match(text, /0 owned commits/);
  assert.match(text, /0 agent boids/);
  assert.match(text, /Git unavailable/);
  assert.match(text, /Click to inspect/);
});

test('hover summary counts measured files and owned commits at the playhead', () => {
  const text = summary({ p: 0, title: 'Measured session', commits: [{ day: 11 }, { day: 13 }], agents: [10, 13], fileEvents: [['src/a.ts', 4], ['src/b.ts', 12]] }, { name: 'Canopy 3', gitAvailable: true });
  assert.match(text, /2 changed files/);
  assert.match(text, /1 owned commits/);
  assert.match(text, /1 agent boids/);
  assert.match(text, /Git evidence available/);
});


test('tree pointer hover forwards identity, rejects hill-hidden pixels, and clears before inspector grace', () => {
  const begin=source.indexOf('function setTreeHover('),end=source.indexOf('function preview(',begin),calls=[];
  const context=vm.createContext({hoverTreeId:null,hoverSession:null,pointerGesture:null,dirty:false,
    performance:{now:()=>100},botanical:{setHovered:(id,time)=>calls.push([id,time])},terrainHidesTree:()=>false,
    preview:s=>{context.hoverSession=s.id;},scheduleLeave:()=>calls.push('inspector-grace')});
  assert.ok(begin>=0,'live garden has an immediate visual-hover boundary');
  vm.runInContext(source.slice(begin,end),context);
  context.previewTree({id:'tree-a'},{clientX:10,clientY:20});
  assert.equal(calls[0][0],'tree-a');assert.equal(context.dirty,true);
  context.terrainHidesTree=()=>true;
  context.previewTree({id:'tree-a'},{clientX:10,clientY:90});
  assert.equal(calls.at(-2)[0],null);assert.equal(calls.at(-1),'inspector-grace');
  context.setTreeHover('tree-b');context.leaveTree();
  assert.equal(context.hoverTreeId,null);assert.equal(calls.at(-2)[0],null);
  assert.equal(context.hoverSession,'tree-a','inspector retains its existing grace period');
});
