'use strict';
const express = require('express');
const router  = express.Router();
const { pool } = require('../db/database');
const { authenticateToken } = require('../middleware/auth');

// ── Public: list published articles ──────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 10, 50);
    const offset = parseInt(req.query.offset) || 0;
    const cat    = req.query.category || '';

    const where = cat
      ? `WHERE published = TRUE AND category ILIKE $3`
      : `WHERE published = TRUE`;
    const params = cat
      ? [limit, offset, `%${cat}%`]
      : [limit, offset];

    const { rows } = await pool.query(
      `SELECT id, title, excerpt, category, image_url, author, created_at
       FROM articles ${where}
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load articles' });
  }
});

// ── Public: single article ────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM articles WHERE id = $1 AND published = TRUE`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load article' });
  }
});

module.exports = router;
