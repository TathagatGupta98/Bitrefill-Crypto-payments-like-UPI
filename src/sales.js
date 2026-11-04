import { nanoid } from 'nanoid';
import QRCode from 'qrcode';
import { formatUnits, parseUnits } from 'viem';
import { BitrefillError, createInvoice, getInvoice } from './bitrefill.js';
import { requestApproval } from './bot.js';
import { ALLOWED_INR, quote } from './catalog.js';
import { config } from './config.js';
import {
  awaitingDirectSales,
  expireOldSales,
  getShopBySlug,
  insertSale,
  openSaleUnits,
  saleRef,
  sqlTime,
  transition,
} from './db.js';
import { fulfillSale } from './fulfill.js';
import { checkSale } from './guardrails.js';

const USDC_DECIMALS = 6;
const TAIL_STEP_UNITS = 100;
const MAX_TAIL = 99;
const SWEEP_MS = 30_000;
// GET /invoices/{id} allows 60 calls per 10 minutes.
const DIRECT_POLL_MS = 15_000;
const UNAVAILABLE = 'temporarily unavailable';

const isDirect = () => config.PAY_MODE === 'direct';
const newExpiry = () => sqlTime(new Date(Date.now() + config.SALE_TTL_MIN * 60_000));

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

// Direct mode: the customer pays this invoice, so Bitrefill sets the address and the amount.
// The docs show payment.price as a decimal coin amount, but have no usdc_base example to confirm it.
async function directInvoiceFields(offer) {
  const item = offer.packageId ? { package_id: offer.packageId } : { value: offer.value };
  const invoice = await createInvoice({
    products: [{ product_id: offer.productId, quantity: 1, ...item }],
    payment_method: 'usdc_base',
    refund_address: config.RECEIVE_ADDRESS,
  });
  if (!invoice.payment?.address || !invoice.payment?.price) {
    throw new Error(`Bitrefill invoice ${invoice.id} has no payment details`);
  }
  return {
    usdc_amount_units: parseUnits(String(invoice.payment.price), USDC_DECIMALS).toString(),
    pay_address: invoice.payment.address,
    bitrefill_invoice_id: invoice.id,
    bitrefill_order_id: invoice.orders?.[0]?.id ?? null,
  };
}

// Returns { sale } or { reason }.
export async function createSale(slug, amountInr) {
  const shop = typeof slug === 'string' ? getShopBySlug(slug) : null;
  if (!shop) return { reason: 'shop not found' };

  const { offer, check } = await quoteAndCheck(shop, amountInr);
  if (check.ok === false) return { reason: check.reason };

  const sale = {
    id: nanoid(),
    shop_id: shop.id,
    amount_inr: amountInr,
    usd_cost: offer.usdCost,
    status: check.needsApproval ? 'awaiting_approval' : 'awaiting_payment',
    expires_at: newExpiry(),
    usdc_amount_units: offer.usdcUnits,
    pay_address: null,
    bitrefill_invoice_id: null,
    bitrefill_order_id: null,
  };

  if (isDirect()) {
    // A sale that needs approval gets its invoice once the owner approves.
    if (!check.needsApproval) {
      try {
        Object.assign(sale, await directInvoiceFields(offer));
      } catch (err) {
        console.error(`Could not create a direct invoice: ${err.message}`);
        return { reason: UNAVAILABLE };
      }
    }
  } else {
    // No await between picking the amount and inserting, so two sales can't pick the same one.
    sale.usdc_amount_units = uniqueUnits(offer.usdcUnits);
    if (!sale.usdc_amount_units) return { reason: UNAVAILABLE };
  }

  insertSale(sale);
  if (check.needsApproval) await requestApproval(shop, sale);
  return { sale };
}

// The customer gets a fresh payment window, because the wait for the owner shouldn't use it up.
// Returns false if the sale was no longer waiting for approval.
export async function approveSale(sale) {
  const fields = { expires_at: newExpiry() };
  if (isDirect()) Object.assign(fields, await directInvoiceFields(await quote(sale.amount_inr)));
  return transition(sale.id, 'awaiting_approval', 'awaiting_payment', fields);
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

export const shopPayUrl = (shop) => `${config.PUBLIC_URL}/pay/${shop.slug}`;
export const shopQrPng = (shop) => QRCode.toBuffer(shopPayUrl(shop), { width: 800, margin: 2 });

const isoTime = (sqlite) => (sqlite ? `${sqlite.replace(' ', 'T')}Z` : null);

function eip681(address, units) {
  return `ethereum:${config.USDC_BASE_ADDRESS}@8453/transfer?address=${address}&uint256=${units}`;
}

// What the customer's browser sees. Never add card fields or `error` here.
export function saleView(sale) {
  const address = sale.pay_address ?? config.RECEIVE_ADDRESS;
  return {
    id: sale.id,
    status: sale.status,
    amountInr: sale.amount_inr,
    usdc: formatUnits(BigInt(sale.usdc_amount_units), USDC_DECIMALS),
    address,
    eip681: eip681(address, sale.usdc_amount_units),
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

// Direct mode has no chain watcher: Bitrefill sees the payment and moves the invoice on.
// A paid invoice goes to fulfill.js, which follows it to the end. Live invoices start as
// not_delivered, so only payment.status shows whether the customer has paid.
async function checkDirectPayments() {
  for (const sale of awaitingDirectSales()) {
    try {
      const invoice = await getInvoice(sale.bitrefill_invoice_id);
      if (invoice.payment?.status === 'unpaid') continue;
      if (transition(sale.id, 'awaiting_payment', 'paid', { paid_at: sqlTime() })) {
        console.log(`Sale ${saleRef(sale.id)} paid directly: payment is ${invoice.payment?.status}`);
        fulfillSale(sale.id).catch((err) => console.error(`Sale ${saleRef(sale.id)} failed: ${err.message}`));
      }
    } catch (err) {
      console.error(`Sale ${saleRef(sale.id)} invoice check failed: ${err.message}`);
    }
  }
}

export function startDirectPoller() {
  const tick = async () => {
    await checkDirectPayments();
    setTimeout(tick, DIRECT_POLL_MS);
  };
  tick();
}
