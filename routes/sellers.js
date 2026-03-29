const express = require('express');
const { query } = require('../db/database');
const { optionalAuth } = require('../middleware/auth');
const router = express.Router();

// ── GET /api/sellers/:id ──────────────────────────────
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const sellerId = parseInt(req.params.id);
    if (isNaN(sellerId)) return res.status(400).json({ error: 'Invalid seller ID' });

    // Public profile — only expose safe fields
    const { rows: users } = await query(
      `SELECT id, name, state, city, bio, avatar_url, created_at
       FROM users WHERE id=$1`,
      [sellerId]
    );
    if (!users.length) return res.status(404).json({ error: 'Seller not found' });
    const seller = users[0];

    // Active listings
    const { rows: listings } = await query(
      `SELECT l.id, l.title, l.category, l.breed, l.price, l.price_type,
              l.state, l.city, l.tier, l.created_at, l.views, l.quantity,
              l.weight_lbs, l.status, l.sold_at,
              (SELECT url FROM listing_photos WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) AS thumb
       FROM listings l
       WHERE l.user_id=$1 AND l.status IN ('active','sold')
       ORDER BY l.status ASC, l.created_at DESC
       LIMIT 24`,
      [sellerId]
    );

    // Review stats
    const { rows: reviewStats } = await query(
      `SELECT COUNT(*) AS count,
              ROUND(AVG(rating)::numeric,1) AS avg_rating
       FROM seller_reviews WHERE seller_id=$1`,
      [sellerId]
    );

    // Recent reviews
    const { rows: reviews } = await query(
      `SELECT r.rating, r.title, r.body, r.created_at,
              u.name AS reviewer_name
       FROM seller_reviews r
       JOIN users u ON u.id=r.reviewer_id
       WHERE r.seller_id=$1
       ORDER BY r.created_at DESC LIMIT 5`,
      [sellerId]
    );

    res.json({
      seller,
      listings,
      stats: reviewStats[0],
      reviews,
    });
  } catch(e) {
    console.error('Seller profile error:', e);
    res.status(500).json({ error: 'Failed to load seller profile' });
  }
});

module.exports = router;
