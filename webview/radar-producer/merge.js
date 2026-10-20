#!/usr/bin/env node
// Radar producer merge: folds one run's per-source results into FM_HOME/data/radar.json.
// Usage: node merge.js <FM_HOME>   (reads state/radar-producer/{slack,teams}.json and config/radar.json)
// Zero dependencies. The output is checked with the dashboard's own fm-radar.v1 parser before it is written.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const radar = require('../radar');

const SOURCES = ['slack', 'teams'];
const HEALTH = ['ok', 'degraded', 'unavailable'];
const KINDS = ['mention', 'dm', 'group', 'channel', 'thread', 'new-channel'];
const RANK = { mention: 6, dm: 5, group: 4, thread: 3, channel: 2, 'new-channel': 1 };
const DEFAULTS = {
  lookbackHours: 24, maxAgeMinutes: 90, deny: { channels: [], senders: [] },
  hours: { start: 8, end: 19, days: [1, 2, 3, 4, 5] }, model: 'sonnet', timeoutSeconds: 900,
  tools: { slack: 'mcp__plugin_slack_slack', chrome: 'mcp__chrome-devtools' },
};

const clip = (v, max) => (typeof v === 'string' && v.trim() ? (v.trim().length > max ? `${v.trim().slice(0, max - 1)}…` : v.trim()) : null);
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : []);
const hashId = (source, conversation) => `${source}:${crypto.createHash('sha256').update(`${source}|${conversation}`).digest('hex').slice(0, 24)}`;

// Slack reports times as message ts ("1792531950.123456"); everything else as ISO.
const toIso = (v) => {
  const n = typeof v === 'number' || /^\d+(\.\d+)?$/.test(v ?? '') ? Number(v) : NaN;
  const ms = Number.isFinite(n) ? (n > 1e12 ? n : n * 1000) : Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const loadConfig = (home) => {
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'config', 'radar.json'), 'utf8'));
  if (!/^[UW][A-Z0-9]{2,}$/.test(raw?.slackUserId ?? '')) throw new Error('config/radar.json needs slackUserId (a Slack user id such as U0123ABCD)');
  return {
    ...DEFAULTS, ...raw,
    deny: { channels: strings(raw.deny?.channels), senders: strings(raw.deny?.senders) },
    hours: { ...DEFAULTS.hours, ...raw.hours }, tools: { ...DEFAULTS.tools, ...raw.tools },
  };
};

const isDenied = (x, conversation, deny) => [conversation?.split(':')[0], x.title, x.where].some((v) => v && deny.channels.includes(v))
  || (x.who != null && deny.senders.includes(x.who));

// Only these fields are ever written, so a message body in a result never reaches radar.json.
const toItem = (source, x, deny) => {
  const id = typeof x?.id === 'string' ? x.id : typeof x?.conversation === 'string' && x.conversation ? hashId(source, x.conversation) : null;
  const lastActivity = toIso(x?.lastActivity);
  const title = clip(x?.title, 120);
  const why = clip(x?.why, 80);
  if (!radar.ID.test(id ?? '') || id.split(':')[0] !== source || !KINDS.includes(x.kind) || !title || !why || !lastActivity) return null;
  const out = {
    id, source, kind: x.kind, title, link: typeof x.link === 'string' && /^https:\/\//i.test(x.link) ? x.link : null, why,
    who: clip(x.who, 80), where: clip(x.where, 120), lastActivity, taskIds: strings(x.taskIds).slice(0, 10),
  };
  return isDenied(out, x.conversation, deny) ? false : out;
};

// One item per id: the higher-ranked kind wins and the newest activity is kept.
const dedupe = (items) => [...items.reduce((byId, x) => {
  const p = byId.get(x.id);
  const newest = p && p.lastActivity > x.lastActivity ? p.lastActivity : x.lastActivity;
  byId.set(x.id, { ...(!p || RANK[x.kind] > RANK[p.kind] ? x : p), lastActivity: newest });
  return byId;
}, new Map()).values()];

const readSource = (source, result, deny) => {
  if (result instanceof Error) return { health: 'unavailable', reason: result.message };
  if (!HEALTH.includes(result?.health)) return { health: 'unavailable', reason: clip(result?.reason, 120) ?? `${source} result has no valid health` };
  if (result.health === 'unavailable') return { health: 'unavailable', reason: clip(result.reason, 120) ?? `${source} unavailable` };
  const mapped = (Array.isArray(result.items) ? result.items : []).map((x) => toItem(source, x, deny));
  const invalid = mapped.filter((x) => x === null).length;
  const health = invalid && result.health === 'ok' ? 'degraded' : result.health;
  const reason = clip(result.reason, 120) ?? (invalid ? `${invalid} invalid item(s) dropped` : null);
  return { health, reason, items: dedupe(mapped.filter(Boolean)), cacheNewest: toIso(result.cacheNewest), invalid };
};

// previous: parsed fm-radar.v1 (or null); results: { slack, teams } as parsed objects or Errors.
const merge = ({ previous, results, config, now = Date.now() }) => {
  const cutoff = now - config.lookbackHours * 3600_000;
  const prevById = new Map((previous?.items ?? []).map((x) => [x.id, x]));
  const sources = {};
  const items = [];
  for (const source of SOURCES) {
    const read = readSource(source, results[source] ?? new Error(`${source}: the producer did not report`), config.deny);
    const prevSource = previous?.sources?.[source];
    const fresh = read.health !== 'unavailable';
    sources[source] = {
      health: read.health, reason: read.reason ?? null, readAt: fresh ? new Date(now).toISOString() : prevSource?.readAt ?? null,
      maxAgeMinutes: config.maxAgeMinutes, ...(read.cacheNewest ? { cacheNewest: read.cacheNewest } : {}),
      ...(fresh ? { counts: { items: read.items.length, invalidItems: read.invalid } } : {}),
    };
    // A failed source keeps its previous items (shown as of the old readAt) rather than faking or dropping them.
    const carry = (x, p) => x && p && { ...x, firstSeen: p.firstSeen, state: p.state, snoozedUntil: p.snoozedUntil ?? null };
    const kept = fresh
      ? read.items.map((x) => carry(x, prevById.get(x.id)) || { ...x, firstSeen: new Date(now).toISOString(), state: 'new', snoozedUntil: null })
      : [...prevById.values()].filter((p) => p.source === source).map((p) => carry(toItem(source, p, config.deny), p)).filter(Boolean);
    items.push(...kept.filter((x) => Date.parse(x.lastActivity) >= cutoff));
  }
  items.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return { schema: radar.SCHEMA, generatedAt: new Date(now).toISOString(), sources, items };
};

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return new Error(e.code === 'ENOENT' ? `${path.basename(file, '.json')}: the producer did not report` : `${path.basename(file)} is not valid JSON`);
  }
};

const run = (home, now = Date.now()) => {
  const config = loadConfig(home);
  const target = path.join(home, 'data', 'radar.json');
  let previous = null;
  try { previous = radar.parseRadar(fs.readFileSync(target, 'utf8'), now); } catch { /* absent or unreadable: start fresh */ }
  const results = Object.fromEntries(SOURCES.map((s) => [s, readJson(path.join(home, 'state', 'radar-producer', `${s}.json`))]));
  const out = merge({ previous, results, config, now });
  const check = radar.parseRadar(JSON.stringify(out), now);
  if (check.invalidItems) throw new Error(`refusing to write: ${check.invalidItems} item(s) fail fm-radar.v1`);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(out, null, 1)}\n`);
  fs.renameSync(tmp, target);
  return out;
};

if (require.main === module) {
  try {
    const out = run(process.argv[2] ?? process.env.FM_HOME);
    console.log(SOURCES.map((s) => `${s} ${out.sources[s].health} ${out.items.filter((x) => x.source === s).length}${out.sources[s].reason ? ` (${out.sources[s].reason})` : ''}`).join('; '));
  } catch (e) {
    console.error(`radar merge failed: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { DEFAULTS, hashId, toIso, loadConfig, merge, run };
