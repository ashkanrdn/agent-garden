const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const fs = require('node:fs');

let createGardenPlayback;
before(async () => {
  const source = fs.readFileSync('web/garden-playback.js', 'utf8');
  ({ createGardenPlayback } = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')));
});

test('default playback traverses exact duration, holds, then softly resets', () => {
  const playback = createGardenPlayback({ maxDay: 4 });
  assert.deepEqual(playback.state(), { day: 0, playing: false, phase: 'traversal', opacity: 1 });
  playback.play();
  playback.advance(300000);
  assert.deepEqual(playback.state(), { day: 4, playing: true, phase: 'hold', opacity: 1 });
  playback.advance(900);
  assert.deepEqual(playback.state(), { day: 4, playing: true, phase: 'hold', opacity: 1 });
  playback.advance(900);
  assert.deepEqual(playback.state(), { day: 4, playing: true, phase: 'reset', opacity: 1 });
  playback.advance(250);
  assert.deepEqual(playback.state(), { day: 0, playing: true, phase: 'reset', opacity: 0 });
  playback.advance(250);
  assert.deepEqual(playback.state(), { day: 0, playing: true, phase: 'traversal', opacity: 1 });
});

test('play, pause, and seek preserve progress and interruption intent', () => {
  const playback = createGardenPlayback({ maxDay: 2, durationMs: 1000, holdMs: 100, resetMs: 100 });
  playback.play();
  playback.advance(490);
  playback.pause();
  const paused = playback.state();
  playback.advance(5000);
  assert.deepEqual(playback.state(), paused);
  playback.play();
  playback.advance(10);
  assert.equal(playback.state().day, 1);
  playback.seek(0);
  assert.deepEqual(playback.state(), { day: 0, playing: true, phase: 'traversal', opacity: 1 });
  playback.advance(500);
  assert.equal(playback.state().day, 1);
  playback.pause();
  playback.seek(2);
  assert.deepEqual(playback.state(), { day: 2, playing: false, phase: 'traversal', opacity: 1 });
  playback.play();
  assert.deepEqual(playback.state(), { day: 0, playing: true, phase: 'traversal', opacity: 1 });
});

test('hidden playback consumes no elapsed time and reduced motion skips reset visual', () => {
  const playback = createGardenPlayback({ maxDay: 1, durationMs: 1000, holdMs: 100, resetMs: 100 });
  playback.play();
  playback.advance(1000);
  const latest = playback.state();
  playback.advance(2000, { hidden: true });
  assert.deepEqual(playback.state(), latest);
  playback.advance(100, { reducedMotion: true });
  assert.deepEqual(playback.state(), { day: 0, playing: true, phase: 'traversal', opacity: 1 });
});

test('zero and one-day histories remain finite and obey boundaries', () => {
  const single = createGardenPlayback({ maxDay: 0, durationMs: 0, holdMs: 0, resetMs: 0 });
  single.play();
  single.advance(Number.POSITIVE_INFINITY);
  assert.deepEqual(single.state(), { day: 0, playing: true, phase: 'traversal', opacity: 1 });

  const oneDay = createGardenPlayback({ maxDay: 1, durationMs: 100, holdMs: 0, resetMs: 0 });
  oneDay.play();
  oneDay.advance(99);
  assert.equal(oneDay.state().day, 0);
  oneDay.advance(1);
  assert.deepEqual(oneDay.state(), { day: 0, playing: true, phase: 'traversal', opacity: 1 });
  assert.deepEqual(oneDay.play(1), { day: 1, playing: true, phase: 'traversal', opacity: 1 });
  assert.deepEqual(oneDay.play(), { day: 0, playing: true, phase: 'traversal', opacity: 1 });
});

test('days clamp to integer boundaries and snapshots cannot mutate controller state', () => {
  const playback = createGardenPlayback({ maxDay: 3, durationMs: 1000 });
  assert.equal(playback.seek(-10).day, 0);
  assert.equal(playback.seek(99.9).day, 3);
  const state = playback.state();
  state.day = 99;
  state.opacity = -1;
  assert.deepEqual(playback.state(), { day: 3, playing: false, phase: 'traversal', opacity: 1 });
  playback.play();
  playback.advance(-20);
  assert.equal(playback.state().day, 0);
});

test('every day survives an exact seek on a year-long history', () => {
  const playback = createGardenPlayback({ maxDay: 365, durationMs: 60000 });
  for (let day = 0; day <= 365; day++) assert.equal(playback.seek(day).day, day);
});
