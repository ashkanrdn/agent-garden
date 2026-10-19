const fs = require('node:fs');
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
let createCloud, sampleArrival, createCloudArrivals, projectPoint;
before(async () => {
  const source = fs.readFileSync('web/procedural-clouds.js', 'utf8');
  ({ createCloud, sampleArrival, createCloudArrivals, projectPoint } = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')));
});
test('stable seeds retain shape and distinct sessions vary it', () => {
  assert.deepEqual(createCloud('session-47'), createCloud('session-47'));
  assert.notDeepEqual(createCloud('session-47'), createCloud('session-48'));
  for (const layer of createCloud('session-47').plates) {
    assert.equal(layer.outline.length,96);
    assert.ok(layer.outline.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
  }
});
test('clouds gather before rain and tree growth; all motion settles', () => {
  assert.equal(sampleArrival(0).cloud,0);
  assert.ok(sampleArrival(2000).cloud>0);
  assert.equal(sampleArrival(2000).rain,0);
  assert.equal(sampleArrival(2000).trunk,0);
  const mid=sampleArrival(6000);assert.ok(mid.rain>0&&mid.trunk>mid.branches&&mid.crown===0);
  const final=sampleArrival(14000);
  assert.equal(final.active,false);assert.equal(final.cloud,0);assert.equal(final.rain,0);assert.equal(final.crown,1);
  const reduced=sampleArrival(4000,{reducedMotion:true});
  assert.equal(reduced.active,false);assert.equal(reduced.cloud,0);assert.equal(reduced.crown,1);
});
test('a full yaw returns the projected point to its start', () => {
  const p={x:14,y:26,z:80},a=projectPoint(p,{yaw:.3}),b=projectPoint(p,{yaw:.3+Math.PI*2});
  assert.ok(Math.hypot(a.x-b.x,a.y-b.y)<1e-10);
});
test('baseline and refresh do not replay existing identities, and crowds stay bounded', () => {
  const queue=createCloudArrivals();queue.sync([{id:'old',projectId:'p'}]);assert.equal(queue.active,false);
  const items=[{id:'old',projectId:'p'},...Array.from({length:20},(_,i)=>({id:'new-'+i,projectId:'p'+i}))];
  queue.sync(items);assert.equal(queue.entries().length,3);
  queue.advance(14000);assert.equal(queue.active,false);
  queue.sync(items);assert.equal(queue.active,false);
  queue.sync([],{reset:true});queue.sync(items);assert.equal(queue.active,true);
});
test('one arrival per project and clocks honor pause, hidden pages, speed and motion preference', () => {
  const queue=createCloudArrivals();queue.sync([]);
  queue.sync([{id:'a',projectId:'p'},{id:'b',projectId:'p'}]);assert.equal(queue.entries().length,1);
  queue.advance(1000);assert.equal(queue.entries()[0].state.elapsed,1000);
  queue.advance(9000,{playing:false});queue.advance(9000,{hidden:true});
  assert.equal(queue.entries()[0].state.elapsed,1000);
  queue.advance(2000,{speed:2});assert.equal(queue.entries()[0].state.elapsed,5000);
  queue.advance(0,{reducedMotion:true});assert.equal(queue.active,false);
});

test('5× and 10× arrival clocks finish at the expected time and report completion once', () => {
  for (const [speed, duration] of [[5, 2800], [10, 1400]]) {
    const completed = [], queue = createCloudArrivals({ onComplete: id => completed.push(id) });
    queue.sync([]);
    queue.sync([{ id: 'new-session', projectId: 'project-a' }]);
    queue.advance(duration - 1, { speed });
    assert.equal(queue.entries()[0].state.elapsed, 14000 - speed);
    assert.deepEqual(completed, []);
    queue.advance(1, { speed });
    assert.equal(queue.active, false);
    assert.deepEqual(completed, ['new-session']);
    queue.advance(1000, { speed });
    assert.deepEqual(completed, ['new-session']);
  }
});
