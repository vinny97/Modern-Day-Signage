const express = require('express');
const router = express.Router();
const { db } = require('../db/client');
const { requireAuth } = require('../middleware/auth');
const { PAST_DUE_GRACE_DAYS, DAY_SECONDS } = require('../services/subscriptionAccess');
const config = require('../config');

const appUrl = process.env.APP_URL || '';
const jsonParser = express.json();

let stripe = null;
if (config.stripeSecretKey) {
  stripe = require('stripe')(config.stripeSecretKey);
}

// Idempotency: mark a Stripe event as processed so duplicate deliveries are no-ops.
async function markEventProcessed(eventId, eventType) {
  try {
    await db.prepare('INSERT OR IGNORE INTO stripe_events (event_id, event_type) VALUES (?, ?)')
      .run(eventId, eventType);
  } catch { /* non-fatal */ }
}

async function isEventAlreadyProcessed(eventId) {
  try {
    return !!await db.prepare('SELECT 1 FROM stripe_events WHERE event_id = ?').get(eventId);
  } catch { return false; }
}

// After a user's subscription becomes active, push a playlist update to all
// their currently-connected devices so suspended screens resume without waiting
// for the next heartbeat.
async function resumeUserDevices(req, userId) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const deviceSocket = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    if (!deviceSocket.buildPlaylistPayload) return;
    const deviceNs = io.of('/device');
    const devices = db.prepare('SELECT id FROM devices WHERE user_id = ?').all(userId);
    for (const d of devices) {
      await commandQueue.queueOrEmitPlaylistUpdate(deviceNs, d.id, deviceSocket.buildPlaylistPayload);
    }
  } catch (e) {
    console.error('resumeUserDevices error:', e.message);
  }
}

// Create checkout session - user clicks "Upgrade" on a plan
router.post('/checkout', jsonParser, requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

  const { plan_id, interval } = req.body; // interval: 'monthly' or 'yearly'
  if (!plan_id) return res.status(400).json({ error: 'plan_id required' });

  const plan = await db.prepare('SELECT * FROM plans WHERE id = ?').get(plan_id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const priceId = interval === 'yearly' ? plan.stripe_price_yearly : plan.stripe_price_monthly;
  if (!priceId) return res.status(400).json({ error: `No Stripe price configured for ${plan_id} (${interval || 'monthly'})` });

  try {
    // Get or create Stripe customer
    let customerId = req.user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: { user_id: req.user.id, name: req.user.name || '' },
      });
      customerId = customer.id;
      await db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, req.user.id);
    }

    // If user already has an active subscription, redirect to billing portal
    if (req.user.stripe_subscription_id) {
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${appUrl}/#/settings`,
      });
      return res.json({ url: portal.url, type: 'portal' });
    }

    // Create checkout session for new subscription
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/#/settings?payment=success`,
      cancel_url: `${appUrl}/#/settings?payment=cancelled`,
      metadata: { user_id: req.user.id, plan_id },
      subscription_data: {
        metadata: { user_id: req.user.id, plan_id },
      },
    });

    res.json({ url: session.url, type: 'checkout' });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Customer portal - manage existing subscription (change plan, cancel, update payment)
router.post('/portal', jsonParser, requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

  const customerId = req.user.stripe_customer_id;
  if (!customerId) return res.status(400).json({ error: 'No billing account found' });

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/#/settings`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe portal error:', err.message);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// Stripe webhook - handles all subscription lifecycle events
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(404).json({ error: 'Stripe not configured' });

  let event;
  try {
    if (!config.stripeWebhookSecret) {
      console.error('Stripe webhook secret not configured — rejecting unsigned webhook');
      return res.status(400).json({ error: 'Webhook secret not configured' });
    }
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.stripeWebhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  console.log(`Stripe webhook: ${event.type}`);

  // Idempotency: skip events we've already processed (handles Stripe retries and
  // duplicate deliveries without double-updating the DB or double-sending emails).
  if (await isEventAlreadyProcessed(event.id)) {
    console.log(`Stripe webhook: ${event.id} already processed, skipping`);
    return res.json({ received: true });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        let session = event.data.object;
        if (session.metadata?.order_type === 'hardware_player') {
          // Retrieve the completed object so shipping/customer/tax details are
          // present even when Stripe sends a compact webhook representation.
          session = await stripe.checkout.sessions.retrieve(session.id);
          const { createHardwareOrderFromSession } = require('../services/hardwareOrders');
          const order = await createHardwareOrderFromSession(session);
          console.log(`Hardware order ${order.order_number} created from ${session.id}`);
          break;
        }
        const userId = session.metadata?.user_id;
        const planId = session.metadata?.plan_id;
        if (userId && session.subscription) {
          await db.prepare(`UPDATE users SET stripe_subscription_id = ?, plan_id = ?,
            subscription_status = 'active', past_due_grace_ends_at = NULL,
            updated_at = strftime('%s','now') WHERE id = ?`)
            .run(session.subscription, planId || 'starter', userId);
          console.log(`User ${userId} subscribed to ${planId} (sub: ${session.subscription})`);
          await resumeUserDevices(req, userId);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId = sub.metadata?.user_id;
        if (!userId) break;

        const priceId = sub.items?.data?.[0]?.price?.id;
        let planId = sub.metadata?.plan_id;
        if (priceId && !planId) {
          const plan = await db.prepare('SELECT id FROM plans WHERE stripe_price_monthly = ? OR stripe_price_yearly = ?').get(priceId, priceId);
          if (plan) planId = plan.id;
        }

        const newStatus = sub.status === 'active' ? 'active' : sub.status === 'past_due' ? 'past_due' : sub.status;
        const ends = sub.current_period_end || null;

        await db.prepare(`UPDATE users SET plan_id = COALESCE(?, plan_id), subscription_status = ?,
          subscription_ends = ?, updated_at = strftime('%s','now') WHERE id = ?`)
          .run(planId, newStatus, ends, userId);
        console.log(`Subscription updated for ${userId}: ${planId} (${newStatus})`);

        if (newStatus === 'active') await resumeUserDevices(req, userId);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = sub.metadata?.user_id;
        if (userId) {
          await db.prepare(`UPDATE users SET plan_id = 'free', subscription_status = 'cancelled',
            stripe_subscription_id = NULL, updated_at = strftime('%s','now') WHERE id = ?`)
            .run(userId);
          console.log(`Subscription cancelled for ${userId}`);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        // Clears past_due state when a recovery payment goes through.
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (subId && invoice.billing_reason !== 'subscription_create') {
          const user = await db.prepare('SELECT id FROM users WHERE stripe_subscription_id = ?').get(subId);
          if (user) {
            await db.prepare(`UPDATE users SET subscription_status = 'active',
              past_due_grace_ends_at = NULL, updated_at = strftime('%s','now') WHERE id = ?`)
              .run(user.id);
            console.log(`Payment recovered for user ${user.id}`);
            await resumeUserDevices(req, user.id);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (subId) {
          const user = await db.prepare('SELECT id FROM users WHERE stripe_subscription_id = ?').get(subId);
          if (user) {
            const graceEndsAt = Math.floor(Date.now() / 1000) + (PAST_DUE_GRACE_DAYS * DAY_SECONDS);
            await db.prepare(`UPDATE users SET subscription_status = 'past_due',
              past_due_grace_ends_at = ?, updated_at = strftime('%s','now') WHERE id = ?`)
              .run(graceEndsAt, user.id);
            console.log(`Payment failed for user ${user.id}, grace ends at ${graceEndsAt}`);
          }
        }
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        if (charge.payment_intent) {
          await db.prepare("UPDATE hardware_orders SET status = 'refunded', updated_at = strftime('%s','now') WHERE stripe_payment_intent = ?")
            .run(charge.payment_intent);
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
    // Don't mark as processed if we errored — allow Stripe to retry.
    return res.status(500).json({ error: 'Webhook processing failed' });
  }

  await markEventProcessed(event.id, event.type);
  res.json({ received: true });
});

module.exports = router;
