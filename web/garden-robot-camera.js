const TAU = Math.PI * 2;
const clamp = value => Math.max(0, Math.min(1, value));
const ease = value => { const t = clamp(value); return t * t * t * (t * (t * 6 - 15) + 10); };

export const GARDEN_ORBIT_MS = 120000;
export const DIVE_DURATION_MS = 14000;
export const SHOWCASE_HOLD_MS = 8000;
export const SHOWCASE_DURATION_MS = 14000;

// Exact critically damped response. Retargeting preserves velocity and position.
function settleAxis(axis, target, seconds, responseScale = 1) {
    const frequency = 2.4 * Math.max(.5, Math.min(2, responseScale));
    const offset = axis.value - target;
    const impulse = axis.velocity + frequency * offset;
    const decay = Math.exp(-frequency * seconds);
    return { value: target + (offset + impulse * seconds) * decay,
        velocity: (axis.velocity - frequency * impulse * seconds) * decay };
}

/** One uninterrupted azimuth orbit. Spawns change framing, never the orbit clock. */
export function createGardenOrbit() {
    let state = null;
    const initialize = camera => {
        const anchor = unprojectGround(camera.x, camera.y, camera.yaw || 0);
        const axis = value => ({ value, velocity: 0 });
        state = { x: axis(anchor.x), y: axis(anchor.y), lift: axis(0),
            zoom: axis(Math.log(camera.zoom)), yaw: camera.yaw || 0, speed: 0, direction: 1 };
    };
    return {
        reset() { state = null; },
        rebase(camera, { angularVelocity = state?.speed || 0 } = {}) {
            const direction = state?.direction || Math.sign(angularVelocity) || 1;
            initialize(camera); state.speed = angularVelocity; state.direction = direction;
        },
        get active() { return !!state; },
        get angularVelocity() { return state?.speed || 0; },
        get direction() { return state?.direction || 1; },
        /** Apply direct-manipulation yaw and seed the coast from the pointer velocity. */
        spin(camera, deltaYaw, angularVelocity = 0) {
            if (!state) initialize(camera);
            const anchor = unprojectGround(camera.x, camera.y, camera.yaw || 0);
            state.yaw = (camera.yaw || 0) + (Number.isFinite(deltaYaw) ? deltaYaw : 0);
            state.speed = Number.isFinite(angularVelocity) ? angularVelocity : 0;
            if (Math.abs(state.speed) > 1e-5) state.direction = Math.sign(state.speed);
            const axis = value => ({ value, velocity: 0 });
            state.x = axis(anchor.x); state.y = axis(anchor.y); state.lift = axis(0);
            state.zoom = axis(Math.log(Math.max(.006, camera.zoom)));
            const projected = projectGround(anchor.x, anchor.y, state.yaw);
            return { ...camera, x: projected.x, y: projected.y, yaw: state.yaw, auto: true };
        },
        /** Current framing (ground anchor, zoom, lift), so a spawn dive can start from and return to the drone pose. */
        pose(camera) {
            if (!state) initialize(camera);
            return { center: { x: state.x.value, y: state.y.value }, zoom: Math.exp(state.zoom.value), lift: state.lift.value };
        },
        /**
         * Follow a drone pose: position, zoom and lift settle toward it with velocity preserved, while yaw is
         * taken from the drone directly (its rate is stored so a later dive continues without a jerk).
         */
        steer(camera, elapsedMs, { center, zoom, lift = 0, yaw, yawRate = 0, responseScale = 1.8 }) {
            if (!state) initialize(camera);
            const seconds = Math.min(100, Math.max(0, elapsedMs || 0)) / 1000;
            if (!seconds) return { ...camera };
            if (Number.isFinite(yaw)) { state.yaw = yaw; state.speed = Number.isFinite(yawRate) ? yawRate : 0; }
            if (Math.abs(state.speed) > 1e-5) state.direction = Math.sign(state.speed);
            state.x = settleAxis(state.x, center.x, seconds, responseScale);
            state.y = settleAxis(state.y, center.y, seconds, responseScale);
            state.lift = settleAxis(state.lift, lift, seconds, responseScale);
            state.zoom = settleAxis(state.zoom, Math.log(Math.max(.006, zoom)), seconds, responseScale);
            const projected = projectGround(state.x.value, state.y.value, state.yaw);
            return { ...camera, x: projected.x, y: projected.y - state.lift.value,
                zoom: Math.exp(state.zoom.value), yaw: state.yaw };
        },
        step(camera, elapsedMs, { center, zoom, lift = 0, speedScale = 1, responseScale = 1,
            autoOrbit = true, holdYaw = false, hold = false }) {
            if (!state) initialize(camera);
            if (hold) { center = { x: state.x.value, y: state.y.value }; zoom = Math.exp(state.zoom.value); lift = state.lift.value; }
            const seconds = Math.min(100, Math.max(0, elapsedMs || 0)) / 1000;
            if (!seconds) return { ...camera };
            const speed = autoOrbit ? state.direction * TAU / (GARDEN_ORBIT_MS / 1000)
                * Math.max(0, Number.isFinite(speedScale) ? speedScale : 1) : 0;
            const ramp = 1.2 / Math.max(.5, Math.min(2, responseScale));
            const decay = Math.exp(-seconds / ramp);
            if (!holdYaw) {
                state.yaw += speed * seconds + (state.speed - speed) * ramp * (1 - decay);
                state.speed = speed + (state.speed - speed) * decay;
            }
            state.x = settleAxis(state.x, center.x, seconds, responseScale);
            state.y = settleAxis(state.y, center.y, seconds, responseScale);
            state.lift = settleAxis(state.lift, lift, seconds, responseScale);
            state.zoom = settleAxis(state.zoom, Math.log(Math.max(.006, zoom)), seconds, responseScale);
            const projected = projectGround(state.x.value, state.y.value, state.yaw);
            return { ...camera, x: projected.x, y: projected.y - state.lift.value,
                zoom: Math.exp(state.zoom.value), yaw: state.yaw };
        },
    };
}

export function releaseSpinVelocity(velocity, idleMs, staleMs = 80) {
    if (!Number.isFinite(velocity)) return 0;
    return Math.max(0, Number(idleMs) || 0) > Math.max(0, staleMs) ? 0 : velocity;
}

export function isCameraMoveComplete(move) {
    if (!move || !Number.isFinite(move.elapsed)) return false;
    if (move.kind === 'dive') return move.elapsed >= DIVE_DURATION_MS;
    if (move.kind === 'showcase') return move.elapsed >= SHOWCASE_DURATION_MS;
    return false;
}

function mix(from, to, amount) { return from + (to - from) * clamp(amount); }
function mixPoint(from, to, amount) {
    return { x: mix(from.x, to.x, amount), y: mix(from.y, to.y, amount) };
}

/** Highest-work anchor, then the nearest members of the same arrival batch. */
export function selectDiveSubjects(candidates, limit = 3) {
    const valid = (candidates || []).filter(item => item && item.id != null
        && Number.isFinite(item.x) && Number.isFinite(item.y));
    if (!valid.length) return [];
    const byWork = (a, b) => (Number(b.work) || 0) - (Number(a.work) || 0)
        || String(a.id).localeCompare(String(b.id));
    const anchor = valid.slice().sort(byWork)[0];
    const nearest = valid.filter(item => item !== anchor).sort((a, b) =>
        Math.hypot(a.x - anchor.x, a.y - anchor.y) - Math.hypot(b.x - anchor.x, b.y - anchor.y)
        || byWork(a, b));
    return [anchor, ...nearest].slice(0, Math.max(1, Math.min(3, Math.floor(limit) || 3)));
}

function combinedBounds(subjects) {
    const bounds = subjects.flatMap(subject => [subject.treeBounds, subject.weatherBounds, subject.bounds])
        .filter(bound => bound && Number.isFinite(bound.x) && Number.isFinite(bound.y)
            && Number.isFinite(bound.w) && Number.isFinite(bound.h));
    if (!bounds.length) return null;
    const left = Math.min(...bounds.map(bound => bound.x));
    const top = Math.min(...bounds.map(bound => bound.y));
    const right = Math.max(...bounds.map(bound => bound.x + bound.w));
    const bottom = Math.max(...bounds.map(bound => bound.y + bound.h));
    return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Frame settled tree and weather bounds without allowing a tiny subject to over-zoom. */
export function frameDiveSubjects(subjects, viewport, islandZoom, {
    projectedCenter = null, viewportOffsetY = 0, heightFill = .52, widthFill = .78,
} = {}) {
    if (!subjects?.length) return null;
    const left = Math.min(...subjects.map(subject => subject.x));
    const right = Math.max(...subjects.map(subject => subject.x));
    const top = Math.min(...subjects.map(subject => subject.y));
    const bottom = Math.max(...subjects.map(subject => subject.y));
    const center = { x: (left + right) / 2, y: (top + bottom) / 2 };
    const bounds = combinedBounds(subjects);
    if (!bounds) return null;
    const width = Math.max(1, viewport?.w || viewport?.width || 1);
    const height = Math.max(1, viewport?.h || viewport?.height || 1);
    const baseZoom = Math.max(.006, Number(islandZoom) || .006);
    const zoomCap = Math.min(3, baseZoom * 2.5);
    const fit = Math.min(width * widthFill / Math.max(1, bounds.w),
        height * heightFill / Math.max(1, bounds.h));
    const zoom = Math.max(baseZoom, Math.min(zoomCap, fit));
    const projected = projectedCenter || { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
    const lift = projected.y - (bounds.y + bounds.h / 2) + viewportOffsetY / zoom;
    return { center, zoom, lift, bounds, zoomCap };
}

/** Share of the viewport a lone spawning tree fills (height), and the group fit for several. */
export const SPAWN_TREE_HEIGHT_FILL = .68;
export const SPAWN_GROUP_FILL = { height: .84, width: .88 };

/**
 * The spawning tree(s) are the subject: zoom until a single settled tree is ~68% of the viewport
 * height, or until several trees' union bounds fit tightly with padding. Weather is left to overflow.
 */
export function frameSpawnSubjects(subjects, viewport, islandZoom, { projectedCenter = null, viewportOffsetY = 0 } = {}) {
    if (!subjects?.length) return null;
    const trees = subjects.map(subject => ({ ...subject, weatherBounds: null, bounds: null }));
    const framed = frameDiveSubjects(trees, viewport, islandZoom, { projectedCenter, viewportOffsetY });
    if (!framed) return null;
    const single = trees.length === 1;
    const width = Math.max(1, viewport?.w || viewport?.width || 1);
    const height = Math.max(1, viewport?.h || viewport?.height || 1);
    const fill = single ? { height: SPAWN_TREE_HEIGHT_FILL, width: .9 } : SPAWN_GROUP_FILL;
    const bounds = framed.bounds;
    const fit = Math.min(width * fill.width / Math.max(1, bounds.w), height * fill.height / Math.max(1, bounds.h));
    const baseZoom = Math.max(.006, Number(islandZoom) || .006);
    const zoom = Math.max(baseZoom, Math.min(3, fit));
    const projected = projectedCenter || { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
    return { ...framed, zoom, zoomCap: 3, lift: projected.y - (bounds.y + bounds.h / 2) + viewportOffsetY / zoom };
}

/**
 * Programmatic zoom-to-fit for growing clouds. Every subject supplies MEASURED geometry:
 *   root      projected ground point of its tree (zoom-1 projected units, same space as camera.x/y)
 *   treeRel   the tree's settled bounds relative to root at zoom 1
 *   cloudRel  the cloud's largest measured extent relative to root at scale 1 (arrivalCloudExtent), or null
 *   unit(z)   the scale the cloud is drawn at for camera zoom z (arrivalCloudUnit of the tree's height at z)
 * Screen size of the tree scales with z; the cloud scales with unit(z), which is clamped, so the zoom is solved by
 * iterating on the projected bounds at the candidate zoom, then verified. The union must sit inside the viewport
 * with `padding` of margin on every side.
 */
export const CLOUD_FIT_PADDING = .08;
export function cloudScreenExtent(subjects, zoom) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const take = (x, y, w, h) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h); };
    for (const subject of subjects) {
        const rx = subject.root.x * zoom, ry = subject.root.y * zoom, tree = subject.treeRel;
        if (tree) take(rx + tree.x * zoom, ry + tree.y * zoom, tree.w * zoom, tree.h * zoom);
        if (subject.cloudRel) {
            const u = subject.unit(zoom), c = subject.cloudRel;
            take(rx + c.x * u, ry + c.y * u, c.w * u, c.h * u);
        }
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY } : null;
}
export function fitCloudSubjects(subjects, viewport, yaw = 0, { canvas = null, padding = CLOUD_FIT_PADDING,
    minZoom = .006, maxZoom = 3, startZoom = 1, pixelPad = 3 } = {}) {
    if (!subjects?.length) return null;
    const vw = Math.max(1, viewport?.w || viewport?.width || 1), vh = Math.max(1, viewport?.h || viewport?.height || 1);
    const offX = canvas ? viewport.x + vw / 2 - canvas.w / 2 : 0, offY = canvas ? viewport.y + vh / 2 - canvas.h / 2 : 0;
    const availW = Math.max(1, vw * (1 - 2 * padding) - pixelPad * 2), availH = Math.max(1, vh * (1 - 2 * padding) - pixelPad * 2);
    let zoom = Math.max(minZoom, Math.min(maxZoom, startZoom));
    let extent = cloudScreenExtent(subjects, zoom);
    if (!extent) return null;
    for (let i = 0; i < 4; i++) {
        zoom = Math.max(minZoom, Math.min(maxZoom, zoom * Math.min(availW / Math.max(1, extent.w), availH / Math.max(1, extent.h))));
        extent = cloudScreenExtent(subjects, zoom);
    }
    // The unit clamp makes the bounds non-linear in zoom: shrink until the measured union really fits.
    for (let guard = 0; guard < 40 && zoom > minZoom && (extent.w > availW + .5 || extent.h > availH + .5); guard++) {
        zoom = Math.max(minZoom, zoom * .985); extent = cloudScreenExtent(subjects, zoom);
    }
    const camera = { x: ((extent.minX + extent.maxX) / 2 - offX) / zoom, y: ((extent.minY + extent.maxY) / 2 - offY) / zoom };
    const groundY = subjects.reduce((sum, subject) => sum + subject.root.y, 0) / subjects.length;
    return { center: unprojectGround(camera.x, groundY, yaw), zoom, lift: groundY - camera.y, camera, extent, availW, availH };
}

/**
 * Where the union of every subject actually lies on screen for a given camera pose (camera.x/y in projected units).
 * `contained` is true when all of it is inside the viewport rectangle (canvas centre = camera). `overflow` is the
 * largest number of pixels any edge sticks out.
 */
export function cloudFitContainment(subjects, pose, viewport, canvas, slack = 0) {
    const extent = cloudScreenExtent(subjects, pose.zoom);
    if (!extent) return { contained: true, overflow: 0, extent: null };
    const left = canvas.w / 2 + extent.minX - pose.x * pose.zoom, right = canvas.w / 2 + extent.maxX - pose.x * pose.zoom;
    const top = canvas.h / 2 + extent.minY - pose.y * pose.zoom, bottom = canvas.h / 2 + extent.maxY - pose.y * pose.zoom;
    const overflow = Math.max(0, viewport.x - left, right - (viewport.x + viewport.w), viewport.y - top, bottom - (viewport.y + viewport.h));
    return { contained: overflow <= slack, overflow, extent: { left, right, top, bottom } };
}

/**
 * Rate-limited pose follower for hand-offs (drone <-> cloud fit). Zoom, centre, lift and yaw each have a speed limit;
 * the caller feeds the result to gardenOrbit.steer, whose critically damped settle makes the motion C1.
 */
export function createPoseFollower({ zoomRate = .45, centerSpeed = 500, liftRate = 260, yawRate = .35 } = {}) {
    let pose = null;
    const limit = (value, target, rate, dt) => value + Math.max(-rate * dt, Math.min(rate * dt, target - value));
    return {
        get active() { return !!pose; },
        get pose() { return pose && { ...pose, center: { ...pose.center } }; },
        reset(from) { pose = from ? { center: { ...from.center }, zoom: from.zoom, lift: from.lift, yaw: from.yaw || 0, yawRate: from.yawRate || 0 } : null; },
        /** Move toward target by at most the rate limits; yaw is held when the target has none. Returns the pose. */
        step(elapsedMs, target, { urgent = false } = {}) {
            if (!pose) return null;
            const dt = Math.min(.1, Math.max(0, (elapsedMs || 0) / 1000));
            const dx = target.center.x - pose.center.x, dy = target.center.y - pose.center.y, distance = Math.hypot(dx, dy);
            // Urgent (a measured cloud left the viewport): zoom out fast and hold the pan back until the zoom has caught up.
            const pan = urgent ? (pose.zoom > target.zoom * 1.02 ? .25 : 2) : 1;
            const travel = Math.min(distance, centerSpeed * pan / Math.max(.05, pose.zoom) * dt);
            if (distance > 1e-9) { pose.center.x += dx / distance * travel; pose.center.y += dy / distance * travel; }
            pose.zoom = Math.exp(limit(Math.log(pose.zoom), Math.log(Math.max(.006, target.zoom)), urgent ? zoomRate * 4 : zoomRate, dt));
            pose.lift = limit(pose.lift, target.lift, liftRate / Math.max(.05, pose.zoom), dt);
            // Heading keeps its current turn rate and eases it out (or toward the target heading): no yaw-rate step.
            if (Number.isFinite(target.yaw)) {
                const error = target.yaw - pose.yaw, wrapped = error - TAU * Math.round(error / TAU), w = .8;
                pose.yawRate += (w * w * wrapped - 2 * w * pose.yawRate) * dt;
            } else pose.yawRate *= Math.exp(-dt / .8);
            pose.yawRate = Math.max(-yawRate, Math.min(yawRate, pose.yawRate));
            pose.yaw += pose.yawRate * dt;
            return { center: { ...pose.center }, zoom: pose.zoom, lift: pose.lift, yaw: pose.yaw, yawRate: pose.yawRate,
                remaining: { yaw: Number.isFinite(target.yaw) ? Math.abs(target.yaw - pose.yaw - TAU * Math.round((target.yaw - pose.yaw) / TAU)) : 0, center: Math.hypot(target.center.x - pose.center.x, target.center.y - pose.center.y),
                    zoom: Math.abs(Math.log(pose.zoom / Math.max(.006, target.zoom))) } };
        },
    };
}

/** Weather-clock targets. Pivot leads on approach; zoom leads on return. */
export function sampleDiveTargets(overview, close, elapsedMs, { speed = 1, crown = 1 } = {}) {
    const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
    let phase = 'Gather', centerProgress = 0, zoomProgress = 0, liftProgress = 0, speedScale = 1;
    if (elapsed < 3000) {
        centerProgress = ease(elapsed / 2600);
        zoomProgress = .06 * ease((elapsed - 2100) / 900);
        liftProgress = .25 * centerProgress;
    } else if (elapsed < 5000) {
        phase = 'Rain'; centerProgress = 1;
        zoomProgress = .06 + .94 * ease((elapsed - 3000) / 1800);
        liftProgress = .25 + .3 * zoomProgress;
    } else if (elapsed < 11000) {
        phase = 'Grow'; centerProgress = zoomProgress = 1;
        liftProgress = .55 + .45 * clamp(crown);
        speedScale = 1 - .4 * ease((elapsed - 5000) / 1200);
    } else if (elapsed < 14000) {
        phase = 'Disperse';
        zoomProgress = 1 - ease((elapsed - 11000) / 1400);
        centerProgress = 1 - ease((elapsed - 12000) / 2000);
        liftProgress = Math.max(zoomProgress, centerProgress);
        speedScale = .6 + .4 * ease((elapsed - 11000) / 2600);
    } else {
        phase = 'Settled'; speedScale = 1;
    }
    const fullDive = speed === 1 || speed === 2;
    if (!fullDive) {
        centerProgress /= 3; zoomProgress = 0; liftProgress = 0; speedScale = 1;
    }
    const zoom = overview.zoom * Math.exp(Math.log(close.zoom / overview.zoom) * clamp(zoomProgress));
    return {
        center: mixPoint(overview.center, close.center, centerProgress),
        zoom, lift: mix(overview.lift || 0, close.lift || 0, liftProgress), speedScale,
        responseScale: fullDive && speed === 2 ? 1.65 : 1,
        phase, centerProgress, zoomProgress, closeProgress: fullDive ? zoomProgress : 0,
        subjectOpacity: 1 - .25 * ease(fullDive ? zoomProgress : 0), done: elapsed >= DIVE_DURATION_MS,
    };
}

/** Reusable 14-second single-tree move with an eight-second close orbit. */
export function sampleShowcaseTargets(overview, close, elapsedMs) {
    const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
    let phase = 'approach', centerProgress = 0, zoomProgress = 0, speedScale = 1;
    if (elapsed < 2000) {
        centerProgress = ease(elapsed / 1800); zoomProgress = .06 * ease((elapsed - 1300) / 700);
    } else if (elapsed < 3000) {
        centerProgress = 1; zoomProgress = .06 + .94 * ease((elapsed - 2000) / 900);
    } else if (elapsed < 3000 + SHOWCASE_HOLD_MS) {
        phase = 'orbit'; centerProgress = zoomProgress = 1; speedScale = .6;
    } else if (elapsed < SHOWCASE_DURATION_MS) {
        phase = 'return';
        zoomProgress = 1 - ease((elapsed - 11000) / 1400);
        centerProgress = 1 - ease((elapsed - 12000) / 2000);
        speedScale = .6 + .4 * ease((elapsed - 11000) / 2600);
    } else phase = 'complete';
    const zoom = overview.zoom * Math.exp(Math.log(close.zoom / overview.zoom) * clamp(zoomProgress));
    return { center: mixPoint(overview.center, close.center, centerProgress), zoom,
        lift: mix(overview.lift || 0, close.lift || 0, Math.max(centerProgress, zoomProgress)),
        speedScale, responseScale: 1, phase, centerProgress, zoomProgress,
        closeProgress: zoomProgress, subjectOpacity: 1 - .25 * ease(zoomProgress),
        done: elapsed >= SHOWCASE_DURATION_MS };
}

export function canShowcaseTree({ exists = false, fullyGrown = false, motion = true,
    reducedMotion = false, hidden = false, interaction = false } = {}) {
    return Boolean(exists && fullyGrown && motion && !reducedMotion && !hidden && !interaction);
}

/** Rotate world coordinates before the isometric projection. Sprites stay upright. */
export function projectGround(x, y, yaw = 0, z = 0) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const rx = x * c - y * s, ry = x * s + y * c;
    return { x: rx - ry, y: (rx + ry) * .43 - z };
}

/** Inverse of projectGround at ground height, shared by hover and click picking. */
export function unprojectGround(x, y, yaw = 0) {
    const rx = (x + y / .43) / 2, ry = (y / .43 - x) / 2;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return { x: rx * c + ry * s, y: -rx * s + ry * c };
}

function between(from, to, t) {
    if (t <= 0) return { ...from };
    if (t >= 1) return { ...to };
    const e = ease(t);
    return { ...from, x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        zoom: Math.exp(Math.log(from.zoom) + Math.log(to.zoom / from.zoom) * e),
        yaw: from.yaw || 0 };
}

export const ROBOT_SHOT_MS = 2380;
export const ROBOT_SHOT_PHASES = Object.freeze([
    ['travel', 420], ['pass-right', 500], ['push', 180], ['hold', 100],
    ['pull', 220], ['pass-left', 500], ['return', 460],
]);

/** A fixed-heading rail move: no orbital path, spring, shake, or overshoot. */
export function sampleRobotShot(from, target, elapsedMs, { railPixels = 64, returnTo = from } = {}) {
    const yaw = from.yaw || 0;
    const center = { ...from, ...target, yaw };
    const rail = Math.max(0, railPixels) / center.zoom;
    const left = { ...center, x: center.x - rail };
    const right = { ...center, x: center.x + rail };
    const close = { ...center, zoom: center.zoom * 1.2 };
    const exit = { ...returnTo, yaw };
    const stops = [from, left, right, close, close, right, left, exit];
    let elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
    for (let i = 0; i < ROBOT_SHOT_PHASES.length; i++) {
        const [phase, duration] = ROBOT_SHOT_PHASES[i];
        if (elapsed < duration) return { camera: between(stops[i], stops[i + 1], elapsed / duration), phase, done: false };
        elapsed -= duration;
    }
    return { camera: exit, phase: 'complete', done: true };
}

/** Begin at the exact current pose, then yaw slowly around its ground-space anchor. */
export function sampleIdleSurvey(base, elapsedMs, { focus = null, framingZoom = base.zoom } = {}) {
    const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
    if (!elapsed) return { ...base };
    // The first three seconds ramp angular velocity from zero. One turn takes ~150 seconds.
    const ramp = 3000, u = Math.min(1, elapsed / ramp);
    const integral = elapsed < ramp ? ramp * (u ** 3 - .5 * u ** 4) : elapsed - ramp / 2;
    const yaw = (base.yaw || 0) + integral / 150000 * TAU;
    const anchor = unprojectGround(base.x, base.y, base.yaw || 0);
    const travel = focus ? ease(elapsed / 9000) : 0;
    const center = projectGround(anchor.x + ((focus?.x ?? anchor.x) - anchor.x) * travel,
        anchor.y + ((focus?.y ?? anchor.y) - anchor.y) * travel, yaw);
    const drift = Math.sin(elapsed / 11000) * ease(elapsed / ramp) * 9 / base.zoom;
    return { ...base, x: center.x + drift, y: center.y,
        zoom: Math.exp(Math.log(base.zoom) + Math.log(framingZoom / base.zoom) * ease(elapsed / 4000)), yaw };
}

/** Every new visible identity receives a shot; baseline imports never replay themselves. */
export function createSpawnShotQueue() {
    let seen = null, pending = [];
    return {
        sync(ids, { animate = true, reset = false } = {}) {
            const next = new Set(ids);
            if (!seen || reset || !animate) pending = [];
            else {
                pending = pending.filter(id => next.has(id));
                pending.push(...[...next].filter(id => !seen.has(id)).sort());
            }
            seen = next;
        },
        take() { return pending.shift() || null; },
        cancel() { pending = []; },
        clear() { seen = null; pending = []; },
        get size() { return pending.length; },
        ids() { return [...pending]; },
    };
}
