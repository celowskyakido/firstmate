'use strict';
// In-memory trend history for the dashboard charts. Kept only while the server
// runs: nothing is written to disk, so a restart starts the charts empty.

// Fixed-capacity ring: pushing past capacity overwrites the oldest sample.
const makeRing = (capacity) => {
  const items = new Array(capacity);
  let next = 0;
  let size = 0;
  return {
    push: (sample) => {
      items[next] = sample;
      next = (next + 1) % capacity;
      size = Math.min(size + 1, capacity);
    },
    values: () => Array.from({ length: size }, (_, i) => items[(next - size + i + capacity) % capacity]),
  };
};

// Averages consecutive samples into at most maxPoints, keeping each group's last
// timestamp. Missing readings (null) are skipped, so a gap never reads as zero.
const downsample = (samples, maxPoints) => {
  if (samples.length <= maxPoints) return samples;
  const size = Math.ceil(samples.length / maxPoints);
  const groups = [];
  for (let i = 0; i < samples.length; i += size) groups.push(samples.slice(i, i + size));
  return groups.map((group) => Object.fromEntries(Object.keys(group[0]).map((key) => {
    if (key === 't') return [key, group[group.length - 1].t];
    const numbers = group.map((s) => s[key]).filter((v) => typeof v === 'number');
    return [key, numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null];
  })));
};

// One series: samples older than windowMs are dropped at read time, because the
// fleet series arrives at the snapshot's pace, slower than the ring is sized for.
const makeSeries = ({ windowMs, sampleMs, now = Date.now }) => {
  const ring = makeRing(Math.ceil(windowMs / sampleMs) + 1);
  return {
    push: (fields) => ring.push({ t: now(), ...fields }),
    read: (maxPoints) => downsample(ring.values().filter((s) => s.t >= now() - windowMs), maxPoints),
  };
};

module.exports = { makeRing, downsample, makeSeries };
