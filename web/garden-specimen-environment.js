import './specimen-environment.js';

// Screen caches belong to one camera basis. Water lives in WORLD space: terrain.waterRing (an annulus built
// from the island footprint alone) plus a fixed lattice whose iso-lines drift with time (see waterContours in
// specimen-environment.js). Zoom, yaw and pan only re-project those world segments; they never re-sample the field.
// The water is painted UNDER the base layer (canvas-garden calls drawWater before the base image; the hill base
// leaves the annulus transparent), cached as one bitmap per 100 ms step, plus a static shore bitmap (gravel, reeds).
// The adapter also prepares decorative ground/flower marks and one overscanned static bitmap.
function environmentBox(points) {
  return { x: Math.min(...points.map(p => p.x)), y: Math.min(...points.map(p => p.y)),
    right: Math.max(...points.map(p => p.x)), bottom: Math.max(...points.map(p => p.y)) };
}
function environmentCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = width; c.height = height; return c; }
  return null;
}

// Hash projected content because the plot surface creates a fresh view on each rebuild.
function environmentHillSignature(view, art) {
  if (view?.key !== undefined) return view.key;
  let hash = 2166136261;
  const add = n => { hash = Math.imul(hash ^ n, 16777619); };
  add(view?.faces?.length ?? 0);
  for (const face of view?.faces ?? []) {
    add(art.seedNumber(face.plotId)); add(art.seedNumber(String(face.opacity))); add(face.points.length);
    for (const p of face.points) { add(Math.round(p.x * 8)); add(Math.round(p.y * 8)); add(Math.round(p.depth * 8)); }
  }
  return hash >>> 0;
}
const WATER_STEP_MS = 100;
// Rings arrive by structured clone from the terrain worker, so identity is useless: hash the geometry.
function environmentRingSignature(ring) {
  if (!ring?.outer?.length) return '';
  let hash = 2166136261;
  const add = n => { hash = Math.imul(hash ^ Math.round(n * 4), 16777619); };
  add(ring.count);
  for (let i = 0; i < ring.outer.length; i += 4) { add(ring.outer[i].x); add(ring.outer[i].y); add(ring.inner[i].x); add(ring.inner[i].y); }
  return String(hash >>> 0);
}
const smooth01 = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// World-space shore marks: stable positions and ranks; zoom only decides which ranks are drawn.
function environmentShoreMarks(art, ring, seed) {
  const { inner, outer, count } = ring, gravel = [], reeds = [];
  const width = Math.max(...outer.map((p, i) => Math.hypot(p.x - inner[i].x, p.y - inner[i].y)));
  const at = (i, t, f) => {
    const a = i % count, b = (i + 1) % count;
    const ox = outer[a].x + (outer[b].x - outer[a].x) * t, oy = outer[a].y + (outer[b].y - outer[a].y) * t;
    const ix = inner[a].x + (inner[b].x - inner[a].x) * t, iy = inner[a].y + (inner[b].y - inner[a].y) * t;
    return { x: ox + (ix - ox) * f, y: oy + (iy - oy) * f };
  };
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 18; k++) {
      const h = n => art.hash2(i * 31 + k, n, seed);
      const v = h(2), point = at(i, h(1), v * v * .12);
      gravel.push({ ...point, rank: h(3), size: (.7 + h(4) * .6) * width / 210, seed: Math.floor(h(5) * 1e9) });
    }
    if (art.hash2(i, 91, seed) < .085) {
      const base = at(i, art.hash2(i, 92, seed), .03 + art.hash2(i, 93, seed) * .07), n = 6 + Math.floor(art.hash2(i, 94, seed) * 9);
      for (let k = 0; k < n; k++) {
        const h = m => art.hash2(i * 17 + k, m, seed + 5);
        reeds.push({ x: base.x + (h(1) - .5) * width / 6, y: base.y + (h(2) - .5) * width / 6, rank: (k + h(3)) / n, seed: Math.floor(h(4) * 1e9) });
      }
    }
  }
  return { gravel, reeds, width };
}
function environmentAffine(before, after, width, height) {
  const [o, px, py] = before, [n, nx, ny] = after;
  const ax = px.x - o.x, ay = px.y - o.y, bx = py.x - o.x, by = py.y - o.y;
  const det = ax * by - ay * bx;
  if (Math.abs(det) < 1e-12) return null;
  const cx = nx.x - n.x, cy = nx.y - n.y, dx = ny.x - n.x, dy = ny.y - n.y;
  const a = (cx * by - dx * ay) / det, b = (cy * by - dy * ay) / det;
  const c = (dx * ax - cx * bx) / det, d = (dy * ax - cy * bx) / det;
  const scale = Math.sqrt(Math.abs(a * d - b * c));
  if (scale < .8 || scale > 1.25 || Math.hypot(a - scale, b, c, d - scale) / (scale * Math.SQRT2) >= .08) return null;
  const tx = n.x - a * o.x - c * o.y, ty = n.y - b * o.x - d * o.y;
  const mx = width * .25, my = height * .25;
  let polygon = [[-mx, -my], [width + mx, -my], [width + mx, height + my], [-mx, height + my]].map(([x, y]) => ({ x: a * x + c * y + tx, y: b * x + d * y + ty }));
  // Clip the transformed expanded region to the current viewport, then measure its exact area.
  for (const [axis, edge, sign] of [['x', 0, 1], ['x', width, -1], ['y', 0, 1], ['y', height, -1]]) {
    const clipped = [];
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i], q = polygon[(i + 1) % polygon.length];
      const pin = (p[axis] - edge) * sign >= 0, qin = (q[axis] - edge) * sign >= 0;
      if (pin) clipped.push(p);
      if (pin !== qin) { const t = (edge - p[axis]) / (q[axis] - p[axis]); clipped.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) }); }
    }
    polygon = clipped;
  }
  const area = Math.abs(polygon.reduce((sum, p, i) => { const q = polygon[(i + 1) % polygon.length]; return sum + p.x * q.y - p.y * q.x; }, 0)) / 2;
  return area >= width * height * .95 ? [a, b, c, d, tx, ty] : null;
}

/** Prepared static ground marks; all coordinates are CSS pixels. `drawWater` stays as a no-op for callers. */
export function createGardenSpecimenEnvironment({ theme = {}, seed = 483765 } = {}) {
  const art = globalThis.SpecimenEnvironment;
  let previous = null, staticCanvas = null, waterCanvas = null, shoreCanvas = null;
  // World-space water caches, keyed by ring signature: basin lattice, per-step contours, shore marks.
  let waterWorld = null;
  const rendered = { view: null, step: -1, shore: null };
  const canvasAvailable = typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined';
  const counters = { preparations: 0, cacheHits: 0, waterDraws: 0, staticDraws: 0, maskBuilds: 0, staticRenders: 0, waterRenders: 0, shoreRenders: 0, movingReuses: 0 };
  function prepare({ layout, contourGeometry, terrain, plotHillView, project, camera = {}, width, height, dpr = 1, moving = false }) {
    // A function identity is insufficient: the garden projector closes over mutable camera state.
    const basis = [project(0, 0, 0), project(1, 0, 0), project(0, 1, 0), project(0, 0, 1)];
    const key = [width, height, dpr, ...basis.flatMap(p => [p.x, p.y])].join('/');
    const ring = terrain?.waterRing?.outer?.length ? terrain.waterRing : null, ringSignature = environmentRingSignature(ring);
    // A worker terrain swap only matters when the water ring itself changed (compared by content).
    const sameGeometry = previous && previous.layout === layout && previous.contourGeometry === contourGeometry && previous.ringSignature === ringSignature;
    if (moving && sameGeometry && previous.width === width && previous.height === height && previous.dpr === dpr) {
      const affine = environmentAffine(previous.basis, basis, width, height);
      if (affine) {
        counters.movingReuses++;
        const base = previous.view;
        return { ...base,
          drawStatic(ctx, opts) { ctx.save(); ctx.transform(...affine); base.drawStatic(ctx, { ...opts, moving: true }); ctx.restore(); },
          drawWater(ctx, time, opts) { ctx.save(); ctx.transform(...affine); base.drawWater(ctx, time, { ...opts, moving: true }); ctx.restore(); } };
      }
    }
    const hillSignature = environmentHillSignature(plotHillView, art);
    if (sameGeometry && previous.key === key && previous.hillSignature === hillSignature) { counters.cacheHits++; return previous.view; }
    counters.preparations++;
    const [o, px, py, pz] = basis;
    const zoom = Math.max(1e-12, Math.hypot(pz.x - o.x, pz.y - o.y) || Math.hypot(px.x - o.x, px.y - o.y));
    const mx = width * .25, my = height * .25, regionWidth = width + 2 * mx, regionHeight = height + 2 * my;
    const inViewport = (x, y) => x >= 0 && y >= 0 && x < width && y < height;
    const ratio = Math.min(Math.max(.1, dpr), 2048 / Math.max(1, regionWidth, regionHeight));
    const pixelWidth = Math.max(1, Math.min(2048, Math.ceil(regionWidth * ratio))), pixelHeight = Math.max(1, Math.min(2048, Math.ceil(regionHeight * ratio)));
    function resize(canvas) {
      if (!canvas) return;
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    }
    resize(staticCanvas);
    const waterMask = { canvas: null, width, height, ratio: 1, contains() { return false; } };
    // `margin` holds ground marks in the overscan ring so a reused bitmap has no empty pan edges.
    const marks = { ground: [], margin: [], flowers: [], shore: [], reeds: [] };
    let samples = 0;
    // A world-aligned power-of-two spacing only changes when detail demand changes.
    const step = 12 * 2 ** Math.max(0, Math.ceil(Math.log2(2 / Math.max(1e-12, zoom * 12))));
    const sampleCap = 9000, marginCap = 1200;
    for (const plot of layout?.plots ?? []) {
      if (!plotHillView || samples >= sampleCap || (marks.ground.length >= 1600 && marks.margin.length >= marginCap)) break;
      if (!plot.polygon?.length || !(plotHillView.faces ?? []).some(face => face.plotId === plot.id)) continue;
      const box = environmentBox(plot.polygon), plotSeed = art.seedNumber(`${seed}/${plot.id}`);
      // Restrict samples to the projected overscanned region before evaluating terrain heights.
      const determinant = (px.x - o.x) * (py.y - o.y) - (py.x - o.x) * (px.y - o.y);
      let sampleBox = box;
      if (Math.abs(determinant) > 1e-30) {
        const points = [];
        const peak = Math.sqrt(Math.abs(plot.area || (box.right - box.x) * (box.bottom - box.y))) * .7 + 2 + (plot.lift || 0);
        for (const z of [0, peak]) for (const x of [-mx - 24, width + mx + 24]) for (const y of [-my - 32, height + my + 32]) {
          const sx = x - o.x - z * (pz.x - o.x), sy = y - o.y - z * (pz.y - o.y);
          points.push({ x: (sx * (py.y - o.y) - sy * (py.x - o.x)) / determinant,
            y: (sy * (px.x - o.x) - sx * (px.y - o.y)) / determinant });
        }
        const viewBox = environmentBox(points);
        sampleBox = { x: Math.max(box.x, viewBox.x), y: Math.max(box.y, viewBox.y), right: Math.min(box.right, viewBox.right), bottom: Math.min(box.bottom, viewBox.bottom) };
      }
      for (let ix = Math.ceil(sampleBox.x / step); ix * step < sampleBox.right && samples < sampleCap; ix++) {
        for (let iy = Math.ceil(sampleBox.y / step); iy * step < sampleBox.bottom && samples < sampleCap; iy++) {
          samples++;
          const random = art.hash2(ix, iy, plotSeed);
          if (random > .68) continue;
          const x = (ix + .2 + art.hash2(ix, iy, plotSeed + 29) * .6) * step;
          const y = (iy + .2 + art.hash2(ix, iy, plotSeed + 47) * .6) * step;
          const root = plotHillView.surfacePoint(plot.id, x, y);
          if (!root) continue;
          const inside = inViewport(root.x, root.y);
          // The plot depth field covers only the viewport, so margin marks are placed without occlusion tests.
          if (inside ? !root.visible || marks.ground.length >= 1600 : root.x < -mx || root.y < -my || root.x >= width + mx || root.y >= height + my || marks.margin.length >= marginCap) continue;
          const mark = { ...root, seed: art.seedNumber(`${plotSeed}/${ix}/${iy}`), size: random < .3 ? 1.6 : .75,
            variant: random < .3 ? 'lawn' : 'meadow', opacity: root.opacity * .38 };
          (inside ? marks.ground : marks.margin).push(mark);
          // Low-frequency noise forms decorative drifts, unrelated to session metrics.
          if (inside && marks.flowers.length < 64 && random < .1 && art.smoothNoise(x / 70, y / 70, plotSeed) > .55 && zoom > .2) {
            marks.flowers.push({ ...mark, size: Math.min(1.2, zoom), opacity: root.opacity * .7 });
          }
        }
      }
    }
    // ---- world-anchored water --------------------------------------------------------------
    function createWater(ring, baseZ) {
      const ax = px.x - o.x, ay = px.y - o.y, bx = py.x - o.x, by = py.y - o.y;
      const ox = o.x + baseZ * (pz.x - o.x), oy = o.y + baseZ * (pz.y - o.y);
      const screenX = (x, y) => ox + x * ax + y * bx, screenY = (x, y) => oy + x * ay + y * by;
      const areaScale = Math.sqrt(Math.abs(ax * by - ay * bx));
      const canvasRatio = Math.min(Math.max(.1, dpr), 2560 / Math.max(1, width, height));
      const waterWidth = Math.max(1, Math.ceil(width * canvasRatio)), waterHeight = Math.max(1, Math.ceil(height * canvasRatio));
      const world = () => {
        if (waterWorld?.signature !== ringSignature) {
          waterWorld = { signature: ringSignature, basin: art.buildWaterBasin(ring), contours: new Map(), shore: environmentShoreMarks(art, ring, seed) };
        }
        return waterWorld;
      };
      const contoursFor = step => {
        const w = world();
        let hit = w.contours.get(step);
        if (!hit) {
          hit = art.waterContours(w.basin, step * WATER_STEP_MS / 1000, { seed });
          w.contours.set(step, hit); if (w.contours.size > 3) w.contours.delete(w.contours.keys().next().value);
        }
        return hit;
      };
      const tracePolygon = (ctx, points) => {
        points.forEach((p, i) => i ? ctx.lineTo(screenX(p.x, p.y), screenY(p.x, p.y)) : ctx.moveTo(screenX(p.x, p.y), screenY(p.x, p.y)));
        ctx.closePath();
      };
      const sizePx = () => world().basin.size * areaScale;
      function paintWater(ctx, step) {
        const deep = theme.lots?.[1] ?? '#293D52', mid = theme.lots?.[3] ?? '#343B52';
        let fill = mid;
        if (ctx.createLinearGradient) {
          const gradient = ctx.createLinearGradient(0, 0, 0, height);
          gradient.addColorStop(0, deep); gradient.addColorStop(.5, mid); gradient.addColorStop(1, deep);
          fill = gradient;
        }
        const annulus = () => { ctx.beginPath(); tracePolygon(ctx, ring.outer); tracePolygon(ctx, ring.inner); };
        ctx.globalAlpha = 1; ctx.fillStyle = fill; ctx.strokeStyle = fill; ctx.lineWidth = 3; ctx.lineJoin = 'round';
        // The stroke bleeds under the opaque hills and island so the transparent hole never shows a seam.
        annulus(); ctx.fill('evenodd'); ctx.stroke();
        const { levels } = contoursFor(step), fade = smooth01(150, 420, sizePx());
        ctx.save(); annulus(); ctx.clip('evenodd');
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const left = -8, top = -8, right = width + 8, bottom = height + 8;
        for (const major of [false, true]) {
          const alpha = major ? .5 * (.55 + .45 * fade) : .3 * fade;
          if (alpha < .01) continue;
          ctx.globalAlpha = alpha; ctx.strokeStyle = major ? '#A9B9EA' : '#8195CF'; ctx.lineWidth = major ? .95 : .7;
          ctx.beginPath();
          levels.forEach((list, level) => {
            if ((level % 4 === 0) !== major) return;
            for (let i = 0; i < list.length; i += 4) {
              const x1 = screenX(list[i], list[i + 1]), y1 = screenY(list[i], list[i + 1]), x2 = screenX(list[i + 2], list[i + 3]), y2 = screenY(list[i + 2], list[i + 3]);
              if ((x1 < left && x2 < left) || (x1 > right && x2 > right) || (y1 < top && y2 < top) || (y1 > bottom && y2 > bottom)) continue;
              ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
            }
          });
          ctx.stroke();
        }
        ctx.restore();
        counters.waterRenders++;
      }
      function paintShore(ctx) {
        const { gravel, reeds, width: ringWidth } = world().shore, zoom = areaScale;
        const pebbleSize = ringWidth / 210 * zoom;
        // Keep-fraction changes only at power-of-two steps, so nothing shimmers while zooming.
        const keep = 2 ** -Math.min(6, Math.max(0, Math.floor(-Math.log2(Math.min(1, Math.max(1 / 64, (pebbleSize / 1.3) ** 2))))));
        const pebbles = [];
        for (const g of gravel) {
          if (g.rank >= keep) continue;
          const x = screenX(g.x, g.y), y = screenY(g.x, g.y);
          if (x < -4 || y < -4 || x > width + 4 || y > height + 4) continue;
          pebbles.push({ x, y, seed: g.seed, size: Math.max(.9, Math.min(2.3, g.size * zoom)), opacity: .5 });
        }
        // Two batched strokes (grey stones, a few lavender ones) instead of one stroke per pebble.
        ctx.save(); ctx.lineWidth = .65; ctx.lineCap = 'round';
        const palette = art.environmentPalette(theme);
        for (const lavender of [false, true]) {
          ctx.globalAlpha = lavender ? .38 : .5; ctx.strokeStyle = lavender ? palette.lavender : '#A9B2B8'; ctx.beginPath();
          for (const p of pebbles) {
            if ((p.seed % 5 === 0) !== lavender) continue;
            const turn = (p.seed % 997) / 997 * .8 - .4, c = Math.cos(turn), n = Math.sin(turn);
            ctx.moveTo(p.x + p.size * c, p.y + p.size * n); ctx.ellipse(p.x, p.y, p.size, p.size * .6, turn, 0, Math.PI * 2);
          }
          ctx.stroke();
        }
        ctx.restore();
        const reedSize = Math.min(1.5, ringWidth / 700 * zoom);
        if (reedSize >= .55) {
          const blades = [];
          for (const r of reeds) {
            const x = screenX(r.x, r.y), y = screenY(r.x, r.y);
            if (x < -20 || y < -30 || x > width + 20 || y > height + 30) continue;
            blades.push({ x, y, seed: r.seed, size: reedSize, opacity: .8 });
          }
          art.drawReedMarks(ctx, blades, { theme, alpha: .85 });
        }
        counters.shoreRenders++;
      }
      function target(which) {
        const canvas = which === 'water' ? waterCanvas : shoreCanvas;
        const fresh = canvas ?? environmentCanvas(waterWidth, waterHeight);
        if (!fresh) return null;
        if (fresh.width !== waterWidth) fresh.width = waterWidth;
        if (fresh.height !== waterHeight) fresh.height = waterHeight;
        if (which === 'water') waterCanvas = fresh; else shoreCanvas = fresh;
        const ctx = fresh.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, waterWidth, waterHeight);
        ctx.setTransform(canvasRatio, 0, 0, canvasRatio, 0, 0);
        return { canvas: fresh, ctx };
      }
      return { draw(ctx, timeMs, opts) {
        counters.waterDraws++;
        const step = Math.floor((Number.isFinite(timeMs) ? timeMs : 0) / WATER_STEP_MS);
        if (!canvasAvailable) { ctx.save(); paintWater(ctx, step); ctx.restore(); ctx.save(); paintShore(ctx); ctx.restore(); return; }
        // While the camera moves, a bitmap that already belongs to this view is reused instead of re-rendered.
        const stale = rendered.view === view && rendered.step !== step;
        if (rendered.view !== view || (stale && !opts.moving)) {
          const t = target('water');
          if (!t) return;
          paintWater(t.ctx, step); rendered.step = step;
          if (rendered.view !== view || rendered.shore !== view) { const s = target('shore'); paintShore(s.ctx); rendered.shore = view; }
          rendered.view = view;
        }
        ctx.drawImage(waterCanvas, 0, 0, waterWidth, waterHeight, 0, 0, width, height);
        ctx.drawImage(shoreCanvas, 0, 0, waterWidth, waterHeight, 0, 0, width, height);
      } };
    }
    function paintCategory(ctx, list, painter, kind) {
      const batch = [], partial = [], flower = kind === 'flowers';
      for (const mark of list) {
        const radius = flower ? 7 : 3, top = flower ? 23 : 3;
        let total = 0, visible = 0;
        const runs = [];
        for (let y = Math.floor(mark.y - top); y <= mark.y + (flower ? 2 : 3); y += 2) {
          let start = null, end = 0;
          for (let x = Math.floor(mark.x - radius); x <= mark.x + radius; x += 2) {
            const inside = inViewport(x + 1, y + 1);
            // Flowers stay clipped to the viewport; ground probes outside it (overscan) are unoccluded.
            const allowed = flower ? inside && plotHillView.decorationVisible(x + 1, y + 1, mark.depth)
              : !inside || !!plotHillView?.surfaceVisible(x + 1, y + 1, mark.depth);
            total++;
            if (allowed) { visible++; if (start === null) start = x; end = x + 2; }
            else if (start !== null) { runs.push([start, y, end - start, 2]); start = null; }
          }
          if (start !== null) runs.push([start, y, end - start, 2]);
        }
        if (visible === total) batch.push(mark);
        else if (visible) partial.push({ mark, runs });
      }
      if (batch.length) painter(ctx, batch, { theme });
      for (const { mark, runs } of partial) {
        ctx.save(); ctx.beginPath(); for (const run of runs) ctx.rect(...run);
        ctx.clip(); painter(ctx, [mark], { theme }); ctx.restore();
      }
    }
    function paintMarks(ctx) {
      paintCategory(ctx, marks.ground.concat(marks.margin), art.drawGroundMarks, 'ground');
      paintCategory(ctx, marks.flowers, art.drawFlowerMarks, 'flowers');
    }
    let staticReady = false;
    function renderStatic() {
      if (!staticCanvas) staticCanvas = environmentCanvas(pixelWidth, pixelHeight);
      resize(staticCanvas);
      const ctx = staticCanvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, pixelWidth, pixelHeight);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.setTransform(ratio, 0, 0, ratio, mx * ratio, my * ratio); paintMarks(ctx);
      staticReady = true; counters.staticRenders++;
    }
    const water = ring ? createWater(ring, terrain.baseZ ?? 0) : null;
    const view = { waterMask, marks, wetPolygons: [], shoreSegments: [], animating: !!water, waterStepMs: water ? WATER_STEP_MS : 0,
      drawStatic(ctx) {
        counters.staticDraws++;
        if (!marks.ground.length && !marks.margin.length && !marks.flowers.length) return;
        if (!canvasAvailable) { paintMarks(ctx); return; }
        if (!staticReady) renderStatic();
        ctx.drawImage(staticCanvas, 0, 0, pixelWidth, pixelHeight, -mx, -my, regionWidth, regionHeight);
      },
      drawWater(ctx, timeMs = 0, opts = {}) { if (water) water.draw(ctx, timeMs, opts); } };
    previous = { key, layout, contourGeometry, terrain, ringSignature, hillSignature, basis, width, height, dpr, view, samples, shoreSamples: 0 };
    return view;
  }
  return { prepare,
    drawPaper(ctx, { width, height, dpr = 1 }) { art.drawPaperGrain(ctx, { x: 0, y: 0, w: width, h: height }, { seed, theme, alpha: .4, dpr }); },
    stats() { return { ...counters, views: previous ? 1 : 0, ground: previous?.view.marks.ground.length ?? 0,
      margin: previous?.view.marks.margin.length ?? 0,
      flowers: previous?.view.marks.flowers.length ?? 0, shore: 0, reeds: 0, samples: previous?.samples ?? 0, shoreSamples: 0,
      rasterBytes: staticCanvas ? staticCanvas.width * staticCanvas.height * 4 : 0, maxRasterBytes: 2048 * 2048 * 4 };
    },
    clear() { previous = null; staticCanvas = null; }
  };
}
