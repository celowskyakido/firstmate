// Hand-written SVG charts. Geometry helpers are pure (tested under node); the
// builders run in the browser only. Labels reach the DOM via textContent only.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FleetCharts = factory();
})(typeof self === 'undefined' ? this : self, function () {
  const NS = 'http://www.w3.org/2000/svg';
  const RADIUS = 4;
  const BAR = 20;

  // Smallest 1/2/2.5/5 x 10^n at or above v, so axis ends read as clean numbers.
  const niceCeil = (v) => {
    if (!(v > 0)) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(v));
    return [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((m) => v <= m + 1e-9);
  };

  // Three ticks for small multiples; whole counts never get a fractional midpoint.
  const ticks = (max, isInteger) => (isInteger && max % 2 ? [0, max] : [0, max / 2, max]);

  // Polyline path that lifts the pen over missing readings instead of drawing them as zero.
  const linePath = (points) => points.reduce((d, p, i) => {
    if (!p) return d;
    return `${d}${d && points[i - 1] ? ' L' : `${d ? ' ' : ''}M`}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }, '');

  // Bar with a rounded data end and a square baseline end.
  const barPath = (x, y, w, h, end) => {
    const r = Math.min(RADIUS, end === 'right' ? w : h, end === 'right' ? h / 2 : w / 2);
    if (w <= 0 || h <= 0) return '';
    return end === 'right'
      ? `M${x} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x}Z`
      : `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
  };

  // Stacked horizontal segments with a 2px surface gap between neighbours.
  const stackLayout = (counts, width, gap = 2) => {
    const total = counts.reduce((a, b) => a + b, 0);
    const shown = counts.filter((c) => c > 0).length;
    const usable = Math.max(0, width - gap * Math.max(0, shown - 1));
    let x = 0;
    return counts.map((c) => {
      if (!c || !total) return null;
      const seg = { x, w: (c / total) * usable };
      x += seg.w + gap;
      return seg;
    });
  };

  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // ---- browser-only builders ----
  const svg = (tag, attrs = {}, ...children) => {
    const node = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => { if (v != null) node.setAttribute(k, String(v)); });
    children.flat().forEach((c) => c && node.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return node;
  };
  const label = (x, y, value, cls, anchor = 'start') => svg('text', { x, y, class: cls, 'text-anchor': anchor }, value);
  const root = (width, height, title) => svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title });

  // One shared tooltip; values lead, labels follow.
  let tip = null;
  const showTip = (anchor, lines, at) => {
    if (!tip) { tip = document.createElement('div'); tip.className = 'tooltip'; tip.setAttribute('aria-hidden', 'true'); document.body.append(tip); }
    tip.replaceChildren(...lines.map(([value, name, key]) => {
      const row = document.createElement('div');
      if (key) { const k = document.createElement('span'); k.className = `key fill-${key}`; row.append(k); }
      const strong = document.createElement('strong');
      strong.textContent = value;
      row.append(strong, document.createTextNode(name ? ` ${name}` : ''));
      return row;
    }));
    tip.hidden = false;
    const box = anchor.getBoundingClientRect();
    const x = at?.x ?? box.left + box.width / 2;
    const y = at?.y ?? box.top;
    tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, x - tip.offsetWidth / 2))}px`;
    tip.style.top = `${Math.max(8, y - tip.offsetHeight - 10)}px`;
  };
  const hideTip = () => { if (tip) tip.hidden = true; };
  const hoverable = (node, lines) => {
    node.addEventListener('pointerenter', () => showTip(node, lines()));
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', () => showTip(node, lines()));
    node.addEventListener('blur', hideTip);
    return node;
  };
  const link = (href, name, ...children) => svg('a', { href, 'aria-label': name, class: 'mark' }, ...children);

  // Small trend line for a KPI tile: no axes, end dot only.
  const sparkline = (values, { width = 96, height = 28 } = {}) => {
    const s = root(width, height, 'trend');
    s.setAttribute('aria-hidden', 'true');
    const real = values.filter((v) => v != null);
    if (real.length < 2) return s;
    const max = Math.max(...real);
    const min = Math.min(...real);
    const span = max - min || 1;
    const pts = values.map((v, i) => (v == null ? null : { x: 4 + (i / (values.length - 1)) * (width - 8), y: max === min ? height / 2 : 4 + (1 - (v - min) / span) * (height - 8) }));
    const last = pts.filter(Boolean).pop();
    s.append(svg('path', { d: linePath(pts), class: 'spark-line' }), svg('circle', { cx: last.x, cy: last.y, r: 3, class: 'spark-dot' }));
    return s;
  };

  // The state strip: one stacked bar across the page, every segment a drill-down link.
  const stateStrip = (segments, width, height = 28) => {
    const s = root(width, height, `Work by state: ${segments.map((g) => `${g.label} ${g.count}`).join(', ')}`);
    const layout = stackLayout(segments.map((g) => g.count), width);
    const lastShown = layout.map((l, i) => (l ? i : -1)).filter((i) => i >= 0).pop();
    segments.forEach((g, i) => {
      const l = layout[i];
      if (!l) return;
      const d = i === lastShown ? barPath(l.x, 0, l.w, height, 'right') : `M${l.x} 0h${l.w}v${height}h${-l.w}Z`;
      s.append(hoverable(link(g.href, `${g.label}: ${g.count}`, svg('path', { d, class: `fill-${g.key}` })),
        () => [[String(g.count), g.label, g.key]]));
    });
    if (lastShown == null) s.append(svg('rect', { x: 0, y: 0, width, height, rx: RADIUS, class: 'track' }));
    return s;
  };

  // Horizontal stacked bars, one row per project, total at the bar tip.
  const projectChart = (rows, width) => {
    const isNarrow = width < 480;
    const labelWidth = isNarrow ? 0 : Math.min(180, width * 0.32);
    const rowHeight = isNarrow ? 44 : 32;
    const plot = width - labelWidth - 36;
    const max = Math.max(1, ...rows.map((r) => r.total));
    const s = root(width, rows.length * rowHeight + 4, 'Work by project');
    rows.forEach((r, i) => {
      const y = i * rowHeight + (isNarrow ? 20 : 6);
      const barWidth = (r.total / max) * plot;
      const layout = stackLayout(r.segments.map((g) => g.count), barWidth);
      const lastShown = layout.map((l, k) => (l ? k : -1)).filter((k) => k >= 0).pop();
      const name = r.project.length > 26 ? `${r.project.slice(0, 25)}…` : r.project;
      const row = link(r.href, `${r.project}: ${r.total} tasks`,
        svg('rect', { x: 0, y: y - (isNarrow ? 20 : 6), width, height: rowHeight, class: 'hit' }),
        label(isNarrow ? 0 : labelWidth - 10, isNarrow ? y - 6 : y + BAR / 2 + 4, name, 'axis-label', isNarrow ? 'start' : 'end'),
        r.segments.map((g, k) => {
          const l = layout[k];
          if (!l) return null;
          return svg('path', { d: k === lastShown ? barPath(labelWidth + l.x, y, l.w, BAR, 'right') : `M${labelWidth + l.x} ${y}h${l.w}v${BAR}h${-l.w}Z`, class: `fill-${g.key}` });
        }),
        label(labelWidth + barWidth + 6, y + BAR / 2 + 4, String(r.total), 'value-label'));
      s.append(hoverable(row, () => [[`${r.total}`, `tasks in ${r.project}`], ...r.segments.filter((g) => g.count).map((g) => [String(g.count), g.label, g.key])]));
    });
    return s;
  };

  // Columns from one baseline, value on each cap, one colour (a single series).
  const columnChart = (bins, width, height = 160) => {
    const axis = 22;
    const top = 18;
    const plotH = height - axis - top;
    const max = Math.max(1, ...bins.map((b) => b.count));
    const band = width / bins.length;
    const barW = Math.min(24, band * 0.6);
    const s = root(width, height, 'Waiting items by age');
    s.append(svg('line', { x1: 0, x2: width, y1: top + plotH + 0.5, y2: top + plotH + 0.5, class: 'baseline' }));
    bins.forEach((b, i) => {
      const h = (b.count / max) * plotH;
      const cx = band * i + band / 2;
      s.append(hoverable(link(b.href, `${b.label}: ${b.count} items`,
        svg('rect', { x: band * i, y: 0, width: band, height, class: 'hit' }),
        b.count ? svg('path', { d: barPath(cx - barW / 2, top + plotH - h, barW, h, 'top'), class: 'fill-series' }) : null,
        label(cx, top + plotH - h - 5, String(b.count), 'value-label', 'middle'),
        label(cx, height - 6, b.label, 'axis-label', 'middle')), () => [[String(b.count), `waiting ${b.label.toLowerCase()}`]]));
    });
    return s;
  };

  // A single-series trend with a crosshair readout. One axis only, starting at zero.
  const lineChart = (points, { width, height = 120, title, format, isInteger = false, reference }) => {
    const left = 34;
    const right = 44;
    const top = 8;
    const bottom = 20;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const values = points.map((p) => p.v);
    const real = values.filter((v) => v != null);
    const max = niceCeil(Math.max(reference?.value ?? 0, ...real, isInteger ? 2 : 0));
    const s = root(width, height, title);
    s.setAttribute('tabindex', '0');
    const y = (v) => top + (1 - v / max) * plotH;
    const t0 = points[0]?.t;
    const t1 = points[points.length - 1]?.t;
    const x = (t) => left + (t1 > t0 ? ((t - t0) / (t1 - t0)) * plotW : plotW);
    ticks(max, isInteger).forEach((v) => {
      s.append(svg('line', { x1: left, x2: left + plotW, y1: y(v) + 0.5, y2: y(v) + 0.5, class: v ? 'grid' : 'baseline' }),
        label(left - 6, y(v) + 4, format(v), 'axis-label', 'end'));
    });
    if (reference) {
      s.append(svg('line', { x1: left, x2: left + plotW, y1: y(reference.value), y2: y(reference.value), class: 'reference' }),
        label(left + 4, y(reference.value) - 4, reference.label, 'axis-label'));
    }
    if (real.length < 2) {
      s.append(label(left + plotW / 2, top + plotH / 2, 'Collecting readings…', 'axis-label', 'middle'));
      return s;
    }
    s.append(label(left, height - 4, clock(t0), 'axis-label'), label(left + plotW, height - 4, 'now', 'axis-label', 'end'));
    const pts = points.map((p) => (p.v == null ? null : { x: x(p.t), y: y(p.v) }));
    const firstReal = pts.find(Boolean);
    const lastReal = [...pts].reverse().find(Boolean);
    s.append(svg('path', { d: `${linePath(pts)} L${lastReal.x} ${y(0)} L${firstReal.x} ${y(0)}Z`, class: 'area' }),
      svg('path', { d: linePath(pts), class: 'line' }),
      svg('circle', { cx: lastReal.x, cy: lastReal.y, r: 4, class: 'end-dot' }),
      label(lastReal.x + 8, lastReal.y + 4, format(real[real.length - 1]), 'value-label'));
    const cross = svg('line', { y1: top, y2: top + plotH, class: 'crosshair', visibility: 'hidden' });
    const dot = svg('circle', { r: 4, class: 'end-dot', visibility: 'hidden' });
    s.append(cross, dot);
    let index = points.length - 1;
    const show = (i, at) => {
      index = Math.max(0, Math.min(points.length - 1, i));
      const p = points[index];
      cross.setAttribute('x1', x(p.t)); cross.setAttribute('x2', x(p.t)); cross.setAttribute('visibility', 'visible');
      if (p.v != null) { dot.setAttribute('cx', x(p.t)); dot.setAttribute('cy', y(p.v)); dot.setAttribute('visibility', 'visible'); }
      showTip(s, [[p.v == null ? 'no reading' : format(p.v), `at ${clock(p.t)}`]], at ?? { x: s.getBoundingClientRect().left + x(p.t), y: s.getBoundingClientRect().top + y(p.v ?? 0) });
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); };
    const nearest = (clientX) => {
      const px = clientX - s.getBoundingClientRect().left;
      let best = 0;
      points.forEach((p, i) => { if (Math.abs(x(p.t) - px) < Math.abs(x(points[best].t) - px)) best = i; });
      return best;
    };
    s.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
    s.addEventListener('pointerleave', hide);
    s.addEventListener('focus', () => show(index));
    s.addEventListener('blur', hide);
    s.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); show(index + (e.key === 'ArrowLeft' ? -1 : 1)); }
    });
    return s;
  };

  return { niceCeil, ticks, linePath, barPath, stackLayout, sparkline, stateStrip, projectChart, columnChart, lineChart, hideTip };
});
