/** One smooth 120-second fade: transparent, 50% at 60 seconds, transparent. */
export function birdOpacity(time, offset = 0) {
  const phase = ((time + offset) % 120000 + 120000) % 120000 / 120000;
  return .25 * (1 - Math.cos(phase * Math.PI * 2));
}

/** Seeded flock motion. Live birds keep their agent identity across updates. */
export function createGardenFlock({ maxBirds = 96, trailLength = 28 } = {}) {
  const birds = new Map();
  const neighborOffsets = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  let lastTime = null, opacityTime = 0;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function random(key) {
    let seed = 2166136261;
    for (const c of key) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619);
    return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  }
  function make(key, treeId, orbiting) {
    const rand = random(key);
    const x = (rand() - .5) * 2, y = (rand() - .5) * 1.2;
    const bird = { key, treeId, rand, x, y, vx: (rand() - .5) * .4, vy: (rand() - .5) * .3, perched: false, orbiting,
      tx: x, ty: y, nextTurn: 0, returning: false, sample: 0, phase: rand() * 6.28, history: [], color: Math.floor(rand() * 3) };
    bird.fadeOffset = random(key + "/opacity")() * 120000;
    return bird;
  }
  function sync(entries) {
    const live = new Set();
    for (const entry of entries) {
      const agents = Array.isArray(entry.agents) ? entry.agents : null;
      const identities = agents || Array.from({ length: Math.min(3, entry.count || 0) }, (_, i) => ({ id: `${entry.id}/${i}` }));
      for (const agent of identities) {
        if (!agents && live.size >= maxBirds) break;
        const key = agent.id;
        live.add(key);
        if (!birds.has(key)) birds.set(key, make(key, entry.id, !!agents));
        const bird = birds.get(key);
        bird.treeId = entry.id;
      }
    }
    for (const key of birds.keys()) if (!live.has(key)) birds.delete(key);
  }
  function advance(time, enabled, entries, selectedTreeId) {
    const dt = lastTime === null ? 0 : clamp((time - lastTime) / 1000, 0, .1);
    if (enabled && lastTime !== null) opacityTime += Math.max(0, time - lastTime);
    lastTime = time;
    if (!enabled || !dt) return;
    const remember = (bird) => {
      bird.sample += dt;
      if (bird.sample >= (bird.orbiting ? .09 : .06)) {
        bird.sample = 0;
        bird.history.push({ x: bird.x, y: bird.y });
        if (bird.history.length > (bird.orbiting ? Math.min(16, trailLength) : trailLength)) bird.history.shift();
      }
    };
    // Nearby live birds repel each other even when their tree origins differ.
    const origins = new Map(entries.map(entry => [entry.id, entry]));
    const livePositions = new Map(), cells = new Map(), cellSize = 28;
    for (const bird of birds.values()) if (bird.orbiting) {
      const origin = origins.get(bird.treeId);
      if (!origin) continue;
      const radius = clamp(origin.width * .7, 16, 60);
      const position = { x: origin.x + bird.x * radius, y: origin.y - origin.height * .5 + bird.y * radius * .72 };
      livePositions.set(bird.key, position);
      const cell = `${Math.floor(position.x / cellSize)},${Math.floor(position.y / cellSize)}`;
      if (!cells.has(cell)) cells.set(cell, []);
      cells.get(cell).push(bird);
    }
    // History birds retain their seeded flocking; live birds roam and return home.
    const previousByTree = new Map();
    for (const bird of birds.values()) if (!bird.orbiting) {
      const group = previousByTree.get(bird.treeId) || [];
      group.push({ ...bird }); previousByTree.set(bird.treeId, group);
    }
    for (const bird of birds.values()) {
      if (bird.treeId === selectedTreeId) {
        // A damped pursuit recalls distant birds without teleporting them.
        const angle = time * .0018 + bird.phase;
        const radius = .9 + .18 * Math.sin(bird.phase * 3);
        const tx = Math.cos(angle) * radius, ty = Math.sin(angle) * radius * .8;
        bird.vx += ((tx - bird.x) * 12 + (-Math.sin(angle) * radius * 1.8 - bird.vx) * 6) * dt;
        bird.vy += ((ty - bird.y) * 12 + (Math.cos(angle) * radius * 1.44 - bird.vy) * 6) * dt;
        bird.x += bird.vx * dt; bird.y += bird.vy * dt;
        bird.nextTurn = 0;
        remember(bird);
        continue;
      }
      if (bird.orbiting) {
        if (time >= bird.nextTurn) {
          bird.returning = !bird.returning;
          const range = bird.returning ? .45 : 2.8;
          bird.tx = (bird.rand() - .5) * range * 2;
          bird.ty = (bird.rand() - .5) * range * 1.45;
          bird.nextTurn = time + 3000 + bird.rand() * 1900;
        }
        let ax = (bird.tx - bird.x) * .52 + Math.sin(time * .0007 + bird.phase) * .12;
        let ay = (bird.ty - bird.y) * .52 + Math.cos(time * .00059 + bird.phase) * .12;
        const position = livePositions.get(bird.key);
        if (position) {
          const cx = Math.floor(position.x / cellSize), cy = Math.floor(position.y / cellSize);
          let checked = 0;
          for (const [ox, oy] of neighborOffsets) {
            if (checked >= 24) break;
            const nearby = cells.get(`${cx + ox},${cy + oy}`) || [];
            const offset = nearby.length ? Math.floor(bird.phase / 6.28 * nearby.length) : 0;
            for (let i = 0; i < nearby.length && i < 4 && checked < 24; i++) {
              const other = nearby[(offset + i) % nearby.length];
              if (other === bird) continue;
              checked++;
              const at = livePositions.get(other.key);
              let dx = position.x - at.x, dy = position.y - at.y;
              if (dx === 0 && dy === 0) { dx = Math.cos(bird.phase - other.phase) * .01; dy = Math.sin(bird.phase - other.phase) * .01; }
              const distance = Math.hypot(dx, dy);
              if (distance > 0 && distance < 22) {
                const force = (1 - distance / 22) * .85;
                ax += dx / distance * force;
                ay += dy / distance * force;
              }
            }
          }
        }
        ax -= Math.max(0, Math.abs(bird.x) - 3.4) * Math.sign(bird.x) * .45;
        ay -= Math.max(0, Math.abs(bird.y) - 2.8) * Math.sign(bird.y) * .45;
        bird.vx = (bird.vx + ax * dt) * Math.exp(-.32 * dt);
        bird.vy = (bird.vy + ay * dt) * Math.exp(-.32 * dt);
        const speed = Math.hypot(bird.vx, bird.vy);
        if (speed > 1.7) { bird.vx *= 1.7 / speed; bird.vy *= 1.7 / speed; }
        bird.x = clamp(bird.x + bird.vx * dt, -4.2, 4.2);
        bird.y = clamp(bird.y + bird.vy * dt, -3.4, 3.4);
        remember(bird);
        continue;
      }
      if (time >= bird.nextTurn) {
        const excursion = bird.rand() > .82 ? 1.7 : 1.1;
        bird.tx = (bird.rand() - .5) * excursion * 2;
        bird.ty = (bird.rand() - .5) * 1.65;
        bird.nextTurn = time + 2400 + bird.rand() * 4400;
      }
      let ax = (bird.tx - bird.x) * .26, ay = (bird.ty - bird.y) * .26;
      let count = 0, cx = 0, cy = 0, vx = 0, vy = 0;
      for (const other of previousByTree.get(bird.treeId) || []) {
        if (other.key === bird.key) continue;
        const dx = bird.x - other.x, dy = bird.y - other.y, distance = Math.hypot(dx, dy);
        count++; cx += other.x; cy += other.y; vx += other.vx; vy += other.vy;
        if (distance < .42) { ax += dx / (distance * distance + .02) * .1; ay += dy / (distance * distance + .02) * .1; }
      }
      if (count) {
        ax += (cx / count - bird.x) * .025 + (vx / count - bird.vx) * .075;
        ay += (cy / count - bird.y) * .025 + (vy / count - bird.vy) * .075;
      }
      ax += Math.sin(time * .00039 + bird.phase + bird.y * 1.8) * .12;
      ay += Math.cos(time * .00047 + bird.phase + bird.x * 1.7) * .1;
      bird.vx = (bird.vx + ax * dt) * Math.exp(-.2 * dt);
      bird.vy = (bird.vy + ay * dt) * Math.exp(-.2 * dt);
      const speed = Math.hypot(bird.vx, bird.vy);
      if (speed > .8) { bird.vx *= .8 / speed; bird.vy *= .8 / speed; }
      bird.x = clamp(bird.x + bird.vx * dt, -2.1, 2.1);
      bird.y = clamp(bird.y + bird.vy * dt, -1.6, 1.6);
      remember(bird);
    }
  }
  function draw(ctx, entries, time, { enabled = true, trails = true, selectedTreeId = null } = {}) {
    sync(entries); advance(time, enabled, entries, selectedTreeId);
    const origins = new Map(entries.map(e => [e.id, e]));
    const colors = ['#BCD4AA', '#A2C5DB', '#C3B4D4'];
    let segments = 0;
    ctx.save();
    const alpha = ctx.globalAlpha;
    for (const bird of birds.values()) {
      const origin = origins.get(bird.treeId);
      if (!origin) continue;
      const radius = clamp(origin.width * .7, 16, 60);
      const at = p => ({ x: origin.x + p.x * radius, y: origin.y - origin.height * .5 + p.y * radius * .72 });
      const highlighted = bird.treeId === selectedTreeId;
      const color = highlighted ? "#FFF0B0" : colors[bird.color], head = at(bird);
      bird.screen = head;
      bird.opacity = highlighted ? 1 : birdOpacity(opacityTime, bird.fadeOffset);
      const birdAlpha = alpha * bird.opacity;
      ctx.setLineDash([3, 4]);
      ctx.lineDashOffset = 0;
      let trailDistance = 0;
      if (trails && bird.orbiting && bird.history.length > 1) {
        const first = at(bird.history[0]);
        ctx.beginPath(); ctx.moveTo(first.x, first.y);
        for (let i = 1; i < bird.history.length; i++) {
          const point = at(bird.history[i]);
          ctx.lineTo(point.x, point.y);
          segments++;
        }
        ctx.lineTo(head.x, head.y);
        ctx.strokeStyle = color; ctx.globalAlpha = birdAlpha * .42; ctx.lineWidth = 1.4; ctx.stroke();
      } else if (trails) for (let i = 1; i < bird.history.length; i++) {
        const a = at(bird.history[i - 1]), b = at(bird.history[i]);
        ctx.lineDashOffset = -trailDistance;
        trailDistance += Math.hypot(b.x - a.x, b.y - a.y);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = color; ctx.globalAlpha = birdAlpha * (.025 + Math.pow(i / bird.history.length, 1.7) * .3);
        ctx.lineWidth = .7 + i / bird.history.length * .4; ctx.stroke(); segments++;
      }
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.save(); ctx.translate(head.x, head.y); ctx.rotate(Math.atan2(bird.vy * .72, bird.vx));
      const size = bird.orbiting ? clamp(origin.width * .07, 2.7, 4.5) : clamp(origin.width * .055, 1.5, 3.1);
      ctx.globalAlpha = birdAlpha; ctx.fillStyle = color;
      if (highlighted) { ctx.shadowColor = "#FFD978"; ctx.shadowBlur = 9; }
      ctx.beginPath(); ctx.moveTo(size * 1.7, 0); ctx.lineTo(-size, -size * .72);
      ctx.lineTo(-size * .4, 0); ctx.lineTo(-size, size * .72); ctx.closePath();
      ctx.fill(); ctx.restore();
    }
    ctx.restore();
    return { birds: birds.size, segments, cap: maxBirds };
  }
  return {
    draw,
    clear() { birds.clear(); lastTime = null; opacityTime = 0; },
    state: () => [...birds.values()].map(({ key, treeId, x, y, vx, vy, perched, screen, history, opacity, fadeOffset }) => ({ key, treeId, x, y, vx, vy, perched, screen, opacity, fadeOffset, trailPoints: history.length })),
  };
}
