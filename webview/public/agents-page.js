// Agents tab: overview of every agent process plus a read-only log panel.
// Every value reaches the page through textContent only. Both API routes need the
// page token because process and log data can hold secrets.
(function () {
  const R = window.FleetRender;
  const OVERVIEW_MS = 5000;
  const BACKGROUND_MS = 30000;
  const LOG_MS = 4000;
  const ACTIVITY = { active: 'Active', 'needs-input': 'Needs input', stuck: 'Stuck or stale', idle: 'Idle' };
  const TONE = { active: 'ok', 'needs-input': 'warn', stuck: 'alert', idle: 'quiet' };

  const create = ({ el, text, empty, token, copyText, onChange }) => {
    let overview = null;
    let error = null;
    const node = el('div', { className: 'agents-page' });
    const expanded = new Set();
    const ago = (s) => (s == null ? 'unknown' : `${R.duration(s)} ago`);
    const mb = (bytes) => (bytes == null ? '' : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);
    const tail = (p) => (p ? p.split('/').filter(Boolean).slice(-2).join('/') : '');
    const chip = (activity) => text('span', ACTIVITY[activity] ?? activity, { className: `activity activity-${TONE[activity] ?? 'quiet'}` });

    const getJson = async (url) => {
      const res = await fetch(url, { cache: 'no-store', headers: { 'X-Webview-Token': token } });
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body;
    };

    // ---- log panel ----
    const dialog = el('dialog', { className: 'agent-log', aria: { labelledby: 'agent-log-title' } });
    const title = text('h2', '', { id: 'agent-log-title' });
    const status = el('p', { className: 'muted', aria: { live: 'polite' } });
    const filter = el('input', { type: 'search', placeholder: 'Filter lines', className: 'search', aria: { label: 'Filter log lines' } });
    const lines = el('select', { aria: { label: 'Lines per source' } }, [200, 500, 1000].map((n) => el('option', { value: String(n), textContent: `Last ${n} lines` })));
    const follow = el('input', { type: 'checkbox', checked: true, id: 'agent-log-follow' });
    const copyNote = el('span', { className: 'copy-note', aria: { live: 'polite' } });
    const sectionsBox = el('div', { className: 'agent-log-sections' });
    const parts = new Map();
    let target = null;
    let opener = null;
    let logTimer = 0;
    let log = null;

    const visibleLines = (s) => {
      const q = filter.value.trim().toLowerCase();
      return q ? s.lines.filter((l) => l.toLowerCase().includes(q)) : s.lines;
    };
    const copyAll = async () => {
      const textValue = (log?.sections ?? []).filter((s) => s.isAvailable).map((s) => `== ${s.title} ==\n${visibleLines(s).join('\n')}`).join('\n\n');
      copyNote.textContent = (await copyText(textValue)) ? 'Copied' : 'Copy failed; select the text instead';
    };

    // Each source keeps its own <pre>, so a reader who scrolled up stays put when auto-scroll is off.
    const renderLog = () => {
      if (!log) return;
      const seen = new Set();
      log.sections.forEach((s) => {
        seen.add(s.key);
        if (!parts.has(s.key)) {
          const part = { wrap: el('section', { className: 'agent-log-section' }), head: text('h3', ''), meta: text('p', '', { className: 'muted' }), pre: el('pre', { tabIndex: 0 }) };
          part.wrap.append(part.head, part.meta, part.pre);
          parts.set(s.key, part);
        }
        const part = parts.get(s.key);
        const shown = s.isAvailable ? visibleLines(s) : [];
        part.head.textContent = s.title;
        part.meta.textContent = s.isAvailable
          ? [s.source, s.updatedAt ? `updated ${new Date(s.updatedAt).toLocaleTimeString()}` : '', filter.value.trim() ? `${shown.length} of ${s.lines.length} lines match` : `${s.lines.length} lines`, s.note].filter(Boolean).join(' · ')
          : `Unavailable: ${s.reason}`;
        part.meta.className = s.isAvailable ? 'muted' : 'muted unavailable';
        part.pre.hidden = !s.isAvailable;
        part.pre.textContent = shown.length ? shown.join('\n') : s.isAvailable ? '(nothing to show)' : '';
        if (follow.checked) part.pre.scrollTop = part.pre.scrollHeight;
      });
      [...parts.keys()].filter((k) => !seen.has(k)).forEach((k) => { parts.get(k).wrap.remove(); parts.delete(k); });
      sectionsBox.replaceChildren(...log.sections.map((s) => parts.get(s.key).wrap));
    };

    const pollLog = async () => {
      clearTimeout(logTimer);
      if (!target || !dialog.open) return;
      const asked = target;
      const params = new URLSearchParams({ [asked.task ? 'task' : 'pid']: String(asked.task ?? asked.pid), lines: lines.value });
      try {
        const body = await getJson(`/api/agents/log?${params}`);
        if (asked !== target) return;
        log = body;
        title.textContent = body.target.label;
        status.textContent = `Read ${new Date(body.generatedAt).toLocaleTimeString()}; refreshes every ${LOG_MS / 1000} seconds while open.`;
        renderLog();
      } catch (e) {
        if (asked !== target) return;
        status.textContent = `Could not read the log: ${e.message}. Retrying.`;
      }
      if (asked === target && dialog.open) logTimer = setTimeout(pollLog, LOG_MS);
    };

    const openLog = (next, label, button) => {
      target = next;
      opener = button;
      log = null;
      parts.clear();
      sectionsBox.replaceChildren(text('p', 'Reading…', { className: 'muted' }));
      title.textContent = label;
      status.textContent = '';
      copyNote.textContent = '';
      if (!dialog.open) dialog.showModal();
      filter.focus();
      pollLog();
    };

    dialog.append(
      el('div', { className: 'detail-head' }, title, el('button', { type: 'button', className: 'close', textContent: 'Close', onclick: () => dialog.close() })),
      el('p', { className: 'agent-log-notice', role: 'note' }, 'Read-only. Logs may still contain sensitive data: obvious secrets are masked, but not everything can be. Nothing here is saved.'),
      el('div', { className: 'agent-log-controls' }, filter, lines,
        el('label', { htmlFor: 'agent-log-follow' }, follow, ' Auto-scroll'),
        el('button', { type: 'button', className: 'copy', textContent: 'Copy', onclick: copyAll }), copyNote),
      status, sectionsBox);
    filter.addEventListener('input', renderLog);
    follow.addEventListener('change', renderLog);
    lines.addEventListener('change', pollLog);
    dialog.addEventListener('close', () => { target = null; clearTimeout(logTimer); opener?.focus(); });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    document.body.append(dialog);

    // ---- overview ----
    const logButton = (label, next, key) => el('button', { type: 'button', className: 'link-button', textContent: label, key, aria: { label: `Open the log for ${label}` },
      onclick: (e) => openLog(next, label, e.currentTarget) });

    const children = (owner, list, count) => (count ? el('details', { key: `kids:${owner}`, open: expanded.has(owner), ontoggle: (e) => (e.target.open ? expanded.add(owner) : expanded.delete(owner)) },
      text('summary', `${count} child process${count === 1 ? '' : 'es'}`),
      el('table', { className: 'agent-children' }, el('tbody', {}, list.map((c) => el('tr', {},
        text('td', String(c.pid), { className: 'num' }), text('td', c.command, { className: 'command' }), text('td', `${c.cpu}%`, { className: 'num' }), text('td', mb(c.rssBytes), { className: 'num' }))))),
      count > list.length ? text('p', `and ${count - list.length} more`, { className: 'muted' }) : '') : '');

    const counterTiles = () => el('div', { className: 'agent-counters' }, Object.entries(ACTIVITY).map(([key, label]) => {
      const c = overview.counters[key];
      return el('section', { className: `kpi tone-${TONE[key]}`, aria: { label: `${label}: ${c.count}` } },
        text('span', label, { className: 'kpi-label' }), text('span', String(c.count), { className: 'kpi-value' }),
        c.reasons.length ? el('ul', { className: 'agent-reasons' }, c.reasons.map((r) => text('li', r))) : text('span', 'None', { className: 'kpi-note' }));
    }));

    const fleetTable = () => el('table', { className: 'agents' },
      el('thead', {}, el('tr', {}, ['Worker', 'Now', 'What it is doing', 'Agent', 'Where', 'Started', 'Last output'].map((h) => text('th', h)))),
      el('tbody', {}, overview.fleet.map((f) => {
        const p = f.processes[0];
        return el('tr', {},
          el('td', {}, logButton(f.id, { task: f.id }, `log:task:${f.id}`), text('div', [f.kind, f.state].filter(Boolean).join(' · '), { className: 'muted' })),
          el('td', {}, chip(f.activity)),
          el('td', {}, text('div', f.reason), f.lastAction ? text('div', `Last tool: ${f.lastAction}`, { className: 'muted' }) : '',
            f.lastEvent?.note ? text('div', `Last status ${ago(f.lastEvent.ageSeconds)}: ${f.lastEvent.state}: ${f.lastEvent.note}`, { className: 'muted' }) : ''),
          el('td', {}, text('div', [f.harness, f.model, f.effort].filter(Boolean).join(' · ') || 'unknown'),
            text('div', p ? `pid ${p.pid} · ${p.cpu}% CPU · ${mb(p.rssBytes)}` : 'no agent process found', { className: 'muted' }), p ? children(`task:${f.id}`, p.children, p.childCount) : ''),
          el('td', {}, text('div', [f.backend, f.target].filter(Boolean).join(' ')), text('div', tail(f.worktree), { className: 'muted', title: f.worktree ?? '' })),
          text('td', f.startedAt ? new Date(f.startedAt).toLocaleString() : 'unknown'),
          text('td', ago(f.lastOutputSeconds)));
      })));

    const othersTable = () => el('table', { className: 'agents' },
      el('thead', {}, el('tr', {}, ['Agent', 'Now', 'Kind', 'What it is doing', 'Folder', 'CPU', 'Memory', 'Running for', 'Last activity'].map((h) => text('th', h)))),
      el('tbody', {}, overview.others.map((o) => el('tr', {},
        el('td', {}, logButton(`${o.name} ${o.pid}`, { pid: o.pid }, `log:pid:${o.pid}`), text('div', o.command, { className: 'command muted' })),
        el('td', {}, chip(o.activity)),
        el('td', {}, text('div', o.role), text('div', [o.model, o.tty ? `terminal ${o.tty}` : 'no terminal', `parent ${o.ppid}`].filter(Boolean).join(' · '), { className: 'muted' })),
        el('td', {}, text('div', o.reason), o.foreground ? text('div', `Running: ${o.foreground}`, { className: 'command muted' }) : '',
          o.lastAction ? text('div', `Last tool: ${o.lastAction}`, { className: 'muted' }) : '', children(`pid:${o.pid}`, o.children, o.childCount)),
        el('td', {}, text('span', tail(o.cwd) || 'unknown', { title: o.cwd ?? '' })),
        text('td', `${o.cpu}%`, { className: 'num' }), text('td', mb(o.rssBytes), { className: 'num' }),
        text('td', R.duration(o.ageSeconds), { className: 'num' }), text('td', ago(o.lastActivitySeconds))))));

    const render = () => {
      const focusKey = node.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
      paint();
      if (focusKey) node.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
    };
    const paint = () => {
      const head = [text('h2', 'Agents', { className: 'page-title' }),
        text('p', `Every agent process on this machine, firstmate's workers first. Read-only; refreshes every ${OVERVIEW_MS / 1000} seconds while this tab is open. Select an agent to read its recent output.`, { className: 'muted' })];
      const fill = (...parts) => node.replaceChildren(...parts.flat(Infinity).filter((x) => x != null && x !== ''));
      if (!overview) return fill(head, error ? text('p', `Could not read the agents: ${error}. Retrying.`, { className: 'problem', role: 'alert' }) : text('p', 'Reading the process table…', { className: 'muted' }));
      return fill(head,
        error ? text('p', `Last refresh failed: ${error}. Showing the previous reading.`, { className: 'problem', role: 'alert' }) : '',
        overview.unavailable.map((u) => text('p', `${u.what} unavailable: ${u.reason}`, { className: 'problem' })),
        counterTiles(),
        el('section', { className: 'panel' }, text('h3', `Firstmate workers (${overview.fleet.length})`),
          text('p', 'State comes from the same reconciliation firstmate uses; the last status line is history, not current state.', { className: 'subtitle' }),
          overview.fleet.length ? fleetTable() : empty(overview.hasSnapshot ? 'No workers recorded in this home.' : 'Waiting for the fleet snapshot.')),
        el('section', { className: 'panel' }, text('h3', `Other agent processes (${overview.others.length})`),
          text('p', 'Agent command-line tools running outside this fleet, with their child processes grouped under them.', { className: 'subtitle' }),
          overview.others.length ? othersTable() : empty('None running.')));
    };

    let timer = 0;
    const isShown = () => node.isConnected && !document.hidden;
    const refresh = async () => {
      clearTimeout(timer);
      try {
        overview = await getJson('/api/agents');
        error = null;
      } catch (e) { error = e.message; }
      onChange(overview);
      timer = setTimeout(refresh, isShown() ? OVERVIEW_MS : BACKGROUND_MS);
    };
    // Opening the tab refreshes at once instead of waiting out the background interval.
    const show = () => { render(); if (!overview || Date.now() - Date.parse(overview.generatedAt) > OVERVIEW_MS) refresh(); };

    return { node, render, refresh, show, isOpen: () => dialog.open };
  };

  window.FleetAgents = { create };
})();
