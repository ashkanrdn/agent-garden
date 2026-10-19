const FOCUS_TIMINGS = { approachMs: 1200, holdMs: 3000, returnMs: 1500 };

function duration(value, fallback) {
    return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function cameraBetween(from, to, amount) {
    if (amount <= 0) return { ...from };
    if (amount >= 1) return { ...to };
    return {
        ...from,
        x: from.x + (to.x - from.x) * amount,
        y: from.y + (to.y - from.y) * amount,
        zoom: from.zoom + (to.zoom - from.zoom) * amount,
        auto: false,
    };
}

/** Sample an automatic fit without the pullback arc used by deliberate flights. */
export function sampleAutoFit(from, to, progress = 0) {
    const t = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
    const eased = t * t * (3 - 2 * t);
    return { ...cameraBetween(from, to, eased), auto: to.auto };
}

/**
 * Sample an optional focus gesture without changing either camera.
 * The caller supplies the destination, typically with zoom multiplied by 1.5.
 * Keep the starting camera for the entire gesture. Cancel by keeping the last
 * sample and discarding the gesture; do not sample its return after cancellation.
 * Camera zoom values must be positive. Times are milliseconds.
 */
export function sampleFocusReturn(from, to, elapsedMs = 0, timings = {}) {
    const approach = duration(timings.approachMs, FOCUS_TIMINGS.approachMs);
    const hold = duration(timings.holdMs, FOCUS_TIMINGS.holdMs);
    const returning = duration(timings.returnMs, FOCUS_TIMINGS.returnMs);
    const elapsed = Number.isNaN(elapsedMs) ? 0 : Math.max(0, elapsedMs);
    const destination = { ...from, ...to };

    if (elapsed >= approach + hold + returning) {
        return { camera: { ...from }, phase: 'complete', done: true };
    }
    if (elapsed < approach) {
        const t = elapsed / approach;
        const ease = t * (3 + t * (t - 3));
        return { camera: cameraBetween(from, destination, ease), phase: 'approach', done: false };
    }
    if (elapsed < approach + hold) {
        return { camera: { ...destination }, phase: 'hold', done: false };
    }
    const t = (elapsed - approach - hold) / returning;
    const ease = t * (2 - t);
    return { camera: cameraBetween(destination, from, ease), phase: 'return', done: false };
}

/**
 * A small 36-second overview loop, always sampled from its original camera.
 * Translation stays within 10 by 6 CSS pixels; zoom increases by at most 0.6%.
 * The caller suspends sampling during inspection, input, or reduced motion.
 */
export function sampleOverviewDrift(base, elapsedMs) {
    const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
    const phase = (elapsed % 36000) / 36000 * Math.PI * 2;
    if (phase === 0) return { ...base };
    const zoom = base.zoom * (1 + .003 * (1 - Math.cos(phase)));
    // The startup envelope also makes the initial drift velocity zero.
    const envelope = (1 - Math.cos(phase)) / 2;
    return {
        ...base,
        x: base.x + Math.sin(phase) * envelope * 10 / zoom,
        y: base.y + Math.sin(phase * 2) * envelope * 6 / zoom,
        zoom,
    };
}

/** A fixed-projection, screen-space orbit with a quiet start and no zoom. */
export function sampleIdleOrbit(base, elapsedMs) {
    const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
    const phase = elapsed % 48000 / 48000 * Math.PI * 2;
    const envelope = Math.min(1, elapsed / 3000);
    const eased = envelope * envelope * (3 - 2 * envelope);
    return {
        ...base,
        x: base.x + Math.sin(phase) * 12 * eased / base.zoom,
        y: base.y + (1 - Math.cos(phase)) * 4 * eased / base.zoom,
    };
}

/** A single soft glance. Offset and zoom return exactly to the current fit. */
export function sampleArrivalGlance(base, offset, elapsedMs) {
    const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
    const progress = Math.min(1, elapsed / 2400);
    const pulse = Math.sin(Math.PI * progress) ** 2;
    const x = Math.max(-40, Math.min(40, offset.x));
    const y = Math.max(-40, Math.min(40, offset.y));
    return {
        camera: { ...base, x: base.x + x * pulse / base.zoom,
            y: base.y + y * pulse / base.zoom, zoom: base.zoom * (1 + .016 * pulse) },
        phase: progress === 1 ? 'complete' : progress < .5 ? 'approach' : 'return',
        done: progress === 1,
    };
}
