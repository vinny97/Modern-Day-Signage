'use strict';

const express = require('express');
const router = express.Router();
const config = require('../config');
const { db } = require('../db/client');
const { optionalAuth, requireAuth, requirePlatformAdmin } = require('../middleware/auth');
const { ORDER_STATUSES, sendShippedEmail } = require('../services/hardwareOrders');

const routeAsync = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const stripe = config.stripeSecretKey ? require('stripe')(config.stripeSecretKey) : null;

function publicOrder(order) {
  return order && {
    order_number: order.order_number,
    status: order.status,
    total: order.total,
    currency: order.currency,
    courier: order.courier,
    tracking_number: order.tracking_number,
    created_at: order.created_at,
  };
}

router.post('/checkout', optionalAuth, routeAsync(async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const product = await db.prepare("SELECT * FROM products WHERE slug = 'screenfizz-player' AND active = 1").get();
  if (!product) return res.status(404).json({ error: 'ScreenFizz Player is not currently available' });

  const price = Number(config.hardwarePlayerPricePence || product.price || 9900);
  const baseUrl = config.appUrl || `${req.protocol}://${req.get('host')}`;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_creation: 'always',
      customer_email: req.user?.email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'gbp',
          unit_amount: price,
          product_data: { name: 'ScreenFizz Player', description: 'Pre-configured plug-and-play digital signage player' },
        },
      }],
      shipping_address_collection: { allowed_countries: ['GB'] },
      phone_number_collection: { enabled: true },
      tax_id_collection: { enabled: true },
      // Only enable Stripe Tax when the account is configured for it — otherwise
      // Stripe rejects every session ("must specify a tax code in all line items").
      automatic_tax: { enabled: config.hardwareAutomaticTax },
      success_url: `${baseUrl}/hardware-order-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/hardware.html?checkout=cancelled`,
      metadata: {
        order_type: 'hardware_player',
        product_id: product.id,
        quantity: '1',
        user_id: req.user?.id || '',
      },
    });
    res.json({ url: session.url });
  } catch (err) {
    // Don't leak Stripe's stack trace / internal paths to the client.
    console.error('Hardware checkout error:', err.message);
    res.status(502).json({ error: 'Could not start checkout. Please try again later.' });
  }
}));

router.get('/orders/session/:sessionId', routeAsync(async (req, res) => {
  const order = await db.prepare('SELECT * FROM hardware_orders WHERE stripe_session_id = ?').get(req.params.sessionId);
  if (!order) return res.status(202).json({ pending: true });
  res.json({ pending: false, order: publicOrder(order) });
}));

router.get('/orders/mine', requireAuth, routeAsync(async (req, res) => {
  const orders = await db.prepare(`
    SELECT o.*, p.name AS product_name
    FROM hardware_orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.user_id = ? OR lower(o.customer_email) = lower(?)
    ORDER BY o.created_at DESC
  `).all(req.user.id, req.user.email);
  res.json(orders.map(publicOrder));
}));

router.get('/orders', requireAuth, requirePlatformAdmin, routeAsync(async (_req, res) => {
  const orders = await db.prepare('SELECT * FROM hardware_orders ORDER BY created_at DESC').all();
  res.json(orders);
}));

router.get('/orders/:id', requireAuth, requirePlatformAdmin, routeAsync(async (req, res) => {
  const order = await db.prepare(`SELECT o.*, p.name AS product_name, oi.unit_price
    FROM hardware_orders o LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN products p ON p.id = oi.product_id WHERE o.id = ?`).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
}));

router.put('/orders/:id', requireAuth, requirePlatformAdmin, routeAsync(async (req, res) => {
  const order = await db.prepare('SELECT * FROM hardware_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const status = req.body.status === undefined ? order.status : String(req.body.status);
  if (!ORDER_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid order status' });
  const courier = req.body.courier === undefined ? order.courier : String(req.body.courier || '').trim();
  const tracking = req.body.tracking_number === undefined ? order.tracking_number : String(req.body.tracking_number || '').trim();
  const notes = req.body.notes === undefined ? order.notes : String(req.body.notes || '').trim();
  if (status === 'shipped' && (!courier || !tracking)) {
    return res.status(400).json({ error: 'Courier and tracking number are required to mark an order shipped' });
  }
  await db.prepare("UPDATE hardware_orders SET status = ?, courier = ?, tracking_number = ?, notes = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(status, courier || null, tracking || null, notes || null, order.id);
  const updated = await db.prepare('SELECT * FROM hardware_orders WHERE id = ?').get(order.id);
  if (status === 'shipped' && order.status !== 'shipped') await sendShippedEmail(updated);
  res.json(await db.prepare('SELECT * FROM hardware_orders WHERE id = ?').get(order.id));
}));

router.post('/orders/:id/refund', requireAuth, requirePlatformAdmin, routeAsync(async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const order = await db.prepare('SELECT * FROM hardware_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!order.stripe_payment_intent) return res.status(400).json({ error: 'Order has no refundable payment' });
  if (order.status === 'refunded') return res.status(409).json({ error: 'Order is already refunded' });
  try {
    const refund = await stripe.refunds.create({ payment_intent: order.stripe_payment_intent });
    await db.prepare("UPDATE hardware_orders SET status = 'refunded', stripe_refund_id = ?, updated_at = strftime('%s','now') WHERE id = ?")
      .run(refund.id, order.id);
    res.json(await db.prepare('SELECT * FROM hardware_orders WHERE id = ?').get(order.id));
  } catch (err) {
    console.error('Hardware refund error:', err.message);
    res.status(502).json({ error: 'Refund could not be processed. Please try again or refund from the Stripe dashboard.' });
  }
}));

module.exports = router;
