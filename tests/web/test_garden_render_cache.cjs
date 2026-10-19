const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('web/canvas-garden.js', 'utf8');
const motionHelpers=()=>{const a=source.indexOf('const MOTION_SETTLE_MS'),b=source.indexOf('\n',source.indexOf('function invalidateRects'));return source.slice(a,b).replace(/^let /m,'var ').replace(/^const lodMemory/m,'var lodMemory')};
const motionDefaults=()=>({cloudFitIds:null,flight:null,spotlight:null,overviewFit:null,layoutMotion:{active:false},pointerGesture:null,canvas:{dataset:{},getBoundingClientRect:()=>({})}});
const start = source.indexOf('function drawForest('), end = source.indexOf('\nfunction drawDynamic(', start);
function harness() {
  let paints = 0, active = false;
  const art = { globalAlpha: 1, save() {}, restore() {}, setTransform() {}, clearRect() {}, drawImage() {} };
  const trees = Array.from({length: 800}, (_, i) => ({s:{id:'tree-'+i},screen:{x:i,y:200},detailed:false}));
  const context = vm.createContext({...motionDefaults(),performance,scale:1,baseCamera:{zoom:.1},motion:true,motionPreference:{matches:false},
    renderedTrees:trees, treeGrowth:{sample:()=>({active,crown:1,trunk:1,branches:1})},cloudArrivals:{entries:()=>[]},
    hitBounds:new Map(),anchorsOnScreen:new Map(),activeCameraMove:()=>null,projectFilter:'',searchFilter:'',matchingIds:new Set(),
    paintHillTree:(c,b,m,d,draw)=>{paints++;draw(c);},botanical:{beginFrame(){},usesVector:()=>false,shadow(){},stats:()=>({})},drawSymbol(){},drawTree(){},
    boundsChanged:()=>false,targetsDirty:false,canvas:{dataset:{}},$:()=>({dataset:{}}),DPR:2,W:1280,H:800,
    forestCanvas:{width:2560,height:1600},forestArt:art,forestCache:null,specimenVisualGeneration:0,day:200,treeSize:2.8,treeYScale:1,
    targetButtons:new Map(),flight:null,tour:null,metadataDirty:false,updateTargets(){},updateTargetGeometry(){},drawArcs(){}});
  vm.runInContext(motionHelpers(),context);vm.runInContext(source.slice(start,end),context);
  return {context,draw:()=>context.drawForest(art,100),paints:()=>paints,setActive:v=>{active=v;}};
}
test('settled forest reuses its drawing while birds animate',()=>{
  const h=harness();h.draw();assert.equal(h.paints(),800);h.draw();
  assert.equal(h.paints(),800,'second unchanged frame must not repaint 800 trees and terrain masks');
});
test('forest redraws for growth, new geometry, filter, and day changes',()=>{
  const h=harness();h.draw();h.setActive(true);h.draw();assert.equal(h.paints(),1600);
  h.setActive(false);h.draw();assert.equal(h.paints(),2400);
  h.context.renderedTrees=h.context.renderedTrees.slice();h.draw();assert.equal(h.paints(),3200);
  h.context.searchFilter='search';h.draw();assert.equal(h.paints(),4000);
  h.context.day--;h.draw();assert.equal(h.paints(),4800);
});

test('depth-sorted forest masks directly without a scratch-canvas transfer per tree',()=>{
  let transfers=0,erases=0,draws=0;
  const art={globalAlpha:1,save(){},restore(){},setTransform(){},clearRect(){},fill(){erases++;},drawImage(){transfers++;}};
  const context=vm.createContext({Path2D:class{moveTo(){}lineTo(){}closePath(){}}});
  vm.runInContext(fs.readFileSync('web/garden-plot-hills.js','utf8').replace(/export /g,''),context);
  const paint=context.createHillTreePainter(()=>({width:0,height:0,getContext:()=>art}));
  const mask=[[{x:0,y:10},{x:20,y:10},{x:20,y:20},{x:0,y:20}]];
  for(let i=0;i<800;i++)paint(art,{x:0,y:0,w:20,h:20},mask,2,()=>{draws++;},true);
  assert.equal(draws,800);assert.equal(erases,800);
  assert.equal(transfers,0,'sorted forest layers must not copy a mutable canvas for each tree');
  paint(art,{x:0,y:0,w:20,h:20},mask,2,()=>{},false);
  assert.equal(transfers,1,'highlights on the composed scene still need an isolated scratch surface');
});


test('direct forest masking matches isolated compositing for overlapping depth-sorted trees',()=>{
  class Path { constructor(){this.polygons=[];} moveTo(x,y){this.polygons.push([{x,y}]);} lineTo(x,y){this.polygons.at(-1).push({x,y});} closePath(){} }
  const inside=(x,y,p)=>{let hit=false;for(let i=0,j=p.length-1;i<p.length;j=i++)if((p[i].y>y)!==(p[j].y>y)&&x<(p[j].x-p[i].x)*(y-p[i].y)/(p[j].y-p[i].y)+p[i].x)hit=!hit;return hit;};
  function surface(){
    let width=40,height=40,pixels=new Float64Array(1600),state={alpha:1,mode:'source-over',sx:1,sy:1,x:0,y:0};const stack=[];
    const image={get width(){return width;},set width(v){width=v;pixels=new Float64Array(width*height);},get height(){return height;},set height(v){height=v;pixels=new Float64Array(width*height);},get pixels(){return pixels;},getContext:()=>ctx};
    const apply=(i,a)=>{pixels[i]=state.mode==='destination-out'?pixels[i]*(1-a):a+pixels[i]*(1-a);};
    const ctx={get globalAlpha(){return state.alpha;},set globalAlpha(v){state.alpha=v;},get globalCompositeOperation(){return state.mode;},set globalCompositeOperation(v){state.mode=v;},
      save(){stack.push({...state});},restore(){state=stack.pop();},setTransform(sx,b,c,sy,x,y){state={...state,sx,sy,x,y};},
      clearRect(){pixels.fill(0);},fillRect(x,y,w,h){for(let py=0;py<height;py++)for(let px=0;px<width;px++){const vx=(px+.5-state.x)/state.sx,vy=(py+.5-state.y)/state.sy;if(vx>=x&&vx<x+w&&vy>=y&&vy<y+h)apply(py*width+px,state.alpha);}},
      fill(path){for(let py=0;py<height;py++)for(let px=0;px<width;px++)if(path.polygons.some(p=>inside((px+.5-state.x)/state.sx,(py+.5-state.y)/state.sy,p)))apply(py*width+px,state.alpha);},
      drawImage(source,sx,sy,sw,sh,dx,dy,dw,dh){for(let py=0;py<height;py++)for(let px=0;px<width;px++){const x=(px+.5-state.x)/state.sx,y=(py+.5-state.y)/state.sy;if(x<dx||x>=dx+dw||y<dy||y>=dy+dh)continue;const ix=Math.floor(sx+(x-dx)/dw*sw),iy=Math.floor(sy+(y-dy)/dh*sh);apply(py*width+px,(source.pixels[iy*source.width+ix]||0)*state.alpha);}}};
    return image;
  }
  const context=vm.createContext({Path2D:Path});
  vm.runInContext(fs.readFileSync('web/garden-plot-hills.js','utf8').replace(/export /g,''),context);
  const rect=(x,y,w,h)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
  function render(sorted){const image=surface(),paint=context.createHillTreePainter(surface),ctx=image.getContext();
    for(let depth=0;depth<3;depth++){
      const box={x:4+depth*5,y:3+depth*2,w:20,h:30};
      const masks=[rect(0,14+depth*5,40,26-depth*5)];
      paint(ctx,box,masks,1,c=>{c.save();c.globalAlpha=.7;c.fillRect(box.x,box.y,20,30);c.fillRect(box.x+5,box.y+3,8,15);c.restore();},sorted);
    }return image.pixels;
  }
  const direct=render(true),isolated=render(false);
  assert.ok(direct.every((alpha,i)=>Math.abs(alpha-isolated[i])<1e-12));
});


test('specimen visual changes invalidate forest pixels; status and decoration clocks retain them',()=>{
 const h=harness();h.draw();
 h.context.decorationTime=1000;h.context.liveRevision=10;h.draw();assert.equal(h.paints(),800);
 h.context.specimenVisualGeneration++;h.draw();assert.equal(h.paints(),1600);
 h.draw();assert.equal(h.paints(),1600);
});


test('flight refresh bounds forest enlargement even before the 200 ms timer',()=>{
  const begin=source.indexOf('function advanceCamera('), end=source.indexOf('\nfunction shownLayout',begin);
  let rebuilds=0;
  const c=vm.createContext({flight:{from:{},to:{},start:0,duration:1000,lift:0},camera:{zoom:.1},baseCamera:{zoom:.1},lastSceneTime:0,tour:null,
    snapshotLayers(){},sampleFlight:()=>({zoom:.125}),rebuild(){rebuilds++;c.baseCamera={...c.camera};},dirty:false});
  vm.runInContext(source.slice(begin,end),c);c.advanceCamera(30);
  assert.equal(rebuilds,1);assert.ok(c.camera.zoom/c.baseCamera.zoom<=1.1);
  c.sampleFlight=()=>({zoom:.13});c.advanceCamera(60);assert.equal(rebuilds,1);
  assert.ok(c.camera.zoom/c.baseCamera.zoom<=1.1);
});

test('translucent close hill masks transfer at native DPR above 2048 pixels',()=>{
  const transfers=[], transforms=[];
  const scratch={globalAlpha:1,save(){},restore(){},setTransform(...args){transforms.push(args);},clearRect(){},fill(){}};
  const target={globalAlpha:.4,drawImage(...args){transfers.push(args);}};
  const context=vm.createContext({Path2D:class{moveTo(){}lineTo(){}closePath(){}}});
  vm.runInContext(fs.readFileSync('web/garden-plot-hills.js','utf8').replace(/export /g,''),context);
  const paint=context.createHillTreePainter(()=>({width:0,height:0,getContext:()=>scratch}));
  const masks=[[{x:0,y:0},{x:30,y:0},{x:30,y:30}]];
  paint(target,{x:0,y:0,w:1400,h:2600},masks,2,()=>{},true,{nativeResolution:true});
  const [,sx,sy,sw,sh,dx,dy,dw,dh]=transfers[0];
  assert.ok(dw*2/sw<=1.1);assert.ok(dh*2/sh<=1.1);
  assert.equal(transforms.at(-1)[0],2);assert.equal(target.globalAlpha,.4);
  assert.equal(target.imageSmoothingEnabled,true);assert.equal(target.imageSmoothingQuality,'high');
});


test('hover identity and easing never invalidate the settled forest',()=>{
 const h=harness();h.draw();
 for(const id of ['tree-1','tree-2',null]){h.context.hoverSession=id;h.context.hoverTreeId=id;h.context.hoverOpacity=.5;h.draw();}
 assert.equal(h.paints(),800);
});
test('automatic orbit keeps the camera busy but does not hide sharp specimens',()=>{
  const c=vm.createContext({...motionDefaults(),performance});vm.runInContext(motionHelpers(),c);
  c.lastMotionAt=1000;c.lastSpecimenMotionAt=-Infinity;
  assert.equal(c.cameraMoving(1050),true);assert.equal(c.specimenMoving(1050),false,'orbit-only yaw creep leaves vectors and the raster pump running');
  c.lastSpecimenMotionAt=1000;assert.equal(c.specimenMoving(1050),true,'flights, drags and zoom still count');
  assert.equal(c.specimenMoving(1000+c.MOTION_SETTLE_MS+1),false,'vectors return one settle window after true motion');
  c.pointerGesture={moved:true};assert.equal(c.specimenMoving(5000),true);
  assert.match(source,/orbitStepPending&&Math\.abs\(camera\.zoom\/baseCamera\.zoom-1\)<\.004&&!cameraFrame&&!flight/,'rebuild classifies orbit-only steps');
});
