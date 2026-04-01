const express = require('express');
const { query } = require('../db/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

const MAX_COW_NAME = 100;
const MAX_BREED    = 50;
const MAX_NOTES    = 500;

function sanitize(str, max) {
  if (!str) return null;
  return String(str).trim().slice(0, max);
}

// ── GET /api/cattle/calving — all calving records for logged-in user ──
router.get('/calving', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, cow_name, breed, breeding_date, due_date, gestation_days, notes, created_at
       FROM calving_records WHERE user_id = $1 ORDER BY due_date ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /calving error:', err.message);
    res.status(500).json({ error: 'Failed to load calving records' });
  }
});

// ── POST /api/cattle/calving — create a calving record ──
router.post('/calving', authenticateToken, async (req, res) => {
  try {
    const cow_name     = sanitize(req.body.cow_name, MAX_COW_NAME);
    const breed        = sanitize(req.body.breed, MAX_BREED);
    const breeding_date = req.body.breeding_date;
    const due_date     = req.body.due_date;
    const gestation_days = parseInt(req.body.gestation_days) || 283;
    const notes        = sanitize(req.body.notes, MAX_NOTES);

    if (!breeding_date || !due_date) {
      return res.status(400).json({ error: 'breeding_date and due_date are required' });
    }

    // Validate dates
    const bd = new Date(breeding_date);
    const dd = new Date(due_date);
    if (isNaN(bd.getTime()) || isNaN(dd.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    const { rows } = await query(
      `INSERT INTO calving_records (user_id, cow_name, breed, breeding_date, due_date, gestation_days, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user.id, cow_name, breed, breeding_date, due_date, gestation_days, notes]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /calving error:', err.message);
    res.status(500).json({ error: 'Failed to save calving record' });
  }
});

// ── DELETE /api/cattle/calving/:id — delete own calving record ──
router.delete('/calving/:id', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || id < 1) return res.status(400).json({ error: 'Invalid ID' });

    const { rowCount } = await query(
      'DELETE FROM calving_records WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Record not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /calving error:', err.message);
    res.status(500).json({ error: 'Failed to delete record' });
  }
});

module.exports = router;
