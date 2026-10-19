const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before } = require('node:test');

let plantTrees, pointInPolygon, insetPolygon, buildGardenLayout, isConvexPolygon, boundaryDistance, triangulatePolygon, polygonCenter, frontAnchor;
before(async () => {
    const load = name => {
        const source = fs.readFileSync(path.join(__dirname, '../../web/' + name), 'utf8');
        return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    };
    ({ plantTrees, pointInPolygon, insetPolygon, isConvexPolygon, boundaryDistance, triangulatePolygon, polygonCenter, frontAnchor } = await load('tree-placement.js'));
    ({ buildGardenLayout } = await load('garden-layout.js'));
});

const cell = [{ x: -130, y: -80 }, { x: 90, y: -110 }, { x: 150, y: 40 }, { x: 65, y: 140 }, { x: -110, y: 90 }];
const ids = count => Array.from({ length: count }, (_, i) => 'session-' + String(i).padStart(5, '0'));
function edgeDistance(p, a, b) {
    return ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / Math.hypot(b.x - a.x, b.y - a.y);
}
function check(result, polygon, expected) {
    assert.deepEqual(result.points.map(p => p.id).sort(), [...expected].sort(), 'exactly one tree represents each session');
    for (const p of result.points) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
        if (isConvexPolygon(polygon)) for (let i = 0; i < polygon.length; i++) {
            assert.ok(edgeDistance(p, polygon[i], polygon[(i + 1) % polygon.length]) >= result.edgeInset - 1e-6, 'tree anchor stays inside every inset half-plane');
        } else {
            assert.ok(pointInPolygon(p, polygon), 'tree anchor stays inside a concave cell');
            assert.ok(boundaryDistance(p, polygon) >= result.edgeInset - 1e-6, 'tree anchor keeps the edge inset from every shore edge');
        }
        assert.ok(p.x >= result.bounds.x - 1e-7 && p.x <= result.bounds.x + result.bounds.w + 1e-7);
        assert.ok(p.y >= result.bounds.y - 1e-7 && p.y <= result.bounds.y + result.bounds.h + 1e-7);
    }
    for (let i = 0; i < result.points.length; i++) {
        for (const q of result.points.slice(i + 1)) {
            assert.ok(Math.hypot(q.x - result.points[i].x, q.y - result.points[i].y) + 1e-7 >= result.minSpacing, 'reported minimum spacing is conservative');
        }
    }
}

test('irregular planting keeps exact counts, an edge inset, and minimum spacing', () => {
    for (const count of [0, 1, 3, 17, 100, 350]) {
        const result = plantTrees(ids(count), cell, { seed: 'test-grove' });
        check(result, cell, ids(count));
        assert.ok(result.edgeInset > 0);
        if (count > 1) assert.ok(result.minSpacing > 0);
    }
});

test('stable session IDs determine positions independently of input order', () => {
    const input = ids(80);
    const first = plantTrees(input, cell, { seed: 'test-grove' });
    assert.deepEqual(first, plantTrees([...input].reverse(), cell, { seed: 'test-grove' }));
    assert.deepEqual(first, plantTrees(input, cell, { seed: 'test-grove' }));
    assert.notDeepEqual(first.points, plantTrees(input, cell, { seed: 'another-grove' }).points);
    assert.equal(new Set(first.points.map(p => p.x.toFixed(6))).size, input.length, 'no shared grid columns');
    assert.equal(new Set(first.points.map(p => p.y.toFixed(6))).size, input.length, 'no shared grid rows');
    const distances = first.points.slice(1).map(p => Math.hypot(p.x - first.points[0].x, p.y - first.points[0].y));
    assert.ok(new Set(distances.map(d => d.toFixed(1))).size > input.length * .8, 'offsets are irregular, not a regular ring');
});

test('narrow cells and dense requests finish without losing sessions', () => {
    const narrow = [{ x: 0, y: 0 }, { x: 900, y: 1 }, { x: 500, y: 2 }];
    check(plantTrees(ids(400), narrow), narrow, ids(400));
    const dense = plantTrees(ids(1200), cell, { edgeInset: 400 });
    check(dense, cell, ids(1200));
    assert.ok(dense.edgeInset < 400, 'oversized inset adapts to the available interior');
});

test('history rebuilds retain every born project and every born session', () => {
    const projects = Array.from({ length: 30 }, (_, i) => ({ id: 'project-' + i, birth: i, work: 10 + i * 4, sessionCount: i % 13 }));
    for (const day of [0, 3, 14, 29]) {
        const layout = buildGardenLayout(projects, { day });
        assert.equal(layout.plots.length, projects.filter(p => p.birth <= day).length);
        let count = 0;
        for (const plot of layout.plots) {
            const sessions = ids(plot.sessionCount).map(id => plot.id + '/' + id);
            const placement = plantTrees(sessions, plot.polygon, { seed: plot.id });
            check(placement, plot.polygon, sessions); count += placement.points.length;
        }
        assert.equal(count, projects.filter(p => p.birth <= day).reduce((sum, p) => sum + p.sessionCount, 0));
    }
});

test('polygon hit tests exclude empty corners of the bounding box', () => {
    assert.equal(pointInPolygon({ x: 140, y: -100 }, cell), false);
    assert.equal(pointInPolygon({ x: 0, y: 0 }, cell), true);
    assert.equal(pointInPolygon(cell[0], cell), true);
    const normalized = polygon => polygon.map(p => p.x.toFixed(6) + ',' + p.y.toFixed(6)).sort();
    assert.deepEqual(normalized(insetPolygon([...cell].reverse(), 10)), normalized(insetPolygon(cell, 10)), 'clockwise input retains the same safe interior');
    assert.throws(() => plantTrees(['same', 'same'], cell), /Duplicate/);
    assert.throws(() => plantTrees(['one'], [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]), /nondegenerate/);
});

const areaOf = polygon => Math.abs(polygon.reduce((sum, a, i) => { const b = polygon[(i + 1) % polygon.length]; return sum + a.x * b.y - b.x * a.y; }, 0)) / 2;
const notchU = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 260, y: 300 }, { x: 260, y: 90 }, { x: 140, y: 90 }, { x: 140, y: 300 }, { x: 0, y: 300 }];
const bay = [{ x: 0, y: 0 }, { x: 500, y: 20 }, { x: 420, y: 160 }, { x: 520, y: 420 }, { x: 250, y: 300 }, { x: 60, y: 460 }, { x: 120, y: 200 }];

test('concave cells keep every tree inside with a true shore inset and recover planting area', () => {
    for (const polygon of [notchU, [...notchU].reverse(), bay]) {
        assert.equal(isConvexPolygon(polygon), false);
        for (const count of [1, 9, 60, 200]) {
            const result = plantTrees(ids(count), polygon, { seed: 'concave', edgeInset: 14 });
            check(result, polygon, ids(count));
            assert.ok(result.edgeInset > 0);
            assert.ok(areaOf(result.polygon) > areaOf(polygon) * .6, 'the planting polygon keeps most of a concave cell, not a convex kernel');
        }
    }
    // Trees reach the arms of the U, which a half-plane clip (the U kernel is empty) would have cut away.
    const arms = plantTrees(ids(300), notchU, { seed: 'arms', edgeInset: 14 });
    assert.ok(arms.points.some(p => p.x < 130 && p.y > 200) && arms.points.some(p => p.x > 270 && p.y > 200));
    assert.ok(arms.points.every(p => !(p.x > 140 && p.x < 260 && p.y > 90)), 'no tree stands in the notch');
});

test('concave planting is deterministic and independent of input order', () => {
    const input = ids(70);
    assert.deepEqual(plantTrees(input, bay, { seed: 'c' }), plantTrees([...input].reverse(), bay, { seed: 'c' }));
});

test('ear clipping tiles simple polygons of either winding; anchors stay interior', () => {
    for (const polygon of [notchU, [...notchU].reverse(), bay]) {
        const triangles = triangulatePolygon(polygon);
        assert.equal(triangles.length, polygon.length - 2);
        near(triangles.reduce((sum, [a, b, c]) => sum + areaOf([polygon[a], polygon[b], polygon[c]]), 0), areaOf(polygon));
        assert.equal(pointInPolygon(polygonCenter(polygon), polygon), true);
        for (const amount of [.2, .5, .62, 1]) assert.equal(pointInPolygon(frontAnchor(polygon, amount), polygon), true);
    }
    const offset = insetPolygon(notchU, 10);
    assert.ok(areaOf(offset) < areaOf(notchU) && areaOf(offset) > areaOf(notchU) * .8);
    for (const p of offset) assert.ok(pointInPolygon(p, notchU) && boundaryDistance(p, notchU) >= 10 - 1e-6);
});
function near(a, b) { assert.ok(Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b)), a + ' != ' + b); }
