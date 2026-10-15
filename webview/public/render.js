// Pure view-model builders over an `fm-fleet-snapshot.v1` object. No DOM and no
// derivation of fleet state: every field is read from the snapshot as published.
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

  const backlogById = (snapshot) => new Map((snapshot.backlog?.records ?? []).map((r) => [r.id, r]));

  const waitsOn = (task, backlog) => {
    const decisions = (task.hints?.open_decisions ?? []).map((d) => `${d.verb}: ${d.summary}`);
    const hold = backlog?.hold_reason ? [`hold: ${backlog.hold_reason}`] : [];
    const blockers = backlog?.unresolved_blocker_ids?.length ? [`blocked by ${backlog.unresolved_blocker_ids.join(', ')}`] : [];
    return [...decisions, ...hold, ...blockers];
  };

  const fleetOverview = (snapshot) => {
    assertSchema(snapshot);
    const backlog = backlogById(snapshot);
    return {
      generated: snapshot.generated,
      tasks: (snapshot.tasks ?? []).map((t) => ({
        id: t.id,
        kind: t.kind,
        project: t.project,
        title: t.backlog?.title ?? null,
        state: t.current_state?.state ?? 'unknown',
        stateDetail: t.current_state?.detail ?? null,
        waitsOn: waitsOn(t, backlog.get(t.id)),
        prUrl: t.pr?.url ?? null,
        endpointExists: t.endpoint?.exists ?? null,
        agentAlive: t.endpoint?.agent_alive ?? null,
        needsCaptain: Boolean(t.hints?.pending_decision || t.hints?.blocked_event),
        // Time since the task's last status event, relative to the snapshot.
        ageSeconds: t.paths?.status_log?.last_event?.age_seconds ?? null,
        since: t.backlog?.since ?? null,
      })),
      secondmates: (snapshot.secondmate_current?.records ?? []).map((r) => ({
        id: r.id,
        state: r.current?.state ?? 'unknown',
        activeChildren: r.active_children?.length ?? 0,
        decisionsOpen: r.decisions_open?.length ?? 0,
        holds: r.holds?.length ?? 0,
        queued: r.queued?.length ?? 0,
      })),
    };
  };

  // Decisions come only from the snapshot's own buckets: the keyed open-decision
  // fold (hints.open_decisions), live captain holds (hold_bucket === 'live'), and
  // secondmates' decisions_open. status logs are never re-read or re-folded here.
  const decisionsInbox = (snapshot) => {
    assertSchema(snapshot);
    const taskIds = new Set((snapshot.tasks ?? []).map((t) => t.id));
    const link = (id) => (taskIds.has(id) ? id : null);
    const fromStatus = (snapshot.tasks ?? []).flatMap((t) => (t.hints?.open_decisions ?? []).map((d) => ({
      source: 'status', id: t.id, taskId: t.id, key: d.key, kind: d.verb, summary: d.summary, project: t.project,
      ageSeconds: t.paths?.status_log?.last_event?.age_seconds ?? null,
    })));
    const fromHolds = (snapshot.backlog?.records ?? []).filter((r) => r.hold_bucket === 'live').map((r) => ({
      source: 'hold', id: r.id, taskId: link(r.id), key: r.id, kind: 'captain-hold', summary: r.title,
      reason: r.hold_reason, holdUntil: r.hold_until, ageDays: r.hold_age_days, project: r.repo,
      ageSeconds: r.hold_age_days == null ? null : r.hold_age_days * DAY,
    }));
    const fromSecondmates = (snapshot.secondmate_current?.records ?? []).flatMap((m) => (m.decisions_open ?? []).map((d) => ({
      source: `secondmate ${m.id}`, id: d.id ?? d.key ?? m.id, taskId: link(m.id), key: d.key ?? d.id,
      kind: d.verb ?? 'decision', summary: d.summary ?? d.title ?? '', reason: d.reason ?? null,
      ageSeconds: d.hold_age_days == null ? null : d.hold_age_days * DAY,
    })));
    return { generated: snapshot.generated, items: [...fromStatus, ...fromHolds, ...fromSecondmates] };
  };

  const taskDetail = (snapshot, id, detail) => {
    assertSchema(snapshot);
    const task = (snapshot.tasks ?? []).find((t) => t.id === id);
    if (!task) return null;
    return {
      id,
      kind: task.kind,
      project: task.project,
      harness: task.harness,
      mode: task.mode,
      title: task.backlog?.title ?? null,
      state: task.current_state?.state ?? 'unknown',
      stateSource: task.current_state?.source ?? null,
      stateDetail: task.current_state?.detail ?? null,
      waitsOn: waitsOn(task, task.backlog),
      prUrl: task.pr?.url ?? null,
      statusLabel: statusLabelOf(fleetOverview(snapshot).tasks.find((t) => t.id === id)),
      ageSeconds: task.paths?.status_log?.last_event?.age_seconds ?? null,
      since: task.backlog?.since ?? null,
      endpoint: task.endpoint ?? null,
      // Labelled history on purpose: wake events are never current state.
      lastEvent: task.paths?.status_log?.last_event ?? null,
      statusHistory: detail?.status_history ?? [],
      inbox: detail?.inbox ?? { pending: [], handled: [] },
    };
  };

  const ASK_LABEL = { 'needs-decision': 'Needs a decision', blocked: 'Blocked', 'captain-hold': 'Your call', decision: 'Needs a decision' };
  // fm-crew-state.sh's fixed detail vocabulary for a passed run whose PR no longer awaits a merge call.
  const PR_SETTLED = /\bPR (merged|closed)\b/;
  const RECENT_LIMIT = 15;
  const NO_PROJECT = '(no project)';

  const isReviewReady = (t) => t.state === 'done' && Boolean(t.prUrl) && !PR_SETTLED.test(t.stateDetail ?? '');

  const finishedRecords = (snapshot) => [
    ...(snapshot.backlog?.records ?? []).filter((r) => r.state === 'done'),
    ...(snapshot.secondmate_landed?.records ?? []),
  ].map((r) => ({
    id: r.id, title: r.title ?? r.raw ?? r.id, project: r.repo ?? null, home: r.home_id ?? null,
    verb: r.completion?.verb ?? null, date: r.completion?.date ?? r.done ?? null, url: r.pr_url ?? r.report_path ?? null,
  })).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  // One status board: what needs the captain, work in flight by project, and
  // recently finished rows. Every bucket is a snapshot field, never a status-log fold.
  const board = (snapshot) => {
    const { tasks } = fleetOverview(snapshot);
    const asks = decisionsInbox(snapshot).items.map((d) => ({
      label: ASK_LABEL[d.kind] ?? d.kind, taskId: d.taskId, project: d.project ?? null, title: d.summary,
      detail: [d.reason, d.holdUntil && `until ${d.holdUntil}`, d.ageDays != null && `${d.ageDays}d old`].filter(Boolean).join(' · '),
      id: d.id, prUrl: null, source: d.source, ageSeconds: d.ageSeconds ?? null,
    }));
    const reviews = tasks.filter(isReviewReady).map((t) => ({
      id: t.id, label: 'PR ready for review', taskId: t.id, project: t.project, title: t.title ?? t.id, detail: t.stateDetail ?? '', prUrl: t.prUrl, source: 'task',
      ageSeconds: t.ageSeconds,
    }));
    const byProject = new Map();
    tasks.forEach((t) => byProject.set(t.project ?? NO_PROJECT, [...(byProject.get(t.project ?? NO_PROJECT) ?? []), t]));
    return {
      asks,
      reviews,
      needsCaptain: [...asks, ...reviews],
      inFlight: [...byProject].sort(([a], [b]) => a.localeCompare(b)).map(([project, list]) => ({ project, tasks: list })),
      finished: finishedRecords(snapshot).slice(0, RECENT_LIMIT),
    };
  };

  // Dashboard state classes, in the fixed order the palette was validated in
  // (adjacent pairs clear the colour-vision checks only in this order).
  const BUCKETS = [
    { key: 'needs', label: 'Needs you' },
    { key: 'blocked', label: 'Blocked' },
    { key: 'waiting', label: 'Waiting' },
    { key: 'working', label: 'Working' },
    { key: 'done', label: 'Done' },
    { key: 'unknown', label: 'Status unknown' },
  ];
  const BUCKET_OF_STATE = { blocked: 'blocked', failed: 'blocked', paused: 'waiting', parked: 'waiting', working: 'working', done: 'done' };
  const bucketOf = (t) => (t.needsCaptain || isReviewReady(t) ? 'needs' : BUCKET_OF_STATE[t.state] ?? 'unknown');
  const bucketLabel = (key) => BUCKETS.find((b) => b.key === key)?.label ?? key;
  const statusLabelOf = (t) => (t.state === 'failed' && bucketOf(t) === 'blocked' ? 'Failed' : bucketLabel(bucketOf(t)));

  const AGE_BUCKETS = [
    { key: 'hour', label: 'Under 1 h', below: HOUR },
    { key: 'hours', label: '1-6 h', below: 6 * HOUR },
    { key: 'day', label: '6-24 h', below: DAY },
    { key: 'days', label: '1-3 days', below: 3 * DAY },
    { key: 'week', label: '3-7 days', below: 7 * DAY },
    { key: 'older', label: 'Over a week', below: Infinity },
  ];
  const ageBucketOf = (seconds) => (seconds == null ? null : AGE_BUCKETS.find((b) => seconds < b.below).key);

  const localDate = (date) => date.toLocaleDateString('en-CA');
  // Some homes record a project as its clone path; show only the folder name.
  const projectName = (p) => (p && p.includes('/') ? p.replace(/\/+$/, '').split('/').pop() : p ?? NO_PROJECT);

  const taskRow = (t) => ({
    id: t.id, taskId: t.id, title: t.title ?? t.id, project: projectName(t.project), bucket: bucketOf(t),
    label: statusLabelOf(t), detail: t.stateDetail ?? '', waitsOn: t.waitsOn, prUrl: t.prUrl, ageSeconds: t.ageSeconds,
  });
  const askRow = (a) => ({
    id: a.id ?? a.taskId, taskId: a.taskId, title: a.title, project: projectName(a.project), bucket: 'needs',
    label: a.label, detail: a.detail, waitsOn: [], prUrl: a.prUrl, ageSeconds: a.ageSeconds,
  });
  const queuedRow = (r) => ({
    id: r.id, taskId: null, title: r.title ?? r.id, project: projectName(r.repo), bucket: null,
    label: r.hold_reason ? 'On hold' : 'Queued', detail: r.hold_reason ?? r.blocked_reason ?? '', waitsOn: [], prUrl: r.pr_url ?? null,
    ageSeconds: null,
  });
  const finishedRow = (f) => ({
    id: f.id, taskId: null, title: f.title, project: projectName(f.project), bucket: 'done',
    label: f.date ? `Finished ${f.date}` : 'Finished', detail: f.home ? `via ${f.home}` : '', waitsOn: [], prUrl: f.url, ageSeconds: null,
  });

  // Items waiting on someone: the captain's asks and reviews, plus blocked work.
  const waitingRows = (snapshot) => {
    const { asks, reviews } = board(snapshot);
    const blocked = fleetOverview(snapshot).tasks.filter((t) => bucketOf(t) === 'blocked').map(taskRow);
    return [...asks.map(askRow), ...reviews.map(askRow), ...blocked];
  };

  // Headline counts. The server samples these per snapshot for the trend sparklines.
  const fleetCounts = (snapshot, today = localDate(new Date())) => {
    const { tasks } = fleetOverview(snapshot);
    const { asks, reviews } = board(snapshot);
    return {
      needsYou: asks.length + reviews.length,
      needsDecision: asks.length,
      reviews: reviews.length,
      blocked: tasks.filter((t) => bucketOf(t) === 'blocked').length,
      inProgress: tasks.filter((t) => t.state !== 'done').length,
      queued: (snapshot.backlog?.records ?? []).filter((r) => r.state === 'queued').length,
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

  const stateBreakdown = (snapshot) => {
    const tasks = fleetOverview(snapshot).tasks;
    return BUCKETS.map((b) => ({ ...b, count: tasks.filter((t) => bucketOf(t) === b.key).length, href: `#/list/state/${b.key}` }));
  };

  // Top projects by task count, the rest folded into one row rather than more rows.
  const projectBars = (snapshot, max = 8) => {
    const rows = board(snapshot).inFlight.map(({ project, tasks }) => ({
      project: projectName(project), total: tasks.length, href: `#/list/project/${encodeURIComponent(project)}`,
      segments: BUCKETS.map((b) => ({ key: b.key, label: b.label, count: tasks.filter((t) => bucketOf(t) === b.key).length })),
    })).sort((a, b) => b.total - a.total || a.project.localeCompare(b.project));
    if (rows.length <= max) return rows;
    const rest = rows.slice(max - 1);
    return [...rows.slice(0, max - 1), {
      project: `${rest.length} other projects`, total: rest.reduce((n, r) => n + r.total, 0), href: '#/list/in-progress',
      segments: BUCKETS.map((b, i) => ({ ...rest[0].segments[i], count: rest.reduce((n, r) => n + r.segments[i].count, 0) })),
    }];
  };

  const ageHistogram = (snapshot) => {
    const rows = waitingRows(snapshot);
    return {
      bins: AGE_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: rows.filter((r) => ageBucketOf(r.ageSeconds) === b.key).length, href: `#/list/age/${b.key}` })),
      unknownAge: rows.filter((r) => r.ageSeconds == null).length,
    };
  };

  // A drill-down list for a route filter such as `blocked`, `state/working`, `project/<name>`, or `age/day`.
  const listView = (snapshot, filter, today = localDate(new Date())) => {
    const [kind, ...rest] = filter.split('/');
    const arg = rest.length ? decodeURIComponent(rest.join('/')) : null;
    const tasks = fleetOverview(snapshot).tasks;
    const { asks, reviews } = board(snapshot);
    const queued = (snapshot.backlog?.records ?? []).filter((r) => r.state === 'queued');
    const byBucket = (key) => tasks.filter((t) => bucketOf(t) === key).map(taskRow);
    const views = {
      needs: () => ['Needs you', [...asks, ...reviews].map(askRow)],
      'needs-decision': () => ['Needs your decision', asks.map(askRow)],
      reviews: () => ['Waiting on review', reviews.map(askRow)],
      blocked: () => ['Blocked', byBucket('blocked')],
      'in-progress': () => ['In progress', tasks.filter((t) => t.state !== 'done').map(taskRow)],
      queued: () => ['Queued', queued.map(queuedRow)],
      'done-today': () => ['Finished today', finishedRecords(snapshot).filter((f) => f.date === today).map(finishedRow)],
      finished: () => ['Recently finished', finishedRecords(snapshot).slice(0, RECENT_LIMIT).map(finishedRow)],
      state: () => [bucketLabel(arg), byBucket(arg)],
      project: () => [`Project ${projectName(arg)}`, [
        ...tasks.filter((t) => (t.project ?? NO_PROJECT) === arg).map(taskRow),
        ...queued.filter((r) => (r.repo ?? NO_PROJECT) === arg).map(queuedRow)]],
      age: () => [`Waiting ${AGE_BUCKETS.find((b) => b.key === arg)?.label.toLowerCase() ?? arg}`,
        waitingRows(snapshot).filter((r) => ageBucketOf(r.ageSeconds) === arg)],
    };
    if (!Object.hasOwn(views, kind)) return null;
    const [title, items] = views[kind]();
    return { title, items: [...items].sort((a, b) => (b.ageSeconds ?? -1) - (a.ageSeconds ?? -1)) };
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

  const TONE_NOTE = { alert: 'Needs attention', warn: 'Waiting on you', ok: 'Healthy', quiet: '' };

  // KPI tiles: counts from the snapshot, machine figures from the latest reading,
  // sparklines from the server's trend history. Each tile links to its drill-down.
  const kpis = ({ counts, machine, limits = {}, history = { fleet: [], machine: [] } }) => {
    const fleetSeries = (k) => history.fleet.map((p) => p[k]);
    const machineSeries = (k) => history.machine.map((p) => p[k]);
    const tile = (key, label, value, tone, href, series, note = TONE_NOTE[tone]) => ({
      key, label, value: value == null ? 'n/a' : String(value), tone: value == null ? 'quiet' : tone, note: value == null ? 'Not measured yet' : note, href, series,
    });
    const c = counts ?? {};
    const loadPerCore = machine?.load != null && machine.cores ? machine.load / machine.cores : null;
    return [
      tile('needs-decision', 'Needs your decision', c.needsDecision, c.needsDecision ? 'warn' : 'ok', '#/list/needs-decision', fleetSeries('needsDecision'), c.needsDecision ? 'Waiting on you' : 'Nothing waiting'),
      tile('blocked', 'Blocked', c.blocked, c.blocked ? 'alert' : 'ok', '#/list/blocked', fleetSeries('blocked'), c.blocked ? 'Needs attention' : 'Nothing stuck'),
      tile('in-progress', 'In progress', c.inProgress, 'ok', '#/list/in-progress', fleetSeries('inProgress'), 'Under way'),
      tile('reviews', 'Waiting on review', c.reviews, c.reviews ? 'warn' : 'ok', '#/list/reviews', fleetSeries('reviews'), c.reviews ? 'Ready for you' : 'Nothing to review'),
      tile('queued', 'Queued', c.queued, 'quiet', '#/list/queued', fleetSeries('queued'), 'Not started yet'),
      tile('done-today', 'Finished today', c.doneToday, c.doneToday ? 'ok' : 'quiet', '#/list/done-today', fleetSeries('doneToday'), c.doneToday ? 'Landed today' : 'None yet today'),
      tile('load', 'Machine load', loadPerCore == null ? null : `${Math.round(loadPerCore * 100)}%`,
        loadPerCore > (limits.loadPerCore ?? 2) ? 'alert' : loadPerCore > 1 ? 'warn' : 'ok', '#/machine',
        history.machine.map((p) => (p.load != null && p.cores ? p.load / p.cores : null)),
        loadPerCore > (limits.loadPerCore ?? 2) ? 'Overloaded' : loadPerCore > 1 ? 'Busy' : 'Of all cores'),
      tile('sessions', 'Claude sessions', machine?.sessions, machine?.sessions > (limits.claudeSessions ?? Infinity) ? 'alert' : 'ok', '#/machine',
        machineSeries('sessions'), machine?.sessions > (limits.claudeSessions ?? Infinity) ? 'Too many running' : 'Running now'),
      tile('orphans', 'Stray helpers', machine?.orphans, machine?.orphans ? 'warn' : 'ok', '#/machine', machineSeries('orphans'),
        machine?.orphans ? 'Parent has exited' : 'None left behind'),
    ];
  };

  return {
    SCHEMA, BUCKETS, AGE_BUCKETS, assertSchema, fleetOverview, decisionsInbox, taskDetail, board, freshnessBanner, resourcesView,
    bucketOf, fleetCounts, machineSample, stateBreakdown, projectBars, ageHistogram, listView, kpis, duration, localDate,
  };
});
