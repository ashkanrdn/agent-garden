/** Rolling hills with blue survey contours and a soft ring-and-dot stipple ground. */
export const PLOT_HILL_SETTINGS = Object.freeze({ shape: 'rolling', elevation: .55, contours: true, roots: false, materials: 'stipple' });
const RINGS = 20;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => a + (b - a) * t;
const cross = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
function hash(text) { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; }
/** Alpha factors; callers apply their base alpha and skip passes below .01. */
export function dashFade(period, dpr = 1) {
    const devicePeriod = period * dpr, x = clamp((devicePeriod - 3) / 3, 0, 1);
    const dashAlpha = x * x * (3 - 2 * x);
    return { dashAlpha, solidAlpha: clamp(devicePeriod / 4, .32, .75) * (1 - dashAlpha) };
}
// Standalone geometric fallback: a split or camera translation never restarts a dash.
function tracePlotDash(ctx, points, { period, phase, solid, origin, duty = .58 }) {
    const [a, b] = points;
    if (solid) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); return; }
    const pa = (a.x - origin.x + (a.y - origin.y) * .35 + phase) / period;
    const pb = (b.x - origin.x + (b.y - origin.y) * .35 + phase) / period, delta = pb - pa;
    if (Math.abs(delta) < 1e-9) {
        if (((pa % 1) + 1) % 1 >= 1 - duty) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
        return;
    }
    for (let k = Math.floor(Math.min(pa, pb)); k <= Math.floor(Math.max(pa, pb)); k++) {
        let u = (k + 1 - duty - pa) / delta, v = (k + 1 - pa) / delta;
        if (u > v) [u, v] = [v, u];
        u = Math.max(0, u); v = Math.min(1, v);
        if (v <= u) continue;
        ctx.moveTo(mix(a.x, b.x, u), mix(a.y, b.y, u));
        ctx.lineTo(mix(a.x, b.x, v), mix(a.y, b.y, v));
    }
}
export function plotContourDashStyle(id, level, zoom, dpr = 1, basePeriod = 15) {
    const key = `${id}/contour/${level}`;
    const period = basePeriod * Math.max(1e-12, zoom) * (.8 + .4 * hash(key + '/period'));
    const fade = dashFade(period, dpr), solid = fade.dashAlpha < .01;
    return { period, phase: period * hash(key + '/phase'), ...fade, solid,
        alpha: solid ? fade.solidAlpha : 1 };
}
function bounds(points) {
    let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
    for (const p of points) { x = Math.min(x, p.x); y = Math.min(y, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y); }
    return { x, y, w: right - x, h: bottom - y };
}
function overlaps(a, b) { return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y; }
function trace(ctx, points) { ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); }
function weights(p, a, b, c) {
    const d = cross(a, b, c);
    if (Math.abs(d) < 1e-10) return null;
    const u = cross(b, c, p) / d, v = cross(c, a, p) / d, w = 1 - u - v;
    return u >= -1e-7 && v >= -1e-7 && w >= -1e-7 ? [u, v, w] : null;
}
function polygonArea2(polygon) {
    return polygon.reduce((sum, a, i) => { const b = polygon[(i + 1) % polygon.length]; return sum + a.x * b.y - b.x * a.y; }, 0);
}
function isConvex(polygon) {
    const sign = Math.sign(polygonArea2(polygon));
    if (!sign) return false;
    return polygon.every((a, i) => {
        const b = polygon[(i + 1) % polygon.length], c = polygon[(i + 2) % polygon.length];
        return sign * cross(a, b, c) >= -1e-9 * Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y);
    });
}
/** Edge-inclusive even-odd containment for any simple polygon. */
function insidePolygon(polygon, x, y, epsilon = 0) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[j], b = polygon[i];
        if (epsilon) {
            const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
            const t = length2 ? clamp(((x - a.x) * dx + (y - a.y) * dy) / length2, 0, 1) : 0;
            if (Math.hypot(x - a.x - dx * t, y - a.y - dy * t) <= epsilon) return true;
        }
        if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}
/** Ear clipping for any simple polygon and either winding; returns index triples. */
function triangulate(polygon) {
    const n = polygon.length, sign = polygonArea2(polygon) < 0 ? -1 : 1, triangles = [];
    const ring = Array.from({ length: n }, (_, i) => sign > 0 ? i : n - 1 - i);
    // The ring is always counterclockwise here, so every ear turn is positive.
    const has = (p, a, b, c) => cross(a, b, p) >= -1e-12 && cross(b, c, p) >= -1e-12 && cross(c, a, p) >= -1e-12;
    const same = (p, q) => p.x === q.x && p.y === q.y;
    let guard = n * n + 8;
    while (ring.length > 3 && guard-- > 0) {
        let clipped = false;
        for (let k = 0; k < ring.length && !clipped; k++) {
            const ia = ring[(k + ring.length - 1) % ring.length], ib = ring[k], ic = ring[(k + 1) % ring.length];
            const a = polygon[ia], b = polygon[ib], c = polygon[ic];
            if (cross(a, b, c) <= 1e-12) continue;
            if (ring.some(j => j !== ia && j !== ib && j !== ic && !same(polygon[j], a) && !same(polygon[j], b) && !same(polygon[j], c) && has(polygon[j], a, b, c))) continue;
            triangles.push([ia, ib, ic]); ring.splice(k, 1); clipped = true;
        }
        if (!clipped) {
            let flattest = 0, least = Infinity;
            for (let k = 0; k < ring.length; k++) {
                const t = Math.abs(cross(polygon[ring[(k + ring.length - 1) % ring.length]], polygon[ring[k]], polygon[ring[(k + 1) % ring.length]]));
                if (t < least) { least = t; flattest = k; }
            }
            ring.splice(flattest, 1);
        }
    }
    if (ring.length === 3 && Math.abs(cross(polygon[ring[0]], polygon[ring[1]], polygon[ring[2]])) > 1e-12) triangles.push([...ring]);
    return triangles;
}
/** Every edge sees the point on its inner side, so the fan of triangles from it tiles the polygon. */
function seesAll(polygon, c, tolerance = 1e-9) {
    const sign = Math.sign(polygonArea2(polygon));
    return polygon.every((a, i) => {
        const b = polygon[(i + 1) % polygon.length];
        return sign * cross(a, b, c) >= -tolerance * Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - a.x, c.y - a.y);
    });
}
/** Centroid of the polygon kernel (points that see every edge), or null when it is empty. */
function kernelPoint(polygon) {
    const sign = polygonArea2(polygon) < 0 ? -1 : 1;
    const box = bounds(polygon), pad = Math.max(box.w, box.h, 1);
    let kernel = [{ x: box.x - pad, y: box.y - pad }, { x: box.x + box.w + pad, y: box.y - pad },
        { x: box.x + box.w + pad, y: box.y + box.h + pad }, { x: box.x - pad, y: box.y + box.h + pad }];
    for (let i = 0; i < polygon.length && kernel.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length], next = [];
        const depth = p => sign * cross(a, b, p);
        for (let j = 0; j < kernel.length; j++) {
            const p = kernel[j], q = kernel[(j + 1) % kernel.length], dp = depth(p), dq = depth(q);
            if (dp >= 0) next.push(p);
            if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); next.push({ x: mix(p.x, q.x, t), y: mix(p.y, q.y, t) }); }
        }
        kernel = next;
    }
    const area = polygonArea2(kernel);
    if (kernel.length < 3 || Math.abs(area) < 1e-9 * Math.max(1, Math.abs(polygonArea2(polygon)))) return null;
    let x = 0, y = 0;
    kernel.forEach((p, i) => { const q = kernel[(i + 1) % kernel.length], w = p.x * q.y - q.x * p.y; x += (p.x + q.x) * w; y += (p.y + q.y) * w; });
    const centroid = { x: x / (3 * area), y: y / (3 * area) };
    return seesAll(polygon, centroid, 0) ? centroid : { x: kernel.reduce((n, p) => n + p.x, 0) / kernel.length, y: kernel.reduce((n, p) => n + p.y, 0) / kernel.length };
}
/** Region of `polygon` visible from `c` (CCW input), with perimeter coordinates for each vertex. */
function visibleRegion(polygon, c) {
    const n = polygon.length, hits = [];
    const cast = angle => {
        const dx = Math.cos(angle), dy = Math.sin(angle);
        let best = null;
        for (let e = 0; e < n; e++) {
            const a = polygon[e], b = polygon[(e + 1) % n], ex = b.x - a.x, ey = b.y - a.y;
            const denominator = dx * ey - dy * ex;
            if (Math.abs(denominator) < 1e-14) continue;
            const t = ((a.x - c.x) * ey - (a.y - c.y) * ex) / denominator, u = ((a.x - c.x) * dy - (a.y - c.y) * dx) / denominator;
            if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 && (!best || t < best.t)) best = { t, s: e + clamp(u, 0, 1), angle };
        }
        if (best) hits.push({ x: c.x + dx * best.t, y: c.y + dy * best.t, s: best.s % n, angle });
    };
    for (const v of polygon) { const angle = Math.atan2(v.y - c.y, v.x - c.x); cast(angle - 1e-7); cast(angle); cast(angle + 1e-7); }
    hits.sort((p, q) => p.angle - q.angle);
    const region = [];
    for (const hit of hits) {
        const last = region.at(-1);
        if (last && Math.hypot(hit.x - last.x, hit.y - last.y) < 1e-6) continue;
        region.push(hit);
    }
    while (region.length > 1 && Math.hypot(region[0].x - region.at(-1).x, region[0].y - region.at(-1).y) < 1e-6) region.pop();
    return region;
}
/** Split a simple polygon into a star-shaped footprint, its center, and flat triangles for the rest. */
function hillFootprint(polygon, preferred) {
    if (isConvex(polygon) || (preferred && seesAll(polygon, preferred))) return { footprint: polygon, center: preferred || null, pockets: [] };
    const kernel = kernelPoint(polygon);
    if (kernel) return { footprint: polygon, center: kernel, pockets: [] };
    const ccw = polygonArea2(polygon) < 0 ? [...polygon].reverse() : polygon;
    const n = ccw.length, total = Math.abs(polygonArea2(ccw));
    const candidates = triangulate(ccw).map(([a, b, c]) => ({ x: (ccw[a].x + ccw[b].x + ccw[c].x) / 3, y: (ccw[a].y + ccw[b].y + ccw[c].y) / 3 }));
    if (preferred && insidePolygon(ccw, preferred.x, preferred.y)) candidates.push(preferred);
    let best = null;
    for (const c of candidates) {
        const region = visibleRegion(ccw, c), area = region.length >= 3 ? Math.abs(polygonArea2(region)) : 0;
        if (!best || area > best.area) best = { c, region, area };
    }
    if (!best || best.region.length < 3) return { footprint: polygon, center: candidates[0] || preferred, pockets: [] };
    const { c, region } = best, pockets = [];
    for (let i = 0; i < region.length; i++) {
        const A = region[i], B = region[(i + 1) % region.length];
        let sa = A.s, sb = B.s; if (sb < sa - 1e-9) sb += n;
        if (sb - sa < 1e-7) continue;
        const chain = [];
        for (let k = Math.floor(sa + 1e-9) + 1; k < sb - 1e-9; k++) chain.push(ccw[k % n]);
        if (!chain.length) continue;
        const pocket = [{ x: A.x, y: A.y }, ...chain, { x: B.x, y: B.y }];
        if (Math.abs(polygonArea2(pocket)) > 1e-9 * total) for (const [a, b, d] of triangulate(pocket)) pockets.push([pocket[a], pocket[b], pocket[d]]);
    }
    return { footprint: region.map(({ x, y }) => ({ x, y })), center: c, pockets };
}
/** Sparse world-anchored stipple: mostly dots with some small rings, jittered inside a fixed per-plot grid. */
function materialStipple(plot, hill) {
    const box = bounds(plot.polygon), step = Math.max(9, Math.sqrt(Math.abs(plot.area || box.w * box.h)) / 11);
    const marks = [];
    // Convex cells keep the exact half-plane test; concave cells need true containment.
    const inside = hill.convex ? p => plot.polygon.every((a, i) => cross(a, plot.polygon[(i + 1) % plot.polygon.length], p) >= 0)
        : p => insidePolygon(plot.polygon, p.x, p.y);
    const nx = Math.min(40, Math.ceil(box.w / step)), ny = Math.min(40, Math.ceil(box.h / step));
    for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) {
        const key = plot.id + '/stipple/' + ix + '/' + iy, rand = n => hash(key + '/' + n);
        if (rand(0) > .72) continue;
        // A second, smaller offset mark in some cells keeps the pattern uneven instead of gridlike.
        for (const [n, keep] of [[1, 1], [4, .35]]) {
            if (n > 1 && rand(3) > keep) continue;
            const p = { x: box.x + (ix + .12 + rand(n) * .76) * step, y: box.y + (iy + .12 + rand(n + 1) * .76) * step };
            if (inside(p)) marks.push({ x: p.x, y: p.y, z: hill.height(p.x, p.y) + .08, ring: rand(n + 2) < (n > 1 ? .2 : .38) });
        }
    }
    return { marks, step, material: 'stipple' };
}
export function hillDepth(x, y, yaw = 0) { return x * (Math.cos(yaw) + Math.sin(yaw)) + y * (Math.cos(yaw) - Math.sin(yaw)); }

/** A linear radial segment matches the rendered planar bands exactly. */
export function buildPlotHill(plot) {
    const polygon = plot.polygon || [];
    if (polygon.length < 3 || !plot.centroid) return { peak: 0, height: () => 0, faces: [], contours: [], polygon, contains: () => false, meshAtZoom: () => [] };
    const convex = isConvex(polygon);
    // Convex cells and cells star-shaped about their centroid keep the classic radial hill. Other simple
    // polygons grow the hill from a kernel point, or from the visible region with flat pockets beyond it.
    const { footprint, center, pockets } = hillFootprint(polygon, plot.centroid);
    const area = Math.abs(polygonArea2(polygon)) / 2;
    const peak = Math.sqrt(area) * (.36 + .32 * hash(plot.id)) * PLOT_HILL_SETTINGS.elevation;
    const levels = Array.from({ length: RINGS + 1 }, (_, i) => peak * (1 + Math.cos(Math.PI * i / RINGS)) / 2);
    const orient = Math.sign(polygonArea2(footprint)) || 1;
    const planes = footprint.map((a, i) => {
        const b = footprint[(i + 1) % footprint.length], nx = b.y - a.y, ny = a.x - b.x;
        return { nx, ny, limit: nx * (a.x - center.x) + ny * (a.y - center.y), ax: a.x - center.x, ay: a.y - center.y, bx: b.x - center.x, by: b.y - center.y };
    });
    function radial(x, y) {
        const px = x - center.x, py = y - center.y;
        if (convex) {
            let t = 0;
            for (const p of planes) if (Math.abs(p.limit) > 1e-9) t = Math.max(t, (p.nx * px + p.ny * py) / p.limit);
            return t;
        }
        // Star-shaped cell: the edge whose wedge holds the point gives the radial fraction.
        const radius = Math.hypot(px, py);
        for (const p of planes) {
            if (Math.abs(p.limit) <= 1e-9) continue;
            const eps = 1e-9 * radius * Math.max(Math.hypot(p.ax, p.ay), Math.hypot(p.bx, p.by));
            if (orient * (p.ax * py - p.ay * px) >= -eps && orient * (px * p.by - py * p.bx) >= -eps) return (p.nx * px + p.ny * py) / p.limit;
        }
        return 1;
    }
    function height(x, y) {
        const s = clamp(radial(x, y), 0, 1) * RINGS, i = Math.min(RINGS - 1, Math.floor(s));
        return mix(levels[i], levels[i + 1], s - i);
    }
    const rings = levels.map((z, i) => footprint.map(p => ({ x: mix(center.x, p.x, i / RINGS), y: mix(center.y, p.y, i / RINGS), z })));
    const flat = pockets.map(triangle => {
        const vertices = triangle.map(p => ({ x: p.x, y: p.y, z: 0 }));
        return { vertices, light: .65 + .35 * .81, band: RINGS - 1 };
    });
    function mesh(indices) {
        const faces = [];
        for (let band = 0; band < indices.length - 1; band++) for (let i = 0; i < footprint.length; i++) {
            const r = indices[band], next = indices[band + 1];
            const j = (i + 1) % footprint.length;
            const vertices = r ? [rings[r][i], rings[next][i], rings[next][j], rings[r][j]] : [rings[r][i], rings[next][i], rings[next][j]];
            const [a, b, c] = vertices, ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
            const normal = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], length = Math.hypot(...normal) || 1;
            const light = .65 + .35 * Math.max(0, (-normal[0] * .49 - normal[1] * .33 + normal[2] * .81) / length);
            faces.push({ vertices, light, band: r });
        }
        return flat.length ? faces.concat(flat) : faces;
    }
    const faces = mesh(Array.from({ length: RINGS + 1 }, (_, i) => i));
    const meshes = new Map();
    function meshAtZoom(zoom, maxError = .2) {
        // Drop only bands whose projected height differs by less than a fifth pixel.
        // The world-space height, roots, and contour levels keep the full mesh.
        const indices = [0];
        function split(a, b) {
            let worst = -1, error = maxError;
            for (let i = a + 1; i < b; i++) {
                const deviation = Math.abs(levels[i] - mix(levels[a], levels[b], (i - a) / (b - a))) * zoom;
                if (deviation > error) { error = deviation; worst = i; }
            }
            if (worst >= 0) { split(a, worst); split(worst, b); }
            else indices.push(b);
        }
        split(0, RINGS);
        if (indices.length === RINGS + 1) return faces;
        const key = indices.join(',');
        if (!meshes.has(key)) {
            meshes.set(key, mesh(indices));
            if (meshes.size > 8) meshes.delete(meshes.keys().next().value);
        }
        return meshes.get(key);
    }
    // Constant-height sections follow the actual piecewise-linear mesh.
    const contours = [];
    for (let i = 1; i < 10; i++) {
        const z = peak * i / 10;
        let r = 0; while (r < RINGS - 1 && levels[r + 1] > z) r++;
        const t = (r + (levels[r] - z) / (levels[r] - levels[r + 1])) / RINGS;
        contours.push(footprint.map(p => ({ x: mix(center.x, p.x, t), y: mix(center.y, p.y, t), z })));
    }
    const contains = convex ? (x, y, eps = 0) => polygon.every((a, i) => cross(a, polygon[(i + 1) % polygon.length], { x, y }) * orient >= -eps)
        : (x, y, eps = 0) => insidePolygon(polygon, x, y, eps);
    return { peak, height, faces, contours, polygon, center, convex, contains, meshAtZoom };
}

export function createPlotHills() {
    const cache = new WeakMap();
    function hill(plot) {
        if (!plot?.polygon) return null;
        let h = cache.get(plot.polygon);
        if (!h) { h = buildPlotHill(plot); h.stipple = materialStipple(plot, h); cache.set(plot.polygon, h); }
        return h;
    }
    return {
        hill,
        height(plot, x, y) { return hill(plot)?.height(x, y) || 0; },
        view(plots, project, { yaw = 0, width, height, zoom = 1, selected, opacity = () => 1 } = {}) {
            const faces = [], lines = [], stipple = Array.from({ length: 8 }, () => []), byId = new Map(plots.map(p => [p.id, p]));
            const viewport = { x: 0, y: 0, w: width, h: height };
            const depthX = Math.cos(yaw) + Math.sin(yaw), depthY = Math.cos(yaw) - Math.sin(yaw);
            // All garden cameras are affine; avoid trigonometry per mesh vertex.
            const origin = project(0, 0, 0), axisX = project(1, 0, 0), axisY = project(0, 1, 0), axisZ = project(0, 0, 1);
            const xx = axisX.x - origin.x, xy = axisY.x - origin.x, xz = axisZ.x - origin.x;
            const yx = axisX.y - origin.y, yy = axisY.y - origin.y, yz = axisZ.y - origin.y;
            for (const plot of plots) {
                const h = hill(plot), lift = 2 + (plot.lift || 0), tint = [33, 52, 72];
                const colors = new Map();
                const alpha = opacity(plot);
                const screen = p => ({ x: origin.x + p.x * xx + p.y * xy + (p.z + lift) * xz,
                    y: origin.y + p.x * yx + p.y * yy + (p.z + lift) * yz, depth: p.x * depthX + p.y * depthY });
                // This prism contains every surface point. Reject it before projecting stipple.
                const prism = [];
                for (const p of h.polygon) for (const z of [0, h.peak + .08]) prism.push(screen({ x: p.x, y: p.y, z }));
                if (!overlaps(bounds(prism), viewport)) continue;
                for (const face of h.meshAtZoom(zoom)) {
                    const points = face.vertices.map(screen), box = bounds(points);
                    if (!overlaps(box, viewport)) continue;
                    const lightKey = Math.round(face.light * 80);
                    if (!colors.has(lightKey)) colors.set(lightKey, `rgb(${tint.map(n => Math.round((n * .85 + 150 * .15) * face.light)).join(',')})`);
                    faces.push({ points, bounds: box, plotId: plot.id, color: colors.get(lightKey), opacity: alpha,
                        depth: points.reduce((sum, p) => sum + p.depth / points.length, 0), maxDepth: Math.max(...points.map(p => p.depth)), minDepth: Math.min(...points.map(p => p.depth)) });
                }
                const stippleOpacity = clamp((h.stipple.step * zoom - 1.5) / 7, 0, .5) * alpha;
                if (stippleOpacity > .01) {
                    const bucket = clamp(Math.round(stippleOpacity / .5 * 8), 1, 8) - 1;
                    for (const mark of h.stipple.marks) {
                        const point = screen(mark);
                        if (overlaps({ x: point.x - 2, y: point.y - 2, w: 4, h: 4 }, viewport)) stipple[bucket].push({ ...point, ring: mark.ring });
                    }
                }
                const addLine = (points, boundary, level) => {
                    const box = bounds(points);
                    if (overlaps(box, viewport)) lines.push({ points, bounds: box, plotId: plot.id, boundary, level,
                        opacity: clamp((h.peak * zoom - 4) / 24, 0, .3) * alpha });
                };
                if (PLOT_HILL_SETTINGS.contours) for (let level = 0; level < h.contours.length; level++) {
                    addLine(h.contours[level].map(screen), false, level);
                }
                addLine(h.polygon.map(p => screen({ ...p, z: 0 })), true);
            }
            faces.sort((a, b) => a.depth - b.depth);
            // A compact depth field hides material marks behind foreground slopes.
            // Exact triangle picking below remains separate for pointer interactions.
            const pixel = 2, columns = Math.ceil(width / pixel), rows = Math.ceil(height / pixel);
            const depthField = new Float32Array(columns * rows); depthField.fill(-Infinity);
            for (const face of faces) for (let i = 1; i < face.points.length - 1; i++) {
                const a = face.points[0], b = face.points[i], c = face.points[i + 1], determinant = cross(a, b, c);
                if (Math.abs(determinant) < 1e-8) continue;
                const left = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x) / pixel));
                const right = Math.min(columns - 1, Math.floor(Math.max(a.x, b.x, c.x) / pixel));
                const top = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y) / pixel));
                const bottom = Math.min(rows - 1, Math.floor(Math.max(a.y, b.y, c.y) / pixel));
                for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
                    const px = (x + .5) * pixel, py = (y + .5) * pixel;
                    const u = ((c.x - b.x) * (py - b.y) - (c.y - b.y) * (px - b.x)) / determinant;
                    const v = ((a.x - c.x) * (py - c.y) - (a.y - c.y) * (px - c.x)) / determinant;
                    const w = 1 - u - v;
                    if (u < 0 || v < 0 || w < 0) continue;
                    const index = y * columns + x, depth = a.depth * u + b.depth * v + c.depth * w;
                    if (depth > depthField[index]) depthField[index] = depth;
                }
            }
            function hidden(x, y, depth) {
                if (x < 0 || y < 0 || x >= width || y >= height) return true;
                return depthField[Math.floor(y / pixel) * columns + Math.floor(x / pixel)] > depth + 3 / Math.max(.001, zoom);
            }
            // View-space bins bound picking and per-tree occlusion work.
            const size = 16, binColumns = Math.ceil(width / size), binRows = Math.ceil(height / size);
            const bins = new Array(binColumns * binRows), visited = new Uint32Array(faces.length);
            let query = 0;
            for (let index = 0; index < faces.length; index++) {
                const b = faces[index].bounds;
                const left = Math.max(0, Math.floor(b.x / size)), right = Math.min(binColumns - 1, Math.floor((b.x + b.w) / size));
                const top = Math.max(0, Math.floor(b.y / size)), bottom = Math.min(binRows - 1, Math.floor((b.y + b.h) / size));
                for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
                    const key = y * binColumns + x;
                    (bins[key] || (bins[key] = [])).push(index);
                }
            }
            function candidates(box) {
                const result = [];
                if (++query === 4294967296) { visited.fill(0); query = 1; }
                const left = Math.max(0, Math.floor(box.x / size)), right = Math.min(binColumns - 1, Math.floor((box.x + box.w) / size));
                const top = Math.max(0, Math.floor(box.y / size)), bottom = Math.min(binRows - 1, Math.floor((box.y + box.h) / size));
                for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
                    const bin = bins[y * binColumns + x];
                    if (!bin) continue;
                    for (const index of bin) {
                        if (visited[index] === query) continue;
                        visited[index] = query;
                        const face = faces[index];
                        if (overlaps(face.bounds, box)) result.push(face);
                    }
                }
                return result;
            }
            function pick(x, y) {
                let found = null;
                if (x < 0 || y < 0 || x >= width || y >= height) return null;
                for (const index of bins[Math.floor(y / size) * binColumns + Math.floor(x / size)] || []) {
                    const face = faces[index];
                    for (let i = 1; i < face.points.length - 1; i++) {
                        const tri = [face.points[0], face.points[i], face.points[i + 1]], w = weights({ x, y }, ...tri);
                        if (!w) continue;
                        const depth = tri.reduce((sum, p, j) => sum + p.depth * w[j], 0);
                        if (!found || depth > found.depth) found = { plot: byId.get(face.plotId), depth };
                    }
                }
                return found;
            }
            return {
                faces, pick,
                decorationVisible: (x, y, depth) => !hidden(x, y, depth),
                surfaceVisible: (x, y, depth) => !hidden(x, y, depth) &&
                    Number.isFinite(depthField[Math.floor(y / pixel) * columns + Math.floor(x / pixel)]),
                surfacePoint(plotId, x, y) {
                    const plot = byId.get(plotId);
                    const hillHere = plot && hill(plot);
                    if (!hillHere || !hillHere.contains(x, y, 1e-8)) return null;
                    const z = hillHere.height(x, y) + 2 + (plot.lift || 0), point = project(x, y, z);
                    const depth = hillDepth(x, y, yaw);
                    return { ...point, depth, world: { x, y, z }, opacity: opacity(plot), visible: !hidden(point.x, point.y, depth) };
                },
                draw(ctx, { traceContour = globalThis.SpecimenEnvironment?.traceContourPath } = {}) {
                    const inheritedAlpha = ctx.globalAlpha ?? 1;
                    ctx.save();
                    for (const face of faces) { ctx.globalAlpha = inheritedAlpha * (face.opacity); ctx.fillStyle = face.color; trace(ctx, face.points); ctx.fill(); }
                    // All dashes are geometric, so Canvas dash state changes at most once.
                    if (!ctx.getLineDash || ctx.getLineDash().length) ctx.setLineDash?.([]);
                    if (ctx.lineDashOffset !== 0) ctx.lineDashOffset = 0;
                    ctx.strokeStyle = '#88accb'; ctx.lineWidth = .8; ctx.lineCap = 'round';
                    for (let bucket = 0; bucket < stipple.length; bucket++) {
                        if (!stipple[bucket].length) continue;
                        ctx.globalAlpha = inheritedAlpha * (bucket + 1) * .5 / 8;
                        if (ctx.globalAlpha < .01) continue;
                        // Dots are zero-length round-capped strokes; rings are tiny arcs. One stroke per kind.
                        ctx.beginPath(); let dots = 0; const rings = [];
                        for (const mark of stipple[bucket]) {
                            if (hidden(mark.x, mark.y, mark.depth)) continue;
                            if (mark.ring && ctx.arc) rings.push(mark); else { ctx.moveTo(mark.x, mark.y); ctx.lineTo(mark.x + .01, mark.y); dots++; }
                        }
                        if (dots) ctx.stroke();
                        if (rings.length) {
                            ctx.lineWidth = .6; ctx.beginPath();
                            for (const mark of rings) { ctx.moveTo(mark.x + 1.5, mark.y); ctx.arc(mark.x, mark.y, 1.5, 0, Math.PI * 2); }
                            ctx.stroke(); ctx.lineWidth = .8;
                        }
                    }
                    const groups = new Map(), dpr = Math.abs(ctx.getTransform?.().a ?? 1);
                    for (const line of lines) {
                        if (!overlaps(line.bounds, viewport)) continue;
                        const dash = line.boundary ? null : plotContourDashStyle(line.plotId, line.level, zoom, dpr, traceContour ? 15 : 7);
                        const color = line.boundary ? (line.plotId === selected ? '#bed5af' : '#657f94') : '#91bce3';
                        const width = line.boundary ? .65 : .75, baseAlpha = inheritedAlpha * (line.boundary ? .7 : line.opacity);
                        const passes = line.boundary ? [{ solid: true, alpha: baseAlpha }] : [
                            { solid: false, alpha: baseAlpha * dash.dashAlpha }, { solid: true, alpha: baseAlpha * dash.solidAlpha }];
                        for (const pass of passes) {
                            if (pass.alpha < .01) continue;
                            const key = `${color}/${width}/${pass.alpha}/${pass.solid ? 'solid' : `${dash.period}/${dash.phase}`}`;
                            let group = groups.get(key);
                            if (!group) { group = { color, width, ...pass, dash, lines: [] }; groups.set(key, group); }
                            group.lines.push(line);
                        }
                    }
                    // Identical styles share one path, including solid fade passes across plots.
                    const drawDash = traceContour || tracePlotDash;
                    for (const group of groups.values()) {
                        ctx.strokeStyle = group.color; ctx.lineWidth = group.width; ctx.globalAlpha = group.alpha;
                        ctx.beginPath(); let count = 0;
                        for (const line of group.lines) {
                            let connected = false;
                            for (let i = 0; i < line.points.length; i++) {
                                const a = line.points[i], b = line.points[(i + 1) % line.points.length];
                                if (Math.max(a.x, b.x) < 0 || Math.min(a.x, b.x) > width ||
                                    Math.max(a.y, b.y) < 0 || Math.min(a.y, b.y) > height) { connected = false; continue; }
                                const n = Math.max(1, Math.min(256, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8)));
                                for (let j = 0; j < n; j++) {
                                    const t = (j + .5) / n;
                                    if (hidden(mix(a.x, b.x, t), mix(a.y, b.y, t), mix(a.depth, b.depth, t))) { connected = false; continue; }
                                    if (!group.solid) {
                                        drawDash(ctx, [{ x: mix(a.x, b.x, j / n), y: mix(a.y, b.y, j / n) },
                                            { x: mix(a.x, b.x, (j + 1) / n), y: mix(a.y, b.y, (j + 1) / n) }],
                                            { ...group.dash, solid: false, origin, duty: .58 });
                                    } else {
                                        if (!connected) ctx.moveTo(mix(a.x, b.x, j / n), mix(a.y, b.y, j / n));
                                        connected = true;
                                        ctx.lineTo(mix(a.x, b.x, (j + 1) / n), mix(a.y, b.y, (j + 1) / n));
                                    }
                                    count++;
                                }
                            }
                        }
                        if (count) ctx.stroke();
                    }
                    ctx.restore();
                },
                occluders(root, box) {
                    const depth = hillDepth(root.x, root.y, yaw) + .01, result = [];
                    for (const face of candidates(box)) {
                        if (face.maxDepth <= depth) continue;
                        if (face.minDepth > depth) { result.push(face.points); continue; }
                        // A tree sprite is an upright plane through its root, so clip terrain against that plane.
                        const points = []; let a = face.points.at(-1);
                        for (const b of face.points) {
                            if ((a.depth > depth) !== (b.depth > depth)) { const t = (depth - a.depth) / (b.depth - a.depth); points.push({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) }); }
                            if (b.depth > depth) points.push(b); a = b;
                        }
                        if (points.length >= 3 && overlaps(bounds(points), box)) result.push(points);
                    }
                    return result;
                },
                drawRoots(ctx, trees, zoom) {
                    if (!PLOT_HILL_SETTINGS.roots) return;
                    ctx.save(); ctx.strokeStyle = '#c8e5a6'; ctx.lineWidth = .65; ctx.globalAlpha = .66;
                    for (const tree of trees) {
                        const plot = byId.get(tree.plotId), h = hill(plot); if (!h) continue;
                        const radius = clamp(Math.sqrt(plot.area || 1) * .023, 3, 9);
                        if (radius * zoom < .6) continue;
                        const ring = Array.from({ length: 20 }, (_, i) => { const a = i / 20 * Math.PI * 2, x = tree.x + Math.cos(a) * radius, y = tree.y + Math.sin(a) * radius; return { ...project(x, y, 2 + h.height(x, y) + (plot.lift || 0)), depth: hillDepth(x, y, yaw) }; });
                        ctx.beginPath();
                        for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; if (hidden((a.x + b.x) / 2, (a.y + b.y) / 2, (a.depth + b.depth) / 2)) continue; ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
                        ctx.stroke();
                    }
                    ctx.restore();
                },
            };
        },
    };
}

/** Sorted forest trees can erase directly; scene highlights use a scratch surface. */
export function createHillTreePainter(makeCanvas) {
    const canvas = makeCanvas(), ctx = canvas.getContext('2d');
    const paths = new WeakMap();
    function erase(target, masks) {
        let path = paths.get(masks);
        if (!path) {
            path = new Path2D();
            for (const points of masks) {
                const area = points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y; }, 0);
                const ordered = area < 0 ? [...points].reverse() : points;
                ordered.forEach((p, i) => i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)); path.closePath();
            }
            paths.set(masks, path);
        }
        target.save(); target.globalCompositeOperation = 'destination-out'; target.globalAlpha = 1; target.fillStyle = '#000';
        target.fill(path); target.restore();
    }
    return (target, box, masks, dpr, draw, sortedForest = false, { nativeResolution = false, viewport = null } = {}) => {
        if (!masks?.length) { draw(target); return; }
        if (sortedForest && target.globalAlpha === 1) {
            // Trees arrive back to front on an otherwise transparent layer. Any
            // terrain in front of this root also hides every earlier tree there.
            draw(target); erase(target, masks); return;
        }
        let x = Math.floor(box.x - 4), y = Math.floor(box.y - 4), right = Math.ceil(box.x + box.w + 4), bottom = Math.ceil(box.y + box.h + 4);
        if (nativeResolution && viewport) {
            x = Math.max(x, viewport.x); y = Math.max(y, viewport.y);
            right = Math.min(right, viewport.x + viewport.w); bottom = Math.min(bottom, viewport.y + viewport.h);
        }
        const w = right - x, h = bottom - y;
        if (w <= 0 || h <= 0) return;
        const ratio = nativeResolution ? dpr : Math.min(dpr, 2048 / Math.max(1, w, h));
        const width = Math.ceil(w * ratio), height = Math.ceil(h * ratio);
        if (canvas.width < width) canvas.width = width;
        if (canvas.height < height) canvas.height = height;
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, width, height);
        ctx.setTransform(ratio, 0, 0, ratio, -x * ratio, -y * ratio); ctx.globalAlpha = 1;
        draw(ctx); erase(ctx, masks);
        target.imageSmoothingEnabled = true; target.imageSmoothingQuality = 'high';
        target.drawImage(canvas, 0, 0, width, height, x, y, width / ratio, height / ratio);
    };
}
