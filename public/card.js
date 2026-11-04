const HIDE_AFTER_SECONDS = 60;
const TOAST_MS = 1800;
const CLOSED_REASONS = {
  link_expired: {
    title: 'This link has closed',
    text: 'Send /cards to Sikku on Telegram to get a new link. If you already claimed this card, there is nothing more to do.',
  },
  locked: {
    title: 'This link is locked',
    text: 'Too many wrong PINs were entered. Send /cards to Sikku on Telegram to get a new link.',
  },
  no_pin: {
    title: 'Set your PIN first',
    text: 'Send /setpin to Sikku on Telegram, then open this link again.',
  },
};

const $ = (id) => document.getElementById(id);
const token = location.pathname.split('/')[2];
let enteredPin = '';
let hideTimer = null;
let toastTimer = null;

function showView(view) {
  for (const id of ['view-sealed', 'view-card', 'view-done', 'view-closed']) $(id).hidden = id !== view;
}

function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, TOAST_MS);
}

async function post(action) {
  const res = await fetch(`/api/cards/${token}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: enteredPin }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function showClosed(reason) {
  const closed = CLOSED_REASONS[reason] ?? CLOSED_REASONS.link_expired;
  $('closed-title').textContent = t(closed.title);
  $('closed-text').textContent = t(closed.text);
  showView('view-closed');
}

// Clears the code from the page, so it isn't left showing on a phone on the counter.
function reseal() {
  clearInterval(hideTimer);
  enteredPin = '';
  $('pin').value = '';
  for (const id of ['card-code', 'card-pin', 'card-instructions']) $(id).textContent = '';
  $('card-link').removeAttribute('href');
  showView('view-sealed');
}

function startHideTimer() {
  let secondsLeft = HIDE_AFTER_SECONDS;
  $('hide-timer').textContent = secondsLeft;
  hideTimer = setInterval(() => {
    secondsLeft -= 1;
    $('hide-timer').textContent = secondsLeft;
    if (secondsLeft <= 0) reseal();
  }, 1000);
}

function fillRow(rowId, valueId, value) {
  $(rowId).hidden = !value;
  $(valueId).textContent = value ?? '';
}

function showCard(card) {
  $('card-amount').textContent = `₹${card.amountInr.toLocaleString('en-IN')}`;
  $('card-shop').textContent = card.shopName;
  fillRow('row-code', 'card-code', card.code);
  fillRow('row-pin', 'card-pin', card.pin);
  const safeLink = /^https:\/\//.test(card.link ?? '');
  $('card-link').hidden = !safeLink;
  if (safeLink) $('card-link').href = card.link;
  $('card-instructions').hidden = !card.instructions;
  $('card-instructions').textContent = card.instructions ?? '';
  $('card-ref').textContent = `${t('Ref')} ${card.ref}`;
  showView('view-card');
  startHideTimer();
}

async function openCard(event) {
  event.preventDefault();
  enteredPin = $('pin').value;
  $('pin-error').hidden = true;
  $('open-card').disabled = true;
  try {
    const { status, body } = await post('reveal');
    if (body.card) {
      showCard(body.card);
    } else if (status === 401) {
      $('pin-error').textContent = t('Wrong PIN. {n} tries left.').replace('{n}', body.attemptsLeft);
      $('pin-error').hidden = false;
      $('pin').value = '';
      $('pin').focus();
    } else {
      showClosed(body.reason);
    }
  } catch {
    $('pin-error').textContent = t('Could not reach Sikka. Please try again.');
    $('pin-error').hidden = false;
  }
  $('open-card').disabled = false;
}

async function claim() {
  $('claim').disabled = true;
  $('claim-error').hidden = true;
  try {
    const { body } = await post('claim');
    if (body.ok) {
      clearInterval(hideTimer);
      enteredPin = '';
      for (const id of ['card-code', 'card-pin', 'card-instructions']) $(id).textContent = '';
      showView('view-done');
      return;
    }
    showClosed(body.reason);
  } catch {
    $('claim-error').textContent = t('Could not reach Sikka. Please try again.');
    $('claim-error').hidden = false;
    $('claim').disabled = false;
  }
}

function setUpCopy(buttonId, valueId) {
  $(buttonId).addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($(valueId).textContent);
      toast(t('Copied ✓'));
    } catch {
      toast(t('Could not copy. Please copy it by hand.'));
    }
  });
}

$('pin-form').addEventListener('submit', openCard);
$('claim').addEventListener('click', claim);
setUpCopy('copy-code', 'card-code');
setUpCopy('copy-pin', 'card-pin');
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !$('view-card').hidden) reseal();
});
