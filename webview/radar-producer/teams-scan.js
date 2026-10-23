#!/usr/bin/env node
// Teams half of a radar pass: attaches to the dedicated radar browser (starting it when it is down), reuses its one persistent
// Teams tab, waits for real readiness, runs teams-read.js there, and writes FM_HOME/state/radar-producer/teams.json.
// A sign-in page, MFA, dialog, or endless loading is written as an explicit unavailable result, never as an empty list.
// Diagnostics go to stderr, one `teams step=<step> ...` line per step with states and counts only, never page content.
// Read only: it never clicks, types, or navigates inside Teams, and it never touches a credential; 1Password and single
// sign-on get the readiness window to finish a sign-in on their own.
// Usage: node teams-scan.js <FM_HOME>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { poll, chromeConfig, ensure, findTeamsTab, teamsTab } = require('./chrome');

const QUIET_MS = 1500;
const READY_TIMEOUT_MS = 90_000;
const SCAN_TIMEOUT_MS = 240_000;

// Runs inside the Teams tab (called with no arguments) and returns booleans and counts only.
const probe = (d = document, l = location, p = performance) => {
  const shown = (sel) => [...d.querySelectorAll(sel)].filter((e) => e.offsetParent !== null).length;
  const ends = p.getEntriesByType('resource').map((r) => r.responseEnd || r.startTime);
  return {
    protocol: l.protocol, host: l.hostname, readyState: d.readyState,
    signInForm: shown('input[type=password],input[name=loginfmt],input[type=email]') > 0,
    signInButton: [...d.querySelectorAll('button,a[role=button]')].some((b) => /^\s*sign in\s*$/i.test(b.textContent ?? '')),
    dialogs: shown('[role=dialog],[role=alertdialog]'),
    skeletons: shown('[class*=skeleton i],[class*=shimmer i],[aria-busy=true]'),
    railRows: d.querySelectorAll('[role=tree][aria-label=Teams] [role=treeitem]').length,
    quietMs: Math.round(p.now() - Math.max(0, ...ends)),
  };
};

// Ready means the chat list has rendered, nothing is still loading, and the network has been quiet for QUIET_MS.
const classify = (s) => {
  if (!s || s.protocol === 'about:' || !s.host) return { state: 'loading', detail: 'the page is not up yet' };
  if (s.protocol === 'chrome-error:') return { state: 'offline', detail: 'Teams did not load (network error)' };
  if (!/^teams\.(cloud\.microsoft|microsoft\.com)$/.test(s.host)) return { state: 'needs-sign-in', detail: 'Teams went to a sign-in page' };
  if (s.signInForm || s.signInButton) return { state: 'needs-sign-in', detail: 'Teams asks to sign in' };
  if (s.dialogs) return { state: 'interstitial', detail: 'Teams shows a dialog or prompt' };
  if (s.readyState !== 'complete' || s.skeletons || !s.railRows) return { state: 'loading', detail: 'Teams did not finish loading' };
  if (s.quietMs < QUIET_MS) return { state: 'loading', detail: 'Teams is still fetching' };
  return { state: 'ready', detail: null };
};

const notReady = ({ state, detail }) => (state === 'needs-sign-in'
  ? { health: 'unavailable', needsSignIn: true, reason: `needs sign-in: ${detail}; run chrome.js show and sign in` }
  : { health: 'unavailable', reason: detail });

const evaluate = async (cdp, sessionId, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error('a script failed in the Teams tab');
  return r.result.value;
};

const scanTeams = async ({ cdp, home, readScript, diag = () => {}, sleep, now, readyTimeoutMs = READY_TIMEOUT_MS }) => {
  const { targetId, created } = await teamsTab(cdp, home);
  diag('tab', { created });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    const look = async () => classify(await evaluate(cdp, sessionId, `(${probe})()`).catch(() => null));
    const wait = () => poll(look, (s) => s.state === 'ready', { timeoutMs: readyTimeoutMs, sleep, now });
    let seen = await wait();
    // Only a stuck load earns one reload; reloading a sign-in page could resend an MFA prompt.
    if (seen.state === 'loading') {
      diag('wait', { state: seen.state, reload: true });
      await cdp.send('Page.reload', {}, sessionId);
      seen = await wait();
    }
    diag('wait', { state: seen.state });
    if (seen.state !== 'ready') return notReady(seen);
    const result = await evaluate(cdp, sessionId, `(${readScript})()`);
    diag('read', { health: result?.health, items: Array.isArray(result?.items) ? result.items.length : 0 });
    return result;
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
};

// For chrome.js status: what the Teams tab shows right now, without creating a tab.
const teamsState = async (home, cfg) => {
  const cdp = await ensure(cfg);
  try {
    const targetId = await findTeamsTab(cdp, home);
    if (!targetId) return 'none yet (the next scan opens one)';
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const { state, detail } = classify(await evaluate(cdp, sessionId, `(${probe})()`).catch(() => null));
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    return detail ? `${state} (${detail})` : state;
  } finally { cdp.close(); }
};

if (require.main === module) {
  const home = process.argv[2] ?? process.env.FM_HOME;
  const out = path.join(home, 'state', 'radar-producer', 'teams.json');
  let step = 'browser';
  const diag = (s, fields = {}) => {
    step = s;
    console.error(`${new Date().toISOString()} teams step=${s}${Object.entries(fields).map(([k, v]) => ` ${k}=${v}`).join('')}`);
  };
  const write = (result) => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(`${out}.tmp`, JSON.stringify(result));
    fs.renameSync(`${out}.tmp`, out);
  };
  const fail = (e) => {
    const at = step;
    diag('failed', { at, error: JSON.stringify(e.message) });
    write({ health: 'unavailable', reason: `Teams scan failed at ${at}: ${e.message}` });
    process.exit(1);
  };
  setTimeout(() => fail(new Error(`no result after ${SCAN_TIMEOUT_MS / 1000}s`)), SCAN_TIMEOUT_MS).unref();
  (async () => {
    const cdp = await ensure(chromeConfig(home), { diag });
    try {
      write(await scanTeams({ cdp, home, diag, readScript: fs.readFileSync(path.join(__dirname, 'teams-read.js'), 'utf8') }));
    } finally { cdp.close(); }
  })().then(() => process.exit(0), fail);
}

module.exports = { QUIET_MS, probe, classify, scanTeams, teamsState };
