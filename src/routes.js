import { Router } from 'express';
import { config } from './config.js';
import { getSale, saleRef, sqlTime, transition } from './db.js';
import { fulfillSale } from './fulfill.js';

export const routes = Router();

if (config.DEV_MODE) {
  routes.post('/api/dev/sales/:id/mark-paid', (req, res) => {
    const sale = getSale(req.params.id);
    if (!sale) return res.status(404).json({ reason: 'sale not found' });
    if (!transition(sale.id, 'awaiting_payment', 'paid', { paid_at: sqlTime() })) {
      return res.status(409).json({ reason: `sale is ${sale.status}` });
    }

    fulfillSale(sale.id).catch((err) => console.error(`Sale ${saleRef(sale.id)} failed: ${err.message}`));
    res.status(202).json({ ok: true });
  });
}
