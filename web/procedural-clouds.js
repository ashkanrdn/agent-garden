/** Seeded geometry and a shared arrival clock. No image assets or animation loop. */
export const ARRIVAL_DURATION_MS = 14000;
export const CLOUD_PALETTE = Object.freeze({
  background: '#23538B', coral: '#FA947F', peach: '#FFC798',
  blue: '#8A9FEB', cyan: '#8CDCDD', violet: '#C5A8EB',
  rain: '#FFD2A4', lightning: '#B6FFFF', trunk: '#232F59',
});
const TAU = Math.PI * 2;
const ARRIVAL_SPEEDS = new Set([1, 2, 5, 10]);
const OUTLINE_DIRECTIONS = Array.from({ length: 96 }, (_, index) => {
  const angle = index / 96 * TAU;
  return { x: Math.cos(angle), y: Math.sin(angle) };
});
const clamp = n => Math.max(0, Math.min(1, n));
const ease = n => { const t = clamp(n); return t * t * (3 - 2 * t); };

export function seededRandom(seed) {
  let h = 2166136261;
  for (const character of String(seed)) h = Math.imul(h ^ character.charCodeAt(0), 16777619);
  return () => {
    h += 0x6D2B79F5;
    let t = Math.imul(h ^ (h >>> 15), h | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Radial outer boundary of circular lobes and contour nodes. */
export function outlineOf(circles, count = 96) {
  const directions = count === 96 ? OUTLINE_DIRECTIONS : Array.from({ length: count }, (_, index) => {
    const angle = index / count * TAU;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  });
  const radii = new Float64Array(count);
  for (const circle of circles) {
    const distance = Math.hypot(circle.x, circle.y);
    let first = 0, last = count - 1;
    if (distance > circle.r * (1 + 1e-12)) {
      // Only rays facing an external circle can extend the positive boundary.
      const angle = Math.atan2(circle.y, circle.x), span = Math.asin(circle.r / distance);
      first = Math.floor((angle - span) / TAU * count);
      last = Math.min(first + count - 1, Math.ceil((angle + span) / TAU * count));
    }
    for (let ray = first; ray <= last; ray++) {
      const index = (ray % count + count) % count;
      const { x: dx, y: dy } = directions[index];
      const along = circle.x * dx + circle.y * dy;
      const cross = circle.x * dy - circle.y * dx;
      const discriminant = circle.r * circle.r - cross * cross;
      if (discriminant >= 0) radii[index] = Math.max(radii[index], along + Math.sqrt(discriminant));
    }
  }
  return directions.map((direction, i) => ({ x: direction.x * radii[i], y: direction.y * radii[i] }));
}

export function createCloud(seed = 'garden', { layers = 5, extrusion = 26 } = {}) {
  const random = seededRandom(seed);
  const count = Math.max(3, Math.min(6, Math.round(Number(layers) || 5)));
  const depth = Math.max(8, Math.min(40, Number(extrusion) || 26));
  const colors = ['coral', 'cyan', 'violet', 'peach', 'coral', 'blue'];
  const plates = Array.from({ length: count }, (_, index) => {
    const circles = [{ x: 0, y: 0, r: 41 }];
    const lobes = 5 + Math.floor(random() * 3), phase = random() * TAU;
    for (let i = 0; i < lobes; i++) {
      const angle = phase + i / lobes * TAU;
      const distance = 31 + random() * 14;
      circles.push({ x: Math.cos(angle) * distance * 1.18, y: Math.sin(angle) * distance,
        r: 22 + random() * 17 });
    }
    return {
      outline: outlineOf(circles),
      x: Math.sin(index * 2.15) * 20 + (random() - .5) * 8,
      y: Math.cos(index * 1.9) * 12,
      z: 162 + index * 20,
      size: 1.15 - index * .09,
      thickness: depth * (.85 + random() * .25),
      color: colors[index],
      phase: random() * TAU,
      hole: index === 0 || index === 2,
    };
  });
  const drops = Array.from({ length: 62 }, () => ({
    x: (random() - .5) * 114, y: (random() - .5) * 78,
    phase: random(), speed: .75 + random() * .45, length: 5 + random() * 7,
  }));
  const bolt = [{ x: 60, y: -18, z: 191 }];
  for (let i = 1; i <= 5; i++) bolt.push({ x: 60 + (random() - .5) * 18, y: -18, z: 191 - i * 10 });
  return { seed: String(seed), plates, drops, bolt };
}

/** Pure sampling supports pause, seek, replay and deterministic future live arrivals. */
export function sampleArrival(elapsedMs, { reducedMotion = false } = {}) {
  const t = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  if (reducedMotion) return { elapsed: t, phase: 'settled', cloud: 0, rain: 0, lightning: 0,
    disperse: 1, trunk: 1, branches: 1, crown: 1, active: false };
  const disperse = ease((t - 11000) / 3000);
  return {
    elapsed: t,
    phase: t < 3000 ? 'Gather' : t < 5000 ? 'Rain' : t < 11000 ? 'Grow' : t < 14000 ? 'Disperse' : 'Settled',
    cloud: ease(t / 3000) * (1 - disperse),
    rain: ease((t - 3000) / 1500) * (1 - ease((t - 10000) / 2000)),
    // One gentle, local pulse. No full-screen flash or repeated strobe.
    lightning: ease((t - 6600) / 250) * (1 - ease((t - 6850) / 450)),
    disperse, trunk: ease((t - 3200) / 3300),
    branches: ease((t - 4700) / 4100), crown: ease((t - 6500) / 4500),
    active: t < ARRIVAL_DURATION_MS,
  };
}

/** Orthographic projection, with optional genuine yaw around a vertical axis. */
export function projectPoint(point, { x = 0, y = 0, scale = 1, yaw = -.25 } = {}) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: x + (point.x * c - point.y * s) * scale,
    y: y + ((point.x * s + point.y * c) * .44 - (point.z || 0)) * scale };
}

function path(ctx, points) {
  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.closePath();
}

/** Caller owns transforms, timing and clearing. Texture, if supplied, is code-generated. */
export function drawCloud(ctx, cloud, state, view = {}, { texture = null, opacity = 1, growth = 'scale', lightning = 'fork' } = {}) {
  if (state.cloud <= 0) return { plates: 0, drops: 0 };
  const project = point => projectPoint(point, view), unit = view.scale || 1;
  const previousAlpha = ctx.globalAlpha;
  ctx.save();
  ctx.lineCap = 'round';
  let drawnDrops = 0;
  if (state.rain > 0) {
    ctx.strokeStyle = CLOUD_PALETTE.rain;
    ctx.lineWidth = Math.max(.5, .55 * unit);
    for (const drop of cloud.drops) {
      const f = (state.elapsed / 1350 * drop.speed + drop.phase) % 1;
      const z = 151 * (1 - f);
      const a = project({ x: drop.x, y: drop.y, z });
      const b = project({ x: drop.x, y: drop.y, z: Math.min(151, z + drop.length) });
      ctx.globalAlpha = previousAlpha * opacity * state.rain * (.28 + Math.sin(f * Math.PI) * .46);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      if (f > .94) {
        const p = project({ x: drop.x, y: drop.y, z: 0 });
        ctx.globalAlpha *= (1 - f) / .06;
        ctx.beginPath(); ctx.ellipse(p.x, p.y, unit * (2 + (f - .94) * 60), unit, 0, 0, TAU); ctx.stroke();
      }
      drawnDrops++;
    }
  }
  let drawnPlates = 0;
  cloud.plates.forEach((plate, index) => {
    const shape = growth === 'shape';
    const grow = shape ? plate.progress : ease((state.elapsed - index * 220) / (2100 + index * 100));
    if (grow <= 0) return;
    const offsetScale = shape ? 1 : grow;
    const spread = plate.size * (shape ? 1 : grow) * (1 + state.disperse * .2);
    const drift = state.disperse * (index % 2 ? 30 : -30);
    const rise = (1 - grow) * 22 - state.disperse * 20;
    const breathe = Math.sin(state.elapsed / 2800 + plate.phase) * 1.1 * state.cloud;
    const points = plate.outline.map(p => ({ x: p.x * spread + plate.x * offsetScale + drift,
      y: p.y * spread + plate.y * offsetScale, z: plate.z - rise + breathe }));
    const top = points.map(project), bottom = points.map(p => project({ ...p, z: p.z - plate.thickness * grow }));
    const alpha = opacity * state.cloud;
    // Front walls are continuous extruded strips, not a drop shadow or flat outline.
    // Their opacity and bottom rims make the volume readable through transparency.
    ctx.fillStyle = CLOUD_PALETTE[plate.color];
    const strips=[];let strip=[];
    for (let i = 0; i < top.length; i++) {
      const j = (i + 1) % top.length;
      if (top[j].x < top[i].x) { if(!strip.length)strip.push(i);strip.push(j); }
      else if(strip.length){strips.push(strip);strip=[];}
    }
    if(strip.length)strips.push(strip);
    for(const indices of strips){
      ctx.globalAlpha=previousAlpha*alpha*.58;
      path(ctx,[...indices.map(i=>top[i]),...indices.slice().reverse().map(i=>bottom[i])]);ctx.fill();
      ctx.save();ctx.clip();ctx.globalAlpha=previousAlpha*alpha*.12;ctx.fillStyle='#18396B';ctx.fill();ctx.restore();
      ctx.globalAlpha=previousAlpha*alpha*.64;
      ctx.strokeStyle=CLOUD_PALETTE[plate.color];ctx.lineWidth=Math.max(.65,unit*.8);
      ctx.beginPath();indices.forEach((i,n)=>n?ctx.lineTo(bottom[i].x,bottom[i].y):ctx.moveTo(bottom[i].x,bottom[i].y));ctx.stroke();
      for(const i of [indices[0],indices.at(-1)]){ctx.beginPath();ctx.moveTo(top[i].x,top[i].y);ctx.lineTo(bottom[i].x,bottom[i].y);ctx.stroke();}
    }
    path(ctx, top);
    const holeCenter = project({ x: plate.x * offsetScale + drift + 13 * spread,
      y: plate.y * offsetScale + 3 * spread, z: plate.z - rise + breathe });
    const hole = plate.hole && (!shape || grow >= .8);
    if (hole) {
      ctx.moveTo(holeCenter.x + 14 * spread * unit, holeCenter.y);
      ctx.ellipse(holeCenter.x, holeCenter.y, 14 * spread * unit, 7 * spread * unit, 0, 0, TAU);
    }
    ctx.fillStyle = CLOUD_PALETTE[plate.color];
    ctx.globalAlpha = previousAlpha * alpha * .48;
    ctx.fill('evenodd');
    if (texture) {
      ctx.save(); ctx.clip('evenodd');
      const left = Math.min(...top.map(p => p.x)), upper = Math.min(...top.map(p => p.y));
      const width = Math.max(...top.map(p => p.x)) - left, height = Math.max(...top.map(p => p.y)) - upper;
      ctx.globalAlpha = previousAlpha * alpha * .15;
      ctx.drawImage(texture, left, upper, width, height); ctx.restore();
    }
    ctx.globalAlpha = previousAlpha * alpha * .86;
    ctx.strokeStyle = index % 2 ? CLOUD_PALETTE.cyan : CLOUD_PALETTE.peach;
    ctx.lineWidth = Math.max(.6, unit * .7); ctx.stroke();
    if(hole){
      const rx=14*spread*unit,ry=7*spread*unit,depth=plate.thickness*grow*unit;
      ctx.save();
      // Clip the shaft to its top opening. The far inner wall reveals the depth.
      ctx.beginPath();ctx.ellipse(holeCenter.x,holeCenter.y,rx,ry,0,0,TAU);ctx.clip();
      ctx.beginPath();ctx.ellipse(holeCenter.x,holeCenter.y,rx,ry,0,Math.PI,TAU);
      ctx.lineTo(holeCenter.x+rx,holeCenter.y+depth);
      ctx.ellipse(holeCenter.x,holeCenter.y+depth,rx,ry,0,0,-Math.PI,true);ctx.closePath();
      ctx.fillStyle=CLOUD_PALETTE[plate.color];ctx.globalAlpha=previousAlpha*alpha*.68;ctx.fill();
      ctx.strokeStyle=CLOUD_PALETTE.peach;ctx.globalAlpha=previousAlpha*alpha*.55;ctx.lineWidth=Math.max(.6,unit*.7);ctx.stroke();ctx.restore();
    }
    drawnPlates++;
  });
  if (lightning !== 'none' && state.lightning > 0) {
    ctx.globalAlpha = previousAlpha * opacity * state.lightning * .8;
    ctx.strokeStyle = CLOUD_PALETTE.lightning; ctx.lineWidth = Math.max(.8, 1.15 * unit);
    const points = cloud.bolt.map(project);
    ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    const fork = points[2]; ctx.moveTo(fork.x, fork.y);
    ctx.lineTo(fork.x + 11 * unit, fork.y + 5 * unit);
    ctx.lineTo(fork.x + 17 * unit, fork.y + 15 * unit); ctx.stroke();
  }
  ctx.restore();
  return { plates: drawnPlates, drops: drawnDrops };
}

/** Bounded arrival queue; stable identifiers prevent repeats during dataset updates. */
export function createCloudArrivals({ cap = 3, cloudFactory = createCloud, onComplete = null } = {}) {
  const limit = Math.max(1, Math.min(3, Math.floor(Number(cap) || 3)));
  let seen = null, active = [], time = 0;
  return {
    sync(items, { animate = true, reset = false } = {}) {
      const ids = new Set(items.map(item => item.id));
      if (reset || !seen || !animate) { active = []; seen = ids; return; }
      active = active.filter(item => ids.has(item.id));
      const projects = new Set(active.map(item => item.projectId));
      for (const item of items.slice().sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0)
        || String(a.id).localeCompare(String(b.id)))) {
        if (seen.has(item.id) || active.length >= limit || projects.has(item.projectId)) continue;
        active.push({ id: item.id, projectId: item.projectId, start: time, cloud: cloudFactory(item.id) });
        projects.add(item.projectId);
      }
      seen = ids;
    },
    advance(deltaMs, { playing = true, hidden = false, reducedMotion = false, speed = 1 } = {}) {
      if (reducedMotion) { active = []; return; }
      if (!playing || hidden) return;
      time += Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0) * (ARRIVAL_SPEEDS.has(speed) ? speed : 1);
      active = active.filter(item => {
        if (time - item.start < ARRIVAL_DURATION_MS) return true;
        onComplete?.(item.id);
        return false;
      });
    },
    entries: () => active.map(item => ({ ...item, state: sampleArrival(time - item.start) })),
    clear() { seen = null; active = []; time = 0; },
    settle() { active = []; },
    get active() { return active.length > 0; },
  };
}
