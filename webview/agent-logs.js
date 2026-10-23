'use strict';
// Read-only log sources for the Agents tab: pane capture through bin/fm-peek.sh, the
// task's status log, its no-mistakes step log, and the Claude or Codex session
// transcript. Log text can hold secrets or PHI, so everything here is redacted
// before it leaves, is never written anywhere, and never reaches the server log.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const TAIL_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;
const PEEK_TIMEOUT_MS = 8000;
const NM_TIMEOUT_MS = 5000;
const CODEX_DAYS = 3;
const CODEX_FILES = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STEP = /^[a-z0-9][a-z0-9_-]{0,40}$/;

// Conservative: a false positive hides a harmless word, a miss shows a secret.
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted AWS key]'],
  [/(?<![A-Za-z0-9])(aws_secret_access_key|aws_session_token)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1$2[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\b(authorization)(["']?\s*[:=]\s*["']?)(?:(?:Basic|Bearer)\s+)?[^\s"',;]+/gi, '$1$2[redacted]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted token]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted token]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, '[redacted key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted token]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[redacted]@'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[redacted token]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[redacted token]'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, '[redacted key]'],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, '[redacted key]'],
  // A keyword may end an underscore- or dash-joined name (DB_PASSWORD=, --db-password=) but never a plain word (mytoken=).
  [/(?<![A-Za-z0-9])(password|passwd|pwd|secret|client_secret|(?:api|secret|private|access)[_-]?key|access[_-]?token|auth[_-]?token|token)(["']?\s*[:=]\s*["']?)(?!\[redacted)[^\s"'&,;]+/gi, '$1$2[redacted]'],
  [/(?<![A-Za-z0-9-])(--?(?:[A-Za-z0-9]+[_-])*(?:password|passwd|pass|secret|client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)\s+["']?)(?![-\[])[^\s"'&,;]+/gi, '$1[redacted]'],
];
const redact = (text) => SECRETS.reduce((s, [pattern, replacement]) => s.replace(pattern, replacement), String(text));
// Terminal escapes and other control characters never reach the page.
const plain = (text) => String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const cleanLines = (text, lines) => redact(plain(text)).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l, i, all) => l || i < all.length - 1).slice(-lines);
const clip = (value, max = 300) => {
  const t = String(value ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const reasonOf = (text) => clip(redact(plain(text)).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '', 200);

const section = (key, title, fields) => ({ key, title, isAvailable: false, reason: null, lines: [], ...fields });

// Never throws: { ok, stdout, reason }. Argument arrays only, short timeouts, no shell.
const run = (cmd, args, { timeout = 5000, cwd, env } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, cwd, env, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
    if (!error) return resolve({ ok: true, stdout });
    const reason = error.killed ? `timed out after ${timeout} ms` : error.code === 'ENOENT' ? `${path.basename(cmd)} is not installed`
      : reasonOf(stderr) || reasonOf(stdout) || `exit code ${error.code}`;
    return resolve({ ok: false, stdout, reason });
  });
});

const tail = async (file, bytes = TAIL_BYTES) => {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size, mtimeMs } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A cut-off first line is dropped rather than shown half-parsed.
    return { text: length < size ? text.slice(text.indexOf('\n') + 1) : text, size, mtimeMs };
  } finally { await handle.close(); }
};

// ---- transcripts ----
const contentText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join(' ') : '');
const toolBrief = (name, input) => {
  const v = input && typeof input === 'object'
    ? input.command ?? input.cmd ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description
    : input;
  return v == null || v === '' ? String(name) : `${name}: ${clip(Array.isArray(v) ? v.join(' ') : v, 160)}`;
};
const blocks = (content) => (Array.isArray(content) ? content : []);

const claudeEntries = (records) => records.flatMap((r) => {
  const at = r.timestamp ?? null;
  const content = r.message?.content;
  if (r.type === 'user') {
    if (typeof content === 'string') return [{ at, kind: 'user', text: clip(content) }];
    return blocks(content).flatMap((c) => (c.type === 'text' ? [{ at, kind: 'user', text: clip(c.text) }]
      : c.type === 'tool_result' ? [{ at, kind: 'result', text: clip(contentText(c.content), 200) }] : []));
  }
  if (r.type === 'assistant') {
    return blocks(content).flatMap((c) => (c.type === 'text' ? [{ at, kind: 'assistant', text: clip(c.text) }]
      : c.type === 'tool_use' ? [{ at, kind: 'tool', tool: c.name, text: toolBrief(c.name, c.input) }] : []));
  }
  return [];
});

const codexEntries = (records) => records.flatMap((r) => {
  const p = r.type === 'response_item' ? r.payload : null;
  const at = r.timestamp ?? null;
  if (p?.type === 'message' && (p.role === 'user' || p.role === 'assistant')) return [{ at, kind: p.role, text: clip(contentText(p.content)) }];
  if (p?.type === 'function_call' || p?.type === 'custom_tool_call') {
    let input = p.arguments ?? p.input;
    try { input = JSON.parse(input); } catch { /* plain text input */ }
    return [{ at, kind: 'tool', tool: p.name, text: toolBrief(p.name, input) }];
  }
  if (p?.type === 'function_call_output' || p?.type === 'custom_tool_call_output') {
    return [{ at, kind: 'result', text: clip(typeof p.output === 'string' ? p.output : JSON.stringify(p.output), 200) }];
  }
  return [];
});

const parseJsonl = (text) => text.split('\n').flatMap((line) => {
  try { return line ? [JSON.parse(line)] : []; } catch { return []; }
});
const entriesOf = (format, text) => (format === 'codex' ? codexEntries : claudeEntries)(parseJsonl(text))
  .filter((e) => e.text).map((e) => ({ ...e, text: redact(e.text) }));
// Server-local time: the server and the page run on the same machine.
const formatEntry = (e) => `${e.at && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toTimeString().slice(0, 8) : '--:--:--'}  ${e.kind.padEnd(9)} ${e.text}`;

// Claude names a project folder after its cwd with every other character turned into '-'.
const claudeProjectDir = (projectsDir, cwd) => path.join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'));

// Claude Code keeps ~/.claude/sessions/<pid>.json for each live session; it is
// undocumented, so anything missing or malformed simply reads as unknown.
const readClaudeSession = async (sessionsDir, pid, readFile) => {
  try {
    const s = JSON.parse(await readFile(path.join(sessionsDir, `${pid}.json`)));
    return {
      sessionId: UUID.test(s.sessionId ?? '') ? s.sessionId : null,
      cwd: typeof s.cwd === 'string' && path.isAbsolute(s.cwd) ? s.cwd : null,
      status: ['busy', 'idle'].includes(s.status) ? s.status : null,
      updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : null,
    };
  } catch { return null; }
};

const newestJsonl = async (dir) => {
  let names;
  try { names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.jsonl')); } catch { return null; }
  const stats = await Promise.all(names.map(async (n) => {
    try { return { file: path.join(dir, n), mtimeMs: (await fs.promises.stat(path.join(dir, n))).mtimeMs }; } catch { return null; }
  }));
  return stats.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file ?? null;
};

// A Codex rollout names its cwd in the first line, which never changes, so it is cached per file.
const codexCwdCache = new Map();
const codexCwd = async (file) => {
  if (codexCwdCache.has(file)) return codexCwdCache.get(file);
  let cwd = null;
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const raw = buffer.toString('utf8', 0, bytesRead).match(/"cwd":("(?:[^"\\]|\\.)*")/)?.[1];
      cwd = raw ? JSON.parse(raw) : null;
    } finally { await handle.close(); }
  } catch { /* unreadable reads as no match */ }
  if (codexCwdCache.size > 500) codexCwdCache.clear();
  codexCwdCache.set(file, cwd);
  return cwd;
};

const codexTranscript = async (sessionsDir, cwd, now) => {
  const days = Array.from({ length: CODEX_DAYS }, (_, i) => {
    const d = new Date(now - i * 86400_000);
    return path.join(sessionsDir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  });
  const files = (await Promise.all(days.map(async (dir) => {
    try { return (await fs.promises.readdir(dir)).filter((n) => /^rollout-.*\.jsonl$/.test(n)).map((n) => path.join(dir, n)); } catch { return []; }
  }))).flat().sort().reverse().slice(0, CODEX_FILES);
  for (const file of files) if (await codexCwd(file) === cwd) return file;
  return null;
};

// Where an agent's transcript lives, or why it cannot be found. Paths are built only
// from fixed roots plus a validated session id or a sanitised folder name.
const locateTranscript = async ({ name, pid, cwd, claude, sharedCwd, homedir, now }) => {
  if (name === 'claude') {
    const projects = path.join(homedir, '.claude', 'projects');
    const folder = claude?.cwd ?? cwd;
    if (!folder) return { reason: 'its working folder is unknown' };
    if (claude?.sessionId) return { file: path.join(claudeProjectDir(projects, folder), `${claude.sessionId}.jsonl`), format: 'claude' };
    const file = await newestJsonl(claudeProjectDir(projects, folder));
    return file ? { file, format: 'claude', isGuess: sharedCwd } : { reason: 'no Claude transcript for its folder' };
  }
  if (name === 'codex') {
    if (!cwd) return { reason: 'its working folder is unknown' };
    const file = await codexTranscript(path.join(homedir, '.codex', 'sessions'), cwd, now);
    return file ? { file, format: 'codex', isGuess: sharedCwd } : { reason: `no Codex session for its folder in the last ${CODEX_DAYS} days` };
  }
  return { reason: `transcripts are not read for ${name ?? 'this agent'} (pid ${pid})` };
};

// The last tool call and when the transcript last changed, for the overview.
const transcriptActivity = async (where) => {
  if (!where?.file) return null;
  try {
    const { text, mtimeMs } = await tail(where.file, 128 * 1024);
    const last = entriesOf(where.format, text).filter((e) => e.kind === 'tool').pop();
    return { mtimeMs, lastTool: last?.tool ?? null, lastAction: last ? clip(last.text, 120) : null };
  } catch { return null; }
};

const transcriptSection = async (where, lines) => {
  const title = 'Session transcript';
  if (!where?.file) return section('transcript', title, { reason: where?.reason ?? 'not located' });
  try {
    // Tool results can be huge, so the window grows until it holds enough entries or hits the cap.
    let bytes = TAIL_BYTES;
    let read = await tail(where.file, bytes);
    let entries = entriesOf(where.format, read.text);
    while (entries.length < lines && bytes < read.size && bytes < TRANSCRIPT_MAX_BYTES) {
      bytes *= 4;
      read = await tail(where.file, Math.min(bytes, TRANSCRIPT_MAX_BYTES));
      entries = entriesOf(where.format, read.text);
    }
    const { mtimeMs } = read;
    return section('transcript', title, {
      isAvailable: true, lines: entries.slice(-lines).map(formatEntry), updatedAt: new Date(mtimeMs).toISOString(),
      note: where.isGuess ? 'Newest transcript for this folder; another session in the same folder may have written it.' : null,
      source: where.format === 'codex' ? 'Codex session' : 'Claude session',
    });
  } catch (e) {
    return section('transcript', title, { reason: e.code === 'ENOENT' ? 'the transcript file does not exist yet' : `could not read the transcript (${e.code ?? 'error'})` });
  }
};

// ---- fleet-only sources ----
// FM_GUARD_READ_ONLY keeps fm-peek's supervision guard from claiming the home's
// one-per-episode watcher banner, which firstmate itself must still see.
const paneSection = async ({ peekScript, home, id, lines, exec = run }) => {
  const out = await exec(peekScript, [id, String(lines)], { timeout: PEEK_TIMEOUT_MS, env: { ...process.env, FM_HOME: home, FM_GUARD_READ_ONLY: '1' } });
  return out.ok ? section('pane', 'Terminal pane', { isAvailable: true, lines: cleanLines(out.stdout, lines), source: 'bin/fm-peek.sh' })
    : section('pane', 'Terminal pane', { reason: `fm-peek could not read it: ${out.reason}` });
};

const statusSection = async (file, lines) => {
  try {
    const { text } = await tail(file, 64 * 1024);
    return section('status', 'Status log (history, not current state)', { isAvailable: true, lines: cleanLines(text, lines) });
  } catch (e) {
    return section('status', 'Status log (history, not current state)', { reason: e.code === 'ENOENT' ? 'no status log yet' : `unreadable (${e.code ?? 'error'})` });
  }
};

// The step to show: the running one, else the last step that ran.
const currentStep = (toon) => {
  const table = (name) => {
    const at = toon.split('\n').findIndex((l) => new RegExp(`^\\s*${name}\\[\\d+\\]\\{`).test(l));
    if (at < 0) return [];
    const columns = toon.split('\n')[at].match(/\{([^}]*)\}/)[1].split(',');
    const indent = toon.split('\n')[at].search(/\S/);
    const rows = [];
    for (const line of toon.split('\n').slice(at + 1)) {
      if (!line.trim() || line.search(/\S/) <= indent) break;
      const cells = line.trim().split(',');
      rows.push(Object.fromEntries(columns.map((c, i) => [c, cells[i]])));
    }
    return rows;
  };
  const step = table('active_steps')[0]?.step
    ?? table('steps').filter((r) => !['pending', 'skipped'].includes(r.status)).pop()?.step;
  return STEP.test(step ?? '') ? step : null;
};

const validationSection = async ({ worktree, isRun, lines, exec = run }) => {
  const title = 'Validation log';
  if (!isRun) return section('validation', title, { reason: 'no no-mistakes run is attributed to this task right now' });
  if (!worktree) return section('validation', title, { reason: 'the task has no local copy on this machine' });
  const status = await exec('no-mistakes', ['axi', 'status'], { timeout: NM_TIMEOUT_MS, cwd: worktree });
  if (!status.ok) return section('validation', title, { reason: `no-mistakes status unavailable: ${status.reason}` });
  const step = currentStep(status.stdout);
  if (!step) return section('validation', title, { reason: 'the run has no step with a log yet' });
  const log = await exec('no-mistakes', ['axi', 'logs', '--step', step], { timeout: NM_TIMEOUT_MS, cwd: worktree });
  return log.ok ? section('validation', `${title}: ${step} step`, { isAvailable: true, lines: cleanLines(log.stdout, lines), source: 'no-mistakes axi logs' })
    : section('validation', title, { reason: `no-mistakes log unavailable: ${log.reason}` });
};

module.exports = {
  redact, plain, cleanLines, clip, run, tail, claudeEntries, codexEntries, entriesOf, formatEntry, claudeProjectDir, readClaudeSession,
  locateTranscript, transcriptActivity, transcriptSection, paneSection, statusSection, currentStep, validationSection, section,
};
