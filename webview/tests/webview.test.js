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
  const app = await start({ home, port: 0, pollMs: 60_000 });
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

  assert.equal((await get(port, '/api/task/nope')).status, 404);
  assert.equal((await get(port, '/api/task/..%2F..%2Fetc')).status, 404);
  assert.equal((await get(port, '/api/snapshot', { method: 'POST' })).status, 405);
  assert.equal((await get(port, '/api/snapshot', { headers: { Host: 'evil.example.invalid' } })).status, 421);
  assert.equal((await get(port, '/')).status, 200);
  assert.equal((await get(port, '/../server.js')).status, 404);
  assert.match((await get(port, '/')).headers['content-security-policy'], /default-src 'self'/);
});

test('decisions inbox uses the snapshot buckets verbatim', () => {
  const { items } = R.decisionsInbox(real);
  const status = items.find((i) => i.source === 'status');
  assert.equal(status.taskId, 'demo-task-1');
  assert.equal(status.summary, `choose ${XSS}`, 'worker text stays raw; app.js renders it via textContent');
  const hold = items.find((i) => i.source === 'hold');
  assert.deepEqual([hold.id, hold.reason], ['demo-held', 'choose naming']);
});

test('overview and detail view-models carry state, PR, and waiting-on', () => {
  const [row] = R.fleetOverview(real).tasks;
  assert.equal(row.prUrl, 'https://example.invalid/demo/pull/9');
  assert.ok(row.needsCaptain);
  assert.ok(row.waitsOn.some((w) => w.startsWith('needs-decision:')));
  const detail = R.taskDetail(real, 'demo-task-1', { status_history: ['a'], inbox: { pending: [], handled: [] } });
  assert.deepEqual(detail.statusHistory, ['a']);
  assert.equal(R.taskDetail(real, 'missing'), null);
});

test('client refuses a foreign snapshot schema', () => {
  assert.throws(() => R.fleetOverview({ schema: 'fm-fleet-snapshot.v2' }), /Unsupported snapshot schema/);
  assert.throws(() => R.decisionsInbox({}), /Unsupported snapshot schema/);
});

test('client code never uses HTML-injecting sinks', () => {
  for (const f of ['app.js', 'render.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/, f);
  }
});
