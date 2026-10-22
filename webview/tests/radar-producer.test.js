'use strict';
// Radar producer: merge validation, carry-forward, lookback, independent source health, no body fields, and the prepare step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const radar = require('../radar');
const { merge, run, hashId, toIso, DEFAULTS } = require('../radar-producer/merge');
const { trackedWork, prepare, isWorkingHours } = require('../radar-producer/prepare');

const NOW = Date.parse('2026-07-08T12:00:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const config = { ...DEFAULTS, slackUserId: 'U000DEMO', deny: { channels: ['C0DENIED', '#demo-noise'], senders: ['Demo Bot'] } };
const slackHit = (n, extra = {}) => ({
  conversation: `C0DEMO${n}:1783500000.00010${n}`, kind: 'mention', title: `#demo-${n}`, who: 'Demo Person', where: `#demo-${n}`,
  link: `https://demo.example.invalid/archives/C0DEMO${n}/p178350000000010${n}`, why: 'mentioned you', lastActivity: String(NOW / 1000 - 600 - n), taskIds: [], ...extra,
});
const teamsHit = (n, extra = {}) => ({
  id: `teams:${String(n).padStart(24, '0')}`, source: 'teams', kind: 'channel', title: `demo-channel-${n}`, link: `https://demo.example.invalid/l/channel/${n}`,
  why: `unread posts in demo-channel-${n}`, who: null, where: `demo-channel-${n}`, lastActivity: at(20 + n), firstSeen: at(1), state: 'new', ...extra,
});
const ok = (items) => ({ health: 'ok', reason: null, items });
const valid = (out) => radar.parseRadar(JSON.stringify(out), NOW);

test('validation: invalid items are dropped, the source turns degraded, and the output parses as fm-radar.v1', () => {
  const out = merge({
    previous: null, now: NOW, config,
    results: {
      slack: ok([slackHit(1), slackHit(2, { kind: 'keyword' }), slackHit(3, { conversation: '' }), slackHit(4, { lastActivity: 'soon' }), slackHit(5, { why: '' })]),
      teams: ok([teamsHit(1), teamsHit(2, { id: 'slack:000000000000000000000002' }), teamsHit(3, { link: 'javascript:alert(1)' })]),
    },
  });
  assert.deepEqual(out.items.map((x) => x.id).sort(), [hashId('slack', slackHit(1).conversation), teamsHit(1).id, teamsHit(3).id].sort());
  assert.equal(out.sources.slack.health, 'degraded');
  assert.match(out.sources.slack.reason, /4 invalid/);
  assert.equal(out.sources.teams.health, 'degraded');
  assert.equal(out.items.find((x) => x.id === teamsHit(3).id).link, null);
  const parsed = valid(out);
  assert.equal(parsed.invalidItems, 0);
  assert.equal(parsed.items.length, 3);
});

test('validation: Slack ids are hashed from the conversation, ts becomes ISO, long text is clipped, and the deny list drops items', () => {
  const out = merge({
    previous: null, now: NOW, config,
    results: {
      slack: ok([slackHit(1, { why: 'w'.repeat(200), title: 't'.repeat(300) }), slackHit(2, { conversation: 'C0DENIED:1.2' }), slackHit(3, { who: 'Demo Bot' }), slackHit(4, { where: '#demo-noise' })]),
      teams: ok([teamsHit(1, { title: '#demo-noise' })]),
    },
  });
  assert.equal(out.items.length, 1);
  const [x] = out.items;
  assert.equal(x.id, hashId('slack', slackHit(1).conversation));
  assert.match(x.id, /^slack:[0-9a-f]{24}$/);
  assert.equal(x.lastActivity, new Date(NOW - 601_000).toISOString());
  assert.equal(x.why.length, 80);
  assert.equal(x.title.length, 120);
  assert.equal(out.sources.slack.health, 'ok', 'denied items are not invalid');
  assert.equal(toIso('1783500000.000100'), '2026-07-08T08:40:00.000Z');
  assert.equal(toIso('nope'), null);
});

test('carry-forward: firstSeen, state, and snoozedUntil survive for the same id; new ids start new', () => {
  const first = merge({ previous: null, now: NOW - 30 * 60_000, config, results: { slack: ok([slackHit(1)]), teams: ok([teamsHit(1)]) } });
  const previous = valid(first);
  previous.items[0].state = 'seen';
  previous.items[0].snoozedUntil = at(-60);
  const second = merge({ previous, now: NOW, config, results: { slack: ok([slackHit(1), slackHit(2)]), teams: ok([teamsHit(1)]) } });
  const byId = Object.fromEntries(second.items.map((x) => [x.id, x]));
  const carried = previous.items[0];
  assert.equal(byId[carried.id].firstSeen, carried.firstSeen);
  assert.equal(byId[carried.id].state, 'seen');
  assert.equal(byId[carried.id].snoozedUntil, at(-60));
  const fresh = byId[hashId('slack', slackHit(2).conversation)];
  assert.equal(fresh.firstSeen, new Date(NOW).toISOString());
  assert.equal(fresh.state, 'new');
  assert.equal(byId[teamsHit(1).id].firstSeen, new Date(NOW - 30 * 60_000).toISOString(), 'the producer, not the source, owns firstSeen');
});

test('lookback: items older than the window are dropped, including carried ones', () => {
  const previous = valid(merge({ previous: null, now: NOW, config, results: { slack: ok([slackHit(1)]), teams: ok([teamsHit(1, { lastActivity: at(23 * 60) })]) } }));
  const out = merge({
    previous, now: NOW + 2 * 3600_000, config,
    results: { slack: ok([slackHit(2, { lastActivity: at(25 * 60) }), slackHit(3)]), teams: { health: 'unavailable', reason: 'no Teams tab open' } },
  });
  assert.deepEqual(out.items.map((x) => x.id), [hashId('slack', slackHit(3).conversation)]);
});

test('one source failing while the other is ok: the failed one keeps its old items and readAt, the other is fresh', () => {
  const previous = valid(merge({ previous: null, now: NOW - 30 * 60_000, config, results: { slack: ok([slackHit(1)]), teams: ok([teamsHit(1)]) } }));
  for (const failed of [{ health: 'unavailable', reason: 'login needed', items: [slackHit(9)] }, new Error('slack: the producer did not report'), { health: 'error' }, undefined]) {
    const out = merge({ previous, now: NOW, config, results: { slack: failed, teams: ok([teamsHit(1), teamsHit(2)]) } });
    assert.equal(out.sources.slack.health, 'unavailable');
    assert.ok(out.sources.slack.reason);
    assert.equal(out.sources.slack.readAt, previous.sources.slack.readAt, 'readAt stays at the last good read');
    assert.deepEqual(out.items.filter((x) => x.source === 'slack').map((x) => x.id), [hashId('slack', slackHit(1).conversation)], 'no faked items, old ones kept');
    assert.equal(out.sources.teams.health, 'ok');
    assert.equal(out.sources.teams.readAt, new Date(NOW).toISOString());
    assert.equal(out.items.filter((x) => x.source === 'teams').length, 2);
  }
  const fromNothing = merge({ previous: null, now: NOW, config, results: { slack: { health: 'unavailable', reason: 'login needed' }, teams: ok([]) } });
  assert.equal(fromNothing.sources.slack.readAt, null);
  assert.equal(valid(fromNothing).sources.slack.isStale, true);
});

test('no body fields: only fm-radar.v1 item fields are written, whatever the result carries', () => {
  const extra = { text: 'secret message text', body: 'secret body', content: 'secret content', lastMessage: { content: 'secret last' } };
  const out = merge({ previous: null, now: NOW, config, results: { slack: ok([slackHit(1, extra)]), teams: ok([teamsHit(1, extra)]) } });
  const fields = ['id', 'source', 'kind', 'title', 'link', 'why', 'who', 'where', 'lastActivity', 'taskIds', 'firstSeen', 'state', 'snoozedUntil'];
  for (const x of out.items) assert.deepEqual(Object.keys(x).sort(), [...fields].sort());
  assert.doesNotMatch(JSON.stringify(out), /secret/);
});

const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-producer-'));
  for (const d of ['config', 'data', 'state/radar-producer']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'radar.json'), JSON.stringify({ slackUserId: 'U000DEMO', deny: { channels: [], senders: [] } }));
  return home;
};

test('run: reads result files, writes radar.json atomically, and the dashboard serves it; a missing result reads as unavailable', async (t) => {
  const home = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'state', 'radar-producer', 'slack.json'), JSON.stringify(ok([slackHit(1, { text: 'secret' })])));
  const out = run(home, NOW);
  assert.equal(out.sources.slack.health, 'ok');
  assert.equal(out.sources.teams.health, 'unavailable');
  assert.match(out.sources.teams.reason, /did not report/);
  assert.deepEqual(fs.readdirSync(path.join(home, 'data')), ['radar.json'], 'no temp file left behind');
  const served = await radar.readRadar(home, NOW);
  assert.equal(served.items.length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(home, 'data', 'radar.json'), 'utf8'), /secret/);
  fs.writeFileSync(path.join(home, 'state', 'radar-producer', 'slack.json'), '{not json');
  const again = run(home, NOW + 60_000);
  assert.equal(again.sources.slack.health, 'unavailable');
  assert.equal(again.items.length, 1, 'the earlier Slack item is kept');
});

test('run: a config without slackUserId is refused and nothing is written', (t) => {
  const home = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'config', 'radar.json'), '{}');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'radar-producer', 'merge.js'), home], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /slackUserId/);
  assert.equal(fs.existsSync(path.join(home, 'data', 'radar.json')), false);
});

test('prepare: tracked keys come from open backlog items only, mapped to their task ids', () => {
  const backlog = ['# Backlog', '', '## In flight', '- [ ] demo-task - fix DEMO-12 and DEMO-34 (kind: ship)', '  Note: see DEMO-56',
    '## Queued', '- other-task - follow up on DEMO-12', '', '## Done', '- [x] old-task - DEMO-99'].join('\n');
  assert.deepEqual(trackedWork(backlog), [
    { key: 'DEMO-12', taskIds: ['demo-task', 'other-task'] }, { key: 'DEMO-34', taskIds: ['demo-task'] }, { key: 'DEMO-56', taskIds: ['demo-task'] },
  ]);
  assert.deepEqual(trackedWork(''), []);
});

test('prepare: working hours, prompt values, and a claude argv limited to read tools', (t) => {
  const home = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const monday10 = new Date(2026, 6, 6, 10, 0);
  assert.equal(isWorkingHours(DEFAULTS.hours, monday10), true);
  assert.equal(isWorkingHours(DEFAULTS.hours, new Date(2026, 6, 6, 20, 0)), false);
  assert.equal(isWorkingHours(DEFAULTS.hours, new Date(2026, 6, 5, 10, 0)), false, 'Sunday');
  assert.equal(prepare(home, { now: new Date(2026, 6, 5, 10, 0) }), null);
  const plan = prepare(home, { now: monday10 });
  assert.match(plan.prompt, /U000DEMO/);
  assert.match(plan.prompt, new RegExp(`after: "${Math.floor(monday10.getTime() / 1000) - 24 * 3600}"`));
  assert.doesNotMatch(plan.prompt, /\{\{\w+\}\}/, 'every placeholder is filled');
  const flag = (name) => plan.args[plan.args.indexOf(name) + 1];
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.equal(flag('--tools'), 'Write,ToolSearch');
  const allowed = flag('--allowedTools').split(',');
  assert.ok(allowed.every((a) => /__(slack_search_public_and_private|slack_read_thread)$/.test(a) || a === `Edit(/${home}/state/radar-producer/slack.json)`), allowed.join(' '));
  assert.ok(flag('--disallowedTools').split(',').some((d) => d.endsWith('__slack_send_message')));
  assert.ok(plan.args.includes('--no-session-persistence'));
  assert.doesNotMatch(plan.prompt, /evaluate_script|Teams tab/, 'the Slack session never drives the browser');
});
