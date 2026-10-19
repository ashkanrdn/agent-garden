const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let weather, arrivals, growth;
const sampleCache = id => growth.sampleContourCloud(weather.createGardenArrivalCloud(id), 8000);
before(async () => {
  const base = path.resolve(__dirname, '../../web');
  weather = await import(pathToFileURL(path.join(base, 'garden-arrival-weather.js')).href);
  arrivals = await import(pathToFileURL(path.join(base, 'procedural-clouds.js')).href);
  growth = await import(pathToFileURL(path.join(base, 'cloud-growth.js')).href);
});

function canvasTrace() {
  const calls = [], stack = [];
  let properties = { globalAlpha: 1 };
  const context = new Proxy({}, {
    get(_, key) {
      if (key in properties) return properties[key];
      if (key === 'createRadialGradient') return (...args) => {
        calls.push(['createRadialGradient', ...args]);
        return { addColorStop: (...stop) => calls.push(['addColorStop', ...stop]) };
      };
      return (...args) => {
        calls.push([key, ...args]);
        if (key === 'save') stack.push({ ...properties });
        if (key === 'restore') properties = stack.pop();
      };
    },
    set(_, key, value) { properties[key] = value; return true; },
  });
  return { context, calls };
}

test('the garden uses the approved metaball preset and stable numeric seeds', () => {
  assert.deepEqual(weather.GARDEN_CONTOUR_PRESET, {
    starts: 5, per: 3, rmin: 19.4, rmax: 25, spread: 1.45, stretch: .66,
    spacing: 6.6, thickness: 5, threshold: .4, mode: 'metaball', fillet: 16.3,
    innerLines: 3, gradient: 'plate', bottomColor: '#8A9FEB', topColor: '#FFC798',
  });
  const id = '019f3a34-110f-7000-8000-000000000001';
  const a = weather.createGardenArrivalCloud(id), b = weather.createGardenArrivalCloud(id);
  assert.equal(a.seed, b.seed);
  assert.equal(typeof a.seed, 'number');
  assert.deepEqual(a.parameters, weather.GARDEN_CONTOUR_PRESET);
  assert.ok(a.leader.length > 0, 'fallback layout keeps a rim-attached leader');
  assert.notEqual(weather.sessionCloudSeed(id), weather.sessionCloudSeed('another-session'));
});

test('arrival weather renders five plates, rain, one attached leader, and bounded local light', () => {
  const cloud = weather.createGardenArrivalCloud('garden-test-session');
  const view = { x: 280, y: 400, scale: .35, yaw: -.25 };
  const wet = arrivals.sampleArrival(6800);
  const painted = canvasTrace();
  const result = weather.drawGardenArrivalCloud(painted.context, cloud, wet, view);
  assert.equal(result.plates, 5);
  assert.equal(result.drops, 62);
  assert.ok(result.segments > 0);
  assert.equal(painted.context.globalAlpha, 1);

  const light = canvasTrace();
  weather.drawGardenArrivalLight(light.context, wet, view);
  assert.equal(light.calls.filter(call => call[0] === 'createRadialGradient').length, 1);
  const gradient = light.calls.find(call => call[0] === 'createRadialGradient');
  const bounds = weather.gardenWeatherBounds({ x: view.x, y: view.y }, view.scale);
  assert.ok(gradient[2] - gradient[6] >= bounds.y);
  assert.ok(gradient[2] + gradient[6] <= bounds.y + bounds.h);
  assert.ok(gradient[1] - gradient[6] >= bounds.x);
  assert.ok(gradient[1] + gradient[6] <= bounds.x + bounds.w);

  const quiet = canvasTrace();
  weather.drawGardenArrivalLight(quiet.context, arrivals.sampleArrival(3000), view);
  assert.equal(quiet.calls.length, 0);
  assert.deepEqual(weather.drawGardenArrivalCloud(quiet.context, cloud, arrivals.sampleArrival(14000), view),
    { plates: 0, drops: 0, segments: 0 });
});

test('capped project arrivals use the contour factory and retain pause and speed behavior', () => {
  const queue = arrivals.createCloudArrivals({ cloudFactory: weather.createGardenArrivalCloud });
  queue.sync([]);
  queue.sync(Array.from({ length: 5 }, (_, i) => ({ id: `session-${i}`, projectId: `project-${i}` })));
  assert.equal(queue.entries().length, 3);
  assert.ok(queue.entries().every(entry => entry.cloud.parameters.mode === 'metaball'));
  queue.advance(1000, { playing: false });
  assert.ok(queue.entries().every(entry => entry.state.elapsed === 0));
  queue.advance(1000, { speed: 2 });
  assert.ok(queue.entries().every(entry => entry.state.elapsed === 2000));
  queue.advance(0, { reducedMotion: true });
  assert.equal(queue.active, false);
});

test('the arrival cloud floats above the canopy and its weather bounds contain it', () => {
  const view = { x: 300, y: 500, scale: .5, yaw: -.25 };
  const treeHeight = 200 * view.scale, canopyTop = view.y - treeHeight, lift = weather.CLOUD_LIFT;
  const bounds = weather.gardenWeatherBounds({ x: view.x, y: view.y }, view.scale);
  const screenY = (p, z) => view.y + ((p.x * Math.sin(-.25) + p.y * Math.cos(-.25)) * .44 - (z + lift)) * view.scale;
  for (const id of ['a', 'b', 'garden-test-session', 'session-9']) {
    const frame = growth.sampleContourCloud(weather.createGardenArrivalCloud(id), 8000);
    const bottom = Math.max(...frame.plates[0].loops.flatMap(l => l.points)
      .map(p => screenY(p, frame.plates[0].z - frame.plates[0].thickness)));
    const gap = (canopyTop - bottom) / treeHeight;
    assert.ok(gap >= .25 && gap <= .4, `gap ${gap} of tree height`);
    const top = Math.min(...frame.plates.flatMap(pl => pl.loops.flatMap(l => l.points.map(p => screenY(p, pl.z)))));
    assert.ok(top >= bounds.y, 'bounds contain the cloud top');
    assert.ok(bottom <= bounds.y + bounds.h);
  }
});

test('lifted rain and leader still run from the cloud bottom down to the tree', () => {
  const view = { x: 300, y: 500, scale: .5, yaw: -.25 };
  const cloud = weather.createGardenArrivalCloud('garden-test-session');
  const wet = arrivals.sampleArrival(6800);
  const painted = canvasTrace();
  const segments = [];
  let from = null;
  const spy = new Proxy(painted.context, { get(t, k) {
    if (k === 'moveTo') return (x, y) => { from = [x, y]; };
    if (k === 'lineTo') return (x, y) => { if (from) segments.push([from[1], y]); };
    return t[k];
  } });
  weather.drawGardenArrivalCloud(spy, cloud, wet, view);
  const canopyTop = view.y - 200 * view.scale;
  const rain = segments.filter(([a, b]) => a !== b);
  assert.ok(rain.length > 0);
  // Nothing is drawn below the ground line, and rain/leader reach the tree (below the canopy top).
  assert.ok(Math.max(...rain.flat()) <= view.y + 60 * view.scale);
  assert.ok(Math.max(...rain.flat()) > canopyTop);
  assert.ok(Math.min(...rain.flat()) < canopyTop, 'weather starts above the canopy');
});
