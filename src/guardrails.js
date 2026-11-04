import { getBalance } from './bitrefill.js';
import { config } from './config.js';
import { salesToday, spendTodayUsd } from './db.js';

const BALANCE_TTL_MS = 30_000;
const UNAVAILABLE = 'temporarily unavailable';

let cachedBalance = null;
let balanceFetchedAt = 0;

export async function getCachedBalance() {
  if (!cachedBalance || Date.now() - balanceFetchedAt > BALANCE_TTL_MS) {
    cachedBalance = await getBalance();
    balanceFetchedAt = Date.now();
  }
  return cachedBalance;
}

// Refuses if the balance can't be read or isn't in USD, because the floor is a USD amount.
async function balanceAllows(usdCost) {
  try {
    const { balance, currency } = await getCachedBalance();
    if (currency !== 'USD') {
      console.error(`Balance is in ${currency}, but the guardrails expect USD`);
      return false;
    }
    return balance - usdCost >= config.BALANCE_FLOOR_USD;
  } catch (err) {
    console.error(`Could not read the Bitrefill balance: ${err.message}`);
    return false;
  }
}

// For the owner's status check: yes or no, never the raw balance.
export const canAcceptPayments = () => balanceAllows(0);

// Run with no `saleId` when creating a sale, and with its id right before buying. The re-check
// leaves that sale out of today's totals and skips approval, which has already been dealt with.
// Refusals come first so an owner is never asked to approve a sale that can't go through.
export async function checkSale(shop, amountInr, usdCost, { saleId = null } = {}) {
  if (salesToday(shop.id, saleId).totalInr + amountInr > shop.daily_cap_inr) {
    return { ok: false, reason: 'daily limit reached' };
  }
  if (usdCost > config.AGENT_MAX_PER_PURCHASE_USD) {
    return { ok: false, reason: 'amount is above the purchase limit' };
  }
  if (spendTodayUsd(saleId) + usdCost > config.AGENT_MAX_DAILY_USD) {
    return { ok: false, reason: UNAVAILABLE };
  }
  if (!(await balanceAllows(usdCost))) {
    return { ok: false, reason: UNAVAILABLE };
  }
  if (!saleId && amountInr > shop.per_sale_cap_inr) {
    return { needsApproval: true };
  }
  return { ok: true };
}
