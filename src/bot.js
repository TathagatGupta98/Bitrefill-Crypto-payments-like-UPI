import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { getSale, getShopByChat, sqlTime, transition } from './db.js';
import { retrySale } from './fulfill.js';

const MAX_INSTRUCTIONS_CHARS = 1000;

let bot;

const escapeHtml = (text) =>
  String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function cardMessage(sale) {
  const lines = [`✅ Crypto se ₹${sale.amount_inr} prapt hue!`, '', 'PhonePe gift card:'];
  if (sale.card_code) lines.push(`Code: <code>${escapeHtml(sale.card_code)}</code>`);
  if (sale.card_pin) lines.push(`PIN: <code>${escapeHtml(sale.card_pin)}</code>`);
  if (sale.card_link) lines.push(`Link: ${escapeHtml(sale.card_link)}`);
  if (sale.card_instructions) {
    lines.push(escapeHtml(sale.card_instructions.slice(0, MAX_INSTRUCTIONS_CHARS)));
  }
  lines.push('', 'Claim it: PhonePe → Gift Cards → Add.', `[Invoice: ${escapeHtml(sale.bitrefill_invoice_id)}]`);
  return lines.join('\n');
}

export async function sendCard(shop, sale) {
  await bot.api.sendMessage(shop.telegram_chat_id, cardMessage(sale), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard()
      .text('📋 Claimed ✅', `claim:${sale.id}`)
      .url('Open PhonePe', 'https://www.phonepe.com/'),
  });
}

export async function notifyOwner(shop, text) {
  try {
    await bot.api.sendMessage(shop.telegram_chat_id, text);
  } catch (err) {
    console.error(`Could not message shop ${shop.slug}: ${err.message}`);
  }
}

// Returns the sale only if it belongs to the shop linked to this chat.
function findOwnSale(chatId, saleId) {
  const shop = getShopByChat(chatId);
  const sale = saleId ? getSale(saleId) : null;
  return shop && sale?.shop_id === shop.id ? { shop, sale } : {};
}

async function handleClaim(ctx) {
  const { sale } = findOwnSale(ctx.chat?.id, ctx.match[1]);
  if (!sale) {
    await ctx.answerCallbackQuery({ text: 'Sale not found' });
    return;
  }

  // Instructions are wiped too, because they can contain the code.
  const claimed = transition(sale.id, 'delivered', 'claimed', {
    claimed_at: sqlTime(),
    card_code: null,
    card_pin: null,
    card_link: null,
    card_instructions: null,
  });
  await ctx.answerCallbackQuery(claimed ? { text: 'Claimed ✓' } : { text: 'Already claimed' });
  if (claimed) await ctx.editMessageText('Claimed ✓ (code removed)');
}

async function handleRetry(ctx) {
  const saleId = ctx.match.trim();
  if (!saleId) {
    await ctx.reply('Usage: /retry <saleId>');
    return;
  }
  const { shop, sale } = findOwnSale(ctx.chat.id, saleId);
  await ctx.reply(sale ? retrySale(sale, shop) : 'Sale not found.');
}

export function startBot() {
  bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  bot.command('retry', handleRetry);
  bot.callbackQuery(/^claim:(.+)$/, handleClaim);
  bot.catch((err) => console.error(`Telegram handler failed: ${err.message}`));

  bot
    .start({ onStart: (me) => console.log(`Telegram bot @${me.username} is running`) })
    .catch((err) => console.error(`Telegram bot stopped: ${err.message}`));
}
