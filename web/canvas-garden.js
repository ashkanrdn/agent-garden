import { createTimelineBrush, sessionInTimeRange } from './garden-timeline-brush.js';
import { OBSERVATORY, drawObservatorySurface } from './observatory-theme.js';
import { createGardenFlock } from './garden-flock.js';
import { createLayoutMotion } from './garden-layout-motion.js';
import { sampleAutoFit, sampleFocusReturn } from './garden-camera-motion.js';
import { GARDEN_ORBIT_MS, projectGround, unprojectGround, createGardenOrbit, createSpawnShotQueue,
 selectDiveSubjects, frameDiveSubjects, frameSpawnSubjects, sampleDiveTargets, sampleShowcaseTargets,
 canShowcaseTree, isCameraMoveComplete, releaseSpinVelocity, fitCloudSubjects, cloudFitContainment, createPoseFollower } from './garden-robot-camera.js';
import { buildDronePath, createGardenDrone } from './garden-drone-path.js';
import { buildGardenLayout, TREE_SPACING } from './garden-layout.js';
import { PLOT_HILL_SETTINGS, createPlotHills, hillDepth, createHillTreePainter } from './garden-plot-hills.js';
import { buildIslandContours, createIslandContourCache, drawIslandContours, drawIslandSurvey } from './garden-island-contours.js';
import { drawHillEnvironment } from './garden-hill-environment.js';
import { createPrintMaterials } from './print-materials.js';
import './garden-specimen-data.js';
import './garden-specimen-encoding.js';
import { createGardenSpecimenRenderer } from './garden-specimen-renderer.js';
import { createGardenSpecimenEnvironment } from './garden-specimen-environment.js';
import { drawLiveSparkle } from './specimen-tree-painter.js';
import { sampleFlight, cardFlightPlan, sampleCardFlight, fitCameraToScreenBounds } from './garden-flight.js';
import { createTreeGrowth, createSpawnHold, TREE_EMERGENCE_MS } from './tree-growth.js';
import { plantTrees, pointInPolygon, insetPolygon, frontAnchor } from './tree-placement.js';
import { createGardenPlayback, GARDEN_PLAYBACK_SPEEDS } from './garden-playback.js';
import { createCloudArrivals } from './procedural-clouds.js';
import { createGardenArrivalCloud, drawGardenArrivalCloud, drawGardenArrivalLight, gardenWeatherBounds, arrivalCloudExtent, arrivalCloudView, arrivalCloudBounds } from './garden-arrival-weather.js';
import { loadCloudPigment } from './cloud-brush-texture.js';
import { createGardenLiveState } from './garden-live-state.js';
import { createGardenMessagePager } from './garden-live-messages.js';
import { createGardenDataSource, mountGardenUpload } from './garden-upload.js';
import { createSpawnCardStack, spawnCardRecord } from './garden-spawn-cards.js';
import { largestSessionIds } from './garden-session-labels.js';
import { buildDailyProjectActivity, layoutActivityCells } from './garden-activity-strip.js';

// The cold Perlin/water build belongs to a worker, including its three-field cache.
// These functions also run in the Node integration checks without a browser harness.
// The reply is a flat typed-array payload (transferred, not cloned); unpackTerrain rebuilds the object graph.
function terrainWorkerMain(createEnvironment,send,listen){
 const pack=terrain=>{
  let F=new Float64Array(1<<16),fn=0,U=new Uint32Array(1<<15),un=0;
  const pf=v=>{if(fn===F.length){const g=new Float64Array(fn*2);g.set(F);F=g}F[fn++]=v};
  const pu=v=>{if(un===U.length){const g=new Uint32Array(un*2);g.set(U);U=g}U[un++]=v};
  const p3=p=>{pf(p.x);pf(p.y);pf(p.z)};
  const poly=points=>{pu(points.length);for(const p of points)p3(p)};
  const {layers,vertices,faces,water,...meta}=terrain;
  pu(vertices.length);for(const v of vertices){pf(v.x);pf(v.y);pf(v.z);pf(v.value)}
  pu(faces.length);
  for(const face of faces){
   pu(face.indices.length);for(const i of face.indices)pu(i);
   pf(face.tone);pf(face.x);pf(face.y);pu(face.segments.length);
   for(const segment of face.segments){if(segment.points.length!==2)throw Error('segment');pu(segment.level);pu(segment.major?1:0);p3(segment.points[0]);p3(segment.points[1])}
  }
  pu(layers.length);
  for(const layer of layers){pf(layer.iso);pf(layer.z);pu(layer.major?1:0);pu(layer.hulls.length);for(const hull of layer.hulls){pu(hull.length);for(const p of hull){pf(p.x);pf(p.y)}}}
  pf(water.level);
  pu(water.faces.length);for(const face of water.faces){pu(face.faceIndex);pu(face.wet.length);for(const wet of face.wet)poly(wet);poly(face.dry)}
  pu(water.shoreSegments.length);for(const segment of water.shoreSegments){pu(segment.faceIndex);poly(segment.points);pf(segment.land.x);pf(segment.land.y)}
  const floats=F.slice(0,fn),uints=U.slice(0,un);
  return {payload:{meta,floats,uints},transfer:[floats.buffer,uints.buffer]};
 };
 const environment=createEnvironment();let geometry=null,generation=-1;
 listen(message=>{
  if(message.geometry){geometry=message.geometry;generation=message.generation}
  const started=performance.now(),[o,x,y,z]=message.basis;
  const unproject=(sx,sy,sz)=>({x:o.x+sx*(x.x-o.x)+sy*(y.x-o.x)+sz*(z.x-o.x),y:o.y+sx*(x.y-o.y)+sy*(y.y-o.y)+sz*(z.y-o.y)});
  const terrain=environment(geometry,{width:message.width,height:message.height,unproject});
  const reply={key:message.key,generation,buildMs:performance.now()-started,cache:environment.stats()};
  let transfer=[];
  try{const packed=pack(terrain);reply.packed=packed.payload;transfer=packed.transfer}catch(failure){reply.terrain=terrain}
  send(reply,transfer);
 });
}
// Main-thread inverse of the worker codec. Reads the two streams in exactly the order pack wrote them.
// It is a generator so the terrain preparation can spend a few milliseconds per turn instead of one long hitch.
function* unpackTerrainSteps({meta,floats:F,uints:U}){
 let fi=0,ui=0;
 const p3=()=>{const p={x:F[fi],y:F[fi+1],z:F[fi+2]};fi+=3;return p};
 const poly=()=>{const n=U[ui++],out=new Array(n);for(let i=0;i<n;i++)out[i]=p3();return out};
 const vertices=new Array(U[ui++]);
 for(let i=0;i<vertices.length;i++){vertices[i]={x:F[fi],y:F[fi+1],z:F[fi+2],value:F[fi+3]};fi+=4;if((i&511)===511)yield}
 const faces=new Array(U[ui++]);
 for(let i=0;i<faces.length;i++){
  const count=U[ui++],indices=new Array(count);for(let k=0;k<count;k++)indices[k]=U[ui++];
  const tone=F[fi],x=F[fi+1],y=F[fi+2];fi+=3;
  const segments=new Array(U[ui++]);
  for(let k=0;k<segments.length;k++){const level=U[ui++],major=U[ui++]===1,a=p3(),b=p3();segments[k]={points:[a,b],major,level}}
  faces[i]={indices,segments,tone,x,y};if((i&255)===255)yield;
 }
 const layers=new Array(U[ui++]);
 for(let i=0;i<layers.length;i++){
  const iso=F[fi],z=F[fi+1],major=U[ui++]===1;fi+=2;
  const hulls=new Array(U[ui++]);
  for(let h=0;h<hulls.length;h++){const n=U[ui++],hull=new Array(n);for(let k=0;k<n;k++){hull[k]={x:F[fi],y:F[fi+1]};fi+=2}hulls[h]=hull}
  layers[i]={iso,z,major,hulls};
  if((i&3)===3)yield;
 }
 const level=F[fi++],waterFaces=new Array(U[ui++]),wetPolygons=[];
 for(let i=0;i<waterFaces.length;i++){
  const faceIndex=U[ui++],wet=new Array(U[ui++]);
  for(let k=0;k<wet.length;k++){wet[k]=poly();wetPolygons.push(wet[k])}
  waterFaces[i]={faceIndex,wet,dry:poly()};if((i&255)===255)yield;
 }
 const shoreSegments=new Array(U[ui++]);
 for(let i=0;i<shoreSegments.length;i++){const faceIndex=U[ui++],points=poly(),land={x:F[fi],y:F[fi+1]};fi+=2;shoreSegments[i]={points,faceIndex,land};if((i&255)===255)yield}
 return {...meta,layers,vertices,faces,water:{level,wetPolygons,shoreSegments,faces:waterFaces}};
}
function unpackTerrain(packed){const steps=unpackTerrainSteps(packed);let step;do{step=steps.next()}while(!step.done);return step.value}
function terrainRequestKey(geometry,{width,height,basis}){
 const [o,x,y,z]=basis,baseZ=-geometry.depth-geometry.span*.04,rise=geometry.span*.46,corners=[];
 for(const sz of [baseZ,baseZ+rise])for(const sx of [-240,width+240])for(const sy of [-240,height+240])
  corners.push({x:o.x+sx*(x.x-o.x)+sy*(y.x-o.x)+sz*(z.x-o.x),y:o.y+sx*(x.y-o.y)+sy*(y.y-o.y)+sz*(z.y-o.y)});
 const minX=Math.min(...corners.map(p=>p.x)),maxX=Math.max(...corners.map(p=>p.x)),minY=Math.min(...corners.map(p=>p.y)),maxY=Math.max(...corners.map(p=>p.y));
 const step=2**Math.ceil(Math.log2(Math.max(maxX-minX,maxY-minY)/88)),tile=step*16,x0=Math.floor(minX/tile)*tile,y0=Math.floor(minY/tile)*tile;
 return [x0,y0,step,Math.ceil((maxX-x0)/tile)*16+1,Math.ceil((maxY-y0)/tile)*16+1,Math.max(0,Math.floor(Math.log2(step*28/geometry.span)))].join('/');
}
function createTerrainPreparation({moduleURL,onReady,makeWorker,fadeMs=160,sliceMs=3}){
 let worker=null,geometry=null,generation=0,sentGeneration=-1,pending=null,inFlight=null,current=null,currentKey='',currentGeneration=-1,error=null;
 let requests=0,completions=0,lastBuildMs=0,lastRequestMs=0,maxRequestMs=0,cache=null,lastUnpackMs=0,maxSliceMs=0,swaps=0,fadeFrom=null,fadeStart=0;
 let job=null,jobKey='',jobGeneration=-1,jobTimer=null,jobMs=0;
 const install=(terrain,key,at)=>{
  // Keep the previous terrain on screen and dissolve to the new one; it must never blank.
  if(current){fadeFrom=current;fadeStart=performance.now()}
  current=terrain;currentKey=key;currentGeneration=at;swaps++;onReady();
 };
 // Unpack a few milliseconds per turn; a superseded layout abandons the job without finishing it.
 const runJob=()=>{
  jobTimer=null;if(!job)return;
  if(jobGeneration!==generation){job=null;return}
  const started=performance.now();let step;
  do{step=job.next()}while(!step.done&&performance.now()-started<sliceMs);
  const spent=performance.now()-started;jobMs+=spent;maxSliceMs=Math.max(maxSliceMs,spent);
  if(!step.done){jobTimer=setTimeout(runJob,0);return}
  job=null;lastUnpackMs=jobMs;install(step.value,jobKey,jobGeneration);flush();
 };
 const start=()=>{
  if(worker||error)return;
  try{
   if(makeWorker)worker=makeWorker();
   else{
    const script=`import {createHillEnvironment} from ${JSON.stringify(moduleURL)};(${terrainWorkerMain.toString()})(createHillEnvironment,(value,transfer)=>postMessage(value,transfer),receive=>{onmessage=event=>receive(event.data)});`;
    const url=URL.createObjectURL(new Blob([script],{type:'text/javascript'}));
    try{worker=new Worker(url,{type:'module'})}finally{URL.revokeObjectURL(url)}
   }
   worker.onmessage=({data})=>{
    inFlight=null;completions++;lastBuildMs=data.buildMs;cache=data.cache;
    // Results for a superseded layout are dropped before any unpacking work happens.
    if(data.generation===generation){
     if(jobTimer!==null){clearTimeout(jobTimer);jobTimer=null}
     if(data.packed){
      job=unpackTerrainSteps(data.packed);jobKey=data.key;jobGeneration=data.generation;jobMs=0;
      if(typeof setTimeout==='function')runJob();
      else{lastUnpackMs=0;const terrain=unpackTerrain(data.packed);job=null;install(terrain,data.key,data.generation)}
     }else{job=null;install(data.terrain,data.key,data.generation)}
    }
    flush();
   };
   worker.onerror=event=>{error=event.message||'Terrain worker failed';inFlight=null;pending=null;worker.terminate();worker=null;onReady()};
  }catch(failure){error=failure.message}
 };
 const flush=()=>{
  if(!pending||inFlight||error)return;
  if(pending.key===currentKey&&pending.generation===currentGeneration){pending=null;return}
  if(job&&pending.key===jobKey&&pending.generation===jobGeneration){pending=null;return}
  start();if(!worker)return;
  const message=pending;pending=null;
  if(sentGeneration!==message.generation){message.geometry=geometry;sentGeneration=message.generation}
  inFlight=message;requests++;worker.postMessage(message);
 };
 return {
  request(next,{width,height,unproject}){
   const started=performance.now();
   // A new geometry keeps the previous terrain (current) until its replacement lands.
   if(next!==geometry){geometry=next;generation++;pending=null}
   if(!next.rings.length){current=null;currentKey='';currentGeneration=-1;fadeFrom=null;job=null;return null}
   const basis=[unproject(0,0,0),unproject(1,0,0),unproject(0,1,0),unproject(0,0,1)];
   const key=terrainRequestKey(next,{width,height,basis});
   if(key!==currentKey||currentGeneration!==generation){
    pending={key,generation,width,height,basis};
    if(inFlight?.key===key&&inFlight.generation===generation||job&&jobKey===key&&jobGeneration===generation)pending=null;
    flush();
   }else pending=null;
   lastRequestMs=performance.now()-started;maxRequestMs=Math.max(maxRequestMs,lastRequestMs);
   return current;
  },
  // {from,alpha} while the newest terrain dissolves over the one it replaced; null when settled.
  fade(now=performance.now()){
   if(!fadeFrom)return null;
   const t=(now-fadeStart)/fadeMs;
   if(t>=1||t<0){fadeFrom=null;return null}
   return {from:fadeFrom,alpha:t*t*(3-2*t)};
  },
  stats:()=>({worker:true,pending:!!pending||!!inFlight||!!job,requests,completions,swaps,lastBuildMs,lastUnpackMs,maxSliceMs,lastRequestMs,maxRequestMs,fading:!!fadeFrom,cache,error}),
 };
}

(()=>{'use strict';const SEED='483765r937n';
function random(key){let h=2166136261;for(const c of SEED+'/'+key)h=Math.imul(h^c.charCodeAt(0),16777619);return()=>{h+=0x6D2B79F5;let t=h;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296}}
const V=(x=0,y=0,z=0)=>({x,y,z}),add=(a,b)=>V(a.x+b.x,a.y+b.y,a.z+b.z),sub=(a,b)=>V(a.x-b.x,a.y-b.y,a.z-b.z),mul=(a,t)=>V(a.x*t,a.y*t,a.z*t),mag=a=>Math.hypot(a.x,a.y,a.z),norm=a=>mul(a,1/(mag(a)||1)),cross=(a,b)=>V(a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x),dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
function rotate(v,axis,theta){axis=norm(axis);return add(add(mul(v,Math.cos(theta)),mul(cross(axis,v),Math.sin(theta))),mul(axis,dot(axis,v)*(1-Math.cos(theta))))}
function gitSkeleton(s){let segments=[],nodes=[],merges=[],lookup=new Map(),children=new Map(),seed=random('evidence/'+s.id);for(const c of s.commits.slice(0,64))if(c.parents[0]){let a=children.get(c.parents[0])||[];a.push(c.id);children.set(c.parents[0],a)}
if(s.kind==='unknown'){let a=V(),b=V(0,0,65);segments.push({a,b,r0:3.1,r1:1.5,birth:s.birth,evidence:false,neutral:true,rank:0,anchorDay:s.birth});nodes.push({id:s.id+'-neutral',p:b,dir:V(0,0,1),day:s.birth,depth:0});return{segments,nodes,merges,children}}
for(const c of s.commits.slice(0,64)){let parent=lookup.get(c.parents[0]),depth=parent?parent.depth+1:0,dir=parent?parent.dir:V(0,0,1),a=parent?parent.p:V(),fork=parent&&(children.get(parent.id)||[]).length>1;if(fork){let list=children.get(parent.id),i=list.indexOf(c.id),side=i===0?-1:1;let azimuth=(seed()-.5)*.8;let axis=norm(V(Math.sin(azimuth),Math.cos(azimuth),.04));dir=norm(rotate(parent.dir,axis,side*.58))}let b=add(a,mul(dir,parent?18:29));let n={...c,p:b,dir,depth};nodes.push(n);lookup.set(c.id,n);segments.push({a,b,r0:Math.max(1.3,4-depth*.38),r1:Math.max(.9,3.7-depth*.38),birth:c.day,evidence:true,commit:c.id,rank:depth,anchorDay:c.day});for(let other of c.parents.slice(1)){let from=lookup.get(other);if(from)merges.push({a:from.p,b,n1:from.id,n2:c.id,day:c.day})}}
return{segments,nodes,merges,children}}
function appendTwig(out,a,b,r0,r1,rank,anchor){out.push({a,b,r0,r1,rank,anchorDay:anchor.day,anchorId:anchor.id,evidence:false,birth:anchor.day})}
function anchors(s,skeleton){if(s.kind==='unknown')return skeleton.nodes;let nodes=skeleton.nodes;return nodes.filter((n,i)=>!(skeleton.children.get(n.id)||[]).length||i%3===2)}
function bifurcation(s,sk){let out=[],rng=random(s.id+'/bifurcation');function recur(a,dir,len,depth,max,anchor){let b=add(a,mul(dir,len));appendTwig(out,a,b,.34+depth*.27,.22+depth*.23,(max-depth)/max,anchor);if(depth<=0)return;let axis=norm(cross(dir,V(Math.cos(rng()*6.28),Math.sin(rng()*6.28),.35)));for(let side of[-1,1]){let d=norm(add(rotate(dir,axis,side*(.52+rng()*.15)),V(0,0,.14)));recur(b,d,len*(.68+rng()*.07),depth-1,max,anchor)}}for(const anchor of anchors(s,sk)){let dir=norm(add(mul(anchor.dir,.65),V((rng()-.5)*.7,(rng()-.5)*.7,.75)));recur(anchor.p,dir,30,4,4,anchor)}return out}
let projects=[],sessions=[],sourceData=null,visibleSessions=[],projectFilter='',searchFilter='',maxDay=0,startTime=0,endTime=0,loading=true,loadError='',allSessions=[],dailyActivity=[];
const $=id=>document.getElementById(id),canvas=$('garden'),ctx=canvas.getContext('2d'),base=document.createElement('canvas'),art=base.getContext('2d'),arc=$('arc-canvas'),arcCtx=arc.getContext('2d'),activityCanvas=$('activity-strip'),activityArt=activityCanvas.getContext('2d'),motionPreference=matchMedia('(prefers-reduced-motion: reduce)');let day=0,selected=null,hoverSession=null,hoverTreeId=null,hoverProject=null,hoverPath=null,pinnedPath=null,mapSession=null,pinnedMap=null,mapKey='',dismissUntil=0,leaveTimer=null,replay=null,playback=null,motion=!motionPreference.matches,scrubbing=false,W=0,H=0,DPR=1,scale=1,dirty=true,lastFrame=0,decorationTime=0,labelMeasureKey='',labelMeasuredHeight=0;const modelCache=new Map(),anchorsOnScreen=new Map(),hitBounds=new Map();const INK=OBSERVATORY.ink,PAPER=OBSERVATORY.background,TEAL='#A3C7CF',CORAL='#DDC494';
const islandContours=createIslandContourCache(),targetContours=createIslandContourCache();let contourView=null,environmentView=null;
const specimenEnvironment=createGardenSpecimenEnvironment({theme:OBSERVATORY});
const terrainPreparation=createTerrainPreparation({moduleURL:new URL('./garden-hill-environment.js',import.meta.url).href,onReady:()=>requestCameraDraw()});
const plotHills=createPlotHills(),paintHillTree=createHillTreePainter(()=>document.createElement('canvas'));let plotHillView=null;
const layoutMotion=createLayoutMotion();let displayScene=null,driftEnabled=true,ambientSuspended=false,driftBase=null,driftStart=0,spotlight=null,overviewFit=null,focusedProject=null,commitPulses=[],seenCommits=null;
const treeGrowth=createTreeGrowth();let growthDay=null,largestSessions=new Set(),renderedTrees=[],targetsDirty=false,metadataDirty=false,proxyView=true;
const spawnShots=createSpawnShotQueue(),spawnHold=createSpawnHold();
const cloudArrivals=createCloudArrivals({cloudFactory:createGardenArrivalCloud,onComplete:id=>treeGrowth.settle([id])});let cloudTexture=null,cloudTextureRequested=false,weatherRenderStats=new Map();
const labelCanvas=document.createElement('canvas'),labelArt=labelCanvas.getContext('2d');
const forestCanvas=document.createElement('canvas'),forestArt=forestCanvas.getContext('2d');let forestCache=null;
// Flight double buffer: two fixed ghost canvases keep the stretched previous base/forest while the crisp rebuild fades in.
const ghostBase=document.createElement('canvas'),ghostForest=document.createElement('canvas'),flightFade={active:false,cam:null,start:0,forestStart:null,defer:0},FLIGHT_FADE_MS=120;
const materials=createPrintMaterials({seed:SEED});
const treeSize=2.8,treeYScale=1;
let timeRange=null;
let specimenEncodings=new Map(),evidenceGeneration=0,encodingCacheKey='',specimenVisualGeneration=0,specimenPreparationKey='';
const {encodeGardenSpecimens}=globalThis.GardenSpecimenEncoding;
// Keep the diagnostic name compatible; every live tree path uses the specimen renderer.
const botanical=createGardenSpecimenRenderer({theme:OBSERVATORY,scale:()=>scale,treeSize:()=>treeSize,dpr:()=>DPR,encoding:id=>specimenEncodings.get(id)});
const flock=createGardenFlock();let boidTrails=true;
const sessionRecords=new Map();
const liveState=createGardenLiveState();let liveMode=false,liveStream=null,selectedAgentId=null,liveReady=false;
const spawnCards=createSpawnCardStack({host:$('spawn-cards'),onSelect:id=>{pin(sessions.find(session=>session.id===id));focusSelected()}});
const dataSource=createGardenDataSource({pageURL:location.href});
const messagesPager={...createGardenMessagePager({
 fetchPage:async(root,agent,cursor)=>{if(dataSource.mode!=='local')return {messages:[],nextCursor:null};const url=new URL('/api/live/messages',location.href);url.searchParams.set('rootSessionId',root);url.searchParams.set('agentId',agent);url.searchParams.set('limit','20');if(cursor)url.searchParams.set('cursor',cursor);const response=await dataSource.fetchLocal(url,{cache:'no-store'});if(!response.ok)throw Error('Messages unavailable ('+response.status+')');return response.json()},
 onChange:(state,options)=>renderMessages(state,options),
}),get available(){return dataSource.mode==='local'}};
const upload=mountGardenUpload({source:dataSource,pageURL:location.href,onData:applyDataset,onMode:configureDataMode,onLocal:async()=>{await loadData();advanceLiveClock();connectLive()}});
function projectTree(p,o){const e=o.embedding||{vertical:1,spread:1,lean:0,phase:0},stretch=o.renderStretch||{x:1,y:1},unit=o.unitScale??scale;const x=p.x*e.spread+(Math.sin(p.z*.033+e.phase)-Math.sin(e.phase))*e.lean,y=p.y*e.spread+(Math.sin(p.z*.023+e.phase+1.1)-Math.sin(e.phase+1.1))*e.lean*.45,z=p.z*e.vertical;return{x:o.x+(x-y)*.74*unit*stretch.x,y:o.y+((x+y)*.29*unit-z*unit)*stretch.y}}
function polygon(c,ps,fill,stroke=INK,lw=.6){c.beginPath();ps.forEach((p,i)=>i?c.lineTo(p.x,p.y):c.moveTo(p.x,p.y));c.closePath();if(fill){c.fillStyle=fill;c.fill()}if(stroke){c.strokeStyle=stroke;c.lineWidth=lw;c.stroke()}}
function line(c,a,b,color=INK,width=1){c.strokeStyle=color;c.lineWidth=width;c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.stroke()}
function groundPolygon(vertices,z=0){return vertices.map(p=>point(p.x,p.y,z))}
function groundRect(r,z=0){return[point(r.x,r.y,z),point(r.x+r.w,r.y,z),point(r.x+r.w,r.y+r.h,z),point(r.x,r.y+r.h,z)]}
function model(s){if(modelCache.has(s.id))return modelCache.get(s.id);const g=gitSkeleton(s),twigs=bifurcation(s,g),dist=new Map(),max=new Map(),key=(id,p)=>id+':'+[p.x,p.y,p.z].map(n=>n.toFixed(5)).join(',');for(const t of twigs){t.start=dist.get(key(t.anchorId,t.a))||0;t.end=t.start+mag(sub(t.b,t.a));dist.set(key(t.anchorId,t.b),t.end);max.set(t.anchorId,Math.max(max.get(t.anchorId)||0,t.end))}for(const t of twigs){t.start=.04+t.start/max.get(t.anchorId)*.86;t.end=.04+t.end/max.get(t.anchorId)*.86}const result={...g,twigs};modelCache.set(s.id,result);return result}
function drawTree(c,s,x,y,growth=null,origin=point(x,y,3)){const move=activeCameraMove(),subject=move?.subjectIds.includes(s.id);const result=botanical.tree(c,s,{...origin,modelX:x,modelY:y,rasterZoom:move?(subject?move.rasterZoom:move.baseZoom):undefined},growth,true);anchorsOnScreen.set(s.id,result);hitBounds.set(s.id,result.bounds);return result}

function syncPlaybackControls(){
 const state=playback?.state()||{playing:false};
 const button=$('play');if(button){button.textContent=state.playing?'Ⅱ':'▶';button.setAttribute('aria-label',state.playing?'Pause historical replay':'Play historical replay');button.setAttribute('aria-pressed',String(state.playing))}
 const speed=$('playback-speed');if(speed){const current=playback?.getSpeed?.()||1,next=GARDEN_PLAYBACK_SPEEDS[(GARDEN_PLAYBACK_SPEEDS.indexOf(current)+1)%GARDEN_PLAYBACK_SPEEDS.length];const duration=seconds=>seconds>=60?`${Math.floor(seconds/60)} min${seconds%60?` ${seconds%60} sec`:''}`:`${seconds} sec`;speed.textContent=current+'×';speed.dataset.speed=String(current);speed.setAttribute('aria-label',`Playback speed ${current}×. Next ${next}×.`);speed.title=`${current}× · ${duration(300/current)} timeline · ${duration(14/current)} weather; camera visits add time. Next ${next}×.`}
 if($('time'))$('time').value=String(day);
}
function setProxyView(enabled){proxyView=!!enabled;rebuild();dirty=true;return proxyView}
function setTrails(enabled){boidTrails=!!enabled;dirty=true;return boidTrails}
function setMotion(enabled){
 motion=!!enabled&&!motionPreference.matches;
 if(!motion){displayScene=layoutMotion.settle();commitPulses=[];treeGrowth.settle();cloudArrivals.settle();stopFlight('Camera still · motion is off')}
 else resumeAmbientCamera();
 document.body.dataset.gardenMotion=motion?'on':'off';
 syncTour();rebuild();syncMotionControls();dirty=true;return motion;
}
function pauseReplay(){if(playback)playback.pause();replay=null;syncPlaybackControls()}
function revealMap(s){if(mapSession!==s.id||$('file-map').hidden)document.querySelector('.inspector-rail').scrollTop=0;mapSession=s.id}
function setTreeHover(id){if(hoverTreeId===id)return;hoverTreeId=id;botanical.setHovered(id,performance.now());dirty=true}
function leaveTree(){setTreeHover(null);scheduleLeave()}
function previewTree(session,event){
 if(pointerGesture)return;
 if(!session||terrainHidesTree(event||{},session.id)){if(hoverTreeId===session?.id)leaveTree();return}
 if(hoverTreeId===session.id)return;
 preview(session);if(hoverSession===session.id)setTreeHover(session.id);
}
function preview(s){if(!s||flight||tour||spotlight||performance.now()<dismissUntil)return;stopAmbientCamera();clearTimeout(leaveTimer);hoverSession=s.id;hoverProject=null;hoverPath=null;updateCard();updateMap();drawArcs();dirty=true}
function leave(){clearTimeout(leaveTimer);hoverSession=null;setTreeHover(null);hoverProject=null;hoverPath=null;updateCard();updateMap();drawArcs();if(!pinnedMap&&!mapSession&&!(typeof scrubbing!=='undefined'&&scrubbing))resumeAmbientCamera();dirty=true}
function scheduleLeave(){clearTimeout(leaveTimer);leaveTimer=setTimeout(leave,650)}function dismiss(){dismissUntil=performance.now()+450;pinnedMap=null;mapSession=null;leave();resumeAmbientCamera();updateMap()}
function partition(items,r){if(!items.length)return[];if(items.length===1)return[{item:items[0],...r}];const total=items.reduce((n,i)=>n+i.bytes,0);let sum=0,best=1,error=Infinity;for(let i=1;i<items.length;i++){sum+=items[i-1].bytes;const e=Math.abs(sum-total/2);if(e<error){best=i;error=e}}const a=items.slice(0,best),b=items.slice(best),ratio=a.reduce((n,i)=>n+i.bytes,0)/total;if(r.w>=r.h){const w=r.w*ratio;return[...partition(a,{x:r.x,y:r.y,w,h:r.h}),...partition(b,{x:r.x+w,y:r.y,w:r.w-w,h:r.h})]}const h=r.h*ratio;return[...partition(a,{x:r.x,y:r.y,w:r.w,h}),...partition(b,{x:r.x,y:r.y+h,w:r.w,h:r.h-h})]}
const DAY=86400000;
function atDay(at){const ms=Date.parse(at);return Number.isFinite(ms)?Math.max(0,Math.floor((ms-startTime)/DAY)):null}
function cutoff(){return day===maxDay?endTime:Math.min(endTime,startTime+(day+1)*DAY-1)}
function work(s){return s?.workByDay?.[Math.min(day,maxDay)]||0}
function shownScore(s){return work(s).toFixed(1)}
function countAt(events){return events.reduce((n,e)=>n+(e.day<=day?(e.count??1):0),0)}
function createOption(value,label,selected=false){const o=document.createElement('option');o.value=value;o.textContent=label;o.selected=selected;return o}
function parseData(data){
  if(data?.schemaVersion!==1||data?.workScore?.version!==1)throw Error('This data schema or work score version is unsupported. Run the current export script.');
  if(!data||!Array.isArray(data.sessions)||!Array.isArray(data.projects))throw Error('The file has no valid sessions or projects. Run the export script again.');
  const initial=Date.parse(data.timeRange?.start),ending=Date.parse(data.timeRange?.end||data.generatedAt);
  if(!Number.isFinite(initial)||!Number.isFinite(ending)||ending<initial)throw Error('The file has an invalid history range.');
  sourceData=data;allSessions=data.sessions;
  timeRange=null;timelineBrush.clear();selectedAgentId=null;
  startTime=Math.floor(initial/DAY)*DAY;endTime=ending;maxDay=Math.max(0,Math.floor((endTime-startTime)/DAY));day=0;
  playback=createGardenPlayback({maxDay,durationMs:300000,holdMs:1800,resetMs:500});playback.pause();day=maxDay;liveMode=dataSource.mode==='local';syncPlaybackControls();
  deriveGardenRecords(data);
  if(typeof refreshActivityStrip==='function')refreshActivityStrip();
  selected=sessions.find(s=>s.fileEvents.length)||sessions[0]||null;hoverSession=null;setTreeHover(null);hoverProject=null;scrubbing=false;pinnedPath=null;mapSession=null;pinnedMap=null;projectFilter='';searchFilter='';sceneKey='';displayScene=null;layoutMotion.settle();seenCommits=null;commitPulses=[];overviewFit=null;driftBase=null;spotlight=null;camera.auto=true;ambientSuspended=false;driftEnabled=motion&&!motionPreference.matches;mapKey='';treeGrowth.clear();growthDay=null;modelCache.clear();botanical.clear();specimenPreparationKey='';flock.clear();if($('session-search'))$('session-search').value='';$('time').max=String(maxDay);$('time').value=String(day);
  arrival=null;showcase=null;lastArrivalAt=-Infinity;idleAfter=performance.now()+3000;cloudArrivals.clear();spawnShots.clear();spawnReturn=null;robotTime=0;camera.yaw=0;gardenOrbit.reset();orbitFrameCache=null;orbitLastTime=0;spinCoast=false;
  $('track-dates')?.replaceChildren(...[0,1/3,2/3,1].map(f=>{const e=document.createElement('span');e.textContent=dateText(Math.round(maxDay*f));return e}));
  renderImportDetails();renderProjectSelect();loading=false;loadError='';
}
function deriveGardenRecords(data){
  const projectIndex=new Map();projects=data.projects.map((p,i)=>{projectIndex.set(p.id,i);return {...p,birth:maxDay,unknown:[],allPrimary:[]}});
  sessionRecords.clear();for(const record of data.sessions)sessionRecords.set(record.id,record);
  const byId=sessionRecords;
  sessions=data.sessions.filter(s=>!s.isSubagent&&!s.isGuardian).map(s=>({...s,p:projectIndex.get(s.projectId),birth:atDay(s.createdAt)??0,agents:[],fileEvents:[],fileMap:new Map(),commits:[],kind:'unknown',family:'bifurcation',score:12,workByDay:new Float64Array(maxDay+1),dailyWorkByDay:new Float64Array(maxDay+1),members:[]})).filter(s=>s.p!==undefined);
  const roots=new Map(sessions.map(s=>[s.id,s]));
  for(const raw of data.sessions){const project=projects[projectIndex.get(raw.projectId)],birth=atDay(raw.createdAt);if(project&&birth!==null)project.birth=Math.min(project.birth,birth);const root=roots.get(raw.isSubagent?raw.rootSessionId:raw.id);if(!root)continue;root.members.push(raw);if(raw.isSubagent&&!raw.isGuardian){const d=atDay(raw.createdAt);if(d!==null)root.agents.push(d)}}
  for(const c of data.commits||[]){const p=projects[projectIndex.get(c.projectId)];if(!p)continue;const d=atDay(c.at);if(d===null)continue;const owner=c.sessionId||c.ownerSessionId;const verified=c.ownership==='verified'||c.ownership==='exact';const raw=byId.get(owner),root=raw&&roots.get(raw.isSubagent?raw.rootSessionId:raw.id);const commit={...c,id:c.sha||c.id,parents:c.parentShas||c.parents||[],day:d,owner:verified&&root?root.id:null};if(verified&&root&&root.projectId===c.projectId)root.commits.push(commit);else p.unknown.push(commit)}
  for(const s of sessions){
    const increments=Array.from({length:maxDay+1},()=>({tool:0,turn:0,file:0,agent:0,commit:0}));
    for(const member of s.members){
      for(const e of member.activity||[]){const d=atDay(e.at);if(d===null||d>maxDay||d<s.birth)continue;if(e.kind==='tool'||e.kind==='turn')increments[d][e.kind]+=Math.max(0,Number(e.count)||0)}
      for(const f of member.files||[]){const valid=(f.events||[]).map(e=>({...e,day:atDay(e.at)})).filter(e=>e.day!==null&&e.day<=maxDay&&e.day>=s.birth);if(!valid.length)continue;
        const path=member.projectId===s.projectId?f.path:(f.absolutePath||f.path),key=member.projectId+'|'+f.path;
        let current=s.fileMap.get(key);if(!current){current={...f,path,events:[],firstDay:maxDay,lastDay:0,projectId:member.projectId};s.fileMap.set(key,current)}
        current.events.push(...valid);current.firstDay=Math.min(current.firstDay,...valid.map(e=>e.day));current.lastDay=Math.max(current.lastDay,...valid.map(e=>e.day));
        if(Number.isFinite(f.bytes)&&(!Number.isFinite(current.bytes)||Date.parse(f.bytesObservedAt)>Date.parse(current.bytesObservedAt))){current.bytes=f.bytes;current.bytesObservedAt=f.bytesObservedAt;current.bytesSource=f.bytesSource;current.absolutePath=f.absolutePath}
      }
    }
    const paths=new Map();for(const f of s.fileMap.values()){if(paths.has(f.path)){const existing=paths.get(f.path);existing.events.push(...f.events);existing.firstDay=Math.min(existing.firstDay,f.firstDay);existing.lastDay=Math.max(existing.lastDay,f.lastDay)}else paths.set(f.path,f)}s.fileMap=paths;
    for(const f of paths.values()){increments[f.firstDay].file++;s.fileEvents.push([f.path,f.firstDay])}
    s.fileEvents.sort((a,b)=>a[1]-b[1]||a[0].localeCompare(b[0]));for(const d of s.agents)if(d>=s.birth&&d<=maxDay)increments[d].agent++;
    s.commits.sort((a,b)=>a.day-b.day||a.id.localeCompare(b.id));for(const c of s.commits)if(c.day>=s.birth&&c.day<=maxDay)increments[c.day].commit++;
    let total=0;for(let d=0;d<=maxDay;d++){const e=increments[d],raw=e.tool+2*e.turn+3*e.file+4*e.agent+5*e.commit;s.dailyWorkByDay[d]=d<s.birth?0:raw;total+=raw;s.workByDay[d]=d<s.birth?0:Math.log1p(total)}
    s.kind=s.commits.length?'verified':'unknown';s.updated=Date.parse(s.updatedAt)||Date.parse(s.createdAt)||0;projects[s.p].birth=Math.min(projects[s.p].birth,s.birth);projects[s.p].allPrimary.push(s);
  }
  for(const p of projects){p.unknown.sort((a,b)=>a.day-b.day);}
  sessions.sort((a,b)=>b.updated-a.updated||a.id.localeCompare(b.id));evidenceGeneration++;
}
function renderImportDetails(){
  const data=sourceData,children=allSessions.filter(s=>s.isSubagent).length,unresolved=allSessions.filter(s=>s.isSubagent&&!s.rootSessionId).length,sources=data.sources||[];
  $('data-summary').textContent=allSessions.length.toLocaleString()+' records · '+sources.length+' sources · data details';
  if(dataSource.mode==='hosted'&&data.redacted===true)$('data-summary').textContent+=' · Redacted export';
  const body=$('data-details-body');body.replaceChildren();
  const addLine=text=>{const e=document.createElement('p');e.className='data-source-line';e.textContent=text;body.appendChild(e)};
  if(dataSource.mode==='hosted')addLine('Your file is read in this browser and never uploaded.');
  addLine('Imported '+new Date(data.generatedAt).toLocaleString()+'. '+sessions.length+' primary sessions, '+children+' subagents, '+unresolved+' subagents with unknown parents.');
  addLine(projects.length+' project plots. '+projects.filter(p=>p.gitAvailable||p.git?.available).length+' with readable Git. '+(data.commits||[]).length.toLocaleString()+' verified Git commits; ownership stays unknown unless directly proved.');
  addLine('Source counts overlap. Session IDs are deduplicated across the live history and all backup copies.');
  for(const source of sources)addLine((source.kind||'source')+' / '+source.id+': '+Number(source.sessions??source.rolloutSessions??0).toLocaleString()+' sessions · '+(source.rollouts??0)+' rollouts · '+(source.errors??0)+' read issues. '+(source.path||''));
  const coverage=data.coverage||{};for(const [key,value]of Object.entries(coverage)){if(typeof value==='string'||typeof value==='number')addLine(key+': '+value);else if(Array.isArray(value))for(const item of value)if(typeof item==='string')addLine(item)}
  if(coverage.parser)addLine('Excluded inherited or unresolved records: '+Number(coverage.parser.excludedInheritedOrUnresolvedRecords||0).toLocaleString()+'. Sessions with uncertain ownership boundaries: '+Number(coverage.sessionsWithUnresolvedInheritance||0)+'.');
  for(const limit of coverage.git?.gitLimitations||[])addLine(limit);
  addLine('All born project lots remain in the growing world. Both zoom levels use specimen trees. Each recorded subagent remains a selectable bird.');
  addLine('File activity includes recorded successful file-change events. Shell writes and older incomplete history may be missing. File bytes measure current files; past bytes stay unknown.');
  $('score-note').textContent='* Recorded work = log(1 + tools + 2×turns + 3×distinct files + 4×agents + 5×owned commits). Descendant work counts once. Species shows session kind; size ranks work; density ranks distinct files. Fruit counts recorded file additions, capped at five.';
  $('world-source').textContent=children+' subagents · '+unresolved+' unresolved · '+(dataSource.mode==='local'?'local import':'browser file');
  document.querySelector('.note code').textContent=dataSource.mode==='hosted'?dataSource.command:data.refreshCommand||'python3 agent_garden_export.py --output web/local-session-data.json';
}
function renderProjectSelect(){const select=$('project-select');if(!select)return;select.replaceChildren(createOption('', 'All '+projects.length+' projects',!projectFilter));for(const p of [...projects].sort((a,b)=>a.name.localeCompare(b.name))){const count=p.allPrimary.filter(s=>s.birth<=day).length;select.appendChild(createOption(p.id,p.name+' · '+count+' sessions'+(!(p.gitAvailable||p.git?.available)?' · Git missing':'')+(projects.filter(x=>x.name===p.name).length>1?' · '+(p.root||p.workspaces?.[0]||p.id).split('/').slice(-3).join('/'):''),projectFilter===p.id))}}
function filteredSessions(){const term=searchFilter.toLocaleLowerCase();return sessions.filter(s=>s.birth<=day&&sessionInTimeRange(s,timeRange)&&(!projectFilter||s.projectId===projectFilter)&&(!term||(s.title+' '+projects[s.p].name+' '+s.id).toLocaleLowerCase().includes(term)))}

function configureDataMode(mode){
 const local=mode==='local';
 $('latest').hidden=!local;$('live-connection').hidden=true;
 $('refresh-data').textContent=local?'Refresh local data':'Open another file';
 $('data-loading').hidden=!local;
 if(!local){loading=false;loadError='';liveMode=false}
 else $('garden-support').hidden=false;
}
function applyDataset(data){
 stopFlight();pauseReplay();
 parseData(data);
 if(new URLSearchParams(location.search).get('at')==='latest'){playback.seek(maxDay);day=maxDay}
 prepareWorld();buildWorldScene();resize();updateDay();resumeAmbientCamera();
}
async function loadData(){
 if(dataSource.mode!=='local')return;
 loading=true;loadError='';$('data-loading').hidden=false;$('data-loading').textContent='Loading sessions…';
 try{
  const fetch=dataSource.fetchLocal;
  const response=await fetch('local-session-data.json?refresh='+Date.now(),{cache:'no-store'});
  if(!response.ok)throw Error('No local import is available ('+response.status+'). Use Refresh local data to create it.');
  applyDataset(await response.json());
 }catch(error){loading=false;loadError=error.message;$('data-loading').hidden=false;$('data-loading').classList.add('error');$('data-loading').textContent=loadError;$('shown-count').textContent='Local data unavailable';$('data-summary').textContent='Import needed · local data only';document.querySelector('.session-card').hidden=true;$('world-counts').textContent='NO DATA LOADED';$('score-note').textContent='Run the export script, then reload this page.';resize()}
}
function setConnection(connected){const hint=$('live-connection');if(hint)hint.hidden=connected||!liveMode;}
function advanceLiveClock(at=Date.now()){
 if(document.body?.dataset.gardenMode==='hosted'||!sourceData)return false;
 const instant=typeof at==='number'?at:Date.parse(at);if(!Number.isFinite(instant))return false;
 endTime=Math.max(endTime,instant);const nextDay=Math.max(maxDay,Math.floor((endTime-startTime)/DAY));
 if(nextDay===maxDay)return false;
 const oldMax=maxDay,oldPlayback=playback?.state(),speed=playback?.getSpeed?.()||1;maxDay=nextDay;
 for(const session of sessions){const oldWork=session.workByDay,oldDaily=session.dailyWorkByDay;if(oldWork.length<=maxDay){session.workByDay=new Float64Array(maxDay+1);session.workByDay.set(oldWork);session.workByDay.fill(oldWork[oldWork.length-1]||0,oldWork.length);session.dailyWorkByDay=new Float64Array(maxDay+1);session.dailyWorkByDay.set(oldDaily)}}
 playback=createGardenPlayback({maxDay,durationMs:300000,holdMs:1800,resetMs:500});playback.setSpeed(speed);
 if(liveMode){day=maxDay;playback.seek(maxDay)}else{playback.seek(Math.min(day,maxDay));if(oldPlayback?.playing)playback.play(day)}
 $('time').max=String(maxDay);$('track-dates')?.replaceChildren(...[0,1/3,2/3,1].map(f=>{const e=document.createElement('span');e.textContent=dateText(Math.round(maxDay*f));return e}));
 if(typeof refreshActivityStrip==='function')refreshActivityStrip();
 if(liveMode){$('date').textContent=new Date(startTime+day*DAY).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'2-digit',timeZone:'UTC'});$('day-label').textContent='LIVE';$('history-status').textContent='CURRENT LOCAL ACTIVITY';$('time').value=String(day);updateCard();updateMap()}
 else $('day-label').textContent='DAY '+(day+1)+' / '+(maxDay+1);
 if(liveMode&&refreshSpecimenEncodings())rebuild();
 syncPlaybackControls();dirty=true;return maxDay!==oldMax;
}
function syncSpawnCards({reset=false,notify=true}={}){
 const records=new Map(sourceData.sessions.map(session=>[session.id,session]));
 spawnCards.sync(visibleSessions.map(session=>spawnCardRecord(records.get(session.id)||session,projects[session.p],liveState.agent(session.id))),{reset,notify:notify&&!document.hidden,motion:motion&&!motionPreference.matches&&!document.hidden,mode:liveMode?'live':'history'});
}
function liveGeometryKey(session){return JSON.stringify([session.projectId,session.createdAt,session.rootSessionId,session.isSubagent,session.isGuardian,session.activity,session.files])}
function mergeLiveEvidence(change){
 if(!sourceData)return;
 const state=liveState.snapshot(),projectsById=new Map(sourceData.projects.map(item=>[item.id,item])),sessionsById=new Map(sourceData.sessions.map(item=>[item.id,item]));let geometryChanged=false,metadataChanged=false,encodingChanged=false;
 for(const id of change.projectIds){const item=state.projects.find(project=>project.id===id);if(item&&JSON.stringify(projectsById.get(id))!==JSON.stringify(item)){geometryChanged ||= !projectsById.has(id);metadataChanged=true;projectsById.set(id,item)}}
 for(const id of change.sessionIds){const item=state.sessions.find(session=>session.id===id);if(item&&JSON.stringify(sessionsById.get(id))!==JSON.stringify(item)){geometryChanged ||= !sessionsById.has(id)||liveGeometryKey(sessionsById.get(id))!==liveGeometryKey(item);encodingChanged ||= sessionsById.get(id)?.updatedAt!==item.updatedAt||JSON.stringify(sessionsById.get(id)?.agentIds)!==JSON.stringify(item.agentIds);metadataChanged=true;sessionsById.set(id,item)}}
 if(!metadataChanged){if(liveMode&&change.agentIds.some(id=>visibleSessions.some(session=>session.id===id)))syncSpawnCards({notify:false});return}
 sourceData={...sourceData,projects:[...projectsById.values()],sessions:[...sessionsById.values()]};allSessions=sourceData.sessions;
 if(!geometryChanged&&encodingChanged){
  const selectedId=selected?.id;deriveGardenRecords(sourceData);selected=sessions.find(s=>s.id===selectedId)||selected;
  const byId=new Map(sessions.map(s=>[s.id,s]));
  for(const list of [treePlacements,renderedTrees,displayScene?.trees||[]])for(const t of list)if(byId.has(t.s?.id))t.s=byId.get(t.s.id);
  visibleSessions=visibleSessions.map(s=>byId.get(s.id)||s);
  if(refreshSpecimenEncodings())rebuild();
  if(liveMode){updateCard();syncSpawnCards({notify:false})}dirty=true;return;
 }
 if(!geometryChanged){for(const id of change.sessionIds){const raw=sessionsById.get(id),derived=sessions.find(item=>item.id===id);if(raw&&derived){derived.title=raw.title;derived.updatedAt=raw.updatedAt}}for(const id of change.projectIds){const raw=projectsById.get(id),derived=projects.find(item=>item.id===id);if(raw&&derived)derived.name=raw.name}if(liveMode){updateCard();syncSpawnCards({notify:false})}return}
 const oldIds=new Set(sessions.map(item=>item.id)),selectedId=selected?.id;
 deriveGardenRecords(sourceData);if(typeof refreshActivityStrip==='function')refreshActivityStrip();selected=sessions.find(item=>item.id===selectedId)||selected;
 if(liveMode){day=maxDay;playback?.pause();
  prepareWorld();const nowFrame=performance.now(),animate=!change.snapshot&&motion&&!motionPreference.matches&&!document.hidden;
  cloudArrivals.sync(visibleSessions.map(item=>({id:item.id,projectId:item.projectId,priority:work(item)})),{animate});
  const freshIds=visibleSessions.filter(item=>!treeGrowth.has(item.id)).map(item=>item.id);
  treeGrowth.sync(visibleSessions.map(item=>({id:item.id,score:work(item)})),nowFrame,{animate});growthDay=day;
  sceneKey='';buildWorldScene();displayScene=layoutMotion.retarget(gardenLayout,treePlacements,nowFrame,{animate});
  // Plant on the final surface: a new tree waits out the lot morph instead of sliding with the hill under it.
  spawnHold.hold(animate?freshIds:[],layoutMotion.active);
  modelCache.clear();mapKey='';rebuild();updateCard();updateMap();drawArcs();renderProjectSelect();syncPlaybackControls();
  syncSpawnCards({notify:!change.snapshot});
  const arrivals=sessions.filter(item=>!oldIds.has(item.id));if(change.snapshot)treeGrowth.settle(arrivals.map(item=>item.id));
  else if(animate&&freshIds.length)flyToLiveArrivals(freshIds);
  dirty=true;
 }else{
  prepareWorld();sceneKey='';buildWorldScene();displayScene=layoutMotion.retarget(gardenLayout,treePlacements,performance.now(),{animate:false});
  rebuild();updateCard();updateMap();dirty=true;
 }
}
function flyToLiveArrivals(ids){
 if(!ids.length||!motion||motionPreference.matches||document.hidden)return;
 stopFlight();dismiss();camera.auto=false;
 // The inspector changes canvas width. Fit against its updated size before departing.
 resize();
 const fit=cloudFitFraming(false,ids);if(!fit)return;
 const center=projectGround(fit.center.x,fit.center.y,camera.yaw);
 moveCamera({auto:false,zoom:fit.zoom,yaw:camera.yaw,x:center.x,y:center.y-fit.lift},1200);
 if(flight)flight.liveArrival=true;
 spawnHold.hold(ids,layoutMotion.active||!!flight);
 idleAfter=0;droneAfter=0;dirty=true;
}
function waitForLiveGrowth(id){
 const check=()=>{if(!liveMode||!sessions.some(item=>item.id===id))return;
  if(liveTreeGrowthActive(id)){setTimeout(check,80);return}
  if(showcase){if(canDeferShowcase(id))setTimeout(check,80);return}
  showcaseTree(id);
 };
 setTimeout(check,TREE_EMERGENCE_MS);
}
function liveTreeGrowthActive(id){return treeGrowth.sample(id,performance.now(),motion).active||cloudArrivals.entries().some(item=>item.id===id&&item.state.crown<1)}
function canDeferShowcase(id){
 const tree=treePlacements.find(item=>item.s.id===id);
 const interaction=!!(pointerGesture||flight||tour||spotlight||arrival||overviewFit||mapSession||pinnedMap||hoverSession||hoverProject||scrubbing||playback?.state().playing||!camera.auto||ambientSuspended||!driftEnabled);
 return canShowcaseTree({exists:!!tree,fullyGrown:!!tree&&!liveTreeGrowthActive(id),motion,reducedMotion:motionPreference.matches,hidden:document.hidden,interaction});
}
function acceptLiveEvent(message,snapshot){const change=liveState.apply(message,{snapshot});if(!change)return;advanceLiveClock(message.observedAt);mergeLiveEvidence(change);if(selectedAgentId&&!agentRecord(selectedAgentId))selectedAgentId=null;liveReady=true;setConnection(true);if(liveMode){renderAgentDetails();const messageId=selectedAgentId||selected?.id;if(messageId&&change.agentIds.includes(messageId))messagesPager.refresh();dirty=true}}
function connectLive(){if(dataSource.mode!=='local'||!window.EventSource)return;liveStream?.close();liveStream=new EventSource('/api/events');liveStream.addEventListener('snapshot',event=>{try{acceptLiveEvent(JSON.parse(event.data),true)}catch(error){console.error('Live snapshot:',error)}});liveStream.addEventListener('upsert',event=>{try{acceptLiveEvent(JSON.parse(event.data),false)}catch(error){console.error('Live update:',error)}});liveStream.addEventListener('open',()=>setConnection(true));liveStream.addEventListener('error',()=>setConnection(false))}
function enterLive(){if(messagesPager.available===false||!playback)return;clearTimeRange();liveMode=true;pauseReplay();playback.seek(maxDay);day=maxDay;selectedAgentId=agentRecord(selectedAgentId)?.rootSessionId===selected?.id?selectedAgentId:null;updateDay({cause:'scrub'});$('history-status').textContent='LIVE';renderAgentDetails();if(selected)messagesPager.refresh();setConnection(liveStream?.readyState===1);dirty=true}
function leaveLive(){if(!liveMode)return;liveMode=false;renderAgentDetails();setConnection(false);dirty=true}
function playHistory(){if(!sessions.length||!playback)return;const state=playback.state();if(state.playing){pauseReplay();return}if(liveMode&&maxDay===0){enterLive();return}dismiss();if(timeRange){clearTimeRange();updateDay({cause:'scrub'})}if(liveMode){leaveLive();playback.play(0)}else playback.play();const previousDay=day;day=playback.state().day;resumeAmbientCamera();if(day!==previousDay)updateDay({cause:'playback'});syncPlaybackControls()}
function agentRecord(id){return liveState.agent(id)||sessionRecords.get(id)}
function treeAgents(s){return (s?.members||[]).filter(agent=>agent.isSubagent&&!agent.isGuardian&&(liveMode||(atDay(agent.createdAt)??Infinity)<=day)).map(agent=>agentRecord(agent.id)||agent)}
function selectAgent(id){const agent=agentRecord(id),root=sessions.find(item=>item.id===agent?.rootSessionId);if(!agent||!root)return;pin(root,null,id);updateBirdTargets()}
function formatDuration(ms){if(ms===null||ms===undefined)return 'Time unavailable';const seconds=Math.floor(ms/1000),minutes=Math.floor(seconds/60);return minutes?minutes+'m '+String(seconds%60).padStart(2,'0')+'s':seconds+'s'}
function renderAgentDetails(){
 const section=$('live-agents');if(!section)return;
 const agentLabel=$('session-agent');if(agentLabel){agentLabel.textContent=selected?.agent==='codex'?'Codex':selected?.agent==='claude-code'?'Claude Code':'';agentLabel.hidden=!agentLabel.textContent}
 section.hidden=!selected;if(section.hidden)return;
 const rootId=selected.id,agents=treeAgents(selected),host=$('agent-list'),keep=new Set(agents.map(item=>item.id));
 if(selectedAgentId&&!keep.has(selectedAgentId))selectedAgentId=null;
 for(const button of [...host.children])if(!keep.has(button.dataset.agentId))button.remove();
 for(const agent of agents){
  const state=liveState.agentState(agent.id)||agent;let button=[...host.children].find(item=>item.dataset.agentId===agent.id);
  if(!button){button=document.createElement('button');button.className='agent-choice';button.dataset.agentId=agent.id;button.addEventListener('click',()=>selectAgent(agent.id));host.appendChild(button)}
  button.style.paddingLeft=(8+Math.min(4,parentDepth(agent,agents))*11)+'px';
  button.textContent=(agent.nickname||agent.role||'Agent '+agent.id.slice(0,6))+(liveMode?' · '+String(state.state||'unknown').replace('-', ' ')+(state.quiet?' · Quiet':''):'');
  button.setAttribute('aria-pressed',String(agent.id===selectedAgentId));
 }
 $('agent-list-empty').hidden=agents.length>0;
 const agent=selectedAgentId&&(liveState.agentState(selectedAgentId)||agentRecord(selectedAgentId));$('agent-detail').hidden=!agent||messagesPager.available===false;
 if(agent){
  $('agent-name').textContent=agent.nickname||agent.role||'Agent '+agent.id.slice(0,8);
  $('agent-state').textContent=(liveMode?'':'Latest recorded state: ')+String(agent.state||'unknown').replace('-', ' ')+(agent.quiet?' · Quiet':'');
  $('agent-role').textContent='Role: '+(agent.role||'unavailable');$('agent-model').textContent='Model: '+(agent.model||'unavailable');$('agent-tool').textContent='Tool: '+(agent.currentTool||'unavailable');
  $('agent-time').textContent='Turn: '+formatDuration(agent.elapsedMs);$('agent-tokens').textContent='Own tokens: '+(Number.isFinite(agent.tokensUsed)?agent.tokensUsed.toLocaleString():'unavailable');
  $('agent-freshness').textContent='Last event: '+(agent.lastEventAt?new Date(agent.lastEventAt).toLocaleString():'unavailable');
 }
 if(messagesPager.available===false){$('session-conversation').hidden=true;$('live-messages').hidden=true;$('hosted-messages-note').hidden=false;return}
 $('hosted-messages-note').hidden=true;
 $('session-conversation').hidden=!agent;$('session-conversation').setAttribute('aria-pressed',String(!agent));
 $('message-heading').textContent=agent?$('agent-name').textContent+' · Messages':'Session messages';$('live-messages').hidden=false;
 const messageId=selectedAgentId||rootId,page=messagesPager.state();
 if(page.rootId!==rootId||page.agentId!==messageId){$('message-list').scrollTop=0;messagesPager.select(rootId,messageId)}
}
function parentDepth(agent,agents){const byId=new Map(agents.map(item=>[item.id,item]));let depth=0,parent=agent.parentId,seen=new Set([agent.id]);while(byId.has(parent)&&!seen.has(parent)){seen.add(parent);depth++;parent=byId.get(parent).parentId}return depth}
function renderMessages({messages,nextCursor,error},{prepend=false}={}){const host=$('message-list'),scroll=host.scrollTop,height=host.scrollHeight;host.replaceChildren();for(const message of messages){const item=document.createElement('p');item.className='agent-message';const meta=document.createElement('strong');meta.textContent=(message.role==='user'?'You':message.role==='assistant'?'Assistant':message.kind==='spawn-task'?'Spawn task':'Agent message')+' · '+(message.at?new Date(message.at).toLocaleString():'time unavailable');const body=document.createElement('span');body.textContent=message.text||'';item.append(meta,body);host.appendChild(item)}host.scrollTop=prepend&&scroll>2?scroll+host.scrollHeight-height:scroll;$('message-status').textContent=error||(!messages.length?'No messages recorded.':'');$('older-messages').hidden=!nextCursor}
async function refreshData(){if(dataSource.mode==='hosted'){upload.chooseFile();return}if(dataSource.mode!=='local')return;const button=$('refresh-data');button.disabled=true;button.textContent='Importing local records…';try{const start=await dataSource.fetchLocal('/api/refresh',{method:'POST'});if(start.status===404||start.status===501){await loadData();$('data-summary').textContent='Static preview · run the import command to collect new records';return}if(!start.ok)throw Error('Local refresh returned '+start.status);let status;do{await new Promise(resolve=>setTimeout(resolve,1200));const response=await dataSource.fetchLocal('/api/status',{cache:'no-store'});if(!response.ok)throw Error('Refresh status returned '+response.status);status=await response.json();button.textContent=status.busy?'Importing local records…':'Loading garden…'}while(status.busy);if(status.lastResult?.ok===false)throw Error(status.lastResult.error||'The local import failed.');await loadData()}catch(error){$('data-summary').textContent='Refresh failed: '+error.message;$('data-details').open=true}finally{button.disabled=false;button.textContent='Refresh local data ↻'}}
function files(s){return s?s.fileEvents.filter(([,d])=>d<=day).map(([path])=>path):[]}
// File events follow the playhead; tile area uses the import's current file measurement.
// These measurements are labeled with their observation date, never as historical sizes.
function snapshot(path,s=activeSession()){const f=s?.fileMap.get(path);if(!f)return null;const ms=Date.parse(f.bytesObservedAt);return Number.isFinite(f.bytes)&&f.bytes>=0&&Number.isFinite(ms)?{day:atDay(f.bytesObservedAt),bytes:f.bytes,observedAt:f.bytesObservedAt,source:f.bytesSource}:null}
function dateText(d){return new Date(startTime+d*DAY).toLocaleDateString('en-US',{month:'short',day:'2-digit',timeZone:'UTC'})}
function type(path){const ext=path.split('.').at(-1).toLowerCase();return ['json','csv','yaml','yml','toml','sqlite','xml'].includes(ext)?'data':['md','txt','rst','pdf'].includes(ext)?'doc':['css','scss','sass','less'].includes(ext)?'style':'code'}
function activeSession(){return sessions.find(s=>s.id===hoverSession)||selected}
function displayTitle(title){
 const raw=String(title||'Untitled session').trim();
 const skill=raw.match(/^\[\$([^\]]+)\]\([^)]*\)/);
 if(skill)return skill[1].replace(/[-_]+/g,' ').replace(/^./,c=>c.toUpperCase());
 return raw.replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/\s+/g,' ').slice(0,140);
}
function hoverSummary(s){
 const project=projects[s.p],owned=s.commits.filter(c=>c.day<=day).length,agentCount=s.agents.filter(d=>d<=day).length,fileCount=files(s).length;
 const git=project.gitAvailable||project.git?.available?'Git evidence available':'Git unavailable';
 const fileText=fileCount?fileCount+' changed files':'no recorded changed files';
 return (project.name||'Unknown project')+' / '+(s.title||s.id.slice(0,8))+'\n'+shownScore(s)+' work score · '+fileText+' · '+owned+' owned commits\n'+agentCount+' agent boids · '+git+'\nClick to inspect';
}
function updateCard(){const s=sessions.find(s=>s.id===mapSession)||selected;if(!s)return;const project=projects[s.p],visible=s.commits.filter(c=>c.day<=day),g=model(s),fileCount=files(s).length;let forks=0;const ids=new Set(visible.map(c=>c.id));for(const[id,children]of g.children)if(ids.has(id)&&children.filter(id=>ids.has(id)).length>1)forks++;
$('card-id').textContent='SESSION / '+s.id.slice(0,8);$('card-id').title=s.id;$('card-state').textContent=s.id===selected?.id?'SELECTED':'PREVIEW';$('project').textContent=project.name;$('project').title=project.root||project.workspaces?.join('\n')||project.name;$('session-title').textContent=displayTitle(s.title);$('session-title').title=s.title||s.id;$('work-score').textContent=fileCount;$('commit-count').textContent=visible.length;$('agent-count').textContent=s.agents.filter(d=>d<=day).length;
for(const id of ['work-score','commit-count','agent-count'])$(id).parentElement.hidden=Number($(id).textContent)===0;
$('open-map').hidden=fileCount===0;
const unknown=project.unknown.filter(c=>c.day<=day).length,projectScore=project.allPrimary.reduce((n,x)=>n+work(x),0),agentCount=s.agents.filter(d=>d<=day).length;$('git-note').textContent=fileCount+' changed files · '+(1+agentCount)+' contributing records. '+(agentCount?'One boid per delegated agent. ':'')+unknown.toLocaleString()+' project commits with unknown session ownership. '+(visible.length?forks+' known forks · '+g.merges.filter(m=>m.day<=day).length+' merge links. ':'')+(visible.length>64?'First 64 attributed commits drawn. ':'')+'Project work '+projectScore.toFixed(1)+'.';
$('unknown').hidden=false;$('unknown').textContent=!(project.gitAvailable||project.git?.available)?'Git unavailable. '+(project.git?.reason||project.gitUnavailableReason||project.gitReason||'The saved workspace may be missing.'):(visible.length?'Commits have direct ownership evidence. Fruit counts recorded file additions, capped at five.':'Commit ownership is unproved. Fruit counts recorded file additions, capped at five.');
$('world').dataset.selectedSession=selected?.id||'';$('world').dataset.inspectedSession=hoverSession||s.id;$('world').dataset.hoverSession=hoverSession||'';$('world').dataset.selectedWorkScore=shownScore(selected);renderAgentDetails();dirty=true}

function updateMap(){
  const map=$('file-map'),rail=document.querySelector('.inspector-rail'),s=visibleSessions.find(s=>s.id===mapSession&&s.birth<=day);if(!s){map.hidden=true;if(rail)rail.hidden=true;dirty=true;return}if(rail)rail.hidden=false;map.hidden=false;dirty=true;map.dataset.session=s.id;map.dataset.pinned=String(pinnedMap===s.id);map.dataset.playheadDay=String(day);map.style.width='';
  const paths=files(s);$('map-title').textContent=paths.length?paths.length+' changed '+(paths.length===1?'file':'files'):'No files recorded';$('map-subtitle').textContent=projects[s.p].name+' · '+s.id.slice(0,8)+' · '+dateText(day);$('map-subtitle').title=s.id;$('map-status').textContent=pinnedMap===s.id?'PINNED':'PREVIEW';$('map-pin').textContent=pinnedMap===s.id?'Pinned':'Pin';$('map-pin').setAttribute('aria-pressed',String(pinnedMap===s.id));
  const fs=paths.map(path=>({path,...snapshot(path,s)})).filter(f=>Number.isFinite(f.bytes)&&f.bytes>0),unknown=paths.filter(path=>!snapshot(path,s)||snapshot(path,s).bytes===0);
  const key=s.id+'|'+day+'|'+map.clientWidth+'|'+JSON.stringify(paths.map(path=>[path,snapshot(path,s)?.bytes??null]));
  if(key!==mapKey){mapKey=key;const select=$('map-file-select');select.replaceChildren(createOption('','Select any changed file'));for(const path of paths){const f=snapshot(path,s);select.appendChild(createOption(path,path+' · '+(f?f.bytes.toLocaleString()+' bytes now':'size unknown')))}
    const missing=$('map-unknown');missing.replaceChildren();missing.hidden=!unknown.length;if(unknown.length){const label=document.createElement('div');label.textContent=unknown.length+' files have zero or unknown current bytes. All remain available in the selector.';missing.appendChild(label);for(const path of unknown.slice(0,3)){const b=document.createElement('button');b.textContent=path+' · '+(snapshot(path,s)?.bytes===0?'0 bytes':'unknown bytes');b.dataset.unknownFilePath=path;b.addEventListener('click',()=>pin(s,path));missing.appendChild(b)}}
    const host=$('map-tiles');host.replaceChildren();host.dataset.measuredFiles=String(fs.length);host.dataset.unknownFiles=String(unknown.length);
    if(!fs.length){const e=document.createElement('div');e.className='map-empty';e.textContent=paths.length?'File sizes unavailable. Choose a file above.':'No file changes recorded by this date.';host.appendChild(e)}else{
      const root={children:new Map(),bytes:0};for(const f of fs){let n=root;n.bytes+=f.bytes;f.path.split('/').forEach((name,i,parts)=>{const nodeKey=name;if(!n.children.has(nodeKey))n.children.set(nodeKey,{name:name||'/',path:parts.slice(0,i+1).join('/'),file:i===parts.length-1,children:new Map(),bytes:0});n=n.children.get(nodeKey);n.bytes+=f.bytes;n.snapshot=f})}
      function draw(branch,parent,r,depth=0){for(const box of partition([...branch.children.values()],r)){const item=box.item;if(item.file){if(box.w<3||box.h<3)continue;const b=document.createElement('button');b.className='file-tile';Object.assign(b.dataset,{session:s.id,filePath:item.path,fileBytes:String(item.bytes),snapshotDay:String(item.snapshot.day),fileType:type(item.path),compact:String(box.h-2<42)});b.style.cssText='left:'+(box.x+1)+'px;top:'+(box.y+1)+'px;width:'+Math.max(1,box.w-2)+'px;height:'+Math.max(1,box.h-2)+'px;--tile-color:'+({code:'#b8cda8',data:'#e3cb92',doc:'#b9d0d7',style:'#d5bfce'}[type(item.path)]);b.setAttribute('aria-label',item.path+', '+item.bytes.toLocaleString('en-US')+' bytes, measured '+new Date(item.snapshot.observedAt).toLocaleString()+', not historical');b.title=b.getAttribute('aria-label');const mark=document.createElement('i');mark.className='tile-marker';const name=document.createElement('span');name.className='tile-name';name.textContent=item.name;const bytes=document.createElement('span');bytes.className='tile-bytes';bytes.textContent=item.bytes>=1024?(item.bytes/1024).toFixed(1)+' KiB':item.bytes+' B';b.append(mark,name,bytes);const hover=()=>{clearTimeout(leaveTimer);hoverSession=s.id===selected?.id?null:s.id;hoverPath=item.path;updateCard();drawArcs()};b.addEventListener('pointerenter',hover);b.addEventListener('focus',hover);b.addEventListener('pointerleave',()=>{hoverPath=null;drawArcs()});b.addEventListener('blur',()=>{hoverPath=null;drawArcs()});b.addEventListener('click',()=>pin(s,item.path));parent.appendChild(b);b.dataset.labelVisible=String(b.clientWidth>=56&&b.clientHeight>=26&&name.scrollWidth<=name.clientWidth)}else{if(box.w<7||box.h<24||depth>24)continue;const folder=document.createElement('div');folder.className='map-folder';folder.dataset.folderPath=item.path;folder.style.cssText='left:'+(box.x+1)+'px;top:'+(box.y+1)+'px;width:'+Math.max(2,box.w-2)+'px;height:'+Math.max(2,box.h-2)+'px';const name=document.createElement('span');name.className='folder-title';name.textContent=item.name+'/';name.title=item.path;folder.appendChild(name);parent.appendChild(folder);draw(item,folder,{x:3,y:16,w:Math.max(2,box.w-10),h:Math.max(2,box.h-23)},depth+1)}}}draw(root,host,{x:1,y:1,w:host.clientWidth-2,h:host.clientHeight-2});
    }
  }
  map.querySelector('.map-meta span').textContent='CURRENT BYTES · '+map.querySelectorAll('.file-tile').length+'/'+fs.length+' TILES FIT';
  const path=hoverPath||(s.id===selected?.id?pinnedPath:null);$('map-file-select').value=paths.includes(path)?path:'';
  for(const tile of map.querySelectorAll('.file-tile')){const f=s.fileMap.get(tile.dataset.filePath),last=Math.max(-Infinity,...f.events.filter(e=>e.day<=day).map(e=>e.day)),recent=day-last<=2;tile.dataset.activity=recent?'recent':'quiet';tile.classList.toggle('recent',recent)}positionMap(s)
}
function positionMap(){ $('file-map').dataset.placement='right-inspector' }
function drawArcs(){
if(!mapSession&&arcsClear)return;arcsClear=!mapSession;
arcCtx.setTransform(DPR,0,0,DPR,0,0);arcCtx.clearRect(0,0,innerWidth,innerHeight);$('relation-evidence').replaceChildren();const map=$('file-map');if(map.hidden)return;const s=sessions.find(s=>s.id===mapSession);if(!s)return;const o=anchorsOnScreen.get(s.id),bounds=canvas.getBoundingClientRect(),path=hoverPath||(s.id===selected?.id?pinnedPath:null),tiles=[...map.querySelectorAll('.file-tile')];let active=null;for(const tile of tiles){const on=tile.dataset.filePath===path;tile.classList.toggle('is-active',on);tile.setAttribute('aria-pressed',String(tile.dataset.session===selected?.id&&tile.dataset.filePath===pinnedPath));if(on)active=tile}
const record=path&&s.fileMap.get(path),measurement=record&&snapshot(path,s),editCount=record?.events.filter(e=>e.day<=day).length||0;
$('map-path').textContent=record?record.path:files(s).length?'Select a file to follow its exact path.':'No recorded changed files at this date.';
$('map-bytes').textContent=record?(measurement?(measurement.bytes>=1024?(measurement.bytes/1024).toFixed(1)+' KB':measurement.bytes+' B')+' current':'Size unknown')+' · '+editCount+' '+(editCount===1?'change':'changes'):files(s).length+' changed paths';$('map-bytes').title=measurement?'Measured '+new Date(measurement.observedAt).toLocaleDateString()+'. Current size, not historical.':'';$('map-path').title=record?.absolutePath||record?.path||'';$('map-file-select').value=record?path:'';const checkout=$('map-checkout');checkout.hidden=!record?.absolutePath||!measurement;checkout.textContent=record&&measurement?'Measured file: '+record.absolutePath:'';
if(!o)return;const rail=document.querySelector('.inspector-rail').getBoundingClientRect(),timeline=$('play').closest('.timeline').getBoundingClientRect();if(bounds.bottom<=0||bounds.top>=innerHeight||o.x<0||o.x>bounds.width||o.y<0||o.y>bounds.height)return;const ratio=camera.zoom/baseCamera.zoom,start={x:bounds.left+W/2+(o.x-W/2)*ratio+(baseCamera.x-camera.x)*camera.zoom,y:bounds.top+H/2+(o.y-H/2)*ratio+(baseCamera.y-camera.y)*camera.zoom-8};const inspectFile=Boolean(hoverPath);let endpoints=(inspectFile?tiles:tiles.filter(tile=>tile===active)).map(tile=>({element:tile.querySelector('.tile-marker'),path:tile.dataset.filePath,bytes:tile.dataset.fileBytes,on:tile===active}));if(record&&!active)endpoints.push({element:$('map-file-select'),path,bytes:measurement?.bytes??'',on:true});if(endpoints.length>30)endpoints=endpoints.filter(e=>e.on).concat(endpoints.filter(e=>!e.on).slice(0,12));
for(const item of endpoints){if(innerWidth<580&&!item.on)continue;const r=item.element.getBoundingClientRect(),mapRect=map.getBoundingClientRect();if(r.top<Math.max(mapRect.top,rail.top,0)||r.bottom>Math.min(mapRect.bottom,rail.bottom,timeline.top,innerHeight))continue;const end={x:r.left+Math.min(r.width/2,12),y:r.top+r.height/2},side=end.x>start.x?1:-1;arcCtx.beginPath();arcCtx.moveTo(start.x,start.y);arcCtx.bezierCurveTo(start.x+side*70,start.y-60,end.x-side*50,end.y,end.x,end.y);arcCtx.setLineDash([]);arcCtx.strokeStyle=PAPER;arcCtx.globalAlpha=item.on?.96:.2;arcCtx.lineWidth=item.on?4.6:2.2;arcCtx.stroke();arcCtx.strokeStyle=item.on?CORAL:TEAL;arcCtx.globalAlpha=item.on?1:.25;arcCtx.lineWidth=item.on?1.8:1;arcCtx.setLineDash(item.on?[]:[3,4]);arcCtx.stroke();arcCtx.setLineDash([]);arcCtx.beginPath();arcCtx.arc(end.x,end.y,item.on?3:2,0,6.28);arcCtx.fillStyle=item.on?CORAL:TEAL;arcCtx.fill();const evidence=document.createElement('span');Object.assign(evidence.dataset,{fileArc:item.path,session:s.id,active:String(item.on),fileBytes:String(item.bytes),startX:String(start.x),startY:String(start.y),endpointX:String(end.x),endpointY:String(end.y),canvasRenderer:'2d'});$('relation-evidence').appendChild(evidence)}arcCtx.globalAlpha=1}

let gardenLayout={plots:[],outline:[],bounds:{x:0,y:0,w:0,h:0},area:0},treePlacements=[],detailSessions=[],matchingIds=new Set(),sceneKey='',camera={x:0,y:0,zoom:1,yaw:0,auto:true},fitScale=1,cameraFrame=0,pointerGesture=null,suppressClickUntil=0;
let flight=null,tour=null,baseCamera={...camera},lastSceneTime=0,sceneRebuilds=0,tourMessage='Follow the paths between your projects.';
// Motion budget: the camera counts as moving until it has been still for MOTION_SETTLE_MS. Moving frames draw from
// cached atlases and skip vector swaps; the first still frame after motion repaints once so detail can fade in.
const MOTION_SETTLE_MS=150,DIAGNOSTICS_MS=250,TARGET_MOVING_MS=125,VECTOR_FADE_MS=250,RECT_MOVING_MS=250;
let lastMotionAt=-Infinity,lastSpecimenMotionAt=-Infinity,orbitStepPending=false,lastRebuildMoving=false,terrainFading=false,vectorFading=false,rasterPending=0,lastTargetUpdateAt=-Infinity,arcsClear=false,canvasRectCache=null,surveyRectCache=null,surveyRectAt=-Infinity;
const lodMemory={close:false,few:false,zoomed:false,held:false,changedAt:-Infinity},diagnosticsAt={rebuild:-Infinity,dynamic:-Infinity,forest:-Infinity,survey:-Infinity},datasetShadow=new WeakMap();
function cameraMoving(now=performance.now()){return !!flight||!!spotlight||!!overviewFit||layoutMotion.active||!!pointerGesture?.moved||now-lastMotionAt<MOTION_SETTLE_MS}
// Specimen sharpness ignores the slow automatic orbit (yaw creep): trees stay native/crisp while it turns. Flights, drags,
// wheel/button zoom, arrivals and layout morphs still count, and vectors return MOTION_SETTLE_MS after they end.
function specimenMoving(now=performance.now()){return !!flight||!!spotlight||!!overviewFit||layoutMotion.active||!!pointerGesture?.moved||now-lastSpecimenMotionAt<MOTION_SETTLE_MS}
// Diagnostic JSON is for QA and debugging; while the camera moves it refreshes at 4 Hz instead of every frame.
function diagnosticsDue(channel,now,moving){if(moving&&now-diagnosticsAt[channel]<DIAGNOSTICS_MS)return false;diagnosticsAt[channel]=now;return true}
// Assign only the attributes whose text changed; identical writes still invalidate style.
function setDataset(element,values){
 if(!element)return;let previous=datasetShadow.get(element);if(!previous){previous={};datasetShadow.set(element,previous)}
 for(const name in values){const value=values[name];if(previous[name]!==value){previous[name]=value;element.dataset[name]=value}}
}
function setText(element,text){if(element&&datasetShadow.get(element)?.text!==text){const previous=datasetShadow.get(element)||{};previous.text=text;datasetShadow.set(element,previous);element.textContent=text}}
// The canvas box only changes with layout, so read it once per resize or scroll instead of once per rebuild.
function canvasRect(){return canvasRectCache||(canvasRectCache=canvas.getBoundingClientRect())}
function invalidateRects(){canvasRectCache=null;surveyRectCache=null}
const gardenOrbit=createGardenOrbit();let orbitLastTime=0,orbitFrameCache=null,spinCoast=false;
let arrival=null,showcase=null,lastArrivalAt=-Infinity,idleAfter=performance.now()+3000,robotTime=0,spawnReturn=null,idleFocus=null,idleZoom=1,idleStop=0;
// Idle drone: a closed path through the gaps between trees. It flies once the camera has been idle (idleAfter) and no
// input or spawn shot holds it back (droneAfter); it never counts as `moving` (see specimenMoving / orbitStepPending).
const DRONE_INPUT_HOLD_MS=4000,DRONE_IDLE_RESUME_MS=12000,DRONE_PATH_REBUILD_MS=4000;
const drone=createGardenDrone();let dronePathKey='',dronePathBuiltAt=-Infinity,dronePathMs=0,droneFlying=false,droneAfter=0,lastCameraInputAt=-Infinity,driftUserOff=false;
function droneTrees(){return treePlacements.map(tree=>{const b=botanical.settledBounds(tree.s,{x:0,y:0},1).bounds;return{id:tree.s.id,x:tree.x,y:tree.y,radius:Math.max(20,b.w/2),height:Math.max(60,b.h)}})}
function droneGroundHeight(x,y){for(const plot of gardenLayout.plots){const b=plot.bounds||plot;if(b&&Number.isFinite(b.x)&&(x<b.x||y<b.y||x>b.x+b.w||y>b.y+b.h))continue;if(pointInPolygon({x,y},plot.polygon))return 3+plotHills.height(plot,x,y)}return 3}
// Rebuilt when the layout changes but never more than every few seconds, so playback days do not hitch the frame.
function ensureDronePath(now){
 const key=sceneKey+'|'+treePlacements.length;if(key===dronePathKey)return drone.ready;
 if(drone.ready&&now-dronePathBuiltAt<DRONE_PATH_REBUILD_MS)return true;
 dronePathKey=key;dronePathBuiltAt=now;const buildStart=performance.now();
 if(!treePlacements.length||!gardenLayout.outline.length){drone.setPath(null);return false}
 drone.setPath(buildDronePath({trees:droneTrees(),outline:gardenLayout.outline,seed:SEED,groundHeight:droneGroundHeight}),viewRect().h);dronePathMs=performance.now()-buildStart;return drone.ready;
}
// Spawn dives and showcases start from, and return to, wherever the camera is now (the drone pose) instead of the far overview.
// Growing clouds: the drone leaves its path and glides (rate-limited, like a dive) to frame every active cloud with its tree.
// Weather bounds always come from gardenWeatherBounds. When the clouds finish, the follower blends back onto the path.
const fitFollower=createPoseFollower();let cloudFitIds=null,fitHandoff=false;
// Measured, not estimated: each subject carries its tree's settled bounds and the cloud's largest measured extent
// (arrivalCloudExtent, taken from the real draw code), and the drawn scale comes from the same arrivalCloudView the painter uses.
let fitUrgent=false,fitSubjects=[];
function cloudFitFraming(urgent=false,ids=null){
 const viewport=viewRect(),subjects=[];
 const weather=new Map(cloudArrivals.entries().map(item=>[item.id,item]));
 for(const id of new Set([...weather.keys(),...(ids||[])])){
  const item=weather.get(id),tree=treePlacements.find(t=>t.s.id===id);if(!tree)continue;
  const root=projectGround(tree.x,tree.y,camera.yaw,treeElevation(tree)),local=botanical.settledBounds(tree.s,root,1).bounds;
  subjects.push({id:tree.s.id,root,treeRel:{x:local.x-root.x,y:local.y-root.y,w:local.w,h:local.h},cloudRel:item?arrivalCloudExtent(item.cloud):null,unit:zoom=>arrivalCloudView(root,(local.h||0)*zoom,0).scale});
 }
 fitSubjects=subjects;
 const targets=urgent?[...subjects,{root:{x:camera.x,y:camera.y},treeRel:{x:0,y:0,w:1,h:1},cloudRel:null,unit:()=>1}]:subjects;
 const frame=fitCloudSubjects(targets,viewport,camera.yaw,{canvas:{w:W,h:H},startZoom:camera.zoom});
 return frame&&{...frame,ids:subjects.map(subject=>subject.id)};
}
function orbitBasePose(){return drone.ready?gardenOrbit.pose(camera):centralOrbitFraming()}
function activeCameraMove(){return showcase||arrival}
function cancelCameraMove(){const active=!!activeCameraMove()||spawnShots.size>0;arrival=null;showcase=null;spawnShots.cancel();return active}
function syncTour(){
 const button=$('tour-garden'),status=$('tour-status'),available=motion&&!motionPreference.matches;syncMotionControls();
 if(button){button.textContent=tour?'Stop flight':'Fly through';button.setAttribute('aria-pressed',String(!!tour));button.disabled=!available||!gardenLayout.plots.length;button.title=available?'Follow the paths between imported projects.':'Turn on motion to fly. Reduced motion keeps the camera still.'}
 if(status)status.textContent=!available?'Camera still · motion is off':tourMessage;
 $('world').dataset.touring=String(!!tour);$('world').dataset.cameraMoving=String(!!flight);
 $('tree-targets').inert=!!flight||!!tour||!!spotlight;
}
function stopFlight(message='Flight stopped · explore at your pace.'){
 const moving=!!flight||!!tour||!!driftBase||!!spotlight;stopAmbientCamera();flight=null;tour=null;if(moving){tourMessage=message;rebuild();updateMap();drawArcs()}syncTour();
}
function moveCamera(destination,duration=850,lift=0){
 if(!motion||motionPreference.matches||document.hidden){Object.assign(camera,destination);scale=camera.zoom;requestCameraDraw();return}
 flight={from:{...camera},to:destination,start:performance.now(),duration,lift};camera.auto=false;syncTour();dirty=true;
}
function destinationForBounds(bounds,maxZoom=1.15,auto=false){
 const previous={...camera};camera.auto=auto;setCameraForBounds(bounds,maxZoom);const destination={...camera};Object.assign(camera,previous);scale=camera.zoom;return destination;
}
function nextTourStop(now){
 if(!tour)return;const plot=tour.plots[tour.index];
 tourMessage='Gliding to '+projects[plot.p].name+' · '+(tour.index+1)+' / '+tour.plots.length;
 const destination=destinationForBounds(plot,.95);
 flight={from:{...camera},to:destination,start:now,duration:5600,lift:Math.min(90,Math.hypot(destination.x-camera.x,destination.y-camera.y)*.055)};
 camera.auto=false;tour.restUntil=0;syncTour();
}
function toggleTour(){
 if(tour){stopFlight();return}if(!motion||motionPreference.matches||!gardenLayout.plots.length)return;
 stopFlight();dismiss();pinnedMap=null;mapSession=null;updateMap();drawArcs();
 let plots=gardenLayout.plots.filter(p=>(!projectFilter||p.id===projectFilter)&&(!searchFilter||projects[p.p].allPrimary.some(s=>matchingIds.has(s.id))));
 if(!plots.length){tourMessage='No matching project paths.';syncTour();return}
 // Begin near the current view, then follow the world layout's stable order.
 const nearest=plots.reduce((best,p,i)=>{const b=projectedBounds(p),distance=Math.hypot(b.x+b.w/2-camera.x,b.y+b.h/2-camera.y);return distance<best.distance?{index:i,distance}:best},{index:0,distance:Infinity}).index;
 plots=plots.slice(nearest).concat(plots.slice(0,nearest));tour={plots,index:0,restUntil:0};nextTourStop(performance.now());
}
// Work that follows motion: one crisp repaint when the camera rests, the terrain dissolve, LOD dwell, and
// the incremental raster queue. Returns to idle (no forced repaint) once all of it has drained.
function settleScene(now,rebuilt){
 if(rebuilt)return;
 const moving=cameraMoving(now);
 if(lastRebuildMoving&&!moving||terrainFading||lodMemory.held&&now-lodMemory.changedAt>=300){rebuild({cameraOnly:true});return}
 if(!specimenMoving(now)&&rasterPending>0){botanical.pump(4);rasterPending=botanical.stats().pendingRasters||0;forestCache=null;dirty=true}
 if(vectorFading)dirty=true;
}
// Copy the layers currently on screen into the reusable ghost canvases (no per-rebuild allocation).
// The forest lands one frame after the base so the two repaints never share a frame.
function snapshotLayers(now){
 if(!base.width||!base.height||!forestCanvas.width||!forestCanvas.height)return;
 for(const [ghost,source] of [[ghostBase,base],[ghostForest,forestCanvas]]){
  if(ghost.width!==source.width)ghost.width=source.width;
  if(ghost.height!==source.height)ghost.height=source.height;
  const g=ghost.getContext('2d');g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,ghost.width,ghost.height);g.drawImage(source,0,0);
 }
 flightFade.active=true;flightFade.cam={...baseCamera};flightFade.start=now;flightFade.forestStart=null;flightFade.defer=1;
}
function flightFadeAlpha(now){
 if(!flightFade.active)return null;
 const ease=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t)};
 const baseAlpha=ease((now-flightFade.start)/FLIGHT_FADE_MS),forestAlpha=flightFade.defer>0||flightFade.forestStart===null?0:ease((now-flightFade.forestStart)/FLIGHT_FADE_MS);
 if(baseAlpha>=1&&forestAlpha>=1){flightFade.active=false;return null}
 return {base:baseAlpha,forest:forestAlpha};
}
// Draw a layer that was rendered at the snapshot camera, aligned to the live camera.
function drawGhostLayer(image){
 const cam=flightFade.cam,r=camera.zoom/cam.zoom;
 ctx.save();ctx.setTransform(DPR,0,0,DPR,0,0);ctx.translate(W/2+(cam.x-camera.x)*camera.zoom,H/2+(cam.y-camera.y)*camera.zoom);ctx.scale(r,r);ctx.translate(-W/2,-H/2);
 ctx.drawImage(image,0,0,image.width,image.height,0,0,W,H);ctx.restore();
}
function advanceCamera(now){
 if(!flight){if(tour&&now>=tour.restUntil){tour.index++;if(tour.index>=tour.plots.length){stopFlight('Flight complete · every matching project visited.');return}nextTourStop(now)}return}
 const progress=Math.min(1,(now-flight.start)/flight.duration);Object.assign(camera,flight.cardPath?sampleCardFlight(flight.from,flight.to,progress,flight.cardPath):sampleFlight(flight.from,flight.to,progress,flight.lift));
 // Reuse the scene between flight samples, but refresh before trees enlarge more than 1.1×.
 // This avoids recreating thousands of tree targets on every animation frame.
 if(now-lastSceneTime>=200||progress===1||camera.zoom/baseCamera.zoom>1.1){snapshotLayers(now);rebuild();lastSceneTime=now}
 dirty=true;if(progress===1){flight=null;if(tour){tour.restUntil=now+1800;tourMessage=projects[tour.plots[tour.index].p].name+' · '+(tour.index+1)+' / '+tour.plots.length}else updateTargets();syncTour();updateMap();drawArcs()}
}
function shownLayout(){return displayScene?.layout||gardenLayout}
function displayedTrees(){return (displayScene?.trees||treePlacements).filter(t=>sessionInTimeRange(t.s,timeRange)&&!(spawnHold.size&&spawnHold.has(t.s.id)))}
function treeElevation(tree,layout=shownLayout()){
 const plot=(layout.plots||[]).find(p=>p.id===tree.plotId||p.id===tree.s?.projectId);
 return 3+(tree.lift||0)+plotHills.height(plot,tree.x,tree.y);
}
function pickHillAtPointer(event){
 if(!plotHillView)return null;
 const rect=canvasRect(),ratio=camera.zoom/baseCamera.zoom;
 const x=(event.clientX-rect.left-W/2)/ratio+W/2-(baseCamera.x-camera.x)*baseCamera.zoom;
 const y=(event.clientY-rect.top-H/2)/ratio+H/2-(baseCamera.y-camera.y)*baseCamera.zoom;
 return plotHillView.pick(x,y);
}
function terrainHidesTree(event,id){
 if(!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY))return false;
 const tree=renderedTrees.find(t=>t.s.id===id),hit=pickHillAtPointer(event);
 return !!(tree&&hit&&hit.depth>hillDepth(tree.x,tree.y,baseCamera.yaw)+.05);
}
function stopAmbientCamera(){droneFlying=false;lastCameraInputAt=performance.now();orbitLastTime=0;spinCoast=false;spotlight=null;cancelCameraMove();spawnReturn=null;driftBase=null;overviewFit=null;ambientSuspended=true;driftEnabled=false;idleAfter=performance.now()+3000;syncMotionControls()}
function resumeAmbientCamera(){if(!motion||motionPreference.matches||mapSession||pinnedMap||hoverSession||hoverProject||scrubbing)return;ambientSuspended=false;driftEnabled=true;driftBase=null;if(gardenOrbit.active)gardenOrbit.rebase(camera);orbitLastTime=0;idleAfter=performance.now()+3000;droneAfter=performance.now()+DRONE_INPUT_HOLD_MS;droneFlying=false;syncMotionControls();dirty=true}
function syncMotionControls(){
 $('drift')?.setAttribute('aria-pressed',String(driftEnabled));
 const button=$('spotlight');if(button){button.setAttribute('aria-pressed',String(!!spotlight));button.disabled=!selected||!motion||motionPreference.matches}
 const drift=$('drift');if(drift)drift.disabled=!motion||motionPreference.matches;
}
function spotlightSelected(){
 if(spotlight){stopFlight();return}if(!selected||!motion||motionPreference.matches)return;
 stopFlight();const tree=displayedTrees().find(t=>t.s.id===selected.id);if(!tree)return;
 const viewport=viewRect(),zoom=Math.min(3,camera.zoom*1.5),from={...camera};
 spotlight={from,to:{auto:false,zoom,yaw:camera.yaw,x:projectGround(tree.x,tree.y,camera.yaw).x-(viewport.x+viewport.w/2-W/2)/zoom,y:projectGround(tree.x,tree.y,camera.yaw,treeElevation(tree)).y-60-(viewport.y+viewport.h/2-H/2)/zoom},start:performance.now(),phase:'approach'};syncTour();
}
function beginArrivalDive(){
 const candidates=spawnShots.ids().map(id=>treePlacements.find(tree=>tree.s.id===id)).filter(Boolean).map(tree=>({id:tree.s.id,x:tree.x,y:tree.y,work:work(tree.s)}));
 const subjects=selectDiveSubjects(candidates);spawnShots.cancel();if(!subjects.length)return;
 const anchorId=subjects[0].id,weather=cloudArrivals.entries().find(item=>item.id===anchorId)||cloudArrivals.entries()[0];
 const overview=orbitBasePose(),subjectIds=subjects.map(subject=>subject.id);
 arrival={kind:'dive',pose:overview,anchorId,subjectIds,elapsed:weather?.state.elapsed||0,phase:'Gather',closeProgress:0,neighborOpacity:1,baseZoom:overview.zoom,rasterZoom:overview.zoom};
 const close=closeOrbitFraming(arrival);if(close)arrival.rasterZoom=Math.min(3,close.zoom*1.2);
}
// Automatic orbit rebuilds no more often than the last rebuild can pay for (at most every 45 ms); the cached
// layers keep compositing every frame in between. Held gestures and morphs always rebuild immediately.
function orbitRebuildDue(now,held){return held||!!pointerGesture||now-lastSceneTime>=Math.min(45,lastRebuildMs*1.25)}
function advanceVisualScene(now){
 let changed=false,geometryChanged=layoutMotion.active;
 if(spawnHold.size){const released=spawnHold.release(layoutMotion.active||!!flight?.liveArrival);if(released.length){treeGrowth.restart(released,now);geometryChanged=changed=true;lastSceneTime=0}}
 if(isCameraMoveComplete(arrival)){arrival=null;idleAfter=now;changed=true}
 if(isCameraMoveComplete(showcase)){showcase=null;idleAfter=now;changed=true}
 if(layoutMotion.active){displayScene=layoutMotion.sample(now);changed=true}
 if(overviewFit&&!hoverSession&&!hoverProject&&!mapSession&&!pinnedMap&&!scrubbing){const p=Math.min(1,(now-overviewFit.start)/620),eased=p*p*(3-2*p);Object.assign(camera,sampleAutoFit(overviewFit.from,overviewFit.to,p));camera.auto=overviewFit.to.auto;fitScale=(overviewFit.fromFitScale??fitScale)+((overviewFit.toFitScale??fitScale)-(overviewFit.fromFitScale??fitScale))*eased;if(arrival?.start)arrival.base={...camera};if(p===1){overviewFit=null;lastSceneTime=0;idleAfter=now+3000}changed=true}
 if(spotlight){const next=sampleFocusReturn(spotlight.from,spotlight.to,now-spotlight.start);Object.assign(camera,next.camera);spotlight.phase=next.phase;if(next.done){spotlight=null;syncTour();lastSceneTime=0}changed=true}
 if(!arrival&&!showcase&&spawnShots.size&&!overviewFit&&!flight&&!tour&&!spotlight&&playback?.state().playing)beginArrivalDive();
 const spinHeld=pointerGesture?.mode==='spin'&&pointerGesture.moved,panHeld=pointerGesture?.mode==='pan'&&pointerGesture.moved;
 const cameraAvailable=motion&&!motionPreference.matches&&!flight&&!tour&&!spotlight&&!overviewFit&&!pinnedMap&&!mapSession&&!hoverSession&&!hoverProject&&!scrubbing;
 // After a wheel/button/pan takeover the drone resumes on its own once the camera has been left alone for a while.
 if(ambientSuspended&&!driftUserOff&&cameraAvailable&&!pointerGesture&&lastCameraInputAt>-Infinity&&now-lastCameraInputAt>=DRONE_IDLE_RESUME_MS&&!arrival&&!showcase&&!spawnShots.size)resumeAmbientCamera();
 const automaticOrbit=driftEnabled&&!ambientSuspended&&(gardenOrbit.active||arrival||showcase||spawnShots.size||now>=idleAfter);
 const freeCamera=!arrival&&!showcase&&!spawnShots.size&&!spinHeld&&!spinCoast&&!panHeld;
 const droneEligible=cameraAvailable&&automaticOrbit&&freeCamera&&now>=idleAfter&&ensureDronePath(now);
 const droneGo=droneEligible&&now>=droneAfter,droneWaiting=droneEligible&&!droneGo;
 let droneStepped=false;
 const cloudsActive=cloudArrivals.entries().length>0;
 const cloudEligible=cameraAvailable&&driftEnabled&&!ambientSuspended&&!arrival&&!showcase&&!spinHeld&&!spinCoast&&!panHeld&&now>=idleAfter&&now>=droneAfter&&(cloudsActive||fitFollower.active);
 if(!cloudEligible&&fitFollower.active){fitUrgent=false;fitFollower.reset(null);fitHandoff=false;cloudFitIds=null}
 if(!cloudEligible&&!fitFollower.active)cloudFitIds=null;
 if(cloudEligible){
  const view=viewRect(),fit=cloudsActive?cloudFitFraming(fitUrgent):null;
  if(!fitFollower.active){fitFollower.reset({...gardenOrbit.pose(camera),yaw:camera.yaw||0,yawRate:gardenOrbit.angularVelocity});droneFlying=false;fitHandoff=false;if(!driftBase){driftBase={...camera};orbitLastTime=now}}
  const delta=Math.max(0,now-orbitLastTime);orbitLastTime=now;
  let target=null;
  if(fit){cloudFitIds=new Set(fit.ids);fitHandoff=false;target={center:fit.center,zoom:fit.zoom,lift:fit.lift}}
  else if(ensureDronePath(now)){
   cloudFitIds=null;
   if(!fitHandoff){const from=fitFollower.pose;drone.resume({x:from.center.x,y:from.center.y,yaw:from.yaw,yawRate:from.yawRate},view.h);fitHandoff=true}
   const dp=drone.step(delta,{viewHeight:view.h,viewportOffsetY:view.y+view.h/2-H/2});target=dp&&{center:dp.center,zoom:dp.zoom,lift:dp.lift,yaw:dp.yaw};
  }
  const pose=target&&fitFollower.step(delta,target,{urgent:!!fit&&fitUrgent});
  if(pose){
   Object.assign(camera,gardenOrbit.steer(camera,delta,{center:pose.center,zoom:pose.zoom,lift:pose.lift,yaw:pose.yaw,yawRate:pose.yawRate}));
   // Hard guarantee: if any measured cloud or tree edge leaves the viewport, the follower zooms out fast next frame.
   fitUrgent=!!fit&&!cloudFitContainment(fitSubjects,camera,view,{w:W,h:H},1).contained;
   if(!fit&&pose.remaining.center<30&&pose.remaining.zoom<.03){drone.adoptHeading(pose.yaw,pose.yawRate);fitFollower.reset(null);fitHandoff=false;droneFlying=true}
  }else{fitFollower.reset(null);fitHandoff=false;cloudFitIds=null}
  droneStepped=changed=true;
 }else if(droneGo){
  const view=viewRect();
  if(!droneFlying){droneFlying=true;const anchor=gardenOrbit.pose(camera);drone.resume({x:anchor.center.x,y:anchor.center.y,yaw:camera.yaw||0,yawRate:gardenOrbit.angularVelocity},view.h)}
  if(!driftBase){driftBase={...camera};orbitLastTime=now}
  const delta=Math.max(0,now-orbitLastTime);orbitLastTime=now;
  const pose=drone.step(delta,{viewHeight:view.h,viewportOffsetY:view.y+view.h/2-H/2});
  if(pose)Object.assign(camera,gardenOrbit.steer(camera,delta,pose));
  orbitStepPending=true;droneStepped=changed=true;
 }else if(cameraAvailable&&!panHeld&&(automaticOrbit||spinHeld||spinCoast)){
  droneFlying=false;
  if(!driftBase){driftBase={...camera};orbitLastTime=now}
  const pausedArrival=!playback?.state().playing&&(!!arrival||cloudArrivals.active);
  const delta=pausedArrival?0:Math.max(0,now-orbitLastTime);orbitLastTime=now;
  // With a drone path the camera holds its own pose (no zoom-out to the far overview) between input and the drone.
  const holdPose=drone.ready&&!arrival&&!showcase&&!spawnShots.size;
  const framing={...(holdPose?{center:{x:0,y:0},zoom:1}:activeOrbitFraming()),autoOrbit:driftEnabled&&!ambientSuspended&&!holdPose,holdYaw:spinHeld,hold:holdPose};
  Object.assign(camera,gardenOrbit.step(camera,delta,framing));
  if(automaticOrbit&&!arrival&&!showcase&&!spawnShots.size&&!spinHeld&&!spinCoast&&!droneWaiting)orbitStepPending=true;
  if(spinCoast&&!framing.autoOrbit&&Math.abs(gardenOrbit.angularVelocity)<.001){spinCoast=false;gardenOrbit.rebase(camera,{angularVelocity:0})}
  changed=true;
 }else{droneFlying=false;orbitLastTime=now}

 if(changed){scale=camera.zoom;const turning=Math.abs((camera.yaw||0)-(baseCamera.yaw||0))>1e-9;if(geometryChanged||(turning||droneStepped)&&orbitRebuildDue(now,spinHeld||panHeld)||(!arrival&&!spawnShots.size&&now-lastSceneTime>=200)){rebuild({cameraOnly:!geometryChanged});lastSceneTime=now;if(!turning&&!droneStepped)updateMap()}dirty=true;if(mapSession)drawArcs()}
}
function point(x,y,z=0){const p=projectGround(x,y,camera.yaw,z);return{x:W/2+(p.x-camera.x)*scale,y:H/2+(p.y-camera.y)*scale}}
function centralOrbitFraming(){
 // Fit the complete swept envelope, independent of yaw and weather phase.
 // Stable radius prevents the view breathing in and out on every quarter turn.
 const key=sceneKey+'|'+W+'|'+H;
 if(orbitFrameCache?.key===key)return orbitFrameCache.value;
 const bounds=gardenLayout.bounds,center={x:bounds.x+bounds.w/2,y:bounds.y+bounds.h/2};
 const relief=buildIslandContours(gardenLayout.outline);
 const radius=Math.max(1,...relief.extent.map(p=>Math.hypot(p.x-center.x,p.y-center.y)))*Math.SQRT2;
 let height=80,width=30;
 for(const tree of treePlacements){
  const b=botanical.settledBounds(tree.s,{x:0,y:0},1).bounds;
  height=Math.max(height,-b.y+treeElevation(tree,gardenLayout));width=Math.max(width,Math.abs(b.x),Math.abs(b.x+b.w));
 }
 // Leave permanent headroom for the procedural clouds, even after rain clears.
 height=Math.max(height,...gardenLayout.plots.map(p=>plotHills.hill(p).peak))+150;
 const viewport=viewRect();
 const zoom=Math.max(.006,Math.min(1.15,viewport.w/(2*(radius+width)+40),viewport.h/(radius*.86+height+relief.depth+100)));
 const lift=(height-relief.depth-60)/2+(viewport.y+viewport.h/2-H/2)/zoom;
 const value={center,zoom,lift};orbitFrameCache={key,value};return value;
}
function closeOrbitFraming(move){
 const viewport=viewRect(),trees=move?.subjectIds.map(id=>treePlacements.find(tree=>tree.s.id===id)).filter(Boolean)||[];
 if(!trees.length)return null;
 const roots=trees.map(tree=>{const root=projectGround(tree.x,tree.y,camera.yaw,treeElevation(tree,gardenLayout)),treeBounds=botanical.settledBounds(tree.s,root,1).bounds,unit=Math.max(.22,Math.min(1.6,(treeBounds.h||40)/200));return{id:tree.s.id,x:tree.x,y:tree.y,treeBounds,weatherBounds:move.kind==='dive'?gardenWeatherBounds(root,unit):null}});
 const center={x:(Math.min(...roots.map(root=>root.x))+Math.max(...roots.map(root=>root.x)))/2,y:(Math.min(...roots.map(root=>root.y))+Math.max(...roots.map(root=>root.y)))/2};
 const options={projectedCenter:projectGround(center.x,center.y,camera.yaw),viewportOffsetY:viewport.y+viewport.h/2-H/2};
 return move.kind==='dive'?frameSpawnSubjects(roots,viewport,centralOrbitFraming().zoom,options):frameDiveSubjects(roots,viewport,centralOrbitFraming().zoom,options);
}
function activeOrbitFraming(){
 const move=activeCameraMove();if(!move)return centralOrbitFraming();const overview=move.pose||centralOrbitFraming();
 const close=closeOrbitFraming(move);if(!close)return overview;
 let sample;if(move.kind==='dive'){
  const weather=cloudArrivals.entries().find(item=>item.id===move.anchorId),crown=weather?.state.crown??1;
  sample=sampleDiveTargets(overview,close,move.elapsed,{speed:playback?.getSpeed?.()||1,crown});
 }else sample=sampleShowcaseTargets(overview,close,move.elapsed);
 Object.assign(move,{phase:sample.phase,closeProgress:sample.closeProgress,neighborOpacity:sample.subjectOpacity});
 return sample;
}
function showcaseTree(id){
 const tree=treePlacements.find(item=>item.s.id===id),now=performance.now();
 const growing=tree&&treeGrowth.sample(id,now,motion).active;
 const weatherGrowing=cloudArrivals.entries().some(item=>item.id===id&&item.state.crown<1);
 const interaction=!!(pointerGesture||flight||tour||spotlight||arrival||showcase||overviewFit||mapSession||pinnedMap||hoverSession||hoverProject||scrubbing||playback?.state().playing||!camera.auto||ambientSuspended||!driftEnabled);
 if(!canShowcaseTree({exists:!!tree,fullyGrown:!!tree&&!growing&&!weatherGrowing,motion,reducedMotion:motionPreference.matches,hidden:document.hidden,interaction}))return false;
 const overview=orbitBasePose();showcase={kind:'showcase',pose:overview,anchorId:id,subjectIds:[id],elapsed:0,phase:'approach',closeProgress:0,neighborOpacity:1,baseZoom:overview.zoom,rasterZoom:overview.zoom};
 const close=closeOrbitFraming(showcase);if(close)showcase.rasterZoom=Math.min(3,close.zoom*1.2);idleAfter=now;dirty=true;return true;
}
function viewRect(){
 // Inspection lives outside the canvas. Reserve only the camera controls below.
 const edge=W>600?32:20,rail=$('spawn-cards'),railWidth=rail&&!rail.hidden&&rail.dataset.collapsed!=='true'?rail.getBoundingClientRect().width:0,left=Math.min(Math.max(edge,railWidth+12),Math.max(edge,W-200));
 return{x:left,y:32,w:Math.max(100,W-left-edge),h:Math.max(120,H-120)};
}
function projectedBounds(rect,padding=0){const corners=(rect.polygon||(rect===gardenLayout.bounds&&gardenLayout.outline.length?gardenLayout.outline:null)||[{x:rect.x,y:rect.y},{x:rect.x+rect.w,y:rect.y},{x:rect.x+rect.w,y:rect.y+rect.h},{x:rect.x,y:rect.y+rect.h}]).map(p=>projectGround(p.x,p.y,camera.yaw));if(rect.polygon)for(const face of plotHills.hill(rect).faces)for(const p of face.vertices)corners.push(projectGround(p.x,p.y,camera.yaw,p.z+2+(rect.lift||0)));else if(rect===gardenLayout.bounds)for(const plot of gardenLayout.plots||[]){const h=plotHills.hill(plot);corners.push(projectGround(plot.centroid.x,plot.centroid.y,camera.yaw,h.peak+2))}const xs=corners.map(p=>p.x),ys=corners.map(p=>p.y);return{x:Math.min(...xs)-padding,y:Math.min(...ys)-padding,w:Math.max(...xs)-Math.min(...xs)+padding*2,h:Math.max(...ys)-Math.min(...ys)+padding*2}}
function fitWorldBounds(bounds,zoom=camera.zoom){
 let world=projectedBounds(bounds,80);if(bounds!==gardenLayout.bounds)return world;
 const extent=buildIslandContours(gardenLayout.outline).extent.map(p=>projectGround(p.x,p.y,camera.yaw,p.z));
 if(extent.length){const left=Math.min(world.x,...extent.map(p=>p.x)),top=Math.min(world.y,...extent.map(p=>p.y)),right=Math.max(world.x+world.w,...extent.map(p=>p.x)),bottom=Math.max(world.y+world.h,...extent.map(p=>p.y));world={x:left-40,y:top,w:right-left+80,h:bottom-top+100}}
 const trees=treePlacements.map(tree=>{const local=typeof botanical.settledBounds==='function'?botanical.settledBounds(tree.s,projectGround(tree.x,tree.y,camera.yaw,treeElevation(tree,gardenLayout)),1).bounds:null;if(!local)return null;return{x:local.x-8,y:local.y-8,w:local.w+16,h:local.h+16}}).filter(Boolean);if(!trees.length)return world;
 for(const item of cloudArrivals.entries()){const tree=treePlacements.find(t=>t.s.id===item.id);if(!tree)continue;const root=projectGround(tree.x,tree.y,camera.yaw,treeElevation(tree,gardenLayout)),local=botanical.settledBounds(tree.s,root,1).bounds,unit=Math.max(.22,Math.min(1.6,(local.h||40)*zoom/200))/zoom;trees.push(arrivalCloudBounds(item.cloud,root,unit))}
 const left=Math.min(world.x,...trees.map(tree=>tree.x)),top=Math.min(world.y,...trees.map(tree=>tree.y)),right=Math.max(world.x+world.w,...trees.map(tree=>tree.x+tree.w)),bottom=Math.max(world.y+world.h,...trees.map(tree=>tree.y+tree.h));return{x:left,y:top,w:right-left,h:bottom-top};
}
function setCameraForBounds(bounds,maxZoom=1.15){const viewport=viewRect(),fit=world=>Math.min(maxZoom,viewport.w/Math.max(1,world.w),viewport.h/Math.max(1,world.h));let zoom=Math.max(.006,camera.zoom||1),world;if(cloudArrivals.active&&bounds===gardenLayout.bounds){for(let i=0;i<6;i++){world=fitWorldBounds(bounds,zoom);const next=fit(world);if(Math.abs(next-zoom)<.0001){zoom=next;break}zoom=next}world=fitWorldBounds(bounds,zoom)}else{world=fitWorldBounds(bounds);zoom=fit(world)}camera.zoom=zoom;scale=zoom;camera.x=world.x+world.w/2-(viewport.x+viewport.w/2-W/2)/scale;camera.y=world.y+world.h/2-(viewport.y+viewport.h/2-H/2)/scale}
function fitGarden(){focusedProject=null;stopFlight();const destination=destinationForBounds(gardenLayout.bounds,1.15,true);fitScale=destination.zoom;moveCamera(destination);resumeAmbientCamera()}
function focusProject(id){focusedProject=id;hoverProject=null;stopFlight('Camera paused · project focused.');const plot=gardenLayout.plots.find(p=>p.id===id);if(!plot)return;moveCamera(destinationForBounds(plot,1.2));resumeAmbientCamera();dirty=true}
function focusSelected(){
 stopFlight();if(!selected)return;
 resize();
 const tree=displayedTrees().find(t=>t.s.id===selected.id);if(!tree)return;
 const viewport=viewRect(),root=projectGround(tree.x,tree.y,camera.yaw,treeElevation(tree));
 const bounds=botanical.settledBounds(tree.s,root,1).bounds;
 const zoom=Math.max(.006,Math.min(3,viewport.w*.8/Math.max(1,bounds.w),viewport.h*.72/Math.max(1,bounds.h)));
 const destination={auto:false,zoom,yaw:camera.yaw,x:bounds.x+bounds.w/2-(viewport.x+viewport.w/2-W/2)/zoom,y:bounds.y+bounds.h/2-(viewport.y+viewport.h/2-H/2)/zoom};
 const cardPath=cardFlightPlan(camera,destination,viewport);
 moveCamera(destination,cardPath.duration);
 if(flight)flight.cardPath=cardPath;
}
function zoomCamera(factor,x=W/2,y=H/2){stopFlight();const old=scale;camera.auto=false;camera.zoom=Math.max(1e-9,Math.min(3,old*factor));camera.x+=(x-W/2)/old-(x-W/2)/camera.zoom;camera.y+=(y-H/2)/old-(y-H/2)/camera.zoom;scale=camera.zoom;requestCameraDraw()}
// Consume input in the main frame so geometry and pixels update together.
function requestCameraDraw(){cameraFrame=1;dirty=true}
function refreshSpecimenEncodings(){
 const key=evidenceGeneration+'|'+day;
 if(key===encodingCacheKey)return false;
 const next=encodeGardenSpecimens(sessions,{day,cutoffMs:cutoff()});
 const changed=next.size!==specimenEncodings.size||[...next].some(([id,record])=>record.visualKey!==specimenEncodings.get(id)?.visualKey);
 specimenEncodings=next;encodingCacheKey=key;
 if(changed)specimenVisualGeneration++;
 return changed;
}
function prepareWorld(){
  refreshSpecimenEncodings();
  visibleSessions=sessions.filter(s=>s.birth<=day&&sessionInTimeRange(s,timeRange));const list=filteredSessions();matchingIds=new Set(list.map(s=>s.id));
  if(!selected||!visibleSessions.some(s=>s.id===selected.id))selected=list.find(s=>s.fileEvents.length)||list[0]||visibleSessions[0]||null;
  $('shown-count').textContent=visibleSessions.length.toLocaleString()+' session trees across '+projects.filter(p=>p.birth<=day).length+' project lots'+((projectFilter||searchFilter)?' · '+list.length+' matching sessions':' · all imported projects stay in the garden');
  $('session-select')?.replaceChildren(...list.map(s=>createOption(s.id,projects[s.p].name+' / '+s.title,s.id===selected?.id)));if($('session-select'))$('session-select').value=selected?.id||'';
  const status=$('data-loading');status.hidden=!loading&&!loadError&&!!gardenLayout.plots.length;status.classList.toggle('error',!!loadError);status.textContent=loading?'Loading sessions…':loadError||'No project records exist at this date.';
  document.querySelector('.session-card').hidden=!selected;const world=$('world');Object.assign(world.dataset,{importedSessions:String(allSessions.length),primarySessions:String(sessions.length),matchingSessions:String(list.length),visibleSessions:String(visibleSessions.length),unresolvedAgents:String(allSessions.filter(s=>s.isSubagent&&!s.rootSessionId).length),filtered:String(!!(projectFilter||searchFilter))});if($('focus-selected'))$('focus-selected').disabled=!selected;syncMotionControls();
}
function buildWorldScene(){
 const key=evidenceGeneration+'|'+day;if(key===sceneKey)return;sceneKey=key;
 const started=performance.now(),inputs=projects.map(p=>({id:p.id,birth:p.birth,work:p.allPrimary.reduce((n,s)=>n+work(s),0),sessionCount:p.allPrimary.filter(s=>s.birth<=day).length}));
 gardenLayout=buildGardenLayout(inputs,{day,seed:SEED});treePlacements=[];
 for(const lot of gardenLayout.plots){
  const index=projects.findIndex(p=>p.id===lot.id);lot.p=index;
  const list=projects[index].allPrimary.filter(s=>s.birth<=day),byId=new Map(list.map(s=>[s.id,s]));
  lot.planting=plantTrees(list.map(s=>s.id),lot.polygon,{seed:SEED+'/'+lot.id,edgeInset:Math.min(18*TREE_SPACING,Math.sqrt(lot.area/Math.max(1,list.length))*.15)});
  for(const position of lot.planting.points)treePlacements.push({s:byId.get(position.id),x:position.x,y:position.y,plotId:lot.id});
  lot.labelAnchor=frontAnchor(lot.planting.polygon,.62);
 }
 const evidence=$('lot-evidence');evidence.replaceChildren();
 for(const lot of gardenLayout.plots){const item=document.createElement('span');Object.assign(item.dataset,{plotId:lot.id,x:String(lot.x),y:String(lot.y),w:String(lot.w),h:String(lot.h),area:String(lot.area),polygon:JSON.stringify(lot.polygon),centroid:JSON.stringify(lot.centroid),placementBounds:JSON.stringify(lot.planting.bounds),edgeInset:String(lot.planting.edgeInset),minSpacing:String(lot.planting.minSpacing),treeCount:String(lot.planting.points.length),trees:JSON.stringify(lot.planting.points),plantingPolygon:JSON.stringify(lot.planting.polygon)});evidence.appendChild(item)}
 Object.assign($('world').dataset,{plotCount:String(gardenLayout.plots.length),projectIds:JSON.stringify(gardenLayout.plots.map(p=>p.id)),worldArea:String(gardenLayout.area),worldBounds:JSON.stringify(gardenLayout.bounds),worldOutline:JSON.stringify(gardenLayout.outline),sessionCount:String(visibleSessions.length),layoutGenerationMs:String(performance.now()-started),layoutDiagnostics:JSON.stringify(gardenLayout.fitting||null),placementCount:String(treePlacements.length),placementContained:String(gardenLayout.plots.every(p=>p.planting.points.every(v=>pointInPolygon(v,p.planting.polygon)))),placementRelaxedCount:String(gardenLayout.plots.filter(p=>p.planting.relaxed).length),placementMinSpacing:String(gardenLayout.plots.some(p=>p.planting.points.length>1)?Math.min(...gardenLayout.plots.filter(p=>p.planting.points.length>1).map(p=>p.planting.minSpacing)):0)});
 syncTour();
}

function drawSymbol(c,s,x,y,growth=null,origin=point(x,y,3)){const result=botanical.symbol(c,s,{...origin,modelX:x,modelY:y},scale,growth);anchorsOnScreen.set(s.id,result);hitBounds.set(s.id,result.bounds);return result}
function settledTreeFitBounds(tree){
 const s=tree?.s;if(!s||typeof botanical.settledBounds!=='function')return null;
 return botanical.settledBounds(s,point(tree.x,tree.y,treeElevation(tree)),scale).bounds;
}
const targetButtons=new Map();
function boundsChanged(a,b){return !a||!b||Math.abs(a.x-b.x)>.01||Math.abs(a.y-b.y)>.01||Math.abs(a.w-b.w)>.01||Math.abs(a.h-b.h)>.01}
function updateTargets(){
 const host=$('tree-targets'),ids=new Set();
 let targetIndex=0;for(const s of renderedTrees.map(t=>t.s)){
  const b=hitBounds.get(s.id),o=anchorsOnScreen.get(s.id);if(!b)continue;ids.add(s.id);
  let button=targetButtons.get(s.id);
  if(!button){button=document.createElement('button');button.className='tree-target';const session=()=>sessions.find(item=>item.id===s.id);button.addEventListener('pointerenter',event=>previewTree(session(),event));button.addEventListener('pointermove',event=>previewTree(session(),event));button.addEventListener('pointerleave',()=>{if(!pointerGesture)leaveTree()});button.addEventListener('focus',()=>previewTree(session()));button.addEventListener('blur',leaveTree);button.addEventListener('click',event=>{if(performance.now()<suppressClickUntil)return;if(event.detail&&terrainHidesTree(event,s.id)){const lot=pickHillAtPointer(event)?.plot;if(lot)focusProject(lot.id);return}pin(session())});targetButtons.set(s.id,button);host.appendChild(button)}
  if(host.children[targetIndex]!==button)host.insertBefore(button,host.children[targetIndex]||null);targetIndex++;
  Object.assign(button.dataset,{session:s.id,treeAnchorX:String(o.x),treeAnchorY:String(o.y),canvasRenderer:'2d',treeAnchorSpace:'canvas-css-pixels',commitCount:String(s.commits.filter(c=>c.day<=day).length),agentCount:String(s.agents.filter(d=>d<=day).length),visualBoids:String(treeAgents(s).length),detail:b.detail||'organic',crownFamily:botanical.profile(s.id).family});
  button.style.cssText='left:'+b.x+'px;top:'+b.y+'px;width:'+b.w+'px;height:'+b.h+'px';button.setAttribute('aria-label',hoverSummary(s));button.setAttribute('aria-pressed',String(s.id===selected?.id));
 }
 for(const[id,button]of targetButtons)if(!ids.has(id)){button.remove();targetButtons.delete(id)}
}
function updateTargetGeometry(){
 const order=new Map(renderedTrees.map((t,i)=>[t.s.id,i]));
 for(const [id,button] of targetButtons){const b=hitBounds.get(id),o=anchorsOnScreen.get(id);if(!b||!o)continue;button.dataset.treeAnchorX=String(o.x);button.dataset.treeAnchorY=String(o.y);button.style.left=b.x+'px';button.style.top=b.y+'px';button.style.width=b.w+'px';button.style.height=b.h+'px';button.style.zIndex=String(order.get(id)||0)}
}

function drawMoths(time){
 const started=performance.now(),entries=[];
 for(const t of renderedTrees){const s=t.s,o=anchorsOnScreen.get(s.id);if(!o||treeGrowth.sample(s.id,performance.now(),motion).crown<1||cloudArrivals.entries().some(item=>item.id===s.id&&item.state.crown<1))continue;entries.push({id:s.id,x:o.x,y:o.y,width:o.bounds?.w||20,height:o.bounds?.h||24,agents:treeAgents(s)})}
 const stats=flock.draw(ctx,entries,time,{enabled:motion&&!motionPreference.matches,trails:boidTrails,selectedTreeId:pinnedMap});
 updateBirdTargets();
 canvas.dataset.flockDrawMs=String(performance.now()-started);canvas.dataset.visibleBoids=String(stats.birds);canvas.dataset.boidCap=String(stats.cap);canvas.dataset.trailSegments=String(stats.segments);
}
const birdTargetButtons=new Map();
function birdKeyAtPointer(event,key,host,birds){
 if(event.detail===0)return key;
 const rect=host.getBoundingClientRect(),sx=rect.width/host.offsetWidth,sy=rect.height/host.offsetHeight;
 if(!sx||!sy)return key;
 const x=(event.clientX-rect.left)/sx,y=(event.clientY-rect.top)/sy;
 let nearest=key,distance=18*18;
 for(const bird of birds){if(!bird.screen)continue;
  const delta=(bird.screen.x-x)**2+(bird.screen.y-y)**2;
  if(delta<distance){nearest=bird.key;distance=delta}
 }
 return nearest;
}
function updateBirdTargets(){
 const host=$('bird-targets');if(!host)return;const ids=new Set();
 for(const bird of flock.state()){if(!agentRecord(bird.key)||!bird.screen)continue;ids.add(bird.key);let button=birdTargetButtons.get(bird.key);
  if(!button){button=document.createElement('button');button.className='bird-target';button.addEventListener('click',event=>selectAgent(birdKeyAtPointer(event,bird.key,host,flock.state())));birdTargetButtons.set(bird.key,button);host.appendChild(button)}
  button.style.left=(bird.screen.x-18)+'px';button.style.top=(bird.screen.y-18)+'px';const label='Inspect agent '+(agentRecord(bird.key)?.nickname||bird.key.slice(0,8)),pressed=String(selectedAgentId===bird.key);
  if(button.getAttribute('aria-label')!==label)button.setAttribute('aria-label',label);
  if(button.getAttribute('aria-pressed')!==pressed)button.setAttribute('aria-pressed',pressed);
 }
 for(const[id,button]of birdTargetButtons)if(!ids.has(id)){button.remove();birdTargetButtons.delete(id)}
}

function fitVisibleGarden(){
 if(liveMode)return;
 if(!camera.auto||flight||tour||spotlight||arrival||showcase||spawnShots.size||overviewFit||layoutMotion.active||driftBase||hoverSession||hoverProject||mapSession||pinnedMap||scrubbing||!gardenLayout.outline.length)return;
 const ground=targetContours(gardenLayout.outline).extent.map(p=>point(p.x,p.y,p.z)),bounds=displayedTrees().map(settledTreeFitBounds).filter(Boolean);
 for(const item of cloudArrivals.entries()){const tree=displayedTrees().find(t=>t.s.id===item.id);if(!tree)continue;const root=point(tree.x,tree.y,treeElevation(tree)),local=botanical.settledBounds(tree.s,root,scale).bounds,unit=Math.max(.22,Math.min(1.6,(local.h||40)/200));bounds.push(arrivalCloudBounds(item.cloud,root,unit))}
 const left=Math.min(...ground.map(p=>p.x),...bounds.map(b=>b.x)),top=Math.min(...ground.map(p=>p.y),...bounds.map(b=>b.y));
 const right=Math.max(...ground.map(p=>p.x),...bounds.map(b=>b.x+b.w)),bottom=Math.max(...ground.map(p=>p.y),...bounds.map(b=>b.y+b.h));
 const next=fitCameraToScreenBounds(camera,{x:left,y:top,w:right-left,h:bottom-top},viewRect(),{x:W/2,y:H/2});
 if(next!==camera){if(motion&&!motionPreference.matches&&growthDay!==null){driftBase=null;overviewFit={from:{...camera},to:next,fromFitScale:fitScale,toFitScale:next.zoom,start:performance.now()}}else{fitScale=next.zoom;Object.assign(camera,next);scale=camera.zoom;requestCameraDraw()}}
}
function prepareSpecimenRasters(move=activeCameraMove()){
 const subjects=new Set(move?.subjectIds||[]);
 for(const t of renderedTrees)t.screen.rasterZoom=move?(subjects.has(t.s.id)?move.rasterZoom:move.baseZoom):undefined;
 const demands=renderedTrees.map(t=>{
  const height=botanical.profile(t.s.id).height*treeSize*(t.screen.rasterZoom||scale)*DPR;
  const bucket=Math.min(768,Math.max(4,2**(Math.ceil(Math.log2(Math.max(4,height))*2)/2)));
  return t.s.id+':'+bucket;
 }).sort();
 const key=[specimenVisualGeneration,DPR,...demands].join('|');
 if(key!==specimenPreparationKey){rasterPending=botanical.prepare(renderedTrees,{zoom:scale,dpr:DPR,moving:specimenMoving(),budgetMs:4})?.pendingRasters||0;specimenPreparationKey=key}
}
function primarySparkle(id){
 const state=liveMode&&liveState.agentState(id);
 return !!state&&(state.state==='working'||state.state==='waiting');
}
function drawSpecimenSparkles(){
 const move=activeCameraMove(),subjects=new Set(move?.subjectIds||[]);
 for(const tree of renderedTrees){
  if(!primarySparkle(tree.s.id))continue;
  const origin=anchorsOnScreen.get(tree.s.id);if(!origin?.actualHeight)continue;
  const height=origin.actualHeight,bounds=tree.sparkleBounds,occluders=tree.sparkleOccluders??(tree.sparkleOccluders=plotHillView.occluders(tree,bounds));
  ctx.save();ctx.globalAlpha*=(tree.opacity??1)*(subjects.has(tree.s.id)?1:move?.neighborOpacity??1);
  ctx.globalAlpha*=(projectFilter||searchFilter)&&!matchingIds.has(tree.s.id)?.52:1;
  paintHillTree(ctx,bounds,occluders,DPR,layer=>drawLiveSparkle(layer,origin.x,origin.y,height,decorationTime/1000,tree.s.id,{reducedMotion:!motion||motionPreference.matches}));
  ctx.restore();
 }
}
function drawForest(target,now){
 const forestStart=performance.now(),previousScale=scale;scale=baseCamera.zoom;const animate=motion&&!motionPreference.matches;
 const samples=new Map(renderedTrees.map(t=>[t.s.id,treeGrowth.sample(t.s.id,now,animate)]));
 if(animate)for(const {id,state} of cloudArrivals.entries()){const growth=samples.get(id);if(growth)samples.set(id,{...growth,trunk:state.trunk,branches:state.branches,crown:state.crown,active:state.active})}
 let growing=0,emerging=0;
 const move=activeCameraMove(),subjects=new Set([...(move?.subjectIds||[]),...(cloudFitIds||[])]),neighborOpacity=move?.neighborOpacity??1;
 const active=vectorFading||[...samples.values()].some(g=>g.active),key=[specimenVisualGeneration,day,scale,DPR,W,H,specimenMoving(now),projectFilter,searchFilter,treeSize,treeYScale,neighborOpacity,...subjects].join('|');
 const cached=!active&&forestCache?.trees===renderedTrees&&forestCache.key===key&&forestCache.matches===matchingIds;
 if(!cached){
  forestCache=null;
  const width=Math.round(W*DPR),height=Math.round(H*DPR);
  if(forestCanvas.width!==width)forestCanvas.width=width;
  if(forestCanvas.height!==height)forestCanvas.height=height;
  forestArt.setTransform(DPR,0,0,DPR,0,0);forestArt.clearRect(0,0,W,H);
  const c=forestArt;
  const moving=specimenMoving(now);botanical.beginFrame(renderedTrees,{zoom:scale,dpr:DPR,viewport:{x:0,y:0,w:W,h:H},moving,now,focusIds:subjects});

 for(const t of renderedTrees){const growth=samples.get(t.s.id),previous=hitBounds.get(t.s.id);if(growth.active)growing++;if(growth.crown<1)emerging++;c.save();c.globalAlpha*=(t.opacity??1)*(subjects.has(t.s.id)?1:neighborOpacity);c.globalAlpha*=(projectFilter||searchFilter)&&!matchingIds.has(t.s.id)?.52:1;paintHillTree(c,t.clipBounds,t.occluders,DPR,layer=>{botanical.shadow(layer,t.s,t.screen,growth,t.detailed);if(t.detailed||subjects.has(t.s.id))drawTree(layer,t.s,t.x,t.y,growth,t.screen);else drawSymbol(layer,t.s,t.x,t.y,growth,t.screen)},true,{nativeResolution:botanical.usesVector(t.s),viewport:{x:0,y:0,w:W,h:H}});if(boundsChanged(previous,hitBounds.get(t.s.id)))targetsDirty=true;c.restore()}
  {const painted=botanical.stats();vectorFading=!!painted.vectorFading;rasterPending=painted.pendingRasters||0}
  if(!active&&!vectorFading)forestCache={trees:renderedTrees,key,matches:matchingIds};
 }
 target.imageSmoothingEnabled=true;target.imageSmoothingQuality='high';
 target.drawImage(forestCanvas,0,0,forestCanvas.width,forestCanvas.height,0,0,W,H);
 scale=previousScale;
 if(diagnosticsDue('forest',forestStart,cameraMoving(now))){setDataset(canvas,{forestCached:String(cached),forestCacheBytes:String(forestCanvas.width*forestCanvas.height*4),growingTrees:String(growing),emergingTrees:String(emerging),forestDrawMs:String(performance.now()-forestStart)});const cache=botanical.stats();setDataset($('world'),{botanicalCacheBytes:String(cache.bytes),botanicalCacheLimit:String(cache.limit),botanicalCacheHits:String(cache.hits),botanicalCacheMisses:String(cache.misses)})}
 const targetStart=performance.now();if(targetsDirty&&!flight&&!tour&&(!cameraMoving(now)||targetStart-lastTargetUpdateAt>=TARGET_MOVING_MS)){lastTargetUpdateAt=targetStart;const needsFull=metadataDirty||targetButtons.size!==renderedTrees.length||renderedTrees.some(t=>!targetButtons.has(t.s.id));if(needsFull){updateTargets();metadataDirty=false}else updateTargetGeometry();targetsDirty=false;drawArcs();setDataset(canvas,{targetUpdateMs:String(performance.now()-targetStart)})}}
function drawTreeHover(target,now){
 const ratio=camera.zoom/baseCamera.zoom,nativeDPR=DPR*ratio;
 const viewport={x:W/2-(W/2+(baseCamera.x-camera.x)*camera.zoom)/ratio,y:H/2-(H/2+(baseCamera.y-camera.y)*camera.zoom)/ratio,w:W/ratio,h:H/ratio};
 const move=activeCameraMove(),subjects=new Set(move?.subjectIds||[]);
 const arrivals=new Map(cloudArrivals.entries().map(item=>[item.id,item.state]));
 const growthFor=tree=>({...treeGrowth.sample(tree.s.id,now,motion&&!motionPreference.matches),...arrivals.get(tree.s.id)});
 const opacityFor=tree=>(tree.opacity??1)*(subjects.has(tree.s.id)?1:move?.neighborOpacity??1)*((projectFilter||searchFilter)&&!matchingIds.has(tree.s.id)?.52:1);
 const result=botanical.drawHover(target,renderedTrees,{now,zoom:baseCamera.zoom,dpr:nativeDPR,viewport,generation:specimenVisualGeneration,opacityFor,growthFor,
  paintMasked:(layer,tree,bounds,paint)=>paintHillTree(layer,bounds,tree.occluders,nativeDPR,paint,false,{nativeResolution:true,viewport})});
 setDataset(canvas,{hoveredTree:hoverTreeId||'',hoverOverlay:JSON.stringify(result)});return result;
}
function drawDynamic(time){
 // Cover every camera source, including flights and fit transitions.
 if(camera.zoom/baseCamera.zoom>(droneFlying||fitFollower.active?1.02:1.1))rebuild({cameraOnly:true});
 if(!base.width||!base.height||!labelCanvas.width||!labelCanvas.height)return;
 ctx.setTransform(DPR,0,0,DPR,0,0);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';drawObservatorySurface(ctx,W,H);ctx.save();ctx.globalAlpha=playback?.state().opacity??1;
 const ratio=Math.abs(camera.zoom/baseCamera.zoom-1)<2e-4?1:camera.zoom/baseCamera.zoom,snap=n=>Math.round(n*DPR)/DPR;ctx.translate(snap(W/2+(baseCamera.x-camera.x)*camera.zoom),snap(H/2+(baseCamera.y-camera.y)*camera.zoom));ctx.scale(ratio,ratio);ctx.translate(-W/2,-H/2);
 const fade=flightFadeAlpha(performance.now());environmentView?.drawWater(ctx,decorationTime,{moving:cameraMoving()});if(fade)drawGhostLayer(ghostBase);ctx.save();if(fade)ctx.globalAlpha*=fade.base;ctx.drawImage(base,0,0,base.width,base.height,0,0,W,H);ctx.restore();const detailOpacity=Math.max(0,Math.min(1,((contourView?.span||0)*camera.zoom-12)/80));ctx.save();ctx.globalAlpha*=detailOpacity;if(fade&&flightFade.defer>0){flightFade.defer--;drawGhostLayer(ghostForest)}else{if(fade){if(flightFade.forestStart===null)flightFade.forestStart=performance.now();drawGhostLayer(ghostForest);ctx.save();ctx.globalAlpha*=fade.forest}drawForest(ctx,performance.now());if(fade)ctx.restore()}const hoverResult=drawTreeHover(ctx,performance.now());drawSpecimenSparkles();drawArrivalClouds();ctx.restore();ctx.save();ctx.setTransform(DPR,0,0,DPR,0,0);specimenEnvironment.drawPaper(ctx,{width:W,height:H,dpr:DPR});ctx.restore();ctx.save();ctx.globalAlpha*=detailOpacity;ctx.drawImage(labelCanvas,0,0,labelCanvas.width,labelCanvas.height,0,0,W,H);drawProjectLabels();drawMoths(time);drawCommitPulses();drawSelection();ctx.restore();ctx.restore();setDataset(canvas,{terrainDetailOpacity:String(detailOpacity)});const tx=W/2+(baseCamera.x-camera.x)*camera.zoom-W/2*ratio,ty=H/2+(baseCamera.y-camera.y)*camera.zoom-H/2*ratio;for(const id of ['tree-targets','bird-targets']){const host=$(id);if(host){host.style.visibility=detailOpacity<.05?'hidden':'';host.style.transform=`translate(${tx}px,${ty}px) scale(${ratio})`;host.style.transformOrigin='0 0'}}dirty=hoverResult.active;fitVisibleGarden();const stamp=performance.now();if(!motion||diagnosticsDue('dynamic',stamp,true))setDataset($('world'),{motionDiagnostics:JSON.stringify({camera:{...camera},layoutMoving:layoutMotion.active,drift:driftEnabled,spotlight:spotlight?.phase||null,orbitActive:gardenOrbit.active,arrivalPhase:arrival?.phase||null,motion,decorationTime,roots:displayedTrees().slice(0,12).map(t=>({id:t.s.id,...point(t.x,t.y,treeElevation(t))}))})});
}
function drawSurveyAnnotations(){
 const outline=shownLayout().outline,geometry=contourView||islandContours(outline),now=performance.now();
 if(!surveyRectCache||(lastRebuildMoving&&now-surveyRectAt>RECT_MOVING_MS)||!lastRebuildMoving&&now-surveyRectAt>0){const rect=canvasRect();surveyRectAt=now;surveyRectCache=['spawn-cards','identity-label'].flatMap(id=>{const element=$(id);if(!element||element.hidden)return[];const r=element.getBoundingClientRect();return[{x:r.left-rect.left-8,y:r.top-rect.top-8,w:r.width+16,h:r.height+16}]})}
 const exclusions=surveyRectCache;
 labelArt.save();labelArt.setTransform(DPR,0,0,DPR,0,0);
 const survey=drawIslandSurvey(labelArt,geometry,outline,point,{width:W,height:H,exclusions,infinite:true});
 labelArt.restore();if(diagnosticsDue('survey',now,lastRebuildMoving))setDataset(canvas,{islandContours:JSON.stringify({rings:geometry.rings.length,depth:geometry.depth,infinite:true,...survey})});
}
function drawProjectLabels(){
 const shown=[],lot=hoverProject&&!hoverSession&&shownLayout().plots.find(p=>p.id===hoverProject);
 const project=lot&&projects[lot.p];
 if(project){
  const anchor=point(lot.centroid.x,lot.centroid.y,4+(lot.lift||0)+plotHills.height(lot,lot.centroid.x,lot.centroid.y));
  if(anchor.x>=0&&anchor.x<=W&&anchor.y>=0&&anchor.y<=H){
   ctx.save();ctx.setTransform(DPR,0,0,DPR,0,0);ctx.font='10px ui-monospace, SFMono-Regular, Consolas, monospace';ctx.textBaseline='middle';
   let title=String(project.name||'Unknown project');const maxWidth=Math.min(220,W-56);
   while(title.length>1&&ctx.measureText(title).width>maxWidth)title=title.slice(0,-2)+'…';
   const w=Math.max(100,ctx.measureText(title).width),right=anchor.x+40+w<W-18;
   const x=Math.max(18,Math.min(W-w-18,right?anchor.x+40:anchor.x-40-w)),y=Math.max(18,Math.min(H-90,anchor.y-32));
   ctx.fillStyle='#142333';ctx.fillRect(x-6,y-3,w+12,40);
   ctx.strokeStyle='#A7BFCD8C';ctx.lineWidth=.8;ctx.lineJoin='round';ctx.beginPath();ctx.moveTo(anchor.x,anchor.y);ctx.lineTo(anchor.x+(right?22:-22),y+16);ctx.lineTo(right?x+w:x,y+16);ctx.stroke();
   const direction=right?1:-1;
   ctx.beginPath();ctx.moveTo(anchor.x,anchor.y);ctx.lineTo(anchor.x+6*direction,anchor.y-7);ctx.lineTo(anchor.x+10*direction,anchor.y-2);ctx.closePath();ctx.strokeStyle='#A7BFCD';ctx.stroke();
   ctx.textAlign='left';ctx.fillStyle='#BACBD3';ctx.fillText(title,x,y+6);
   ctx.font='8px ui-monospace, SFMono-Regular, Consolas, monospace';ctx.fillStyle='#7F99AA';ctx.fillText('PROJECT LOT',x,y+28);
   ctx.restore();shown.push({id:lot.id});
  }
 }
 $('world').dataset.projectLabels=JSON.stringify({hoverOnly:true,shown});
}
// Painted inside drawDynamic's base-to-camera transform, so positions and scale must be in base-camera space.
function basePoint(x,y,z=0){const p=projectGround(x,y,baseCamera.yaw,z);return{x:W/2+(p.x-baseCamera.x)*baseCamera.zoom,y:H/2+(p.y-baseCamera.y)*baseCamera.zoom}}
function drawArrivalClouds(){
 let clouds=0,drops=0,segments=0;weatherRenderStats=new Map();
 ctx.save();ctx.setTransform(DPR,0,0,DPR,0,0);
 if(motion&&!motionPreference.matches)for(const item of cloudArrivals.entries()){
  const tree=renderedTrees.find(t=>t.s.id===item.id);if(!tree)continue;
  const root=basePoint(tree.x,tree.y,treeElevation(tree)),bounds=botanical.settledBounds(tree.s,root,baseCamera.zoom).bounds;
  const view=arrivalCloudView(root,bounds?.h,baseCamera.yaw);
  drawGardenArrivalLight(ctx,item.state,view);
  const stats=drawGardenArrivalCloud(ctx,item.cloud,item.state,view,{texture:cloudTexture,opacity:.85});
  weatherRenderStats.set(item.id,stats);
  if(stats.plates)clouds++;drops+=stats.drops;segments+=stats.segments;
 }
 ctx.restore();
 const phase=cloudArrivals.entries()[0]?.state.phase||'';
 if(canvas.dataset.arrivalPhase!==phase){canvas.dataset.arrivalPhase=phase;$('history-status').textContent=({Gather:'CLOUDS GATHERING',Rain:'RAINING ON NEW SESSIONS',Grow:'NEW SESSIONS GROWING',Disperse:'CLOUDS CLEARING'})[phase]||(day===maxDay?'LATEST IMPORTED STATE':'THROUGH END OF DAY · UTC')}
 canvas.dataset.arrivalClouds=String(clouds);canvas.dataset.rainDrops=String(drops);canvas.dataset.lightningSegments=String(segments);
}
function syncCommitPulses(animate){
 const next=new Set();for(const session of visibleSessions)for(const commit of session.commits){if(commit.day>day)continue;const key=session.projectId+'/'+commit.id;next.add(key);if(animate&&seenCommits&&!seenCommits.has(key)&&commitPulses.length<24)commitPulses.push({sessionId:session.id,commitId:commit.id,start:decorationTime})}
 if(!animate)commitPulses=[];seenCommits=next;
}
function drawCommitPulses(){
 commitPulses=commitPulses.filter(p=>decorationTime-p.start<850);
 for(const pulse of commitPulses){const s=sessions.find(s=>s.id===pulse.sessionId),origin=anchorsOnScreen.get(pulse.sessionId),node=s&&model(s).nodes.find(n=>n.id===pulse.commitId);if(!node||!origin||!detailSessions.includes(s))continue;
  const p=projectTree(node.p,{...origin,unitScale:baseCamera.zoom}),t=(decorationTime-pulse.start)/850;
  ctx.save();ctx.globalAlpha*=((1-t)*.72);ctx.strokeStyle=CORAL;ctx.lineWidth=1.2;ctx.beginPath();ctx.arc(p.x+2,p.y,3+10*t,0,Math.PI*2);ctx.stroke();ctx.restore();
 }
}
function selectionLabelBounds(){
 const labelSession=visibleSessions.find(s=>s.id===(hoverSession||pinnedMap||mapSession));
 const o=labelSession&&anchorsOnScreen.get(labelSession.id);
 const anchor=o?.bounds?{x:o.bounds.x+o.bounds.w/2,y:o.bounds.y+o.bounds.h*.42}:o;
 if(!anchor)return null;
 // Tree bounds use the cached camera. Labels and leaders use current CSS pixels.
 const ratio=camera.zoom/baseCamera.zoom,screenX=W/2+(anchor.x-W/2)*ratio+(baseCamera.x-camera.x)*camera.zoom,screenY=H/2+(anchor.y-H/2)*ratio+(baseCamera.y-camera.y)*camera.zoom;
 if(screenX<0||screenX>W||screenY<0||screenY>H)return null;
 const pinned=labelSession?.id===pinnedMap;
 const text=hoverSummary(labelSession).replace('Click to inspect',pinned?'Selected session · details in inspector':'Click to inspect');
 const cards=$('spawn-cards'),worldRect=$('world').getBoundingClientRect();
 const cardsRight=cards&&!cards.hidden?cards.getBoundingClientRect().right-worldRect.left:0;
 const stacked=cardsRight>0&&W-cardsRight-28<220;
 const x=cardsRight&&!stacked?cardsRight+12:16,y=16;
 const w=Math.min(340,W-x-16),identity=$('identity-label'),measureKey=text+'|'+w+'|'+H;
 if(identity&&measureKey!==labelMeasureKey){identity.hidden=false;identity.textContent=text;identity.style.width=w+'px';identity.style.height='auto';labelMeasuredHeight=Math.ceil(identity.getBoundingClientRect().height);labelMeasureKey=measureKey}
 const h=labelMeasuredHeight||110;
 // Keep the label outside the scrolling card column; only its leader moves.
 let end,elbow,leader;
 if(screenX>x+w+24){
  end={x:x+w,y:y+Math.min(h*.5,54)};elbow={x:end.x+24,y:end.y};
  leader=[{x:screenX,y:screenY},{x:elbow.x,y:screenY},elbow,end];
 }else{
  end={x:Math.max(x+18,Math.min(x+w-18,screenX)),y:y+h};
  leader=[{x:screenX,y:screenY},{x:screenX,y:end.y+20},{x:end.x,y:end.y+20},end];
 }

 return{text,x,y,w,h,stacked,session:labelSession?.id||null,leader};
}
function drawSelection(){
 const label=selectionLabelBounds(),identity=$('identity-label'),leader=$('identity-leader');
 const cards=$('spawn-cards');if(cards)cards.style.top=label?.stacked?(label.y+label.h+12)+'px':'';
 if(identity){identity.hidden=!label;identity.textContent=label?.text||'';if(label)identity.style.cssText='left:'+label.x+'px;top:'+label.y+'px;width:'+label.w+'px'}
 if(leader){
  leader.toggleAttribute('hidden',!label);
  if(label){const points=label.leader;leader.setAttribute('viewBox',`0 0 ${W} ${H}`);leader.querySelector('path').setAttribute('d',points.map((p,i)=>`${i?'L':'M'} ${p.x} ${p.y}`).join(' '));leader.querySelector('circle').setAttribute('cx',points[0].x);leader.querySelector('circle').setAttribute('cy',points[0].y)}
 }
 const labelEvidence=JSON.stringify(label);if($('world').dataset.selectionLabel!==labelEvidence)$('world').dataset.selectionLabel=labelEvidence;
 const o=selected&&anchorsOnScreen.get(selected.id);if(pinnedMap===selected?.id&&o?.bounds&&!treeGrowth.sample(selected.id,performance.now(),motion).active&&!cloudArrivals.entries().some(item=>item.id===selected.id&&item.state.crown<1)){
  const tree=renderedTrees.find(t=>t.s.id===selected.id);if(tree)paintHillTree(ctx,tree.clipBounds,tree.occluders,DPR,layer=>botanical.highlight(layer,selected,o,true));
 }

}

function resize(){invalidateRects();flightFade.active=false;const shouldResume=driftEnabled&&!ambientSuspended&&!hoverSession&&!hoverProject&&!mapSession&&!pinnedMap&&!scrubbing;displayScene=layoutMotion.settle();stopFlight('Flight stopped · the view changed.');const r=canvas.getBoundingClientRect();if(!r.width||!r.height)return;W=r.width;H=r.height;DPR=Math.min(2,devicePixelRatio||1);canvas.width=base.width=Math.round(W*DPR);canvas.height=base.height=Math.round(H*DPR);arc.width=Math.round(innerWidth*DPR);arc.height=Math.round(innerHeight*DPR);canvas.dataset.pixelRatio=String(DPR);if(typeof drawActivityStrip==='function')drawActivityStrip();if(camera.auto&&!hoverSession&&!hoverProject&&!mapSession&&!pinnedMap&&!scrubbing){setCameraForBounds(gardenLayout.bounds);fitScale=camera.zoom}rebuild();updateMap();drawArcs();if(shouldResume)resumeAmbientCamera()}
function pin(s,path=null,agentId=null){if(!s)return;stopFlight('Camera paused · inspecting a session.');playback?.pause();syncPlaybackControls();clearTimeout(leaveTimer);const rail=document.querySelector('.inspector-rail');if(rail)rail.hidden=false;const changed=selected?.id!==s.id;if(changed||path===null)selectedAgentId=agentId;selected=s;hoverSession=null;setTreeHover(null);hoverProject=null;hoverPath=null;pinnedMap=s.id;revealMap(s);pinnedPath=path&&files(s).includes(path)?path:(files(s).includes(pinnedPath)?pinnedPath:files(s)[0]||null);$('session-select')&&($('session-select').value=s.id);if(changed)rebuild();for(const b of document.querySelectorAll('.tree-target'))b.setAttribute('aria-pressed',String(b.dataset.session===s.id));updateCard();updateMap();drawArcs();dirty=true}
function updateDay({cause='playback'}={}){
 const previousDay=growthDay,previousCamera={...(arrival?.base||camera)},fitReference=arrival?.base||driftBase||camera,scrub=cause==='scrub',isScrubbing=scrubbing;
 if(scrub){stopFlight('Camera paused · scrubbing history.');displayScene=layoutMotion.settle();treeGrowth.settle();hoverSession=null;setTreeHover(null);hoverProject=null;hoverPath=null}
 prepareWorld();syncSpawnCards({reset:previousDay===null||scrub||day<previousDay,notify:previousDay!==null&&!scrub});cloudArrivals.sync(visibleSessions.map(s=>({id:s.id,projectId:s.projectId,priority:work(s)})),{animate:motion&&!motionPreference.matches&&growthDay!==null&&!scrub,reset:growthDay!==null&&day<growthDay});
 if(cloudArrivals.active&&!cloudTextureRequested){cloudTextureRequested=true;loadCloudPigment().then(result=>{cloudTexture=result.canvas;dirty=true;canvas.dataset.cloudPigment='ready'}).catch(()=>{canvas.dataset.cloudPigment='unavailable'})}
 const freshIds=visibleSessions.filter(s=>!treeGrowth.has(s.id)).map(s=>s.id);
 treeGrowth.sync(visibleSessions.map(s=>({id:s.id,score:work(s)})),performance.now(),{animate:motion&&!motionPreference.matches&&growthDay!==null&&!scrub,reset:growthDay!==null&&day<growthDay});growthDay=day;buildWorldScene();
 const animate=motion&&!motionPreference.matches&&!document.hidden&&previousDay!==null&&!scrub&&day>=previousDay;
 displayScene=layoutMotion.retarget(gardenLayout,treePlacements,performance.now(),{animate,reset:previousDay!==null&&day<previousDay});
 spawnHold.hold(animate?freshIds:[],layoutMotion.active);
 const fitSuspended=hoverSession||hoverProject||mapSession||pinnedMap;
 if(camera.auto&&!fitSuspended&&!gardenOrbit.active){
  const destination=destinationForBounds(gardenLayout.bounds,1.15,true);
  const changed=Math.hypot((destination.x-fitReference.x)*destination.zoom,(destination.y-fitReference.y)*destination.zoom)>.5||Math.abs(destination.zoom/fitReference.zoom-1)>.001;
  if(changed&&animate){driftBase=null;overviewFit={from:previousCamera,to:destination,fromFitScale:fitScale,toFitScale:destination.zoom,start:performance.now()}}
  else if(changed||!animate){overviewFit=null;fitScale=destination.zoom;Object.assign(camera,destination);scale=camera.zoom;if(arrival?.start)arrival.base={...camera}}
 }
 queueArrival(previousDay,performance.now());syncCommitPulses(animate);if(pinnedMap&&!visibleSessions.some(s=>s.id===pinnedMap))pinnedMap=null;if(mapSession&&!visibleSessions.some(s=>s.id===mapSession))mapSession=pinnedMap||selected?.id||null;if(!files(selected).includes(pinnedPath))pinnedPath=files(selected)[0]||null;
 rebuild();updateCard();renderProjectSelect();$('date').textContent=new Date(startTime+day*DAY).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'2-digit',timeZone:'UTC'});$('day-label').textContent=liveMode?'LIVE':'DAY '+(day+1)+' / '+(maxDay+1);$('history-status').textContent=liveMode?'CURRENT LOCAL ACTIVITY':day===maxDay?'LATEST IMPORTED STATE':'THROUGH END OF DAY · UTC';$('time').value=day;if(typeof syncPlaybackControls==='function')syncPlaybackControls();if(typeof drawActivityStrip==='function')drawActivityStrip();updateMap();drawArcs();if(scrub&&!isScrubbing)resumeAmbientCamera()
}

function clearTimeRange(){timeRange=null;timelineBrush.clear()}
const timelineBrush=createTimelineBrush({element:$('timeline-brush'),clearButton:$('clear-time-range'),summary:$('brush-summary'),maxDay:()=>maxDay,dateText,onChange:range=>{
 if(!playback)return;
 timeRange=range;leaveLive();pauseReplay();playback.seek(maxDay);day=maxDay;
 hoverSession=null;setTreeHover(null);hoverProject=null;hoverPath=null;
 updateDay({cause:'scrub'});
}});

function refreshActivityStrip(){dailyActivity=buildDailyProjectActivity(sourceData?.sessions||[],{startTime,dayMs:DAY,maxDay});drawActivityStrip()}
function drawActivityStrip(){
 const rect=activityCanvas.getBoundingClientRect(),width=rect.width,height=rect.height,ratio=Math.min(2,devicePixelRatio||1);
 activityCanvas.width=Math.max(1,Math.round(width*ratio));activityCanvas.height=Math.max(1,Math.round(height*ratio));activityCanvas.dataset.pixelRatio=String(ratio);
 activityArt.setTransform(ratio,0,0,ratio,0,0);activityArt.clearRect(0,0,width,height);if(!width||!height)return;
 const inset=Math.min(8,width/2),span=Math.max(0,width-inset*2),step=maxDay?span/maxDay:span,cellWidth=Math.max(1,Math.min(3,step-1));
 for(let index=0;index<dailyActivity.length;index++){const x=(maxDay?inset+index/maxDay*span:width/2)-cellWidth/2,layout=layoutActivityCells(dailyActivity[index].projectCount,height);activityArt.globalAlpha=index<=day&&(!timeRange||(index>=timeRange.start&&index<=timeRange.end))?1:.15;activityArt.fillStyle=INK;for(const cell of layout.rects)activityArt.fillRect(Math.round(x),cell.y,cellWidth,cell.height);if(layout.cap)activityArt.fillRect(Math.round(x),layout.cap.y,cellWidth,layout.cap.height)}
 timelineBrush.render();
 const playhead=maxDay?inset+day/maxDay*span:width/2;activityArt.globalAlpha=1;activityArt.fillStyle='#BFD5A5';activityArt.fillRect(Math.round(playhead)-1,0,2,height);
}

function specimenClipBounds(fit,origin,zoom){
 // Include the displaced painted pool, including translucent isolated draws.
 const pad=16*zoom+4,rx=fit.w*.6,ry=fit.w*.4;
 const x=Math.min(fit.x,origin.x-rx)-pad,y=Math.min(fit.y,origin.y-ry)-pad;
 return {x,y,w:Math.max(fit.x+fit.w,origin.x+rx)+pad-x,h:Math.max(fit.y+fit.h,origin.y+ry)+pad-y};
}
function selectDetailedTreeIds(rendered,{proxyView,zoomed,hoverSession,selectedId,focusedProject,cameraSubjectIds=new Set(),memory=null,now=0}){
 // Choose one LOD for the viewport, not the nearest arbitrary subset of trees.
 // With memory, each gate has a hysteresis band (tree height 56/72 CSS px, tree count 26/34) and a
 // 300 ms dwell, so one tree crossing the viewport edge cannot flip every tree at once.
 const heights=rendered.map(t=>t.screenHeight||0).sort((a,b)=>a-b),median=heights.length?heights[Math.floor(heights.length/2)]:0;
 let closeView=heights.length>0&&median>=64,few=!!zoomed&&rendered.length<30;
 if(memory){
  closeView=heights.length>0&&(memory.close?median>=56:median>=72);
  few=!!zoomed&&(memory.few?rendered.length<=34:rendered.length<26);
  memory.held=false;
  if((closeView!==memory.close||few!==memory.few)){
   if(now-memory.changedAt<300){closeView=memory.close;few=memory.few;memory.held=true}
   else memory.changedAt=now;
  }
  memory.close=closeView;memory.few=few;
 }
 if(!proxyView||closeView||few)return new Set(rendered.map(t=>t.s.id));
 return new Set(rendered.filter(t=>cameraSubjectIds.has(t.s.id)||t.s.id===hoverSession||t.s.id===selectedId||(focusedProject&&t.plotId===focusedProject)).map(t=>t.s.id));
}
function rebuild({cameraOnly=false}={}){
 const rebuildStart=performance.now();
 // Any camera step (pan, zoom, orbit yaw, flight) marks the scene as moving until it has rested for MOTION_SETTLE_MS.
 if(baseCamera.x!==camera.x||baseCamera.y!==camera.y||baseCamera.zoom!==camera.zoom||(baseCamera.yaw||0)!==(camera.yaw||0)){lastMotionAt=rebuildStart;
  if(!(orbitStepPending&&Math.abs(camera.zoom/baseCamera.zoom-1)<.004&&!cameraFrame&&!flight&&!tour&&!arrival&&!showcase&&!spawnShots.size&&!spinCoast&&!pointerGesture))lastSpecimenMotionAt=rebuildStart}
 orbitStepPending=false;
 const moving=cameraMoving(rebuildStart),diagnostics=diagnosticsDue('rebuild',rebuildStart,moving);lastRebuildMoving=moving;
 baseCamera={...camera};sceneRebuilds++;if(labelCanvas.width!==base.width||labelCanvas.height!==base.height){labelCanvas.width=base.width;labelCanvas.height=base.height}labelArt.setTransform(DPR,0,0,DPR,0,0);labelArt.clearRect(0,0,W,H);
 anchorsOnScreen.clear();hitBounds.clear();detailSessions=[];scale=camera.zoom;art.setTransform(DPR,0,0,DPR,0,0);art.clearRect(0,0,W,H);
 const layout=shownLayout(),plots=layout.plots;let drawnLots=0;
 // Terrain is requested for the layout's target outline, never the per-frame morph outline: the worker
 // rebuilds once per layout change and the previous terrain stays visible (then dissolves) meanwhile.
 const terrainGeometry=targetContours(gardenLayout.outline);
 contourView=layout.outline===gardenLayout.outline?terrainGeometry:islandContours(layout.outline);
 const terrain=terrainPreparation.request(terrainGeometry,{width:W,height:H,unproject:(x,y,z)=>unprojectGround((x-W/2)/scale+camera.x,(y-H/2)/scale+camera.y+z,camera.yaw)});
 const terrainFade=terrain?terrainPreparation.fade(rebuildStart):null;terrainFading=!!terrainFade;
 if(plots.length&&terrain){
  const style={width:W,height:H,theme:OBSERVATORY,waterHole:true};
  if(terrainFade)drawHillEnvironment(art,terrainFade.from,point,style);
  art.save();if(terrainFade)art.globalAlpha*=terrainFade.alpha;drawHillEnvironment(art,terrain,point,style);art.restore();
 }
 if(diagnostics)setDataset(canvas,{hillEnvironment:JSON.stringify({...terrain?.stats,...terrainPreparation.stats()})});
 if(plots.length){drawIslandContours(art,contourView,point);polygon(art,groundPolygon(layout.outline),OBSERVATORY.ground,OBSERVATORY.edge,.8)}
 drawSurveyAnnotations();
 const selectedProject=selected?.projectId;
 const hillBuildStart=performance.now();plotHillView=plotHills.view(plots,point,{yaw:camera.yaw,width:W,height:H,zoom:scale,selected:selectedProject,
  color:r=>OBSERVATORY.lots[Math.floor(random('plot-color/'+r.id)()*5)],
  opacity:r=>{const project=projects[r.p],match=projectFilter?project.id===projectFilter:project.allPrimary.some(s=>matchingIds.has(s.id));return ((projectFilter||searchFilter)&&!match?.65:1)*(r.opacity??1)}});
 plotHillView.draw(art);const shownTrees=displayedTrees();plotHillView.drawRoots(art,shownTrees,scale);
 environmentView=specimenEnvironment.prepare({layout,contourGeometry:contourView,terrain,plotHillView,project:point,camera,width:W,height:H,dpr:DPR,moving});environmentView.drawStatic(art,{moving});
 if(diagnostics)setDataset(canvas,{plotHills:JSON.stringify({...PLOT_HILL_SETTINGS,plots:plots.length,faces:plotHillView.faces.length,buildMs:performance.now()-hillBuildStart,maxHeight:Math.max(0,...plots.map(p=>plotHills.hill(p).peak))})});
 for(const r of plots){const project=projects[r.p],corners=groundPolygon(r.polygon,1+(r.lift||0)),xs=corners.map(p=>p.x),ys=corners.map(p=>p.y),left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);if(right<0||left>W||bottom<0||top>H)continue;drawnLots++;
 const filtered=!!(projectFilter||searchFilter),match=projectFilter?project.id===projectFilter:project.allPrimary.some(s=>matchingIds.has(s.id));art.save();art.globalAlpha=(filtered&&!match?.65:1)*(r.opacity??1);
 const count=project.unknown.filter(c=>c.day<=day).length;
 if(count){
  const anchor=frontAnchor(r.planting.polygon,.36),p=point(anchor.x,anchor.y,3),size=Math.max(1.2,Math.min(3.5,scale*5));
  for(let i=0;i<Math.min(scale>.25?7:3,count);i++){
   const q={x:anchor.x-(i%4)*8,y:anchor.y-Math.floor(i/4)*8};
   if(!pointInPolygon(q,r.planting.polygon))continue;
   const pos=point(q.x,q.y,3+(r.lift||0)+plotHills.height(r,q.x,q.y)),x=pos.x,y=pos.y;
   polygon(art,[{x,y:y-size},{x:x+size,y},{x,y:y+size},{x:x-size,y}],'#d8945d','#805d4a',.4);
  }
 }
 art.restore();
 }
 const viewport=viewRect(),focus={x:viewport.x+viewport.w/2,y:viewport.y+viewport.h/2},rendered=[];for(const t of shownTrees){const p=point(t.x,t.y,treeElevation(t));anchorsOnScreen.set(t.s.id,{...p,modelX:t.x,modelY:t.y,embedding:{vertical:1,spread:1,lean:0,phase:0}});const measured=botanical.settledBounds(t.s,p,scale),bounds=measured.bounds;if(bounds.x+bounds.w<0||bounds.x>W||bounds.y+bounds.h<0||bounds.y>H)continue;rendered.push({...t,screen:p,screenHeight:measured.actualHeight,distance:Math.hypot(p.x-focus.x,p.y-focus.y)})}
 const move=activeCameraMove(),cameraSubjectIds=new Set(move?.subjectIds||[]),zoomRatio=scale/Math.max(.01,fitScale),zoomed=lodMemory.zoomed=lodMemory.zoomed?zoomRatio>1.02:zoomRatio>1.06,detailed=selectDetailedTreeIds(rendered,{proxyView,zoomed,hoverSession,selectedId:selected?.id,focusedProject,cameraSubjectIds,memory:lodMemory,now:rebuildStart});
 for(const t of rendered)t.depthKey=hillDepth(t.x,t.y,camera.yaw);
 renderedTrees=rendered.sort((a,b)=>a.depthKey-b.depthKey).map(t=>{
 const fit=detailed.has(t.s.id)?botanical.settledBounds(t.s,t.screen,scale).bounds:botanical.symbolBounds(t.s,t.screen,scale).bounds,clipBounds=specimenClipBounds(fit,t.screen,scale);
 const height=t.screenHeight,margin=height*.7+10,sparkleBounds={x:t.screen.x-margin,y:t.screen.y-height*.58-margin,w:margin*2,h:margin*2};
 return {...t,detailed:detailed.has(t.s.id),clipBounds,occluders:plotHillView.occluders(t,clipBounds),sparkleBounds,sparkleOccluders:null};
 });
 prepareSpecimenRasters(move);
 detailSessions=renderedTrees.filter(t=>t.detailed).map(t=>t.s);targetsDirty=true;metadataDirty=metadataDirty||!cameraOnly;
 setDataset(canvas,{treeCount:String(visibleSessions.length),playheadDay:String(day),visibleCommitCount:String(visibleSessions.reduce((n,s)=>n+s.commits.filter(c=>c.day<=day).length,0)),unknownProjectCommits:String(plots.reduce((n,r)=>n+projects[r.p].unknown.filter(c=>c.day<=day).length,0))});
 setDataset($('world'),{proxyView:String(proxyView),visibleSessionCount:String(rendered.length),renderedDetailCount:String(detailSessions.length),renderedSymbolCount:String(rendered.length-detailSessions.length),drawnPlotCount:String(drawnLots),camera:JSON.stringify({x:camera.x,y:camera.y,zoom:camera.zoom,yaw:camera.yaw,auto:camera.auto}),cameraMode:camera.auto?'overview':'focused',fitScale:String(fitScale),botanicalCacheBytes:String(botanical.stats().bytes),botanicalCacheLimit:String(botanical.stats().limit),botanicalCacheHits:String(botanical.stats().hits),botanicalCacheMisses:String(botanical.stats().misses),printMaterialCache:JSON.stringify(materials.cacheStats())});setText($('world-counts'),plots.length+' PROJECT LOTS / '+visibleSessions.length+' SESSION TREES');setText($('zoom-label'),camera.auto?'Fit':Math.round(scale/Math.max(.0001,fitScale)*100)+'%');$('data-loading').hidden=!loading&&!loadError&&!!plots.length;dirty=true;lastRebuildMs=performance.now()-rebuildStart;maxRebuildMs=Math.max(maxRebuildMs,lastRebuildMs);
}
function bindCamera(){
 canvas.dataset.treeSize=String(treeSize);canvas.dataset.treeYScale=String(treeYScale);
 const world=$('world');world.addEventListener('wheel',event=>{if(event.target.closest('.camera-tools,.session-card,.file-map'))return;event.preventDefault();const rect=canvas.getBoundingClientRect();zoomCamera(Math.exp(-Math.max(-150,Math.min(150,event.deltaY))*.0025),event.clientX-rect.left,event.clientY-rect.top)},{passive:false});
 canvas.addEventListener('pointerleave',()=>{setTreeHover(null);if(hoverProject)leave()});world.addEventListener('pointerleave',()=>setTreeHover(null));
 world.addEventListener('pointermove',event=>{if(pointerGesture)return;const treeId=event.target.closest?.('.tree-target')?.dataset.session,terrainTarget=event.target===canvas||(treeId&&terrainHidesTree(event,treeId)),lot=terrainTarget?pickHillAtPointer(event)?.plot:null,next=lot?.id||null;if(terrainTarget)setTreeHover(null);if(next===hoverProject)return;hoverProject=next;if(next){stopAmbientCamera();hoverSession=null;setTreeHover(null);hoverPath=null}else if(!pinnedMap&&!mapSession&&!scrubbing)resumeAmbientCamera();updateCard();updateMap();drawArcs();dirty=true},true);
 world.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest('.camera-tools,.world-title'))return;const now=performance.now(),spin=!event.shiftKey;pointerGesture={id:event.pointerId,mode:spin?'spin':'pan',orbitEnabled:driftEnabled,startX:event.clientX,startY:event.clientY,lastX:event.clientX,lastMotionAt:now,velocity:0,x:camera.x,y:camera.y,moved:false};clearTimeout(leaveTimer)},true);
 world.addEventListener('pointermove',event=>{if(!pointerGesture||event.pointerId!==pointerGesture.id)return;const dx=event.clientX-pointerGesture.startX,dy=event.clientY-pointerGesture.startY,threshold=pointerGesture.mode==='spin'?Math.abs(dx):Math.hypot(dx,dy);if(!pointerGesture.moved&&threshold>5){const orbitEnabled=pointerGesture.orbitEnabled;stopFlight();driftEnabled=orbitEnabled;ambientSuspended=!orbitEnabled;spinCoast=false;pointerGesture.moved=true;droneFlying=false;lastCameraInputAt=performance.now();world.setPointerCapture(event.pointerId);world.classList.add('is-panning');hoverSession=null;setTreeHover(null);hoverProject=null;hoverPath=null;updateCard()}if(!pointerGesture.moved)return;if(pointerGesture.mode==='pan'){camera.auto=false;camera.x=pointerGesture.x-dx/scale;camera.y=pointerGesture.y-dy/scale}else{const now=performance.now(),step=event.clientX-pointerGesture.lastX;if(step){const seconds=Math.max(.008,(now-pointerGesture.lastMotionAt)/1000),delta=step*.006,instant=Math.max(-3,Math.min(3,delta/seconds));pointerGesture.velocity=pointerGesture.velocity*.45+instant*.55;Object.assign(camera,gardenOrbit.spin(camera,delta,pointerGesture.velocity));pointerGesture.lastX=event.clientX;pointerGesture.lastMotionAt=now;driftBase??={...camera};orbitLastTime=now}}requestCameraDraw()},true);
 function finish(event){if(!pointerGesture||event.pointerId!==pointerGesture.id)return;const gesture=pointerGesture,now=performance.now();if(gesture.moved){lastCameraInputAt=now;droneAfter=now+DRONE_INPUT_HOLD_MS;droneFlying=false;suppressClickUntil=now+500;dismissUntil=suppressClickUntil;driftEnabled=gesture.orbitEnabled;ambientSuspended=!gesture.orbitEnabled;if(gesture.mode==='spin'){const velocity=motion&&!motionPreference.matches?releaseSpinVelocity(gesture.velocity,now-gesture.lastMotionAt):0;gardenOrbit.rebase(camera,{angularVelocity:velocity});spinCoast=!gesture.orbitEnabled&&Math.abs(velocity)>1e-4;camera.auto=true}else{camera.auto=false;ambientSuspended=true;driftBase=null;spinCoast=false}}if(world.hasPointerCapture(event.pointerId))world.releasePointerCapture(event.pointerId);pointerGesture=null;world.classList.remove('is-panning');syncMotionControls()}
 world.addEventListener('pointerup',finish,true);world.addEventListener('pointercancel',finish,true);world.addEventListener('click',event=>{if(performance.now()<suppressClickUntil){event.preventDefault();event.stopImmediatePropagation()}},true);
 world.addEventListener('click',event=>{if(event.target!==canvas||event.target.closest('.camera-tools'))return;const lot=pickHillAtPointer(event)?.plot;if(lot)focusProject(lot.id)});
 $('zoom-in')?.addEventListener('click',()=>zoomCamera(1.4));$('zoom-out')?.addEventListener('click',()=>zoomCamera(1/1.4));$('fit-garden')?.addEventListener('click',()=>{resumeAmbientCamera();fitGarden()});$('focus-selected')?.addEventListener('click',focusSelected);$('tour-garden')?.addEventListener('click',toggleTour);
 $('drift')?.addEventListener('click',()=>{const enable=driftEnabled&&ambientSuspended||!driftEnabled;driftUserOff=!enable;droneAfter=performance.now()+DRONE_INPUT_HOLD_MS;if(!enable)cancelCameraMove();stopFlight();spinCoast=false;driftEnabled=enable;ambientSuspended=!enable;driftBase=null;if(enable){pinnedMap=null;hoverSession=null;setTreeHover(null);camera.auto=true;if(gardenOrbit.active)gardenOrbit.rebase(camera)}syncMotionControls();dirty=true});
 $('spotlight')?.addEventListener('click',spotlightSelected);
}

 const endScrub=()=>{if(scrubbing){scrubbing=false;if(day===maxDay&&dataSource.mode==='local')enterLive();else resumeAmbientCamera()}};$('time').addEventListener('input',e=>{if(!playback)return;clearTimeRange();if(!scrubbing){scrubbing=true;stopAmbientCamera()}leaveLive();playback.seek(Number(e.target.value));day=playback.state().day;updateDay({cause:'scrub'})});$('time').addEventListener('pointerdown',()=>{scrubbing=true;stopAmbientCamera()});$('time').addEventListener('pointerup',endScrub);$('time').addEventListener('pointercancel',endScrub);$('time').addEventListener('change',endScrub);$('time').addEventListener('keydown',()=>{if(!scrubbing){scrubbing=true;stopAmbientCamera()}});$('time').addEventListener('keyup',endScrub);$('time').addEventListener('blur',endScrub);document.addEventListener('pointerup',endScrub,true);document.addEventListener('pointercancel',endScrub,true);
$('play').addEventListener('click',playHistory);
$('playback-speed')?.addEventListener('click',()=>{if(!playback)return;const current=playback.getSpeed(),next=GARDEN_PLAYBACK_SPEEDS[(GARDEN_PLAYBACK_SPEEDS.indexOf(current)+1)%GARDEN_PLAYBACK_SPEEDS.length];playback.setSpeed(next);lastAnimationTime=performance.now();syncPlaybackControls()});
$('latest')?.addEventListener('click',enterLive);
$('older-messages')?.addEventListener('click',()=>{if(messagesPager.available)messagesPager.older()});
$('session-conversation')?.addEventListener('click',()=>pin(selected));
$('refresh-data').addEventListener('click',()=>{stopFlight('Flight stopped · loading data.');refreshData()});
$('inspector-toggle').addEventListener('click',()=>{
 const rail=document.querySelector('.inspector-rail'),collapsed=rail.dataset.collapsed!=='true';
 rail.dataset.collapsed=String(collapsed);$('inspector-toggle').setAttribute('aria-expanded',String(!collapsed));
 $('inspector-toggle').setAttribute('aria-label',collapsed?'Expand session details':'Collapse session details');
 $('inspector-toggle').textContent=collapsed?'‹':'›';
 orbitFrameCache=null;mapKey='';resize();updateMap();drawArcs();
});
$('spawn-cards-toggle').addEventListener('click',()=>{orbitFrameCache=null;dirty=true});
document.querySelector('.inspector-rail').addEventListener('scroll',drawArcs,{passive:true});document.querySelector('.inspector-rail').addEventListener('pointerenter',()=>clearTimeout(leaveTimer));$('open-map').addEventListener('click',()=>pin(sessions.find(s=>s.id===mapSession)||selected));$('map-close').addEventListener('click',dismiss);
$('map-pin').addEventListener('click',()=>{const s=sessions.find(s=>s.id===mapSession);if(!s)return;if(pinnedMap===s.id){pinnedMap=null;updateMap();drawArcs()}else pin(s,hoverPath)});
$('map-file-select').addEventListener('change',e=>{const s=sessions.find(s=>s.id===mapSession);if(s&&e.target.value)pin(s,e.target.value)});
$('file-map').addEventListener('pointerenter',()=>clearTimeout(leaveTimer));$('file-map').addEventListener('pointerleave',scheduleLeave);$('file-map').addEventListener('focusin',()=>clearTimeout(leaveTimer));$('file-map').addEventListener('focusout',e=>{if(!$('file-map').contains(e.relatedTarget))scheduleLeave()});$('file-map').addEventListener('scroll',drawArcs,{passive:true});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){stopFlight();dismiss()}});document.addEventListener('visibilitychange',()=>{if(document.hidden){lastAnimationTime=0;displayScene=layoutMotion.settle();treeGrowth.settle();commitPulses=[];stopFlight('Camera paused · tab hidden.');rebuild();dirty=true}else{advanceLiveClock();lastAnimationTime=0;resumeAmbientCamera()}});motionPreference.addEventListener('change',e=>{if(e.matches)setMotion(false);else syncTour()});
window.addEventListener('resize',()=>{mapKey='';resize();updateMap()});if(window.ResizeObserver){const rail=document.querySelector('.inspector-rail');if(rail)new ResizeObserver(()=>{const rect=canvas.getBoundingClientRect();if(rect.width!==W||rect.height!==H){mapKey='';resize();updateMap()}}).observe(rail)}window.addEventListener('scroll',()=>{invalidateRects();if(mapSession){positionMap(sessions.find(s=>s.id===mapSession));drawArcs()}},{passive:true});
let lastAnimationTime=0,dynamicFrames=0,lastRebuildMs=0,maxRebuildMs=0,lastDrawMs=0;
const frameTimings=[];
function queueArrival(previousDay, now){
 const animate=previousDay!==null&&day>=previousDay&&motion&&!motionPreference.matches&&!document.hidden&&camera.auto&&driftEnabled&&!ambientSuspended&&!scrubbing&&!pinnedMap&&!mapSession&&!hoverSession&&!hoverProject&&!flight&&!tour;
 spawnShots.sync(visibleSessions.map(s=>s.id),{animate,reset:previousDay!==null&&day<previousDay});
 if(spawnShots.size)lastArrivalAt=now
}
function frame(t){if(!document.hidden&&(cameraFrame||t-lastFrame>=1000/60-1)){const frameStarted=performance.now(),elapsed=lastAnimationTime?t-lastAnimationTime:0,lastDelta=Math.min(100,elapsed),weatherDelta=Math.min(250,elapsed),replaySpeed=playback?.getSpeed?.()||1,playing=!!playback?.state().playing&&!scrubbing;lastAnimationTime=t;const arrivalHolding=cloudArrivals.active||!!arrival||spawnShots.size>0;if(motion&&playing){robotTime+=lastDelta;if(arrival)arrival.elapsed+=weatherDelta*replaySpeed}if(motion&&showcase)showcase.elapsed+=lastDelta;cloudArrivals.advance(weatherDelta,{playing:(liveMode||playing)&&!(liveMode&&(layoutMotion.active||flight?.liveArrival)),hidden:document.hidden,reducedMotion:motionPreference.matches||!motion,speed:replaySpeed});if(playback&&elapsed>0&&!scrubbing&&!arrivalHolding){const before=playback.state();const after=playback.advance(elapsed,{hidden:false,reducedMotion:motionPreference.matches||!motion});if(!liveMode&&document.body?.dataset.gardenMode!=='hosted'&&(maxDay===0||after.day===maxDay&&after.day>before.day)){enterLive();dirty=true}else if(after.day!==before.day||after.phase!==before.phase){const previousDay=day;day=after.day;updateDay({cause:after.phase==='traversal'&&after.day===0?'loop':'playback'});dirty=true}}if(motion&&!motionPreference.matches)decorationTime+=lastDelta;const rebuildsBeforeCamera=sceneRebuilds;advanceCamera(t);advanceVisualScene(t);if(cameraFrame){cameraFrame=0;if(sceneRebuilds===rebuildsBeforeCamera)rebuild({cameraOnly:true});updateMap();drawArcs()}settleScene(t,sceneRebuilds!==rebuildsBeforeCamera);if(motion||dirty||flight){const drawStart=performance.now();drawDynamic(decorationTime);lastDrawMs=performance.now()-drawStart;dynamicFrames++;frameTimings.push({work:performance.now()-frameStarted,gap:elapsed});if(frameTimings.length>90)frameTimings.shift();if(dynamicFrames%30===0||!motion){const work=frameTimings.map(f=>f.work).sort((a,b)=>a-b),gaps=frameTimings.map(f=>f.gap).filter(g=>g>0&&g<1000);canvas.dataset.performance=JSON.stringify({dynamicFrames,sceneRebuilds,lastRebuildMs,maxRebuildMs,lastDrawMs,decorationTime,frameP50Ms:work[Math.floor(work.length*.5)],frameP95Ms:work[Math.min(work.length-1,Math.floor(work.length*.95))],drawsPerSecond:gaps.length?1000*gaps.length/gaps.reduce((n,g)=>n+g,0):0})}}lastFrame=t}requestAnimationFrame(frame)}
window.canvasGarden={observatory:()=>({flock:flock.state(),trails:boidTrails,tags:[],theme:'observatory'}),seed:SEED,renderer:'Canvas2D',terrain:()=>({...PLOT_HILL_SETTINGS,plots:shownLayout().plots.length}),showcaseTree,geometry:()=>({outline:gardenLayout.outline.map(p=>({...p})),bounds:{...gardenLayout.bounds},area:gardenLayout.area,diagnostics:gardenLayout.fitting||null,plots:gardenLayout.plots.map(p=>({id:p.id,polygon:p.polygon.map(v=>({...v})),centroid:{...p.centroid},area:p.area,targetArea:p.targetArea,labelAnchor:{...p.labelAnchor},planting:{bounds:{...p.planting.bounds},edgeInset:p.planting.edgeInset,minSpacing:p.planting.minSpacing,targetSpacing:p.planting.targetSpacing,relaxed:p.planting.relaxed},trees:p.planting.points.map(v=>({...v}))}))}),state:()=>{const playbackState=playback?.state()||{day,playing:false,phase:'traversal',opacity:1};return{day,timeRange:timeRange&&{...timeRange},treeSize,treeYScale,playing:playbackState.playing,phase:playbackState.phase,opacity:playbackState.opacity,selected:selected?.id||null,mapSession,pinnedMap,pinnedPath,motion,layoutMoving:layoutMotion.active,ambientCamera:driftEnabled&&!ambientSuspended,ambientSuspended,hoveredIdentity:hoverSession||null,hoveredTreeId:hoverTreeId,hoveredProject:hoverProject||null,hoverSession,inspectedSessionId:pinnedMap||mapSession||null,focusedProject:focusedProject||null,scrubbing,commitPulses:commitPulses.length,displayedRoots:displayedTrees().map(t=>({id:t.s.id,x:t.x,y:t.y,lift:t.lift||0,elevation:treeElevation(t),screen:point(t.x,t.y,treeElevation(t))})),source:dataSource.mode,camera:{...camera},fitScale,autoFit:overviewFit?{from:{...overviewFit.from},to:{...overviewFit.to},fromFitScale:overviewFit.fromFitScale,toFitScale:overviewFit.toFitScale,start:overviewFit.start}:null,visible:visibleSessions.length,total:sessions.length,tour:{active:!!tour,index:tour?.index??null,count:tour?.plots.length??0,project:tour?tour.plots[tour.index]?.id:null,status:tourMessage},flight:!!flight,reducedMotion:motionPreference.matches,decorationTime,performance:{dynamicFrames,sceneRebuilds,lastRebuildMs,maxRebuildMs,lastDrawMs,botanical:botanical.stats(),specimen:botanical.stats(),environment:specimenEnvironment.stats(),terrain:terrainPreparation.stats(),specimenVisualGeneration,evidenceGeneration}}},counts:()=>({imported:allSessions.length,primary:sessions.length,projects:projects.length,trees:visibleSessions.length,commits:sourceData?.commits?.length||0})};
const gardenState=window.canvasGarden.state;
Object.assign(window.canvasGarden,{setMotion,setTrails,setProxyView,refreshData:()=>{stopFlight('Flight stopped · loading data.');return refreshData()}});
window.canvasGarden.state=()=>({...gardenState(),liveMode,liveRevision:liveState.snapshot().revision,selectedAgentId,arrivalWeather:cloudArrivals.entries().map(({id,projectId,cloud,state})=>({id,projectId,seed:cloud.seed,plates:weatherRenderStats.get(id)?.plates||0,phase:state.phase,elapsed:state.elapsed})),cameraMotion:{arrivalPhase:arrival?.phase||null,arrivalPending:spawnShots.size>0,arrivalSessionId:arrival?.anchorId||null,arrivalSubjectIds:arrival?.subjectIds||[],showcasePhase:showcase?.phase||null,showcaseSessionId:showcase?.anchorId||null,queuedSpawns:spawnShots.size,renderCamera:{...baseCamera},shotElapsed:arrival?.elapsed||showcase?.elapsed||0,yaw:camera.yaw,angularVelocity:gardenOrbit.angularVelocity,idleDelayMs:Math.max(0,idleAfter-performance.now()),idleActive:!!driftBase&&!!driftEnabled&&!ambientSuspended,cloudFit:{active:fitFollower.active,ids:[...(cloudFitIds||[])]},drone:{ready:drone.ready,flying:droneFlying,s:drone.s,pathLength:drone.path?.length||0,pathBuildMs:dronePathMs,waitMs:Math.max(0,droneAfter-performance.now())},orbitActive:gardenOrbit.active,orbitPeriodMs:GARDEN_ORBIT_MS}});
document.body.dataset.gardenMotion=motion?'on':'off';bindCamera();resize();syncTour();syncMotionControls();requestAnimationFrame(frame);upload.start();setInterval(()=>{if(dataSource.mode!=='local')return;advanceLiveClock();if(liveMode&&selectedAgentId&&liveState.agent(selectedAgentId))renderAgentDetails()},1000);
})();
