import { markCardClaimed, notifyOwner } from './bot.js';
import { config } from './config.js';
import {
  getSaleByRevealHash,
  getShopById,
  logEvent,
  plainCardSales,
  saleRef,
  sealPlainCard,
  sqlTime,
  transition,
} from './db.js';
import { hashSecret, newSecret, openCard, sealCard, verifyPin } from './vault.js';

const LINK_TTL_MS = 24 * 60 * 60_000;
const MAX_PIN_ATTEMPTS = 5;

// Each new link replaces the last one, so a resend also cancels any older link.
export function issueRevealLink(sale) {
  const secret = newSecret();
  transition(sale.id, 'delivered', 'delivered', {
    reveal_token_hash: hashSecret(secret),
    reveal_expires_at: sqlTime(new Date(Date.now() + LINK_TTL_MS)),
    reveal_attempts: 0,
  });
  return `${config.PUBLIC_URL}/card/${secret}`;
}

// Returns { sale, shop } if the link and PIN are good, or { status, reason } if not.
function unlock(token, pin) {
  const sale = typeof token === 'string' ? getSaleByRevealHash(hashSecret(token)) : null;
  if (!sale || sale.status !== 'delivered' || sale.reveal_expires_at <= sqlTime()) {
    return { status: 410, reason: 'link_expired' };
  }

  const shop = getShopById(sale.shop_id);
  if (!shop.pin_hash) return { status: 409, reason: 'no_pin' };
  if (typeof pin === 'string' && /^\d{4}$/.test(pin) && verifyPin(pin, shop.pin_hash)) return { sale, shop };

  const attempts = sale.reveal_attempts + 1;
  if (attempts < MAX_PIN_ATTEMPTS) {
    transition(sale.id, 'delivered', 'delivered', { reveal_attempts: attempts });
    logEvent(sale.id, 'pin_failed', `Wrong PIN, attempt ${attempts} of ${MAX_PIN_ATTEMPTS}`);
    return { status: 401, reason: 'wrong_pin', attemptsLeft: MAX_PIN_ATTEMPTS - attempts };
  }

  transition(sale.id, 'delivered', 'delivered', { reveal_token_hash: null, reveal_attempts: 0 });
  logEvent(sale.id, 'link_locked', `Link locked after ${MAX_PIN_ATTEMPTS} wrong PINs`);
  notifyOwner(
    shop,
    `⚠️ ${saleRef(sale.id)}: गलत PIN कई बार डाला गया, इसलिए लिंक बंद कर दिया गया। नया लिंक: /cards`,
    `⚠️ ${saleRef(sale.id)}: too many wrong PINs, so this link was locked. Get a new one with /cards.`,
  );
  return { status: 423, reason: 'locked' };
}

export function revealCard(token, pin) {
  const { sale, shop, status, reason, attemptsLeft } = unlock(token, pin);
  if (!sale) return { status, reason, attemptsLeft };

  transition(sale.id, 'delivered', 'delivered', { reveal_attempts: 0 });
  logEvent(sale.id, 'card_revealed', 'Owner opened the card with the right PIN');
  return {
    card: {
      ...openCard(sale.id, sale.card_sealed),
      amountInr: sale.amount_inr,
      shopName: shop.name,
      ref: saleRef(sale.id),
    },
  };
}

export function claimCard(token, pin) {
  const { sale, shop, status, reason, attemptsLeft } = unlock(token, pin);
  if (!sale) return { status, reason, attemptsLeft };

  const claimed = transition(sale.id, 'delivered', 'claimed', {
    claimed_at: sqlTime(),
    card_sealed: null,
    reveal_token_hash: null,
    reveal_expires_at: null,
  });
  if (claimed) {
    logEvent(sale.id, 'card_wiped', "Owner claimed the card. Sikka's copy of the code is deleted");
    markCardClaimed(shop, sale);
  }
  return { ok: true };
}

// Encrypts cards stored in plain text by an earlier version, so no readable code stays on disk.
export function sealOldCards() {
  for (const sale of plainCardSales()) {
    const { card_code: code, card_pin: pin, card_link: link, card_instructions: instructions } = sale;
    sealPlainCard(sale.id, sealCard(sale.id, { code, pin, link, instructions }));
  }
}
