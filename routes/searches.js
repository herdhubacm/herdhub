const express = require('express');
const { query } = require('../db/database');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

// ── GET /api/searches — list user's saved searches ────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM saved_searches WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'Failed to load saved searches' }); }
});

// ── POST /api/searches — save a search ───────────────
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, category, state, min_price, max_price,
            min_weight, max_weight, keywords } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Search name is required' });

    // Limit to 10 saved searches per user
    const { rows: existing } = await query(
      'SELECT COUNT(*) AS c FROM saved_searches WHERE user_id=$1', [req.user.id]
    );
    if (parseInt(existing[0].c) >= 10)
      return res.status(400).json({ error: 'You can save up to 10 searches. Delete one to add another.' });

    const { rows } = await query(
      `INSERT INTO saved_searches
         (user_id, name, category, state, min_price, max_price, min_weight, max_weight, keywords)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [req.user.id, name.trim(), category||null, state||null,
       min_price||null, max_price||null, min_weight||null, max_weight||null, keywords||null]
    );
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: 'Failed to save search' }); }
});

// ── DELETE /api/searches/:id ──────────────────────────
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    await query(
      'DELETE FROM saved_searches WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    res.json({ deleted: true });
  } catch(e) { res.status(500).json({ error: 'Failed to delete saved search' }); }
});

module.exports = router;
