// Checks the Bitrefill integration end to end. The only purchase is the free test product.
import { config, requireConfig } from '../src/config.js';
import {
  BitrefillError,
  createInvoice,
  getBalance,
  getInvoice,
  getOrder,
  getProduct,
  ping,
  searchProducts,
} from '../src/bitrefill.js';

const TEST_PRODUCT_ID = 'test-gift-card-code';
const TEST_VALUE = 10;
// GET /invoices/{id} and /orders/{id} allow 60 calls per 10 minutes.
const POLL_MS = 5_000;
const POLL_TIMEOUT_MS = 60_000;

const INVOICE_FAILURES = ['blocked', 'denied', 'payment_error'];
const ORDER_FAILURES = ['failed', 'refunded'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mask(value) {
  if (typeof value !== 'string') return value;
  return value.length > 8 ? `XXXX…${value.slice(-4)} (${value.length} chars)` : `XXXX (${value.length} chars)`;
}

// redemption_info is documented as both a string and an object, so mask every string inside it.
function maskDeep(value) {
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, maskDeep(val)]));
  }
  return mask(value);
}

async function pollUntil(label, fetchStatus, doneStatus, failedStatuses) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const result = await fetchStatus();
    console.log(`  ${label} status: ${result.status}`);
    if (result.status === doneStatus) return result;
    if (failedStatuses.includes(result.status)) throw new Error(`${label} ended as ${result.status}`);
    if (Date.now() >= deadline) throw new Error(`${label} still ${result.status} after ${POLL_TIMEOUT_MS / 1000}s`);
    await sleep(POLL_MS);
  }
}

async function checkPhonePe() {
  // `country` isn't documented on /products/search, so filter the results here as well.
  const results = await searchProducts('phonepe', { country: 'IN' });
  const phonepe = results.filter((p) => /phonepe/i.test(`${p.id} ${p.name}`));
  console.log(`  ${phonepe.length} match(es):`, phonepe.map((p) => p.id).join(', ') || 'none');

  const match =
    phonepe.find((p) => p.id === config.PHONEPE_PRODUCT_ID) ??
    phonepe.find((p) => (p.country_code ?? p.country) === 'IN');
  if (!match) {
    console.log(`  WARNING: no PhonePe India product found (PHONEPE_PRODUCT_ID=${config.PHONEPE_PRODUCT_ID})`);
    return false;
  }

  const product = await getProduct(match.id);
  console.log(`  ${product.id}: currency=${product.currency} in_stock=${product.in_stock}`);
  console.log(`  product fields: ${Object.keys(product).join(', ')}`);
  console.log('  packages:', JSON.stringify(product.packages ?? null));
  console.log('  range:', JSON.stringify(product.range ?? null));
  return true;
}

async function buyTestCard() {
  const created = await createInvoice({
    products: [{ product_id: TEST_PRODUCT_ID, value: TEST_VALUE, quantity: 1 }],
    payment_method: 'balance',
    auto_pay: true,
  });
  console.log(`  invoice ${created.id}: status=${created.status}`);
  console.log(`  invoice fields: ${Object.keys(created).join(', ')}`);
  console.log('  invoice payment:', JSON.stringify(created.payment ?? null));

  const invoice = await pollUntil('invoice', () => getInvoice(created.id), 'complete', INVOICE_FAILURES);
  const orderId = invoice.orders?.[0]?.id;
  if (!orderId) throw new Error(`invoice ${invoice.id} has no orders`);

  const order = await pollUntil('order', () => getOrder(orderId), 'delivered', ORDER_FAILURES);
  console.log(`  order fields: ${Object.keys(order).join(', ')}`);
  console.log('  redemption_info:', JSON.stringify(maskDeep(order.redemption_info)));
}

async function main() {
  requireConfig(['BITREFILL_API_KEY']);
  console.log(`Using ${config.BITREFILL_BASE_URL}\n`);

  console.log('1. Ping');
  console.log(' ', (await ping()).message);

  console.log('2. Balance');
  const before = await getBalance();
  console.log(`  ${before.balance} ${before.currency}`);

  console.log('3. PhonePe product');
  const foundPhonePe = await checkPhonePe();

  console.log(`4. Test purchase (${TEST_PRODUCT_ID}, free)`);
  await buyTestCard();

  console.log('5. Balance after the test purchase');
  const after = await getBalance();
  console.log(`  ${after.balance} ${after.currency}`);
  if (after.balance !== before.balance) console.log('  WARNING: the test purchase changed the balance');

  if (!foundPhonePe) {
    process.exitCode = 1;
    console.log('\nSmoke test finished, but the PhonePe product check needs attention.');
    return;
  }
  console.log('\nSmoke test passed.');
}

main().catch((err) => {
  process.exitCode = 1;
  console.error(`\nSmoke test failed: ${err.message}`);
  if (err instanceof BitrefillError && err.code) console.error(`Error code: ${err.code}`);
});
