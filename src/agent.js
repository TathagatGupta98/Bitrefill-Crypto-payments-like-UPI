import OpenAI from 'openai';
import { sendCard } from './bot.js';
import { config } from './config.js';
import { getShopById, recentSales, saleRef, salesSummary, salesToday, unclaimedSales, updateCaps } from './db.js';
import { canAcceptPayments } from './guardrails.js';

const MAX_TOOL_ROUNDS = 4;
const TIMEOUT_MS = 20_000;
const MAX_PER_SALE_INR = 5000;
const MAX_DAILY_INR = 20000;
const DEFAULT_RECENT = 5;
const MAX_RECENT = 20;
const PERIODS = ['today', 'week', 'all'];

const isCap = (value) => Number.isInteger(value) && value > 0;

export function getSalesSummary(shop, period = 'today') {
  const chosen = PERIODS.includes(period) ? period : 'today';
  const { count, totalInr, unclaimed } = salesSummary(shop.id, chosen);
  return { period: chosen, count, total_inr: totalInr, unclaimed_cards: unclaimed };
}

// No card fields: this output goes to the LLM provider.
export function listRecentSales(shop, limit = DEFAULT_RECENT) {
  const count = Math.min(Math.max(Number(limit) || DEFAULT_RECENT, 1), MAX_RECENT);
  return recentSales(shop.id, count).map((sale) => ({
    ref: saleRef(sale.id),
    amount_inr: sale.amount_inr,
    status: sale.status,
    time_utc: sale.created_at,
  }));
}

// Takes the shop's id instead of a shop object so the caps it validates against are never stale.
export function changeCaps(shopId, { per_sale_inr: perSale, daily_inr: daily }) {
  const shop = getShopById(shopId);
  const nextPerSale = perSale ?? shop.per_sale_cap_inr;
  const nextDaily = daily ?? shop.daily_cap_inr;
  if (!isCap(nextPerSale) || nextPerSale > MAX_PER_SALE_INR) {
    return { error: `Per-sale limit must be a whole number from 1 to ${MAX_PER_SALE_INR}` };
  }
  if (!isCap(nextDaily) || nextDaily > MAX_DAILY_INR) {
    return { error: `Daily limit must be a whole number from 1 to ${MAX_DAILY_INR}` };
  }
  updateCaps(shopId, nextPerSale, nextDaily);
  return { per_sale_inr: nextPerSale, daily_inr: nextDaily };
}

async function getStatus(shopId) {
  const shop = getShopById(shopId);
  return {
    per_sale_cap_inr: shop.per_sale_cap_inr,
    daily_cap_inr: shop.daily_cap_inr,
    used_today_inr: salesToday(shop.id).totalInr,
    can_accept_payments: await canAcceptPayments(),
  };
}

async function resendUnclaimedCards(shop) {
  const sales = unclaimedSales(shop.id);
  for (const sale of sales) await sendCard(shop, sale);
  return { resent: sales.length };
}

const tool = (name, description, properties = {}) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties } },
});

const TOOLS = [
  tool('get_sales_summary', 'Number of sales, total rupees received and unclaimed cards for a period.', {
    period: { type: 'string', enum: PERIODS },
  }),
  tool('list_recent_sales', 'The most recent sales: reference, amount, status and time.', {
    limit: { type: 'integer', minimum: 1, maximum: MAX_RECENT },
  }),
  tool('update_caps', 'Change the shop limits. Only use when the owner clearly asks to change them.', {
    per_sale_inr: { type: 'integer', minimum: 1, maximum: MAX_PER_SALE_INR },
    daily_inr: { type: 'integer', minimum: 1, maximum: MAX_DAILY_INR },
  }),
  tool('get_status', "Current limits, today's usage and whether Sikka can accept payments right now."),
  tool('resend_unclaimed_cards', 'Send the owner a fresh Reveal card button for each unclaimed card. Codes are never sent in chat.'),
];

// The shop always comes from the Telegram chat, never from the model's arguments.
const HANDLERS = {
  get_sales_summary: (shop, args) => getSalesSummary(shop, args.period),
  list_recent_sales: (shop, args) => listRecentSales(shop, args.limit),
  update_caps: (shop, args) => changeCaps(shop.id, args),
  get_status: (shop) => getStatus(shop.id),
  resend_unclaimed_cards: (shop) => resendUnclaimedCards(shop),
};

async function runTool(shop, call) {
  try {
    const handler = HANDLERS[call.function.name];
    if (!handler) return { error: `Unknown tool ${call.function.name}` };
    return await handler(shop, JSON.parse(call.function.arguments || '{}'));
  } catch (err) {
    return { error: err.message };
  }
}

export const agentEnabled = () => Boolean(config.LLM_API_KEY && config.LLM_MODEL);

// Throws on any LLM failure, so the caller can fall back to the command help.
export async function runAgent(shop, userText) {
  const client = new OpenAI({ apiKey: config.LLM_API_KEY, baseURL: config.LLM_BASE_URL, maxRetries: 0 });
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const messages = [
    {
      role: 'system',
      content:
        'You are Sikka, a friendly assistant for a small Indian shop owner who accepts crypto via Sikka. ' +
        "Reply briefly (1–3 sentences) in the owner's language: Hindi or Hinglish if they write that way, otherwise English. " +
        'Always use tools for numbers; never invent amounts. ' +
        'You cannot move money or buy anything yourself. You have no access to gift card codes, PINs or reveal links. ' +
        'If asked for a code, say you cannot see it, and that the Reveal card button with their PIN opens it. ' +
        `Shop: ${shop.name}.`,
    },
    { role: 'user', content: userText },
  ];

  // The last pass offers no tools, so the model has to answer with what it already has.
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const canUseTools = round < MAX_TOOL_ROUNDS;
    const response = await client.chat.completions.create(
      { model: config.LLM_MODEL, messages, ...(canUseTools ? { tools: TOOLS } : {}) },
      { signal },
    );
    const message = response.choices[0].message;
    if (!message.tool_calls?.length) {
      if (!message.content) throw new Error('The LLM returned an empty reply');
      return message.content;
    }

    messages.push(message);
    for (const call of message.tool_calls) {
      const result = await runTool(shop, call);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error('The LLM did not finish');
}
