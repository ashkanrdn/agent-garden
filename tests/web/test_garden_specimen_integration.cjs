const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const directory='web/';
const source=fs.readFileSync(directory+'canvas-garden.js','utf8');
const extract=name=>{const start=source.indexOf(`function ${name}(`),end=source.indexOf('\nfunction ',start+1);assert.ok(start>=0);return source.slice(start,end<0?undefined:end)};
const motionHelpers=()=>{const a=source.indexOf('const MOTION_SETTLE_MS'),b=source.indexOf('\n',source.indexOf('function invalidateRects'));return source.slice(a,b)};
const motionDefaults=()=>({cloudFitIds:null,fitFollower:{active:false,reset(){},pose:null},flight:null,spotlight:null,overviewFit:null,layoutMotion:{active:false},pointerGesture:null,vectorFading:false,rasterPending:0,FLIGHT_FADE_MS:120,flightFade:{active:false,cam:null,start:0,forestStart:null,defer:0},ghostBase:{name:'ghostBase'},ghostForest:{name:'ghostForest'}});
const urls=new Map();
function moduleURL(name){if(!urls.has(name))urls.set(name,'data:text/javascript;base64,'+Buffer.from(fs.readFileSync(directory+name,'utf8').replace(/(import[^;]*?)(['"])[.]\/([^'"]+)\2/g,(_,prefix,quote,dependency)=>prefix+quote+moduleURL(dependency)+quote)).toString('base64'));return urls.get(name)}
const load=name=>import(moduleURL(name));
const {encodeGardenSpecimens}=require('../../'+directory+'garden-specimen-encoding.js');
function art(){const stack=[];return {globalAlpha:1,globalCompositeOperation:'source-over',save(){stack.push({globalAlpha:this.globalAlpha,globalCompositeOperation:this.globalCompositeOperation})},restore(){Object.assign(this,stack.pop())},setTransform(){},clearRect(){},drawImage(){},scale(){},translate(){},rotate(){},beginPath(){},closePath(){},moveTo(){},lineTo(){},bezierCurveTo(){},rect(){},clip(){},fill(){},stroke(){},fillRect(){},ellipse(){},arc(){},createRadialGradient(){return {addColorStop(){}}}}}
const canvasFactory=(width,height)=>({width,height,getContext:()=>art()});
function encodingHarness(){
 const DAY=86400000,startTime=Date.parse('2026-09-20'),data={projects:[{id:'p',name:'Project'}],sessions:[],commits:[]};
 const root=(id,day=0)=>({id,projectId:'p',createdAt:new Date(startTime+day*DAY).toISOString(),updatedAt:new Date(startTime+day*DAY+60000).toISOString(),activity:[{kind:'tool',count:30,at:new Date(startTime+day*DAY).toISOString()}],files:[]});
 data.sessions=[root('a'),root('b'),root('future',2),{...root('child'),isSubagent:true,rootSessionId:'a'},{...root('guardian'),isSubagent:true,isGuardian:true,rootSessionId:'a'}];
 data.sessions[0].files=[{path:'created.js',events:[{at:new Date(startTime).toISOString(),kind:'add'}]}];
 const context=vm.createContext({DAY,startTime,endTime:startTime+3*DAY-1,maxDay:2,day:0,sessions:[],projects:[],sessionRecords:new Map(),evidenceGeneration:0,encodingCacheKey:'',specimenVisualGeneration:0,specimenEncodings:new Map(),encodeGardenSpecimens,sourceData:data});
 vm.runInContext(['atDay','cutoff','deriveGardenRecords','refreshSpecimenEncodings'].map(extract).join('\n'),context);
 context.deriveGardenRecords(data);context.refreshSpecimenEncodings();
 return {context,data,root};
}
test('derived import encodes the born cohort once and filters never rerank it',()=>{
 const {context:c}=encodingHarness();
 assert.deepEqual([...c.specimenEncodings.keys()],['a','b']);
 assert.equal(c.specimenEncodings.get('a').fruit,1);
 assert.equal(c.specimenEncodings.get('a').metrics.tools,60,'root and real child count once; guardian stays excluded');
 assert.equal(c.specimenEncodings.get('a').metrics.agents,1);
 const encoded=c.specimenEncodings;
 c.projectFilter='missing';c.searchFilter='nothing';c.timeRange={start:2,end:2};
 assert.equal(c.refreshSpecimenEncodings(),false);assert.equal(c.specimenEncodings,encoded);
 c.day=2;c.refreshSpecimenEncodings();assert.equal(c.specimenEncodings.size,3);
 c.day=0;c.refreshSpecimenEncodings();assert.deepEqual([...c.specimenEncodings.keys()],['a','b']);
});
test('duration-only live evidence updates species without moving roots; metadata retains pixels',()=>{
 const {context:c,data}=encodingHarness();let rebuilds=0,clears=0;
 const tree={s:c.sessions.find(s=>s.id==='b'),x:11,y:22};
 Object.assign(c,{sourceData:structuredClone(data),liveMode:true,selected:tree.s,visibleSessions:c.sessions.slice(),treePlacements:[tree],renderedTrees:[tree],displayScene:null,
  liveState:{snapshot:()=>data},botanical:{clear(){clears++}},dirty:false,updateCard(){},syncSpawnCards(){},rebuild(){rebuilds++}});
 vm.runInContext(['liveGeometryKey','mergeLiveEvidence'].map(extract).join('\n'),c);
 const generation=c.specimenVisualGeneration;
 data.sessions=data.sessions.map(s=>s.id==='b'?{...s,title:'New title'}:s);
 c.mergeLiveEvidence({sessionIds:['b'],projectIds:[],agentIds:[]});
 assert.equal(c.specimenVisualGeneration,generation);assert.equal(rebuilds,0);
 data.sessions=data.sessions.map(s=>s.id==='b'?{...s,updatedAt:'2026-09-20T04:00:00Z'}:s);
 c.mergeLiveEvidence({sessionIds:['b'],projectIds:[],agentIds:[]});
 assert.equal(c.specimenEncodings.get('b').species,'slow-burn');assert.equal(rebuilds,1);assert.equal(clears,0);
 assert.equal(c.selected.id,'b');assert.deepEqual([tree.x,tree.y],[11,22]);
 data.sessions=data.sessions.map(s=>s.id==='b'?{...s,updatedAt:'2026-09-20T05:00:00Z'}:s);
 c.mergeLiveEvidence({sessionIds:['b'],projectIds:[],agentIds:[]});assert.equal(rebuilds,1,'unchanged visual class retains forest pixels');
});
test('only current primary pending states sparkle, including quiet; child states and History do not',async()=>{
 const {createGardenLiveState}=await load('garden-live-state.js'),state=createGardenLiveState();
 const c=vm.createContext({liveMode:true,liveState:state});vm.runInContext(extract('primarySparkle'),c);
 let revision=0;
 const apply=agents=>state.apply({schemaVersion:1,revision:revision++,agents},{snapshot:true});
 for(const status of ['working','waiting']){apply([{id:'root',state:status,lastEventAt:'2020-01-01'}]);assert.equal(state.agentState('root').quiet,true);assert.equal(c.primarySparkle('root'),true)}
 for(const status of ['unknown','turn-ended','error','removed']){apply([{id:'root',state:status}]);assert.equal(c.primarySparkle('root'),false)}
 apply([{id:'child',rootSessionId:'root',isSubagent:true,state:'working'}]);assert.equal(c.primarySparkle('root'),false);
 apply([{id:'root',state:'working'}]);c.liveMode=false;assert.equal(c.primarySparkle('root'),false);
 c.liveMode=true;state.apply({schemaVersion:1,revision:revision++,removedAgentIds:['root']});assert.equal(c.primarySparkle('root'),false);
});
test('sparkle uses seconds, static motion gates, inherited opacity, and isolated expanded hill masks',()=>{
 const ctx=art(),calls=[],masks=[];ctx.globalAlpha=.4;
 const bounds={x:-40,y:-60,w:100,h:100},occluders=[[]];
 const c=vm.createContext({ctx,activeCameraMove:()=>({subjectIds:[],neighborOpacity:.5}),renderedTrees:[{s:{id:'root'},opacity:.8,sparkleBounds:bounds,sparkleOccluders:occluders}],
  primarySparkle:()=>true,anchorsOnScreen:new Map([['root',{x:10,y:20,actualHeight:80}]]),projectFilter:'p',searchFilter:'',matchingIds:new Set(),DPR:2,decorationTime:2345,motion:false,motionPreference:{matches:false},
  paintHillTree:(...args)=>{masks.push(args);args[4](ctx)},drawLiveSparkle:(...args)=>calls.push({alpha:ctx.globalAlpha,args})});
 vm.runInContext(extract('drawSpecimenSparkles'),c);c.drawSpecimenSparkles();
 assert.equal(calls[0].args[4],2.345);assert.equal(calls[0].args[5],'root');assert.equal(calls[0].args[6].reducedMotion,true);
 assert.ok(Math.abs(calls[0].alpha-.4*.8*.5*.52)<1e-12);assert.equal(ctx.globalAlpha,.4);
 assert.equal(masks[0][1],bounds);assert.equal(masks[0][2],occluders);assert.equal(masks[0][5],undefined,'never erase composed terrain directly');
 c.motion=true;c.motionPreference.matches=true;c.drawSpecimenSparkles();assert.equal(calls[1].args[6].reducedMotion,true);
});
test('both forest paths use prepared specimens; dynamic overlays cause no warm allocations or crown painting',async()=>{
 const {createGardenSpecimenRenderer}=await load('garden-specimen-renderer.js');
 const records=Array.from({length:80},(_,i)=>({id:'tree-'+i,species:['build','conversation','orchestration','slow-burn','quick'][i%5],sizeClass:i%5,density:['sparse','medium','dense'][i%3],fruit:i%6,visualKey:String(i)}));
 const encodings=new Map(records.map(s=>[s.id,s])),renderer=createGardenSpecimenRenderer({encoding:id=>encodings.get(id),scale:()=>.2,createCanvas:canvasFactory});
 const trees=records.map((s,i)=>({s,x:i,y:100,screen:{x:i,y:100},detailed:false})),surface=art();
 const c=vm.createContext({...motionDefaults(),performance,scale:.2,treeSize:2.8,treeYScale:1,DPR:1,W:1280,H:800,day:2,specimenVisualGeneration:1,specimenPreparationKey:'',
  renderedTrees:trees,botanical:renderer,baseCamera:{zoom:.2},motion:true,motionPreference:{matches:false},treeGrowth:{sample:()=>({active:false,trunk:1,branches:1,crown:1})},cloudArrivals:{entries:()=>[]},
  hitBounds:new Map(),anchorsOnScreen:new Map(),activeCameraMove:()=>null,projectFilter:'',searchFilter:'',matchingIds:new Set(),paintHillTree:(ctx,bounds,masks,dpr,draw)=>draw(ctx),
  targetsDirty:false,metadataDirty:false,canvas:{dataset:{}},$:()=>({dataset:{}}),forestCanvas:canvasFactory(1280,800),forestArt:surface,forestCache:null,targetButtons:new Map(),flight:null,tour:null,updateTargets(){},updateTargetGeometry(){},drawArcs(){}});
 vm.runInContext(motionHelpers()+'\n'+['prepareSpecimenRasters','drawTree','drawSymbol','boundsChanged','drawForest'].map(extract).join('\n'),c);
 for(const full of [false,true]){
  c.renderedTrees=trees.map(t=>({...t,detailed:full}));c.prepareSpecimenRasters();renderer.pump(Infinity);c.drawForest(surface,0);
  const before=renderer.stats();
  for(let time=1;time<=18;time++){c.decorationTime=time*17;c.prepareSpecimenRasters();c.drawForest(surface,time*17)}
  const after=renderer.stats();
  for(const key of ['proceduralRepaints','rasterAllocations','layerRepaints','preparations'])assert.equal(after[key],before[key],key);
  assert.equal(after.unpreparedDraws,0);assert.ok(after.bytes<=32*1024*1024);
  assert.equal(full?after.detailDraws:after.proxyDraws,80);
 }
});
test('raster demand prepares the whole dive set and ignores exact camera positions',()=>{
 const calls=[],c=vm.createContext({...motionDefaults(),performance,activeCameraMove:()=>null,renderedTrees:[{s:{id:'a'},screen:{x:0,y:0}},{s:{id:'b'},screen:{x:10,y:20}}],treeSize:2.8,scale:.1,DPR:2,specimenVisualGeneration:1,specimenPreparationKey:'',botanical:{profile:()=>({height:100}),prepare:(records,plan)=>calls.push({records:records.map(t=>({...t.screen})),plan})}});
 vm.runInContext(motionHelpers()+'\n'+extract('prepareSpecimenRasters'),c);c.prepareSpecimenRasters();c.renderedTrees.reverse();c.renderedTrees[0].screen.x=900;c.prepareSpecimenRasters();assert.equal(calls.length,1);
 c.prepareSpecimenRasters({subjectIds:['a'],rasterZoom:1.3,baseZoom:.1});assert.equal(calls.length,2);assert.equal(calls[1].records.length,2);
 assert.equal(c.renderedTrees.find(t=>t.s.id==='a').screen.rasterZoom,1.3);
});
test('dynamic composition shares the cached camera for water and trees; paper precedes labels and birds',()=>{
 const events=[],ctx=art();ctx.drawImage=canvas=>events.push(canvas.name);ctx.setTransform=()=>events.push('screen');
 const c=vm.createContext({...motionDefaults(),ctx,DPR:2,W:800,H:600,base:{name:'base',width:1600,height:1200},labelCanvas:{name:'labels',width:1600,height:1200},canvas:{dataset:{}},playback:{state:()=>({opacity:.8})},
  camera:{x:1,y:2,zoom:.2},baseCamera:{x:0,y:0,zoom:.1},contourView:{span:2000},environmentView:{drawWater:(ctx,time)=>events.push('water:'+time)},decorationTime:1234,
  rebuild(){events.push('refresh');c.baseCamera={...c.camera};},
  specimenEnvironment:{drawPaper:()=>events.push('paper')},drawObservatorySurface(){},drawForest:()=>events.push('forest'),drawTreeHover:()=>{events.push('hover');return {active:false};},botanical:{hoverState:()=>({active:false})},drawSpecimenSparkles:()=>events.push('sparkle'),drawArrivalClouds:()=>events.push('weather'),drawProjectLabels:()=>events.push('lot'),drawMoths:()=>events.push('birds'),drawCommitPulses:()=>events.push('commits'),drawSelection:()=>events.push('selection'),performance,
  $:()=>({dataset:{},style:{}}),dirty:true,fitVisibleGarden(){},layoutMotion:{active:false},driftEnabled:false,fitFollower:{active:false,reset(){},pose:null},cloudFitIds:null,fitHandoff:false,droneFlying:false,spotlight:null,gardenOrbit:{active:false},arrival:null,motion:false,displayedTrees:()=>[]});
 vm.runInContext(motionHelpers()+'\n'+extract('flightFadeAlpha')+'\n'+extract('drawGhostLayer')+'\n'+extract('drawDynamic'),c);c.drawDynamic(1234);
 assert.deepEqual(events,['refresh','screen','water:1234','base','forest','hover','sparkle','weather','screen','paper','labels','lot','birds','commits','selection']);
 assert.equal(ctx.globalAlpha,1);
 assert.ok(c.camera.zoom/c.baseCamera.zoom<=1.1);
 // Motion off still queues the terminal clear frame after a dropped display callback.
 c.drawTreeHover=()=>({active:true});c.botanical.hoverState=()=>({active:true});c.drawDynamic(160);assert.equal(c.dirty,true);
 c.drawTreeHover=()=>({active:false});c.botanical.hoverState=()=>({active:false});c.drawDynamic(240);assert.equal(c.dirty,false);
 // A slow paint crosses the ease endpoint after sampling a nonterminal image.
 let clock=110;c.performance={now:()=>clock};
 c.drawTreeHover=(target,now)=>{const rendered={active:now<120};clock=130;return rendered;};
 c.botanical.hoverState=now=>({active:now<120});
 c.drawDynamic(110);assert.equal(c.dirty,true,'the rendered 110ms image still needs a terminal repaint');
 c.drawDynamic(130);assert.equal(c.dirty,false,'the terminal image completes the transition');

});
test('terrain requests coalesce, reject old layouts, and never call the cold builder on the frame thread',()=>{
 const sent=[],worker={postMessage:message=>sent.push(message),terminate(){}};let ready=0;
 const c=vm.createContext({performance});vm.runInContext(source.slice(source.indexOf('function terrainWorkerMain('),source.indexOf("(()=>{'use strict'")),c);
 const prep=c.createTerrainPreparation({makeWorker:()=>worker,onReady:()=>ready++});
 const geometry={rings:[{points:[]}],depth:100,span:1000},options=x=>({width:800,height:600,unproject:(sx,sy,z)=>({x:sx*20+x,y:sy*20+z})});
 prep.request(geometry,options(0));for(let i=1;i<=30;i++)prep.request(geometry,options(i*10000));assert.equal(sent.length,1);
 const first=sent[0];worker.onmessage({data:{key:first.key,generation:first.generation,terrain:{id:'first'},buildMs:100}});assert.equal(sent.length,2);assert.equal(ready,1);
 const next={...geometry};prep.request(next,options(0));
 worker.onmessage({data:{key:sent[1].key,generation:first.generation,terrain:{id:'stale'},buildMs:100}});
 assert.equal(ready,1,'old layout results cannot install');assert.equal(sent.length,3);assert.ok(sent[2].geometry);
 worker.onmessage({data:{key:sent[2].key,generation:sent[2].generation,terrain:{id:'latest'},buildMs:50}});
 assert.equal(prep.request(next,options(0)).id,'latest');assert.equal(sent.length,3);assert.equal(prep.stats().pending,false);
});
test('worker and field keys agree through extreme zoom and repeated pans',async()=>{
 const [{buildIslandContours},{createHillEnvironment},{unprojectGround}]=await Promise.all(['garden-island-contours.js','garden-hill-environment.js','garden-robot-camera.js'].map(load));
 const c=vm.createContext({});vm.runInContext(extract('terrainRequestKey'),c);
 const geometry=buildIslandContours([{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}]),environment=createHillEnvironment();
 for(const zoom of [.1,1e-9]){
  const unproject=(x,y,z)=>unprojectGround((x-400)/zoom,(y-300)/zoom+z,.37),basis=[unproject(0,0,0),unproject(1,0,0),unproject(0,1,0),unproject(0,0,1)];
  assert.equal(c.terrainRequestKey(geometry,{width:800,height:600,basis}),environment(geometry,{width:800,height:600,unproject}).key);
 }
});
test('launcher imports specimen modules and retains the page interface',()=>{
 assert.match(source,/createGardenSpecimenRenderer\(/);assert.doesNotMatch(source,/createBotanicalRenderer|from '.\/botanical-renderer/);
 assert.match(source,/screenHeight:measured.actualHeight/);assert.match(source,/symbolBounds\(t.s,t.screen,scale\).bounds/);
 assert.match(source,/Fruit counts recorded file additions, capped at five/);
 const html=fs.readFileSync(directory+'index.html','utf8');assert.match(html,/src="canvas-garden.js"/);assert.doesNotMatch(html,/<header[ >]/);
 for(const match of source.matchAll(/(?:from\s+|import\s*)['"]\.\/([^'"]+)['"]/g))assert.ok(fs.existsSync(directory+match[1]),match[1]);
});

test('new child evidence changes orchestration in Live and respects the current History cutoff',()=>{
 for(const liveMode of [true,false]){
  const {context:c,data,root}=encodingHarness();let rebuilds=0;
  Object.assign(c,{sourceData:structuredClone(data),liveMode,allSessions:data.sessions,selected:c.sessions.find(s=>s.id==='a'),visibleSessions:[],treePlacements:[],renderedTrees:[],displayScene:null,
   performance,document:{hidden:false},motion:false,motionPreference:{matches:false},playback:{pause(){}},liveState:{snapshot:()=>data},
   prepareWorld(){c.refreshSpecimenEncodings();c.visibleSessions=c.sessions.filter(s=>s.birth<=c.day)},
   cloudArrivals:{sync(){}},work:s=>s.workByDay[c.day],spawnHold:{size:0,has:()=>false,hold(){},release:()=>[]},treeGrowth:{has:()=>true,restart(){},sync(){},settle(){}},buildWorldScene(){},gardenLayout:{},layoutMotion:{retarget:()=>null},modelCache:{clear(){}},
   rebuild(){rebuilds++},updateCard(){},updateMap(){},drawArcs(){},renderProjectSelect(){},syncPlaybackControls(){},syncSpawnCards(){}});
  vm.runInContext(['liveGeometryKey','mergeLiveEvidence'].map(extract).join('\n'),c);
  data.sessions=[...data.sessions,{...root('child2',1),isSubagent:true,rootSessionId:'a'}];
  c.mergeLiveEvidence({sessionIds:['child2'],projectIds:[],agentIds:[],snapshot:false});
  assert.equal(c.specimenEncodings.get('a').species,liveMode?'orchestration':'build');
  assert.equal(c.selected.id,'a');assert.equal(rebuilds,1);
  if(!liveMode){c.day=1;c.refreshSpecimenEncodings();assert.equal(c.specimenEncodings.get('a').species,'orchestration')}
 }
});

test('live specimen roots, size, and aspect remain uniform at 2.8 times in both draw paths',async()=>{
 const {createGardenSpecimenRenderer}=await load('garden-specimen-renderer.js');
 for(const species of ['build','conversation','orchestration','slow-burn','quick'])for(let sizeClass=0;sizeClass<5;sizeClass++){
  const record={id:species+sizeClass,species,sizeClass,density:'medium',fruit:2},origin={x:50,y:70};
  const unit=createGardenSpecimenRenderer({treeSize:1,encoding:()=>record}),scaled=createGardenSpecimenRenderer({treeSize:2.8,encoding:()=>record});
  const a=unit.settledBounds(record,origin,.3),b=scaled.symbolBounds(record,origin,.3),c=scaled.settledBounds(record,origin,.3);
  assert.equal(b.x,50);assert.equal(b.y,70);assert.ok(Math.abs(b.bounds.w/a.bounds.w-2.8)<1e-12);assert.ok(Math.abs(b.bounds.h/a.bounds.h-2.8)<1e-12);
  assert.equal(b.actualHeight,c.actualHeight);assert.equal(b.bounds.w,c.bounds.w);assert.equal(b.bounds.x,c.bounds.x);
 }
});

test('isolated tree masks include the full displaced shadow pool at every zoom',()=>{
 const c=vm.createContext({});vm.runInContext(extract('specimenClipBounds'),c);
 for(const zoom of [.01,.1,1,3]){
  const width=100*zoom,origin={x:400,y:500},fit={x:origin.x-width*.38,y:origin.y-200*zoom,w:width,h:200*zoom};
  const box=c.specimenClipBounds(fit,origin,zoom),r=width*.32;
  for(let i=0;i<100;i++){
   const angle=i*Math.PI*2/100,x=r*1.25*Math.cos(angle)*1.18,y=r*1.03*Math.sin(angle)*.72;
   const px=origin.x+r*.3+x*Math.cos(.28)-y*Math.sin(.28),py=origin.y+r*.22+x*Math.sin(.28)+y*Math.cos(.28);
   assert.ok(px>=box.x&&px<=box.x+box.w&&py>=box.y&&py<=box.y+box.h);
  }
 }
});
