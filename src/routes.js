import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import QRCode from 'qrcode';
import { config } from './config.js';
import { adminSales, getSale, getShopBySlug, saleRef, salesSummary, sqlTime, transition } from './db.js';
import { sseHandler } from './events.js';
import { fulfillSale } from './fulfill.js';
import { amountOptions, createSale, saleView, shopQrPng } from './sales.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export const routes = Router();

routes.use(express.static(PUBLIC_DIR, { index: false }));

const ADMIN_SALES_LIMIT = 100;

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

// A light read for the standee and soundbox, which don't need amount checks from Bitrefill.
routes.get('/api/shops/:slug/summary', (req, res) => {
  const shop = getShopBySlug(req.params.slug);
  if (!shop) return res.status(404).json({ reason: 'shop not found' });
  const { count, totalInr } = salesSummary(shop.id, 'today');
  res.json({ name: shop.name, todayCount: count, todayInr: totalInr });
});

routes.get('/api/shops/:slug/events', (req, res) => {
  const shop = getShopBySlug(req.params.slug);
  if (!shop) return res.status(404).json({ reason: 'shop not found' });
  sseHandler(shop.slug)(req, res);
});

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

  routes.post('/api/dev/sales/:id/mark-paid', (req, res) => {
    if (config.PAY_MODE === 'direct') return res.status(409).json({ reason: "direct mode can't be simulated" });
    const sale = getSale(req.params.id);
    if (!sale) return res.status(404).json({ reason: 'sale not found' });
    if (!transition(sale.id, 'awaiting_payment', 'paid', { paid_at: sqlTime() })) {
      return res.status(409).json({ reason: `sale is ${sale.status}` });
    }

    fulfillSale(sale.id).catch((err) => console.error(`Sale ${saleRef(sale.id)} failed: ${err.message}`));
    res.status(202).json({ ok: true });
  });
}
