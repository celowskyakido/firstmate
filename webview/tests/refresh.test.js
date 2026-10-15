'use strict';
// Refresh behaviour against a fake snapshot script whose mode is switched
// between polls: ok, fail, slow (sleeps in a grandchild like jq would), or hang.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../server');
const { makeHome } = require('./fixture');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webview-fake-'));
const home = makeHome();
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

const script = path.join(dir, 'fake-snapshot.sh');
fs.writeFileSync(script, `#!/bin/sh
d=${JSON.stringify(dir)}
echo start >> "$d/log"
case "$(cat "$d/mode")" in
  fail) echo boom >&2; exit 3 ;;
  slow) sleep 0.4 ;;
  hang) sleep 30 ;;
esac
echo end >> "$d/log"
printf '{"schema":"fm-fleet-snapshot.v1","generated":"%s","tasks":[],"backlog":{"records":[]}}' "$(cat "$d/mode")"
`, { mode: 0o755 });
const setMode = (mode) => fs.writeFileSync(path.join(dir, 'mode'), mode);

const get = async (port) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
  return { status: res.status, headers: res.headers, body: await res.json() };
};
const until = async (check, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) {
    const value = await check();
    if (value) return value;
  }
  throw new Error('condition not met in time');
};

test('first load reports loading, then a timeout with its real reason, without waiting for grandchildren', async (t) => {
  setMode('hang');
  // Long enough that the first request lands before the timeout even on a loaded CI runner.
  const app = await start({ home, port: 0, pollMs: 60_000, snapshotTimeoutMs: 1500, snapshotScript: script, collectResources: async () => ({}) });
  t.after(() => app.close());
  const loading = await get(app.port);
  assert.equal(loading.status, 503);
  assert.deepEqual([loading.body.loading, loading.body.refreshing, loading.body.error], [true, true, null]);
  const began = Date.now();
  await app.ready;
  assert.ok(Date.now() - began < 5000, 'the hung grandchild was killed with the process group');
  const failed = await get(app.port);
  assert.equal(failed.status, 503);
  assert.match(failed.body.error, /fm-fleet-snapshot\.sh failed: timed out after 1500 ms/);
});

test('a failed refresh keeps serving the last good snapshot with the exit code and stderr', async (t) => {
  setMode('ok');
  const app = await start({ home, port: 0, pollMs: 50, snapshotTimeoutMs: 5000, snapshotScript: script, collectResources: async () => ({}) });
  t.after(() => app.close());
  await app.ready;
  const good = await get(app.port);
  assert.equal(good.status, 200);
  assert.equal(good.body.generated, 'ok');
  assert.equal(good.headers.get('x-snapshot-stale'), null);

  setMode('fail');
  const stale = await until(async () => { const r = await get(app.port); return r.headers.get('x-snapshot-stale') && r; });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.generated, 'ok', 'data is not replaced by the error');
  assert.equal(stale.headers.get('x-snapshot-version'), good.headers.get('x-snapshot-version'));
  assert.equal(decodeURIComponent(stale.headers.get('x-snapshot-stale')), 'fm-fleet-snapshot.sh failed: exit code 3: boom');

  setMode('slow');
  const refreshing = await until(async () => { const r = await get(app.port); return r.headers.get('x-snapshot-refreshing') && r; });
  assert.equal(refreshing.body.generated, 'ok', 'still serving the last good snapshot mid-refresh');
  const fresh = await until(async () => { const r = await get(app.port); return r.body.generated === 'slow' && r; });
  assert.equal(fresh.headers.get('x-snapshot-stale'), null);
});

test('polls never overlap even when a run outlasts the poll interval', async (t) => {
  setMode('slow');
  fs.writeFileSync(path.join(dir, 'log'), '');
  const app = await start({ home, port: 0, pollMs: 10, snapshotTimeoutMs: 5000, snapshotScript: script, collectResources: async () => ({}) });
  t.after(() => app.close());
  await until(() => fs.readFileSync(path.join(dir, 'log'), 'utf8').split('\n').filter((l) => l === 'end').length >= 2);
  await app.close();
  const log = fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n');
  log.forEach((line, i) => assert.equal(line, i % 2 ? 'end' : 'start', `overlapping run at line ${i}: ${log.join(',')}`));
});
