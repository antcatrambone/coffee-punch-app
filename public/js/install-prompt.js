// "Add to Home Screen" prompt for the punch card page.
//
// There is no single cross-platform API for this — Chrome/Android expose
// a real `beforeinstallprompt` event you can trigger programmatically;
// iOS Safari exposes nothing at all, so the only thing that works there is
// telling the customer to use the Share button themselves. This file
// handles both, plus a persistent low-key link that's always available
// (not just a one-time popup that's easy to miss).
(function () {
  const banner = document.getElementById('installBanner');
  const bannerText = document.getElementById('installBannerText');
  const installBtn = document.getElementById('installBtn');
  const dismissBtn = document.getElementById('installDismissBtn');
  const persistentLink = document.getElementById('addToHomeScreenLink');
  const iosOverlay = document.getElementById('iosInstallOverlay');
  const iosOverlayCloseBtn = document.getElementById('iosInstallOverlayClose');

  // This script is shared by pages that may not have this markup (kept
  // defensive rather than assuming every page that includes it has all
  // these elements).
  if (!persistentLink) return;

  // Already installed and running as a standalone app? Nothing to do —
  // `navigator.standalone` is the iOS-specific equivalent of the
  // `display-mode` media query, which iOS doesn't support.
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isStandalone) return;

  const ua = window.navigator.userAgent;
  // iPadOS 13+ Safari reports itself as a Mac, so the user-agent alone
  // misses every modern iPad — a "Mac" with a touchscreen is an iPad.
  const isIos =
    /iphone|ipad|ipod/i.test(ua) ||
    (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
  const isAndroid = /android/i.test(ua);
  // Instagram/Facebook/Line/etc. open links in an embedded browser that
  // can't install anything — the visitor has to reopen the page in a real
  // browser first.
  const isInAppBrowser = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|; wv\)/i.test(ua);
  const params = new URLSearchParams(window.location.search);
  const isNewSignup = params.get('new') === '1';
  const DISMISS_KEY = 'installPromptDismissed';

  let deferredPrompt = null;

  function showBanner(text) {
    if (bannerText && text) bannerText.textContent = text;
    if (banner) banner.classList.add('show');
  }

  function hideBanner() {
    if (banner) banner.classList.remove('show');
  }

  function showIosOverlay() {
    if (iosOverlay) iosOverlay.classList.add('show');
  }

  function hideIosOverlay() {
    if (iosOverlay) iosOverlay.classList.remove('show');
  }

  // Plain-language steps for whichever device/browser this is, shown in the
  // overlay whenever there's no one-tap native install prompt to trigger.
  // Previously the non-iPhone fallthrough did nothing at all, which made the
  // "Add this card to your home screen" link look broken on Android
  // browsers without the install event, iPads, in-app browsers, and
  // desktops.
  function setOverlayContent(title, stepsHtml) {
    const titleEl = document.getElementById('installOverlayTitle');
    const stepsEl = document.getElementById('installSteps');
    if (titleEl) titleEl.textContent = title;
    if (stepsEl) stepsEl.innerHTML = stepsHtml;
  }

  function showFallbackInstructions() {
    if (isInAppBrowser) {
      setOverlayContent(
        'Open in your browser first',
        '<p>1. Tap the <strong>⋯</strong> or <strong>Share</strong> button in the corner of this screen.</p>' +
          '<p>2. Choose <strong>"Open in Safari"</strong> (iPhone) or <strong>"Open in Chrome"</strong> (Android).</p>' +
          '<p>3. Then come back to this link to add your card to your home screen.</p>'
      );
    } else if (isIos) {
      setOverlayContent(
        'Add to Home Screen',
        '<p>1. Open this page in <strong>Safari</strong> (other iPhone browsers can\'t add to the home screen).</p>' +
          '<p>2. Tap the <strong>Share</strong> icon <span class="ios-share-icon">⬆️</span> — on iPad it\'s at the top right, on iPhone at the bottom.</p>' +
          '<p>3. Scroll down, tap <strong>"Add to Home Screen,"</strong> then <strong>"Add."</strong></p>'
      );
    } else if (isAndroid) {
      setOverlayContent(
        'Add to Home Screen',
        '<p>1. Tap the <strong>⋮</strong> menu in the top corner of your browser.</p>' +
          '<p>2. Tap <strong>"Add to Home screen"</strong> or <strong>"Install app."</strong></p>' +
          '<p>3. Tap <strong>"Add"</strong> — your punch card now opens like an app!</p>'
      );
    } else {
      setOverlayContent(
        'Add to Home Screen',
        '<p>This works best on your phone. Open this same link on your phone, then use your browser\'s menu — <strong>Share</strong> on iPhone, <strong>⋮</strong> on Android — and choose <strong>"Add to Home Screen."</strong></p>' +
          '<p>On a computer, you can also just bookmark this page.</p>'
      );
    }
    showIosOverlay();
  }

  async function triggerInstall() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      hideBanner();
      return;
    }
    // No native one-tap prompt available — show device-appropriate manual
    // steps instead of silently doing nothing.
    hideBanner();
    showFallbackInstructions();
  }

  // The persistent link is always visible/clickable regardless of the
  // one-time banner's dismissed state.
  persistentLink.addEventListener('click', triggerInstall);
  if (installBtn) installBtn.addEventListener('click', triggerInstall);
  if (iosOverlayCloseBtn) iosOverlayCloseBtn.addEventListener('click', hideIosOverlay);

  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      localStorage.setItem(DISMISS_KEY, '1');
      hideBanner();
    });
  }

  // Chrome/Android: capture the browser's native install prompt so it can
  // be triggered from our own styled button instead of relying on
  // Chrome's easy-to-miss built-in mini-infobar.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (isNewSignup && localStorage.getItem(DISMISS_KEY) !== '1') {
      showBanner('Add your punch card to your home screen for one-tap access next time!');
    }
  });

  // iOS has no equivalent event — if we know it's iOS and this is a fresh
  // signup, show the banner right away rather than waiting for an event
  // that will never fire.
  if (isIos && isNewSignup && localStorage.getItem(DISMISS_KEY) !== '1') {
    showBanner('Add your punch card to your home screen for one-tap access next time!');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
