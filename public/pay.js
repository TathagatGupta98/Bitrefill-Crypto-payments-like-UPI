const POLL_MS = 2000;
const TOAST_MS = 1800;
const URGENT_SECONDS = 120;
const SUCCESS = ['delivered', 'claimed'];
const FAILURES = {
  expired: {
    title: 'Time ran out',
    text: 'This payment window has ended. If you already sent USDC, show this reference to the shop.',
  },
  rejected: { title: 'Payment declined', text: 'The shop declined this payment. Nothing was charged.' },
  failed: {
    title: 'Payment not completed',
    text: 'We received your USDC but could not complete the sale. The shop has been told. Show them this reference for a refund.',
  },
};

const $ = (id) => document.getElementById(id);
const rupees = (inr) => `₹${inr.toLocaleString('en-IN')}`;
const shortAddress = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;

const slug = location.pathname.split('/')[2];
let shopName = '';
let chosenInr = null;
let countdownTimer = null;
let toastTimer = null;
let currentSale = null;
let fullAddress = '';

function show(screen) {
  for (const id of ['screen-select', 'screen-pay', 'screen-wait', 'screen-result']) {
    $(id).hidden = id !== screen;
  }
  window.scrollTo(0, 0);
}

function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, TOAST_MS);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.reason ?? 'Something went wrong'), { status: res.status });
  return body;
}

function chooseAmount(chip, { inr, approxUsdc }) {
  chosenInr = inr;
  for (const other of $('chips').children) other.classList.toggle('chip-on', other === chip);
  $('amount-value').textContent = rupees(inr);
  $('amount-value').classList.remove('is-empty');
  $('amount-sub').textContent = t('About {n} USDC').replace('{n}', Number(approxUsdc).toFixed(2));
  $('pay-button').disabled = false;
  $('pay-button').textContent = t('Pay {amount}').replace('{amount}', rupees(inr));
}

function renderChips(amounts) {
  $('chips').replaceChildren(
    ...amounts.map((amount) => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = rupees(amount.inr);
      chip.disabled = !amount.enabled;
      chip.addEventListener('click', () => chooseAmount(chip, amount));
      return chip;
    }),
  );

  const reasons = new Set(amounts.filter((amount) => !amount.enabled).map((amount) => amount.reason));
  $('chip-note').textContent = reasons.size ? `${t('Some amounts are unavailable:')} ${[...reasons].map(t).join(', ')}.` : '';
  if (amounts.every((amount) => !amount.enabled)) {
    $('amount-sub').textContent = t('Not available right now');
    $('pay-button').textContent = t('Not available right now');
  }
}

function startCountdown(expiresAt) {
  clearInterval(countdownTimer);
  const tick = () => {
    const secondsLeft = Math.max(0, Math.floor((new Date(expiresAt) - Date.now()) / 1000));
    const seconds = String(secondsLeft % 60).padStart(2, '0');
    $('countdown').textContent = `${Math.floor(secondsLeft / 60)}:${seconds}`;
    $('timer').classList.toggle('is-urgent', secondsLeft < URGENT_SECONDS);
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

function renderPay(sale) {
  fullAddress = sale.address;
  $('pay-usdc').textContent = sale.usdc;
  $('pay-inr').textContent = sale.amountInr.toLocaleString('en-IN');
  $('open-wallet').href = sale.eip681;
  $('copy-amount-value').textContent = sale.usdc;
  $('copy-address-value').textContent = shortAddress(sale.address);
  $('pay-qr').src = `/api/sales/${sale.id}/qr.png`;
  $('dev-tools').hidden = !sale.devMode;
  $('change-amount').href = `/pay/${slug}`;
  startCountdown(sale.expiresAt);
  show('screen-pay');
}

function renderWait(sale, { text, sub, showSteps }) {
  $('wait-text').textContent = t(text);
  $('wait-sub').textContent = sub ? t(sub) : '';
  $('wait-steps').hidden = !showSteps;
  $('wait-mascot').src = showSteps ? '/mascot/happy.svg' : '/mascot/think.svg';
  $('wait-ref').textContent = `${t('Ref')} ${sale.ref}`;
  show('screen-wait');
}

function renderResult(sale) {
  const success = SUCCESS.includes(sale.status);
  const failure = FAILURES[sale.status];
  $('screen-result').className = `result ${success ? 'result-ok' : 'result-bad'}`;
  $('result-mascot').src = success ? '/mascot/happy.svg' : '/mascot/oops.svg';
  $('result-title').textContent = success ? t('Paid {amount}').replace('{amount}', rupees(sale.amountInr)) : t(failure.title);
  $('result-text').textContent = success ? t('to {shop}').replace('{shop}', shopName) : t(failure.text);
  $('result-ref').textContent = sale.ref;
  $('result-time-row').hidden = !success;
  $('result-time').textContent = success ? new Date(sale.deliveredAt).toLocaleString('en-IN') : '';
  $('result-tx-row').hidden = !sale.explorerUrl;
  if (sale.explorerUrl) $('result-tx').href = sale.explorerUrl;
  $('result-again').href = `/pay/${slug}`;
  document.querySelector('meta[name="theme-color"]').content = success ? '#0a7d4f' : '#b5352a';
  if (success) navigator.vibrate?.(80);
  show('screen-result');
}

// Returns true once the sale can't change any more, so polling can stop.
function renderSale(sale) {
  currentSale = sale;
  if (sale.status === 'awaiting_approval') {
    renderWait(sale, {
      text: 'Waiting for the shop to approve…',
      sub: 'This amount is over the shop’s limit. No need to pay yet.',
      showSteps: false,
    });
  } else if (sale.status === 'awaiting_payment') {
    if ($('screen-pay').hidden) renderPay(sale);
  } else if (sale.status === 'paid' || sale.status === 'purchasing') {
    renderWait(sale, { text: 'Payment received ✓ — finishing up…', sub: '', showSteps: true });
  } else {
    renderResult(sale);
    return true;
  }
  return false;
}

async function poll(saleId) {
  try {
    if (renderSale(await api(`/api/sales/${saleId}`))) {
      clearInterval(countdownTimer);
      return;
    }
  } catch (err) {
    // A bad connection shouldn't lose the sale, so keep polling. Only a missing sale ends it.
    if (err.status === 404) {
      location.replace(`/pay/${slug}`);
      return;
    }
  }
  setTimeout(() => poll(saleId), POLL_MS);
}

async function startPayment() {
  const label = $('pay-button').textContent;
  $('pay-button').disabled = true;
  $('pay-button').textContent = t('Preparing…');
  $('select-error').hidden = true;
  try {
    const sale = await api('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, amountInr: chosenInr }),
    });
    // Mobile browsers often reload the tab after a trip to the wallet app, so the URL keeps the sale.
    history.replaceState(null, '', `/pay/${slug}?sale=${sale.id}`);
    renderSale(sale);
    setTimeout(() => poll(sale.id), POLL_MS);
  } catch (err) {
    $('select-error').textContent = t(err.message);
    $('select-error').hidden = false;
    $('pay-button').disabled = false;
    $('pay-button').textContent = label;
  }
}

function setUpCopy(buttonId, label, getValue) {
  $(buttonId).addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getValue());
      toast(t(`${label} copied ✓`));
    } catch {
      toast(t('Could not copy. Please copy it by hand.'));
    }
  });
}

async function start() {
  $('pay-button').addEventListener('click', startPayment);
  $('simulate').addEventListener('click', () => {
    $('simulate').disabled = true;
    api(`/api/dev/sales/${currentSale.id}/mark-paid`, { method: 'POST' }).catch((err) => {
      $('simulate').disabled = false;
      toast(err.message);
    });
  });
  setUpCopy('copy-amount', 'Amount', () => $('copy-amount-value').textContent);
  setUpCopy('copy-address', 'Address', () => fullAddress);

  let shop;
  try {
    shop = await api(`/api/shops/${slug}`);
  } catch (err) {
    $('shop-name').textContent = t(err.status === 404 ? 'Shop not found' : 'Could not load this shop. Please try again.');
    return;
  }

  shopName = shop.name;
  document.title = `Pay ${shop.name}`;
  $('shop-name').textContent = shop.name;
  $('shop-avatar').textContent = shop.name.trim().charAt(0).toUpperCase();
  $('shop-verified').hidden = !shop.verified;

  const saleId = new URLSearchParams(location.search).get('sale');
  if (saleId) {
    poll(saleId);
    return;
  }
  renderChips(shop.amounts);
  show('screen-select');
}

start();
