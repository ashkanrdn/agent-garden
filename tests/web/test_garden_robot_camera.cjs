const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, test } = require('node:test');
let api;
before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../web/garden-robot-camera.js'), 'utf8');
  api = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
});
const from = Object.freeze({x: -200, y: 90, zoom: .35, yaw: .62, auto: true});
const target = Object.freeze({x: 180, y: -80, zoom: .9, yaw: .62, auto: true});
const near = (a,b,e=1e-7) => assert.ok(Math.abs(a-b)<e, `${a} != ${b}`);

test('rotated ground picking recovers world points at all view angles', () => {
  for (const yaw of [0, .62, Math.PI / 2, Math.PI, Math.PI * 2, -3.4]) {
    for (const [x,y] of [[0,0],[-130,256],[950,-481]]) {
      const p=api.projectGround(x,y,yaw), inverse=api.unprojectGround(p.x,p.y,yaw);
      near(inverse.x,x); near(inverse.y,y);
      const raised=api.projectGround(x,y,yaw,70);
      near(raised.x,p.x); near(raised.y,p.y-70);
    }
  }
});

test('rail passes last 500 ms, keep heading and height, and reverse without orbit', () => {
  const phases=api.ROBOT_SHOT_PHASES;
  assert.equal(phases.find(p=>p[0]==='pass-right')[1],500);
  assert.equal(phases.find(p=>p[0]==='pass-left')[1],500);
  assert.equal(phases.reduce((sum,p)=>sum+p[1],0),api.ROBOT_SHOT_MS);
  let lastRight=-Infinity,lastLeft=Infinity;
  for(let t=0;t<500;t+=7){
    const r=api.sampleRobotShot(from,target,420+t).camera;
    const l=api.sampleRobotShot(from,target,1420+t).camera;
    assert.ok(r.x>=lastRight); assert.ok(l.x<=lastLeft);
    for(const pose of [r,l]) {near(pose.y,target.y);near(pose.yaw,from.yaw);near(pose.zoom,target.zoom);}
    lastRight=r.x;lastLeft=l.x;
  }
});

test('all phases join continuously and return to the exact saved view', () => {
  assert.deepEqual(api.sampleRobotShot(from,target,0).camera,from);
  let boundary=0;
  for(const [,duration] of api.ROBOT_SHOT_PHASES){
    boundary+=duration;
    const a=api.sampleRobotShot(from,target,boundary-.001).camera;
    const b=api.sampleRobotShot(from,target,boundary+.001).camera;
    for(const field of ['x','y','zoom','yaw'])near(a[field],b[field],.0001);
  }
  assert.deepEqual(api.sampleRobotShot(from,target,api.ROBOT_SHOT_MS),{camera:from,phase:'complete',done:true});
  assert.equal(api.sampleRobotShot(from,target,1150).camera.zoom,target.zoom*1.2);
  assert.deepEqual(api.sampleRobotShot(from,target,800),api.sampleRobotShot(from,target,800));
});

test('idle survey changes ground orientation without tilting vertical geometry', () => {
  assert.deepEqual(api.sampleIdleSurvey(from,0),from);
  const a=api.sampleIdleSurvey(from,5000), b=api.sampleIdleSurvey(from,10000);
  assert.ok(a.yaw>from.yaw); assert.ok(b.yaw>a.yaw);
  assert.ok(a.zoom>0&&b.zoom>0);
  const raised=api.projectGround(40,60,b.yaw,80),ground=api.projectGround(40,60,b.yaw);
  near(raised.x,ground.x);near(ground.y-raised.y,80);
});

test('every new identity queues once, including low-work arrivals and skipped dates', () => {
  const q=api.createSpawnShotQueue();
  q.sync(['baseline']);assert.equal(q.size,0);
  q.sync(['baseline','tiny','large','middle']);assert.deepEqual(q.ids(),['large','middle','tiny']);
  assert.equal(q.take(),'large');
  q.sync(['baseline','tiny','large','middle']);assert.deepEqual(q.ids(),['middle','tiny']);
  q.cancel();assert.equal(q.size,0);
  q.sync(['baseline','tiny','large','middle']);assert.equal(q.size,0);
  q.sync(['baseline'],{reset:true});q.sync(['baseline','tiny']);assert.equal(q.take(),'tiny');
  q.sync(['baseline','tiny','scrubbed'],{animate:false});assert.equal(q.size,0);
});

test('central orbit reaches the opposite side and a full turn without zoom pulses', () => {
  const orbit=api.createGardenOrbit(),center={x:140,y:-70};
  const p=api.projectGround(center.x,center.y,0);
  let camera={...p,zoom:.6,yaw:0,auto:true};
  let previousYaw=0;
  for(let ms=0;ms<api.GARDEN_ORBIT_MS+2000;ms+=20){
    camera=orbit.step(camera,20,{center,zoom:.6});
    assert.ok(camera.yaw>previousYaw);previousYaw=camera.yaw;
    near(camera.zoom,.6);
    const anchor=api.projectGround(center.x,center.y,camera.yaw);
    near(camera.x,anchor.x);near(camera.y,anchor.y);
  }
  assert.ok(camera.yaw>Math.PI*2);
  const front=api.projectGround(center.x+120,center.y,0);
  const back=api.projectGround(center.x+120,center.y,Math.PI);
  assert.ok((front.x-p.x)*(back.x-api.projectGround(center.x,center.y,Math.PI).x)<0,
    'world positions change sides; the camera does not merely translate the image');
});

test('orbit retargets growth without position or angular velocity discontinuities', () => {
  const orbit=api.createGardenOrbit();
  let camera={x:0,y:0,yaw:0,zoom:.6,auto:true};
  for(let i=0;i<600;i++)camera=orbit.step(camera,16,{center:{x:0,y:0},zoom:.6});
  const before={...camera},target={center:{x:100,y:80},zoom:.4,lift:60};
  assert.deepEqual(orbit.step(camera,0,target),before);
  camera=orbit.step(camera,16,target);
  assert.ok(Math.hypot(camera.x-before.x,camera.y-before.y)<.3);
  assert.ok(Math.abs(camera.zoom-before.zoom)<.001);
  near(camera.yaw-before.yaw,Math.PI*2/api.GARDEN_ORBIT_MS*16,1e-6);
});

test('orbit pause and resume retain the pose without a catch-up jump', () => {
  const orbit=api.createGardenOrbit(),target={center:{x:0,y:0},zoom:.5};
  let camera={x:0,y:0,yaw:2,zoom:.5};
  for(let i=0;i<100;i++)camera=orbit.step(camera,20,target);
  assert.deepEqual(orbit.step(camera,0,target),camera);
  const next=orbit.step(camera,5000,target);
  assert.ok(next.yaw-camera.yaw<.009,'long frame gaps cannot jump across the scene');
  orbit.reset();assert.equal(orbit.active,false);
  assert.deepEqual(orbit.step(next,0,target),next);
});

test('dive subjects use the highest-work anchor and its nearest two batch peers', () => {
  const candidates=[
    {id:'far',x:100,y:100,work:4},
    {id:'anchor',x:0,y:0,work:12},
    {id:'nearest',x:2,y:1,work:1},
    {id:'next',x:-4,y:0,work:3},
    {id:'fourth',x:7,y:0,work:9},
  ];
  assert.deepEqual(api.selectDiveSubjects(candidates).map(item=>item.id),['anchor','nearest','next']);
  assert.equal(api.selectDiveSubjects(candidates,20).length,3);
  assert.deepEqual(api.selectDiveSubjects([]),[]);
});

test('dive framing includes settled tree and weather bounds with a bounded zoom', () => {
  const subjects=[
    {id:'a',x:-10,y:4,treeBounds:{x:-25,y:-80,w:30,h:84},weatherBounds:{x:-80,y:-190,w:140,h:210}},
    {id:'b',x:14,y:8,treeBounds:{x:15,y:-75,w:35,h:82},weatherBounds:{x:-30,y:-185,w:150,h:215}},
  ];
  const frame=api.frameDiveSubjects(subjects,{w:900,h:600},.4,{projectedCenter:{x:10,y:-5}});
  assert.deepEqual(frame.center,{x:2,y:6});
  assert.deepEqual(frame.bounds,{x:-80,y:-190,w:200,h:220});
  assert.equal(frame.zoomCap,1);
  assert.ok(frame.zoom>=.4&&frame.zoom<=1);
  assert.ok(frame.bounds.h*frame.zoom<=600*.52+.0001);
  const tiny=api.frameDiveSubjects([{id:'tiny',x:0,y:0,bounds:{x:-1,y:-2,w:2,h:3}}],{w:1200,h:900},1.4);
  assert.equal(tiny.zoom,3,'absolute zoom cap wins over a tiny single subject');
});

test('weather phases lead with pivot, hold close, and lead the return with zoom', () => {
  const overview={center:{x:0,y:0},zoom:.4,lift:10};
  const close={center:{x:120,y:-60},zoom:1,lift:90};
  const gather=api.sampleDiveTargets(overview,close,2400,{speed:1,crown:0});
  assert.equal(gather.phase,'Gather');
  assert.ok(gather.centerProgress>.8&&gather.zoomProgress<.06,'pivot leads the incoming zoom');
  const rain=api.sampleDiveTargets(overview,close,4500,{speed:1,crown:.2});
  assert.equal(rain.phase,'Rain');assert.equal(rain.centerProgress,1);assert.ok(rain.zoomProgress>.8);
  const lowCrown=api.sampleDiveTargets(overview,close,7000,{speed:1,crown:.1});
  const fullCrown=api.sampleDiveTargets(overview,close,7000,{speed:1,crown:1});
  assert.equal(lowCrown.phase,'Grow');assert.ok(fullCrown.lift>lowCrown.lift);assert.ok(lowCrown.speedScale<.61);
  const disperse=api.sampleDiveTargets(overview,close,11800,{speed:1});
  assert.equal(disperse.phase,'Disperse');
  assert.ok(disperse.zoomProgress<disperse.centerProgress,'zoom leaves before the pivot');
  assert.equal(api.sampleDiveTargets(overview,close,14000,{speed:1}).done,true);
});

test('full dives run at 1x and 2x while fast replay only leans the pivot', () => {
  const overview={center:{x:0,y:0},zoom:.5,lift:0},close={center:{x:90,y:30},zoom:1.2,lift:70};
  for(const speed of [1,2]){
    const sample=api.sampleDiveTargets(overview,close,7000,{speed,crown:1});
    assert.deepEqual(sample.center,close.center);assert.equal(sample.zoom,close.zoom);assert.ok(sample.closeProgress>.99);
  }
  for(const speed of [5,10]){
    const sample=api.sampleDiveTargets(overview,close,7000,{speed,crown:1});
    near(sample.center.x,30);near(sample.center.y,10);near(sample.zoom,overview.zoom);near(sample.lift,0);
    assert.equal(sample.speedScale,1);assert.equal(sample.closeProgress,0);
  }
});

test('yaw stays monotonic with continuous velocity through dive targets and cancellation', () => {
  const orbit=api.createGardenOrbit(),overview={center:{x:0,y:0},zoom:.5,lift:0};
  const close={center:{x:80,y:30},zoom:1,lift:50};
  let camera={x:0,y:0,yaw:0,zoom:.5},previousYaw=0;
  for(let i=0;i<800;i++){camera=orbit.step(camera,16,overview);assert.ok(camera.yaw>=previousYaw);previousYaw=camera.yaw}
  const deltas=[];
  for(let i=0;i<240;i++){
    const target=i<80?api.sampleDiveTargets(overview,close,5200+i*16,{speed:1,crown:1}):overview;
    const before=camera.yaw;camera=orbit.step(camera,16,target);deltas.push(camera.yaw-before);
    assert.ok(camera.yaw>before,'yaw never stops or reverses');
  }
  for(let i=1;i<deltas.length;i++)assert.ok(Math.abs(deltas[i]-deltas[i-1])<.00002,'angular velocity changes continuously');
});

test('drag spin coasts and hands its direction to the normal auto-orbit', () => {
  const orbit=api.createGardenOrbit(),target={center:{x:0,y:0},zoom:.5,lift:0};
  let camera={x:0,y:0,yaw:1,zoom:.5,auto:true};
  camera=orbit.spin(camera,-.18,-1.4);
  assert.equal(camera.auto,true);assert.equal(orbit.direction,-1);
  let previous=camera.yaw;
  for(let i=0;i<500;i++){
    camera=orbit.step(camera,16,target);assert.ok(camera.yaw<previous);previous=camera.yaw;
  }
  const normal=Math.PI*2/(api.GARDEN_ORBIT_MS/1000);
  near(orbit.angularVelocity,-normal,.002);
});

test('showcase gating rejects blocked requests and completes the shared camera move', () => {
  const allowed={exists:true,fullyGrown:true,motion:true,reducedMotion:false,hidden:false,interaction:false};
  assert.equal(api.canShowcaseTree(allowed),true);
  for(const field of ['exists','fullyGrown','motion'])assert.equal(api.canShowcaseTree({...allowed,[field]:false}),false);
  for(const field of ['reducedMotion','hidden','interaction'])assert.equal(api.canShowcaseTree({...allowed,[field]:true}),false);
  const overview={center:{x:0,y:0},zoom:.4,lift:0},close={center:{x:50,y:20},zoom:1,lift:40};
  assert.equal(api.sampleShowcaseTargets(overview,close,3000).phase,'orbit');
  assert.equal(api.sampleShowcaseTargets(overview,close,10999).phase,'orbit');
  assert.equal(api.sampleShowcaseTargets(overview,close,11000).phase,'return');
  const complete=api.sampleShowcaseTargets(overview,close,api.SHOWCASE_DURATION_MS);
  assert.equal(complete.done,true);assert.deepEqual(complete.center,overview.center);near(complete.zoom,overview.zoom);
});

test('camera moves complete from elapsed time without requiring an orbit step', () => {
  assert.equal(api.isCameraMoveComplete({kind:'dive',elapsed:13999}),false);
  assert.equal(api.isCameraMoveComplete({kind:'dive',elapsed:14000}),true);
  assert.equal(api.isCameraMoveComplete({kind:'showcase',elapsed:api.SHOWCASE_DURATION_MS-1}),false);
  assert.equal(api.isCameraMoveComplete({kind:'showcase',elapsed:api.SHOWCASE_DURATION_MS}),true);
  assert.equal(api.isCameraMoveComplete(null),false);
});

test('spin with automatic orbit off coasts to zero without reversing', () => {
  const orbit=api.createGardenOrbit(),target={center:{x:0,y:0},zoom:.5,lift:0,autoOrbit:false};
  let camera={x:0,y:0,yaw:0,zoom:.5,auto:true};
  camera=orbit.spin(camera,.1,.8);let previous=camera.yaw,previousSpeed=orbit.angularVelocity;
  for(let i=0;i<800;i++){
    camera=orbit.step(camera,16,target);
    assert.ok(camera.yaw>=previous,'coast cannot reverse');
    assert.ok(orbit.angularVelocity<=previousSpeed+.000001,'coast velocity must decay');
    previous=camera.yaw;previousSpeed=orbit.angularVelocity;
  }
  assert.ok(Math.abs(orbit.angularVelocity)<.001);
});

test('held spin pointer owns yaw while framing springs continue settling', () => {
  const orbit=api.createGardenOrbit(),target={center:{x:40,y:-20},zoom:1,lift:30,holdYaw:true};
  let camera={x:0,y:0,yaw:.5,zoom:.5,auto:true};
  camera=orbit.spin(camera,.2,1.1);const heldYaw=camera.yaw,heldZoom=camera.zoom;
  for(let i=0;i<30;i++)camera=orbit.step(camera,16,target);
  near(camera.yaw,heldYaw);
  assert.ok(camera.zoom>heldZoom,'zoom spring remains active while yaw is held');
});

test('stale pointer velocity is zeroed before release', () => {
  assert.equal(api.releaseSpinVelocity(1.25,79),1.25);
  assert.equal(api.releaseSpinVelocity(1.25,80),1.25);
  assert.equal(api.releaseSpinVelocity(1.25,81),0);
  assert.equal(api.releaseSpinVelocity(Infinity,10),0);
});
