'use strict';
// Agents tab: invented process tables, snapshots, and transcripts only; no real tmux or agents.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../agents');
const L = require('../agent-logs');
const R = require('../public/render');
const { start } = require('../server');
const { makeHome } = require('./fixture');

const HOME = '/demo/fm-home';
const PS = `
    1     0    0  0.0   100 10-00:00:00 ?? /sbin/launchd
  100     1  501  0.0  1000 01:00:00 ?? /usr/bin/tmux new -s demo
  200   100  501  1.0  2000 30:00 ttys001 -zsh
  201   200  501 12.5 300000 29:00 ttys001 claude --model demo-model --dangerously-skip-permissions
  202   201  501  3.0 50000 00:05 ttys001 /bin/bash -c npm test
  203   201  501  0.1 40000 29:00 ttys001 node /opt/demo/mcp-server.js
  204   202  501  0.0  1000 00:02 ttys001 claude -p summarize
  300     1  501  0.0  1000 02:00:00 ttys002 -zsh
  301   300  501  0.0 200000 01:59:00 ttys002 node /opt/demo/bin/gemini.js
  400     1  501  0.0  1000 05:00:00 ?? no-mistakes daemon run
  401   400  501  5.0  1000 03:00 ?? claude -p review the diff
  500     1  501  0.0  1000 01:00 ?? claude bg-pty-host
  600     1  501  0.0  1000 01:00 ttys003 codex exec do-thing
  700     1  501  0.0  1000 01:00 ttys004 /Applications/Demo.app/Contents/MacOS/Claude
  800     1  501  0.0  1000 01:00 ttys005 claude
  900     1  501  0.0  1000 01:00 ?? piano-helper --serve
  950     1  501  0.0  1000 01:00 ttys006 acli rovodev run
`;
const procs = A.parsePs(PS);
const roots = A.agentRoots(procs);
const rootOf = (pid) => roots.find((r) => r.proc.pid === pid);

const task = (id, fields = {}) => ({
  id, kind: 'ship', harness: 'claude', backend: 'tmux', remote: null,
  paths: { worktree: { path: `/work/${id}`, present: true }, home: { path: null }, status_log: { last_event: { state: 'working', note: 'setup done', age_seconds: 60 } } },
  current_state: { state: 'working', source: 'pane', detail: 'harness busy' },
  endpoint: { target: `demo:fm-${id}`, exists: true, status: 'present' },
  hints: { open_decisions: [], blocked_event: false }, backlog: { title: 'Demo task', captain_actionable: false },
  ...fields,
});

test('agent detection: CLI names, wrapped runtimes, and look-alikes', () => {
  assert.deepEqual(procs.find((p) => p.pid === 201), {
    pid: 201, ppid: 200, uid: 501, cpu: 12.5, rssBytes: 300000 * 1024, ageSeconds: 29 * 60, tty: 'ttys001', args: 'claude --model demo-model --dangerously-skip-permissions',
  });
  assert.equal(procs.find((p) => p.pid === 400).tty, null);
  assert.equal(A.agentName('node /opt/demo/bin/gemini.js'), 'gemini');
  assert.equal(A.agentName('/usr/local/bin/codex exec x'), 'codex');
  assert.equal(A.agentName('acli rovodev run'), 'rovodev');
  assert.equal(A.agentName('acli jira list'), null);
  assert.equal(A.agentName('/Applications/Demo.app/Contents/MacOS/Claude'), null, 'desktop app is not a CLI agent');
  assert.equal(A.agentName('piano-helper --serve'), null);
  assert.equal(A.agentName('node --inspect claude'), null, 'a flag after the wrapper is not a script');
  assert.equal(A.modelFlag('claude --model demo-model -p x'), 'demo-model');
  assert.equal(A.modelFlag('codex -m=demo-2'), 'demo-2');
});

test('grouping: each outermost agent owns its subtree, nested agents included', () => {
  assert.deepEqual(roots.map((r) => r.proc.pid).sort((a, b) => a - b), [201, 301, 401, 500, 600, 800, 950]);
  assert.deepEqual(rootOf(201).descendants.map((c) => c.pid).sort(), [202, 203, 204]);
  assert.equal(rootOf(401).ancestors[0].pid, 400);
  // A pid cycle must not loop forever.
  const loop = A.agentRoots(A.parsePs('  10 11 501 0.0 1 00:01 ?? claude\n  11 10 501 0.0 1 00:01 ?? sh\n'));
  assert.equal(loop.length, 1);
});

const overviewFor = (snapshot, extra = {}) => A.buildOverview({
  snapshot, roots, home: HOME, now: Date.parse('2026-07-08T12:00:00Z'), unavailable: [],
  cwdByPid: new Map([[201, '/work/demo-task-1/webview'], [301, '/demo/projects/x'], [800, HOME], [401, '/demo/nm/wt']]),
  claudeByPid: new Map([[800, { status: 'busy', updatedAt: Date.parse('2026-07-08T11:59:30Z') }]]),
  activityByPid: new Map([[201, { mtimeMs: Date.parse('2026-07-08T11:59:00Z'), lastTool: 'Bash', lastAction: 'Bash: npm test' }]]),
  fleetDirs: [{ id: 'demo-task-1', dir: '/work/demo-task-1' }, { id: 'demo-task-2', dir: '/work/demo-task-2' }],
  metaById: new Map([['demo-task-1', { model: 'demo-model', effort: 'high', spawn_gen: 's1783512000.42.7' }]]),
  ...extra,
});

test('classification: fleet worker by folder, then headless, supervision, interactive, and this home', () => {
  const v = overviewFor({ tasks: [task('demo-task-1'), task('demo-task-2', { current_state: { state: 'done', detail: 'PR open' } })] });
  const worker = v.fleet.find((f) => f.id === 'demo-task-1');
  assert.deepEqual(worker.processes.map((p) => [p.pid, p.class, p.role]), [[201, 'fleet', 'Firstmate worker']]);
  assert.deepEqual([worker.model, worker.effort, worker.startedAt, worker.lastTool, worker.lastOutputSeconds], ['demo-model', 'high', '2026-07-08T12:00:00.000Z', 'Bash', 60]);
  assert.equal(worker.processes[0].foreground, 'claude -p summarize', 'the youngest non-MCP child is the foreground command');
  assert.equal(v.fleet.find((f) => f.id === 'demo-task-2').processes.length, 0);
  const role = (pid) => v.others.find((o) => o.pid === pid);
  assert.deepEqual([role(301).class, role(301).role], ['interactive', 'Interactive session']);
  assert.deepEqual([role(401).class, role(401).role], ['headless', 'no-mistakes pipeline']);
  assert.deepEqual([role(500).class, role(500).role], ['headless', 'Supervision host']);
  assert.deepEqual([role(600).class, role(600).role], ['headless', 'Headless run']);
  assert.deepEqual([role(800).class, role(800).role], ['interactive', 'Firstmate session (this home)']);
  assert.equal(v.others.some((o) => o.pid === 201), false, 'a fleet process is listed under its worker, not as other');
});

test('state derivation: needs input, stuck, active, and idle come from the snapshot state', () => {
  const at = (fields, quiet = null) => A.fleetActivity(task('demo-x', fields), quiet);
  assert.deepEqual(at({ hints: { open_decisions: [{ verb: 'needs-decision', summary: 'pick a name' }] } }), ['needs-input', 'decision: pick a name']);
  assert.equal(at({ backlog: { captain_actionable: true } })[0], 'needs-input');
  assert.deepEqual(at({ current_state: { state: 'parked', detail: 'review gate' } }), ['needs-input', 'parked: review gate']);
  assert.deepEqual(at({ current_state: { state: 'blocked', detail: 'needs a login' } }), ['stuck', 'blocked: needs a login']);
  assert.equal(at({ current_state: { state: 'failed', detail: 'x' } })[0], 'stuck');
  assert.deepEqual(at({ endpoint: { exists: false } }), ['stuck', 'working, but its terminal pane is gone']);
  assert.deepEqual(at({}, 3 * 3600), ['stuck', 'no transcript output for 3h']);
  assert.deepEqual(at({}, 60), ['active', 'harness busy']);
  assert.deepEqual(at({ current_state: { state: 'done', detail: 'PR open' } }), ['idle', 'done: PR open']);
  assert.equal(at({ current_state: { state: 'working' }, endpoint: { exists: false }, remote: { host: 'demo' } })[0], 'active', 'a remote pane is not checked locally');
});

test('overview: active work first, counters carry their reasons', () => {
  const v = overviewFor({ tasks: [task('demo-idle', { current_state: { state: 'done', detail: 'PR open' } }), task('demo-task-1'), task('demo-stuck', { current_state: { state: 'blocked', detail: 'no creds' } })] });
  assert.deepEqual(v.fleet.map((f) => f.activity), ['active', 'stuck', 'idle']);
  assert.deepEqual(v.others.slice(0, 2).map((o) => [o.pid, o.activity]), [[401, 'active'], [800, 'active']]);
  assert.equal(v.others.find((o) => o.pid === 800).reason, 'Claude reports it busy');
  assert.deepEqual(v.counters.stuck, { count: 1, reasons: ['demo-stuck: blocked: no creds'] });
  assert.equal(v.counters.active.count, 3);
  assert.equal(R.agentsTab(v).hasWarning, true);
  assert.equal(R.agentsTab(null).count, null);
  assert.equal(R.tabs({ page: 'agents', agents: v }).find((t) => t.key === 'agents').isSelected, true);
  assert.equal(R.route('#agents').page, 'agents');
  assert.equal(R.route('#/agents').page, 'agents');
  assert.equal(R.viewFor('agents', { hasSnapshot: false }), 'agents', 'process data does not wait for the snapshot');
});

test('log parameters: allowlisted ids and pids only, bounded line counts', () => {
  const allow = { taskIds: new Set(['demo-task-1']), agentPids: new Set([201]) };
  const q = (s) => A.parseLogQuery(new URLSearchParams(s), allow);
  assert.deepEqual(q('task=demo-task-1'), { task: 'demo-task-1', lines: 200 });
  assert.deepEqual(q('pid=201&lines=50'), { pid: 201, lines: 50 });
  assert.deepEqual(q('task=demo-task-1&lines=999999999'), { task: 'demo-task-1', lines: A.LINES.max });
  for (const bad of ['lines=0', 'lines=-5', 'lines=1e3', 'lines=12abc', 'lines=']) assert.equal(q(`task=demo-task-1&${bad}`).status, 400, bad);
  for (const bad of ['task=../../etc/passwd', 'task=demo-task-1%2F..', 'task=.hidden', 'task=demo-other', `task=${'a'.repeat(200)}`]) assert.equal(q(bad).status, 404, bad);
  for (const bad of ['pid=999', 'pid=0', 'pid=201.5', 'pid=-201', 'pid=201;rm']) assert.equal(q(bad).status, 404, bad);
  assert.equal(q('').status, 400);
  assert.equal(q('task=demo-task-1&pid=201').status, 400);
});

test('redaction: obvious secrets are masked, ordinary text kept', () => {
  const cases = [
    ['key AKIAABCDEFGHIJKLMNOP here', 'key [redacted AWS key] here'],
    ['Authorization: Bearer abcdef0123456789', 'Authorization: [redacted]'],
    ['curl -H "Bearer abc.def.ghi-jkl"', 'curl -H "Bearer [redacted]"'],
    ['password=hunter2 next', 'password=[redacted] next'],
    ['{"api_key": "demo-value-1"}', '{"api_key": "[redacted]"}'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123', 'token [redacted token]'],
    ['https://demo:s3cret@example.invalid/x', 'https://demo:[redacted]@example.invalid/x'],
    ['-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\nafter', '[redacted private key]\nafter'],
    ['sk-ant-demo0123456789abcdefghij used', '[redacted key] used'],
    ['npm test passed in 3s', 'npm test passed in 3s'],
    ['DB_PASSWORD=hunter2 next', 'DB_PASSWORD=[redacted] next'],
    ['export MY_API_TOKEN=abc123', 'export MY_API_TOKEN=[redacted]'],
    ['OPENAI_API_KEY=demo-value-1', 'OPENAI_API_KEY=[redacted]'],
    ['SLACK_TOKEN=demo-value-2', 'SLACK_TOKEN=[redacted]'],
    ['SLACK_TOKEN=xoxb-0123456789-abcdef', 'SLACK_TOKEN=[redacted token]'],
    ['TF_VAR_aws_secret_access_key=abc', 'TF_VAR_aws_secret_access_key=[redacted]'],
    ['mysql --password hunter2 -h db', 'mysql --password [redacted] -h db'],
    ['gh auth login --token demo-value-3', 'gh auth login --token [redacted]'],
    ['deploy --db-password=hunter2', 'deploy --db-password=[redacted]'],
    [`npm_${'a1'.repeat(18)} set`, '[redacted token] set'],
    [`AIza${'b2'.repeat(17)}c`, '[redacted key]'],
    [`glpat-${'c3'.repeat(10)}`, '[redacted token]'],
    [`sk_live_${'d4'.repeat(12)}`, '[redacted key]'],
    ['npm_config_cache=/tmp/npm', 'npm_config_cache=/tmp/npm'],
    ['token_count=42 tokenizer=bpe', 'token_count=42 tokenizer=bpe'],
    ['mytoken=abc OLDPWD=/Users/demo', 'mytoken=abc OLDPWD=/Users/demo'],
    ['--token-file ./t --password-stdin', '--token-file ./t --password-stdin'],
    ['PASSWORD_FILE=/run/secrets/db', 'PASSWORD_FILE=/run/secrets/db'],
    ['reading the password policy for AIzaSy', 'reading the password policy for AIzaSy'],
  ];
  for (const [input, output] of cases) assert.equal(L.redact(input), output, input);
  assert.deepEqual(L.cleanLines('\x1b[31mred\x1b[0m line\nsecond\n', 10), ['red line', 'second']);
  assert.deepEqual(L.cleanLines('a\nb\nc\n', 2), ['b', 'c']);
});

test('transcripts: Claude and Codex records become short readable entries', () => {
  const claude = L.entriesOf('claude', [
    { type: 'user', timestamp: '2026-07-08T12:00:00Z', message: { content: 'please run the demo tests' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test --token=abc123' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'ok 12 tests' }] }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'All green.' }] } },
    { type: 'system' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n{"truncated');
  assert.deepEqual(claude.map((e) => [e.kind, e.text]), [['user', 'please run the demo tests'], ['tool', 'Bash: npm test --token=[redacted]'], ['result', 'ok 12 tests'], ['assistant', 'All green.']]);
  const codex = L.entriesOf('codex', [
    { type: 'session_meta', payload: { cwd: '/work/x' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system rules' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"git status"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'clean' } },
  ].map((r) => JSON.stringify(r)).join('\n'));
  assert.deepEqual(codex.map((e) => [e.kind, e.text]), [['user', 'fix it'], ['tool', 'exec_command: git status'], ['result', 'clean']]);
  assert.equal(L.claudeProjectDir('/p', '/Users/demo/.pool/1/repo'), '/p/-Users-demo--pool-1-repo');
});

test('transcripts: located from fixed roots, bounded, and unavailable with a reason', async (t) => {
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-home-'));
  t.after(() => fs.rmSync(homedir, { recursive: true, force: true }));
  const sid = '00000000-0000-4000-8000-000000000001';
  const dir = L.claudeProjectDir(path.join(homedir, '.claude', 'projects'), '/work/demo');
  fs.mkdirSync(dir, { recursive: true });
  const record = (i) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `step ${i}` }] } });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${Array.from({ length: 50 }, (_, i) => record(i)).join('\n')}\n`);
  const where = await L.locateTranscript({ name: 'claude', pid: 1, cwd: '/work/demo', claude: { sessionId: sid }, homedir, now: Date.now() });
  const s = await L.transcriptSection(where, 5);
  assert.deepEqual([s.isAvailable, s.lines.length, s.lines[4].endsWith('step 49')], [true, 5, true]);
  // No session id: the newest file in the folder, flagged as a guess when another session shares the folder.
  const guess = await L.locateTranscript({ name: 'claude', pid: 1, cwd: '/work/demo', claude: null, sharedCwd: true, homedir, now: Date.now() });
  assert.equal((await L.transcriptSection(guess, 5)).note !== null, true);
  const now = new Date();
  const day = path.join(homedir, '.codex', 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'rollout-demo.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { base_instructions: 'say "cwd":"/nope"', cwd: '/work/codex' } })}\n`);
  assert.equal((await L.locateTranscript({ name: 'codex', pid: 2, cwd: '/work/codex', homedir, now: Date.now() })).file, path.join(day, 'rollout-demo.jsonl'));
  assert.match((await L.locateTranscript({ name: 'codex', pid: 2, cwd: '/work/other', homedir, now: Date.now() })).reason, /no Codex session/);
  assert.match((await L.locateTranscript({ name: 'gemini', pid: 3, cwd: '/x', homedir })).reason, /not read for gemini/);
  assert.match((await L.transcriptSection({ file: path.join(dir, 'missing.jsonl'), format: 'claude' }, 5)).reason, /does not exist/);
  assert.equal(await L.readClaudeSession(path.join(homedir, '.claude', 'sessions'), 1, (f) => fs.promises.readFile(f, 'utf8')), null);
});

test('validation step: the running step, else the last step that ran', () => {
  assert.equal(L.currentStep('run:\n  id: "01RUN"\n  steps[3]{step,status,findings,duration_ms}:\n    intent,completed,0,0\n    review,completed,0,0\n    test,pending,0,0\n'), 'review');
  assert.equal(L.currentStep('run:\n  active_steps[1]{step,active_for,last_activity,agent_pid,round}:\n    lint,1m,2s,1,"auto-fix 1/3"\n  steps[1]{step,status,findings,duration_ms}:\n    intent,completed,0,0\n'), 'lint');
  assert.equal(L.currentStep('run:\n  steps[1]{step,status,findings,duration_ms}:\n    --evil,running,0,0\n'), null, 'a step that is not a plain name never reaches a command line');
  assert.equal(L.currentStep('error: no run'), null);
});

// ---- service and server: every command is faked ----
const fakeExec = (overrides = {}) => {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd: path.basename(cmd), args, opts });
    const name = path.basename(cmd);
    if (overrides[name]) return overrides[name](args, opts);
    if (name === 'ps') return { ok: true, stdout: PS };
    if (name === 'lsof') return { ok: true, stdout: 'p201\nn/work/demo-task-1\n' };
    if (name === 'fm-peek.sh') return { ok: true, stdout: 'pane line AKIAABCDEFGHIJKLMNOP\n' };
    if (name === 'no-mistakes') return args[1] === 'status' ? { ok: true, stdout: 'run:\n  steps[1]{step,status,findings,duration_ms}:\n    review,running,0,0\n' } : { ok: true, stdout: 'review log\n' };
    return { ok: false, reason: `${name} is not installed` };
  };
  return { exec, calls };
};

test('service: logs are read through fm-peek and no-mistakes with argument arrays, redacted', async (t) => {
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-home-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-fm-'));
  t.after(() => { fs.rmSync(homedir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(home, 'state'));
  fs.writeFileSync(path.join(home, 'state', 'demo-task-1.status'), 'working [at=1]: started\npaused [at=2]: password=hunter2\n');
  fs.writeFileSync(path.join(home, 'state', 'demo-task-1.meta'), 'model=demo-model\nworktree=/secret/not-read\n');
  const { exec, calls } = fakeExec();
  const agents = A.makeAgents({ home, homedir, exec, snapshot: () => ({ tasks: [task('demo-task-1', { current_state: { state: 'working', source: 'run-step', detail: 'review running' } })] }) });
  const v = await agents.overview();
  assert.equal(v.fleet[0].model, 'demo-model');
  const { status, body } = await agents.log(new URLSearchParams('task=demo-task-1&lines=20'));
  assert.equal(status, 200);
  const byKey = Object.fromEntries(body.sections.map((s) => [s.key, s]));
  assert.deepEqual(byKey.pane.lines, ['pane line [redacted AWS key]']);
  assert.deepEqual(byKey.status.lines, ['working [at=1]: started', 'paused [at=2]: password=[redacted]']);
  assert.deepEqual([byKey.validation.title, byKey.validation.lines], ['Validation log: review step', ['review log']]);
  assert.match(body.notice, /sensitive/);
  const peek = calls.find((c) => c.cmd === 'fm-peek.sh');
  assert.deepEqual(peek.args, ['demo-task-1', '20']);
  assert.deepEqual([peek.opts.env.FM_HOME, peek.opts.env.FM_GUARD_READ_ONLY], [home, '1'], 'fm-peek never claims the watcher banner');
  assert.deepEqual(calls.find((c) => c.args[1] === 'logs').args, ['axi', 'logs', '--step', 'review']);
  assert.equal(calls.find((c) => c.args[1] === 'logs').opts.cwd, '/work/demo-task-1');
  const other = await agents.log(new URLSearchParams('pid=301'));
  assert.deepEqual(other.body.sections.map((s) => [s.key, s.isAvailable]), [['pane', false], ['transcript', false]]);
  assert.equal((await agents.log(new URLSearchParams('pid=999'))).status, 404);
});

test('degradation: a missing tool or failed read shows unavailable with its reason, never an error page', async () => {
  const { exec } = fakeExec({
    ps: () => ({ ok: false, reason: 'ps is not installed' }),
    'fm-peek.sh': () => ({ ok: false, reason: 'error: endpoint demo:fm-demo-task-1 is gone' }),
  });
  const agents = A.makeAgents({ home: '/nonexistent', homedir: '/nonexistent', exec, snapshot: () => ({ tasks: [task('demo-task-1')] }) });
  const v = await agents.overview();
  assert.deepEqual(v.unavailable, [{ what: 'Process list', reason: 'ps is not installed' }]);
  assert.deepEqual([v.fleet.length, v.others.length], [1, 0]);
  const { body } = await agents.log(new URLSearchParams('task=demo-task-1'));
  const byKey = Object.fromEntries(body.sections.map((s) => [s.key, s]));
  assert.match(byKey.pane.reason, /fm-peek could not read it: error: endpoint .* is gone/);
  assert.match(byKey.status.reason, /no status log/);
  assert.match(byKey.validation.reason, /no no-mistakes run/);
  assert.match(byKey.transcript.reason, /no running agent process/);
  const lsofDown = A.makeAgents({ home: '/nonexistent', homedir: '/nonexistent', exec: fakeExec({ lsof: () => ({ ok: false, stdout: '', reason: 'lsof is not installed' }) }).exec, snapshot: () => null });
  const w = await lsofDown.overview();
  assert.deepEqual(w.unavailable.map((u) => u.what), ['Firstmate workers', 'Working folders']);
  assert.equal(w.others.length, 7);
  const broken = A.makeAgents({ home: '/nonexistent', exec: async () => { throw new Error('boom password=hunter2'); }, snapshot: () => null });
  assert.deepEqual((await broken.overview()).unavailable, [{ what: 'Agents', reason: 'boom password=[redacted]' }]);
});

test('server: agent routes need the page token and the right Host, send no-store, and log nothing', async (t) => {
  const home = makeHome();
  const { exec } = fakeExec();
  const app = await start({ home, port: 0, pollMs: 60_000, resourcesPollMs: 60_000, collectResources: async () => ({}), token: 'demo-token', agentsDeps: { exec, homedir: home } });
  t.after(async () => { await app.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await app.ready;
  const get = (p, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    require('node:http').request({ host: '127.0.0.1', port: app.port, path: p, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject).end();
  });
  const auth = { 'X-Webview-Token': 'demo-token' };
  assert.equal((await get('/api/agents')).status, 403);
  assert.equal((await get('/api/agents', { 'X-Webview-Token': 'wrong-token' })).status, 403);
  assert.equal((await get('/api/agents/log?task=demo-task-1')).status, 403);
  assert.equal((await get('/api/agents', { ...auth, Host: 'evil.example.invalid' })).status, 421);
  assert.equal((await get('/api/agents', auth, 'POST')).status, 405);
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const overview = await get('/api/agents', auth);
    assert.equal(overview.status, 200);
    assert.equal(overview.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(overview.body).fleet.map((f) => f.id), ['demo-task-1']);
    const log = await get('/api/agents/log?task=demo-task-1&lines=10', auth);
    assert.equal(log.status, 200);
    assert.equal(log.headers['cache-control'], 'no-store');
    assert.match(log.body, /\[redacted AWS key\]/);
    assert.doesNotMatch(log.body, /AKIAABCDEFGHIJKLMNOP/);
    assert.equal((await get('/api/agents/log?task=..%2F..%2Fetc%2Fpasswd', auth)).status, 404);
    assert.equal((await get('/api/agents/log?task=demo-task-1&lines=lots', auth)).status, 400);
  } finally { console.error = original; }
  assert.deepEqual(errors, [], 'log and process data never reach the server log');
  for (const file of ['/agents-page.js', '/agents.css']) assert.equal((await get(file)).status, 200, file);
});

// A browser drops an element's scroll position when it leaves the document and ignores
// scrollTop while detached; this stand-in DOM does the same so the log panel can be driven here.
class FakeNode {
  constructor(tag, value = '') { Object.assign(this, { tag, value, children: [], parent: null, dataset: {}, listeners: {}, top: 0, hidden: false }); }
  get isConnected() { return this.isRoot || Boolean(this.parent?.isConnected); }
  append(...nodes) { nodes.forEach((n) => { const c = n instanceof FakeNode ? n : new FakeNode('#text', String(n)); c.remove(); c.parent = this; this.children.push(c); }); }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
    const reset = (n) => { n.top = 0; n.children.forEach(reset); };
    reset(this);
  }
  replaceChildren(...nodes) { [...this.children].forEach((c) => c.remove()); this.append(...nodes); }
  get textContent() { return this.value + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children.forEach((c) => { c.parent = null; }); this.children = []; this.value = String(v); }
  get scrollHeight() { return this.isConnected ? this.value.split('\n').length * 20 : 0; }
  get scrollTop() { return this.top; }
  set scrollTop(v) { if (this.isConnected) this.top = Math.max(0, Math.min(v, this.scrollHeight)); }
  setAttribute() {}
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type) { (this.listeners[type] ?? []).forEach((fn) => fn({ target: this, currentTarget: this })); }
  find(match) { return match(this) ? this : this.children.reduce((hit, c) => hit ?? c.find(match), null); }
  contains() { return false; }
  focus() {}
  showModal() { this.open = true; }
}

test('log panel: auto-scroll follows the tail, and a reader who scrolled up stays put across refreshes', async () => {
  const vm = require('node:vm');
  const body = new FakeNode('body');
  body.isRoot = true;
  let logLines = 50;
  const overview = { generatedAt: new Date().toISOString(), hasSnapshot: true, unavailable: [], others: [],
    counters: Object.fromEntries(['active', 'needs-input', 'stuck', 'idle'].map((k) => [k, { count: 0, reasons: [] }])),
    fleet: [{ id: 'demo-task-1', activity: 'idle', reason: 'waiting', processes: [] }] };
  const logBody = () => ({ target: { label: 'demo-task-1' }, generatedAt: new Date().toISOString(), sections: [
    { key: 'status', title: 'Status log', isAvailable: true, source: 'status', lines: Array.from({ length: logLines }, (_, i) => `line ${i}`) },
    { key: 'pane', title: 'Pane', isAvailable: false, reason: 'no terminal', lines: [] }] });
  const context = vm.createContext({
    window: { FleetRender: R }, URLSearchParams, CSS: { escape: String }, setTimeout: () => 0, clearTimeout: () => {},
    document: { body, hidden: false, activeElement: null },
    fetch: async (url) => ({ ok: true, status: 200, json: async () => (url.startsWith('/api/agents/log') ? logBody() : overview) }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'agents-page.js'), 'utf8'), context);
  const el = (tag, props = {}, ...kids) => {
    const node = new FakeNode(tag);
    Object.entries(props).forEach(([k, v]) => { if (v == null) return; if (k === 'key') node.dataset.key = v; else if (k !== 'aria') node[k] = v; });
    node.append(...kids.flat(Infinity).filter((c) => c != null && c !== '' && c !== false));
    return node;
  };
  const page = context.window.FleetAgents.create({ el, text: (tag, value, props) => el(tag, { ...props, textContent: value ?? '' }), empty: (m) => el('p', { textContent: m }), token: 'demo-token', copyText: async () => true, onChange: () => {} });
  body.append(page.node);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await page.refresh();
  page.render();
  const button = page.node.find((n) => n.dataset.key === 'log:task:demo-task-1');
  button.onclick({ currentTarget: button });
  await settle();
  const dialog = body.find((n) => n.tag === 'dialog');
  const pre = dialog.find((n) => n.tag === 'pre');
  const follow = dialog.find((n) => n.type === 'checkbox');
  const repoll = async () => { dialog.find((n) => n.tag === 'select').fire('change'); await settle(); };
  assert.ok(pre.scrollHeight > 0 && pre.scrollTop === pre.scrollHeight, 'the first read lands on the newest line');
  logLines = 80;
  await repoll();
  assert.equal(pre.scrollTop, 80 * 20, 'new lines keep the tail in view');
  follow.checked = false;
  follow.fire('change');
  pre.scrollTop = 400;
  logLines = 90;
  await repoll();
  assert.equal(pre.scrollTop, 400, 'with auto-scroll off a refresh leaves the reader where they were');
});
