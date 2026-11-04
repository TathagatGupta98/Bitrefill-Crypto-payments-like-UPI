import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot, InlineKeyboard, InputFile, Keyboard } from 'grammy';
import { customAlphabet } from 'nanoid';
import { agentEnabled, changeCaps, getSalesSummary, listRecentSales, runAgent } from './agent.js';
import { issueRevealLink } from './cards.js';
import { config } from './config.js';
import {
  deleteOnboarding,
  getOnboarding,
  getSale,
  getShopByChat,
  insertShop,
  logEvent,
  saleRef,
  saveOnboarding,
  setCardMessage,
  setShopLang,
  setShopPin,
  transition,
  unclaimedSales,
} from './db.js';
import { retrySale } from './fulfill.js';
import { approveSale, shopPayUrl, shopQrPng, soundboxUrl } from './sales.js';
import { hashPin, newSecret } from './vault.js';

const MAX_NAME_CHARS = 60;
const MAX_MESSAGE_CHARS = 4000;
const PHONE_PATTERN = /^\+?[\d\s-]{10,16}$/;
const WEAK_PINS = ['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321'];
const WELCOME_IMAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'mascot', 'sikku-welcome.png');
// Shown before the owner has chosen, so it's the only message in both languages.
const CHOOSE_LANGUAGE = 'नमस्ते! 🙏 मैं सिक्कू हूँ। अपनी भाषा चुनिए।\nNamaste! I\'m Sikku. Please choose your language.';
const COMMANDS = [
  { command: 'start', description: 'Set up your shop, or get your QR again' },
  { command: 'today', description: "Today's sales" },
  { command: 'sales', description: 'Recent sales' },
  { command: 'cards', description: 'Get links for unclaimed cards' },
  { command: 'caps', description: 'Change limits: /caps 500 2000' },
  { command: 'setpin', description: 'Change your card PIN' },
  { command: 'language', description: 'Choose Hindi or English' },
  { command: 'help', description: 'What Sikku can do' },
];

const slugSuffix = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 4);

let bot;
let botUsername = null;

export const getBotUsername = () => botUsername;

const rupees = (inr) => `₹${inr.toLocaleString('en-IN')}`;
const say = (lang, hindi, english) => (lang === 'hi' ? hindi : english);
const startFirst = (lang) => say(lang, 'शुरू करने के लिए /start भेजिए।', 'Send /start to begin.');
const languageKeyboard = () => new InlineKeyboard().text('हिंदी', 'lang:hi').text('English', 'lang:en');

function helpText(lang) {
  return say(
    lang,
    [
      'आप मुझसे सीधे पूछ सकते हैं, जैसे "आज कितना आया?"',
      '',
      '/today – आज की बिक्री',
      '/sales – हाल की बिक्री',
      '/cards – बिना क्लेम वाले कार्ड',
      '/caps <प्रति बिक्री> <प्रति दिन> – लिमिट बदलें',
      '/setpin – PIN बदलें',
      '/language – भाषा बदलें',
    ].join('\n'),
    [
      'You can just ask me, like "how much came in today?"',
      '',
      "/today – Today's sales",
      '/sales – Recent sales',
      '/cards – Unclaimed cards',
      '/caps <per_sale> <daily> – Change limits',
      '/setpin – Change your PIN',
      '/language – Change language',
    ].join('\n'),
  );
}

// The code is deliberately not in this message: Telegram keeps bot chats on its servers.
function sealedCardMessage(sale, lang) {
  const amount = rupees(sale.amount_inr);
  return [
    say(lang, `✅ क्रिप्टो से ${amount} प्राप्त हुए!`, `✅ ${amount} received in crypto!`),
    '',
    say(
      lang,
      '🔒 आपका PhonePe गिफ्ट कार्ड सील है। कोड इस चैट में नहीं है।',
      '🔒 Your PhonePe gift card is sealed. The code is not in this chat.',
    ),
    '',
    `[Ref: ${saleRef(sale.id)} · Invoice: ${sale.bitrefill_invoice_id}]`,
  ].join('\n');
}

export async function sendCard(shop, sale) {
  const link = `${issueRevealLink(sale)}${shop.lang === 'hi' ? '?lang=hi' : ''}`;
  const message = await bot.api.sendMessage(shop.telegram_chat_id, sealedCardMessage(sale, shop.lang), {
    reply_markup: new InlineKeyboard().url(say(shop.lang, '🔓 कार्ड खोलें', '🔓 Reveal card'), link),
  });
  setCardMessage(sale.id, message.message_id);
  logEvent(sale.id, 'owner_notified', 'Owner told on Telegram, with no code in the message');
}

export async function markCardClaimed(shop, sale) {
  const { card_message_id: messageId, bitrefill_invoice_id: invoiceId } = getSale(sale.id);
  if (!messageId) return;
  const amount = rupees(sale.amount_inr);
  try {
    await bot.api.editMessageText(
      shop.telegram_chat_id,
      messageId,
      `${say(shop.lang, `✅ ${amount} क्लेम हो गया, कोड मिटा दिया गया।`, `✅ ${amount} claimed, code deleted.`)}\n\n[Ref: ${saleRef(sale.id)} · Invoice: ${invoiceId}]`,
    );
  } catch (err) {
    console.error(`Could not update the card message for ${saleRef(sale.id)}: ${err.message}`);
  }
}

export async function notifyOwner(shop, hindi, english) {
  try {
    await bot.api.sendMessage(shop.telegram_chat_id, say(shop.lang, hindi, english));
  } catch (err) {
    console.error(`Could not message shop ${shop.slug}: ${err.message}`);
  }
}

// If this message can't be sent, the customer's page waits until the sale expires.
export async function requestApproval(shop, sale) {
  const amount = rupees(sale.amount_inr);
  const limit = rupees(shop.per_sale_cap_inr);
  try {
    await bot.api.sendMessage(
      shop.telegram_chat_id,
      say(
        shop.lang,
        `ग्राहक ${amount} देना चाहता है, जो आपकी ${limit} लिमिट से ज़्यादा है। मंज़ूरी दें?`,
        `Customer wants to pay ${amount} (over your ${limit} limit). Approve?`,
      ),
      {
        reply_markup: new InlineKeyboard()
          .text(say(shop.lang, '✅ मंज़ूर', '✅ Approve'), `approve:${sale.id}`)
          .text(say(shop.lang, '❌ मना', '❌ Reject'), `reject:${sale.id}`),
      },
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

async function handleApprove(ctx) {
  const { shop, sale } = findOwnSale(ctx.chat?.id, ctx.match[1]);
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
  await ctx.answerCallbackQuery({ text: approved ? say(shop.lang, 'मंज़ूर ✓', 'Approved ✓') : say(shop.lang, 'मंज़ूरी नहीं हो सकी', 'Could not approve this sale') });
  if (approved) {
    logEvent(sale.id, 'owner_approved', 'Owner approved a sale over the per-sale limit');
    await ctx.editMessageText(say(shop.lang, `✅ ${rupees(sale.amount_inr)} मंज़ूर (${saleRef(sale.id)})`, `✅ Approved ${rupees(sale.amount_inr)} (${saleRef(sale.id)})`));
  }
}

async function handleReject(ctx) {
  const { shop, sale } = findOwnSale(ctx.chat?.id, ctx.match[1]);
  const rejected = sale ? transition(sale.id, 'awaiting_approval', 'rejected') : false;
  await ctx.answerCallbackQuery({ text: rejected ? say(shop.lang, 'मना कर दिया', 'Rejected') : 'This sale can no longer be rejected' });
  if (rejected) {
    logEvent(sale.id, 'owner_rejected', 'Owner rejected a sale over the per-sale limit');
    await ctx.editMessageText(say(shop.lang, `❌ ${rupees(sale.amount_inr)} मना (${saleRef(sale.id)})`, `❌ Rejected ${rupees(sale.amount_inr)} (${saleRef(sale.id)})`));
  }
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
  const lang = shop.lang;
  await ctx.replyWithPhoto(new InputFile(await shopQrPng(shop), 'sikka-qr.png'), {
    caption: say(lang, `${shop.name} का पेमेंट QR। ग्राहक इसे फ़ोन कैमरे से स्कैन करे।`, `${shop.name}'s payment QR. Customers scan it with their phone camera.`),
  });
  await ctx.reply(
    say(
      lang,
      [
        '✅ आपकी दुकान तैयार है!',
        '',
        '1. 🖨 स्टैंडी प्रिंट करके काउंटर पर रखिए',
        '2. 🔊 साउंडबॉक्स काउंटर के पास वाले फ़ोन पर खोलिए',
        '3. 🧪 एक बार पे पेज देख लीजिए',
        '',
        `लिमिट: बिना मंज़ूरी ${rupees(shop.per_sale_cap_inr)} प्रति बिक्री, ${rupees(shop.daily_cap_inr)} प्रति दिन। बदलनी हो तो बस मुझसे कहिए।`,
      ].join('\n'),
      [
        '✅ Your shop is ready!',
        '',
        '1. 🖨 Print the standee for your counter',
        '2. 🔊 Open the soundbox on a phone near your counter',
        '3. 🧪 Check your pay page once',
        '',
        `Limits: ${rupees(shop.per_sale_cap_inr)} per sale without approval, ${rupees(shop.daily_cap_inr)} per day. Change anytime, just ask me.`,
      ].join('\n'),
    ),
    {
      reply_markup: new InlineKeyboard()
        .url(say(lang, '🖨 स्टैंडी', '🖨 Standee'), `${config.PUBLIC_URL}/standee/${shop.slug}`)
        .url(say(lang, '🔊 साउंडबॉक्स', '🔊 Soundbox'), soundboxUrl(shop))
        .row()
        .url(say(lang, '🧪 पे पेज', '🧪 Pay page'), shopPayUrl(shop)),
    },
  );
}

async function askForPin(ctx, lang, prefix = '') {
  await ctx.reply(
    `${prefix}${say(
      lang,
      '4 अंकों का PIN चुनिए। इसी से आपके गिफ्ट कार्ड खुलेंगे। इसे किसी को न बताएँ।',
      'Choose a 4-digit PIN. It opens your gift cards. Keep it private.',
    )}`,
  );
}

async function handleStart(ctx) {
  const shop = getShopByChat(ctx.chat.id);
  if (shop) {
    if (!shop.pin_hash) {
      saveOnboarding({ chat_id: ctx.chat.id, step: 'pin', name: shop.name, phone: null, lang: shop.lang });
      await askForPin(ctx, shop.lang);
      return;
    }
    await sendShopKit(ctx, shop);
    return;
  }
  saveOnboarding({ chat_id: ctx.chat.id, step: 'lang', name: null, phone: null, lang: null });
  try {
    await ctx.replyWithPhoto(new InputFile(WELCOME_IMAGE), { caption: CHOOSE_LANGUAGE, reply_markup: languageKeyboard() });
  } catch (err) {
    console.error(`Could not send the welcome image: ${err.message}`);
    await ctx.reply(CHOOSE_LANGUAGE, { reply_markup: languageKeyboard() });
  }
}

async function handleLanguageChoice(ctx) {
  const lang = ctx.match[1];
  const shop = getShopByChat(ctx.chat.id);
  const row = getOnboarding(ctx.chat.id);
  await ctx.answerCallbackQuery({ text: lang === 'hi' ? 'हिंदी ✓' : 'English ✓' });
  await ctx.editMessageReplyMarkup().catch(() => {});

  if (shop) {
    setShopLang(shop.id, lang);
    if (row) saveOnboarding({ ...row, lang });
    await ctx.reply(say(lang, 'ठीक है, अब मैं हिंदी में बात करूँगा।', "Done. I'll use English from now on."));
    return;
  }
  if (row?.step !== 'lang') return;

  saveOnboarding({ ...row, step: 'name', lang });
  await ctx.reply(
    say(
      lang,
      'सिक्का से आप बिना किसी वॉलेट के क्रिप्टो पेमेंट ले सकते हैं। 4 छोटे सवाल, फिर आपका QR तैयार।',
      'With Sikka you can accept crypto without a wallet. 4 short questions, then your QR is ready.',
    ),
  );
  await ctx.reply(say(lang, 'स्टेप 1/4: आपकी दुकान का नाम क्या है?', 'Step 1 of 4: What is your shop called?'));
}

const payoutKeyboard = (lang) => new InlineKeyboard().text(say(lang, 'PhonePe बैलेंस ✓', 'PhonePe balance ✓'), 'payout:phonepe');
const phoneKeyboard = (lang) => new Keyboard().requestContact(say(lang, '📱 मेरा नंबर भेजें', '📱 Share my number')).resized().oneTime();
const payoutQuestion = (lang) => say(lang, 'स्टेप 3/4: पैसे कहाँ आएँ?', 'Step 3 of 4: How would you like to be paid?');

async function askPayout(ctx, lang) {
  await ctx.reply(say(lang, 'नंबर मिल गया ✓', 'Got your number ✓'), { reply_markup: { remove_keyboard: true } });
  await ctx.reply(payoutQuestion(lang), { reply_markup: payoutKeyboard(lang) });
}

async function acceptPin(ctx, row, text) {
  const { lang } = row;
  if (!/^\d{4}$/.test(text) || WEAK_PINS.includes(text)) {
    await ctx.reply(say(lang, 'यह PIN नहीं चलेगा। 4 अंक चुनिए, जो 1234 या 0000 जैसे आसान न हों।', "That PIN won't work. Choose 4 digits that aren't easy to guess, like 1234 or 0000."));
    return;
  }
  const shop = getShopByChat(ctx.chat.id);
  setShopPin(shop.id, hashPin(text));
  deleteOnboarding(ctx.chat.id);
  // Best effort, so the PIN doesn't stay in the chat history.
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply(say(lang, '🔒 PIN सेव हो गया। आपका संदेश हटा दिया गया।', '🔒 PIN saved, and your message was removed.'));
  if (row.name) await sendShopKit(ctx, getShopByChat(ctx.chat.id));
}

async function handleOnboardingText(ctx, row) {
  const text = ctx.message.text.trim();
  const { lang } = row;

  if (row.step === 'lang') {
    await ctx.reply(CHOOSE_LANGUAGE, { reply_markup: languageKeyboard() });
    return;
  }

  if (row.step === 'pin') {
    await acceptPin(ctx, row, text);
    return;
  }

  if (row.step === 'name') {
    if (!text || text.length > MAX_NAME_CHARS) {
      await ctx.reply(say(lang, `दुकान का नाम ${MAX_NAME_CHARS} अक्षरों तक रखिए।`, `Please keep the shop name under ${MAX_NAME_CHARS} characters.`));
      return;
    }
    saveOnboarding({ ...row, step: 'phone', name: text });
    await ctx.reply(say(lang, 'स्टेप 2/4: फ़ोन नंबर? बटन दबाइए या टाइप कीजिए।', 'Step 2 of 4: Phone number? Tap the button or type it.'), {
      reply_markup: phoneKeyboard(lang),
    });
    return;
  }

  if (row.step === 'phone') {
    if (!PHONE_PATTERN.test(text)) {
      await ctx.reply(say(lang, 'यह नंबर सही नहीं लग रहा। दोबारा भेजिए, जैसे 9876543210', "That number doesn't look right. Please send it again, like 9876543210"));
      return;
    }
    saveOnboarding({ ...row, step: 'payout', phone: text });
    await askPayout(ctx, lang);
    return;
  }

  await ctx.reply(payoutQuestion(lang), { reply_markup: payoutKeyboard(lang) });
}

// Telegram lets people share any contact, so only their own number counts.
async function handleContact(ctx) {
  const row = getOnboarding(ctx.chat.id);
  if (row?.step !== 'phone') return;
  const { contact } = ctx.message;
  if (contact.user_id !== ctx.from.id) {
    await ctx.reply(say(row.lang, 'अपना ही नंबर भेजिए, या टाइप कर दीजिए।', 'Please share your own number, or type it.'));
    return;
  }
  saveOnboarding({ ...row, step: 'payout', phone: contact.phone_number });
  await askPayout(ctx, row.lang);
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

  insertShop({
    slug: slugFor(row.name),
    name: row.name,
    phone: row.phone,
    telegram_chat_id: String(chatId),
    payout: 'phonepe',
    per_sale_cap_inr: config.DEFAULT_PER_SALE_CAP_INR,
    daily_cap_inr: config.DEFAULT_DAILY_CAP_INR,
    soundbox_key: newSecret(),
    lang: row.lang ?? 'en',
  });
  saveOnboarding({ ...row, step: 'pin', phone: null });

  await ctx.answerCallbackQuery({ text: 'PhonePe ✓' });
  await ctx.editMessageText(say(row.lang, 'पेमेंट: PhonePe बैलेंस ✓', 'Payout: PhonePe balance ✓'));
  await askForPin(ctx, row.lang, say(row.lang, 'स्टेप 4/4: ', 'Step 4 of 4: '));
}

// Runs in the background, because a slow LLM would otherwise hold up the Approve and Reject buttons.
async function answerWithAgent(ctx, shop) {
  try {
    if (!agentEnabled()) throw new Error('LLM_API_KEY or LLM_MODEL is not set');
    await ctx.replyWithChatAction('typing');
    const reply = await runAgent(shop, ctx.message.text);
    await ctx.reply(reply.slice(0, MAX_MESSAGE_CHARS));
  } catch (err) {
    console.error(`Agent failed: ${err.message}`);
    await ctx.reply(helpText(shop.lang));
  }
}

async function handleText(ctx) {
  const shop = getShopByChat(ctx.chat.id);
  const row = getOnboarding(ctx.chat.id);
  if (ctx.message.text.startsWith('/')) {
    await ctx.reply(shop ? helpText(shop.lang) : startFirst(row?.lang));
    return;
  }
  if (row) {
    await handleOnboardingText(ctx, row);
    return;
  }
  if (shop) {
    answerWithAgent(ctx, shop).catch((err) => console.error(`Could not reply: ${err.message}`));
    return;
  }
  await ctx.reply(`${startFirst('hi')}\n${startFirst('en')}`);
}

// Commands for owners only, so a chat without a shop is pointed to /start.
function ownerCommand(handler) {
  return async (ctx) => {
    const shop = getShopByChat(ctx.chat.id);
    if (!shop) await ctx.reply(`${startFirst('hi')}\n${startFirst('en')}`);
    else await handler(ctx, shop);
  };
}

async function handleToday(ctx, shop) {
  const { count, total_inr: total, unclaimed_cards: unclaimed } = getSalesSummary(shop, 'today');
  await ctx.reply(
    say(
      shop.lang,
      `आज: ${count} बिक्री, ${rupees(total)}। बिना क्लेम वाले कार्ड: ${unclaimed}।`,
      `Today: ${count} sale(s), ${rupees(total)}. Unclaimed cards: ${unclaimed}.`,
    ),
  );
}

async function handleSales(ctx, shop) {
  const sales = listRecentSales(shop);
  if (!sales.length) {
    await ctx.reply(say(shop.lang, 'अभी तक कोई बिक्री नहीं।', 'No sales yet.'));
    return;
  }
  await ctx.reply(sales.map((sale) => `${sale.ref}  ${rupees(sale.amount_inr)}  ${sale.status}`).join('\n'));
}

async function handleCaps(ctx, shop) {
  const [perSale, daily] = ctx.match.trim().split(/\s+/).map(Number);
  if (!perSale || !daily) {
    await ctx.reply(say(shop.lang, 'ऐसे लिखिए: /caps 500 2000', 'Usage: /caps <per_sale> <daily>, e.g. /caps 500 2000'));
    return;
  }
  const result = changeCaps(shop.id, { per_sale_inr: perSale, daily_inr: daily });
  await ctx.reply(
    result.error ??
      say(
        shop.lang,
        `लिमिट बदल गई: ${rupees(result.per_sale_inr)} प्रति बिक्री, ${rupees(result.daily_inr)} प्रति दिन।`,
        `Limits updated: ${rupees(result.per_sale_inr)} per sale, ${rupees(result.daily_inr)} per day.`,
      ),
  );
}

async function handleCards(ctx, shop) {
  const sales = unclaimedSales(shop.id);
  if (!sales.length) {
    await ctx.reply(say(shop.lang, 'कोई बिना क्लेम वाला कार्ड नहीं है।', 'You have no unclaimed cards.'));
    return;
  }
  for (const sale of sales) await sendCard(shop, sale);
}

async function handleSetPin(ctx, shop) {
  saveOnboarding({ chat_id: ctx.chat.id, step: 'pin', name: null, phone: null, lang: shop.lang });
  await askForPin(ctx, shop.lang);
}

async function handleLanguageCommand(ctx, shop) {
  await ctx.reply(say(shop.lang, 'अपनी भाषा चुनिए।', 'Please choose your language.'), { reply_markup: languageKeyboard() });
}

async function handleHelp(ctx) {
  const shop = getShopByChat(ctx.chat.id);
  await ctx.reply(shop ? helpText(shop.lang) : `${startFirst('hi')}\n${startFirst('en')}`);
}

export function startBot() {
  bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  bot.command('start', handleStart);
  bot.command('help', handleHelp);
  bot.command('retry', handleRetry);
  bot.command('today', ownerCommand(handleToday));
  bot.command('sales', ownerCommand(handleSales));
  bot.command('caps', ownerCommand(handleCaps));
  bot.command('cards', ownerCommand(handleCards));
  bot.command('setpin', ownerCommand(handleSetPin));
  bot.command('language', ownerCommand(handleLanguageCommand));
  // Buttons on messages sent before cards were sealed.
  bot.callbackQuery(/^claim:/, (ctx) => ctx.answerCallbackQuery({ text: 'Use /cards for a new link' }));
  bot.callbackQuery(/^approve:(.+)$/, handleApprove);
  bot.callbackQuery(/^reject:(.+)$/, handleReject);
  bot.callbackQuery(/^lang:(hi|en)$/, handleLanguageChoice);
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
