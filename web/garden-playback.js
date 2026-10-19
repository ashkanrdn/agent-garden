export const GARDEN_PLAYBACK_SPEEDS = Object.freeze([1, 2, 5, 10]);

/**
 * Elapsed-time playback for the garden history.
 *
 * The controller owns only the historical timeline. Camera and boid clocks
 * can advance independently, while this clock stops whenever playback pauses
 * or the document is hidden.
 */
export function createGardenPlayback({
    maxDay = 0,
    durationMs = 300000,
    holdMs = 1800,
    resetMs = 500,
} = {}) {
    const dayCount = clampInteger(maxDay, 0, Number.MAX_SAFE_INTEGER);
    const traversalMs = finiteDuration(durationMs);
    const latestHoldMs = finiteDuration(holdMs);
    const softResetMs = finiteDuration(resetMs);

    let elapsedMs = 0;
    let playing = false;
    let speed = 1;
    // A direct seek at the latest date must still report traversal. The next
    // elapsed tick enters the configured hold, or the reset when hold is zero.
    let seekedAtTraversalEnd = false;

    const cycleMs = traversalMs + latestHoldMs + softResetMs;
    const postTraversalMs = traversalMs + latestHoldMs;

    function snapshot() {
        const info = phaseAt(elapsedMs, seekedAtTraversalEnd);
        return {
            day: info.day,
            playing,
            phase: info.phase,
            opacity: info.opacity,
        };
    }

    function play(day) {
        if (arguments.length > 0) {
            const target = clampInteger(day, 0, dayCount);
            elapsedMs = dayCount === 0 || traversalMs === 0
                ? 0
                : traversalMs * target / dayCount;
            seekedAtTraversalEnd = target === dayCount;
            playing = true;
            return snapshot();
        }

        // Pressing play on the latest hold starts the next traversal. A seek
        // to the latest date has the same restart behavior, without losing a
        // paused reset's exact position.
        const info = phaseAt(elapsedMs, seekedAtTraversalEnd);
        if (dayCount > 0 && (info.phase === 'hold' ||
            (info.phase === 'traversal' && seekedAtTraversalEnd))) {
            elapsedMs = 0;
            seekedAtTraversalEnd = false;
        }
        playing = true;
        return snapshot();
    }

    function pause() {
        playing = false;
        return snapshot();
    }

    function seek(day) {
        const target = clampInteger(day, 0, dayCount);
        elapsedMs = dayCount === 0 || traversalMs === 0
            ? 0
            : traversalMs * target / dayCount;
        seekedAtTraversalEnd = target === dayCount;
        return snapshot();
    }

    function advance(deltaMs, { hidden = false, reducedMotion = false } = {}) {
        if (!playing || hidden) return snapshot();

        const delta = boundedElapsed(deltaMs) * speed;
        if (dayCount === 0) return snapshot();

        // Reduced motion removes the reset fade and the visual crossfade. The
        // date still changes, so the next traversal begins at day zero.
        if (reducedMotion) {
            seekedAtTraversalEnd = false;
            if (postTraversalMs === 0) {
                elapsedMs = 0;
            } else {
                if (elapsedMs >= postTraversalMs) elapsedMs = 0;
                elapsedMs = (elapsedMs + delta) % postTraversalMs;
            }
            return snapshot();
        }

        seekedAtTraversalEnd = false;
        elapsedMs = cycleMs === 0 ? 0 : (elapsedMs + delta) % cycleMs;
        return snapshot();
    }

    function phaseAt(position, atTraversalEnd = false) {
        if (dayCount === 0) {
            return { day: 0, phase: 'traversal', opacity: 1 };
        }

        if (atTraversalEnd && traversalMs > 0) {
            return { day: dayCount, phase: 'traversal', opacity: 1 };
        }

        if (traversalMs > 0 && position < traversalMs) {
            return {
                // Floating-point division can place an exact seek infinitesimally
                // below its integer boundary on long histories.
                day: Math.min(dayCount, Math.floor(position / traversalMs * dayCount + 1e-9)),
                phase: 'traversal',
                opacity: 1,
            };
        }

        if (latestHoldMs > 0 && position < postTraversalMs) {
            return { day: dayCount, phase: 'hold', opacity: 1 };
        }

        if (softResetMs > 0 && position < cycleMs) {
            const resetElapsed = Math.max(0, position - postTraversalMs);
            const midpoint = softResetMs / 2;
            const opacity = midpoint === 0
                ? 1
                : resetElapsed <= midpoint
                    ? 1 - resetElapsed / midpoint
                    : (resetElapsed - midpoint) / midpoint;
            return {
                day: resetElapsed >= midpoint ? 0 : dayCount,
                phase: 'reset',
                opacity: clamp(opacity, 0, 1),
            };
        }

        // Zero-length phases are resolved at the start of the next traversal.
        return { day: 0, phase: 'traversal', opacity: 1 };
    }

    function setSpeed(value) {
        speed = GARDEN_PLAYBACK_SPEEDS.includes(value) ? value : 1;
        return snapshot();
    }

    return Object.freeze({ play, pause, seek, advance, state: snapshot, setSpeed, getSpeed: () => speed });
}

function finiteDuration(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function boundedElapsed(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, number));
}

function clampInteger(value, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return minimum;
    return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}
