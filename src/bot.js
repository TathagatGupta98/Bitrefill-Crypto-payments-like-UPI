import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot, InlineKeyboard, InputFile, Keyboard } from 'grammy';
import { customAlphabet } from 'nanoid';
import { agentEnabled, changeCaps, getSalesSummary, listRecentSales, runAgent } from './agent.js';
import { config } from './config.js';
import {
  deleteOnboarding,
  getOnboarding,
  getSale,
  getShopByChat,
  insertShop,
  saleRef,
  saveOnboarding,
  sqlTime,
  transition,
} from './db.js';
import { retrySale } from './fulfill.js';
import { approveSale, shopPayUrl, shopQrPng } from './sales.js';

const MAX_INSTRUCTIONS_CHARS = 1000;
const MAX_NAME_CHARS = 60;
const MAX_MESSAGE_CHARS = 4000;
const PHONE_PATTERN = /^\+?[\d\s-]{10,16}$/;
const HELP_TEXT = [
  'Yeh commands use kijiye:',
  '/today – aaj ki kamai',
  '/sales – recent sales',
  '/caps <per_sale> <daily> – limits badliye, e.g. /caps 500 2000',
].join('\n');

const WELCOME_IMAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'mascot', 'sikku-welcome.png');
const WELCOME_TEXT = 'Namaste! 🙏 Main Sikku hoon. Sikka se aap crypto payments le sakte hain, bina kisi wallet ke.\n\n3 chhote sawaal, phir aapka QR ready.';
const COMMANDS = [
  { command: 'start', description: 'Shop setup, or get your QR and links again' },
  { command: 'today', description: "Today's sales" },
  { command: 'sales', description: 'Recent sales' },
  { command: 'caps', description: 'Change limits: /caps 500 2000' },
  { command: 'help', description: 'What Sikku can do' },
];

const slugSuffix = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 4);

let bot;
let botUsername = null;

export const getBotUsername = () => botUsername;

const escapeHtml = (text) =>
  String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const rupees = (inr) => `₹${inr.toLocaleString('en-IN')}`;

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

// If this message can't be sent, the customer's page waits until the sale expires.
export async function requestApproval(shop, sale) {
  try {
    await bot.api.sendMessage(
      shop.telegram_chat_id,
      `Customer wants to pay ${rupees(sale.amount_inr)} (over your ${rupees(shop.per_sale_cap_inr)} limit). Approve?`,
      { reply_markup: new InlineKeyboard().text('✅ Approve', `approve:${sale.id}`).text('❌ Reject', `reject:${sale.id}`) },
    );
  } catch (err) {
    console.error(`Could not ask shop ${shop.slug} for approval: ${err.message}`);
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

async function handleApprove(ctx) {
  const { sale } = findOwnSale(ctx.chat?.id, ctx.match[1]);
  if (sale?.status !== 'awaiting_approval') {
    await ctx.answerCallbackQuery({ text: sale ? `This sale is already ${sale.status}` : 'Sale not found' });
    return;
  }

  let approved = false;
  try {
    approved = await approveSale(sale);
  } catch (err) {
    console.error(`Could not approve ${saleRef(sale.id)}: ${err.message}`);
  }
  await ctx.answerCallbackQuery({ text: approved ? 'Approved ✓' : 'Could not approve this sale' });
  if (approved) await ctx.editMessageText(`✅ Approved ${rupees(sale.amount_inr)} (${saleRef(sale.id)})`);
}

async function handleReject(ctx) {
  const { sale } = findOwnSale(ctx.chat?.id, ctx.match[1]);
  const rejected = sale ? transition(sale.id, 'awaiting_approval', 'rejected') : false;
  await ctx.answerCallbackQuery({ text: rejected ? 'Rejected' : 'This sale can no longer be rejected' });
  if (rejected) await ctx.editMessageText(`❌ Rejected ${rupees(sale.amount_inr)} (${saleRef(sale.id)})`);
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

async function sendShopKit(ctx, shop) {
  await ctx.replyWithPhoto(new InputFile(await shopQrPng(shop), 'sikka-qr.png'), {
    caption: `${shop.name} ka payment QR. Customer ise phone camera se scan kare.\n${shopPayUrl(shop)}`,
  });
  await ctx.reply(
    [
      '✅ Aapki shop ready hai!',
      '',
      '1. 🖨 Standee print karke counter par rakhiye',
      '2. 🔊 Soundbox counter ke paas wale phone par kholiye',
      '3. 🧪 Khud ek baar pay page dekh lijiye',
      '',
      `Limits: ${rupees(shop.per_sale_cap_inr)} per sale without approval, ${rupees(shop.daily_cap_inr)} per day. Change anytime, just ask me.`,
    ].join('\n'),
    {
      reply_markup: new InlineKeyboard()
        .url('🖨 Standee', `${config.PUBLIC_URL}/standee/${shop.slug}`)
        .url('🔊 Soundbox', `${config.PUBLIC_URL}/soundbox/${shop.slug}`)
        .row()
        .url('🧪 Pay page', shopPayUrl(shop)),
    },
  );
}

async function handleStart(ctx) {
  const shop = getShopByChat(ctx.chat.id);
  if (shop) {
    await sendShopKit(ctx, shop);
    return;
  }
  saveOnboarding({ chat_id: ctx.chat.id, step: 'name', name: null, phone: null });
  try {
    await ctx.replyWithPhoto(new InputFile(WELCOME_IMAGE), { caption: WELCOME_TEXT });
  } catch (err) {
    console.error(`Could not send the welcome image: ${err.message}`);
    await ctx.reply(WELCOME_TEXT);
  }
  await ctx.reply('Step 1 of 3: Shop ka naam kya hai?');
}

const payoutKeyboard = () => new InlineKeyboard().text('PhonePe balance ✓', 'payout:phonepe');
const phoneKeyboard = () => new Keyboard().requestContact('📱 Share my number').resized().oneTime();

async function askPayout(ctx) {
  await ctx.reply('Number mil gaya ✓', { reply_markup: { remove_keyboard: true } });
  await ctx.reply('Step 3 of 3: Paise kahan aaye?', { reply_markup: payoutKeyboard() });
}

async function handleOnboardingText(ctx, row) {
  const text = ctx.message.text.trim();

  if (row.step === 'name') {
    if (!text || text.length > MAX_NAME_CHARS) {
      await ctx.reply(`Shop ka naam ${MAX_NAME_CHARS} characters tak rakhiye. Shop ka naam kya hai?`);
      return;
    }
    saveOnboarding({ ...row, step: 'phone', name: text });
    await ctx.reply('Step 2 of 3: Phone number? Button dabaiye ya type kijiye.', { reply_markup: phoneKeyboard() });
    return;
  }

  if (row.step === 'phone') {
    if (!PHONE_PATTERN.test(text)) {
      await ctx.reply('Yeh number sahi nahi lag raha. Phone number dobara bhejiye, e.g. 9876543210');
      return;
    }
    saveOnboarding({ ...row, step: 'payout', phone: text });
    await askPayout(ctx);
    return;
  }

  await ctx.reply('Step 3 of 3: Paise kahan aaye?', { reply_markup: payoutKeyboard() });
}

// Telegram lets people share any contact, so only their own number counts.
async function handleContact(ctx) {
  const row = getOnboarding(ctx.chat.id);
  if (row?.step !== 'phone') return;
  const { contact } = ctx.message;
  if (contact.user_id !== ctx.from.id) {
    await ctx.reply('Apna hi number share kijiye, ya type kar dijiye.');
    return;
  }
  saveOnboarding({ ...row, step: 'payout', phone: contact.phone_number });
  await askPayout(ctx);
}

function slugFor(name) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base || 'shop'}-${slugSuffix()}`;
}

async function handlePayout(ctx) {
  const chatId = ctx.chat.id;
  const row = getOnboarding(chatId);
  if (row?.step !== 'payout') {
    await ctx.answerCallbackQuery();
    return;
  }

  const shop = insertShop({
    slug: slugFor(row.name),
    name: row.name,
    phone: row.phone,
    telegram_chat_id: String(chatId),
    payout: 'phonepe',
    per_sale_cap_inr: config.DEFAULT_PER_SALE_CAP_INR,
    daily_cap_inr: config.DEFAULT_DAILY_CAP_INR,
  });
  deleteOnboarding(chatId);

  await ctx.answerCallbackQuery({ text: 'Shop ready ✓' });
  await ctx.editMessageText('Payout: PhonePe balance ✓');
  await sendShopKit(ctx, shop);
}

// Runs in the background, because a slow LLM would otherwise hold up the Approve and Claimed buttons.
async function answerWithAgent(ctx, shop) {
  try {
    if (!agentEnabled()) throw new Error('LLM_API_KEY or LLM_MODEL is not set');
    await ctx.replyWithChatAction('typing');
    const reply = await runAgent(shop, ctx.message.text);
    await ctx.reply(reply.slice(0, MAX_MESSAGE_CHARS));
  } catch (err) {
    console.error(`Agent failed: ${err.message}`);
    await ctx.reply(HELP_TEXT);
  }
}

async function handleText(ctx) {
  const shop = getShopByChat(ctx.chat.id);
  if (ctx.message.text.startsWith('/')) {
    await ctx.reply(shop ? HELP_TEXT : 'Shuru karne ke liye /start bhejiye.');
    return;
  }
  if (shop) {
    answerWithAgent(ctx, shop).catch((err) => console.error(`Could not reply: ${err.message}`));
    return;
  }
  const row = getOnboarding(ctx.chat.id);
  if (row) await handleOnboardingText(ctx, row);
  else await ctx.reply('Shuru karne ke liye /start bhejiye.');
}

// Commands for owners only, so a chat without a shop is pointed to /start.
function ownerCommand(handler) {
  return async (ctx) => {
    const shop = getShopByChat(ctx.chat.id);
    if (!shop) await ctx.reply('Shuru karne ke liye /start bhejiye.');
    else await handler(ctx, shop);
  };
}

async function handleToday(ctx, shop) {
  const { count, total_inr: total, unclaimed_cards: unclaimed } = getSalesSummary(shop, 'today');
  await ctx.reply(`Aaj: ${count} sale(s), ${rupees(total)}. Unclaimed cards: ${unclaimed}.`);
}

async function handleSales(ctx, shop) {
  const sales = listRecentSales(shop);
  if (!sales.length) {
    await ctx.reply('Abhi tak koi sale nahi.');
    return;
  }
  await ctx.reply(sales.map((sale) => `${sale.ref}  ${rupees(sale.amount_inr)}  ${sale.status}`).join('\n'));
}

async function handleCaps(ctx, shop) {
  const [perSale, daily] = ctx.match.trim().split(/\s+/).map(Number);
  if (!perSale || !daily) {
    await ctx.reply('Usage: /caps <per_sale> <daily>, e.g. /caps 500 2000');
    return;
  }
  const result = changeCaps(shop.id, { per_sale_inr: perSale, daily_inr: daily });
  await ctx.reply(
    result.error ?? `Limits updated: ${rupees(result.per_sale_inr)} per sale, ${rupees(result.daily_inr)} per day.`,
  );
}

export function startBot() {
  bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  bot.command('start', handleStart);
  bot.command('retry', handleRetry);
  bot.command('help', (ctx) => ctx.reply(`Main Sikku hoon! Aaj ki kamai ya limits ke baare mein seedha pooch sakte hain.\n\n${HELP_TEXT}`));
  bot.command('today', ownerCommand(handleToday));
  bot.command('sales', ownerCommand(handleSales));
  bot.command('caps', ownerCommand(handleCaps));
  bot.callbackQuery(/^claim:(.+)$/, handleClaim);
  bot.callbackQuery(/^approve:(.+)$/, handleApprove);
  bot.callbackQuery(/^reject:(.+)$/, handleReject);
  bot.callbackQuery('payout:phonepe', handlePayout);
  bot.on('message:contact', handleContact);
  bot.on('message:text', handleText);
  bot.catch((err) => console.error(`Telegram handler failed: ${err.message}`));

  bot
    .start({
      onStart: (me) => {
        botUsername = me.username;
        console.log(`Telegram bot @${me.username} is running`);
        bot.api.setMyCommands(COMMANDS).catch((err) => console.error(`Could not set bot commands: ${err.message}`));
      },
    })
    .catch((err) => console.error(`Telegram bot stopped: ${err.message}`));
}
