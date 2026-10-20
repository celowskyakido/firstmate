'use strict';
// Cancelling held decisions and queued tasks against a fake snapshot and a stubbed
// script runner: no firstmate script ever runs. Synthetic demo-* names only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const R = require('../public/render');
const { start } = require('../server');

const SNAPSHOT = {
  schema: R.SCHEMA, generated: '2026-07-08T12:00:00Z',
  tasks: [{ id: 'demo-live', kind: 'ship', current_state: { state: 'working' }, pr: { url: null }, hints: { open_decisions: [] }, paths: {} }],
  backlog: { records: [
    { id: 'demo-live', title: 'Live work', repo: 'demo', state: 'in_flight' },
    { id: 'demo-held', title: 'Pick a name', repo: 'demo', state: 'queued', kind: 'captain', hold_reason: 'choose naming', hold_kind: 'captain', hold_bucket: 'live' },
    { id: 'demo-dated', title: 'Later call', repo: 'demo', state: 'queued', hold_reason: 'revisit', hold_kind: 'captain', hold_bucket: 'dated' },
    { id: 'demo-queued', title: 'Plain queued', repo: 'demo', state: 'queued', unresolved_blocker_ids: [] },
    { id: 'demo-watched', title: 'Has a PR', repo: 'demo', state: 'queued', pr_url: 'https://example.invalid/demo/pull/4' },
    { id: 'demo-orphan', title: 'In flight, no worker record', repo: 'demo', state: 'in_flight' },
    { id: 'demo-old', title: 'Finished', repo: 'demo', state: 'done' },
  ] },
};

test('only held decisions and queued items with no worker or PR watch can be cancelled', () => {
  const plan = (id) => R.cancelPlan(SNAPSHOT, id);
  assert.equal(plan('demo-held').kind, 'decision');
  assert.equal(plan('demo-dated').kind, 'decision', 'a deferred hold still closes through the hold script');
  assert.equal(plan('demo-queued').kind, 'queued');
  assert.deepEqual(plan('demo-live'), { refusal: 'a worker is on it; ask firstmate to stop it instead' });
  assert.deepEqual(plan('demo-watched'), { refusal: 'it has a pull request that firstmate is watching' });
  assert.deepEqual(plan('demo-orphan'), { refusal: 'it is in flight' });
  assert.deepEqual(plan('demo-old'), { refusal: 'it is already finished' });
  assert.deepEqual(plan('demo-nope'), { refusal: "it is not in this home's backlog", isUnknown: true });

  const registry = R.cardRegistry(SNAPSHOT);
  const offered = [...registry.values()].filter((c) => R.isCancellable(SNAPSHOT, c)).map((c) => c.key).sort();
  assert.deepEqual(offered, ['hold:demo-held', 'queued:demo-dated', 'queued:demo-queued']);
  assert.equal(R.isCancellable(SNAPSHOT, registry.get('task:demo-live')), false, 'a live task card never offers Cancel');
});

test('the confirm dialog requires a reason, and Other requires a short note', () => {
  assert.deepEqual(R.CANCEL_REASONS.map(([, label]) => label), ['Outdated', 'Already handled', 'Other']);
  assert.match(R.cancelReason({}).error, /choose a reason/);
  assert.match(R.cancelReason({ reason: 'delete-everything' }).error, /choose a reason/);
  assert.match(R.cancelReason({ reason: 'other', note: '   ' }).error, /short note/);
  assert.match(R.cancelReason({ reason: 'outdated', note: 'x'.repeat(R.CANCEL_NOTE_MAX + 1) }).error, /200 characters/);
  assert.match(R.cancelReason({ reason: 'outdated', note: 7 }).error, /text/);
  assert.deepEqual(R.cancelReason({ reason: 'outdated' }), { reason: 'outdated', note: '', text: 'Cancelled from the dashboard: outdated' });
  assert.deepEqual(R.cancelReason({ reason: 'other', note: ' superseded\nby demo-x\t ' }),
    { reason: 'other', note: 'superseded by demo-x', text: 'Cancelled from the dashboard: other. Note: superseded by demo-x' }, 'the note collapses to one line');
  assert.equal(R.cancelReason({ reason: 'handled' }).text, 'Cancelled from the dashboard: already handled');
});

// ---- HTTP ----
const request = (port, route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const length = body == null ? {} : { 'Content-Length': Buffer.byteLength(body) };
  const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { ...length, ...headers } }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
  });
  req.on('error', reject);
  req.end(body);
});

const setup = async (t, runner = async () => ({ ok: true, output: '' })) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webview-cancel-home-'));
  fs.mkdirSync(path.join(home, 'state'));
  const script = path.join(home, 'fake-snapshot.sh');
  fs.writeFileSync(path.join(home, 'snapshot.json'), JSON.stringify(SNAPSHOT));
  fs.writeFileSync(script, `#!/bin/sh\ncat ${JSON.stringify(path.join(home, 'snapshot.json'))}\n`, { mode: 0o755 });
  const calls = [];
  const run = async (name, args) => {
    const fileAt = args.indexOf('--decision-file');
    calls.push({ name, args, decision: fileAt >= 0 ? fs.readFileSync(args[fileAt + 1], 'utf8') : null });
    return runner(name, args);
  };
  const app = await start({
    home, port: 0, pollMs: 60_000, resourcesPollMs: 60_000, collectResources: async () => ({}), snapshotScript: script, token: 'demo-token', cancelDeps: { run },
  });
  t.after(async () => { await app.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await app.ready;
  const { port } = app;
  const good = { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'X-Webview-Token': 'demo-token', 'Content-Type': 'application/json' };
  const post = (body, headers = good) => request(port, '/api/cancel', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
    .then((r) => ({ status: r.status, body: JSON.parse(r.body) }));
  const log = () => (fs.existsSync(path.join(home, 'state', 'webview-cancel.log'))
    ? fs.readFileSync(path.join(home, 'state', 'webview-cancel.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { home, port, good, post, calls, log };
};

test('cancel endpoint: POST only, with this page Origin, token, Host, and JSON body', async (t) => {
  const { port, good, post, calls } = await setup(t);
  const body = { id: 'demo-held', reason: 'outdated' };
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
    const res = await request(port, '/api/cancel', { method, headers: good });
    assert.deepEqual([res.status, res.headers.allow], [405, 'POST'], method);
  }
  const omit = (key) => Object.fromEntries(Object.entries(good).filter(([k]) => k !== key));
  assert.equal((await post(body, omit('X-Webview-Token'))).status, 403);
  assert.equal((await post(body, { ...good, 'X-Webview-Token': 'demo-tokeX' })).status, 403);
  assert.equal((await post(body, omit('Origin'))).status, 403);
  assert.equal((await post(body, { ...good, Origin: 'http://evil.example.invalid' })).status, 403);
  assert.equal((await request(port, '/api/cancel', { method: 'POST', headers: { ...good, Host: 'evil.example.invalid' }, body: JSON.stringify(body) })).status, 421);
  assert.equal((await post(body, { ...good, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post({ id: '--release', reason: 'outdated' })).status, 400, 'an id never reaches a script as a flag');
  assert.deepEqual(calls, [], 'no script runs before every guard passes');
});

test('cancel endpoint refuses unknown ids, live work, PR watches, and a missing reason', async (t) => {
  const { home, post, calls, log } = await setup(t);
  const unknown = await post({ id: 'demo-nope', reason: 'outdated' });
  assert.deepEqual([unknown.status, unknown.body.reason], [404, "it is not in this home's backlog"]);
  const live = await post({ id: 'demo-live', reason: 'outdated' });
  assert.deepEqual([live.status, live.body], [409, { id: 'demo-live', outcome: 'refused', reason: 'a worker is on it; ask firstmate to stop it instead' }]);
  assert.equal((await post({ id: 'demo-watched', reason: 'handled' })).status, 409);
  assert.equal((await post({ id: 'demo-orphan', reason: 'handled' })).status, 409);
  assert.equal((await post({ id: 'demo-old', reason: 'handled' })).status, 409);
  assert.equal((await post({ id: 'demo-held' })).status, 400);
  assert.equal((await post({ id: 'demo-held', reason: 'other' })).status, 400);
  // A worker started after the snapshot was taken has a task record already.
  fs.writeFileSync(path.join(home, 'state', 'demo-queued.meta'), 'kind=ship\n');
  const started = await post({ id: 'demo-queued', reason: 'outdated' });
  assert.deepEqual([started.status, started.body.reason], [409, 'a worker was started on it after this page loaded']);
  assert.deepEqual(calls, []);
  assert.deepEqual(log().map((l) => [l.id, l.outcome]), [['demo-nope', 'refused'], ['demo-live', 'refused'], ['demo-watched', 'refused'],
    ['demo-orphan', 'refused'], ['demo-old', 'refused'], ['demo-held', 'refused'], ['demo-held', 'refused'], ['demo-queued', 'refused']]);
});

test('a held decision closes through fm-captain-hold.sh answer, a queued task through tasks-axi done, each logged', async (t) => {
  const { post, calls, log } = await setup(t);
  const held = await post({ id: 'demo-held', reason: 'handled', note: 'done in demo-x' });
  assert.deepEqual([held.status, held.body], [200, { id: 'demo-held', outcome: 'cancelled' }]);
  assert.equal(calls[0].name, 'fm-captain-hold.sh');
  assert.deepEqual([calls[0].args[0], calls[0].args[1], calls[0].args[2], calls[0].args.length], ['answer', 'demo-held', '--decision-file', 4], 'no --release, so the decision closes');
  assert.equal(calls[0].decision, 'Cancelled from the dashboard: already handled. Note: done in demo-x\n');

  const queued = await post({ id: 'demo-queued', reason: 'outdated' });
  assert.equal(queued.status, 200);
  assert.deepEqual(calls[1], { name: 'fm-tasks-axi.sh', args: ['done', 'demo-queued', '--note', 'Cancelled from the dashboard: outdated'], decision: null });

  const lines = log();
  assert.deepEqual(lines.map(({ at, ...rest }) => rest), [
    { id: 'demo-held', reason: 'handled', note: 'done in demo-x', outcome: 'cancelled' },
    { id: 'demo-queued', reason: 'outdated', note: '', outcome: 'cancelled' },
  ]);
  assert.ok(lines.every((l) => !Number.isNaN(Date.parse(l.at))), 'every line is timestamped');
});

test('a script failure is reported plainly with its output and logged as failed', async (t) => {
  const { post, log } = await setup(t, async () => ({ ok: false, output: 'fm-captain-hold: demo refusal' }));
  const res = await post({ id: 'demo-held', reason: 'outdated' });
  assert.deepEqual([res.status, res.body], [500, { id: 'demo-held', outcome: 'failed', reason: 'the firstmate script refused or failed', output: 'fm-captain-hold: demo refusal' }]);
  assert.deepEqual(log().map((l) => l.outcome), ['failed']);
});
