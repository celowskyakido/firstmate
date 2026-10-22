// DOM glue. Every fleet-derived string reaches the page through textContent only.
(function () {
  const R = window.FleetRender;
  const C = window.FleetCharts;
  const view = document.getElementById('view');
  const banner = document.getElementById('banner');
  const freshness = document.getElementById('freshness');
  const health = document.getElementById('health');
  const alertsBox = document.getElementById('alerts');
  const dialog = document.getElementById('detail');
  const detailBody = document.getElementById('detail-body');
  let snapshot = null;
  let allCards = [];
  // Every card any page can link to, so the drawer opens list-only and older finished cards too.
  let registry = new Map();
  let resources = null;
  let resourcesLine = '';
  let resourcesError = null;
  let snapshotNote = 'Loading the first snapshot (can take up to a minute).';
  let history = { fleet: [], machine: [] };
  let charts = [];
  const filters = { query: '', project: '' };
  // Private per-home link settings (the Jira base URL) from the server; empty until it answers.
  let linkConfig = {};

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (v == null) return;
      if (k === 'key') node.dataset.key = v;
      else if (k === 'aria') Object.entries(v).forEach(([a, val]) => node.setAttribute(`aria-${a}`, val));
      else node[k] = v;
    });
    children.flat(Infinity).forEach((c) => c != null && c !== '' && c !== false && node.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return node;
  };
  const text = (tag, value, props) => el(tag, { ...props, textContent: value ?? '' });
  const { isWebUrl } = R;
  const external = (url, label, className) => el('a', { href: url, textContent: label, rel: 'noreferrer noopener', target: '_blank', className });
  const empty = (message) => text('p', message, { className: 'muted empty' });
  const swatch = (group) => el('span', { className: `dot fill-${group}`, aria: { hidden: 'true' } });
  const ago = (seconds) => (seconds == null ? '' : `${R.duration(seconds)} ago`);
  const groupOf = (column) => R.COLUMNS.find((c) => c.key === column)?.group ?? 'done';
  const cardHref = (c) => `#/card/${encodeURIComponent(c.key)}`;

  // Charts draw at their container's measured width, after insertion and on resize.
  const chart = (className, draw) => {
    const node = el('div', { className: `chart ${className}` });
    charts.push({ node, draw });
    return node;
  };
  const drawCharts = () => {
    C.hideTip();
    charts = charts.filter((c) => c.node.isConnected);
    charts.forEach((c) => c.node.replaceChildren(c.draw(Math.max(200, Math.floor(c.node.clientWidth)))));
  };
  const numbersTable = (headers, rows) => el('details', { className: 'numbers', key: `table:${headers.join()}` },
    text('summary', 'Show the numbers'),
    el('table', {}, el('thead', {}, el('tr', {}, headers.map((h) => text('th', h)))),
      el('tbody', {}, rows.map((r) => el('tr', {}, r.map((v) => text('td', v)))))));
  const panel = (title, subtitle, ...body) => el('section', { className: 'panel' }, text('h3', title), subtitle ? text('p', subtitle, { className: 'subtitle' }) : '', ...body);

  // ---- KPI strip ----
  const kpiStrip = () => el('div', { className: 'kpis' }, R.kpis({
    counts: R.fleetCounts(snapshot), machine: resources && R.machineSample(resources), limits: resources?.limits, history,
  }).map((t) => el('a', { href: t.href, className: `kpi tone-${t.tone}`, key: `tile:${t.key}` },
    text('span', t.label, { className: 'kpi-label' }),
    el('span', { className: 'kpi-body' }, text('span', t.value, { className: 'kpi-value' }), C.sparkline(t.series, { width: 64, height: 24 })),
    text('span', t.note, { className: 'kpi-note' }))));

  // ---- cards ----
  // The card's PR badge already links the PR, so bare URLs are dropped from the one-line summary.
  const snippet = (c) => {
    const line = (c.decisions[0]?.summary ?? c.blockers.events[0]?.summary
      ?? (c.blockers.ids.length ? `Waiting on ${c.blockers.ids.join(', ')}` : c.stateDetail) ?? '').replace(/https?:\/\/\S+/g, '').trim();
    return line.length > 3 ? line : '';
  };
  const cardNode = (c) => el('article', { className: `card tone-${groupOf(c.column)}` },
    el('a', { href: cardHref(c), className: 'card-link', key: `card:${c.key}`, textContent: c.title }),
    snippet(c) && snippet(c) !== c.title ? text('p', snippet(c), { className: 'card-snippet' }) : '',
    el('div', { className: 'card-meta' },
      text('span', R.projectName(c.project), { className: 'chip' }),
      c.ageSeconds != null ? text('span', R.duration(c.ageSeconds), { className: `age${c.column === 'aging' ? ' age-old' : ''}`,
        title: c.decisions.length ? `Waiting on you for ${R.duration(c.ageSeconds)}` : `Last update ${ago(c.ageSeconds)}` }) : '',
      c.date ? text('span', c.date, { className: 'age' }) : '',
      R.cardSources(c, linkConfig).map((s) => external(s.url, s.label, s.kind === 'pr' ? 'pr-badge' : `source-badge source-${s.kind}`)),
      c.badges.map((b) => text('span', b, { className: 'badge' })),
      cancelButton(c, 'small'),
      chatBadge(c.taskId)));


  // ---- chat radar ----
  let radar = null;
  let radarJson = '';
  let radarByTask = new Map();
  const chatBadge = (taskId) => {
    const items = radarByTask.get(taskId);
    return items?.length ? el('a', { href: '#radar', className: 'source-badge chat-badge', title: items.map((x) => `${x.sourceName}: ${x.title}`).join('\n'),
      aria: { label: `${items.length} chat item${items.length === 1 ? '' : 's'} about this task` } }, text('span', '💬', { aria: { hidden: 'true' } }), ` ${items.length}`) : '';
  };
  const sourceIcon = (x) => text('span', x.sourceName, { className: `source source-${x.source}` });

  const chooseRadar = async (x, action, span) => {
    try {
      const res = await fetch(`/api/radar/${encodeURIComponent(x.id)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webview-Token': token }, body: JSON.stringify(span ? { for: span } : {}),
      });
      const body = await res.json().catch(() => ({ reason: `HTTP ${res.status}` }));
      if (!res.ok) return showToast(`Could not ${action} ${x.title}: ${body.reason ?? res.status}.`, 'error');
      showToast(action === 'dismiss' ? `Dismissed ${x.title}.` : `Snoozed ${x.title} for ${span}.`, 'ok');
      refreshRadar();
    } catch (e) {
      showToast(`Could not reach the web view server: ${e.message}`, 'error');
    }
  };

  const radarRow = (x) => el('li', { className: 'radar-item' },
    sourceIcon(x),
    el('div', { className: 'radar-text' }, text('strong', x.title), text('span', x.why, { className: 'muted' })),
    text('span', x.age, { className: 'age' }),
    el('span', { className: 'radar-actions' },
      x.link ? external(x.link, 'Open', 'open') : '',
      el('button', { type: 'button', className: 'small', textContent: 'Dismiss', key: `radar:${x.id}:dismiss`, aria: { label: `Dismiss ${x.title}` }, onclick: () => chooseRadar(x, 'dismiss') }),
      ['4h', '1d'].map((span) => el('button', { type: 'button', className: 'small', textContent: `Snooze ${span}`, key: `radar:${x.id}:${span}`,
        aria: { label: `Snooze ${x.title} for ${span}` }, onclick: () => chooseRadar(x, 'snooze', span) }))));

  const radarPanel = () => {
    const v = R.radarView(radar);
    if (!v) return empty(R.radarTab(radar).emptyMessage);
    return el('section', { className: 'panel radar', id: 'radar', aria: { label: 'Chat radar' } },
      el('div', { className: 'panel-head' }, text('h3', `Chat radar (${v.count})`), text('span', v.generated, { className: 'muted' })),
      v.error ? text('p', v.error, { className: 'problem', role: 'alert' }) : '',
      el('ul', { className: 'radar-sources' }, v.banners.map((b) => text('li', b.text, { className: `radar-source tone-${b.tone}` }))),
      v.groups.map((g) => el('div', { className: 'radar-group' }, text('h4', `${g.label} (${g.items.length})`), el('ul', {}, g.items.map(radarRow)))),
      !v.error && !v.count ? empty('Nothing new in Slack or Teams.') : '');
  };

  const radarNode = el('div', { className: 'radar-page' });
  const radarPage = () => (radar ? radarPanel() : text('p', 'Loading the chat radar…', { className: 'muted' }));

  // ---- tabs: Board and Radar, built once so focus survives every refresh ----
  const tabsBox = document.getElementById('tabs');
  const tabNodes = new Map();
  const tabParts = (key) => {
    if (!tabNodes.has(key)) {
      const node = el('a', { role: 'tab', id: `tab-${key}`, className: 'tab', key: `tab:${key}` });
      const label = el('span', {});
      const count = el('span', { className: 'tab-count' });
      const warn = el('span', { className: 'tab-warn', aria: { hidden: 'true' } });
      node.append(label, count, warn);
      tabNodes.set(key, { node, label, count, warn });
      tabsBox.append(node);
    }
    return tabNodes.get(key);
  };
  const renderTabs = () => {
    const list = R.tabs({ page: route(baseHash).page, snapshot, radar, agents: agentsOverview });
    list.forEach((t, i) => {
      const { node, label, count, warn } = tabParts(t.key);
      node.href = t.href;
      node.setAttribute('aria-selected', String(t.isSelected));
      node.setAttribute('aria-label', t.description);
      node.tabIndex = t.isSelected || (!list.some((x) => x.isSelected) && !i) ? 0 : -1;
      label.textContent = t.label;
      count.textContent = t.count == null ? '' : String(t.count);
      count.hidden = t.count == null;
      warn.hidden = !t.hasWarning;
    });
  };
  tabsBox.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    const keys = ['Home', 'End'];
    if (!step && !keys.includes(e.key)) return;
    const nodes = [...tabNodes.values()].map((t) => t.node);
    const at = nodes.indexOf(document.activeElement);
    const next = nodes[e.key === 'Home' ? 0 : e.key === 'End' ? nodes.length - 1 : (Math.max(at, 0) + step + nodes.length) % nodes.length];
    e.preventDefault();
    next.focus();
    location.hash = next.getAttribute('href');
  });

  const refreshRadar = async () => {
    try {
      const [body] = await getJson('/api/radar');
      if (JSON.stringify(body) === radarJson) return;
      radarJson = JSON.stringify(body);
      radar = body;
    } catch (e) {
      radar = { present: true, error: `could not reach the web view server: ${e.message}` };
      radarJson = '';
    }
    radarByTask = R.radarByTask(R.radarView(radar));
    renderTabs();
    if (view.contains(boardNode)) renderBoardColumns();
    else if (view.contains(radarNode)) radarNode.replaceChildren(radarPage());
  };

  // ---- board ----
  let baseHash = '#/board';
  const boardNode = el('div', { className: 'board', aria: { label: 'Work board' } });
  const kpiSlot = el('div', {});
  let renderBoardColumns = () => {};

  // The toolbar is built once and never replaced, so typing keeps its focus and caret.
  const toolbar = (() => {
    const search = el('input', { type: 'search', placeholder: 'Search tasks', className: 'search', key: 'search', aria: { label: 'Search tasks' } });
    const project = el('select', { className: 'project-filter', key: 'project', aria: { label: 'Filter by project' } });
    const status = el('span', { className: 'muted filter-status', aria: { live: 'polite' } });
    const sync = () => {
      const params = new URLSearchParams();
      if (filters.query) params.set('q', filters.query);
      if (filters.project) params.set('project', filters.project);
      window.history.replaceState(null, '', `#/board${params.size ? `?${params}` : ''}`);
      baseHash = location.hash;
      renderBoardColumns();
    };
    search.addEventListener('input', () => { filters.query = search.value; sync(); });
    project.addEventListener('change', () => { filters.project = project.value; sync(); });
    const node = el('div', { className: 'toolbar' }, search, project, status,
      text('span', 'Press / to search, arrow keys to move between cards, Enter to open.', { className: 'muted hint' }));
    return {
      node, status,
      update: () => {
        if (search.value !== filters.query) search.value = filters.query;
        const options = [['', 'All projects'], ...R.projects(allCards).map((p) => [p.value, p.label])];
        if (filters.project && !options.some(([v]) => v === filters.project)) options.push([filters.project, R.projectName(filters.project)]);
        project.replaceChildren(...options.map(([value, label]) => el('option', { value, textContent: label })));
        project.value = filters.project;
      },
      focus: () => search.focus(),
    };
  })();

  renderBoardColumns = () => {
    const columns = R.boardView(allCards, filters);
    const shown = columns.reduce((n, c) => n + c.cards.length, 0);
    const total = columns.reduce((n, c) => n + c.total, 0);
    toolbar.status.textContent = filters.query || filters.project ? `Showing ${shown} of ${total}` : '';
    const focusKey = document.activeElement?.dataset?.key;
    boardNode.replaceChildren(...columns.map((col) => el('section', { className: `column tone-${col.group}`, id: `col-${col.key}`, aria: { labelledby: `col-${col.key}-title` } },
      el('h2', { className: 'column-head', id: `col-${col.key}-title`, tabIndex: -1 }, swatch(col.group), text('span', col.label),
        text('span', col.cards.length === col.total ? String(col.total) : `${col.cards.length} of ${col.total}`, { className: 'count' })),
      col.cards.length ? el('div', { className: 'column-cards' }, col.cards.map(cardNode))
        : empty(col.total ? 'No matches.' : 'Nothing here.'))));
    if (focusKey && !dialog.open) boardNode.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  };

  // Arrow keys walk the board like a grid: up and down within a column, left and right across.
  boardNode.addEventListener('keydown', (e) => {
    const link = e.target.closest?.('.card-link');
    if (!link || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const columns = [...boardNode.querySelectorAll('.column')].map((col) => [...col.querySelectorAll('.card-link')]);
    const x = columns.findIndex((links) => links.includes(link));
    const y = columns[x].indexOf(link);
    let target = e.key === 'ArrowUp' ? columns[x][y - 1] : e.key === 'ArrowDown' ? columns[x][y + 1] : null;
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    for (let i = x + step; step && i >= 0 && i < columns.length && !target; i += step) target = columns[i][Math.min(y, columns[i].length - 1)];
    if (target) { e.preventDefault(); target.focus(); target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || dialog.open || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || !view.contains(boardNode)) return;
    e.preventDefault();
    toolbar.focus();
  });

  const renderBoard = (columnKey) => {
    toolbar.update();
    kpiSlot.replaceChildren(kpiStrip());
    if (!view.contains(boardNode)) view.replaceChildren(kpiSlot, toolbar.node, boardNode);
    renderBoardColumns();
    if (columnKey) {
      const col = document.getElementById(`col-${columnKey}`);
      col?.scrollIntoView({ block: 'nearest', inline: 'center' });
      col?.querySelector('.column-head')?.focus({ preventScroll: true });
    }
  };

  // ---- charts page ----
  const legend = (segments) => el('ul', { className: 'legend' }, segments.map((g) => el('li', {},
    el('a', { href: g.href, key: `legend:${g.key}` }, el('span', { className: `swatch fill-${g.key}`, aria: { hidden: 'true' } }), text('span', g.label), text('strong', String(g.count))))));

  const machineTrends = () => {
    const series = (key, scale = 1) => history.machine.map((p) => ({ t: p.t, v: p[key] == null ? null : p[key] * scale }));
    const cores = resources?.load?.cores;
    const whole = (v) => String(Math.round(v));
    const specs = [
      ['Load average', series('load'), { format: (v) => v.toFixed(1), reference: cores ? { value: cores, label: `${cores} cores` } : null }],
      ['Memory in use', series('memoryInUse', 100), { format: (v) => `${Math.round(v)}%` }],
      ['Claude sessions', series('sessions'), { format: whole, isInteger: true }],
      ['MCP helper processes', series('helpers'), { format: whole, isInteger: true }],
    ];
    const minutes = Math.round((history.machine.length > 1 ? history.machine[history.machine.length - 1].t - history.machine[0].t : 0) / 60000);
    return panel('Machine trends', `Last ${minutes ? `${minutes} min` : 'few seconds'} while this page's server has been running, up to 3 hours.`,
      el('div', { className: 'multiples' }, specs.map(([title, points, opts]) => el('figure', {},
        text('figcaption', title), chart('trend', (width) => C.lineChart(points, { width, title, ...opts }))))),
      numbersTable(['Time', ...specs.map(([t]) => t)], history.machine.slice(-12).reverse().map((p) => [
        new Date(p.t).toLocaleTimeString(), p.load?.toFixed(1) ?? 'n/a', p.memoryInUse == null ? 'n/a' : `${Math.round(p.memoryInUse * 100)}%`,
        p.sessions == null ? 'n/a' : String(Math.round(p.sessions)), p.helpers == null ? 'n/a' : String(Math.round(p.helpers))])));
  };

  const renderCharts = () => {
    const breakdown = R.stateBreakdown(snapshot);
    const projects = R.projectBars(snapshot);
    const ages = R.ageHistogram(snapshot);
    const total = breakdown.reduce((n, b) => n + b.count, 0);
    return [
      text('h2', 'Charts', { className: 'page-title' }),
      panel('Everything on the board', `${total} cards by state. Select a segment to list them.`,
        chart('strip-chart', (width) => C.stateStrip(breakdown, width)), legend(breakdown)),
      el('div', { className: 'grid-2' },
        panel('Open work by project', 'Cards per project, coloured by state. Select a project to filter the board.',
          projects.length ? chart('bars', (width) => C.projectChart(projects, width)) : empty('No open work.'),
          numbersTable(['Project', 'Cards', ...R.GROUPS.filter((g) => g.key !== 'done').map((g) => g.label)], projects.map((p) => [p.project, String(p.total), ...p.segments.map((g) => String(g.count))]))),
        panel('How long items have waited', `Decisions, blocked work, and PRs by time since their last update.${ages.unknownAge ? ` ${ages.unknownAge} item${ages.unknownAge === 1 ? ' has' : 's have'} no known age and ${ages.unknownAge === 1 ? 'is' : 'are'} left out.` : ''}`,
          chart('columns', (width) => C.columnChart(ages.bins, width)),
          numbersTable(['Waiting', 'Items'], ages.bins.map((b) => [b.label, String(b.count)])))),
      machineTrends(),
    ];
  };

  const backLink = () => el('p', { className: 'back' }, el('a', { href: '#/board', textContent: 'Back to the board', key: 'back' }));

  const renderList = (filter) => {
    const found = R.listView(snapshot, filter);
    if (!found) return [backLink(), text('h2', 'Nothing to show for this link', { className: 'page-title' })];
    const list = { ...found, cards: found.cards.filter((c) => !isHidden(c)) };
    return [backLink(), text('h2', `${list.title} (${list.cards.length})`, { className: 'page-title' }),
      list.cards.length ? el('div', { className: 'card-grid' }, list.cards.map(cardNode)) : empty('Nothing here right now.')];
  };

  const renderMachine = () => {
    if (!resources) return [text('h2', 'Machine', { className: 'page-title' }), empty(R.machineStatus({ resources, error: resourcesError }))];
    const v = R.resourcesView(resources);
    const plain = (headers, rows) => el('table', {}, el('thead', {}, el('tr', {}, headers.map((h) => text('th', h)))),
      el('tbody', {}, rows.map((r) => el('tr', {}, r.map(([value, cls]) => text('td', value, { className: cls }))))));
    return [text('h2', 'Machine', { className: 'page-title' }), text('p', resourcesLine, { className: 'muted' }),
      el('section', { className: 'panel' }, el('table', {}, v.machine.map(([k, val]) => el('tr', {}, text('th', k), text('td', val, { className: 'num' }))))),
      machineTrends(),
      panel(`Claude sessions (${v.sessions.length})`, 'Largest first, including their helper processes.',
        v.sessions.length ? plain(['Session', 'Memory', 'Processes', 'MCP helpers', 'Age'], v.sessions.map((x) => [[x.name], [x.memory, 'num'], [x.processes, 'num'], [x.mcpHelpers, 'num'], [x.age, 'num']])) : empty('No Claude sessions.')),
      strayPanel(v.orphans)];
  };

  // ---- stopping stray helpers: the page's only write, guarded again on the server ----
  const token = document.querySelector('meta[name="webview-token"]')?.content ?? '';
  const confirmBox = document.getElementById('confirm');
  const toast = document.getElementById('toast');
  const strays = { busy: new Set(), gone: new Set(), problem: '' };
  const strayKey = (o) => `${o.pid}:${o.command}`;
  const OUTCOME = { terminated: 'stopped', killed: 'force-stopped after it ignored the stop request', 'already-gone': 'was already gone' };

  const showToast = (message, tone) => {
    toast.textContent = message;
    toast.className = `toast toast-${tone}`;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 8000);
  };

  const confirmStop = (list) => new Promise((resolve) => {
    const row = (k, v) => el('div', {}, text('dt', k), text('dd', v));
    const cancel = el('button', { type: 'button', className: 'close', textContent: 'Cancel', onclick: () => confirmBox.close('cancel') });
    confirmBox.replaceChildren(
      text('h2', list.length === 1 ? `Stop stray helper ${list[0].pid}?` : `Stop all ${list.length} stray helpers?`, { id: 'confirm-title' }),
      text('p', 'Each one gets a stop request, then a force stop if it is still running 3 seconds later. The server checks each one again first and refuses anything that is no longer a stray.', { className: 'muted' }),
      el('div', { className: 'confirm-list' }, list.map((o) => el('dl', { className: 'confirm-item' },
        row('PID', o.pid), row('Age', o.age), row('Parent', o.ppid === 1 ? 'none (adopted by init, pid 1)' : String(o.ppid)), row('Memory', o.memory),
        row('Command', o.command.length > 140 ? `${o.command.slice(0, 139)}…` : o.command)))),
      el('div', { className: 'confirm-actions' }, cancel,
        el('button', { type: 'button', className: 'danger', textContent: list.length === 1 ? 'Stop it' : `Stop all ${list.length}`, onclick: () => confirmBox.close('stop') })));
    confirmBox.returnValue = '';
    confirmBox.addEventListener('close', () => resolve(confirmBox.returnValue === 'stop'), { once: true });
    confirmBox.showModal();
    cancel.focus();
  });

  const stopOne = async (o) => {
    try {
      const res = await fetch(`/api/stray-helpers/${encodeURIComponent(o.pid)}/kill`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webview-Token': token },
        body: JSON.stringify({ command: o.command, ageSeconds: o.ageSeconds }),
      });
      return await res.json().catch(() => ({ outcome: 'failed', reason: `HTTP ${res.status}` }));
    } catch (e) {
      return { outcome: 'failed', reason: `could not reach the web view server: ${e.message}` };
    }
  };

  const stopStrays = async (list) => {
    if (!list.length || !(await confirmStop(list))) return;
    list.forEach((o) => strays.busy.add(strayKey(o)));
    strays.problem = '';
    renderBase();
    const failures = [];
    for (const o of list) {
      const result = await stopOne(o);
      strays.busy.delete(strayKey(o));
      if (OUTCOME[result.outcome]) strays.gone.add(strayKey(o));
      else failures.push(`${o.pid}: ${result.reason ?? result.outcome}`);
      if (list.length === 1) {
        showToast(OUTCOME[result.outcome] ? `Stray helper ${o.pid} ${OUTCOME[result.outcome]}.` : `Did not stop ${o.pid}: ${result.reason ?? result.outcome}.`, OUTCOME[result.outcome] ? 'ok' : 'error');
      }
      renderBase();
    }
    if (list.length > 1) {
      showToast(`Stopped ${list.length - failures.length} of ${list.length} stray helpers.${failures.length ? ` Not stopped: ${failures.join('; ')}.` : ''}`, failures.length ? 'error' : 'ok');
    }
    strays.problem = failures.length ? `Not stopped: ${failures.join('; ')}.` : '';
    renderBase();
  };

  const strayPanel = (orphans) => {
    // A pid stays hidden after a stop until the next reading drops it.
    strays.gone.forEach((k) => { if (!orphans.some((o) => strayKey(o) === k)) strays.gone.delete(k); });
    const shown = orphans.filter((o) => !strays.gone.has(strayKey(o)));
    const stoppable = shown.filter((o) => o.isYours && !strays.busy.has(strayKey(o)));
    return el('section', { className: 'panel' },
      el('div', { className: 'panel-head' }, text('h3', `Stray helpers (${shown.length})`),
        shown.length ? el('button', { type: 'button', className: 'danger', textContent: 'Kill all strays', key: 'stray:all', disabled: !stoppable.length || strays.busy.size > 0,
          onclick: () => stopStrays(stoppable) }) : ''),
      text('p', 'Helper processes older than an hour whose parent has exited. Stopping one sends it a stop request, then a force stop after 3 seconds.', { className: 'subtitle' }),
      strays.problem ? text('p', strays.problem, { className: 'problem', role: 'alert' }) : '',
      shown.length ? el('table', { className: 'strays' }, el('thead', {}, el('tr', {}, ['PID', 'Command', 'Memory', 'Age', ''].map((h) => text('th', h)))),
        el('tbody', {}, shown.map((o) => el('tr', {},
          text('td', o.pid, { className: 'num' }), text('td', o.command, { className: 'command' }), text('td', o.memory, { className: 'num' }), text('td', o.age, { className: 'num' }),
          el('td', {}, o.isYours
            ? el('button', { type: 'button', className: 'danger small', key: `stray:${strayKey(o)}`, textContent: strays.busy.has(strayKey(o)) ? 'Stopping…' : 'Kill',
              disabled: strays.busy.size > 0, aria: { label: `Kill stray helper ${o.pid}` }, onclick: () => stopStrays([o]) })
            : text('span', "Another user's", { className: 'muted' })))))) : empty('None.'));
  };

  // ---- cancelling a held decision or queued task: guarded again on the server ----
  // An id stays hidden after a cancel until a snapshot no longer offers it.
  const cancelled = new Set();
  let isCancelBusy = false;
  const isHidden = (c) => cancelled.has(c.id) && (c.source === 'hold' || c.source === 'queued');
  const pruneCancelled = () => cancelled.forEach((id) => { if (!R.cancelPlan(snapshot, id).kind) cancelled.delete(id); });
  const hideCancelled = () => {
    allCards = allCards.filter((c) => !isHidden(c));
    registry = new Map([...registry].filter(([, c]) => !isHidden(c)));
  };

  // One dialog for every "say why" or "pick a day" confirmation, single or in bulk.
  // It resolves with the validated choice, or null when the captain keeps things as they are.
  const confirmChoice = ({ heading, intro, titles = [], mode, yes, no = 'Keep it', legend = 'Why cancel it?' }) => new Promise((resolve) => {
    let choice = null;
    const problem = el('p', { className: 'problem', role: 'alert', hidden: true });
    const shown = titles.slice(0, 10);
    const list = titles.length > 1 ? el('ul', { className: 'confirm-titles' }, shown.map((t) => text('li', t)),
      titles.length > shown.length ? text('li', `and ${titles.length - shown.length} more`, { className: 'muted' }) : '') : '';
    const note = el('input', { type: 'text', maxLength: R.CANCEL_NOTE_MAX, className: 'note', id: 'cancel-note' });
    const date = el('input', { type: 'date', className: 'note', id: 'defer-date', min: R.localDate(new Date(Date.now() + DAY_MS)), max: R.localDate(new Date(Date.now() + R.DEFER_MAX_DAYS * DAY_MS)) });
    const radios = R.CANCEL_REASONS.map(([value, label]) => el('label', { className: 'reason' },
      el('input', { type: 'radio', name: 'cancel-reason', value }), text('span', label)));
    const controls = mode === 'date'
      ? [el('label', { className: 'note-label', htmlFor: 'defer-date' }, legend), date, deferQuickPicks((value) => { date.value = value; })]
      : [el('fieldset', { className: 'reasons' }, text('legend', legend), radios),
        el('label', { className: 'note-label', htmlFor: 'cancel-note' }, `Short note (required for Other, up to ${R.CANCEL_NOTE_MAX} characters)`), note];
    const keep = el('button', { type: 'button', className: 'close', textContent: no, onclick: () => confirmBox.close() });
    const submit = () => {
      const picked = mode === 'date' ? R.deferDate(date.value)
        : R.cancelReason({ reason: confirmBox.querySelector('input[name="cancel-reason"]:checked')?.value, note: note.value });
      if (picked.error) {
        problem.textContent = `Cannot continue yet: ${picked.error}.`;
        problem.hidden = false;
        return;
      }
      choice = mode === 'date' ? { until: picked.until } : { reason: picked.reason, note: picked.note };
      confirmBox.close();
    };
    confirmBox.replaceChildren(text('h2', heading, { id: 'confirm-title' }), text('p', intro, { className: 'muted' }), list, ...controls, problem,
      el('div', { className: 'confirm-actions' }, keep, el('button', { type: 'button', className: 'danger', textContent: yes, onclick: submit })));
    confirmBox.addEventListener('close', () => resolve(choice), { once: true });
    confirmBox.showModal();
    (mode === 'date' ? date : radios[0].querySelector('input')).focus();
  });
  const confirmCancel = (c, plan) => confirmChoice({
    heading: `Cancel "${c.title}"?`, intro: `${plan.effect} Use this for an item that is outdated or already handled.`, mode: 'reason', yes: 'Cancel it',
  });

  const postJson = async (route, body) => {
    try {
      const res = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webview-Token': token }, body: JSON.stringify(body) });
      return await res.json().catch(() => ({ outcome: 'failed', reason: `HTTP ${res.status}` }));
    } catch (e) {
      return { outcome: 'failed', reason: `could not reach the web view server: ${e.message}` };
    }
  };
  const postCancel = (body) => postJson('/api/cancel', body);

  const cancelCard = async (c) => {
    const plan = R.cancelPlan(snapshot, c.id);
    const choice = plan.kind && await confirmCancel(c, plan);
    if (!choice) return;
    isCancelBusy = true;
    renderBase();
    const result = await postCancel({ id: c.id, ...choice });
    isCancelBusy = false;
    if (result.outcome === 'cancelled') {
      cancelled.add(c.id);
      hideCancelled();
      showToast(`Cancelled "${c.title}". It leaves the board for good on the next refresh.`, 'ok');
      if (route().page === 'card') dialog.close();
    } else {
      showToast(`Did not cancel "${c.title}": ${result.reason ?? result.outcome}.${result.output ? ` ${result.output}` : ''}`, 'error');
    }
    renderBase();
  };

  const cancelButton = (c, size = '') => (snapshot && R.isCancellable(snapshot, c)
    ? el('button', { type: 'button', className: `danger ${size}`.trim(), textContent: 'Cancel', key: `cancel:${size}:${c.key}`, disabled: isCancelBusy,
      aria: { label: `Cancel ${c.title}` }, onclick: () => cancelCard(c) })
    : '');

  // ---- decisions tab: answer, defer, or close, one at a time or in bulk; every request is guarded again on the server ----
  const DAY_MS = 86400 * 1000;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const deferQuickPicks = (setDate) => el('div', { className: 'quick-picks' },
    [['Tomorrow', 1], ['In a week', 7], ['In a month', 30]].map(([label, days]) => el('button', { type: 'button', className: 'small', textContent: label,
      onclick: () => setDate(R.localDate(new Date(Date.now() + days * DAY_MS))) })));

  const decisionRows = new Map();
  const groupHeads = new Map();
  const selected = new Set();
  // ref -> { tone, text, isDone, at }: the inline result under each decision.
  const outcomes = new Map();
  // What this page did, newest first. Kept until the page is reloaded; an undo works while the server keeps running.
  const recent = [];
  let isDecisionBusy = false;
  let recentId = 0;

  const decisionsNode = el('div', { className: 'decisions-page' });
  const decisionsTitle = text('h2', 'Decisions', { className: 'page-title' });
  const decisionsNote = text('p', '', { className: 'muted' });
  const selectAll = el('input', { type: 'checkbox', name: 'select-all', id: 'select-all', key: 'select-all' });
  const selectedCount = text('span', '', { className: 'muted', aria: { live: 'polite' } });
  const bulkSettle = el('button', { type: 'button', className: 'danger small', key: 'bulk-settle', textContent: 'Close as settled…', onclick: () => bulkRun('settle') });
  const bulkDefer = el('button', { type: 'button', className: 'small', key: 'bulk-defer', textContent: 'Defer…', onclick: () => bulkRun('defer') });
  const bulkBar = el('div', { className: 'bulk-bar', role: 'group', aria: { label: 'Act on several decisions' } },
    el('label', { className: 'select-all' }, selectAll, ' Select all'), selectedCount, bulkSettle, bulkDefer);
  const recentBox = el('section', { className: 'panel recent', hidden: true, aria: { label: 'Recent actions' } });
  const decisionList = el('div', { className: 'decision-list' });
  decisionsNode.append(decisionsTitle, decisionsNote, bulkBar, recentBox, decisionList);

  const addRecent = (entry) => {
    recent.unshift({ id: ++recentId, refs: [], ...entry });
    recent.length = Math.min(recent.length, 30);
  };
  // Records the inline result for one decision and the line in Recent actions.
  const settleOutcome = (item, action, result) => {
    const line = R.resultLine(action, result, item);
    outcomes.set(item.ref, { ...line, isDone: line.tone === 'ok', at: Date.now() });
    if (line.tone === 'ok') selected.delete(item.ref);
    return line;
  };
  const runBusy = async (work, pendingItems = []) => {
    pendingItems.forEach((i) => outcomes.set(i.ref, { tone: 'info', text: 'Working… this can take several seconds.' }));
    isDecisionBusy = true;
    renderDecisions();
    try { return await work(); } finally { isDecisionBusy = false; renderDecisions(); }
  };
  const currentItems = () => R.decisionItems(snapshot).items;

  const answerRow = (row) => runBusy(async () => {
    const { item } = row;
    const body = { action: 'answer', ref: item.ref, ...(row.option ? { option: row.option } : { text: row.text.value }), ...(item.needsMode ? { mode: row.mode.value } : {}) };
    const line = settleOutcome(item, 'answer', await postJson('/api/decisions/act', body));
    addRecent({ tone: line.tone, text: `${item.title}: ${line.text}` });
  }, [row.item]);
  const deferRow = (row) => runBusy(async () => {
    const { item } = row;
    const date = R.deferDate(row.date.value);
    if (date.error) { outcomes.set(item.ref, { tone: 'error', text: `Could not defer: ${date.error}.` }); return; }
    const line = settleOutcome(item, 'defer', await postJson('/api/decisions/act', { action: 'defer', ref: item.ref, until: date.until }));
    addRecent({ tone: line.tone, text: `${item.title}: ${line.text}`, refs: line.tone === 'ok' ? [item.ref] : [] });
  }, [row.item]);
  const settleRow = async (row) => {
    const { item } = row;
    const choice = await confirmChoice({ heading: `Close "${item.title}" as settled?`, intro: R.effectOf(item, 'settle'), mode: 'reason', yes: 'Close it', legend: 'Why is it settled?' });
    if (!choice) return;
    await runBusy(async () => {
      const line = settleOutcome(item, 'settle', await postJson('/api/decisions/act', { action: 'settle', ref: item.ref, ...choice }));
      addRecent({ tone: line.tone, text: `${item.title}: ${line.text}` });
    }, [item]);
  };

  const BULK_WORDS = {
    settle: { heading: (n) => `Close ${plural(n, 'decision')} as settled?`, yes: (n) => `Close ${n}`, legend: 'Why are they settled?', mode: 'reason', cannot: 'closed', done: 'Closed',
      effect: 'Closes them as settled, with your reason recorded on each. This cannot be undone from here.' },
    defer: { heading: (n) => `Defer ${plural(n, 'decision')}?`, yes: (n) => `Defer ${n}`, legend: 'Defer them until', mode: 'date', cannot: 'deferred', done: 'Deferred',
      effect: 'Hides them until the day you pick. You can undo it from Recent actions.' },
  };
  const bulkRun = async (action) => {
    const items = currentItems().filter((i) => selected.has(i.ref));
    const eligible = items.filter((i) => i.actions[action]);
    if (!eligible.length) return;
    const words = BULK_WORDS[action];
    const skipped = items.length - eligible.length;
    const choice = await confirmChoice({
      heading: words.heading(eligible.length), mode: words.mode, yes: words.yes(eligible.length), legend: words.legend, titles: eligible.map((i) => i.title),
      intro: `${words.effect}${skipped ? ` ${plural(skipped, 'selected decision')} cannot be ${words.cannot} this way and ${skipped === 1 ? 'is' : 'are'} left alone.` : ''}`,
    });
    if (!choice) return;
    await runBusy(async () => {
      const refs = eligible.map((i) => i.ref);
      const result = await postJson('/api/decisions/bulk', { action, refs, count: refs.length, ...choice });
      const byRef = new Map((result.results ?? []).map((r) => [r.ref, r]));
      if (!result.results) {
        const line = R.resultLine(action, result);
        addRecent({ tone: 'error', text: `${words.done} none of ${refs.length}: ${line.text}` });
        return;
      }
      eligible.forEach((item) => settleOutcome(item, action, byRef.get(item.ref) ?? { outcome: 'failed', reason: 'no result came back for it' }));
      const isFailed = (i) => ['refused', 'failed', undefined].includes(byRef.get(i.ref)?.outcome);
      const failures = eligible.filter(isFailed).map((i) => `${i.title} (${byRef.get(i.ref)?.reason ?? 'no result came back'}${byRef.get(i.ref)?.output ? `: ${byRef.get(i.ref).output}` : ''})`);
      addRecent({ tone: failures.length ? 'error' : 'ok', text: `${words.done} ${result.done} of ${refs.length}.${failures.length ? ` Not done: ${failures.join('; ')}.` : ''}`,
        refs: action === 'defer' ? eligible.filter((i) => !isFailed(i)).map((i) => i.ref) : [] });
    }, eligible);
  };

  // Holds the same reason again with no date, which is exactly what clears a deferral.
  const undoEntry = (entry) => runBusy(async () => {
    const refs = [...entry.refs];
    const result = refs.length === 1 ? await postJson('/api/decisions/act', { action: 'undo-defer', ref: refs[0] })
      : await postJson('/api/decisions/bulk', { action: 'undo-defer', refs, count: refs.length });
    const results = result.results ?? [{ ref: refs[0], ...result }];
    const undone = results.filter((r) => r.outcome === 'undone').map((r) => r.ref);
    undone.forEach((ref) => outcomes.delete(ref));
    entry.refs = refs.filter((ref) => !undone.includes(ref));
    const failed = results.filter((r) => r.outcome !== 'undone');
    entry.undoNote = failed.length ? `Could not undo ${plural(failed.length, 'deferral')}: ${failed.map((r) => `${r.reason ?? r.outcome}${r.output ? ` ${r.output}` : ''}`).join('; ')}.` : 'Undone: back on your list.';
    entry.undoTone = failed.length ? 'error' : 'ok';
  });

  const reconcile = (parent, nodes) => {
    nodes.forEach((node, i) => { if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] ?? null); });
    while (parent.children.length > nodes.length) parent.lastElementChild.remove();
  };

  // A row is built once and updated in place, so typing, the chosen option, and focus survive every refresh.
  const makeRow = (ref) => {
    const row = { ref, item: null, option: null, optionSignature: '', optionButtons: [] };
    row.select = el('input', { type: 'checkbox', name: 'select', key: `select:${ref}`, onchange: () => { if (row.select.checked) selected.add(ref); else selected.delete(ref); renderDecisions(); } });
    row.title = el('a', { className: 'decision-title', key: `decision:${ref}` });
    row.meta = el('div', { className: 'card-meta' });
    row.summary = el('p', { className: 'decision-summary' });
    row.optionBox = el('div', { className: 'options', role: 'group', aria: { label: 'Listed options' } });
    row.text = el('textarea', { name: 'answer', rows: 2, maxLength: R.ANSWER_MAX, className: 'answer-text', key: `answer:${ref}`, placeholder: 'Or write your answer', oninput: () => { row.option = null; renderDecisions(); } });
    row.mode = el('select', { name: 'after-answer', className: 'mode', key: `mode:${ref}`, aria: { label: 'What happens after you answer' }, onchange: () => renderDecisions() },
      el('option', { value: '', textContent: 'After answering…' }), el('option', { value: 'done', textContent: 'Close the question' }), el('option', { value: 'release', textContent: 'Let the held work go ahead' }));
    row.send = el('button', { type: 'button', className: 'primary small', textContent: 'Send answer', key: `send:${ref}`, onclick: () => answerRow(row) });
    row.answerEffect = text('p', '', { className: 'effect', aria: { live: 'polite' } });
    row.date = el('input', { type: 'date', name: 'defer-until', className: 'defer-date', key: `date:${ref}`, aria: { label: 'Defer until' }, oninput: () => renderDecisions() });
    row.defer = el('button', { type: 'button', className: 'small', textContent: 'Defer', key: `defer:${ref}`, onclick: () => deferRow(row) });
    row.deferEffect = text('p', '', { className: 'effect', aria: { live: 'polite' } });
    row.settle = el('button', { type: 'button', className: 'danger small', textContent: 'Close as settled…', key: `settle:${ref}`, onclick: () => settleRow(row) });
    row.settleEffect = text('p', '', { className: 'effect' });
    row.readOnly = text('p', '', { className: 'muted' });
    row.result = el('p', { role: 'status' });
    row.answerBox = el('div', { className: 'answer-box' }, row.optionBox, row.text, row.mode, row.send, row.answerEffect);
    row.deferBox = el('div', { className: 'defer-box' }, row.date, deferQuickPicks((value) => { row.date.value = value; renderDecisions(); }), row.defer, row.deferEffect);
    row.settleBox = el('div', { className: 'settle-box' }, row.settle, row.settleEffect);
    row.node = el('article', { className: 'decision card tone-needs' }, el('div', { className: 'decision-head' }, row.select, row.title), row.meta, row.summary,
      row.answerBox, row.readOnly, row.deferBox, row.settleBox, row.result);
    return row;
  };

  const syncOptions = (row, item) => {
    const signature = item.options.map((o) => `${o.label}\u0001${o.text}`).join('\u0002');
    if (signature !== row.optionSignature) {
      row.optionSignature = signature;
      if (!item.options.some((o) => o.label === row.option)) row.option = null;
      row.optionButtons = item.options.map((o) => el('button', { type: 'button', className: 'option small', key: `option:${row.ref}:${o.label}`, textContent: `${o.label}  ${o.text}`,
        onclick: () => { row.option = row.option === o.label ? null : o.label; if (row.option) row.text.value = ''; renderDecisions(); } }));
      row.optionBox.replaceChildren(...row.optionButtons);
    }
    row.optionButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(row.option === item.options[i].label)));
    row.optionBox.hidden = !item.options.length;
  };

  const updateRow = (row, item) => {
    row.item = item;
    const outcome = outcomes.get(item.ref);
    const isDone = Boolean(outcome?.isDone);
    const isLocked = isDecisionBusy || isDone;
    row.title.textContent = item.title;
    row.title.href = item.cardKey ? `#/card/${encodeURIComponent(item.cardKey)}` : '#/decisions';
    row.title.title = 'Open the full detail';
    row.meta.replaceChildren(text('span', R.projectName(item.project), { className: 'chip' }),
      item.ageSeconds != null ? text('span', R.duration(item.ageSeconds), { className: `age${item.isAging ? ' age-old' : ''}`, title: `Waiting on you for ${R.duration(item.ageSeconds)}` }) : '',
      text('span', R.PRIORITY_LABELS[item.priority], { className: 'badge' }),
      item.collapsed ? text('span', `${plural(item.collapsed + 1, 'record')} folded into one`, { className: 'badge', title: 'Twin records of this decision are shown once' }) : '');
    row.summary.textContent = item.summary;
    row.node.classList.toggle('is-done', isDone);
    const canBulk = item.actions.defer || item.actions.settle;
    row.select.hidden = !canBulk;
    row.select.checked = selected.has(item.ref);
    row.select.disabled = isLocked;
    row.select.setAttribute('aria-label', `Select ${item.title}`);

    const { answer } = item.actions;
    row.answerBox.hidden = !answer;
    row.readOnly.hidden = Boolean(answer);
    row.readOnly.textContent = item.actions.readOnly ?? '';
    if (answer) {
      syncOptions(row, item);
      row.mode.hidden = !item.needsMode;
      const hasAnswer = Boolean(row.option) || row.text.value.trim().length > 0;
      row.text.disabled = isLocked;
      row.mode.disabled = isLocked;
      row.optionButtons.forEach((b) => { b.disabled = isLocked; });
      row.send.disabled = isLocked || !hasAnswer || (item.needsMode && !row.mode.value);
      row.send.textContent = answer.type === 'relay' ? 'Send to the worker' : 'Send answer';
      row.answerEffect.textContent = R.effectOf(item, 'answer', { mode: row.mode.value });
    }
    row.deferBox.hidden = !item.actions.defer;
    row.date.min = R.localDate(new Date(Date.now() + DAY_MS));
    row.date.disabled = isLocked;
    row.defer.disabled = isLocked || !row.date.value;
    row.deferEffect.textContent = R.effectOf(item, 'defer', { until: R.deferDate(row.date.value).until });
    row.settleBox.hidden = !item.actions.settle;
    row.settle.disabled = isLocked;
    row.settleEffect.textContent = R.effectOf(item, 'settle');
    row.result.hidden = !outcome;
    row.result.textContent = outcome?.text ?? '';
    row.result.className = outcome ? { ok: 'result-ok', error: 'problem' }[outcome.tone] ?? 'muted' : '';
  };

  const renderRecent = () => {
    recentBox.hidden = !recent.length;
    recentBox.replaceChildren(text('h3', 'Recent actions'), text('p', 'Kept until you reload this page. A deferral can be undone here; an answer or a close cannot.', { className: 'subtitle' }),
      el('ul', { className: 'recent-list' }, recent.map((e) => el('li', { className: e.tone === 'ok' ? 'result-ok' : 'problem' }, text('span', e.text),
        e.refs.length ? el('button', { type: 'button', className: 'small', textContent: e.refs.length === 1 ? 'Undo' : `Undo ${e.refs.length}`, key: `undo:${e.id}`, disabled: isDecisionBusy, onclick: () => undoEntry(e) }) : '',
        e.undoNote ? text('span', ` ${e.undoNote}`, { className: e.undoTone === 'ok' ? 'muted' : 'problem' }) : ''))));
  };

  const renderDecisions = () => {
    if (!snapshot) return;
    const { items, collapsed } = R.decisionItems(snapshot);
    const live = new Set(items.map((i) => i.ref));
    selected.forEach((ref) => { if (!live.has(ref)) selected.delete(ref); });
    decisionRows.forEach((_, ref) => { if (!live.has(ref)) decisionRows.delete(ref); });
    // A newer snapshot that still lists a decision is the proof that the action did not take, so it becomes actionable again.
    outcomes.forEach((o, ref) => { if (o.isDone && Date.parse(snapshot.generated) > o.at) outcomes.delete(ref); });
    decisionsTitle.textContent = `Decisions (${items.length})`;
    decisionsNote.textContent = collapsed ? `${plural(collapsed, 'duplicate record')} folded into the entries below.` : '';
    decisionsNote.hidden = !collapsed;
    const nodes = [];
    let lastPriority = -1;
    items.forEach((item) => {
      if (item.priority !== lastPriority) {
        lastPriority = item.priority;
        if (!groupHeads.has(item.priority)) groupHeads.set(item.priority, text('h3', '', { className: 'group-head' }));
        const head = groupHeads.get(item.priority);
        head.textContent = `${R.PRIORITY_LABELS[item.priority]} (${items.filter((i) => i.priority === item.priority).length})`;
        nodes.push(head);
      }
      if (!decisionRows.has(item.ref)) decisionRows.set(item.ref, makeRow(item.ref));
      const row = decisionRows.get(item.ref);
      updateRow(row, item);
      nodes.push(row.node);
    });
    if (!items.length) nodes.push(empty('Nothing is waiting on you.'));
    reconcile(decisionList, nodes);

    const pickable = items.filter((i) => (i.actions.defer || i.actions.settle) && !outcomes.get(i.ref)?.isDone);
    const chosen = items.filter((i) => selected.has(i.ref));
    selectAll.disabled = isDecisionBusy || !pickable.length;
    selectAll.checked = Boolean(pickable.length) && pickable.every((i) => selected.has(i.ref));
    selectAll.indeterminate = !selectAll.checked && chosen.length > 0;
    selectedCount.textContent = chosen.length ? `${chosen.length} selected` : 'Select decisions to close or defer several at once.';
    bulkSettle.disabled = isDecisionBusy || !chosen.some((i) => i.actions.settle);
    bulkDefer.disabled = isDecisionBusy || !chosen.some((i) => i.actions.defer);
    bulkBar.hidden = !pickable.length;
    renderRecent();
  };
  selectAll.addEventListener('change', () => {
    const pickable = currentItems().filter((i) => (i.actions.defer || i.actions.settle) && !outcomes.get(i.ref)?.isDone);
    if (selectAll.checked) pickable.forEach((i) => selected.add(i.ref)); else selected.clear();
    renderDecisions();
  });

  // ---- detail drawer ----
  const copyText = async (value) => {
    try { await navigator.clipboard.writeText(value); return true; } catch { /* fall back below */ }
    const area = el('textarea', { value, readOnly: true, className: 'offscreen' });
    document.body.append(area);
    area.select();
    const isCopied = document.execCommand('copy');
    area.remove();
    return isCopied;
  };
  const copyRow = (step, i) => {
    const note = el('span', { className: 'copy-note', aria: { live: 'polite' } });
    return el('div', { className: 'resolve-step' },
      text('div', step.label, { className: 'resolve-label' }),
      el('div', { className: 'resolve-line' }, text('code', step.text),
        el('button', { type: 'button', className: 'copy', textContent: 'Copy', key: `copy:${i}`, aria: { label: `Copy: ${step.label}` },
          onclick: async () => { note.textContent = (await copyText(step.text)) ? 'Copied' : 'Copy failed; select the text instead'; } })),
      note);
  };
  const blockerLink = (id) => {
    const target = [...registry.values()].find((c) => c.id === id && c.column !== 'done');
    return target ? el('a', { href: cardHref(target), textContent: id }) : text('span', id);
  };
  const closeButton = () => el('button', { type: 'button', className: 'close', textContent: 'Close', key: 'close', onclick: () => dialog.close() });

  const renderDetail = (key, detail) => {
    const c = registry.get(key);
    if (!c) return [el('div', { className: 'detail-head' }, text('h2', 'This item is no longer on the board', { id: 'detail-title' }), closeButton())];
    const column = R.COLUMNS.find((x) => x.key === c.column);
    const t = c.taskId ? R.taskDetail(snapshot, c.taskId, detail) : null;
    const row = (k, ...v) => el('div', {}, text('dt', k), el('dd', {}, ...v));
    const block = (title, ...body) => el('section', { className: 'detail-block' }, text('h3', title), ...body);
    return [
      el('div', { className: 'detail-head' },
        el('div', {}, text('h2', c.title, { id: 'detail-title' }),
          el('p', { className: 'detail-meta' }, text('span', R.projectName(c.project), { className: 'chip' }), text('span', c.id, { className: 'muted' }))),
        el('div', { className: 'detail-actions' }, cancelButton(c), closeButton())),
      el('p', { className: 'status' }, swatch(groupOf(c.column)), text('strong', column?.label ?? 'Queued'), c.badges.map((b) => text('span', b, { className: 'badge' }))),
      c.decisions.length ? block(c.decisions.length === 1 ? 'The decision' : `${c.decisions.length} decisions`,
        c.decisions.map((d) => el('div', { className: 'decision' }, text('p', d.summary), d.reason ? text('p', d.reason, { className: 'muted' }) : '',
          d.until ? text('p', `Held until ${d.until}`, { className: 'muted' }) : ''))) : '',
      c.blockers.events.length || c.blockers.ids.length || c.blockers.reason ? block('Blocked by',
        c.blockers.events.map((b) => text('p', b.summary)),
        c.blockers.ids.length ? el('p', {}, 'Waiting on ', c.blockers.ids.map((id, i) => [i ? ', ' : '', blockerLink(id)])) : '',
        c.blockers.reason ? text('p', c.blockers.reason, { className: 'muted' }) : '') : '',
      c.resolve.length ? el('section', { className: 'detail-block resolve' }, text('h3', 'How to resolve it'),
        text('p', 'Apart from Cancel and the Decisions tab, nothing runs from this page. Copy a reply for firstmate, or the command it would run.', { className: 'muted' }),
        c.resolve.map(copyRow)) : '',
      el('dl', {},
        c.stateDetail ? row('Latest status', c.stateDetail) : '',
        c.decisions.length && c.ageSeconds != null ? row('Waiting on you', `for ${R.duration(c.ageSeconds)}`) : '',
        (c.lastUpdateSeconds ?? (c.decisions.length ? null : c.ageSeconds)) != null ? row('Last update', ago(c.lastUpdateSeconds ?? c.ageSeconds)) : '',
        c.since ? row('Started', c.since) : '',
        c.date ? row('Finished', c.date) : '',
        row('Pull request', c.prUrl && isWebUrl(c.prUrl) ? external(c.prUrl, c.prUrl, 'url') : 'None'),
        R.sourceLinks(c, linkConfig).length ? row('Sources', el('ul', { className: 'sources' },
          R.sourceLinks(c, linkConfig).map((s) => el('li', {}, text('span', s.label, { className: 'badge' }), ' ', external(s.url, s.url, 'url'))))) : ''),
      c.text.length ? block('Full text', c.text.map((line) => text('pre', line))) : '',
      t ? [text('h3', 'Update history'),
        text('p', 'Past updates, oldest first. These are a record, not the current status above.', { className: 'muted' }),
        t.statusHistory.length ? text('pre', t.statusHistory.join('\n')) : empty(detail ? 'No updates recorded.' : 'Loading…'),
        text('h3', `Instructions sent (${t.inbox.pending.length} unread, ${t.inbox.handled.length} read)`),
        [['Unread', t.inbox.pending], ['Read', t.inbox.handled]].filter(([, m]) => m.length).map(([name, msgs]) => el('details', { key: `inbox:${name}` },
          text('summary', `${name} (${msgs.length})`), msgs.map((m) => el('div', {}, text('strong', m.name), text('pre', m.text)))))] : '',
    ].flat(Infinity).filter(Boolean);
  };

  // ---- agents tab: overview and log panel live in agents-page.js ----
  let agentsOverview = null;
  const agentsPage = window.FleetAgents.create({
    el, text, empty, token, copyText,
    onChange: (overview) => { agentsOverview = overview; renderTabs(); if (view.contains(agentsPage.node)) agentsPage.render(); },
  });

  // ---- routing ----
  const route = (hash = location.hash) => R.route(hash);

  // Re-rendering keeps keyboard focus and opened tables on the element with the same key.
  // The Machine page needs only the machine reading, so it works while the fleet snapshot is slow or failing.
  const renderBase = (isNavigation = false) => {
    if (route().page !== 'card') baseHash = location.hash || '#/board';
    const r = route(baseHash);
    const page = R.viewFor(r.page, { hasSnapshot: Boolean(snapshot) });
    if (r.page === 'board') {
      filters.query = r.params.get('q') ?? '';
      filters.project = r.params.get('project') ?? '';
    }
    const focusKey = document.activeElement?.dataset?.key;
    const scrollY = window.scrollY;
    const openKeys = [...view.querySelectorAll('details[open]')].map((d) => d.dataset.key);
    try {
      if (page === 'board') renderBoard(isNavigation ? r.column : null);
      else if (page === 'waiting') view.replaceChildren(text('h2', 'Waiting for the fleet snapshot', { className: 'page-title' }), text('p', snapshotNote, { className: 'muted' }));
      else if (page === 'radar') { if (!view.contains(radarNode)) view.replaceChildren(radarNode); radarNode.replaceChildren(radarPage()); }
      else if (page === 'agents') { if (view.contains(agentsPage.node)) agentsPage.render(); else { view.replaceChildren(agentsPage.node); agentsPage.show(); } }
      else if (page === 'decisions') { if (!view.contains(decisionsNode)) view.replaceChildren(decisionsNode); renderDecisions(); }
      else view.replaceChildren(...[page === 'list' ? renderList(r.filter) : page === 'machine' ? renderMachine() : renderCharts()].flat());
      if (snapshot) document.title = `Firstmate (${R.fleetCounts(snapshot).needsYou} need you)`;
    } catch (e) {
      return showBanner({ tone: 'error', text: e.message });
    }
    openKeys.forEach((k) => { const d = view.querySelector(`details[data-key="${CSS.escape(k ?? '')}"]`); if (d) d.open = true; });
    if (focusKey && !dialog.open && !(isNavigation && r.column)) view.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
    drawCharts();
    renderTabs();
    if (!isNavigation) window.scrollTo(0, scrollY);
    document.querySelectorAll('nav a').forEach((a) => a.setAttribute('aria-current', String(a.getAttribute('href') === `#/${r.page}`)));
  };

  // Same focus and opened-section preservation as the base view, inside the drawer.
  const fillDetail = (key, detail) => {
    const isFocusInside = dialog.contains(document.activeElement);
    const focusKey = document.activeElement?.dataset?.key;
    const openKeys = [...detailBody.querySelectorAll('details[open]')].map((d) => d.dataset.key);
    detailBody.replaceChildren(...renderDetail(key, detail));
    openKeys.forEach((k) => { const d = detailBody.querySelector(`details[data-key="${CSS.escape(k ?? '')}"]`); if (d) d.open = true; });
    if (isFocusInside) (detailBody.querySelector(`[data-key="${CSS.escape(focusKey ?? '')}"]`) ?? detailBody.querySelector('.close'))?.focus();
  };

  let detailFor = null;
  const syncDetail = async () => {
    const r = route();
    if (r.page !== 'card') { if (dialog.open) dialog.close(); return; }
    if (!snapshot) return;
    if (detailFor?.key !== r.key) detailFor = { key: r.key, detail: null };
    fillDetail(r.key, detailFor.detail);
    if (!dialog.open) { dialog.showModal(); detailBody.querySelector('.close')?.focus(); }
    const taskId = registry.get(r.key)?.taskId;
    if (!taskId) return;
    const [detail] = await getJson(`/api/task/${encodeURIComponent(taskId)}`).catch(() => [null]);
    if (detail && detailFor?.key === r.key && route().key === r.key) {
      detailFor.detail = detail;
      fillDetail(r.key, detail);
    }
  };
  dialog.addEventListener('close', () => {
    const { key } = route();
    detailFor = null;
    if (route().page === 'card') location.hash = baseHash;
    requestAnimationFrame(() => view.querySelector(`[data-key="${CSS.escape(`card:${key}`)}"]`)?.focus());
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  // ---- data ----
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
      if (body.loading) {
        snapshotNote = R.freshnessBanner(body).text;
        showBanner(R.freshnessBanner(body));
        if (!snapshot && route().page !== 'machine') renderBase();
        return;
      }
      const stale = res.headers.get('X-Snapshot-Stale');
      showBanner(R.freshnessBanner({
        fetchedAt: res.headers.get('X-Snapshot-Fetched-At'),
        stale: stale && decodeURIComponent(stale),
        refreshing: res.headers.has('X-Snapshot-Refreshing'),
      }));
      if (res.headers.get('X-Snapshot-Version') !== version) {
        snapshot = R.assertSchema(body);
        allCards = R.cards(snapshot);
        registry = R.cardRegistry(snapshot);
        pruneCancelled();
        hideCancelled();
        version = res.headers.get('X-Snapshot-Version');
        renderBase();
        if (route().page === 'card') syncDetail();
      }
    } catch (e) {
      snapshotNote = snapshot ? snapshotNote : e.message;
      showBanner({ tone: 'error', text: snapshot ? `Lost contact with the web view server: ${e.message}` : e.message });
    }
  };

  let resourcesVersion = null;
  const refreshResources = async () => {
    try {
      const [[body, res], [trend]] = await Promise.all([getJson('/api/resources'), getJson('/api/history')]);
      history = trend;
      if (body.loading) {
        health.textContent = body.error ? 'Machine check failing' : 'Checking machine…';
        resourcesError = body.error;
        if (route().page === 'machine') renderBase();
        return;
      }
      resourcesError = null;
      const stale = res.headers.get('X-Resources-Stale');
      resourcesLine = R.freshnessBanner({ fetchedAt: res.headers.get('X-Resources-Fetched-At'), stale: stale && decodeURIComponent(stale) }).text;
      if (res.headers.get('X-Resources-Version') === resourcesVersion && !stale) return;
      resourcesVersion = res.headers.get('X-Resources-Version');
      resources = body;
      const v = R.resourcesView(body);
      health.className = `health health-${v.badge.tone}`;
      health.textContent = v.badge.text;
      alertsBox.hidden = !v.alerts.length;
      alertsBox.replaceChildren(text('h2', 'Machine alerts'), el('ul', {}, v.alerts.map((a) => text('li', a))));
      if (document.querySelector('dialog[open]')) return;
      // On the board only the KPI strip depends on the machine, so the columns and search box stay put.
      if (view.contains(boardNode)) {
        const focusKey = document.activeElement?.dataset?.key;
        kpiSlot.replaceChildren(kpiStrip());
        if (focusKey?.startsWith('tile:')) kpiSlot.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
      } else if (!view.contains(radarNode) && !view.contains(agentsPage.node) && !view.contains(decisionsNode)) renderBase();
    } catch (e) {
      health.className = 'health health-error';
      health.textContent = `Machine check unavailable: ${e.message}`;
      resourcesError = e.message;
      if (!resources && route().page === 'machine') renderBase();
    }
  };

  window.addEventListener('hashchange', () => {
    if (route().page !== 'card') renderBase(true);
    syncDetail();
  });
  let resizeFrame = 0;
  new ResizeObserver(() => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(drawCharts); }).observe(view);
  getJson('/api/config').then(([body]) => { linkConfig = body; if (snapshot) renderBase(); }).catch(() => {});
  refresh();
  refreshResources();
  refreshRadar();
  agentsPage.refresh();
  setInterval(refresh, 3000);
  setInterval(refreshRadar, 15000);
  setInterval(refreshResources, 5000);
})();
