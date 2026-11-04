const POLL_MS = 2000;
const SUCCESS = ['delivered', 'claimed'];
const FAILURES = {
  expired: {
    title: 'Payment window ended',
    text: 'This sale has expired. If you already sent USDC, show this reference to the shop.',
  },
  rejected: { title: 'Payment declined', text: 'The shop declined this payment. Nothing was charged.' },
  failed: {
    title: 'Payment not completed',
    text: 'We received your USDC but could not complete the sale. The shop has been told. Show them this reference for a refund.',
  },
};

const $ = (id) => document.getElementById(id);
const rupees = (inr) => `₹${inr.toLocaleString('en-IN')}`;

const slug = location.pathname.split('/')[2];
let shopName = '';
let chosenInr = null;
let countdownTimer = null;
let currentSale = null;

function show(screen) {
  for (const id of ['screen-select', 'screen-pay', 'screen-wait', 'screen-result']) {
    $(id).hidden = id !== screen;
  }
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.reason ?? 'Something went wrong'), { status: res.status });
  return body;
}

function renderChips(amounts) {
  $('chips').replaceChildren(
    ...amounts.map(({ inr, enabled }) => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = rupees(inr);
      chip.disabled = !enabled;
      chip.addEventListener('click', () => {
        chosenInr = inr;
        for (const other of $('chips').children) other.classList.toggle('chip-on', other === chip);
        $('pay-button').disabled = false;
        $('pay-button').textContent = `Pay ${rupees(inr)}`;
      });
      return chip;
    }),
  );

  const reasons = new Set(amounts.filter((amount) => !amount.enabled).map((amount) => amount.reason));
  $('chip-note').textContent = reasons.size ? `Some amounts are off: ${[...reasons].join(', ')}.` : '';
  if (amounts.every((amount) => !amount.enabled)) {
    $('pay-button').textContent = 'Not available right now';
  }
}

function startCountdown(expiresAt) {
  clearInterval(countdownTimer);
  const tick = () => {
    const secondsLeft = Math.max(0, Math.floor((new Date(expiresAt) - Date.now()) / 1000));
    const seconds = String(secondsLeft % 60).padStart(2, '0');
    $('countdown').textContent = `${Math.floor(secondsLeft / 60)}:${seconds}`;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

function renderPay(sale) {
  $('pay-usdc').textContent = sale.usdc;
  $('pay-inr').textContent = sale.amountInr.toLocaleString('en-IN');
  $('open-wallet').href = sale.eip681;
  $('copy-amount-value').textContent = sale.usdc;
  $('copy-address-value').textContent = sale.address;
  $('pay-qr').src = `/api/sales/${sale.id}/qr.png`;
  $('simulate').hidden = !sale.devMode;
  startCountdown(sale.expiresAt);
  show('screen-pay');
}

function renderWait(text, sale) {
  $('wait-text').textContent = text;
  $('wait-ref').textContent = `Ref ${sale.ref}`;
  show('screen-wait');
}

function renderResult(sale) {
  const success = SUCCESS.includes(sale.status);
  const failure = FAILURES[sale.status];
  $('screen-result').className = `result ${success ? 'result-ok' : 'result-bad'}`;
  $('result-icon').textContent = success ? '✓' : '✕';
  $('result-title').textContent = success ? `Paid ✓ ${rupees(sale.amountInr)}` : failure.title;
  $('result-text').textContent = success ? `to ${shopName}` : failure.text;
  $('result-ref').textContent = `Ref ${sale.ref}`;
  $('result-time').textContent = success ? new Date(sale.deliveredAt).toLocaleString('en-IN') : '';
  $('result-again').href = `/pay/${slug}`;
  show('screen-result');
}

// Returns true once the sale can't change any more, so polling can stop.
function renderSale(sale) {
  currentSale = sale;
  if (sale.status === 'awaiting_approval') {
    renderWait('Waiting for the shop to approve…', sale);
  } else if (sale.status === 'awaiting_payment') {
    if ($('screen-pay').hidden) renderPay(sale);
  } else if (sale.status === 'paid' || sale.status === 'purchasing') {
    renderWait('Payment received ✓ — finishing up…', sale);
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
  $('pay-button').disabled = true;
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
    $('select-error').textContent = err.message;
    $('select-error').hidden = false;
    $('pay-button').disabled = false;
  }
}

function setUpCopy(buttonId, valueId) {
  const action = $(buttonId).querySelector('.copy-action');
  $(buttonId).addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($(valueId).textContent);
      action.textContent = 'Copied ✓';
    } catch {
      action.textContent = 'Copy failed';
    }
    setTimeout(() => {
      action.textContent = 'Copy';
    }, 2000);
  });
}

async function start() {
  $('pay-button').addEventListener('click', startPayment);
  $('simulate').addEventListener('click', () => {
    api(`/api/dev/sales/${currentSale.id}/mark-paid`, { method: 'POST' }).catch((err) => alert(err.message));
  });
  setUpCopy('copy-amount', 'copy-amount-value');
  setUpCopy('copy-address', 'copy-address-value');

  let shop;
  try {
    shop = await api(`/api/shops/${slug}`);
  } catch (err) {
    $('shop-name').textContent = err.status === 404 ? 'Shop not found' : 'Could not load this shop. Please try again.';
    return;
  }

  shopName = shop.name;
  document.title = `Pay ${shop.name}`;
  $('shop-name').textContent = shop.name;
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
