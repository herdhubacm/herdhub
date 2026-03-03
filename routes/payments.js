const express = require('express');
const { query } = require('../db/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

let stripe;
try {
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('YOUR_')) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
} catch (e) {
  console.warn('⚠️  Stripe not configured');
}

function requireStripe(req, res, next) {
  if (!stripe) return res.status(503).json({
    error: 'Payment processing not configured. Add STRIPE_SECRET_KEY to your .env file.'
  });
  next();
}

// ── POST /api/payments/create-checkout ────────────────
router.post('/create-checkout', authenticateToken, requireStripe, async (req, res) => {
  try {
    const { listing_id, tier } = req.body;
    if (!listing_id || !['standard','featured'].includes(tier))
      return res.status(400).json({ error: 'listing_id and tier (standard|featured) required' });

    const { rows } = await query(
      'SELECT id, title FROM listings WHERE id=$1 AND user_id=$2',
      [listing_id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Listing not found' });

    const priceId = tier === 'featured'
      ? process.env.STRIPE_PRICE_FEATURED
      : process.env.STRIPE_PRICE_STANDARD;

    if (!priceId || priceId.includes('YOUR_'))
      return res.status(503).json({ error: 'Stripe price IDs not configured' });

    const origin  = req.headers.origin || `http://localhost:${process.env.PORT || 3000}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/listing/${listing_id}?upgrade=success`,
      cancel_url:  `${origin}/listing/${listing_id}?upgrade=cancelled`,
      metadata:    { listing_id: String(listing_id), user_id: String(req.user.id), tier },
      customer_email: req.user.email,
    });

    await query(
      'UPDATE listings SET stripe_session_id=$1, payment_status=$2 WHERE id=$3',
      [session.id, 'pending', listing_id]
    );

    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ── POST /api/payments/webhook ─────────────────────────
// IMPORTANT: must be registered BEFORE express.json() in server.js
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session                     = event.data.object;
    const { listing_id, tier }        = session.metadata;
    const isFeatured                  = tier === 'featured';
    const days                        = isFeatured ? 90 : 60;
    const expires                     = new Date(Date.now() + days * 86400000);

    try {
      await query(
        `UPDATE listings
         SET tier=$1, is_featured=$2, payment_status='paid', status='active', expires_at=$3
         WHERE id=$4`,
        [tier, isFeatured, expires, parseInt(listing_id)]
      );
      console.log(`✅  Listing ${listing_id} upgraded to ${tier}`);
    } catch (err) {
      console.error('Webhook DB error:', err);
    }
  }

  res.json({ received: true });
});

// ── GET /api/payments/listing/:id/status ──────────────
router.get('/listing/:id/status', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT tier, payment_status, is_featured, expires_at FROM listings WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payment status' });
  }
});

module.exports = router;
