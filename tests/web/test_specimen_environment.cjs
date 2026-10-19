const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  seedNumber, seededRandom, hash2, smoothNoise, dashVisible,
} = require('../../web/specimen-environment.js');

test('seeded noise repeats and changes with seed', () => {
  assert.equal(seedNumber('bank-a'), seedNumber('bank-a'));
  assert.notEqual(seedNumber('bank-a'), seedNumber('bank-b'));
  const first = Array.from({ length: 30 }, seededRandom('flowers'));
  assert.deepEqual(first, Array.from({ length: 30 }, seededRandom('flowers')));
  assert.notDeepEqual(first, Array.from({ length: 30 }, seededRandom('reeds')));
  assert(first.every(value => value >= 0 && value < 1));
  for (let i = 0; i < 30; i++) {
    assert.equal(hash2(i, -i, 'shore'), hash2(i, -i, 'shore'));
    const x = i * .31, y = i * .17;
    assert.equal(smoothNoise(x, y, 'shore'), smoothNoise(x, y, 'shore'));
    assert(Math.abs(smoothNoise(Math.round(x) - 1e-7, y, 'shore') -
      smoothNoise(Math.round(x) + 1e-7, y, 'shore')) < 1e-6);
  }
  assert.notEqual(smoothNoise(.34, .67, 'shore'), smoothNoise(.34, .67, 'other'));
});

test('diagonal dash gate repeats and shifts by the bank angle', () => {
  const row = Array.from({ length: 300 }, (_, x) => dashVisible(x, 12));
  assert(row.some(Boolean) && row.some(value => !value));
  for (let x = -60; x <= 60; x += 3) {
    assert.equal(dashVisible(x, 12), dashVisible(x + 15, 12));
    assert.equal(dashVisible(x, 12), dashVisible(x - 3.5, 22));
  }
  assert.equal(dashVisible(0, 0), false);
  assert.equal(dashVisible(7, 0), true);
});

test('geometry marks stay transparent, inherit alpha, and use cool theme colors', () => {
  const env = require('../../web/specimen-environment.js');
  const paints = [], stack = [];
  const ctx = { globalAlpha: .25, save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
    beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, arc() {}, ellipse() {}, closePath() {},
    stroke() { paints.push([this.globalAlpha, this.strokeStyle]); }, fill() { paints.push([this.globalAlpha, this.fillStyle]); },
    fillRect() { assert.fail('world primitives must never paint a rectangle'); } };
  const theme = { canopies: [{ top: '#123456' }, { top: '#234567' }, { top: '#345678' }, { top: '#FEDCBA' }] };
  for (const name of ['drawGroundMarks', 'drawPebbleMarks', 'drawReedMarks', 'drawFlowerMarks']) {
    env[name](ctx, [{ x: 10, y: 20, size: 2, opacity: .6, seed: 7 }], { theme });
    assert.equal(ctx.globalAlpha, .25);
  }
  assert.ok(paints.length > 5);
  assert.ok(paints.every(([alpha]) => alpha <= .15 + 1e-9));
  assert.ok(paints.some(([, color]) => color === '#345678'));
  assert.ok(paints.every(([, color]) => color !== '#FEDCBA'), 'warm ochre belongs only to fruit');
});

test('geometric contour dashes continue across separately drawn segments', () => {
  const { drawContourPath } = require('../../web/specimen-environment.js');
  const strokes = [];
  const ctx = { globalAlpha: .4, save() {}, restore() {}, beginPath() {}, moveTo(x, y) { strokes.push(['m', x, y]); },
    lineTo(x, y) { strokes.push(['l', x, y]); }, stroke() {} };
  drawContourPath(ctx, [{ x: 0, y: 0 }, { x: 30, y: 0 }]);
  const whole = strokes.splice(0);
  drawContourPath(ctx, [{ x: 0, y: 0 }, { x: 15, y: 0 }]);
  drawContourPath(ctx, [{ x: 15, y: 0 }, { x: 30, y: 0 }]);
  assert.deepEqual(strokes, whole);
});

test('contour cadence varies by ID, survives pan, and resolves to a faint solid line at low zoom', () => {
  const { contourDashStyle, traceContourPath } = require('../../web/specimen-environment.js');
  const first = contourDashStyle('island/3', 1, 2);
  assert.deepEqual(first, contourDashStyle('island/3', 1, 2));
  assert.notEqual(first.period, contourDashStyle('island/4', 1, 2).period);
  assert.notEqual(first.phase, contourDashStyle('island/4', 1, 2).phase);
  assert.equal(first.solid, false);
  const low = contourDashStyle('island/3', .02, 2);
  assert.equal(low.solid, true);
  assert.ok(low.alpha < 1);
  const lines = (pan, style) => {
    const calls = [], ctx = { moveTo(x, y) { calls.push(['m', x - pan, y]); },
      lineTo(x, y) { calls.push(['l', x - pan, y]); } };
    traceContourPath(ctx, [{ x: 10 + pan, y: 20 }, { x: 130 + pan, y: 20 }],
      { ...style, origin: { x: pan, y: 0 } });
    return calls;
  };
  const still = lines(0, first), moved = lines(231, first);
  assert.equal(still.length, moved.length);
  still.forEach((part, i) => {
    assert.equal(part[0], moved[i][0]);
    assert.ok(Math.abs(part[1] - moved[i][1]) < 1e-9);
    assert.equal(part[2], moved[i][2]);
  });
  assert.deepEqual(lines(0, low), [['m', 10, 20], ['l', 130, 20]]);
});

test('preview contour rows retain their world position when the viewport pans', () => {
  const { drawDashedContours } = require('../../web/specimen-environment.js');
  const render = (x, y) => {
    const marks = [], ctx = { globalAlpha: 1, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      moveTo(px, py) { marks.push(['m', px - x, py - y]); },
      lineTo(px, py) { marks.push(['l', px - x, py - y]); }, stroke() {} };
    drawDashedContours(ctx, { x, y, w: 90, h: 50 }, { seed: 9, origin: { x, y } });
    return marks;
  };
  const first = render(0, 0), moved = render(200, 80);
  assert.ok(first.length > 10);
  assert.equal(first.length, moved.length);
  first.forEach((mark, i) => {
    assert.equal(mark[0], moved[i][0]);
    assert.ok(Math.abs(mark[1] - moved[i][1]) < 1e-9);
    assert.ok(Math.abs(mark[2] - moved[i][2]) < 1e-9);
  });
});

test('sheet primitives preserve parent opacity and transparent pebble calls do not fill a swatch', () => {
  const env = require('../../web/specimen-environment.js'), paints = [], stack = [];
  const ctx = { globalAlpha: .2, save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
    beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, arc() {}, ellipse() {},
    stroke() { paints.push(this.globalAlpha); }, fill() { paints.push(this.globalAlpha); },
    fillRect() { assert.fail('transparent pebble mode painted its background'); } };
  const rect = { x: 0, y: 0, w: 80, h: 60 };
  for (const name of ['drawShorelinePebbles', 'drawReeds', 'drawFlowerDrifts', 'drawDashedContours']) {
    env[name](ctx, rect, { seed: 42, transparent: true });
    assert.equal(ctx.globalAlpha, .2);
  }
  assert.ok(paints.length > 20 && paints.every(alpha => alpha <= .2));
});

test('contour work stays bounded when a projected line spans an enormous world', () => {
  const { traceContourPath } = require('../../web/specimen-environment.js');
  let count = 0;
  const ctx = { canvas: { width: 800, height: 600 }, getTransform: () => ({ a: 1 }),
    moveTo(x, y) { assert.ok(x >= -2.001 && x <= 802.001); count++; }, lineTo() {} };
  traceContourPath(ctx, [{ x: -1e9, y: 30 }, { x: 1e9, y: 30 }]);
  assert.ok(count > 10 && count < 60);
});


test('dash blend is continuous and monotonic across three to six device pixels', () => {
  const { contourDashStyle, contourDashPasses, drawContourPath } = require('../../web/specimen-environment.js');
  const unit = contourDashStyle('blend', 1, 1).period;
  let previous = null;
  for (let dp = 3; dp <= 6.001; dp += .03) {
    const style = contourDashStyle('blend', dp / unit, 1), x = (dp - 3) / 3;
    assert.ok(Math.abs(style.dashAlpha - x * x * (3 - 2 * x)) < 1e-10);
    assert.ok(Math.abs(style.solidAlpha - .75 * (1 - style.dashAlpha)) < 1e-10);
    if (previous) {
      assert.ok(style.dashAlpha >= previous.dashAlpha);
      assert.ok(style.solidAlpha <= previous.solidAlpha);
      assert.ok(style.dashAlpha - previous.dashAlpha < .016);
    }
    previous = style;
  }
  const mid = contourDashStyle('blend', 4.5 / unit, 1);
  assert.deepEqual(contourDashPasses(mid, 1), [{ solid: false, alpha: .5 }, { solid: true, alpha: .375 }]);
  assert.deepEqual(contourDashPasses(mid, .01), []);
  assert.equal(contourDashPasses(contourDashStyle('blend', 3 / unit, 1), 1).length, 1);
  assert.equal(contourDashPasses(contourDashStyle('blend', 6 / unit, 1), 1).length, 1);
  const strokes = [], stack = [], ctx = { globalAlpha: .5,
    save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() { strokes.push(this.globalAlpha); } };
  drawContourPath(ctx, [{ x: 0, y: 0 }, { x: 100, y: 0 }], { id: 'blend', zoom: 4.5 / unit });
  assert.deepEqual(strokes, [.25, .1875]); assert.equal(ctx.globalAlpha, .5);
});
