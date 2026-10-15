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
  const taskLink = (id, label) => el('a', { href: `#/task/${encodeURIComponent(id)}`, textContent: label || id });

  const stateCell = (t) => cell(text('span', t.state, { className: `state state-${t.state}` }), t.stateDetail ? el('div', { className: 'muted', textContent: t.stateDetail }) : '');
  const empty = (message) => text('p', message, { className: 'muted' });

  const renderBoard = () => {
    const { needsCaptain, inFlight, finished } = R.board(snapshot);
    const taskCount = inFlight.reduce((n, g) => n + g.tasks.length, 0);
    return [
      text('h2', `Needs the captain (${needsCaptain.length})`),
      needsCaptain.length ? el('ul', { className: 'asks' }, needsCaptain.map((a) => el('li', {},
        text('strong', a.label), ' ',
        a.taskId ? taskLink(a.taskId, a.title) : text('span', a.title),
        a.project ? text('span', ` · ${a.project}`, { className: 'muted' }) : '',
        a.prUrl ? el('div', {}, safeLink(a.prUrl)) : '',
        a.detail ? text('div', a.detail, { className: 'muted' }) : ''))) : empty('Nothing waiting on the captain.'),
      text('h2', `In flight (${taskCount})`),
      ...(inFlight.length ? inFlight.flatMap(({ project, tasks }) => [
        text('h3', `${project} (${tasks.length})`),
        table(['Task', 'State', 'Waiting on', 'PR'], tasks.map((t) => el('tr', { className: t.needsCaptain ? 'needs-captain' : '' },
          cell(taskLink(t.id, t.title), t.title ? text('div', t.id, { className: 'muted' }) : '', t.kind ? text('div', t.kind, { className: 'muted' }) : ''),
          stateCell(t), cell(t.waitsOn.map((w) => text('div', w))), cell(safeLink(t.prUrl))))),
      ]) : [empty('No work in flight.')]),
      text('h2', `Recently finished (${finished.length})`),
      finished.length ? table(['Finished', 'Task', 'Project', 'Link'], finished.map((f) => el('tr', {},
        cell([f.verb, f.date].filter(Boolean).join(' ')),
        cell(text('div', f.title), text('div', f.home ? `${f.id} · via ${f.home}` : f.id, { className: 'muted' })),
        cell(f.project ?? ''), cell(safeLink(f.url))))) : empty('Nothing finished recently.'),
    ];
  };

  const renderTask = (id) => {
    const t = R.taskDetail(snapshot, id, taskDetail?.id === id ? taskDetail : null);
    if (!t) return [text('h2', `Unknown task ${id}`), el('a', { href: '#/', textContent: 'Back to the board' })];
    const row = (k, v) => el('tr', {}, text('th', k), cell(v ?? ''));
    return [
      el('p', {}, el('a', { href: '#/', textContent: '← Board' })),
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
    return page === 'task' && arg ? { page, id: decodeURIComponent(arg) } : { page: 'board' };
  };

  const render = () => {
    if (!snapshot) return;
    const r = route();
    try {
      view.replaceChildren(...(r.page === 'task' ? renderTask(r.id) : renderBoard()));
      document.title = `Firstmate (${R.board(snapshot).needsCaptain.length} need you)`;
    } catch (e) {
      showBanner({ tone: 'error', text: e.message });
    }
  };

  const showBanner = ({ tone, text: message }) => {
    banner.hidden = tone === 'quiet';
    banner.className = `banner-${tone}`;
    banner.textContent = message;
    freshness.textContent = tone === 'quiet' ? message : '';
  };

  const getJson = async (url) => {
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok && !body.loading) throw new Error(body.error ?? `${url}: HTTP ${res.status}`);
    return [body, res];
  };

  // The page keeps whatever it last rendered; only a newer snapshot version replaces it.
  let version = null;
  const refresh = async () => {
    try {
      const [body, res] = await getJson('/api/snapshot');
      if (body.loading) return showBanner(R.freshnessBanner(body));
      const stale = res.headers.get('X-Snapshot-Stale');
      showBanner(R.freshnessBanner({
        fetchedAt: res.headers.get('X-Snapshot-Fetched-At'),
        stale: stale && decodeURIComponent(stale),
        refreshing: res.headers.has('X-Snapshot-Refreshing'),
      }));
      const r = route();
      const isNew = res.headers.get('X-Snapshot-Version') !== version;
      if (isNew) { snapshot = R.assertSchema(body); version = res.headers.get('X-Snapshot-Version'); }
      if (r.page === 'task') taskDetail = (await getJson(`/api/task/${encodeURIComponent(r.id)}`).catch(() => [null]))[0];
      if (isNew || r.page === 'task') render();
    } catch (e) {
      showBanner({ tone: 'error', text: snapshot ? `Lost contact with the web view server: ${e.message}` : e.message });
    }
  };

  window.addEventListener('hashchange', () => { taskDetail = null; render(); refresh(); });
  refresh();
  setInterval(refresh, 3000);
})();
