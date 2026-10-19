const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before } = require('node:test');

let sampleFlight, cardFlightPlan, sampleCardFlight, fitCameraToScreenBounds;
before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../web/garden-flight.js'), 'utf8');
  ({ sampleFlight, cardFlightPlan, sampleCardFlight, fitCameraToScreenBounds } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')));
});
const from = { x: -240, y: 400, zoom: .15, auto: true };
const to = { x: 1300, y: 1400, zoom: 1.25, auto: false };

test('camera travel preserves endpoints and clamps progress', () => {
  for (const progress of [-1, 0]) assert.deepEqual(sampleFlight(from, to, progress, 90), from);
  for (const progress of [1, 2]) {
    const result = sampleFlight(from, to, progress, 90);
    for (const key of ['x', 'y', 'zoom']) assert.ok(Math.abs(result[key] - to[key]) < 1e-10);
    assert.equal(result.auto, to.auto);
  }
});

test('large changes of scale remain finite, positive, and deterministic', () => {
  for (const [start, end] of [[from, to], [to, from]]) {
    for (let i = 0; i <= 100; i++) {
      const result = sampleFlight(start, end, i / 100, 90);
      assert.ok(Number.isFinite(result.x) && Number.isFinite(result.y));
      assert.ok(Number.isFinite(result.zoom) && result.zoom > 0);
      assert.deepEqual(result, sampleFlight(start, end, i / 100, 90));
    }
  }
});

test('camera starts and lands gently rather than snapping at full speed', () => {
  const start = sampleFlight(from, to, .001, 90);
  const end = sampleFlight(from, to, .999, 90);
  assert.ok(Math.hypot(start.x - from.x, start.y - from.y) < .001);
  assert.ok(Math.hypot(end.x - to.x, end.y - to.y) < .001);
});

test('card travel pulls back, follows a visible arc, and gently settles on the exact target', () => {
  const start = {...from, yaw: .7}, end = {...to, yaw: .7};
  const plan = cardFlightPlan(start, end, {w:1000,h:700});
  assert.ok(plan.duration > 1100 && plan.duration <= 2200);
  assert.ok(sampleCardFlight(start,end,.2,plan).zoom < start.zoom);
  const middle = sampleCardFlight(start,end,.42,plan);
  assert.ok(Math.abs((middle.y-(start.y+end.y)/2)*middle.zoom) > 15, 'visible curved travel');
  assert.ok(sampleCardFlight(start,end,.84,plan).zoom > end.zoom, 'small landing push');
  assert.ok(sampleCardFlight(start,end,.84,plan).zoom <= end.zoom*1.025+1e-8);
  for (const t of [-1,0]) assert.deepEqual(sampleCardFlight(start,end,t,plan),start);
  for (const t of [1,2]) assert.deepEqual(sampleCardFlight(start,end,t,plan),end);
  for (let i=0;i<=100;i++) {
    const value=sampleCardFlight(start,end,i/100,plan);
    assert.equal(value.yaw,.7);
    assert.ok(value.zoom>0&&value.zoom<=3);
  }
});

test('card timing scales with distance and zoom, while the curve stays within a screen-sized bound', () => {
  const start={x:0,y:0,zoom:1,yaw:0}, near={...start,x:40}, far={...start,x:3000,zoom:.2};
  const view={w:900,h:600};
  assert.ok(cardFlightPlan(start,near,view).duration < cardFlightPlan(start,far,view).duration);
  for (const zoom of [1e-9,.006,.1,1,3]) {
    const a={...start,zoom},b={...far,zoom:3},plan=cardFlightPlan(a,b,view);
    for(let i=0;i<=100;i++) {
      const t=i/100,v=sampleCardFlight(a,b,t,plan);
      assert.ok(Number.isFinite(v.x)&&Number.isFinite(v.y)&&v.zoom>0&&v.zoom<=3+1e-8);
      assert.ok(Math.abs(v.y*v.zoom)<=plan.liftPixels+plan.bendPixels+1e-8);
    }
  }
});

test('card flight is continuous at phase boundaries and retargets from its displayed pose', () => {
  const plan=cardFlightPlan(from,to,{w:1000,h:700}),epsilon=1e-5;
  for(const t of [0,.2,.84,1]) {
    const a=sampleCardFlight(from,to,t-epsilon,plan),b=sampleCardFlight(from,to,t,plan),c=sampleCardFlight(from,to,t+epsilon,plan);
    assert.ok(Math.hypot(c.x-a.x,c.y-a.y)*b.zoom<.1);
    assert.ok(Math.abs(Math.log(c.zoom/a.zoom))<1e-5);
  }
  const displayed=sampleCardFlight(from,to,.45,plan),newTarget={x:-800,y:120,zoom:.8,auto:false};
  const next=cardFlightPlan(displayed,newTarget,{w:1000,h:700});
  assert.deepEqual(sampleCardFlight(displayed,newTarget,0,next),displayed);
  assert.deepEqual(sampleCardFlight(displayed,newTarget,1,next),newTarget);
});


test('fitting includes tall crowns and stops after the view contains them', () => {
  const camera = { x: 0, y: 0, zoom: 1, auto: true };
  const viewport = { x: 20, y: 30, w: 400, h: 300 };
  const bounds = { x: -30, y: -100, w: 500, h: 600 };
  const fitted = fitCameraToScreenBounds(camera, bounds, viewport);
  assert.equal(fitted.zoom, .5);
  assert.equal(fitted.auto, true);
  assert.equal(fitted.x, 0);
  assert.equal(fitted.y, 20);
  const contained = { x: 100, y: 50, w: 200, h: 200 };
  assert.equal(fitCameraToScreenBounds(fitted, contained, viewport), fitted);
});

test('fitting respects the canvas center when controls offset the usable view', () => {
  const camera = { x: 130, y: 240, zoom: .8, auto: true };
  const center = { x: 450, y: 320 };
  const viewport = { x: 32, y: 32, w: 836, h: 520 };
  const bounds = { x: -50, y: -180, w: 1000, h: 850 };
  const fitted = fitCameraToScreenBounds(camera, bounds, viewport, center);
  const x = value => center.x + ((value - center.x) / camera.zoom - fitted.x + camera.x) * fitted.zoom;
  const y = value => center.y + ((value - center.y) / camera.zoom - fitted.y + camera.y) * fitted.zoom;
  assert.ok(x(bounds.x) >= viewport.x - 1e-9);
  assert.ok(x(bounds.x + bounds.w) <= viewport.x + viewport.w + 1e-9);
  assert.ok(y(bounds.y) >= viewport.y - 1e-9);
  assert.ok(y(bounds.y + bounds.h) <= viewport.y + viewport.h + 1e-9);
});
