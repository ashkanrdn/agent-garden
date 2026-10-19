/** Study-only Cloud Volume and extruded Contour Plates. */
import { createCloud, seededRandom, drawCloud, projectPoint, CLOUD_PALETTE } from './procedural-clouds.js';

const TAU = Math.PI * 2;
const clamp = value => Math.max(0, Math.min(1, value));
const smoothstep = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const BASE_Z = 162;
export const PALETTE = ['#8A9FEB', '#6F8FE6', '#9A9BEA', '#C7A3DB', '#F09E90', '#FFC798'];
export const PARAMETER_RANGES = {
  starts: [2, 5, 1], per: [2, 5, 1], rmin: [8, 24, .1], rmax: [16, 44, .1],
  spread: [.3, 1.8, .01], stretch: [0, 1, .01], spacing: [4, 20, .1], thickness: [2, 14, .1],
  threshold: [.1, .6, .01], fillet: [0, 30, .1], innerLines: [0, 3, 1],
};
// The concept's numeric generator, including its seeded knob order.
function rng(seed) {
  return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function seedParameters(seed) {
  const r = rng(Number(seed));
  return { starts: 2 + Math.floor(r() * 4), per: 2 + Math.floor(r() * 4), rmin: 12 + r() * 8,
    rmax: 22 + r() * 14, spread: .5 + r() * .9, stretch: r(), spacing: 10, thickness: 7,
    threshold: .25, mode: 'metaball', fillet: 9, innerLines: 2, gradient: 'plate',
    bottomColor: '#8A9FEB', topColor: '#FFC798' };
}
export function contourParameters(seed, overrides = {}) {
  const p = seedParameters(seed);
  for (const [key, [min, max, step]] of Object.entries(PARAMETER_RANGES)) {
    if (Number.isFinite(overrides[key])) p[key] = Math.max(min, Math.min(max,
      step === 1 ? Math.round(overrides[key]) : overrides[key]));
  }
  if (p.rmin > p.rmax) {
    if ('rmin' in overrides && !('rmax' in overrides)) p.rmax = p.rmin;
    else p.rmin = p.rmax;
  }
  for (const [key, values] of Object.entries({ mode: ['metaball', 'tangent'], gradient: ['plate', 'face', 'both'],
    bottomColor: PALETTE, topColor: PALETTE })) if (values.includes(overrides[key])) p[key] = overrides[key];
  return p;
}

/** Compact support field, copied from the approved concept. */
export function field(balls, x, y, z) {
  let value = 0;
  for (const b of balls) {
    const d = ((x - b.x) ** 2 + (y - b.y) ** 2 + (z - b.z) ** 2) / (1.4 * b.R) ** 2;
    if (d < 1) value += (1 - d) ** 3;
  }
  return value;
}
function volumeCandidate(seed, p) {
  const r = rng(Number(seed));
  for (let i = 0; i < 6; i++) r();
  const starts = [], balls = [];
  for (let g = 0; g < p.starts; g++) {
    const start = { x: (r() * 2 - 1) * 70, y: (r() * 2 - 1) * 26 }, a = r() * TAU;
    starts.push(start);
    for (let j = 0; j < p.per; j++) {
      const along = (j - (p.per - 1) / 2) * (14 + p.stretch * 22) * p.spread;
      const side = (r() * 2 - 1) * 10 * p.spread;
      balls.push({ x: Math.max(-100, Math.min(100, start.x + Math.cos(a) * along - Math.sin(a) * side)),
        y: Math.max(-50, Math.min(50, start.y + (Math.sin(a) * along + Math.cos(a) * side) * .6)),
        z: r() * 22, R: p.rmin + r() * (p.rmax - p.rmin), g });
    }
  }
  return { starts, balls };
}

// Select a layout with a real leader attachment using the seed defaults.
// Pin one existing ball to the allowed upper cap only when the fifth slice is absent.
// The chosen heading samples and cap index stay stable as sliders move.
function volume(seed, parameters) {
  const defaults = seedParameters(seed);
  for (let attempt = 0; attempt < 256; attempt++) {
    const layoutSeed = Number(seed) + attempt * 7919;
    const candidate = volumeCandidate(layoutSeed, defaults);
    const attachment = candidate.balls.some(b => {
      const radius = Math.sqrt(Math.max(0, (.85 * b.R) ** 2 - b.z ** 2));
      return radius > 0 && Math.hypot(b.x, b.y) + radius > 60;
    });
    if (!attachment) continue;
    const result = volumeCandidate(layoutSeed, parameters);
    if (!candidate.balls.some(b => .85 * b.R > 40 - b.z + 1)) {
      const cap = candidate.balls.reduce((best, b, i, all) => b.z + b.R > all[best].z + all[best].R ? i : best, 0);
      const ball = result.balls[Math.min(cap, result.balls.length - 1)];
      ball.z = 22; ball.R = parameters.rmax;
    }
    return { ...result, layoutAttempt: attempt };
  }
  throw new RangeError('Seed has no valid leader attachment');
}

const signedArea = points => points.reduce((sum, a, i) => {
  const b = points[(i + 1) % points.length]; return sum + a.x * b.y - b.x * a.y;
}, 0) / 2;
function contains(points, p) {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}
function finishLoops(raw) {
  return raw.map(points => {
    const hole = raw.filter(other => other !== points && contains(other, points[0])).length % 2 === 1;
    // Positive outer winding makes projected front-facing edges run right to left.
    if ((signedArea(points) > 0) === hole) points.reverse();
    const smooth = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      smooth.push({ x: .75 * a.x + .25 * b.x, y: .75 * a.y + .25 * b.y },
        { x: .25 * a.x + .75 * b.x, y: .25 * a.y + .75 * b.y });
    }
    const capped = smooth.length > 256 ? Array.from({ length: 256 }, (_, i) => smooth[Math.floor(i * smooth.length / 256)]) : smooth;
    return { hole, points: [...capped, { ...capped[0] }] };
  });
}


function extractContours({ values, left, top, nx, ny, cell }, threshold) {
  const vertices = new Map(), edges = new Map();
  function vertex(key, ax, ay, bx, by, a, b) {
    if (!vertices.has(key)) {
      const t = a / (a - b);
      vertices.set(key, { x: left + (ax + (bx - ax) * t) * cell, y: top + (ay + (by - ay) * t) * cell });
    }
    return key;
  }
  function connect(a, b) {
    if (!edges.has(a)) edges.set(a, []);
    if (!edges.has(b)) edges.set(b, []);
    edges.get(a).push(b); edges.get(b).push(a);
  }
  for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    const i = y * nx + x, a = (threshold - values[i]), b = (threshold - values[i + 1]), c = (threshold - values[i + nx + 1]), d = (threshold - values[i + nx]);
    const mask = (a < 0 ? 1 : 0) | (b < 0 ? 2 : 0) | (c < 0 ? 4 : 0) | (d < 0 ? 8 : 0);
    if (mask === 0 || mask === 15) continue;
    const crossings = [];
    if ((a < 0) !== (b < 0)) crossings.push(vertex(i * 2, x, y, x + 1, y, a, b));
    if ((b < 0) !== (c < 0)) crossings.push(vertex((i + 1) * 2 + 1, x + 1, y, x + 1, y + 1, b, c));
    if ((d < 0) !== (c < 0)) crossings.push(vertex((i + nx) * 2, x, y + 1, x + 1, y + 1, d, c));
    if ((a < 0) !== (d < 0)) crossings.push(vertex(i * 2 + 1, x, y, x, y + 1, a, d));
    if (crossings.length === 2) connect(...crossings);
    else {
      // Resolve saddles consistently from their bilinear center.
      const centerInside = (a + b + c + d) < 0;
      if ((mask === 5) === centerInside) {
        connect(crossings[0], crossings[1]); connect(crossings[2], crossings[3]);
      } else { connect(crossings[0], crossings[3]); connect(crossings[1], crossings[2]); }
    }
  }
  const visited = new Set(), loops = [];
  for (const start of edges.keys()) {
    if (visited.has(start)) continue;
    let current = start, previous = -1;
    const points = [];
    do {
      visited.add(current); points.push(vertices.get(current));
      const next = edges.get(current).find(key => key !== previous);
      previous = current; current = next;
    } while (current !== undefined && current !== start && !visited.has(current));
    if (current === start && points.length >= 3) loops.push(points);
  }
  return finishLoops(loops);
}

// Split disjoint supports before sampling. This keeps tiny early slices bounded.
function sliceGrids(balls, z, cell) {
  const active = balls.filter(b => Math.abs(z - b.z) < b.R * 1.4);
  const groups = [];
  for (const ball of active) {
    const touching = groups.filter(group => group.some(b => Math.hypot(b.x - ball.x, b.y - ball.y) < (b.R + ball.R) * 1.4));
    const group = [ball, ...touching.flat()];
    for (const old of touching) groups.splice(groups.indexOf(old), 1);
    groups.push(group);
  }
  return groups.map(group => {
    const left = Math.min(...group.map(b => b.x - b.R * 1.4)) - cell;
    const top = Math.min(...group.map(b => b.y - b.R * 1.4)) - cell;
    const nx = Math.ceil((Math.max(...group.map(b => b.x + b.R * 1.4)) - left) / cell) + 2;
    const ny = Math.ceil((Math.max(...group.map(b => b.y + b.R * 1.4)) - top) / cell) + 2;
    const values = new Float32Array(nx * ny);
    for (const b of group) {
      const radius2 = (b.R * 1.4) ** 2, dz = (z - b.z) ** 2;
      const reach = Math.sqrt(radius2 - dz);
      const x0 = Math.max(0, Math.floor((b.x - reach - left) / cell)), x1 = Math.min(nx - 1, Math.ceil((b.x + reach - left) / cell));
      const y0 = Math.max(0, Math.floor((b.y - reach - top) / cell)), y1 = Math.min(ny - 1, Math.ceil((b.y + reach - top) / cell));
      for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
        const u = 1 - ((left + i * cell - b.x) ** 2 + (top + j * cell - b.y) ** 2 + dz) / radius2;
        if (u > 0) values[j * nx + i] += u * u * u;
      }
    }
    let max = 0; for (const value of values) max = Math.max(max, value);
    return { values, left, top, nx, ny, cell, max };
  });
}

/** Exact signed-radius arcs and common tangents from the concept's tangentPath. */
function tangentPath(circles, fillet) {
  const cx = circles.reduce((sum, c) => sum + c.x, 0) / circles.length;
  const cy = circles.reduce((sum, c) => sum + c.y, 0) / circles.length;
  const cs = [...circles].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  if (cs.length === 1) return [{ x: cs[0].x, y: cs[0].y, r: cs[0].r, start: 0, sweep: TAU, owner: cs[0].id }];
  const items = [];
  cs.forEach((A, i) => {
    const B = cs[(i + 1) % cs.length], dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
    const ra = A.r + fillet, rb = B.r + fillet;
    items.push({ x: A.x, y: A.y, rho: A.r, owner: A.id });
    if (fillet > 0 && L < ra + rb && L > Math.abs(ra - rb)) {
      const a = (ra * ra - rb * rb + L * L) / (2 * L), h = Math.sqrt(Math.max(0, ra * ra - a * a));
      items.push({ x: A.x + dx / L * a + dy / L * h, y: A.y + dy / L * a - dx / L * h, rho: -fillet, owner: A.id });
    }
  });
  const normals = items.map((P, i) => {
    const Q = items[(i + 1) % items.length], dx = Q.x - P.x, dy = Q.y - P.y, L = Math.hypot(dx, dy);
    const a = Math.max(-1, Math.min(1, (P.rho - Q.rho) / L)), s = Math.sqrt(1 - a * a);
    return { x: a * dx / L + s * dy / L, y: a * dy / L - s * dx / L };
  });
  return items.map((P, i) => {
    const a = normals[(i - 1 + items.length) % items.length], b = normals[i], sign = Math.sign(P.rho);
    const start = Math.atan2(sign * a.y, sign * a.x), end = Math.atan2(sign * b.y, sign * b.x);
    const sweep = P.rho < 0 ? -((start - end + TAU) % TAU) : (end - start + TAU) % TAU;
    return { x: P.x, y: P.y, r: Math.abs(P.rho), start, sweep, owner: P.owner };
  });
}
function arcPoints(arcs) {
  const points = [];
  for (const arc of arcs) {
    const steps = Math.max(1, Math.ceil(Math.abs(arc.sweep) / (Math.PI / 24)));
    for (let i = 0; i <= steps; i++) {
      const angle = arc.start + arc.sweep * i / steps;
      const p = { x: arc.x + arc.r * Math.cos(angle), y: arc.y + arc.r * Math.sin(angle), owner: arc.owner };
      if (!points.length || Math.hypot(p.x - points.at(-1).x, p.y - points.at(-1).y) > 1e-8) points.push(p);
    }
  }
  if (Math.hypot(points[0].x - points.at(-1).x, points[0].y - points.at(-1).y) < 1e-8) points.pop();
  return [...points, { ...points[0] }];
}
function crossing(points) {
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 0; i < points.length - 1; i++) for (let j = i + 2; j < points.length - 1; j++) {
    if (i === 0 && j === points.length - 2) continue;
    const a = points[i], b = points[i + 1], c = points[j], d = points[j + 1];
    if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) ||
        Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) continue;
    if (cross(a, b, c) * cross(a, b, d) < -1e-12 && cross(c, d, a) * cross(c, d, b) < -1e-12) return [a.owner, b.owner, c.owner, d.owner];
  }
  return null;
}
export function tangentLoop(circles, fillet) {
  let cs = circles.map((c, id) => ({ ...c, id })).filter((a, i, all) => !all.some((b, j) =>
    j !== i && Math.hypot(a.x - b.x, a.y - b.y) + a.r <= b.r + 1e-8 && (a.r < b.r || i > j)));
  while (cs.length) {
    const arcs = tangentPath(cs, fillet), points = arcPoints(arcs), crossed = crossing(points);
    if (!crossed) return { hole: false, points: points.map(({ x, y }) => ({ x, y })), arcs };
    const cx = cs.reduce((sum, c) => sum + c.x, 0) / cs.length, cy = cs.reduce((sum, c) => sum + c.y, 0) / cs.length;
    const interior = cs.filter(c => crossed.includes(c.id)).sort((a, b) =>
      Math.hypot(a.x - cx, a.y - cy) + a.r - Math.hypot(b.x - cx, b.y - cy) - b.r)[0];
    cs = cs.filter(c => c !== interior);
  }
  return null;
}

const frameCaches = new WeakMap();
export function createContourCloud(seed, overrides = {}) {
  const parameters = contourParameters(seed, overrides), template = createCloud(seed);
  const cloud = { seed, parameters, ...volume(seed, parameters), drops: template.drops, bolt: template.bolt };
  const settled = sampleContourCloud(cloud, 8000);
  cloud.leader = createStepLeader(seededRandom(seed + ':leader'), settled);
  settled.leader = cloud.leader;
  return cloud;
}
export function sampleContourCloud(cloud, elapsedMs) {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const progress = smoothstep(elapsed / 3000), disperse = smoothstep((elapsed - 11000) / 3000);
  const key = elapsed >= 3000 && elapsed <= 11000 ? 3000 : elapsed;
  let cache = frameCaches.get(cloud);
  if (!cache) { cache = new Map(); frameCaches.set(cloud, cache); }
  if (cache.has(key)) return cache.get(key);
  const p = cloud.parameters;
  const center = { x: cloud.starts.reduce((sum, s) => sum + s.x, 0) / p.starts,
    y: cloud.starts.reduce((sum, s) => sum + s.y, 0) / p.starts };
  const balls = cloud.balls.map(b => {
    if (progress === 1 && disperse === 0) return { ...b };
    const s = cloud.starts[b.g], length = Math.hypot(s.x - center.x, s.y - center.y) || 1;
    return { ...b, x: s.x + (b.x - s.x) * progress + (s.x - center.x) / length * 30 * disperse,
      y: s.y + (b.y - s.y) * progress + (s.y - center.y) / length * 30 * disperse,
      z: b.z * progress, R: b.R * progress * (1 - .26 * disperse) };
  });
  const plates = Array.from({ length: 5 }, (_, k) => {
    const z = k * p.spacing * progress;
    const grids = progress > 0 ? sliceGrids(balls, z, 3 * progress) : [];
    const fieldLoops = grids.flatMap(grid => extractContours(grid, p.threshold));
    const circles = balls.map(b => ({ x: b.x, y: b.y, r: Math.sqrt(Math.max(0, (.85 * b.R) ** 2 - (z - b.z) ** 2)) })).filter(c => c.r > 0);
    const loops = p.mode === 'metaball' ? fieldLoops : fieldLoops.filter(loop => !loop.hole).flatMap(loop => {
      const group = circles.filter(c => contains(loop.points, c) && !fieldLoops.some(hole => hole.hole && contains(hole.points, c)));
      const tangent = group.length ? tangentLoop(group, p.fillet * progress) : null;
      return tangent ? [tangent] : [];
    });
    const max = Math.max(0, ...grids.map(grid => grid.max));
    const inner = Array.from({ length: p.innerLines }, (_, i) =>
      grids.flatMap(grid => extractContours(grid, p.threshold + (max - p.threshold) * (i + 1) / (p.innerLines + 1)))).flat();
    return { x: 0, y: 0, z: BASE_Z + z, thickness: p.thickness * progress,
      progress, circles, loops, inner, fieldMax: max };
  });
  const frame = { ...cloud, balls, plates, progress, disperse };
  // Keep only the settled geometry and the latest moving frame.
  for (const time of cache.keys()) if (time !== 3000) cache.delete(time);
  cache.set(key, frame);
  return frame;
}

/** The wider, flatter study camera fits a complete orbit and dispersal. */
export function contourView(width, height, parameters, yaw = -.25) {
  const extent = 120 + parameters.rmax * 1.4 + 30;
  const y = height * (width < 600 ? .70 : .77);
  return { x: width * .5, y, yaw, scale: Math.min(width / (width < 600 ? 440 : 550), height / 410,
    (width - 32) / (extent * 2), (y - 20) / (BASE_Z + parameters.spacing * 4 + extent * .44)) };
}
// Test the entire segment, including the closest point between its endpoints.
function clearsTree(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator ? clamp(-(a.x * dx + a.y * dy) / denominator) : 0;
  return Math.hypot(a.x + dx * t, a.y + dy * t) >= 55;
}

/** World-space points share the plates' origin, so orbit rotates the entire scene. */
export function createStepLeader(random, cloud) {
  const bottom = cloud.plates[0];
  const direction = random() * TAU;
  // Attach to the actual bottom Contour Plate rim, outside the tree exclusion radius.
  const candidates = bottom.loops.filter(loop => !loop.hole).flatMap(loop => loop.points)
    .filter(point => Math.hypot(point.x, point.y) >= 57)
    .map(point => ({ ...point, z: bottom.z - bottom.thickness }));
  let start = candidates[Math.floor(random() * candidates.length)];
  if (!start) start = bottom.loops.filter(loop => !loop.hole).flatMap(loop => loop.points)
    .filter(point => Math.hypot(point.x, point.y) >= 55.001)
    .sort((a, b) => Math.hypot(b.x, b.y) - Math.hypot(a.x, a.y))
    .map(point => ({ ...point, z: bottom.z - bottom.thickness }))[0];
  if (!start) return [];
  const segments = [], paths = [], branchStarts = [];
  function growPath(from, steps, main, parentOrder = 0) {
    let a = from;
    const path = [];
    for (let step = 0; step < steps && segments.length < 40; step++) {
      let b;
      for (let attempt = 0; attempt < 4; attempt++) {
        const drift = main ? 6 : 12;
        const candidate = { x: a.x + (random() * 2 - 1) * drift + Math.cos(direction) * 2,
          y: a.y + (random() * 2 - 1) * drift + Math.sin(direction) * 2,
          z: a.z - 6 - random() * 4 };
        if (candidate.z < 60) break;
        if (clearsTree(a, candidate)) { b = candidate; break; }
      }
      // A vertical step always clears the gate when its valid start does.
      // It also prevents a near-boundary random walk from producing zero segments.
      if (!b && a.z - 8 >= 60) b = { x: a.x, y: a.y, z: a.z - 8 };
      if (!b) break;
      const order = main ? step : parentOrder;
      const segment = { a, b, order, main, fade: 1 };
      segments.push(segment); path.push(segment);
      if (main && branchStarts.length < 4 && random() < .3) branchStarts.push({ point: b, order });
      a = b;
    }
    paths.push(path);
  }
  growPath(start, 14, true);
  for (const branch of branchStarts) growPath(branch.point, 3 + Math.floor(random() * 4), false, branch.order);
  for (const path of paths) path.forEach((segment, index) => {
    segment.fade = 1 - smoothstep(((index + 1) / path.length - .7) / .3);
  });
  return segments;
}


function mixColor(a, b, amount) {
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const end = rgb(b);
  return '#' + rgb(a).map((v, i) => Math.round(v + (end[i] - v) * amount).toString(16).padStart(2, '0')).join('');
}
function topPath(ctx, plate, view) {
  ctx.beginPath();
  for (const loop of plate.loops) {
    if (!loop.arcs) { loopPath(ctx, loop.points.map(p => projectPoint({ ...p, z: plate.z }, view)), false); continue; }
    const origin = projectPoint({ x: 0, y: 0, z: plate.z }, view), scale = view.scale || 1;
    const yaw = view.yaw ?? -.25, c = Math.cos(yaw), s = Math.sin(yaw);
    ctx.save(); ctx.transform(c * scale, s * .44 * scale, -s * scale, c * .44 * scale, origin.x, origin.y);
    const first = loop.arcs[0];
    ctx.moveTo(first.x + first.r * Math.cos(first.start), first.y + first.r * Math.sin(first.start));
    for (const arc of loop.arcs) ctx.arc(arc.x, arc.y, arc.r, arc.start, arc.start + arc.sweep, arc.sweep < 0);
    ctx.closePath(); ctx.restore();
  }
}
function loopPath(ctx, points, begin = true) {
  if (begin) ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.closePath();
}

/** Draw Contour Plates only; the existing renderer supplies the unchanged rain tracks. */
// Rain keeps landing on the ground while its start rises with the cloud.
function drawLiftedRain(ctx, cloud, state, view, opacity, lift) {
  if (!(state.rain > 0)) return 0;
  const unit = view.scale || 1, stretch = (151 + lift) / 151, previousAlpha = ctx.globalAlpha;
  ctx.save(); ctx.lineCap = 'round';
  ctx.strokeStyle = CLOUD_PALETTE.rain; ctx.lineWidth = Math.max(.5, .55 * unit);
  let drawn = 0;
  for (const drop of cloud.drops) {
    const f = (state.elapsed / 1350 * drop.speed + drop.phase) % 1;
    const z = 151 * (1 - f) * stretch;
    const a = projectPoint({ x: drop.x, y: drop.y, z }, view);
    const b = projectPoint({ x: drop.x, y: drop.y, z: Math.min(151 * stretch, z + drop.length * stretch) }, view);
    ctx.globalAlpha = previousAlpha * opacity * state.rain * (.28 + Math.sin(f * Math.PI) * .46);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    if (f > .94) {
      const p = projectPoint({ x: drop.x, y: drop.y, z: 0 }, view);
      ctx.globalAlpha *= (1 - f) / .06;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, unit * (2 + (f - .94) * 60), unit, 0, 0, TAU); ctx.stroke();
    }
    drawn++;
  }
  ctx.restore();
  return drawn;
}
// `lift` (cloud units) raises the plates; rain and the leader stretch to stay attached.
export function drawContourCloud(ctx, cloud, state, view = {}, { texture = null, opacity = 1, lift = 0 } = {}) {
  if (state.cloud <= 0) return { plates: 0, drops: 0 };
  const groundView = view;
  if (lift) view = { ...view, y: (view.y || 0) - lift * (view.scale || 1) };
  const rain = lift ? { drops: drawLiftedRain(ctx, cloud, state, groundView, opacity, lift) }
    : drawCloud(ctx, { ...cloud, plates: [] }, state, view, { opacity, lightning: 'none' });
  const unit = view.scale || 1;
  const alpha = ctx.globalAlpha * opacity * (1 - cloud.disperse);
  let plates = 0;
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const [index, plate] of cloud.plates.entries()) {
    if (!plate.loops.length) continue;
    const p = cloud.parameters, color = mixColor(p.bottomColor, p.topColor, index / 4);
    const loops = plate.loops.map(loop => ({ hole: loop.hole,
      top: loop.points.map(p => projectPoint({ x: p.x + plate.x, y: p.y + plate.y, z: plate.z }, view)),
      bottom: loop.points.map(p => projectPoint({ x: p.x + plate.x, y: p.y + plate.y, z: plate.z - plate.thickness }, view)) }));
    const walls = loop => {
      const { top, bottom } = loop;
      const strips = []; let strip = [];
      for (let i = 0; i < top.length - 1; i++) {
        if (top[i + 1].x < top[i].x) { if (!strip.length) strip.push(i); strip.push(i + 1); }
        else if (strip.length) { strips.push(strip); strip = []; }
      }
      if (strip.length) strips.push(strip);
      for (const indices of strips) {
        loopPath(ctx, [...indices.map(i => top[i]), ...indices.slice().reverse().map(i => bottom[i])]);
        ctx.fillStyle = mixColor(color, '#12284E', .45); ctx.globalAlpha = alpha; ctx.fill();
        ctx.strokeStyle = mixColor(color, '#12284E', .3); ctx.globalAlpha = alpha;
        ctx.lineWidth = Math.max(.65, unit * .8);
        ctx.beginPath(); indices.forEach((i, n) => n ? ctx.lineTo(bottom[i].x, bottom[i].y) : ctx.moveTo(bottom[i].x, bottom[i].y)); ctx.stroke();
      }
    };
    loops.filter(loop => !loop.hole).forEach(walls);
    topPath(ctx, plate, view);
    let fill = color;
    if (p.gradient !== 'plate') {
      const a = projectPoint({ x: -125, y: -70, z: plate.z }, view);
      const b = projectPoint({ x: 125, y: 70, z: plate.z }, view);
      fill = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      fill.addColorStop(0, p.gradient === 'both' ? mixColor(p.bottomColor, color, .6) : p.bottomColor);
      fill.addColorStop(1, p.gradient === 'both' ? mixColor(p.topColor, color, .6) : p.topColor);
    }
    ctx.fillStyle = fill; ctx.globalAlpha = alpha; ctx.fill('evenodd');
    ctx.save(); ctx.clip('evenodd');
    ctx.strokeStyle = mixColor(color, '#FFF1DE', .55); ctx.lineWidth = Math.max(.5, unit * .4);
    ctx.beginPath();
    for (const line of plate.inner) loopPath(ctx, line.points.map(point => projectPoint({ ...point, z: plate.z }, view)), false);
    ctx.stroke(); ctx.restore();
    topPath(ctx, plate, view);
    if (texture) {
      ctx.save(); ctx.clip('evenodd');
      const points = loops.flatMap(loop => loop.top), xs = points.map(p => p.x), ys = points.map(p => p.y);
      const left = Math.min(...xs), top = Math.min(...ys);
      ctx.globalAlpha = alpha * .15; ctx.drawImage(texture, left, top, Math.max(...xs) - left, Math.max(...ys) - top); ctx.restore();
    }
    ctx.globalAlpha = alpha; ctx.strokeStyle = '#FFF1DE';
    ctx.lineWidth = Math.max(.6, unit * .7); ctx.stroke();
    for (const loop of loops.filter(loop => loop.hole)) {
      ctx.save(); loopPath(ctx, loop.top); ctx.clip(); walls(loop); ctx.restore();
    }
    plates++;
  }
  ctx.restore();
  return { plates, drops: rain.drops };
}

export function drawStepLeader(ctx, cloud, state, view = {}, { opacity = 1, lift = 0 } = {}) {
  if (state.cloud <= 0 || state.elapsed < 6350 || state.elapsed >= 7300 || !cloud.leader.length) return { segments: 0 };
  const reveal = clamp((state.elapsed - 6350) / 300);
  const orderCount = Math.max(...cloud.leader.filter(segment => segment.main).map(segment => segment.order)) + 1;
  const alpha = .32 * (1 - smoothstep((state.elapsed - 6650) / 650)) + .68 * state.lightning;
  const previousAlpha = ctx.globalAlpha;
  let drawn = 0;
  // Stretch z about the tree end (z 60) so the top follows the lifted cloud.
  const stretch = lift ? (BASE_Z - 5 + lift - 60) / (BASE_Z - 5 - 60) : 1;
  const lifted = point => ({ ...point, z: 60 + (point.z - 60) * stretch });
  ctx.save(); ctx.lineCap = 'round'; ctx.strokeStyle = CLOUD_PALETTE.lightning;
  for (const segment of cloud.leader) {
    const amount = clamp(reveal * orderCount - segment.order);
    if (amount <= 0 || segment.fade <= 0) continue;
    const a = projectPoint(lifted(segment.a), view);
    const b = projectPoint(lifted({ x: segment.a.x + (segment.b.x - segment.a.x) * amount,
      y: segment.a.y + (segment.b.y - segment.a.y) * amount,
      z: segment.a.z + (segment.b.z - segment.a.z) * amount }), view);
    ctx.globalAlpha = previousAlpha * opacity * alpha * segment.fade * (segment.main ? 1 : .5);
    ctx.lineWidth = Math.max(.65, (segment.main ? 1.15 : .8) * (view.scale || 1));
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); drawn++;
  }
  ctx.restore();
  return { segments: drawn };
}
