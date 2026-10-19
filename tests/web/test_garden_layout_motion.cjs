const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

// These camera/inspection fixtures hold weather idle; dedicated tests cover arrivals.
function createContext(values) {
  const context=vm.createContext({
    cloudArrivals: { active: false, sync() {}, advance() {}, entries: () => [] },
    gardenOrbit:{active:false},cloudTextureRequested: true,queueArrival(){},liveMode:false,
    ...values,
  });
  context.plotHills=context.createPlotHills();
  vm.runInContext(functionSource("treeElevation"),context);
  return context;
}

const source = fs.readFileSync('web/canvas-garden.js', 'utf8');
async function moduleFile(name) { return import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync('web/' + name, 'utf8')).toString('base64')); }
function functionSource(name) {
 const start = source.indexOf('function '+name+'('), next = source.indexOf('\nfunction ', start+1);
 return source.slice(start, next < 0 ? undefined : next);
}
async function harness() {
 const nodes = new Map(), node = id => { if(!nodes.has(id))nodes.set(id,{dataset:{},replaceChildren(){},appendChild(){},setAttribute(){}});return nodes.get(id); };
 const sessions = [0,1].map(i=>({id:'tree-'+i,projectId:'lot',p:0,birth:i,fileEvents:[],commits:[],agents:[],workByDay:[1,1]}));
 let now=100;
 const context=createContext({ timeRange:null, ...await moduleFile('garden-timeline-brush.js'), ...await moduleFile('garden-plot-hills.js'), ...await moduleFile('garden-robot-camera.js'), ...await moduleFile('garden-layout.js'), ...await moduleFile('garden-island-contours.js'), ...await moduleFile('tree-placement.js'), ...await moduleFile('garden-layout-motion.js'),
  $:id=>id==='spawn-cards'?{hidden:true}:node(id), document:{createElement:()=>node('span'),hidden:false},performance:{now:()=>now},
  projects:[{id:'lot',birth:0,allPrimary:sessions}],sessions,visibleSessions:[sessions[0]],selected:sessions[0],
  displayScene:null,overviewFit:null,arrival:null,driftBase:null,endTime:172800000,syncCommitPulses(){},
  evidenceGeneration:0,sourceData:{generatedAt:'fixture'},sceneKey:'',day:0,maxDay:1,startTime:0,SEED:'483765r937n',DAY:86400000,
  gardenLayout:{plots:[],outline:[],bounds:{x:0,y:0,w:0,h:0}},treePlacements:[],camera:{x:20,y:30,zoom:1,auto:false},
  scale:1,fitScale:1,W:800,H:600,hoverSession:null,hoverProject:null,hoverPath:null,pinnedMap:null,mapSession:null,pinnedPath:null,scrubbing:false,
  botanical:{settledBounds:(s,origin)=>({bounds:{x:origin.x-20,y:origin.y-100,w:40,h:100}})},
  motion:true,motionPreference:{matches:false},growthDay:0,spawnHold:{size:0,has:()=>false,hold(){},release:()=>[]},treeGrowth:{has:()=>true,restart(){},sync(){}},
  work:s=>s.workByDay[context.day],syncSpawnCards(){},prepareWorld(){context.visibleSessions=sessions.filter(s=>s.birth<=context.day)},
  stopFlight(){},syncTour(){},rebuild(){},updateCard(){},renderProjectSelect(){},updateMap(){},drawArcs(){},files:()=>[],
 });
 vm.runInContext(['point','viewRect','projectedBounds','fitWorldBounds','setCameraForBounds','destinationForBounds','shownLayout','displayedTrees','buildWorldScene','updateDay'].map(functionSource).join('\n'),context);
 vm.runInContext('layoutMotion=createLayoutMotion();buildWorldScene();displayScene=layoutMotion.retarget(gardenLayout,treePlacements,100,{animate:false})',context);
 return {context,advance(){context.day=1;vm.runInContext('updateDay()',context)},root(){return vm.runInContext('point(displayedTrees()[0].x,displayedTrees()[0].y,3+(displayedTrees()[0].lift||0))',context)}};
}
test('adding a tree preserves the displayed existing root on the first frame',async()=>{
 const h=await harness(),before=h.root();h.advance();const after=h.root();
 assert.ok(Math.hypot(after.x-before.x,after.y-before.y)<.001,`existing root jumped ${Math.hypot(after.x-before.x,after.y-before.y).toFixed(2)} CSS pixels`);
 assert.equal(h.context.camera.auto,false,'history must preserve a manually positioned camera');
});

function square(x,y,size){return[{x,y},{x:x+size,y},{x:x+size,y:y+size},{x,y:y+size}]}
function scene(size=100,polygon=square(0,0,size)) { return {outline:polygon,bounds:{x:0,y:0,w:size,h:size},plots:[{id:'lot',polygon,centroid:{x:size/2,y:size/2},labelAnchor:{x:size/2,y:size},x:0,y:0,w:size,h:size,planting:{polygon}}]}; }
function area(polygon){return Math.abs(polygon.reduce((a,p,i)=>{const q=polygon[(i+1)%polygon.length];return a+p.x*q.y-p.y*q.x},0)/2)}
test('overview fit starts at the current camera when a tree appears',async()=>{
 const h=await harness();h.context.camera.auto=true;const before=h.root(),camera={...h.context.camera};h.advance();const after=h.root();
 assert.deepEqual({...h.context.camera},camera);assert.ok(Math.hypot(after.x-before.x,after.y-before.y)<.001);assert.ok(h.context.overviewFit);
});
test('cyclic vertex ordering cannot collapse a lot during interpolation',async()=>{
 const {createLayoutMotion}=await moduleFile('garden-layout-motion.js'),motion=createLayoutMotion(),polygon=square(0,0,100);
 motion.retarget(scene(),[],0,{animate:false});motion.retarget(scene(100,polygon.slice(2).concat(polygon.slice(0,2))),[],0);
 for(let t=0;t<=620;t+=20)assert.ok(area(motion.sample(t).layout.plots[0].polygon)>9999);
});
test('new roots start inside the old lot and repeated retargets remain continuous',async()=>{
 const {createLayoutMotion}=await moduleFile('garden-layout-motion.js'),motion=createLayoutMotion(),root=(id,x)=>({s:{id},plotId:'lot',x,y:50});
 motion.retarget(scene(),[root('old',50)],0,{animate:false});
 const first=motion.retarget(scene(200),[root('old',100),root('new',150)],0);
 assert.ok(first.trees.every(t=>t.x<=100&&t.y<=100));
 const middle=motion.sample(200),before=middle.trees[0];motion.retarget(scene(300),[root('old',200),root('new',220)],200);
 assert.deepEqual(motion.sample(200).trees[0],before);
 assert.equal(motion.sample(900).active,false);assert.equal(motion.sample(900).trees[0].x,200);
});
test('reduced motion, backwards history and explicit settling use final geometry',async()=>{
 const {createLayoutMotion}=await moduleFile('garden-layout-motion.js'),motion=createLayoutMotion();
 motion.retarget(scene(),[],0,{animate:false});assert.equal(motion.retarget(scene(200),[],100,{animate:false}).active,false);
 motion.retarget(scene(300),[],200);assert.equal(motion.active,true);assert.equal(motion.settle().layout.bounds.w,300);
 assert.equal(motion.retarget(scene(),[],300,{reset:true}).layout.bounds.w,100);assert.equal(motion.active,false);
});
