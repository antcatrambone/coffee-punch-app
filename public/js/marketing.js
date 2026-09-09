(function () {
  document.getElementById('shopName').textContent = window.SHOP_CONFIG.name + ' — Marketing & Customer Lists';

  const pinPanel = document.getElementById('pinPanel');
  const marketingPanel = document.getElementById('marketingPanel');
  const pinInput = document.getElementById('pin');
  const pinBtn = document.getElementById('pinBtn');
  const pinError = document.getElementById('pinError');
  const lockBtn = document.getElementById('lockBtn');

  const includeNonOptedInCheckbox = document.getElementById('includeNonOptedIn');
  const segmentGrid = document.getElementById('segmentGrid');
  const previewPanel = document.getElementById('previewPanel');
  const previewTitle = document.getElementById('previewTitle');
  const previewDescription = document.getElementById('previewDescription');
  const previewTableBody = document.getElementById('previewTableBody');
  const previewTable = document.getElementById('previewTable');
  const previewEmpty = document.getElementById('previewEmpty');
  const exportBtn = document.getElementById('exportBtn');
  const closePreviewBtn = document.getElementById('closePreviewBtn');

  let activeSegmentId = null;

  function getPin() {
    return localStorage.getItem('staffPin') || '';
  }

  function includeNonOptedIn() {
    return includeNonOptedInCheckbox.checked;
  }

  // ---------- segment cards ----------
  function renderSegments(segments) {
    segmentGrid.innerHTML = '';
    segments.forEach((seg, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'segment-card';
      card.style.animationDelay = `${i * 60}ms`;

      const count = document.createElement('div');
      count.className = 'segment-count';
      count.textContent = seg.count;

      const label = document.createElement('div');
      label.className = 'segment-label';
      label.textContent = seg.label;

      const desc = document.createElement('div');
      desc.className = 'segment-description';
      desc.textContent = seg.description;

      card.append(count, label, desc);
      card.addEventListener('click', () => loadPreview(seg.id, seg.label, seg.description));
      segmentGrid.appendChild(card);
    });
  }

  async function loadSegments() {
    const params = new URLSearchParams({ includeNonOptedIn: includeNonOptedIn() });
    const res = await fetch(`/api/owner/marketing/segments?${params}`, { headers: { 'x-staff-pin': getPin() } });
    if (!res.ok) throw new Error('Could not load segments.');
    const data = await res.json();
    renderSegments(data.segments);
  }

  // ---------- preview table ----------
  function renderPreviewTable(customers) {
    previewTableBody.innerHTML = '';
    const hasRows = customers.length > 0;
    previewTable.style.display = hasRows ? 'table' : 'none';
    previewEmpty.style.display = hasRows ? 'none' : 'block';

    customers.forEach((c) => {
      const row = document.createElement('tr');

      const name = document.createElement('td');
      name.textContent = [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';

      const email = document.createElement('td');
      email.textContent = c.email || '—';

      const phone = document.createElement('td');
      phone.textContent = c.phone || '—';

      const optedIn = document.createElement('td');
      optedIn.textContent = c.marketingOptIn ? 'Yes' : 'No';

      const joined = document.createElement('td');
      joined.textContent = c.joinedAt ? new Date(c.joinedAt).toLocaleDateString() : '—';

      const detail = document.createElement('td');
      detail.textContent = c.detail || '—';

      row.append(name, email, phone, optedIn, joined, detail);
      previewTableBody.appendChild(row);
    });
  }

  async function loadPreview(segmentId, label, description) {
    activeSegmentId = segmentId;
    previewTitle.textContent = label;
    previewDescription.textContent = description;
    previewPanel.style.display = 'block';
    segmentGrid.style.display = 'none';
    previewTableBody.innerHTML = '';

    const params = new URLSearchParams({ includeNonOptedIn: includeNonOptedIn() });
    const res = await fetch(`/api/owner/marketing/segments/${segmentId}/customers?${params}`, {
      headers: { 'x-staff-pin': getPin() },
    });
    if (!res.ok) return;
    const data = await res.json();
    renderPreviewTable(data.customers);
  }

  function closePreview() {
    previewPanel.style.display = 'none';
    segmentGrid.style.display = 'grid';
    activeSegmentId = null;
  }

  // ---------- CSV export ----------
  // Fetched with the same auth header as everything else (rather than a
  // plain link with the PIN in the URL), then turned into a client-side
  // download — keeps the staff PIN out of the URL/browser history/server
  // access logs.
  async function exportCsv() {
    if (!activeSegmentId) return;
    const originalText = exportBtn.textContent;
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting…';
    try {
      const params = new URLSearchParams({ includeNonOptedIn: includeNonOptedIn() });
      const res = await fetch(`/api/owner/marketing/segments/${activeSegmentId}/export?${params}`, {
        headers: { 'x-staff-pin': getPin() },
      });
      if (!res.ok) throw new Error('Export failed.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${activeSegmentId}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Could not export this list. Please try again.');
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = originalText;
    }
  }

  async function refresh() {
    closePreview();
    await loadSegments();
  }

  function showMarketingPanel() {
    pinPanel.style.display = 'none';
    marketingPanel.style.display = 'block';
    refresh().catch(() => {});
  }

  if (getPin()) {
    showMarketingPanel();
  }

  pinBtn.addEventListener('click', async () => {
    const pin = pinInput.value.trim();
    if (!pin) return;
    pinError.textContent = '';
    try {
      const res = await fetch('/api/owner/marketing/segments', { headers: { 'x-staff-pin': pin } });
      if (res.status === 401) {
        pinError.textContent = 'Incorrect PIN.';
        return;
      }
      localStorage.setItem('staffPin', pin);
      showMarketingPanel();
    } catch (err) {
      pinError.textContent = 'Something went wrong.';
    }
  });

  includeNonOptedInCheckbox.addEventListener('change', () => {
    refresh().catch(() => {});
  });

  closePreviewBtn.addEventListener('click', closePreview);
  exportBtn.addEventListener('click', exportCsv);

  lockBtn.addEventListener('click', () => {
    localStorage.removeItem('staffPin');
    marketingPanel.style.display = 'none';
    pinPanel.style.display = 'block';
    pinInput.value = '';
  });
})();
