(function () {
  document.getElementById('shopName').textContent = window.SHOP_CONFIG.name;
  document.getElementById('shopTagline').textContent = window.SHOP_CONFIG.tagline;

  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || localStorage.getItem('punchCardToken');

  if (!token) {
    window.location.href = 'index.html';
    return;
  }
  localStorage.setItem('punchCardToken', token);

  const cardEl = document.getElementById('card');
  const grid = document.getElementById('punchGrid');
  const statusLine = document.getElementById('statusLine');
  const rewardBanner = document.getElementById('rewardBanner');
  const contactLine = document.getElementById('contactLine');
  const switchLink = document.getElementById('switchLink');

  switchLink.addEventListener('click', () => {
    localStorage.removeItem('punchCardToken');
    window.location.href = 'index.html';
  });

  // iOS/Safari require a user gesture before audio can play — unlock on first tap.
  document.body.addEventListener('click', () => window.PunchSounds.unlock(), { once: true });
  document.body.addEventListener('touchstart', () => window.PunchSounds.unlock(), { once: true });

  let state = null;
  let qr = null;

  function renderGrid(punchesNeeded) {
    grid.innerHTML = '';
    for (let i = 0; i < punchesNeeded; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.index = i;
      grid.appendChild(slot);
    }
  }

  function updateSlots(punches) {
    const slots = grid.querySelectorAll('.slot');
    slots.forEach((slot, i) => {
      slot.classList.toggle('filled', i < punches);
      slot.textContent = i < punches ? '☕' : '';
    });
  }

  function renderQR() {
    document.getElementById('qrcode').innerHTML = '';
    // eslint-disable-next-line no-undef
    qr = new QRCode(document.getElementById('qrcode'), {
      text: token,
      width: 160,
      height: 160,
      colorDark: '#4a3218',
      colorLight: '#ffffff',
    });
  }

  function renderContact(c) {
    contactLine.textContent = c.email || c.phone || '';
  }

  function renderStatus(c) {
    if (c.freeRewards > 0) {
      statusLine.textContent = `${c.freeRewards} free coffee${c.freeRewards > 1 ? 's' : ''} ready to redeem!`;
    } else {
      statusLine.textContent = `${c.punches} / ${c.punchesNeeded} punches`;
    }
    rewardBanner.classList.toggle('show', c.freeRewards > 0);
  }

  function animatePunch(newPunchIndex) {
    const slots = grid.querySelectorAll('.slot');
    const target = slots[newPunchIndex];
    if (!target) return;

    const gridRect = grid.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();

    const stamp = document.createElement('div');
    stamp.className = 'stamp animate';
    stamp.textContent = '☕';
    stamp.style.left = `${targetRect.left - gridRect.left + targetRect.width / 2}px`;
    stamp.style.top = `${targetRect.top - gridRect.top}px`;
    grid.style.position = 'relative';
    grid.appendChild(stamp);

    window.PunchSounds.playPunch();
    cardEl.classList.remove('shake');
    void cardEl.offsetWidth; // restart animation
    cardEl.classList.add('shake');

    setTimeout(() => {
      target.classList.add('filled', 'pop');
      target.textContent = '☕';
    }, 380);

    setTimeout(() => stamp.remove(), 600);
  }

  function celebrateReward() {
    window.PunchSounds.playReward();
    if (window.confetti) {
      confetti({ particleCount: 120, spread: 80, origin: { y: 0.4 } });
    }
  }

  async function loadCustomer() {
    const res = await fetch(`/api/customer/${encodeURIComponent(token)}`);
    if (!res.ok) {
      localStorage.removeItem('punchCardToken');
      window.location.href = 'index.html';
      return;
    }
    state = await res.json();
    renderGrid(state.punchesNeeded);
    updateSlots(state.punches);
    renderStatus(state);
    renderContact(state);
    renderQR();
  }

  function connectSocket() {
    const socket = io();
    socket.on('connect', () => socket.emit('join', token));

    socket.on('punch-added', (payload) => {
      const priorPunches = state ? state.punches : 0;
      const wasRewardRun = payload.rewardEarned;

      // If this punch triggered a reward, the counter has already rolled
      // back to 0 server-side — animate into the final (10th) slot first.
      const indexToAnimate = wasRewardRun ? payload.punchesNeeded - 1 : payload.punches - 1;
      animatePunch(indexToAnimate);

      state = payload;
      setTimeout(() => {
        renderStatus(state);
        if (wasRewardRun) {
          updateSlots(0);
          celebrateReward();
        } else {
          updateSlots(state.punches);
        }
      }, 420);
    });

    socket.on('reward-redeemed', (payload) => {
      state = payload;
      renderStatus(state);
      updateSlots(state.punches);
    });
  }

  loadCustomer().then(connectSocket);
})();
