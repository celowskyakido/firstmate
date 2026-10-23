'use strict';
// Agents tab: every agent CLI process on this machine, firstmate's workers first,
// plus a read-only log view per agent. Fleet facts come from the fleet snapshot
// (bin/fm-crew-state.sh's reconciliation), never from re-reading status logs.
// Process and log data is sensitive: the routes are token-gated, nothing is written
// to disk, and only redacted text leaves this module.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('./agent-logs');
const { parseEtime, parseLsofCwd } = require('./resources');

const AGENT_NAMES = new Set(['claude', 'codex', 'opencode', 'pi', 'omp', 'grok', 'kimi', 'cursor-agent', 'gemini', 'muse', 'devin', 'agy', 'amp', 'aider', 'goose', 'qwen', 'crush']);
const WRAPPERS = new Set(['node', 'bun', 'deno', 'python', 'python3']);
const HEADLESS_FLAGS = new Set(['-p', '--print', '--headless', '--non-interactive']);
const PS_ARGS = ['-A', '-ww', '-o', 'pid=,ppid=,uid=,pcpu=,rss=,etime=,tty=,args='];
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const LINES = { fallback: 200, max: 1000 };
const ACTIVE_CPU = 2;
const QUIET_SECONDS = 30 * 60;
const MAX_CHILDREN = 40;
const CACHE_MS = 3000;
const MCP = /mcp|chrome-devtools/i;
const ORDER = { active: 0, 'needs-input': 1, stuck: 2, idle: 3 };
const PEEK_SCRIPT = path.resolve(__dirname, '..', 'bin', 'fm-peek.sh');
const NOTICE = 'Logs may still contain sensitive data: obvious secrets are masked, but not everything can be. Do not paste them anywhere public.';

const parsePs = (text) => text.split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/))
  .filter(Boolean)
  .map(([, pid, ppid, uid, cpu, rss, etime, tty, args]) => ({
    pid: Number(pid), ppid: Number(ppid), uid: Number(uid), cpu: Number(cpu.replace(',', '.')), rssBytes: Number(rss) * 1024,
    ageSeconds: parseEtime(etime), tty: /^(\?\??|-)$/.test(tty) ? null : tty, args,
  }));

// `node /path/to/gemini.js` is gemini; the wrapper itself is never the agent.
const program = (args) => {
  const argv = args.trim().split(/\s+/);
  const first = path.basename(argv[0] ?? '');
  const isWrapped = WRAPPERS.has(first) && Boolean(argv[1]) && !argv[1].startsWith('-');
  return { name: isWrapped ? path.basename(argv[1]).replace(/\.(?:[cm]?js|ts|py)$/, '') : first, rest: argv.slice(isWrapped ? 2 : 1) };
};
const agentName = (args) => {
  const { name, rest } = program(args);
  return AGENT_NAMES.has(name) ? name : name === 'acli' && rest[0] === 'rovodev' ? 'rovodev' : null;
};
const modelFlag = (args) => args.match(/(?:^|\s)(?:--model|-m)(?:=|\s+)([A-Za-z0-9._:/@-]{1,80})/)?.[1] ?? null;

// Each agent with no agent above it, with its whole process subtree; a nested agent
// (a headless run started by a session) belongs to the outer one.
const agentRoots = (procs) => {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const kids = new Map();
  procs.forEach((p) => { if (p.ppid !== p.pid) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]); });
  const ancestors = (p) => {
    const up = [];
    for (let a = byPid.get(p.ppid); a && a !== p && up.length < 64 && !up.includes(a); a = byPid.get(a.ppid)) up.push(a);
    return up;
  };
  return procs.filter((p) => agentName(p.args)).map((p) => ({ proc: p, ancestors: ancestors(p) }))
    .filter(({ ancestors: up }) => !up.some((a) => agentName(a.args)))
    .map(({ proc, ancestors: up }) => {
      const descendants = [];
      const seen = new Set([proc.pid]);
      for (const stack = [...(kids.get(proc.pid) ?? [])]; stack.length;) {
        const c = stack.pop();
        if (seen.has(c.pid)) continue;
        seen.add(c.pid);
        descendants.push(c);
        stack.push(...(kids.get(c.pid) ?? []));
      }
      return { proc, name: agentName(proc.args), ancestors: up, descendants: descendants.sort((a, b) => b.cpu - a.cpu) };
    });
};

const isUnder = (dir, root) => dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`);
// The deepest fleet folder containing the process's cwd names its task.
const fleetMatch = (cwd, fleetDirs) => (cwd ? fleetDirs.filter((f) => isUnder(cwd, f.dir)).sort((a, b) => b.dir.length - a.dir.length)[0]?.id ?? null : null);

const classify = ({ name, proc, ancestors }, { task, cwd, home }) => {
  const { rest } = program(proc.args);
  if (task) return { class: 'fleet', role: task.kind === 'secondmate' ? 'Second mate' : 'Firstmate worker' };
  if (ancestors.some((a) => program(a.args).name === 'no-mistakes')) return { class: 'headless', role: 'no-mistakes pipeline' };
  if (name === 'claude' && ['bg-pty-host', 'agents', 'daemon'].includes(rest[0])) return { class: 'headless', role: 'Supervision host' };
  if (rest.some((a) => HEADLESS_FLAGS.has(a)) || ['exec', 'run'].includes(rest[0])) return { class: 'headless', role: 'Headless run' };
  if (!proc.tty) return { class: 'headless', role: 'Background (no terminal)' };
  if (cwd && cwd === home) return { class: 'interactive', role: 'Firstmate session (this home)' };
  return { class: 'interactive', role: 'Interactive session' };
};

const secondsSince = (ms, now) => (ms ? Math.max(0, Math.round((now - ms) / 1000)) : null);
const round1 = (n) => Math.round(n * 10) / 10;
const duration = (s) => (s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);

const processRow = (r, { cwd, claude, activity, role, now }) => {
  const tree = [r.proc, ...r.descendants];
  const cpu = round1(tree.reduce((n, p) => n + p.cpu, 0));
  const isBusy = claude?.status === 'busy';
  const foreground = r.descendants.filter((c) => !MCP.test(c.args)).sort((a, b) => a.ageSeconds - b.ageSeconds)[0];
  return {
    pid: r.proc.pid, ppid: r.proc.ppid, name: r.name, ...role, command: L.clip(L.redact(r.proc.args), 200), cwd, tty: r.proc.tty,
    ageSeconds: r.proc.ageSeconds, cpu, rssBytes: tree.reduce((n, p) => n + p.rssBytes, 0), model: modelFlag(r.proc.args),
    activity: isBusy || cpu >= ACTIVE_CPU ? 'active' : 'idle',
    reason: isBusy ? 'Claude reports it busy' : cpu >= ACTIVE_CPU ? `using ${cpu}% CPU` : claude?.status === 'idle' ? 'Claude reports it idle' : 'no CPU use right now',
    foreground: foreground ? L.clip(L.redact(foreground.args), 160) : null,
    lastActivitySeconds: secondsSince(Math.max(activity?.mtimeMs ?? 0, claude?.updatedAt ?? 0), now),
    lastTool: activity?.lastTool ?? null, lastAction: activity?.lastAction ?? null,
    childCount: r.descendants.length,
    children: r.descendants.slice(0, MAX_CHILDREN).map((c) => ({
      pid: c.pid, ppid: c.ppid, command: L.clip(L.redact(c.args), 160), cpu: c.cpu, rssBytes: c.rssBytes, ageSeconds: c.ageSeconds,
    })),
  };
};

// Activity from the snapshot's current state, which is crew-state's reconciled read.
const fleetActivity = (t, lastOutputSeconds) => {
  const state = t.current_state?.state ?? 'unknown';
  const detail = t.current_state?.detail || state;
  const decision = t.hints?.open_decisions?.find((d) => d.verb === 'needs-decision');
  if (decision || t.backlog?.captain_actionable) return ['needs-input', decision ? `decision: ${decision.summary}` : 'held for a captain decision'];
  if (state === 'parked') return ['needs-input', `parked: ${detail}`];
  if (state === 'blocked' || state === 'failed' || t.hints?.blocked_event) return ['stuck', `${state}: ${detail}`];
  if (state === 'working' && t.endpoint?.exists === false && !t.remote) return ['stuck', 'working, but its terminal pane is gone'];
  if (state === 'working' && lastOutputSeconds > QUIET_SECONDS) return ['stuck', `no transcript output for ${duration(lastOutputSeconds)}`];
  if (state === 'working') return ['active', detail];
  return ['idle', `${state}: ${detail}`];
};

const fleetRow = (t, { meta = {}, processes = [] }) => {
  const lead = processes[0];
  const lastOutputSeconds = lead?.lastActivitySeconds ?? null;
  const [activity, reason] = fleetActivity(t, lastOutputSeconds);
  const started = Number(meta.spawn_gen?.match(/^s(\d+)\./)?.[1]);
  const event = t.paths?.status_log?.last_event;
  return {
    id: t.id, kind: t.kind ?? null, harness: t.harness ?? null, model: meta.model || lead?.model || null, effort: meta.effort || null,
    backend: t.backend ?? (t.remote ? 'remote' : 'tmux'), target: t.endpoint?.target ?? null, endpoint: t.endpoint?.status ?? null,
    worktree: t.paths?.worktree?.path ?? t.paths?.home?.path ?? null,
    startedAt: started ? new Date(started * 1000).toISOString() : null,
    state: t.current_state?.state ?? 'unknown', stateSource: t.current_state?.source ?? null, detail: L.redact(t.current_state?.detail ?? ''),
    lastEvent: event ? { state: event.state ?? null, note: L.clip(L.redact(event.note ?? ''), 200), ageSeconds: event.age_seconds ?? null } : null,
    activity, reason: L.clip(L.redact(reason), 200), lastOutputSeconds, lastTool: lead?.lastTool ?? null, lastAction: lead?.lastAction ?? null,
    processes,
  };
};

const byActivity = (a, b) => ORDER[a.activity] - ORDER[b.activity];
const counters = (rows) => Object.fromEntries(Object.keys(ORDER).map((k) => {
  const hits = rows.filter((r) => r.activity === k);
  return [k, { count: hits.length, reasons: hits.slice(0, 6).map((r) => L.clip(`${r.label}: ${r.reason}`, 110)) }];
}));

const buildOverview = ({ snapshot, roots, cwdByPid, claudeByPid, activityByPid, fleetDirs, metaById, home, now, unavailable }) => {
  const tasks = snapshot?.tasks ?? [];
  const processesByTask = new Map();
  const others = [];
  for (const r of roots) {
    const cwd = cwdByPid.get(r.proc.pid) ?? claudeByPid.get(r.proc.pid)?.cwd ?? null;
    const task = tasks.find((t) => t.id === fleetMatch(cwd, fleetDirs));
    const row = processRow(r, { cwd, claude: claudeByPid.get(r.proc.pid), activity: activityByPid.get(r.proc.pid), role: classify(r, { task, cwd, home }), now });
    if (task) processesByTask.set(task.id, [...(processesByTask.get(task.id) ?? []), row]);
    else others.push(row);
  }
  const fleet = tasks.map((t) => fleetRow(t, { meta: metaById.get(t.id), processes: processesByTask.get(t.id) }))
    .sort((a, b) => byActivity(a, b) || (a.lastOutputSeconds ?? Infinity) - (b.lastOutputSeconds ?? Infinity) || a.id.localeCompare(b.id));
  others.sort((a, b) => byActivity(a, b) || b.cpu - a.cpu || a.pid - b.pid);
  return {
    generatedAt: new Date(now).toISOString(), notice: NOTICE, hasSnapshot: Boolean(snapshot), unavailable,
    counters: counters([...fleet.map((f) => ({ ...f, label: f.id })), ...others.map((o) => ({ ...o, label: `${o.name} ${o.pid}` }))]),
    fleet, others,
  };
};

// Exactly one of task or pid, each checked against the live allowlist; lines is clamped.
const parseLogQuery = (params, { taskIds, agentPids }) => {
  const task = params.get('task');
  const pid = params.get('pid');
  const rawLines = params.get('lines');
  if ((task == null) === (pid == null)) return { status: 400, error: 'name exactly one of task or pid' };
  if (rawLines != null && !/^[1-9]\d{0,8}$/.test(rawLines)) return { status: 400, error: 'lines must be a positive whole number' };
  const lines = Math.min(rawLines == null ? LINES.fallback : Number(rawLines), LINES.max);
  if (task != null) return TASK_ID.test(task) && taskIds.has(task) ? { task, lines } : { status: 404, error: 'unknown task' };
  return /^[1-9]\d{0,9}$/.test(pid) && agentPids.has(Number(pid)) ? { pid: Number(pid), lines } : { status: 404, error: 'unknown agent process' };
};

const META_KEYS = new Set(['model', 'effort', 'spawn_gen']);
const parseMeta = (text) => Object.fromEntries(text.split('\n').map((l) => l.match(/^([a-z_]+)=(.*)$/)).filter((m) => m && META_KEYS.has(m[1])).map((m) => [m[1], m[2].trim()]));
const realpath = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

const makeAgents = ({
  home, snapshot: getSnapshot, exec = L.run, readFile = (f) => fs.promises.readFile(f, 'utf8'), homedir = os.homedir(), now = Date.now, peekScript = PEEK_SCRIPT,
}) => {
  const collect = async () => {
    const at = now();
    const unavailable = [];
    const snapshot = getSnapshot();
    if (!snapshot) unavailable.push({ what: 'Firstmate workers', reason: 'the fleet snapshot has not loaded yet' });
    const ps = await exec('ps', PS_ARGS, { timeout: 5000 });
    if (!ps.ok) unavailable.push({ what: 'Process list', reason: ps.reason });
    const roots = ps.ok ? agentRoots(parsePs(ps.stdout)) : [];
    let cwdByPid = new Map();
    if (roots.length) {
      // lsof exits non-zero when one pid has gone, yet still lists the rest.
      const lsof = await exec('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', roots.map((r) => r.proc.pid).join(',')], { timeout: 3000 });
      if (lsof.ok || lsof.stdout) cwdByPid = parseLsofCwd(lsof.stdout);
      else unavailable.push({ what: 'Working folders', reason: lsof.reason });
    }
    const sessionsDir = path.join(homedir, '.claude', 'sessions');
    const claudeByPid = new Map((await Promise.all(roots.filter((r) => r.name === 'claude')
      .map(async (r) => [r.proc.pid, await L.readClaudeSession(sessionsDir, r.proc.pid, readFile)]))).filter(([, s]) => s));
    const tasks = (snapshot?.tasks ?? []).filter((t) => TASK_ID.test(t.id ?? ''));
    const fleetDirs = tasks.flatMap((t) => [t.paths?.worktree?.path, t.paths?.home?.path].filter(Boolean)
      .flatMap((dir) => [...new Set([dir, realpath(dir)])].map((d) => ({ id: t.id, dir: d }))));
    const metaById = new Map(await Promise.all(tasks.map(async (t) => [t.id, await readFile(path.join(home, 'state', `${t.id}.meta`)).then(parseMeta, () => ({}))])));
    const cwdCount = new Map();
    cwdByPid.forEach((cwd) => cwdCount.set(cwd, (cwdCount.get(cwd) ?? 0) + 1));
    const whereByPid = new Map(await Promise.all(roots.map(async (r) => {
      const cwd = cwdByPid.get(r.proc.pid) ?? null;
      return [r.proc.pid, await L.locateTranscript({
        name: r.name, pid: r.proc.pid, cwd, claude: claudeByPid.get(r.proc.pid), sharedCwd: (cwdCount.get(cwd) ?? 0) > 1, homedir, now: at,
      })];
    })));
    const activityByPid = new Map(await Promise.all([...whereByPid].map(async ([pid, where]) => [pid, await L.transcriptActivity(where)])));
    const view = buildOverview({ snapshot, roots, cwdByPid, claudeByPid, activityByPid, fleetDirs, metaById, home, now: at, unavailable });
    const pidsByTask = new Map(view.fleet.map((f) => [f.id, f.processes.map((p) => p.pid)]));
    return { view, snapshot: { tasks }, whereByPid, pidsByTask };
  };

  // One collection serves every request within CACHE_MS, and concurrent callers share it.
  let cached = null;
  const current = () => {
    if (!cached || now() - cached.at > CACHE_MS) {
      const promise = collect().catch((e) => ({
        view: { generatedAt: new Date(now()).toISOString(), notice: NOTICE, hasSnapshot: false, counters: counters([]), fleet: [], others: [], unavailable: [{ what: 'Agents', reason: L.clip(L.redact(e.message), 200) }] },
        snapshot: { tasks: [] }, whereByPid: new Map(), pidsByTask: new Map(),
      }));
      cached = { at: now(), promise };
    }
    return cached.promise;
  };

  const readLog = async (q, state) => {
    if (q.task) {
      const task = state.snapshot.tasks.find((t) => t.id === q.task);
      const pid = state.pidsByTask.get(q.task)?.[0];
      const worktree = task.paths?.worktree?.present ? task.paths.worktree.path : null;
      return {
        target: { kind: 'task', id: q.task, label: task.backlog?.title ? `${q.task}: ${task.backlog.title}` : q.task },
        sections: await Promise.all([
          L.paneSection({ peekScript, home, id: q.task, lines: q.lines, exec }),
          L.statusSection(path.join(home, 'state', `${q.task}.status`), q.lines),
          L.validationSection({ worktree, isRun: task.current_state?.source === 'run-step', lines: q.lines, exec }),
          L.transcriptSection(pid ? state.whereByPid.get(pid) : { reason: 'no running agent process was found in its local copy' }, q.lines),
        ]),
      };
    }
    const row = state.view.others.find((o) => o.pid === q.pid) ?? state.view.fleet.flatMap((f) => f.processes).find((p) => p.pid === q.pid);
    return {
      target: { kind: 'process', pid: q.pid, label: `${row.name} ${q.pid} (${row.role})` },
      sections: [
        L.section('pane', 'Terminal pane', { reason: 'only firstmate workers have a recorded pane; this view does not read other terminals' }),
        await L.transcriptSection(state.whereByPid.get(q.pid), q.lines),
      ],
    };
  };

  // Identical log requests in flight share one read, so several open pages cannot pile up captures.
  const inFlight = new Map();
  const log = async (params) => {
    const state = await current();
    const q = parseLogQuery(params, { taskIds: new Set(state.snapshot.tasks.map((t) => t.id)), agentPids: new Set(state.whereByPid.keys()) });
    if (q.error) return { status: q.status, body: { error: q.error } };
    const key = `${q.task ?? q.pid}:${q.lines}`;
    if (!inFlight.has(key)) inFlight.set(key, readLog(q, state).finally(() => inFlight.delete(key)));
    const body = await inFlight.get(key);
    return { status: 200, body: { ...body, lines: q.lines, generatedAt: new Date(now()).toISOString(), notice: NOTICE } };
  };

  return { overview: async () => (await current()).view, log };
};

module.exports = {
  AGENT_NAMES, LINES, PS_ARGS, parsePs, program, agentName, modelFlag, agentRoots, fleetMatch, classify, fleetActivity, fleetRow, buildOverview, parseLogQuery, parseMeta, makeAgents,
};
