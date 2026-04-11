const express = require('express');
const router  = express.Router();
const { query } = require('../db/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// ── POST /api/beefbox/signup ───────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { name, email, state, type, street, city, zip } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
    if (!email.includes('@')) return res.status(400).json({ error: 'Please enter a valid email address.' });

    const { rows: existing } = await query(
      'SELECT id FROM beefbox_waitlist WHERE email = $1', [email.toLowerCase()]
    );
    if (existing.length) return res.status(409).json({ error: "You're already on the list! We'll be in touch at launch." });

    await query(
      'INSERT INTO beefbox_waitlist (name, email, state, type, street, city, zip) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [name, email.toLowerCase(), state || null, type || null,
       (street||'').slice(0,150) || null, (city||'').slice(0,100) || null, (zip||'').slice(0,20) || null]
    );
    res.status(201).json({ success: true, message: "You're on the list!" });
  } catch (err) {
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// ── GET /api/beefbox/count (public) ───────────────────
router.get('/count', async (_req, res) => {
  try {
    const { rows } = await query('SELECT COUNT(*) AS c FROM beefbox_waitlist');
    res.json({ count: parseInt(rows[0].c) });
  } catch (err) {
    res.status(500).json({ count: 0 });
  }
});

// ── GET /api/beefbox/list (admin only) ────────────────
router.get('/list', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id, name, email, state, type, street, city, zip, created_at FROM beefbox_waitlist ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch list' });
  }
});

// ── DELETE /api/beefbox/:id (admin only) ──────────────
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      'DELETE FROM beefbox_waitlist WHERE id=$1 RETURNING id',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Entry not found' });
    res.json({ deleted: true, id: rows[0].id });
  } catch(e) {
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

module.exports = router;
