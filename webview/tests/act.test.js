'use strict';
// Answering, deferring, and closing decisions against a fake snapshot and a stubbed script runner:
// no firstmate script ever runs. Synthetic demo-* names only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const R = require('../public/render');
const act = require('../act');
const { start } = require('../server');

const DAY = 86400;
const hold = (id, extra = {}) => ({ id, title: `Title ${id}`, repo: 'demo', state: 'queued', kind: 'captain', hold_bucket: 'live', hold_kind: 'captain', hold_age_days: 1, ...extra });
const workTask = (id, extra = {}) => ({
  id, kind: 'ship', mode: 'direct-PR', project: 'demo', current_state: { state: 'working' }, pr: { url: null },
  hints: { open_decisions: extra.decisions ?? [] }, paths: { status_log: { last_event: { age_seconds: 60 } } },
  actions: { steer: `bin/fm-send.sh fm-${id} '<instruction>'` }, backlog: { id, title: `Title ${id}`, ...extra.backlog },
});
const SNAPSHOT = {
  schema: R.SCHEMA, generated: '2026-07-08T12:00:00Z',
  tasks: [
    workTask('demo-live', { decisions: [{ key: 'demo-live-q', verb: 'needs-decision', summary: 'Tabs or spaces? (A) tabs (B) spaces' }] }),
    workTask('demo-held-run', { backlog: { kind: 'ship', hold_bucket: 'live', hold_reason: 'go ahead with the plan?' } }),
    { ...workTask('demo-mate', { decisions: [{ key: 'captain-hold-demo-mate-h1', verb: 'needs-decision', summary: 'relayed copy' }] }), kind: 'secondmate' },
  ],
  backlog: { records: [
    hold('demo-q', { hold_reason: 'Which name? (A) Reports (B) Insights (C) neither', hold_age_days: 5 }),
    hold('demo-w', { kind: 'ship', hold_kind: 'ship', hold_reason: 'approve the plan first', hold_age_days: 2 }),
    hold('demo-u', { kind: null, hold_kind: null, hold_reason: 'which way?', hold_age_days: 1 }),
    hold('demo-noreason', { hold_reason: null }),
    hold('demo-pr', { hold_reason: 'has a watched pull request', pr_url: 'https://example.invalid/demo/pull/4' }),
    { id: 'demo-live', title: 'Title demo-live', state: 'in_flight' },
    { id: 'demo-held-run', title: 'Title demo-held-run', state: 'in_flight', kind: 'ship', hold_bucket: 'live', hold_reason: 'go ahead with the plan?' },
  ] },
  secondmate_current: { records: [{ id: 'demo-mate', home: '/tmp/demo/mate', remote: false,
    decisions_open: [{ id: 'demo-mate-h1', key: 'demo-mate-h1', verb: 'captain-hold', summary: 'the second mate hold', hold_age_days: 7 }] }] },
};

test('parseOptions finds lettered or numbered choices in order and leaves everything else as free text', () => {
  const texts = (reason) => R.parseOptions(reason).map((o) => `${o.label}=${o.text}`);
  assert.deepEqual(texts('Pick: (A) keep it as is; (B) drop it, or (C) ask later'), ['A=keep it as is', 'B=drop it', 'C=ask later']);
  assert.deepEqual(texts('1. first thing\n2. second thing\n3) third'), ['1=first thing', '2=second thing', '3=third']);
  assert.deepEqual(texts('a) yes b) no'), ['A=yes', 'B=no'], 'case does not matter');
  assert.deepEqual(texts('(A) one\\nsecond line (B) two\\nmore prose after'), ['A=one second line', 'B=two'], 'a stored line break ends the last choice');
  assert.deepEqual(texts('choose a name'), []);
  assert.deepEqual(texts('Only (A) one option'), [], 'a single choice is not a menu');
  assert.deepEqual(texts('(B) first (C) second'), [], 'a menu starts at A or 1');
  assert.deepEqual(texts('(A) one (C) skipped a letter'), [], 'labels must run in order');
  assert.deepEqual(texts('(A) one (B)'), [], 'an empty choice voids the menu');
  assert.deepEqual(texts('call foo(A) and bar(B) now'), [], 'a marker needs a space before and after');
  assert.deepEqual(texts(null), []);
  assert.equal(R.parseOptions(`(A) ${'x'.repeat(500)} (B) y`)[0].text.length, 300, 'a choice is capped');
});

test('answer text and defer dates are validated before anything runs', () => {
  const item = { options: R.parseOptions('(A) tabs (B) spaces') };
  assert.deepEqual(R.answerText({ option: 'b' }, item), { text: 'Answered from the dashboard: option (B) spaces', summary: 'option B' });
  assert.match(R.answerText({ option: 'C' }, item).error, /not one of the listed options/);
  assert.match(R.answerText({ option: 'A', text: 'x' }, item).error, /either your own words or one/);
  assert.match(R.answerText({}, item).error, /either your own words or one/);
  assert.match(R.answerText({ text: '  \n ' }, item).error, /write an answer/);
  assert.match(R.answerText({ text: 7 }, item).error, /must be text/);
  assert.match(R.answerText({ text: 'x'.repeat(R.ANSWER_MAX + 1) }, item).error, /2000 characters/);
  assert.equal(R.answerText({ text: '/exit\r\nsecond\u0007 line' }, item).text, 'Answered from the dashboard: /exit\nsecond line',
    'a leading slash is never first, and control characters are dropped');
  const date = (until) => R.deferDate(until, '2026-07-08');
  assert.deepEqual(date('2026-07-09'), { until: '2026-07-09' });
  assert.deepEqual(date('2027-07-09'), { until: '2027-07-09' });
  for (const bad of ['2026-07-08', '2026-07-07', '2026-02-30', '07/09/2026', '2026-7-9', 'tomorrow', null, 20260709]) assert.ok(date(bad).error, String(bad));
  assert.match(date('2027-07-10').error, /within the next year/);
});

test('one entry per decision: twin records collapse, the worker-blocking ones lead, oldest first', () => {
  const { items, collapsed } = R.decisionItems(SNAPSHOT);
  assert.deepEqual(items.map((i) => i.ref), ['relay:demo-live:demo-live-q', 'hold:demo-held-run', 'hold:demo-q', 'hold:demo-w', 'hold:demo-noreason', 'hold:demo-pr', 'hold:demo-u', 'readonly:demo-mate|demo-mate-h1']);
  assert.equal(collapsed, 1, 'the second mate hold and its relayed copy are one decision');
  const mate = items.find((i) => i.ref.startsWith('readonly:'));
  assert.deepEqual([mate.collapsed, mate.priority, mate.title, mate.actions.answer, mate.ageSeconds], [1, 2, 'the second mate hold', null, 7 * DAY]);
  assert.match(mate.actions.readOnly, /second mate demo-mate's home/);
  const by = Object.fromEntries(items.map((i) => [i.ref, i]));
  assert.deepEqual(by['hold:demo-q'].options.map((o) => o.label), ['A', 'B', 'C']);
  assert.deepEqual(by['hold:demo-q'].actions, { answer: { type: 'hold', id: 'demo-q', mode: 'done' }, defer: true, settle: true, readOnly: null });
  assert.equal(by['hold:demo-w'].actions.answer.mode, 'release');
  assert.deepEqual([by['hold:demo-u'].actions.answer.mode, by['hold:demo-u'].needsMode], [null, true]);
  assert.deepEqual([by['hold:demo-held-run'].priority, by['hold:demo-held-run'].actions.settle, by['hold:demo-held-run'].actions.answer.mode], [0, false, 'release'], 'work under way is released, never closed as settled');
  assert.equal(by['hold:demo-pr'].actions.settle, false);
  assert.deepEqual(by['relay:demo-live:demo-live-q'].actions, { answer: { type: 'relay', task: 'demo-live', key: 'demo-live-q' }, defer: false, settle: false, readOnly: null });
  assert.deepEqual(by['relay:demo-live:demo-live-q'].options.map((o) => o.text), ['tabs', 'spaces']);
  assert.equal(R.findDecision(SNAPSHOT, 'hold:demo-nope'), null);
  assert.ok(by['hold:demo-q'].isAging && !by['hold:demo-u'].isAging, 'aging starts at three days');
});

test('what a click will do is spelled out per action, with an honest label when it cannot be undone', () => {
  const item = (answer) => ({ actions: { answer } });
  assert.match(R.effectOf(item({ type: 'hold', mode: 'done' }), 'answer'), /closes this decision.*cannot be undone/);
  assert.match(R.effectOf(item({ type: 'hold', mode: 'release' }), 'answer'), /lets the held work go ahead.*cannot be undone/);
  assert.match(R.effectOf(item({ type: 'hold', mode: null }), 'answer', { mode: 'release' }), /lets the held work go ahead/);
  assert.match(R.effectOf(item({ type: 'hold', mode: null }), 'answer'), /Choose whether/);
  assert.match(R.effectOf(item({ type: 'relay' }), 'answer'), /Sends your answer to the worker/);
  assert.match(R.effectOf(item(null), 'settle'), /cannot be undone/);
  assert.match(R.effectOf(item(null), 'defer', { until: '2026-08-01' }), /until 2026-08-01.*undo/);
});

test('the ledger forgets an action only once a newer snapshot has been observed', () => {
  const ledger = act.makeLedger();
  ledger.mark('hold:demo-q');
  assert.equal(ledger.isSettled('hold:demo-q', { generated: '2000-01-01T00:00:00Z' }), true);
  assert.equal(ledger.isSettled('hold:demo-q', { generated: '2000-01-01T00:00:00Z' }), true, 'asking again changes nothing');
  assert.equal(ledger.isSettled('hold:demo-q', { generated: new Date(Date.now() + 60_000).toISOString() }), false);
  assert.equal(ledger.isSettled('hold:demo-q', { generated: '2000-01-01T00:00:00Z' }), false, 'once dropped it stays dropped');
  assert.equal(ledger.isSettled('hold:demo-other', {}), false);
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

const setup = async (t, runner = async () => ({ ok: true, output: '' }), snapshot = SNAPSHOT) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webview-act-home-'));
  fs.mkdirSync(path.join(home, 'state'));
  const script = path.join(home, 'fake-snapshot.sh');
  fs.writeFileSync(path.join(home, 'snapshot.json'), JSON.stringify(snapshot));
  fs.writeFileSync(script, `#!/bin/sh\ncat ${JSON.stringify(path.join(home, 'snapshot.json'))}\n`, { mode: 0o755 });
  const calls = [];
  const run = async (name, args) => {
    const fileAt = args.indexOf('--decision-file');
    calls.push({ name, args, decision: fileAt >= 0 ? fs.readFileSync(args[fileAt + 1], 'utf8') : null });
    return runner(name, args);
  };
  const app = await start({
    home, port: 0, pollMs: 60_000, resourcesPollMs: 60_000, collectResources: async () => ({}), snapshotScript: script, token: 'demo-token', actDeps: { run },
  });
  t.after(async () => { await app.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await app.ready;
  const { port } = app;
  const good = { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'X-Webview-Token': 'demo-token', 'Content-Type': 'application/json' };
  const send = (route, body, headers = good) => request(port, route, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
    .then((r) => ({ status: r.status, body: JSON.parse(r.body) }));
  const post = (body, headers) => send('/api/decisions/act', body, headers);
  const bulk = (body, headers) => send('/api/decisions/bulk', body, headers);
  const log = () => (fs.existsSync(path.join(home, 'state', 'webview-actions.log'))
    ? fs.readFileSync(path.join(home, 'state', 'webview-actions.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { home, port, good, post, bulk, send, calls, log };
};

for (const route of ['/api/decisions/act', '/api/decisions/bulk']) {
  test(`${route}: POST only, with this page Origin, token, Host, and a JSON body`, async (t) => {
    const { port, good, send, calls } = await setup(t);
    const body = { action: 'answer', ref: 'hold:demo-q', text: 'x', action2: 'settle', refs: ['hold:demo-q'], count: 1 };
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
      const res = await request(port, route, { method, headers: good });
      assert.deepEqual([res.status, res.headers.allow], [405, 'POST'], method);
    }
    const omit = (key) => Object.fromEntries(Object.entries(good).filter(([k]) => k !== key));
    assert.equal((await send(route, body, omit('X-Webview-Token'))).status, 403);
    assert.equal((await send(route, body, { ...good, 'X-Webview-Token': 'demo-tokeX' })).status, 403);
    assert.equal((await send(route, body, omit('Origin'))).status, 403);
    assert.equal((await send(route, body, { ...good, Origin: 'http://evil.example.invalid' })).status, 403);
    assert.equal((await request(port, route, { method: 'POST', headers: { ...good, Host: 'evil.example.invalid' }, body: JSON.stringify(body) })).status, 421);
    assert.equal((await send(route, body, { ...good, 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await send(route, 'not json')).status, 400);
    assert.equal((await send(route, JSON.stringify({ text: 'x'.repeat(17 * 1024) }))).status, 400, 'a body over 16 KB is refused');
    assert.deepEqual(calls, [], 'no script runs before every guard passes');
  });
}

test('an unknown action, a malformed or unknown reference, and a flag-shaped id never reach a script', async (t) => {
  const { post, calls } = await setup(t);
  assert.equal((await post({ action: 'merge', ref: 'hold:demo-q' })).status, 400);
  assert.equal((await post({ ref: 'hold:demo-q', text: 'x' })).status, 400);
  assert.equal((await post({ action: 'answer', ref: 7, text: 'x' })).status, 400);
  assert.equal((await post({ action: 'answer', ref: `hold:${'x'.repeat(500)}`, text: 'x' })).status, 400);
  assert.equal((await post({ action: 'answer', ref: 'hold:--release', text: 'x' })).status, 404);
  assert.equal((await post({ action: 'answer', ref: 'hold:demo-nope', text: 'x' })).status, 404);
  assert.equal((await post({ action: 'answer', ref: 'readonly:../etc', text: 'x' })).status, 404);
  assert.deepEqual(calls, []);
});

test('a question hold is answered and closed; a work hold is answered and released; an unknown kind asks which', async (t) => {
  const { post, calls, log } = await setup(t);
  const question = await post({ action: 'answer', ref: 'hold:demo-q', option: 'b' });
  assert.deepEqual([question.status, question.body], [200, { outcome: 'answered', kind: 'hold', mode: 'done' }]);
  assert.deepEqual([calls[0].name, calls[0].args[0], calls[0].args[1], calls[0].args[2], calls[0].args.length], ['fm-captain-hold.sh', 'answer', 'demo-q', '--decision-file', 4], 'no --release, so the question closes');
  assert.equal(calls[0].decision, 'Answered from the dashboard: option (B) Insights\n');

  const work = await post({ action: 'answer', ref: 'hold:demo-w', text: 'go ahead, but keep it small' });
  assert.deepEqual([work.status, work.body.mode], [200, 'release']);
  assert.deepEqual([calls[1].args[0], calls[1].args[1], calls[1].args[2], calls[1].args[4], calls[1].args.length], ['answer', 'demo-w', '--decision-file', '--release', 5]);
  assert.equal(calls[1].decision, 'Answered from the dashboard: go ahead, but keep it small\n');

  const running = await post({ action: 'answer', ref: 'hold:demo-held-run', text: 'yes' });
  assert.deepEqual([running.status, calls[2].args.at(-1)], [200, '--release'], 'a hold on running work releases it');

  const ask = await post({ action: 'answer', ref: 'hold:demo-u', text: 'left' });
  assert.deepEqual([ask.status, ask.body.reason], [400, 'choose whether to close the question or let the held work go ahead']);
  assert.equal((await post({ action: 'answer', ref: 'hold:demo-u', text: 'left', mode: 'delete' })).status, 400);
  assert.equal((await post({ action: 'answer', ref: 'hold:demo-u', text: 'left', mode: 'release' })).status, 200);
  assert.equal(calls.length, 4);
  assert.equal((await post({ action: 'answer', ref: 'hold:demo-q', text: 'x', mode: 'release' })).status, 409, 'already answered; mode is checked only on a live decision');

  assert.deepEqual(log().map((l) => [l.action, l.ref, l.mode, l.said, l.outcome]), [
    ['answer', 'hold:demo-q', 'done', 'option B', 'answered'], ['answer', 'hold:demo-w', 'release', 'free text', 'answered'],
    ['answer', 'hold:demo-held-run', 'release', 'free text', 'answered'], ['answer', 'hold:demo-u', 'release', 'free text', 'answered']]);
  assert.ok(!JSON.stringify(log()).includes('keep it small'), 'the captain\'s words never reach the log');
});

test('bad answers are refused before any script: both or neither of text and option, an unlisted option, too long', async (t) => {
  const { post, calls } = await setup(t);
  for (const extra of [{}, { text: 'x', option: 'A' }, { option: 'Z' }, { text: '   ' }, { text: 5 }, { text: 'x'.repeat(2001) }, { option: 'A', mode: 'release' }]) {
    const res = await post({ action: 'answer', ref: 'hold:demo-q', ...extra });
    assert.equal(res.status, 400, JSON.stringify(extra).slice(0, 40));
  }
  assert.equal((await post({ action: 'answer', ref: 'hold:demo-noreason', text: 'ok' })).status, 200, 'a hold with no reason can still be answered');
  assert.equal(calls.length, 1);
});

test('a worker question is relayed with its key so the worker record closes, and the text can never read as a command', async (t) => {
  const { post, calls } = await setup(t);
  const res = await post({ action: 'answer', ref: 'relay:demo-live:demo-live-q', text: '/exit now --key Enter' });
  assert.deepEqual([res.status, res.body], [200, { outcome: 'answered', kind: 'relay', mode: null }]);
  assert.deepEqual(calls[0], { name: 'fm-send.sh', args: ['demo-live', '--resolve-key', 'demo-live-q', 'Answered from the dashboard: /exit now --key Enter'], decision: null });
  assert.equal((await post({ action: 'answer', ref: 'relay:demo-live:demo-live-q', text: 'again' })).status, 409, 'a second click does not send twice');
  assert.equal(calls.length, 1);
  const withMode = await post({ action: 'answer', ref: 'relay:demo-live:demo-live-q', text: 'x', mode: 'release' });
  assert.ok([400, 409].includes(withMode.status));
});

test('a worker answer carries a delivery warning back to the page', async (t) => {
  const { post } = await setup(t, async () => ({ ok: true, output: 'warning: reply-tracking-degraded' }));
  const res = await post({ action: 'answer', ref: 'relay:demo-live:demo-live-q', option: 'A' });
  assert.deepEqual([res.status, res.body.output], [200, 'warning: reply-tracking-degraded']);
});

test('a second mate decision has no answer here and says why; nothing runs', async (t) => {
  const { post, calls } = await setup(t);
  const res = await post({ action: 'answer', ref: 'readonly:demo-mate|demo-mate-h1', text: 'yes' });
  assert.equal(res.status, 409);
  assert.match(res.body.reason, /second mate demo-mate's home/);
  const defer = await post({ action: 'defer', ref: 'readonly:demo-mate|demo-mate-h1', until: '2999-01-01' });
  assert.equal(defer.status, 409);
  assert.deepEqual(calls, []);
});

test('a script failure is shown with its exact output, is logged, and leaves the decision answerable', async (t) => {
  let fail = true;
  const { post, calls, log } = await setup(t, async () => (fail ? { ok: false, output: 'fm-captain-hold: demo refusal' } : { ok: true, output: '' }));
  const res = await post({ action: 'answer', ref: 'hold:demo-q', text: 'first try' });
  assert.deepEqual([res.status, res.body], [500, { outcome: 'failed', reason: 'the firstmate script refused or failed', output: 'fm-captain-hold: demo refusal' }]);
  fail = false;
  assert.equal((await post({ action: 'answer', ref: 'hold:demo-q', text: 'second try' })).status, 200, 'a failed attempt does not lock the decision');
  assert.equal(calls.length, 2);
  assert.deepEqual(log().map((l) => l.outcome), ['failed', 'answered']);
});

test('a worker started on a held question after the page loaded stops the answer', async (t) => {
  const { home, post, calls } = await setup(t);
  fs.writeFileSync(path.join(home, 'state', 'demo-q.meta'), 'kind=ship\n');
  const res = await post({ action: 'answer', ref: 'hold:demo-q', text: 'x' });
  assert.deepEqual([res.status, res.body.reason], [409, 'a worker was started on it after this page loaded']);
  assert.deepEqual(calls, []);
});

test('defer holds again with the same reason and a date; undo holds again with no date; each is guarded', async (t) => {
  const { post, calls, log } = await setup(t);
  const until = R.localDate(new Date(Date.now() + 5 * DAY * 1000));
  for (const bad of [undefined, 'soon', R.localDate(new Date()), '2020-01-01', '2999-01-01']) {
    assert.equal((await post({ action: 'defer', ref: 'hold:demo-q', until: bad })).status, 400, String(bad));
  }
  assert.equal((await post({ action: 'defer', ref: 'relay:demo-live:demo-live-q', until })).status, 409, 'a worker question has no hold to date');
  assert.equal((await post({ action: 'defer', ref: 'hold:demo-noreason', until })).status, 409);
  assert.deepEqual(calls, []);

  const deferred = await post({ action: 'defer', ref: 'hold:demo-q', until });
  assert.deepEqual([deferred.status, deferred.body], [200, { outcome: 'deferred', until }]);
  assert.deepEqual(calls[0], { name: 'fm-captain-hold.sh', args: ['hold', 'demo-q', '--reason', 'Which name? (A) Reports (B) Insights (C) neither', '--until', until], decision: null });
  assert.equal((await post({ action: 'defer', ref: 'hold:demo-q', until })).status, 409, 'a second click does not repeat it');
  assert.equal((await post({ action: 'answer', ref: 'hold:demo-q', text: 'x' })).status, 409, 'a deferred decision is not answered by a stale page');

  assert.equal((await post({ action: 'undo-defer', ref: 'hold:demo-w' })).status, 409, 'only this page\'s own deferrals can be undone');
  assert.equal((await post({ action: 'undo-defer', ref: 'hold:--x' })).status, 400, 'a flag-shaped id is not a reference');
  assert.equal((await post({ action: 'undo-defer', ref: 'readonly:x' })).status, 400);
  const undone = await post({ action: 'undo-defer', ref: 'hold:demo-q' });
  assert.deepEqual([undone.status, undone.body], [200, { outcome: 'undone' }]);
  assert.deepEqual(calls[1].args, ['hold', 'demo-q', '--reason', 'Which name? (A) Reports (B) Insights (C) neither'], 'no --until, so the date clears');
  assert.equal((await post({ action: 'undo-defer', ref: 'hold:demo-q' })).status, 409, 'undo is one step');
  assert.equal((await post({ action: 'defer', ref: 'hold:demo-q', until })).status, 200, 'and the decision can be deferred again');
  assert.deepEqual(log().map((l) => [l.action, l.outcome]), [['defer', 'deferred'], ['undo-defer', 'undone'], ['defer', 'deferred']]);
});

test('a failed undo keeps the undo available', async (t) => {
  let fail = false;
  const { post } = await setup(t, async () => (fail ? { ok: false, output: 'closed meanwhile' } : { ok: true, output: '' }));
  const until = R.localDate(new Date(Date.now() + 3 * DAY * 1000));
  assert.equal((await post({ action: 'defer', ref: 'hold:demo-q', until })).status, 200);
  fail = true;
  const res = await post({ action: 'undo-defer', ref: 'hold:demo-q' });
  assert.deepEqual([res.status, res.body.output], [500, 'closed meanwhile']);
  fail = false;
  assert.equal((await post({ action: 'undo-defer', ref: 'hold:demo-q' })).status, 200);
});

test('close as settled reuses the cancel path and refuses work under way and watched pull requests', async (t) => {
  const { post, calls, log } = await setup(t);
  const res = await post({ action: 'settle', ref: 'hold:demo-q', reason: 'outdated', note: 'superseded' });
  assert.deepEqual([res.status, res.body], [200, { outcome: 'settled' }]);
  assert.deepEqual([calls[0].name, calls[0].args.slice(0, 3), calls[0].decision], ['fm-captain-hold.sh', ['answer', 'demo-q', '--decision-file'], 'Cancelled from the dashboard: outdated. Note: superseded\n']);
  assert.equal((await post({ action: 'settle', ref: 'hold:demo-q', reason: 'outdated' })).status, 409, 'a second click does nothing');
  assert.equal((await post({ action: 'settle', ref: 'hold:demo-w', reason: 'delete-everything' })).status, 400);
  assert.equal((await post({ action: 'settle', ref: 'hold:demo-w', reason: 'other' })).status, 400, 'Other needs a note');
  assert.equal((await post({ action: 'settle', ref: 'hold:demo-held-run', reason: 'outdated' })).status, 409);
  assert.equal((await post({ action: 'settle', ref: 'hold:demo-pr', reason: 'outdated' })).status, 409);
  assert.equal((await post({ action: 'settle', ref: 'relay:demo-live:demo-live-q', reason: 'outdated' })).status, 409);
  assert.equal(calls.length, 1);
  assert.deepEqual(log().map((l) => [l.action, l.outcome]), [['settle', 'cancelled'], ['settle', 'refused'], ['settle', 'refused']], 'every attempt that reached the script layer is logged');
});

test('the old cancel route and the new actions never both act on one decision', async (t) => {
  const { port, good, post, calls } = await setup(t);
  assert.equal((await post({ action: 'answer', ref: 'hold:demo-q', text: 'done' })).status, 200);
  const cancel = await request(port, '/api/cancel', { method: 'POST', headers: good, body: JSON.stringify({ id: 'demo-q', reason: 'outdated' }) });
  assert.equal(cancel.status, 409);
  assert.equal(calls.length, 1);
});

test('bulk: settle or defer a confirmed selection, report each outcome, and keep going after a failure', async (t) => {
  const { bulk, calls, log } = await setup(t, async (name, args) => (args.includes('demo-w') ? { ok: false, output: 'demo refusal' } : { ok: true, output: '' }));
  const refs = ['hold:demo-q', 'hold:demo-w', 'hold:demo-u'];
  const res = await bulk({ action: 'settle', refs, count: 3, reason: 'handled' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.outcome, res.body.done, res.body.total], ['partial', 2, 3]);
  assert.deepEqual(res.body.results.map((r) => [r.ref, r.outcome]), [['hold:demo-q', 'settled'], ['hold:demo-w', 'failed'], ['hold:demo-u', 'settled']]);
  assert.equal(res.body.results[1].output, 'demo refusal');
  assert.ok(res.body.results.every((r) => !('isUnknown' in r) && !('isBadRequest' in r)));
  assert.equal(calls.length, 3, 'every selected decision is attempted');
  assert.deepEqual(log().map((l) => l.outcome), ['cancelled', 'failed', 'cancelled']);

  const again = await bulk({ action: 'settle', refs: ['hold:demo-q', 'hold:demo-pr'], count: 2, reason: 'handled' });
  assert.deepEqual(again.body.results.map((r) => r.outcome), ['refused', 'refused'], 'already settled, and a watched pull request');
  assert.deepEqual([again.body.outcome, again.body.done], ['failed', 0]);
});

test('bulk defer and bulk undo apply one date to every selected decision', async (t) => {
  const { bulk, calls } = await setup(t);
  const until = R.localDate(new Date(Date.now() + 7 * DAY * 1000));
  const res = await bulk({ action: 'defer', refs: ['hold:demo-q', 'hold:demo-w'], count: 2, until });
  assert.deepEqual([res.status, res.body.outcome, res.body.results.map((r) => r.until)], [200, 'done', [until, until]]);
  assert.deepEqual(calls.map((c) => c.args.slice(0, 2).concat(c.args.slice(-2))), [['hold', 'demo-q', '--until', until], ['hold', 'demo-w', '--until', until]]);
  const undo = await bulk({ action: 'undo-defer', refs: ['hold:demo-q', 'hold:demo-w', 'hold:demo-u'], count: 3 });
  assert.deepEqual(undo.body.results.map((r) => r.outcome), ['undone', 'undone', 'refused']);
  assert.equal(undo.body.outcome, 'partial');
});

test('bulk refuses a wrong count, duplicates, nothing, too many, or a bad date or reason before running anything', async (t) => {
  const { bulk, calls } = await setup(t);
  const until = R.localDate(new Date(Date.now() + 2 * DAY * 1000));
  const ok = { action: 'settle', refs: ['hold:demo-q', 'hold:demo-w'], count: 2, reason: 'outdated' };
  const bad = [{ count: 3 }, { count: '2' }, { count: undefined }, { refs: ['hold:demo-q', 'hold:demo-q'] }, { refs: [] }, { refs: 'hold:demo-q', count: 1 },
    { refs: Array.from({ length: 51 }, (_, i) => `hold:demo-${i}`), count: 51 }, { refs: ['hold:demo-q', 7], count: 2 }, { action: 'answer' }, { action: 'defer', until: 'soon' },
    { reason: undefined }, { reason: 'other' }];
  for (const patch of bad) assert.equal((await bulk({ ...ok, ...patch })).status, 400, JSON.stringify(patch));
  assert.equal((await bulk({ action: 'defer', refs: ['hold:demo-q'], count: 1, until })).status, 200);
  assert.equal(calls.length, 1, 'only the valid request ran');
});

test('two changes at once: the second is turned away rather than interleaved', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { post, calls } = await setup(t, async () => { await gate; return { ok: true, output: '' }; });
  const first = post({ action: 'answer', ref: 'hold:demo-q', text: 'one' });
  while (!calls.length) await new Promise((r) => setTimeout(r, 5));
  const second = await post({ action: 'answer', ref: 'hold:demo-w', text: 'two' });
  assert.deepEqual([second.status, second.body.reason], [409, 'another change is still running; try again in a moment']);
  release();
  assert.equal((await first).status, 200);
  assert.equal(calls.length, 1);
});

test('without a loaded snapshot nothing can be acted on', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webview-act-empty-'));
  fs.mkdirSync(path.join(home, 'state'));
  const script = path.join(home, 'broken.sh');
  fs.writeFileSync(script, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const app = await start({ home, port: 0, pollMs: 60_000, resourcesPollMs: 60_000, collectResources: async () => ({}), snapshotScript: script, token: 'demo-token', actDeps: { run: async () => { throw new Error('must not run'); } } });
  t.after(async () => { await app.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await app.ready;
  const good = { Host: `127.0.0.1:${app.port}`, Origin: `http://127.0.0.1:${app.port}`, 'X-Webview-Token': 'demo-token', 'Content-Type': 'application/json' };
  const res = await request(app.port, '/api/decisions/act', { method: 'POST', headers: good, body: JSON.stringify({ action: 'answer', ref: 'hold:demo-q', text: 'x' }) });
  assert.equal(res.status, 503);
});
