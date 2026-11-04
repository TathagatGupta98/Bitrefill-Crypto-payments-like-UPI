import { createInvoice, getInvoice, getOrder } from './bitrefill.js';
import { notifyOwner, sendCard } from './bot.js';
import { quote } from './catalog.js';
import { getSale, getShopById, saleRef, sqlTime, transition } from './db.js';
import { events } from './events.js';
import { checkSale } from './guardrails.js';
import { config } from './config.js';

// GET /invoices/{id} and /orders/{id} each allow 60 calls per 10 minutes.
// A direct payment needs on-chain confirmations first, which the docs put at 1-5 minutes on L2s.
const POLL_MS = config.PAY_MODE === 'direct' ? 15_000 : 5_000;
const POLL_TIMEOUT_MS = config.PAY_MODE === 'direct' ? 900_000 : 120_000;

// The live API uses all_delivered, all_error and permanent_failure. The rest are from the docs.
const INVOICE_DONE = ['complete', 'all_delivered'];
const INVOICE_FAILURES = ['blocked', 'denied', 'payment_error', 'all_error'];
const ORDER_FAILURES = ['failed', 'refunded', 'permanent_failure'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function failSale(sale, shop, reason) {
  if (!transition(sale.id, 'purchasing', 'failed', { error: reason })) return;
  console.error(`Sale ${saleRef(sale.id)} failed: ${reason}`);
  await notifyOwner(
    shop,
    `⚠️ Sale ${saleRef(sale.id)} paid ₹${sale.amount_inr} but the card purchase failed (${reason}). ` +
      (config.PAY_MODE === 'direct'
        ? `Bitrefill refunds this to ${config.RECEIVE_ADDRESS}, then send it back to the customer.`
        : `Customer refund needed: ${sale.payer_address ?? 'payer address unknown'}.`),
  );
}

function invoiceErrorReason(err) {
  if (err.code === 'out_of_stock') return 'PhonePe card is out of stock';
  if (err.code === 'balance_too_low') return "Sikka's Bitrefill balance is too low";
  if (err.status === 429) return 'Bitrefill rate limit reached, try again shortly';
  // No clear answer from Bitrefill, so the invoice may exist even though we never got its ID.
  if (!err.status || err.status >= 500) {
    return `no clear response from Bitrefill (${err.message}), check the account for an invoice before refunding`;
  }
  return err.message;
}

// Returns false if the sale failed before an invoice was created.
async function buyCard(sale, shop) {
  let offer;
  try {
    offer = await quote(sale.amount_inr);
  } catch (err) {
    await failSale(sale, shop, err.message);
    return false;
  }

  const check = await checkSale(shop, sale.amount_inr, offer.usdCost, { saleId: sale.id });
  if (!check.ok) {
    await failSale(sale, shop, check.reason);
    return false;
  }

  const item = offer.packageId ? { package_id: offer.packageId } : { value: offer.value };
  let invoice;
  try {
    invoice = await createInvoice({
      products: [{ product_id: offer.productId, quantity: 1, ...item }],
      payment_method: 'balance',
      auto_pay: true,
    });
  } catch (err) {
    await failSale(sale, shop, invoiceErrorReason(err));
    return false;
  }

  // Saved before any polling, so a retry resumes this invoice instead of buying again.
  transition(sale.id, 'purchasing', 'purchasing', {
    usd_cost: offer.usdCost,
    bitrefill_invoice_id: invoice.id,
    bitrefill_order_id: invoice.orders?.[0]?.id ?? null,
  });
  return true;
}

// redemption_info is documented as both an object and a plain string, and its fields vary per product.
function cardFields(redemption) {
  if (typeof redemption === 'string') return { card_instructions: redemption };
  return {
    card_code: redemption?.code ?? null,
    card_pin: redemption?.pin ?? null,
    card_link: redemption?.link ?? null,
    card_instructions: redemption?.instructions ?? null,
  };
}

async function deliverCard(sale, shop, order) {
  const delivered = transition(sale.id, 'purchasing', 'delivered', {
    ...cardFields(order.redemption_info),
    bitrefill_order_id: order.id,
    delivered_at: sqlTime(),
  });
  if (!delivered) return;

  events.emit(shop.slug, { type: 'delivered', saleId: sale.id, amountInr: sale.amount_inr });
  try {
    await sendCard(shop, getSale(sale.id));
  } catch (err) {
    console.error(`Sale ${saleRef(sale.id)} is delivered, but Telegram failed: ${err.message}`);
  }
}

async function checkPurchase(sale, shop, invoiceId) {
  const invoice = await getInvoice(invoiceId);
  if (INVOICE_FAILURES.includes(invoice.status)) {
    await failSale(sale, shop, `Bitrefill invoice ${invoice.status}`);
    return true;
  }
  if (!INVOICE_DONE.includes(invoice.status)) return false;

  const orderId = sale.bitrefill_order_id ?? invoice.orders?.[0]?.id;
  if (!orderId) {
    await failSale(sale, shop, `Bitrefill invoice ${invoiceId} has no order`);
    return true;
  }

  const order = await getOrder(orderId);
  if (ORDER_FAILURES.includes(order.status)) {
    await failSale(sale, shop, order.error ?? `Bitrefill order ${order.status}`);
    return true;
  }
  if (order.status !== 'delivered') return false;

  await deliverCard(sale, shop, order);
  return true;
}

async function waitForCard(sale, shop) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (await checkPurchase(sale, shop, sale.bitrefill_invoice_id)) return;
    } catch (err) {
      // The purchase may still go through, so a failed status check doesn't fail the sale.
      console.error(`Sale ${saleRef(sale.id)} status check failed: ${err.message}`);
    }
    await sleep(POLL_MS);
  }

  // The sale stays in `purchasing`, so a retry resumes the same invoice.
  await notifyOwner(
    shop,
    `⏳ Sale ${saleRef(sale.id)} (₹${sale.amount_inr}): Bitrefill is taking longer than usual. ` +
      `Invoice ${sale.bitrefill_invoice_id}. Try again with /retry ${sale.id}`,
  );
}

async function processSale(saleId) {
  try {
    const shop = getShopById(getSale(saleId).shop_id);
    if (!getSale(saleId).bitrefill_invoice_id && !(await buyCard(getSale(saleId), shop))) return;
    await waitForCard(getSale(saleId), shop);
  } catch (err) {
    console.error(`Sale ${saleRef(saleId)} stopped unexpectedly: ${err.message}`);
  }
}

// Only this module moves a sale on from `paid`.
export async function fulfillSale(saleId) {
  if (!transition(saleId, 'paid', 'purchasing')) return;
  await processSale(saleId);
}

// Picks up a stuck sale in the background and returns a message for the owner.
export function retrySale(sale, shop) {
  const logFailure = (err) => console.error(`Retry of ${saleRef(sale.id)} failed: ${err.message}`);

  if (sale.status === 'paid') {
    fulfillSale(sale.id).catch(logFailure);
    return `Starting the purchase for ${saleRef(sale.id)}.`;
  }
  if (sale.status === 'delivered') {
    sendCard(shop, sale).catch(logFailure);
    return `Sending the card for ${saleRef(sale.id)} again.`;
  }
  if (sale.status !== 'purchasing') {
    return `${saleRef(sale.id)} can't be retried because its status is ${sale.status}.`;
  }
  if (!sale.bitrefill_invoice_id) {
    // The purchase may have gone through before the ID was saved, so buying again could pay twice.
    return `${saleRef(sale.id)} has no saved invoice. Check the Bitrefill account before doing anything else.`;
  }
  processSale(sale.id).catch(logFailure);
  return `Checking invoice ${sale.bitrefill_invoice_id} for ${saleRef(sale.id)}.`;
}
