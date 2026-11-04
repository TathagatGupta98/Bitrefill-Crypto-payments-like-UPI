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

// Sales that count towards the daily caps. Expired, rejected and failed sales release their share.
const COUNTED_STATUSES = `('awaiting_approval', 'awaiting_payment', 'paid', 'purchasing', 'delivered', 'claimed')`;
// Timestamps are stored in UTC, but the caps reset at midnight in India.
const IS_TODAY_IST = `date(created_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')`;

const shopBySlug = db.prepare('SELECT * FROM shops WHERE slug = ?');
const shopByChat = db.prepare('SELECT * FROM shops WHERE telegram_chat_id = ?');
const saleInsert = db.prepare(`
  INSERT INTO sales (id, shop_id, amount_inr, usd_cost, usdc_amount_units, status, expires_at)
  VALUES (@id, @shop_id, @amount_inr, @usd_cost, @usdc_amount_units, @status, @expires_at)
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

export const getShopBySlug = (slug) => shopBySlug.get(slug);
export const getShopByChat = (chatId) => shopByChat.get(String(chatId));
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
