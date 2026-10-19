const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

async function moduleAt(name) {
    const source = fs.readFileSync(path.join(__dirname,
        '../../web', name), 'utf8');
    return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

test('idle orbit stays within screen-space bounds and begins and ends still', async () => {
    const { sampleIdleOrbit } = await moduleAt('garden-camera-motion.js');
    for (const zoom of [.006, .4, 3]) {
        const base = Object.freeze({ x: 12, y: 24, zoom, auto: true });
        assert.deepEqual(sampleIdleOrbit(base, 0), base);
        assert.deepEqual(sampleIdleOrbit(base, 48000), base);
        for (let ms = 0; ms < 48000; ms += 137) {
            const sample = sampleIdleOrbit(base, ms);
            assert.ok(Math.abs((sample.x - base.x) * zoom) <= 12.000001);
            assert.ok(Math.abs((sample.y - base.y) * zoom) <= 8.000001);
            assert.equal(sample.zoom, zoom);
            assert.equal(sample.auto, true);
        }
    }
});

test('arrival remains continuous across a new fit and restores the updated base', async () => {
    const { sampleArrivalGlance, sampleAutoFit } = await moduleAt('garden-camera-motion.js');
    const oldBase = { x: 0, y: 0, zoom: .5, auto: true };
    const newBase = { x: 5, y: 3, zoom: .52, auto: true };
    const offset = { x: 1000, y: -1000 };
    const before = sampleArrivalGlance(oldBase, offset, 900).camera;
    const nextFit = sampleAutoFit(oldBase, newBase, 0);
    const after = sampleArrivalGlance(nextFit, offset, 900).camera;
    assert.deepEqual(after, before);
    for (let ms = 901; ms < 2400; ms += 100) {
        const fit = sampleAutoFit(oldBase, newBase, Math.min(1, (ms - 900) / 620));
        const glance = sampleArrivalGlance(fit, offset, ms);
        assert.ok(Number.isFinite(glance.camera.x));
        assert.ok(glance.camera.zoom <= fit.zoom * 1.016);
    }
    assert.deepEqual(sampleArrivalGlance(newBase, offset, 2400), {
        camera: newBase, phase: 'complete', done: true,
    });
});

test('new sprouts stagger 100 ms in stable order and cap at 600 ms', async () => {
    const { createTreeGrowth } = await moduleAt('tree-growth.js');
    const growth = createTreeGrowth();
    growth.sync(Array.from({ length: 9 }, (_, index) => ({
        id: `tree-${8-index}`, score: 2,
    })), 1000);
    for (let index = 0; index < 9; index++) {
        const id = `tree-${index}`;
        const birth = 1000 + Math.min(600, index * 100);
        assert.equal(growth.sample(id, birth - 1).trunk, 0);
        assert.ok(growth.sample(id, birth + 150).trunk > 0);
    }
});
