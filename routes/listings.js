const express = require('express');
const multer  = require('multer');
const { query, pool } = require('../db/database');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const storage = require('../services/storage');

const router = express.Router();

// Input length limits — prevent abuse and DB overload
const MAX_TITLE_LEN       = 120;
const MAX_DESC_LEN        = 5000;
const MAX_WEBSITE_LEN     = 500;
const MAX_CITY_LEN        = 80;

function sanitizeText(str, maxLen) {
  if (!str) return null;
  return String(str).trim().slice(0, maxLen);
}

// ── Multer — memory storage only ──────────────────────
// Files land in req.files as Buffer objects, then we
// hand them straight to the storage service (S3/R2/local).
// Nothing ever touches the server's disk at the route level.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (parseInt(process.env.MAX_UPLOAD_MB) || 10) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(Object.assign(new Error('Only JPEG, PNG, WEBP, GIF images allowed'), { status: 415 }));
  },
});

// ── Helpers ────────────────────────────────────────────
function tierPhotoLimit(tier) {
  if (tier === 'filet')        return parseInt(process.env.MAX_PHOTOS_FILET)  || 5;
  if (tier === 't_bone')       return parseInt(process.env.MAX_PHOTOS_TBONE)  || 5;
  if (tier === 'ribeye')       return parseInt(process.env.MAX_PHOTOS_RIBEYE) || 3;
  if (tier === 'sirloin')      return parseInt(process.env.MAX_PHOTOS_SIRLOIN) || 3;
  if (tier === 'farm_to_table') return 3;
  if (tier === 'burger')       return 1;
  return parseInt(process.env.MAX_PHOTOS_BASIC) || 1;
}
function expiresAt(tier) {
  // t_bone = recurring (90 day window), filet = 30 day one-time, ribeye = 90 day featured, basic = 30 day free
  const days = (tier === 't_bone' || tier === 'ribeye') ? 90 : 30;
  return new Date(Date.now() + days * 86400000);
}

// ── GET /api/listings ──────────────────────────────────
router.get('/', optionalAuth, async (req, res) => {
  try {
    const {
      category, state, breed, sex, min_price, max_price,
      q, page = 1, limit = 24, sort = 'featured',
      tier, status = 'active',
    } = req.query;

    const conditions = ['l.status = $1'];
    const params     = [status];
    let p = 2;

    if (q) {
      conditions.push(`l.search_vector @@ plainto_tsquery('english', $${p})`);
      params.push(q); p++;
    }
    if (category)  { conditions.push(`l.category = $${p}`);    params.push(category);       p++; }
    if (state)     { conditions.push(`l.state = $${p}`);       params.push(state);          p++; }
    if (breed)     { conditions.push(`l.breed ILIKE $${p}`);   params.push(`%${breed}%`);   p++; }
    if (sex)       { conditions.push(`l.sex = $${p}`);         params.push(sex);            p++; }
    if (tier)      { conditions.push(`l.tier = $${p}`);        params.push(tier);           p++; }
    if (min_price) { conditions.push(`l.price >= $${p}`);      params.push(+min_price);     p++; }
    if (max_price) { conditions.push(`l.price <= $${p}`);      params.push(+max_price);     p++; }

    const where   = conditions.join(' AND ');
    const tsRank  = q ? `ts_rank(l.search_vector, plainto_tsquery('english', $2)) DESC, ` : '';
    const orderMap = {
      featured:   'l.is_featured DESC, l.created_at DESC',
      newest:     'l.created_at DESC',
      price_asc:  'l.price ASC NULLS LAST',
      price_desc: 'l.price DESC NULLS LAST',
    };
    const order  = tsRank + (orderMap[sort] || orderMap.featured);
    const safeLimit  = Math.min(Math.max(1, parseInt(limit)  || 24), 100); // max 100 per request
    const safePage   = Math.max(1, parseInt(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    const [countRes, dataRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM listings l WHERE ${where}`, params),
      query(
        `SELECT l.id, l.title, l.category, l.breed, l.price, l.price_type,
                l.quantity, l.state, l.city, l.tier, l.is_featured,
                l.views, l.created_at, u.name AS seller_name,
                (SELECT url FROM listing_photos WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) AS thumb,
                (SELECT thumb_url FROM listing_photos WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) AS thumb_small
         FROM listings l
         JOIN users u ON u.id = l.user_id
         WHERE ${where}
         ORDER BY ${order}
         LIMIT $${p} OFFSET $${p + 1}`,
        [...params, safeLimit, offset]
      ),
    ]);

    const total = parseInt(countRes.rows[0].count);
    res.json({
      listings: dataRes.rows,
      pagination: { total, page: safePage, limit: safeLimit, pages: Math.ceil(total / safeLimit) },
    });
  } catch (err) {
    console.error('GET /listings:', err);
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// ── GET /api/listings/featured ────────────────────────
router.get('/featured', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT l.id, l.title, l.category, l.breed, l.price, l.price_type,
              l.quantity, l.state, l.city, l.tier, l.is_featured, l.created_at,
              u.name AS seller_name,
              (SELECT url FROM listing_photos WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) AS thumb,
              (SELECT thumb_url FROM listing_photos WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) AS thumb_small
       FROM listings l
       JOIN users u ON u.id = l.user_id
       WHERE l.status = 'active' AND l.is_featured = TRUE
       ORDER BY l.created_at DESC LIMIT 12`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch featured listings' });
  }
});

// ── GET /api/listings/stats ───────────────────────────
router.get('/stats', async (_req, res) => {
  try {
    const [totalRes, catRes, stateRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM listings WHERE status = 'active'`),
      query(`SELECT category, COUNT(*) AS c FROM listings WHERE status='active' GROUP BY category ORDER BY c DESC`),
      query(`SELECT state, COUNT(*) AS c FROM listings WHERE status='active' GROUP BY state ORDER BY c DESC LIMIT 15`),
    ]);
    res.json({
      total_active: parseInt(totalRes.rows[0].count),
      by_category:  catRes.rows,
      by_state:     stateRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── GET /api/listings/storage-info ────────────────────
router.get('/storage-info', (_req, res) => res.json(storage.getStorageInfo()));

// ── GET /api/listings/presign ─────────────────────────
// Returns a presigned URL for direct browser → cloud uploads.
// Usage: GET /api/listings/presign?type=image/jpeg&ext=.jpg&folder=listings
router.get('/presign', authenticateToken, async (req, res) => {
  try {
    const { type = 'image/jpeg', ext = '.jpg', folder = 'listings' } = req.query;
    const result = await storage.getPresignedUploadUrl(type, ext, folder);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── GET /api/listings/user/me ─────────────────────────
router.get('/user/me', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT l.*,
              (SELECT url       FROM listing_photos WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) AS thumb,
              (SELECT thumb_url FROM listing_photos WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) AS thumb_small
       FROM listings l
       WHERE l.user_id = $1
       ORDER BY l.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch your listings' });
  }
});

// ── GET /api/listings/:id ─────────────────────────────
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid listing ID' });

    const { rows } = await query(
      `SELECT l.*, u.name AS seller_name,
              u.state AS seller_state, u.city AS seller_city
       FROM listings l
       JOIN users u ON u.id = l.user_id
       WHERE l.id = $1 AND l.status = 'active'`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Listing not found' });

    const listing = rows[0];

    const [photosRes] = await Promise.all([
      query(
        'SELECT id, url, thumb_url, width, height, size_bytes, sort_order FROM listing_photos WHERE listing_id=$1 ORDER BY sort_order',
        [id]
      ),
      query('UPDATE listings SET views = views + 1 WHERE id=$1', [id]),
    ]);
    listing.photos = photosRes.rows;

    // Only expose seller contact info to authenticated users
    if (req.user) {
      const { rows: contactRows } = await query(
        'SELECT phone FROM users WHERE id=$1', [listing.user_id]
      );
      if (contactRows.length) listing.seller_phone = contactRows[0].phone;
      const { rows: saved } = await query(
        'SELECT 1 FROM saved_listings WHERE user_id=$1 AND listing_id=$2',
        [req.user.id, id]
      );
      listing.is_saved = saved.length > 0;
    }

    res.json(listing);
  } catch (err) {
    console.error('GET /listings/:id:', err);
    res.status(500).json({ error: 'Failed to fetch listing' });
  }
});

// ── POST /api/listings ────────────────────────────────
// Accepts multipart/form-data with up to 20 photos.
// Photos go: multer memoryStorage → storage service → S3/R2/local → DB.
router.post('/', authenticateToken, upload.array('photos', 20), async (req, res) => {
  const client = await pool.connect();
  const uploadedKeys = []; // track for rollback on failure

  try {
    const {
      title, description, category, subcategory, breed,
      price, price_type = 'fixed', quantity = 1,
      weight_lbs, age_months, sex,
      state, city, zip, tier = 'basic',
    } = req.body;

    if (!title || !description || !category || !state || !city)
      return res.status(400).json({ error: 'title, description, category, state, city required' });

    const validCategories = [
      'bulls','bucking_bulls','bred_heifers','bred_cows','open_heifers','open_cows',
      'feeder_stocker','fat_cattle','bottle_calves','cow_calf_pairs',
      'embryos','semen','showstock','dairy',
      'equipment','trailers','chutes_pens','working_dogs','feed_hay',
      'sale_barns','ranches_farms','breed_associations',
      'farm_to_table','livestock_services','feed_stores',
      'insurance_finance','full_herd'
    ];
    if (!validCategories.includes(category))
      return res.status(400).json({ error: 'Invalid category' });
    const safeTier   = ['burger','sirloin','ribeye','filet','t_bone','farm_to_table'].includes(tier) ? tier : 'burger';
    const isFeatured = ['sirloin','ribeye','filet','t_bone'].includes(safeTier);
    const photoLimit = tierPhotoLimit(safeTier);

    await client.query('BEGIN');

    // 1. Insert listing
    const { rows } = await client.query(
      `INSERT INTO listings
         (user_id, title, description, category, subcategory, breed,
          price, price_type, quantity, weight_lbs, age_months, sex,
          state, city, zip, tier, is_featured, expires_at, payment_status, website_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        req.user.id, title, description, category,
        subcategory || null, breed || null,
        price ? +price : null, price_type,
        +quantity,
        weight_lbs ? +weight_lbs : null,
        age_months ? +age_months : null,
        sex || null, state, city, zip || null,
        safeTier, isFeatured, expiresAt(safeTier),
        safeTier === 'basic' ? 'free' : 'pending',
        req.body.website_url || null,
      ]
    );
    const listingId = rows[0].id;

    // 2. Upload photos to cloud storage (in parallel, up to tier limit)
    if (req.files && req.files.length) {
      const { succeeded, failed } = await storage.uploadMany(
        req.files, `listings/${listingId}`, photoLimit
      );

      // Track keys for rollback
      succeeded.forEach(r => { if (r.key) uploadedKeys.push(r.key); });

      // Insert photo records
      for (let i = 0; i < succeeded.length; i++) {
        const r = succeeded[i];
        await client.query(
          `INSERT INTO listing_photos
             (listing_id, url, thumb_url, storage_key, thumb_key,
              width, height, size_bytes, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            listingId, r.url, r.thumbUrl || null,
            r.key, r.thumbKey || null,
            r.width || null, r.height || null,
            r.size || null, i,
          ]
        );
      }

      if (failed.length) {
        console.warn(`Listing ${listingId}: ${failed.length} photo(s) failed to upload`);
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ id: listingId, message: 'Listing created' });

  } catch (err) {
    await client.query('ROLLBACK');
    // Clean up any files already uploaded to cloud
    await Promise.allSettled(uploadedKeys.map(k => storage.deleteFile(k)));
    console.error('POST /listings:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to create listing' });
  } finally {
    client.release();
  }
});

// ── PUT /api/listings/:id ─────────────────────────────
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM listings WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Listing not found' });
    if (rows[0].user_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Not authorized' });

    const { title, description, breed, price, price_type, quantity, state, city, zip, status, category } = req.body;

    // Validate category if provided
    const validCategories = [
      'bulls','bucking_bulls','bred_heifers','bred_cows','open_heifers','open_cows',
      'feeder_stocker','fat_cattle','bottle_calves','cow_calf_pairs',
      'embryos','semen','showstock','dairy',
      'equipment','trailers','chutes_pens','working_dogs','feed_hay',
      'sale_barns','ranches_farms','breed_associations',
      'farm_to_table','livestock_services','feed_stores',
      'insurance_finance','full_herd'
    ];
    const safeCategory = category && validCategories.includes(category)
      ? category : rows[0].category;

    await query(
      `UPDATE listings
       SET title=$1, description=$2, breed=$3, price=$4, price_type=$5,
           quantity=$6, state=$7, city=$8, zip=$9, status=$10, category=$11,
           updated_at=NOW()
       WHERE id=$12`,
      [
        title, description, breed || null,
        price ? +price : null, price_type || 'fixed',
        +quantity || 1, state, city, zip || null,
        status || 'active', safeCategory, req.params.id,
      ]
    );
    res.json({ message: 'Listing updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update listing' });
  }
});

// ── POST /api/listings/:id/photos ─────────────────────
// Add more photos to an existing listing.
router.post('/:id/photos', authenticateToken, upload.array('photos', 20), async (req, res) => {
  const client = await pool.connect();
  const uploadedKeys = [];
  try {
    const { rows } = await query('SELECT * FROM listings WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Listing not found' });
    if (rows[0].user_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Not authorized' });

    // Check current photo count
    const { rows: existing } = await query(
      'SELECT COUNT(*) FROM listing_photos WHERE listing_id=$1', [req.params.id]
    );
    const currentCount = parseInt(existing[0].count);
    const limit = tierPhotoLimit(rows[0].tier);
    const slots = Math.max(0, limit - currentCount);

    if (slots === 0)
      return res.status(400).json({ error: `Photo limit (${limit}) reached for ${rows[0].tier} tier` });

    await client.query('BEGIN');

    const { succeeded, failed } = await storage.uploadMany(
      req.files || [], `listings/${req.params.id}`, slots
    );
    succeeded.forEach(r => { if (r.key) uploadedKeys.push(r.key); });

    const { rows: sortRes } = await client.query(
      'SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM listing_photos WHERE listing_id=$1',
      [req.params.id]
    );
    let sortOrder = parseInt(sortRes[0].max_sort) + 1;

    for (const r of succeeded) {
      await client.query(
        `INSERT INTO listing_photos
           (listing_id, url, thumb_url, storage_key, thumb_key,
            width, height, size_bytes, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          req.params.id, r.url, r.thumbUrl || null,
          r.key, r.thumbKey || null,
          r.width || null, r.height || null, r.size || null, sortOrder++,
        ]
      );
    }

    await client.query('COMMIT');
    res.json({ added: succeeded.length, failed: failed.length, slots_remaining: slots - succeeded.length });
  } catch (err) {
    await client.query('ROLLBACK');
    await Promise.allSettled(uploadedKeys.map(k => storage.deleteFile(k)));
    res.status(500).json({ error: 'Failed to add photos' });
  } finally {
    client.release();
  }
});

// ── DELETE /api/listings/:id/photos/:photoId ──────────
// Delete a single photo — removes from cloud + DB.
router.delete('/:id/photos/:photoId', authenticateToken, async (req, res) => {
  try {
    // Verify ownership
    const { rows: listing } = await query(
      'SELECT user_id FROM listings WHERE id=$1', [req.params.id]
    );
    if (!listing.length) return res.status(404).json({ error: 'Listing not found' });
    if (listing[0].user_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Not authorized' });

    // Fetch the photo record to get the storage key
    const { rows: photo } = await query(
      'SELECT id, storage_key, thumb_key FROM listing_photos WHERE id=$1 AND listing_id=$2',
      [req.params.photoId, req.params.id]
    );
    if (!photo.length) return res.status(404).json({ error: 'Photo not found' });

    // Delete from cloud storage
    if (photo[0].storage_key) await storage.deleteFile(photo[0].storage_key);

    // Delete DB record
    await query('DELETE FROM listing_photos WHERE id=$1', [req.params.photoId]);

    res.json({ deleted: true, photoId: req.params.photoId });
  } catch (err) {
    console.error('DELETE photo:', err);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

// ── DELETE /api/listings/:id ──────────────────────────
// Soft-delete listing + hard-delete all its photos from cloud.
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query('SELECT user_id FROM listings WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].user_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Not authorized' });

    // Fetch all photo storage keys before deleting
    const { rows: photos } = await query(
      'SELECT storage_key, thumb_key FROM listing_photos WHERE listing_id=$1',
      [req.params.id]
    );

    // Soft-delete the listing
    await query(`UPDATE listings SET status='expired' WHERE id=$1`, [req.params.id]);

    // Hard-delete photos from cloud (fire and forget — don't fail the request)
    const keys = photos.flatMap(p => [p.storage_key, p.thumb_key].filter(Boolean));
    Promise.allSettled(keys.map(k => storage.deleteFile(k))).then(results => {
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length) console.warn(`${failed.length} photo(s) failed to delete from storage`);
    });

    res.json({ message: 'Listing removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove listing' });
  }
});

// ── POST /api/listings/:id/save ───────────────────────
router.post('/:id/save', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT 1 FROM saved_listings WHERE user_id=$1 AND listing_id=$2',
      [req.user.id, req.params.id]
    );
    if (rows.length) {
      await query('DELETE FROM saved_listings WHERE user_id=$1 AND listing_id=$2',
        [req.user.id, req.params.id]);
      res.json({ saved: false });
    } else {
      await query('INSERT INTO saved_listings (user_id, listing_id) VALUES ($1,$2)',
        [req.user.id, req.params.id]);
      res.json({ saved: true });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to update saved status' });
  }
});

// ── POST /api/listings/:id/contact ────────────────────
router.post('/:id/contact', authenticateToken, async (req, res) => {
  try {
    const { body } = req.body;
    if (!body) return res.status(400).json({ error: 'Message body required' });

    const { rows } = await query(
      'SELECT user_id, title FROM listings WHERE id=$1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Listing not found' });

    await query(
      'INSERT INTO messages (listing_id, from_user, to_user, subject, body) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id, req.user.id, rows[0].user_id, `Re: ${rows[0].title}`, body]
    );

    // Email notification to seller (non-blocking)
    try {
      const { rows: seller } = await query(
        'SELECT name, email FROM users WHERE id=$1', [rows[0].user_id]
      );
      const { rows: sender } = await query(
        'SELECT name FROM users WHERE id=$1', [req.user.id]
      );
      if (seller.length && sender.length) {
        const { sendEmail, newMessageEmail } = require('../services/email');
        const tmpl = newMessageEmail(seller[0].name, sender[0].name, rows[0].title, body);
        sendEmail({ to: seller[0].email, ...tmpl }).catch(() => {});
      }
    } catch(e) {}

    res.json({ message: 'Message sent' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── GET /api/listings/messages ─────────────────────────
// Returns all messages for the logged-in user (sent + received)
router.get('/messages', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT m.id, m.subject, m.body, m.is_read, m.created_at,
              m.listing_id, m.from_user AS from_id, m.to_user AS to_id,
              CASE WHEN m.from_user=$1 THEN r.name ELSE s.name END AS other_name,
              l.title AS listing_title
       FROM messages m
       JOIN users s ON s.id = m.from_user
       JOIN users r ON r.id = m.to_user
       LEFT JOIN listings l ON l.id = m.listing_id
       WHERE m.from_user=$1 OR m.to_user=$1
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [req.user.id]
    );
    // Mark all received messages as read
    await query(
      'UPDATE messages SET is_read=TRUE WHERE to_user=$1 AND is_read=FALSE',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ── GET /api/listings/messages/unread-count ────────────
router.get('/messages/unread-count', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT COUNT(*) AS c FROM messages WHERE to_user=$1 AND is_read=FALSE',
      [req.user.id]
    );
    res.json({ count: parseInt(rows[0].c) });
  } catch (err) {
    res.status(500).json({ count: 0 });
  }
});

module.exports = router;
