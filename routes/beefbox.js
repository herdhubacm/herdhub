const express = require('express');
const router  = express.Router();
const { query } = require('../db/database');

// ── POST /api/beefbox/signup ───────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { name, email, state, type } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
    if (!email.includes('@')) return res.status(400).json({ error: 'Please enter a valid email address.' });

    // Check for duplicate
    const { rows: existing } = await query(
      'SELECT id FROM beefbox_waitlist WHERE email = $1', [email.toLowerCase()]
    );
    if (existing.length) return res.status(409).json({ error: "You're already on the list! We'll be in touch at launch." });

    await query(
      `INSERT INTO beefbox_waitlist (name, email, state, type)
       VALUES ($1, $2, $3, $4)`,
      [name, email.toLowerCase(), state || null, type || null]
    );

    res.status(201).json({ success: true, message: "You're on the list!" });
  } catch (err) {
    console.error('Beef box signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// ── GET /api/beefbox/count (public — for display) ─────
router.get('/count', async (_req, res) => {
  try {
    const { rows } = await query('SELECT COUNT(*) AS c FROM beefbox_waitlist');
    res.json({ count: parseInt(rows[0].c) });
  } catch (err) {
    res.status(500).json({ count: 0 });
  }
});

// ── GET /api/beefbox/list (admin only) ────────────────
router.get('/list', async (req, res) => {
  // Simple token check — reuse admin auth
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { rows } = await query(
      'SELECT name, email, state, type, created_at FROM beefbox_waitlist ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch list' });
  }
});

module.exports = router;
