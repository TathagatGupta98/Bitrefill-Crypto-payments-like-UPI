// Bitrefill response fields, checked against live responses on 4 Nov 2026. These differ from the docs.
//   GET /accounts/balance -> balance, currency (the account's currency: "BTC" on the current account)
//   GET /products/{id}    -> id, currency, in_stock, packages (no range on phonepe-india)
//     packages[]          -> id ("phonepe-india<&>100"), value ("100"), amount, price (account currency; sats on BTC)
//   POST /invoices        -> id, status ("not_delivered"), payment{method, currency, price, status, commission}, orders[{id, status}]
//     on usdc_base        -> payment{address (one per invoice), currency "USDC", price (6-decimal units: 1140000 = 1.14 USDC)}
//   GET /invoices/{id}    -> status all_delivered | all_error, and orders[] include redemption_info, so never log them
//   GET /orders/{id}      -> id, status delivered | permanent_failure, redemption_info{code, instructions, other, extra_fields}
import { getProduct } from './bitrefill.js';
import { config } from './config.js';
import { getCachedBalance } from './guardrails.js';

export const ALLOWED_INR = [100, 500, 1000, 2000, 5000];

const TEST_VALUE = 10;
const PRODUCT_TTL_MS = 10 * 60_000;

let cachedProduct = null;
let productFetchedAt = 0;

async function getPhonePeProduct() {
  if (!cachedProduct || Date.now() - productFetchedAt > PRODUCT_TTL_MS) {
    cachedProduct = await getProduct(config.PHONEPE_PRODUCT_ID);
    productFetchedAt = Date.now();
  }
  return cachedProduct;
}

// Finds how to buy this INR amount, as a fixed package or as a value within the product's range.
function findOffer(product, amountInr) {
  if (product.in_stock === false) return null;

  // The docs show `packages` both as an array and as a single object.
  const packages = [].concat(product.packages ?? []);
  const pkg = packages.find((candidate) => Number(candidate.value) === amountInr);
  if (pkg) return { packageId: pkg.package_id ?? pkg.id, price: Number(pkg.price) };

  const { min, max, step, price_rate: rate } = product.range ?? {};
  const inRange = amountInr >= min && amountInr <= max && (!step || (amountInr - min) % step === 0);
  if (inRange) return { value: amountInr, price: amountInr * Number(rate) };

  return null;
}

export async function availableAmounts() {
  if (config.BITREFILL_TEST_MODE) return ALLOWED_INR;
  const product = await getPhonePeProduct();
  return ALLOWED_INR.filter((amountInr) => findOffer(product, amountInr));
}

// Bitrefill prices are in the account's currency, so they only count as USD on a USD account.
async function usdCostFor(offer, amountInr) {
  const { currency } = await getCachedBalance();
  return currency === 'USD' && offer.price > 0 ? offer.price : amountInr / config.INR_PER_USD;
}

function customerUsdcUnits(usdCost) {
  const price = usdCost * (1 + config.MARKUP_PCT / 100);
  // toFixed drops float noise, so an exact 1.17 can't round up to 1.18.
  const cents = Math.ceil(Number((price * 100).toFixed(6)));
  return String(cents * 10_000);
}

// Returns { productId, packageId | value, usdCost, usdcUnits }. `usdCost` is what Bitrefill charges
// and counts towards the guardrails. `usdcUnits` is the customer's price, before the per-sale tail.
export async function quote(amountInr) {
  if (!ALLOWED_INR.includes(amountInr)) throw new Error(`₹${amountInr} is not a supported amount`);

  // Test cards are free, so they cost 0 and can't use up the daily USD cap before the real demo.
  // The customer still sees a realistic price, which keeps the pay page identical.
  if (config.BITREFILL_TEST_MODE) {
    return {
      productId: config.BITREFILL_TEST_PRODUCT,
      value: TEST_VALUE,
      usdCost: 0,
      usdcUnits: customerUsdcUnits(amountInr / config.INR_PER_USD),
    };
  }

  const product = await getPhonePeProduct();
  const offer = findOffer(product, amountInr);
  if (!offer) throw new Error(`₹${amountInr} is not available right now`);

  const usdCost = await usdCostFor(offer, amountInr);
  const purchase = offer.packageId ? { packageId: offer.packageId } : { value: offer.value };
  return { productId: product.id, ...purchase, usdCost, usdcUnits: customerUsdcUnits(usdCost) };
}
