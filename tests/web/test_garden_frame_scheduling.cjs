const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('web/canvas-garden.js', 'utf8');
const extract = name => {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end);
};

function fixture({ orbit = false, lastFrame = 0 } = {}) {
  const callbacks = [], events = [];
  const state = {
    document: { hidden: false }, performance: { now: () => 100 },
    cameraFrame: 0, lastFrame, lastAnimationTime: 0, motion: orbit,
    liveMode: false, playback: null, scrubbing: false, arrival: null, showcase: null,
    cloudArrivals: { active: false, advance() {} }, spawnShots: { size: 0 },
    motionPreference: { matches: false }, flight: null, dirty: false,
    decorationTime: 0, dynamicFrames: 0, frameTimings: [], sceneRebuilds: 0,
    lastRebuildMs: 0, maxRebuildMs: 0, lastDrawMs: 0, canvas: { dataset: {} },
    requestAnimationFrame(callback) { callbacks.push(callback); return callbacks.length; },
    advanceCamera() {}, settleScene() {},
    advanceVisualScene() { if (orbit) state.rebuild({ cameraOnly: true }); },
    rebuild() { state.sceneRebuilds++; state.dirty = true; events.push('rebuild'); },
    updateMap() { events.push('map'); }, drawArcs() { events.push('arcs'); },
    drawDynamic() { state.dirty = false; events.push('draw'); },
  };
  const context = vm.createContext(state);
  vm.runInContext(extract('requestCameraDraw'), context);
  const start = source.indexOf('function frame(');
  vm.runInContext(source.slice(start, source.indexOf('\nwindow.canvasGarden', start)), context);
  // The main animation callback is already queued when input arrives.
  callbacks.push(context.frame);
  return {
    context, events, callbacks,
    tick(time) { const current = callbacks.splice(0); for (const callback of current) callback(time); },
  };
}

test('a burst of camera input rebuilds and draws within the next display callback', () => {
  const h = fixture();
  for (let i = 0; i < 50; i++) h.context.requestCameraDraw();
  h.tick(100);
  assert.deepEqual(h.events, ['rebuild', 'map', 'arcs', 'draw']);
  assert.equal(h.callbacks.length, 1, 'only the main animation loop remains queued');
  h.tick(117);
  assert.equal(h.context.sceneRebuilds, 1, 'no stale input rebuild in the next frame');
});

test('held spin shares the orbit rebuild instead of rebuilding twice', () => {
  const h = fixture({ orbit: true });
  h.context.requestCameraDraw();
  h.tick(100);
  assert.equal(h.context.sceneRebuilds, 1);
  assert.deepEqual(h.events, ['rebuild', 'map', 'arcs', 'draw']);
});

test('input is drawn on the next display callback even inside the animation throttle', () => {
  const h = fixture({ lastFrame: 100 });
  h.context.requestCameraDraw();
  h.tick(108);
  assert.deepEqual(h.events, ['rebuild', 'map', 'arcs', 'draw']);
});

test('water and sparkle clocks freeze for Motion off, reduced motion, and hidden tabs',()=>{
 const h=fixture({orbit:true});h.tick(100);h.tick(117);assert.equal(h.context.decorationTime,17);
 h.context.motion=false;h.tick(134);assert.equal(h.context.decorationTime,17);
 h.context.motion=true;h.context.motionPreference.matches=true;h.tick(151);assert.equal(h.context.decorationTime,17);
 h.context.motionPreference.matches=false;h.context.document.hidden=true;h.tick(8000);assert.equal(h.context.decorationTime,17);
 // The visibility handler discards elapsed hidden time before the first visible frame.
 assert.match(source,/else\{advanceLiveClock\(\);lastAnimationTime=0;resumeAmbientCamera\(\)\}/);
 h.context.document.hidden=false;h.context.lastAnimationTime=0;h.tick(9000);assert.equal(h.context.decorationTime,17);
 h.tick(9017);assert.equal(h.context.decorationTime,34);
});
