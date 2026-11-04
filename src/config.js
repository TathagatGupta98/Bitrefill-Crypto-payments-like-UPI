import 'dotenv/config';

const REQUIRED = [
  'PUBLIC_URL',
  'BITREFILL_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'RECEIVE_ADDRESS',
];

const str = (name, fallback = '') => process.env[name]?.trim() || fallback;
const bool = (name, fallback) => str(name, String(fallback)).toLowerCase() === 'true';

function num(name, fallback) {
  const value = Number(str(name, String(fallback)));
  if (!Number.isFinite(value)) throw new Error(`Env var ${name} must be a number`);
  return value;
}

export const config = {
  PORT: num('PORT', 3000),
  PUBLIC_URL: str('PUBLIC_URL').replace(/\/+$/, ''),
  BITREFILL_API_KEY: str('BITREFILL_API_KEY'),
  BITREFILL_BASE_URL: str('BITREFILL_BASE_URL', 'https://api.bitrefill.com/v2').replace(/\/+$/, ''),
  BITREFILL_TEST_MODE: bool('BITREFILL_TEST_MODE', true),
  // Set to test-gift-card-code-fail to demo the failed-purchase path.
  BITREFILL_TEST_PRODUCT: str('BITREFILL_TEST_PRODUCT', 'test-gift-card-code'),
  PHONEPE_PRODUCT_ID: str('PHONEPE_PRODUCT_ID', 'phonepe-india'),
  TELEGRAM_BOT_TOKEN: str('TELEGRAM_BOT_TOKEN'),
  LLM_BASE_URL: str('LLM_BASE_URL', 'https://api.groq.com/openai/v1'),
  LLM_API_KEY: str('LLM_API_KEY'),
  LLM_MODEL: str('LLM_MODEL'),
  BASE_RPC_URL: str('BASE_RPC_URL', 'https://base-rpc.publicnode.com'),
  RECEIVE_ADDRESS: str('RECEIVE_ADDRESS'),
  USDC_BASE_ADDRESS: str('USDC_BASE_ADDRESS', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  INR_PER_USD: num('INR_PER_USD', 88),
  MARKUP_PCT: num('MARKUP_PCT', 3),
  SALE_TTL_MIN: num('SALE_TTL_MIN', 15),
  DEFAULT_PER_SALE_CAP_INR: num('DEFAULT_PER_SALE_CAP_INR', 500),
  DEFAULT_DAILY_CAP_INR: num('DEFAULT_DAILY_CAP_INR', 2000),
  AGENT_MAX_PER_PURCHASE_USD: num('AGENT_MAX_PER_PURCHASE_USD', 60),
  AGENT_MAX_DAILY_USD: num('AGENT_MAX_DAILY_USD', 10),
  BALANCE_FLOOR_USD: num('BALANCE_FLOOR_USD', 2),
  DEV_MODE: bool('DEV_MODE', false),
  // relay: the customer pays Sikka, which buys from balance. direct: the customer pays Bitrefill's invoice.
  PAY_MODE: str('PAY_MODE', 'relay'),
};

// Scripts pass only the vars they use, so the smoke test doesn't need a bot token.
export function requireConfig(names = REQUIRED) {
  const missing = names.filter((name) => !config[name]);
  if (missing.length) {
    throw new Error(
      `Missing required env vars:\n${missing.map((name) => `  - ${name}`).join('\n')}\nSet them in .env (see .env.example).`,
    );
  }
}
