'use strict';

const { db } = require('../db/client');
const { sendEmail } = require('./email');

const ORDER_STATUSES = new Set([
  'paid', 'preparing', 'ready_to_ship', 'shipped', 'delivered', 'cancelled', 'refunded',
]);

function shippingDetails(session) {
  return session.collected_information?.shipping_details || session.shipping_details || {};
}

function taxId(session) {
  const ids = session.customer_details?.tax_ids || [];
  return ids[0]?.value || null;
}

async function createHardwareOrderFromSession(session) {
  const existing = await db.prepare('SELECT * FROM hardware_orders WHERE stripe_session_id = ?').get(session.id);
  if (existing) return existing;

  const productId = session.metadata?.product_id || 'screenfizz-player';
  const product = await db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new Error(`Hardware product not found: ${productId}`);

  const shipping = shippingDetails(session);
  const address = shipping.address || session.customer_details?.address || {};
  const customer = session.customer_details || {};
  const quantity = Math.max(1, parseInt(session.metadata?.quantity || '1', 10));
  const subtotal = Number(session.amount_subtotal ?? product.price * quantity);
  const total = Number(session.amount_total ?? subtotal);
  const tax = Number(session.total_details?.amount_tax ?? Math.max(0, total - subtotal));

  try {
    const result = await db.runReturningId(`
      INSERT INTO hardware_orders (
        order_number, user_id, stripe_session_id, stripe_payment_intent,
        customer_name, customer_email, customer_phone, vat_number,
        shipping_address_line1, shipping_address_line2, city, postcode, country,
        quantity, subtotal, tax, total, currency, status
      ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid')
    `, [
      session.metadata?.user_id || null,
      session.id,
      typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
      shipping.name || customer.name || '',
      customer.email || session.customer_email || '',
      customer.phone || null,
      taxId(session),
      address.line1 || '', address.line2 || null, address.city || '', address.postal_code || '', address.country || '',
      quantity, subtotal, tax, total, String(session.currency || product.currency || 'gbp').toLowerCase(),
    ]);
    const orderId = result.lastInsertRowid;
    const orderNumber = `SF-${1000 + Number(orderId)}`;
    await db.prepare('UPDATE hardware_orders SET order_number = ? WHERE id = ?').run(orderNumber, orderId);
    await db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)')
      .run(orderId, product.id, quantity, product.price);
    return db.prepare('SELECT * FROM hardware_orders WHERE id = ?').get(orderId);
  } catch (error) {
    // A simultaneous webhook retry may win the UNIQUE(stripe_session_id) race.
    const raced = await db.prepare('SELECT * FROM hardware_orders WHERE stripe_session_id = ?').get(session.id);
    if (raced) return raced;
    throw error;
  }
}

function statusLabel(status) {
  return ({
    paid: 'Paid', preparing: 'Preparing', ready_to_ship: 'Ready to Ship', shipped: 'Shipped',
    delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded',
  })[status] || status;
}

async function sendShippedEmail(order) {
  if (!order || order.shipped_email_sent_at || !order.customer_email) return { sent: false, reason: 'not_needed' };
  const firstName = String(order.customer_name || '').trim().split(/\s+/)[0] || 'there';
  const result = await sendEmail({
    to: order.customer_email,
    rawSubject: true,
    subject: 'Your ScreenFizz Player has shipped',
    text: `Hi ${firstName},\n\nYour ScreenFizz Player has been dispatched.\n\nCourier:\n${order.courier || '—'}\n\nTracking Number:\n${order.tracking_number || '—'}\n\nThanks for choosing ScreenFizz.`,
    html: `<p>Hi ${firstName},</p><p>Your ScreenFizz Player has been dispatched.</p><p><strong>Courier:</strong><br>${order.courier || '—'}</p><p><strong>Tracking Number:</strong><br>${order.tracking_number || '—'}</p><p>Thanks for choosing ScreenFizz.</p>`,
    fromName: 'ScreenFizz',
  });
  if (result.sent) {
    await db.prepare("UPDATE hardware_orders SET shipped_email_sent_at = strftime('%s','now') WHERE id = ?").run(order.id);
  }
  return result;
}

module.exports = { ORDER_STATUSES, createHardwareOrderFromSession, sendShippedEmail, statusLabel };
