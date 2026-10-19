const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, test } = require('node:test');

let sampleFocusReturn, sampleOverviewDrift;
before(async () => {
    const source = fs.readFileSync(path.join(__dirname,
        '../../web/garden-camera-motion.js'), 'utf8');
    ({ sampleFocusReturn, sampleOverviewDrift } = await import(
        'data:text/javascript;base64,' + Buffer.from(source).toString('base64')));
});

const from = Object.freeze({ x: -200, y: 70, zoom: .4, auto: true, selection: 'session-a' });
const to = Object.freeze({ x: 600, y: 420, zoom: .6, auto: false });

function closeCamera(actual, expected, tolerance = 1e-6) {
    for (const field of ['x', 'y', 'zoom']) {
        assert.ok(Math.abs(actual[field] - expected[field]) < tolerance,
            `${field}: ${actual[field]} differs from ${expected[field]}`);
    }
}

test('focus approaches, holds, and restores the entire starting camera exactly', () => {
    assert.deepEqual(sampleFocusReturn(from, to, -10),
        { camera: from, phase: 'approach', done: false });
    assert.deepEqual(sampleFocusReturn(from, to, 0).camera, from);
    for (const time of [1200, 2400, 4199]) {
        assert.deepEqual(sampleFocusReturn(from, to, time), {
            camera: { ...from, ...to }, phase: 'hold', done: false,
        });
    }
    assert.equal(sampleFocusReturn(from, to, 4200).phase, 'return');
    for (const time of [5700, 5800, Infinity]) {
        assert.deepEqual(sampleFocusReturn(from, to, time),
            { camera: from, phase: 'complete', done: true });
    }
});

test('focus phase boundaries are continuous and sampling cannot alter its inputs', () => {
    for (const boundary of [1200, 4200, 5700]) {
        const before = sampleFocusReturn(from, to, boundary - .000001).camera;
        const after = sampleFocusReturn(from, to, boundary + .000001).camera;
        closeCamera(before, after, .00001);
    }
    const sample = sampleFocusReturn(from, to, 600);
    assert.ok(sample.camera.x > from.x && sample.camera.x < to.x);
    sample.camera.selection = 'changed';
    sample.camera.x = 10000;
    assert.equal(from.selection, 'session-a');
    assert.equal(from.x, -200);
    assert.equal(to.x, 600);
    assert.notEqual(sampleFocusReturn(from, to, 600).camera.x, 10000);
});

test('zero duration phases avoid division by zero and can finish immediately', () => {
    assert.equal(sampleFocusReturn(from, to, 0,
        { approachMs: 0, holdMs: 100, returnMs: 0 }).phase, 'hold');
    assert.deepEqual(sampleFocusReturn(from, to, 100,
        { approachMs: 0, holdMs: 100, returnMs: 0 }).camera, from);
    assert.deepEqual(sampleFocusReturn(from, to, 0,
        { approachMs: 0, holdMs: 0, returnMs: 0 }),
        { camera: from, phase: 'complete', done: true });
});

test('sampling at a timestamp does not depend on intermediate animation frames', () => {
    const direct = sampleFocusReturn(from, to, 4900);
    for (let time = 0; time < 4900; time += 1000 / 144) sampleFocusReturn(from, to, time);
    assert.deepEqual(sampleFocusReturn(from, to, 4900), direct);
    assert.deepEqual(sampleFocusReturn(from, to, 5700).camera, from);
});

test('overview drift remains bounded at wide and close zoom without cumulative movement', () => {
    for (const zoom of [.006, .4, 3]) {
        const base = Object.freeze({ ...from, zoom });
        assert.deepEqual(sampleOverviewDrift(base, 0), base);
        for (let time = 0; time <= 72000; time += 137) {
            const camera = sampleOverviewDrift(base, time);
            assert.ok(Math.abs((camera.x - base.x) * camera.zoom) <= 10.000001);
            assert.ok(Math.abs((camera.y - base.y) * camera.zoom) <= 6.000001);
            assert.ok(camera.zoom >= base.zoom && camera.zoom <= base.zoom * 1.006 + 1e-12);
            assert.equal(camera.auto, base.auto);
            assert.equal(camera.selection, base.selection);
        }
        for (const time of [36000, 72000, 36000 * 10000]) {
            assert.deepEqual(sampleOverviewDrift(base, time), base);
        }
        assert.deepEqual(sampleOverviewDrift(base, 12345), sampleOverviewDrift(base, 48345));
    }
});

test('overview loop is continuous and its initial sample is still for caller motion gating', () => {
    closeCamera(sampleOverviewDrift(from, 35999.999), sampleOverviewDrift(from, 36000.001));
    for (const time of [-10, 0, NaN, Infinity]) {
        assert.deepEqual(sampleOverviewDrift(from, time), from);
    }
    const sample = sampleOverviewDrift(from, 5000);
    sample.x = 10000;
    assert.equal(from.x, -200);
});
