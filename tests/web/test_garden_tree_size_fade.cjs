const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const load = file => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync('web/' + file, 'utf8')).toString('base64'));

test('bird opacity cycles from zero to 50 percent to zero in 120 seconds', async () => {
  const { birdOpacity } = await load('garden-flock.js');
  assert.equal(birdOpacity(0), 0);
  assert.equal(birdOpacity(60000), .5);
  assert.equal(birdOpacity(120000), 0);
  assert.ok(Math.abs(birdOpacity(30000) - .25) < 1e-12);
  for (let t = 0; t <= 120000; t += 1000) {
    assert.ok(birdOpacity(t) >= 0 && birdOpacity(t) <= .5);
    assert.ok(Math.abs(birdOpacity(t) - birdOpacity(120000 - t)) < 1e-12);
    assert.ok(Math.abs(birdOpacity(t, 27000) - birdOpacity(t + 27000)) < 1e-12);
  }
});

test('bird offsets stay distinct and stable; paused drawing freezes the fade', async () => {
  const { createGardenFlock } = await load('garden-flock.js');
  const flock = createGardenFlock(), stack = [], fills = [], strokes = [];
  const ctx = { globalAlpha: .8, save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
    fill() { fills.push(this.globalAlpha); }, stroke() { strokes.push(this.globalAlpha); },
    setLineDash() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, translate() {}, rotate() {} };
  const records = [{ id: 'root', x: 0, y: 0, width: 30, height: 60,
    agents: Array.from({ length: 30 }, (_, i) => ({ id: 'agent-' + i })) }];
  flock.draw(ctx, records, 0);
  const initial = flock.state();
  assert.equal(new Set(initial.map(b => b.fadeOffset)).size, 30);
  assert.ok(new Set(initial.map(b => Math.floor(b.opacity * 10))).size >= 4);
  for (let t = 100; t <= 1000; t += 100) flock.draw(ctx, records, t);
  const running = flock.state();
  flock.draw(ctx, records, 61000, { enabled: false });
  assert.deepEqual(flock.state(), running);
  assert.deepEqual(running.map(b => b.fadeOffset), initial.map(b => b.fadeOffset));
  assert.ok(fills.every(alpha => alpha >= 0 && alpha <= .4));
  assert.ok(strokes.length && strokes.every(alpha => alpha <= .4 * .42));
  flock.clear(); flock.draw(ctx, records, 0);
  assert.deepEqual(flock.state().map(b => b.fadeOffset), initial.map(b => b.fadeOffset));
});
