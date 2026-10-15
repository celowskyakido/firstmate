'use strict';
// Fixture process tables only: nothing here runs the real ps, lsof, or sysctl.
const test = require('node:test');
const assert = require('node:assert/strict');
const resources = require('../resources');
const R = require('../public/render');
const { XSS } = require('./fixture');

const MB = 1024; // ps rss is in KiB
const row = (pid, ppid, rssKb, etime, args, uid = 501) => `${pid} ${ppid} ${uid} ${rssKb} ${etime} ${args}`;
const PS = [
  row(1, 0, 6000, '10-19:05:58', '/sbin/launchd', 0),
  row(100, 1, 400 * MB, '02:00:00', '/Users/demo/.local/bin/claude --resume'),
  row(101, 100, 100 * MB, '01:59:00', 'node /opt/demo/mcp-server.js'),
  row(102, 100, 50 * MB, '01:59:00', 'npx chrome-devtools-mcp'),
  row(103, 101, 10 * MB, '01:00', 'claude --print nested'),
  row(200, 1, 1600 * MB, '05:00', `claude ${XSS}`),
  row(300, 1, 20 * MB, '3-00:00:00', 'claude bg-pty-host'),
  row(301, 1, 20 * MB, '3-00:00:00', 'claude agents'),
  row(400, 1, 30 * MB, '02:00:00', '/usr/bin/python3 -m demo_helper'),
  row(401, 1, 30 * MB, '10:00', 'node /opt/demo/young.js'),
  row(402, 1, 30 * MB, '05:00:00', '/usr/bin/ssh-agent'),
  '  PID  PPID   UID    RSS     ELAPSED ARGS',
].join('\n');
const VM_STAT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                                1000.',
  'Pages inactive:                            1000.',
  'Pages speculative:                         1000.',
  'Pages occupied by compressor:            900000.',
].join('\n');

const fakeExec = (outputs) => async (cmd) => {
  if (!(cmd in outputs)) throw new Error(`unexpected command ${cmd}`);
  if (outputs[cmd] instanceof Error) throw outputs[cmd];
  return outputs[cmd];
};

test('parseEtime handles mm:ss, hh:mm:ss, and dd-hh:mm:ss', () => {
  assert.equal(resources.parseEtime('01:05'), 65);
  assert.equal(resources.parseEtime('02:00:00'), 7200);
  assert.equal(resources.parseEtime('3-00:00:01'), 3 * 86400 + 1);
});

test('session trees include helpers, skip bg-pty-host and agents, and sort by memory', () => {
  const sessions = resources.sessionTrees(resources.parsePs(PS));
  assert.deepEqual(sessions.map((s) => [s.pid, s.processes, s.mcpHelpers]), [[200, 1, 0], [100, 4, 2]]);
  assert.equal(sessions[1].rssBytes, (400 + 100 + 50 + 10) * MB * 1024);
  assert.equal(sessions[1].ageSeconds, 7200);
});

test('orphans are old parentless node/python/mcp helpers only', () => {
  assert.deepEqual(resources.orphans(resources.parsePs(PS)).map((o) => o.pid), [400]);
});

test('collect on macOS: memory, process limit, cwd from lsof, and plain-language alerts', async () => {
  const r = await resources.collect({
    platform: 'darwin', loadavg: [40, 30, 20], cores: 8, uid: 501,
    exec: fakeExec({ ps: PS, sysctl: `${16 * 1024 ** 3}\n12\n`, vm_stat: VM_STAT, lsof: 'p100\nfcwd\nn/Users/demo/projects/demo-app\n' }),
  });
  assert.equal(r.sessions.find((s) => s.pid === 100).cwd, 'demo-app');
  assert.equal(r.sessions.find((s) => s.pid === 200).cwd, null);
  assert.deepEqual(r.processes, { total: 11, user: 10, limit: 12 });
  assert.ok(r.memory.freeShare < 0.05 && r.memory.compressedShare > 0.5);
  const text = r.alerts.join('\n');
  for (const expected of [/overloaded: load 40\.0 on 8 cores/, /10 of the 12 per-user limit/, /almost exhausted/, /heavy pressure: 86% compressed/,
    /pid 200 is using 1\.6 GB/, /1 orphaned helper process is still running/]) assert.match(text, expected);
  assert.doesNotMatch(text, /Claude sessions are running/);
});

test('collect tolerates lsof and sysctl failures and reads Linux /proc', async () => {
  const files = {
    '/proc/meminfo': 'MemTotal:       1000 kB\nMemAvailable:    500 kB\n',
    '/proc/self/limits': 'Limit                     Soft Limit           Hard Limit           Units\nMax processes             100                  200                  processes\n',
  };
  const r = await resources.collect({
    platform: 'linux', loadavg: [0.5, 0.5, 0.5], cores: 4, uid: 501,
    exec: fakeExec({ ps: PS, lsof: new Error('lsof timed out') }), readFile: async (f) => files[f],
  });
  assert.deepEqual(r.memory, { totalBytes: 1000 * 1024, freeShare: 0.5, compressedShare: null });
  assert.equal(r.processes.limit, 100);
  assert.ok(r.sessions.every((s) => s.cwd === null));
  assert.equal(resources.parseLinuxProcLimit('Max processes  unlimited  unlimited  processes'), null);
});

test('runaway session and session-count alerts fire at the thresholds', () => {
  const base = { load: { oneMinute: 0, cores: 1 }, memory: null, processes: { user: 1, limit: null }, orphans: [] };
  const big = { pid: 7, cwd: 'demo-app', processes: resources.LIMITS.sessionTreeProcesses + 1, rssBytes: 0 };
  assert.match(resources.alerts({ ...base, sessions: [big] })[0], /Session demo-app has 301 processes: likely a runaway test or fork storm/);
  const many = Array.from({ length: resources.LIMITS.claudeSessions + 1 }, (_, i) => ({ pid: i, processes: 1, rssBytes: 0 }));
  assert.match(resources.alerts({ ...base, sessions: many })[0], /26 Claude sessions are running/);
  assert.deepEqual(resources.alerts({ ...base, sessions: [] }), []);
});

test('resources view keeps worker-controlled strings raw for textContent', async () => {
  const r = await resources.collect({ platform: 'darwin', loadavg: [1, 1, 1], cores: 8, uid: 501, exec: fakeExec({ ps: PS, sysctl: new Error('no'), vm_stat: new Error('no'), lsof: '' }) });
  const v = R.resourcesView(r);
  assert.equal(v.badge.tone, 'error');
  assert.equal(r.memory, null);
  assert.deepEqual(v.machine[1], ['Memory', 'unavailable']);
  assert.ok(r.orphans.length === 1 && v.orphans[0].command.includes('demo_helper'));
  assert.equal(R.resourcesView({ ...r, alerts: [] }).badge.text, 'Machine OK');
});
