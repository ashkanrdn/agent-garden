/**
 * Deterministic, uncapped, capacity-fitted Voronoi garden geometry.
 *
 * `birth`, `work`, and `sessionCount` describe the selected playhead. Callers
 * must not supply a latest-state session count or work score during replay.
 * Camera clipping and selection never change the projects passed here.
 * Returned polygons are counterclockwise world coordinates; cells share edges.
 */
// Generous lots: ~1.8x the earlier base, with far more room per session tree.
const BASE_PLOT_AREA = 200_000;
const TREE_AREA = 38_000;
const WORK_AREA = 5_000;
const INITIAL_WORLD_AREA = 1_200_000;
export const TREE_SPACING = 1.6;

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) {
    value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  }
  return value >>> 0;
}

function positive(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function polygonMetrics(polygon) {
  let twiceArea = 0, x = 0, y = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
  }
  return { area: twiceArea / 2, centroid: { x: x / (3 * twiceArea), y: y / (3 * twiceArea) } };
}

function boundsOf(polygon) {
  const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function organicOutline(seed) {
  const random = (() => { let state = hash(seed + '/shore') || 1; return () => {
    state = (state + 0x6d2b79f5) >>> 0; let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();
  const phase = random() * Math.PI * 2;
  const aspect = 1.25 + random() * .15;
  // Piecewise-linear noise keeps sharp corners at every knot. Three octaves
  // give headlands, bays, and rocky teeth; the sum stays shallow relative to
  // a lot so clipping the shore never splits a parcel into two pieces.
  const octave = (knots, amplitude) => {
    const values = Array.from({ length: knots }, () => random() * 2 - 1);
    return a => { const u = a / (Math.PI * 2) * knots, k = Math.floor(u) % knots, f = u - Math.floor(u);
      return amplitude * (values[k] * (1 - f) + values[(k + 1) % knots] * f); };
  };
  const octaves = [octave(7, .05), octave(19, .04), octave(47, .03)];
  const count = 120;
  const polygon = Array.from({ length: count }, (_, i) => {
    const a = (i + (random() - .5) * .7) / count * Math.PI * 2;
    const wrapped = (a + Math.PI * 2) % (Math.PI * 2);
    const tooth = (random() - .5) * .05;
    const r = 1 + .05 * Math.cos(3 * a + phase) + octaves.reduce((sum, f) => sum + f(wrapped), 0) + tooth;
    return { x: r * Math.cos(a) * Math.sqrt(aspect), y: r * Math.sin(a) / Math.sqrt(aspect) };
  });
  const unit = 1 / Math.sqrt(polygonMetrics(polygon).area);
  const bounds = boundsOf(polygon);
  return polygon.map(p => ({ x: (p.x - bounds.x) * unit, y: (p.y - bounds.y) * unit }));
}

function clip(polygon, nx, ny, limit, neighbor) {
  const output = [];
  if (!polygon.length) return output;
  let a = polygon.at(-1), da = nx * a.x + ny * a.y - limit;
  for (const b of polygon) {
    const db = nx * b.x + ny * b.y - limit;
    const insideA = da <= 1e-13, insideB = db <= 1e-13;
    if (insideA !== insideB) {
      const t = da / (da - db);
      output.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
        edge: insideA ? b.edge : neighbor });
    }
    if (insideB) output.push(b);
    a = b; da = db;
  }
  return output;
}

function diagram(outline, sites, powers) {
  return sites.map((site, i) => {
    let polygon = outline.map(p => ({ ...p, edge: -1 }));
    for (let j = 0; j < sites.length && polygon.length; j++) {
      if (i === j) continue;
      const other = sites[j];
      polygon = clip(polygon, 2 * (other.x - site.x), 2 * (other.y - site.y),
        other.x * other.x + other.y * other.y - site.x * site.x - site.y * site.y + powers[i] - powers[j], j);
    }
    return { polygon, ...polygonMetrics(polygon) };
  });
}

function initialSites(items, outline, seed) {
  const bounds = boundsOf(outline), center = polygonMetrics(outline).centroid;
  // Area-aware stratification gives large projects space before power fitting.
  // These are only sites: the delivered cells are all true power cells.
  const rectangles = [];
  function split(start, end, x, y, w, h) {
    if (end - start === 1) { rectangles[start] = { x: x + w / 2, y: y + h / 2 }; return; }
    let total = 0; for (let i = start; i < end; i++) total += items[i].weight;
    let sum = 0, best = Infinity, cut = start + 1, fraction = items[start].weight / total;
    for (let i = start; i < end - 1; i++) {
      sum += items[i].weight;
      if (Math.abs(sum - total / 2) < best) { best = Math.abs(sum - total / 2); cut = i + 1; fraction = sum / total; }
    }
    if (w > h) { split(start, cut, x, y, w * fraction, h); split(cut, end, x + w * fraction, y, w * (1 - fraction), h); }
    else { split(start, cut, x, y, w, h * fraction); split(cut, end, x, y + h * fraction, w, h * (1 - fraction)); }
  }
  split(0, items.length, -1, -1, 2, 2);
  return rectangles.map((p, i) => {
    // Keep seed sites inside a conservative inscribed ellipse.
    const angle = (hash(seed + '/' + items[i].id) / 4294967295 - .5) * .035;
    const x = p.x * Math.sqrt(1 - p.y * p.y / 2), y = p.y * Math.sqrt(1 - p.x * p.x / 2);
    return { x: center.x + (x * Math.cos(angle) - y * Math.sin(angle)) * bounds.w * .37,
      y: center.y + (x * Math.sin(angle) + y * Math.cos(angle)) * bounds.h * .37 };
  });
}

function powerStep(cells, sites, error) {
  // The shared-edge lengths are the exact area derivatives of a power diagram.
  const edges = cells.map((cell, i) => cell.polygon.flatMap((b, k, polygon) => {
    if (b.edge < 0) return [];
    const a = polygon[(k + polygon.length - 1) % polygon.length], other = sites[b.edge];
    const coefficient = Math.hypot(b.x - a.x, b.y - a.y) / (2 * Math.hypot(other.x - sites[i].x, other.y - sites[i].y));
    return [{ neighbor: b.edge, coefficient }];
  }));
  const n = sites.length, result = new Float64Array(n), residual = Float64Array.from(error), direction = Float64Array.from(error);
  let norm = residual.reduce((sum, v) => sum + v * v, 0);
  const initial = norm;
  for (let iteration = 0; iteration < n * 2 && norm > Math.max(1e-24, initial * 1e-14); iteration++) {
    const product = direction.map((v, i) => edges[i].reduce((sum, edge) => sum + edge.coefficient * (v - direction[edge.neighbor]), 1e-10 * v));
    const denominator = direction.reduce((sum, v, i) => sum + v * product[i], 0);
    if (denominator <= 0) break;
    const alpha = norm / denominator;
    for (let i = 0; i < n; i++) { result[i] += alpha * direction[i]; residual[i] -= alpha * product[i]; }
    const nextNorm = residual.reduce((sum, v) => sum + v * v, 0), beta = nextNorm / norm;
    for (let i = 0; i < n; i++) direction[i] = residual[i] + beta * direction[i];
    norm = nextNorm;
  }
  return result;
}

function fitAreas(outline, sites, powers, targets, maxIterations = 35) {
  let cells = diagram(outline, sites, powers), iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    const error = cells.map((cell, i) => targets[i] - cell.area);
    if (error.every((value, i) => Math.abs(value) / targets[i] < .003)) break;
    const loss = error.reduce((sum, value) => sum + value * value, 0);
    const step = powerStep(cells, sites, error);
    let accepted = false;
    for (let fraction = 1; fraction >= 1 / 4096; fraction /= 2) {
      const trial = powers.map((value, i) => value + step[i] * fraction);
      const candidate = diagram(outline, sites, trial);
      const nextLoss = candidate.reduce((sum, cell, i) => sum + (targets[i] - cell.area) ** 2, 0);
      if (candidate.every((cell, i) => cell.area > targets[i] * .0001) && nextLoss < loss) {
        powers = trial; cells = candidate; accepted = true; break;
      }
    }
    if (!accepted) break;
  }
  return { cells, powers, iterations };
}

export function buildGardenLayout(projects, { day = Infinity, seed = '483765r937n', spacing = TREE_SPACING } = {}) {
  if (!Array.isArray(projects)) throw new TypeError('Garden projects must be an array.');
  if (typeof day !== 'number' || Number.isNaN(day)) throw new TypeError('Garden day must be a number.');
  if (!Number.isFinite(spacing) || spacing <= 0) throw new TypeError('Tree spacing must be positive.');
  const ids = new Set();
  const items = [];
  for (const project of projects) {
    if (typeof project.id !== 'string' || !project.id) throw new TypeError('Every project needs a stable ID.');
    if (ids.has(project.id)) throw new TypeError(`Duplicate garden project: ${project.id}`);
    ids.add(project.id);
    const birth = project.birth ?? 0;
    if (typeof birth !== 'number' || !Number.isFinite(birth)) throw new TypeError('Project birth must be finite.');
    if (birth > day) continue;
    const work = positive(project.work ?? project.score);
    const sessionCount = Math.floor(positive(project.sessionCount));
    const weight = BASE_PLOT_AREA + TREE_AREA * sessionCount + WORK_AREA * Math.log1p(work);
    items.push({ id: project.id, birth, work, sessionCount, weight });
  }
  items.sort((a, b) => a.birth - b.birth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!items.length) return { bounds: { x: 0, y: 0, w: 0, h: 0 }, outline: [], plots: [], area: 0 };
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  // Scale world area so every lot, shared edge, shore, and in-lot gap grows together.
  const area = Math.max(INITIAL_WORLD_AREA, total) * spacing ** 2, unit = Math.sqrt(area);
  const outline = organicOutline(String(seed));
  const targets = items.map(item => item.weight / total);
  let sites = initialSites(items, outline, String(seed)), powers = new Float64Array(items.length), fit, iterations = 0;
  // Lloyd relaxation rounds off the initial stratification. Power fitting then
  // restores each project's requested share; no project is removed to make room.
  for (let round = 0; round < 4; round++) {
    fit = fitAreas(outline, sites, powers, targets);
    iterations += fit.iterations;
    if (round < 3) {
      sites = fit.cells.map(cell => cell.centroid);
      // Zero powers keep every distinct centroid's starting cell nonempty.
      powers = new Float64Array(items.length);
    }
  }
  const worldPoint = p => ({ x: p.x * unit, y: p.y * unit });
  const worldOutline = outline.map(worldPoint);
  const plots = fit.cells.map((cell, i) => {
    const polygon = cell.polygon.map(worldPoint);
    return { ...items[i], ...boundsOf(polygon), polygon, centroid: worldPoint(cell.centroid),
      site: worldPoint(sites[i]), power: fit.powers[i] * area, area: cell.area * area, targetArea: targets[i] * area };
  });
  return { bounds: boundsOf(worldOutline), outline: worldOutline, plots, area,
    fitting: { method: 'clipped-power-diagram', iterations, tolerance: .003,
      maxRelativeAreaError: Math.max(...plots.map(p => Math.abs(p.area - p.targetArea) / p.targetArea)) } };
}
