const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const moduleSource = fs.readFileSync('web/garden-flock.js','utf8');
const moduleReady = import('data:text/javascript;base64,'+Buffer.from(moduleSource).toString('base64'));
const context = () => ({globalAlpha:1,setLineDash(){},save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},arc(){},stroke(){},fill(){},translate(){},rotate(){}});
const entries = count => Array.from({length:count},(_,i)=>({id:'tree-'+i,count:3,x:i*20,y:100,width:35,height:60}));
test('flock respects record counts, history changes, and the 96-bird cap',async()=>{
  const {createGardenFlock}=await moduleReady,flock=createGardenFlock(),ctx=context();
  flock.draw(ctx,entries(64),0);assert.equal(flock.state().length,96);
  flock.draw(ctx,[{...entries(1)[0],count:1}],100);assert.equal(flock.state().length,1);
  flock.draw(ctx,[{...entries(1)[0],count:0}],200);assert.equal(flock.state().length,0);
});
test('seeded wandering stays finite with bounded trails and freezes when motion is disabled',async()=>{
  const {createGardenFlock}=await moduleReady,a=createGardenFlock(),b=createGardenFlock(),ctx=context(),records=entries(3);
  for(let t=0;t<30000;t+=66){a.draw(ctx,records,t);b.draw(ctx,records,t)}
  assert.deepEqual(a.state(),b.state());
  for(const bird of a.state()){assert(Number.isFinite(bird.x)&&Number.isFinite(bird.y));assert(Math.abs(bird.x)<=2.1);assert(bird.trailPoints<=28&&bird.trailPoints>0);assert(Math.hypot(bird.vx,bird.vy)<=.801)}
  const frozen=a.state();a.draw(ctx,records,31000,{enabled:false});assert.deepEqual(a.state(),frozen);
  assert.equal(a.draw(ctx,records,32000,{enabled:false,trails:false}).segments,0);
});
test('every live status keeps a small directional bird and bounded trail',async()=>{
  const {createGardenFlock}=await moduleReady,flock=createGardenFlock();
  const marks=[];let recordMarks=true,strokes=0;
  const ctx={...context(),arc(){throw Error('Live agent painted as a circle')},moveTo(x,y){if(recordMarks)marks.push({x,y})},stroke(){strokes++}};
  const agents=Array.from({length:340},(_,i)=>({id:'agent-'+i,state:['working','waiting','turn-ended','error','unknown'][i%5]}));
  const live=[{id:'root',agents,x:40,y:80,width:20,height:60},{id:'other',agents:[{id:'other-child',state:'turn-ended'}],x:300,y:90,width:20,height:60}];
  flock.draw(ctx,live,0,{trails:false});
  assert.equal(flock.state().length,341);
  assert.equal(flock.state()[0].key,'agent-0');
  assert(marks.some(mark=>mark.x>=4.5&&mark.x<7),'overview bird silhouette is smaller than the first orbit draft');
  recordMarks=false;
  const path=[];for(let t=100;t<=18000;t+=100){flock.draw(ctx,live,t);path.push(flock.state()[0])}
  assert(strokes<=341*180,'live trails use at most one stroke per bird and frame');
  assert(path.some(b=>Math.abs(b.x)>1.5),'bird can leave the tight crown orbit');
  assert(path.every(b=>b.treeId==='root'&&!b.perched));
  assert(flock.state().every(b=>b.trailPoints>0&&!b.perched));
  assert.equal(new Set(flock.state().map(b=>b.key)).size,341);
  assert.equal(flock.state().find(b=>b.key==='other-child').treeId,'other');
  agents[0]={id:'agent-0',state:'turn-ended'};
  const before=flock.state().find(b=>b.key==='agent-0');
  flock.draw(ctx,live,18100);
  const after=flock.state().find(b=>b.key==='agent-0');
  assert.notEqual(after.x,before.x,'status change does not stop orbit');
  const frozen=flock.state();flock.draw(ctx,live,18200,{enabled:false});assert.deepEqual(flock.state(),frozen);
  assert.equal(flock.draw(ctx,live,18300,{enabled:false,trails:false}).segments,0);
});
test('a live bird roams freely, returns home, and avoids a nearby bird from another tree',async()=>{
  const {createGardenFlock}=await moduleReady,ctx=context();
  const own={id:'root',agents:[{id:'agent-0',state:'unknown'}],x:100,y:100,width:20,height:60};
  const solo=createGardenFlock(),path=[];
  for(let t=0;t<=45000;t+=100){solo.draw(ctx,[own],t);path.push(solo.state()[0])}
  const far=path.findIndex(b=>Math.hypot(b.x,b.y)>1.8);
  assert(far>0,'bird leaves the immediate tree crown');
  assert(path.slice(far+1,far+101).some(b=>Math.hypot(b.x,b.y)<1),'bird returns near its own tree');
  const neighbor={id:'adjacent',agents:[{id:'nearby-agent',state:'error'}],x:100,y:100,width:20,height:60};
  const probe=createGardenFlock();probe.draw(ctx,[own,neighbor],0);
  const [initial,other]=probe.state();
  neighbor.x+=16*(initial.x-other.x)+5;
  neighbor.y+=16*.72*(initial.y-other.y);
  const pair=createGardenFlock(),alone=createGardenFlock();
  for(let t=0;t<=2000;t+=100){pair.draw(ctx,[own,neighbor],t);alone.draw(ctx,[own],t)}
  const withNeighbor=pair.state().find(b=>b.key==='agent-0'),without=alone.state()[0];
  assert(Math.hypot(withNeighbor.x-without.x,withNeighbor.y-without.y)>.05,'nearby bird diverts its path across tree boundaries');
});
test("selection recalls only related birds and respects disabled motion",async()=>{
 const {createGardenFlock}=await moduleReady, flock=createGardenFlock(),ctx=context();
 const records=[{id:"root",agents:[{id:"agent-0"}],x:100,y:100,width:30,height:60},{id:"other",agents:[{id:"agent-1"}],x:400,y:100,width:30,height:60}];
 for(let t=0;t<15000;t+=50)flock.draw(ctx,records,t);
 const orbit=[];
 for(let t=15000;t<=23000;t+=50){flock.draw(ctx,records,t,{selectedTreeId:"root"});if(t>19000)orbit.push(flock.state()[0]);}
 assert(orbit.every(b=>b.opacity===1&&Math.hypot(b.x,b.y)<1.5));
 assert(orbit.some(b=>b.x<-.5)&&orbit.some(b=>b.x>.5));
 assert(flock.state()[1].opacity<=.5);
 const frozen=flock.state();flock.draw(ctx,records,23100,{selectedTreeId:"root",enabled:false});assert.deepEqual(flock.state(),frozen);
 flock.draw(ctx,records,23200,{selectedTreeId:"other"});
 assert(flock.state()[0].opacity<=.5);assert.equal(flock.state()[1].opacity,1);
});
