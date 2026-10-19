/** Procedural atlas. Canvas techniques adapted from collage-park.pages.dev.
 * Lobed union silhouettes, load-bearing limbs, cutout holes, and fine leaf lines.
 * Palette and data encoding belong to this garden. No external art.
 */
import { OBSERVATORY } from './observatory-theme.js';
const TW = 384, TH = 768, TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
export const SPECIES = Object.freeze(['build', 'conversation', 'orchestration', 'slow-burn', 'quick']);
export const SIZE_NAMES = Object.freeze(['Sapling', 'Young', 'Established', 'Mature', 'Veteran']);
export function seedHash(value) {
  let h = 2166136261;
  for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
export function seededRandom(seed) {
  let a = seedHash(seed);
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Larger classes grow more structural limbs and thicker trunks. */
export function growthProfile(sizeClass = 2) {
  const index = clamp(Math.round(Number(sizeClass) || 0), 0, 4);
  return Object.freeze({ index, limbs: [1, 2, 3, 5, 7][index], trunk: [5, 9, 14, 21, 29][index],
    lobes: [3, 4, 5, 7, 9][index], height: [98, 126, 155, 184, 214][index] });
}
export function specimenHeight(species, sizeClass) {
  return growthProfile(sizeClass).height * ({ build: 1, conversation: 1.04, orchestration: 1.17, 'slow-burn': 1.02, quick: .48 }[species] || 1);
}
export function speciesPalette(species, theme = OBSERVATORY) {
  const c = theme.canopies;
  const tone = { build: c[0], conversation: c[1], orchestration: c[2], 'slow-burn': c[0], quick: c[2] }[species] || c[0];
  return { f: tone.face, h: tone.top, l: tone.seam, t: theme.ink, b: tone.side };
}
function canvas(width, height) {
  const c = document.createElement('canvas'); c.width = width; c.height = height; return c;
}

function paintSpecimen(T, C, specimen, options = {}) {
  const species = SPECIES.includes(specimen.species) ? specimen.species : 'build';
  const g = growthProfile(specimen.sizeClass), r = seededRandom(specimen.seed ?? 'specimen');
  const P = speciesPalette(species, options.theme), density = specimen.density ?? 'medium';
  const d = typeof density === 'number' ? clamp(density, 0, 2) : ({ sparse: 0, medium: 1, dense: 2 }[density] ?? 1);
  const holeP = [.72, .25, .035][d], per = [3, 6, 9][d];
  const stems = (cx, y) => {
    const fx = TW / 2 + (r() - .5) * 22, fy = 660 + r() * 20;
    const result = [[TW / 2, TH - 2, fx, fy, g.trunk, g.trunk * .74, -6 + r() * 12, 5, 0]];
    for (let i = 0; i < g.limbs; i++) {
      const u = g.limbs === 1 ? 0 : i / (g.limbs - 1) * 2 - 1;
      result.push([fx, fy, cx + u * (38 + g.index * 9), y - r() * 42,
        g.trunk * .58, 2 + g.index * .5, u * 12, -u * 4, 1]);
    }
    return result;
  };
  const broad = { top: 160 + r() * 30, bot: 565 + r() * 24, rx: 151,
    lobes: g.lobes, per, rMin: 15, rMax: 31, core: [.18, .65, 1][d],
    tooth: 2.2, holeP, holeR: [24, 15, 7][d], edge: .64,
    hiP: .35, lobeHi: .85, veinA: .58, lineA: .58, stems };
  if (species === 'build' || species === 'conversation') {
    tBroad(T, C, r, P, { ...broad,
      top: species === 'conversation' ? 130 : broad.top,
      bot: species === 'conversation' ? 535 : broad.bot,
      core: species === 'conversation' ? [.05, .35, .7][d] : broad.core,
      holeP: species === 'conversation' ? Math.min(.9, holeP + .12) : holeP });
  } else if (species === 'slow-burn') {
    tWeep(T, C, r, P, { top: 165, dome: 145, rx: 158, forkY: 630,
      w0: g.trunk, limbs: g.limbs, n: 12 + g.lobes * per, rMin: 14, rMax: 28,
      strands: 12 + g.index * 3 + d * 6, lenMin: 190, lenMax: 370,
      wMin: [8, 13, 19][d], wMax: [19, 26, 35][d], taper: .42,
      gap: [.65, .3, .08][d], dashes: 50 + g.index * 20, dashA: .52, lineA: .58 });
  } else if (species === 'orchestration') {
    const vein = new (T.Path || Path2D)(), cx = TW / 2 + (r() - .5) * 14;
    const specs = [[TW / 2, TH - 2, cx, 85, g.trunk, 2, 5, -4, 1]];
    for (let i = 0; i < g.limbs; i++) {
      const y = 580 - i * 440 / g.limbs, side = i % 2 ? -1 : 1;
      specs.push([cx, y + 65, cx + side * (28 + r() * 20), y - 34,
        g.trunk * .45, 2, side * 9, 0, 1]);
    }
    const tops = tStems(T, vein, P, specs);
    const points = tScatter(r, (9 + g.lobes * per), 12, () => {
      const k = r(), y = lerp(90, 630, k), u = r() * 2 - 1;
      return [cx + u * (45 + g.index * 5) * Math.sin(Math.PI * (.06 + .87 * k)) ** .55, y, Math.abs(u)];
    });
    const cl = tMasses(r, points, 14, 25, 1.3), Y = tLayer(T.Path);
    tBranches(T, vein, r, P, tops, cl, .65);
    tAddMasses(Y, r, cl, { holeP, holeR: 18, hiP: .35, sprigs: .8 });
    tPaint(C, Y, P, .6); tVeins(C, vein, P, .64); T.drawImage(C.canvas, 0, 0);
  } else {
    const vein = new (T.Path || Path2D)(), base = TH - 5;
    const { cl, lb } = tCrown(r, TW / 2, base - 112, 151, 108,
      { lobes: g.lobes, per, rMin: 14, rMax: 27, core: [.15, .6, 1][d] });
    const specs = [];
    for (let i = 0; i < g.limbs; i++) {
      const u = g.limbs === 1 ? 0 : i / (g.limbs - 1) * 2 - 1;
      specs.push([TW / 2, TH - 2, TW / 2 + u * 80, 660 - r() * 25,
        g.trunk * .48, 2.2, u * 8, 0, 1]);
    }
    const tops = tStems(T, vein, P, specs), Y = tLayer(T.Path);
    tBranches(T, vein, r, P, tops, cl, .6);
    tAddMasses(Y, r, cl, { holeP, holeR: 18, hiP: .26, sprigs: 1.1 });
    tAddLobeHi(Y, r, lb, .85); tPaint(C, Y, P, .58);
    tDashes(C, r, P, 30 + g.index * 12, 35, TW - 35, 550, 737, 7, 18, .38);
    tVeins(C, vein, P, .55); T.drawImage(C.canvas, 0, 0);
  }
  // Sample the actual crown, so fruit never hangs in a hole or beside a branch.
  const pixels = options.geometry ? null : C.getImageData(0, 0, TW, TH).data;
  const fruit = options.geometry ? 5 : clamp(Math.floor(Number(specimen.fruit) || 0), 0, 12);
  const positions = [];
  for (let tries = 0; positions.length < fruit && tries < 6000; tries++) {
    const x = 20 + Math.floor(r() * (TW - 40)), y = 40 + Math.floor(r() * (TH - 80));
    if ((options.geometry ? !C.contains(x, y) : pixels[(y * TW + x) * 4 + 3] < 180) || positions.some(p => Math.hypot(p.x - x, p.y - y) < 28)) continue;
    positions.push({ x, y });
    if (options.geometry) continue;
    T.strokeStyle = P.l; T.lineWidth = 1.5; T.beginPath(); T.moveTo(x, y - 8); T.lineTo(x + 1, y); T.stroke();
    T.fillStyle = OBSERVATORY.canopies[3].top; T.beginPath(); T.ellipse(x, y + 4, 5.5, 7, -.15, 0, TAU); T.fill();
    T.fillStyle = OBSERVATORY.ink; T.globalAlpha = .55; T.beginPath(); T.arc(x - 1.5, y + 1.5, 1.2, 0, TAU); T.fill(); T.globalAlpha = 1;
  }
  if (options.geometry) options.geometry.fruit = positions;
  return species === 'conversation' ? .66 : species === 'slow-burn' ? .86 : .94;
}

/** Geometry recording uses the same painter as the sheet, without allocating a canvas.
 * Commands live only during preparation. Renderers may retain just crop/root/fruit metadata.
 */
class SpecimenPath {
  constructor() { this.commands = []; this.polygons = []; this.current = null; }
  moveTo(x, y) { this.commands.push(['moveTo', x, y]); this.current = [[x, y]]; this.polygons.push(this.current); }
  lineTo(x, y) { this.commands.push(['lineTo', x, y]); this.current?.push([x, y]); }
  closePath() { this.commands.push(['closePath']); }
  bezierCurveTo(...args) { this.commands.push(['bezierCurveTo', ...args]); }
  contains(x, y) {
    return this.polygons.some(points => {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i], b = points[j];
        if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      return inside;
    });
  }
}
function geometryContext(layer) {
  const commands = [], context = { Path: SpecimenPath, layer, commands,
    globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1,
    beginPath() { this.path = new SpecimenPath(); },
    moveTo(...args) { this.path.moveTo(...args); }, lineTo(...args) { this.path.lineTo(...args); },
    closePath() { this.path.closePath(); }, bezierCurveTo(...args) { this.path.bezierCurveTo(...args); },
    fill(path = this.path) { this.record('fill', path); }, stroke(path = this.path) { this.record('stroke', path); },
    drawImage() {}, // The live renderer keeps the crown separate from its supporting wood.
    record(kind, path) { commands.push({ kind, path, layer: this.layer, color: kind === 'fill' ? this.fillStyle : this.strokeStyle,
      alpha: this.globalAlpha, composite: this.globalCompositeOperation, lineWidth: this.lineWidth }); },
    contains(x, y) {
      let filled = false;
      for (const c of commands) {
        if (c.kind !== 'fill' || c.composite === 'source-atop') continue;
        if (c.path.contains(x, y)) filled = c.composite !== 'destination-out';
      }
      return filled;
    },
  };
  return context;
}
export function createSpecimenGeometry(specimen, { theme = OBSERVATORY } = {}) {
  const T = geometryContext('trunk'), C = geometryContext('crown'), metadata = {};
  const alpha = paintSpecimen(T, C, specimen, { theme, geometry: metadata });
  const layers = { trunk: [], branches: [], crown: C.commands };
  for (const command of T.commands) layers[command.layer].push(command);
  let x0 = TW, y0 = TH, x1 = 0;
  for (const command of [...T.commands, ...C.commands]) {
    if (command.composite !== 'source-over') continue;
    const pad = command.kind === 'stroke' ? command.lineWidth / 2 : 0;
    for (const [, ...coordinates] of command.path.commands) for (let i = 0; i < coordinates.length; i += 2) {
      x0 = Math.min(x0, coordinates[i] - pad); x1 = Math.max(x1, coordinates[i] + pad);
      y0 = Math.min(y0, coordinates[i + 1] - pad);
    }
  }
  x0 = Math.max(0, Math.floor(x0) - 3); x1 = Math.min(TW, Math.ceil(x1) + 4); y0 = Math.max(0, Math.floor(y0) - 3);
  const crop = { x: x0, y: y0, width: Math.max(1, x1 - x0), height: TH - y0 };
  return { crop, root: (TW / 2 - x0) / crop.width, aspect: crop.width / crop.height,
    height: specimenHeight(specimen.species, specimen.sizeClass), alpha, layers, fruit: metadata.fruit,
    containsCrown: (x, y) => C.contains(x, y) };
}
/** Replay one layer into an isolated cell. Source-atop and holes must never affect another cell. */
export function paintSpecimenLayer(ctx, geometry, layer, { behind = false, opaqueCoverage = false } = {}) {
  ctx.save(); const inheritedAlpha = ctx.globalAlpha;
  ctx.lineJoin = ctx.lineCap = 'round';
  // Reverse source-over wood behind the finished crown. Crown holes then reveal wood, never the scene.
  const commands = geometry.layers[layer] || [];
  for (const command of behind ? [...commands].reverse() : commands) {
    const available = typeof Path2D !== 'undefined';
    if (available && command.native === undefined) {
      const path = new Path2D();
      // Incomplete test/host shims must retain the operation-replay fallback.
      const supported = command.path.commands.every(([method]) => typeof path[method] === 'function');
      if (supported) for (const [method, ...args] of command.path.commands) path[method](...args);
      command.native = supported ? path : null;
    }
    const native = available && command.native;
    if (!native) {
      ctx.beginPath();
      for (const [method, ...args] of command.path.commands) ctx[method](...args);
    }
    ctx.globalCompositeOperation = behind ? 'destination-over' : command.composite;
    ctx.globalAlpha = inheritedAlpha * (opaqueCoverage ? 1 : command.alpha);
    ctx.fillStyle = ctx.strokeStyle = command.color; ctx.lineWidth = command.lineWidth;
    if (native) ctx[command.kind](command.native); else ctx[command.kind]();
  }
  ctx.restore();
}
/** One reusable fruit stamp; attachments belong to the crown geometry, not the raster bucket. */
export function paintSpecimenFruit(ctx, theme = OBSERVATORY) {
  ctx.save(); const alpha = ctx.globalAlpha;
  ctx.strokeStyle = theme.canopies[0].seam; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(1, 0); ctx.stroke();
  ctx.fillStyle = theme.canopies[3].top; ctx.beginPath(); ctx.ellipse(0, 4, 5.5, 7, -.15, 0, TAU); ctx.fill();
  ctx.fillStyle = theme.ink; ctx.globalAlpha = alpha * .55;
  ctx.beginPath(); ctx.arc(-1.5, 1.5, 1.2, 0, TAU); ctx.fill(); ctx.restore();
}

/** Atlas cells use cropped bounds; roots keep their original location after cropping. */
export function createTreeAtlas(specimens) {
  const cellWidth = 256, cellHeight = 448, columns = Math.min(8, Math.max(1, specimens.length));
  const atlas = canvas(columns * cellWidth, Math.max(1, Math.ceil(specimens.length / columns)) * cellHeight);
  const A = atlas.getContext('2d', { willReadFrequently: true }), scratch = canvas(TW, TH), crown = canvas(TW, TH);
  const T = scratch.getContext('2d', { willReadFrequently: true }), C = crown.getContext('2d', { willReadFrequently: true });
  T.lineJoin = T.lineCap = C.lineJoin = C.lineCap = 'round';
  const entries = specimens.map((specimen, index) => {
    T.clearRect(0, 0, TW, TH); C.clearRect(0, 0, TW, TH);
    const alpha = paintSpecimen(T, C, specimen), pixels = T.getImageData(0, 0, TW, TH).data;
    let x0 = TW, y0 = TH, x1 = 0;
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      if (pixels[(y * TW + x) * 4 + 3] < 8) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x);
    }
    x0 = Math.max(0, x0 - 3); x1 = Math.min(TW, x1 + 4); y0 = Math.max(0, y0 - 3);
    const width = x1 - x0, height = TH - y0, scale = Math.min((cellWidth - 8) / width, (cellHeight - 8) / height);
    const sx = index % columns * cellWidth + 4, sy = Math.floor(index / columns) * cellHeight + 4;
    A.imageSmoothingEnabled = true; A.imageSmoothingQuality = 'high';
    A.globalAlpha = alpha; A.drawImage(scratch, x0, y0, width, height, sx, sy, width * scale, height * scale);
    return { sx, sy, sw: width * scale, sh: height * scale, root: (TW / 2 - x0) / width,
      aspect: width / height, specimen, height: specimenHeight(specimen.species, specimen.sizeClass) };
  });
  return { canvas: atlas, entries, draw(ctx, index, x, y, height = entries[index]?.height, { shadow = true, alpha = 1 } = {}) {
    const entry = entries[index]; if (!entry) return null;
    const width = height * entry.aspect, left = x - width * entry.root;
    ctx.save(); const inheritedAlpha = ctx.globalAlpha * alpha; ctx.globalAlpha = inheritedAlpha;
    if (shadow) {
      ctx.fillStyle = OBSERVATORY.path; ctx.globalAlpha *= .4;
      for (let i = 2; i >= 0; i--) {
        ctx.beginPath(); ctx.ellipse(x + height * .06, y + 1, width * (.23 + i * .08), Math.max(2, width * (.035 + i * .014)), -.12, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = inheritedAlpha;
    }
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(atlas, entry.sx, entry.sy, entry.sw, entry.sh, left, y - height, width, height);
    ctx.restore(); return { x: left, y: y - height, width, height };
  } };
}

/** Live-only light. The sheet supplies one explicit demonstration flag. */
export function drawLiveSparkle(ctx, x, y, height, seconds, seed = 'live', { reducedMotion = false } = {}) {
  const t = reducedMotion ? 0 : seconds, r = seededRandom(seed), cy = y - height * .58, inheritedAlpha = ctx.globalAlpha;
  ctx.save();
  const radius = height * (.48 + Math.sin(t * 1.15) * .025);
  const glow = ctx.createRadialGradient(x, cy, 0, x, cy, radius);
  glow.addColorStop(0, OBSERVATORY.canopies[0].top + '18'); glow.addColorStop(.55, OBSERVATORY.ink + '0C'); glow.addColorStop(1, OBSERVATORY.ink + '00');
  ctx.fillStyle = glow; ctx.fillRect(x - radius, cy - radius, radius * 2, radius * 2);
  for (let i = 0; i < 7; i++) {
    const phase = r() * TAU, speed = .45 + r() * .5, angle = phase + t * .12;
    const px = x + Math.cos(angle) * height * (.25 + r() * .17), py = cy + Math.sin(angle) * height * (.24 + r() * .25);
    const pulse = reducedMotion ? .5 : Math.max(0, Math.sin(t * speed + phase)) ** 6;
    const length = 1.2 + pulse * 4;
    ctx.globalAlpha = inheritedAlpha * (.12 + pulse * .78); ctx.strokeStyle = OBSERVATORY.ink; ctx.lineWidth = .8;
    ctx.beginPath(); ctx.moveTo(px - length, py); ctx.lineTo(px + length, py);
    ctx.moveTo(px, py - length * 1.5); ctx.lineTo(px, py + length * 1.5); ctx.stroke();
  }
  ctx.restore();
}

function tPoly(paths, pts) {
  for (const p of paths) {
    p.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
    p.closePath();
  }
}
function tLine(p, a) {
  p.moveTo(a[0], a[1]);
  for (let i = 2; i < a.length; i += 2) p.lineTo(a[i], a[i + 1]);
}
/* part of a closed outline as an open line, centred near the top (a front leaf group's visible edge) */
function tArc(p, pts, r, frac) {
  const n = pts.length / 2;
  let top = 0;
  for (let i = 1; i < n; i++) if (pts[2 * i + 1] < pts[2 * top + 1]) top = i;
  const m = Math.max(3, (n * frac) | 0),
    i0 = (top - ((m * (0.2 + r() * 0.6)) | 0) + n) % n;
  p.moveTo(pts[2 * i0], pts[2 * i0 + 1]);
  for (let j = 1; j <= m; j++) {
    const i = (i0 + j) % n;
    p.lineTo(pts[2 * i], pts[2 * i + 1]);
  }
}
/* a leaf mass: lobed outline with a serrated edge of small leaf points; always wound the same way,
   so a nonzero fill of many masses in one path is their exact union */
function tMass(cx, cy, rx, ry, r, tooth = 2.6, step = 4) {
  const n = Math.max(12, (Math.PI * (rx + ry)) / step) | 0,
    k1 = 2 + ((r() * 3) | 0),
    k2 = 5 + ((r() * 4) | 0),
    k3 = 11 + ((r() * 7) | 0),
    p1 = r() * 6.283,
    p2 = r() * 6.283,
    p3 = r() * 6.283,
    a1 = 0.06 + r() * 0.1,
    a2 = 0.04 + r() * 0.05,
    a3 = 0.02 + r() * 0.035,
    a0 = r() * 6.283,
    da = 6.2832 / n,
    pts = [];
  for (let i = 0; i < n; i++) {
    const t = a0 + (i + (r() - 0.5) * 0.7) * da;
    let k = 1 + a1 * Math.sin(k1 * t + p1) + a2 * Math.sin(k2 * t + p2) + a3 * Math.sin(k3 * t + p3);
    if (r() < 0.025) k *= 0.86;
    const e = i & 1 ? tooth * (0.5 + r() * 1.1) : -tooth * r() * 0.4;
    pts.push(cx + Math.cos(t) * (rx * k + e), cy + Math.sin(t) * (ry * k + e));
  }
  return pts;
}
/* a pointed leaf sprig sticking out of a mass (dir a), serrated along both sides; same winding as tMass */
function tSprig(x, y, a, len, w, r) {
  const dx = Math.cos(a),
    dy = Math.sin(a),
    px = -dy,
    py = dx,
    pts = [x - px * w * 0.5, y - py * w * 0.5];
  for (const k of [0.35, 0.7]) {
    const s = (1 - k) * w * 0.5 + 1.5 + r() * 2;
    pts.push(x + dx * len * k - px * s, y + dy * len * k - py * s);
    pts.push(x + dx * len * (k + 0.1) - px * s * 0.45, y + dy * len * (k + 0.1) - py * s * 0.45);
  }
  pts.push(x + dx * len, y + dy * len);
  for (const k of [0.7, 0.35]) {
    const s = (1 - k) * w * 0.5 + 1.5 + r() * 2;
    pts.push(x + dx * len * (k + 0.1) + px * s * 0.45, y + dy * len * (k + 0.1) + py * s * 0.45);
    pts.push(x + dx * len * k + px * s, y + dy * len * k + py * s);
  }
  pts.push(x + px * w * 0.5, y + py * w * 0.5);
  return pts;
}
/* a hanging strand: pointed top, ragged sides, tapering to a tip; same winding as tMass */
function tStrand(x, y0, len, w, r, sway, jag) {
  const n = Math.max(3, (len / 6) | 0),
    R = [],
    L = [];
  let xo = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n,
      y = y0 + len * t,
      hw = (w / 2) * (1 - 0.7 * t ** 3);
    xo += (r() - 0.5) * 2.4;
    const xc = x + sway * t * t + xo;
    R.push(xc + hw + r() * jag, y);
    L.push(xc - hw - r() * jag, y);
  }
  const pts = [x, y0 - w * 0.25].concat(R);
  pts.push(x + sway + xo, y0 + len + 4 + r() * 10);
  for (let i = L.length - 2; i >= 0; i -= 2) pts.push(L[i], L[i + 1]);
  return pts;
}
/* a tapered limb on a cubic curve (b1, b2 push its thirds sideways): A and B are its two edges, M its centre */
function tLimb(x0, y0, x1, y1, w0, w1, b1, b2 = b1) {
  const dx = x1 - x0,
    dy = y1 - y0,
    L = Math.hypot(dx, dy) || 1,
    nx = -dy / L,
    ny = dx / L,
    c1x = x0 + dx / 3 + nx * b1,
    c1y = y0 + dy / 3 + ny * b1,
    c2x = x0 + (dx * 2) / 3 + nx * b2,
    c2y = y0 + (dy * 2) / 3 + ny * b2,
    n = Math.max(3, (L / 12) | 0),
    A = [],
    B = [],
    M = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n,
      u = 1 - t,
      x = u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x1,
      y = u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y1,
      tx = u * u * (c1x - x0) + 2 * u * t * (c2x - c1x) + t * t * (x1 - c2x),
      ty = u * u * (c1y - y0) + 2 * u * t * (c2y - c1y) + t * t * (y1 - c2y),
      tl = Math.hypot(tx, ty) || 1,
      w = lerp(w0, w1, t) / 2;
    A.push(x - (ty / tl) * w, y + (tx / tl) * w);
    B.push(x + (ty / tl) * w, y - (tx / tl) * w);
    M.push(x, y);
  }
  return { A, B, M, w: (w0 + w1) / 2 };
}
function tDrawLimb(g, L, P) {
  g.beginPath();
  g.moveTo(L.A[0], L.A[1]);
  for (let i = 2; i < L.A.length; i += 2) g.lineTo(L.A[i], L.A[i + 1]);
  for (let i = L.B.length - 2; i >= 0; i -= 2) g.lineTo(L.B[i], L.B[i + 1]);
  g.closePath();
  g.fillStyle = P.t;
  g.fill();
  g.beginPath();
  tLine(g, L.A);
  tLine(g, L.B);
  g.strokeStyle = P.b;
  g.lineWidth = 1.2;
  g.stroke();
}
/* stems: [x0, y0, x1, y1, w0, w1, b1, b2, isTop]; draws them and returns the tops that carry the crown */
function tStems(T, vein, P, specs) {
  T.layer = 'trunk';
  const tops = [];
  for (const s of specs) {
    const L = tLimb(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]);
    tDrawLimb(T, L, P);
    tLine(vein, L.A);
    tLine(vein, L.B);
    if (s[8]) tops.push([s[2], s[3], s[5]]);
  }
  return tops;
}
/* n slender stems splaying from one foot, gently S-curved, each forking once below the crown */
function tSplay(r, n, cx, y1, spread, w0, w1, fork = 0.8) {
  const s = [];
  for (let i = 0; i < n; i++) {
    const u = n > 1 ? (i / (n - 1)) * 2 - 1 : 0,
      x1 = cx + u * spread + (r() - 0.5) * 20,
      y = y1 + r() * 50 * (1 - Math.abs(u) * 0.5),
      b = (r() - 0.5) * 18;
    if (r() < fork) {
      const fy = lerp(TH, y, 0.88 + r() * 0.07),
        fx = lerp(TW / 2, x1, 0.92),
        wf = lerp(w0, w1, 0.7);
      s.push([TW / 2 + u * 3, TH - 2, fx, fy, w0 * (0.85 + r() * 0.3), wf, b, -b * 0.6, 0]);
      for (const k of [-1, 1])
        s.push([fx, fy, x1 + k * (8 + r() * 16), y - r() * 24, wf * 0.8, w1, k * 3 + (r() - 0.5) * 6, 0, 1]);
    } else s.push([TW / 2 + u * 3, TH - 2, x1, y, w0 * (0.85 + r() * 0.3), w1, b, -b * 0.6, 1]);
  }
  return s;
}
/* branches grown from the stem tops to every leaf mass: each mass joins the nearest node already on
   the tree (going downwards costs more), so limbs fork naturally; widths follow how much they carry */
function tBranches(T, vein, r, P, tops, cl, veinAll = 0.45) {
  T.layer = 'branches';
  const N = tops.map(([x, y, w], i) => ({ x, y, w, p: -1, n: 0, root: i })),
    R0 = N.length,
    todo = cl.map((c) => {
      const x = c[0],
        y = c[1] + c[3] * 0.25;
      let d = 1e9,
        root = 0;
      tops.forEach((t, i) => {
        const dd = Math.abs(t[0] - x) + Math.abs(t[1] - y) * 0.35;
        if (dd < d) {
          d = dd;
          root = i;
        }
      });
      return { x, y, d: Math.hypot(tops[root][0] - x, tops[root][1] - y), p: -1, n: 1, root };
    });
  todo.sort((a, b) => a.d - b.d);
  for (const c of todo) {
    let best = 0,
      bc = 1e9;
    for (let j = 0; j < N.length; j++) {
      const q = N[j];
      if (q.root !== c.root) continue;
      const d = Math.hypot(q.x - c.x, q.y - c.y) * (q.y < c.y - 4 ? 2.2 : 1);
      if (d < bc) {
        bc = d;
        best = j;
      }
    }
    c.p = best;
    N.push(c);
  }
  for (let i = N.length - 1; i >= R0; i--) N[N[i].p].n += N[i].n;
  const wOf = (c) =>
    c.p < 0 ? c.w : Math.max(1.1, N[c.root].w * Math.sqrt(c.n / Math.max(1, N[c.root].n)));
  for (let i = R0; i < N.length; i++) {
    const c = N[i],
      q = N[c.p],
      w1 = wOf(c),
      w0 = Math.min(wOf(q), w1 * 1.4),
      d = Math.hypot(c.x - q.x, c.y - q.y),
      L = tLimb(q.x, q.y, c.x, c.y, w0, w1, (r() - 0.5) * d * 0.3, (r() - 0.5) * d * 0.2);
    tDrawLimb(T, L, P);
    if (L.w > 2.6) {
      tLine(vein, L.A);
      tLine(vein, L.B);
    } else if (c.n > 1 || r() < veinAll) tLine(vein, L.M);
  }
}
/* rejection-sample points with a minimum spacing; gen() proposes [x, y, d] or null */
function tScatter(r, n, minD, gen) {
  const pts = [];
  for (let k = 0; pts.length < n && k < n * 40; k++) {
    const c = gen();
    if (!c) continue;
    let ok = true;
    for (const p of pts)
      if ((p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 < minD * minD) {
        ok = false;
        break;
      }
    if (ok) pts.push(c);
  }
  return pts;
}
/* points inside a lobed ellipse, thinning towards the rim */
function tEllipse(r, cx, cy, rx, ry, rim = 0.55) {
  const p1 = r() * 6.283,
    p2 = r() * 6.283,
    a1 = 0.1 + r() * 0.12;
  return () => {
    const a = r() * 6.283,
      d = Math.sqrt(r()),
      e = 1 + a1 * Math.sin(2 * a + p1) + 0.1 * Math.sin(3 * a + p2);
    if (d * 1.08 > e || (d > 0.7 && r() > rim)) return null;
    return [cx + Math.cos(a) * rx * d, cy + Math.sin(a) * ry * d, d];
  };
}
/* turn sampled points into leaf masses [x, y, rx, ry], kept inside the cell */
function tMasses(r, pts, rMin, rMax, sq = 0.85) {
  return pts.map(([x, y, d]) => {
    const R = lerp(rMax, rMin, d) * (0.8 + r() * 0.4),
      ry = R * (sq + r() * 0.3),
      m = R * 1.25 + 5;
    return [clamp(x, m, TW - m), Math.max(y, ry * 1.25 + 5), R, ry];
  });
}
/* a crown: a central lobe ringed by overlapping lobes (bumps on the outline), each densely packed with leaf masses */
function tCrown(r, cx, cy, rx, ry, o) {
  const nl = o.lobes ?? 6,
    lb = [[cx + (r() - 0.5) * rx * 0.2, cy + (r() - 0.5) * ry * 0.2, rx * 0.55, ry * 0.55]],
    cl = [],
    a0 = r() * 6.283;
  for (let i = 0; i < nl; i++) {
    const a = a0 + ((i + (r() - 0.5) * 0.6) / nl) * 6.283,
      s = 0.34 + r() * 0.24,
      k = 0.82 + r() * 0.22;
    lb.push([cx + Math.cos(a) * rx * (1 - s) * k, cy + Math.sin(a) * ry * (1 - s) * k, rx * s, ry * s]);
  }
  for (const [lx, ly, lrx, lry] of lb) {
    // a solid core per lobe (flag 1: no rim detail), ringed by the small masses that make the outline
    if (r() < (o.core ?? 0.85)) cl.push([clamp(lx, lrx * 0.8, TW - lrx * 0.8), ly, lrx * 0.62, lry * 0.58, 1]);
    const pts = tScatter(
      r,
      o.per ?? 8,
      o.rMin * 0.85,
      tEllipse(r, lx, ly, Math.max(4, lrx - o.rMin * 0.8), Math.max(4, lry - o.rMin * 0.8), 0.9),
    );
    for (const m of tMasses(r, pts, o.rMin, o.rMax, o.sq ?? 0.8)) cl.push(m);
  }
  return { cl, lb };
}
/* a crown layer: union fill, posterised highlight patches, holes, then the interior linework */
function tLayer(Path = Path2D) {
  return { all: new Path(), edge: new Path(), hi: new Path(), holes: new Path() };
}
function tAddMasses(Y, r, cl, o = {}) {
  const tooth = o.tooth ?? 2.6,
    step = o.step ?? 4;
  let mx = 0,
    my = 0;
  for (const c of cl) {
    mx += c[0] / cl.length;
    my += c[1] / cl.length;
  }
  for (const [x, y, rx, ry, core] of cl) {
    const m = tMass(x, y, rx, ry, r, tooth, step);
    tPoly([Y.all], m);
    if (core) continue;
    const out = Math.atan2(y - my, x - mx);
    for (let k = (r() * (o.sprigs ?? 2.2)) | 0; k > 0; k--) {
      const a = out + (r() - 0.5) * 2.2,
        l = 12 + r() * 14,
        sx = x + Math.cos(a) * rx * 0.8,
        sy = y + Math.sin(a) * ry * 0.8,
        tx = sx + Math.cos(a) * (l + 4),
        ty = sy + Math.sin(a) * (l + 4);
      if (tx > 6 && tx < TW - 6 && ty > 6) tPoly([Y.all], tSprig(sx, sy, a, l, 9 + r() * 7, r));
    }
    if (r() < (o.edge ?? 0.55)) tArc(Y.edge, m, r, 0.3 + r() * 0.35);
    if (r() < (o.hiP ?? 0.25)) {
      const s = 0.4 + r() * 0.3;
      tPoly(
        [Y.hi],
        tMass(x - rx * (0.12 + r() * 0.25), y - ry * (0.2 + r() * 0.25), rx * s, ry * s * 0.8, r, tooth * 0.8, step),
      );
    }
    if (r() < (o.holeP ?? 0.1)) {
      const a = r() * 6.283,
        s = 2.5 + r() * r() * (o.holeR ?? 13);
      tPoly(
        [Y.holes],
        tMass(x + Math.cos(a) * rx * 0.9, y + Math.sin(a) * ry * 0.9, s * (0.7 + r() * 0.6), s * (0.5 + r() * 0.6), r, 1.6, 3),
      );
    }
  }
}
/* sunlit top of each lobe as one bigger posterised patch */
function tAddLobeHi(Y, r, lb, p = 0.75, tooth = 2.6) {
  for (const [x, y, lrx, lry] of lb)
    if (r() < p)
      tPoly(
        [Y.hi],
        tMass(x - lrx * (0.1 + r() * 0.2), y - lry * (0.3 + r() * 0.15), lrx * (0.45 + r() * 0.2), lry * (0.3 + r() * 0.15), r, tooth, 4),
      );
}
function tPaint(C, Y, P, lineA = 0.75) {
  C.globalCompositeOperation = "source-over";
  C.fillStyle = P.f;
  C.fill(Y.all);
  C.globalCompositeOperation = "source-atop";
  C.fillStyle = P.h;
  C.fill(Y.hi);
  C.globalCompositeOperation = "destination-out";
  C.fill(Y.holes);
  C.globalCompositeOperation = "source-atop";
  C.strokeStyle = P.l;
  C.lineWidth = 1.2;
  C.globalAlpha = lineA;
  C.stroke(Y.edge);
  C.globalAlpha = lineA * 0.8;
  C.stroke(Y.hi);
  C.globalAlpha = 1;
  C.globalCompositeOperation = "source-over";
}
function tVeins(C, vein, P, a = 0.6) {
  C.globalCompositeOperation = "source-atop";
  C.strokeStyle = P.l;
  C.lineWidth = 1.1;
  C.globalAlpha = a;
  C.stroke(vein);
  C.globalAlpha = 1;
  C.globalCompositeOperation = "source-over";
}
/* short wavy dashes inside a crown (willow and shrub texture) */
function tDashes(C, r, P, n, x0, x1, y0, y1, l0, l1, a = 0.5) {
  C.globalCompositeOperation = "source-atop";
  C.strokeStyle = P.l;
  C.globalAlpha = a;
  C.lineWidth = 1.1;
  C.beginPath();
  for (let i = 0; i < n; i++) {
    const x = lerp(x0, x1, r()),
      y = lerp(y0, y1, r()),
      l = lerp(l0, l1, r());
    C.moveTo(x, y);
    C.bezierCurveTo(x + (r() - 0.5) * 6, y + l / 3, x + (r() - 0.5) * 6, y + (2 * l) / 3, x + (r() - 0.5) * 4, y + l);
  }
  C.stroke();
  C.globalAlpha = 1;
  C.globalCompositeOperation = "source-over";
}
/* a broadleaf: stems, branches, one lobed crown */
function tBroad(T, C, r, P, o) {
  const cx = TW / 2 + (r() - 0.5) * (o.lean ?? 24),
    cy = (o.top + o.bot) / 2,
    ry = (o.bot - o.top) / 2,
    vein = new (T.Path || Path2D)(),
    { cl, lb } = tCrown(r, cx, cy, o.rx, ry, o),
    tops = tStems(T, vein, P, o.stems(cx, o.bot + (o.below ?? 10)));
  tBranches(T, vein, r, P, tops, cl);
  const Y = tLayer(T.Path);
  tAddMasses(Y, r, cl, o);
  tAddLobeHi(Y, r, lb, o.lobeHi ?? 0.75);
  tPaint(C, Y, P, o.lineA);
  tVeins(C, vein, P, o.veinA);
  T.drawImage(C.canvas, 0, 0);
}
/* a weeping tree: a rounded dome of leaf masses with a curtain of ragged strands hanging from it */
function tWeep(T, C, r, P, o) {
  const cx = TW / 2 + (r() - 0.5) * 16,
    vein = new (T.Path || Path2D)(),
    fy = o.forkY + r() * 30,
    fx = TW / 2 + (r() - 0.5) * 30,
    dcy = o.top + o.dome,
    surf = (u) => dcy - o.dome * Math.sqrt(Math.max(0, 1 - u * u));
  const specs = [[TW / 2, TH - 2, fx, fy, o.w0, o.w0 * 0.75, (r() - 0.5) * 20, (r() - 0.5) * 20, 0]];
  for (let i = 0; i < o.limbs; i++) {
    const u = o.limbs > 1 ? (i / (o.limbs - 1)) * 2 - 1 : 0;
    specs.push([fx, fy, cx + u * o.rx * 0.5, surf(u * 0.5) + 60, o.w0 * 0.55, 3, u * 34, u * 12, 1]);
  }
  const tops = tStems(T, vein, P, specs);
  // dome: masses in the upper half of an ellipse, a little taller than wide
  const pts = tScatter(r, o.n, o.rMin * 1.1, () => {
      const u = r() * 2 - 1,
        y = lerp(surf(u) + o.rMin, dcy + 30, r());
      return [cx + u * (o.rx - o.rMin), y, Math.abs(u)];
    }),
    cl = tMasses(r, pts, o.rMin, o.rMax, 1.3);
  tBranches(T, vein, r, P, tops, cl, 0.3);
  const Y = tLayer(T.Path);
  tAddMasses(Y, r, cl, { tooth: 3.2, edge: 0.4, hiP: 0.25, holeP: 0, sprigs: 1.5 });
  let lowest = 0;
  const ph = r() * 6.283,
    fq = 2.5 + r() * 2.5;
  for (let i = 0; i < o.strands; i++) {
    const u = (i / (o.strands - 1)) * 2 - 1 + (r() - 0.5) * 0.06,
      y0 = surf(u) + 40 + r() * 36,
      g = clamp(0.5 + 0.35 * Math.sin(u * fq + ph) + (r() - 0.5) * 0.55, 0, 1),
      len = Math.min(lerp(o.lenMin, o.lenMax, g) * (1 - u * u * o.taper), TH - 40 - y0),
      w = lerp(o.wMin, o.wMax, r()),
      x = clamp(cx + u * (o.rx - 16), w / 2 + 16, TW - w / 2 - 16),
      s = tStrand(x, y0, len, w, r, (r() - 0.5) * 10, 2.4);
    lowest = Math.max(lowest, y0 + len);
    tPoly([Y.all], s);
    if (r() < 0.35) tLine(Y.edge, s.slice(4, 4 + ((s.length / 2) | 0)));
    if (r() < (o.hiS ?? 0.3)) {
      const hy = y0 + len * (0.2 + r() * 0.3),
        hw = w * (0.22 + r() * 0.15);
      tPoly([Y.hi], tMass(x + (r() - 0.5) * w * 0.5, hy, hw, hw * (4 + r() * 3), r, 2.4, 4));
    }
    if (r() < o.gap)
      tPoly([Y.holes], tStrand(x + w * 0.5, y0 + len * (0.55 + r() * 0.25), len * 0.35, 3 + r() * 5, r, 0, 1));
  }
  tPaint(C, Y, P, o.lineA ?? 0.7);
  tDashes(C, r, P, o.dashes, cx - o.rx, cx + o.rx, o.top + 40, lowest - 50, 12, 50, o.dashA ?? 0.55);
  tVeins(C, vein, P, 0.45);
  T.drawImage(C.canvas, 0, 0);
}
