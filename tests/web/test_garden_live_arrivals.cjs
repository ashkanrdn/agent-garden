const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const dir = 'web/';
const source = fs.readFileSync(dir + 'canvas-garden.js', 'utf8');
const extract = name => { const start = source.indexOf(`function ${name}(`), end = source.indexOf('\nfunction ', start + 1); return source.slice(start, end); };
const load = name => import(pathToFileURL(path.resolve(dir, name)).href);

async function fixture() {
  const { createCloudArrivals } = await load('procedural-clouds.js');
  const { createTreeGrowth } = await load('tree-growth.js');
  const old = { id: 'old', projectId: 'garden' }, fresh = { id: 'new', projectId: 'garden' };
  const cloudArrivals = createCloudArrivals(), treeGrowth = createTreeGrowth(), flights = [];
  cloudArrivals.sync([old], { animate: false });
  treeGrowth.sync([{ id: old.id, score: 1 }], 0, { animate: false });
  const state = { sourceData: { sessions: [old], projects: [] }, sessions: [old], visibleSessions: [old], selected: null,
    liveState: { snapshot: () => ({ sessions: [old, fresh], projects: [] }) }, liveMode: true,
    motion: true, motionPreference: { matches: false }, document: { hidden: false }, maxDay: 2, day: 2,
    playback: { pause() {}, state: () => ({ playing: false, day: 2 }), advance: () => ({day:2}), getSpeed: () => 1 },
    performance: { now: () => 1000 },
    deriveGardenRecords(data) { state.sessions = data.sessions; }, prepareWorld() { state.visibleSessions = state.sessions; },
    spawnHold: { size: 0, hold() {} }, treeGrowth, cloudArrivals, work: () => 1,
    buildWorldScene() {}, gardenLayout: {}, treePlacements: [], layoutMotion: { active: false, retarget() {} },
    modelCache: { clear() {} }, rebuild() {}, updateCard() {}, updateMap() {}, drawArcs() {},
    renderProjectSelect() {}, syncPlaybackControls() {}, syncSpawnCards() {}, waitForLiveGrowth() {},
    flyToLiveArrivals: ids => flights.push([...ids]), cloudTextureRequested: true,
    cameraFrame: 0, lastFrame: 0, lastAnimationTime: 0, scrubbing: false, arrival: null, showcase: null,
    spawnShots: { size: 0 }, flight: null, dirty: false, decorationTime: 0, dynamicFrames: 0,
    frameTimings: [], sceneRebuilds: 0, lastRebuildMs: 0, maxRebuildMs: 0, lastDrawMs: 0,
    canvas: { dataset: {} }, requestAnimationFrame() {}, advanceCamera() {}, advanceVisualScene() {}, settleScene() {}, drawDynamic() {},
  };
  const context = vm.createContext(state);
  vm.runInContext(extract('liveGeometryKey') + '\n' + extract('mergeLiveEvidence'), context);
  const start = source.indexOf('function frame(');
  vm.runInContext(source.slice(start, source.indexOf('\nwindow.canvasGarden', start)), context);
  const change = { projectIds: [], sessionIds: ['new'], agentIds: [], snapshot: false };
  return { state, context, cloudArrivals, flights, change };
}

test('a live session starts weather and flies before growth finishes', async () => {
  const h = await fixture(); h.context.mergeLiveEvidence(h.change);
  assert.deepEqual(h.cloudArrivals.entries().map(item => item.id), ['new']);
  assert.deepEqual(h.flights, [['new']]);
  assert.equal(h.cloudArrivals.entries()[0].state.elapsed, 0);
});

test('live weather advances with history paused, then finishes', async () => {
  const h = await fixture();
  h.cloudArrivals.sync([{id:'old',projectId:'garden'}, {id:'new',projectId:'garden'}]);
  h.context.frame(1000); h.context.frame(1100);
  assert.equal(h.cloudArrivals.entries()[0].state.elapsed, 100);
  for(let t=1200;t<=17000;t+=100) h.context.frame(t);
  assert.equal(h.cloudArrivals.active, false);
});

test('snapshots do not replay arrivals or move the camera', async () => {
  const h = await fixture(); h.context.mergeLiveEvidence({...h.change, snapshot:true});
  assert.equal(h.cloudArrivals.active, false); assert.deepEqual(h.flights, []);
});


test('live weather waits for flight and ground, while paused History stays paused', async () => {
  const h = await fixture();
  h.cloudArrivals.sync([{id:'old',projectId:'garden'}, {id:'new',projectId:'garden'}]);
  h.state.flight={liveArrival:true}; h.context.frame(1000); h.context.frame(1100);
  assert.equal(h.cloudArrivals.entries()[0].state.elapsed,0);
  h.state.flight=null; h.state.layoutMotion.active=true; h.context.frame(1200);
  assert.equal(h.cloudArrivals.entries()[0].state.elapsed,0);
  h.state.layoutMotion.active=false; h.context.frame(1300);
  assert.equal(h.cloudArrivals.entries()[0].state.elapsed,100);
  h.state.liveMode=false; h.context.frame(1400);
  assert.equal(h.cloudArrivals.entries()[0].state.elapsed,100);
});

test('card selection flies to measured tree bounds even with the inspector open', async () => {
  const {projectGround} = await load('garden-robot-camera.js');
  const {cardFlightPlan} = await load('garden-flight.js');
  const tree={s:{id:'tree'},x:400,y:200};
  const c=vm.createContext({ selected:tree.s, displayedTrees:()=>[tree], stopFlight(){}, resize(){},
    viewRect:()=>({x:280,y:32,w:688,h:600}), treeElevation:()=>30, projectGround, cardFlightPlan,
    botanical:{settledBounds:(s,root)=>({bounds:{x:root.x-60,y:root.y-240,w:120,h:240}})},
    W:1000,H:800,camera:{x:0,y:0,yaw:.2,zoom:.2},mapSession:'tree',flight:null,
    motion:true,motionPreference:{matches:false},document:{hidden:false},performance:{now:()=>10},
    syncTour(){},requestCameraDraw(){},
  });
  vm.runInContext(extract('moveCamera')+'\n'+extract('focusSelected'),c);c.focusSelected();
  assert.ok(c.flight,'the open inspector must not turn flight into an instant jump');
  assert.ok(c.flight.cardPath && c.flight.duration > 1100, 'card clicks use the scenic path');
  const root=projectGround(400,200,.2,30), target=c.flight.to;
  assert.equal(target.zoom,1.8);
  assert.ok(Math.abs(500+(root.x-target.x)*target.zoom-624)<1e-8);
  assert.ok(Math.abs(400+(root.y-120-target.y)*target.zoom-332)<1e-8);
  c.flight=null;c.motionPreference.matches=true;c.focusSelected();
  assert.equal(c.flight,null);assert.equal(c.camera.zoom,1.8);
});

test('live camera departure includes all fresh trees and holds growth until landing', () => {
  const calls=[],c=vm.createContext({motion:true,motionPreference:{matches:false},document:{hidden:false},
    camera:{yaw:.4,auto:true},flight:null,layoutMotion:{active:false},
    stopFlight(){calls.push('stop')},dismiss(){calls.push('dismiss')},resize(){calls.push('resize')},
    cloudFitFraming:(_urgent,ids)=>{calls.push([...ids]);return {center:{x:2,y:3},zoom:1.2,lift:10}},
    projectGround:(x,y)=>({x,y}),moveCamera:to=>{c.flight={to}},spawnHold:{hold:(ids,active)=>calls.push({ids:[...ids],active})},
  });
  vm.runInContext(extract('flyToLiveArrivals'),c);c.flyToLiveArrivals(['a','b']);
  assert.deepEqual(calls.slice(0,4),['stop','dismiss','resize',['a','b']]);
  assert.equal(c.flight.liveArrival,true);assert.equal(calls.at(-1).active,true);
  assert.equal(c.idleAfter,0);assert.equal(c.droneAfter,0);
});
