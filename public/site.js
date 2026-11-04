const SCENE_MS = 2800;
const FALLBACK_BOT_LINK = '/start';
const ANSWERS = [
  {
    q: 'Do I need a crypto wallet?',
    a: 'No. Only your customer needs one. You just need Telegram, and I bring everything to you there.',
  },
  {
    q: 'How do I get my money?',
    a: 'As a PhonePe gift card, delivered to you on Telegram. You add it to PhonePe and it becomes gift card balance. It does not go to your bank account.',
  },
  {
    q: 'How long is setup?',
    a: 'Three short questions on Telegram. Then I send your QR, a standee to print and a soundbox link.',
  },
  {
    q: 'What if a payment fails?',
    a: 'The customer sees a clear screen with a reference, and I alert you on Telegram straight away. Refunds are handled by hand for now.',
  },
  {
    q: 'Can someone overspend?',
    a: 'Every shop has limits. By default, anything over ₹500 needs your approval, and sales stop at ₹2,000 a day. You can change them in chat.',
  },
];

function startDemo() {
  const scenes = [...document.querySelectorAll('.scene')];
  const caption = document.getElementById('demo-caption');
  if (!scenes.length) return;

  let current = 0;
  const show = (index) => {
    scenes.forEach((scene, position) => scene.classList.toggle('is-on', position === index));
    caption.textContent = scenes[index].dataset.caption;
  };
  show(0);

  // People who ask for less motion get the last scene, which shows the end result.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    show(scenes.length - 1);
    return;
  }
  setInterval(() => {
    current = (current + 1) % scenes.length;
    show(current);
  }, SCENE_MS);
}

async function connectBotLinks() {
  try {
    const { url } = await (await fetch('/api/bot')).json();
    if (!url) return;
    document.querySelectorAll('[data-bot-link]').forEach((link) => {
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
    });
    const qr = document.getElementById('bot-qr');
    if (qr) {
      qr.src = '/bot-qr.png';
      qr.hidden = false;
    }
  } catch {
    // The links keep pointing at the start page, which still explains the steps.
  }
}

function buildAskSikku() {
  const panel = document.createElement('div');
  panel.className = 'ask-panel';
  panel.hidden = true;
  panel.setAttribute('aria-live', 'polite');

  const toggle = document.createElement('button');
  toggle.className = 'ask-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  const face = document.createElement('img');
  face.src = '/mascot/wave.svg';
  face.alt = '';
  const label = document.createElement('span');
  label.className = 'ask-label';
  label.textContent = 'Ask Sikku';
  toggle.setAttribute('aria-label', 'Ask Sikku');
  toggle.append(face, label);

  const addMessage = (text, fromYou) => {
    const message = document.createElement('p');
    message.className = fromYou ? 'ask-msg is-you' : 'ask-msg';
    message.textContent = text;
    panel.insertBefore(message, chips);
    panel.scrollTop = panel.scrollHeight;
  };

  const chips = document.createElement('div');
  chips.className = 'ask-chips';
  for (const { q, a } of ANSWERS) {
    const chip = document.createElement('button');
    chip.textContent = q;
    chip.addEventListener('click', () => {
      addMessage(q, true);
      addMessage(a, false);
    });
    chips.append(chip);
  }
  panel.append(chips);
  addMessage('Namaste! I’m Sikku. What would you like to know?', false);

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  document.body.append(panel, toggle);
}

document.querySelectorAll('[data-bot-link]').forEach((link) => {
  link.href = FALLBACK_BOT_LINK;
});
startDemo();
connectBotLinks();
buildAskSikku();
