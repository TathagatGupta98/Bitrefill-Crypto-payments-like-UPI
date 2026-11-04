import { nanoid } from 'nanoid';
import { formatUnits } from 'viem';
import { BitrefillError } from './bitrefill.js';
import { ALLOWED_INR, quote } from './catalog.js';
import { config } from './config.js';
import { expireOldSales, getShopBySlug, insertSale, openSaleUnits, saleRef, sqlTime } from './db.js';
import { checkSale } from './guardrails.js';

const USDC_DECIMALS = 6;
const TAIL_STEP_UNITS = 100;
const MAX_TAIL = 99;
const SWEEP_MS = 30_000;
const UNAVAILABLE = 'temporarily unavailable';

// Refusals reach the customer, so API and network errors are logged instead of shown.
async function quoteAndCheck(shop, amountInr) {
  try {
    const offer = await quote(amountInr);
    return { offer, check: await checkSale(shop, amountInr, offer.usdCost) };
  } catch (err) {
    if (!(err instanceof BitrefillError)) return { check: { ok: false, reason: err.message } };
    console.error(`Could not quote ₹${amountInr}: ${err.message}`);
    return { check: { ok: false, reason: UNAVAILABLE } };
  }
}

// Adds a 4th-decimal tail that no open sale is using, because the amount is what identifies the payment.
function uniqueUnits(baseUnits) {
  const taken = new Set(openSaleUnits());
  const free = [];
  for (let tail = 1; tail <= MAX_TAIL; tail++) {
    const units = String(BigInt(baseUnits) + BigInt(tail * TAIL_STEP_UNITS));
    if (!taken.has(units)) free.push(units);
  }
  return free.length ? free[Math.floor(Math.random() * free.length)] : null;
}

// Returns { sale } or { reason }. Task 5 pings the owner for sales that come back awaiting_approval.
export async function createSale(slug, amountInr) {
  const shop = typeof slug === 'string' ? getShopBySlug(slug) : null;
  if (!shop) return { reason: 'shop not found' };

  const { offer, check } = await quoteAndCheck(shop, amountInr);
  if (check.ok === false) return { reason: check.reason };

  // No await between picking the amount and inserting, so two sales can't pick the same one.
  const usdcUnits = uniqueUnits(offer.usdcUnits);
  if (!usdcUnits) return { reason: UNAVAILABLE };

  const sale = {
    id: nanoid(),
    shop_id: shop.id,
    amount_inr: amountInr,
    usd_cost: offer.usdCost,
    usdc_amount_units: usdcUnits,
    status: check.needsApproval ? 'awaiting_approval' : 'awaiting_payment',
    expires_at: sqlTime(new Date(Date.now() + config.SALE_TTL_MIN * 60_000)),
  };
  insertSale(sale);
  return { sale };
}

// One entry per chip on the pay page, using the same checks as creating a sale.
export async function amountOptions(shop) {
  const options = [];
  for (const inr of ALLOWED_INR) {
    const { check } = await quoteAndCheck(shop, inr);
    options.push(check.ok === false ? { inr, enabled: false, reason: check.reason } : { inr, enabled: true });
  }
  return options;
}

const isoTime = (sqlite) => (sqlite ? `${sqlite.replace(' ', 'T')}Z` : null);

function eip681(units) {
  return `ethereum:${config.USDC_BASE_ADDRESS}@8453/transfer?address=${config.RECEIVE_ADDRESS}&uint256=${units}`;
}

// What the customer's browser sees. Never add card fields or `error` here.
export function saleView(sale) {
  return {
    id: sale.id,
    status: sale.status,
    amountInr: sale.amount_inr,
    usdc: formatUnits(BigInt(sale.usdc_amount_units), USDC_DECIMALS),
    address: config.RECEIVE_ADDRESS,
    eip681: eip681(sale.usdc_amount_units),
    expiresAt: isoTime(sale.expires_at),
    deliveredAt: isoTime(sale.delivered_at),
    ref: saleRef(sale.id),
    invoiceId: sale.bitrefill_invoice_id ?? undefined,
    devMode: config.DEV_MODE,
  };
}

export function startExpirySweeper() {
  setInterval(() => {
    const expired = expireOldSales();
    if (expired) console.log(`Expired ${expired} unpaid sale(s)`);
  }, SWEEP_MS);
}
