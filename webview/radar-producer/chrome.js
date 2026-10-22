#!/usr/bin/env node
// The radar's dedicated browser: its own Chrome profile in FM_HOME/state/radar-chrome-profile, reachable only over CDP on
// 127.0.0.1:<chrome.port>, with the Teams tab in its own minimized window, so scans never touch the operator's everyday Chrome.
// Usage: FM_HOME=<home> node chrome.js setup|start|show|status|stop   (needs Node 22+ for the built-in WebSocket)
//   setup   start the browser and open a normal window at the 1Password extension page and Teams
//   start   start the browser in the background if it is not running (scans do this themselves)
//   show    bring the Teams window up to sign in again; status: running or not, and what the Teams tab shows; stop: quit it
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const DEFAULT_PORT = 9333;
const MAC_APP = '/Applications/Google Chrome.app';
const TEAMS_URL = 'https://teams.cloud.microsoft/';
// Slack is read through its MCP server, not this browser, so it needs no tab or sign-in here.
const SETUP_URLS = ['https://chromewebstore.google.com/detail/aeblfdkhhhdcdjpifhhbdiojplfjncoa', TEAMS_URL];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt, baseMs, maxMs) => Math.min(maxMs, baseMs * 2 ** attempt);

// Calls read() until isDone(result) or the timeout, sleeping with exponential backoff; returns the last result.
const poll = async (read, isDone, { timeoutMs, baseMs = 500, maxMs = 5000, sleep = delay, now = Date.now }) => {
  const end = now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const value = await read();
    if (isDone(value) || now() >= end) return value;
    await sleep(Math.min(backoff(attempt, baseMs, maxMs), Math.max(0, end - now())));
  }
};

// Only the `chrome` block of config/radar.json is read, so setup works before the rest of the config exists.
const chromeConfig = (home) => {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(home, 'config', 'radar.json'), 'utf8')).chrome ?? {}; } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`config/radar.json: ${e.message}`);
  }
  const port = raw.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('config/radar.json: chrome.port must be a port number from 1024 to 65535');
  return { port, app: raw.app ?? MAC_APP, binary: raw.binary ?? null, profileDir: path.join(home, 'state', 'radar-chrome-profile') };
};

// No startup window: the first window is created over CDP, minimized and unfocused, so launching never activates Chrome.
// The background flags keep Teams rendering while its window is minimized.
const launchCommand = ({ port, app, binary, profileDir }, platform = process.platform) => {
  const flags = [`--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--no-startup-window',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
  // macOS: -n starts a separate instance beside the everyday Chrome, -g keeps it in the background, -j launches it hidden.
  if (platform === 'darwin' && !binary) return { cmd: 'open', args: ['-n', '-g', '-j', '-a', app, '--args', ...flags] };
  return { cmd: binary ?? 'google-chrome', args: flags };
};

// The endpoint counts as ours only when the process listening on the port was started with this profile.
const portOwner = (port, profileDir) => {
  const pids = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const flag = ` --user-data-dir=${profileDir} `;
  return pids.find((pid) => ` ${spawnSync('ps', ['-o', 'args=', '-p', pid], { encoding: 'utf8' }).stdout.trim()} `.includes(flag)) ?? null;
};

const endpoint = async ({ port, profileDir }) => {
  let version;
  try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json(); } catch { return { up: false }; }
  const ws = version?.webSocketDebuggerUrl;
  return typeof ws === 'string' && portOwner(port, profileDir) ? { up: true, ws } : { up: true, foreign: true };
};

const connect = async (url) => {
  if (typeof WebSocket !== 'function') throw new Error('the radar browser needs Node 22 or later (built-in WebSocket)');
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('could not connect to the radar browser')); });
  const pending = new Map();
  let id = 0;
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result);
  };
  ws.onclose = () => { for (const p of pending.values()) p.reject(new Error('the radar browser closed the connection')); pending.clear(); };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msg = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
    const timer = setTimeout(() => { pending.delete(msg.id); reject(new Error(`${method}: no answer in 30s`)); }, 30_000);
    pending.set(msg.id, { method, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify(msg));
  });
  return { send, close: () => ws.close() };
};

const launch = (cfg) => new Promise((resolve, reject) => {
  fs.mkdirSync(cfg.profileDir, { recursive: true, mode: 0o700 });
  const { cmd, args } = launchCommand(cfg);
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', (e) => reject(new Error(`could not start the radar browser: ${e.message}`)));
  // `open` returns once the app is launched; a direct binary keeps running, so it is detached instead of awaited.
  if (cmd === 'open') child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`open exited ${code}`))));
  else { child.unref(); resolve(); }
});

// Returns a connected CDP client, starting the browser first when it is not running.
const ensure = async (cfg, { diag = () => {} } = {}) => {
  let ep = await endpoint(cfg);
  if (ep.foreign) throw new Error(`127.0.0.1:${cfg.port} belongs to another program; set chrome.port in config/radar.json`);
  if (!ep.up) {
    const t0 = Date.now();
    await launch(cfg);
    ep = await poll(() => endpoint(cfg), (e) => e.up, { timeoutMs: 20_000, baseMs: 250, maxMs: 2000 });
    if (!ep.ws) throw new Error(`the radar browser did not open 127.0.0.1:${cfg.port} within 20s`);
    diag('browser', { started: true, ms: Date.now() - t0 });
  }
  return connect(ep.ws);
};

const tabFile = (home) => path.join(home, 'state', 'radar-producer', 'teams-tab');
const isTeams = (url) => /^https:\/\/teams\.(cloud\.microsoft|microsoft\.com)\//.test(url ?? '');

// The one persistent Teams tab: the remembered target if it still exists (even while it sits on a sign-in page), else any Teams tab.
const findTeamsTab = async (cdp, home) => {
  const pages = (await cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');
  let remembered = null;
  try { remembered = fs.readFileSync(tabFile(home), 'utf8').trim(); } catch { /* first scan */ }
  return (pages.find((t) => t.targetId === remembered) ?? pages.find((t) => isTeams(t.url)))?.targetId ?? null;
};

// With no tab yet, a new one opens in its own minimized, unfocused window; that is the only time the radar loads Teams.
const teamsTab = async (cdp, home, { windowState = 'minimized' } = {}) => {
  const found = await findTeamsTab(cdp, home);
  const visible = windowState !== 'minimized';
  const targetId = found
    ?? (await cdp.send('Target.createTarget', { url: TEAMS_URL, newWindow: true, windowState, focus: visible, background: !visible })).targetId;
  fs.mkdirSync(path.dirname(tabFile(home)), { recursive: true });
  fs.writeFileSync(tabFile(home), targetId);
  return { targetId, created: !found };
};

const setup = async (home) => {
  const cfg = chromeConfig(home);
  const cdp = await ensure(cfg);
  const { targetId } = await cdp.send('Target.createTarget', { url: SETUP_URLS[0], newWindow: true, windowState: 'normal', focus: true });
  for (const url of SETUP_URLS.slice(1)) await cdp.send('Target.createTarget', { url, newWindow: false, focus: false });
  await cdp.send('Target.activateTarget', { targetId });
  cdp.close();
  console.log([
    `The radar browser is open (profile ${cfg.profileDir}, debugging on 127.0.0.1:${cfg.port} only; on macOS it is the second Chrome icon in the Dock).`,
    'Do these once, in that window:',
    '1. On the Chrome Web Store tab, click "Add to Chrome" for 1Password, then sign in to 1Password in its toolbar button.',
    '2. On the Teams tab, sign in (let 1Password fill it) and tick "Stay signed in"; then open Calendar, so later loads reopen there instead of a chat.',
    '3. Close the window when done; the browser keeps running in the background and the next scan opens Teams in its own minimized window.',
    `Check it any time with: FM_HOME=${home} node ${path.relative(process.cwd(), __filename)} status`,
  ].join('\n'));
};

// The one command that shows the radar browser on purpose. macOS does not let it take focus from the active app, so the
// restored window can sit behind others.
const show = async (home) => {
  const cdp = await ensure(chromeConfig(home));
  const { targetId, created } = await teamsTab(cdp, home, { windowState: 'normal' });
  if (!created) {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  }
  await cdp.send('Target.activateTarget', { targetId });
  cdp.close();
  console.log('The Teams window is open (on macOS it is the second Chrome icon in the Dock): sign in there, let 1Password fill it, then minimize it.');
};

const status = async (home) => {
  const cfg = chromeConfig(home);
  const ep = await endpoint(cfg);
  if (!ep.up) return console.log(`not running (port ${cfg.port})`);
  if (ep.foreign) return console.log(`port ${cfg.port} belongs to another program`);
  const { teamsState } = require('./teams-scan');
  console.log(`running on 127.0.0.1:${cfg.port}; Teams tab: ${await teamsState(home, cfg)}`);
};

const stop = async (home) => {
  const cfg = chromeConfig(home);
  const ep = await endpoint(cfg);
  if (!ep.ws) return console.log('not running');
  const cdp = await connect(ep.ws);
  await cdp.send('Browser.close').catch(() => { /* the connection drops as it quits */ });
  console.log('stopped');
};

if (require.main === module) {
  const commands = { setup, start: async (home) => { (await ensure(chromeConfig(home))).close(); console.log('running'); }, show, status, stop };
  const [command] = process.argv.slice(2);
  const home = process.env.FM_HOME;
  if (!commands[command] || !home) {
    console.error('usage: FM_HOME=<home> node chrome.js setup|start|show|status|stop');
    process.exit(2);
  }
  commands[command](home).then(() => process.exit(0), (e) => { console.error(`radar browser: ${e.message}`); process.exit(1); });
}

module.exports = { DEFAULT_PORT, TEAMS_URL, poll, backoff, chromeConfig, launchCommand, endpoint, connect, ensure, findTeamsTab, teamsTab };
