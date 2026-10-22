'use strict';
// Radar browser and Teams scan: launcher arguments, readiness detection on invented pages, backoff, the persistent tab,
// the pass lock, and keeping the last good Teams data with a stale-since time. No real Chrome or account is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const radar = require('../radar');
const { DEFAULT_PORT, poll, chromeConfig, launchCommand } = require('../radar-producer/chrome');
const { QUIET_MS, probe, classify, scanTeams } = require('../radar-producer/teams-scan');
const { merge, DEFAULTS } = require('../radar-producer/merge');

const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-chrome-'));
  for (const d of ['config', 'data', 'state/radar-producer']) fs.mkdirSync(path.join(home, d), { recursive: true });
  return home;
};

test('launcher: a separate background instance on the dedicated profile, debugging on 127.0.0.1 only, with no startup window', (t) => {
  const home = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cfg = chromeConfig(home);
  assert.equal(cfg.port, DEFAULT_PORT);
  assert.notEqual(DEFAULT_PORT, 9222, 'not the well-known debugging port');
  assert.equal(cfg.profileDir, path.join(home, 'state', 'radar-chrome-profile'));
  const mac = launchCommand(cfg, 'darwin');
  assert.equal(mac.cmd, 'open');
  assert.deepEqual(mac.args.slice(0, mac.args.indexOf('--args')), ['-n', '-g', '-j', '-a', '/Applications/Google Chrome.app']);
  for (const flag of [`--user-data-dir=${cfg.profileDir}`, `--remote-debugging-port=${DEFAULT_PORT}`, '--remote-debugging-address=127.0.0.1',
    '--no-startup-window', '--no-first-run', '--disable-backgrounding-occluded-windows']) assert.ok(mac.args.includes(flag), flag);
  assert.equal(mac.args.some((a) => /^https?:/.test(a)), false, 'no page opens at launch');
  fs.writeFileSync(path.join(home, 'config', 'radar.json'), JSON.stringify({ chrome: { port: 9444, binary: '/opt/demo/chrome' } }));
  const linux = launchCommand(chromeConfig(home), 'linux');
  assert.equal(linux.cmd, '/opt/demo/chrome');
  assert.ok(linux.args.includes('--remote-debugging-port=9444'));
  assert.equal(launchCommand({ ...cfg, binary: null }, 'linux').cmd, 'google-chrome');
  for (const port of [80, 70000, '9333']) {
    fs.writeFileSync(path.join(home, 'config', 'radar.json'), JSON.stringify({ chrome: { port } }));
    assert.throws(() => chromeConfig(home), /chrome\.port/);
  }
});

test('poll: exponential backoff capped at the max, stops when done, and gives up at the timeout with the last value', async () => {
  let clock = 0;
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); clock += ms; };
  const now = () => clock;
  let reads = 0;
  const done = await poll(async () => ++reads, (n) => n === 4, { timeoutMs: 60_000, sleep, now });
  assert.equal(done, 4);
  assert.deepEqual(sleeps, [500, 1000, 2000]);
  sleeps.length = 0;
  const last = await poll(async () => 'loading', () => false, { timeoutMs: 20_000, sleep, now });
  assert.equal(last, 'loading');
  assert.deepEqual(sleeps, [500, 1000, 2000, 4000, 5000, 5000, 2500], 'capped at 5 s and trimmed to the deadline');
});

// A minimal DOM for probe(): elements with a tag, attributes, text, and visibility, matched by simple selectors.
const node = (tag, attrs = {}, { text = '', hidden = false, children = [] } = {}) => ({ tag, attrs, textContent: text, offsetParent: hidden ? null : {}, children });
const flat = (nodes, parent = null) => nodes.flatMap((n) => [Object.assign(n, { parent }), ...flat(n.children, n)]);
const one = (e, part) => {
  const tag = part.match(/^[a-z]+/)?.[0];
  return (!tag || e.tag === tag) && [...part.matchAll(/\[([\w-]+)(?:(\*?=)([^\]\s]+)(\s+i)?)?\]/g)].every(([, name, op, want, ci]) => {
    const have = e.attrs[name];
    if (have == null || !op) return have != null;
    const [a, b] = ci ? [have.toLowerCase(), want.toLowerCase()] : [have, want];
    return op === '=' ? a === b : a.includes(b);
  });
};
const matches = (e, sel) => {
  const parts = sel.trim().split(/\s+(?![^[]*\])/);
  if (!one(e, parts.pop())) return false;
  for (let up = e.parent; parts.length && up; up = up.parent) if (one(up, parts.at(-1))) parts.pop();
  return parts.length === 0;
};
const page = ({ host = 'teams.cloud.microsoft', protocol = 'https:', readyState = 'complete', body = [], lastResponse = 0, now = 10_000 } = {}) => {
  const all = flat(body);
  const d = { readyState, querySelectorAll: (sel) => all.filter((e) => sel.split(/,(?![^[]*\])/).some((s) => matches(e, s))) };
  const p = { getEntriesByType: () => (lastResponse ? [{ responseEnd: lastResponse }] : []), now: () => now };
  return probe(d, { hostname: host, protocol }, p);
};
const rail = (rows) => node('div', { role: 'tree', 'aria-label': 'Teams' }, { children: Array.from({ length: rows }, () => node('div', { role: 'treeitem' })) });

test('state detection: signed out, sign-in prompt, MFA, interstitial, loading skeleton, busy network, offline, and ready', () => {
  const state = (opts) => classify(page(opts)).state;
  assert.equal(state({ host: 'login.example.invalid', body: [node('input', { type: 'password' })] }), 'needs-sign-in', 'redirected to the identity provider');
  assert.equal(state({ host: 'login.example.invalid', body: [node('div', {}, { text: 'Approve the request on your phone' })] }), 'needs-sign-in', 'MFA wait on the sign-in host');
  assert.equal(state({ body: [node('button', {}, { text: ' Sign in ' })] }), 'needs-sign-in', 'Teams signed-out landing page');
  assert.equal(state({ body: [node('input', { name: 'loginfmt' }), rail(3)] }), 'needs-sign-in');
  assert.equal(state({ body: [rail(5), node('div', { role: 'dialog' })] }), 'interstitial');
  assert.equal(state({ body: [rail(5), node('div', { role: 'dialog' }, { hidden: true })] }), 'ready', 'a hidden dialog is not a prompt');
  assert.equal(state({ body: [node('div', { class: 'fui-Skeleton root' }), rail(0)] }), 'loading', 'loading skeleton');
  assert.equal(state({ body: [rail(5), node('div', { class: 'app-ShimmerBar' })] }), 'loading', 'rail drawn but content still shimmering');
  assert.equal(state({ body: [rail(0)] }), 'loading', 'empty chat list');
  assert.equal(state({ readyState: 'interactive', body: [rail(5)] }), 'loading');
  assert.equal(state({ body: [rail(5)], lastResponse: 10_000 - QUIET_MS + 100 }), 'loading', 'network still busy');
  assert.equal(state({ protocol: 'about:', host: '' }), 'loading');
  assert.equal(state({ protocol: 'chrome-error:', host: 'chromewebdata' }), 'offline');
  assert.equal(state({ body: [rail(5)], lastResponse: 10_000 - QUIET_MS - 100 }), 'ready');
  assert.equal(classify(null).state, 'loading', 'a failed probe (page navigating) reads as loading');
  const signals = page({ body: [rail(2), node('button', {}, { text: 'Sign in' })] });
  assert.deepEqual(Object.values(signals).map((v) => typeof v).filter((t) => !['boolean', 'number'].includes(t)), ['string', 'string', 'string'],
    'only protocol, host, and readyState are strings; no page text leaves the tab');
});

const READ = 'async () => ({})';
const fakeCdp = ({ pages = [], probes, read = { health: 'ok', reason: null, items: [] } }) => {
  const calls = [];
  let n = 0;
  const send = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'Target.getTargets') return { targetInfos: pages };
    if (method === 'Target.createTarget') return { targetId: 'new-tab' };
    if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
    if (method === 'Runtime.evaluate') return { result: { value: params.expression === `(${READ})()` ? read : probes[Math.min(n++, probes.length - 1)] } };
    return {};
  };
  return { calls, send, methods: () => calls.map((c) => c.method) };
};
const signals = (over = {}) => ({ protocol: 'https:', host: 'teams.cloud.microsoft', readyState: 'complete', signInForm: false, signInButton: false,
  dialogs: 0, skeletons: 0, railRows: 4, quietMs: 5000, ...over });
const scan = async (home, cdp) => {
  let clock = 0;
  return scanTeams({ cdp, home, readScript: READ, sleep: async (ms) => { clock += ms; }, now: () => clock, readyTimeoutMs: 30_000 });
};

test('scan: waits through loading to ready, then reads, reusing the persistent tab across scans', async (t) => {
  const home = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const first = fakeCdp({ probes: [null, signals({ railRows: 0, skeletons: 3 }), signals({ quietMs: 10 }), signals()], read: { health: 'ok', reason: null, items: [{ id: 'x' }] } });
  assert.deepEqual(await scan(home, first), { health: 'ok', reason: null, items: [{ id: 'x' }] });
  const created = first.calls.find((c) => c.method === 'Target.createTarget');
  assert.deepEqual(created.params, { url: 'https://teams.cloud.microsoft/', newWindow: true, windowState: 'minimized', focus: false, background: true });
  assert.equal(first.methods().includes('Page.reload'), false);
  assert.equal(first.methods().at(-1), 'Target.detachFromTarget');
  // Next scan: the remembered tab is reused even though it now sits on a sign-in host.
  const second = fakeCdp({ pages: [{ type: 'page', targetId: 'other', url: 'https://teams.cloud.microsoft/' }, { type: 'page', targetId: 'new-tab', url: 'https://login.example.invalid/' }], probes: [signals()] });
  await scan(home, second);
  assert.equal(second.methods().includes('Target.createTarget'), false);
  assert.equal(second.calls.find((c) => c.method === 'Target.attachToTarget').params.targetId, 'new-tab');
  // A browser restart loses the remembered tab; an existing Teams tab is adopted before a new one is opened.
  const third = fakeCdp({ pages: [{ type: 'page', targetId: 'adopted', url: 'https://teams.cloud.microsoft/v2/' }], probes: [signals()] });
  await scan(home, third);
  assert.equal(third.methods().includes('Target.createTarget'), false);
  assert.equal(fs.readFileSync(path.join(home, 'state', 'radar-producer', 'teams-tab'), 'utf8'), 'adopted');
});

test('scan: a sign-in page is reported as needs sign-in, never read, and never reloaded; a stuck load gets exactly one reload', async (t) => {
  const home = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const signIn = fakeCdp({ probes: [signals({ host: 'login.example.invalid' })] });
  const out = await scan(home, signIn);
  assert.equal(out.health, 'unavailable');
  assert.equal(out.needsSignIn, true);
  assert.match(out.reason, /^needs sign-in: .*chrome\.js show/);
  assert.equal(signIn.methods().includes('Page.reload'), false);
  assert.equal(signIn.calls.filter((c) => c.method === 'Runtime.evaluate').every((c) => c.params.expression !== `(${READ})()`), true, 'teams-read never runs');
  const stuck = fakeCdp({ probes: [signals({ skeletons: 2 })] });
  const timedOut = await scan(home, stuck);
  assert.deepEqual(timedOut, { health: 'unavailable', reason: 'Teams did not finish loading' });
  assert.equal(stuck.methods().filter((m) => m === 'Page.reload').length, 1);
  const prompt = fakeCdp({ probes: [signals({ dialogs: 1 })] });
  assert.equal((await scan(home, prompt)).reason, 'Teams shows a dialog or prompt');
});

const NOW = Date.parse('2026-07-08T12:00:00Z');
const config = { ...DEFAULTS, slackUserId: 'U000DEMO' };
const teamsItem = { id: 'teams:000000000000000000000001', source: 'teams', kind: 'dm', title: 'demo-chat', link: null, why: 'unread DM', who: null, where: 'demo-chat', lastActivity: new Date(NOW - 600_000).toISOString() };

test('stale data: a failed Teams scan keeps the last good items and readAt, stamps staleSince once, and a good scan clears it', () => {
  const ok = { health: 'ok', reason: null, items: [teamsItem] };
  const slack = { health: 'ok', reason: null, items: [] };
  const signIn = { health: 'unavailable', needsSignIn: true, reason: 'needs sign-in: Teams went to a sign-in page; run chrome.js show and sign in' };
  const good = radar.parseRadar(JSON.stringify(merge({ previous: null, now: NOW, config, results: { slack, teams: ok } })), NOW);
  assert.equal(good.sources.teams.staleSince, null);
  const t1 = NOW + 30 * 60_000;
  const failed = radar.parseRadar(JSON.stringify(merge({ previous: good, now: t1, config, results: { slack, teams: signIn } })), t1);
  assert.equal(failed.sources.teams.health, 'unavailable');
  assert.equal(failed.sources.teams.needsSignIn, true);
  assert.equal(failed.sources.teams.staleSince, new Date(t1).toISOString());
  assert.equal(failed.sources.teams.readAt, new Date(NOW).toISOString());
  assert.deepEqual(failed.items.map((x) => x.id), [teamsItem.id], 'last good items kept');
  assert.equal(failed.sources.slack.staleSince, null, 'Slack is unaffected');
  const t2 = t1 + 30 * 60_000;
  const still = radar.parseRadar(JSON.stringify(merge({ previous: failed, now: t2, config, results: { slack, teams: { health: 'unavailable', reason: 'Teams did not finish loading' } } })), t2);
  assert.equal(still.sources.teams.staleSince, new Date(t1).toISOString(), 'staleSince marks the first failure');
  assert.equal(still.sources.teams.needsSignIn, false);
  assert.equal(still.items.length, 1);
  const t3 = t2 + 30 * 60_000;
  const back = merge({ previous: still, now: t3, config, results: { slack, teams: ok } });
  assert.equal('staleSince' in back.sources.teams, false);
  assert.equal(back.sources.teams.readAt, new Date(t3).toISOString());
});

test('pass lock: a live pass or one just starting blocks a second pass; a dead or long-empty lock is taken over and released', (t) => {
  const home = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'config', 'radar.json'), '{}');
  const lock = path.join(home, 'state', 'radar-producer.lock');
  const log = () => fs.readFileSync(path.join(home, 'state', 'radar-producer.log'), 'utf8').trim().split('\n').at(-1);
  const pass = () => spawnSync('bash', [path.join(__dirname, '..', 'radar-producer', 'run.sh'), '--any-time'], { env: { ...process.env, FM_HOME: home }, encoding: 'utf8' });
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  assert.equal(pass().status, 0);
  assert.match(log(), /skip: pass \d+ still running/);
  fs.rmSync(path.join(lock, 'pid'));
  assert.equal(pass().status, 0);
  assert.match(log(), /skip: another pass is starting/);
  const old = (Date.now() - 5 * 60_000) / 1000;
  fs.utimesSync(lock, old, old);
  // Taking over runs prepare, which refuses this config, so the pass stops before any browser or claude starts.
  assert.equal(pass().status, 1);
  assert.match(log(), /error: prepare failed/);
  assert.equal(fs.existsSync(lock), false, 'the lock is released on exit');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), String(spawnSync('true').pid));
  assert.equal(pass().status, 1);
  assert.match(log(), /error: prepare failed/);
  assert.equal(fs.existsSync(lock), false);
});
