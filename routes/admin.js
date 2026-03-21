/**
 * ╔══════════════════════════════════════════════════════╗
 * ║   HERD HUB – Admin API Routes                       ║
 * ║   All routes require admin role                     ║
 * ╚══════════════════════════════════════════════════════╝
 */
const express = require('express');
const bcrypt  = require('bcryptjs');
const multer  = require('multer');
const { query } = require('../db/database');
const storage = require('../services/storage');

// multer — memory only, admin image uploads
const adminUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Images only'));
    cb(null, true);
  }
});
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { deleteFile } = require('../services/storage');

const router = express.Router();

// All admin routes require auth + admin role
router.use(authenticateToken, requireAdmin);

// ── GET /api/admin/stats ───────────────────────────────
router.get('/stats', async (_req, res) => {
  try {
    const [listings, users, messages, revenue, recentListings, topCategories, topStates] = await Promise.all([
      query(`SELECT
        COUNT(*) FILTER (WHERE status='active')  AS active,
        COUNT(*) FILTER (WHERE status='expired') AS expired,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS today,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')  AS this_week,
        COUNT(*) AS total
       FROM listings`),
      query(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS today,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')  AS this_week,
        COUNT(*) FILTER (WHERE is_banned = TRUE) AS banned
       FROM users`),
      query(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE is_read = FALSE) AS unread
       FROM messages`),
      query(`SELECT
        COUNT(*) FILTER (WHERE payment_status='paid') AS paid_count,
        COUNT(*) FILTER (WHERE tier='ribeye' AND payment_status='paid') AS ribeye_count,
        COUNT(*) FILTER (WHERE tier='filet'  AND payment_status='paid') AS filet_count,
        COUNT(*) FILTER (WHERE tier='t_bone' AND payment_status='paid') AS tbone_count
       FROM listings`),
      query(`SELECT l.id, l.title, l.category, l.state, l.tier, l.status,
              l.created_at, u.name AS seller_name, u.email AS seller_email
             FROM listings l JOIN users u ON u.id = l.user_id
             ORDER BY l.created_at DESC LIMIT 10`),
      query(`SELECT category, COUNT(*) AS count
             FROM listings WHERE status='active'
             GROUP BY category ORDER BY count DESC LIMIT 8`),
      query(`SELECT state, COUNT(*) AS count
             FROM listings WHERE status='active' AND state IS NOT NULL
             GROUP BY state ORDER BY count DESC LIMIT 10`),
    ]);

    res.json({
      listings:        listings.rows[0],
      users:           users.rows[0],
      messages:        messages.rows[0],
      revenue:         revenue.rows[0],
      recentListings:  recentListings.rows,
      topCategories:   topCategories.rows,
      topStates:       topStates.rows,
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Could not load stats' });
  }
});

// ── GET /api/admin/listings ────────────────────────────
router.get('/listings', async (req, res) => {
  try {
    const { page = 1, limit = 25, status, category, q, tier } = req.query;
    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 25), 200);
    const safePage  = Math.max(1, parseInt(page) || 1);
    const offset = (safePage - 1) * safeLimit;
    const conditions = [];
    const params = [];
    let p = 1;

    if (status)   { conditions.push(`l.status = $${p++}`);   params.push(status); }
    if (category) { conditions.push(`l.category = $${p++}`); params.push(category); }
    if (tier)     { conditions.push(`l.tier = $${p++}`);     params.push(tier); }
    if (q)        { conditions.push(`(l.title ILIKE $${p} OR u.email ILIKE $${p} OR u.name ILIKE $${p})`); params.push(`%${q}%`); p++; }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [rows, countRow] = await Promise.all([
      query(`SELECT l.id, l.title, l.category, l.breed, l.price, l.price_type,
              l.state, l.city, l.tier, l.status, l.is_featured,
              l.payment_status, l.created_at, l.expires_at,
              u.id AS user_id, u.name AS seller_name, u.email AS seller_email,
              (SELECT COUNT(*) FROM listing_photos WHERE listing_id=l.id) AS photo_count,
              (SELECT url FROM listing_photos WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) AS thumb
             FROM listings l JOIN users u ON u.id = l.user_id
             ${where}
             ORDER BY l.created_at DESC
             LIMIT $${p} OFFSET $${p+1}`,
        [...params, safeLimit, offset]),
      query(`SELECT COUNT(*) AS total FROM listings l JOIN users u ON u.id=l.user_id ${where}`, params),
    ]);

    res.json({
      listings: rows.rows,
      total:    parseInt(countRow.rows[0].total),
      page:     parseInt(page),
      pages:    Math.ceil(countRow.rows[0].total / limit),
    });
  } catch (err) {
    console.error('Admin listings error:', err);
    res.status(500).json({ error: 'Could not load listings' });
  }
});

// ── DELETE /api/admin/listings/:id ────────────────────
router.delete('/listings/:id', async (req, res) => {
  try {
    const { reason = 'Removed by admin' } = req.body;
    const { rows: photos } = await query(
      'SELECT storage_key, thumb_key FROM listing_photos WHERE listing_id=$1', [req.params.id]
    );
    // Delete from cloud storage
    await Promise.allSettled(
      photos.flatMap(p => [p.storage_key, p.thumb_key].filter(Boolean).map(k => deleteFile(k)))
    );
    // Hard delete listing (cascades to photos)
    const { rows } = await query(
      'DELETE FROM listings WHERE id=$1 RETURNING id, title', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Listing not found' });
    console.log(`🗑️  Admin deleted listing ${req.params.id}: ${rows[0].title} — ${reason}`);
    res.json({ deleted: true, id: req.params.id, title: rows[0].title });
  } catch (err) {
    console.error('Admin delete listing error:', err);
    res.status(500).json({ error: 'Could not delete listing' });
  }
});

// ── GET /api/admin/users ───────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 25, q, role, banned } = req.query;
    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 25), 200);
    const safePage  = Math.max(1, parseInt(page) || 1);
    const offset = (safePage - 1) * safeLimit;
    const conditions = [];
    const params = [];
    let p = 1;

    if (role)   { conditions.push(`role = $${p++}`);          params.push(role); }
    if (banned === 'true')  { conditions.push(`is_banned = TRUE`); }
    if (banned === 'false') { conditions.push(`is_banned = FALSE`); }
    if (q) { conditions.push(`(email ILIKE $${p} OR name ILIKE $${p})`); params.push(`%${q}%`); p++; }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [rows, countRow] = await Promise.all([
      query(`SELECT u.id, u.email, u.name, u.phone, u.state, u.city, u.role,
              u.is_verified, u.is_banned, u.created_at,
              COUNT(l.id) AS listing_count,
              COUNT(l.id) FILTER (WHERE l.status='active') AS active_listings
             FROM users u
             LEFT JOIN listings l ON l.user_id = u.id
             ${where}
             GROUP BY u.id
             ORDER BY u.created_at DESC
             LIMIT $${p} OFFSET $${p+1}`,
        [...params, safeLimit, offset]),
      query(`SELECT COUNT(*) AS total FROM users ${where}`, params),
    ]);

    res.json({
      users: rows.rows,
      total: parseInt(countRow.rows[0].total),
      page:  parseInt(page),
      pages: Math.ceil(countRow.rows[0].total / limit),
    });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'Could not load users' });
  }
});

// ── PUT /api/admin/users/:id/ban ──────────────────────
router.put('/users/:id/ban', async (req, res) => {
  try {
    const { reason = 'Banned by admin' } = req.body;
    const { rows } = await query(
      `UPDATE users SET is_banned=TRUE, ban_reason=$1 WHERE id=$2 RETURNING id, email, name`,
      [reason, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    console.log(`🚫  Admin banned user ${req.params.id}: ${rows[0].email} — ${reason}`);
    res.json({ banned: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not ban user' });
  }
});

// ── PUT /api/admin/users/:id/unban ────────────────────
router.put('/users/:id/unban', async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE users SET is_banned=FALSE, ban_reason=NULL WHERE id=$1 RETURNING id, email, name`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ banned: false, user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not unban user' });
  }
});

// ── PUT /api/admin/users/:id/role ─────────────────────
router.put('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    if (!['user', 'admin', 'moderator'].includes(role))
      return res.status(400).json({ error: 'Invalid role' });
    const { rows } = await query(
      `UPDATE users SET role=$1 WHERE id=$2 RETURNING id, email, name, role`,
      [role, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ updated: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not update role' });
  }
});

// ── PUT /api/admin/users/:id/reset-password ───────────
router.put('/users/:id/reset-password', async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const hash = await bcrypt.hash(newPassword, 12);
    const { rows } = await query(
      `UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id, email, name`,
      [hash, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ reset: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not reset password' });
  }
});

// ── GET /api/admin/messages ───────────────────────────
router.get('/messages', async (req, res) => {
  try {
    const { page = 1, limit = 25, unread } = req.query;
    const offset = (page - 1) * limit;
    const where = unread === 'true' ? 'WHERE m.is_read = FALSE' : '';

    const [rows, countRow] = await Promise.all([
      query(`SELECT m.id, m.subject, m.body, m.is_read, m.created_at,
              sender.id AS from_id, sender.name AS from_name, sender.email AS from_email,
              recip.id  AS to_id,   recip.name  AS to_name,  recip.email AS to_email,
              l.id AS listing_id, l.title AS listing_title
             FROM messages m
             JOIN users sender ON sender.id = m.from_user
             JOIN users recip  ON recip.id  = m.to_user
             LEFT JOIN listings l ON l.id = m.listing_id
             ${where}
             ORDER BY m.created_at DESC
             LIMIT $1 OFFSET $2`, [limit, offset]),
      query(`SELECT COUNT(*) AS total FROM messages m ${where}`),
    ]);

    res.json({
      messages: rows.rows,
      total:    parseInt(countRow.rows[0].total),
      page:     parseInt(page),
      pages:    Math.ceil(countRow.rows[0].total / limit),
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load messages' });
  }
});

// ── PUT /api/admin/messages/:id/read ─────────────────
router.put('/messages/:id/read', async (req, res) => {
  try {
    await query('UPDATE messages SET is_read=TRUE WHERE id=$1', [req.params.id]);
    res.json({ read: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not update message' });
  }
});

// ── GET /api/admin/user/:id/detail ────────────────────
router.get('/users/:id/detail', async (req, res) => {
  try {
    const [user, listings, messages] = await Promise.all([
      query(`SELECT id, email, name, phone, state, city, bio, role,
              is_verified, is_banned, ban_reason, created_at
             FROM users WHERE id=$1`, [req.params.id]),
      query(`SELECT id, title, category, price, tier, status, created_at
             FROM listings WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,
        [req.params.id]),
      query(`SELECT m.id, m.subject, m.created_at, m.is_read,
              u.name AS from_name, l.title AS listing_title
             FROM messages m
             JOIN users u ON u.id = m.from_user
             LEFT JOIN listings l ON l.id = m.listing_id
             WHERE m.to_user=$1 OR m.from_user=$1
             ORDER BY m.created_at DESC LIMIT 20`,
        [req.params.id]),
    ]);
    if (!user.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: user.rows[0], listings: listings.rows, messages: messages.rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load user detail' });
  }
});

// ── POST /api/admin/upload-image ─────────────────────
// Single image upload for articles and other admin uses
router.post('/upload-image', adminUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    const result = await storage.uploadFile(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      'articles',
      { generateThumb: false, optimise: true }
    );
    res.json({ url: result.url, name: result.name });
  } catch (e) {
    console.error('Admin image upload error:', e);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});


// ── ARTICLES CRUD ─────────────────────────────────────

// GET /api/admin/articles
router.get('/articles', async (req, res) => {
  try {
    const limit  = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);
    const offset = parseInt(req.query.offset) || 0;
    const { rows } = await query(
      `SELECT id, title, excerpt, category, image_url, author, published, created_at, updated_at
       FROM articles ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const total = await query(`SELECT COUNT(*) FROM articles`);
    res.json({ articles: rows, total: parseInt(total.rows[0].count) });
  } catch (e) { res.status(500).json({ error: 'Failed to load articles' }); }
});

// POST /api/admin/articles
router.post('/articles', async (req, res) => {
  try {
    const { title, excerpt, body, category, image_url, author, published } = req.body;
    if (!title || !category) return res.status(400).json({ error: 'Title and category required' });
    const { rows } = await query(
      `INSERT INTO articles (title, excerpt, body, category, image_url, author, published)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title, excerpt||'', body||'', category, image_url||'', author||'Herd Hub Staff', published !== false]
    );
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to create article' }); }
});

// PUT /api/admin/articles/:id
router.put('/articles/:id', async (req, res) => {
  try {
    const { title, excerpt, body, category, image_url, author, published } = req.body;
    const { rows } = await query(
      `UPDATE articles SET title=$1, excerpt=$2, body=$3, category=$4,
       image_url=$5, author=$6, published=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [title, excerpt||'', body||'', category, image_url||'', author||'Herd Hub Staff', published !== false, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Failed to update article' }); }
});

// DELETE /api/admin/articles/:id
router.delete('/articles/:id', async (req, res) => {
  try {
    await query(`DELETE FROM articles WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete article' }); }
});


module.exports = router;
