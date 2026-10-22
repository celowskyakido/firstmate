'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { start, parseSnapshot } = require('../server');
const R = require('../public/render');
const { makeHome, XSS } = require('./fixture');

const ROOT = path.resolve(__dirname, '..', '..');
const home = makeHome();
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const real = JSON.parse(execFileSync(path.join(ROOT, 'bin', 'fm-fleet-snapshot.sh'), ['--json'], {
  env: { ...process.env, FM_HOME: home },
}));

const get = (port, p, { headers = {}, method = 'GET' } = {}) => new Promise((resolve, reject) => {
  require('node:http').request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject).end();
});

test('refuses to start without FM_HOME', async () => {
  await assert.rejects(start({ home: undefined, port: 0 }), /FM_HOME is required/);
  const env = { ...process.env };
  delete env.FM_HOME;
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /FM_HOME must be set/);
});

test('parseSnapshot fails loudly on a foreign schema or non-JSON', () => {
  assert.throws(() => parseSnapshot('{"schema":"fm-fleet-snapshot.v2"}'), /unsupported snapshot schema/);
  assert.throws(() => parseSnapshot('nope'), /not JSON/);
  assert.equal(parseSnapshot('{"schema":"fm-fleet-snapshot.v1"}').schema, 'fm-fleet-snapshot.v1');
});

test('server: snapshot proxy, task detail, and guards', async (t) => {
  const app = await start({ home, port: 0, pollMs: 60_000, resourcesPollMs: 60_000, collectResources: async () => ({ alerts: ['demo alert'] }) });
  t.after(() => app.close());
  await app.ready;
  const { port } = app;
  assert.equal(app.server.address().address, '127.0.0.1');

  const snap = await get(port, '/api/snapshot', { headers: { Host: `127.0.0.1:${port}` } });
  assert.equal(snap.status, 200);
  const served = JSON.parse(snap.body);
  assert.equal(served.schema, 'fm-fleet-snapshot.v1');
  assert.deepEqual(served.tasks.map((x) => x.id), real.tasks.map((x) => x.id));
  assert.deepEqual(served.tasks[0].hints.open_decisions, real.tasks[0].hints.open_decisions);
  assert.equal(served.tasks[0].hints.open_decisions[0].summary, `choose ${XSS}`);

  const detail = JSON.parse((await get(port, '/api/task/demo-task-1')).body);
  assert.equal(detail.status_history.length, 2);
  assert.equal(detail.inbox.pending[0].name, '001.msg');
  assert.equal(detail.inbox.handled[0].text.trim(), 'old steer');

  await app.resourcesReady;
  const res = await get(port, '/api/resources');
  assert.deepEqual([res.status, JSON.parse(res.body).alerts, res.headers['x-resources-version']], [200, ['demo alert'], '1']);
  assert.equal((await get(port, '/api/resources', { method: 'POST' })).status, 405);

  const trend = JSON.parse((await get(port, '/api/history')).body);
  assert.equal(trend.windowMs, 3 * 3600_000);
  assert.deepEqual(Object.keys(trend.fleet[0]), ['t', ...Object.keys(R.fleetCounts(real))]);
  assert.deepEqual([trend.fleet[0].decide, trend.fleet[0].aging], [1, 1]);
  assert.deepEqual([trend.machine.length, trend.machine[0].sessions], [1, null], 'a partial reading samples as missing, not zero');
  assert.equal((await get(port, '/api/history', { method: 'POST' })).status, 405);
  assert.deepEqual(JSON.parse((await get(port, '/api/config')).body), { jiraBase: process.env.WEBVIEW_JIRA_BASE || null }, 'no link config in the fixture home');
  for (const file of ['/charts.js', '/theme.js']) assert.equal((await get(port, file)).status, 200, file);

  assert.equal((await get(port, '/api/task/nope')).status, 404);
  assert.equal((await get(port, '/api/task/..%2F..%2Fetc')).status, 404);
  assert.equal((await get(port, '/api/snapshot', { method: 'POST' })).status, 405);
  assert.equal((await get(port, '/api/snapshot', { headers: { Host: 'evil.example.invalid' } })).status, 421);
  assert.equal((await get(port, '/')).status, 200);
  assert.equal((await get(port, '/../server.js')).status, 404);
  assert.match((await get(port, '/')).headers['content-security-policy'], /default-src 'self'/);
});

test('cards: a status decision, a captain hold, and finished work, with worker text kept raw', () => {
  const all = R.cards(real);
  const by = Object.fromEntries(all.map((c) => [c.key, c]));
  const task = by['task:demo-task-1'];
  assert.equal(task.column, 'aging', 'the fixture decision is years old');
  assert.deepEqual(task.decisions.map((d) => [d.key, d.summary]), [['api-shape', `choose ${XSS}`]], 'worker text stays raw; app.js renders it via textContent');
  assert.equal(task.prUrl, 'https://example.invalid/demo/pull/9');
  assert.deepEqual(task.resolve.map((s) => s.text), [`For demo-task-1 (choose ${XSS}): <your answer>`, "bin/fm-send.sh fm-demo-task-1 --resolve-key api-shape '<your answer>'"]);
  const hold = by['hold:demo-held'];
  assert.deepEqual([hold.column, hold.decisions[0].summary, hold.badges], ['decide', 'choose naming', ['Your call']]);
  const done = all.find((c) => c.source === 'finished');
  assert.deepEqual([done.id, done.column, done.date, done.prUrl], ['demo-old', 'done', '2026-07-08', 'https://example.invalid/demo/pull/3']);
});

test('the Machine page works without a fleet snapshot; other pages wait for it', () => {
  assert.equal(R.viewFor('machine', { hasSnapshot: false }), 'machine');
  for (const page of ['board', 'charts', 'list']) {
    assert.equal(R.viewFor(page, { hasSnapshot: false }), 'waiting', page);
    assert.equal(R.viewFor(page, { hasSnapshot: true }), page, page);
  }
  assert.equal(R.machineStatus({ resources: null, error: null }), 'Checking the machine…');
  assert.equal(R.machineStatus({ resources: null, error: 'ps timed out' }), 'The machine check is failing: ps timed out. Retrying.');
  assert.equal(R.machineStatus({ resources: {}, error: 'ps timed out' }), null);
});

test('task detail carries the status history and inbox for known tasks only', () => {
  const detail = R.taskDetail(real, 'demo-task-1', { status_history: ['a'], inbox: { pending: [], handled: [] } });
  assert.deepEqual(detail.statusHistory, ['a']);
  assert.equal(R.taskDetail(real, 'missing'), null);
});

test('freshness banner never replaces data with an error', () => {
  const now = Date.parse('2026-07-08T12:00:00Z');
  assert.deepEqual(R.freshnessBanner({ loading: true, error: null }),
    { tone: 'info', text: 'Loading the first snapshot (can take up to a minute).' });
  assert.equal(R.freshnessBanner({ loading: true, error: 'timed out after 5 ms' }).tone, 'error');
  assert.deepEqual(R.freshnessBanner({ fetchedAt: '2026-07-08T11:58:00Z', refreshing: true, now }),
    { tone: 'info', text: 'Data from 2 min ago · refreshing' });
  assert.deepEqual(R.freshnessBanner({ fetchedAt: '2026-07-08T11:59:30Z', stale: 'exit code 3', now }),
    { tone: 'error', text: 'Data from 30s ago. Last refresh failed: exit code 3.' });
  assert.equal(R.freshnessBanner({ fetchedAt: '2026-07-08T11:59:30Z', now }).tone, 'quiet');
});

test('client refuses a foreign snapshot schema', () => {
  assert.throws(() => R.cards({ schema: 'fm-fleet-snapshot.v2' }), /Unsupported snapshot schema/);
  assert.throws(() => R.taskDetail({}, 'demo-task-1'), /Unsupported snapshot schema/);
});

test('client code never uses HTML-injecting sinks', () => {
  for (const f of ['app.js', 'render.js', 'charts.js', 'theme.js', 'agents-page.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/, f);
  }
});
