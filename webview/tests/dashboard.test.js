'use strict';
// Board classifier, view-models, and chart geometry over synthetic snapshots (demo-* names only).
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/render');
const C = require('../public/charts');

const HOUR = 3600;
const DAY = 86400;
const GENERATED = '2026-07-08T12:00:00Z';
const ago = (seconds) => new Date(Date.parse(GENERATED) - seconds * 1000).toISOString();

const task = (id, state, extra = {}) => ({
  id, kind: extra.kind ?? 'ship', mode: extra.mode ?? 'no-mistakes', project: extra.project ?? 'demo-api',
  current_state: { state, detail: extra.detail ?? null }, pr: { url: extra.pr ?? null },
  hints: { open_decisions: [
    ...(extra.decision ? [{ key: `${id}-q`, verb: 'needs-decision', summary: extra.decision }] : []),
    ...(extra.blocked ? [{ key: `${id}-b`, verb: 'blocked', summary: extra.blocked }] : [])] },
  paths: { status_log: { last_event: extra.age == null ? null : { age_seconds: extra.age } } },
  actions: { steer: `bin/fm-send.sh fm-${id} '<instruction>'`, watch: `bin/fm-peek.sh fm-${id}` },
  backlog: { id, title: `Title ${id}`, since: '2026-07-01', unresolved_blocker_ids: extra.blockers ?? [] },
});
const snap = (tasks, records = [], extra = {}) => ({ schema: R.SCHEMA, generated: GENERATED, tasks, backlog: { records }, ...extra });
const PR = 'https://example.invalid/demo/pull/7';

test('work column comes from structured fields: state, blockers, PR, and delivery mode', () => {
  const t = (state, extra = {}) => ({ state, kind: 'ship', mode: 'no-mistakes', prUrl: null, isPrSettled: false, blockedEvents: [], blockerIds: [], ...extra });
  const cases = [
    [t('working'), 'working'],
    [t('working', { prUrl: PR }), 'working'],
    [t('parked'), 'working'],
    [t('unknown'), 'working'],
    [t('unknown', { prUrl: PR }), 'review'],
    [t('paused', { prUrl: PR, mode: 'direct-PR' }), 'review'],
    [t('blocked'), 'blocked'],
    [t('failed'), 'blocked'],
    [t('working', { blockedEvents: [{ key: 'k' }] }), 'blocked'],
    [t('working', { blockerIds: ['demo-x'] }), 'blocked'],
    [t('done', { prUrl: PR }), 'land'],
    [t('done', { prUrl: PR, mode: 'no-mistakes-prod-only' }), 'land'],
    [t('done', { prUrl: PR, mode: 'direct-PR' }), 'review'],
    [t('done', { prUrl: PR, isPrSettled: true }), 'done'],
    [t('done', { mode: 'local-only' }), 'land'],
    [t('done', { kind: 'scout', mode: 'scout' }), 'review'],
  ];
  cases.forEach(([input, expected]) => assert.equal(R.workColumn(input), expected, JSON.stringify(input)));
});

test('decisions split into fresh and aging at three days; blocked events are never decisions', () => {
  const all = R.cards(snap([
    task('demo-fresh', 'paused', { decision: 'pick one', age: 3 * DAY - 1 }),
    task('demo-old', 'paused', { decision: 'pick two', age: 3 * DAY }),
    task('demo-stuck', 'unknown', { blocked: 'staging image is stale', age: 6 * DAY }),
  ]));
  const col = Object.fromEntries(all.map((c) => [c.id, c.column]));
  assert.deepEqual(col, { 'demo-fresh': 'decide', 'demo-old': 'aging', 'demo-stuck': 'blocked' });
  const stuck = all.find((c) => c.id === 'demo-stuck');
  assert.deepEqual([stuck.decisions, stuck.blockers.events.map((e) => e.summary), stuck.badges], [[], ['staging image is stale'], ['No live status']]);
  assert.deepEqual(stuck.resolve.map((s) => s.text), ['Unblock demo-stuck: <what it should do>', "bin/fm-send.sh fm-demo-stuck --resolve-key demo-stuck-b '<what it should do>'"]);
});

test('captain holds age from when they were set, and work waiting on other work is blocked', () => {
  const records = [
    { id: 'demo-h1', title: 'Name it', repo: 'demo-web', state: 'queued', hold_bucket: 'live', hold_reason: 'choose a name', hold_set: ago(4 * DAY), hold_age_days: 0 },
    { id: 'demo-h2', title: 'Old hold', repo: 'demo-web', state: 'queued', hold_bucket: 'live', hold_reason: 'confirm', hold_age_days: 1 },
    { id: 'demo-h3', title: 'Held and waiting', repo: 'demo-web', state: 'queued', hold_bucket: 'live', hold_reason: 'later', unresolved_blocker_ids: ['demo-h1'] },
    { id: 'demo-next', title: 'Next', repo: 'demo-web', state: 'queued', unresolved_blocker_ids: ['demo-a'] },
    { id: 'demo-idle', title: 'Idle', repo: 'demo-web', state: 'queued', unresolved_blocker_ids: [] },
  ];
  const all = R.cards(snap([task('demo-a', 'working')], records));
  const by = Object.fromEntries(all.map((c) => [c.id, c]));
  assert.deepEqual([by['demo-h1'].column, by['demo-h1'].ageSeconds], ['aging', 4 * DAY]);
  assert.deepEqual([by['demo-h2'].column, by['demo-h2'].ageSeconds], ['decide', DAY]);
  assert.equal(by['demo-h3'].column, 'blocked');
  assert.deepEqual([by['demo-next'].column, by['demo-next'].decisions, by['demo-next'].resolve[0].text], ['blocked', [], 'Starts once demo-a lands.']);
  assert.equal(by['demo-idle'], undefined, 'plain queued work stays off the board');
  assert.deepEqual(by['demo-h1'].resolve.map((s) => s.text), ['Decision on demo-h1: <your call>',
    'bin/fm-captain-hold.sh answer demo-h1 --decision-file <file with your answer> --release']);
});

test('a live hold on a running task makes the task card a decision instead of a second card', () => {
  const t = task('demo-a', 'working', { age: HOUR });
  t.backlog = { ...t.backlog, hold_bucket: 'live', hold_reason: 'approve the plan' };
  const all = R.cards(snap([t], [t.backlog]));
  assert.deepEqual(all.map((c) => [c.key, c.column, c.decisions.map((d) => d.summary)]), [['task:demo-a', 'decide', ['approve the plan']]]);
});

test('second mate decisions join the second mate card once, or stand alone, and age by their own hold', () => {
  const mate = task('demo-mate', 'parked', { kind: 'secondmate', decision: 'from status', age: HOUR });
  const all = R.cards(snap([mate], [], { secondmate_current: { records: [
    { id: 'demo-mate', home: "/tmp/demo homes/mate's", remote: false, decisions_open: [
      { id: 'demo-q', key: 'demo-mate-q', verb: 'needs-decision', summary: 'duplicate of the status one' },
      { id: 'demo-hold', key: 'demo-hold', verb: 'captain-hold', summary: 'its own hold', hold_age_days: 5 }] },
    { id: 'demo-remote', home: '/srv/demo/remote', remote: { host: 'demo-host' }, decisions_open: [{ id: 'demo-r', key: 'demo-r', verb: 'captain-hold', summary: 'remote ask', hold_age_days: 1 }] },
  ] } }));
  const own = all.find((c) => c.id === 'demo-mate');
  assert.deepEqual(own.decisions.map((d) => d.summary), ['from status', 'its own hold']);
  assert.deepEqual([own.column, own.ageSeconds, own.lastUpdateSeconds], ['aging', 5 * DAY, HOUR], 'the 5-day hold ages the card, not the recent update');
  assert.ok(own.badges.includes('Second mate'));
  assert.deepEqual(own.resolve.map((s) => s.text), [
    'For demo-mate (from status): <your answer>',
    "bin/fm-send.sh fm-demo-mate --resolve-key demo-mate-q '<your answer>'",
    'For second mate demo-mate, decision on demo-hold: <your answer>',
    `FM_HOME='/tmp/demo homes/mate'\\''s' bin/fm-captain-hold.sh answer demo-hold --decision-file <file with your answer> --release`,
  ], 'the main-home status decision steers the second mate; its own hold is answered in its own home');
  const remote = all.find((c) => c.source === 'secondmate');
  assert.deepEqual([remote.id, remote.column, remote.ageSeconds], ['demo-r', 'decide', DAY]);
  assert.deepEqual(remote.resolve.map((s) => s.text), ['For second mate demo-remote, decision on demo-r: <your answer>'],
    'no command when the owning home is remote, so nothing can run against this home');
});

test('a live hold ages from when it was set, not from the latest worker update', () => {
  const t = task('demo-a', 'working', { age: 60 });
  t.backlog = { ...t.backlog, hold_bucket: 'live', hold_reason: 'approve the plan', hold_set: ago(4 * DAY) };
  const fallback = task('demo-b', 'working', { age: 60 });
  fallback.backlog = { ...fallback.backlog, hold_bucket: 'live', hold_reason: 'pick a date', hold_age_days: 2 };
  const by = Object.fromEntries(R.cards(snap([t, fallback], [t.backlog, fallback.backlog])).map((c) => [c.id, c]));
  assert.deepEqual([by['demo-a'].column, by['demo-a'].ageSeconds, by['demo-a'].lastUpdateSeconds], ['aging', 4 * DAY, 60]);
  assert.deepEqual([by['demo-b'].column, by['demo-b'].ageSeconds], ['decide', 2 * DAY]);
});

test('the card registry resolves every listed card, beyond the board window and off the board', () => {
  const finished = Array.from({ length: 18 }, (_, i) => ({ id: `demo-done-${i}`, title: `Done ${i}`, repo: 'demo-api', state: 'done',
    completion: { verb: 'merged', date: i < 17 ? '2026-07-08' : '2026-07-01' } }));
  const queued = [{ id: 'demo-plain', title: 'Plain queued', repo: 'demo-api', state: 'queued' },
    { id: 'demo-held', title: 'Held', repo: 'demo-api', state: 'queued', hold_bucket: 'live', hold_reason: 'choose', hold_age_days: 1 }];
  const s = snap([], [...finished, ...queued]);
  assert.equal(R.cards(s).filter((c) => c.column === 'done').length, 15, 'the board keeps its recent window');
  const registry = R.cardRegistry(s);
  const today = R.listView(s, 'done-today', '2026-07-08').cards;
  assert.equal(today.length, 17);
  today.forEach((c) => assert.deepEqual(registry.get(c.key), c, c.key));
  const queuedList = R.listView(s, 'queued').cards;
  assert.deepEqual(queuedList.map((c) => c.key).sort(), ['hold:demo-held', 'queued:demo-plain']);
  queuedList.forEach((c) => assert.deepEqual(registry.get(c.key), c, c.key));
  assert.ok(registry.has('done::demo-done-17'), 'finished work older than the window still opens');
});

test('resolve steps for PRs: merge ready work, review direct PRs, watch working tasks', () => {
  const all = R.cards(snap([
    task('demo-land', 'done', { pr: PR, age: HOUR }),
    task('demo-review', 'done', { pr: PR, mode: 'direct-PR' }),
    task('demo-local', 'done', { mode: 'local-only' }),
    task('demo-run', 'working'),
  ]));
  const steps = Object.fromEntries(all.map((c) => [c.id, c.resolve.map((s) => s.text)]));
  assert.deepEqual(steps['demo-land'], [`Merge ${PR}`, `bin/fm-pr-merge.sh demo-land ${PR}`]);
  assert.deepEqual(steps['demo-review'], [`Merge ${PR}`, 'Changes needed on demo-review: <what to change>']);
  assert.deepEqual(steps['demo-local'], ['Land demo-local', 'bin/fm-merge-local.sh demo-local']);
  assert.deepEqual(steps['demo-run'], ['bin/fm-peek.sh fm-demo-run']);
});

const board = snap([
  task('demo-a', 'working', { age: 600, project: 'demo-api' }),
  task('demo-b', 'blocked', { age: 2 * HOUR }),
  task('demo-c', 'paused', { decision: 'pick a colour', age: 30 * HOUR, project: 'demo-web' }),
  task('demo-d', 'done', { pr: PR, age: 10 * DAY, project: 'demo-web' }),
  task('demo-e', 'done', { pr: PR, detail: 'run passed: PR merged', project: 'demo-web' }),
  task('demo-f', 'working', { project: '/tmp/demo/demo-ops' }),
  task('demo-g', 'failed', { age: 20 }),
], [
  { id: 'demo-q1', title: 'Queued one', repo: 'demo-api', state: 'queued', hold_bucket: 'live', hold_reason: 'choose', hold_age_days: 2 },
  { id: 'demo-q2', title: 'Queued two', repo: 'demo-web', state: 'queued' },
  { id: 'demo-x', title: 'Shipped today', repo: 'demo-api', state: 'done', completion: { verb: 'merged', date: '2026-07-08' } },
  { id: 'demo-y', title: 'Shipped before', repo: 'demo-api', state: 'done', completion: { verb: 'merged', date: '2026-07-01' } },
]);

test('board view: columns in order, oldest first, newest done first, search and project filters', () => {
  const all = R.cards(board);
  const ids = (cols) => Object.fromEntries(cols.map((c) => [c.key, c.cards.map((x) => x.id)]));
  assert.deepEqual(ids(R.boardView(all)), {
    decide: ['demo-q1', 'demo-c'], aging: [], blocked: ['demo-b', 'demo-g'], working: ['demo-a', 'demo-f'],
    review: [], land: ['demo-d'], done: ['demo-e', 'demo-x', 'demo-y'],
  });
  const searched = R.boardView(all, { query: 'COLOUR' });
  assert.deepEqual(searched.flatMap((c) => c.cards.map((x) => x.id)), ['demo-c'], 'search reads decision text, case-insensitively');
  assert.equal(searched.find((c) => c.key === 'decide').total, 2, 'column totals ignore the filter');
  assert.deepEqual(R.boardView(all, { query: 'demo-ops' }).flatMap((c) => c.cards.map((x) => x.id)), ['demo-f'], 'search reads the shown project name');
  assert.deepEqual(R.boardView(all, { project: 'demo-web' }).flatMap((c) => c.cards.map((x) => x.id)), ['demo-c', 'demo-d', 'demo-e']);
  assert.deepEqual(R.projects(all).find((p) => p.label === 'demo-ops'), { value: '/tmp/demo/demo-ops', label: 'demo-ops' });
});

test('headline counts', () => {
  assert.deepEqual(R.fleetCounts(board, '2026-07-08'), {
    needsYou: 3, decide: 2, aging: 0, blocked: 2, working: 2, review: 0, land: 1, queued: 2, inProgress: 5, doneToday: 1,
  });
});

test('charts: state groups in palette order, projects with the tail folded, waiting ages', () => {
  assert.deepEqual(R.stateBreakdown(board).map((g) => [g.key, g.count]), [['needs', 2], ['blocked', 2], ['review', 0], ['working', 2], ['land', 1], ['done', 3]]);
  const rows = R.projectBars(board);
  assert.deepEqual(rows.map((r) => [r.project, r.total]), [['demo-api', 4], ['demo-web', 2], ['demo-ops', 1]]);
  assert.equal(rows[2].href, `#/board?project=${encodeURIComponent('/tmp/demo/demo-ops')}`, 'a clone path shows its folder name but filters on the full value');
  assert.deepEqual(R.projectBars(board, 2).map((r) => [r.project, r.total]), [['demo-api', 4], ['2 other projects', 3]]);
  const { bins, unknownAge } = R.ageHistogram(board);
  assert.deepEqual(bins.map((b) => [b.key, b.count]), [['hour', 1], ['hours', 1], ['day', 0], ['days', 2], ['week', 0], ['older', 1]]);
  assert.equal(unknownAge, 0);
});

test('lists behind charts and tiles', () => {
  const ids = (filter) => R.listView(board, filter, '2026-07-08').cards.map((c) => c.id);
  assert.deepEqual(ids('group/needs'), ['demo-q1', 'demo-c']);
  assert.deepEqual(ids('age/days'), ['demo-q1', 'demo-c']);
  assert.deepEqual(ids('queued'), ['demo-q1', 'demo-q2']);
  assert.deepEqual(ids('done-today'), ['demo-x']);
  assert.equal(R.listView(board, 'nope'), null);
});

test('machine samples and KPI tiles: tones, notes, and drill links', () => {
  const machine = R.machineSample({ load: { oneMinute: 25, cores: 10 }, memory: { freeShare: 0.25 }, orphans: [{}], sessions: [{ mcpHelpers: 2 }, { mcpHelpers: 3 }] });
  assert.deepEqual(machine, { load: 25, cores: 10, memoryInUse: 0.75, sessions: 2, helpers: 5, orphans: 1 });
  assert.deepEqual(R.machineSample({}), { load: null, cores: null, memoryInUse: null, sessions: null, helpers: null, orphans: null });
  const history = { fleet: [{ blocked: 1 }, { blocked: 2 }], machine: [{ load: 5, cores: 10 }, { load: null, cores: 10 }] };
  const tiles = Object.fromEntries(R.kpis({ counts: R.fleetCounts(board), machine, limits: { loadPerCore: 2, claudeSessions: 25 }, history }).map((t) => [t.key, t]));
  assert.deepEqual(Object.keys(tiles), ['decide', 'aging', 'blocked', 'working', 'review', 'land', 'done-today', 'load', 'sessions', 'orphans']);
  assert.deepEqual([tiles.blocked.value, tiles.blocked.tone, tiles.blocked.href, tiles.blocked.series], ['2', 'alert', '#/board/blocked', [1, 2]]);
  assert.deepEqual([tiles.aging.tone, tiles.aging.note], ['ok', 'None overdue']);
  assert.deepEqual([tiles.load.value, tiles.load.tone, tiles.load.note, tiles.load.series], ['250%', 'alert', 'Overloaded', [0.5, null]]);
  assert.deepEqual([tiles.orphans.tone, tiles.sessions.tone, tiles.decide.tone], ['warn', 'ok', 'warn']);
  const blank = Object.fromEntries(R.kpis({ counts: null, machine: null }).map((t) => [t.key, t]));
  assert.deepEqual([blank.load.value, blank.load.tone, blank.load.note], ['n/a', 'quiet', 'Not measured yet']);
});

test('names: clone paths show their folder, PR numbers come from the URL', () => {
  assert.deepEqual([R.projectName('/tmp/demo/demo-ops/'), R.projectName('demo-api'), R.projectName(null)], ['demo-ops', 'demo-api', '(no project)']);
  assert.deepEqual([R.prNumber(PR), R.prNumber('https://example.invalid/demo/-/merge_requests/12'), R.prNumber(null)], ['7', '12', null]);
});

test('chart geometry: clean axis ends, gapped stacks, and gaps over missing readings', () => {
  assert.deepEqual([0, 0.3, 7, 11, 23, 250].map(C.niceCeil), [1, 0.5, 10, 20, 25, 250]);
  assert.deepEqual(C.ticks(5, true), [0, 5]);
  assert.deepEqual(C.ticks(10, true), [0, 5, 10]);
  assert.equal(C.linePath([{ x: 0, y: 1 }, { x: 1, y: 2 }, null, { x: 3, y: 4 }, { x: 4, y: 5 }]), 'M0.0 1.0 L1.0 2.0 M3.0 4.0 L4.0 5.0');
  assert.deepEqual(C.stackLayout([2, 0, 2], 102), [{ x: 0, w: 50 }, null, { x: 52, w: 50 }]);
  assert.deepEqual(C.stackLayout([0, 0], 100), [null, null]);
  assert.equal(C.barPath(0, 0, 0, 10, 'right'), '');
  assert.match(C.barPath(0, 0, 50, 20, 'right'), /^M0 0H46Q50 0 50 4V16Q50 20 46 20H0Z$/);
});
