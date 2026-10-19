const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const fs = require('node:fs');

let createGardenPlayback, GARDEN_PLAYBACK_SPEEDS;
before(async () => {
  const source = fs.readFileSync('web/garden-playback.js', 'utf8');
  ({ createGardenPlayback, GARDEN_PLAYBACK_SPEEDS } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')));
});

test('normal replay reaches the latest day in exactly five minutes', () => {
  const replay = createGardenPlayback({ maxDay: 300 });
  replay.play();
  assert.equal(replay.advance(299999).day, 299);
  assert.equal(replay.advance(1).phase, 'hold');
  assert.equal(replay.state().day, 300);
});

test('double speed reaches the latest day in exactly two minutes thirty seconds', () => {
  const replay = createGardenPlayback({ maxDay: 300 });
  replay.setSpeed(2);
  replay.play();
  assert.equal(replay.advance(149999).day, 299);
  assert.equal(replay.advance(1).phase, 'hold');
  assert.equal(replay.state().day, 300);
});

test('5× and 10× traverse history in one minute and thirty seconds', () => {
  assert.deepEqual(GARDEN_PLAYBACK_SPEEDS, [1, 2, 5, 10]);
  for (const [speed, duration] of [[5, 60000], [10, 30000]]) {
    const replay = createGardenPlayback({ maxDay: 300 });
    replay.setSpeed(speed);
    replay.play();
    assert.equal(replay.advance(duration - 1).day, 299);
    assert.equal(replay.advance(1).phase, 'hold');
    assert.equal(replay.state().day, 300);
  }
});

test('speed changes preserve position, pause, seeking, and hidden-tab suspension', () => {
  const replay = createGardenPlayback({ maxDay: 300 });
  replay.play();
  replay.advance(10000);
  const current = replay.state();
  assert.deepEqual(replay.setSpeed(2), current);
  assert.equal(replay.advance(10000).day, 30);
  replay.pause();
  const paused = replay.state();
  assert.deepEqual(replay.setSpeed(1), paused);
  assert.deepEqual(replay.advance(10000), paused);
  replay.seek(100);
  replay.setSpeed(2);
  replay.play();
  assert.equal(replay.advance(10000, { hidden: true }).day, 100);
  assert.equal(replay.advance(10000).day, 120);
  replay.setSpeed(1);
  assert.equal(replay.advance(10000).day, 130);
});

test('speed changes across all four values preserve position and paused state', () => {
  const replay = createGardenPlayback({ maxDay: 300 });
  replay.seek(75);
  const paused = replay.state();
  for (const speed of GARDEN_PLAYBACK_SPEEDS) {
    assert.deepEqual(replay.setSpeed(speed), paused);
    assert.equal(replay.getSpeed(), speed);
  }
  replay.play();
  replay.advance(1000);
  const playing = replay.state();
  for (const speed of GARDEN_PLAYBACK_SPEEDS) assert.deepEqual(replay.setSpeed(speed), playing);
  replay.setSpeed(99);
  assert.equal(replay.getSpeed(), 1);
});
