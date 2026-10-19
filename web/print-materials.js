/**
 * Small, deterministic Canvas 2D print materials. No scene or application state.
 * Paper construction and seeded ink treatment adapt ideas and small helpers from
 * procedural-film, Copyright (c) 2026 Dean Kuhn, MIT licensed.
 * The complete notice is in third-party/procedural-film-LICENSE.txt.
 */

export const PRINT_PALETTE = Object.freeze({
  paper: '#F3EADB', paperLight: '#FCF5E8', paperShade: '#E2D2B8',
  ink: '#2C4070', inkSoft: '#516283', inkFaint: '#8D96A3',
  teal: '#008F87', tealDeep: '#246861', tealLight: '#75B9A0',
  leaf: '#79A66B', leafLight: '#B9CD87', leafDeep: '#356B58',
  yellow: '#F4C23D', ochre: '#C59943', coral: '#EA694E',
  bark: '#BC9567', barkLight: '#DDC08A', barkDeep: '#80664F',
  soil: '#D7C9A4', bed: '#BCCB98', path: '#EFE0BC',
});

const TAU = Math.PI * 2;
const clamp = (number, min = 0, max = 1) => Math.max(min, Math.min(max, number));
const mix = (a, b, amount) => a + (b - a) * amount;
const smooth = value => (value = clamp(value), value * value * (3 - 2 * value));

function hash(value) {
  let result = 2166136261;
  for (const character of String(value)) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}

// Stateless spatial randomness lets texture samples remain stable after repaint.
function h3(a, b, seed) {
  let value = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  value ^= value >>> 15;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function noise(value, seed) {
  const index = Math.floor(value), part = smooth(value - index);
  return mix(h3(index, 7, seed), h3(index + 1, 7, seed), part) * 2 - 1;
}

function periodicNoise(x, y, cells, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), tx = smooth(x - ix), ty = smooth(y - iy);
  const at = (a, b) => h3((a + cells) % cells, (b + cells) % cells, seed);
  return mix(mix(at(ix, iy), at(ix + 1, iy), tx), mix(at(ix, iy + 1), at(ix + 1, iy + 1), tx), ty) * 2 - 1;
}

function canvas(width, height) {
  const result = document.createElement('canvas');
  result.width = width;
  result.height = height;
  return result;
}

function pointsOf(points) {
  return points.map(point => Array.isArray(point) ? { x: point[0], y: point[1] } : point)
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function trace(ctx, points, closed) {
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  if (closed) ctx.closePath();
}

function clip(ctx, shape) {
  if (Array.isArray(shape)) {
    trace(ctx, pointsOf(shape), true);
    ctx.clip();
  } else if (typeof shape === 'function') {
    ctx.beginPath();
    shape(ctx);
    ctx.clip();
  } else if (shape) {
    ctx.clip(shape);
  }
}

/**
 * createPrintMaterials({seed, cacheBytes?})
 * All draw coordinates and pattern pitches use CSS pixels, after projection.
 * Surface screens can follow an object through `origin: {x, y}`. Paper stays
 * fixed in the viewport. Helpers restore all changed drawing-context state.
 */
export function createPrintMaterials(options = {}) {
  if (typeof options === 'string') options = { seed: options };
  const seed = hash(options.seed ?? '483765r937n');
  const budget = clamp(options.cacheBytes ?? 8 * 1024 * 1024, 2 * 1024 * 1024, 16 * 1024 * 1024);
  const cache = new Map();
  let cacheBytes = 0;

  function tile(key, make) {
    if (cache.has(key)) {
      const value = cache.get(key);
      cache.delete(key);
      cache.set(key, value);
      return value;
    }
    const image = make();
    const bytes = image.width * image.height * 4;
    while (cacheBytes + bytes > budget && cache.size) {
      const oldestKey = cache.keys().next().value;
      cacheBytes -= cache.get(oldestKey).bytes;
      cache.delete(oldestKey);
    }
    const value = { image, bytes, patterns: new WeakMap() };
    cache.set(key, value);
    cacheBytes += bytes;
    return value;
  }

  function pattern(ctx, material, spacing = 16, angle = 0, origin = { x: 0, y: 0 }) {
    let result = material.patterns.get(ctx);
    if (!result) {
      result = ctx.createPattern(material.image, 'repeat');
      material.patterns.set(ctx, result);
    }
    const size = spacing / 16, cos = Math.cos(angle) * size, sin = Math.sin(angle) * size;
    result.setTransform(new DOMMatrix([cos, sin, -sin, cos, origin.x || 0, origin.y || 0]));
    return result;
  }

  function paperTile() {
    return tile('paper', () => {
      const size = 512, result = canvas(size, size), ctx = result.getContext('2d');
      const image = ctx.createImageData(size, size), bytes = image.data;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const broad = periodicNoise(x / 128, y / 128, 4, seed);
          const small = periodicNoise(x / 32, y / 32, 16, seed + 19);
          const grain = (h3(x, y, seed + 77) - .5) * .021 + (h3(x >> 1, y >> 1, seed + 78) - .5) * .011;
          const value = 1 + broad * .026 + small * .009 + grain;
          const offset = (y * size + x) * 4;
          bytes[offset] = 243 * value;
          bytes[offset + 1] = 234 * (value - (1 - value) * .12);
          bytes[offset + 2] = 219 * (value - (1 - value) * .30);
          bytes[offset + 3] = 255;
        }
      }
      ctx.putImageData(image, 0, 0);
      const dark = new Path2D(), light = new Path2D();
      for (let index = 0; index < 185; index++) {
        const x = h3(index, 1, seed) * size, y = h3(index, 2, seed) * size;
        const length = 5 + h3(index, 3, seed) * 23, angle = h3(index, 4, seed) * TAU;
        const endX = x + Math.cos(angle) * length, endY = y + Math.sin(angle) * length;
        const bend = (h3(index, 5, seed) - .5) * length * .38;
        const path = index % 3 ? light : dark;
        path.moveTo(x, y);
        path.quadraticCurveTo((x + endX) / 2 - Math.sin(angle) * bend, (y + endY) / 2 + Math.cos(angle) * bend, endX, endY);
      }
      ctx.lineCap = 'round';
      ctx.lineWidth = .55;
      ctx.strokeStyle = '#78634416';
      ctx.stroke(dark);
      ctx.lineWidth = .8;
      ctx.strokeStyle = '#fffbee55';
      ctx.stroke(light);
      for (let index = 0; index < 35; index++) {
        ctx.fillStyle = index % 3 ? '#74633e14' : '#fff9e755';
        ctx.beginPath();
        ctx.ellipse(h3(index, 6, seed) * size, h3(index, 7, seed) * size, .25 + h3(index, 8, seed) * .7, .4, 0, 0, TAU);
        ctx.fill();
      }
      return result;
    });
  }

  function paper(ctx, width, height) {
    ctx.save();
    ctx.fillStyle = pattern(ctx, paperTile());
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  function screen(ctx, shape, bounds, opts = {}) {
    const tone = Math.round(clamp(opts.tone ?? .35, 0, .88) * 16) / 16;
    const detail = smooth(((opts.zoom ?? 1) - .22) / .20);
    if (!tone || !detail || bounds.w < 2 || bounds.h < 2) return;
    const color = opts.color || PRINT_PALETTE.ink;
    const material = tile('screen|' + color + '|' + tone, () => {
      // A regular amplitude-modulated screen: tone changes radius, not random
      // point count. Small radius variation mimics imperfect ink transfer.
      const result = canvas(128, 128), ctx = result.getContext('2d');
      ctx.fillStyle = color;
      for (let row = 0; row < 8; row++) {
        for (let column = 0; column < 8; column++) {
          const radius = 16 * Math.sqrt(tone / Math.PI) * (.95 + h3(row, column, seed + 83) * .1);
          const x = column * 16 + 8, y = row * 16 + 8;
          ctx.beginPath();
          ctx.ellipse(x, y, radius, radius * (.94 + h3(column, row, seed + 84) * .1), -.16, 0, TAU);
          ctx.fill();
        }
      }
      // A small deterministic fleck layer breaks the perfect screen grid.
      // The tile is cached, so foliage keeps the same printed grain on every repaint.
      ctx.globalAlpha = .2;
      for (let index = 0; index < 78; index++) {
        const x = h3(index, 117, seed + 85) * 128;
        const y = h3(index, 118, seed + 85) * 128;
        const radius = .22 + h3(index, 119, seed + 86) * .55;
        ctx.beginPath();
        ctx.ellipse(x, y, radius * 1.35, radius, h3(index, 120, seed + 87) * Math.PI, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return result;
    });
    ctx.save();
    clip(ctx, shape);
    ctx.globalAlpha *= clamp(opts.alpha ?? .45) * detail;
    ctx.fillStyle = pattern(ctx, material, clamp(opts.spacing ?? 4.8, 3.2, 12), opts.angle ?? -.45, opts.origin);
    ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    ctx.restore();
  }

  function hatch(ctx, shape, bounds, opts = {}) {
    const detail = smooth(((opts.zoom ?? 1) - .3) / .3);
    if (!detail || bounds.w < 2 || bounds.h < 2) return;
    const color = opts.color || PRINT_PALETTE.ink;
    const material = tile('hatch|' + color, () => {
      const result = canvas(128, 128), ctx = result.getContext('2d');
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      for (let row = 0; row < 8; row++) {
        ctx.lineWidth = 1.5 + h3(row, 9, seed) * 1.4;
        const y = row * 16 + 8;
        for (let part = 0; part < 3; part++) {
          const x = part * 44 + h3(row, part, seed) * 5;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.quadraticCurveTo(x + 14, y + (h3(row, part, seed + 1) - .5) * 3, x + 32, y);
          ctx.stroke();
        }
      }
      return result;
    });
    ctx.save();
    clip(ctx, shape);
    ctx.globalAlpha *= clamp(opts.alpha ?? .3) * detail;
    ctx.fillStyle = pattern(ctx, material, clamp(opts.spacing ?? 7, 4, 16), opts.angle ?? -Math.PI / 4, opts.origin);
    ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    ctx.restore();
  }

  function ink(ctx, input, opts = {}) {
    const points = pointsOf(input), closed = !!opts.closed;
    if (points.length < 2) return;
    const vertices = closed ? [...points, points[0]] : points;
    const lengths = [0];
    for (let index = 1; index < vertices.length; index++) {
      lengths.push(lengths[index - 1] + Math.hypot(vertices[index].x - vertices[index - 1].x, vertices[index].y - vertices[index - 1].y));
    }
    const length = lengths.at(-1);
    if (length < .01) return;
    const count = Math.min(1024, Math.max(2, Math.ceil(length / 2.8)));
    const localSeed = hash(seed + '/' + (opts.seed ?? 'ink'));
    const width = Math.max(.3, opts.width ?? 1.2), wobble = opts.wobble ?? Math.min(.7, width * .38);
    const pressure = clamp(opts.pressure ?? .22, 0, .6);
    const phase = h3(localSeed, 1, seed) * TAU, phase2 = h3(localSeed, 2, seed) * TAU;
    const frequency = Math.max(1, Math.round(length / 90));
    const left = [], right = [], centers = [];
    let segment = 1;
    for (let index = 0; index <= count; index++) {
      const u = index / count, distance = u * length;
      while (segment < vertices.length - 1 && lengths[segment] < distance) segment++;
      const a = vertices[segment - 1], b = vertices[segment], span = lengths[segment] - lengths[segment - 1] || 1;
      const part = clamp((distance - lengths[segment - 1]) / span), dx = b.x - a.x, dy = b.y - a.y;
      const magnitude = Math.hypot(dx, dy) || 1, nx = -dy / magnitude, ny = dx / magnitude;
      const drift = wobble * (.68 * Math.sin(u * TAU * frequency + phase) + .32 * Math.sin(u * TAU * (frequency * 3) + phase2));
      const x = mix(a.x, b.x, part) + nx * drift, y = mix(a.y, b.y, part) + ny * drift;
      const taper = closed || opts.taper === false ? 1 : .38 + .62 * smooth(u / .12) * smooth((1 - u) / .16);
      const radius = width * .5 * taper * (1 + pressure * Math.sin(u * TAU * (frequency + 1) + phase2));
      const rough = width * .07 * noise(distance * .23, localSeed);
      centers.push({ x, y });
      left.push({ x: x + nx * (radius + rough), y: y + ny * (radius + rough) });
      right.push({ x: x - nx * (radius - rough), y: y - ny * (radius - rough) });
    }
    ctx.save();
    ctx.globalAlpha *= clamp(opts.alpha ?? 1);
    if (closed && opts.fill) {
      ctx.fillStyle = opts.fill;
      trace(ctx, centers, true);
      ctx.fill();
    }
    ctx.fillStyle = opts.color || PRINT_PALETTE.ink;
    trace(ctx, [...left, ...right.reverse()], true);
    ctx.fill();
    ctx.restore();
  }

  return Object.freeze({
    palette: PRINT_PALETTE, paper, screen, hatch, ink,
    cacheStats: () => ({ entries: cache.size, bytes: cacheBytes, budget }),
  });
}
