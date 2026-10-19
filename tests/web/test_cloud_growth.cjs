const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

let createContourCloud, sampleContourCloud, drawContourCloud, drawStepLeader, field, tangentLoop,
  seedParameters, contourParameters, PARAMETER_RANGES, createCloud, drawCloud, sampleArrival;
before(async () => {
  const url = name => pathToFileURL(path.resolve(__dirname, '../../web/', name)).href;
  ({ createContourCloud, sampleContourCloud, drawContourCloud, drawStepLeader, field, tangentLoop,
    seedParameters, contourParameters, PARAMETER_RANGES } = await import(url('cloud-growth.js')));
  ({ createCloud, drawCloud, sampleArrival } = await import(url('procedural-clouds.js')));
});
const seeds = Array.from({ length: 50 }, (_, i) => 47 + i);
const components = frame => frame.plates.reduce((n, p) => n + p.loops.filter(loop => !loop.hole).length, 0);
// Record canvas operations and properties, including save/restore alpha semantics.
// The legacy digest below was captured before adding the opt-in renderer options.
function recordingContext() {
  const calls = [], stack = [];
  let properties = { globalAlpha: .73 };
  const context = new Proxy({}, {
    get(_, key) {
      if (Object.hasOwn(properties, key)) return properties[key];
      return (...args) => {
        calls.push([key, ...args]);
        if (key === 'save') stack.push({ ...properties });
        if (key === 'restore') properties = stack.pop();
      };
    },
    set(_, key, value) { properties[key] = value; calls.push(['set', key, value]); return true; },
  });
  return { context, calls };
}

function legacyTrace(renderer, makeLegacyCloud, sample) {
  const traces = [];
  for (const elapsed of [0, 1000, 3000, 6800, 12500, 14000]) {
    for (const texture of [null, 'texture-fixture']) {
      const { context, calls } = recordingContext();
      const result = renderer(context, makeLegacyCloud('legacy-contract'), sample(elapsed),
        { x: 240, y: 410, scale: 1.15, yaw: .63 }, { texture, opacity: .82 });
      traces.push({ result, calls });
    }
  }
  return createHash('sha256').update(JSON.stringify(traces)).digest('hex');
}

test('leader drawing reveals once, seeks exactly, and vanishes after its fade window', () => {
  const cloud = createContourCloud(seeds[0]);
  function drawAt(elapsed, reducedMotion = false) {
    const recorded = recordingContext();
    return { result: drawStepLeader(recorded.context, cloud, sampleArrival(elapsed, { reducedMotion })),
      calls: recorded.calls };
  }
  for (const elapsed of [0, 6349, 6350, 7300, 14000]) assert.equal(drawAt(elapsed).result.segments, 0);
  const partial = drawAt(6500), complete = drawAt(6650);
  assert.ok(partial.result.segments > 0);
  assert.ok(complete.result.segments >= partial.result.segments);
  assert.ok(drawAt(6800).result.segments > 0);
  assert.deepEqual(drawAt(6500), partial, 'seeking back restores the exact leader drawing');
  assert.equal(drawAt(6800, true).result.segments, 0);
});

test('default drawCloud canvas operations retain the pre-change rendering contract', () => {
  assert.equal(legacyTrace(drawCloud, createCloud, sampleArrival),
    '75accab658f0a824601011441548780270c24b76a4ba24e8c20e5dc19af4263b');
});


test('the 3D field uses the approved compact cubic kernel', () => {
  const ball = { x: 0, y: 0, z: 0, R: 10 };
  assert.equal(field([ball], 0, 0, 0), 1);
  assert.equal(field([ball], 14, 0, 0), 0);
  assert.equal(field([ball], 0, 0, 14), 0);
  assert.equal(field([ball, ball], 7, 0, 0), 2 * .75 ** 3);
});
test('same parameters and arbitrary seeks reproduce immutable geometry', () => {
  for (const mode of ['metaball', 'tangent']) {
    const cloud = createContourCloud(47, { mode }), original = structuredClone(cloud);
    assert.deepEqual(cloud, createContourCloud(47, { mode }));
    assert.notDeepEqual(cloud, createContourCloud(48, { mode }));
    const frame = sampleContourCloud(cloud, 601.2);
    for (const time of [14000, 100, 13000, 3000, 600, 8000]) sampleContourCloud(cloud, time);
    assert.deepEqual(sampleContourCloud(cloud, 601.2), frame);
    assert.deepEqual(cloud, original);
    assert.strictEqual(sampleContourCloud(cloud, 3000), sampleContourCloud(cloud, 11000));
    assert.deepEqual(frame, sampleContourCloud(createContourCloud(47, { mode }), 601.2));
  }
});
test('seeded controls obey ranges, overrides change geometry, reset restores defaults', () => {
  for (const seed of seeds) {
    const p = seedParameters(seed);
    for (const [key, [min, max]] of Object.entries(PARAMETER_RANGES)) assert.ok(p[key] >= min && p[key] <= max, key);
    assert.ok(p.rmin >= 12 && p.rmin <= 20 && p.rmax >= 22 && p.rmax <= 36);
    const base = createContourCloud(seed), changed = createContourCloud(seed, { threshold: .5 });
    assert.notDeepEqual(sampleContourCloud(base, 8000).plates, sampleContourCloud(changed, 8000).plates);
    assert.deepEqual(createContourCloud(seed, {}), base);
    for (const b of base.balls) {
      assert.ok(Math.abs(b.x) <= 100 && Math.abs(b.y) <= 50 && b.z >= 0 && b.z <= 22);
      assert.ok(b.R >= p.rmin && b.R <= p.rmax);
    }
  }
  assert.ok(contourParameters(47, { rmin: 24, rmax: 16 }).rmin <= 16);
  assert.equal(contourParameters(47, { starts: 100 }).starts, 5);
});
test('five slices grow together by 3 seconds; groups scale about their starts', () => {
  for (const mode of ['metaball', 'tangent']) for (const seed of seeds) {
    const cloud = createContourCloud(seed, { mode });
    assert.ok(sampleContourCloud(cloud, 0).plates.every(p => !p.loops.length));
    const early = sampleContourCloud(cloud, 100), settled = sampleContourCloud(cloud, 3000);
    assert.ok(early.plates.every(p => p.loops.length), `${seed} ${mode}`);
    assert.equal(settled.progress, 1);
    assert.deepEqual(settled.balls, cloud.balls);
    early.balls.forEach((b, i) => {
      const original = cloud.balls[i], start = cloud.starts[b.g];
      assert.ok(Math.abs(b.x - start.x - (original.x - start.x) * early.progress) < 1e-10);
      assert.equal(b.R, original.R * early.progress);
    });
    early.plates.forEach((p, i) => assert.equal(p.z, 162 + i * 10 * early.progress));
  }
});
test('most of twenty clouds split into more components during break-up', () => {
  let split = 0;
  for (const seed of seeds.slice(0, 20)) {
    const cloud = createContourCloud(seed), early = sampleContourCloud(cloud, 8000), late = sampleContourCloud(cloud, 13000);
    if (components(late) > components(early)) split++;
    late.balls.forEach((b, i) => {
      assert.ok(b.R >= cloud.balls[i].R * .74 - 1e-10);
      assert.ok(Math.hypot(b.x - cloud.balls[i].x, b.y - cloud.balls[i].y) <= 30 + 1e-10);
    });
  }
  assert.ok(split > 10, `${split}/20 clouds split`);
});
// Independent, dense arc sampling checks the actual analytic top-face path.
function checkLoop(loop) {
  const points = [];
  for (const a of loop.arcs) {
    const n = Math.max(1, Math.ceil(Math.abs(a.sweep) / .025));
    for (let i = 0; i <= n; i++) {
      const t = a.start + a.sweep * i / n;
      points.push({ x: a.x + Math.cos(t) * a.r, y: a.y + Math.sin(t) * a.r });
    }
  }
  points.push(points[0]);
  const cross = (a, b, c) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  for (let i = 0; i < points.length-1; i++) for (let j = i+2; j < points.length-1; j++) {
    if (i === 0 && j === points.length-2) continue;
    const a=points[i],b=points[i+1],c=points[j],d=points[j+1];
    assert.ok(!(cross(a,b,c)*cross(a,b,d)<-1e-10 && cross(c,d,a)*cross(c,d,b)<-1e-10), 'analytic tangent path crosses itself');
  }
  assert.deepEqual(loop.points[0], loop.points.at(-1));
  assert.ok(loop.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  assert.equal(loop.hole, false);
}
test('tangent paths have finite closed non-crossing exact arcs across fifty seeds and four fillets', () => {
  for (const seed of seeds) for (const fillet of [0, 3, 9, 30]) {
    const cloud = createContourCloud(seed, { mode: 'tangent', fillet });
    for (const time of [100, 3000, 13000]) for (const plate of sampleContourCloud(cloud, time).plates) for (const loop of plate.loops) checkLoop(loop);
  }
  for (const fillet of [0, 9, 30]) checkLoop(tangentLoop([{x:0,y:0,r:20},{x:0,y:0,r:20},{x:2,y:0,r:3}],fillet));
});
test('metaball loops retain holes and inner contour levels', () => {
  const cloud = createContourCloud(47);
  cloud.starts = [{x:0,y:0}]; cloud.parameters = {...cloud.parameters, starts:1};
  cloud.balls = Array.from({length:12},(_,i)=>({x:Math.cos(i*Math.PI/6)*30,y:Math.sin(i*Math.PI/6)*30,z:0,R:12,g:0}));
  const ring = sampleContourCloud({...cloud}, 8000);
  assert.ok(ring.plates[0].loops.some(l=>l.hole));
  assert.ok(ring.plates[0].inner.length >= 2);
});
test('every default seed has a leader within all existing spatial and time gates', () => {
  for (const mode of ['metaball', 'tangent']) for (const seed of seeds) {
    const cloud = createContourCloud(seed, { mode }), bottom = sampleContourCloud(cloud,8000).plates[0];
    assert.ok(cloud.leader.length > 0 && cloud.leader.length <= 40, `${seed} ${mode}`);
    assert.equal(cloud.leader[0].a.z, bottom.z-bottom.thickness);
    assert.ok(bottom.loops.some(loop=>loop.points.some(p=>Math.hypot(p.x-cloud.leader[0].a.x,p.y-cloud.leader[0].a.y)<1e-8)));
    for (const {a,b,fade} of cloud.leader) {
      assert.ok(b.z<a.z && b.z>=60 && fade>=0 && fade<=1);
      const dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy;
      const t=den?Math.max(0,Math.min(1,-(a.x*dx+a.y*dy)/den)):0;
      assert.ok(Math.hypot(a.x+dx*t,a.y+dy*t)>=55-1e-9);
    }
  }
});
test('render is deterministic through orbit and uses unchanged rain tracks without random choices', () => {
  for (const mode of ['metaball','tangent']) {
    const cloud=createContourCloud(47,{mode}), frame=sampleContourCloud(cloud,6800), state=sampleArrival(6800);
    const originalRandom = Math.random; Math.random=()=>{throw Error('render randomness');};
    try {
      for(let n=0;n<8;n++) {
        const a=recordingContext(), b=recordingContext(), view={yaw:n*Math.PI/4};
        assert.deepEqual(drawContourCloud(a.context,frame,state,view),{plates:5,drops:62});
        drawContourCloud(b.context,sampleContourCloud(cloud,6800),state,view);
        assert.deepEqual(a.calls,b.calls); assert.equal(a.context.globalAlpha,.73);
      }
      const a=recordingContext(), b=recordingContext();
      drawCloud(a.context,{...cloud,plates:[]},state,{}, {lightning:'none'});
      drawContourCloud(b.context,{...frame,plates:[]},state);
      assert.deepEqual(b.calls.slice(0,a.calls.length),a.calls);
      assert.deepEqual(drawContourCloud(recordingContext().context,frame,sampleArrival(6800,{reducedMotion:true})),{plates:0,drops:0});
    } finally { Math.random=originalRandom; }
  }
});
