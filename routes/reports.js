const express = require('express');
const { query } = require('../db/database');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const router = express.Router();

const VALID_REASONS = [
  'Fraudulent listing',
  'Misrepresented animal/item',
  'Duplicate listing',
  'Wrong category',
  'Spam or scam',
  'Prohibited item',
  'Price gouging',
  'Other',
];

// ── POST /api/reports/listing/:id ──────────────────────
router.post('/listing/:id', optionalAuth, async (req, res) => {
  try {
    const { reason, details } = req.body;
    if (!reason || !VALID_REASONS.includes(reason))
      return res.status(400).json({ error: 'Please select a valid reason' });

    const { rows: listing } = await query(
      'SELECT id FROM listings WHERE id=$1', [req.params.id]
    );
    if (!listing.length) return res.status(404).json({ error: 'Listing not found' });

    // Check for duplicate report from same user/IP
    if (req.user) {
      const { rows: dup } = await query(
        'SELECT 1 FROM listing_reports WHERE listing_id=$1 AND reporter_id=$2',
        [req.params.id, req.user.id]
      );
      if (dup.length) return res.status(409).json({ error: 'You have already reported this listing' });
    }

    await query(
      `INSERT INTO listing_reports (listing_id, reporter_id, reason, details)
       VALUES ($1, $2, $3, $4)`,
      [req.params.id, req.user?.id || null, reason, details?.trim().slice(0, 1000) || null]
    );

    // Auto-flag listing if it gets 3+ reports
    const { rows: count } = await query(
      "SELECT COUNT(*) AS c FROM listing_reports WHERE listing_id=$1 AND status='open'",
      [req.params.id]
    );
    if (parseInt(count[0].c) >= 3) {
      await query(
        "UPDATE listings SET status='pending' WHERE id=$1 AND status='active'",
        [req.params.id]
      );
      console.warn(`⚠️  Listing ${req.params.id} auto-flagged after 3 reports`);
    }

    res.status(201).json({ message: 'Report submitted. Our team will review it shortly.' });
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

module.exports = router;
