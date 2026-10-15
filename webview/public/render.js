// Pure view-model builders over an `fm-fleet-snapshot.v1` object. No DOM and no
// derivation of fleet state: every field is read from the snapshot as published.
// Values stay raw strings; app.js is the only place they reach the DOM, via textContent.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FleetRender = factory();
})(typeof self === 'undefined' ? this : self, function () {
  const SCHEMA = 'fm-fleet-snapshot.v1';

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
    })));
    const fromHolds = (snapshot.backlog?.records ?? []).filter((r) => r.hold_bucket === 'live').map((r) => ({
      source: 'hold', id: r.id, taskId: link(r.id), key: r.id, kind: 'captain-hold', summary: r.title,
      reason: r.hold_reason, holdUntil: r.hold_until, ageDays: r.hold_age_days, project: r.repo,
    }));
    const fromSecondmates = (snapshot.secondmate_current?.records ?? []).flatMap((m) => (m.decisions_open ?? []).map((d) => ({
      source: `secondmate ${m.id}`, id: d.id ?? d.key ?? m.id, taskId: link(m.id), key: d.key ?? d.id,
      kind: d.verb ?? 'decision', summary: d.summary ?? d.title ?? '', reason: d.reason ?? null,
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

  // One status board: what needs the captain, work in flight by project, and
  // recently finished rows. Every bucket is a snapshot field, never a status-log fold.
  const board = (snapshot) => {
    const { tasks } = fleetOverview(snapshot);
    const asks = decisionsInbox(snapshot).items.map((d) => ({
      label: ASK_LABEL[d.kind] ?? d.kind, taskId: d.taskId, project: d.project ?? null, title: d.summary,
      detail: [d.reason, d.holdUntil && `until ${d.holdUntil}`, d.ageDays != null && `${d.ageDays}d old`].filter(Boolean).join(' · '),
      prUrl: null, source: d.source,
    }));
    const reviews = tasks.filter((t) => t.state === 'done' && t.prUrl && !PR_SETTLED.test(t.stateDetail ?? '')).map((t) => ({
      label: 'PR ready for review', taskId: t.id, project: t.project, title: t.title ?? t.id, detail: t.stateDetail ?? '', prUrl: t.prUrl, source: 'task',
    }));
    const byProject = new Map();
    tasks.forEach((t) => byProject.set(t.project ?? NO_PROJECT, [...(byProject.get(t.project ?? NO_PROJECT) ?? []), t]));
    const finished = [
      ...(snapshot.backlog?.records ?? []).filter((r) => r.state === 'done'),
      ...(snapshot.secondmate_landed?.records ?? []),
    ].map((r) => ({
      id: r.id, title: r.title ?? r.raw ?? r.id, project: r.repo ?? null, home: r.home_id ?? null,
      verb: r.completion?.verb ?? null, date: r.completion?.date ?? r.done ?? null, url: r.pr_url ?? r.report_path ?? null,
    })).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, RECENT_LIMIT);
    return {
      needsCaptain: [...asks, ...reviews],
      inFlight: [...byProject].sort(([a], [b]) => a.localeCompare(b)).map(([project, list]) => ({ project, tasks: list })),
      finished,
    };
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

  return { SCHEMA, assertSchema, fleetOverview, decisionsInbox, taskDetail, board, freshnessBanner, resourcesView };
});
