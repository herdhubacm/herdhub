const express = require('express');
const { query } = require('../db/database');
const { authenticateToken, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/forum/topics ──────────────────────────────
router.get('/topics', optionalAuth, async (req, res) => {
  try {
    const { category, page = 1, limit = 20 } = req.query;
    const conditions = [];
    const params     = [];
    let p = 1;

    if (category) { conditions.push(`t.category = $${p}`); params.push(category); p++; }

    const where  = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [countRes, topicsRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM forum_topics t ${where}`, params),
      query(
        `SELECT t.*, u.name as author,
                (SELECT COUNT(*) FROM forum_replies r WHERE r.topic_id=t.id) as reply_count,
                (SELECT created_at FROM forum_replies r WHERE r.topic_id=t.id ORDER BY created_at DESC LIMIT 1) as last_reply_at
         FROM forum_topics t
         JOIN users u ON u.id = t.user_id
         ${where}
         ORDER BY t.is_pinned DESC, t.updated_at DESC
         LIMIT $${p} OFFSET $${p+1}`,
        [...params, parseInt(limit), offset]
      )
    ]);

    const total = parseInt(countRes.rows[0].count);
    res.json({ topics: topicsRes.rows, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) {
    console.error('GET /forum/topics error:', err);
    res.status(500).json({ error: 'Failed to fetch topics' });
  }
});

// ── GET /api/forum/topics/:id ──────────────────────────
router.get('/topics/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.*, u.name as author
       FROM forum_topics t JOIN users u ON u.id=t.user_id
       WHERE t.id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Topic not found' });

    const [repliesRes] = await Promise.all([
      query(
        `SELECT r.*, u.name as author
         FROM forum_replies r JOIN users u ON u.id=r.user_id
         WHERE r.topic_id=$1 ORDER BY r.created_at ASC`,
        [req.params.id]
      ),
      query('UPDATE forum_topics SET views=views+1 WHERE id=$1', [req.params.id]),
    ]);

    res.json({ ...rows[0], replies: repliesRes.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch topic' });
  }
});

// ── POST /api/forum/topics ─────────────────────────────
router.post('/topics', authenticateToken, async (req, res) => {
  try {
    const { category = 'general', title, body } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title and body required' });

    const { rows } = await query(
      'INSERT INTO forum_topics (user_id, category, title, body) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.user.id, category, title, body]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create topic' });
  }
});

// ── POST /api/forum/topics/:id/replies ────────────────
router.post('/topics/:id/replies', authenticateToken, async (req, res) => {
  try {
    const { body } = req.body;
    if (!body) return res.status(400).json({ error: 'body required' });

    const { rows: topic } = await query('SELECT id FROM forum_topics WHERE id=$1', [req.params.id]);
    if (!topic.length) return res.status(404).json({ error: 'Topic not found' });

    const [replyRes] = await Promise.all([
      query(
        'INSERT INTO forum_replies (topic_id, user_id, body) VALUES ($1,$2,$3) RETURNING id',
        [req.params.id, req.user.id, body]
      ),
      query('UPDATE forum_topics SET updated_at=NOW() WHERE id=$1', [req.params.id]),
    ]);

    res.status(201).json({ id: replyRes.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to post reply' });
  }
});

// ── GET /api/forum/categories ──────────────────────────
router.get('/categories', (_req, res) =>
  res.json(['general','cattle','equipment','dogs','market','health','farm_to_table'])
);

module.exports = router;
