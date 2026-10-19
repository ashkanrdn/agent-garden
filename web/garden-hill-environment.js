/** Seeded Perlin terrain, sampled in world space and drawn as closed contour hulls. */
const TAU = Math.PI * 2;
/** Extra moat width between the island footprint and the hill ramp, as a fraction of geometry.span. */
export const WATER_GAP = 0.60;
const clamp = n => Math.max(0, Math.min(1, n));
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

function gradient(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) & 7;
}

/** Real lattice-gradient Perlin noise; shared lattice corners make tile seams continuous. */
export function perlinNoise(x, y, seed = 483765) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const dot = (dx, dy) => {
    const g = gradient(ix + dx, iy + dy, seed), px = fx - dx, py = fy - dy;
    return (g < 4 ? ((g & 1) ? -px : px) + ((g & 2) ? -py : py)
      : g < 6 ? (g & 1 ? -px : px) : (g & 1 ? -py : py)) * .7071067811865476;
  };
  return lerp(lerp(dot(0, 0), dot(1, 0), fade(fx)), lerp(dot(0, 1), dot(1, 1), fade(fx)), fade(fy));
}

/** Multiple octaves give independent hill masses, creased ridges, and fine rock edges. */
export function hillHeight(x, y, { center, span, wavelength = span, step = 0 }) {
  const px = (x - center.x) / wavelength + 17.31, py = (y - center.y) / wavelength - 9.17;
  const warpX = perlinNoise(px * .45, py * .45, 71) * .35;
  const warpY = perlinNoise(px * .45, py * .45, 193) * .35;
  const u = px + warpX, v = py + warpY;
  const broad = perlinNoise(u, v, 483765), middle = perlinNoise(u * 2.1, v * 2.1, 137);
  const ridges = .32 - Math.abs(perlinNoise(u * 4.3, v * 4.3, 811));
  const crag = perlinNoise(u * 8.7, v * 8.7, 329), grit = perlinNoise(u * 17.2, v * 17.2, 953);
  const detail = frequency => Math.min(1, wavelength / Math.max(1, step * frequency * 3)) ** 3;
  return clamp(.43 + broad * .9 + middle * .35 + ridges * .27 + crag * .13 * detail(8.7) + grit * .055 * detail(17.2));
}

/** Marching squares with shared edge IDs, including an asymptotic saddle decision. */
export function contourHulls(values, columns, rows, iso, { x, y, step }) {
  const nodes = new Map(), links = new Map();
  const node = (id, ax, ay, av, bx, by, bv) => {
    if (!nodes.has(id)) {
      const t = (iso - av) / (bv - av);
      nodes.set(id, { x: x + (ax + (bx - ax) * t) * step, y: y + (ay + (by - ay) * t) * step });
    }
    return id;
  };
  const connect = (a, b) => {
    if (!links.has(a)) links.set(a, []);
    if (!links.has(b)) links.set(b, []);
    links.get(a).push(b); links.get(b).push(a);
  };
  const offset = columns * rows;
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < columns - 1; i++) {
    const k = j * columns + i;
    const a = values[k], b = values[k + 1], c = values[k + columns + 1], d = values[k + columns];
    const edges = [];
    if ((a > iso) !== (b > iso)) edges.push(node(k, i, j, a, i + 1, j, b));
    if ((b > iso) !== (c > iso)) edges.push(node(offset + k + 1, i + 1, j, b, i + 1, j + 1, c));
    if ((d > iso) !== (c > iso)) edges.push(node(k + columns, i, j + 1, d, i + 1, j + 1, c));
    if ((a > iso) !== (d > iso)) edges.push(node(offset + k, i, j, a, i, j + 1, d));
    if (edges.length === 2) connect(edges[0], edges[1]);
    else if (edges.length === 4) {
      const saddle = (a - iso) * (c - iso) - (b - iso) * (d - iso);
      if (saddle >= 0) { connect(edges[0], edges[1]); connect(edges[2], edges[3]); }
      else { connect(edges[0], edges[3]); connect(edges[1], edges[2]); }
    }
  }
  const used = new Set(), hulls = [];
  for (const start of nodes.keys()) {
    if (used.has(start)) continue;
    const points = []; let previous = null, current = start;
    while (current !== undefined && !used.has(current)) {
      used.add(current); points.push(nodes.get(current));
      const next = (links.get(current) || []).find(id => id !== previous);
      previous = current; current = next;
    }
    if (current === start && points.length >= 3) hulls.push(points);
  }
  return hulls;
}

function islandFootprint(geometry) {
  const outline = geometry.rings.at(-1).points;
  return Array.from({ length: 256 }, (_, i) => {
    const angle = i / 256 * TAU, dx = Math.cos(angle), dy = Math.sin(angle);
    let radius = 0;
    for (let k = 0; k < outline.length; k++) {
      const a = outline[k], b = outline[(k + 1) % outline.length];
      const ax = a.x - geometry.center.x, ay = a.y - geometry.center.y, ex = b.x - a.x, ey = b.y - a.y;
      const cross = dx * ey - dy * ex;
      if (Math.abs(cross) < 1e-8) continue;
      const t = (ax * dy - ay * dx) / cross, r = (ax * ey - ay * ex) / cross;
      if (t >= 0 && t <= 1 && r > 0) radius = Math.max(radius, r);
    }
    return radius;
  });
}

/** Water annulus from the island footprint alone: fixed angular resolution, no Perlin samples, so it cannot
 *  change with zoom, pan, octave or tile. The outer edge sits just inside the hill ramp start so hills overlap it. */
export const WATER_RIDGE_INSET = .97;
export function buildWaterRing(geometry, footprint, waterGap = WATER_GAP) {
  const count = footprint.length, { center } = geometry, window = 3;
  // A small circular average calms the outer edge; the hill ramp itself stays untouched.
  const smooth = footprint.map((_, i) => { let sum = 0;
    for (let k = -window; k <= window; k++) sum += footprint[(i + k + count) % count];
    return sum / (2 * window + 1); });
  const at = (i, radius) => { const angle = i / count * TAU; return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }; };
  const gap = geometry.span * waterGap;
  return { level: 0, count, center: { x: center.x, y: center.y },
    inner: footprint.map((r, i) => at(i, r * .985)),
    outer: footprint.map((r, i) => at(i, Math.min(smooth[i], r) * .98 + gap * WATER_RIDGE_INSET)) };
}

// Interpolate all coordinates so clipped water and dry faces share exact shore vertices.
function cutPolygon(points, distance) {
  const result = [];
  let a = points.at(-1), da = a && distance(a);
  for (const b of points) {
    const db = distance(b);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      result.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) });
    }
    if (db >= 0) result.push(b);
    a = b; da = db;
  }
  return result;
}
function waterBox(points) {
  return { left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)),
    top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)) };
}
function waterOverlap(a, b) { return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top; }
function waterArea(points) { return points.reduce((s, p, i) => { const q = points[(i + 1) % points.length]; return s + p.x * q.y - q.x * p.y; }, 0); }

/** Triangle clipping preserves wet basins; the star-shaped finite skirt is subtracted exactly. */
export function buildTerrainWater(terrain, footprint = [], level = terrain.baseZ + terrain.rise * .17) {
  const wetPolygons = [], shoreSegments = [], faces = [];
  const center = terrain.center ?? (footprint.length ? { x: footprint.reduce((s, p) => s + p.x / footprint.length, 0),
    y: footprint.reduce((s, p) => s + p.y / footprint.length, 0) } : null);
  const wedges = footprint.map((a, i) => {
    const points = [center, a, footprint[(i + 1) % footprint.length]];
    const sign = Math.sign(waterArea(points));
    return { box: waterBox(points), edges: points.map((p, j) => { const q = points[(j + 1) % 3];
      return r => sign * ((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)); }) };
  });
  const footprintBox = footprint.length ? waterBox(footprint) : null;
  const boundary = footprint.map((p, i) => waterBox([p, footprint[(i + 1) % footprint.length]]));
  function exclude(points) {
    if (!footprint.length) return [points];
    const box = waterBox(points);
    if (!waterOverlap(box, footprintBox)) return [points];
    if (!boundary.some(edge => waterOverlap(box, edge))) {
      return wedges.some(w => w.edges.every(edge => edge(points[0]) >= -1e-9)) ? [] : [points];
    }
    let pieces = [points];
    for (const wedge of wedges) {
      const next = [];
      for (const piece of pieces) {
        if (!waterOverlap(waterBox(piece), wedge.box)) { next.push(piece); continue; }
        let remaining = piece;
        for (const edge of wedge.edges) {
          const outside = cutPolygon(remaining, p => -edge(p));
          if (outside.length >= 3 && Math.abs(waterArea(outside)) > 1e-8) next.push(outside);
          remaining = cutPolygon(remaining, edge);
          if (remaining.length < 3) break;
        }
      }
      pieces = next;
      if (!pieces.length) break;
    }
    return pieces;
  }
  function shoreOutside(a, b) {
    if (!footprintBox || !waterOverlap(waterBox([a, b]), footprintBox)) return [[a, b]];
    const cuts = [0, 1], dx = b.x - a.x, dy = b.y - a.y;
    for (let i = 0; i < footprint.length; i++) {
      const p = footprint[i], q = footprint[(i + 1) % footprint.length], ex = q.x - p.x, ey = q.y - p.y;
      const det = dx * ey - dy * ex;
      if (Math.abs(det) < 1e-12) continue;
      const t = ((p.x - a.x) * ey - (p.y - a.y) * ex) / det;
      const u = ((p.x - a.x) * dy - (p.y - a.y) * dx) / det;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
    }
    cuts.sort((a, b) => a - b);
    const point = t => ({ x: a.x + dx * t, y: a.y + dy * t, z: level });
    const parts = [];
    for (let i = 1; i < cuts.length; i++) {
      const p = point((cuts[i - 1] + cuts[i]) / 2);
      if (!wedges.some(w => w.edges.every(edge => edge(p) >= -1e-9))) parts.push([point(cuts[i - 1]), point(cuts[i])]);
    }
    return parts;
  }
  for (let index = 0; index < terrain.faces.length; index++) {
    const face = terrain.faces[index], points = face.indices.map(i => terrain.vertices[i]);
    const wet = cutPolygon(points, p => level - p.z), dry = cutPolygon(points, p => p.z - level);
    const polygons = wet.length >= 3 ? exclude(wet.map(p => ({ x: p.x, y: p.y, z: level }))) : [];
    wetPolygons.push(...polygons);
    const cuts = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if ((a.z > level) === (b.z > level)) continue;
      const t = (level - a.z) / (b.z - a.z);
      cuts.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: level });
    }
    if (cuts.length === 2 && Math.hypot(cuts[0].x - cuts[1].x, cuts[0].y - cuts[1].y) > 1e-8) {
      const land = points.filter(p => p.z > level);
      for (const part of shoreOutside(...cuts)) shoreSegments.push({ points: part, faceIndex: index,
        land: { x: land.reduce((s, p) => s + p.x / land.length, 0), y: land.reduce((s, p) => s + p.y / land.length, 0) } });
    }
    faces.push({ faceIndex: index, wet: polygons, dry: dry.length >= 3 ? dry : [] });
  }
  return { level, wetPolygons, shoreSegments, faces };
}

/** World-aligned, padded tiles continue for every pan/zoom; storage stays bounded. */
export function createHillEnvironment({ waterGap = WATER_GAP } = {}) {
  let previousGeometry = null, footprint = null, waterRing = null;
  const cache = new Map();
  const environment = (geometry, { width, height, unproject }) => {
    if (!geometry.rings.length) { cache.clear(); return { layers: [], vertices: [], faces: [], water: { level: 0, wetPolygons: [], shoreSegments: [], faces: [] }, stats: { hulls: 0 } }; }
    if (geometry !== previousGeometry) { cache.clear(); footprint = islandFootprint(geometry); waterRing = buildWaterRing(geometry, footprint, waterGap); previousGeometry = geometry; }
    const baseZ = -geometry.depth - geometry.span * .04, rise = geometry.span * .46;
    const margin = 240, corners = [];
    for (const z of [baseZ, baseZ + rise]) for (const x of [-margin, width + margin]) for (const y of [-margin, height + margin]) corners.push(unproject(x, y, z));
    const minX = Math.min(...corners.map(p => p.x)), maxX = Math.max(...corners.map(p => p.x));
    const minY = Math.min(...corners.map(p => p.y)), maxY = Math.max(...corners.map(p => p.y));
    const step = 2 ** Math.ceil(Math.log2(Math.max(maxX - minX, maxY - minY) / 88));
    const tile = step * 16, x = Math.floor(minX / tile) * tile, y = Math.floor(minY / tile) * tile;
    const columns = Math.ceil((maxX - x) / tile) * 16 + 1, rows = Math.ceil((maxY - y) / tile) * 16 + 1;
    // Coarser octaves become visible as fine terrain falls below the grid resolution.
    const octave = Math.max(0, Math.floor(Math.log2(step * 28 / geometry.span)));
    const wavelength = geometry.span * 2 ** octave;
    const key = [x, y, step, columns, rows, octave].join('/');
    if (cache.has(key)) return cache.get(key);
    const values = new Float64Array(columns * rows);
    for (let j = 1; j < rows - 1; j++) for (let i = 1; i < columns - 1; i++) {
      const px = x + i * step, py = y + j * step, dx = px - geometry.center.x, dy = py - geometry.center.y;
      const distance = Math.hypot(dx, dy), position = ((Math.atan2(dy, dx) + TAU) % TAU) / TAU * footprint.length;
      const index = Math.floor(position), radius = lerp(footprint[index], footprint[(index + 1) % footprint.length], position - index);
      const blend = fade(clamp((distance - radius * .98 - geometry.span * waterGap) / (geometry.span * .18)));
      values[j * columns + i] = hillHeight(px, py, { center: geometry.center, span: geometry.span, wavelength, step }) * blend;
    }
    const layers = [];
    for (let i = 1; i <= 28; i++) {
      const iso = .12 + i * .025, hulls = contourHulls(values, columns, rows, iso, { x, y, step });
      if (hulls.length) layers.push({ iso, z: baseZ + rise * iso, major: i % 5 === 0, hulls });
    }
    const vertices = Array.from(values, (value, index) => ({ x: x + index % columns * step,
      y: y + Math.floor(index / columns) * step, z: baseZ + value * rise, value }));
    const faces = [];
    const face = indices => {
      const points = indices.map(i => vertices[i]), segments = [];
      const low = Math.max(1, Math.ceil((Math.min(...points.map(p => p.value)) - .12) / .025));
      const high = Math.min(28, Math.floor((Math.max(...points.map(p => p.value)) - .12) / .025));
      for (let level = low; level <= high; level++) {
        const iso = .12 + level * .025, cuts = [];
        for (let i = 0; i < 3; i++) {
          const a = points[i], b = points[(i + 1) % 3];
          if ((a.value > iso) === (b.value > iso)) continue;
          const t = (iso - a.value) / (b.value - a.value);
          cuts.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: baseZ + iso * rise });
        }
        if (cuts.length === 2) segments.push({ points: cuts, major: level % 5 === 0, level });
      }
      const value = points.reduce((sum, p) => sum + p.value / 3, 0);
      faces.push({ indices, segments, tone: Math.round(value * 7),
        x: points.reduce((sum, p) => sum + p.x / 3, 0), y: points.reduce((sum, p) => sum + p.y / 3, 0) });
    };
    for (let j = 0; j < rows - 1; j++) for (let i = 0; i < columns - 1; i++) {
      const a = j * columns + i, b = a + 1, c = a + columns + 1, d = a + columns;
      face([a, b, c]); face([a, c, d]);
    }
    const terrain = { layers, vertices, faces, center: geometry.center, bounds: { x, y, w: (columns - 1) * step, h: (rows - 1) * step }, baseZ, rise,
      stats: { infinite: true, generator: 'perlin', octave, gridCells: columns * rows,
        layers: layers.length, hulls: layers.reduce((n, layer) => n + layer.hulls.length, 0), faces: faces.length, step, wavelength } };
    terrain.key = key;
    // Shared by identity across tiles: the ring depends on geometry only, never on the tile key.
    terrain.waterRing = waterRing;
    terrain.water = { level: baseZ, wetPolygons: [], shoreSegments: [], faces: [] };
    cache.set(key, terrain);
    if (cache.size > 3) cache.delete(cache.keys().next().value);
    return terrain;
  };
  environment.stats = () => ({ fields: cache.size, maxFields: 3 });
  environment.clear = () => { cache.clear(); previousGeometry = null; };
  return environment;
}

/** Kept local so worker and standalone consumers need no renderer dependency. */
export function hillDashFade(period, dpr = 1) {
  const devicePeriod = period * dpr, x = clamp((devicePeriod - 3) / 3);
  const dashAlpha = x * x * (3 - 2 * x);
  return { dashAlpha, solidAlpha: Math.max(.32, Math.min(.75, devicePeriod / 4)) * (1 - dashAlpha) };
}
function traceHillDash(ctx, points, { period, phase, solid, origin }) {
  const [a, b] = points;
  if (solid) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); return; }
  const pa = (a.x - origin.x + (a.y - origin.y) * .35 + phase) / period;
  const pb = (b.x - origin.x + (b.y - origin.y) * .35 + phase) / period, delta = pb - pa;
  if (Math.abs(delta) < 1e-9) {
    if (((pa % 1) + 1) % 1 >= .42) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    return;
  }
  for (let k = Math.floor(Math.min(pa, pb)); k <= Math.floor(Math.max(pa, pb)); k++) {
    let u = (k + .42 - pa) / delta, v = (k + 1 - pa) / delta;
    if (u > v) [u, v] = [v, u];
    u = Math.max(0, u); v = Math.min(1, v);
    if (v <= u) continue;
    ctx.moveTo(lerp(a.x, b.x, u), lerp(a.y, b.y, u));
    ctx.lineTo(lerp(a.x, b.x, v), lerp(a.y, b.y, v));
  }
}

/** Static, zoom-independent water: one evenodd annulus fill plus a few shore-parallel contour lines. */
function drawWaterRing(ctx, ring, screen, z, { width, height, alpha, theme, ink }) {
  const trace = points => { points.forEach((p, i) => { const q = screen({ x: p.x, y: p.y, z }); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.closePath(); };
  const deep = theme.lots?.[1] ?? '#293D52';
  let fill = deep;
  if (ctx.createLinearGradient) {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, deep); gradient.addColorStop(.5, '#343B52'); gradient.addColorStop(1, deep);
    fill = gradient;
  }
  ctx.globalAlpha = alpha; ctx.fillStyle = fill;
  ctx.beginPath(); trace(ring.outer); trace(ring.inner); ctx.fill('evenodd');
  ctx.lineJoin = 'round'; ctx.strokeStyle = ink; ctx.lineWidth = .55;
  [[.22, .2], [.48, .14], [.74, .1]].forEach(([t, a]) => {
    ctx.globalAlpha = alpha * a; ctx.beginPath();
    trace(ring.inner.map((p, i) => ({ x: lerp(p.x, ring.outer[i].x, t), y: lerp(p.y, ring.outer[i].y, t) })));
    ctx.stroke();
  });
  ctx.globalAlpha = alpha; ctx.lineJoin = 'miter';
}

function punchWaterHole(ctx, ring, screen, z, alpha) {
  const trace = points => { points.forEach((p, i) => { const q = screen({ x: p.x, y: p.y, z }); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.closePath(); };
  ctx.globalCompositeOperation = 'destination-out'; ctx.globalAlpha = alpha; ctx.fillStyle = '#000';
  ctx.beginPath(); trace(ring.outer); trace(ring.inner); ctx.fill('evenodd');
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = alpha;
}

export function drawHillEnvironment(ctx, terrain, project, { width, height, theme = {}, waterHole = false, traceContour = globalThis.SpecimenEnvironment?.traceContourPath }) {
  const alpha = ctx.globalAlpha ?? 1, paper = theme.background ?? '#111E2E';
  const rgb = /^#[0-9a-f]{6}$/i.test(paper) ? [1, 3, 5].map(i => parseInt(paper.slice(i, i + 2), 16)) : [17, 30, 46];
  ctx.save(); ctx.fillStyle = paper; ctx.fillRect(0, 0, width, height);
  ctx.lineJoin = 'miter'; ctx.miterLimit = 2;
  // The garden uses an affine projection. Compute its basis once per frame.
  const origin = project(0, 0, 0), unitX = project(1, 0, 0), unitY = project(0, 1, 0), unitZ = project(0, 0, 1);
  const zoom = Math.hypot(unitX.x - origin.x, unitX.y - origin.y);
  const dpr = Math.abs(ctx.getTransform?.().a ?? 1);
  const dashStyles = Array.from({ length: 29 }, (_, level) =>
    globalThis.SpecimenEnvironment?.contourDashStyle(`hill/${level}`, zoom, dpr) ?? (() => {
      const period = 15 * Math.max(1e-12, zoom) * (.8 + .4 * ((level * .754877666) % 1));
      return { period, phase: period * ((level * .618033989) % 1) };
    })());
  const dashFades = dashStyles.map(style => hillDashFade(style.period, dpr));
  const drawDash = traceContour || traceHillDash;
  if (!ctx.getLineDash || ctx.getLineDash().length) ctx.setLineDash?.([]);
  if (ctx.lineDashOffset !== 0) ctx.lineDashOffset = 0;
  const xx = unitX.x - origin.x, xy = unitY.x - origin.x, xz = unitZ.x - origin.x;
  const yx = unitX.y - origin.y, yy = unitY.y - origin.y, yz = unitZ.y - origin.y;
  const screen = p => ({ x: origin.x + p.x * xx + p.y * xy + p.z * xz,
    y: origin.y + p.x * yx + p.y * yy + p.z * yz });
  const projected = terrain.vertices.map(screen);
  // A terrain face must hide the contours behind it. Elevation-only ordering
  // produces crossed lines where neighboring hills overlap in the isometric view.
  const ring = terrain.waterRing;
  // Water goes under every hill face: flat faces (all vertices at value 0) are only paper-colored ground,
  // so skipping them leaves the water visible while raised faces still cover its outer edge.
  // With `waterHole` the base layer leaves the annulus transparent: the animated water is painted UNDER this
  // layer by the specimen environment (drawWater), so the hills and island above it still overlap its edges.
  if (ring && waterHole) punchWaterHole(ctx, ring, screen, terrain.baseZ, alpha);
  else if (ring) drawWaterRing(ctx, ring, screen, terrain.baseZ, { width, height, alpha, theme, ink: '#A7BFCD' });
  const faces = terrain.faces.map(face => ({ face, depth: face.x * yx + face.y * yy }))
    .sort((a, b) => a.depth - b.depth);
  for (const { face } of faces) {
    if (ring && face.indices.every(i => terrain.vertices[i].value === 0)) continue;
    const points = face.indices.map(i => projected[i]);
    if (points.every(p => p.x < -2) || points.every(p => p.x > width + 2) ||
      points.every(p => p.y < -2) || points.every(p => p.y > height + 2)) continue;
    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
    const centerY = points.reduce((sum, p) => sum + p.y / points.length, 0);
    const distanceFade = .25 + .75 * clamp((centerY / Math.max(1, height) + .15) / .7);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = `rgb(${[17 + face.tone, 31 + face.tone, 45 + face.tone].map((v, i) => Math.round(lerp(rgb[i], v, distanceFade))).join(',')})`; ctx.fill();
    // Keep face painter order: a nearer face must still cover rear contours.
    const groups = new Map();
    for (const segment of face.segments) {
      const points = segment.points.map(screen), [a, b] = points;
      if (Math.max(a.x, b.x) < -2 || Math.min(a.x, b.x) > width + 2 ||
        Math.max(a.y, b.y) < -2 || Math.min(a.y, b.y) > height + 2) continue;
      const key = `${segment.level}/${segment.major}`;
      let group = groups.get(key);
      if (!group) { group = { level: segment.level, major: segment.major, segments: [] }; groups.set(key, group); }
      group.segments.push(points);
    }
    for (const { level, major, segments } of groups.values()) {
      const dash = dashStyles[level], fade = dashFades[level], baseAlpha = alpha * distanceFade;
      const passes = [{ solid: false, alpha: baseAlpha * fade.dashAlpha },
        { solid: true, alpha: baseAlpha * fade.solidAlpha }];
      for (const pass of passes) {
        if (pass.alpha < .01) continue;
        ctx.globalAlpha = pass.alpha;
        ctx.strokeStyle = major ? '#9CB5C19E' : '#7896A674'; ctx.lineWidth = major ? .9 : .5;
        ctx.beginPath();
        for (const points of segments) drawDash(ctx, points,
          { id: `hill/${level}`, period: dash.period, phase: dash.phase, solid: pass.solid, origin });
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}
