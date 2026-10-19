/** Seeded blue-noise planting within a simple (convex or concave) project cell. No session is omitted. */
function rngFor(key) {
    let h = 2166136261;
    for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return () => {
        h += 0x6D2B79F5;
        let t = Math.imul(h ^ (h >>> 15), h | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function signedArea(polygon) {
    return polygon.reduce((sum, p, i) => {
        const q = polygon[(i + 1) % polygon.length];
        return sum + p.x * q.y - q.x * p.y;
    }, 0) / 2;
}

export function pointInPolygon(point, polygon, epsilon = 1e-7) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[j], b = polygon[i];
        const dx = b.x - a.x, dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        if (length > 0) {
            const cross = (point.x - a.x) * dy - (point.y - a.y) * dx;
            const along = (point.x - a.x) * dx + (point.y - a.y) * dy;
            if (Math.abs(cross) <= epsilon * length && along >= -epsilon && along <= length * length + epsilon) return true;
        }
        if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

function cross3(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }

/** True when every turn has the same sense (collinear vertices allowed). */
export function isConvexPolygon(polygon) {
    const sign = Math.sign(signedArea(polygon));
    if (!sign) return false;
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length], c = polygon[(i + 2) % polygon.length];
        if (sign * cross3(a, b, c) < -1e-9 * Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y)) return false;
    }
    return true;
}

function segmentDistance(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
    const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
    return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

/** Distance from a point to the nearest polygon edge. */
export function boundaryDistance(point, polygon) {
    let best = Infinity;
    for (let i = 0; i < polygon.length; i++) best = Math.min(best, segmentDistance(point, polygon[i], polygon[(i + 1) % polygon.length]));
    return best;
}

function segmentsCross(a, b, c, d) {
    const d1 = cross3(a, b, c), d2 = cross3(a, b, d), d3 = cross3(c, d, a), d4 = cross3(c, d, b);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

/** Ear clipping for any simple polygon and either winding. Returns triangles of original vertices. */
export function triangulatePolygon(polygon) {
    const n = polygon.length, sign = signedArea(polygon) < 0 ? -1 : 1;
    const ring = Array.from({ length: n }, (_, i) => sign > 0 ? i : n - 1 - i), triangles = [];
    // The ring is always counterclockwise here, so every ear turn is positive.
    const inside = (p, a, b, c) => cross3(a, b, p) >= -1e-12 && cross3(b, c, p) >= -1e-12 && cross3(c, a, p) >= -1e-12;
    const same = (p, q) => p.x === q.x && p.y === q.y;
    let guard = n * n + 8;
    while (ring.length > 3 && guard-- > 0) {
        let clipped = false;
        for (let k = 0; k < ring.length && !clipped; k++) {
            const ia = ring[(k + ring.length - 1) % ring.length], ib = ring[k], ic = ring[(k + 1) % ring.length];
            const a = polygon[ia], b = polygon[ib], c = polygon[ic], turn = cross3(a, b, c);
            if (turn <= 1e-12) continue;
            if (ring.some(j => j !== ia && j !== ib && j !== ic && !same(polygon[j], a) && !same(polygon[j], b) && !same(polygon[j], c) && inside(polygon[j], a, b, c))) continue;
            triangles.push([ia, ib, ic]); ring.splice(k, 1); clipped = true;
        }
        if (!clipped) {
            // Collinear or touching vertices: drop the flattest vertex and continue.
            let flattest = 0, least = Infinity;
            for (let k = 0; k < ring.length; k++) {
                const t = Math.abs(cross3(polygon[ring[(k + ring.length - 1) % ring.length]], polygon[ring[k]], polygon[ring[(k + 1) % ring.length]]));
                if (t < least) { least = t; flattest = k; }
            }
            ring.splice(flattest, 1);
        }
    }
    if (ring.length === 3 && Math.abs(cross3(polygon[ring[0]], polygon[ring[1]], polygon[ring[2]])) > 1e-12) triangles.push([...ring]);
    return triangles;
}

/** Inward miter offset, or null when it collapses, self-intersects, or leaves the polygon. */
function offsetSimplePolygon(polygon, distance) {
    const clean = polygon.filter((p, i) => { const q = polygon[(i + polygon.length - 1) % polygon.length]; return p.x !== q.x || p.y !== q.y; });
    const n = clean.length, sign = signedArea(clean) < 0 ? -1 : 1;
    if (n < 3) return null;
    const normals = clean.map((a, i) => {
        const b = clean[(i + 1) % n], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
        return { x: -sign * dy / length, y: sign * dx / length };
    });
    const result = clean.map((v, i) => {
        const n0 = normals[(i + n - 1) % n], n1 = normals[i], denominator = 1 + n0.x * n1.x + n0.y * n1.y;
        if (denominator < 1e-6) return null;
        return { x: v.x + (n0.x + n1.x) * distance / denominator, y: v.y + (n0.y + n1.y) * distance / denominator };
    });
    if (result.some(p => !p)) return null;
    if (Math.sign(signedArea(result)) !== sign) return null;
    const floor = distance * (1 - 1e-6);
    for (let i = 0; i < n; i++) {
        const a = clean[i], b = clean[(i + 1) % n], p = result[i], q = result[(i + 1) % n];
        if ((q.x - p.x) * (b.x - a.x) + (q.y - p.y) * (b.y - a.y) <= 0) return null;
        if (boundaryDistance(p, clean) < floor || boundaryDistance(a, result) < floor) return null;
        for (let j = 0; j < n; j++) {
            const c = clean[j], d = clean[(j + 1) % n];
            if (segmentsCross(p, q, c, d)) return null;
            if (j > i + 1 && !(i === 0 && j === n - 1) && segmentsCross(p, q, result[j], result[(j + 1) % n])) return null;
        }
    }
    return pointInPolygon(result[0], clean) ? result : null;
}

/** Inward offset. Convex cells clip by each edge; concave cells use a validated miter offset that halves on failure. */
export function insetPolygon(polygon, distance) {
    if (!distance) return polygon.map(p => ({ ...p }));
    if (!isConvexPolygon(polygon)) {
        for (let d = distance, attempt = 0; attempt < 8; attempt++, d /= 2) {
            const offset = offsetSimplePolygon(polygon, d);
            if (offset) return offset;
        }
        return polygon.map(p => ({ ...p }));
    }
    const sign = signedArea(polygon) < 0 ? -1 : 1;
    let result = polygon.map(p => ({ ...p }));
    for (let i = 0; i < polygon.length && result.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
        if (!length) continue;
        const depth = p => sign * (dx * (p.y - a.y) - dy * (p.x - a.x)) / length - distance;
        const clipped = [];
        for (let j = 0; j < result.length; j++) {
            const p = result[j], q = result[(j + 1) % result.length], dp = depth(p), dq = depth(q);
            if (dp >= 0) clipped.push(p);
            if ((dp >= 0) !== (dq >= 0)) {
                const t = dp / (dp - dq);
                clipped.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
            }
        }
        result = clipped;
    }
    return result;
}

/** Deepest interior point (coarse pole of inaccessibility) of a simple polygon. */
export function interiorPoint(polygon) {
    const box = boundsOf(polygon);
    let best = null, depth = -1;
    const consider = p => {
        if (!pointInPolygon(p, polygon)) return;
        const d = boundaryDistance(p, polygon);
        if (d > depth) { depth = d; best = p; }
    };
    for (const [a, b, c] of triangulatePolygon(polygon)) consider({ x: (polygon[a].x + polygon[b].x + polygon[c].x) / 3, y: (polygon[a].y + polygon[b].y + polygon[c].y) / 3 });
    const steps = 16;
    for (let i = 0; i < steps; i++) for (let j = 0; j < steps; j++) consider({ x: box.x + (i + .5) / steps * box.w, y: box.y + (j + .5) / steps * box.h });
    return { point: best || { ...polygon[0] }, distance: Math.max(0, depth) };
}

export function polygonCenter(polygon) {
    const average = polygon.reduce((p, v) => ({ x: p.x + v.x / polygon.length, y: p.y + v.y / polygon.length }), { x: 0, y: 0 });
    // The vertex average is strictly inside a nondegenerate convex cell; concave cells need a real interior point.
    if (isConvexPolygon(polygon) || pointInPolygon(average, polygon)) return average;
    const area = signedArea(polygon);
    if (Math.abs(area) > 1e-9) {
        let x = 0, y = 0;
        polygon.forEach((p, i) => { const q = polygon[(i + 1) % polygon.length], w = p.x * q.y - q.x * p.y; x += (p.x + q.x) * w; y += (p.y + q.y) * w; });
        const centroid = { x: x / (6 * area), y: y / (6 * area) };
        if (pointInPolygon(centroid, polygon)) return centroid;
    }
    return interiorPoint(polygon).point;
}

/** Interior anchor near the visible front of a cell, for labels and field props. */
export function frontAnchor(polygon, amount = .5) {
    const center = polygonCenter(polygon);
    const front = polygon.reduce((best, p) => p.x + p.y > best.x + best.y ? p : best, polygon[0]);
    const convex = isConvexPolygon(polygon);
    for (let a = amount, attempt = 0; attempt < 8; attempt++, a /= 2) {
        const anchor = { x: center.x + (front.x - center.x) * a, y: center.y + (front.y - center.y) * a };
        // A straight pull toward a concave cell's front can leave the cell; shorten it until it stays inside.
        if (convex || pointInPolygon(anchor, polygon)) return anchor;
    }
    return center;
}

function boundsOf(points) {
    if (!points.length) return { x: 0, y: 0, w: 0, h: 0 };
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function plantTrees(ids, polygon, { seed = 'garden', edgeInset = 12 } = {}) {
    const sorted = [...ids].sort();
    if (new Set(sorted).size !== sorted.length) throw new Error('Duplicate session identity in tree placement');
    if (polygon.length < 3 || polygon.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)) || Math.abs(signedArea(polygon)) <= 1e-9) {
        if (!ids.length) return { points: [], bounds: boundsOf([]), polygon: [], edgeInset: 0, minSpacing: 0, targetSpacing: 0, relaxed: false };
        throw new Error('Tree placement requires a finite, nondegenerate simple polygon');
    }
    const convex = isConvexPolygon(polygon);
    let inset, safe, triangles;
    if (convex) {
        const center = polygonCenter(polygon);
        const clearance = Math.min(...polygon.map((a, i) => {
            const b = polygon[(i + 1) % polygon.length];
            return Math.abs((b.x - a.x) * (center.y - a.y) - (b.y - a.y) * (center.x - a.x)) / (Math.hypot(b.x - a.x, b.y - a.y) || 1);
        }));
        inset = Math.min(Math.max(0, edgeInset), clearance * .3);
        safe = insetPolygon(polygon, inset);
        const centerSafe = polygonCenter(safe);
        triangles = safe.map((a, i) => {
            const b = safe[(i + 1) % safe.length];
            return { o: centerSafe, a, b, area: Math.abs((a.x - centerSafe.x) * (b.y - centerSafe.y) - (b.x - centerSafe.x) * (a.y - centerSafe.y)) / 2 };
        });
    } else {
        // Concave cell: the offset polygon is validated as simple and at least `inset` from the shore,
        // so ear-clipped triangles of it can be sampled without any containment test.
        const wanted = Math.min(Math.max(0, edgeInset), interiorPoint(polygon).distance * .3);
        inset = 0; safe = polygon.map(p => ({ ...p }));
        for (let d = wanted, attempt = 0; d > 0 && attempt < 8; attempt++, d /= 2) {
            const offset = offsetSimplePolygon(polygon, d);
            if (offset) { inset = d; safe = offset; break; }
        }
        triangles = triangulatePolygon(safe).map(([i, j, k]) => ({ o: safe[i], a: safe[j], b: safe[k], area: Math.abs(cross3(safe[i], safe[j], safe[k])) / 2 }));
        if (!triangles.length) {
            const c = polygonCenter(safe);
            triangles = safe.map((a, i) => { const b = safe[(i + 1) % safe.length]; return { o: c, a, b, area: Math.abs(cross3(c, a, b)) / 2 }; });
        }
    }
    const area = Math.abs(signedArea(safe));
    const spacing = Math.sqrt(area / Math.max(1, sorted.length)) * .49;
    const safeBounds = boundsOf(safe), cellSize = Math.max(1e-7, spacing), grid = new Map(), points = [];
    const triangleArea = triangles.reduce((sum, triangle) => sum + triangle.area, 0);
    const sample = random => {
        let which = random() * triangleArea;
        const triangle = triangles.find(t => (which -= t.area) <= 0) || triangles.at(-1);
        const u = Math.sqrt(random()), v = random();
        return { x: (1 - u) * triangle.o.x + u * (1 - v) * triangle.a.x + u * v * triangle.b.x,
            y: (1 - u) * triangle.o.y + u * (1 - v) * triangle.a.y + u * v * triangle.b.y };
    };
    const cell = p => [Math.floor((p.x - safeBounds.x) / cellSize), Math.floor((p.y - safeBounds.y) / cellSize)];
    const nearest = p => {
        const [x, y] = cell(p);
        // Outside these 25 buckets points exceed the required exclusion radius.
        let distance = spacing * 2;
        for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
            for (const q of grid.get((x + dx) + ',' + (y + dy)) || []) distance = Math.min(distance, Math.hypot(p.x - q.x, p.y - q.y));
        }
        return distance;
    };
    const groveRandom = rngFor(seed + '/groves');
    const groves = [sample(groveRandom), sample(groveRandom)];
    const clearing = sample(groveRandom), groveRadius = Math.sqrt(area) * .38, clearingRadius = Math.sqrt(area) * .12;
    let effectiveSpacing = spacing, relaxed = false;
    for (const id of sorted) {
        const random = rngFor(seed + '/session/' + id);
        let chosen = null;
        // Constant candidate and retry limits keep malformed capacity requests finite.
        for (let round = 0; round < 7 && !chosen; round++) {
            const required = spacing * Math.pow(.72, round);
            let bestScore = -Infinity;
            for (let attempt = 0; attempt < 28; attempt++) {
                const candidate = sample(random), distance = nearest(candidate);
                if (distance < required) continue;
                const grove = Math.min(...groves.map(p => Math.hypot(p.x - candidate.x, p.y - candidate.y)));
                const clearingDistance = Math.hypot(candidate.x - clearing.x, candidate.y - clearing.y);
                const affinity = .76 + .34 * Math.exp(-grove * grove / (groveRadius * groveRadius));
                const openness = .36 + .64 * Math.min(1, clearingDistance / clearingRadius);
                const score = Math.min(distance / spacing, 2) * affinity * openness;
                if (score > bestScore) { chosen = candidate; bestScore = score; }
            }
            if (chosen) { effectiveSpacing = Math.min(effectiveSpacing, required); relaxed ||= round > 0; }
        }
        if (!chosen) {
            // Even extremely thin or overfull cells retain every session inside the cell.
            let bestDistance = -1;
            for (let attempt = 0; attempt < 64; attempt++) {
                const candidate = sample(random), distance = nearest(candidate);
                if (distance > bestDistance) { chosen = candidate; bestDistance = distance; }
            }
            effectiveSpacing = Math.min(effectiveSpacing, bestDistance); relaxed = true;
        }
        const placed = { id, ...chosen }, key = cell(placed).join(',');
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(placed); points.push(placed);
    }
    return { points, bounds: boundsOf(points), polygon: safe, edgeInset: inset,
        minSpacing: points.length > 1 ? effectiveSpacing : 0, targetSpacing: spacing, relaxed };
}
