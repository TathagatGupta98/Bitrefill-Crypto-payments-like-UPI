import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import QRCode from 'qrcode';
import { getBotUsername } from './bot.js';
import { claimCard, revealCard } from './cards.js';
import { config } from './config.js';
import { adminSales, getSale, getShopBySlug, logEvent, saleEvents, saleRef, salesSummary, sqlTime, transition } from './db.js';
import { sseHandler } from './events.js';
import { fulfillSale } from './fulfill.js';
import { amountOptions, createSale, saleView, shopQrPng } from './sales.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export const routes = Router();

routes.use(express.static(PUBLIC_DIR, { index: false }));

const ADMIN_SALES_LIMIT = 100;

const botUrl = () => (getBotUsername() ? `https://t.me/${getBotUsername()}?start=web` : null);

routes.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'home.html')));
routes.get('/how-it-works', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'how.html')));
routes.get('/start', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'start.html')));
routes.get('/api/bot', (req, res) => res.json({ username: getBotUsername(), url: botUrl() }));
routes.get('/bot-qr.png', async (req, res) => {
  if (!botUrl()) return res.status(503).json({ reason: 'bot is not connected yet' });
  res.type('png').send(await QRCode.toBuffer(botUrl(), { width: 480, margin: 1 }));
});

routes.get('/pay/:slug', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'pay.html')));
routes.get('/standee/:slug', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'standee.html')));
routes.get('/soundbox/:slug', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'soundbox.html')));

routes.get('/qr/:slug.png', async (req, res) => {
  const shop = getShopBySlug(req.params.slug);
  if (!shop) return res.status(404).json({ reason: 'shop not found' });
  res.type('png').send(await shopQrPng(shop));
});

routes.get('/api/shops/:slug', async (req, res) => {
  const shop = getShopBySlug(req.params.slug);
  if (!shop) return res.status(404).json({ reason: 'shop not found' });
  res.json({ name: shop.name, verified: true, amounts: await amountOptions(shop) });
});

// The name is public anyway, because it's printed on the standee.
routes.get('/api/shops/:slug/name', (req, res) => {
  const shop = getShopBySlug(req.params.slug);
  if (!shop) return res.status(404).json({ reason: 'shop not found' });
  res.json({ name: shop.name });
});

// Sales figures are private, so the soundbox needs the key from the owner's Telegram link.
function soundboxShop(req, res) {
  const shop = getShopBySlug(req.params.slug);
  if (!shop) {
    res.status(404).json({ reason: 'shop not found' });
    return null;
  }
  if (!shop.soundbox_key || req.query.k !== shop.soundbox_key) {
    res.status(403).json({ reason: 'open the soundbox link from your Telegram chat' });
    return null;
  }
  return shop;
}

routes.get('/api/shops/:slug/summary', (req, res) => {
  const shop = soundboxShop(req, res);
  if (!shop) return;
  const { count, totalInr } = salesSummary(shop.id, 'today');
  res.json({ name: shop.name, todayCount: count, todayInr: totalInr });
});

routes.get('/api/shops/:slug/events', (req, res) => {
  const shop = soundboxShop(req, res);
  if (shop) sseHandler(shop.slug)(req, res);
});

routes.get('/card/:token', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'card.html')));

// Browsers and proxies must never keep a copy of a card.
function sendCardResult(res, result) {
  res.set('Cache-Control', 'no-store');
  if (result.reason) {
    return res.status(result.status).json({ reason: result.reason, attemptsLeft: result.attemptsLeft });
  }
  res.json(result);
}

routes.post('/api/cards/:token/reveal', (req, res) => sendCardResult(res, revealCard(req.params.token, req.body?.pin)));
routes.post('/api/cards/:token/claim', (req, res) => sendCardResult(res, claimCard(req.params.token, req.body?.pin)));

routes.post('/api/sales', async (req, res) => {
  const { slug, amountInr } = req.body ?? {};
  const { sale, reason } = await createSale(slug, amountInr);
  if (!sale) return res.status(400).json({ reason });
  res.status(201).json(saleView(getSale(sale.id)));
});

routes.get('/api/sales/:id', (req, res) => {
  const sale = getSale(req.params.id);
  if (!sale) return res.status(404).json({ reason: 'sale not found' });
  res.json(saleView(sale));
});

routes.get('/api/sales/:id/qr.png', async (req, res) => {
  const sale = getSale(req.params.id);
  if (!sale) return res.status(404).json({ reason: 'sale not found' });
  const png = await QRCode.toBuffer(saleView(sale).eip681, { width: 480, margin: 1 });
  res.type('png').send(png);
});

if (config.DEV_MODE) {
  routes.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
  routes.get('/api/dev/sales', (req, res) => res.json(adminSales(ADMIN_SALES_LIMIT)));
  routes.get('/api/dev/sales/:id/events', (req, res) => res.json(saleEvents(req.params.id)));

  routes.post('/api/dev/sales/:id/mark-paid', (req, res) => {
    if (config.PAY_MODE === 'direct') return res.status(409).json({ reason: "direct mode can't be simulated" });
    const sale = getSale(req.params.id);
    if (!sale) return res.status(404).json({ reason: 'sale not found' });
    if (!transition(sale.id, 'awaiting_payment', 'paid', { paid_at: sqlTime() })) {
      return res.status(409).json({ reason: `sale is ${sale.status}` });
    }

    logEvent(sale.id, 'payment_simulated', 'Developer test: no real payment was made');
    fulfillSale(sale.id).catch((err) => console.error(`Sale ${saleRef(sale.id)} failed: ${err.message}`));
    res.status(202).json({ ok: true });
  });
}
