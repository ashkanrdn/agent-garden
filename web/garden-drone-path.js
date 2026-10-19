// Idle "drone" camera: a seeded, closed, C1-smooth flight path that threads the gaps between trees and a director that
// flies it at constant screen speed with eased turns, look-ahead heading and gentle altitude bobbing.
// Pure module (no imports, no DOM): the caller supplies tree records and the island outline in world units.
const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = value => Number.isFinite(value);

export const DRONE_SETTINGS = Object.freeze({
    speedPx: 95,          // screen pixels per second along the path (slower through turns)
    fill: .35,            // typical nearby tree height as a share of the viewport height
    maxFill: .55,         // no tree may be framed taller than this
    minZoom: .3, maxZoom: 3,
    zoomRate: .04,        // largest |d ln(zoom)/dt|: keeps vector trees crisp (see specimenMoving)
    yawRate: .2,          // largest heading turn rate (rad/s)
    yawResponse: .8,      // critically damped heading response (rad/s)
    lookAhead: 520,       // heading looks this far along the path (world units)
    bobPeriodMs: 9000, bobAmount: .028,
    clearanceScale: 1.2, clearancePad: 20,
});

function seeded(seed) {
    let h = 2166136261;
    for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return () => {
        h = (h + 0x6D2B79F5) | 0; let t = Math.imul(h ^ h >>> 15, 1 | h);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function pointInPolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j];
        if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

/** Nearest point on the polygon boundary. */
function boundaryNearest(x, y, polygon) {
    let best = { d: Infinity, x, y };
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[j], b = polygon[i], dx = b.x - a.x, dy = b.y - a.y;
        const t = clamp(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
        const qx = a.x + dx * t, qy = a.y + dy * t, d = Math.hypot(x - qx, y - qy);
        if (d < best.d) best = { d, x: qx, y: qy };
    }
    return best;
}

/** Centripetal Catmull-Rom (Barry-Goldman). Continuous in position and tangent, no cusps or loops. */
function centripetal(p0, p1, p2, p3, u) {
    const knot = (a, b) => Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)) + 1e-6;
    const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3), t = t1 + (t2 - t1) * u;
    const lerp = (a, b, ta, tb) => ({ x: (a.x * (tb - t) + b.x * (t - ta)) / (tb - ta), y: (a.y * (tb - t) + b.y * (t - ta)) / (tb - ta) });
    const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
    const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
    return lerp(b1, b2, t1, t2);
}

function closedSpline(points, perSegment) {
    const n = points.length, out = [];
    for (let i = 0; i < n; i++) {
        const p0 = points[(i + n - 1) % n], p1 = points[i], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n];
        for (let k = 0; k < perSegment; k++) out.push(centripetal(p0, p1, p2, p3, k / perSegment));
    }
    return out;
}

/** Equal arc-length resample of a closed polyline. */
function resampleClosed(polyline, step) {
    const n = polyline.length, cumulative = [0];
    for (let i = 0; i < n; i++) {
        const a = polyline[i], b = polyline[(i + 1) % n];
        cumulative.push(cumulative[i] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    const length = cumulative[n], count = Math.max(8, Math.round(length / step)), out = [];
    let segment = 0;
    for (let k = 0; k < count; k++) {
        const target = length * k / count;
        while (segment < n - 1 && cumulative[segment + 1] < target) segment++;
        const a = polyline[segment], b = polyline[(segment + 1) % n];
        const span = cumulative[segment + 1] - cumulative[segment] || 1, u = (target - cumulative[segment]) / span;
        out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
    }
    return { points: out, length };
}

function blurCircular(values, radius, passes = 2, reducer = null) {
    const n = values.length;
    let current = Float64Array.from(values);
    for (let pass = 0; pass < passes; pass++) {
        const next = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            if (reducer) { let m = -Infinity; for (let k = -radius; k <= radius; k++) m = Math.max(m, current[(i + k + n * 8) % n]); next[i] = m; continue; }
            let sum = 0;
            for (let k = -radius; k <= radius; k++) sum += current[(i + k + n * 8) % n];
            next[i] = sum / (radius * 2 + 1);
        }
        current = next;
    }
    return current;
}

function wrapAngle(angle) { return angle - TAU * Math.round(angle / TAU); }

/**
 * Build a closed flight path.
 * trees: [{ id, x, y, radius (ground canopy radius), height (screen px at zoom 1) }], outline: island polygon.
 * The result is deterministic for a given seed and input.
 */
export function buildDronePath({ trees = [], outline = [], seed = 'garden-drone', groundHeight = () => 0,
    clearanceScale = DRONE_SETTINGS.clearanceScale, clearancePad = DRONE_SETTINGS.clearancePad, spacing = 12 } = {}) {
    const rand = seeded(seed);
    const list = trees.filter(t => t && finite(t.x) && finite(t.y)).map(t => ({
        id: t.id, x: t.x, y: t.y, radius: Math.max(8, Number(t.radius) || 40), height: Math.max(20, Number(t.height) || 200),
    }));
    for (const tree of list) tree.req = tree.radius * clearanceScale + clearancePad;
    const maxReq = Math.max(60, ...list.map(t => t.req));

    // World extent: the island outline, or a box around the trees when the outline is unknown.
    let polygon = (outline || []).filter(p => finite(p?.x) && finite(p?.y));
    if (polygon.length < 3) {
        const xs = list.map(t => t.x), ys = list.map(t => t.y), pad = maxReq * 4;
        const x0 = list.length ? Math.min(...xs) - pad : -800, x1 = list.length ? Math.max(...xs) + pad : 800;
        const y0 = list.length ? Math.min(...ys) - pad : -600, y1 = list.length ? Math.max(...ys) + pad : 600;
        polygon = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    }
    const left = Math.min(...polygon.map(p => p.x)), right = Math.max(...polygon.map(p => p.x));
    const top = Math.min(...polygon.map(p => p.y)), bottom = Math.max(...polygon.map(p => p.y));
    const centroid = { x: polygon.reduce((s, p) => s + p.x, 0) / polygon.length, y: polygon.reduce((s, p) => s + p.y, 0) / polygon.length };
    const extent = Math.max(right - left, bottom - top);
    const edgeMargin = Math.min(maxReq * 1.2, extent * .12);

    // Spatial hash so clearance queries stay cheap while the loop is relaxed.
    const cell = maxReq, grid = new Map();
    const key = (ix, iy) => (ix + 65536) * 131072 + (iy + 65536);
    for (const tree of list) {
        const k = key(Math.floor(tree.x / cell), Math.floor(tree.y / cell));
        (grid.get(k) || grid.set(k, []).get(k)).push(tree);
    }
    const nearby = (x, y, visit) => {
        const ix = Math.floor(x / cell), iy = Math.floor(y / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const bucket = grid.get(key(ix + dx, iy + dy));
            if (bucket) for (const tree of bucket) visit(tree);
        }
    };
    const repelTrees = (point, boost = 1) => {
        for (let pass = 0; pass < 4; pass++) {
            let moved = false;
            nearby(point.x, point.y, tree => {
                let dx = point.x - tree.x, dy = point.y - tree.y, d = Math.hypot(dx, dy);
                if (d >= tree.req) return;
                if (d < 1e-6) { const a = rand() * TAU; dx = Math.cos(a); dy = Math.sin(a); d = 1; }
                point.x = tree.x + dx / d * tree.req * 1.003 * boost; point.y = tree.y + dy / d * tree.req * 1.003 * boost; moved = true;
            });
            if (!moved) break;
        }
    };
    const keepOnIsland = point => {
        const inside = pointInPolygon(point.x, point.y, polygon), edge = boundaryNearest(point.x, point.y, polygon);
        if (inside && edge.d >= edgeMargin) return;
        let dx = inside ? point.x - edge.x : edge.x - point.x, dy = inside ? point.y - edge.y : edge.y - point.y;
        const d = Math.hypot(dx, dy) || 1;
        point.x = edge.x + dx / d * edgeMargin; point.y = edge.y + dy / d * edgeMargin;
    };
    const slackAt = (x, y) => {
        let slack = Infinity;
        nearby(x, y, tree => { slack = Math.min(slack, Math.hypot(x - tree.x, y - tree.y) - tree.req); });
        return slack;
    };
    const usable = (x, y) => pointInPolygon(x, y, polygon) && boundaryNearest(x, y, polygon).d >= edgeMargin && slackAt(x, y) >= 0;

    // Candidate waypoints sit in the open space between trees: midpoints of neighbouring pairs, plus one pass close beside each tree.
    const candidates = [];
    for (let i = 0; i < list.length; i++) {
        const a = list[i], near = [];
        for (let j = 0; j < list.length; j++) if (j !== i) {
            const d = Math.hypot(list[j].x - a.x, list[j].y - a.y);
            if (near.length < 3 || d < near[near.length - 1].d) { near.push({ j, d }); near.sort((p, q) => p.d - q.d); if (near.length > 3) near.pop(); }
        }
        for (const { j } of near) {
            const b = list[j], x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
            if (usable(x, y)) candidates.push({ x, y });
        }
        const angle = rand() * TAU, distance = a.req * 1.4, x = a.x + Math.cos(angle) * distance, y = a.y + Math.sin(angle) * distance;
        if (usable(x, y)) candidates.push({ x, y });
    }
    if (candidates.length < 6) {
        const step = Math.max(maxReq * 2, extent / 8);
        for (let x = left + step / 2; x < right; x += step) for (let y = top + step / 2; y < bottom; y += step) if (usable(x, y)) candidates.push({ x, y });
    }

    // Spread waypoints across the island with seeded farthest-point sampling, then order them into a crossing-free tour.
    const wanted = clamp(Math.round(Math.sqrt(list.length) * 2.2), 8, 36);
    let waypoints = [];
    if (candidates.length >= 3) {
        const distances = new Float64Array(candidates.length).fill(Infinity);
        let next = Math.floor(rand() * candidates.length);
        while (waypoints.length < Math.min(wanted, candidates.length)) {
            const chosen = candidates[next]; waypoints.push({ x: chosen.x, y: chosen.y });
            let best = -1, bestDistance = -1;
            for (let i = 0; i < candidates.length; i++) {
                distances[i] = Math.min(distances[i], Math.hypot(candidates[i].x - chosen.x, candidates[i].y - chosen.y));
                if (distances[i] > bestDistance + rand() * 1e-3) { best = i; bestDistance = distances[i]; }
            }
            if (bestDistance <= 0 || best < 0) break;
            next = best;
        }
    }
    if (waypoints.length < 3) {
        const radius = Math.max(maxReq, extent * .3);
        waypoints = Array.from({ length: 12 }, (_, i) => ({ x: centroid.x + Math.cos(i / 12 * TAU) * radius, y: centroid.y + Math.sin(i / 12 * TAU) * radius * .75 }));
    }
    const tourLength = order => order.reduce((sum, p, i) => sum + Math.hypot(p.x - order[(i + 1) % order.length].x, p.y - order[(i + 1) % order.length].y), 0);
    const remaining = waypoints.slice(1), tour = [waypoints[0]];
    while (remaining.length) {
        const last = tour[tour.length - 1];
        let best = 0; for (let i = 1; i < remaining.length; i++) if (Math.hypot(remaining[i].x - last.x, remaining[i].y - last.y) < Math.hypot(remaining[best].x - last.x, remaining[best].y - last.y)) best = i;
        tour.push(remaining.splice(best, 1)[0]);
    }
    for (let improved = true, guard = 0; improved && guard < 60; guard++) {
        improved = false;
        for (let i = 1; i < tour.length - 1; i++) for (let k = i + 1; k < tour.length; k++) {
            const candidate = tour.slice(0, i).concat(tour.slice(i, k + 1).reverse(), tour.slice(k + 1));
            if (tourLength(candidate) < tourLength(tour) - 1e-6) { tour.splice(0, tour.length, ...candidate); improved = true; }
        }
    }

    // Route each leg of the tour through free space with A* on a coarse grid, so the loop starts on the correct side of
    // every canopy and coastline; the relaxation below then only has to polish it.
    function routeThroughGaps(waypointsInOrder) {
        const size = Math.max(36, extent / 90), cols = Math.ceil((right - left) / size) + 1, rows = Math.ceil((bottom - top) / size) + 1;
        const free = new Uint8Array(cols * rows), slackGrid = new Float32Array(cols * rows);
        const cx = i => left + (i % cols) * size, cy = i => top + Math.floor(i / cols) * size;
        for (let i = 0; i < free.length; i++) {
            const x = cx(i), y = cy(i), slack = slackAt(x, y);
            slackGrid[i] = slack;
            free[i] = slack >= 12 && pointInPolygon(x, y, polygon) && boundaryNearest(x, y, polygon).d >= edgeMargin * .4 ? 1 : 0;
        }
        const cellOf = (x, y) => clamp(Math.round((y - top) / size), 0, rows - 1) * cols + clamp(Math.round((x - left) / size), 0, cols - 1);
        const snap = (x, y) => {
            const start = cellOf(x, y);
            if (free[start]) return start;
            let best = -1, bestDistance = Infinity;
            for (let i = 0; i < free.length; i++) if (free[i]) { const d = (cx(i) - x) ** 2 + (cy(i) - y) ** 2; if (d < bestDistance) { bestDistance = d; best = i; } }
            return best;
        };
        const lineFree = (a, b) => {
            const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (size * .5)));
            for (let k = 0; k <= steps; k++) if (!free[cellOf(a.x + (b.x - a.x) * k / steps, a.y + (b.y - a.y) * k / steps)]) return false;
            return true;
        };
        const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
        const leg = (from, to) => {
            const a = snap(from.x, from.y), b = snap(to.x, to.y);
            if (a < 0 || b < 0 || a === b) return [];
            const cost = new Float32Array(free.length).fill(Infinity), parent = new Int32Array(free.length).fill(-1), heap = [];
            const push = (node, priority) => { heap.push([priority, node]); let i = heap.length - 1; while (i > 0) { const up = (i - 1) >> 1; if (heap[up][0] <= heap[i][0]) break; [heap[up], heap[i]] = [heap[i], heap[up]]; i = up; } };
            const pop = () => { const top0 = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top0[1]; };
            cost[a] = 0; push(a, 0);
            while (heap.length) {
                const node = pop();
                if (node === b) break;
                const nx = node % cols, ny = (node - nx) / cols;
                for (const [dx, dy] of neighbours) {
                    const mx = nx + dx, my = ny + dy;
                    if (mx < 0 || my < 0 || mx >= cols || my >= rows) continue;
                    const next = my * cols + mx;
                    if (!free[next] || (dx && dy && (!free[ny * cols + mx] || !free[my * cols + nx]))) continue;
                    const comfort = 1 + Math.max(0, (60 - slackGrid[next]) / 60) * .8;
                    const total = cost[node] + (dx && dy ? 1.4142 : 1) * comfort;
                    if (total < cost[next]) { cost[next] = total; parent[next] = node; push(next, total + Math.hypot(mx - b % cols, my - Math.floor(b / cols))); }
                }
            }
            if (parent[b] < 0) return [];
            const cells = []; for (let node = b; node >= 0 && node !== a; node = parent[node]) cells.push(node); cells.push(a);
            return cells.reverse().map(i => ({ x: cx(i), y: cy(i) }));
        };
        const raw = [];
        for (let i = 0; i < waypointsInOrder.length; i++) {
            const from = waypointsInOrder[i], to = waypointsInOrder[(i + 1) % waypointsInOrder.length];
            raw.push({ x: from.x, y: from.y }, ...leg(from, to));
        }
        // String-pull: drop vertices that a straight, free line can skip, keeping the route short but on the right side.
        const pulled = []; let at = 0;
        while (at < raw.length) {
            let far = at + 1;
            for (let k = Math.min(raw.length - 1, at + 40); k > at + 1; k--) if (lineFree(raw[at], raw[k])) { far = k; break; }
            pulled.push(raw[at]); at = far;
        }
        // A waypoint at the end of a dead-end pocket would make the drone reverse: skip vertices that turn back on themselves.
        for (let pass = 0; pass < 6; pass++) {
            let removed = false;
            for (let i = 0; i < pulled.length && pulled.length > 6; i++) {
                const a = pulled[(i + pulled.length - 1) % pulled.length], b = pulled[i], c = pulled[(i + 1) % pulled.length];
                const turn = Math.abs(wrapAngle(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x)));
                if (turn > 1.9 && lineFree(a, c)) { pulled.splice(i, 1); removed = true; i--; }
            }
            if (!removed) break;
        }
        const clean = pulled.filter((p, i) => Math.hypot(p.x - pulled[(i + pulled.length - 1) % pulled.length].x, p.y - pulled[(i + pulled.length - 1) % pulled.length].y) > 1);
        return clean.length >= 4 ? clean : waypointsInOrder;
    }

    // Relax the spline: smooth the loop, then push it out of canopies and off the coast; repeat until it settles.
    const route = routeThroughGaps(tour);
    let loop = resampleClosed(closedSpline(route, 8), 32).points;
    for (let iteration = 0; iteration < 30; iteration++) {
        const n = loop.length, smoothed = loop.map((p, i) => {
            const a = loop[(i + n - 1) % n], b = loop[(i + 1) % n];
            return { x: p.x * .5 + (a.x + b.x) * .25, y: p.y * .5 + (a.y + b.y) * .25 };
        });
        for (const p of smoothed) { keepOnIsland(p); repelTrees(p); }
        loop = iteration % 6 === 5 ? resampleClosed(smoothed, 32).points : smoothed;
    }
    for (const p of loop) { keepOnIsland(p); repelTrees(p, 1.03); }

    // Final C1 curve through the relaxed loop's points (32 units apart, so bulges between them stay well inside the margin).
    // Any stretch that still dips into a canopy pushes its two nearest control points out a little more.
    const controls = loop.map(p => ({ x: p.x, y: p.y }));
    let dense = [], resampled = null;
    for (let attempt = 0; attempt < 12; attempt++) {
        resampled = resampleClosed(closedSpline(controls, 6), spacing); dense = resampled.points;
        let violated = false;
        for (const sample of dense) {
            if (slackAt(sample.x, sample.y) >= -4) continue;
            violated = true;
            const ranked = controls.map((c, i) => ({ i, d: Math.hypot(c.x - sample.x, c.y - sample.y) })).sort((p, q) => p.d - q.d).slice(0, 2);
            for (const { i } of ranked) repelTrees(controls[i], 1.02 + .02 * attempt);
        }
        if (!violated) break;
    }
    // Round off any remaining corner (a pocket the router doubled back through) where that keeps clear of the trees.
    for (let round = 0; round < 3; round++) {
        const n = dense.length, sharp = new Uint8Array(n);
        let any = false;
        for (let i = 0; i < n; i++) {
            const a = dense[(i + n - 1) % n], b = dense[i], c = dense[(i + 1) % n];
            if (Math.abs(wrapAngle(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x))) > .22) { any = true; for (let k = -24; k <= 24; k++) sharp[(i + k + n) % n] = 1; }
        }
        if (!any) break;
        for (let pass = 0; pass < 80; pass++) {
            const next = dense.map((p, i) => {
                if (!sharp[i]) return p;
                const a = dense[(i + n - 1) % n], c = dense[(i + 1) % n], q = { x: p.x * .5 + (a.x + c.x) * .25, y: p.y * .5 + (a.y + c.y) * .25 };
                return slackAt(q.x, q.y) >= -4 && pointInPolygon(q.x, q.y, polygon) ? q : p;
            });
            dense = next;
        }
        resampled = resampleClosed(dense, spacing); dense = resampled.points;
    }
    const count = dense.length, length = resampled.length, step = length / count;
    const px = Float64Array.from(dense, p => p.x), py = Float64Array.from(dense, p => p.y);

    // Heading, curvature, ground height and the tree size seen from each sample.
    const heading = new Float64Array(count);
    for (let i = 0; i < count; i++) heading[i] = Math.atan2(py[(i + 1) % count] - py[(i + count - 1) % count], px[(i + 1) % count] - px[(i + count - 1) % count]);
    const turn = new Float64Array(count);
    for (let i = 0; i < count; i++) turn[i] = Math.abs(wrapAngle(heading[(i + 1) % count] - heading[(i + count - 1) % count])) / (2 * step);
    const curvature = blurCircular(turn, Math.max(2, Math.round(200 / step)), 2);
    const z = blurCircular(Float64Array.from(dense, p => Number(groundHeight(p.x, p.y)) || 0), Math.max(2, Math.round(160 / step)), 2);
    const logSize = new Float64Array(count), logMax = new Float64Array(count), nearest = new Float64Array(count);
    const medianHeight = list.length ? list.map(t => t.height).sort((a, b) => a - b)[list.length >> 1] : 220;
    for (let i = 0; i < count; i++) {
        const best = []; let tallest = 0, nearestDistance = Infinity;
        for (const tree of list) {
            const d = Math.hypot(tree.x - px[i], tree.y - py[i]);
            if (d < nearestDistance) nearestDistance = d;
            if (d < 300 && tree.height > tallest) tallest = tree.height;
            if (best.length < 3 || d < best[best.length - 1].d) {
                let at = best.length; while (at > 0 && best[at - 1].d > d) at--;
                best.splice(at, 0, { d, h: tree.height }); if (best.length > 3) best.pop();
            }
        }
        let weight = 0, sum = 0; for (const b of best) { const w = 1 / (b.d + 80); weight += w; sum += w * Math.log(b.h); }
        logSize[i] = weight ? sum / weight : Math.log(medianHeight);
        logMax[i] = Math.log(Math.max(tallest, best[0]?.h || medianHeight));
        nearest[i] = nearestDistance;
    }
    const window = Math.max(3, Math.round(1200 / step / 2));
    const size = blurCircular(logSize, window, 2).map(Math.exp);
    const maxNear = blurCircular(blurCircular(logMax, Math.round(window / 2), 1, true), Math.round(window / 2), 1).map(Math.exp);

    let minSlack = Infinity; for (let i = 0; i < count; i++) minSlack = Math.min(minSlack, slackAt(px[i], py[i]));
    let minGap = Infinity;
    for (let i = 0; i < count; i++) for (const tree of list) minGap = Math.min(minGap, Math.hypot(tree.x - px[i], tree.y - py[i]) - tree.radius);

    const wrap = s => ((s % length) + length) % length;
    const path = {
        closed: true, length, spacing: step, count, x: px, y: py, z, size, maxNear, curvature, nearest, heading,
        trees: list, waypoints: tour, outline: polygon, minSlack, minCanopyGap: minGap, seed,
        at(s) {
            const f = wrap(s) / step, i = Math.floor(f) % count, j = (i + 1) % count, u = f - Math.floor(f);
            const tx = px[j] - px[i], ty = py[j] - py[i], d = Math.hypot(tx, ty) || 1;
            return { x: px[i] + tx * u, y: py[i] + ty * u, z: z[i] + (z[j] - z[i]) * u, tx: tx / d, ty: ty / d,
                size: size[i] + (size[j] - size[i]) * u, maxNear: maxNear[i] + (maxNear[j] - maxNear[i]) * u,
                curvature: curvature[i] + (curvature[j] - curvature[i]) * u, s: wrap(s) };
        },
        nearest(x, y) {
            let best = 0, bestDistance = Infinity;
            for (let i = 0; i < count; i++) { const d = (px[i] - x) ** 2 + (py[i] - y) ** 2; if (d < bestDistance) { bestDistance = d; best = i; } }
            return best * step;
        },
        wrap,
    };
    return path;
}

/** Yaw that turns a world-space heading vector toward the top of the screen in the garden's isometric projection. */
export function yawForHeading(dx, dy) { return -3 * Math.PI / 4 - Math.atan2(dy, dx); }

/**
 * The drone director. Holds the position along the path (s), a speed that eases through turns, a heading that
 * follows the path ahead with rate-limited critically damped yaw, and a zoom that is rate limited so the scene
 * never counts as "moving" for specimen sharpness.
 */
export function createGardenDrone(settings = {}) {
    const cfg = { ...DRONE_SETTINGS, ...settings };
    let path = null, s = 0, speed = 0, yaw = 0, yawRate = 0, logZoom = 0, clock = 0, lastPosition = null;
    const targetZoom = (sample, viewHeight) => {
        const wanted = cfg.fill * viewHeight / Math.max(20, sample.size), cap = cfg.maxFill * viewHeight / Math.max(20, sample.maxNear);
        return clamp(Math.min(wanted, cap), cfg.minZoom, cfg.maxZoom);
    };
    return {
        get path() { return path; },
        get ready() { return !!path; },
        get s() { return s; },
        get speed() { return speed; },
        get yaw() { return yaw; },
        get position() { return lastPosition && { ...lastPosition }; },
        /** Replace the path, keeping the drone where it is: it rejoins the nearest point of the new loop. */
        setPath(next, viewHeight = 800) {
            const here = lastPosition;
            path = next && next.count ? next : null;
            if (path) {
                if (here) s = path.nearest(here.x, here.y);
                else s = 0;
                logZoom = Math.log(targetZoom(path.at(s), viewHeight));
            }
        },
        /** Join the path at the point nearest to the camera's ground anchor, easing in from rest. */
        resume({ x, y, yaw: cameraYaw = 0, yawRate: cameraYawRate = 0 } = {}, viewHeight = 800) {
            if (!path) return;
            s = path.nearest(x, y); speed = 0; yaw = cameraYaw; yawRate = cameraYawRate;
            logZoom = Math.log(targetZoom(path.at(s), viewHeight));
        },
        /** Take over the camera's heading exactly (used when a hand-off releases the drone): no yaw jump. */
        adoptHeading(nextYaw, nextYawRate = 0) { yaw = nextYaw; yawRate = clamp(nextYawRate, -cfg.yawRate, cfg.yawRate); },
        step(elapsedMs, { viewHeight = 800, viewportOffsetY = 0, speedScale = 1 } = {}) {
            if (!path) return null;
            const dt = clamp((elapsedMs || 0) / 1000, 0, .1);
            clock += dt;
            const here = path.at(s);
            // Zoom target follows the trees along the path; the rate cap keeps vector trees crisp.
            const desired = Math.log(targetZoom(here, viewHeight));
            logZoom += clamp(desired - logZoom, -cfg.zoomRate * dt, cfg.zoomRate * dt);
            const zoom = Math.exp(logZoom);
            // Constant screen speed, slowed through tight turns; speed itself eases so starts and turns are soft.
            const turnEase = 1 / (1 + here.curvature * 350), goal = cfg.speedPx / zoom * clamp(turnEase, .5, 1) * Math.max(0, speedScale);
            speed += (goal - speed) * (1 - Math.exp(-dt / 1.4));
            s = path.wrap(s + speed * dt);
            const p = path.at(s), look = path.at(s + cfg.lookAhead);
            // Heading follows the path ahead with rate-limited critically damped yaw (no snap, no whip on resume).
            let desiredYaw = yawForHeading(look.x - p.x, look.y - p.y);
            desiredYaw = yaw + wrapAngle(desiredYaw - yaw);
            const w = cfg.yawResponse, acceleration = w * w * (desiredYaw - yaw) - 2 * w * yawRate;
            yawRate = clamp(yawRate + acceleration * dt, -cfg.yawRate, cfg.yawRate);
            yaw += yawRate * dt;
            // Focus a little ahead of the drone so oncoming trees fill the upper frame; it stays on the path.
            const ahead = path.at(s + .12 * viewHeight / zoom);
            const bob = Math.sin(clock * 1000 / cfg.bobPeriodMs * TAU) * cfg.bobAmount * p.size;
            lastPosition = { x: p.x, y: p.y };
            return {
                center: { x: ahead.x, y: ahead.y }, position: { x: p.x, y: p.y }, zoom,
                lift: p.z + .2 * p.size + bob + viewportOffsetY / zoom,
                yaw, yawRate, s, speed, nearTree: p.size,
            };
        },
    };
}
