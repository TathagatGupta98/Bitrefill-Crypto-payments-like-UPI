import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const db = new Database(path.join(ROOT, 'sikka.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  telegram_chat_id TEXT UNIQUE NOT NULL,
  payout TEXT NOT NULL DEFAULT 'phonepe',
  per_sale_cap_inr INTEGER NOT NULL,
  daily_cap_inr INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  amount_inr INTEGER NOT NULL,
  usd_cost REAL,
  usdc_amount_units TEXT NOT NULL,
  status TEXT NOT NULL,
  pay_address TEXT,
  payer_address TEXT,
  payer_tx_hash TEXT,
  bitrefill_invoice_id TEXT,
  bitrefill_order_id TEXT,
  card_code TEXT,
  card_pin TEXT,
  card_link TEXT,
  card_instructions TEXT,
  error TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT, delivered_at TEXT, claimed_at TEXT
);

CREATE TABLE IF NOT EXISTS chain_cursor (id INTEGER PRIMARY KEY CHECK (id=1), last_block INTEGER);
CREATE TABLE IF NOT EXISTS seen_logs (tx_hash TEXT, log_index INTEGER, PRIMARY KEY (tx_hash, log_index));
CREATE TABLE IF NOT EXISTS onboarding (chat_id TEXT PRIMARY KEY, step TEXT, name TEXT, phone TEXT);
`);

// CREATE TABLE IF NOT EXISTS doesn't add columns to a database made by an earlier version.
if (!db.pragma('table_info(sales)').some((column) => column.name === 'pay_address')) {
  db.exec('ALTER TABLE sales ADD COLUMN pay_address TEXT');
}

// Sales that count towards the daily caps. Expired, rejected and failed sales release their share.
const COUNTED_STATUSES = `('awaiting_approval', 'awaiting_payment', 'paid', 'purchasing', 'delivered', 'claimed')`;
// Timestamps are stored in UTC, but the caps reset at midnight in India.
const IS_TODAY_IST = `date(created_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')`;

const shopById = db.prepare('SELECT * FROM shops WHERE id = ?');
const shopBySlug = db.prepare('SELECT * FROM shops WHERE slug = ?');
const shopByChat = db.prepare('SELECT * FROM shops WHERE telegram_chat_id = ?');
const saleById = db.prepare('SELECT * FROM sales WHERE id = ?');
const saleInsert = db.prepare(`
  INSERT INTO sales (id, shop_id, amount_inr, usd_cost, usdc_amount_units, status, expires_at,
                     pay_address, bitrefill_invoice_id, bitrefill_order_id)
  VALUES (@id, @shop_id, @amount_inr, @usd_cost, @usdc_amount_units, @status, @expires_at,
          @pay_address, @bitrefill_invoice_id, @bitrefill_order_id)
`);
const shopToday = db.prepare(`
  SELECT COUNT(*) AS count, COALESCE(SUM(amount_inr), 0) AS totalInr
  FROM sales
  WHERE shop_id = ? AND id IS NOT ? AND status IN ${COUNTED_STATUSES} AND ${IS_TODAY_IST}
`);
const spendToday = db.prepare(`
  SELECT COALESCE(SUM(usd_cost), 0) AS total
  FROM sales
  WHERE id IS NOT ? AND status IN ${COUNTED_STATUSES} AND ${IS_TODAY_IST}
`);

const openUnits = db.prepare(`
  SELECT usdc_amount_units FROM sales WHERE status IN ('awaiting_approval', 'awaiting_payment')
`);
const payableSale = db.prepare(`
  SELECT * FROM sales WHERE status = 'awaiting_payment' AND usdc_amount_units = ? AND expires_at > ?
`);
const expireSales = db.prepare(`
  UPDATE sales SET status = 'expired'
  WHERE status IN ('awaiting_approval', 'awaiting_payment') AND expires_at <= ?
`);
const cursorRead = db.prepare('SELECT last_block FROM chain_cursor WHERE id = 1');
const cursorWrite = db.prepare(`
  INSERT INTO chain_cursor (id, last_block) VALUES (1, ?)
  ON CONFLICT (id) DO UPDATE SET last_block = excluded.last_block
`);
const seenLogInsert = db.prepare('INSERT OR IGNORE INTO seen_logs (tx_hash, log_index) VALUES (?, ?)');
const expiredSale = db.prepare(`
  SELECT * FROM sales WHERE status = 'expired' AND usdc_amount_units = ? ORDER BY expires_at DESC
`);
const directSales = db.prepare(`
  SELECT * FROM sales WHERE status = 'awaiting_payment' AND bitrefill_invoice_id IS NOT NULL
`);

const shopInsert = db.prepare(`
  INSERT INTO shops (slug, name, phone, telegram_chat_id, payout, per_sale_cap_inr, daily_cap_inr)
  VALUES (@slug, @name, @phone, @telegram_chat_id, @payout, @per_sale_cap_inr, @daily_cap_inr)
`);
const capsUpdate = db.prepare('UPDATE shops SET per_sale_cap_inr = ?, daily_cap_inr = ? WHERE id = ?');
const onboardingRead = db.prepare('SELECT * FROM onboarding WHERE chat_id = ?');
const onboardingWrite = db.prepare(`
  INSERT INTO onboarding (chat_id, step, name, phone) VALUES (@chat_id, @step, @name, @phone)
  ON CONFLICT (chat_id) DO UPDATE SET step = excluded.step, name = excluded.name, phone = excluded.phone
`);
const onboardingDelete = db.prepare('DELETE FROM onboarding WHERE chat_id = ?');

// Only money that actually reached the shop counts as earned.
const EARNED_STATUSES = `('delivered', 'claimed')`;
const PERIOD_FILTERS = {
  today: IS_TODAY_IST,
  week: `created_at >= datetime('now', '-7 days')`,
  all: '1 = 1',
};
const summaryByPeriod = Object.fromEntries(
  Object.entries(PERIOD_FILTERS).map(([period, filter]) => [
    period,
    db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(amount_inr), 0) AS totalInr,
             COALESCE(SUM(status = 'delivered'), 0) AS unclaimed
      FROM sales WHERE shop_id = ? AND status IN ${EARNED_STATUSES} AND ${filter}
    `),
  ]),
);
// These two lists leave out the card columns on purpose.
const recent = db.prepare(`
  SELECT id, amount_inr, status, created_at FROM sales WHERE shop_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
`);
const adminList = db.prepare(`
  SELECT s.id, shops.name AS shop, s.amount_inr, s.usd_cost, s.usdc_amount_units, s.status, s.payer_address,
         s.payer_tx_hash, s.bitrefill_invoice_id, s.bitrefill_order_id, s.error, s.created_at
  FROM sales s JOIN shops ON shops.id = s.shop_id ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?
`);
const unclaimed = db.prepare(`SELECT * FROM sales WHERE shop_id = ? AND status = 'delivered' ORDER BY created_at`);

// Same format as SQLite's datetime('now'), so stored timestamps compare correctly.
export const sqlTime = (date = new Date()) => date.toISOString().slice(0, 19).replace('T', ' ');
export const saleRef = (id) => `SIK-${id.slice(0, 6).toUpperCase()}`;

export const getShopById = (id) => shopById.get(id);
export const getShopBySlug = (slug) => shopBySlug.get(slug);
export const getShopByChat = (chatId) => shopByChat.get(String(chatId));
export const getSale = (id) => saleById.get(id);
export const insertSale = (sale) => saleInsert.run(sale);

// Returns false if the sale wasn't in `from`, meaning another caller already moved it.
// `fields` keys are column names and must only ever come from our own code.
export function transition(id, from, to, fields = {}) {
  const columns = Object.keys(fields);
  const assignments = ['status = ?', ...columns.map((column) => `${column} = ?`)].join(', ');
  const result = db
    .prepare(`UPDATE sales SET ${assignments} WHERE id = ? AND status = ?`)
    .run(to, ...columns.map((column) => fields[column]), id, from);
  return result.changes === 1;
}

// `excludeSaleId` stops a sale counting against itself when it is re-checked before buying.
export const salesToday = (shopId, excludeSaleId = null) => shopToday.get(shopId, excludeSaleId);
export const spendTodayUsd = (excludeSaleId = null) => spendToday.get(excludeSaleId).total;

export const openSaleUnits = () => openUnits.all().map((row) => row.usdc_amount_units);
export const findPayableSale = (units) => payableSale.get(units, sqlTime());
export const expireOldSales = () => expireSales.run(sqlTime()).changes;

export const getChainCursor = () => cursorRead.get()?.last_block ?? null;
export const setChainCursor = (block) => cursorWrite.run(block);
// Returns false if this log was already handled.
export const markLogSeen = (txHash, logIndex) => seenLogInsert.run(txHash, logIndex).changes === 1;
// The newest expired sale for an amount, used to tell the right shop about a late payment.
export const findExpiredSale = (units) => expiredSale.get(units);
export const awaitingDirectSales = () => directSales.all();

export function insertShop(shop) {
  shopInsert.run(shop);
  return getShopBySlug(shop.slug);
}
export const updateCaps = (shopId, perSaleInr, dailyInr) => capsUpdate.run(perSaleInr, dailyInr, shopId);

export const getOnboarding = (chatId) => onboardingRead.get(String(chatId));
export const saveOnboarding = (row) => onboardingWrite.run({ ...row, chat_id: String(row.chat_id) });
export const deleteOnboarding = (chatId) => onboardingDelete.run(String(chatId));

export const salesSummary = (shopId, period) => summaryByPeriod[period].get(shopId);
export const recentSales = (shopId, limit) => recent.all(shopId, limit);
export const unclaimedSales = (shopId) => unclaimed.all(shopId);
export const adminSales = (limit) => adminList.all(limit);
