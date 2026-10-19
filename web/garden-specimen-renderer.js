/** Bounded live adapter for the approved specimen painter. No camera or evidence ownership. */
import { OBSERVATORY } from './observatory-theme.js';
import { SPECIES, seedHash, specimenHeight, speciesPalette, createSpecimenGeometry, paintSpecimenLayer, paintSpecimenFruit } from './specimen-tree-painter.js';
import './specimen-environment.js';

export const SPECIMEN_VECTOR_LIMIT = 12;
/** Growing and camera-focus trees are always native vector, moving or not; this bounds that extra cost. */
export const SPECIMEN_FOCUS_LIMIT = 8;
const smooth = ctx => { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; };
const LIMIT = 32 * 1024 * 1024, PAGE = 1024, PAD = 2, GROWTH_LIMIT = 4 * 1024 * 1024;
const HIGHLIGHT_LIMIT = 2 * 512 * 512 * 4, FRUIT_BYTES = 5 * 32 * 48 * 4;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const value = (input, fallback) => {
  const n = Number(typeof input === 'function' ? input() : input);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const unit = n => clamp(Number.isFinite(Number(n)) ? Number(n) : 1, 0, 1);
const bucket = height => Math.min(768, Math.max(4, 2 ** (Math.ceil(Math.log2(Math.max(4, height)) * 2) / 2)));
const defaultCanvas = (width, height) => {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
};
const release = canvas => { canvas.width = canvas.height = 0; };

/**
 * prepare accepts encodings, sessions, or {s, screen, detailed} records for the entire visible cohort.
 * rasterPlan: {zoom?, rasterZoom?, dpr?, themeVersion?, moving?, budgetMs?}. screen.rasterZoom wins.
 * Both detail bindings share full-resolution cells; detail eligibility belongs to the garden.
 * Without options, prepare drains synchronously. Frame-aware plans pump a 4 ms slice.
 * Infinity explicitly drains the queue; moving only permits minimum-resolution cold shapes.
 * Call prepare before drawing, after evidence or bucket demand changes. x/y/yaw/day/time are ignored.
 * beginFrame selects at most 12 native-resolution trees on each forest repaint.
 * Native scratch storage is transient drawing memory, reported separately from the 32 MiB atlas.
 * Additional createCanvas and shadow options support DOM-free tests and an injected shadow painter.
 */
export function createGardenSpecimenRenderer({ theme = OBSERVATORY, scale = () => 1, dpr = () => 1,
  treeSize = () => 2.8, encoding, createCanvas = defaultCanvas, shadow: shadowPainter } = {}) {
  const metadata = new Map(), sprites = new Map(), highlights = new Map(), retainedDemand = new Map(), visualBindings = new Map();
  let pages = [], fruitCanvas = null, pageBytes = 0, highlightBytes = 0, themeKey = '';
  const growthPages = new Map(); let growthBytes = 0;
  let rasterFactor = 1, rasterCap = Infinity, preparedRecords = 0, activeRatio = 1, visibleKeys = new Set();
  let hits = 0, misses = 0, proceduralRepaints = 0, preparations = 0, detailDraws = 0, proxyDraws = 0, unpreparedDraws = 0;
  const vectorGeometry = new Map(), pendingRasters = new Map(), vectorFades = new Map();
  let incrementalRasters = 0, frameMoving = false, rasterMoving = false, frameStarted = false, frameNow = 0;
  const clock = () => performance.now();
  const fadeAmount = fade => clamp((frameNow - fade.start) / 150, 0, 1);
  const rounded = b => ({ x: Math.floor(b.x), y: Math.floor(b.y),
    w: Math.ceil(b.x+b.w)-Math.floor(b.x), h: Math.ceil(b.y+b.h)-Math.floor(b.y) });
  let vectorIds = new Set(), vectorDrawn = new Set(), frameRatio = 1, frameViewport = null;
  let vectorScratch = null, scratchPeakBytes = 0, vectorDraws = 0, vectorRepaints = 0;
  let frameVectorDraws = 0, frameMaxUpscale = 0, focusDraws = 0;
  // focusNow: ids drawn vector this frame regardless of motion. growingSeen: unsettled ids seen last frame (carried into the next).
  let focusNow = new Set(), growingSeen = new Set(), growingNext = new Set(), focusHold = new Set();
  let focusVectorDraws = 0, rasterAllocations = 0, layerRepaints = 0, rasterDraws = 0, highlightRepaints = 0;
  const hoverTracks = new Map(), hoverImages = new Map(), hoverPool = new Map(), hoverGrowing = new Set();
  let hoverPoolBytes = 0, hoverBuilds = 0, hoverPoolHits = 0;
  const hoverPoolLimit = 16*1024*1024;
  function takeHover(width,height) {
    const w = Math.ceil(width/64)*64, h = Math.ceil(height/64)*64, key = `${w}:${h}`;
    const pool = hoverPool.get(key), canvas = pool?.pop();
    if (!pool?.length) hoverPool.delete(key);
    if (canvas) { hoverPoolBytes -= w*h*4; hoverPoolHits++; }
    const result = canvas || createCanvas(w,h), ctx = result.getContext('2d');
    ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,w,h);
    return result;
  }
  function returnHover(canvas) {
    const bytes = canvas.width*canvas.height*4, key = `${canvas.width}:${canvas.height}`;
    if (hoverPoolBytes+bytes > hoverPoolLimit) { release(canvas); return; }
    if (!hoverPool.has(key)) hoverPool.set(key,[]);
    hoverPool.get(key).push(canvas); hoverPoolBytes += bytes;
  }
  let hoveredId = null, pendingHoverAt = 0;
  const hoverAmount = (track, now) => {
    const t = clamp((now - track.start) / 120, 0, 1), eased = t*t*(3-2*t);
    return track.from + (track.to-track.from)*eased;
  };
  function setHovered(id, now = performance.now()) {
    if (id === hoveredId) return;
    hoveredId = id; pendingHoverAt = now;
    for (const [key, track] of hoverTracks) {
      const from = hoverAmount(track, now);
      if (track.to !== (key === id ? 1 : 0)) hoverTracks.set(key, { from, to: key === id ? 1 : 0, start: now });
    }
    if (id && !hoverTracks.has(id) && hoverTracks.size < 8)
      hoverTracks.set(id, { from: 0, to: 1, start: now });
  }
  function hoverState(now = performance.now()) {
    for (const [id, track] of hoverTracks) if (track.to === 0 && now-track.start >= 120) {
      hoverTracks.delete(id); hoverGrowing.delete(id);
      const image = hoverImages.get(id); if (image) returnHover(image.canvas);
      hoverImages.delete(id);
    }
    // Coalesce extreme pointer traffic until a fading slot becomes free. Never drop visible opacity.
    if (hoveredId && !hoverTracks.has(hoveredId) && hoverTracks.size < 8)
      hoverTracks.set(hoveredId, { from: 0, to: 1, start: Math.max(pendingHoverAt, now) });
    const entries = [...hoverTracks].map(([id, track]) => ({ id, opacity: hoverAmount(track, now) }));
    return { id: hoveredId || entries[0]?.id || null, opacity: entries.find(t=>t.id===hoveredId)?.opacity ?? entries[0]?.opacity ?? 0,
      active: [...hoverTracks.values()].some(t=>now-t.start < 120) || !!(hoveredId&&!hoverTracks.has(hoveredId)), entries, neighborOpacity: 1 };
  }
  function allocate(width, height) { rasterAllocations++; return createCanvas(width, height); }

  function recordFor(session) {
    const id = typeof session === 'string' ? session : session?.id;
    return encoding?.(id) || (session?.species ? session : { id, species: 'build', sizeClass: 0, density: 'medium', fruit: 0, visualKey: 'missing' });
  }
  function shapeFor(record) {
    const species = SPECIES.includes(record.species) ? record.species : 'build';
    const sizeClass = clamp(Math.round(Number(record.sizeClass) || 0), 0, 4);
    const density = typeof record.density === 'number' ? ['sparse', 'medium', 'dense'][clamp(Math.round(record.density), 0, 2)]
      : ['sparse', 'medium', 'dense'].includes(record.density) ? record.density : 'medium';
    const variation = seedHash(record.id ?? '') % 4;
    return { species, sizeClass, density, seed: `variant:${variation}`, key: `${species}:${sizeClass}:${density}:${variation}` };
  }
  function remember(shape, geometry) {
    const { crop, root, aspect, height, alpha, fruit } = geometry;
    const result = { crop, root, aspect, height, alpha, fruit };
    metadata.set(shape.key, result); return result;
  }
  function metrics(shape) {
    return metadata.get(shape.key) || remember(shape, createSpecimenGeometry(shape, { theme }));
  }
  function measure(session, origin, zoom, detail = 'tree') {
    const record = recordFor(session), shape = shapeFor(record), meta = metrics(shape);
    const renderScale = value(zoom, value(scale, 1)), actualHeight = specimenHeight(shape.species, shape.sizeClass) * value(treeSize, 2.8) * renderScale;
    const width = actualHeight * meta.aspect;
    return { x: origin.x, y: origin.y, bounds: { x: origin.x - width * meta.root, y: origin.y - actualHeight, w: width, h: actualHeight, detail },
      renderScale, family: shape.species, visualKey: record.visualKey, actualHeight };
  }
  function clearRasters() {
    for (const page of pages) release(page);
    for (const image of highlights.values()) release(image.canvas);
    if (fruitCanvas) release(fruitCanvas);
    for (const g of growthPages.values()) release(g.canvas);
    growthPages.clear(); growthBytes = 0;
    pages = []; sprites.clear(); highlights.clear(); visualBindings.clear(); fruitCanvas = null; pageBytes = highlightBytes = 0;
  }
  // Each shape owns a compact page. Replacement pages become visible atomically.
  // Symbol and tree use identical artwork and resolution, so both bindings share cells.
  function cellPlan(demand, factor) {
    // Unknown crops use a conservative square estimate; planning never builds geometry.
    const meta = metadata.get(demand.shape.key) || {crop:{width:384,height:384}};
    const height = bucket(demand.height * factor);
    const ratio = Math.min(height / meta.crop.height, (PAGE-PAD*2) / meta.crop.width);
    const w = Math.ceil(meta.crop.width*ratio), h = Math.ceil(meta.crop.height*ratio);
    // The atlas page holds only the settled cell; growth layers live in a small on-demand page.
    const width = w+PAD*2, pageHeight = h+PAD*2;
    return { shape: demand.shape, meta, height, ratio, w, h, width, pageHeight, bytes: width*pageHeight*4 };
  }
  function ensureFruit() {
    if (fruitCanvas) return;
    fruitCanvas = allocate(32*5,48);
    const ctx = fruitCanvas.getContext('2d');
    for (let i=0;i<5;i++) {
      ctx.save(); ctx.translate(i*32+16,20); ctx.scale(2,2);
      paintSpecimenFruit(ctx, { ...theme, canopies: [{ ...theme.canopies[0], seam: speciesPalette(SPECIES[i],theme).l }, ...theme.canopies.slice(1)] });
      ctx.restore();
    }
  }
  // Memory pressure lowers the largest demands first (they fall back to native vectors); smaller trees keep device size.
  const factorFor = demand => Math.min(1, rasterCap / demand.height);
  function evictHidden() {
    for (const [key, sprite] of sprites) {
      if (!key.endsWith(':tree') || visibleKeys.has(key.slice(0, -5))) continue;
      sprites.delete(key); sprites.delete(`${key.slice(0, -5)}:symbol`); retainedDemand.delete(key.slice(0, -5));
      pages.splice(pages.indexOf(sprite.canvas), 1); pageBytes -= sprite.bytes; release(sprite.canvas);
      return true;
    }
    return false;
  }
  function rasterize(demand, factor = factorFor(demand)) {
    const geometry = createSpecimenGeometry(demand.shape,{theme}), meta = remember(demand.shape,geometry);
    let item = cellPlan(demand, factor);
    while (pageBytes + item.bytes + HIGHLIGHT_LIMIT + FRUIT_BYTES > LIMIT - GROWTH_LIMIT && evictHidden());
    // Keep the old cell alive during painting. Reduce this replacement if transient memory is tight.
    while (pageBytes + item.bytes + HIGHLIGHT_LIMIT + FRUIT_BYTES > LIMIT - GROWTH_LIMIT && item.height > 4) {
      factor /= Math.SQRT2; item = cellPlan(demand, factor);
    }
    if (pageBytes + item.bytes + HIGHLIGHT_LIMIT + FRUIT_BYTES > LIMIT - GROWTH_LIMIT) return false;
    const canvas = allocate(item.width,item.pageHeight), ctx = canvas.getContext('2d');
    const cells = { settled: { x: PAD, y: PAD } };
    ctx.save(); ctx.beginPath(); ctx.rect(PAD,PAD,item.w,item.h); ctx.clip();
    ctx.translate(PAD,PAD); ctx.scale(item.ratio,item.ratio); ctx.translate(-meta.crop.x,-meta.crop.y);
    // Match native compositing: finish crown holes first, then paint wood behind it.
    paintSpecimenLayer(ctx,geometry,'crown');
    paintSpecimenLayer(ctx,geometry,'branches',{behind:true});
    paintSpecimenLayer(ctx,geometry,'trunk',{behind:true});
    ctx.restore();
    const old = sprites.get(`${demand.shape.key}:tree`);
    dropGrowth(demand.shape.key);
    const sprite = { ...item, meta, canvas, cells, demandHeight: demand.height, revision: themeKey,
      key: `${themeKey}:${activeRatio}:${demand.shape.key}:${item.height}` };
    sprites.set(`${demand.shape.key}:tree`,sprite); sprites.set(`${demand.shape.key}:symbol`,sprite);
    pages.push(canvas); pageBytes += item.bytes;
    if (old) { pageBytes -= old.bytes; pages.splice(pages.indexOf(old.canvas),1); release(old.canvas); }
    proceduralRepaints++; misses++; incrementalRasters++; ensureFruit();
    return true;
  }
  function pump(budgetMs = 4) {
    if (frameMoving || rasterMoving) return stats();
    const started = clock();
    // Visible gaps first, then the largest trees on screen.
    const queue = [...pendingRasters].sort((a,b) => (sprites.has(`${a[0]}:tree`) - sprites.has(`${b[0]}:tree`)) || b[1].height - a[1].height);
    for (const [key,demand] of queue) {
      if (clock()-started >= budgetMs) break;
      if (!rasterize(demand)) break;
      pendingRasters.delete(key);
    }
    return stats();
  }
  function prepare(records, rasterPlan = {}) {
    preparations++;
    const ratio = value(rasterPlan.dpr,value(dpr,1));
    const list = records instanceof Map ? [...records.values()] : Array.from(records || []);
    preparedRecords = list.length;
    const nextTheme = `${seedHash(JSON.stringify(theme))}:${rasterPlan.themeVersion ?? theme.version ?? 0}`;
    if (nextTheme !== themeKey || ratio !== activeRatio) {
      vectorGeometry.clear(); retainedDemand.clear(); pendingRasters.clear();
    }
    themeKey = nextTheme; activeRatio = ratio;
    for (const item of list) {
      const record = recordFor(item.s || item), shape = shapeFor(record);
      const zoom = value(item.screen?.rasterZoom ?? item.rasterZoom ?? rasterPlan.rasterZoom,value(rasterPlan.zoom,value(scale,1)));
      const height = specimenHeight(shape.species,shape.sizeClass)*value(treeSize,2.8)*zoom*ratio;
      const prior = retainedDemand.get(shape.key);
      if (!prior || height > prior.height*1.15) retainedDemand.set(shape.key,{shape,height:bucket(height)});
    }
    const ordered = [...retainedDemand.values()];
    visibleKeys = new Set(list.map(item => shapeFor(recordFor(item.s || item)).key));
    const shown = ordered.filter(d => visibleKeys.has(d.shape.key)), maxHeight = Math.max(4, ...shown.map(d => d.height));
    let cap = maxHeight;
    const fits = () => {
      const sizes = shown.map(d=>cellPlan(d,Math.min(1,cap/d.height)).bytes);
      return sizes.reduce((a,b)=>a+b,0) + Math.max(0,...sizes) + HIGHLIGHT_LIMIT + FRUIT_BYTES <= LIMIT - GROWTH_LIMIT;
    };
    while (cap > 4 && !fits()) cap *= .87;
    rasterCap = cap; rasterFactor = cap / maxHeight;
    for (const key of pendingRasters.keys()) if (!visibleKeys.has(key)) pendingRasters.delete(key);
    for (const demand of shown) {
      const sprite = sprites.get(`${demand.shape.key}:tree`);
      if (!sprite || sprite.demandHeight !== demand.height || sprite.revision !== themeKey || sprite.height > cellPlan(demand,factorFor(demand)).height)
        pendingRasters.set(demand.shape.key,demand);
    }
    const moving = rasterPlan.moving ?? frameMoving;
    rasterMoving = moving;
    frameMoving = moving;
    if (moving) {
      // Cold shapes get a small stand-in cell (never a few pixels); the settled pump upgrades it. Existing sprites stay drawable.
      for (const [key,demand] of pendingRasters) if (!sprites.has(`${key}:tree`) && visibleKeys.has(key)) rasterize(demand,Math.min(factorFor(demand),96/demand.height));
    } else {
      pump(rasterPlan.budgetMs ?? (frameStarted && Object.keys(rasterPlan).length ? 4 : Infinity));
    }
    visualBindings.clear();
    for (const item of list) {
      const record = recordFor(item.s || item), shape = shapeFor(record);
      visualBindings.set(record.id,`${record.visualKey ?? shape.key}:${sprites.get(`${shape.key}:tree`)?.key ?? ''}`);
    }
    hits++; return stats();
  }
  // Select a drawing backend, never a different level of artwork detail.
  // Call only when repainting forest pixels; decoration frames keep the warm forest.
  function beginFrame(records, { zoom = value(scale,1), dpr: ratio = value(dpr,1), viewport = null,
    moving = false, now = clock(), focusIds = null } = {}) {
    frameStarted = true; frameMoving = rasterMoving = moving; frameNow = typeof now === 'function' ? now() : now;
    frameRatio = ratio; frameViewport = viewport; frameVectorDraws = frameMaxUpscale = focusDraws = 0;
    vectorDrawn = new Set();
    // Focus set: caller-declared subjects, trees that were growing last frame, and trees still waiting for an adequate
    // atlas cell after growth ended (they stay native until the cell is within 5% of device size).
    const wanted = new Set(focusIds || []), byId = new Map(), previous = new Set([...growingSeen, ...focusHold]);
    for (const item of records || []) byId.set(recordFor(item.s || item).id, item);
    for (const id of growingSeen) wanted.add(id);
    const left = [];
    for (const id of focusHold) {
      if (wanted.has(id) || !byId.has(id)) continue;
      const item = byId.get(id), shape = shapeFor(recordFor(item.s || item));
      const sprite = sprites.get(`${shape.key}:${item.detailed === false ? 'symbol' : 'tree'}`);
      const device = specimenHeight(shape.species,shape.sizeClass)*value(treeSize,2.8)*zoom*ratio;
      if (moving || !sprite || device/(sprite.meta.crop.height*sprite.ratio) > 1.05) wanted.add(id);
    }
    const heightOf = id => { const item = byId.get(id); if (!item) return -1; const shape = shapeFor(recordFor(item.s || item));
      return specimenHeight(shape.species,shape.sizeClass); };
    const ranked = [...wanted].filter(id => byId.has(id)).sort((a,b)=>heightOf(b)-heightOf(a) || String(a).localeCompare(String(b)));
    focusNow = new Set(ranked.slice(0,SPECIMEN_FOCUS_LIMIT));
    focusHold = new Set([...focusNow]);
    const handedOff = [...previous].filter(id => !focusNow.has(id));
    growingSeen = growingNext; growingNext = new Set();
    const candidates = [];
    if (!moving) for (const item of records || []) {
      const record = recordFor(item.s || item), shape = shapeFor(record);
      const height = specimenHeight(shape.species,shape.sizeClass)*value(treeSize,2.8)*zoom;
      const sprite = sprites.get(`${shape.key}:${item.detailed === false ? 'symbol' : 'tree'}`);
      const sourceHeight = sprite ? sprite.meta.crop.height*sprite.ratio : 0;
      const member = vectorIds.has(record.id), deviceHeight = height*ratio;
      if (deviceHeight/sourceHeight > (member ? 1 : 1.1) ||
        (item.detailed !== false && deviceHeight > (member ? 160 : 192) && deviceHeight/sourceHeight > (member ? .8 : .95)))
        candidates.push({id:record.id,height});
    }
    candidates.sort((a,b)=>b.height-a.height || String(a.id).localeCompare(String(b.id)));
    const selected = candidates.filter(t=>vectorIds.has(t.id)).slice(0,SPECIMEN_VECTOR_LIMIT);
    for (const candidate of candidates) {
      if (selected.includes(candidate)) continue;
      if (selected.length < SPECIMEN_VECTOR_LIMIT) selected.push(candidate);
      else {
        selected.sort((a,b)=>a.height-b.height);
        if (candidate.height > selected[0].height*1.25) selected[0] = candidate;
      }
    }
    vectorIds = new Set(selected.map(t=>t.id));
    // Motion and departing members drop directly to atlas, preserving the hard vector draw cap.
    for (const id of vectorFades.keys()) if (!vectorIds.has(id)) vectorFades.delete(id);
    // A tree that just left focus is already native vector: stay vector without a crossfade pop.
    for (const id of vectorIds) if (!vectorFades.has(id)) vectorFades.set(id,{start:handedOff.includes(id) ? -Infinity : frameNow});
    return vectorIds;
  }
  function usesVector(session) {
    const id = recordFor(session).id;
    return (focusNow.has(id) || (!frameMoving && vectorIds.has(id))) && !vectorDrawn.has(id);
  }
  function geometryFor(shape) {
    let geometry = vectorGeometry.get(shape.key);
    if (!geometry) { geometry = createSpecimenGeometry(shape,{theme}); vectorRepaints++; }
    vectorGeometry.delete(shape.key); vectorGeometry.set(shape.key,geometry);
    if (vectorGeometry.size > 24) vectorGeometry.delete(vectorGeometry.keys().next().value);
    return geometry;
  }
  function nativeSurface(bounds) {
    let x = Math.floor(bounds.x), y = Math.floor(bounds.y), right = Math.ceil(bounds.x + bounds.w), bottom = Math.ceil(bounds.y + bounds.h);
    if (frameViewport) {
      x = Math.max(x, frameViewport.x); y = Math.max(y, frameViewport.y);
      right = Math.min(right, frameViewport.x + frameViewport.w); bottom = Math.min(bottom, frameViewport.y + frameViewport.h);
    }
    if (right <= x || bottom <= y) return null;
    const width = Math.ceil((right - x) * frameRatio), height = Math.ceil((bottom - y) * frameRatio);
    const wantedWidth = Math.max(width,Math.ceil((frameViewport?.w ?? 1024)*frameRatio));
    const wantedHeight = Math.max(height,Math.ceil((frameViewport?.h ?? 1024)*frameRatio));
    if (!vectorScratch) vectorScratch = createCanvas(wantedWidth,wantedHeight);
    if (vectorScratch.width < wantedWidth) vectorScratch.width = wantedWidth;
    if (vectorScratch.height < wantedHeight) vectorScratch.height = wantedHeight;
    scratchPeakBytes = Math.max(scratchPeakBytes,vectorScratch.width*vectorScratch.height*4);
    const ctx = vectorScratch.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, width, height);
    ctx.setTransform(frameRatio, 0, 0, frameRatio, -x * frameRatio, -y * frameRatio);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    return { ctx, x, y, width, height };
  }
  /** Replay the approved geometry at native device resolution in one reusable, clipped surface.
   * The crown must finish on transparency before wood is painted behind it. This preserves
   * layer overlap, holes and source-atop highlights without erasing the forest or ground.
   */
  function drawSpecimenVector(ctx, session, origin, { zoom = origin.renderScale ?? value(scale, 1), growth = null, detail = 'tree', force = false, silhouette = false } = {}) {
    const focus = focusNow.has(recordFor(session).id);
    if (frameMoving && !focus) return draw(ctx,session,origin,zoom,growth,detail,true);
    if (!force && (!usesVector(session) || (focus ? focusDraws >= SPECIMEN_FOCUS_LIMIT : frameVectorDraws >= SPECIMEN_VECTOR_LIMIT))) return draw(ctx, session, origin, zoom, growth, detail);
    const measured = measure(session, origin, zoom, detail), record = recordFor(session), shape = shapeFor(record);
    const geometry = geometryFor(shape), b = measured.bounds;
    const fade = !force && !focus ? fadeAmount(vectorFades.get(record.id)) : 1;
    if (fade < 1) {
      ctx.save(); ctx.globalAlpha *= 1-fade; draw(ctx,session,origin,zoom,growth,detail,true); ctx.restore();
    }
    const trunk = unit(growth?.trunk ?? 1), branches = unit(growth?.branches ?? 1), crown = unit(growth?.crown ?? 1);
    const size = clamp(Number(growth?.size ?? 1) || 0, 0, 2), settled = trunk === 1 && branches === 1 && crown === 1;
    const ratio = measured.actualHeight / geometry.crop.height;
    const result = { ...measured, renderPath: 'vector', upscale: 1 };
    if (trunk <= 0 || size <= 0) return result;
    function replay(layers, uniform, amount, opacity) {
      const surface = nativeSurface({ x: measured.x + (b.x-measured.x)*uniform, y: measured.y-b.h*uniform, w: b.w*uniform, h: b.h*uniform });
      if (!surface) return;
      const c = surface.ctx;
      c.save(); c.beginPath(); c.rect(surface.x,surface.y,surface.width/frameRatio,surface.height/frameRatio); c.clip();
      // Both settled backends map the crop to the same integer destination rectangle.
      const aligned = rounded({x:measured.x+(b.x-measured.x)*uniform,y:measured.y-b.h*uniform,w:b.w*uniform,h:b.h*uniform});
      if (settled) {
        c.translate(aligned.x,aligned.y); c.scale(aligned.w/geometry.crop.width,aligned.h/geometry.crop.height);
        c.translate(-geometry.crop.x,-geometry.crop.y);
      } else {
      c.translate(measured.x, measured.y); c.scale(uniform, uniform);
      c.beginPath(); c.rect(b.x-measured.x-1, -b.h*amount, b.w+2, b.h*amount+1); c.clip();
      c.scale(ratio, ratio); c.translate(-192, -768);
      }
      for (const [layer, behind] of layers) paintSpecimenLayer(c, geometry, layer, { behind, opaqueCoverage: silhouette });
      c.restore();
      ctx.save(); ctx.globalAlpha *= (silhouette ? 1 : geometry.alpha) * opacity * fade; smooth(ctx);
      ctx.drawImage(vectorScratch, 0, 0, surface.width, surface.height, surface.x, surface.y, surface.width/frameRatio, surface.height/frameRatio);
      ctx.restore();
      // Derived from the actual transfer dimensions, including DPR (no atlas bucket involved).
      result.upscale = Math.max((surface.width/frameRatio)*frameRatio/surface.width, (surface.height/frameRatio)*frameRatio/surface.height);
    }
    if (settled) replay([['crown',false],['branches',true],['trunk',true]],size,1,1);
    else for (const [layer, amount] of [['trunk',trunk],['branches',branches],['crown',crown]]) {
      if (amount > 0) replay([[layer,false]],size*(.2+.8*(layer === 'trunk' ? trunk : Math.max(trunk,amount))),amount,layer === 'trunk' ? Math.min(1,amount*5) : amount);
    }
    // Fruit uses the same vector primitive and crown attachments as the atlas stamp.
    if (crown > 0) {
      const uniform = size*(settled ? 1 : .2+.8*Math.max(trunk,crown));
      const fruitTheme = { ...theme, canopies: [{ ...theme.canopies[0], seam: speciesPalette(shape.species, theme).l }, ...theme.canopies.slice(1)] };
      ctx.save(); ctx.globalAlpha *= (silhouette ? 1 : geometry.alpha)*crown*fade; ctx.translate(measured.x,measured.y); ctx.scale(uniform,uniform);
      ctx.beginPath(); ctx.rect(b.x-measured.x,-b.h*crown,b.w,b.h*crown+1/uniform); ctx.clip(); ctx.scale(ratio,ratio); ctx.translate(-192,-768);
      for (const p of geometry.fruit.slice(0,Math.min(5,Math.max(0,Math.floor(Number(record.fruit)||0))))) {
        ctx.save(); ctx.translate(p.x,p.y); paintSpecimenFruit(ctx,fruitTheme); ctx.restore();
      }
      ctx.restore();
    }
    vectorDraws++; if (!force) { if (focus) { focusDraws++; focusVectorDraws++; } else frameVectorDraws++; vectorDrawn.add(record.id); } frameMaxUpscale = Math.max(frameMaxUpscale,result.upscale);
    return result;
  }
  function dropGrowth(key) {
    const g = growthPages.get(key); if (!g) return;
    growthPages.delete(key); growthBytes -= g.bytes; release(g.canvas);
  }
  // Wood/crown layers are only needed while a tree grows; build them lazily and keep a few (LRU, 4 MiB).
  function growthFor(sprite) {
    const key = sprite.shape.key; let g = growthPages.get(key);
    if (g && g.sprite === sprite) { growthPages.delete(key); growthPages.set(key, g); return g; }
    dropGrowth(key);
    const meta = sprite.meta, bytesAt = r => (Math.ceil(meta.crop.width*r)+PAD*2)*2*(Math.ceil(meta.crop.height*r)+PAD*2)*2*4;
    let ratio = sprite.ratio; while (bytesAt(ratio) > GROWTH_LIMIT && ratio > .05) ratio *= .87;
    const w = Math.ceil(meta.crop.width*ratio), h = Math.ceil(meta.crop.height*ratio), bytes = bytesAt(ratio);
    while (growthBytes + bytes > GROWTH_LIMIT && growthPages.size) dropGrowth(growthPages.keys().next().value);
    const canvas = allocate((w+PAD*2)*2,(h+PAD*2)*2), ctx = canvas.getContext('2d'), geometry = vectorGeometry.get(key) || createSpecimenGeometry(sprite.shape,{theme}), cells = {};
    for (const [i,layer] of ['trunk','branches','crown'].entries()) {
      const cell = cells[layer] = { x: PAD+(i%2)*(w+PAD*2), y: PAD+Math.floor(i/2)*(h+PAD*2) };
      ctx.save(); ctx.beginPath(); ctx.rect(cell.x,cell.y,w,h); ctx.clip();
      ctx.translate(cell.x,cell.y); ctx.scale(ratio,ratio); ctx.translate(-meta.crop.x,-meta.crop.y);
      paintSpecimenLayer(ctx,geometry,layer); layerRepaints++; ctx.restore();
    }
    g = { sprite, canvas, cells, ratio, bytes }; growthPages.set(key, g); growthBytes += bytes;
    return g;
  }
  function image(ctx, sprite, layer, left, top, width, height) {
    const page = layer === 'settled' ? sprite : growthFor(sprite), cell = page.cells[layer]; rasterDraws++; smooth(ctx);
    // Fractional source extents preserve exact crop aspect despite integer allocation padding.
    ctx.drawImage(page.canvas, cell.x, cell.y, sprite.meta.crop.width * page.ratio, sprite.meta.crop.height * page.ratio, left, top, width, height);
  }
  function fruit(ctx, record, sprite, measured, growth, size) {
    const amount = Math.min(5, Math.max(0, Math.floor(Number(record.fruit) || 0)));
    if (!amount || growth <= 0) return;
    const meta = sprite.meta, ratio = measured.actualHeight / meta.crop.height;
    ctx.save(); ctx.globalAlpha *= meta.alpha * growth; ctx.translate(measured.x, measured.y); ctx.scale(size, size);
    const index = SPECIES.indexOf(sprite.shape.species); smooth(ctx);
    for (const p of meta.fruit.slice(0, amount)) {
      ctx.drawImage(fruitCanvas, index * 32, 0, 32, 48, (p.x - 192 - 8) * ratio, (p.y - 768 - 10) * ratio, 16 * ratio, 24 * ratio);
    }
    ctx.restore();
  }
  function draw(ctx, session, origin, zoom, growth, detail, atlasOnly = false) {
    const measured = measure(session, origin, zoom, detail), record = recordFor(session), shape = shapeFor(record);
    // A tree whose growth is unfolding is native from its first visible frame: never a scaled atlas raster.
    if (!atlasOnly && growth && (unit(growth.trunk ?? 1) < 1 || unit(growth.branches ?? 1) < 1 || unit(growth.crown ?? 1) < 1)) {
      growingNext.add(record.id);
      if (!focusNow.has(record.id) && focusNow.size < SPECIMEN_FOCUS_LIMIT) { focusNow.add(record.id); focusHold.add(record.id); }
    }
    if (!atlasOnly && focusNow.has(record.id) && usesVector(record) && focusDraws < SPECIMEN_FOCUS_LIMIT) {
      return drawSpecimenVector(ctx, session, origin, { zoom, growth, detail });
    }
    if (!atlasOnly && usesVector(record) && frameVectorDraws < SPECIMEN_VECTOR_LIMIT) {
      if (fadeAmount(vectorFades.get(record.id)) >= 1) {
        if (detail === 'tree') detailDraws++; else proxyDraws++;
      }
      return drawSpecimenVector(ctx, session, origin, { zoom, growth, detail });
    }
    const sprite = sprites.get(`${shape.key}:${detail}`);
    if (!sprite) { unpreparedDraws++; return measured; }
    hits++; if (!atlasOnly) { if (detail === 'tree') detailDraws++; else proxyDraws++; }
    const trunk = unit(growth?.trunk ?? 1), branches = unit(growth?.branches ?? 1), crown = unit(growth?.crown ?? 1);
    const size = clamp(Number(growth?.size ?? 1) || 0, 0, 2);
    if (trunk <= 0 || size <= 0) return measured;
    const b = measured.bounds, localLeft = b.x - measured.x;
    ctx.save(); ctx.globalAlpha *= sprite.meta.alpha; ctx.translate(measured.x, measured.y);
    if (trunk === 1 && branches === 1 && crown === 1) {
      const aligned = rounded({x:measured.x+localLeft*size,y:measured.y-b.h*size,w:b.w*size,h:b.h*size});
      image(ctx,sprite,'settled',aligned.x-measured.x,aligned.y-measured.y,aligned.w,aligned.h);
    } else {
      for (const [layer, amount] of [['trunk', trunk], ['branches', branches], ['crown', crown]]) {
        if (amount <= 0) continue;
        ctx.save(); const uniform = size * (.2 + .8 * (layer === 'trunk' ? trunk : Math.max(trunk, amount)));
        ctx.scale(uniform, uniform); ctx.globalAlpha *= layer === 'trunk' ? Math.min(1, amount * 5) : amount;
        ctx.beginPath(); ctx.rect(localLeft - 1, -b.h * amount, b.w + 2, b.h * amount + 1); ctx.clip();
        image(ctx, sprite, layer, localLeft, -b.h, b.w, b.h); ctx.restore();
      }
    }
    ctx.restore();
    // Crown fruit follows the same uniform scale and bottom-up reveal as its parent crown.
    if (crown > 0) {
      const fruitSize = size * (trunk === 1 && branches === 1 && crown === 1 ? 1 : .2 + .8 * Math.max(trunk, crown));
      ctx.save(); ctx.beginPath(); ctx.rect(measured.x + localLeft * fruitSize, measured.y - b.h * crown * fruitSize, b.w * fruitSize, b.h * crown * fruitSize + 1); ctx.clip();
      fruit(ctx, record, sprite, measured, crown, fruitSize); ctx.restore();
    }
    return measured;
  }
  function shadow(ctx, session, origin, growth) {
    const measured = measure(session, origin, origin.renderScale ?? value(scale, 1));
    const amount = unit(growth?.trunk ?? 1) * unit(growth?.size ?? 1);
    if (amount > 0) {
      ctx.save(); ctx.globalAlpha *= amount;
      const paint = shadowPainter || globalThis.SpecimenEnvironment?.drawShadowPool;
      paint?.(ctx, measured.x, measured.y, measured.bounds.w * .32, { seed: session.id, opacity: 1 });
      ctx.restore();
    }
    return measured;
  }
  function highlight(ctx, session, origin, selected = false) {
    const detail = origin.bounds?.detail === 'symbol' ? 'symbol' : 'tree';
    const measured = measure(session, origin, origin.renderScale ?? value(scale, 1), detail), record = recordFor(session);
    const shape = shapeFor(record), sprite = sprites.get(`${shape.key}:${detail}`);
    if (!sprite) return measured;
    const key = `${sprite.key}:${selected ? 1 : 0}`;
    let cached = highlights.get(key);
    if (!cached) {
      if (highlights.size === 2) {
        const oldest = highlights.keys().next().value, entry = highlights.get(oldest);
        highlightBytes -= entry.canvas.width * entry.canvas.height * 4; release(entry.canvas); highlights.delete(oldest);
      }
      const factor = Math.min(1, 512 / Math.max(sprite.w, sprite.h));
      const w = Math.max(1, Math.ceil(sprite.w * factor)), h = Math.max(1, Math.ceil(sprite.h * factor));
      const canvas = allocate(w, h), effect = canvas.getContext('2d');
      image(effect, sprite, 'settled', 0, 0, w, h);
      effect.globalCompositeOperation = 'source-in'; effect.fillStyle = selected ? theme.accent : theme.ink; effect.fillRect(0, 0, w, h);
      cached = { canvas }; highlightRepaints++; highlights.set(key, cached); highlightBytes += w * h * 4;
    }
    ctx.save(); ctx.globalAlpha *= selected ? .27 : .17;
    smooth(ctx); ctx.drawImage(cached.canvas, measured.bounds.x, measured.bounds.y, measured.bounds.w, measured.bounds.h); ctx.restore();
    return measured;
  }
  /** Hover is an independent native overlay. Settled forest pixels and native frame slots stay unchanged. */
  function drawHover(ctx, records, { now = performance.now(), zoom = value(scale,1), dpr: ratio = value(dpr,1),
    viewport = null, generation = 0, opacityFor = tree => tree.opacity ?? 1, growthFor = () => null, paintMasked = (c,t,b,paint) => paint(c) } = {}) {
    const state = hoverState(now), drawnIds = [], nativeIds = [];
    let growthFading = false;
    const previousRatio = frameRatio, previousViewport = frameViewport;
    frameRatio = ratio;
    const quantize = n => 2 ** (Math.round(Math.log2(n)*16)/16);
    const paintRatio = quantize(ratio), paintZoom = quantize(zoom);
    frameRatio = paintRatio;
    const overlaps = (a,b) => a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;
    try {
      for (const entry of state.entries) {
        const index = records.findIndex(t=>t.s.id===entry.id), tree = records[index];
        if (!tree || entry.opacity <= 0) continue;
        const growth = growthFor(tree), growing = growth?.active || (growth?.crown ?? 1)<1;
        let image = hoverImages.get(entry.id);
        if (growing && !image) { hoverGrowing.add(entry.id); continue; }
        const measured = measure(tree.s,tree.screen,paintZoom), pad = 3/Math.max(.01,paintRatio/value(dpr,1));
        const b = measured.bounds;
        const left = Math.max(viewport?.x ?? -Infinity, Math.floor(b.x-pad)), top = Math.max(viewport?.y ?? -Infinity, Math.floor(b.y-pad));
        const right = Math.min(viewport ? viewport.x+viewport.w : Infinity, Math.ceil(b.x+b.w+pad));
        const bottom = Math.min(viewport ? viewport.y+viewport.h : Infinity, Math.ceil(b.y+b.h+pad));
        if (right<=left || bottom<=top) continue;
        const bounds = {x:left,y:top,w:right-left,h:bottom-top}, width=Math.ceil(bounds.w*paintRatio), height=Math.ceil(bounds.h*paintRatio);
        const key = [generation,paintZoom,paintRatio,left,top,width,height,recordFor(tree.s).visualKey].join('|');
        const version = t => {
          const g = growthFor(t);
          return [opacityFor(t),g?.trunk,g?.branches,g?.crown,g?.size,t.screen.x,t.screen.y,recordFor(t.s).visualKey].join(',');
        };
        const current = dependency => records[dependency.index]?.s.id === dependency.id ? records[dependency.index] : records.find(t=>t.s.id===dependency.id);
        const valid = image && image.key === key && image.dependencies.every(d=>{
          const t = current(d); return t && version(t) === d.version;
        });
        if (!growing && !valid) {
          const previousImage = image;
          const canvas=takeHover(width,height), c=canvas.getContext('2d'), body=takeHover(width,height), bodyArt=body.getContext('2d');
          const setup = art => { art.setTransform(paintRatio,0,0,paintRatio,-left*paintRatio,-top*paintRatio); art.globalAlpha=1; art.globalCompositeOperation='source-over'; };
          frameViewport=bounds;
          // Keep only geometry owned by the regular forest preparation. Hover cannot grow that cache.
          const replay = (art,t,silhouette=false) => {
            const shape=shapeFor(recordFor(t.s)), had=vectorGeometry.has(shape.key);
            drawSpecimenVector(art,t.s,t.screen,{zoom:paintZoom,force:true,silhouette,growth:growthFor(t)});
            if(!had)vectorGeometry.delete(shape.key);
          };
          setup(bodyArt); replay(bodyArt,tree,true); setup(c);
          // Dilate native alpha by a thin screen-space rim. No atlas texture or rectangle is used.
          const rim=1.15*value(dpr,1)/paintRatio;
          for(let n=0;n<8;n++){const angle=n*Math.PI/4;c.drawImage(body,0,0,width,height,left+Math.cos(angle)*rim,top+Math.sin(angle)*rim,bounds.w,bounds.h);}
          c.globalCompositeOperation='source-in';c.fillStyle=theme.ink;c.fillRect(left,top,bounds.w,bounds.h);
          c.globalCompositeOperation='destination-out';c.drawImage(body,0,0,width,height,left,top,bounds.w,bounds.h);
          bodyArt.setTransform(1,0,0,1,0,0);bodyArt.clearRect(0,0,width,height);setup(bodyArt);replay(bodyArt,tree);
          c.globalCompositeOperation='source-over';c.globalAlpha=.28;c.drawImage(body,0,0,width,height,left,top,bounds.w,bounds.h);c.globalAlpha=1;
          returnHover(body);
          // Isolate hill masking before erasing foreground trees, including their own hill masks.
          const masked=takeHover(width,height), maskedArt=masked.getContext('2d');setup(maskedArt);
          paintMasked(maskedArt,tree,bounds,layer=>layer.drawImage(canvas,0,0,width,height,left,top,bounds.w,bounds.h));
          returnHover(canvas);
          const dependencies = [{id:tree.s.id,index,version:version(tree)}];
          for(let frontIndex=index+1;frontIndex<records.length;frontIndex++) {
            const front = records[frontIndex];
            if(!overlaps(bounds,measure(front.s,front.screen,paintZoom).bounds))continue;
            dependencies.push({id:front.s.id,index:frontIndex,version:version(front)});
            maskedArt.save();maskedArt.globalCompositeOperation='destination-out';maskedArt.globalAlpha*=opacityFor(front);
            paintMasked(maskedArt,front,bounds,layer=>replay(layer,front));maskedArt.restore();
          }
          image={canvas:masked,key,dependencies,bounds,width,height,zoom:paintZoom,
            growthTrack:previousImage?.growthTrack || {from:hoverGrowing.has(entry.id)?0:1,to:1,start:now}};
          hoverGrowing.delete(entry.id);
          hoverImages.set(entry.id,image); hoverBuilds++;
          if (previousImage) returnHover(previousImage.canvas);
        }
        const target = growing ? 0 : 1;
        if (image.growthTrack.to !== target) image.growthTrack = {from:hoverAmount(image.growthTrack,now),to:target,start:now};
        const growthAlpha = hoverAmount(image.growthTrack,now);
        growthFading ||= now-image.growthTrack.start < 120 && image.growthTrack.from !== image.growthTrack.to;
        if (growthAlpha <= 0) continue;
        ctx.save();ctx.globalAlpha*=entry.opacity*opacityFor(tree)*growthAlpha;smooth(ctx);
        const delta = zoom/image.zoom;
        ctx.drawImage(image.canvas,0,0,image.width,image.height,
          tree.screen.x+(image.bounds.x-tree.screen.x)*delta,tree.screen.y+(image.bounds.y-tree.screen.y)*delta,
          image.bounds.w*delta,image.bounds.h*delta);ctx.restore();
        drawnIds.push(entry.id);nativeIds.push(entry.id);
      }
    } finally {frameRatio=previousRatio;frameViewport=previousViewport;}
    return {drawnIds,nativeIds,neighborOpacity:1,upscale:1,active:state.active || growthFading};
  }
  function stats() {
    return { bytes: pageBytes + growthBytes + (fruitCanvas ? FRUIT_BYTES : 0) + highlightBytes, limit: LIMIT, pageBytes, growthBytes,
      fruitBytes: fruitCanvas ? FRUIT_BYTES : 0, highlightBytes, scratchBytes: vectorScratch ? vectorScratch.width * vectorScratch.height * 4 : 0, scratchPeakBytes,
      hoverBuilds, hoverPoolHits, hoverPoolBytes,
      hoverBytes: [...hoverImages.values()].reduce((n,image)=>n+image.canvas.width*image.canvas.height*4,0), hoverEntries: hoverImages.size,
      pendingRasters: pendingRasters.size, incrementalRasters, vectorFading: [...vectorFades.values()].some(f=>fadeAmount(f)<1),
      vectorLimit: SPECIMEN_VECTOR_LIMIT, vectorDraws, frameVectorDraws, focusVectorDraws, focusLimit: SPECIMEN_FOCUS_LIMIT, focusCount: focusNow.size, frameMaxUpscale, vectorRepaints, vectorGeometryEntries: vectorGeometry.size,
      pages: pages.length, entries: sprites.size, visualEntries: visualBindings.size, geometryEntries: metadata.size, preparedRecords,
      rasterFactor, dpr: activeRatio, rasterAllocations, layerRepaints, rasterDraws, highlightRepaints, hits, misses, proceduralRepaints, preparations, detailDraws, proxyDraws, unpreparedDraws };
  }
  return { prepare, pump, beginFrame, usesVector, drawSpecimenVector, setHovered, hoverState, drawHover,
    tree: (ctx, session, origin, growth, fullDetail = true) => draw(ctx, session, origin, origin.renderScale ?? value(scale, 1), growth, fullDetail ? 'tree' : 'symbol'),
    symbol: (ctx, session, origin, zoom, growth) => draw(ctx, session, origin, zoom, growth, 'symbol'),
    settledBounds: (session, origin, zoom) => measure(session, origin, zoom),
    symbolBounds: (session, origin, zoom) => measure(session, origin, zoom, 'symbol'),
    shadow, highlight,
    profile(id) { const record = recordFor(id), shape = shapeFor(record), meta = metrics(shape); return { family: shape.species, species: shape.species, root: meta.root, aspect: meta.aspect, height: meta.height, palette: speciesPalette(shape.species, theme), visualKey: record.visualKey }; },
    clear() { for(const pool of hoverPool.values())for(const canvas of pool)release(canvas);hoverPool.clear();hoverPoolBytes=0;for(const image of hoverImages.values())release(image.canvas);hoverImages.clear();hoverTracks.clear();hoverGrowing.clear();hoveredId=null;if (vectorScratch) release(vectorScratch); vectorScratch = null; vectorGeometry.clear(); vectorIds.clear(); vectorFades.clear(); focusNow = new Set(); growingSeen = new Set(); growingNext = new Set(); focusHold = new Set(); pendingRasters.clear(); vectorDrawn.clear(); clearRasters(); metadata.clear(); retainedDemand.clear(); visualBindings.clear(); preparedRecords = 0; frameStarted = frameMoving = rasterMoving = false; }, stats,
  };
}
