#!/usr/bin/env node
// Read-only, localhost-only web view over `bin/fm-fleet-snapshot.sh --json`.
// Zero dependencies. All fleet derivation stays in the snapshot script; this
// process only caches its output and serves it.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SCHEMA = 'fm-fleet-snapshot.v1';
const HOST = '127.0.0.1';
const SNAPSHOT_SCRIPT = path.resolve(__dirname, '..', 'bin', 'fm-fleet-snapshot.sh');
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/render.js': ['render.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TAIL_LINES = 200;
const TAIL_BYTES = 64 * 1024;
const INBOX_TEXT_BYTES = 4 * 1024;

const parseSnapshot = (stdout) => {
  let snapshot;
  try { snapshot = JSON.parse(stdout); } catch (e) { throw new Error(`snapshot is not JSON: ${e.message}`); }
  if (snapshot?.schema !== SCHEMA) {
    throw new Error(`unsupported snapshot schema ${JSON.stringify(snapshot?.schema)}, expected ${SCHEMA}`);
  }
  return snapshot;
};

const fetchSnapshot = (home) => new Promise((resolve, reject) => {
  // Argument array, no shell: nothing from the fleet ever reaches a command line.
  execFile(SNAPSHOT_SCRIPT, ['--json'], {
    env: { ...process.env, FM_HOME: home },
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    if (error) return reject(new Error(`fm-fleet-snapshot.sh failed: ${stderr.trim() || error.message}`));
    try { resolve(parseSnapshot(stdout)); } catch (e) { reject(e); }
  });
});

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

async function start({ home, port = 4780, pollMs = 7000 }) {
  if (!home) throw new Error('FM_HOME is required: refusing to guess which fleet to show');
  if (!fs.statSync(home, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`FM_HOME is not a directory: ${home}`);
  const state = { snapshot: null, version: 0, fetchedAt: null, error: null };

  const poll = async () => {
    try {
      state.snapshot = await fetchSnapshot(home);
      state.version += 1;
      state.fetchedAt = new Date().toISOString();
      state.error = null;
    } catch (e) {
      state.error = e.message;
      console.error(`webview: ${e.message}`);
    }
  };
  const firstPoll = poll();
  const timer = setInterval(poll, pollMs);
  timer.unref();

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

  const server = http.createServer(async (req, res) => {
    const { port: boundPort } = server.address();
    // Rejecting foreign Host headers blocks DNS-rebinding reads of fleet data.
    if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`].includes(req.headers.host)) {
      return sendJson(res, 421, { error: 'unexpected Host header' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'read-only: GET only' }, { Allow: 'GET, HEAD' });
    }
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (Object.hasOwn(STATIC, pathname)) {
        const [file, type] = STATIC[pathname];
        return send(res, 200, type, await fs.promises.readFile(path.join(PUBLIC_DIR, file)));
      }
      if (pathname === '/api/snapshot') {
        if (!state.snapshot) return sendJson(res, 503, { error: state.error ?? 'snapshot not ready yet' });
        const meta = { 'X-Snapshot-Version': String(state.version), 'X-Snapshot-Fetched-At': state.fetchedAt };
        // A failed refresh keeps serving the last good snapshot, flagged as stale.
        if (state.error) meta['X-Snapshot-Stale'] = encodeURIComponent(state.error);
        return sendJson(res, 200, state.snapshot, meta);
      }
      const match = pathname.match(/^\/api\/task\/([^/]+)$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        const task = TASK_ID.test(id) && state.snapshot?.tasks.find((t) => t.id === id);
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
      ready: firstPoll,
      close: () => { clearInterval(timer); return new Promise((r) => server.close(r)); },
    }));
  });
}

module.exports = { start, parseSnapshot, SCHEMA };

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
  }).then(({ port }) => console.log(`webview: http://${HOST}:${port}/ (read-only)`))
    .catch((e) => { console.error(`webview: ${e.message}`); process.exit(2); });
}
