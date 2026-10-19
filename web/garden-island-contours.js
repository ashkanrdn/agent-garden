/** Decorative relative relief. These levels do not encode work or real elevation. */
const LEVELS = 40;
const FILL = '#142333';
const INK = '#A7BFCD';

// Periodic linear noise retains sharp creases, unlike a smooth sine-wave offset.
function ridgeNoise(angle, count, seed) {
  const sample = index => {
    let h = Math.imul(((index % count + count) % count) + seed, 374761393);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const position = angle / (Math.PI * 2) * count;
  const i = Math.floor(position), fraction = position - i;
  return sample(i) * (1 - fraction) + sample(i + 1) * fraction;
}

function shoreRadius(outline, center, x, y) {
  let radius = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    const ax = a.x - center.x, ay = a.y - center.y;
    const ex = b.x - a.x, ey = b.y - a.y, cross = x * ey - y * ex;
    if (Math.abs(cross) < 1e-10) continue;
    const alongRay = (ax * ey - ay * ex) / cross;
    const alongEdge = (ax * y - ay * x) / cross;
    if (alongRay > 0 && alongEdge >= -1e-8 && alongEdge <= 1 + 1e-8) radius = Math.min(radius, alongRay);
  }
  return radius;
}

/** Build a deep, faceted hillside from the displayed (possibly morphing) shore. */
export function buildIslandContours(outline) {
  if (outline.length < 3) return { rings: [], extent: [], depth: 0 };
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    const cross = a.x * b.y - b.x * a.y;
    area += cross; cx += (a.x + b.x) * cross; cy += (a.y + b.y) * cross;
  }
  if (Math.abs(area) < 1e-8) return { rings: [], extent: [], depth: 0 };
  const center = { x: cx / (3 * area), y: cy / (3 * area) };
  const span = Math.sqrt(Math.abs(area) / 2), depth = span * .44;
  const tau = Math.PI * 2;
  // Include shore corners so resampling cannot cut across the original plateau.
  const angles = [...Array.from({ length: 280 }, (_, i) => i / 280 * tau),
    ...outline.map(p => (Math.atan2(p.y - center.y, p.x - center.x) + tau) % tau)]
    .sort((a, b) => a - b).filter((a, i, values) => !i || a - values[i - 1] > 1e-8);
  const rays = angles.map(angle => {
    const x = Math.cos(angle), y = Math.sin(angle), radius = shoreRadius(outline, center, x, y);
    const hill = ridgeNoise(angle, 7, 17), ridge = ridgeNoise(angle, 19, 53);
    const crag = ridgeNoise(angle, 47, 131), scree = ridgeNoise(angle, 109, 211);
    return { x, y, radius, hill, ridge, crag, scree, spread: 0 };
  });
  const rings = Array.from({ length: LEVELS }, (_, i) => {
    const level = i + 1, t = level / LEVELS;
    return { level: -level * .25, major: level % 8 === 0, z: -depth * t,
      points: rays.map(r => {
        // Different shoulders open at different depths. Positive increments keep
        // every ring nested while alternating cliffs, shelves, and long gullies.
        const shoulder = .2 + r.hill * .5;
        const foothill = Math.max(0, (t - shoulder) / (1 - shoulder));
        const shelf = .65 + .55 * Math.sin(t * 8.5 + r.hill * 5 + r.ridge * 2);
        const slope = .28 + r.hill * 1.45 + r.ridge * .65 + r.crag * .4 + r.scree * .17;
        r.spread += span * .31 / LEVELS * slope * (shelf + foothill * foothill * 1.2);
        return { x: center.x + r.x * (r.radius + r.spread),
          y: center.y + r.y * (r.radius + r.spread) };
      }) };
  });
  return { rings, depth, center, span,
    // Irregular shoulders can project beyond the bottom ring during an orbit.
    extent: [...outline.map(p => ({ ...p, z: 0 })), ...rings.flatMap(r => r.points.map(p => ({ ...p, z: r.z })))] };
}

export function createIslandContourCache() {
  const entries = new Map();
  return outline => {
    let hash = 2166136261;
    for (const p of outline) {
      hash = Math.imul(hash ^ Math.round(p.x * 4), 16777619);
      hash = Math.imul(hash ^ Math.round(p.y * 4), 16777619);
    }
    const key = `${outline.length}/${hash >>> 0}`;
    const geometry = entries.get(key) ?? buildIslandContours(outline);
    entries.delete(key); entries.set(key, geometry);
    if (entries.size > 4) entries.delete(entries.keys().next().value);
    return geometry;
  };
}

function path(ctx, points) {
  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.closePath();
}

function stroke(ctx, points, color, width = .7, dash = []) {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.stroke(); ctx.setLineDash([]);
}

/** Draw before the original top. Opaque terraces hide their rear contour lines. */
export function drawIslandContours(ctx, geometry, project, { theme = {}, drawContour = globalThis.SpecimenEnvironment?.drawContourPath } = {}) {
  const inheritedAlpha = ctx.globalAlpha ?? 1;
  ctx.save(); ctx.lineJoin = 'miter'; ctx.miterLimit = 2;
  const origin = project(0, 0, 0), unit = project(1, 0, 0);
  const zoom = Math.hypot(unit.x - origin.x, unit.y - origin.y);
  const dpr = Math.abs(ctx.getTransform?.().a ?? 1);
  let lastPeriod = ctx.getLineDash?.().length === 0 ? 0 : null, lastOffset = ctx.lineDashOffset;
  const setDash = (period, offset) => {
    if (period !== lastPeriod) { ctx.setLineDash?.(period ? [period * .58, period * .42] : []); lastPeriod = period; }
    if (offset !== lastOffset) { ctx.lineDashOffset = offset; lastOffset = offset; }
  };
  if (drawContour) setDash(0, 0);
  for (let i = geometry.rings.length - 1; i >= 0; i--) {
    const ring = geometry.rings[i], points = ring.points.map(p => project(p.x, p.y, ring.z));
    const dash = globalThis.SpecimenEnvironment?.contourDashStyle(`island/${i}`, zoom, dpr) ?? (() => {
      const period = 15 * Math.max(1e-12, zoom) * (.8 + .4 * ((i * .754877666) % 1));
      return { period, phase: period * ((i * .618033989) % 1) };
    })();
    ctx.globalAlpha = inheritedAlpha;
    path(ctx, points);
    ctx.fillStyle = ring.major ? (theme.path ?? '#101E2C') : (theme.ground ?? FILL); ctx.fill();
    const devicePeriod = dash.period * dpr, x = Math.max(0, Math.min(1, (devicePeriod - 3) / 3));
    const t = x * x * (3 - 2 * x);
    const passes = [{ solid: false, alpha: inheritedAlpha * t },
      { solid: true, alpha: inheritedAlpha * Math.max(.32, Math.min(.75, devicePeriod / 4)) * (1 - t) }];
    for (const pass of passes) {
      if (pass.alpha < .01) continue;
      ctx.globalAlpha = pass.alpha;
      if (drawContour) drawContour(ctx, points, { theme, closed: true, color: ring.major ? '#A2B8C4B8' : '#8AA4B47D',
        // Shared drawContourPath interprets id as a request to fade again. Supply explicit passes instead.
        width: ring.major ? 1 : .55, id: drawContour === globalThis.SpecimenEnvironment?.drawContourPath ? undefined : `island/${i}`,
        contourId: `island/${i}`, zoom, dpr, origin, period: dash.period, phase: dash.phase, solid: pass.solid });
      else {
        setDash(pass.solid ? 0 : dash.period, pass.solid ? 0 : dash.phase);
        ctx.strokeStyle = ring.major ? '#A2B8C4B8' : '#8AA4B47D';
        ctx.lineWidth = ring.major ? 1 : .55; ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function inside(point, polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

const surveyState = new WeakMap();
const FLIP_HYSTERESIS = .14;

/** Fixed world anchors for the labelled rings: computed once per ring geometry, never per frame. */
export function islandLabelAnchors(geometry) {
  let state = surveyState.get(geometry);
  if (state) return state.anchors;
  const tau = Math.PI * 2, center = geometry.center ?? { x: 0, y: 0 };
  const majors = geometry.rings.map((ring, index) => ({ ring, index })).filter(r => r.ring.major);
  const anchors = majors.map(({ ring, index }, k) => {
    // Fixed bearing per level, staggered so labels never stack in one column.
    const target = Math.PI * .42 + k * .3;
    let best = 0, bestDelta = Infinity;
    ring.points.forEach((p, j) => {
      const angle = Math.atan2(p.y - center.y, p.x - center.x);
      const delta = Math.abs(((angle - target) % tau + tau + Math.PI) % tau - Math.PI);
      if (delta < bestDelta) { bestDelta = delta; best = j; }
    });
    const n = ring.points.length;
    return { ring: index, vertex: best, level: ring.level, z: ring.z, point: ring.points[best],
      prev: ring.points[(best + n - 1) % n], next: ring.points[(best + 1) % n], flip: false };
  });
  surveyState.set(geometry, { anchors, shown: false });
  return anchors;
}

/** Height labels ride fixed terrain points. They are hidden, never relocated, when covered. The
 * datum and scale flags stay false: nothing screen-placed is drawn for them. */
export function drawIslandSurvey(ctx, geometry, outline, project, { width, height, exclusions = [] }) {
  const result = { labels: 0, datum: false, scale: false, placed: [] };
  if (!geometry.rings.length) return result;
  const anchors = islandLabelAnchors(geometry), state = surveyState.get(geometry);
  const top = outline.map(p => project(p.x, p.y, 0));
  const rings = geometry.rings.map(r => ({ ...r, screen: r.points.map(p => project(p.x, p.y, r.z)) }));
  const outer = rings.at(-1).screen;
  const left = Math.min(...outer.map(p => p.x)), right = Math.max(...outer.map(p => p.x));
  // Hysteresis on the size gate so zooming across it does not flicker the whole set.
  state.shown = right - left >= (state.shown ? 140 : 160);
  if (!state.shown) return result;
  const occupied = [...exclusions];
  const room = box => box.x > 12 && box.x + box.w < width - 12 && box.y > 12 && box.y + box.h < height - 55 && !occupied.some(b => intersects(box, b));
  ctx.save(); ctx.font = '10px ui-monospace, SFMono-Regular, Consolas, monospace';
  ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  for (const anchor of anchors) {
    const i = anchor.ring, p = project(anchor.point.x, anchor.point.y, anchor.z);
    const a = project(anchor.prev.x, anchor.prev.y, anchor.z), b = project(anchor.next.x, anchor.next.y, anchor.z);
    const label = '−' + Math.abs(anchor.level).toFixed(2), w = ctx.measureText(label).width + 10;
    let angle = Math.atan2(b.y - a.y, b.x - a.x);
    // Keep text upright; only flip once the tangent is clearly past vertical.
    const limit = Math.PI / 2 + FLIP_HYSTERESIS;
    const wrap = v => { v %= Math.PI * 2; return v > Math.PI ? v - Math.PI * 2 : v < -Math.PI ? v + Math.PI * 2 : v; };
    let current = wrap(anchor.flip ? angle + Math.PI : angle);
    if (Math.abs(current) > limit) { anchor.flip = !anchor.flip; current = wrap(anchor.flip ? angle + Math.PI : angle); }
    angle = current;
    const bw = Math.abs(Math.cos(angle)) * w + Math.abs(Math.sin(angle)) * 12 + 6;
    const bh = Math.abs(Math.sin(angle)) * w + Math.abs(Math.cos(angle)) * 12 + 6;
    const box = { x: p.x - bw / 2, y: p.y - bh / 2, w: bw, h: bh };
    if (!room(box)) continue;
    // Hidden by the plateau or any higher terrace: skip, never hunt for another spot.
    if (inside(p, top) || rings.slice(0, i).some(r => inside(p, r.screen))) continue;
    if ([{ x: box.x, y: box.y }, { x: box.x + bw, y: box.y },
      { x: box.x, y: box.y + bh }, { x: box.x + bw, y: box.y + bh }].some(corner => inside(corner, top))) continue;
    occupied.push(box); ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(angle);
    ctx.fillStyle = FILL; ctx.fillRect(-w / 2, -6, w, 12);
    ctx.textAlign = 'center'; ctx.fillStyle = INK; ctx.fillText(label, 0, 0); ctx.restore();
    result.labels++; result.placed.push({ ring: i, vertex: anchor.vertex, x: p.x, y: p.y });
  }

  ctx.restore(); return result;
}
