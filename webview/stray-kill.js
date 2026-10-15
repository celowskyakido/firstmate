'use strict';
// The web view's one write action: stopping a stray helper process. Every request
// re-reads the process table and re-applies the stray rules before any signal is
// sent, so a stale page can never stop something that is no longer a stray.
const resources = require('./resources');

const GRACE_MS = 3000;
const POLL_MS = 100;
// ps ages are whole seconds and the page's copy is up to a refresh old.
const AGE_SLACK_SECONDS = 5;
const CHANGED = 'the process changed since the list was shown; refresh and try again';

// Same process: same owner and command, and not younger than when it was seen.
const isSameProcess = (p, seen) => p.uid === seen.uid && p.args.slice(0, 200) === seen.command && p.ageSeconds + AGE_SLACK_SECONDS >= seen.ageSeconds;

// Why this pid must not be stopped right now, or null when it may be.
const refusal = (procs, pid, { uid, selfPid, expected }) => {
  const p = procs.find((x) => x.pid === pid);
  if (pid === selfPid) return 'that is the web view itself';
  if (uid != null && p.uid !== uid) return 'it belongs to another user';
  if (p.ppid !== 1) return 'it has a parent again, so it is not a stray';
  if (resources.isSessionRoot(p)) return 'it is a Claude session';
  if (!resources.orphans(procs, selfPid).some((o) => o.pid === pid)) return 'it no longer matches the stray helper rules';
  // A stray must have parent pid 1, so no child of a stray is ever classified; any child means refuse.
  if (procs.some((c) => c.ppid === pid)) return 'it has child processes, which the stray rules do not cover';
  // A different command, or a process younger than the one the page showed, means the pid was reused.
  if (!isSameProcess(p, { uid: p.uid, command: expected?.command, ageSeconds: expected?.ageSeconds })) return CHANGED;
  return null;
};

// SIGTERM, wait up to GRACE_MS, then SIGKILL. Returns { outcome, reason? }:
// terminated, killed, already-gone, refused, or failed. The pid is re-verified
// against a fresh process table before SIGKILL, because a helper that exits during
// the grace period can have its pid reused by an unrelated process.
const killStray = async (pid, expected, {
  listProcesses = () => resources.listProcesses(), kill = process.kill, uid = process.getuid?.() ?? null, selfPid = process.pid,
  now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), graceMs = GRACE_MS,
} = {}) => {
  const procs = await listProcesses();
  if (!procs.some((p) => p.pid === pid)) return { outcome: 'already-gone' };
  const reason = refusal(procs, pid, { uid, selfPid, expected });
  if (reason) return { outcome: 'refused', reason };
  const first = procs.find((p) => p.pid === pid);
  const seen = { uid: first.uid, command: first.args.slice(0, 200), ageSeconds: first.ageSeconds };
  const isAlive = () => {
    try { kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  };
  const send = (signal) => {
    try { kill(pid, signal); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
  };
  if (!send('SIGTERM')) return { outcome: 'already-gone' };
  for (const end = now() + graceMs; now() < end; await sleep(POLL_MS)) {
    if (!isAlive()) return { outcome: 'terminated' };
  }
  const later = await listProcesses();
  const current = later.find((p) => p.pid === pid);
  // A younger process, another owner, or another command under the same pid is a replacement, never signalled.
  if (!current || !isSameProcess(current, seen)) return { outcome: 'already-gone' };
  const laterReason = refusal(later, pid, { uid, selfPid, expected: seen });
  if (laterReason) return { outcome: 'refused', reason: `sent the stop request, but did not force-stop it: ${laterReason}` };
  if (!send('SIGKILL')) return { outcome: 'terminated' };
  await sleep(POLL_MS);
  return isAlive() ? { outcome: 'failed', reason: 'still running after SIGKILL' } : { outcome: 'killed' };
};

module.exports = { killStray, refusal, GRACE_MS };
