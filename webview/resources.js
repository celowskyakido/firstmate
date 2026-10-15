'use strict';
// Read-only machine health: load, memory, process headroom, Claude session trees,
// and orphaned helpers. One ps call per refresh; every other read is a file or a
// short-timeout command. Parsers are pure so tests feed fixture output, never real ps.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Every alert threshold lives here.
const LIMITS = {
  loadPerCore: 2,
  processShareOfLimit: 0.7,
  sessionTreeProcesses: 300,
  freeMemoryShare: 0.05,
  compressedMemoryShare: 0.5,
  sessionRssBytes: 1.5 * 1024 ** 3,
  claudeSessions: 25,
  orphanAgeSeconds: 3600,
};
const COMMAND_TIMEOUT_MS = 5000;
const LSOF_TIMEOUT_MS = 3000;
const PS_ARGS = ['-A', '-ww', '-o', 'pid=,ppid=,uid=,rss=,etime=,args='];
const NOT_SESSIONS = /^\S+\s+(bg-pty-host|agents)\b/;
const MCP = /mcp|chrome-devtools/i;
const ORPHAN_COMMANDS = new Set(['node', 'npm', 'npx', 'python', 'python3', 'uv', 'uvx']);

// ps etime: [[dd-]hh:]mm:ss
const parseEtime = (text) => {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text];
  return clock.split(':').map(Number).reduce((total, part) => total * 60 + part, 0) + Number(days) * 86400;
};

const parsePs = (text) => text.split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
  .filter(Boolean)
  .map(([, pid, ppid, uid, rss, etime, args]) => ({
    pid: Number(pid), ppid: Number(ppid), uid: Number(uid), rssBytes: Number(rss) * 1024, ageSeconds: parseEtime(etime), args,
  }));

const commandName = (args) => path.basename(args.split(/\s+/)[0] ?? '');
const isSessionRoot = (p) => commandName(p.args).startsWith('claude') && !NOT_SESSIONS.test(p.args);

// A claude process nested under another session's tree belongs to that session.
const sessionTrees = (procs) => {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map();
  procs.forEach((p) => children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]));
  const hasSessionAncestor = (p) => {
    for (let up = byPid.get(p.ppid), seen = 0; up && seen < procs.length; up = byPid.get(up.ppid), seen += 1) {
      if (isSessionRoot(up)) return true;
    }
    return false;
  };
  return procs.filter((p) => isSessionRoot(p) && !hasSessionAncestor(p)).map((root) => {
    const tree = [];
    const seen = new Set();
    for (const stack = [root]; stack.length;) {
      const p = stack.pop();
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      tree.push(p);
      stack.push(...(children.get(p.pid) ?? []));
    }
    return {
      pid: root.pid,
      cwd: null,
      rssBytes: tree.reduce((sum, p) => sum + p.rssBytes, 0),
      processes: tree.length,
      mcpHelpers: tree.filter((p) => MCP.test(p.args)).length,
      ageSeconds: root.ageSeconds,
    };
  }).sort((a, b) => b.rssBytes - a.rssBytes);
};

// The web view's own process is never listed, even when it was started detached.
const orphans = (procs, selfPid = process.pid) => procs.filter((p) => p.ppid === 1 && p.pid !== selfPid && p.ageSeconds > LIMITS.orphanAgeSeconds
  && (ORPHAN_COMMANDS.has(commandName(p.args)) || MCP.test(p.args)))
  .map((p) => ({ pid: p.pid, ppid: p.ppid, uid: p.uid, command: p.args.slice(0, 200), rssBytes: p.rssBytes, ageSeconds: p.ageSeconds }));

// macOS: free + inactive + speculative pages are what the kernel can hand out now.
const parseVmStat = (text, totalBytes) => {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
  const pages = (label) => Number(text.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
  return {
    totalBytes,
    freeShare: ((pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * pageSize) / totalBytes,
    compressedShare: (pages('Pages occupied by compressor') * pageSize) / totalBytes,
  };
};

// Linux has no compressor figure; MemAvailable is the kernel's own estimate.
const parseMeminfo = (text) => {
  const kb = (label) => Number(text.match(new RegExp(`^${label}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
  return { totalBytes: kb('MemTotal') * 1024, freeShare: kb('MemAvailable') / kb('MemTotal'), compressedShare: null };
};

const parseLinuxProcLimit = (text) => {
  const soft = text.match(/^Max processes\s+(\S+)/m)?.[1];
  return soft && soft !== 'unlimited' ? Number(soft) : null;
};

// lsof -Fn: "p<pid>" then "n<path>" lines per process.
const parseLsofCwd = (text) => {
  const cwd = new Map();
  let pid = null;
  text.split('\n').forEach((line) => {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid != null) cwd.set(pid, line.slice(1));
  });
  return cwd;
};

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const pct = (share) => `${Math.round(share * 100)}%`;

// Plain-language alerts, each naming what to look at.
const alerts = ({ load, memory, processes, sessions, orphans: lost }) => [
  load.oneMinute > LIMITS.loadPerCore * load.cores
    && `Machine is overloaded: load ${load.oneMinute.toFixed(1)} on ${load.cores} cores. Look at the largest sessions below and any runaway test runs.`,
  processes.limit && processes.user > LIMITS.processShareOfLimit * processes.limit
    && `Running out of processes: ${processes.user} of the ${processes.limit} per-user limit. New sessions and tests will start failing; look for a session with a huge process count.`,
  ...sessions.filter((s) => s.processes > LIMITS.sessionTreeProcesses).map((s) => `Session ${s.cwd ?? `pid ${s.pid}`} has ${s.processes} processes: likely a runaway test or fork storm. Check what that session is running.`),
  memory && memory.freeShare < LIMITS.freeMemoryShare && `Memory almost exhausted: ${pct(memory.freeShare)} free. Close the largest sessions below.`,
  memory?.compressedShare != null && memory.compressedShare > LIMITS.compressedMemoryShare
    && `Memory under heavy pressure: ${pct(memory.compressedShare)} compressed. Close the largest sessions below.`,
  ...sessions.filter((s) => s.rssBytes > LIMITS.sessionRssBytes).map((s) => `Session ${s.cwd ?? `pid ${s.pid}`} is using ${gb(s.rssBytes)} of memory. Check its MCP helpers and child processes.`),
  sessions.length > LIMITS.claudeSessions && `${sessions.length} Claude sessions are running (more than ${LIMITS.claudeSessions}). Close the ones no longer needed.`,
  lost.length && `${lost.length} orphaned helper process${lost.length === 1 ? ' is' : 'es are'} still running with no parent. See the stray helpers list on the Machine page.`,
].filter(Boolean);

const run = (cmd, args, timeout) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});
const tolerate = (promise) => promise.catch(() => null);
const listProcesses = async (exec = run) => parsePs(await exec('ps', PS_ARGS, COMMAND_TIMEOUT_MS));

// `exec` and `readFile` are injectable so tests never touch the real machine.
const collect = async ({
  platform = process.platform, exec = run, readFile = (f) => fs.promises.readFile(f, 'utf8'),
  loadavg = os.loadavg(), cores = os.cpus().length, uid = process.getuid?.() ?? null,
} = {}) => {
  const isMac = platform === 'darwin';
  const [psText, sysctl, vmStat, meminfo, limits] = await Promise.all([
    exec('ps', PS_ARGS, COMMAND_TIMEOUT_MS),
    isMac ? tolerate(exec('sysctl', ['-n', 'hw.memsize', 'kern.maxprocperuid'], COMMAND_TIMEOUT_MS)) : null,
    isMac ? tolerate(exec('vm_stat', [], COMMAND_TIMEOUT_MS)) : null,
    isMac ? null : tolerate(readFile('/proc/meminfo')),
    isMac ? null : tolerate(readFile('/proc/self/limits')),
  ]);
  const procs = parsePs(psText);
  const [memBytes, macProcLimit] = (sysctl ?? '').trim().split(/\s+/).map(Number);
  const memory = isMac ? (vmStat && memBytes ? parseVmStat(vmStat, memBytes) : null) : (meminfo ? parseMeminfo(meminfo) : null);
  const sessions = sessionTrees(procs);
  if (sessions.length) {
    const cwd = parseLsofCwd(await tolerate(exec('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', sessions.map((s) => s.pid).join(',')], LSOF_TIMEOUT_MS)) ?? '');
    sessions.forEach((s) => { s.cwd = cwd.has(s.pid) ? path.basename(cwd.get(s.pid)) : null; });
  }
  const summary = {
    load: { oneMinute: loadavg[0], fiveMinute: loadavg[1], cores },
    memory,
    processes: {
      total: procs.length,
      user: uid == null ? procs.length : procs.filter((p) => p.uid === uid).length,
      limit: (isMac ? macProcLimit : parseLinuxProcLimit(limits ?? '')) || null,
    },
    sessions,
    orphans: orphans(procs),
    uid,
  };
  return { ...summary, alerts: alerts(summary), limits: LIMITS };
};

module.exports = { LIMITS, parseEtime, parsePs, isSessionRoot, listProcesses, sessionTrees, orphans, parseVmStat, parseMeminfo, parseLinuxProcLimit, parseLsofCwd, alerts, collect };
