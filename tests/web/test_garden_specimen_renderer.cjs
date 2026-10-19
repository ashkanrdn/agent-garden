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

test('all species, sizes and densities have allocation-free root/aspect parity and uniform 2.8 scale', async () => {
  const { renderer, records, allocations, specimenHeight } = await setup(cohort(75));
  for (const record of records) {
    const origin = { x: 51, y: 93 }, full = renderer.settledBounds(record, origin, 1), small = renderer.symbolBounds(record, origin, 1);
    assert.equal(full.actualHeight, specimenHeight(record.species, record.sizeClass) * 2.8);
    assert.equal(full.x, origin.x); assert.equal(full.y, origin.y);
    for (const key of ['x', 'y', 'w', 'h']) assert.equal(full.bounds[key], small.bounds[key]);
    const double = renderer.settledBounds(record, origin, 2);
    assert.equal(double.bounds.w, full.bounds.w * 2); assert.equal(double.actualHeight, full.actualHeight * 2);
    assert.equal(full.family, record.species); assert.equal(full.visualKey, record.visualKey);
  }
  assert.equal(allocations.length, 0);
});

test('growth separates wood and crown, scales uniformly, keeps settled bounds, and preserves caller alpha', async () => {
  const { renderer, records, allocations } = await setup(cohort(1));
  renderer.prepare(records, { zoom: 1, rasterZoom: 2, fullDetail: true });
  const log = [], ctx = canvasFactory(log)(100, 100).getContext('2d'); ctx.globalAlpha = .3;
  const origin = { x: 10, y: 20, rasterZoom: 2 }, record = records[0];
  const settled = renderer.settledBounds(record, origin, 1);
  // Growing trees are native vector up to the focus cap; saturate it so this tree exercises the atlas growth layers.
  const scratch = canvasFactory()(10, 10).getContext('2d');
  for (let i = 0; i < 8; i++) renderer.tree(scratch, { id: `focus-${i}`, species: 'build', sizeClass: 0, density: 'medium', fruit: 0, visualKey: `f${i}` }, origin, { trunk: .5, branches: .2, crown: 0, size: 1, active: true }, true);
  const atlasAllocations = allocations.length;
  renderer.tree(ctx, record, origin, { trunk: 0, branches: 0, crown: 0, size: 1, active: true }, true);
  assert.equal(log.filter(c => c.kind === 'image').length, 0);
  renderer.tree(ctx, record, origin, { trunk: .6, branches: .3, crown: 0, size: .8, active: true }, true);
  assert.equal(log.filter(c => c.kind === 'image').length, 2);
  const before = allocations.length; assert.equal(before, atlasAllocations + 1, 'wood/crown layers build one lazy growth page');
  assert.ok(renderer.stats().growthBytes > 0 && renderer.stats().growthBytes <= 4 * 1024 * 1024);
  assert.ok(log.filter(c => c.kind === 'scale').every(c => c.x === c.y));
  assert.ok(log.filter(c => c.kind === 'image').every(c => c.alpha <= .3));
  log.length = 0;
  assert.deepEqual(renderer.tree(ctx, record, origin, { trunk: 1, branches: 1, crown: 1, size: 1 }, true).bounds, settled.bounds);
  renderer.symbol(ctx, record, origin, 1, { trunk: 1, branches: 1, crown: 1 });
  assert.equal(ctx.globalAlpha, .3); assert.equal(allocations.length, before);
  assert.equal(renderer.stats().unpreparedDraws, 0);
});

for (const ratio of [1, 2]) test(`794 trees at DPR ${ratio} keep all detail, stay below 32 MiB, and do not churn through yaw`, async () => {
  const { renderer, records, allocations } = await setup(cohort(), ratio);
  renderer.prepare(records, { zoom: 2, rasterZoom: 3, dpr: ratio, fullDetail: true });
  const before = renderer.stats(), count = allocations.length;
  assert.ok(before.bytes <= 32 * 1024 * 1024); assert.equal(before.preparedRecords, 794);
  const ctx = canvasFactory()(10, 10).getContext('2d');
  for (let yaw = 0; yaw < 18; yaw++) {
    renderer.prepare(records.map(r => ({ s: r, screen: { x: yaw * 10, y: yaw, rasterZoom: 3 }, detailed: true })), { zoom: 2, dpr: ratio, yaw });
    for (const record of records) {
      renderer.tree(ctx, record, { x: yaw, y: yaw, rasterZoom: 3 }, null, true);
      renderer.symbol(ctx, record, { x: yaw, y: yaw, rasterZoom: 3 }, 2, null);
    }
  }
  for (let i = 0; i < 4; i++) renderer.highlight(ctx, records[i], { x: 20, y: 50 }, i % 2 === 0);
  const after = renderer.stats();
  assert.ok(after.bytes <= after.limit);
  assert.ok(after.highlightBytes > 0);
  assert.equal(after.proceduralRepaints, before.proceduralRepaints);
  assert.equal(after.misses, before.misses); assert.equal(allocations.length, count + 4);
  assert.equal(after.unpreparedDraws, 0); assert.equal(after.detailDraws, 794 * 18);
  assert.equal(after.proxyDraws, 794 * 18);
  console.log(JSON.stringify({ dpr: ratio, bytes: after.bytes, scratchBytes: after.scratchBytes, pages: after.pages, rasterFactor: after.rasterFactor, geometryEntries: after.geometryEntries, highlightBytes: after.highlightBytes, detailDraws: after.detailDraws, proxyDraws: after.proxyDraws, rasterAllocations: after.rasterAllocations, layerRepaints: after.layerRepaints, proceduralRepaints: after.proceduralRepaints, warmMisses: after.misses - before.misses }));
});

test('fruit updates share geometry, capped attachments, highlights and shadows retain alpha and root', async () => {
  const { renderer, records, encodings } = await setup(cohort(1));
  renderer.prepare(records, { zoom: 1 });
  const before = renderer.stats(), record = records[0];
  encodings.set(record.id, { ...record, fruit: 99, visualKey: 'fruit-five' });
  renderer.prepare(records, { zoom: 1 });
  assert.equal(renderer.stats().proceduralRepaints, before.proceduralRepaints);
  const log = [], ctx = canvasFactory(log)(1, 1).getContext('2d'); ctx.globalAlpha = .25;
  const origin = { x: 120, y: 240 };
  renderer.tree(ctx, record, origin, null, true);
  assert.equal(log.filter(c => c.kind === 'image').length, 6);
  const h = renderer.highlight(ctx, record, origin, true), bounds = renderer.settledBounds(record, origin, 1).bounds;
  assert.equal(h.x, origin.x); assert.equal(h.y, origin.y);
  assert.ok(h.bounds.x <= bounds.x && h.bounds.y <= bounds.y);
  renderer.shadow(ctx, record, origin, null);
  assert.equal(ctx.globalAlpha, .25);
  assert.ok(log.filter(c => c.alpha !== undefined).every(c => c.alpha <= .25));
  assert.ok(renderer.stats().bytes <= 32 * 1024 * 1024);
  renderer.clear(); assert.equal(renderer.stats().bytes, 0);
});

test('camera subsets and metadata changes retain warm pages; raster and theme transitions rebuild once', async () => {
  const { renderer, records, encodings } = await setup(cohort(75));
  renderer.prepare(records, { zoom: .3, dpr: 1 });
  const before = renderer.stats();
  for (const part of [records.slice(0, 30), [], records.slice(30), records.slice().reverse()]) {
    renderer.prepare(part, { zoom: .3, dpr: 1, day: 44, yaw: 1.9, time: 300 });
  }
  for (const record of records) encodings.set(record.id, { ...record, metrics: { tools: 99 }, subagents: ['child'] });
  renderer.prepare(records, { zoom: .3, dpr: 1 });
  assert.equal(renderer.stats().rasterAllocations, before.rasterAllocations);
  assert.equal(renderer.stats().proceduralRepaints, before.proceduralRepaints);
  renderer.prepare(records, { zoom: .3, dpr: 2, themeVersion: 'v2' });
  const changed = renderer.stats();
  assert.ok(changed.proceduralRepaints > before.proceduralRepaints);
  renderer.prepare(records, { zoom: .3, dpr: 2, themeVersion: 'v2' });
  assert.equal(renderer.stats().proceduralRepaints, changed.proceduralRepaints);
  assert.ok(changed.bytes <= changed.limit);
});

test('a newly visible shape stays cached across repeated alternating views', async () => {
  const { renderer, records } = await setup(cohort(75));
  renderer.prepare(records.slice(0, 30), { zoom: 1 });
  renderer.prepare(records.slice(30), { zoom: 1 });
  const before = renderer.stats();
  for (let i = 0; i < 8; i++) renderer.prepare(i % 2 ? records.slice(30) : records.slice(0, 30), { zoom: 1 });
  assert.equal(renderer.stats().proceduralRepaints, before.proceduralRepaints);
  assert.equal(renderer.stats().rasterAllocations, before.rasterAllocations);
});

for (const dpr of [1, 2]) for (const zoom of [1.25, 3]) test(`native close trees DPR ${dpr} zoom ${zoom}: sharp, same bounds/root, isolated holes`, async () => {
  const { renderer, records } = await setup(cohort(), dpr);
  renderer.prepare(records, { zoom, dpr });
  const chosen = [records[10], records[22]], origin = { x: 640, y: 760, renderScale: zoom };
  const before = chosen.map(record => {
    const log = [], ctx = canvasFactory(log)(1280*dpr,800*dpr).getContext('2d');
    renderer.tree(ctx,record,origin,null,true);
    const transfer = log.find(c=>c.kind==='image').args;
    return {id:record.id,atlasUpscale:transfer[8]*dpr/transfer[4]};
  });
  renderer.beginFrame(chosen.map(s => ({ s, screen: origin, detailed: true })), { zoom, dpr, viewport: { x: 0, y: 0, w: 1280, h: 800 } });
  const log = [], ctx = canvasFactory(log)(1280*dpr, 800*dpr).getContext('2d'); ctx.globalAlpha = .37;
  for (const record of chosen) {
    const expected = renderer.settledBounds(record, origin, zoom);
    const actual = renderer.tree(ctx, record, origin, null, true);
    assert.deepEqual(actual.bounds, expected.bounds); assert.equal(actual.x, origin.x); assert.equal(actual.y, origin.y);
    assert.equal(actual.renderPath, 'vector');
    assert.ok(actual.upscale <= 1.1, `actual native transfer upscale ${actual.upscale}`);
    const transfer = log.filter(c => c.kind === 'image').at(-1).args;
    assert.ok(transfer[7]*dpr/transfer[3] <= 1.1);
    assert.ok(transfer[8]*dpr/transfer[4] <= 1.1);
  }
  console.log(JSON.stringify({zoom,dpr,before,vectorUpscale:renderer.stats().frameMaxUpscale}));
  assert.equal(ctx.globalAlpha, .37);
  assert.ok(log.every(c => c.composite !== 'destination-out'), 'holes cannot erase the background');
  assert.ok(log.filter(c => c.kind === 'image').every(c => c.smoothing && c.quality === 'high'));
  const stats = renderer.stats(); assert.equal(stats.frameVectorDraws, 2); assert.ok(stats.scratchBytes <= 1280*800*dpr*dpr*4);
});

test('vector frame budget picks largest trees, preserves detail, and rejects repeat draws beyond cap', async () => {
  const { renderer, records } = await setup(cohort(80), 2);
  renderer.prepare(records, { zoom: 3, dpr: 2 });
  const visible = records.map(s => ({ s, screen: { x: 300, y: 800, renderScale: 3 }, detailed: true }));
  renderer.beginFrame(visible, { zoom: 3, dpr: 2 });
  const expected = visible.slice().sort((a,b) => renderer.settledBounds(b.s,b.screen,3).actualHeight-renderer.settledBounds(a.s,a.screen,3).actualHeight || a.s.id.localeCompare(b.s.id)).slice(0,renderer.stats().vectorLimit).map(t=>t.s.id).sort();
  const ctx = canvasFactory()(1280,800).getContext('2d'), selected = [];
  for (const t of visible) if (renderer.tree(ctx,t.s,t.screen,null,true).renderPath === 'vector') selected.push(t.s.id);
  assert.deepEqual(selected.sort(),expected);
  assert.equal(renderer.stats().frameVectorDraws,renderer.stats().vectorLimit);
  for (const t of visible) renderer.tree(ctx,t.s,t.screen,null,true);
  assert.equal(renderer.stats().frameVectorDraws,renderer.stats().vectorLimit);
  assert.equal(renderer.stats().proxyDraws,0);
  renderer.beginFrame(visible.slice().reverse(),{zoom:3,dpr:2});
  assert.equal(renderer.stats().frameVectorDraws,0);
});


test('vector and raster bounds match for every species, class and density through growth', async () => {
  const {renderer,records,rasterLog}=await setup(cohort(75),2);
  renderer.prepare(records,{zoom:1.25,dpr:2});
  const ctx=canvasFactory()(1280,800).getContext('2d');ctx.globalAlpha=.31;
  for(const record of records){
    const origin={x:100,y:300,renderScale:1.25};
    renderer.beginFrame([{s:record,screen:origin,detailed:true}],{zoom:1.25,dpr:2});
    const native=renderer.tree(ctx,record,origin,{trunk:.8,branches:.5,crown:.6,size:.9},true);
    renderer.beginFrame([],{zoom:1.25,dpr:2});
    const raster=renderer.tree(ctx,record,origin,{trunk:.8,branches:.5,crown:.6,size:.9},true);
    assert.deepEqual(native.bounds,raster.bounds);assert.equal(native.x,raster.x);assert.equal(native.y,raster.y);
    assert.equal(ctx.globalAlpha,.31);
  }
  assert.ok(rasterLog.some(c=>c.composite==='destination-out'),'fixture exercises actual crown holes');
});


test('warm native frames reuse geometry and one scratch canvas when atlas resolution is insufficient', async () => {
  const {renderer,records,allocations}=await setup(cohort(2),2);
  const zoom=.1,visible=records.map(s=>({s,screen:{x:100,y:150,renderScale:zoom},detailed:true}));
  renderer.prepare(visible,{zoom:zoom/4,rasterZoom:zoom/4,dpr:2});
  const ctx=canvasFactory()(1280,800).getContext('2d');
  const frame=()=>{renderer.beginFrame(visible,{zoom,dpr:2});for(const t of visible)assert.equal(renderer.tree(ctx,t.s,t.screen,null,true).renderPath,'vector');};
  frame();const before=renderer.stats(),count=allocations.length;
  frame();frame();assert.equal(renderer.stats().vectorRepaints,before.vectorRepaints);
  assert.equal(renderer.stats().proceduralRepaints,before.proceduralRepaints);
  assert.equal(allocations.length,count,'reuse the same canvas object across native trees');
  renderer.clear();assert.equal(renderer.stats().scratchBytes,0);
});


test('hover renderer eases in and out over 120 ms and preserves interrupted opacity', async () => {
  const { renderer, records } = await setup(cohort(2));
  renderer.setHovered(records[0].id, 0);
  assert.equal(renderer.hoverState(0).opacity, 0);
  assert.equal(renderer.hoverState(60).opacity, .5);
  assert.equal(renderer.hoverState(120).opacity, 1);
  assert.equal(renderer.hoverState(120).active, false);
  renderer.setHovered(null, 120);
  assert.equal(renderer.hoverState(180).opacity, .5);
  renderer.setHovered(records[0].id, 180);
  assert.equal(renderer.hoverState(180).opacity, .5);
  assert.equal(renderer.hoverState(300).opacity, 1);
  renderer.setHovered(null, 300);
  assert.equal(renderer.hoverState(420).id, null);
  assert.equal(renderer.hoverState(420).active, false);
  assert.equal(renderer.hoverState(420).neighborOpacity, 1);
});


test('hover draws only its native silhouette, keeps proxy neighbours unchanged, and reuses the overlay during easing', async () => {
  const { renderer, records, rasterLog } = await setup(cohort(3), 2);
  const trees = records.map((s,i)=>({s,screen:{x:100+i*300,y:200,renderScale:.1},detailed:false,occluders:[]}));
  renderer.prepare(trees,{zoom:.1,dpr:2});
  const log=[], ctx=canvasFactory(log)(1600,1000).getContext('2d');ctx.globalAlpha=.4;
  const options={zoom:.1,dpr:2,viewport:{x:0,y:0,w:800,h:500},generation:0};
  renderer.setHovered(records[1].id,0);
  const result=renderer.drawHover(ctx,trees,{...options,now:60});
  assert.deepEqual(result.drawnIds,[records[1].id]);
  assert.equal(result.neighborOpacity,1);assert.equal(result.upscale,1);
  assert.equal(result.nativeIds[0],records[1].id);
  const before=rasterLog.length;
  renderer.drawHover(ctx,trees,{...options,now:90});
  assert.equal(rasterLog.length,before,'easing composites cached native pixels without repainting geometry');
  assert.equal(ctx.globalAlpha,.4);
  renderer.setHovered(null,90);
  assert.deepEqual(renderer.drawHover(ctx,trees,{...options,now:210}).drawnIds,[]);
});


test('silhouette coverage removes translucent interior from the rim', async () => {
  const { paintSpecimenLayer } = await modules();
  let alpha=0;
  const ctx={globalAlpha:1,save(){},restore(){},beginPath(){},fill(){alpha=this.globalCompositeOperation==='destination-out'?alpha*(1-this.globalAlpha):this.globalAlpha+alpha*(1-this.globalAlpha);}};
  const geometry={layers:{crown:[{kind:'fill',path:{commands:[]},alpha:.66,composite:'source-over',color:'#fff',lineWidth:1}]}};
  paintSpecimenLayer(ctx,geometry,'crown',{opaqueCoverage:true});
  assert.equal(alpha,1,'silhouette coverage is opaque even when approved body paint is translucent');
  let rim=1;rim*=1-alpha;
  assert.equal(rim,0,'subtracting coverage leaves no interior ink');
});


test('direct tree changes crossfade immediately and rapid hover keeps bounded continuous tracks', async () => {
 const {renderer,records}=await setup(cohort(20));
 renderer.setHovered(records[0].id,0);renderer.hoverState(120);
 renderer.setHovered(records[1].id,120);
 const halfway=renderer.hoverState(180).entries;
 assert.equal(halfway.find(t=>t.id===records[0].id).opacity,.5);
 assert.equal(halfway.find(t=>t.id===records[1].id).opacity,.5);
 for(let i=2;i<20;i++){renderer.setHovered(records[i].id,180+i);assert.ok(renderer.hoverState(180+i).entries.length<=8);}
 renderer.hoverState(320);
 assert.ok(renderer.hoverState(440).entries.some(t=>t.id===records[19].id&&t.opacity===1));
 renderer.setHovered(null,440);assert.equal(renderer.hoverState(560).entries.length,0);
});

test('hover masks hills and only intersecting foreground trees using effective opacity without taking forest vector slots', async () => {
 const {renderer,records}=await setup(cohort(4),2),trees=records.map((s,i)=>({s,screen:{x:i===3?700:100,y:200,renderScale:.2},detailed:i%2===0,occluders:[i]}));
 renderer.prepare(trees,{zoom:.2,dpr:2});renderer.beginFrame(trees,{zoom:.2,dpr:2});
 const before=renderer.stats().frameVectorDraws,masked=[],log=[],ctx=canvasFactory(log)(1600,1000).getContext('2d');
 renderer.setHovered(records[1].id,0);
 const options={now:120,zoom:.2,dpr:2.1,viewport:{x:0,y:0,w:800,h:500},opacityFor:()=>.52,
  paintMasked:(art,tree,bounds,draw)=>{masked.push({id:tree.s.id,mode:art.globalCompositeOperation,alpha:art.globalAlpha,masks:tree.occluders});draw(art);}};
 renderer.drawHover(ctx,trees,options);
 assert.deepEqual(masked.map(t=>t.id),[records[1].id,records[2].id]);
 assert.equal(masked[1].mode,'destination-out');assert.equal(masked[1].alpha,.52);
 assert.deepEqual(masked[0].masks,[1]);assert.equal(log.at(-1).alpha,.52);
 assert.equal(renderer.stats().frameVectorDraws,before);
 const transfer=log.at(-1).args;assert.ok(transfer[7]*2.1/transfer[3]<=1.1);assert.ok(transfer[8]*2.1/transfer[4]<=1.1);
 const previous=masked.length;renderer.drawHover(ctx,trees,{...options,opacityFor:()=>.3});assert.ok(masked.length>previous);
 const growthOptions={...options,growthFor:()=>({active:true,crown:.4})};
 assert.equal(renderer.drawHover(ctx,trees,growthOptions).active,true,'existing hover fades during growth');
 assert.deepEqual(renderer.drawHover(ctx,trees,{...growthOptions,now:240}).drawnIds,[]);
 renderer.setHovered(null,120);renderer.drawHover(ctx,trees,{...options,now:240});assert.equal(renderer.stats().hoverBytes,0);
});


test('vector membership ignores the 30-tree boundary and retains comparable incumbents', async () => {
  const records=Array.from({length:31},(_,i)=>({id:`sticky-${i}`,species:'build',sizeClass:3,density:'medium'}));
  const {renderer,encodings}=await setup(records);
  renderer.prepare(records,{zoom:.1});
  const visible=records.map(s=>({s,detailed:true}));
  const frame=list=>renderer.beginFrame(list,{zoom:1,now:0});
  const initial=[...frame(visible.slice(0,29))].sort();
  assert.equal(initial.length,12);
  assert.deepEqual([...frame(visible.slice(0,30))].sort(),initial);
  assert.deepEqual([...frame(visible.slice().reverse())].sort(),initial);
  const outsider=records.find(r=>!initial.includes(r.id));
  encodings.set(outsider.id,{...outsider,sizeClass:4}); // 214/184 < 1.25
  assert.deepEqual([...frame(visible)].sort(),initial);
  encodings.set(outsider.id,{...outsider,sizeClass:4,species:'orchestration'}); // > 1.25
  assert.ok(frame(visible).has(outsider.id));
});

test('vector entry and exit thresholds retain members inside the hysteresis band', async () => {
  const {renderer,records}=await setup(cohort(1));
  renderer.prepare(records,{zoom:.1});
  const log=[],ctx=canvasFactory(log)(1,1).getContext('2d');
  renderer.tree(ctx,records[0],{x:50,y:100,renderScale:.1});
  const sourceHeight=log.find(c=>c.kind==='image').args[4];
  const base=renderer.settledBounds(records[0],{x:0,y:0},1).actualHeight;
  const frame=ratio=>renderer.beginFrame(records.map(s=>({s,detailed:false})),{zoom:ratio*sourceHeight/base,now:0});
  assert.equal(frame(1.09).size,0); assert.equal(frame(1.11).size,1);
  assert.equal(frame(1.04).size,1); assert.equal(frame(.99).size,0);
});

test('vector crossfade follows injected time and motion draws only the existing atlas', async () => {
  const {renderer,records}=await setup(cohort(1));
  const record=records[0],origin={x:400,y:700,renderScale:1},visible=[{s:record,screen:origin,detailed:true}];
  renderer.prepare(records,{zoom:.1});
  const log=[],ctx=canvasFactory(log)(1000,800).getContext('2d');ctx.globalAlpha=.4;
  const alphas=[];
  for(const now of [0,75,150]) {
    renderer.beginFrame(visible,{zoom:1,now,viewport:{x:0,y:0,w:1000,h:800}});
    log.length=0;renderer.tree(ctx,record,origin);
    alphas.push(log.filter(c=>c.kind==='image').map(c=>c.alpha));
    assert.equal(renderer.stats().vectorFading,now<150);
    assert.equal(ctx.globalAlpha,.4);
  }
  assert.equal(alphas[0][1],0);
  assert.equal(alphas[1][0],alphas[0][0]/2);assert.equal(alphas[1][1],alphas[2][0]/2);
  assert.equal(alphas[2].length,1);
  const before=renderer.stats();
  renderer.beginFrame(visible,{zoom:2,now:160,moving:true});
  renderer.prepare(records,{zoom:2,moving:true,budgetMs:Infinity});renderer.pump(Infinity);
  renderer.tree(ctx,record,origin);renderer.drawSpecimenVector(ctx,record,origin,{force:true});
  assert.equal(renderer.stats().frameVectorDraws,0);
  assert.equal(renderer.stats().vectorDraws,before.vectorDraws);
  assert.equal(renderer.stats().proceduralRepaints,before.proceduralRepaints);
  assert.equal(renderer.stats().rasterAllocations,before.rasterAllocations);
  assert.equal(renderer.stats().vectorFading,false);
  assert.ok(renderer.stats().pendingRasters>0);
});

test('atlas queues one changed shape, retains old pixels, and respects bucket hysteresis', async () => {
  const {renderer,records}=await setup(cohort(2));
  renderer.prepare(records,{zoom:.1});
  const log=[],ctx=canvasFactory(log)(1,1).getContext('2d'),origin={x:100,y:200,renderScale:.1};
  const transfer=()=>{log.length=0;renderer.tree(ctx,records[0],origin);return log.find(c=>c.kind==='image').args;};
  const old=transfer(),sourceHeight=old[4],base=renderer.settledBounds(records[0],origin,1).actualHeight;
  const before=renderer.stats();
  renderer.prepare([{s:records[0],rasterZoom:sourceHeight/base*1.14}],{budgetMs:Infinity});
  assert.equal(renderer.stats().incrementalRasters,before.incrementalRasters);
  renderer.prepare([{s:records[0],rasterZoom:sourceHeight/base*1.16}],{budgetMs:0});
  assert.equal(renderer.stats().pendingRasters,1);assert.equal(transfer()[0],old[0]);assert.ok(old[0].width>0);
  assert.equal(renderer.stats().incrementalRasters,before.incrementalRasters);
  renderer.pump(Infinity);
  assert.equal(renderer.stats().incrementalRasters,before.incrementalRasters+1);
  assert.equal(renderer.stats().pendingRasters,0);assert.notEqual(transfer()[0],old[0]);assert.equal(old[0].width,0);
  renderer.prepare(records,{zoom:.01});assert.equal(renderer.stats().incrementalRasters,before.incrementalRasters+1);
  const tree=transfer();log.length=0;renderer.symbol(ctx,records[0],origin,.1);
  assert.equal(log.find(c=>c.kind==='image').args[4],tree[4],'symbol and tree share full source resolution');
});

test('cold motion uses minimum cells and a zero budget leaves cold settled work pending', async () => {
  const {renderer,records}=await setup(cohort(3));
  renderer.prepare(records,{zoom:2,budgetMs:0});
  assert.equal(renderer.stats().entries,0);assert.equal(renderer.stats().pendingRasters,3);
  assert.equal(renderer.stats().geometryEntries,0,"zero-budget planning does not build geometry");
  renderer.prepare(records,{zoom:2,moving:true});
  assert.equal(renderer.stats().entries,6);assert.equal(renderer.stats().pendingRasters,3);
  const before=renderer.stats();renderer.pump(Infinity);
  assert.equal(renderer.stats().proceduralRepaints,before.proceduralRepaints);
  renderer.beginFrame([],{moving:false});renderer.prepare(records);
  assert.equal(renderer.stats().pendingRasters,0,'no-options prepare remains synchronous after beginFrame');
});

test('time slices stop between raster jobs and subsequent pumps finish the queue', async () => {
  const {createGardenSpecimenRenderer}=await modules();
  let time=0;
  const oldPerformance=global.performance;
  const factory=canvasFactory();
  const renderer=createGardenSpecimenRenderer({createCanvas:(w,h)=>{time+=5;return factory(w,h);}});
  try {
    global.performance={now:()=>time};
    renderer.prepare(cohort(3),{zoom:.1,budgetMs:4});
    assert.equal(renderer.stats().incrementalRasters,1);assert.equal(renderer.stats().pendingRasters,2);
    renderer.pump(4);assert.equal(renderer.stats().incrementalRasters,2);
    renderer.pump(Infinity);assert.equal(renderer.stats().pendingRasters,0);
  } finally {global.performance=oldPerformance;}
});

test('scratch dimensions remain fixed across trees and vector geometry uses a 24-shape LRU', async () => {
  const {createGardenSpecimenRenderer}=await modules(),factory=canvasFactory();
  let assignments=0,allocations=0;
  const renderer=createGardenSpecimenRenderer({createCanvas:(width,height)=>{
    allocations++;const canvas=factory(width,height);
    for(const key of ['width','height']){let value=canvas[key];Object.defineProperty(canvas,key,{get:()=>value,set:n=>{assignments++;value=n;}});}
    return canvas;
  }});
  const records=cohort(25),origin={x:500,y:750,renderScale:1};
  const ctx=factory(1280,800).getContext('2d');
  const paint=r=>{renderer.beginFrame([{s:r}],{zoom:1,now:0,viewport:{x:0,y:0,w:1280,h:800}});renderer.tree(ctx,r,origin);};
  records.slice(0,24).forEach(paint);
  assert.equal(allocations,1);assert.equal(assignments,0);assert.equal(renderer.stats().scratchBytes,1280*800*4);
  assert.equal(renderer.stats().vectorGeometryEntries,24);
  const before=renderer.stats().vectorRepaints;
  paint(records[0]);paint(records[24]);paint(records[0]);
  assert.equal(renderer.stats().vectorRepaints,before+1,'recently touched shape survives eviction');
  paint(records[1]);assert.equal(renderer.stats().vectorRepaints,before+2,'least-recently-used shape was evicted');
  assert.equal(renderer.stats().vectorGeometryEntries,24);assert.equal(assignments,0);
});

test('hover ratio jitter and record copies hit cache; pooled canvases survive release and growth fades back in', async () => {
  const {renderer,records,allocations}=await setup(cohort(80),2);
  const trees=records.map((s,i)=>({s,screen:{x:i<2?100:1000+i*100,y:200},detailed:true}));
  const ctx=canvasFactory()(1600,1000).getContext('2d');
  let samples=0;
  const options={zoom:.1,dpr:2,viewport:{x:0,y:0,w:800,h:500},growthFor:()=>{samples++;return null;}};
  renderer.setHovered(records[0].id,0);renderer.drawHover(ctx,trees,{...options,now:120});
  const before=renderer.stats();samples=0;
  renderer.drawHover(ctx,trees.map(t=>({...t})),{...options,dpr:2.001,now:140});
  assert.equal(renderer.stats().hoverBuilds,before.hoverBuilds);assert.ok(samples<8,'only overlapping dependencies are sampled');
  renderer.drawHover(ctx,trees,{...options,generation:1,now:150});
  assert.ok(renderer.stats().hoverPoolHits>before.hoverPoolHits);
  const allocated=allocations.length;
  renderer.drawHover(ctx,trees,{...options,generation:2,now:160});
  assert.equal(allocations.length,allocated,'replacement holds the old image while reusing pooled temporaries');
  const growing={...options,generation:2,growthFor:()=>({active:true,crown:.5})};
  assert.equal(renderer.drawHover(ctx,trees,{...growing,now:170}).active,true);
  assert.deepEqual(renderer.drawHover(ctx,trees,{...growing,now:290}).drawnIds,[]);
  assert.equal(renderer.drawHover(ctx,trees,{...options,generation:2,now:300}).active,true);
  assert.deepEqual(renderer.drawHover(ctx,trees,{...options,generation:2,now:420}).drawnIds,[records[0].id]);
  renderer.setHovered(null,420);renderer.drawHover(ctx,trees,{...options,now:540});
  assert.equal(renderer.stats().hoverBytes,0);assert.ok(renderer.stats().hoverPoolBytes>0);
  renderer.setHovered(records[0].id,540);renderer.drawHover(ctx,trees,{...options,now:660});
  assert.equal(allocations.length,allocated,'re-hover uses released canvases');
  renderer.clear();assert.equal(renderer.stats().hoverPoolBytes,0);
});


test('hover that starts during growth fades in after completion', async () => {
  const {renderer,records}=await setup(cohort(1));
  const trees=records.map(s=>({s,screen:{x:100,y:200}})),log=[],ctx=canvasFactory(log)(800,500).getContext('2d');
  const options={zoom:.1,dpr:1};renderer.setHovered(records[0].id,0);
  assert.deepEqual(renderer.drawHover(ctx,trees,{...options,now:120,growthFor:()=>({active:true,crown:.5})}).drawnIds,[]);
  assert.equal(renderer.drawHover(ctx,trees,{...options,now:200}).active,true);
  assert.equal(log.filter(c=>c.kind==='image').length,0);
  renderer.drawHover(ctx,trees,{...options,now:260});assert.equal(log.at(-1).alpha,.5);
  renderer.drawHover(ctx,trees,{...options,now:320});assert.equal(log.at(-1).alpha,1);
});

test('budget pressure lowers the largest atlas cells first and keeps smaller trees at device size', async () => {
  const { renderer, records, specimenHeight } = await setup(cohort(300), 2);
  const list = records.slice(0, 60).map((r, i) => ({ s: r, screen: { x: i * 10, y: 500, renderScale: i < 6 ? 1.6 : .12 }, detailed: true }));
  renderer.prepare(list, { zoom: .12, dpr: 2, budgetMs: Infinity });
  assert.equal(renderer.stats().pendingRasters, 0);
  assert.ok(renderer.stats().bytes <= 32 * 1024 * 1024);
  const upscale = (item, zoom) => {
    const log = []; const ctx = canvasFactory(log)(10, 10).getContext('2d');
    renderer.tree(ctx, item.s, { ...item.screen, renderScale: zoom }, null, true);
    const a = log.find(c => c.kind === 'image').args; return Math.max(a[7] * 2 / a[3], a[8] * 2 / a[4]);
  };
  const small = list.slice(6).map(item => upscale(item, .12));
  assert.ok(Math.max(...small) <= 1.16, `small trees keep device-size cells, got ${Math.max(...small)}`);
});

test('a cold shape drawn during motion gets a stand-in cell of at least 96 device pixels', async () => {
  const { renderer, records } = await setup(cohort(1), 1);
  renderer.prepare(records, { zoom: 2, moving: true });
  const log = []; renderer.tree(canvasFactory(log)(10, 10).getContext('2d'), records[0], { x: 0, y: 0, renderScale: 2 }, null, true);
  const a = log.find(c => c.kind === 'image').args;
  assert.ok(a[4] >= 90, `stand-in source height ${a[4]}`);
  assert.equal(renderer.stats().pendingRasters, 1, 'the sharp raster stays queued for after the camera settles');
  renderer.prepare(records, { zoom: 2, moving: false, budgetMs: Infinity });
  assert.equal(renderer.stats().pendingRasters, 0);
});
