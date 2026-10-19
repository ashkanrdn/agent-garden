const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const folder = 'web/';
async function moduleFile(file) { return import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(folder + file, 'utf8')).toString('base64')); }
const modules = Promise.all(['garden-plot-hills.js', 'garden-robot-camera.js', 'garden-layout.js', 'tree-placement.js', 'garden-layout-motion.js'].map(moduleFile));
function square(id = 'a', size = 100, offset = 0) {
    return { id, area: size * size, centroid: { x: offset + size / 2, y: size / 2 }, polygon: [{ x: offset, y: 0 }, { x: offset + size, y: 0 }, { x: offset + size, y: size }, { x: offset, y: size }] };
}
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-7, message || `${a} != ${b}`);

test('approved settings generate continuous boundaries without changing Voronoi inputs', async () => {
    const [{ PLOT_HILL_SETTINGS, buildPlotHill }] = await modules;
    assert.deepEqual(PLOT_HILL_SETTINGS, { shape: 'rolling', elevation: .55, contours: true, roots: false, materials: 'stipple' });
    const a = square(), b = square('b', 100, 100), original = JSON.stringify([a, b]);
    const h = buildPlotHill(a), other = buildPlotHill(b);
    assert.ok(h.peak > 0);
    near(h.height(50, 50), h.peak);
    for (let y = 0; y <= 100; y += 2) { near(h.height(100, y), 0); near(other.height(100, y), 0); }
    assert.equal(JSON.stringify([a, b]), original);
    const reordered = buildPlotHill({ ...a, polygon: a.polygon.slice(2).concat(a.polygon.slice(0, 2)) });
    for (let x = 0; x <= 100; x += 5) for (let y = 0; y <= 100; y += 5) near(h.height(x, y), reordered.height(x, y));
});

test('plot contour dashes vary by plot and level with a deterministic low zoom fallback', async () => {
    const [{ plotContourDashStyle }] = await modules;
    const style = plotContourDashStyle('plot-a', 2, 1, 2);
    assert.deepEqual(style, plotContourDashStyle('plot-a', 2, 1, 2));
    assert.notEqual(style.period, plotContourDashStyle('plot-a', 3, 1, 2).period);
    assert.notEqual(style.phase, plotContourDashStyle('plot-b', 2, 1, 2).phase);
    assert.equal(style.solid, false);
    const distant = plotContourDashStyle('plot-a', 2, .05, 2);
    assert.equal(distant.solid, true);
    assert.ok(distant.alpha < 1);
});

test('tree heights and contour levels lie on rendered mesh planes, including skinny cells', async () => {
    const [{ buildPlotHill }, , { buildGardenLayout }] = await modules;
    const layout = buildGardenLayout(Array.from({ length: 25 }, (_, i) => ({ id: 'p' + i, work: i * 500, sessionCount: i === 0 ? 500 : i })));
    for (const plot of layout.plots) {
        const hill = buildPlotHill(plot);
        for (const face of hill.faces) {
            const p = face.vertices.slice(0, 3).reduce((p, v, i) => { const w = [.2, .3, .5][i]; return { x: p.x + v.x * w, y: p.y + v.y * w, z: p.z + v.z * w }; }, { x: 0, y: 0, z: 0 });
            near(hill.height(p.x, p.y), p.z, 'a root must not float above or sink below the mesh');
        }
        for (const ring of hill.contours) for (const p of ring) near(hill.height(p.x, p.y), p.z);
    }
});

test('surface picking follows raised slopes through a full camera orbit', async () => {
    const [{ createPlotHills, hillDepth }, { projectGround }] = await modules;
    const hills = createPlotHills(), plot = square(), h = hills.hill(plot);
    for (let angle = 0; angle < 12; angle++) {
        const yaw = angle / 12 * Math.PI * 2, project = (x, y, z) => { const p = projectGround(x - 50, y - 50, yaw, z); return { x: 250 + p.x * 2, y: 250 + p.y * 2 }; };
        const view = hills.view([plot], project, { yaw, width: 500, height: 500, zoom: 2 });
        const peak = project(50, 50, h.peak + 2), hit = view.pick(peak.x, peak.y);
        assert.equal(hit.plot.id, plot.id);
        near(hit.depth, hillDepth(50, 50, yaw));
        assert.equal(view.pick(0, 0), null);
    }
});

test('tree masks hide foreground slopes and leave the visible crown above the hill', async () => {
    const [{ createPlotHills, hillDepth }, { projectGround }, , { pointInPolygon }] = await modules;
    const hills = createPlotHills(), plot = square();
    const project = (x, y, z) => { const p = projectGround(x - 50, y - 50, 0, z); return { x: 250 + p.x * 2, y: 250 + p.y * 2 }; };
    const view = hills.view([plot], project, { width: 500, height: 500, zoom: 2 });
    const root = { x: 35, y: 35 }, masks = view.occluders(root, { x: 0, y: 0, w: 500, h: 500 });
    assert.ok(masks.length > 0);
    for (let x = 70; x < 430; x += 11) for (let y = 130; y < 380; y += 13) {
        const hit = view.pick(x, y), hidden = !!(hit && hit.depth > hillDepth(root.x, root.y) + .02);
        const mask = masks.some(p => pointInPolygon({ x, y }, p));
        assert.equal(mask, hidden, `terrain/tree depth mismatch at ${x}, ${y}`);
    }
});

test('hill cache follows historical polygons and animated roots without retaining stale heights', async () => {
    const [{ createPlotHills }, , , , { createLayoutMotion }] = await modules;
    const hills = createPlotHills(), a = square(), b = square('a', 200);
    assert.equal(hills.hill(a), hills.hill(a));
    assert.notEqual(hills.hill(a), hills.hill(b));
    near(hills.hill(b).peak, hills.hill(a).peak * 2);
    function scene(p) { return { plots: [{ ...p, labelAnchor: p.centroid, planting: { polygon: p.polygon } }], outline: p.polygon, bounds: { x: 0, y: 0, w: Math.sqrt(p.area), h: Math.sqrt(p.area) } }; }
    const motion = createLayoutMotion(), tree = { s: { id: 'tree' }, plotId: 'a', x: 45, y: 55 };
    motion.retarget(scene(a), [tree], 0, { animate: false });
    const before = hills.height(a, tree.x, tree.y), first = motion.retarget(scene(b), [{ ...tree, x: 90, y: 110 }], 100, { animate: true });
    near(hills.height(first.layout.plots[0], first.trees[0].x, first.trees[0].y), before);
    const last = motion.sample(720);
    near(hills.height(last.layout.plots[0], last.trees[0].x, last.trees[0].y), before * 2);
});

test('focused camera bounds and live tree elevation include the complete raised surface', async () => {
    const [{ createPlotHills }, { projectGround }] = await modules;
    const plot = square(), tree = { x: 45, y: 55, plotId: 'a', lift: 7 };
    const source = fs.readFileSync(folder + 'canvas-garden.js', 'utf8');
    const code = name => { const start = source.indexOf('function ' + name + '('), end = source.indexOf('\nfunction ', start + 1); return source.slice(start, end); };
    const plotHills = createPlotHills(), layout = { plots: [plot] }, context = vm.createContext({ plotHills, projectGround, shownLayout: () => layout, gardenLayout: layout, camera: { yaw: 0 } });
    vm.runInContext(code('treeElevation') + '\n' + code('projectedBounds'), context);
    near(context.treeElevation(tree), 10 + plotHills.height(plot, tree.x, tree.y));
    for (let i = 0; i < 16; i++) {
        context.camera.yaw = i * Math.PI / 8;
        const box = context.projectedBounds(plot);
        for (const face of plotHills.hill(plot).faces) for (const p of face.vertices) {
            const screen = projectGround(p.x, p.y, context.camera.yaw, p.z + 2);
            assert.ok(screen.x >= box.x - 1e-7 && screen.x <= box.x + box.w + 1e-7 && screen.y >= box.y - 1e-7 && screen.y <= box.y + box.h + 1e-7);
        }
    }
});


test('distant hill meshes stay within a fifth screen pixel of the full surface', async () => {
    const [{ buildPlotHill }] = await modules;
    const hill = buildPlotHill(square('mesh', 900));
    for (const zoom of [.001, .03, .1, .4, 1, 3]) {
        const faces = hill.meshAtZoom(zoom);
        assert.equal(hill.meshAtZoom(zoom), faces, 'reuse the same detail mesh');
        for (const face of faces) {
            const a = face.vertices[0], b = face.vertices[1];
            for (let i = 0; i <= 40; i++) {
                const t = i / 40, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
                const z = a.z + (b.z - a.z) * t;
                assert.ok(Math.abs(hill.height(x, y) - z) * zoom <= .20000001);
            }
        }
    }
    assert.ok(hill.meshAtZoom(.03).length < hill.faces.length / 2);
    assert.ok(hill.meshAtZoom(3).length > hill.meshAtZoom(.03).length, 'close views restore visible curvature');
});

test('decoration roots follow hill heights and reuse terrain visibility through camera yaw', async () => {
    const [{ createPlotHills }, { projectGround }] = await modules;
    const hills = createPlotHills(), plot = square();
    for (const yaw of [0, .8, 2.4]) {
        const project = (x, y, z) => { const p = projectGround(x - 50, y - 50, yaw, z); return { x: 250 + p.x * 2, y: 250 + p.y * 2 }; };
        const view = hills.view([plot], project, { yaw, width: 500, height: 500, zoom: 2, opacity: () => .4 });
        const mark = view.surfacePoint(plot.id, 50, 50);
        near(mark.world.z, hills.height(plot, 50, 50) + 2);
        near(mark.x, project(50, 50, mark.world.z).x);
        near(mark.y, project(50, 50, mark.world.z).y);
        assert.equal(mark.opacity, .4);
        assert.equal(mark.visible, true);
        assert.equal(view.surfacePoint(plot.id, -1, 50), null);
        assert.equal(view.decorationVisible(-10, -10, mark.depth), false);
        let hidden = 0;
        for (let x = 10; x < 500; x += 10) for (let y = 10; y < 500; y += 10) {
            if (!view.decorationVisible(x, y, -1000)) hidden++;
        }
        assert.ok(hidden > 0, 'foreground slope masks rear decoration strokes');
    }
});

function countingContext(dpr = 1) {
    const strokes = [], dashChanges = [], offsets = [];
    let dash = null, offset, segments = 0;
    return { strokes, dashChanges, offsets, globalAlpha: 1,
        save() {}, restore() {}, beginPath() { segments = 0; }, closePath() {}, fill() {},
        moveTo() {}, lineTo() { segments++; }, getTransform() { return { a: dpr }; },
        stroke() { strokes.push({ color: this.strokeStyle, alpha: this.globalAlpha, segments }); },
        setLineDash(value) {
            const next = JSON.stringify(value);
            assert.notEqual(next, dash, 'setLineDash only runs when the pattern changes');
            dash = next; dashChanges.push(next);
        },
        set lineDashOffset(value) {
            assert.notEqual(value, offset, 'lineDashOffset only changes when needed');
            offset = value; offsets.push(value);
        }
    };
}

test('stipple marks share at most sixteen strokes and offscreen plots draw nothing', async () => {
    const [{ createPlotHills }] = await modules;
    const hills = createPlotHills(), plot = square('dense', 900);
    assert.ok(hills.hill(plot).stipple.marks.length > 80);
    const project = (x, y) => ({ x: x * .5 + 20, y: y * .5 + 20 });
    const view = hills.view([plot], project, { width: 500, height: 500, zoom: .5 });
    const ctx = countingContext(); view.draw(ctx, { traceContour: null });
    const marks = ctx.strokes.filter(s => s.color === '#88accb');
    assert.ok(marks.length > 0 && marks.length <= 16, 'dots and rings batch per opacity bucket');
    assert.ok(marks.reduce((n, s) => n + s.segments, 0) > 40, 'keep stipple density');
    const outside = hills.view([plot], (x, y) => ({ x: x + 2000, y: y + 2000 }),
        { width: 500, height: 500, zoom: 1 });
    const empty = countingContext(); outside.draw(empty, { traceContour: null });
    assert.equal(empty.strokes.length, 0);
});

test('dash fade uses complementary smoothstep passes at device-pixel thresholds', async () => {
    const [{ dashFade }] = await modules;
    for (const [period, t] of [[2, 0], [3, 0], [4.5, .5], [6, 1], [8, 1]]) {
        const fade = dashFade(period / 2, 2);
        near(fade.dashAlpha, t);
        near(fade.solidAlpha, Math.max(.32, Math.min(.75, period / 4)) * (1 - t));
    }
});


test('overview stroke budget keeps the full 88-plot stipple density', async () => {
    const [{ createPlotHills }, { projectGround }, { buildGardenLayout }] = await modules;
    const counts = Array.from({ length: 88 }, (_, i) => i === 0 ? 450 : i === 1 ? 172 : 2);
    const layout = buildGardenLayout(counts.map((sessionCount, i) => ({ id: 'p' + i, sessionCount, work: sessionCount * 5 })));
    const hills = createPlotHills(), zoom = .1;
    const project = (x, y, z) => {
        const p = projectGround(x - layout.bounds.w / 2, y - layout.bounds.h / 2, 0, z);
        return { x: 640 + p.x * zoom, y: 400 + p.y * zoom };
    };
    const view = hills.view(layout.plots, project, { width: 1280, height: 800, zoom });
    const ctx = countingContext(); view.draw(ctx, { traceContour: null });
    assert.ok(ctx.strokes.length <= 4000, `${ctx.strokes.length} strokes exceeds the overview budget`);
    assert.ok(layout.plots.reduce((n, p) => n + hills.hill(p).stipple.marks.length, 0) > 5000);
    assert.equal(ctx.dashChanges.length, 1);
    assert.equal(ctx.offsets.length, 1);
});

test('plot contour passes apply base opacity and omit passes below .01', async () => {
    const [{ createPlotHills, plotContourDashStyle }] = await modules;
    for (const [devicePeriod, t] of [[2, 0], [3, 0], [4.5, .5], [6, 1], [8, 1], [3.01, .00003325925925925784]]) {
        for (const traced of [false, true]) for (const opacity of [1, .01]) {
            const hills = createPlotHills(), plot = square('fade', 900), hill = hills.hill(plot);
            hill.contours = [hill.contours[0]];
            const basePeriod = traced ? 15 : 7;
            const period = plotContourDashStyle(plot.id, 0, 1, 1, basePeriod).period;
            const dpr = devicePeriod / period;
            const view = hills.view([plot], (x, y) => ({ x: x + 20, y: y + 20 }),
                { width: 1000, height: 1000, zoom: 1, opacity: () => opacity });
            const ctx = countingContext(dpr);
            view.draw(ctx, { traceContour: traced ? (target, points, options) => {
                assert.equal(options.solid, false);
                target.moveTo(points[0].x, points[0].y); target.lineTo(points[1].x, points[1].y);
            } : null });
            const passes = ctx.strokes.filter(s => s.color === '#91bce3');
            const expected = [.3 * opacity * t, .3 * opacity * Math.max(.32, Math.min(.75, devicePeriod / 4)) * (1 - t)].filter(a => a >= .01);
            assert.equal(passes.length, expected.length);
            passes.forEach((pass, i) => near(pass.alpha, expected[i]));
        }
    }
});

test('standalone plot dashes stay attached through camera translation', async () => {
    const [{ createPlotHills }] = await modules;
    const hills = createPlotHills(), plot = square('anchored', 100);
    function draw(dx, dy) {
        const view = hills.view([plot], (x, y) => ({ x: x + 40 + dx, y: y + 40 + dy }), { width: 300, height: 300, zoom: 1 });
        const ctx = countingContext(2), points = [];
        ctx.moveTo = (x, y) => points.push([x - dx, y - dy]);
        ctx.lineTo = (x, y) => points.push([x - dx, y - dy]);
        view.draw(ctx, { traceContour: null }); return points;
    }
    const a = draw(0, 0), b = draw(13, 7);
    assert.equal(a.length, b.length);
    a.forEach((point, i) => { near(point[0], b[i][0]); near(point[1], b[i][1]); });
});


test('plot draw preserves an already solid canvas dash state without redundant writes', async () => {
    const [{ createPlotHills }] = await modules;
    const hills = createPlotHills(), ctx = countingContext();
    ctx.getLineDash = () => [];
    Object.defineProperty(ctx, 'lineDashOffset', { get: () => 0, set() { assert.fail('offset is already zero'); } });
    hills.view([square()], (x, y) => ({ x, y }), { width: 200, height: 200, zoom: 1 }).draw(ctx);
    assert.equal(ctx.dashChanges.length, 0);
});

// Concave (jagged-shore) cells: L has a kernel, the comb has none and needs flat pockets.
function concave(id, polygon, centroid) {
    const area = Math.abs(polygon.reduce((s, a, i) => { const b = polygon[(i + 1) % polygon.length]; return s + a.x * b.y - b.x * a.y; }, 0)) / 2;
    return { id, area, polygon, centroid };
}
const ell = () => concave('ell', [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 60 }, { x: 60, y: 60 }, { x: 60, y: 200 }, { x: 0, y: 200 }], { x: 40, y: 40 });
const comb = () => concave('comb', [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 250, y: 200 }, { x: 250, y: 40 }, { x: 200, y: 40 },
    { x: 200, y: 200 }, { x: 150, y: 200 }, { x: 150, y: 40 }, { x: 100, y: 40 }, { x: 100, y: 200 }, { x: 50, y: 200 }, { x: 50, y: 40 }, { x: 0, y: 40 }], { x: 150, y: 20 });
function faceArea(vertices) {
    let sum = 0;
    for (let i = 1; i < vertices.length - 1; i++) sum += ((vertices[i].x - vertices[0].x) * (vertices[i + 1].y - vertices[0].y) - (vertices[i].y - vertices[0].y) * (vertices[i + 1].x - vertices[0].x)) / 2;
    return Math.abs(sum);
}

test('concave cells tile exactly once, keep heights on mesh planes, and never rise outside the cell', async () => {
    const [{ buildPlotHill }, , , { pointInPolygon }] = await modules;
    for (const plot of [ell(), comb()]) {
        const hill = buildPlotHill(plot);
        near(hill.faces.reduce((sum, f) => sum + faceArea(f.vertices), 0) / plot.area, 1, plot.id + ' mesh area must equal cell area');
        for (const face of hill.faces) {
            const p = face.vertices.slice(0, 3).reduce((p, v, i) => { const w = [.2, .3, .5][i]; return { x: p.x + v.x * w, y: p.y + v.y * w, z: p.z + v.z * w }; }, { x: 0, y: 0, z: 0 });
            assert.ok(pointInPolygon(p, plot.polygon), 'every face lies inside the cell');
            assert.ok(Math.abs(hill.height(p.x, p.y) - p.z) < 1e-5, plot.id + ' root must sit on the mesh (visibility slivers are ~1e-7 wide)');
        }
        for (const ring of hill.contours) for (const p of ring) assert.ok(Math.abs(hill.height(p.x, p.y) - p.z) < 1e-5);
        assert.ok(hill.peak > 0 && Math.max(...hill.faces.flatMap(f => f.vertices.map(v => v.z))) <= hill.peak + 1e-9);
        assert.equal(hill.contains(hill.center.x, hill.center.y), true);
    }
    // The comb's teeth are hidden from any single point: they lie flat, beside a raised spine.
    const hill = buildPlotHill(comb());
    assert.ok(hill.height(25, 150) === 0 || hill.height(75, 150) === 0 || hill.height(275, 150) === 0, 'a hidden tooth stays on the ground');
    assert.equal(hill.height(-500, 10), 0);
});

test('concave cells stipple only inside the true polygon and a convex square keeps its stipple', async () => {
    const [{ createPlotHills }, , , { pointInPolygon }] = await modules;
    const hills = createPlotHills();
    for (const plot of [ell(), comb()]) {
        const marks = hills.hill(plot).stipple.marks;
        assert.ok(marks.length > 20, plot.id + ' has stipple marks');
        for (const p of marks) assert.ok(pointInPolygon(p, plot.polygon), 'stipple point stays inside a concave cell');
        const inTeeth = marks.some(p => plot.id === 'comb' ? p.y > 60 : p.x > 100);
        assert.ok(inTeeth, 'stipple reaches the far arms of a concave cell');
    }
    assert.ok(hills.hill(square()).stipple.marks.length > 50);
});

test('lots carry no crosshatch: no two-point diagonal strokes and no hatch data', async () => {
    const [{ createPlotHills }] = await modules;
    const hills = createPlotHills(), hill = hills.hill(square('flat', 900));
    assert.equal(hill.hatches, undefined);
    assert.equal(hill.stipple.material, 'stipple');
    assert.ok(hill.stipple.marks.every(m => Number.isFinite(m.x + m.y + m.z) && typeof m.ring === 'boolean'));
    assert.ok(hill.stipple.marks.some(m => m.ring) && hill.stipple.marks.some(m => !m.ring), 'mix of rings and dots');
    const again = createPlotHills().hill(square('flat', 900)).stipple.marks;
    assert.deepEqual(again.map(m => [m.x, m.y]), hill.stipple.marks.map(m => [m.x, m.y]), 'world-anchored and deterministic');
});

test('concave surface points respect the notch', async () => {
    const [{ createPlotHills }] = await modules;
    const plot = ell(), hills = createPlotHills();
    const view = hills.view([plot], (x, y, z) => ({ x: 100 + x, y: 100 + y - z }), { width: 500, height: 500, zoom: 1 });
    assert.ok(view.surfacePoint('ell', 30, 150));
    assert.equal(view.surfacePoint('ell', 150, 150), null, 'a point in the notch is not on the lot');
});
