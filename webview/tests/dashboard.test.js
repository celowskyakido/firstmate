'use strict';
// Dashboard view-models and chart geometry over a synthetic snapshot (demo-* names only).
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/render');
const C = require('../public/charts');

const HOUR = 3600;
const task = (id, project, state, extra = {}) => ({
  id, kind: 'ship', project, current_state: { state, detail: extra.detail ?? null }, pr: { url: extra.pr ?? null },
  hints: { pending_decision: Boolean(extra.decision), blocked_event: false, open_decisions: extra.decision ? [{ key: id, verb: 'needs-decision', summary: extra.decision }] : [] },
  paths: { status_log: { last_event: extra.age == null ? null : { age_seconds: extra.age } } },
  backlog: { id, title: `Title ${id}`, since: '2026-07-01' },
});
const snapshot = {
  schema: R.SCHEMA,
  tasks: [
    task('demo-a', 'demo-api', 'working', { age: 600 }),
    task('demo-b', 'demo-api', 'blocked', { age: 2 * HOUR }),
    task('demo-c', 'demo-web', 'paused', { decision: 'pick one', age: 30 * HOUR }),
    task('demo-d', 'demo-web', 'done', { pr: 'https://example.invalid/demo/pull/1', detail: 'run passed: PR open', age: 10 * 86400 }),
    task('demo-e', 'demo-web', 'done', { pr: 'https://example.invalid/demo/pull/2', detail: 'run passed: PR merged' }),
    task('demo-f', null, 'unknown'),
    task('demo-g', 'demo-api', 'failed', { age: 20 }),
    task('demo-h', '/tmp/demo/demo-ops', 'working'),
  ],
  backlog: {
    records: [
      { id: 'demo-q1', title: 'Queued one', repo: 'demo-api', state: 'queued', hold_bucket: 'live', hold_reason: 'choose', hold_age_days: 2 },
      { id: 'demo-q2', title: 'Queued two', repo: 'demo-web', state: 'queued' },
      { id: 'demo-x', title: 'Shipped today', repo: 'demo-api', state: 'done', completion: { verb: 'merged', date: '2026-07-08' } },
      { id: 'demo-y', title: 'Shipped before', repo: 'demo-api', state: 'done', completion: { verb: 'merged', date: '2026-07-01' } },
    ],
  },
};

test('state buckets: captain asks and open PRs need you, failed reads as blocked, a merged PR is done', () => {
  const buckets = Object.fromEntries(R.fleetOverview(snapshot).tasks.map((t) => [t.id, R.bucketOf(t)]));
  assert.deepEqual(buckets, { 'demo-a': 'working', 'demo-b': 'blocked', 'demo-c': 'needs', 'demo-d': 'needs', 'demo-e': 'done', 'demo-f': 'unknown', 'demo-g': 'blocked', 'demo-h': 'working' });
  assert.deepEqual(R.stateBreakdown(snapshot).map((b) => [b.key, b.count, b.href]), [
    ['needs', 2, '#/list/state/needs'], ['blocked', 2, '#/list/state/blocked'], ['waiting', 0, '#/list/state/waiting'],
    ['working', 2, '#/list/state/working'], ['done', 1, '#/list/state/done'], ['unknown', 1, '#/list/state/unknown'],
  ]);
});

test('headline counts', () => {
  assert.deepEqual(R.fleetCounts(snapshot, '2026-07-08'), {
    needsYou: 3, needsDecision: 2, reviews: 1, blocked: 2, inProgress: 6, queued: 2, doneToday: 1,
  });
});

test('work by project sorts by size and folds the tail into one row', () => {
  const rows = R.projectBars(snapshot);
  assert.deepEqual(rows.map((r) => [r.project, r.total]), [['demo-api', 3], ['demo-web', 3], ['(no project)', 1], ['demo-ops', 1]]);
  assert.equal(rows[3].href, `#/list/project/${encodeURIComponent('/tmp/demo/demo-ops')}`, 'a clone path shows its folder name but filters on the full value');
  assert.deepEqual(R.listView(snapshot, rows[3].href.slice('#/list/'.length)).items.map((i) => [i.id, i.project]), [['demo-h', 'demo-ops']]);
  assert.deepEqual(rows[0].segments.filter((s) => s.count).map((s) => [s.key, s.count]), [['blocked', 2], ['working', 1]]);
  assert.equal(rows[0].href, '#/list/project/demo-api');
  const folded = R.projectBars(snapshot, 2);
  assert.deepEqual(folded.map((r) => [r.project, r.total]), [['demo-api', 3], ['3 other projects', 5]]);
  assert.equal(folded[1].segments.reduce((n, s) => n + s.count, 0), 5);
});

test('waiting-age histogram covers asks, reviews, and blocked work', () => {
  const { bins, unknownAge } = R.ageHistogram(snapshot);
  assert.deepEqual(bins.map((b) => [b.key, b.count]), [['hour', 1], ['hours', 1], ['day', 0], ['days', 2], ['week', 0], ['older', 1]]);
  assert.equal(unknownAge, 0);
});

test('drill-down lists filter by tile, state, project, and age, oldest first', () => {
  const ids = (filter) => R.listView(snapshot, filter, '2026-07-08').items.map((i) => i.id);
  assert.deepEqual(ids('blocked'), ['demo-b', 'demo-g']);
  assert.equal(R.listView(snapshot, 'blocked').items[1].label, 'Failed');
  assert.deepEqual(ids('reviews'), ['demo-d']);
  assert.deepEqual(ids('needs-decision'), ['demo-q1', 'demo-c']);
  assert.deepEqual(ids('state/working'), ['demo-a', 'demo-h'], 'items with no known age sort last');
  assert.deepEqual(ids(`project/${encodeURIComponent('demo-web')}`), ['demo-d', 'demo-c', 'demo-e', 'demo-q2']);
  assert.deepEqual(ids('age/days'), ['demo-q1', 'demo-c']);
  assert.deepEqual(ids('done-today'), ['demo-x']);
  assert.deepEqual(ids('queued'), ['demo-q1', 'demo-q2']);
  assert.equal(R.listView(snapshot, 'nope'), null);
  assert.equal(R.listView(snapshot, 'blocked').title, 'Blocked');
});

test('task detail carries a plain status label, age, and start date', () => {
  const d = R.taskDetail(snapshot, 'demo-g', null);
  assert.deepEqual([d.statusLabel, d.ageSeconds, d.since], ['Failed', 20, '2026-07-01']);
});

test('machine samples and KPI tiles: tones, notes, and drill links', () => {
  const machine = R.machineSample({
    load: { oneMinute: 25, cores: 10 }, memory: { freeShare: 0.25 }, orphans: [{}],
    sessions: [{ mcpHelpers: 2 }, { mcpHelpers: 3 }],
  });
  assert.deepEqual(machine, { load: 25, cores: 10, memoryInUse: 0.75, sessions: 2, helpers: 5, orphans: 1 });
  assert.deepEqual(R.machineSample({}), { load: null, cores: null, memoryInUse: null, sessions: null, helpers: null, orphans: null });
  const history = { fleet: [{ blocked: 1 }, { blocked: 2 }], machine: [{ load: 5, cores: 10 }, { load: null, cores: 10 }] };
  const tiles = Object.fromEntries(R.kpis({ counts: R.fleetCounts(snapshot), machine, limits: { loadPerCore: 2, claudeSessions: 25 }, history }).map((t) => [t.key, t]));
  assert.deepEqual(Object.keys(tiles), ['needs-decision', 'blocked', 'in-progress', 'reviews', 'queued', 'done-today', 'load', 'sessions', 'orphans']);
  assert.deepEqual([tiles.blocked.value, tiles.blocked.tone, tiles.blocked.href, tiles.blocked.series], ['2', 'alert', '#/list/blocked', [1, 2]]);
  assert.deepEqual([tiles.load.value, tiles.load.tone, tiles.load.note, tiles.load.series], ['250%', 'alert', 'Overloaded', [0.5, null]]);
  assert.deepEqual([tiles.orphans.tone, tiles.sessions.tone, tiles['needs-decision'].tone], ['warn', 'ok', 'warn']);
  const blank = Object.fromEntries(R.kpis({ counts: null, machine: null }).map((t) => [t.key, t]));
  assert.deepEqual([blank.load.value, blank.load.tone, blank.load.note], ['n/a', 'quiet', 'Not measured yet']);
});

test('chart geometry: clean axis ends, gapped stacks, and gaps over missing readings', () => {
  assert.deepEqual([0, 0.3, 7, 11, 23, 250].map(C.niceCeil), [1, 0.5, 10, 20, 25, 250]);
  assert.deepEqual(C.ticks(5, true), [0, 5]);
  assert.deepEqual(C.ticks(10, true), [0, 5, 10]);
  assert.equal(C.linePath([{ x: 0, y: 1 }, { x: 1, y: 2 }, null, { x: 3, y: 4 }, { x: 4, y: 5 }]), 'M0.0 1.0 L1.0 2.0 M3.0 4.0 L4.0 5.0');
  const layout = C.stackLayout([2, 0, 2], 102);
  assert.deepEqual(layout, [{ x: 0, w: 50 }, null, { x: 52, w: 50 }]);
  assert.deepEqual(C.stackLayout([0, 0], 100), [null, null]);
  assert.equal(C.barPath(0, 0, 0, 10, 'right'), '');
  assert.match(C.barPath(0, 0, 50, 20, 'right'), /^M0 0H46Q50 0 50 4V16Q50 20 46 20H0Z$/);
});
