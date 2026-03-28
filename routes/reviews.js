const express = require('express');
const { query } = require('../db/database');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const router = express.Router();

// ── GET /api/reviews/seller/:id ────────────────────────
router.get('/seller/:id', optionalAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT r.id, r.rating, r.title, r.body, r.created_at,
              u.name AS reviewer_name,
              l.id AS listing_id, l.title AS listing_title
       FROM seller_reviews r
       JOIN users u ON u.id = r.reviewer_id
       LEFT JOIN listings l ON l.id = r.listing_id
       WHERE r.seller_id = $1
       ORDER BY r.created_at DESC
       LIMIT 20`,
      [req.params.id]
    );

    const stats = await query(
      `SELECT COUNT(*) AS count,
              ROUND(AVG(rating)::numeric, 1) AS avg_rating,
              COUNT(*) FILTER (WHERE rating = 5) AS five_star,
              COUNT(*) FILTER (WHERE rating = 4) AS four_star,
              COUNT(*) FILTER (WHERE rating = 3) AS three_star,
              COUNT(*) FILTER (WHERE rating <= 2) AS low_star
       FROM seller_reviews WHERE seller_id = $1`,
      [req.params.id]
    );

    res.json({ reviews: rows, stats: stats.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not load reviews' });
  }
});

// ── POST /api/reviews/seller/:id ───────────────────────
router.post('/seller/:id', authenticateToken, async (req, res) => {
  try {
    const sellerId   = parseInt(req.params.id);
    const reviewerId = req.user.id;

    if (sellerId === reviewerId)
      return res.status(400).json({ error: 'You cannot review yourself' });

    const { rating, title, body, listing_id } = req.body;
    if (!rating || rating < 1 || rating > 5)
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    if (!body?.trim())
      return res.status(400).json({ error: 'Review body is required' });

    // Check reviewer actually interacted with this seller (sent a message)
    const { rows: interaction } = await query(
      `SELECT 1 FROM messages
       WHERE from_user = $1 AND to_user = $2
       LIMIT 1`,
      [reviewerId, sellerId]
    );
    if (!interaction.length)
      return res.status(403).json({ error: 'You can only review sellers you have contacted' });

    const { rows } = await query(
      `INSERT INTO seller_reviews (seller_id, reviewer_id, listing_id, rating, title, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (seller_id, reviewer_id, listing_id) DO UPDATE
         SET rating=$4, title=$5, body=$6
       RETURNING id`,
      [sellerId, reviewerId, listing_id || null, rating, title?.trim() || null, body.trim()]
    );

    res.status(201).json({ id: rows[0].id, message: 'Review submitted' });
  } catch (err) {
    console.error('Review error:', err);
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

module.exports = router;
