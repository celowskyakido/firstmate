// Pure view-model builders over an `fm-fleet-snapshot.v1` object. No DOM and no
// re-folding of status logs: every field is read from the snapshot as published.
// Values stay raw strings; app.js is the only place they reach the DOM, via textContent.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FleetRender = factory();
})(typeof self === 'undefined' ? this : self, function () {
  const SCHEMA = 'fm-fleet-snapshot.v1';
  const HOUR = 3600;
  const DAY = 86400;

  const assertSchema = (snapshot) => {
    if (snapshot?.schema !== SCHEMA) {
      throw new Error(`Unsupported snapshot schema ${JSON.stringify(snapshot?.schema)}; expected ${SCHEMA}`);
    }
    return snapshot;
  };

  // Task history for the detail drawer. Labelled history on purpose: wake events are never current state.
  const taskDetail = (snapshot, id, detail) => {
    assertSchema(snapshot);
    if (!(snapshot.tasks ?? []).some((t) => t.id === id)) return null;
    return { id, statusHistory: detail?.status_history ?? [], inbox: detail?.inbox ?? { pending: [], handled: [] } };
  };

  // fm-crew-state.sh's fixed detail vocabulary for a passed run whose PR no longer awaits a merge call.
  const PR_SETTLED = /\bPR (merged|closed)\b/;
  const RECENT_LIMIT = 15;
  const NO_PROJECT = '(no project)';
  // A decision the captain has not answered in this long moves to its own column.
  const AGING_AFTER = 3 * DAY;

  // Board columns, left to right.
  const COLUMNS = [
    { key: 'decide', label: 'Needs your decision', group: 'needs' },
    { key: 'aging', label: 'Aging decisions', group: 'needs' },
    { key: 'blocked', label: 'Blocked', group: 'blocked' },
    { key: 'working', label: 'Working', group: 'working' },
    { key: 'review', label: 'Waiting on review', group: 'review' },
    { key: 'land', label: 'Ready to land', group: 'land' },
    { key: 'done', label: 'Done (recent)', group: 'done' },
  ];
  // Colour groups in the fixed order the palette was validated in (adjacent pairs
  // clear the colour-vision checks only in this order); charts stack in this order.
  const GROUPS = [
    { key: 'needs', label: 'Decisions' },
    { key: 'blocked', label: 'Blocked' },
    { key: 'review', label: 'Waiting on review' },
    { key: 'working', label: 'Working' },
    { key: 'land', label: 'Ready to land' },
    { key: 'done', label: 'Done' },
  ];
  const columnOf = (key) => COLUMNS.find((c) => c.key === key);

  const localDate = (date) => date.toLocaleDateString('en-CA');
  // Some homes record a project as its clone path; show only the folder name.
  const projectName = (p) => (p && p.includes('/') ? p.replace(/\/+$/, '').split('/').pop() : p ?? NO_PROJECT);
  const prNumber = (url) => url?.match(/\/(?:pull|merge_requests)\/(\d+)/)?.[1] ?? null;
  const decisionColumn = (ageSeconds) => (ageSeconds != null && ageSeconds >= AGING_AFTER ? 'aging' : 'decide');
  const isNoMistakes = (mode) => /^no-mistakes/.test(mode ?? '');

  // Where an undecided task sits, from structured fields only: blocked events,
  // current state, unresolved blockers, the PR and whether it settled, and the
  // delivery mode. A no-mistakes run that passed has been reviewed and is waiting
  // on a merge call; a direct PR still needs its review.
  const workColumn = (t) => {
    if (t.blockedEvents.length || t.state === 'blocked' || t.state === 'failed' || t.blockerIds.length) return 'blocked';
    if (t.state === 'done') {
      if (!t.prUrl) return t.kind === 'scout' ? 'review' : 'land';
      if (t.isPrSettled) return 'done';
      return isNoMistakes(t.mode) ? 'land' : 'review';
    }
    if (t.prUrl && (t.state === 'paused' || t.state === 'unknown')) return 'review';
    return 'working';
  };

  const steerTarget = (task) => task.actions?.steer?.split(/\s+/)[1] ?? null;

  // Suggested ways to resolve a card: what to tell firstmate, and the command it
  // would run. The web view never runs them.
  const resolveSteps = (c, task) => {
    const target = task && steerTarget(task);
    const steps = c.decisions.flatMap((d) => (d.kind === 'captain-hold'
      ? [{ label: 'Tell firstmate', text: `Decision on ${d.holdId ?? c.id}: <your call>` },
        { label: 'Command firstmate would run', text: `bin/fm-captain-hold.sh answer ${d.holdId ?? c.id} --decision-file <file with your answer> --release` }]
      : [{ label: 'Tell firstmate', text: `For ${c.id} (${d.summary}): <your answer>` },
        target && { label: 'Command firstmate would run', text: `bin/fm-send.sh ${target} --resolve-key ${d.key} '<your answer>'` }]));
    if (steps.length) return steps.filter(Boolean);
    const blockedEvent = c.blockers.events[0];
    if (blockedEvent) {
      return [{ label: 'Tell firstmate', text: `Unblock ${c.id}: <what it should do>` },
        target && blockedEvent.key && { label: 'Command firstmate would run', text: `bin/fm-send.sh ${target} --resolve-key ${blockedEvent.key} '<what it should do>'` }].filter(Boolean);
    }
    if (c.blockers.ids.length) return [{ label: 'Clears on its own', text: `Starts once ${c.blockers.ids.join(', ')} ${c.blockers.ids.length === 1 ? 'lands' : 'land'}.` }];
    if (c.column === 'land' && c.prUrl) {
      return [{ label: 'Tell firstmate', text: `Merge ${c.prUrl}` }, { label: 'Command firstmate would run', text: `bin/fm-pr-merge.sh ${c.id} ${c.prUrl}` }];
    }
    if (c.column === 'land') return [{ label: 'Tell firstmate', text: `Land ${c.id}` }, { label: 'Command firstmate would run', text: `bin/fm-merge-local.sh ${c.id}` }];
    if (c.column === 'review' && c.prUrl) {
      return [{ label: 'Tell firstmate', text: `Merge ${c.prUrl}` }, { label: 'Or ask for changes', text: `Changes needed on ${c.id}: <what to change>` }];
    }
    if (c.column === 'review' && task?.paths?.report?.path) return [{ label: 'Read the findings', text: task.paths.report.path }];
    if (c.column === 'working' && task?.actions?.watch) return [{ label: 'Watch the worker', text: task.actions.watch }];
    return [];
  };

  const card = (fields) => ({
    taskId: null, project: NO_PROJECT, ageSeconds: null, prUrl: null, decisions: [], blockers: { events: [], ids: [], reason: null },
    stateDetail: null, text: [], date: null, badges: [], ...fields,
  });

  const finishedRecords = (snapshot) => [
    ...(snapshot.backlog?.records ?? []).filter((r) => r.state === 'done'),
    ...(snapshot.secondmate_landed?.records ?? []),
  ].map((r) => ({
    id: r.id, title: r.title ?? r.raw ?? r.id, project: r.repo ?? null, home: r.home_id ?? null,
    verb: r.completion?.verb ?? null, date: r.completion?.date ?? r.done ?? null, url: r.pr_url ?? r.report_path ?? null,
  })).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  // Every board card, classified from the snapshot's structured fields. Status logs
  // are never re-read; free text is only displayed, never matched, except the fixed
  // PR-settled vocabulary above.
  const cards = (snapshot) => {
    assertSchema(snapshot);
    const generatedMs = Date.parse(snapshot.generated ?? '') || Date.now();
    const records = snapshot.backlog?.records ?? [];
    const byId = new Map(records.map((r) => [r.id, r]));
    const holdAge = (r) => (r.hold_set && Date.parse(r.hold_set) ? Math.max(0, (generatedMs - Date.parse(r.hold_set)) / 1000)
      : r.hold_age_days == null ? null : r.hold_age_days * DAY);
    const holdDecision = (r) => ({ key: r.id, kind: 'captain-hold', holdId: r.id, summary: r.hold_reason ?? r.title ?? r.id, until: r.hold_until ?? null });
    const out = [];
    const taskCards = new Map();

    (snapshot.tasks ?? []).forEach((task) => {
      const record = byId.get(task.id) ?? task.backlog ?? null;
      const open = task.hints?.open_decisions ?? [];
      const decisions = open.filter((d) => d.verb !== 'blocked').map((d) => ({ key: d.key, kind: d.verb, summary: d.summary }));
      if (record?.hold_bucket === 'live') decisions.push(holdDecision(record));
      const t = {
        kind: task.kind, mode: task.mode, state: task.current_state?.state ?? 'unknown', prUrl: task.pr?.url ?? null,
        isPrSettled: PR_SETTLED.test(task.current_state?.detail ?? '') || Boolean(record?.merged),
        blockedEvents: open.filter((d) => d.verb === 'blocked').map((d) => ({ key: d.key, summary: d.summary })),
        blockerIds: record?.unresolved_blocker_ids ?? [],
      };
      const ageSeconds = task.paths?.status_log?.last_event?.age_seconds ?? null;
      const c = card({
        key: `task:${task.id}`, source: 'task', id: task.id, taskId: task.id, title: record?.title ?? task.id,
        project: task.project ?? record?.repo ?? NO_PROJECT, ageSeconds, prUrl: t.prUrl, decisions,
        blockers: { events: t.blockedEvents, ids: t.blockerIds, reason: record?.blocked_reason ?? null },
        state: t.state, stateDetail: task.current_state?.detail ?? null, kind: task.kind, since: record?.since ?? null,
        text: [record?.body_excerpt, task.hints?.last_event_text].filter(Boolean),
        column: decisions.length ? decisionColumn(ageSeconds) : workColumn(t),
        badges: [t.state === 'unknown' && 'No live status', t.state === 'failed' && 'Failed', t.state === 'paused' && 'Paused',
          t.state === 'parked' && 'Parked', task.kind === 'scout' && 'Investigation', task.kind === 'secondmate' && 'Second mate'].filter(Boolean),
      });
      c.resolve = resolveSteps(c, task);
      taskCards.set(task.id, c);
      out.push(c);
    });

    // A second mate's own open decisions join its card, or stand alone when it has no task row.
    (snapshot.secondmate_current?.records ?? []).forEach((m) => {
      const owner = taskCards.get(m.id);
      (m.decisions_open ?? []).forEach((d) => {
        const decision = { key: d.key ?? d.id, kind: d.verb ?? 'decision', holdId: d.verb === 'captain-hold' ? d.id : undefined, summary: d.summary ?? d.title ?? '', reason: d.reason ?? null };
        if (owner) {
          if (owner.decisions.some((x) => x.key === decision.key)) return;
          owner.decisions.push(decision);
          owner.column = decisionColumn(owner.ageSeconds);
          owner.resolve = resolveSteps(owner, null);
          return;
        }
        const ageSeconds = d.hold_age_days == null ? null : d.hold_age_days * DAY;
        const c = card({ key: `secondmate:${m.id}:${decision.key}`, source: 'secondmate', id: d.id ?? m.id, title: decision.summary, project: m.id, ageSeconds,
          decisions: [decision], text: [d.reason].filter(Boolean), column: decisionColumn(ageSeconds), badges: ['Second mate'] });
        c.resolve = resolveSteps(c, null);
        out.push(c);
      });
    });

    // Backlog rows with no task: live holds are decisions, rows waiting on unfinished work are blocked.
    records.filter((r) => !taskCards.has(r.id) && r.state !== 'done').forEach((r) => {
      const blockerIds = r.unresolved_blocker_ids ?? [];
      const isHeld = r.hold_bucket === 'live';
      if (!isHeld && !blockerIds.length) return;
      const ageSeconds = isHeld ? holdAge(r) : null;
      const c = card({
        key: `${isHeld ? 'hold' : 'queued'}:${r.id}`, source: isHeld ? 'hold' : 'queued', id: r.id, title: r.title ?? r.id, project: r.repo ?? NO_PROJECT,
        ageSeconds, prUrl: r.pr_url ?? null, decisions: isHeld ? [holdDecision(r)] : [],
        blockers: { events: [], ids: blockerIds, reason: r.blocked_reason ?? null }, since: r.since ?? null,
        text: [r.body_excerpt].filter(Boolean),
        column: blockerIds.length ? 'blocked' : decisionColumn(ageSeconds),
        badges: [isHeld ? 'Your call' : 'Not started'],
      });
      c.resolve = resolveSteps(c, null);
      out.push(c);
    });

    finishedRecords(snapshot).slice(0, RECENT_LIMIT).forEach((f) => out.push(card({
      key: `done:${f.home ?? ''}:${f.id}`, source: 'finished', id: f.id, title: f.title, project: f.project ?? NO_PROJECT,
      prUrl: /^https?:/.test(f.url ?? '') ? f.url : null, date: f.date, column: 'done', resolve: [],
      text: [f.home && `Finished via ${f.home}`, f.url && !/^https?:/.test(f.url) && f.url].filter(Boolean),
      badges: [f.verb === 'merged' ? 'Merged' : f.verb ? 'Finished' : null].filter(Boolean),
    })));
    return out;
  };

  // Oldest first, so the longest waits are on top; recently finished work shows newest first.
  const byAge = (a, b) => (b.ageSeconds ?? -1) - (a.ageSeconds ?? -1);
  const byDate = (a, b) => (b.date ?? '9999').localeCompare(a.date ?? '9999');

  const matches = (c, query) => !query || [c.title, c.id, projectName(c.project), c.stateDetail, ...c.decisions.map((d) => d.summary), ...c.blockers.events.map((e) => e.summary)]
    .some((v) => (v ?? '').toLowerCase().includes(query.toLowerCase()));

  // The kanban: every column, filtered by search text and project.
  const boardView = (all, { query = '', project = '' } = {}) => {
    const shown = all.filter((c) => matches(c, query.trim()) && (!project || c.project === project));
    return COLUMNS.map((col) => ({
      ...col, cards: shown.filter((c) => c.column === col.key).sort(col.key === 'done' ? byDate : byAge),
      total: all.filter((c) => c.column === col.key).length,
    }));
  };

  const projects = (all) => [...new Set(all.map((c) => c.project))].sort((a, b) => projectName(a).localeCompare(projectName(b)))
    .map((value) => ({ value, label: projectName(value) }));

  // Headline counts. The server samples these per snapshot for the trend sparklines.
  const fleetCounts = (snapshot, today = localDate(new Date())) => {
    const all = cards(snapshot);
    const count = (key) => all.filter((c) => c.column === key).length;
    const tasks = snapshot.tasks ?? [];
    return {
      needsYou: count('decide') + count('aging') + count('review') + count('land'),
      decide: count('decide'),
      aging: count('aging'),
      blocked: count('blocked'),
      working: count('working'),
      review: count('review'),
      land: count('land'),
      queued: (snapshot.backlog?.records ?? []).filter((r) => r.state === 'queued').length,
      inProgress: tasks.filter((t) => t.current_state?.state !== 'done').length,
      doneToday: finishedRecords(snapshot).filter((f) => f.date === today).length,
    };
  };

  // One machine sample for the trend ring buffer.
  const machineSample = (r) => ({
    load: r.load?.oneMinute ?? null,
    cores: r.load?.cores ?? null,
    memoryInUse: r.memory?.freeShare == null ? null : 1 - r.memory.freeShare,
    sessions: r.sessions?.length ?? null,
    helpers: r.sessions ? r.sessions.reduce((n, s) => n + s.mcpHelpers, 0) : null,
    orphans: r.orphans?.length ?? null,
  });

  const groupOf = (c) => columnOf(c.column)?.group;

  const stateBreakdown = (snapshot) => {
    const all = cards(snapshot);
    return GROUPS.map((g) => ({ ...g, count: all.filter((c) => groupOf(c) === g.key).length, href: `#/list/group/${g.key}` }));
  };

  // Open work per project by colour group, the tail folded into one row rather than more rows.
  const projectBars = (snapshot, max = 8) => {
    const open = cards(snapshot).filter((c) => c.column !== 'done');
    const byProject = new Map();
    open.forEach((c) => byProject.set(c.project, [...(byProject.get(c.project) ?? []), c]));
    const segmentsOf = (list) => GROUPS.filter((g) => g.key !== 'done').map((g) => ({ key: g.key, label: g.label, count: list.filter((c) => groupOf(c) === g.key).length }));
    const rows = [...byProject].map(([project, list]) => ({
      project: projectName(project), total: list.length, href: `#/board?project=${encodeURIComponent(project)}`, segments: segmentsOf(list),
    })).sort((a, b) => b.total - a.total || a.project.localeCompare(b.project));
    if (rows.length <= max) return rows;
    const rest = rows.slice(max - 1);
    return [...rows.slice(0, max - 1), {
      project: `${rest.length} other projects`, total: rest.reduce((n, r) => n + r.total, 0), href: '#/board',
      segments: rest[0].segments.map((s, i) => ({ ...s, count: rest.reduce((n, r) => n + r.segments[i].count, 0) })),
    }];
  };

  const AGE_BUCKETS = [
    { key: 'hour', label: 'Under 1 h', below: HOUR },
    { key: 'hours', label: '1-6 h', below: 6 * HOUR },
    { key: 'day', label: '6-24 h', below: DAY },
    { key: 'days', label: '1-3 days', below: AGING_AFTER },
    { key: 'week', label: '3-7 days', below: 7 * DAY },
    { key: 'older', label: 'Over a week', below: Infinity },
  ];
  const ageBucketOf = (seconds) => (seconds == null ? null : AGE_BUCKETS.find((b) => seconds < b.below).key);
  const WAITING = new Set(['decide', 'aging', 'blocked', 'review', 'land']);

  const ageHistogram = (snapshot) => {
    const waiting = cards(snapshot).filter((c) => WAITING.has(c.column));
    return {
      bins: AGE_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: waiting.filter((c) => ageBucketOf(c.ageSeconds) === b.key).length, href: `#/list/age/${b.key}` })),
      unknownAge: waiting.filter((c) => c.ageSeconds == null).length,
    };
  };

  // Card lists behind chart segments and tiles: `group/<key>`, `age/<bucket>`, `queued`, `done-today`.
  const listView = (snapshot, filter, today = localDate(new Date())) => {
    const [kind, ...rest] = filter.split('/');
    const arg = rest.length ? decodeURIComponent(rest.join('/')) : null;
    const all = cards(snapshot);
    const views = {
      group: () => [GROUPS.find((g) => g.key === arg)?.label ?? arg, all.filter((c) => groupOf(c) === arg)],
      age: () => [`Waiting ${AGE_BUCKETS.find((b) => b.key === arg)?.label.toLowerCase() ?? arg}`,
        all.filter((c) => WAITING.has(c.column) && ageBucketOf(c.ageSeconds) === arg)],
      queued: () => ['Queued, not started', (snapshot.backlog?.records ?? []).filter((r) => r.state === 'queued').map((r) => card({
        key: `queued:${r.id}`, source: 'queued', id: r.id, title: r.title ?? r.id, project: r.repo ?? NO_PROJECT, column: 'queued', resolve: [],
        text: [r.hold_reason && `On hold: ${r.hold_reason}`, r.body_excerpt].filter(Boolean),
      }))],
      'done-today': () => ['Finished today', finishedRecords(snapshot).filter((f) => f.date === today).map((f) => all.find((c) => c.source === 'finished' && c.id === f.id)
        ?? card({ key: `done::${f.id}`, source: 'finished', id: f.id, title: f.title, project: f.project ?? NO_PROJECT, date: f.date, column: 'done', resolve: [] }))],
    };
    if (!Object.hasOwn(views, kind)) return null;
    const [title, list] = views[kind]();
    return { title, cards: [...list].sort(byAge) };
  };

  const ago = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  };

  // Plain-language freshness line; tone 'error' only when the newest refresh failed.
  const freshnessBanner = ({ loading, fetchedAt, stale, refreshing, error, now = Date.now() }) => {
    if (loading) {
      return error
        ? { tone: 'error', text: `The first snapshot failed: ${error}. Retrying.` }
        : { tone: 'info', text: 'Loading the first snapshot (can take up to a minute).' };
    }
    const age = fetchedAt ? `Data from ${ago(now - Date.parse(fetchedAt))}` : 'Data age unknown';
    if (stale) return { tone: 'error', text: `${age}. Last refresh failed: ${stale}.${refreshing ? ' Retrying now.' : ''}` };
    return { tone: refreshing ? 'info' : 'quiet', text: `${age}${refreshing ? ' · refreshing' : ''}` };
  };

  const bytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);
  const duration = (s) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`);
  const share = (x) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);

  // Display strings for the resources panel; app.js renders them via textContent.
  const resourcesView = (r) => ({
    badge: r.alerts.length
      ? { tone: 'error', text: `${r.alerts.length} machine alert${r.alerts.length === 1 ? '' : 's'}` }
      : { tone: 'ok', text: 'Machine OK' },
    alerts: r.alerts,
    machine: [
      ['Load (1 min / 5 min)', `${r.load.oneMinute.toFixed(1)} / ${r.load.fiveMinute.toFixed(1)} on ${r.load.cores} cores`],
      ['Memory', r.memory ? `${share(r.memory.freeShare)} free, ${share(r.memory.compressedShare)} compressed of ${bytes(r.memory.totalBytes)}` : 'unavailable'],
      ['Processes', `${r.processes.user} yours${r.processes.limit ? ` of ${r.processes.limit} allowed` : ''} (${r.processes.total} total)`],
    ],
    sessions: r.sessions.map((s) => ({
      name: s.cwd ?? `pid ${s.pid}`, memory: bytes(s.rssBytes), processes: String(s.processes), mcpHelpers: String(s.mcpHelpers), age: duration(s.ageSeconds),
    })),
    orphans: r.orphans.map((o) => ({ pid: String(o.pid), command: o.command, memory: bytes(o.rssBytes), age: duration(o.ageSeconds) })),
  });

  // KPI strip: one tile per waiting column plus finished today and the machine.
  // Each links to its column or page; sparklines come from the server's trend history.
  const kpis = ({ counts, machine, limits = {}, history = { fleet: [], machine: [] } }) => {
    const series = (k) => history.fleet.map((p) => p[k] ?? null);
    const c = counts ?? {};
    const tile = (key, label, value, tone, href, trend, note) => ({
      key, label, value: value == null ? 'n/a' : String(value), tone: value == null ? 'quiet' : tone, note: value == null ? 'Not measured yet' : note, href, series: trend,
    });
    const column = (key, label, isUrgent, notes) => tile(key, label, c[key], c[key] ? (isUrgent ? 'alert' : 'warn') : 'ok', `#/board/${key}`, series(key), c[key] ? notes[0] : notes[1]);
    const loadPerCore = machine?.load != null && machine.cores ? machine.load / machine.cores : null;
    const isOverloaded = loadPerCore > (limits.loadPerCore ?? 2);
    return [
      column('decide', 'Needs your decision', false, ['Waiting on you', 'Nothing waiting']),
      column('aging', 'Aging decisions', true, ['Waiting 3 days or more', 'None overdue']),
      column('blocked', 'Blocked', true, ['Stuck on something', 'Nothing stuck']),
      tile('working', 'Working', c.working, 'ok', '#/board/working', series('working'), 'Under way'),
      column('review', 'Waiting on review', false, ['Ready for your review', 'Nothing to review']),
      column('land', 'Ready to land', false, ['Ready for your merge call', 'Nothing to merge']),
      tile('done-today', 'Finished today', c.doneToday, c.doneToday ? 'ok' : 'quiet', '#/list/done-today', series('doneToday'), c.doneToday ? 'Landed today' : 'None yet today'),
      tile('load', 'Machine load', loadPerCore == null ? null : `${Math.round(loadPerCore * 100)}%`, isOverloaded ? 'alert' : loadPerCore > 1 ? 'warn' : 'ok', '#/machine',
        history.machine.map((p) => (p.load != null && p.cores ? p.load / p.cores : null)), isOverloaded ? 'Overloaded' : loadPerCore > 1 ? 'Busy' : 'Of all cores'),
      tile('sessions', 'Claude sessions', machine?.sessions, machine?.sessions > (limits.claudeSessions ?? Infinity) ? 'alert' : 'ok', '#/machine',
        history.machine.map((p) => p.sessions), machine?.sessions > (limits.claudeSessions ?? Infinity) ? 'Too many running' : 'Running now'),
      tile('orphans', 'Stray helpers', machine?.orphans, machine?.orphans ? 'warn' : 'ok', '#/machine', history.machine.map((p) => p.orphans),
        machine?.orphans ? 'Parent has exited' : 'None left behind'),
    ];
  };

  return {
    SCHEMA, COLUMNS, GROUPS, AGE_BUCKETS, AGING_AFTER, assertSchema, taskDetail, freshnessBanner, resourcesView,
    cards, workColumn, boardView, projects, projectName, prNumber, fleetCounts, machineSample, stateBreakdown, projectBars, ageHistogram, listView, kpis,
    duration, localDate,
  };
});
