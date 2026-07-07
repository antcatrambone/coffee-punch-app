(function () {
  document.getElementById('shopName').textContent = window.SHOP_CONFIG.name + ' — Stats';

  const pinPanel = document.getElementById('pinPanel');
  const statsPanel = document.getElementById('statsPanel');
  const pinInput = document.getElementById('pin');
  const pinBtn = document.getElementById('pinBtn');
  const pinError = document.getElementById('pinError');
  const lockBtn = document.getElementById('lockBtn');

  const tiles = {
    totalPunches: document.getElementById('statPunches'),
    totalRedeemed: document.getElementById('statRedeemed'),
    totalCustomers: document.getElementById('statCustomers'),
    outstandingRewards: document.getElementById('statOutstanding'),
  };

  function getPin() {
    return localStorage.getItem('staffPin') || '';
  }

  function animateTo(el, value) {
    if (el.textContent !== String(value)) {
      el.textContent = value;
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    }
  }

  function renderStats(stats) {
    animateTo(tiles.totalPunches, stats.totalPunches);
    animateTo(tiles.totalRedeemed, stats.totalRedeemed);
    animateTo(tiles.totalCustomers, stats.totalCustomers);
    animateTo(tiles.outstandingRewards, stats.outstandingRewards);
  }

  async function loadStats() {
    const res = await fetch('/api/stats', { headers: { 'x-staff-pin': getPin() } });
    if (!res.ok) throw new Error('Could not load stats.');
    return res.json();
  }

  function connectSocket() {
    const socket = io();
    socket.on('stats-updated', renderStats);
  }

  function showStatsPanel() {
    pinPanel.style.display = 'none';
    statsPanel.style.display = 'block';
    loadStats().then(renderStats).catch(() => {});
    connectSocket();
  }

  // Try a saved PIN first so this can be left open on a shop tablet.
  if (getPin()) {
    showStatsPanel();
  }

  pinBtn.addEventListener('click', async () => {
    const pin = pinInput.value.trim();
    if (!pin) return;
    pinError.textContent = '';
    try {
      const res = await fetch('/api/stats', { headers: { 'x-staff-pin': pin } });
      if (res.status === 401) {
        pinError.textContent = 'Incorrect PIN.';
        return;
      }
      localStorage.setItem('staffPin', pin);
      showStatsPanel();
    } catch (err) {
      pinError.textContent = 'Something went wrong.';
    }
  });

  lockBtn.addEventListener('click', () => {
    localStorage.removeItem('staffPin');
    statsPanel.style.display = 'none';
    pinPanel.style.display = 'block';
    pinInput.value = '';
  });
})();
