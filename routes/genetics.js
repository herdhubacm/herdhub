const express = require('express');
const { query } = require('../db/database');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

// POST /api/genetics/pairings
router.post('/pairings', authenticateToken, async (req, res) => {
  try {
    const b = req.body;
    const { rows } = await query(
      `INSERT INTO genetic_pairings (user_id, bull_name, bull_breed, bull_epds, cow_herd_epds, cow_herd_breed, predicted_results, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, (b.bull_name||'').slice(0,100), (b.bull_breed||'').slice(0,50),
       JSON.stringify(b.bull_epds), JSON.stringify(b.cow_herd_epds),
       (b.cow_herd_breed||'').slice(0,50), JSON.stringify(b.predicted_results),
       (b.notes||'').slice(0,1000)]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST pairings error:', err.message);
    res.status(500).json({ error: 'Failed to save pairing' });
  }
});

// GET /api/genetics/pairings
router.get('/pairings', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM genetic_pairings WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load pairings' });
  }
});

// DELETE /api/genetics/pairings/:id
router.delete('/pairings/:id', authenticateToken, async (req, res) => {
  try {
    const { rowCount } = await query(
      'DELETE FROM genetic_pairings WHERE id=$1 AND user_id=$2',
      [parseInt(req.params.id), req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

module.exports = router;
