const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const folder = 'web/';
const dataURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const theme = dataURL(fs.readFileSync(folder + 'observatory-theme.js', 'utf8'));
const painter = import(dataURL(fs.readFileSync(folder + 'specimen-tree-painter.js', 'utf8')
  .replace("'./observatory-theme.js'", JSON.stringify(theme))));

test('session seeds repeat exactly and produce distinct tree variation', async () => {
  const { seededRandom, seedHash } = await painter;
  const sample = key => { const random = seededRandom(key); return Array.from({ length: 100 }, random); };
  assert.deepEqual(sample('session-a'), sample('session-a'));
  assert.notDeepEqual(sample('session-a'), sample('session-b'));
  assert.ok(sample('session-a').every(n => n >= 0 && n < 1));
  assert.equal(seedHash('session-a'), seedHash('session-a'));
  assert.notEqual(seedHash('session-a'), seedHash('session-b'));
});

test('each size class grows limbs, trunk thickness, and crown structure', async () => {
  const { growthProfile } = await painter;
  const stages = Array.from({ length: 5 }, (_, i) => growthProfile(i));
  assert.deepEqual(stages.map(stage => stage.limbs), [1, 2, 3, 5, 7]);
  for (let i = 1; i < stages.length; i++) {
    for (const key of ['trunk', 'lobes', 'height']) assert.ok(stages[i][key] > stages[i - 1][key], key);
  }
  assert.equal(growthProfile(-3).index, 0);
  assert.equal(growthProfile(9).index, 4);
  assert.equal(growthProfile(NaN).index, 0);
});

test('species keep their distinct proportions at all five sizes', async () => {
  const { SPECIES, specimenHeight } = await painter;
  assert.equal(SPECIES.length, 5);
  for (let size = 0; size < 5; size++) {
    assert.ok(specimenHeight('quick', size) < specimenHeight('build', size) * .5);
    assert.ok(specimenHeight('orchestration', size) > specimenHeight('build', size));
    for (const species of SPECIES) {
      assert.ok(Number.isFinite(specimenHeight(species, size)));
      if (size) assert.ok(specimenHeight(species, size) > specimenHeight(species, size - 1));
    }
  }
});

test('tree foliage and trunks use Observatory tones without the warm fruit accent', async () => {
  const { SPECIES, speciesPalette } = await painter;
  const { OBSERVATORY } = await import(theme);
  const allowed = new Set([OBSERVATORY.ink, ...OBSERVATORY.canopies.flatMap(c => Object.values(c))]);
  for (const species of SPECIES) {
    const colors = Object.values(speciesPalette(species));
    assert.ok(colors.every(color => allowed.has(color)));
    assert.ok(!colors.includes(OBSERVATORY.canopies[3].top));
  }
});


test('live geometry exposes stable crop, three layers, and five crown-valid fruit anchors without a DOM', async () => {
  const { createSpecimenGeometry, SPECIES } = await painter;
  for (const species of SPECIES) for (let sizeClass = 0; sizeClass < 5; sizeClass++) {
    for (const density of ['sparse', 'medium', 'dense']) {
      const g = createSpecimenGeometry({ species, sizeClass, density, seed: 'variant:0' });
      assert.ok(g.crop.width > 0 && g.crop.height > 0);
      assert.equal(g.aspect, g.crop.width / g.crop.height);
      assert.equal(g.root, (192 - g.crop.x) / g.crop.width);
      assert.deepEqual(Object.keys(g.layers), ['trunk', 'branches', 'crown']);
      assert.equal(g.fruit.length, 5);
      for (const p of g.fruit) assert.ok(g.containsCrown(p.x, p.y), `${species}: fruit outside crown`);
    }
  }
});

test('sheet atlas and live sparkle preserve inherited opacity and existing exports', async () => {
  const { createTreeAtlas, drawLiveSparkle } = await painter;
  const oldDocument = global.document, oldPath = global.Path2D;
  const draws = [], strokes = [];
  class Path { moveTo() {} lineTo() {} closePath() {} }
  const makeCanvas = () => {
    const canvas = { width: 1, height: 1 }, stack = [];
    const ctx = { canvas, globalAlpha: 1, save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
      drawImage() { draws.push(this.globalAlpha); }, stroke() { strokes.push(this.globalAlpha); },
      getImageData(x, y, w, h) { const data = new Uint8ClampedArray(w * h * 4); data.fill(255); return { data }; },
      createRadialGradient() { return { addColorStop() {} }; } };
    for (const method of ['clearRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'arc', 'ellipse', 'bezierCurveTo', 'fillRect']) ctx[method] = () => {};
    canvas.getContext = () => ctx; return canvas;
  };
  global.document = { createElement: makeCanvas }; global.Path2D = Path;
  try {
    const atlas = createTreeAtlas([{ species: 'build', sizeClass: 2, density: 'medium', fruit: 3, seed: 'sheet' }]);
    assert.equal(atlas.entries.length, 1); assert.equal(typeof atlas.draw, 'function');
    const ctx = makeCanvas().getContext('2d'); ctx.globalAlpha = .3; draws.length = strokes.length = 0;
    const bounds = atlas.draw(ctx, 0, 40, 80, 100, { shadow: true, alpha: .5 });
    assert.equal(bounds.height, 100); assert.equal(draws.at(-1), .15); assert.equal(ctx.globalAlpha, .3);
    drawLiveSparkle(ctx, 40, 80, 100, 2, 'live');
    assert.ok(strokes.every(alpha => alpha <= .3)); assert.equal(ctx.globalAlpha, .3);
  } finally { global.document = oldDocument; global.Path2D = oldPath; }
});


test('native crown then underpainted wood matches raster layer composition, including holes and inherited alpha', async () => {
  const {createSpecimenGeometry,paintSpecimenLayer,SPECIES,seedHash}=await painter;
  // A deterministic coverage probe exercises partial edge coverage as well as full holes.
  // It tests Porter-Duff color/alpha parity without claiming browser antialiasing equivalence.
  const over=(s,d)=>s.map((v,i)=>v+d[i]*(1-s[3]));
  function surface(sample){
    let pixel=[0,0,0,0],path=[],state={globalAlpha:1,globalCompositeOperation:'source-over'},stack=[];
    const ctx={save(){stack.push({...state});},restore(){state=stack.pop();},beginPath(){path=[];},
      get pixel(){return pixel;},fill(){paint('fill');},stroke(){paint('stroke');}};
    for(const key of ['globalAlpha','globalCompositeOperation','fillStyle','strokeStyle','lineWidth'])Object.defineProperty(ctx,key,{get:()=>state[key],set:v=>{state[key]=v;}});
    for(const method of ['moveTo','lineTo','closePath','bezierCurveTo'])ctx[method]=(...args)=>path.push([method,...args]);
    function paint(kind){
      const coverage=[0,.25,.75,1][seedHash(JSON.stringify(path)+sample+kind)%4];
      const alpha=coverage*state.globalAlpha,color=String(state[kind==='fill'?'fillStyle':'strokeStyle']);
      const rgb=[0,1,2].map(i=>(seedHash(color+i)%256)/255),s=[...rgb.map(c=>c*alpha),alpha],d=pixel;
      if(state.globalCompositeOperation==='destination-out')pixel=d.map(v=>v*(1-alpha));
      else if(state.globalCompositeOperation==='source-atop')pixel=s.map((v,i)=>v*d[3]+d[i]*(1-alpha));
      else if(state.globalCompositeOperation==='destination-over')pixel=over(d,s);
      else pixel=over(s,d);
    }
    return ctx;
  }
  let probes=0;
  for(const species of SPECIES)for(const sizeClass of [0,2,4])for(const density of ['sparse','dense']){
    const geometry=createSpecimenGeometry({species,sizeClass,density,seed:'parity'});
    for(let sample=0;sample<4;sample++){
      const layers=['trunk','branches','crown'].map(layer=>{const c=surface(sample);paintSpecimenLayer(c,geometry,layer);return c.pixel;});
      const expected=layers.reduce((d,s)=>over(s,d),[0,0,0,0]);
      const native=surface(sample);paintSpecimenLayer(native,geometry,'crown');paintSpecimenLayer(native,geometry,'branches',{behind:true});paintSpecimenLayer(native,geometry,'trunk',{behind:true});
      const background=[.12,.23,.34,1],opacity=.37*geometry.alpha;
      const a=over(expected.map(v=>v*opacity),background),b=over(native.pixel.map(v=>v*opacity),background);
      assert.ok(a.every((v,i)=>Math.abs(v-b[i])<1e-12),`${species}/${sizeClass}/${density}`);
      assert.equal(b[3],1,'crown holes must leave the opaque background intact');probes++;
    }
  }
  assert.equal(probes,120);
});


test('native Path2D commands build once and preserve fill, stroke, alpha and composite', async () => {
  const { paintSpecimenLayer } = await painter;
  const previous = global.Path2D;
  let builds=0, operations=0;
  class Path {
    constructor(){builds++;}
    moveTo(){operations++;} lineTo(){operations++;} closePath(){operations++;}
  }
  const command = kind => ({kind,path:{commands:[['moveTo',1,2],['lineTo',3,4],['closePath']]},
    composite:'source-atop',alpha:.4,color:'#abc',lineWidth:2});
  const geometry={layers:{crown:[command('fill'),command('stroke')]}}, calls=[];
  const ctx={globalAlpha:.5,save(){},restore(){this.globalAlpha=.5;},
    fill(path){calls.push(['fill',path,this.globalAlpha,this.globalCompositeOperation]);},
    stroke(path){calls.push(['stroke',path,this.globalAlpha,this.globalCompositeOperation]);}};
  global.Path2D=Path;
  try {
    paintSpecimenLayer(ctx,geometry,'crown'); paintSpecimenLayer(ctx,geometry,'crown');
    assert.equal(builds,2); assert.equal(operations,6);
    assert.equal(calls[0][1],calls[2][1]); assert.equal(calls[1][1],calls[3][1]);
    assert.deepEqual(calls.map(c=>[c[0],c[2],c[3]]),[
      ['fill',.2,'source-atop'],['stroke',.2,'source-atop'],['fill',.2,'source-atop'],['stroke',.2,'source-atop']]);
    delete global.Path2D;
    let replayed=0;
    for(const method of ['beginPath','moveTo','lineTo','closePath'])ctx[method]=()=>replayed++;
    paintSpecimenLayer(ctx,geometry,'crown'); assert.equal(replayed,8);
  } finally { if(previous===undefined)delete global.Path2D;else global.Path2D=previous; }
});
