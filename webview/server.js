#!/usr/bin/env node
// Localhost-only web view over `bin/fm-fleet-snapshot.sh --json`.
// Zero dependencies. All fleet derivation stays in the snapshot script; this
// process caches its output and serves it. Its only writes are the guarded
// routes in stray-kill.js and cancel.js.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const resourcesLib = require('./resources');
const history = require('./history');
const { killStray } = require('./stray-kill');
const { cancelItem } = require('./cancel');
const radar = require('./radar');
const agents = require('./agents');
const R = require('./public/render');

const SCHEMA = 'fm-fleet-snapshot.v1';
const HOST = '127.0.0.1';
const SNAPSHOT_SCRIPT = path.resolve(__dirname, '..', 'bin', 'fm-fleet-snapshot.sh');
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/render.js': ['render.js', 'text/javascript; charset=utf-8'],
  '/charts.js': ['charts.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/agents-page.js': ['agents-page.js', 'text/javascript; charset=utf-8'],
  '/agents.css': ['agents.css', 'text/css; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TAIL_LINES = 200;
const TAIL_BYTES = 64 * 1024;
const INBOX_TEXT_BYTES = 4 * 1024;
const HISTORY_POINTS = 360;
const KILL_ROUTE = /^\/api\/stray-helpers\/(\d+)\/kill$/;
const CANCEL_ROUTE = '/api/cancel';
const RADAR_ROUTE = /^\/api\/radar\/([^/]+)\/(dismiss|snooze)$/;
const MAX_BODY_BYTES = 4096;
const TOKEN_PLACEHOLDER = '__WEBVIEW_TOKEN__';

const parseSnapshot = (stdout) => {
  let snapshot;
  try { snapshot = JSON.parse(stdout); } catch (e) { throw new Error(`snapshot is not JSON: ${e.message}`); }
  if (snapshot?.schema !== SCHEMA) {
    throw new Error(`unsupported snapshot schema ${JSON.stringify(snapshot?.schema)}, expected ${SCHEMA}`);
  }
  return snapshot;
};

const describeFailure = (error, stderr, timedOutMs) => {
  const why = timedOutMs ? `timed out after ${timedOutMs} ms`
    : error.signal ? `killed by ${error.signal}` : error.code != null ? `exit code ${error.code}` : error.message;
  const tail = stderr.trim().slice(-2000);
  return `fm-fleet-snapshot.sh failed: ${why}${tail ? `: ${tail}` : ''}`;
};

// The script fans out to jq and per-task reads; killing only the shell would
// leave those holding stdout open, so it runs as its own process group.
const killGroup = (child) => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };

const MAX_OUTPUT = 64 * 1024 * 1024;

// `cancel` lets close() stop a run still in flight.
// spawn, not execFile: execFile silently drops `detached`.
const fetchSnapshot = (script, home, timeoutMs) => {
  // Argument array, no shell: nothing from the fleet ever reaches a command line.
  const child = spawn(script, ['--json'], { env: { ...process.env, FM_HOME: home }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise((resolve, reject) => {
    let timedOutMs = 0;
    const out = { stdout: '', stderr: '' };
    const timer = setTimeout(() => { timedOutMs = timeoutMs; killGroup(child); }, timeoutMs);
    for (const name of ['stdout', 'stderr']) {
      child[name].setEncoding('utf8').on('data', (chunk) => {
        out[name] += chunk;
        if (out[name].length > MAX_OUTPUT) killGroup(child);
      });
    }
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(describeFailure(error, out.stderr, 0))); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(describeFailure({ code, signal }, out.stderr, timedOutMs)));
      try { resolve(parseSnapshot(out.stdout)); } catch (e) { reject(e); }
    });
  });
  return { done, cancel: () => killGroup(child) };
};

// The next run is scheduled only after the current one settles, so refreshes
// never overlap; on a big home one snapshot run can take most of a minute.
// `startRun` returns { done, cancel }; `onValue` sees each successful value.
const makePoller = (startRun, pollMs, onValue = () => {}) => {
  const state = { value: null, version: 0, fetchedAt: null, error: null, refreshing: false, failures: 0 };
  let timer = null;
  let running = null;
  let closed = false;
  const poll = async () => {
    state.refreshing = true;
    try {
      running = startRun();
      state.value = await running.done;
      state.version += 1;
      state.fetchedAt = new Date().toISOString();
      state.error = null;
      state.failures = 0;
      // A trend-sampling bug must not mark a good refresh as failed.
      try { onValue(state.value); } catch (e) { console.error(`webview: history sample failed: ${e.message}`); }
    } catch (e) {
      state.error = e.message;
      state.failures += 1;
      if (!closed) console.error(`webview: ${e.message}`);
    } finally {
      state.refreshing = false;
      running = null;
    }
    if (closed) return;
    // Back off after consecutive failures, capped at 64x the poll interval.
    timer = setTimeout(poll, pollMs * 2 ** Math.min(state.failures, 6));
    timer.unref();
  };
  const ready = poll();
  return {
    state,
    ready,
    close: () => { closed = true; clearTimeout(timer); running?.cancel(); },
  };
};

const readBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  let isTooLarge = false;
  req.setEncoding('utf8');
  // An oversized body is drained rather than cut off, so the client still gets the refusal.
  req.on('data', (chunk) => {
    isTooLarge ||= body.length + chunk.length > MAX_BODY_BYTES;
    if (!isTooLarge) body += chunk;
  });
  req.on('end', () => (isTooLarge ? reject(new Error('body too large')) : resolve(body)));
  req.on('error', reject);
});

const sameToken = (given, token) => typeof given === 'string' && given.length === token.length
  && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));

const readTail = async (file) => {
  let text;
  try { text = await fs.promises.readFile(file, 'utf8'); } catch { return []; }
  return text.slice(-TAIL_BYTES).split('\n').filter(Boolean).slice(-TAIL_LINES);
};

const readInbox = async (dir) => {
  const list = async (d) => {
    let names;
    try { names = (await fs.promises.readdir(d)).filter((n) => n.endsWith('.msg')).sort(); } catch { return []; }
    return Promise.all(names.map(async (name) => {
      let text = '';
      try { text = (await fs.promises.readFile(path.join(d, name), 'utf8')).slice(0, INBOX_TEXT_BYTES); } catch { /* removed mid-read */ }
      return { name, text };
    }));
  };
  return { pending: await list(dir), handled: await list(path.join(dir, 'handled')) };
};

// The Jira base URL is company data, so it lives only in the home or the environment, never in this repo.
const readLinkConfig = (home, env = process.env) => {
  let file = '';
  try { file = fs.readFileSync(path.join(home, 'config', 'webview-links'), 'utf8'); } catch { /* optional */ }
  const jiraBase = (env.WEBVIEW_JIRA_BASE || file.match(/^jira_base=(.*)$/m)?.[1] || '').trim();
  return { jiraBase: R.isWebUrl(jiraBase) ? jiraBase : null };
};

async function start({
  home, port = 4780, pollMs = 7000, snapshotTimeoutMs = 180_000, snapshotScript = SNAPSHOT_SCRIPT,
  resourcesPollMs = 5000, collectResources = () => resourcesLib.collect(), historyWindowMs = 3 * 3600_000,
  killDeps = {}, cancelDeps = {}, agentsDeps = {}, token = crypto.randomBytes(24).toString('hex'),
}) {
  if (!home) throw new Error('FM_HOME is required: refusing to guess which fleet to show');
  if (!fs.statSync(home, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`FM_HOME is not a directory: ${home}`);
  const fleetTrend = history.makeSeries({ windowMs: historyWindowMs, sampleMs: pollMs });
  const machineTrend = history.makeSeries({ windowMs: historyWindowMs, sampleMs: resourcesPollMs });
  const snapshots = makePoller(() => fetchSnapshot(snapshotScript, home, snapshotTimeoutMs), pollMs,
    (snapshot) => fleetTrend.push(R.fleetCounts(snapshot)));
  const resources = makePoller(() => ({ done: collectResources(), cancel: () => {} }), resourcesPollMs,
    (reading) => machineTrend.push(R.machineSample(reading)));
  const agentsView = agents.makeAgents({ home, snapshot: () => snapshots.state.value, ...agentsDeps });

  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
      ...extra,
    });
    res.end(body);
  };
  const sendJson = (res, status, value, extra) => send(res, status, 'application/json', JSON.stringify(value), extra);
  // A failed refresh keeps serving the last good value, flagged as stale.
  const sendCached = (res, state, name) => {
    if (!state.value) return sendJson(res, 503, { loading: true, refreshing: state.refreshing, error: state.error });
    const meta = { [`X-${name}-Version`]: String(state.version), [`X-${name}-Fetched-At`]: state.fetchedAt };
    if (state.error) meta[`X-${name}-Stale`] = encodeURIComponent(state.error);
    if (state.refreshing) meta[`X-${name}-Refreshing`] = '1';
    return sendJson(res, 200, state.value, meta);
  };

  // Every write: Origin must be this page and the token must match this launch.
  // Returns the parsed body, or undefined after sending the refusal.
  const readWrite = async (req, res) => {
    if (req.headers.origin !== `http://${req.headers.host}`) return void sendJson(res, 403, { outcome: 'refused', reason: 'request did not come from this page' });
    if (!sameToken(req.headers['x-webview-token'], token)) return void sendJson(res, 403, { outcome: 'refused', reason: 'missing or wrong page token; reload the page' });
    if (!/^application\/json(;|$)/.test(req.headers['content-type'] ?? '')) return void sendJson(res, 415, { outcome: 'refused', reason: 'expected application/json' });
    try { return JSON.parse(await readBody(req)); } catch { return void sendJson(res, 400, { outcome: 'refused', reason: 'body must be JSON under 4 KB' }); }
  };

  // The stray rules are re-checked against a fresh process table inside killStray.
  const handleKill = async (req, res, pid) => {
    const expected = await readWrite(req, res);
    if (expected === undefined) return undefined;
    if (!(pid > 1) || typeof expected?.command !== 'string' || typeof expected?.ageSeconds !== 'number') {
      return sendJson(res, 400, { outcome: 'refused', reason: 'expected {command, ageSeconds} for a pid above 1' });
    }
    const result = await killStray(pid, expected, killDeps);
    console.error(`webview: stray helper ${pid}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`);
    const status = { refused: 409, failed: 500 }[result.outcome] ?? 200;
    return sendJson(res, status, { pid, ...result });
  };

  // The id must be cancellable in the current snapshot; cancelItem re-checks it and runs the script.
  // ponytail: one cancel at a time across the server; per-id locks if several people ever share one page.
  let isCancelling = false;
  const handleCancel = async (req, res) => {
    const body = await readWrite(req, res);
    if (body === undefined) return undefined;
    const id = body?.id;
    if (typeof id !== 'string' || id.length > 120 || !TASK_ID.test(id)) return sendJson(res, 400, { outcome: 'refused', reason: 'expected {id, reason, note} with a task id' });
    if (!snapshots.state.value) return sendJson(res, 503, { id, outcome: 'refused', reason: 'the fleet snapshot has not loaded yet' });
    if (isCancelling) return sendJson(res, 409, { id, outcome: 'refused', reason: 'another cancel is still running; try again in a moment' });
    isCancelling = true;
    try {
      const result = await cancelItem({ home, snapshot: snapshots.state.value, id, reason: body.reason, note: body.note, ...cancelDeps });
      console.error(`webview: cancel ${id}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`);
      const status = result.outcome === 'cancelled' ? 200 : result.outcome === 'failed' ? 500 : result.isUnknown ? 404 : result.isBadRequest ? 400 : 409;
      return sendJson(res, status, { id, outcome: result.outcome, reason: result.reason, output: result.output });
    } finally { isCancelling = false; }
  };

  const handleRadar = async (req, res, id, action) => {
    const body = await readWrite(req, res);
    if (body === undefined) return undefined;
    if (!radar.ID.test(id)) return sendJson(res, 400, { outcome: 'refused', reason: 'unknown radar item id' });
    if (action === 'snooze' && !Object.hasOwn(radar.SNOOZE_MS, body?.for)) return sendJson(res, 400, { outcome: 'refused', reason: 'snooze needs {"for": "4h"} or {"for": "1d"}' });
    return sendJson(res, 200, { outcome: 'recorded', ...(await radar.recordChoice(home, id, action, body?.for)) });
  };

  const server = http.createServer(async (req, res) => {
    const { port: boundPort } = server.address();
    // Rejecting foreign Host headers blocks DNS-rebinding reads of fleet data.
    if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`].includes(req.headers.host)) {
      return sendJson(res, 421, { error: 'unexpected Host header' });
    }
    const { pathname } = new URL(req.url, 'http://localhost');
    const kill = pathname.match(KILL_ROUTE);
    const radarChoice = pathname.match(RADAR_ROUTE);
    const isCancel = pathname === CANCEL_ROUTE;
    // Stopping a stray helper, cancelling a backlog item, and dismissing or snoozing a radar item are the only writes; every other route is read-only.
    // Unread request bodies are drained so a refused request leaves the connection usable.
    const isWrite = Boolean(kill || radarChoice) || isCancel;
    if (req.method !== 'POST' || !isWrite) req.resume();
    if (isWrite && req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' }, { Allow: 'POST' });
    if (!isWrite && req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'read-only: GET only' }, { Allow: 'GET, HEAD' });
    }
    try {
      if (kill) return await handleKill(req, res, Number(kill[1]));
      if (isCancel) return await handleCancel(req, res);
      if (radarChoice) return await handleRadar(req, res, decodeURIComponent(radarChoice[1]), radarChoice[2]);
      if (pathname === '/api/radar') return sendJson(res, 200, await radar.readRadar(home));
      // Process and log data can hold secrets or PHI, so even these reads need this launch's token.
      if (pathname === '/api/agents' || pathname === '/api/agents/log') {
        if (!sameToken(req.headers['x-webview-token'], token)) return sendJson(res, 403, { error: 'missing or wrong page token; reload the page' });
        if (pathname === '/api/agents') return sendJson(res, 200, await agentsView.overview());
        const { status, body } = await agentsView.log(new URL(req.url, 'http://localhost').searchParams);
        return sendJson(res, status, body);
      }
      if (Object.hasOwn(STATIC, pathname)) {
        const [file, type] = STATIC[pathname];
        const body = await fs.promises.readFile(path.join(PUBLIC_DIR, file));
        // The page carries this launch's token; other origins cannot read it, so they cannot send it back.
        return send(res, 200, type, pathname === '/' ? body.toString('utf8').replace(TOKEN_PLACEHOLDER, token) : body);
      }
      if (pathname === '/api/snapshot') return sendCached(res, snapshots.state, 'Snapshot');
      if (pathname === '/api/config') return sendJson(res, 200, readLinkConfig(home));
      if (pathname === '/api/resources') return sendCached(res, resources.state, 'Resources');
      if (pathname === '/api/history') {
        return sendJson(res, 200, {
          windowMs: historyWindowMs, fleet: fleetTrend.read(HISTORY_POINTS), machine: machineTrend.read(HISTORY_POINTS),
        });
      }
      const match = pathname.match(/^\/api\/task\/([^/]+)$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        const task = TASK_ID.test(id) && snapshots.state.value?.tasks.find((t) => t.id === id);
        if (!task) return sendJson(res, 404, { error: 'unknown task' });
        const stateDir = path.join(home, 'state');
        return sendJson(res, 200, {
          id,
          // Historical wake events only; current state lives in the snapshot row.
          status_history: await readTail(path.join(stateDir, `${id}.status`)),
          inbox: await readInbox(path.join(stateDir, `${id}.inbox`)),
        });
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      console.error(`webview: ${e.message}`);
      return sendJson(res, 500, { error: 'internal error' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve({
      server,
      port: server.address().port,
      ready: snapshots.ready,
      resourcesReady: resources.ready,
      close: () => {
        snapshots.close();
        resources.close();
        return new Promise((r) => server.close(r));
      },
    }));
  });
}

module.exports = { start, parseSnapshot, readLinkConfig, SCHEMA };

if (require.main === module) {
  const home = process.env.FM_HOME;
  if (!home) {
    console.error('webview: FM_HOME must be set explicitly; refusing to guess which fleet to show');
    process.exit(2);
  }
  start({
    home,
    port: Number(process.env.WEBVIEW_PORT ?? 4780),
    pollMs: Number(process.env.WEBVIEW_POLL_MS ?? 7000),
    snapshotTimeoutMs: Number(process.env.WEBVIEW_SNAPSHOT_TIMEOUT_MS ?? 180_000),
    resourcesPollMs: Number(process.env.WEBVIEW_RESOURCES_POLL_MS ?? 5000),
  }).then(({ port }) => console.log(`webview: http://${HOST}:${port}/`))
    .catch((e) => { console.error(`webview: ${e.message}`); process.exit(2); });
}
