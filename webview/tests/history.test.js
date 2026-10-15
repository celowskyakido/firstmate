'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRing, downsample, makeSeries } = require('../history');

test('ring keeps the newest samples in order once it wraps', () => {
  const ring = makeRing(3);
  assert.deepEqual(ring.values(), []);
  [1, 2].forEach(ring.push);
  assert.deepEqual(ring.values(), [1, 2]);
  [3, 4, 5].forEach(ring.push);
  assert.deepEqual(ring.values(), [3, 4, 5]);
});

test('downsample averages groups, keeps the last timestamp, and skips missing readings', () => {
  const samples = [
    { t: 1, load: 1, memory: null },
    { t: 2, load: 3, memory: 0.5 },
    { t: 3, load: 5, memory: null },
    { t: 4, load: 7, memory: null },
    { t: 5, load: 9, memory: 0.2 },
  ];
  assert.equal(downsample(samples, 10), samples, 'short series pass through untouched');
  assert.deepEqual(downsample(samples, 2), [{ t: 3, load: 3, memory: 0.5 }, { t: 5, load: 8, memory: 0.2 }]);
  assert.deepEqual(downsample(samples.slice(2, 4), 1), [{ t: 4, load: 6, memory: null }], 'an all-missing group stays missing, not zero');
  assert.ok(downsample(Array.from({ length: 2160 }, (_, t) => ({ t, v: t })), 360).length <= 360);
});

test('series drops samples older than the window and sizes the ring from the sample rate', () => {
  let now = 0;
  const series = makeSeries({ windowMs: 30, sampleMs: 10, now: () => now });
  for (now = 0; now <= 60; now += 10) series.push({ v: now });
  now = 60;
  assert.deepEqual(series.read(100).map((s) => s.v), [30, 40, 50, 60]);
  now = 85;
  assert.deepEqual(series.read(100).map((s) => s.v), [60], 'slow pushes still age out by time');
});
