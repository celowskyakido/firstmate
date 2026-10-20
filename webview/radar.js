'use strict';
// Chat radar: reads the producer's FM_HOME/data/radar.json on each request and
// keeps the page's dismiss and snooze choices in FM_HOME/state/radar-dismissed.json.
// Only the schema's named fields are passed on, so no message text can reach the page.
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'fm-radar.v1';
const SOURCES = ['slack', 'teams'];
const HEALTH = ['ok', 'degraded', 'unavailable'];
const KINDS = ['mention', 'dm', 'group', 'channel', 'thread', 'new-channel'];
const ID = /^(teams|slack):[0-9a-f]{24}$/;
const SNOOZE_MS = { '4h': 4 * 3600_000, '1d': 24 * 3600_000 };

const isText = (v, max) => typeof v === 'string' && v.length <= max;
const isTime = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const optional = (v, max) => (isText(v, max) ? v : null);
const ageSeconds = (iso, now) => (isTime(iso) ? Math.max(0, Math.round((now - Date.parse(iso)) / 1000)) : null);

const source = (s, name, now) => {
  if (!HEALTH.includes(s?.health) || !Number.isInteger(s.maxAgeMinutes) || s.maxAgeMinutes < 1 || !(s.readAt === null || isTime(s.readAt))) {
    throw new Error(`radar.json: sources.${name} needs health, readAt, and maxAgeMinutes`);
  }
  const age = ageSeconds(s.readAt, now);
  return {
    health: s.health, reason: optional(s.reason, 120), readAt: s.readAt, maxAgeMinutes: s.maxAgeMinutes, ageSeconds: age,
    isStale: age == null || age > s.maxAgeMinutes * 60,
  };
};

// An item missing a required field is dropped and counted rather than failing the whole file.
const item = (x) => {
  if (!ID.test(x?.id ?? '') || x.id.split(':')[0] !== x.source || !KINDS.includes(x.kind) || !isText(x.title, 120) || !isText(x.why, 80)
    || !isTime(x.firstSeen) || !isTime(x.lastActivity) || !['new', 'seen', 'dismissed', 'snoozed'].includes(x.state)) return null;
  return {
    id: x.id, source: x.source, kind: x.kind, title: x.title, why: x.why, who: optional(x.who, 80), where: optional(x.where, 120),
    link: typeof x.link === 'string' && /^https?:\/\//i.test(x.link) ? x.link : null,
    firstSeen: x.firstSeen, lastActivity: x.lastActivity, state: x.state, snoozedUntil: isTime(x.snoozedUntil) ? x.snoozedUntil : null,
    taskIds: Array.isArray(x.taskIds) ? x.taskIds.filter((t) => isText(t, 120)) : [],
  };
};

const parseRadar = (text, now = Date.now()) => {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`radar.json is not JSON: ${e.message}`); }
  if (raw?.schema !== SCHEMA) throw new Error(`unsupported radar schema ${JSON.stringify(raw?.schema)}, expected ${SCHEMA}`);
  if (!isTime(raw.generatedAt) || !raw.sources || !Array.isArray(raw.items)) throw new Error('radar.json needs generatedAt, sources, and items');
  const items = raw.items.map(item).map((x) => x && { ...x, ageSeconds: ageSeconds(x.lastActivity, now) });
  return {
    schema: SCHEMA, generatedAt: raw.generatedAt, ageSeconds: ageSeconds(raw.generatedAt, now),
    sources: Object.fromEntries(SOURCES.map((name) => [name, source(raw.sources[name], name, now)])),
    items: items.filter(Boolean), invalidItems: items.filter((x) => !x).length,
  };
};

// The file maps an item id to { until }: an ISO time for a snooze, null for a dismiss.
const readDismissed = async (file) => {
  try {
    const value = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
};

const isHidden = (x, choice, now) => (choice && (choice.until == null || Date.parse(choice.until) > now))
  || x.state === 'dismissed' || (x.state === 'snoozed' && x.snoozedUntil != null && Date.parse(x.snoozedUntil) > now);

const readRadar = async (home, now = Date.now()) => {
  let text;
  try { text = await fs.promises.readFile(path.join(home, 'data', 'radar.json'), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { present: false };
    return { present: true, error: `could not read radar.json: ${e.code ?? e.message}` };
  }
  let radar;
  try { radar = parseRadar(text, now); } catch (e) { return { present: true, error: e.message }; }
  const dismissed = await readDismissed(path.join(home, 'state', 'radar-dismissed.json'));
  const shown = radar.items.filter((x) => !isHidden(x, dismissed[x.id], now));
  return { present: true, ...radar, items: shown, hiddenItems: radar.items.length - shown.length };
};

// Expired snoozes are pruned on each write; the tmp + rename keeps readers from seeing half a file.
const recordChoice = async (home, id, action, span, now = Date.now()) => {
  const file = path.join(home, 'state', 'radar-dismissed.json');
  const current = await readDismissed(file);
  const kept = Object.fromEntries(Object.entries(current).filter(([, c]) => c?.until == null || Date.parse(c.until) > now));
  const until = action === 'snooze' ? new Date(now + SNOOZE_MS[span]).toISOString() : null;
  kept[id] = { until };
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(kept, null, 1)}\n`);
  await fs.promises.rename(tmp, file);
  return { id, action, until };
};

module.exports = { SCHEMA, ID, SNOOZE_MS, parseRadar, readRadar, recordChoice };
