// Prints the PhonePe India product and its packages, to confirm PHONEPE_PRODUCT_ID before going live.
import { getProduct, searchProducts } from '../src/bitrefill.js';
import { ALLOWED_INR } from '../src/catalog.js';
import { config, requireConfig } from '../src/config.js';

async function main() {
  requireConfig(['BITREFILL_API_KEY']);

  const query = process.argv[2] ?? 'phonepe';
  const results = await searchProducts(query, { country: 'IN' });
  console.log(`Search "${query}" in IN: ${results.map((product) => product.id).join(', ') || 'no results'}`);

  const id = results.some((product) => product.id === config.PHONEPE_PRODUCT_ID)
    ? config.PHONEPE_PRODUCT_ID
    : results[0]?.id;
  if (!id) {
    process.exitCode = 1;
    return;
  }
  if (id !== config.PHONEPE_PRODUCT_ID) {
    console.log(`WARNING: PHONEPE_PRODUCT_ID=${config.PHONEPE_PRODUCT_ID} isn't in the results. Showing ${id} instead.`);
  }

  const product = await getProduct(id);
  console.log(`\n${product.id}: name=${product.name} currency=${product.currency} in_stock=${product.in_stock}`);
  console.log('packages:', JSON.stringify(product.packages ?? null, null, 2));
  console.log('range:', JSON.stringify(product.range ?? null));

  const packages = [].concat(product.packages ?? []);
  for (const inr of ALLOWED_INR) {
    const pkg = packages.find((candidate) => Number(candidate.value) === inr);
    console.log(`₹${inr}: ${pkg ? `package ${pkg.package_id ?? pkg.id}, price ${pkg.price}` : 'no fixed package'}`);
  }
}

main().catch((err) => {
  process.exitCode = 1;
  console.error(`Failed: ${err.message}`);
});
