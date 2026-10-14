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

  return { SCHEMA, assertSchema, fleetOverview, decisionsInbox, taskDetail };
});
