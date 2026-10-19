const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const folder = 'web/';
const dataURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const themeURL = dataURL(fs.readFileSync(folder + 'observatory-theme.js', 'utf8'));
const painterURL = dataURL(fs.readFileSync(folder + 'specimen-tree-painter.js', 'utf8').replace("'./observatory-theme.js'", JSON.stringify(themeURL)));
async function modules() {
  const source = fs.readFileSync(folder + 'garden-specimen-renderer.js', 'utf8')
    .replace("'./observatory-theme.js'", JSON.stringify(themeURL))
    .replace("'./specimen-tree-painter.js'", JSON.stringify(painterURL))
    .replace("import './specimen-environment.js';", '');
  return { ...await import(dataURL(source)), ...await import(painterURL) };
}
function canvasFactory(log = []) {
  return (width, height) => {
    const canvas = { width, height }, stack = [];
    const ctx = { canvas, globalAlpha: 1, globalCompositeOperation: 'source-over',
      save() { stack.push({ globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation }); },
      restore() { Object.assign(this, stack.pop()); },
      drawImage(...args) { log.push({ kind: 'image', alpha: this.globalAlpha, composite: this.globalCompositeOperation, smoothing: this.imageSmoothingEnabled, quality: this.imageSmoothingQuality, args }); },
      scale(x, y) { log.push({ kind: 'scale', x, y }); },
      fill() { log.push({ kind: 'fill', composite: this.globalCompositeOperation, alpha: this.globalAlpha }); },
      stroke() { log.push({ kind: 'stroke', composite: this.globalCompositeOperation, alpha: this.globalAlpha }); },
      createRadialGradient() { return { addColorStop() {} }; },
    };
    for (const method of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'bezierCurveTo', 'ellipse', 'arc', 'translate', 'rotate', 'rect', 'clip', 'clearRect', 'fillRect', 'setTransform']) ctx[method] = () => {};
    canvas.getContext = () => ctx;
    return canvas;
  };
}
function cohort(n = 794) {
  const species = ['build', 'conversation', 'orchestration', 'slow-burn', 'quick'];
  return Array.from({ length: n }, (_, i) => ({ id: `session-${i}`, species: species[i % 5], sizeClass: Math.floor(i / 5) % 5,
    density: ['sparse', 'medium', 'dense'][Math.floor(i / 25) % 3], fruit: i % 6, visualKey: `visual-${i % 150}` }));
}
async function setup(records = cohort(25), ratio = 1) {
  const api = await modules(), encodings = new Map(records.map(r => [r.id, r])), allocations = [], rasterLog = [];
  const factory = canvasFactory(rasterLog);
  const renderer = api.createGardenSpecimenRenderer({ encoding: id => encodings.get(id), scale: () => 1, dpr: () => ratio,
    treeSize: () => 2.8, createCanvas: (w, h) => { allocations.push([w, h]); return factory(w, h); },
    shadow: (ctx, x, y, radius) => { ctx.beginPath(); ctx.ellipse(x, y, radius, radius / 2, 0, 0, Math.PI * 2); ctx.fill(); } });
  return { ...api, renderer, allocations, encodings, records, rasterLog };
}


test('motion blocks all vector work and upgrades; settled fades use injected time', async () => {
  const {renderer,records}=await setup(cohort(2));
  const origin={x:300,y:500,renderScale:1};
  renderer.prepare(records,{zoom:.05});
  renderer.beginFrame(records,{zoom:1,moving:true,now:0});
  const before=renderer.stats();
  renderer.prepare(records,{zoom:1,moving:true});
  const log=[],ctx=canvasFactory(log)(800,600).getContext('2d');
  renderer.tree(ctx,records[0],origin);
  renderer.drawSpecimenVector(ctx,records[0],origin,{force:true});
  assert.equal(renderer.stats().vectorDraws,before.vectorDraws);
  assert.equal(renderer.stats().proceduralRepaints,before.proceduralRepaints);
  assert.ok(renderer.stats().pendingRasters>0);
  const amounts=[];
  for(const now of [100,175,250]) {
    renderer.beginFrame(records,{zoom:1,now}); log.length=0;
    renderer.tree(ctx,records[0],origin);
    amounts.push(log.filter(c=>c.kind==='image').at(-1).alpha);
    assert.equal(renderer.stats().vectorFading,now<250);
  }
  assert.equal(amounts[0],0); assert.ok(amounts[1]>0);
  assert.ok(Math.abs(amounts[1]*2-amounts[2])<1e-12);
});

test('one demand update keeps old pixels pending and repaints one shape', async () => {
  const {renderer,records}=await setup(cohort(3));
  const visible=records.map(s=>({s,rasterZoom:.1}));
  renderer.prepare(visible); const before=renderer.stats();
  const log=[],ctx=canvasFactory(log)(800,600).getContext('2d');
  const draw=()=>{log.length=0;renderer.tree(ctx,records[0],{x:100,y:100,renderScale:.1});return log.find(c=>c.kind==='image').args[0];};
  const old=draw(); visible[0].rasterZoom=.3;
  renderer.prepare(visible,{budgetMs:0});
  assert.equal(renderer.stats().pendingRasters,1); assert.equal(draw(),old);
  assert.equal(renderer.stats().proceduralRepaints,before.proceduralRepaints);
  renderer.pump(Infinity);
  assert.equal(renderer.stats().pendingRasters,0);
  assert.equal(renderer.stats().proceduralRepaints,before.proceduralRepaints+1);
  assert.notEqual(draw(),old);
});

test('crossing thirty records preserves sticky equal-size vector membership', async () => {
  const records=Array.from({length:31},(_,i)=>({id:`tree-${i}`,species:'build',sizeClass:2,density:'medium',fruit:0}));
  const {renderer}=await setup(records);
  renderer.prepare(records,{zoom:.03});
  const first=[...renderer.beginFrame(records.slice(1,30),{zoom:1,now:0})].sort();
  const next=[...renderer.beginFrame(records,{zoom:1,now:150})].sort();
  assert.equal(first.length,12);assert.deepEqual(next,first);
  const leave=renderer.beginFrame(records,{zoom:.0001,now:300});assert.equal(leave.size,0);
});

test('hover cache ignores array identity and ratio jitter; released surfaces are pooled', async () => {
  const {renderer,records,allocations}=await setup(cohort(3),2);
  const trees=records.map((s,i)=>({s,screen:{x:100+i*300,y:200,renderScale:.1}}));
  renderer.prepare(trees,{zoom:.1,dpr:2});renderer.setHovered(records[0].id,0);
  const ctx=canvasFactory()(1600,1000).getContext('2d');let samples=0;
  const options={now:120,zoom:.1,dpr:2,generation:1,viewport:{x:0,y:0,w:800,h:500},growthFor:()=>{samples++;return null;}};
  renderer.drawHover(ctx,trees,options);const builds=renderer.stats().hoverBuilds;
  samples=0;renderer.drawHover(ctx,trees.map(t=>({...t})),{...options,dpr:2.001});
  assert.equal(renderer.stats().hoverBuilds,builds);assert.ok(samples<=3);
  renderer.drawHover(ctx,trees,{...options,generation:2});
  const count=allocations.length;
  renderer.drawHover(ctx,trees,{...options,generation:3});
  assert.equal(allocations.length,count);assert.ok(renderer.stats().hoverPoolHits>0);
});

test('scratch storage does not resize per tree and geometry survives deselection', async () => {
  const {createGardenSpecimenRenderer}=await modules();let writes=0;
  const factory=canvasFactory();
  const renderer=createGardenSpecimenRenderer({createCanvas:(w,h)=>{
    const c=factory(w,h);let width=w,height=h;
    Object.defineProperties(c,{width:{get:()=>width,set:v=>{writes++;width=v;}},height:{get:()=>height,set:v=>{writes++;height=v;}}});return c;
  }});
  const records=cohort(30),ctx=factory(1200,800).getContext('2d');
  const frame=items=>{renderer.beginFrame(items,{zoom:.2,viewport:{x:0,y:0,w:1200,h:800}});for(const s of items)renderer.drawSpecimenVector(ctx,s,{x:500,y:600,renderScale:.2},{force:true});};
  frame(records.slice(0,12));const first=renderer.stats().vectorRepaints;
  frame([]);frame(records.slice(0,12));assert.equal(renderer.stats().vectorRepaints,first);
  frame(records.slice(12));assert.equal(renderer.stats().vectorGeometryEntries,24);
  assert.equal(writes,0);assert.equal(renderer.stats().scratchBytes,1200*800*4);
});

test('native paths replay once per command and keep fill and stroke semantics', async () => {
  const {paintSpecimenLayer}=await modules();const original=global.Path2D;
  let operations=0,paths=0;const fills=[],strokes=[];
  global.Path2D=class {constructor(){paths++;}moveTo(){operations++;}lineTo(){operations++;}closePath(){operations++;}};
  const make=kind=>({kind,composite:'source-over',alpha:.5,color:'#123',lineWidth:2,path:{commands:[['moveTo',0,0],['lineTo',1,1],['closePath']]}});
  const geometry={layers:{trunk:[make('fill'),make('stroke')]}};
  const ctx={globalAlpha:1,save(){},restore(){},fill:p=>fills.push(p),stroke:p=>strokes.push(p)};
  try {paintSpecimenLayer(ctx,geometry,'trunk');paintSpecimenLayer(ctx,geometry,'trunk');
    assert.equal(paths,2);assert.equal(operations,6);assert.equal(fills[0],fills[1]);assert.equal(strokes[0],strokes[1]);
  } finally {global.Path2D=original;}
});

test('new hover after growth completion fades from zero', async () => {
  const {renderer,records}=await setup(cohort(1));const trees=[{s:records[0],screen:{x:100,y:200}}];
  renderer.prepare(records,{zoom:.1});renderer.setHovered(records[0].id,0);
  const log=[],ctx=canvasFactory(log)(800,600).getContext('2d'),options={zoom:.1,dpr:1};
  renderer.drawHover(ctx,trees,{...options,now:120,growthFor:()=>({active:true,crown:.5})});
  const start=renderer.drawHover(ctx,trees,{...options,now:200});
  assert.equal(start.active,true);assert.deepEqual(start.drawnIds,[]);
  renderer.drawHover(ctx,trees,{...options,now:260});assert.equal(log.at(-1).alpha,.5);
  renderer.drawHover(ctx,trees,{...options,now:320});assert.equal(log.at(-1).alpha,1);
});

test('prepare moving state also blocks pump until settled', async () => {
  const {renderer,records}=await setup(cohort(1));renderer.prepare(records,{zoom:.01});
  const count=renderer.stats().proceduralRepaints;
  renderer.prepare(records,{zoom:1,moving:true});renderer.pump(Infinity);
  assert.equal(renderer.stats().proceduralRepaints,count);
  renderer.prepare(records,{zoom:1,moving:false,budgetMs:Infinity});
  assert.equal(renderer.stats().pendingRasters,0);assert.equal(renderer.stats().proceduralRepaints,count+1);
});

test('atlas buckets have a fifteen-percent entry band and never shrink while retained', async () => {
  const {renderer,records}=await setup(cohort(1));const s=records[0];
  const base=renderer.settledBounds(s,{x:0,y:0},1).actualHeight;
  renderer.prepare(records,{zoom:32/base});const count=renderer.stats().proceduralRepaints;
  renderer.prepare(records,{zoom:36.7/base});assert.equal(renderer.stats().proceduralRepaints,count);
  renderer.prepare(records,{zoom:37/base});assert.equal(renderer.stats().proceduralRepaints,count+1);
  renderer.prepare(records,{zoom:4/base});assert.equal(renderer.stats().proceduralRepaints,count+1);
});

test('sticky vector membership admits a newcomer only beyond one size class', async () => {
  const records=Array.from({length:13},(_,i)=>({id:`member-${i}`,species:'build',sizeClass:1,density:'medium'}));
  const {renderer,encodings}=await setup(records);
  renderer.prepare(records,{zoom:.01});const before=renderer.beginFrame(records.slice(0,12),{zoom:1});
  const newcomer=records[12];const current=renderer.beginFrame(records,{zoom:1});
  assert.deepEqual([...current].sort(),[...before].sort());
  encodings.set(newcomer.id,{...newcomer,species:'orchestration',sizeClass:4});
  const enlarged=renderer.beginFrame(records,{zoom:1});assert.equal(enlarged.size,12);assert.ok(enlarged.has(newcomer.id));
});
