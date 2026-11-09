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
  const cardTitle = document.getElementById('cardTitle');
  const grid = document.getElementById('punchGrid');
  const statusLine = document.getElementById('statusLine');
  const rewardBanner = document.getElementById('rewardBanner');
  const rewardBadges = document.getElementById('rewardBadges');
  const rewardBannerText = document.getElementById('rewardBannerText');
  const contactLine = document.getElementById('contactLine');
  const lifetimeLine = document.getElementById('lifetimeLine');
  const switchLink = document.getElementById('switchLink');

  switchLink.addEventListener('click', () => {
    localStorage.removeItem('punchCardToken');
    window.location.href = 'index.html';
  });

  // Browsers only allow audio to play after some interaction with the page.
  // We never ask for one explicitly — instead we listen broadly so almost
  // any incidental touch (adjusting the phone, scrolling, the screen
  // simply being tapped to wake it) silently unlocks sound in the
  // background. If none of these ever fire, sound just won't play on that
  // visit — the punch animation and confetti work regardless.
  const unlockEvents = ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'click', 'keydown', 'scroll'];
  function unlockOnce() {
    window.PunchSounds.unlock();
    unlockEvents.forEach((evt) => document.removeEventListener(evt, unlockOnce));
  }
  unlockEvents.forEach((evt) => document.addEventListener(evt, unlockOnce, { passive: true }));

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
      // Transparent instead of white, so the QR sits directly on the page
      // background instead of inside a white box.
      colorLight: 'rgba(255, 255, 255, 0)',
    });
  }

  function renderCardTitle(c) {
    const title = c.firstName ? `${c.firstName}'s Punch Card` : 'My Punch Card';
    cardTitle.textContent = title;
    document.title = title;
  }

  function renderContact(c) {
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
    const contact = c.email || c.phone || '';
    contactLine.textContent = name ? `${name} · ${contact}` : contact;
  }

  function renderLifetime(c) {
    const n = c.totalCoffees || 0;
    if (n <= 0) {
      lifetimeLine.textContent = '';
      return;
    }
    lifetimeLine.textContent = `You've received ${n} punch${n === 1 ? '' : 'es'} with us!`;
  }

  // One badge per unredeemed free coffee, each showing where it came from
  // (a birthday cake, a campaign's own emoji, or the regular party emoji
  // for a plain 5-punch reward) instead of a single generic line — so a
  // customer holding more than one reward can see at a glance what each
  // one is, and staff can see it too when the card is shown at checkout.
  // Ids of rewards the customer hasn't seen before this render — their
  // badges get a short attention-grabbing pulse (see .reward-badge.is-new).
  let highlightIds = new Set();

  function renderRewardBadges(c) {
    const rewards = c.pendingRewards || [];
    rewardBadges.innerHTML = '';
    rewards.forEach((r) => {
      const badge = document.createElement('span');
      badge.className = 'reward-badge' + (highlightIds.has(String(r.id)) ? ' is-new' : '');
      badge.title = r.label || 'Free Coffee';
      badge.textContent = r.emoji || '🎉';
      rewardBadges.appendChild(badge);
    });
  }

  function renderStatus(c) {
    if (c.freeRewards > 0) {
      statusLine.textContent = `${c.freeRewards} free coffee${c.freeRewards > 1 ? 's' : ''} ready to redeem!`;
    } else {
      statusLine.textContent = `${c.punches} / ${c.punchesNeeded} punches`;
    }
    renderRewardBadges(c);
    rewardBannerText.textContent = 'Show this to staff to redeem.';
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

  // ---------- "you earned a free coffee!" celebration ----------
  // Which rewards has this customer already seen on this device? Stored
  // per card in localStorage as a list of reward ids. Anything pending that
  // isn't in that list is new — it gets a full-screen celebration so it's
  // obvious something was just earned (previously a scanned campaign QR
  // just quietly opened the card with an extra badge on it).
  const SEEN_KEY = `seenRewardIds:${token}`;

  function loadSeen() {
    try {
      const raw = localStorage.getItem(SEEN_KEY);
      return raw === null ? null : JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function saveSeen(rewards) {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify((rewards || []).map((r) => String(r.id))));
    } catch (e) {
      /* storage unavailable — worst case, celebrations just don't dedupe */
    }
  }

  function findNewRewards(rewards) {
    const list = rewards || [];
    const seen = loadSeen();
    if (seen === null) {
      // First time this device has loaded this card since celebrations
      // existed: don't replay every reward already sitting on the card —
      // only celebrate ones that were earned moments ago.
      const cutoff = Date.now() - 15 * 60 * 1000;
      return list.filter((r) => new Date(r.earnedAt).getTime() >= cutoff);
    }
    return list.filter((r) => !seen.includes(String(r.id)));
  }

  function showRewardCelebration(newRewards, opts) {
    if (!newRewards || newRewards.length === 0) return;
    const skipFx = opts && opts.skipFx;

    const overlay = document.createElement('div');
    overlay.className = 'reward-celebrate';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-live', 'polite');

    const box = document.createElement('div');
    box.className = 'reward-celebrate-card';

    const emojis = document.createElement('div');
    emojis.className = 'reward-celebrate-emojis';
    newRewards.forEach((r, i) => {
      const e = document.createElement('span');
      e.className = 'reward-celebrate-emoji';
      e.style.animationDelay = `${i * 140}ms`;
      e.textContent = r.emoji || '🎉';
      emojis.appendChild(e);
    });

    const title = document.createElement('div');
    title.className = 'reward-celebrate-title';
    title.textContent =
      newRewards.length === 1 ? 'You earned a free coffee!' : `You earned ${newRewards.length} free coffees!`;

    const labels = Array.from(new Set(newRewards.map((r) => r.label || 'Free Coffee')));
    const detail = document.createElement('div');
    detail.className = 'reward-celebrate-detail';
    detail.textContent = labels.join(' · ');

    const hint = document.createElement('div');
    hint.className = 'reward-celebrate-hint';
    hint.textContent = 'Show this card to staff to redeem it.';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reward-celebrate-btn';
    btn.textContent = 'Awesome!';

    box.append(emojis, title, detail, hint, btn);
    overlay.appendChild(box);

    let timer = null;
    function close() {
      clearTimeout(timer);
      overlay.classList.add('closing');
      setTimeout(() => overlay.remove(), 250);
    }
    btn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    timer = setTimeout(close, 9000);

    document.body.appendChild(overlay);
    if (!skipFx) celebrateReward();
  }

  function celebrateBirthday(c) {
    renderRewardBadges(c);
    rewardBannerText.textContent = `Happy birthday${c.firstName ? ', ' + c.firstName : ''}! We added a free coffee just for you.`;
    rewardBanner.classList.add('show');
    celebrateReward();
  }

  async function loadCustomer() {
    const res = await fetch(`/api/customer/${encodeURIComponent(token)}`);
    if (!res.ok) {
      localStorage.removeItem('punchCardToken');
      window.location.href = 'index.html';
      return;
    }
    state = await res.json();
    const newRewards = findNewRewards(state.pendingRewards);
    highlightIds = new Set(newRewards.map((r) => String(r.id)));
    renderCardTitle(state);
    renderGrid(state.punchesNeeded);
    updateSlots(state.punches);
    renderStatus(state);
    renderContact(state);
    renderLifetime(state);
    renderQR();
    saveSeen(state.pendingRewards);

    if (state.birthdayGranted) {
      // Give the page a moment to settle before celebrating.
      setTimeout(() => celebrateBirthday(state), 500);
    }
    if (newRewards.length > 0) {
      // The birthday celebration above already plays the sound/confetti,
      // so only add those here when it didn't.
      setTimeout(() => showRewardCelebration(newRewards, { skipFx: !!state.birthdayGranted }), 600);
    }
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
        const newRewards = findNewRewards(state.pendingRewards);
        highlightIds = new Set(newRewards.map((r) => String(r.id)));
        renderStatus(state);
        renderLifetime(state);
        saveSeen(state.pendingRewards);
        if (wasRewardRun) {
          updateSlots(0);
          celebrateReward();
        } else {
          updateSlots(state.punches);
        }
        showRewardCelebration(newRewards, { skipFx: wasRewardRun });
      }, 420);
    });

    socket.on('reward-redeemed', (payload) => {
      state = payload;
      highlightIds = new Set();
      renderStatus(state);
      saveSeen(state.pendingRewards);
      updateSlots(state.punches);
    });
  }

  loadCustomer().then(connectSocket);
})();
