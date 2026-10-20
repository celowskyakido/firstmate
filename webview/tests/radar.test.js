'use strict';
// Chat radar: schema checks, dismiss/snooze, per-source health, and the write guards (demo-* and example.invalid only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const radar = require('../radar');
const R = require('../public/render');
const { start } = require('../server');

const NOW = Date.parse('2026-07-08T12:00:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const id = (source, n) => `${source}:${String(n).padStart(24, '0')}`;
const source = (extra = {}) => ({ health: 'ok', reason: null, readAt: at(5), maxAgeMinutes: 60, ...extra });
const item = (src, n, extra = {}) => ({
  id: id(src, n), source: src, kind: 'mention', title: `demo-chat-${n}`, link: `https://${src}.example.invalid/m/${n}`, why: 'mentions you',
  who: 'Demo Person', where: null, firstSeen: at(30), lastActivity: at(10 + n), state: 'new', snoozedUntil: null, ...extra,
});
const file = (extra = {}) => ({
  schema: 'fm-radar.v1', generatedAt: at(5), sources: { slack: source(), teams: source() },
  items: [item('slack', 1), item('teams', 2)], ...extra,
});
const makeHome = (value) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webview-radar-'));
  fs.mkdirSync(path.join(home, 'data'));
  fs.mkdirSync(path.join(home, 'state'));
  if (value !== undefined) fs.writeFileSync(path.join(home, 'data', 'radar.json'), typeof value === 'string' ? value : JSON.stringify(value));
  return home;
};

test('schema: unknown schema, non-JSON, and missing top-level or source fields are rejected', () => {
  assert.throws(() => radar.parseRadar(JSON.stringify(file({ schema: 'fm-radar.v2' }))), /unsupported radar schema/);
  assert.throws(() => radar.parseRadar('nope'), /not JSON/);
  for (const key of ['generatedAt', 'sources', 'items']) {
    const value = file();
    delete value[key];
    assert.throws(() => radar.parseRadar(JSON.stringify(value)), /needs generatedAt, sources, and items/, key);
  }
  assert.throws(() => radar.parseRadar(JSON.stringify(file({ sources: { slack: source() } }))), /sources\.teams/);
  assert.throws(() => radar.parseRadar(JSON.stringify(file({ sources: { slack: source({ health: 'fine' }), teams: source() } }))), /sources\.slack/);
});

test('schema: invalid items are dropped and counted, and only schema fields pass through', () => {
  const missing = item('slack', 3);
  delete missing.why;
  const parsed = radar.parseRadar(JSON.stringify(file({
    items: [
      { ...item('slack', 1), body: 'secret message text', text: 'more text' },
      missing,
      item('teams', 4, { why: 'x'.repeat(81) }),
      item('teams', 5, { id: id('slack', 5) }),
      item('slack', 6, { kind: 'keyword' }),
    ],
  })), NOW);
  assert.deepEqual(parsed.items.map((x) => x.id), [id('slack', 1)]);
  assert.equal(parsed.invalidItems, 4);
  assert.equal(parsed.items[0].body, undefined);
  assert.equal(parsed.items[0].text, undefined);
  assert.doesNotMatch(JSON.stringify(parsed), /secret message text|more text/);
});

test('links are limited to http and https', () => {
  const links = ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'http://demo.example.invalid/a', 'https://demo.example.invalid/b', null];
  const parsed = radar.parseRadar(JSON.stringify(file({ items: links.map((link, n) => item('slack', n, { link })) })), NOW);
  assert.deepEqual(parsed.items.map((x) => x.link), [null, null, null, 'http://demo.example.invalid/a', 'https://demo.example.invalid/b', null]);
});

test('dismiss hides an item for good; snooze hides it until it expires', async (t) => {
  const home = makeHome(file({ items: [item('slack', 1), item('teams', 2), item('slack', 3)] }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await radar.recordChoice(home, id('slack', 1), 'dismiss', undefined, NOW);
  const snooze = await radar.recordChoice(home, id('teams', 2), 'snooze', '4h', NOW);
  assert.equal(snooze.until, new Date(NOW + 4 * 3600_000).toISOString());
  const visible = async (now) => (await radar.readRadar(home, now)).items.map((x) => x.id);
  assert.deepEqual(await visible(NOW), [id('slack', 3)]);
  assert.deepEqual(await visible(NOW + 4 * 3600_000 + 1), [id('teams', 2), id('slack', 3)], 'the snooze expired');
  // A later write prunes the expired snooze and keeps the dismiss.
  await radar.recordChoice(home, id('slack', 3), 'snooze', '1d', NOW + 5 * 3600_000);
  const stored = JSON.parse(fs.readFileSync(path.join(home, 'state', 'radar-dismissed.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), [id('slack', 1), id('slack', 3)]);
  assert.equal(stored[id('slack', 1)].until, null);
});

test('one source failed: the other still renders and the failure reads as a failure, not an empty list', async (t) => {
  const home = makeHome(file({
    sources: { slack: source({ health: 'unavailable', reason: 'login needed', readAt: at(300) }), teams: source() },
    items: [item('teams', 2)],
  }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const v = R.radarView(await radar.readRadar(home, NOW));
  assert.deepEqual(v.banners.map((b) => [b.source, b.tone]), [['slack', 'error'], ['teams', 'ok']]);
  assert.match(v.banners[0].text, /^Slack radar failed: login needed/);
  assert.deepEqual(v.groups[0].items.map((x) => x.sourceName), ['Teams']);

  const stale = R.radarView({ present: true, ...radar.parseRadar(JSON.stringify(file({ sources: { slack: source(), teams: source({ readAt: at(120) }) } })), NOW) });
  assert.match(stale.banners[1].text, /^Teams radar is out of date/);
  const never = R.radarView({ present: true, ...radar.parseRadar(JSON.stringify(file({ sources: { slack: source(), teams: source({ health: 'unavailable', reason: 'tab not open', readAt: null }) } })), NOW) });
  assert.match(never.banners[1].text, /^Teams radar failed: tab not open \(never read/);
});

test('Slack and Teams render equally: same row shape, both banners, grouped by kind, newest first', () => {
  const v = R.radarView({ present: true, ...radar.parseRadar(JSON.stringify(file({
    items: [item('teams', 1), item('slack', 2), item('slack', 3, { kind: 'dm' }), item('teams', 4, { kind: 'dm', taskIds: ['demo-task-1'] })],
  })), NOW) });
  assert.deepEqual(v.banners.map((b) => [b.name, b.tone]), [['Slack', 'ok'], ['Teams', 'ok']]);
  assert.deepEqual(v.groups.map((g) => [g.kind, g.items.map((x) => x.sourceName)]), [['mention', ['Teams', 'Slack']], ['dm', ['Slack', 'Teams']]]);
  const shape = (x) => Object.keys(x).sort().join();
  assert.equal(shape(v.groups[0].items[0]), shape(v.groups[0].items[1]));
  assert.equal(v.groups[0].items[0].age, '11 min ago');
  assert.deepEqual([...R.radarByTask(v).keys()], ['demo-task-1']);
});

test('no radar.json: the API says so and the page adds nothing', async (t) => {
  const home = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(await radar.readRadar(home), { present: false });
  assert.equal(R.radarView({ present: false }), null);
  assert.equal(R.radarByTask(null).size, 0);
  fs.writeFileSync(path.join(home, 'data', 'radar.json'), '{"schema":"other"}');
  assert.match(R.radarView(await radar.readRadar(home)).error, /^Chat radar unreadable: unsupported radar schema/);
});

const request = (port, p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data }));
  });
  req.on('error', reject);
  req.end(body);
});

test('server: GET /api/radar, and dismiss/snooze carry the same guards as the stray-helper stop', async (t) => {
  const home = makeHome(file());
  const app = await start({
    home, port: 0, pollMs: 60_000, resourcesPollMs: 60_000, collectResources: async () => ({}), token: 'demo-token', snapshotScript: '/usr/bin/true',
  });
  t.after(async () => { await app.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const { port } = app;
  const good = { Origin: `http://127.0.0.1:${port}`, 'X-Webview-Token': 'demo-token', 'Content-Type': 'application/json' };
  const post = (p, body = '{}', headers = good) => request(port, p, { method: 'POST', headers, body });
  const list = async () => JSON.parse((await request(port, '/api/radar')).body).items.map((x) => x.id);

  assert.deepEqual(await list(), [id('slack', 1), id('teams', 2)]);
  const dismiss = `/api/radar/${id('slack', 1)}/dismiss`;
  assert.equal((await post(dismiss, '{}', { ...good, 'X-Webview-Token': 'wrong-token' })).status, 403);
  assert.equal((await post(dismiss, '{}', { ...good, Origin: 'http://evil.example.invalid' })).status, 403);
  assert.equal((await post(dismiss, '{}', { ...good, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(dismiss, 'not json')).status, 400);
  assert.equal((await request(port, dismiss)).status, 405);
  assert.equal((await post('/api/radar/slack:nothex/dismiss')).status, 400);
  assert.equal((await post(`/api/radar/${id('teams', 2)}/snooze`, '{"for":"1y"}')).status, 400);
  assert.deepEqual(await list(), [id('slack', 1), id('teams', 2)], 'refused writes change nothing');
  assert.equal(fs.existsSync(path.join(home, 'state', 'radar-dismissed.json')), false);

  assert.equal((await post(dismiss)).status, 200);
  assert.equal((await post(`/api/radar/${id('teams', 2)}/snooze`, '{"for":"4h"}')).status, 200);
  assert.deepEqual(await list(), []);
  assert.equal((await request(port, '/api/radar', { method: 'PUT', body: '{}' })).status, 405);
});
