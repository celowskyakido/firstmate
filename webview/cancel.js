'use strict';
// The web view's second write: closing a backlog item no worker holds. It goes
// through firstmate's own scripts with FM_HOME set and never edits the backlog itself.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const R = require('./public/render');

const BIN = path.resolve(__dirname, '..', 'bin');
const TIMEOUT_MS = 60_000;

// Argument array, no shell; the reply carries the script's own output so the page can show it.
const runScript = (home) => (script, args) => new Promise((resolve) => {
  execFile(path.join(BIN, script), args, { env: { ...process.env, FM_HOME: home }, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => resolve({ ok: !error, output: `${stderr}${stdout}`.trim().slice(-2000) }));
});

const audit = async (home, entry) => {
  try {
    await fs.promises.appendFile(path.join(home, 'state', 'webview-cancel.log'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch (e) { console.error(`webview: could not write the cancel log: ${e.message}`); }
};

const attempt = async ({ home, snapshot, id, reason, note, run }) => {
  const plan = R.cancelPlan(snapshot, id);
  if (plan.refusal) return { outcome: 'refused', reason: plan.refusal, isUnknown: plan.isUnknown };
  // The snapshot can be a minute old; a worker started since then already has its task record.
  if (fs.existsSync(path.join(home, 'state', `${id}.meta`))) return { outcome: 'refused', reason: 'a worker was started on it after this page loaded' };
  const why = R.cancelReason({ reason, note });
  if (why.error) return { outcome: 'refused', reason: why.error, isBadRequest: true };
  let result;
  if (plan.kind === 'decision') {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webview-cancel-'));
    try {
      const file = path.join(dir, 'decision.txt');
      await fs.promises.writeFile(file, `${why.text}\n`);
      // No --release: the decision closes rather than letting held work resume.
      result = await run('fm-captain-hold.sh', ['answer', id, '--decision-file', file]);
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  } else {
    result = await run('fm-tasks-axi.sh', ['done', id, '--note', why.text]);
  }
  return result.ok ? { outcome: 'cancelled', kind: plan.kind, note: why.note }
    : { outcome: 'failed', kind: plan.kind, note: why.note, reason: 'the firstmate script refused or failed', output: result.output };
};

// Returns { outcome: cancelled | refused | failed, reason?, output?, isUnknown?, isBadRequest? } and logs one line per attempt.
const cancelItem = async ({ home, snapshot, id, reason, note, run = runScript(home) }) => {
  const result = await attempt({ home, snapshot, id, reason, note, run });
  // Only fixed fields and the already-cleaned short note reach the log.
  await audit(home, { id, reason: R.CANCEL_REASONS.some(([key]) => key === reason) ? reason : null, note: result.note ?? null, outcome: result.outcome });
  return result;
};

module.exports = { cancelItem };
