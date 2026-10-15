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
  let resources = null;
  let resourcesLine = '';
  let history = { fleet: [], machine: [] };
  let charts = [];

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (v == null) return;
      if (k === 'key') node.dataset.key = v;
      else node[k] = v;
    });
    children.flat().forEach((c) => c != null && c !== '' && node.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return node;
  };
  const text = (tag, value, props) => el(tag, { ...props, textContent: value ?? '' });
  const safeLink = (url) => (/^https?:\/\//i.test(url ?? '')
    ? el('a', { href: url, textContent: url.replace(/^https?:\/\//, ''), rel: 'noreferrer noopener', target: '_blank', className: 'url' })
    : document.createTextNode(url ?? ''));
  const empty = (message) => text('p', message, { className: 'muted empty' });
  const dot = (bucket) => el('span', { className: `dot fill-${bucket}`, ariaHidden: 'true' });
  const ago = (seconds) => (seconds == null ? '' : `${R.duration(seconds)} ago`);
  const KIND = { ship: 'Change with a PR', scout: 'Investigation', secondmate: 'Second mate' };

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
  const card = (title, subtitle, ...body) => el('section', { className: 'card' }, text('h3', title), subtitle ? text('p', subtitle, { className: 'subtitle' }) : '', ...body);

  // ---- overview ----
  const legend = (segments) => el('ul', { className: 'legend' }, segments.map((g) => el('li', {},
    el('a', { href: g.href, key: `legend:${g.key}` }, el('span', { className: `swatch fill-${g.key}`, ariaHidden: 'true' }), text('span', g.label), text('strong', String(g.count))))));

  // Work tiles and machine tiles sit in separate rows so each row fills the width.
  const tiles = (counts) => {
    const all = R.kpis({ counts, machine: resources && R.machineSample(resources), limits: resources?.limits, history }).map((t, i) => el('a', { href: t.href, className: `tile tone-${t.tone}`, key: `tile:${t.key}` },
      text('span', t.label, { className: 'tile-label' }),
      el('span', { className: 'tile-body' }, text('span', t.value, { className: 'tile-value' }), C.sparkline(t.series, { width: i < 6 ? 72 : 144, height: 28 })),
      text('span', t.note, { className: 'tile-note' })));
    return [el('div', { className: 'tiles' }, all.slice(0, 6)), el('div', { className: 'tiles tiles-machine' }, all.slice(6))];
  };

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
    return card('Machine trends', `Last ${minutes ? `${minutes} min` : 'few seconds'} while this page's server has been running, up to 3 hours.`,
      el('div', { className: 'multiples' }, specs.map(([title, points, opts]) => el('figure', {},
        text('figcaption', title), chart('trend', (width) => C.lineChart(points, { width, title, ...opts }))))),
      numbersTable(['Time', ...specs.map(([t]) => t)], history.machine.slice(-12).reverse().map((p) => [
        new Date(p.t).toLocaleTimeString(), p.load?.toFixed(1) ?? 'n/a', p.memoryInUse == null ? 'n/a' : `${Math.round(p.memoryInUse * 100)}%`,
        p.sessions == null ? 'n/a' : String(Math.round(p.sessions)), p.helpers == null ? 'n/a' : String(Math.round(p.helpers))])));
  };

  const itemTable = (items) => el('table', { className: 'items' },
    el('thead', {}, el('tr', {}, ['Status', 'Item', 'Project', 'Last update', 'Link'].map((h) => text('th', h)))),
    el('tbody', {}, items.map((i) => el('tr', {},
      el('td', { className: 'status' }, i.bucket ? dot(i.bucket) : '', text('span', i.label)),
      el('td', {},
        i.taskId ? el('a', { href: `#/task/${encodeURIComponent(i.taskId)}`, textContent: i.title, key: `task:${i.taskId}` }) : text('span', i.title),
        i.detail ? text('div', i.detail, { className: 'muted' }) : '',
        i.waitsOn.map((w) => text('div', w, { className: 'muted' }))),
      text('td', i.project), text('td', ago(i.ageSeconds), { className: 'num' }), el('td', {}, safeLink(i.prUrl))))));

  const renderOverview = () => {
    const counts = R.fleetCounts(snapshot);
    const breakdown = R.stateBreakdown(snapshot);
    const projects = R.projectBars(snapshot);
    const ages = R.ageHistogram(snapshot);
    const needs = R.listView(snapshot, 'needs');
    const total = breakdown.reduce((n, b) => n + b.count, 0);
    return [
      el('section', { className: 'hero' },
        el('h2', { className: 'hero-line' },
          counts.needsYou ? [text('span', String(counts.needsYou), { className: 'hero-number' }), text('span', counts.needsYou === 1 ? ' item needs you' : ' items need you')]
            : text('span', 'Nothing needs you right now')),
        counts.needsYou ? el('p', { className: 'hero-sub' },
          el('a', { href: '#/list/needs-decision', textContent: `${counts.needsDecision} decision${counts.needsDecision === 1 ? '' : 's'}`, key: 'hero:decisions' }), ' and ',
          el('a', { href: '#/list/reviews', textContent: `${counts.reviews} review${counts.reviews === 1 ? '' : 's'}`, key: 'hero:reviews' }), ' waiting.') : '',
        el('div', { className: 'strip' },
          text('p', `${total} task${total === 1 ? '' : 's'} by state`, { className: 'strip-title' }),
          chart('strip-chart', (width) => C.stateStrip(breakdown, width)),
          legend(breakdown))),
      ...tiles(counts),
      el('div', { className: 'grid-2' },
        card('Work by project', 'Tasks per project, coloured by state. Select a project to see its work.',
          projects.length ? chart('bars', (width) => C.projectChart(projects, width)) : empty('No work in flight.'),
          numbersTable(['Project', 'Tasks', ...R.BUCKETS.map((b) => b.label)], projects.map((p) => [p.project, String(p.total), ...p.segments.map((g) => String(g.count))]))),
        card('How long items have waited', `Decisions, reviews, and blocked work by time since their last update.${ages.unknownAge ? ` ${ages.unknownAge} without a known age are left out.` : ''}`,
          chart('columns', (width) => C.columnChart(ages.bins, width)),
          numbersTable(['Waiting', 'Items'], ages.bins.map((b) => [b.label, String(b.count)])))),
      machineTrends(),
      el('section', { className: 'card' },
        el('div', { className: 'card-head' }, text('h3', 'Needs you'), needs.items.length > 8 ? el('a', { href: '#/list/needs', textContent: `See all ${needs.items.length}`, key: 'needs:all' }) : ''),
        needs.items.length ? itemTable(needs.items.slice(0, 8)) : empty('Nothing is waiting on you.')),
      el('p', { className: 'more' }, el('a', { href: '#/list/finished', textContent: 'Recently finished work', key: 'more:finished' })),
    ];
  };

  const backLink = () => el('p', { className: 'back' }, el('a', { href: '#/', textContent: 'Back to the overview', key: 'back' }));

  const renderList = (filter) => {
    const list = R.listView(snapshot, filter);
    if (!list) return [backLink(), text('h2', 'Nothing to show for this link')];
    return [backLink(), text('h2', `${list.title} (${list.items.length})`),
      list.items.length ? el('section', { className: 'card' }, itemTable(list.items)) : empty('Nothing here right now.')];
  };

  const renderMachine = () => {
    if (!resources) return [backLink(), text('h2', 'Machine'), empty('Checking the machine…')];
    const v = R.resourcesView(resources);
    const plain = (headers, rows) => el('table', {}, el('thead', {}, el('tr', {}, headers.map((h) => text('th', h)))),
      el('tbody', {}, rows.map((r) => el('tr', {}, r.map(([value, cls]) => text('td', value, { className: cls }))))));
    return [backLink(), text('h2', 'Machine'), text('p', resourcesLine, { className: 'muted' }),
      el('section', { className: 'card' }, el('table', {}, v.machine.map(([k, val]) => el('tr', {}, text('th', k), text('td', val, { className: 'num' }))))),
      machineTrends(),
      card(`Claude sessions (${v.sessions.length})`, 'Largest first, including their helper processes.',
        v.sessions.length ? plain(['Session', 'Memory', 'Processes', 'MCP helpers', 'Age'], v.sessions.map((x) => [[x.name], [x.memory, 'num'], [x.processes, 'num'], [x.mcpHelpers, 'num'], [x.age, 'num']])) : empty('No Claude sessions.')),
      card(`Stray helpers (${v.orphans.length})`, 'Helper processes older than an hour whose parent has exited.',
        v.orphans.length ? plain(['PID', 'Command', 'Memory', 'Age'], v.orphans.map((o) => [[o.pid, 'num'], [o.command, 'command'], [o.memory, 'num'], [o.age, 'num']])) : empty('None.'))];
  };

  // ---- task detail panel ----
  const renderDetail = (id, detail) => {
    const t = R.taskDetail(snapshot, id, detail);
    if (!t) return [text('h2', 'This task is no longer in the fleet', { id: 'detail-title' })];
    const row = (k, ...v) => el('div', {}, text('dt', k), el('dd', {}, ...v));
    return [
      el('div', { className: 'detail-head' },
        el('div', {}, text('h2', t.title ?? t.id, { id: 'detail-title' }), text('p', [t.id, t.project].filter(Boolean).join(' in '), { className: 'muted' })),
        el('button', { type: 'button', className: 'close', textContent: 'Close', key: 'close', onclick: () => dialog.close() })),
      el('p', { className: 'status' }, dot(R.bucketOf(R.fleetOverview(snapshot).tasks.find((x) => x.id === id))), text('strong', t.statusLabel), t.stateDetail ? text('span', ` ${t.stateDetail}`, { className: 'muted' }) : ''),
      el('dl', {},
        row('What it is', KIND[t.kind] ?? t.kind ?? 'Unknown'),
        row('Started', t.since ?? 'Unknown'),
        row('Last update', t.ageSeconds == null ? 'Unknown' : ago(t.ageSeconds)),
        row('Pull request', t.prUrl ? safeLink(t.prUrl) : 'None yet'),
        row('Waiting on', t.waitsOn.length ? t.waitsOn.map((w) => text('div', w)) : 'Nothing')),
      text('h3', 'Update history'),
      text('p', 'Past updates, oldest first. These are a record, not the current status above.', { className: 'muted' }),
      t.statusHistory.length ? text('pre', t.statusHistory.join('\n')) : empty(detail ? 'No updates recorded.' : 'Loading…'),
      text('h3', `Instructions sent (${t.inbox.pending.length} unread, ${t.inbox.handled.length} read)`),
      ...[['Unread', t.inbox.pending], ['Read', t.inbox.handled]].filter(([, m]) => m.length).map(([name, msgs]) => el('details', { key: `inbox:${name}` },
        text('summary', `${name} (${msgs.length})`), ...msgs.map((m) => el('div', {}, text('strong', m.name), text('pre', m.text))))),
    ];
  };

  // ---- routing ----
  const route = () => {
    const [, page, ...rest] = location.hash.slice(1).split('/');
    if (page === 'task' && rest[0]) return { page, id: decodeURIComponent(rest[0]) };
    if (page === 'list' && rest.length) return { page, filter: rest.join('/') };
    if (page === 'machine') return { page };
    return { page: 'overview' };
  };
  let baseHash = '#/';

  // Re-rendering keeps keyboard focus and opened tables on the element with the same key.
  const renderBase = () => {
    if (!snapshot) return;
    if (route().page !== 'task') baseHash = location.hash || '#/';
    const [, page, ...rest] = baseHash.slice(1).split('/');
    const focusKey = document.activeElement?.dataset?.key;
    const openKeys = [...view.querySelectorAll('details[open]')].map((d) => d.dataset.key);
    try {
      view.replaceChildren(...(page === 'list' ? renderList(rest.join('/')) : page === 'machine' ? renderMachine() : renderOverview()));
      document.title = `Firstmate (${R.fleetCounts(snapshot).needsYou} need you)`;
    } catch (e) {
      return showBanner({ tone: 'error', text: e.message });
    }
    openKeys.forEach((k) => { const d = view.querySelector(`details[data-key="${CSS.escape(k ?? '')}"]`); if (d) d.open = true; });
    if (focusKey && !dialog.open) view.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
    drawCharts();
    document.querySelectorAll('nav a').forEach((a) => a.setAttribute('aria-current', String(a.getAttribute('href') === (page === 'machine' ? '#/machine' : '#/'))));
  };

  // Same focus and opened-section preservation as the base view, inside the panel.
  const fillDetail = (id, detail) => {
    const isFocusInside = dialog.contains(document.activeElement);
    const focusKey = document.activeElement?.dataset?.key;
    const openKeys = [...detailBody.querySelectorAll('details[open]')].map((d) => d.dataset.key);
    detailBody.replaceChildren(...renderDetail(id, detail));
    openKeys.forEach((k) => { const d = detailBody.querySelector(`details[data-key="${CSS.escape(k ?? '')}"]`); if (d) d.open = true; });
    if (isFocusInside) (detailBody.querySelector(`[data-key="${CSS.escape(focusKey ?? '')}"]`) ?? detailBody.querySelector('.close'))?.focus();
  };

  let detailFor = null;
  const syncDetail = async () => {
    const r = route();
    if (r.page !== 'task') { if (dialog.open) dialog.close(); return; }
    if (!snapshot) return;
    if (detailFor?.id !== r.id) detailFor = { id: r.id, detail: null };
    fillDetail(r.id, detailFor.detail);
    if (!dialog.open) { dialog.showModal(); detailBody.querySelector('.close')?.focus(); }
    const [detail] = await getJson(`/api/task/${encodeURIComponent(r.id)}`).catch(() => [null]);
    if (detail && detailFor?.id === r.id && route().id === r.id) {
      detailFor.detail = detail;
      fillDetail(r.id, detail);
    }
  };
  dialog.addEventListener('close', () => {
    const id = route().id;
    detailFor = null;
    if (route().page === 'task') location.hash = baseHash;
    requestAnimationFrame(() => view.querySelector(`[data-key="${CSS.escape(`task:${id}`)}"]`)?.focus());
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
      if (body.loading) return showBanner(R.freshnessBanner(body));
      const stale = res.headers.get('X-Snapshot-Stale');
      showBanner(R.freshnessBanner({
        fetchedAt: res.headers.get('X-Snapshot-Fetched-At'),
        stale: stale && decodeURIComponent(stale),
        refreshing: res.headers.has('X-Snapshot-Refreshing'),
      }));
      if (res.headers.get('X-Snapshot-Version') !== version) {
        snapshot = R.assertSchema(body);
        version = res.headers.get('X-Snapshot-Version');
        renderBase();
        if (route().page === 'task') syncDetail();
      }
    } catch (e) {
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
        return;
      }
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
      if (!dialog.open) renderBase();
    } catch (e) {
      health.className = 'health health-error';
      health.textContent = `Machine check unavailable: ${e.message}`;
    }
  };

  window.addEventListener('hashchange', () => {
    if (route().page !== 'task') renderBase();
    syncDetail();
  });
  let resizeFrame = 0;
  new ResizeObserver(() => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(drawCharts); }).observe(view);
  refresh();
  refreshResources();
  setInterval(refresh, 3000);
  setInterval(refreshResources, 5000);
})();
