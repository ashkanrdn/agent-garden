/* Seeded, screen-space environment studies for the specimen sheet.
   Browser: window.SpecimenEnvironment. Node: require('./specimen-environment.js').
   Pass the existing garden geometry functions through drawWaterStrip opts.landscape. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SpecimenEnvironment = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TAU = Math.PI * 2;
  // These are Observatory theme colors. Keep environment marks quieter than trees.
  const C = {
    paper: '#111E2E', ground: '#182838', path: '#101C29', edge: '#536978', ink: '#A7BFCD',
    accent: '#D1E9A2', sage: '#A2B393', teal: '#83AEA9', slate: '#63727B',
    lavender: '#B2A0B9', ochre: '#C5B080', deepWater: '#293D52', paleWater: '#63727B',
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  function environmentPalette(theme = {}) {
    return { ...C, paper: theme.background ?? C.paper, ground: theme.ground ?? C.ground,
      path: theme.path ?? C.path, edge: theme.edge ?? C.edge, ink: theme.ink ?? C.ink,
      accent: theme.accent ?? C.accent, teal: theme.canopies?.[0]?.top ?? C.teal,
      lavender: theme.canopies?.[1]?.top ?? C.lavender, sage: theme.canopies?.[2]?.top ?? C.sage,
      deepWater: theme.lots?.[1] ?? C.deepWater };
  }

  function seedNumber(seed) {
    if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
    let h = 2166136261;
    for (const char of String(seed ?? 1)) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
    return h >>> 0;
  }
  function seededRandom(seed) {
    let state = seedNumber(seed);
    return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  }
  function hash2(x, y, seed = 1) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ seedNumber(seed);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function smoothNoise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    return lerp(lerp(hash2(ix, iy, seed), hash2(ix + 1, iy, seed), u),
      lerp(hash2(ix, iy + 1, seed), hash2(ix + 1, iy + 1, seed), u), v);
  }
  function fbm(x, y, seed, noise = smoothNoise) {
    let sum = 0, amplitude = .5;
    for (let i = 0; i < 4; i++) {
      sum += amplitude * noise(x, y, seed + i * 37);
      x = x * 2.03 + 17.1; y = y * 2.03 - 11.7; amplitude *= .5;
    }
    return sum;
  }
  function patternCanvas(size) {
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(size, size);
    canvas.width = canvas.height = size;
    return canvas;
  }
  function clipRect(ctx, rect) {
    ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
  }
  function path(ctx, points, close = false) {
    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    if (close) ctx.closePath();
  }
  const tileCache = new Map();
  const paperPatterns = new WeakMap();
  function cachedTile(key, make) {
    if (!tileCache.has(key)) {
      tileCache.set(key, make());
      if (tileCache.size > 24) tileCache.delete(tileCache.keys().next().value);
    }
    return tileCache.get(key);
  }

  /** Translucent ImageData fibers and noise, for use over the Observatory surface. */
  function drawPaperGrain(ctx, rect, opts = {}) {
    const inheritedAlpha = ctx.globalAlpha ?? 1;
    const seed = seedNumber(opts.seed), size = 192, tileKey = `paper/${seed}`;
    const canCache = ctx !== null && (typeof ctx === 'object' || typeof ctx === 'function');
    let patterns = canCache ? paperPatterns.get(ctx) : null;
    let pattern = patterns?.get(tileKey);
    if (!pattern) {
      const tile = cachedTile(`paper/${seed}`, () => {
        const canvas = patternCanvas(size), g = canvas.getContext('2d');
        const data = g.createImageData(size, size), random = seededRandom(seed ^ 0x45508ab1);
        for (let i = 0; i < size * size; i++) {
          const bright = random() > .55, a = Math.round(Math.pow(random(), 2.7) * (bright ? 35 : 27));
          data.data.set(bright ? [203, 221, 218, a] : [19, 30, 46, a], i * 4);
        }
        g.putImageData(data, 0, 0);
        g.lineWidth = .55;
        for (let i = 0; i < 48; i++) {
          const x = random() * size, y = random() * size, length = 3 + random() * 11;
          g.strokeStyle = random() < .65 ? '#B2C3B11B' : '#101C291C';
          g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + length * .38, y - 1.2, x + length, y + 1.3); g.stroke();
        }
        return canvas;
      });
      pattern = ctx.createPattern(tile, 'repeat');
      if (canCache && pattern) {
        if (!patterns) { patterns = new Map(); paperPatterns.set(ctx, patterns); }
        patterns.set(tileKey, pattern);
      }
    }
    ctx.save(); clipRect(ctx, rect); ctx.globalAlpha = inheritedAlpha * (opts.alpha ?? .9);
    ctx.fillStyle = pattern; ctx.fillRect(rect.x, rect.y, rect.w, rect.h); ctx.restore();
  }

  function stippleTile(seed, variant, theme) {
    const C = environmentPalette(theme);
    const size = 144, canvas = patternCanvas(size), g = canvas.getContext('2d');
    const cell = variant === 'meadow' ? 7 : 12;
    for (let y = -cell; y < size + cell; y += cell) for (let x = -cell; x < size + cell; x += cell) {
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      if (hash2(gx, gy, seed + 13) > (variant === 'meadow' ? .68 : .48)) continue;
      const px = x + cell * (.2 + hash2(gx, gy, seed + 29) * .6);
      const py = y + cell * (.2 + hash2(gx, gy, seed + 47) * .6);
      const r = (variant === 'meadow' ? .75 : 2.15) * (.7 + .6 * hash2(gx, gy, seed + 71));
      g.globalAlpha = .28 + hash2(gx, gy, seed + 97) * .36;
      g.strokeStyle = variant === 'meadow' ? C.sage : C.teal;
      g.fillStyle = variant === 'meadow' ? C.sage : C.ink;
      g.beginPath(); g.arc(px, py, r, 0, TAU);
      if (variant === 'meadow' || hash2(gx, gy, seed + 103) < .28) g.fill();
      else { g.lineWidth = .75; g.stroke(); }
    }
    return canvas;
  }
  /** variant: 'lawn' (open rings) or 'meadow' (warm, close dots). */
  function drawGroundStipple(ctx, rect, opts = {}) {
    const inheritedAlpha = ctx.globalAlpha ?? 1, C = environmentPalette(opts.theme);
    const seed = seedNumber(opts.seed), variant = opts.variant === 'meadow' ? 'meadow' : 'lawn';
    const tile = cachedTile(`stipple/${seed}/${variant}/${C.sage}/${C.teal}/${C.ink}`, () => stippleTile(seed, variant, opts.theme));
    ctx.save(); clipRect(ctx, rect);
    ctx.fillStyle = variant === 'meadow' ? '#243F47' : C.ground;
    if (!opts.transparent) ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.globalAlpha = inheritedAlpha * (opts.alpha ?? 1); ctx.fillStyle = ctx.createPattern(tile, 'repeat');
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h); ctx.globalAlpha = inheritedAlpha * (1);
    // Screen-space paper fog softens distant marks toward the top of a swatch.
    if (!opts.transparent && opts.fade !== false) {
      const fog = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h);
      fog.addColorStop(0, '#111E2EB8'); fog.addColorStop(.55, '#111E2E27'); fog.addColorStop(1, '#111E2E00');
      ctx.fillStyle = fog; ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    ctx.restore();
  }

  function drawShorelinePebbles(ctx, rect, opts = {}) {
    const inheritedAlpha = ctx.globalAlpha ?? 1, C = environmentPalette(opts.theme);
    const seed = seedNumber(opts.seed), random = seededRandom(seed ^ 0x36a44327);
    ctx.save(); clipRect(ctx, rect); ctx.fillStyle = opts.background ?? C.path;
    if (!opts.transparent) ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    const row = 6, column = 8;
    for (let y = rect.y - row; y < rect.y + rect.h + row; y += row) {
      for (let x = rect.x - column; x < rect.x + rect.w + column; x += column) {
        if (random() < .08) continue;
        const px = x + (random() - .5) * 4, py = y + (random() - .5) * 3;
        const rx = 1.7 + random() * 1.6, ry = 1.2 + random() * 1.2;
        ctx.globalAlpha = inheritedAlpha * (.28 + random() * .36); ctx.strokeStyle = random() < .2 ? C.lavender : C.ink;
        ctx.lineWidth = .65; ctx.beginPath(); ctx.ellipse(px, py, rx, ry, random() * .8 - .4, 0, TAU); ctx.stroke();
        if (random() < .3) {
          ctx.fillStyle = C.slate; ctx.globalAlpha = inheritedAlpha * (.28);
          ctx.beginPath(); ctx.ellipse(px, py, rx * .62, ry * .55, 0, 0, TAU); ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  function drawReeds(ctx, rect, opts = {}) {
    const inheritedAlpha = ctx.globalAlpha ?? 1, C = environmentPalette(opts.theme);
    const seed = seedNumber(opts.seed), random = seededRandom(seed ^ 0x19ac37e2);
    ctx.save(); clipRect(ctx, rect); ctx.lineCap = 'round';
    const count = Math.max(1, Math.round(rect.w * rect.h / 170));
    for (let i = 0; i < count; i++) {
      const x = rect.x + random() * rect.w, y = rect.y + rect.h * (.48 + random() * .53);
      const patch = fbm(x / 65, y / 35, seed);
      if (patch < .42 || random() < .2) continue;
      for (let blade = 0, n = 1 + Math.floor(random() * 3); blade < n; blade++) {
        const height = 8 + random() * 13, lean = (random() - .5) * 5;
        const sx = x + (random() - .5) * 4, top = y - height;
        ctx.globalAlpha = inheritedAlpha * (.38 + random() * .43); ctx.strokeStyle = random() < .35 ? C.teal : C.sage;
        ctx.lineWidth = .8 + random() * 1.1;
        ctx.beginPath(); ctx.moveTo(sx, y); ctx.quadraticCurveTo(sx + lean * .15, y - height * .6, sx + lean, top); ctx.stroke();
        if (random() < .22) {
          ctx.globalAlpha = inheritedAlpha * (.47); ctx.strokeStyle = C.ochre; ctx.lineWidth = .8;
          ctx.beginPath(); ctx.moveTo(sx + lean, top + 4); ctx.lineTo(sx + lean + .3, top - 1); ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  function drawFlowerDrifts(ctx, rect, opts = {}) {
    const inheritedAlpha = ctx.globalAlpha ?? 1, C = environmentPalette(opts.theme);
    const seed = seedNumber(opts.seed), random = seededRandom(seed ^ 0x81ac5613);
    ctx.save(); clipRect(ctx, rect); ctx.lineCap = 'round';
    const drifts = Math.max(2, Math.round(rect.w / 68));
    for (let d = 0; d < drifts; d++) {
      const centerX = rect.x + (d + .4 + random() * .35) * rect.w / drifts;
      const centerY = rect.y + rect.h * (.6 + random() * .34);
      const flowers = 5 + Math.floor(random() * 8);
      for (let i = 0; i < flowers; i++) {
        const x = centerX + (random() - .5) * 43, y = centerY + (random() - .5) * 18;
        const top = y - 7 - random() * 14, bend = (random() - .5) * 7;
        ctx.strokeStyle = random() < .5 ? C.teal : C.sage; ctx.globalAlpha = inheritedAlpha * (.5 + random() * .35);
        ctx.lineWidth = .8; ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + bend * .4, y - 7, x + bend, top); ctx.stroke();
        if (random() < .27) {
          ctx.fillStyle = C.lavender;
          for (let k = 0; k < 5; k++) {
            const a = k * TAU / 5;
            ctx.beginPath(); ctx.ellipse(x + bend + Math.cos(a) * 2.4, top + Math.sin(a) * 2.4, 1.75, 1.05, a, 0, TAU); ctx.fill();
          }
          ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(x + bend, top, .9, 0, TAU); ctx.fill();
        } else {
          ctx.fillStyle = random() < .5 ? C.ink : C.lavender;
          ctx.beginPath(); ctx.arc(x + bend, top, 1.45 + random() * .8, 0, TAU); ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  /** A contour keeps its cadence as the camera pans; neighboring IDs differ. */
  function contourDashStyle(id, zoom = 1, dpr = 1, basePeriod = 15) {
    const period = basePeriod * Math.max(1e-12, zoom) * (.8 + .4 * hash2(seedNumber(id), 1, 0x51a7));
    const phase = period * hash2(seedNumber(id), 2, 0x51a7);
    const devicePeriod = period * dpr;
    const x = clamp((devicePeriod - 3) / 3, 0, 1), dashAlpha = x * x * (3 - 2 * x);
    const solidAlpha = clamp(devicePeriod / 4, .32, .75) * (1 - dashAlpha), solid = dashAlpha < .01;
    return { period, phase, devicePeriod, dashAlpha, solidAlpha, solid, alpha: solid ? solidAlpha : 1 };
  }
  function contourDashPasses(style, baseAlpha = 1) {
    if (!style) return baseAlpha < .01 ? [] : [{ solid: false, alpha: baseAlpha }];
    return [{ solid: false, alpha: baseAlpha * style.dashAlpha },
      { solid: true, alpha: baseAlpha * style.solidAlpha }].filter(pass => pass.alpha >= .01);
  }
  /** The origin is the projected world origin, so camera translation cancels. */
  function dashVisible(x, y, period = 15, duty = .58, phase = 0, origin = { x: 0, y: 0 }) {
    const position = ((((x - origin.x) + (y - origin.y) * .35 + phase) / period) % 1 + 1) % 1;
    return position >= 1 - duty;
  }
  function drawDashedContours(ctx, rect, opts = {}) {
    const inheritedAlpha = ctx.globalAlpha ?? 1, C = environmentPalette(opts.theme);
    const seed = seedNumber(opts.seed), spacing = opts.spacing ?? 13;
    const rowStart = opts.origin
      ? Math.ceil((rect.y - opts.origin.y - 8) / spacing)
      : 0;
    ctx.save(); clipRect(ctx, rect); ctx.lineCap = 'round';
    for (let row = rowStart, base = opts.origin ? opts.origin.y + 8 + row * spacing : rect.y + 8;
      base < rect.y + rect.h + 10; base += spacing, row++) {
      const phase = hash2(row, 0, seed) * 7;
      const dash = contourDashStyle(`${seed}/${row}`, opts.zoom ?? 1, opts.dpr ?? 1, opts.period ?? 15);
      ctx.strokeStyle = row % 4 === 0 ? C.ink : C.edge;
      const passes = contourDashPasses(dash, inheritedAlpha * (row % 4 === 0 ? .43 : .55));
      ctx.lineWidth = row % 4 === 0 ? 1 : .7;
      const points = [];
      for (let x = rect.x - 1; x < rect.x + rect.w + 2; x += 2) {
        const worldX = x - (opts.origin?.x ?? 0);
        const y = base + Math.sin((worldX + phase) * .021) * 3.2 + (fbm(worldX / 70, row / 3, seed) - .47) * 6;
        points.push({ x, y });
      }
      for (const pass of passes) {
        ctx.globalAlpha = pass.alpha; ctx.beginPath(); let drawing = false;
        for (const { x, y } of points) {
          if (pass.solid || dashVisible(x, y, dash.period, opts.duty ?? .58, dash.phase, opts.origin)) {
            if (drawing) ctx.lineTo(x, y); else ctx.moveTo(x, y);
            drawing = true;
          } else drawing = false;
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function shoreY(x, rect, side, seed, noise) {
    const u = (x - rect.x) / rect.w;
    const wobble = (noise(u * 3.2 + 13, side * 4 + 7, seed) - .5) * rect.h * .11;
    return rect.y + rect.h * (side === 0 ? .25 : .74) + wobble + Math.sin(u * TAU * 1.25 + side * 2) * rect.h * .025;
  }
  const waterCache = new Map();
  function waterBanks(rect, seed, landscape) {
    const noise = landscape.perlinNoise
      ? (x, y, s) => .5 + landscape.perlinNoise(x, y, s) * .72
      : smoothNoise;
    const key = `${rect.x}/${rect.y}/${rect.w}/${rect.h}/${seed}/${!!landscape.perlinNoise}/${!!landscape.buildIslandContours}/${!!landscape.buildPlotHill}`;
    if (waterCache.has(key)) return waterCache.get(key);
    const xs = Array.from({ length: 33 }, (_, i) => rect.x + rect.w * i / 32);
    const top = xs.map(x => ({ x, y: shoreY(x, rect, 0, seed, noise) }));
    const bottom = xs.map(x => ({ x, y: shoreY(x, rect, 1, seed + 19, noise) }));
    const upper = [{ x: rect.x, y: rect.y - rect.h }, { x: rect.x + rect.w, y: rect.y - rect.h }, ...top.slice().reverse()];
    const lower = [...bottom, { x: rect.x + rect.w, y: rect.y + rect.h * 2 }, { x: rect.x, y: rect.y + rect.h * 2 }];
    const banks = [upper, lower].map((polygon, i) => {
      const geometry = landscape.buildIslandContours?.(polygon);
      const hillPolygon = i === 0
        ? [{ x: rect.x + rect.w * .16, y: rect.y }, { x: rect.x + rect.w * .84, y: rect.y },
          { x: rect.x + rect.w * .74, y: rect.y + rect.h * .18 }, { x: rect.x + rect.w * .25, y: rect.y + rect.h * .18 }]
        : [{ x: rect.x + rect.w * .21, y: rect.y + rect.h * .82 }, { x: rect.x + rect.w * .8, y: rect.y + rect.h * .82 },
          { x: rect.x + rect.w * .88, y: rect.y + rect.h }, { x: rect.x + rect.w * .12, y: rect.y + rect.h }];
      const centroid = { x: hillPolygon.reduce((s, p) => s + p.x, 0) / 4, y: hillPolygon.reduce((s, p) => s + p.y, 0) / 4 };
      const hill = landscape.buildPlotHill?.({ id: `specimen-bank-${seed}-${i}`, polygon: hillPolygon, centroid,
        area: rect.w * rect.h * .12 });
      return { polygon, geometry, hill };
    });
    const result = { banks, noise };
    waterCache.set(key, result); if (waterCache.size > 5) waterCache.delete(waterCache.keys().next().value);
    return result;
  }

  /** The only moving marks are water contours. timeMs determines every frame. */
  function drawWaterStrip(ctx, rect, timeMs = 0, opts = {}) {
    const inheritedAlpha = ctx.globalAlpha ?? 1, C = environmentPalette(opts.theme);
    const seed = seedNumber(opts.seed), landscape = opts.landscape || {};
    const { banks, noise } = waterBanks(rect, seed, landscape);
    const time = (Number.isFinite(timeMs) ? timeMs : 0) / 1000;
    ctx.save(); clipRect(ctx, rect);
    const water = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h);
    water.addColorStop(0, C.deepWater); water.addColorStop(.5, '#343B52'); water.addColorStop(1, C.deepWater);
    ctx.fillStyle = water; ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    // FBM-warped, drifting isolines replace the fragment shader's lineAA bands.
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let line = -3; line < 24; line++) {
      ctx.beginPath();
      for (let x = rect.x - 4, i = 0; x <= rect.x + rect.w + 4; x += 3, i++) {
        const u = (x - rect.x) / Math.max(1, rect.w);
        const broad = fbm(u * 3.4 + time * .018, line * .17 - time * .012, seed + 5, noise);
        const warp = fbm(u * 7.1 - time * .013, line * .23 + broad * 1.2, seed + 99, noise);
        const y = rect.y + line * rect.h / 20 + (broad - .47) * rect.h * .22 + (warp - .47) * rect.h * .075;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.globalAlpha = inheritedAlpha * (line % 4 === 0 ? .43 : .23);
      ctx.strokeStyle = line % 4 === 0 ? C.ink : C.lavender;
      ctx.lineWidth = line % 4 === 0 ? .9 : .55; ctx.stroke();
    }
    ctx.globalAlpha = inheritedAlpha * (1);
    for (let side = 0; side < 2; side++) {
      const { polygon, geometry, hill } = banks[side];
      // The concentric relief comes from garden-island-contours.js.
      if (geometry?.rings) for (let i = 37; i >= 0; i -= 6) {
        const ring = geometry.rings[i]; if (!ring) continue;
        path(ctx, ring.points, true); ctx.strokeStyle = C.edge; ctx.globalAlpha = inheritedAlpha * (.16);
        ctx.lineWidth = .65; ctx.stroke();
      }
      ctx.globalAlpha = inheritedAlpha * (1); path(ctx, polygon, true);
      ctx.fillStyle = side ? '#243F47' : C.ground; ctx.fill();
      ctx.save(); path(ctx, polygon, true); ctx.clip();
      // Seeded Perlin height gives small, fixed patches inside the land.
      const step = 13;
      for (let y = rect.y; y < rect.y + rect.h; y += step) for (let x = rect.x; x < rect.x + rect.w; x += step) {
        const n = landscape.hillHeight
          ? landscape.hillHeight(x + (seed % 997) * .13, y + (seed % 733) * .17,
            { center: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, span: rect.w * 1.3, step })
          : fbm(x / 95, y / 95, seed, noise);
        if (n < .38) continue;
        ctx.globalAlpha = inheritedAlpha * (clamp((n - .38) * .39, 0, .2)); ctx.fillStyle = n > .58 ? C.sage : C.teal;
        ctx.beginPath(); ctx.arc(x + hash2(x, y, seed) * 6, y, .6 + n * .85, 0, TAU); ctx.fill();
      }
      // garden-plot-hills.js supplies elevation sections within both islands.
      if (hill?.contours) {
        ctx.globalAlpha = inheritedAlpha * (.26); ctx.strokeStyle = C.ink; ctx.lineWidth = .65;
        for (let i = 1; i < hill.contours.length; i += 2) { path(ctx, hill.contours[i], true); ctx.stroke(); }
      }
      ctx.restore(); ctx.globalAlpha = inheritedAlpha * (1);
      const edge = side ? polygon.slice(0, -2) : polygon.slice(2).reverse();
      path(ctx, edge); ctx.strokeStyle = C.ink; ctx.globalAlpha = inheritedAlpha * (.72); ctx.lineWidth = 1.25; ctx.stroke();
      ctx.globalAlpha = inheritedAlpha * (1);
    }
    ctx.restore();
  }

  // Geometry primitives paint only supplied marks. Roots and clipping belong to the world adapter.
  function paintMarks(ctx, marks, opts, paint) {
    const colors = environmentPalette(opts.theme), alpha = ctx.globalAlpha ?? 1;
    ctx.save(); ctx.lineCap = 'round';
    for (const mark of marks) {
      ctx.globalAlpha = alpha * (opts.alpha ?? 1) * (mark.opacity ?? 1);
      paint(mark, colors, seededRandom(mark.seed ?? opts.seed));
    }
    ctx.restore();
  }
  function drawGroundMarks(ctx, marks, opts = {}) {
    paintMarks(ctx, marks, opts, (p, c) => {
      ctx.lineWidth = .65; ctx.fillStyle = c.sage; ctx.strokeStyle = c.teal;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, p.size ?? 1.6, (p.size ?? 1.6) * .5, 0, 0, TAU);
      if (p.variant === 'meadow') ctx.fill(); else ctx.stroke();
    });
  }
  function drawPebbleMarks(ctx, marks, opts = {}) {
    paintMarks(ctx, marks, opts, (p, c, random) => {
      ctx.strokeStyle = random() < .2 ? c.lavender : c.ink; ctx.lineWidth = .65;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, p.size ?? 2, (p.size ?? 2) * .6, random() * .8 - .4, 0, TAU); ctx.stroke();
    });
  }
  function drawReedMarks(ctx, marks, opts = {}) {
    paintMarks(ctx, marks, opts, (p, c, random) => {
      for (let i = 0; i < 3; i++) {
        const height = (p.size ?? 1) * (6 + random() * 8), lean = (random() - .5) * 5;
        const x = p.x + i - 1, top = p.y - height;
        ctx.strokeStyle = i % 2 ? c.teal : c.sage; ctx.lineWidth = .8;
        ctx.beginPath(); ctx.moveTo(x, p.y); ctx.quadraticCurveTo(x, p.y - height * .6, x + lean, top); ctx.stroke();
        ctx.strokeStyle = c.sage;
        ctx.beginPath(); ctx.moveTo(x + lean, top + 3); ctx.lineTo(x + lean, top - 1); ctx.stroke();
      }
    });
  }
  function drawFlowerMarks(ctx, marks, opts = {}) {
    paintMarks(ctx, marks, opts, (p, c, random) => {
      const top = p.y - (p.size ?? 1) * (7 + random() * 7), bend = (random() - .5) * 5;
      ctx.strokeStyle = c.sage; ctx.lineWidth = .8;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.quadraticCurveTo(p.x + bend * .4, p.y - 5, p.x + bend, top); ctx.stroke();
      ctx.fillStyle = c.lavender;
      for (let i = 0; i < 5; i++) {
        const a = i * TAU / 5;
        ctx.beginPath(); ctx.ellipse(p.x + bend + Math.cos(a) * 2, top + Math.sin(a) * 2, 1.6, 1, a, 0, TAU); ctx.fill();
      }
      ctx.fillStyle = c.ink; ctx.beginPath(); ctx.arc(p.x + bend, top, .8, 0, TAU); ctx.fill();
    });
  }
  /** Geometric dash intervals; splitting a line never restarts its phase. */
  function drawContourPath(ctx, points, opts = {}) {
    const c = environmentPalette(opts.theme);
    const style = opts.id === undefined ? null : contourDashStyle(opts.id, opts.zoom, opts.dpr, opts.basePeriod);
    const alpha = (ctx.globalAlpha ?? 1) * (opts.alpha ?? 1);
    const passes = style ? contourDashPasses(style, alpha) : [{ solid: opts.solid ?? false, alpha }];
    for (const pass of passes) {
      ctx.save(); ctx.globalAlpha = pass.alpha;
      ctx.strokeStyle = opts.color ?? c.edge; ctx.lineWidth = opts.width ?? .7;
      ctx.beginPath(); traceContourPath(ctx, points, { ...opts, ...style, solid: pass.solid }); ctx.stroke(); ctx.restore();
    }
  }
  function traceContourPath(ctx, points, opts = {}) {
    const period = opts.period ?? 15, duty = opts.duty ?? .58, phase = opts.phase ?? 0;
    const origin = opts.origin ?? { x: 0, y: 0 };
    const count = points.length - (opts.closed ? 0 : 1);
    if (opts.solid) {
      if (points.length) ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      if (opts.closed && points.length) ctx.lineTo(points[0].x, points[0].y);
      return;
    }
    for (let i = 0; i < count; i++) {
      let a = points[i], b = points[(i + 1) % points.length];
      // Clip before counting dashes. Extreme camera zoom cannot create unbounded stroke work.
      if (ctx.canvas) {
        const transform = ctx.getTransform?.(), ratio = Math.max(1e-9, Math.abs(transform?.a ?? 1));
        const width = ctx.canvas.width / ratio, height = ctx.canvas.height / ratio;
        const dx = b.x - a.x, dy = b.y - a.y;
        let lo = 0, hi = 1;
        for (const [p, q] of [[-dx, a.x + 2], [dx, width + 2 - a.x], [-dy, a.y + 2], [dy, height + 2 - a.y]]) {
          if (p === 0) { if (q < 0) hi = -1; }
          else if (p < 0) lo = Math.max(lo, q / p);
          else hi = Math.min(hi, q / p);
        }
        if (hi < lo) continue;
        b = { x: a.x + dx * hi, y: a.y + dy * hi };
        a = { x: a.x + dx * lo, y: a.y + dy * lo };
      }
      const pa = (a.x - origin.x + (a.y - origin.y) * .35 + phase) / period;
      const pb = (b.x - origin.x + (b.y - origin.y) * .35 + phase) / period, delta = pb - pa;
      if (Math.abs(delta) < 1e-9) {
        if (dashVisible(a.x, a.y, period, duty, phase, origin)) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
        continue;
      }
      // View-clipped callers keep this loop bounded by screen size.
      const lo = Math.floor(Math.min(pa, pb)), hi = Math.floor(Math.max(pa, pb));
      for (let k = lo; k <= hi; k++) {
        let u = (k + 1 - duty - pa) / delta, v = (k + 1 - pa) / delta;
        if (u > v) [u, v] = [v, u];
        u = Math.max(0, u); v = Math.min(1, v);
        if (v <= u) continue;
        ctx.moveTo(lerp(a.x, b.x, u), lerp(a.y, b.y, u));
        ctx.lineTo(lerp(a.x, b.x, v), lerp(a.y, b.y, v));
      }
    }
  }
  /** Soft painted pool displaced toward the fixed afternoon-sun shadow direction. */
  function drawShadowPool(ctx, x, y, r, opts = {}) {
    const random = seededRandom(seedNumber(opts.seed) ^ 0x619f782a);
    const sx = x + r * .3, sy = y + r * .22;
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(.28); ctx.scale(1.18, .72);
    for (let i = 0; i < 4; i++) {
      const rx = r * (1.25 - i * .17), ry = r * (1.03 - i * .12);
      ctx.fillStyle = `rgba(8, 20, 30, ${(.035 + random() * .014) * (opts.opacity ?? 1)})`;
      ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  // ---- World-anchored water field -------------------------------------------------------------
  // Everything below depends only on the water ring (world units), a seed and time. Zoom, yaw and pan
  // never enter: the sampling lattice is fixed per ring, so the contour shapes cannot re-sample.
  function hash3(x, y, z, seed) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1103515245) ^ seed;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function noise3(x, y, z, seed) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
    const layer = k => lerp(lerp(hash3(ix, iy, k, seed), hash3(ix + 1, iy, k, seed), u),
      lerp(hash3(ix, iy + 1, k, seed), hash3(ix + 1, iy + 1, k, seed), u), v);
    return lerp(layer(iz), layer(iz + 1), w);
  }
  const WATER_LEVELS = 15, WATER_LOW = .27, WATER_STEP = .032;
  /** Warped three-octave field in about [.2, .8]; `scale` is the world size of one base wavelength. */
  function waterValue(x, y, timeSec, seed, scale) {
    const px = x / (scale * 2.1) + timeSec * .011, py = y / scale, z = timeSec * .055;
    const wx = noise3(px * .8 + 3.1, py * .8 - 7.7, z * .7, seed + 1) - .5;
    const wy = noise3(px * .8 - 5.3, py * .8 + 2.9, z * .7, seed + 2) - .5;
    const qx = px + wx * 1.7, qy = py + wy * 1.7;
    // Each octave is rotated so value-noise lattice lines never line up.
    return .55 * noise3(qx, qy, z, seed + 11)
      + .3 * noise3(qx * 1.6 - qy * 1.2, qx * 1.2 + qy * 1.6, z * 1.4 + 9, seed + 12)
      + .15 * noise3(qx * 3.1 - qy * 2.2, qx * 2.2 + qy * 3.1, z * 2 + 19, seed + 13);
  }
  /** Fixed lattice over the ring's bounding box; only cells near the annulus are kept. */
  function buildWaterBasin(ring, { cells = 170 } = {}) {
    const { inner, outer, count } = ring;
    const all = inner.concat(outer);
    const c = ring.center || { x: outer.reduce((s, p) => s + p.x, 0) / outer.length, y: outer.reduce((s, p) => s + p.y, 0) / outer.length };
    const x0 = Math.min(...all.map(p => p.x)), x1 = Math.max(...all.map(p => p.x));
    const y0 = Math.min(...all.map(p => p.y)), y1 = Math.max(...all.map(p => p.y));
    const size = Math.max(x1 - x0, y1 - y0), cell = size / cells;
    const cols = Math.ceil((x1 - x0) / cell) + 2, rows = Math.ceil((y1 - y0) / cell) + 2;
    const bx = x0 - cell, by = y0 - cell;
    const innerR = inner.map(p => Math.hypot(p.x - c.x, p.y - c.y)), outerR = outer.map(p => Math.hypot(p.x - c.x, p.y - c.y));
    const near = (px, py) => {
      const position = ((Math.atan2(py - c.y, px - c.x) + TAU) % TAU) / TAU * count, i = Math.floor(position) % count, f = position - Math.floor(position);
      const j = (i + 1) % count, r = Math.hypot(px - c.x, py - c.y);
      return r >= lerp(innerR[i], innerR[j], f) - cell * 2 && r <= lerp(outerR[i], outerR[j], f) + cell * 2;
    };
    const usedVertex = new Uint8Array(cols * rows), list = [];
    for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
      if (!near(bx + (i + .5) * cell, by + (j + .5) * cell)) continue;
      list.push(i, j);
      usedVertex[j * cols + i] = usedVertex[j * cols + i + 1] = usedVertex[(j + 1) * cols + i] = usedVertex[(j + 1) * cols + i + 1] = 1;
    }
    const vertices = []; for (let k = 0; k < usedVertex.length; k++) if (usedVertex[k]) vertices.push(k);
    return { bx, by, cell, cols, rows, size, cells: Int32Array.from(list), vertices: Int32Array.from(vertices), values: new Float32Array(cols * rows) };
  }
  /** Iso-line segments for one time. Returns { levels: Float32Array[] (x1,y1,x2,y2 world units), segments }. */
  function waterContours(basin, timeSec, { seed = 1, levels = WATER_LEVELS } = {}) {
    const { bx, by, cell, cols, values, size } = basin, s = seedNumber(seed), scale = size / 7.5;
    for (const k of basin.vertices) values[k] = waterValue(bx + (k % cols) * cell, by + Math.floor(k / cols) * cell, timeSec, s, scale);
    const out = Array.from({ length: levels }, () => []);
    const pts = [0, 0, 0, 0, 0, 0, 0, 0];
    const EDGES = [null, [3, 0], [0, 1], [3, 1], [1, 2], null, [0, 2], [3, 2], [2, 3], [0, 2], null, [1, 2], [1, 3], [0, 1], [3, 0], null];
    const { cells } = basin;
    for (let n = 0; n < cells.length; n += 2) {
      const i = cells[n], j = cells[n + 1], k = j * cols + i;
      const a = values[k], b = values[k + 1], c = values[k + cols + 1], d = values[k + cols];
      const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
      const first = Math.max(0, Math.ceil((lo - WATER_LOW) / WATER_STEP)), last = Math.min(levels - 1, Math.floor((hi - WATER_LOW) / WATER_STEP));
      const x = bx + i * cell, y = by + j * cell;
      for (let level = first; level <= last; level++) {
        const L = WATER_LOW + level * WATER_STEP;
        const mask = (a > L ? 1 : 0) | (b > L ? 2 : 0) | (c > L ? 4 : 0) | (d > L ? 8 : 0);
        if (mask === 0 || mask === 15) continue;
        pts[0] = x + (L - a) / (b - a) * cell; pts[1] = y;
        pts[2] = x + cell; pts[3] = y + (L - b) / (c - b) * cell;
        pts[4] = x + (L - d) / (c - d) * cell; pts[5] = y + cell;
        pts[6] = x; pts[7] = y + (L - a) / (d - a) * cell;
        let pairs = EDGES[mask];
        const target = out[level];
        if (mask === 5 || mask === 10) {
          const high = (a + b + c + d) / 4 > L;
          const set = mask === 5 ? (high ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]]) : (high ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]]);
          for (const [p, q] of set) target.push(pts[p * 2], pts[p * 2 + 1], pts[q * 2], pts[q * 2 + 1]);
          continue;
        }
        target.push(pts[pairs[0] * 2], pts[pairs[0] * 2 + 1], pts[pairs[1] * 2], pts[pairs[1] * 2 + 1]);
      }
    }
    const arrays = out.map(list => Float32Array.from(list));
    return { levels: arrays, segments: arrays.reduce((n, list) => n + list.length / 4, 0) };
  }

  return { drawPaperGrain, drawGroundStipple, drawShorelinePebbles, drawReeds,
    drawFlowerDrifts, drawDashedContours, drawWaterStrip, drawShadowPool,
    seedNumber, seededRandom, hash2, smoothNoise, dashVisible, contourDashStyle, contourDashPasses, environmentPalette,
    drawGroundMarks, drawPebbleMarks, drawReedMarks, drawFlowerMarks, drawContourPath, traceContourPath,
    waterValue, buildWaterBasin, waterContours, WATER_LEVELS };
});
