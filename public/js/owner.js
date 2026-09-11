(function () {
  document.getElementById('shopName').textContent = window.SHOP_CONFIG.name + ' — Owner Dashboard';

  const pinPanel = document.getElementById('pinPanel');
  const ownerPanel = document.getElementById('ownerPanel');
  const pinInput = document.getElementById('pin');
  const pinBtn = document.getElementById('pinBtn');
  const pinError = document.getElementById('pinError');
  const lockBtn = document.getElementById('lockBtn');

  const statSignups = document.getElementById('statSignups');
  const statPunches = document.getElementById('statPunches');
  const statPunchesToday = document.getElementById('statPunchesToday');
  const statSignupsToday = document.getElementById('statSignupsToday');
  const statRewards = document.getElementById('statRewards');
  const statRepeatRate = document.getElementById('statRepeatRate');

  const granularityTabs = document.getElementById('granularityTabs');
  const rangeTabs = document.getElementById('rangeTabs');
  const vipTabs = document.getElementById('vipTabs');
  const vipTitle = document.getElementById('vipTitle');

  const VIP_WINDOW_LABELS = { all: 'All-Time', month: 'This Month', year: 'This Year' };

  function getPin() {
    return localStorage.getItem('staffPin') || '';
  }

  // Filter state persists across visits (same idea as the saved staff PIN)
  // so the owner doesn't have to re-pick "26 weeks" every time they open
  // the page. Falls back to sane defaults if localStorage has garbage in
  // it or nothing at all. Week range and day range are remembered
  // separately, so flipping the granularity toggle back and forth doesn't
  // lose whichever range you'd picked for the other view.
  const ALLOWED_WEEKS = [4, 12, 26];
  const ALLOWED_DAYS = [7, 14, 30];
  const ALLOWED_VIP_WINDOWS = ['all', 'month', 'year'];
  const ALLOWED_GRANULARITY = ['week', 'day'];

  function loadFilterState() {
    const savedGranularity = localStorage.getItem('ownerDashboardGranularity');
    const savedWeeks = parseInt(localStorage.getItem('ownerDashboardWeeks'), 10);
    const savedDays = parseInt(localStorage.getItem('ownerDashboardDays'), 10);
    const savedVipWindow = localStorage.getItem('ownerDashboardVipWindow');
    return {
      granularity: ALLOWED_GRANULARITY.includes(savedGranularity) ? savedGranularity : 'week',
      weeks: ALLOWED_WEEKS.includes(savedWeeks) ? savedWeeks : 12,
      days: ALLOWED_DAYS.includes(savedDays) ? savedDays : 14,
      vipWindow: ALLOWED_VIP_WINDOWS.includes(savedVipWindow) ? savedVipWindow : 'all',
    };
  }

  const filterState = loadFilterState();

  function setActiveTab(tabRow, datasetKey, value) {
    Array.from(tabRow.children).forEach((btn) => {
      btn.classList.toggle('active', btn.dataset[datasetKey] === String(value));
    });
  }

  // The range row's buttons depend on which granularity is active (4/12/26
  // weeks vs. 7/14/30 days) — rebuilt from scratch rather than toggling
  // `display` on two static rows, so there's only one place that owns
  // "what range values exist."
  function renderRangeTabs() {
    rangeTabs.innerHTML = '';
    const isDay = filterState.granularity === 'day';
    const values = isDay ? ALLOWED_DAYS : ALLOWED_WEEKS;
    const activeValue = isDay ? filterState.days : filterState.weeks;
    values.forEach((value) => {
      const btn = document.createElement('button');
      btn.className = 'tab-btn' + (value === activeValue ? ' active' : '');
      btn.dataset.range = String(value);
      btn.textContent = `${value} ${isDay ? (value === 1 ? 'Day' : 'Days') : (value === 1 ? 'Week' : 'Weeks')}`;
      rangeTabs.appendChild(btn);
    });
  }

  // Weekly buckets are stored as 'YYYY-MM-DD' strings (see weeklySeries()
  // in db.js) — parsed manually rather than through Date/toLocaleDateString
  // so a viewer's local timezone can't shift the date shown by a day.
  function shortDateLabel(iso) {
    const parts = iso.split('-');
    const month = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);
    return `${month}/${day}`;
  }

  // Used only in day-view tooltips, where "Tue 9/9" reads a lot faster
  // than a bare date when you're scanning across a week of daily points.
  const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function weekdayAbbr(iso) {
    const parts = iso.split('-').map((p) => parseInt(p, 10));
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return WEEKDAY_ABBR[d.getUTCDay()];
  }

  function pluralize(n, singular, plural) {
    return n === 1 ? singular : plural;
  }

  // ---------- count-up animation for the big numbers ----------
  // Non-technical owners respond to "the number is climbing" much more
  // than a number that just appears — this is the one animation doing
  // the most work toward "show the performance."
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function countUp(el, target, suffix) {
    suffix = suffix || '';
    const start = parseInt(el.dataset.value || '0', 10) || 0;
    el.dataset.value = target;
    if (start === target) {
      el.textContent = target + suffix;
      return;
    }
    const duration = 900;
    const startTime = performance.now();
    function tick(now) {
      const progress = Math.min(1, (now - startTime) / duration);
      const eased = easeOutCubic(progress);
      const value = Math.round(start + (target - start) * eased);
      el.textContent = value + suffix;
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // ---------- plain-English trend note under each chart ----------
  // Translates "here's a line" into a sentence, since the audience for
  // this page shouldn't have to read a chart to know if things are good.
  //
  // Compares two rolling 7-day windows (last 7 days vs. the 7 days before
  // that) rather than "this calendar week so far" vs. "all of last week."
  // The calendar-week version made the trend look falsely negative for
  // most of every week, since a partial week was always being compared
  // against a complete one.
  function trendNote(rolling) {
    if (!rolling) return '';
    const { last7, prev7 } = rolling;
    if (prev7 === 0 && last7 === 0) return 'No activity in the last 7 days.';
    if (prev7 === 0) return `${last7} in the last 7 days — a fresh start!`;
    const pct = Math.round(((last7 - prev7) / prev7) * 100);
    if (pct > 0) return `▲ Up ${pct}% vs. the previous 7 days`;
    if (pct < 0) return `▼ Down ${Math.abs(pct)}% vs. the previous 7 days`;
    return 'Same as the previous 7 days';
  }

  // A tooltip only ever needs to be dismissed from outside its own chart
  // via this — set while a tooltip is showing, cleared when hidden. A
  // single document-level listener (registered once, below) uses it to
  // close whichever chart's tooltip is open when the owner taps/clicks
  // anywhere else on the page (needed for touch, which has no hover-away).
  let dismissActiveTooltip = null;

  function tooltipText(p, granularity, metric) {
    const countLabel = `${p.value} ${pluralize(p.value, metric.singular, metric.plural)}`;
    if (granularity === 'day') {
      return `${weekdayAbbr(p.periodStart)} ${shortDateLabel(p.periodStart)}: ${countLabel}`;
    }
    return `Week of ${shortDateLabel(p.periodStart)}: ${countLabel}`;
  }

  // ---------- animated SVG line chart ----------
  // Hand-rolled rather than a charting library, same philosophy as the
  // existing bar chart on the staff dashboard — no new dependency for
  // something this simple. `metric` is a {singular, plural} label pair
  // (e.g. {singular:'punch', plural:'punches'}) used in the hover tooltip.
  function renderLineChart(container, series, color, emptyText, granularity, metric) {
    container.innerHTML = '';
    const values = series.map((s) => s.value);
    const hasData = values.some((v) => v > 0);

    if (!hasData) {
      const empty = document.createElement('div');
      empty.className = 'chart-empty';
      empty.textContent = emptyText;
      container.appendChild(empty);
      return;
    }

    const W = 600, H = 150, padX = 12, padY = 20;
    const max = Math.max(1, ...values);

    const points = series.map((s, i) => ({
      x: padX + (i / Math.max(1, series.length - 1)) * (W - padX * 2),
      y: H - padY - (s.value / max) * (H - padY * 2),
      value: s.value,
      periodStart: s.periodStart,
    }));

    const linePath = points.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(' ');
    const areaPath = `${linePath} L ${points[points.length - 1].x} ${H - padY} L ${points[0].x} ${H - padY} Z`;

    // Wraps just the <svg> (not the x-axis labels below it) at a size that
    // exactly matches the svg's own box, so the tooltip can be positioned
    // with plain percentages of this wrapper instead of measuring pixels —
    // 0-600/0-150 viewBox units convert straight to 0-100% here regardless
    // of how wide the panel actually renders.
    const chartArea = document.createElement('div');
    chartArea.className = 'line-chart-area-wrap';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.classList.add('line-chart-svg');

    const area = document.createElementNS(svg.namespaceURI, 'path');
    area.setAttribute('d', areaPath);
    area.setAttribute('class', 'line-chart-area');
    area.style.fill = color.area;
    svg.appendChild(area);

    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', linePath);
    path.setAttribute('class', 'line-chart-path');
    path.style.stroke = color.line;
    svg.appendChild(path);

    const tooltip = document.createElement('div');
    tooltip.className = 'line-chart-tooltip';
    tooltip.setAttribute('role', 'status');

    function hideTooltip() {
      tooltip.classList.remove('visible');
      if (dismissActiveTooltip === hideTooltip) dismissActiveTooltip = null;
    }

    function showTooltip(p, i) {
      tooltip.textContent = tooltipText(p, granularity, metric);
      const xPct = (p.x / W) * 100;
      const yPct = (p.y / H) * 100;
      tooltip.style.left = `${xPct}%`;
      tooltip.style.top = `${yPct}%`;
      // Always centered over the point (the CSS default transform) —
      // the chart panel has enough side padding that even the first/last
      // point's tooltip has room to spill slightly into it without
      // clipping, and a centered arrow always points at the right dot.
      tooltip.classList.add('visible');
      dismissActiveTooltip = hideTooltip;
    }

    points.forEach((p, i) => {
      const dot = document.createElementNS(svg.namespaceURI, 'circle');
      dot.setAttribute('cx', p.x);
      dot.setAttribute('cy', p.y);
      dot.setAttribute('r', 4);
      dot.setAttribute('class', 'line-chart-dot');
      dot.style.fill = color.line;
      dot.style.animationDelay = `${400 + i * 35}ms`;
      svg.appendChild(dot);

      // A larger, invisible hit target — the visible dot is only 4px,
      // too small to reliably hover or tap on its own. Keyboard-focusable
      // too, so the exact value behind each point is reachable without a
      // mouse or a touchscreen.
      const hit = document.createElementNS(svg.namespaceURI, 'circle');
      hit.setAttribute('cx', p.x);
      hit.setAttribute('cy', p.y);
      hit.setAttribute('r', 11);
      hit.setAttribute('class', 'line-chart-dot-hit');
      hit.setAttribute('tabindex', '0');
      hit.setAttribute('role', 'img');
      hit.setAttribute('aria-label', tooltipText(p, granularity, metric));
      hit.addEventListener('pointerenter', () => showTooltip(p, i));
      hit.addEventListener('pointerdown', () => showTooltip(p, i));
      hit.addEventListener('pointerleave', hideTooltip);
      hit.addEventListener('focus', () => showTooltip(p, i));
      hit.addEventListener('blur', hideTooltip);
      svg.appendChild(hit);
    });

    chartArea.appendChild(svg);
    chartArea.appendChild(tooltip);
    container.appendChild(chartArea);

    // Draw-in animation: measure the path's real length, then animate
    // stroke-dashoffset from "fully hidden" to "fully drawn."
    const length = path.getTotalLength();
    path.style.strokeDasharray = String(length);
    path.style.strokeDashoffset = String(length);
    void path.getBoundingClientRect(); // force layout so the transition below actually runs
    path.style.transition = 'stroke-dashoffset 900ms cubic-bezier(.16,.84,.32,1)';
    path.style.strokeDashoffset = '0';

    area.style.opacity = '0';
    area.style.transition = 'opacity 900ms ease 250ms';
    requestAnimationFrame(() => {
      area.style.opacity = '1';
    });

    // X-axis labels: a plain flex row under the SVG rather than SVG <text>,
    // since the points are evenly spaced — an equal-width flex column per
    // point lines up closely enough without any coordinate math.
    const labelsRow = document.createElement('div');
    labelsRow.className = 'line-chart-labels';
    series.forEach((s) => {
      const label = document.createElement('span');
      label.className = 'line-chart-label';
      label.textContent = shortDateLabel(s.periodStart);
      labelsRow.appendChild(label);
    });
    container.appendChild(labelsRow);
  }

  // ---------- VIP list ----------
  function renderVipList(vip) {
    const el = document.getElementById('vipList');
    el.innerHTML = '';
    if (!vip || vip.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chart-empty';
      empty.textContent = 'No punches yet — your first VIP is out there!';
      el.appendChild(empty);
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    vip.forEach((v, i) => {
      const row = document.createElement('div');
      row.className = 'vip-row';
      row.style.animationDelay = `${i * 130}ms`;

      const medal = document.createElement('span');
      medal.className = 'vip-medal';
      medal.textContent = medals[i] || '';

      const name = document.createElement('span');
      name.className = 'vip-name';
      name.textContent = v.name;

      const count = document.createElement('span');
      count.className = 'vip-count';
      count.textContent = `${v.totalCoffees} punch${v.totalCoffees === 1 ? '' : 'es'}`;

      row.append(medal, name, count);
      el.appendChild(row);
    });
  }

  let dashboardData = null;

  function renderAll() {
    if (!dashboardData) return;
    countUp(statSignups, dashboardData.totalSignups);
    countUp(statPunches, dashboardData.totalPunches);
    countUp(statPunchesToday, dashboardData.punchesToday);
    countUp(statSignupsToday, dashboardData.signupsToday);
    countUp(statRewards, dashboardData.totalRewardsEarned);
    countUp(statRepeatRate, dashboardData.repeatRatePercent, '%');

    const byLabel = dashboardData.granularity === 'day' ? 'by day' : 'by week';
    document.getElementById('punchesChartTitle').textContent = `Punches given, ${byLabel}`;
    document.getElementById('signupsChartTitle').textContent = `New sign-ups, ${byLabel}`;

    renderLineChart(
      document.getElementById('punchesLineChart'),
      dashboardData.series.punches,
      { line: 'var(--accent)', area: 'rgba(249, 157, 28, 0.18)' },
      'No punches yet.',
      dashboardData.granularity,
      { singular: 'punch', plural: 'punches' }
    );
    document.getElementById('punchesTrendNote').textContent = trendNote(dashboardData.punchesRolling7);

    renderLineChart(
      document.getElementById('signupsLineChart'),
      dashboardData.series.signups,
      { line: 'var(--brown-dark)', area: 'rgba(92, 18, 32, 0.12)' },
      'No sign-ups yet.',
      dashboardData.granularity,
      { singular: 'sign-up', plural: 'sign-ups' }
    );
    document.getElementById('signupsTrendNote').textContent = trendNote(dashboardData.signupsRolling7);

    vipTitle.textContent = `Your VIPs — ${VIP_WINDOW_LABELS[dashboardData.vipWindow] || 'All-Time'}`;
    renderVipList(dashboardData.vip);
  }

  async function loadDashboard() {
    const params = new URLSearchParams({
      granularity: filterState.granularity,
      weeks: filterState.weeks,
      days: filterState.days,
      vipWindow: filterState.vipWindow,
    });
    const res = await fetch(`/api/owner/dashboard?${params}`, { headers: { 'x-staff-pin': getPin() } });
    if (!res.ok) throw new Error('Could not load dashboard.');
    return res.json();
  }

  async function refresh() {
    dashboardData = await loadDashboard();
    renderAll();
  }

  function connectSocket() {
    const socket = io();
    // Any punch/redeem/signup/birthday event changes these numbers —
    // just refetch rather than trying to patch everything in place.
    socket.on('stats-updated', () => {
      refresh().catch(() => {});
    });
  }

  function showOwnerPanel() {
    pinPanel.style.display = 'none';
    ownerPanel.style.display = 'block';
    refresh().catch(() => {});
    connectSocket();
  }

  // Reflect saved/default filter state in the tab buttons immediately,
  // before the first fetch even resolves, so the UI doesn't flash the
  // wrong tab as "active" for a moment.
  setActiveTab(granularityTabs, 'granularity', filterState.granularity);
  renderRangeTabs();
  setActiveTab(vipTabs, 'vipWindow', filterState.vipWindow);

  granularityTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const granularity = btn.dataset.granularity;
    if (!ALLOWED_GRANULARITY.includes(granularity) || granularity === filterState.granularity) return;
    filterState.granularity = granularity;
    localStorage.setItem('ownerDashboardGranularity', granularity);
    setActiveTab(granularityTabs, 'granularity', granularity);
    renderRangeTabs();
    refresh().catch(() => {});
  });

  rangeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const range = parseInt(btn.dataset.range, 10);
    const isDay = filterState.granularity === 'day';
    const allowed = isDay ? ALLOWED_DAYS : ALLOWED_WEEKS;
    const current = isDay ? filterState.days : filterState.weeks;
    if (!allowed.includes(range) || range === current) return;
    if (isDay) {
      filterState.days = range;
      localStorage.setItem('ownerDashboardDays', String(range));
    } else {
      filterState.weeks = range;
      localStorage.setItem('ownerDashboardWeeks', String(range));
    }
    renderRangeTabs();
    refresh().catch(() => {});
  });

  vipTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const vipWindow = btn.dataset.vipWindow;
    if (!ALLOWED_VIP_WINDOWS.includes(vipWindow) || vipWindow === filterState.vipWindow) return;
    filterState.vipWindow = vipWindow;
    localStorage.setItem('ownerDashboardVipWindow', vipWindow);
    setActiveTab(vipTabs, 'vipWindow', vipWindow);
    refresh().catch(() => {});
  });

  // Dismisses whichever chart's hover tooltip is currently open when the
  // owner taps/clicks anywhere outside a chart point — the only way to
  // close a tooltip on a touchscreen, which has no "mouse moved away."
  document.addEventListener('pointerdown', (e) => {
    if (dismissActiveTooltip && !e.target.closest('.line-chart-dot-hit')) {
      dismissActiveTooltip();
    }
  });

  // Try a saved PIN first so this can be left open on the owner's own device.
  if (getPin()) {
    showOwnerPanel();
  }

  pinBtn.addEventListener('click', async () => {
    const pin = pinInput.value.trim();
    if (!pin) return;
    pinError.textContent = '';
    try {
      const res = await fetch('/api/owner/dashboard', { headers: { 'x-staff-pin': pin } });
      if (res.status === 401) {
        pinError.textContent = 'Incorrect PIN.';
        return;
      }
      localStorage.setItem('staffPin', pin);
      showOwnerPanel();
    } catch (err) {
      pinError.textContent = 'Something went wrong.';
    }
  });

  lockBtn.addEventListener('click', () => {
    localStorage.removeItem('staffPin');
    ownerPanel.style.display = 'none';
    pinPanel.style.display = 'block';
    pinInput.value = '';
  });
})();
