// DOM glue. Every fleet-derived string reaches the page through textContent only.
(function () {
  const R = window.FleetRender;
  const view = document.getElementById('view');
  const banner = document.getElementById('banner');
  const freshness = document.getElementById('freshness');
  let snapshot = null;
  let taskDetail = null;

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => { if (v != null) node[k] = v; });
    children.flat().forEach((c) => node.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return node;
  };
  const text = (tag, value, props) => el(tag, { ...props, textContent: value ?? '' });
  const safeLink = (url) => (/^https?:\/\//i.test(url ?? '')
    ? el('a', { href: url, textContent: url, rel: 'noreferrer noopener', target: '_blank' })
    : document.createTextNode(url ?? ''));
  const table = (headers, rows) => el('table', {},
    el('thead', {}, el('tr', {}, headers.map((h) => text('th', h)))),
    el('tbody', {}, rows));
  const cell = (...children) => el('td', {}, ...children);
  const taskLink = (id) => el('a', { href: `#/task/${encodeURIComponent(id)}`, textContent: id });

  const renderOverview = () => {
    const { tasks, secondmates } = R.fleetOverview(snapshot);
    return [
      text('h2', `Workers and tasks (${tasks.length})`),
      tasks.length ? table(['Task', 'Kind', 'Project', 'State', 'Waiting on', 'PR', 'Endpoint'], tasks.map((t) => el('tr', { className: t.needsCaptain ? 'needs-captain' : '' },
        cell(taskLink(t.id), t.title ? el('div', { className: 'muted', textContent: t.title }) : ''),
        cell(t.kind ?? ''), cell(t.project ?? ''),
        cell(text('span', t.state, { className: `state state-${t.state}` }), t.stateDetail ? el('div', { className: 'muted', textContent: t.stateDetail }) : ''),
        cell(t.waitsOn.map((w) => text('div', w))),
        cell(safeLink(t.prUrl)),
        cell(`${t.endpointExists === null ? '?' : t.endpointExists ? 'present' : 'missing'}${t.agentAlive && t.agentAlive !== 'not_checked' ? ` / ${t.agentAlive}` : ''}`)))) : text('p', 'No live task metadata.', { className: 'muted' }),
      text('h2', `Secondmates (${secondmates.length})`),
      secondmates.length ? table(['Secondmate', 'State', 'Active', 'Decisions', 'Holds', 'Queued'], secondmates.map((m) => el('tr', {},
        cell(m.id), cell(m.state), cell(m.activeChildren), cell(m.decisionsOpen), cell(m.holds), cell(m.queued)))) : text('p', 'None registered.', { className: 'muted' }),
    ];
  };

  const renderDecisions = () => {
    const { items } = R.decisionsInbox(snapshot);
    return [
      text('h2', `Decisions inbox (${items.length})`),
      items.length ? table(['Task', 'Kind', 'Summary', 'Detail', 'Source'], items.map((d) => el('tr', {},
        cell(d.taskId ? taskLink(d.taskId) : d.id), cell(d.kind ?? ''), cell(d.summary ?? ''),
        cell([d.reason, d.holdUntil && `until ${d.holdUntil}`, d.ageDays != null && `${d.ageDays}d old`].filter(Boolean).join(' · ')),
        cell(d.source)))) : text('p', 'Nothing waiting on the captain.', { className: 'muted' }),
    ];
  };

  const renderTask = (id) => {
    const t = R.taskDetail(snapshot, id, taskDetail?.id === id ? taskDetail : null);
    if (!t) return [text('h2', `Unknown task ${id}`), el('a', { href: '#/', textContent: 'Back to fleet' })];
    const row = (k, v) => el('tr', {}, text('th', k), cell(v ?? ''));
    return [
      el('p', {}, el('a', { href: '#/', textContent: '← Fleet' })),
      text('h2', t.id),
      el('table', {},
        row('Title', t.title), row('Kind', t.kind), row('Project', t.project), row('Harness', t.harness),
        row('Current state', `${t.state}${t.stateSource ? ` (source: ${t.stateSource})` : ''}${t.stateDetail ? ` — ${t.stateDetail}` : ''}`),
        row('Waiting on', t.waitsOn.map((w) => text('div', w))),
        row('PR', safeLink(t.prUrl))),
      text('h3', 'Status history (past wake events, not current state)'),
      t.statusHistory.length ? text('pre', t.statusHistory.join('\n')) : text('p', 'No status events.', { className: 'muted' }),
      text('h3', `Inbox: ${t.inbox.pending.length} pending, ${t.inbox.handled.length} handled`),
      ...[['Pending', t.inbox.pending], ['Handled', t.inbox.handled]].filter(([, m]) => m.length)
        .flatMap(([label, msgs]) => [text('h4', label), ...msgs.map((m) => el('div', {}, text('strong', m.name), text('pre', m.text)))]),
    ];
  };

  const route = () => {
    const [, page, arg] = location.hash.slice(1).split('/');
    return page === 'decisions' ? { page } : page === 'task' && arg ? { page, id: decodeURIComponent(arg) } : { page: 'overview' };
  };

  const render = () => {
    document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('muted', a.dataset.route !== route().page));
    if (!snapshot) return;
    const r = route();
    try {
      view.replaceChildren(...(r.page === 'decisions' ? renderDecisions() : r.page === 'task' ? renderTask(r.id) : renderOverview()));
      document.getElementById('decision-count').textContent = `(${R.decisionsInbox(snapshot).items.length})`;
    } catch (e) {
      showError(e.message);
    }
  };

  const showError = (message) => { banner.hidden = false; banner.textContent = message; };

  const getJson = async (url) => {
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `${url}: HTTP ${res.status}`);
    return [body, res];
  };

  const refresh = async () => {
    try {
      const [body, res] = await getJson('/api/snapshot');
      snapshot = R.assertSchema(body);
      const stale = res.headers.get('X-Snapshot-Stale');
      stale ? showError(`Showing stale data: ${decodeURIComponent(stale)}`) : (banner.hidden = true);
      freshness.textContent = `snapshot ${snapshot.generated} · fetched ${res.headers.get('X-Snapshot-Fetched-At')}`;
      const r = route();
      if (r.page === 'task') taskDetail = (await getJson(`/api/task/${encodeURIComponent(r.id)}`).catch(() => [null]))[0];
      render();
    } catch (e) {
      showError(e.message);
    }
  };

  window.addEventListener('hashchange', () => { taskDetail = null; render(); refresh(); });
  refresh();
  setInterval(refresh, 3000);
})();
