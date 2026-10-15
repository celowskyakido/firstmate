'use strict';
// Stopping stray helpers against an injected process table and kill function: no real process is signalled.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { killStray } = require('../stray-kill');
const { start } = require('../server');
const { makeHome } = require('./fixture');

const UID = 501;
const SELF = 900;
const proc = (pid, ppid, args, { uid = UID, ageSeconds = 7200 } = {}) => ({ pid, ppid, uid, rssBytes: 1024, ageSeconds, args });
const table = () => [
  proc(1, 0, '/sbin/launchd', { uid: 0 }),
  proc(400, 1, 'node /opt/demo/stray.js'),
  proc(401, 1, 'python3 -m demo_helper', { uid: 502 }),
  proc(402, 1, 'node /opt/demo/young.js', { ageSeconds: 60 }),
  proc(403, 1, 'claude --resume'),
  proc(404, 1, '/usr/bin/ssh-agent'),
  proc(405, 1, 'node /opt/demo/parent.js'),
  proc(406, 405, '/usr/bin/caffeinate'),
  proc(407, 1, 'npx demo-mcp-server'),
  proc(408, 407, 'node /opt/demo/mcp-child.js'),
  proc(SELF, 1, 'node webview/server.js'),
  proc(500, 300, 'node /opt/demo/has-parent.js'),
];
const expect = (procs, pid) => { const p = procs.find((x) => x.pid === pid); return { command: p.args, ageSeconds: p.ageSeconds }; };

// A fake kill: `dies` maps a signal to whether the process exits on it.
const fakeKill = (procs, dies) => {
  const alive = new Set(procs.map((p) => p.pid));
  const sent = [];
  const kill = (pid, signal) => {
    if (!alive.has(pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    if (signal === 0) return;
    sent.push(signal);
    if (dies[signal]) alive.delete(pid);
  };
  return { kill, sent };
};
const deps = (procs, kill, extra = {}) => {
  let clock = 0;
  return { listProcesses: async () => procs, kill, uid: UID, selfPid: SELF, now: () => clock, sleep: async (ms) => { clock += ms; }, ...extra };
};

test('a stray that exits on SIGTERM is terminated without SIGKILL', async () => {
  const procs = table();
  const k = fakeKill(procs, { SIGTERM: true });
  assert.deepEqual(await killStray(400, expect(procs, 400), deps(procs, k.kill)), { outcome: 'terminated' });
  assert.deepEqual(k.sent, ['SIGTERM']);
});

test('a stray that ignores SIGTERM for 3 seconds gets SIGKILL', async () => {
  const procs = table();
  const k = fakeKill(procs, { SIGKILL: true });
  assert.deepEqual(await killStray(400, expect(procs, 400), deps(procs, k.kill)), { outcome: 'killed' });
  assert.deepEqual(k.sent, ['SIGTERM', 'SIGKILL']);
  const stubborn = fakeKill(procs, {});
  assert.deepEqual(await killStray(400, expect(procs, 400), deps(procs, stubborn.kill)), { outcome: 'failed', reason: 'still running after SIGKILL' });
});

test('a stray with any child process is refused, since no child of a stray is itself a stray', async () => {
  const procs = table();
  const k = fakeKill(procs, { SIGTERM: true });
  const reason = 'it has child processes, which the stray rules do not cover';
  assert.deepEqual(await killStray(405, expect(procs, 405), deps(procs, k.kill)), { outcome: 'refused', reason });
  assert.deepEqual(await killStray(407, expect(procs, 407), deps(procs, k.kill)), { outcome: 'refused', reason });
  assert.deepEqual(k.sent, []);
});

test('anything that is not a current stray is refused before any signal is sent', async () => {
  const procs = table();
  const refused = async (pid, reason, expected = expect(procs, pid)) => {
    const k = fakeKill(procs, { SIGTERM: true });
    assert.deepEqual(await killStray(pid, expected, deps(procs, k.kill)), { outcome: 'refused', reason }, `pid ${pid}`);
    assert.deepEqual(k.sent, [], `no signal for pid ${pid}`);
  };
  await refused(SELF, 'that is the web view itself');
  await refused(401, 'it belongs to another user');
  await refused(500, 'it has a parent again, so it is not a stray');
  await refused(403, 'it is a Claude session');
  await refused(402, 'it no longer matches the stray helper rules');
  await refused(404, 'it no longer matches the stray helper rules');
  await refused(1, 'it belongs to another user');
});

test('a reused pid is refused: same number, different command or a younger process', async () => {
  const procs = table();
  const k = fakeKill(procs, { SIGTERM: true });
  const changed = 'the process changed since the list was shown; refresh and try again';
  assert.deepEqual(await killStray(400, { command: 'node /opt/demo/other.js', ageSeconds: 7200 }, deps(procs, k.kill)), { outcome: 'refused', reason: changed });
  assert.deepEqual(await killStray(400, { command: 'node /opt/demo/stray.js', ageSeconds: 99999 }, deps(procs, k.kill)), { outcome: 'refused', reason: changed });
  assert.deepEqual(k.sent, []);
  assert.deepEqual(await killStray(999, { command: 'x', ageSeconds: 1 }, deps(procs, k.kill)), { outcome: 'already-gone' });
});

// ---- HTTP guards ----
// An explicit Content-Length, because Node sends DELETE bodies without one.
const request = (port, path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const length = body == null ? {} : { 'Content-Length': Buffer.byteLength(body) };
  const req = http.request({ host: '127.0.0.1', port, path, method, headers: { ...length, ...headers } }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
  });
  req.on('error', reject);
  req.end(body);
});

test('kill endpoint: token, Origin, Host, and content type are all required', async (t) => {
  const home = makeHome();
  const procs = table();
  const k = fakeKill(procs, { SIGTERM: true });
  const app = await start({
    home, port: 0, pollMs: 60_000, resourcesPollMs: 60_000, collectResources: async () => ({}), token: 'demo-token',
    killDeps: deps(procs, k.kill),
  });
  t.after(async () => { await app.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const { port } = app;
  const good = { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'X-Webview-Token': 'demo-token', 'Content-Type': 'application/json' };
  const post = (pid, headers = good, body = JSON.stringify(expect(procs, pid))) => request(port, `/api/stray-helpers/${pid}/kill`, { method: 'POST', headers, body });

  const page = await request(port, '/');
  assert.match(page.body, /<meta name="webview-token" content="demo-token">/, 'the page carries this launch token');

  const omit = (key) => Object.fromEntries(Object.entries(good).filter(([k2]) => k2 !== key));
  assert.equal((await post(400, omit('X-Webview-Token'))).status, 403);
  assert.equal((await post(400, { ...good, 'X-Webview-Token': 'demo-tokeX' })).status, 403);
  assert.equal((await post(400, omit('Origin'))).status, 403);
  assert.equal((await post(400, { ...good, Origin: 'http://evil.example.invalid' })).status, 403);
  assert.equal((await post(400, { ...good, Origin: `http://localhost:${port}` })).status, 403, 'Origin must match the Host the page was loaded from');
  assert.equal((await post(400, { ...good, Host: 'evil.example.invalid' })).status, 421);
  assert.equal((await post(400, { ...good, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(400, good, 'not json')).status, 400);
  assert.equal((await post(400, good, 'x'.repeat(5000))).status, 400);
  assert.deepEqual(k.sent, [], 'no signal before every guard passes');

  const refused = await post(403);
  assert.deepEqual([refused.status, JSON.parse(refused.body)], [409, { pid: 403, outcome: 'refused', reason: 'it is a Claude session' }]);
  const ok = await post(400);
  assert.deepEqual([ok.status, JSON.parse(ok.body)], [200, { pid: 400, outcome: 'terminated' }]);
  assert.deepEqual(k.sent, ['SIGTERM']);
});

test('every other route stays GET-only, and the kill route is POST-only', async (t) => {
  const home = makeHome();
  const app = await start({ home, port: 0, pollMs: 60_000, resourcesPollMs: 60_000, collectResources: async () => ({}), token: 'demo-token' });
  t.after(async () => { await app.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const { port } = app;
  const headers = { Origin: `http://127.0.0.1:${port}`, 'X-Webview-Token': 'demo-token', 'Content-Type': 'application/json' };
  const routes = ['/', '/app.js', '/render.js', '/charts.js', '/theme.js', '/style.css', '/api/snapshot', '/api/resources', '/api/history',
    '/api/task/demo-task-1', '/api/stray-helpers', '/api/stray-helpers/400', '/api/stray-helpers/400/kill/now', '/nope'];
  for (const route of routes) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await request(port, route, { method, headers, body: '{}' });
      assert.deepEqual([res.status, res.headers.allow], [405, 'GET, HEAD'], `${method} ${route}`);
    }
  }
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
    const res = await request(port, '/api/stray-helpers/400/kill', { method, headers });
    assert.deepEqual([res.status, res.headers.allow], [405, 'POST'], `${method} kill route`);
  }
});
