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

  // ---- source links ----
  // Only http and https ever become links, so a javascript: or file: URL in a row is never rendered.
  const isWebUrl = (url) => /^https?:\/\//i.test(url ?? '');
  const URL_IN_TEXT = /https?:\/\/[^\s)"<>]+/g;
  const JIRA_KEY = /\b[A-Z][A-Z0-9]+-[0-9]+\b/g;
  const SOURCE_ORDER = ['pr', 'jira', 'chat', 'doc'];
  // Matched on the parsed hostname, so a lookalike host in a path or query never passes.
  const SOURCE_KINDS = [
    { kind: 'pr', test: (u) => u.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/pull\/\d+/.test(u.pathname), label: (u) => `PR ${prNumber(u.href)}` },
    { kind: 'jira', test: (u) => u.hostname.endsWith('.atlassian.net') && /^\/browse\/[A-Z][A-Z0-9]+-\d+/.test(u.pathname), label: (u) => u.pathname.split('/')[2] },
    { kind: 'chat', test: (u) => u.hostname.endsWith('.slack.com') && u.pathname.startsWith('/archives/'), label: () => 'Slack' },
    { kind: 'chat', test: (u) => ['teams.microsoft.com', 'teams.cloud.microsoft'].includes(u.hostname), label: () => 'Teams' },
    { kind: 'doc', test: (u) => /(^|\.)notion\.(so|site)$/.test(u.hostname) || u.hostname === 'docs.google.com'
      || (u.hostname.endsWith('.atlassian.net') && u.pathname.startsWith('/wiki/')), label: () => 'Doc' },
  ];
  const classifySource = (url) => {
    if (!isWebUrl(url)) return null;
    let u;
    try { u = new URL(url); } catch { return null; }
    const match = SOURCE_KINDS.find((k) => k.test(u));
    return match ? { kind: match.kind, label: match.label(u), url } : null;
  };
  // Trailing sentence punctuation is not part of a URL written in prose.
  const urlsIn = (lines) => (lines ?? []).flatMap((line) => (line.match(URL_IN_TEXT) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')));
  const recordUrls = (r) => [...(r?.links ?? []), ...urlsIn(r?.body_lines)];

  // Every recognised source of a card, in fixed kind order, each URL once. The card's own
  // PR counts whatever its forge; Jira keys in the title link only with a configured base.
  const sourceLinks = (c, { jiraBase } = {}) => {
    const base = isWebUrl(jiraBase) ? jiraBase.replace(/\/+$/, '') : null;
    const keys = base ? (c.title ?? '').match(JIRA_KEY) ?? [] : [];
    const seen = new Set();
    return [
      isWebUrl(c.prUrl) && { kind: 'pr', label: prNumber(c.prUrl) ? `PR ${prNumber(c.prUrl)}` : 'PR', url: c.prUrl },
      ...(c.sourceUrls ?? []).map(classifySource),
      ...keys.map((key) => ({ kind: 'jira', label: key, url: `${base}/browse/${key}` })),
    ].filter((s) => s && !seen.has(s.url) && seen.add(s.url))
      .sort((a, b) => SOURCE_ORDER.indexOf(a.kind) - SOURCE_ORDER.indexOf(b.kind));
  };
  // The card footer shows the first source of each kind.
  const cardSources = (c, config) => sourceLinks(c, config).filter((s, i, all) => all.findIndex((x) => x.kind === s.kind) === i);

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
  const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
  // `answer` records the captain's words and closes a question; `--release` records
  // them and lets held work resume instead (captain-hold-lifecycle: answer vs release).
  const HOLD_STEPS = {
    question: [['Command firstmate would run (records your answer and closes the question)', '']],
    work: [['Command firstmate would run (records your answer and lets the work go ahead)', ' --release']],
    unknown: [['If it is a question, firstmate would run (records your answer and closes it)', ''],
      ['If the held work should go ahead, firstmate would run', ' --release']],
  };
  const holdCommands = (id, shape, prefix = '', labelSuffix = '') => HOLD_STEPS[shape ?? 'unknown'].map(([label, flag]) => ({
    label: `${label}${labelSuffix}`, text: `${prefix}bin/fm-captain-hold.sh answer ${id} --decision-file <file with your answer>${flag}`,
  }));
  // A captain-kind row is the question itself; a held ship, scout, or other work row resumes once answered.
  const holdShape = (record) => (record?.kind === 'captain' ? 'question' : record?.kind ? 'work' : null);

  // A decision recorded in a second mate's home is answered in that home, never
  // this one: its command names that FM_HOME, or is left out when the home is
  // remote or unknown, so a copied command cannot act on the wrong backlog.
  const decisionSteps = (c, d, target) => {
    if (d.owner) {
      const isHold = d.kind === 'captain-hold';
      return [{ label: 'Tell firstmate', text: `For second mate ${d.owner.id}, ${isHold ? `decision on ${d.holdId}` : `${d.key} (${d.summary})`}: <your answer>` },
        ...(isHold && d.owner.home ? holdCommands(d.holdId, d.shape, `FM_HOME=${shellQuote(d.owner.home)} `, `, in second mate ${d.owner.id}'s home`) : [])];
    }
    if (d.kind === 'captain-hold') {
      return [{ label: 'Tell firstmate', text: `Decision on ${d.holdId ?? c.id}: <your call>` }, ...holdCommands(d.holdId ?? c.id, d.shape)];
    }
    return [{ label: 'Tell firstmate', text: `For ${c.id} (${d.summary}): <your answer>` },
      target && { label: 'Command firstmate would run', text: `bin/fm-send.sh ${target} --resolve-key ${d.key} '<your answer>'` }];
  };

  // Suggested ways to resolve a card: what to tell firstmate, and the command it
  // would run. The web view never runs them.
  const resolveSteps = (c, task) => {
    const target = task && steerTarget(task);
    const steps = c.decisions.flatMap((d) => decisionSteps(c, d, target));
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

  // ageSeconds is how long the card has waited: for a decision, since the oldest
  // decision was raised; otherwise since the last update (lastUpdateSeconds).
  const card = (fields) => ({
    taskId: null, project: NO_PROJECT, ageSeconds: null, lastUpdateSeconds: null, prUrl: null, sourceUrls: [], decisions: [], blockers: { events: [], ids: [], reason: null },
    stateDetail: null, text: [], date: null, badges: [], ...fields,
  });

  const finishedRecords = (snapshot) => [
    ...(snapshot.backlog?.records ?? []).filter((r) => r.state === 'done'),
    ...(snapshot.secondmate_landed?.records ?? []),
  ].map((r) => ({
    id: r.id, title: r.title ?? r.raw ?? r.id, project: r.repo ?? null, home: r.home_id ?? null,
    verb: r.completion?.verb ?? null, date: r.completion?.date ?? r.done ?? null, url: r.pr_url ?? r.report_path ?? null, sourceUrls: recordUrls(r),
  })).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  // Every board card, classified from the snapshot's structured fields. Status logs
  // are never re-read; free text is only displayed, never matched, except the fixed
  // PR-settled vocabulary above.
  const cards = (snapshot, { recentLimit = RECENT_LIMIT } = {}) => {
    assertSchema(snapshot);
    const generatedMs = Date.parse(snapshot.generated ?? '') || Date.now();
    const records = snapshot.backlog?.records ?? [];
    const byId = new Map(records.map((r) => [r.id, r]));
    const holdAge = (r) => (r.hold_set && Date.parse(r.hold_set) ? Math.max(0, (generatedMs - Date.parse(r.hold_set)) / 1000)
      : r.hold_age_days == null ? null : r.hold_age_days * DAY);
    const holdDecision = (r, shape = holdShape(r)) => ({ key: r.id, kind: 'captain-hold', holdId: r.id, shape, summary: r.hold_reason ?? r.title ?? r.id, until: r.hold_until ?? null, ageSeconds: holdAge(r) });
    const oldest = (decisions) => decisions.reduce((max, d) => (d.ageSeconds != null && (max == null || d.ageSeconds > max) ? d.ageSeconds : max), null);
    const out = [];
    const taskCards = new Map();
    const tasksById = new Map((snapshot.tasks ?? []).map((t) => [t.id, t]));

    (snapshot.tasks ?? []).forEach((task) => {
      const record = byId.get(task.id) ?? task.backlog ?? null;
      const open = task.hints?.open_decisions ?? [];
      const lastUpdateSeconds = task.paths?.status_log?.last_event?.age_seconds ?? null;
      // An open status decision has no timestamp of its own, so it ages from the latest status event.
      const decisions = open.filter((d) => d.verb !== 'blocked').map((d) => ({ key: d.key, kind: d.verb, summary: d.summary, ageSeconds: lastUpdateSeconds }));
      // A hold on a dispatched task gates work that is already under way, so answering releases it.
      if (record?.hold_bucket === 'live') decisions.push(holdDecision(record, 'work'));
      const t = {
        kind: task.kind, mode: task.mode, state: task.current_state?.state ?? 'unknown', prUrl: task.pr?.url ?? null,
        isPrSettled: PR_SETTLED.test(task.current_state?.detail ?? '') || Boolean(record?.merged),
        blockedEvents: open.filter((d) => d.verb === 'blocked').map((d) => ({ key: d.key, summary: d.summary })),
        blockerIds: record?.unresolved_blocker_ids ?? [],
      };
      const ageSeconds = decisions.length ? oldest(decisions) : lastUpdateSeconds;
      const c = card({
        key: `task:${task.id}`, source: 'task', id: task.id, taskId: task.id, title: record?.title ?? task.id,
        project: task.project ?? record?.repo ?? NO_PROJECT, ageSeconds, lastUpdateSeconds, prUrl: t.prUrl, sourceUrls: recordUrls(record), decisions,
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
      const home = !m.remote && typeof m.home === 'string' && m.home ? m.home : null;
      (m.decisions_open ?? []).forEach((d) => {
        // Children of one second mate can reuse a key such as `approval`, so identity is child id plus key.
        const decision = {
          id: d.id ?? null, key: d.key ?? d.id, kind: d.verb ?? 'decision', holdId: d.verb === 'captain-hold' ? d.id : undefined, summary: d.summary ?? d.title ?? '', reason: d.reason ?? null,
          ageSeconds: d.hold_age_days == null ? null : d.hold_age_days * DAY, owner: { id: m.id, home },
        };
        if (owner) {
          if (owner.decisions.some((x) => x.owner && x.id === decision.id && x.key === decision.key)) return;
          // The second mate's own record is authoritative; the parent's relayed status copy of that key gives way to it.
          owner.decisions = owner.decisions.filter((x) => x.owner || x.kind === 'captain-hold' || x.key !== decision.key);
          owner.decisions.push(decision);
          owner.ageSeconds = oldest(owner.decisions);
          owner.column = decisionColumn(owner.ageSeconds);
          owner.resolve = resolveSteps(owner, tasksById.get(m.id));
          return;
        }
        const { ageSeconds } = decision;
        const c = card({ key: `secondmate:${m.id}:${decision.id ?? ''}:${decision.key}`, source: 'secondmate', id: d.id ?? m.id, title: decision.summary, project: m.id, ageSeconds,
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
        ageSeconds, prUrl: r.pr_url ?? null, sourceUrls: recordUrls(r), decisions: isHeld ? [holdDecision(r)] : [],
        blockers: { events: [], ids: blockerIds, reason: r.blocked_reason ?? null }, since: r.since ?? null,
        text: [r.body_excerpt].filter(Boolean),
        column: blockerIds.length ? 'blocked' : decisionColumn(ageSeconds),
        badges: [isHeld ? 'Your call' : 'Not started'],
      });
      c.resolve = resolveSteps(c, null);
      out.push(c);
    });

    finishedRecords(snapshot).slice(0, recentLimit).forEach((f) => out.push(card({
      key: `done:${f.home ?? ''}:${f.id}`, source: 'finished', id: f.id, title: f.title, project: f.project ?? NO_PROJECT,
      prUrl: /^https?:/.test(f.url ?? '') ? f.url : null, sourceUrls: f.sourceUrls, date: f.date, column: 'done', resolve: [],
      text: [f.home && `Finished via ${f.home}`, f.url && !/^https?:/.test(f.url) && f.url].filter(Boolean),
      badges: [f.verb === 'merged' ? 'Merged' : f.verb ? 'Finished' : null].filter(Boolean),
    })));
    return out;
  };

  const queuedCard = (r) => card({
    key: `queued:${r.id}`, source: 'queued', id: r.id, title: r.title ?? r.id, project: r.repo ?? NO_PROJECT, column: 'queued', resolve: [], sourceUrls: recordUrls(r),
    since: r.since ?? null, text: [r.hold_reason && `On hold: ${r.hold_reason}`, r.body_excerpt].filter(Boolean), badges: ['Not started'],
  });

  // Every card any page can show, by key: the board's cards plus all finished work
  // and every queued row. The detail drawer resolves links through this, so a card
  // listed outside the board's recent window still opens.
  const cardRegistry = (snapshot) => {
    const registry = new Map(cards(snapshot, { recentLimit: Infinity }).map((c) => [c.key, c]));
    const shown = new Set([...registry.values()].map((c) => c.id));
    (snapshot.backlog?.records ?? []).filter((r) => r.state === 'queued' && !shown.has(r.id)).forEach((r) => registry.set(`queued:${r.id}`, queuedCard(r)));
    return registry;
  };

  // Whether the page may cancel a backlog item, and how. Only an item no worker or
  // PR watch holds: a captain hold closes through fm-captain-hold.sh so the reason
  // is recorded as the captain's answer; a plain queued item closes through tasks-axi.
  // The server runs this same check against its own snapshot before acting.
  const cancelPlan = (snapshot, id) => {
    const record = (snapshot?.backlog?.records ?? []).find((r) => r.id != null && r.id === id);
    if (!record) return { refusal: "it is not in this home's backlog", isUnknown: true };
    if (record.state === 'done') return { refusal: 'it is already finished' };
    if ((snapshot.tasks ?? []).some((t) => t.id === id)) return { refusal: 'a worker is on it; ask firstmate to stop it instead' };
    if (record.pr_url) return { refusal: 'it has a pull request that firstmate is watching' };
    if (record.hold_bucket) return { kind: 'decision', effect: 'Records your reason as the answer and closes the decision. Nothing else runs.' };
    if (record.state === 'queued') return { kind: 'queued', effect: 'Moves the task to Done without starting it, with your reason in its note.' };
    return { refusal: 'it is in flight' };
  };
  // Cards the page offers Cancel on; every other card belongs to live work or another home.
  const isCancellable = (snapshot, c) => (c.source === 'hold' || c.source === 'queued') && Boolean(cancelPlan(snapshot, c.id).kind);

  const CANCEL_REASONS = [['outdated', 'Outdated'], ['handled', 'Already handled'], ['other', 'Other']];
  const CANCEL_NOTE_MAX = 200;
  // The recorded reason: a fixed phrase plus at most a short one-line note.
  const cancelReason = ({ reason, note = '' } = {}) => {
    const label = CANCEL_REASONS.find(([key]) => key === reason)?.[1];
    if (!label) return { error: 'choose a reason: Outdated, Already handled, or Other' };
    if (typeof note !== 'string') return { error: 'the note must be text' };
    const clean = note.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
    if (clean.length > CANCEL_NOTE_MAX) return { error: `keep the note to ${CANCEL_NOTE_MAX} characters` };
    if (reason === 'other' && !clean) return { error: 'add a short note saying why' };
    return { reason, note: clean, text: `Cancelled from the dashboard: ${label.toLowerCase()}${clean ? `. Note: ${clean}` : ''}` };
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
    const registry = [...cardRegistry(snapshot).values()];
    const queuedIds = new Set((snapshot.backlog?.records ?? []).filter((r) => r.state === 'queued').map((r) => r.id));
    const views = {
      group: () => [GROUPS.find((g) => g.key === arg)?.label ?? arg, all.filter((c) => groupOf(c) === arg)],
      age: () => [`Waiting ${AGE_BUCKETS.find((b) => b.key === arg)?.label.toLowerCase() ?? arg}`,
        all.filter((c) => WAITING.has(c.column) && ageBucketOf(c.ageSeconds) === arg)],
      queued: () => ['Queued, not started', registry.filter((c) => c.source !== 'finished' && c.source !== 'secondmate' && queuedIds.has(c.id))],
      'done-today': () => ['Finished today', registry.filter((c) => c.source === 'finished' && c.date === today)],
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
    // The raw command and age go back with a stop request so the server can spot a reused pid.
    orphans: r.orphans.map((o) => ({
      pid: String(o.pid), ppid: o.ppid ?? null, command: o.command, memory: bytes(o.rssBytes), age: duration(o.ageSeconds), ageSeconds: o.ageSeconds,
      isYours: r.uid == null || o.uid == null || o.uid === r.uid,
    })),
  });

  // What a page can show right now. Only the Machine page works without a fleet
  // snapshot, because it reads the machine directly; the rest wait for the snapshot.
  const viewFor = (page, { hasSnapshot }) => (page === 'machine' || page === 'radar' || hasSnapshot ? page : 'waiting');

  // The Machine page's line before its first reading arrives.
  const machineStatus = ({ resources, error }) => (resources ? null
    : error ? `The machine check is failing: ${error}. Retrying.` : 'Checking the machine…');

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

  // ---- chat radar ----
  // Slack and Teams are equal, independent sources, so both always get a status line in one fixed order.
  const RADAR_SOURCES = [['slack', 'Slack'], ['teams', 'Teams']];
  const RADAR_KINDS = [['mention', 'Mentions'], ['dm', 'Direct messages'], ['group', 'Group chats'], ['thread', 'Thread replies'], ['channel', 'Channels'], ['new-channel', 'New channels']];
  const sourceLabel = (key) => RADAR_SOURCES.find(([k]) => k === key)?.[1] ?? key;
  const sourceBanner = (key, s) => {
    const name = sourceLabel(key);
    if (!s) return { source: key, name, tone: 'error', text: `${name} radar: no status in radar.json` };
    const asOf = s.readAt ? `last read ${s.ageSeconds == null ? 'at an unknown time' : ago(s.ageSeconds * 1000)}` : 'never read';
    if (s.health === 'unavailable') return { source: key, name, tone: 'error', text: `${name} radar failed: ${s.reason ?? 'no reason given'} (${asOf}; items shown are from then)` };
    if (s.isStale) return { source: key, name, tone: 'error', text: `${name} radar is out of date: ${asOf}, expected every ${s.maxAgeMinutes} min` };
    if (s.health === 'degraded') return { source: key, name, tone: 'warn', text: `${name} radar partly working: ${s.reason ?? 'no reason given'} (${asOf})` };
    return { source: key, name, tone: 'ok', text: `${name} radar ok, ${asOf}` };
  };

  // null means there is no radar.json, so the page shows nothing new at all.
  const radarView = (radar) => {
    if (!radar?.present) return null;
    if (radar.error) return { error: `Chat radar unreadable: ${radar.error}`, banners: [], groups: [], generated: '', count: 0 };
    const items = [...radar.items].sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity)).map((x) => ({
      ...x, sourceName: sourceLabel(x.source), age: x.ageSeconds == null ? '' : ago(x.ageSeconds * 1000),
    }));
    return {
      error: null,
      generated: `Radar written ${radar.ageSeconds == null ? 'at an unknown time' : ago(radar.ageSeconds * 1000)}`,
      banners: RADAR_SOURCES.map(([key]) => sourceBanner(key, radar.sources?.[key])),
      groups: RADAR_KINDS.map(([kind, label]) => ({ kind, label, items: items.filter((x) => x.kind === kind) })).filter((g) => g.items.length),
      count: items.length,
    };
  };

  // Task id -> the radar items that mention it, for the chat icon on task cards.
  const radarByTask = (view) => {
    const map = new Map();
    view?.groups.forEach((g) => g.items.forEach((x) => x.taskIds.forEach((id) => map.set(id, [...(map.get(id) ?? []), x]))));
    return map;
  };

  // '#radar' and '#/radar' both open the Radar tab; unknown hashes fall back to the board.
  const route = (hash) => {
    const [path, query = ''] = hash.slice(1).split('?');
    const [, page, ...rest] = path.split('/');
    if (page === 'card' && rest[0]) return { page: 'card', key: decodeURIComponent(rest.join('/')) };
    if (page === 'task' && rest[0]) return { page: 'card', key: `task:${decodeURIComponent(rest[0])}` };
    if (page === 'list' && rest.length) return { page, filter: rest.join('/') };
    if (page === 'machine' || page === 'charts' || page === 'radar') return { page };
    if (path === 'radar') return { page: 'radar' };
    return { page: 'board', column: rest[0] ?? null, params: new URLSearchParams(query) };
  };

  // The Radar tab's badge counts visible items; its warning dot shows even while another tab is open,
  // so a dead Slack or Teams login is never hidden behind the board.
  const radarTab = (radar) => {
    const v = radarView(radar);
    return {
      count: v?.count ?? 0,
      hasWarning: Boolean(v && (v.error || v.banners.some((b) => b.tone === 'error'))),
      isEmpty: !v || (!v.error && !v.count),
      emptyMessage: v ? 'Nothing new in Slack or Teams.' : 'No chat radar yet: nothing has written data/radar.json.',
    };
  };

  // Tab bar over the two main views; Charts and Machine stay plain links, so neither tab is selected there.
  const tabs = ({ page, snapshot, radar }) => {
    const rt = radarTab(radar);
    const needsYou = snapshot ? fleetCounts(snapshot).needsYou : null;
    return [
      { key: 'board', label: 'Board', href: '#/board', count: needsYou, hasWarning: false, isSelected: page === 'board',
        description: needsYou == null ? 'Board' : `Board, ${needsYou} need${needsYou === 1 ? 's' : ''} you` },
      { key: 'radar', label: 'Radar', href: '#radar', count: rt.count, hasWarning: rt.hasWarning, isSelected: page === 'radar',
        description: `Radar, ${rt.count} item${rt.count === 1 ? '' : 's'}${rt.hasWarning ? ', a chat source has a problem' : ''}` },
    ];
  };

  return {
    SCHEMA, COLUMNS, GROUPS, AGE_BUCKETS, AGING_AFTER, assertSchema, taskDetail, freshnessBanner, resourcesView,
    cards, cardRegistry, cancelPlan, isCancellable, cancelReason, CANCEL_REASONS, CANCEL_NOTE_MAX, workColumn, boardView, viewFor, machineStatus, projects, projectName, prNumber, fleetCounts, machineSample, stateBreakdown, projectBars, ageHistogram, listView, kpis,
    duration, localDate, isWebUrl, classifySource, sourceLinks, cardSources, RADAR_SOURCES, radarView, radarByTask, radarTab, tabs, route,
  };
});
