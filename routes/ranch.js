const express = require('express');
const multer = require('multer');
const { query } = require('../db/database');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const storage = require('../services/storage');
const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','image/gif'];
    ok.includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error('Image only'), { status: 415 }));
  },
});

// GET /api/ranch/directory
router.get('/directory', async (req, res) => {
  try {
    const { state, breed, premium } = req.query;
    const conds = [];
    const params = [];
    let p = 1;
    if (state) { conds.push('location_state=$' + p); params.push(state); p++; }
    if (breed) { conds.push('$' + p + '=ANY(breeds)'); params.push(breed); p++; }
    if (premium === 'true') { conds.push('is_premium=true'); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { rows } = await query(
      `SELECT rp.*, u.name AS user_name,
        (SELECT COUNT(*) FROM listings l WHERE l.user_id=rp.user_id AND l.status='active') AS active_listings
       FROM ranch_profiles rp JOIN users u ON u.id=rp.user_id
       ${where} ORDER BY rp.is_premium DESC, rp.views DESC`, params);
    res.json(rows);
  } catch (err) {
    console.error('Directory error:', err.message);
    res.status(500).json({ error: 'Failed to load directory' });
  }
});

// GET /api/ranch/my/profile
router.get('/my/profile', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM ranch_profiles WHERE user_id=$1', [req.user.id]);
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// GET /api/ranch/:userId
router.get('/:userId', async (req, res) => {
  try {
    const uid = parseInt(req.params.userId);
    const { rows } = await query('SELECT * FROM ranch_profiles WHERE user_id=$1', [uid]);
    if (!rows.length) return res.status(404).json({ error: 'Ranch not found' });
    // Increment views
    await query('UPDATE ranch_profiles SET views=views+1 WHERE user_id=$1', [uid]);
    const listings = await query(
      `SELECT id, title, category, price, city, state, photo_urls, tier, created_at
       FROM listings WHERE user_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 20`, [uid]);
    res.json({ ...rows[0], listings: listings.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load ranch' });
  }
});

// POST /api/ranch
router.post('/', authenticateToken, upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'banner', maxCount: 1 }
]), async (req, res) => {
  try {
    const b = req.body;
    let logo_url = b.existing_logo_url || null;
    let banner_url = b.existing_banner_url || null;

    if (req.files?.logo?.[0]) {
      const f = req.files.logo[0];
      const r = await storage.uploadFile(f.buffer, f.originalname, f.mimetype, 'ranch');
      logo_url = r.url;
    }
    if (req.files?.banner?.[0]) {
      const f = req.files.banner[0];
      const r = await storage.uploadFile(f.buffer, f.originalname, f.mimetype, 'ranch');
      banner_url = r.url;
    }

    const specialties = b.specialties ? (typeof b.specialties === 'string' ? JSON.parse(b.specialties) : b.specialties) : [];
    const breeds = b.breeds ? (typeof b.breeds === 'string' ? JSON.parse(b.breeds) : b.breeds) : [];

    const { rows } = await query(`
      INSERT INTO ranch_profiles (user_id, ranch_name, tagline, story, founded_year, acres,
        location_city, location_state, phone, website, facebook, instagram,
        specialties, breeds, logo_url, banner_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (user_id) DO UPDATE SET
        ranch_name=$2, tagline=$3, story=$4, founded_year=$5, acres=$6,
        location_city=$7, location_state=$8, phone=$9, website=$10, facebook=$11, instagram=$12,
        specialties=$13, breeds=$14,
        logo_url=COALESCE($15, ranch_profiles.logo_url),
        banner_url=COALESCE($16, ranch_profiles.banner_url),
        updated_at=NOW()
      RETURNING *`,
      [req.user.id, (b.ranch_name||'').slice(0,150), (b.tagline||'').slice(0,200),
       (b.story||'').slice(0,5000), parseInt(b.founded_year)||null, parseInt(b.acres)||null,
       (b.location_city||'').slice(0,100), (b.location_state||'').slice(0,2),
       (b.phone||'').slice(0,20), (b.website||'').slice(0,200),
       (b.facebook||'').slice(0,200), (b.instagram||'').slice(0,200),
       specialties, breeds, logo_url, banner_url]);
    res.json(rows[0]);
  } catch (err) {
    console.error('POST ranch error:', err.message);
    res.status(500).json({ error: 'Failed to save profile' });
  }
});

module.exports = router;
