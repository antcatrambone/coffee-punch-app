(function () {
  document.getElementById('shopName').textContent = '☕ ' + window.SHOP_CONFIG.name + ' — Staff';

  const pinPanel = document.getElementById('pinPanel');
  const scanPanel = document.getElementById('scanPanel');
  const pinInput = document.getElementById('pin');
  const pinBtn = document.getElementById('pinBtn');
  const pinError = document.getElementById('pinError');
  const lockBtn = document.getElementById('lockBtn');

  const contactInput = document.getElementById('contact');
  const lookupBtn = document.getElementById('lookupBtn');
  const resultCard = document.getElementById('resultCard');
  const resultName = document.getElementById('resultName');
  const resultStatus = document.getElementById('resultStatus');
  const punchBtn = document.getElementById('punchBtn');
  const redeemBtn = document.getElementById('redeemBtn');
  const staffStatus = document.getElementById('staffStatus');

  let currentCustomer = null;
  let scanner = null;
  let scanCooldown = false;

  function getPin() {
    return localStorage.getItem('staffPin') || '';
  }

  function showScanPanel() {
    pinPanel.style.display = 'none';
    scanPanel.style.display = 'block';
    startScanner();
  }

  // Try a saved PIN first so staff don't have to re-enter it every shift.
  if (getPin()) {
    showScanPanel();
  }

  pinBtn.addEventListener('click', async () => {
    const pin = pinInput.value.trim();
    if (!pin) return;
    pinError.textContent = '';
    // Validate by attempting a harmless lookup call.
    const res = await fetch('/api/staff/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: '__pin_check__', pin }),
    });
    if (res.status === 401) {
      pinError.textContent = 'Incorrect PIN.';
      return;
    }
    localStorage.setItem('staffPin', pin);
    showScanPanel();
  });

  lockBtn.addEventListener('click', () => {
    localStorage.removeItem('staffPin');
    if (scanner) scanner.stop().catch(() => {});
    scanPanel.style.display = 'none';
    pinPanel.style.display = 'block';
    pinInput.value = '';
    resultCard.classList.remove('show');
  });

  function setStatus(msg, isError) {
    staffStatus.textContent = msg;
    staffStatus.style.color = isError ? '#ffb4b4' : '';
  }

  async function showCustomer(customer) {
    currentCustomer = customer;
    resultName.textContent = customer.email || customer.phone || 'Customer';
    resultStatus.textContent = customer.freeRewards > 0
      ? `${customer.freeRewards} free coffee ready · ${customer.punches}/${customer.punchesNeeded} punches toward next`
      : `${customer.punches}/${customer.punchesNeeded} punches`;
    redeemBtn.disabled = customer.freeRewards <= 0;
    resultCard.classList.add('show');
  }

  async function fetchByToken(token) {
    const res = await fetch(`/api/customer/${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error('No card matches that QR code.');
    return res.json();
  }

  lookupBtn.addEventListener('click', async () => {
    const contact = contactInput.value.trim();
    if (!contact) return;
    setStatus('Looking up…');
    try {
      const res = await fetch('/api/staff/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact, pin: getPin() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await showCustomer(data);
      setStatus('');
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  punchBtn.addEventListener('click', async () => {
    if (!currentCustomer) return;
    setStatus('Adding punch…');
    try {
      const res = await fetch('/api/staff/punch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: currentCustomer.token, pin: getPin() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await showCustomer(data);
      setStatus(data.rewardEarned ? '🎉 Free coffee unlocked for this customer!' : 'Punch added.');
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  redeemBtn.addEventListener('click', async () => {
    if (!currentCustomer) return;
    setStatus('Redeeming…');
    try {
      const res = await fetch('/api/staff/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: currentCustomer.token, pin: getPin() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await showCustomer(data);
      setStatus('Free coffee redeemed.');
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  function startScanner() {
    // eslint-disable-next-line no-undef
    scanner = new Html5Qrcode('reader');
    scanner
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        async (decodedText) => {
          if (scanCooldown) return;
          scanCooldown = true;
          setTimeout(() => (scanCooldown = false), 2000);
          try {
            const customer = await fetchByToken(decodedText.trim());
            await showCustomer(customer);
            setStatus('Card found — tap "Add punch" to confirm.');
          } catch (err) {
            setStatus(err.message, true);
          }
        },
        () => {} // ignore per-frame scan failures
      )
      .catch((err) => {
        setStatus('Could not start camera: ' + err, true);
      });
  }
})();
