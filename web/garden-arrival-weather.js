import { createContourCloud, sampleContourCloud, drawContourCloud, drawStepLeader } from './cloud-growth.js';
import { sampleArrival } from './procedural-clouds.js';

// The approved cloud-study controls. The session id changes only the layout.
export const GARDEN_CONTOUR_PRESET = Object.freeze({
  starts: 5, per: 3, rmin: 19.4, rmax: 25, spread: 1.45, stretch: .66,
  spacing: 6.6, thickness: 5, threshold: .4, mode: 'metaball', fillet: 16.3,
  innerLines: 3, gradient: 'plate', bottomColor: '#8A9FEB', topColor: '#FFC798',
});
// Cloud units (x scale). Lowest plate rim sits ~127 units above ground, the canopy top ~200,
// so 140 leaves a clear gap of ~67 units (about a third of the tree height).
export const CLOUD_LIFT = 140;
export const GARDEN_WEATHER_EXTENT = Object.freeze({ halfWidth: 190, rise: 290 + CLOUD_LIFT, below: 30 });

export function gardenWeatherBounds(root, unit) {
  return { x: root.x - GARDEN_WEATHER_EXTENT.halfWidth * unit,
    y: root.y - GARDEN_WEATHER_EXTENT.rise * unit,
    w: GARDEN_WEATHER_EXTENT.halfWidth * 2 * unit,
    h: (GARDEN_WEATHER_EXTENT.rise + GARDEN_WEATHER_EXTENT.below) * unit };
}

export function sessionCloudSeed(id) {
  let hash = 2166136261;
  for (const character of String(id)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function createGardenArrivalCloud(id) {
  const baseSeed = sessionCloudSeed(id);
  for (let attempt = 0; attempt < 8; attempt++) {
    const cloud = createContourCloud((baseSeed + attempt * 7919) >>> 0, GARDEN_CONTOUR_PRESET);
    if (cloud.leader.length) return cloud;
  }
  throw new RangeError('Session cloud has no rim-attached leader');
}

export function drawGardenArrivalLight(ctx, state, view) {
  if (state.lightning <= 0 || state.cloud <= 0) return;
  const unit = view.scale || 1;
  const radius = 110 * unit;
  const centerY = view.y - (80 + CLOUD_LIFT) * unit;
  const glow = ctx.createRadialGradient(view.x, centerY, 0, view.x, centerY, radius);
  glow.addColorStop(0, `rgba(255, 199, 152, ${(.13 * state.lightning).toFixed(3)})`);
  glow.addColorStop(1, 'rgba(255, 199, 152, 0)');
  ctx.save();
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(view.x, centerY, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawGardenArrivalCloud(ctx, cloud, state, view, { texture = null, opacity = .85 } = {}) {
  if (state.cloud <= 0) return { plates: 0, drops: 0, segments: 0 };
  const frame = sampleContourCloud(cloud, state.elapsed);
  const weather = drawContourCloud(ctx, frame, state, view, { texture, opacity, lift: CLOUD_LIFT });
  const leader = drawStepLeader(ctx, cloud, state, view, { opacity, lift: CLOUD_LIFT });
  return { ...weather, segments: leader.segments };
}

/** The one place that decides how big a session cloud is drawn and where: shared by the draw path and the camera fit. */
export const ARRIVAL_CLOUD_YAW = -.25;
export function arrivalCloudUnit(treeHeight) { return Math.max(.22, Math.min(1.6, (treeHeight || 40) / 200)); }
export function arrivalCloudView(root, treeHeight, cameraYaw = 0) {
  return { x: root.x, y: root.y, scale: arrivalCloudUnit(treeHeight), yaw: ARRIVAL_CLOUD_YAW + (cameraYaw || 0) };
}

/**
 * A recording 2D context: it draws nothing and keeps the extent of every coordinate the draw code submits (path points,
 * ellipses, arcs, images), plus the widest stroke. Measuring through the real draw code means the measurement cannot
 * drift from what is painted (plates, rain, splashes, step leader, glow).
 */
export function createBoundsRecorder() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, widest = 0, count = 0;
  const add = (x, y, px = 0, py = px) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x - px); maxX = Math.max(maxX, x + px); minY = Math.min(minY, y - py); maxY = Math.max(maxY, y + py); count++;
  };
  const gradient = () => ({ addColorStop() {} });
  const ctx = {
    globalAlpha: 1, lineWidth: 1, fillStyle: '', strokeStyle: '', lineCap: '', lineJoin: '',
    save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {}, fill() {}, setLineDash() {}, translate() {}, scale() {}, rotate() {},
    stroke() { widest = Math.max(widest, Number(this.lineWidth) || 0); },
    moveTo: add, lineTo: add,
    quadraticCurveTo(cx, cy, x, y) { add(cx, cy); add(x, y); },
    bezierCurveTo(ax, ay, bx, by, x, y) { add(ax, ay); add(bx, by); add(x, y); },
    rect(x, y, w, h) { add(x, y); add(x + w, y + h); },
    arc(x, y, r) { add(x, y, r); },
    ellipse(x, y, rx, ry) { add(x, y, Math.abs(rx), Math.abs(ry)); },
    drawImage(image, ...a) { if (a.length >= 4) { const [x, y, w, h] = a.slice(-4); add(x, y); add(x + w, y + h); } },
    createLinearGradient: gradient, createRadialGradient: gradient,
  };
  return { ctx, bounds() {
    if (!count) return null;
    const pad = widest / 2;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + widest, h: maxY - minY + widest };
  } };
}

function unionBounds(a, b) {
  if (!a) return b; if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * Screen-space bounding box of everything an arrival cloud paints for one state and view: plates and walls, lifted
 * rain and splashes, the step leader, and the lightning glow. Returns null when nothing is drawn.
 */
export function measureArrivalCloud(cloud, state, view, { opacity = .85 } = {}) {
  const recorder = createBoundsRecorder();
  drawGardenArrivalLight(recorder.ctx, state, view);
  drawGardenArrivalCloud(recorder.ctx, cloud, state, view, { texture: null, opacity });
  return recorder.bounds();
}

const GROWN_SAMPLE_MS = [1500, 3000, 4500, 6850, 12000, 13000, 13500, 13900];
const GROWN_YAWS = Array.from({ length: 12 }, (_, i) => i / 12 * Math.PI * 2);
const grownExtents = new WeakMap();
/**
 * The largest extent the cloud reaches over its whole life (gathering, settled with rain, the lightning leader and glow,
 * dispersal), relative to the tree root at scale 1, over every yaw. Fitting to it means the view does not keep zooming
 * out as the cloud grows. Cached per cloud: measuring rebuilds a few plate frames once.
 */
export function arrivalCloudExtent(cloud) {
  if (grownExtents.has(cloud)) return grownExtents.get(cloud);
  let extent = null;
  for (const elapsed of GROWN_SAMPLE_MS) {
    const state = sampleArrival(elapsed);
    for (const yaw of GROWN_YAWS) extent = unionBounds(extent, measureArrivalCloud(cloud, state, { x: 0, y: 0, scale: 1, yaw }));
  }
  // Yaws are sampled every 30 degrees; a small pad covers the gaps between them.
  const padX = extent.w * .02, padY = extent.h * .02;
  extent = { x: extent.x - padX, y: extent.y - padY, w: extent.w + padX * 2, h: extent.h + padY * 2 };
  grownExtents.set(cloud, extent);
  return extent;
}

/** Largest measured cloud extent placed at a tree root drawn at `unit`: the measured replacement for gardenWeatherBounds. */
export function arrivalCloudBounds(cloud, root, unit) {
  const e = arrivalCloudExtent(cloud);
  return { x: root.x + e.x * unit, y: root.y + e.y * unit, w: e.w * unit, h: e.h * unit };
}
