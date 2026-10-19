const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { before, test } = require('node:test');
const { budgetMs } = require('./helpers/budget-ms.cjs');
const dir = path.join(__dirname, '../../web/');
let droneMod, robot, layoutMod, placeMod;
before(async () => {
  const load = name => import(pathToFileURL(dir + name).href);
  [droneMod, robot, layoutMod, placeMod] = await Promise.all(
    ['garden-drone-path.js', 'garden-robot-camera.js', 'garden-layout.js', 'tree-placement.js'].map(load));
});

const VIEW = 800, CANOPY_RADIUS = 68;
function scene(counts = [12, 8, 5, 3, 2, 2, 1, 20, 30]) {
  const inputs = counts.map((n, i) => ({ id: 'p' + i, birth: 0, work: n * 5, sessionCount: n }));
  const layout = layoutMod.buildGardenLayout(inputs, { day: 1, seed: 's' }), trees = [];
  for (const lot of layout.plots) {
    const ids = Array.from({ length: counts[+lot.id.slice(1)] }, (_, i) => lot.id + '/' + i);
    for (const p of placeMod.plantTrees(ids, lot.polygon, { seed: 'x', edgeInset: 10 }).points) {
      trees.push({ id: p.id, x: p.x, y: p.y, radius: CANOPY_RADIUS, height: 200 + (p.x * 7 + p.y * 3) % 120 });
    }
  }
  return { layout, trees };
}
const nearest = (trees, p) => trees.reduce((best, t) => { const d = Math.hypot(t.x - p.x, t.y - p.y); return d < best.d ? { d, t } : best; }, { d: Infinity });

test('the path is a closed, C1-smooth loop with no jumps', () => {
  const { layout, trees } = scene(), p = droneMod.buildDronePath({ trees, outline: layout.outline, seed: 'a' });
  assert.equal(p.closed, true);
  assert.ok(p.length > 3000 && p.count > 100, `length ${p.length}`);
  const gap = Math.hypot(p.x[0] - p.x[p.count - 1], p.y[0] - p.y[p.count - 1]);
  assert.ok(gap < p.spacing * 1.05, `the loop closes (${gap})`);
  let maxTurn = 0, maxStep = 0;
  for (let i = 0; i < p.count; i++) {
    const j = (i + 1) % p.count, k = (i + 2) % p.count;
    maxStep = Math.max(maxStep, Math.hypot(p.x[j] - p.x[i], p.y[j] - p.y[i]));
    const turn = Math.atan2(p.y[k] - p.y[j], p.x[k] - p.x[j]) - Math.atan2(p.y[j] - p.y[i], p.x[j] - p.x[i]);
    maxTurn = Math.max(maxTurn, Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn))));
  }
  assert.ok(maxStep < p.spacing * 1.1, `evenly spaced samples (${maxStep})`);
  assert.ok(maxTurn < .5, `no corners between samples (${maxTurn} rad per ${p.spacing} units)`);
  const twin = droneMod.buildDronePath({ trees, outline: layout.outline, seed: 'a' });
  assert.deepEqual(Array.from(twin.x.slice(0, 20)), Array.from(p.x.slice(0, 20)), 'the same seed gives the same loop');
  const other = droneMod.buildDronePath({ trees, outline: layout.outline, seed: 'b' });
  assert.notDeepEqual(Array.from(other.x.slice(0, 20)), Array.from(p.x.slice(0, 20)), 'another seed flies another loop');
});

test('the path threads the gaps: canopy clearance everywhere and it stays over the island', () => {
  const { layout, trees } = scene(), p = droneMod.buildDronePath({ trees, outline: layout.outline });
  let closest = Infinity, passes = 0;
  for (let i = 0; i < p.count; i++) {
    const near = nearest(trees, { x: p.x[i], y: p.y[i] });
    closest = Math.min(closest, near.d);
    assert.ok(near.d >= CANOPY_RADIUS * 1.15, `sample ${i} is ${near.d} from a tree (canopy ${CANOPY_RADIUS})`);
    assert.ok(placeMod.pointInPolygon({ x: p.x[i], y: p.y[i] }, layout.outline), `sample ${i} left the island`);
    if (near.d < CANOPY_RADIUS * 2.2) passes++;
  }
  assert.ok(closest >= CANOPY_RADIUS * 1.15);
  assert.ok(passes > p.count * .05, 'trees pass close by on the route, not only far away');
  assert.ok(p.minCanopyGap > 0, 'the reported clearance agrees');
});

test('flight is smooth: no position, speed, heading or zoom jumps, and trees stay 25 to 45% of the frame', () => {
  const { layout, trees } = scene(), p = droneMod.buildDronePath({ trees, outline: layout.outline });
  const drone = droneMod.createGardenDrone(); drone.setPath(p, VIEW);
  drone.resume({ x: p.x[0], y: p.y[0], yaw: 0 }, VIEW);
  let prev = null, maxJump = 0, maxSpeedStep = 0, maxYawAccel = 0, maxZoomRate = 0, maxYawRate = 0;
  const fills = [], laps = 2.2, dt = 1000 / 60;
  let travelled = 0, frames = 0;
  while (travelled < p.length * laps && frames++ < 60 * 900) {
    const pose = drone.step(dt, { viewHeight: VIEW });
    if (prev) {
      const jump = Math.hypot(pose.position.x - prev.position.x, pose.position.y - prev.position.y);
      travelled += jump; maxJump = Math.max(maxJump, jump);
      if (frames > 240) {
        maxSpeedStep = Math.max(maxSpeedStep, Math.abs(pose.speed - prev.speed) / (dt / 1000));
        maxYawAccel = Math.max(maxYawAccel, Math.abs(pose.yawRate - prev.yawRate));
      }
      maxYawRate = Math.max(maxYawRate, Math.abs(pose.yawRate));
      maxZoomRate = Math.max(maxZoomRate, Math.abs(Math.log(pose.zoom / prev.zoom)) / (dt / 1000));
      assert.ok(Math.abs(Math.atan2(Math.sin(pose.yaw - prev.yaw), Math.cos(pose.yaw - prev.yaw))) < .01, 'heading never snaps');
    }
    if (frames % 20 === 0) {
      const near = nearest(trees, pose.position);
      fills.push(near.t.height * pose.zoom / VIEW);
      const tallest = Math.max(...trees.filter(t => Math.hypot(t.x - pose.position.x, t.y - pose.position.y) < 300).map(t => t.height));
      assert.ok(tallest * pose.zoom / VIEW < .72, 'a single tree never fills the screen');
    }
    prev = pose;
  }
  assert.ok(travelled >= p.length * laps, 'flew multiple laps of the loop');
  const mean = fills.reduce((a, b) => a + b, 0) / fills.length;
  assert.ok(mean >= .25 && mean <= .45, `mean nearby tree height ${mean.toFixed(3)} of the viewport`);
  assert.ok(maxJump < 3, `per-frame travel ${maxJump}`);
  assert.ok(maxSpeedStep < 60, `speed eases (${maxSpeedStep} px/s^2)`);
  assert.ok(maxYawRate <= droneMod.DRONE_SETTINGS.yawRate + 1e-9, `yaw rate ${maxYawRate}`);
  assert.ok(maxYawAccel < .01, `yaw eases (${maxYawAccel} rad/s per frame)`);
  assert.ok(maxZoomRate <= droneMod.DRONE_SETTINGS.zoomRate + 1e-6, `zoom rate ${maxZoomRate} keeps vector trees crisp`);
});

test('blends smoothly from the drone into a spawn dive and back onto the path', () => {
  const { layout, trees } = scene(), p = droneMod.buildDronePath({ trees, outline: layout.outline });
  const drone = droneMod.createGardenDrone(); drone.setPath(p, VIEW);
  const orbit = robot.createGardenOrbit(), dt = 1000 / 60, viewport = { x: 32, y: 32, w: 1200, h: VIEW };
  let camera = { x: 0, y: 0, zoom: .25, yaw: 0, auto: true };
  const log = [], record = phase => log.push({ phase, x: camera.x, y: camera.y, lz: Math.log(camera.zoom), yaw: camera.yaw });
  const fly = ms => {
    const start = orbit.pose(camera);
    drone.resume({ x: start.center.x, y: start.center.y, yaw: camera.yaw, yawRate: orbit.angularVelocity }, VIEW);
    for (let t = 0; t < ms; t += dt) { camera = orbit.steer(camera, dt, drone.step(dt, { viewHeight: VIEW })); record('drone'); }
  };
  fly(20000);
  // A spawn a few hundred units from the drone.
  const here = drone.position, target = nearest(trees.filter(t => Math.hypot(t.x - here.x, t.y - here.y) > 250), here).t;
  const root = robot.projectGround(target.x, target.y, camera.yaw);
  const subject = { id: target.id, x: target.x, y: target.y, treeBounds: { x: root.x - 68, y: root.y - 274, w: 136, h: 274 }, weatherBounds: null, bounds: null };
  const overview = orbit.pose(camera);
  const close = robot.frameSpawnSubjects([subject], viewport, .25, { projectedCenter: root, viewportOffsetY: 0 });
  assert.ok(close.zoom > overview.zoom, 'the dive frames the new tree closer than the drone view');
  for (let elapsed = 0; elapsed < robot.DIVE_DURATION_MS + 2000; elapsed += dt) {
    const sample = robot.sampleDiveTargets(overview, close, elapsed, { speed: 1, crown: 1 });
    camera = orbit.step(camera, dt, { ...sample, autoOrbit: true }); record('dive');
  }
  fly(30000);
  assert.ok(log.length > 2000);
  const d1 = [], d2 = [];
  for (let i = 1; i < log.length; i++) {
    d1.push(Math.hypot(log[i].x - log[i - 1].x, log[i].y - log[i - 1].y));
    if (i > 1) d2.push(Math.hypot(log[i].x - 2 * log[i - 1].x + log[i - 2].x, log[i].y - 2 * log[i - 1].y + log[i - 2].y));
  }
  const entry = log.findIndex(f => f.phase === 'dive'), exit = log.findIndex((f, i) => i > entry && f.phase === 'drone');
  const around = (index, values) => Math.max(...values.slice(Math.max(0, index - 6), index + 6));
  for (const [label, index] of [['dive entry', entry], ['drone resume', exit]]) {
    assert.ok(around(index, d1) < 20, `${label}: position step ${around(index, d1)} px/frame`);
    assert.ok(around(index, d2) < 1.5, `${label}: no acceleration spike (${around(index, d2)} px/frame^2)`);
    const jumps = log.slice(Math.max(1, index - 6), index + 6).map((f, i, all) => i ? Math.abs(f.lz - all[i - 1].lz) : 0);
    assert.ok(Math.max(...jumps) < .02, `${label}: zoom step`);
    const yawSteps = log.slice(Math.max(1, index - 6), index + 6).map((f, i, all) => i ? Math.abs(f.yaw - all[i - 1].yaw) : 0);
    assert.ok(Math.max(...yawSteps) < .01, `${label}: yaw step`);
  }
  assert.ok(Math.max(...d1) < 40, `no frame in the whole sequence jumps (${Math.max(...d1)} px)`);
  assert.ok(Math.max(...d2) < 4, `no frame accelerates like a snap (${Math.max(...d2)} px/frame^2)`);
  // After the dive the drone rejoins the nearest point of the loop instead of restarting from the seam.
  drone.resume({ x: here.x, y: here.y, yaw: 0 }, VIEW);
  const back = drone.path.at(drone.s);
  assert.ok(Math.hypot(back.x - here.x, back.y - here.y) < 60, 'resume joins the nearest path point');
});

test('rebuilding the path for a changed layout keeps the drone where it is', () => {
  const a = scene(), b = scene([12, 8, 5, 3, 2, 2, 1, 20, 30, 4]);
  const first = droneMod.buildDronePath({ trees: a.trees, outline: a.layout.outline });
  const drone = droneMod.createGardenDrone(); drone.setPath(first, VIEW); drone.resume({ x: first.x[300], y: first.y[300], yaw: 0 }, VIEW);
  for (let i = 0; i < 600; i++) drone.step(16.7, { viewHeight: VIEW });
  const before = drone.step(16.7, { viewHeight: VIEW }).position;
  drone.setPath(droneMod.buildDronePath({ trees: b.trees, outline: b.layout.outline }), VIEW);
  const after = drone.step(16.7, { viewHeight: VIEW }).position;
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 400, 'rejoins the new loop near the old position, not at the seam');
});

test('degenerate inputs still fly: no trees, one tree', () => {
  for (const trees of [[], [{ id: 'a', x: 100, y: 100, radius: 60, height: 240 }]]) {
    const p = droneMod.buildDronePath({ trees, outline: [{ x: 0, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 700 }, { x: 0, y: 700 }] });
    assert.ok(p.length > 500 && p.count > 20);
    const drone = droneMod.createGardenDrone(); drone.setPath(p, VIEW); drone.resume({ x: 450, y: 350, yaw: 0 }, VIEW);
    const pose = drone.step(16.7, { viewHeight: VIEW });
    assert.ok(Number.isFinite(pose.zoom) && Number.isFinite(pose.lift) && Number.isFinite(pose.yaw));
  }
});

test('a real-size island builds quickly', () => {
  const counts = Array.from({ length: 60 }, (_, i) => i === 0 ? 300 : i === 1 ? 120 : 6);
  const { layout, trees } = scene(counts);
  const started = performance.now(), p = droneMod.buildDronePath({ trees, outline: layout.outline });
  const ms = performance.now() - started;
  assert.ok(trees.length > 500);
  assert.ok(ms < budgetMs(600), `built ${trees.length} trees in ${ms.toFixed(0)} ms`);
  assert.ok(p.length > 3000);
  console.log(`drone path: ${trees.length} trees, ${p.length.toFixed(0)} units, ${ms.toFixed(0)} ms, min canopy gap ${p.minCanopyGap.toFixed(0)}`);
});

test('camera wiring: yaw is steered directly, dives start from the drone pose, and the drone never marks specimens moving', () => {
  const source = fs.readFileSync(dir + 'canvas-garden.js', 'utf8');
  assert.match(source, /import \{ buildDronePath, createGardenDrone \} from '\.\/garden-drone-path\.js'/);
  assert.match(source, /gardenOrbit\.steer\(camera,delta,pose\)/);
  assert.match(source, /function orbitBasePose\(\)\{return drone\.ready\?gardenOrbit\.pose\(camera\):centralOrbitFraming\(\)\}/);
  assert.match(source, /const overview=orbitBasePose\(\),subjectIds/, 'spawn dives start from the drone pose');
  const specimenMoving = source.slice(source.indexOf('function specimenMoving('), source.indexOf('\n', source.indexOf('function specimenMoving(')));
  assert.doesNotMatch(specimenMoving, /drone/i, 'the drone is not a reason for specimens to count as moving');
  assert.match(source, /droneStepped=changed=true/);
  assert.match(source, /orbitStepPending=true;droneStepped=changed=true/, 'drone steps use the slow-orbit crisp-tree exemption');
  const gate = source.slice(source.indexOf('const cameraAvailable='), source.indexOf('const automaticOrbit='));
  assert.match(gate, /!motionPreference\.matches/, 'reduced motion keeps the camera still');
  assert.match(source, /const droneEligible=cameraAvailable&&automaticOrbit&&freeCamera/, 'the drone requires the same availability gate as the orbit');
  assert.match(source, /focusIds:subjects/, 'dive subjects stay crisp while the camera moves');
  assert.match(source, /camera\.zoom\/baseCamera\.zoom>\(droneFlying\|\|fitFollower\.active\?1\.02:1\.1\)/, 'continuous drone zoom rebuilds the forest canvas before it can blur');
  assert.match(source, /DRONE_IDLE_RESUME_MS/);
});

test('the orbit can steer, report its pose and hold it', () => {
  const orbit = robot.createGardenOrbit(), camera = { x: 100, y: 50, zoom: .5, yaw: 0, auto: true };
  const pose = orbit.pose(camera);
  const held = orbit.step(camera, 500, { center: { x: 9999, y: 9999 }, zoom: 9, hold: true, autoOrbit: false });
  assert.ok(Math.abs(held.zoom - .5) < 1e-9 && Math.abs(held.x - camera.x) < 1e-6, 'hold keeps the current framing');
  const steered = orbit.steer(held, 500, { center: { x: pose.center.x + 10, y: pose.center.y }, zoom: .5, yaw: .2, yawRate: .1 });
  assert.equal(steered.yaw, .2);
  assert.equal(orbit.angularVelocity, .1, 'yaw rate carries into a dive or coast');
});

// ---- Measured cloud fit: the fit is solved from the cloud's real painted geometry and checked against the real draw path. ----
const W = 1280, H = 920, VIEWPORT = { x: 32, y: 32, w: 1216, h: VIEW }, OFFSET_Y = VIEWPORT.y + VIEWPORT.h / 2 - H / 2;
let weather, procedural;
before(async () => {
  weather = await import(pathToFileURL(dir + 'garden-arrival-weather.js').href);
  procedural = await import(pathToFileURL(dir + 'procedural-clouds.js').href);
});
const GROWTH_MS = [400, 1500, 2600, 3200, 4500, 6500, 6850, 9000, 12000, 13500, 13900];

// Independent recording context: keeps every coordinate the real draw code submits, in device pixels.
function recordingContext(dpr) {
  const points = []; let widest = 0;
  const add = (x, y, rx = 0, ry = rx) => { if (Number.isFinite(x) && Number.isFinite(y)) points.push([x - rx, y - ry, x + rx, y + ry]); };
  const noop = () => {}; const gradient = () => ({ addColorStop: noop });
  const ctx = { globalAlpha: 1, lineWidth: 1, save: noop, restore: noop, beginPath: noop, closePath: noop, clip: noop, fill: noop, setLineDash: noop,
    stroke() { widest = Math.max(widest, this.lineWidth); }, moveTo: add, lineTo: add, arc: (x, y, r) => add(x, y, r), ellipse: (x, y, rx, ry) => add(x, y, rx, ry),
    quadraticCurveTo: (a, b, x, y) => { add(a, b); add(x, y); }, bezierCurveTo: (a, b, c, d, x, y) => { add(a, b); add(c, d); add(x, y); },
    drawImage: (img, ...a) => { const [x, y, w, h] = a.slice(-4); add(x, y); add(x + w, y + h); },
    createLinearGradient: gradient, createRadialGradient: gradient };
  return { ctx, dpr, extent() {
    const pad = widest / 2;
    return points.reduce((e, [a, b, c, d]) => ({ l: Math.min(e.l, a - pad), t: Math.min(e.t, b - pad), r: Math.max(e.r, c + pad), b: Math.max(e.b, d + pad) }), { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity });
  } };
}

// One cloud painted the way canvas-garden.js paints it, for a camera pose; returns device-pixel extent.
function paintCloud(subject, cloud, elapsed, cam, dpr) {
  const rec = recordingContext(dpr), root = { x: W / 2 + (subject.root.x - cam.x) * cam.zoom, y: H / 2 + (subject.root.y - cam.y) * cam.zoom };
  const state = procedural.sampleArrival(elapsed), view = weather.arrivalCloudView(root, subject.height * cam.zoom, cam.yaw);
  weather.drawGardenArrivalLight(rec.ctx, state, view); weather.drawGardenArrivalCloud(rec.ctx, cloud, state, view, { texture: null, opacity: .85 });
  const e = rec.extent();
  return Number.isFinite(e.l) ? { l: e.l * dpr, t: e.t * dpr, r: e.r * dpr, b: e.b * dpr } : null;
}
function inside(e, dpr, slack = 1) {
  return e.l >= (VIEWPORT.x - slack) * dpr && e.t >= (VIEWPORT.y - slack) * dpr && e.r <= (VIEWPORT.x + VIEWPORT.w + slack) * dpr && e.b <= (VIEWPORT.y + VIEWPORT.h + slack) * dpr;
}
function fitSubject(tree, cloud, yaw, elevation = 30) {
  const root = robot.projectGround(tree.x, tree.y, yaw, elevation);
  return { id: tree.id, height: tree.height, root, treeRel: { x: -CANOPY_RADIUS, y: -tree.height, w: CANOPY_RADIUS * 2, h: tree.height }, cloudRel: weather.arrivalCloudExtent(cloud),
    unit: zoom => weather.arrivalCloudView(root, tree.height * zoom, 0).scale };
}
const cloudFor = id => weather.createGardenArrivalCloud(id);

test('the measured extent comes from the painted geometry and covers every growth time', () => {
  const cloud = cloudFor('measure-me'), extent = weather.arrivalCloudExtent(cloud);
  for (const elapsed of GROWTH_MS) for (const yaw of [-1.2, 0, .9, 2.4]) {
    const state = procedural.sampleArrival(elapsed), m = weather.measureArrivalCloud(cloud, state, { x: 0, y: 0, scale: 1, yaw: -.25 + yaw });
    if (!m) continue;
    assert.ok(m.x >= extent.x - 1 && m.y >= extent.y - 1 && m.x + m.w <= extent.x + extent.w + 1 && m.y + m.h <= extent.y + extent.h + 1, `t=${elapsed} yaw=${yaw} inside the grown extent`);
  }
  assert.ok(extent.w > 150 && extent.h > 250, 'a real cloud has real size');
});

test('the fit keeps every drawn coordinate of 1 and 3 clouds inside the viewport at every growth time, yaw and dpr', () => {
  const { trees } = scene();
  for (const ids of [[trees[3].id], [trees[3].id, trees[40].id, trees[70].id]]) for (const yaw of [0, .7, 2.1, -1.3]) for (const dpr of [1, 2]) {
    const clouds = ids.map(cloudFor), subjects = ids.map((id, i) => fitSubject(trees.find(t => t.id === id), clouds[i], yaw));
    const fit = robot.fitCloudSubjects(subjects, VIEWPORT, yaw, { canvas: { w: W, h: H } });
    const cam = { x: fit.camera.x, y: fit.camera.y, zoom: fit.zoom, yaw };
    for (const elapsed of GROWTH_MS) subjects.forEach((subject, i) => {
      const e = paintCloud(subject, clouds[i], elapsed, cam, dpr);
      if (e) assert.ok(inside(e, dpr), `${ids.length} clouds, yaw ${yaw}, dpr ${dpr}, t=${elapsed}: ${JSON.stringify(e)}`);
    });
    const containment = robot.cloudFitContainment(subjects, cam, VIEWPORT, { w: W, h: H });
    assert.ok(containment.contained, 'the measured union (trees included) is inside the viewport');
    // About 8% padding: the union never spans more than the padded share of the viewport.
    assert.ok(fit.extent.w <= VIEWPORT.w * .85 && fit.extent.h <= VIEWPORT.h * .85, 'padding kept');
  }
  const one = robot.fitCloudSubjects([fitSubject(trees[3], cloudFor(trees[3].id), 0)], VIEWPORT, 0, { canvas: { w: W, h: H } });
  const three = robot.fitCloudSubjects([3, 40, 70].map(i => fitSubject(trees[i], cloudFor(trees[i].id), 0)), VIEWPORT, 0, { canvas: { w: W, h: H } });
  assert.ok(three.zoom < one.zoom, 'several clouds zoom out to fit them all');
});

// Mirrors the canvas cloud branch: follower chases the measured fit (urgent when a cloud leaves the viewport), else the resumed drone.
function cloudSim() {
  const { layout, trees } = scene(), path = droneMod.buildDronePath({ trees, outline: layout.outline });
  const drone = droneMod.createGardenDrone(); drone.setPath(path, VIEW);
  const orbit = robot.createGardenOrbit(), follower = robot.createPoseFollower(), dt = 1000 / 60, clouds = new Map();
  let camera = { x: 0, y: 0, zoom: .25, yaw: 0, auto: true }, handoff = false, flying = false, urgent = false, active = [];
  const log = [];
  const frame = () => {
    const view = { viewHeight: VIEW, viewportOffsetY: OFFSET_Y };
    let fit = null, subjects = [];
    if (active.length || follower.active) {
      if (!follower.active) { follower.reset({ ...orbit.pose(camera), yaw: camera.yaw, yawRate: orbit.angularVelocity }); flying = false; handoff = false; }
      let target;
      if (active.length) {
        subjects = active.map(id => fitSubject(trees.find(t => t.id === id), clouds.get(id), camera.yaw));
        const wanted = urgent ? [...subjects, { root: { x: camera.x, y: camera.y }, treeRel: { x: 0, y: 0, w: 1, h: 1 }, cloudRel: null, unit: () => 1 }] : subjects;
        fit = robot.fitCloudSubjects(wanted, VIEWPORT, camera.yaw, { canvas: { w: W, h: H }, startZoom: camera.zoom });
        target = { center: fit.center, zoom: fit.zoom, lift: fit.lift }; handoff = false;
      } else {
        if (!handoff) { const from = follower.pose; drone.resume({ x: from.center.x, y: from.center.y, yaw: from.yaw, yawRate: from.yawRate }, VIEW); handoff = true; }
        const dp = drone.step(dt, view); target = { center: dp.center, zoom: dp.zoom, lift: dp.lift, yaw: dp.yaw };
      }
      const pose = follower.step(dt, target, { urgent: !!fit && urgent });
      camera = orbit.steer(camera, dt, { center: pose.center, zoom: pose.zoom, lift: pose.lift, yaw: pose.yaw, yawRate: pose.yawRate });
      urgent = !!fit && !robot.cloudFitContainment(subjects, camera, VIEWPORT, { w: W, h: H }, 1).contained;
      if (!fit && pose.remaining.center < 30 && pose.remaining.zoom < .03) { drone.adoptHeading(pose.yaw, pose.yawRate); follower.reset(null); handoff = false; flying = true; }
    } else {
      if (!flying) { const a = orbit.pose(camera); drone.resume({ x: a.center.x, y: a.center.y, yaw: camera.yaw, yawRate: orbit.angularVelocity }, VIEW); flying = true; }
      camera = orbit.steer(camera, dt, drone.step(dt, view));
    }
    log.push({ mode: active.length || follower.active ? 'cloud' : 'drone', x: camera.x, y: camera.y, lz: Math.log(camera.zoom), yaw: camera.yaw, subjects, zoom: camera.zoom, cam: { ...camera } });
  };
  return { trees, log, run(ms) { for (let t = 0; t < ms; t += dt) frame(); },
    set(ids) { for (const id of ids) if (!clouds.has(id)) clouds.set(id, cloudFor(id)); active = ids; },
    cloudsOf: () => clouds, get camera() { return camera; }, get active() { return active; } };
}
function spikes(log, from = 1, to = log.length) {
  let step = 0, accel = 0, zoom = 0, yaw = 0;
  for (let i = Math.max(2, from); i < Math.min(log.length, to); i++) {
    const a = log[i - 2], b = log[i - 1], c = log[i], z = Math.exp(c.lz); // screen pixels, not projected world units
    step = Math.max(step, Math.hypot(c.x - b.x, c.y - b.y) * z);
    accel = Math.max(accel, Math.hypot(c.x - 2 * b.x + a.x, c.y - 2 * b.y + a.y) * z);
    zoom = Math.max(zoom, Math.abs(c.lz - b.lz)); yaw = Math.max(yaw, Math.abs(c.yaw - b.yaw));
  }
  return { step, accel, zoom, yaw };
}
// Device-pixel drawn extent of every active cloud for the frame's camera, at the clouds' current growth time.
function drawnInside(sim, frameIndex, elapsed, dpr = 2) {
  const f = sim.log[frameIndex];
  return f.subjects.every(subject => {
    const e = paintCloud(subject, sim.cloudsOf().get(subject.id), elapsed, f.cam, dpr);
    return !e || inside(e, dpr);
  });
}

test('drone to cloud fit to drone has no position, zoom or yaw spikes, and the drawn cloud stays in view once settled', () => {
  const sim = cloudSim(); sim.run(15000);
  const enter = sim.log.length; sim.set([sim.trees[10].id, sim.trees[50].id, sim.trees[80].id]);
  let outsideLate = 0;
  for (let ms = 0; ms < 12000; ms += 250) {
    sim.run(250);
    const elapsed = 500 + ms; // clouds grow while the camera glides
    if (ms >= 4000 && !drawnInside(sim, sim.log.length - 1, Math.min(elapsed, 13900))) outsideLate++;
  }
  assert.equal(outsideLate, 0, 'after 4 s no painted coordinate leaves the viewport');
  for (const elapsed of GROWTH_MS) assert.ok(drawnInside(sim, sim.log.length - 1, elapsed), `settled fit contains growth time ${elapsed}`);
  const leave = sim.log.length; sim.set([]); sim.run(25000);
  assert.ok(sim.log[sim.log.length - 1].mode === 'drone', 'returns to the drone');
  const whole = spikes(sim.log, 600);
  assert.ok(whole.step < 30, `position step ${whole.step}`);
  assert.ok(whole.accel < 2, `acceleration ${whole.accel}`);
  assert.ok(whole.zoom < .02 || Math.abs(whole.zoom) < .05, `zoom step ${whole.zoom}`);
  assert.ok(whole.yaw < .01, `yaw step ${whole.yaw}`);
  assert.ok(spikes(sim.log, leave - 30, leave + 240).accel < 1.5, 'clouds finishing does not jolt the camera');
  void enter;
});

test('the hard guarantee: a cloud that appears far from the drone is in view within a short time bound', () => {
  const sim = cloudSim(); sim.run(12000);
  const far = sim.trees.reduce((a, t) => { const p = sim.camera; return Math.hypot(t.x, t.y) > Math.hypot(a.x, a.y) ? t : a; }, sim.trees[0]);
  sim.set([far.id]);
  const start = sim.log.length; let firstIn = null;
  for (let ms = 0; ms < 9000; ms += 100) {
    sim.run(100);
    const idx = sim.log.length - 1;
    if (firstIn === null && robot.cloudFitContainment(sim.log[idx].subjects, sim.log[idx].cam, VIEWPORT, { w: W, h: H }, 2).contained) firstIn = ms;
    if (firstIn !== null) assert.ok(robot.cloudFitContainment(sim.log[idx].subjects, sim.log[idx].cam, VIEWPORT, { w: W, h: H }, 6).contained, `stays in view after ${firstIn} ms (at ${ms} ms)`);
  }
  assert.ok(firstIn !== null && firstIn <= 6000, `cloud fully in view within 6 s (${firstIn})`);
  void start;
});

test('the fit updates smoothly when a second cloud appears and when one finishes', () => {
  const sim = cloudSim(); sim.run(10000);
  const a = sim.trees[5].id, b = sim.trees[60].id;
  sim.set([a]); sim.run(8000);
  const oneZoom = sim.log[sim.log.length - 1].lz;
  const added = sim.log.length; sim.set([a, b]); sim.run(8000);
  const twoZoom = sim.log[sim.log.length - 1].lz;
  assert.ok(twoZoom < oneZoom - .05, `the fit zooms out for the second cloud (${oneZoom} -> ${twoZoom})`);
  const around = spikes(sim.log, added - 10, added + 480);
  assert.ok(around.accel < 2 && around.step < 25 && around.zoom < .05, `smooth retarget ${JSON.stringify(around)}`);
  for (const elapsed of GROWTH_MS) assert.ok(drawnInside(sim, sim.log.length - 1, elapsed), `both clouds contained at ${elapsed}`);
  const finished = sim.log.length; sim.set([b]); sim.run(8000);
  assert.ok(spikes(sim.log, finished - 10, finished + 480).accel < 2, 'one cloud finishing re-fits smoothly');
});

test('cloud fit wiring: measured extents, one shared draw scale, base-space painting, urgent guarantee, input priority', () => {
  const source = fs.readFileSync(dir + 'canvas-garden.js', 'utf8');
  assert.match(source, /cloudRel:item\?arrivalCloudExtent\(item\.cloud\):null/, 'the fit is solved from the measured extent');
  assert.match(source, /unit:zoom=>arrivalCloudView\(root,\(local\.h\|\|0\)\*zoom,0\)\.scale/, 'fit and painter share one scale rule');
  const painter = source.slice(source.indexOf('function drawArrivalClouds('), source.indexOf('function syncCommitPulses'));
  assert.match(painter, /arrivalCloudView\(root,bounds\?\.h,baseCamera\.yaw\)/);
  assert.match(painter, /basePoint\(tree\.x,tree\.y,treeElevation\(tree\)\)/, 'painted in base-camera space, matching drawDynamic\'s transform');
  assert.match(source, /fitUrgent=!!fit&&!cloudFitContainment\(fitSubjects,camera,view,\{w:W,h:H\},1\)\.contained/, 'hard guarantee re-checks the real camera each frame');
  assert.match(source, /fitFollower\.step\(delta,target,\{urgent:!!fit&&fitUrgent\}\)/);
  const gate = source.slice(source.indexOf('const cloudEligible='), source.indexOf('if(cloudEligible){'));
  for (const term of ['cameraAvailable', '!ambientSuspended', 'now>=droneAfter', '!spinHeld', '!panHeld', '!arrival']) assert.ok(gate.includes(term), term);
  assert.match(source, /subjects=new Set\(\[\.\.\.\(move\?\.subjectIds\|\|\[\]\),\.\.\.\(cloudFitIds\|\|\[\]\)\]\)/);
  const specimenMoving = source.slice(source.indexOf('function specimenMoving('), source.indexOf('\n', source.indexOf('function specimenMoving(')));
  assert.doesNotMatch(specimenMoving, /cloud|fitFollower/i);
});
