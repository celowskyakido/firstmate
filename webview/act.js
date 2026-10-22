'use strict';
// The web view's third write: answering, deferring, or closing a decision from the Decisions tab.
// Every action goes through one of firstmate's own scripts with FM_HOME set and an argument array, never a shell,
// and never edits a data file itself. Closing reuses cancel.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('./public/render');
const { cancelItem, runScript } = require('./cancel');

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const REF_MAX = 400;
const BULK_MAX = 50;
const DEFERRED_MAX = 500;
const ACTIONS = ['answer', 'defer', 'undo-defer', 'settle'];
const BULK_ACTIONS = ['defer', 'undo-defer', 'settle'];

const refuse = (reason, extra = {}) => ({ outcome: 'refused', reason, ...extra });
const badRequest = (reason) => refuse(reason, { isBadRequest: true });
const failed = (result) => ({ outcome: 'failed', reason: 'the firstmate script refused or failed', output: result.output });

// What this process already did, so a second click or a retry cannot repeat it before a newer snapshot shows the result.
// ponytail: in memory only, so a restart forgets pending undos; persist if undo must outlive the server.
const makeLedger = () => {
  const settled = new Map();
  const deferred = new Map();
  return {
    mark: (ref) => settled.set(ref, Date.now()),
    unmark: (ref) => settled.delete(ref),
    // Only a snapshot observed after the action can say whether it took effect.
    isSettled: (ref, snapshot) => {
      const at = settled.get(ref);
      if (at == null) return false;
      if (Date.parse(snapshot?.generated ?? '') > at) { settled.delete(ref); return false; }
      return true;
    },
    remember: (id, entry) => {
      deferred.set(id, entry);
      if (deferred.size > DEFERRED_MAX) deferred.delete(deferred.keys().next().value);
    },
    recall: (id) => deferred.get(id) ?? null,
    forget: (id) => deferred.delete(id),
  };
};

// Only fixed fields reach the log: never the captain's words, a title, or a hold reason.
const audit = async (home, entry) => {
  try {
    await fs.promises.appendFile(path.join(home, 'state', 'webview-actions.log'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch (e) { console.error(`webview: could not write the action log: ${e.message}`); }
};

const holdIdOf = (ref) => (/^hold:/.test(ref) ? ref.slice(5) : null);
const isRef = (ref) => typeof ref === 'string' && ref.length <= REF_MAX;

// The item must still be waiting on the captain in the current snapshot and not already handled from this page.
const lookup = ({ snapshot, ledger }, ref) => {
  if (!isRef(ref)) return { error: badRequest('expected a decision reference') };
  const item = R.findDecision(snapshot, ref);
  if (!item) return { error: refuse('it is not waiting on you in the latest snapshot', { isUnknown: true }) };
  if (ledger.isSettled(ref, snapshot)) return { error: refuse('it was already handled from this page; the next refresh will drop it') };
  return { item };
};

// A question nobody else holds: a worker started on it since the snapshot is a reason to leave it alone.
const isClaimedSince = (ctx, item) => item.priority === 1 && fs.existsSync(path.join(ctx.home, 'state', `${item.actions.answer.id}.meta`));

const answerDecision = async (ctx, body) => {
  const { item, error } = lookup(ctx, body.ref);
  if (error) return error;
  const { answer } = item.actions;
  if (!answer) return refuse(item.actions.readOnly);
  const said = R.answerText(body, item);
  if (said.error) return badRequest(said.error);
  const ids = answer.type === 'hold' ? [answer.id] : [answer.task, answer.key];
  if (!ids.every((id) => SAFE_ID.test(id))) return refuse('its identifier is not one this page will pass to a script');
  let mode = answer.mode;
  if (answer.type === 'hold') {
    mode ??= body.mode;
    if (mode !== 'done' && mode !== 'release') return badRequest('choose whether to close the question or let the held work go ahead');
    if (answer.mode && body.mode != null && body.mode !== answer.mode) return badRequest('that choice does not match this decision');
    if (isClaimedSince(ctx, item)) return refuse('a worker was started on it after this page loaded');
  } else if (body.mode != null) return badRequest('a worker answer has no close choice');
  let result;
  if (answer.type === 'hold') {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webview-answer-'));
    try {
      const file = path.join(dir, 'decision.txt');
      await fs.promises.writeFile(file, `${said.text}\n`);
      result = await ctx.run('fm-captain-hold.sh', ['answer', answer.id, '--decision-file', file, ...(mode === 'release' ? ['--release'] : [])]);
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  } else {
    result = await ctx.run('fm-send.sh', [answer.task, '--resolve-key', answer.key, said.text]);
  }
  await audit(ctx.home, { action: 'answer', ref: item.ref, mode: mode ?? 'relay', said: said.summary, outcome: result.ok ? 'answered' : 'failed' });
  if (!result.ok) return failed(result);
  ctx.ledger.mark(item.ref);
  return { outcome: 'answered', kind: answer.type, mode: mode ?? null, output: result.output || undefined };
};

const deferDecision = async (ctx, { ref, until }) => {
  const { item, error } = lookup(ctx, ref);
  if (error) return error;
  if (!item.actions.defer) return refuse('only a decision held in this home can be deferred');
  const date = R.deferDate(until);
  if (date.error) return badRequest(date.error);
  const id = holdIdOf(item.ref);
  const reason = (ctx.snapshot.backlog?.records ?? []).find((r) => r.id === id)?.hold_reason;
  if (!SAFE_ID.test(id) || !reason) return refuse('its hold has no recorded reason, so it cannot be held again with a date');
  const result = await ctx.run('fm-captain-hold.sh', ['hold', id, '--reason', reason, '--until', date.until]);
  await audit(ctx.home, { action: 'defer', ref: item.ref, until: date.until, outcome: result.ok ? 'deferred' : 'failed' });
  if (!result.ok) return failed(result);
  ctx.ledger.mark(item.ref);
  ctx.ledger.remember(id, { reason });
  return { outcome: 'deferred', until: date.until };
};

// Holding again with the same reason and no date is exactly what clears the date and keeps the original hold time.
const undoDefer = async (ctx, { ref }) => {
  const id = isRef(ref) ? holdIdOf(ref) : null;
  if (!id || !SAFE_ID.test(id)) return badRequest('expected a decision reference');
  const entry = ctx.ledger.recall(id);
  if (!entry) return refuse('this page has no deferral of it to undo');
  const result = await ctx.run('fm-captain-hold.sh', ['hold', id, '--reason', entry.reason]);
  await audit(ctx.home, { action: 'undo-defer', ref, outcome: result.ok ? 'undone' : 'failed' });
  if (!result.ok) return failed(result);
  ctx.ledger.forget(id);
  ctx.ledger.unmark(ref);
  return { outcome: 'undone' };
};

const settleDecision = async (ctx, { ref, reason, note }) => {
  const { item, error } = lookup(ctx, ref);
  if (error) return error;
  if (!item.actions.settle) return refuse('only a decision with no worker or pull request on it can be closed as settled');
  const id = holdIdOf(item.ref);
  const result = await cancelItem({ home: ctx.home, snapshot: ctx.snapshot, id, reason, note, run: ctx.run });
  await audit(ctx.home, { action: 'settle', ref: item.ref, outcome: result.outcome });
  if (result.outcome === 'cancelled') { ctx.ledger.mark(item.ref); return { outcome: 'settled' }; }
  return { ...result, outcome: result.outcome === 'failed' ? 'failed' : 'refused' };
};

const HANDLERS = { answer: answerDecision, defer: deferDecision, 'undo-defer': undoDefer, settle: settleDecision };

// Returns { outcome, reason?, output?, isUnknown?, isBadRequest? }; the server maps it to a status.
const actOnDecision = (ctx, body) => (ACTIONS.includes(body?.action) ? HANDLERS[body.action](ctx, body) : Promise.resolve(badRequest('unknown action')));

// One action over several decisions, one after another, with the count the captain confirmed.
// A failure on one never stops the rest; every outcome is reported.
const bulkAct = async (ctx, body) => {
  const { action, refs, count } = body ?? {};
  if (!BULK_ACTIONS.includes(action)) return badRequest('choose settle, defer, or undo-defer');
  if (!Array.isArray(refs) || !refs.length || refs.length > BULK_MAX || !refs.every(isRef) || new Set(refs).size !== refs.length) {
    return badRequest(`expected between 1 and ${BULK_MAX} different decisions`);
  }
  if (count !== refs.length) return badRequest('the confirmed count does not match the selection');
  if (action === 'settle' && R.cancelReason(body).error) return badRequest(R.cancelReason(body).error);
  if (action === 'defer' && R.deferDate(body.until).error) return badRequest(R.deferDate(body.until).error);
  const results = [];
  for (const ref of refs) results.push({ ref, ...(await HANDLERS[action](ctx, { ...body, ref })) });
  const done = results.filter((r) => !['refused', 'failed'].includes(r.outcome)).length;
  return { outcome: done === results.length ? 'done' : done ? 'partial' : 'failed', done, total: results.length, results };
};

module.exports = { actOnDecision, bulkAct, makeLedger, runScript, SAFE_ID, BULK_MAX };
