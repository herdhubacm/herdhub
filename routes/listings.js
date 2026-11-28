const express = require('express');
const multer  = require('multer');
const { query, pool } = require('../db/database');
const { authenticateToken, optionalAuth, requireVerifiedEmail } = require('../middleware/auth');
const storage = require('../services/storage');
const plans   = require('../services/plans');
const zipcodes = require('zipcodes');

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

const PRICE_TYPES   = ['fixed','negotiable','obo','call','per_head','per_lb','per_cwt','firm','each','per_pair','per_lb_hanging'];
// Farm to Table: Buy Beef ('farm_to_table') and Processors and Lockers ('processors')
const F2T_CATEGORIES = ['farm_to_table','processors'];
const F2T_TIERS      = ['farm_to_table','t_bone','filet'];
const OPTIONS = {
  farm_proteins:           ['beef','wagyu_beef','bison','pork','lamb_goat','chicken_poultry','chicken_eggs','other_protein'],
  farm_product_forms:      ['whole_animal','half_animal','quarter_animal','custom_cuts','specialty_cuts','bulk_ground','live_to_locker','other_form'],
  farm_production_methods: ['grass_fed','grass_grain_finished','grain_fed','pasture_raised','certified_organic','no_hormones','regenerative'],
  farm_processing:         ['usda_inspected','custom_exempt','buyer_arranges'],
  farm_delivery:           ['farm_pickup','local_delivery','ships_regional','ships_nationwide'],
  proc_inspection:         ['usda','state','custom_exempt'],
  proc_species:            ['beef','hogs','sheep_goats','bison','deer_game','poultry'],
  proc_services:           ['slaughter','mobile_slaughter','cut_wrap','sausage','smoking_curing','dry_aging','vacuum_pack'],
};
const AVAILABILITY = ['ready_now','seasonal','pre_order','sold_out'];
const OPTION_WORDS = {
  farm_proteins: 'what you sell', farm_product_forms: 'how you sell it', farm_production_methods: 'how it is raised',
  farm_processing: 'where it is processed', farm_delivery: 'how buyers get it',
  proc_inspection: 'inspection type', proc_species: 'species', proc_services: 'services',
};
// A list field arrives as a JSON string (posting, multipart) or an array (editing, JSON).
function optionList(v) {
  if (v === '' || v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(String) : null; } catch (e) { return null; }
}
const SEXES         = ['bull','cow','heifer','steer','calf'];
const CONTACT_PREFS = ['message','phone','either'];

function lookupZip(zip) {
  if (!/^\d{5}$/.test(String(zip || ''))) return null;
  const z = zipcodes.lookup(String(zip));
  return z ? { zip: z.zip, city: z.city, state: z.state, lat: z.latitude, lng: z.longitude } : null;
}

// The optional detail fields the listing form sends. Returns { error } or clean values.
// Only keys present in the body are returned, so an edit can send a subset.
function listingExtras(b) {
  const out = {};
  const has = k => Object.prototype.hasOwnProperty.call(b, k);
  const num = v => (v === '' || v == null) ? null : Number(v);
  if (has('weight_lbs')) {
    const w = num(b.weight_lbs);
    if (w !== null && !(w > 0 && w <= 5000)) return { error: 'Weight should be between 1 and 5,000 lb, or leave it blank.' };
    out.weight_lbs = w;
  }
  if (has('age_months')) {
    const a = num(b.age_months);
    if (a !== null && !(Number.isInteger(a) && a >= 0 && a <= 600)) return { error: 'Age should be a whole number of months (up to 50 years), or leave it blank.' };
    out.age_months = a;
  }
  if (has('sex')) {
    if (b.sex && !SEXES.includes(b.sex)) return { error: 'Pick bull, cow, heifer, steer or calf, or leave it blank.' };
    out.sex = b.sex || null;
  }
  if (has('price_type')) {
    if (b.price_type && !PRICE_TYPES.includes(b.price_type)) return { error: 'Pick a price unit from the list.' };
    out.price_type = b.price_type || 'fixed';
  }
  if (has('contact_pref')) {
    if (b.contact_pref && !CONTACT_PREFS.includes(b.contact_pref)) return { error: 'Pick how buyers should reach you.' };
    out.contact_pref = b.contact_pref || 'either';
  }
  if (has('zip')) {
    if (b.zip === '' || b.zip == null) { out.zip = null; }
    else {
      const z = lookupZip(b.zip);
      if (!z) return { error: "We couldn't find that ZIP code. Check it, or leave it blank and enter your city and state." };
      out.zip = z.zip; out.zip_place = z;
    }
  }
  if (has('website_url')) {
    const u = sanitizeText(b.website_url, MAX_WEBSITE_LEN);
    if (u && !/^https?:\/\//i.test(u)) return { error: 'Website should start with http:// or https://' };
    out.website_url = u;
  }
  // Farm to Table fields
  for (const key of Object.keys(OPTIONS)) {
    if (!has(key)) continue;
    const a = optionList(b[key]);
    if (a === null || a.some(v => !OPTIONS[key].includes(v))) return { error: `Pick ${OPTION_WORDS[key]} from the list.` };
    out[key] = a.length ? [...new Set(a)] : null;
  }
  if (has('farm_name')) out.farm_name = sanitizeText(b.farm_name, 150) || null;
  if (has('farm_availability')) {
    if (b.farm_availability && !AVAILABILITY.includes(b.farm_availability)) return { error: 'Pick when the beef is ready from the list.' };
    out.farm_availability = b.farm_availability || null;
  }
  if (has('farm_harvest_date')) {
    const d = b.farm_harvest_date;
    if (d && !(/^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)))) return { error: 'Enter the harvest date as a date, or leave it blank.' };
    out.farm_harvest_date = d || null;
  }
  if (has('farm_deposit_amount')) {
    const v = num(b.farm_deposit_amount);
    if (v !== null && !(v > 0 && v <= 100000)) return { error: 'Enter a deposit amount in dollars, or leave it blank.' };
    out.farm_deposit_amount = v;
    out.farm_deposit_required = v !== null;
  }
  if (has('proc_lead_weeks')) {
    const v = num(b.proc_lead_weeks);
    if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 104)) return { error: 'Enter how many weeks out you are booking (0 to 104), or leave it blank.' };
    out.proc_lead_weeks = v;
  }
  if (has('proc_capacity')) {
    const v = num(b.proc_capacity);
    if (v !== null && !(Number.isInteger(v) && v > 0 && v <= 100000)) return { error: 'Enter head per week as a whole number, or leave it blank.' };
    out.proc_capacity = v;
  }
  if (has('proc_haul')) out.proc_haul = b.proc_haul === true || b.proc_haul === 'true';
  return out;
}

// Required pieces for the two Farm to Table categories, checked on the whole listing.
function f2tMissing(category, v) {
  if (category === 'farm_to_table') {
    if (!(v.farm_proteins || []).length) return 'Pick at least one thing you sell.';
    if (!(v.farm_product_forms || []).length) return 'Pick at least one way you sell it (whole, half, quarter, boxes...).';
    if (!(v.farm_delivery || []).length) return 'Pick how buyers get it: pickup, delivery or shipping.';
  }
  if (category === 'processors') {
    if (!(v.proc_inspection || []).length) return 'Pick your inspection type.';
    if (!(v.proc_species || []).length) return 'Pick at least one species you process.';
    if (!(v.proc_services || []).length) return 'Pick at least one service you offer.';
  }
  return null;
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

// ── Magic bytes file validation ───────────────────────
// Checks actual file content, not just MIME type (spoofing protection)
function validateImageBytes(buffer) {
  if (!buffer || buffer.length < 4) return false;
  const b = buffer;
  // JPEG: FF D8 FF
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return true;
  // GIF: 47 49 46 38
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true;
  // WEBP: 52 49 46 46 (RIFF) then WEBP at offset 8
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      buffer.length > 11 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true;
  return false;
}

// ── Helpers ────────────────────────────────────────────
function tierPhotoLimit(tier) {
  if (tier === 'filet')        return parseInt(process.env.MAX_PHOTOS_FILET)  || 5;
  if (tier === 't_bone')       return parseInt(process.env.MAX_PHOTOS_TBONE)  || 5;
  if (tier === 'ribeye')       return parseInt(process.env.MAX_PHOTOS_RIBEYE) || 3;
  if (tier === 'sirloin')      return parseInt(process.env.MAX_PHOTOS_SIRLOIN) || 3;
  if (tier === 'farm_to_table') return 8;
  if (tier === 'burger')       return 1;
  return parseInt(process.env.MAX_PHOTOS_BASIC) || 1;
}
function expiresAt(tier) {
  // Run lengths live in services/plans.js (they match the plan cards; launch trials run 30 days)
  return plans.daysFromNow(plans.runDays(tier));
}

// ── GET /api/listings ──────────────────────────────────
router.get('/', optionalAuth, async (req, res) => {
  try {
    const {
      category, categories, state, breed, sex, min_price, max_price,
      min_weight, max_weight,
      q, page = 1, limit = 24, sort = 'featured',
      tier, status = 'active', haul, exclude_f2t_featured,
    } = req.query;

    // Public browse: only live or sold listings, never pending/draft/deleted ones
    const conditions = ['l.status = $1', 'l.deleted_at IS NULL'];
    const params     = [status === 'sold' ? 'sold' : 'active'];
    let p = 2;

    if (q) {
      conditions.push(`l.search_vector @@ plainto_tsquery('english', $${p})`);
      params.push(q); p++;
    }
    // Multi-category filter (comma-separated) takes priority over single category
    if (categories) {
      const catArr = categories.split(',').map(c => c.trim()).filter(Boolean);
      if (catArr.length) { conditions.push(`l.category = ANY($${p})`); params.push(catArr); p++; }
    } else if (category) {
      conditions.push(`l.category = $${p}`); params.push(category); p++;
    }
    if (state)      { conditions.push(`l.state = $${p}`);           params.push(state);          p++; }
    if (breed)      { conditions.push(`l.breed ILIKE $${p}`);       params.push(`%${breed}%`);   p++; }
    if (sex)        { conditions.push(`l.sex = $${p}`);             params.push(sex);            p++; }
    if (tier) {
      const tierArr = tier.split(',').map(t => t.trim()).filter(Boolean);
      if (tierArr.length === 1) { conditions.push(`l.tier = $${p}`); params.push(tierArr[0]); p++; }
      else if (tierArr.length > 1) { conditions.push(`l.tier = ANY($${p})`); params.push(tierArr); p++; }
    }
    if (min_price)  { conditions.push(`l.price >= $${p}`);          params.push(+min_price);     p++; }
    if (max_price)  { conditions.push(`l.price <= $${p}`);          params.push(+max_price);     p++; }
    if (min_weight) { conditions.push(`l.weight_lbs >= $${p}`);     params.push(+min_weight);    p++; }
    if (max_weight) { conditions.push(`l.weight_lbs <= $${p}`);     params.push(+max_weight);    p++; }
    // Farm to Table filters: listings matching any of the picked values (comma-separated)
    const F2T_FILTERS = { forms: 'farm_product_forms', methods: 'farm_production_methods', delivery: 'farm_delivery',
      inspection: 'proc_inspection', species: 'proc_species', services: 'proc_services' };
    for (const [param, col] of Object.entries(F2T_FILTERS)) {
      if (!req.query[param]) continue;
      const vals = String(req.query[param]).split(',').map(v => v.trim()).filter(v => OPTIONS[col].includes(v));
      if (vals.length) { conditions.push(`l.${col} && $${p}::text[]`); params.push(vals); p++; }
    }
    if (haul === '1' || haul === 'true') conditions.push('l.proc_haul = TRUE');
    // Recent Listings: Prime and Choice Farm to Table spots show in their own row and the side columns instead
    if (exclude_f2t_featured === '1') conditions.push(`NOT (l.category IN ('farm_to_table','processors') AND l.tier IN ('filet','t_bone'))`);

    const where   = conditions.join(' AND ');
    const tsRank  = q ? `ts_rank(l.search_vector, plainto_tsquery('english', $2)) DESC, ` : '';
    const orderMap = {
      featured:     'l.is_featured DESC, l.created_at DESC',
      newest:       'l.created_at DESC',
      price_asc:    'l.price ASC NULLS LAST',
      price_desc:   'l.price DESC NULLS LAST',
      weight_asc:   'l.weight_lbs ASC NULLS LAST',
      weight_desc:  'l.weight_lbs DESC NULLS LAST',
    };
    const order  = tsRank + (orderMap[sort] || orderMap.featured);
    const safeLimit  = Math.min(Math.max(1, parseInt(limit)  || 24), 500); // max 500 per request (map needs higher limit)
    const safePage   = Math.max(1, parseInt(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    const [countRes, dataRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM listings l WHERE ${where}`, params),
      query(
        `SELECT l.id, l.title, l.category, l.breed, l.price, l.price_type,
                l.quantity, l.state, l.city, l.tier, l.is_featured,
                l.views, l.created_at, l.lat, l.lng,
                l.farm_name, l.farm_proteins, l.farm_production_methods,
                l.proc_inspection, l.proc_species, l.proc_lead_weeks,
                u.name AS seller_name, u.is_verified AS seller_verified,
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
    const cols = `l.id, l.title, l.category, l.breed, l.price, l.price_type,
              l.quantity, l.state, l.city, l.tier, l.is_featured, l.created_at,
              u.name AS seller_name, u.is_verified AS seller_verified,
              (SELECT url FROM listing_photos WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) AS thumb,
              (SELECT thumb_url FROM listing_photos WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) AS thumb_small`;
    // Try featured/paid tiers first
    let { rows } = await query(
      `SELECT ${cols} FROM listings l JOIN users u ON u.id = l.user_id
       WHERE l.status = 'active' AND (l.is_featured = TRUE OR l.tier IN ('t_bone','filet','ribeye'))
       ORDER BY l.created_at DESC LIMIT 12`
    );
    // Fallback: newest active listings
    if (!rows.length) {
      ({ rows } = await query(
        `SELECT ${cols} FROM listings l JOIN users u ON u.id = l.user_id
         WHERE l.status = 'active' ORDER BY l.created_at DESC LIMIT 12`
      ));
    }
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
// Direct-to-storage upload URL. Not used by the site today; kept for native
// clients. Folder and extension are whitelisted so a token holder can't
// write anywhere else in the bucket.
const PRESIGN_FOLDERS = /^(listings|herd|ranch)(\/\d{1,10})?$/;
const PRESIGN_EXTS    = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
router.get('/presign', authenticateToken, async (req, res) => {
  try {
    const { type = 'image/jpeg', ext = '.jpg', folder = 'listings' } = req.query;
    const safeExt = String(ext).toLowerCase();
    if (!PRESIGN_FOLDERS.test(String(folder))) return res.status(400).json({ error: 'Invalid upload folder' });
    if (!PRESIGN_EXTS.has(safeExt))            return res.status(400).json({ error: 'Invalid file extension' });
    const result = await storage.getPresignedUploadUrl(String(type), safeExt, String(folder));
    res.json(result);
  } catch (err) {
    console.error('Presign error:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not prepare the upload' });
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
       WHERE l.user_id = $1 AND l.deleted_at IS NULL
       ORDER BY l.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch your listings' });
  }
});

// The seller's running Sirloin/Ribeye launch trial, if any (one at a time during launch)
async function runningFeaturedTrial(userId) {
  if (plans.PAID_PLANS_LIVE) return null;
  const { rows } = await query(
    `SELECT id, title, expires_at FROM listings
      WHERE user_id=$1 AND launch_promo AND tier = ANY($2)
        AND status IN ('active','pending') AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [userId, plans.SELLER_FEATURED]
  );
  return rows[0] || null;
}

// ── GET /api/listings/zip-lookup/:zip ── fills city and state in the listing form
router.get('/zip-lookup/:zip', (req, res) => {
  const z = lookupZip(req.params.zip);
  if (!z) return res.status(404).json({ error: "We couldn't find that ZIP code." });
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ zip: z.zip, city: z.city, state: z.state });
});

// ── GET /api/listings/user/me/plans ── what the post form should offer this seller
router.get('/user/me/plans', authenticateToken, async (req, res) => {
  try {
    res.json({ paid_plans_live: plans.PAID_PLANS_LIVE, featured_trial: await runningFeaturedTrial(req.user.id) });
  } catch (err) {
    res.status(500).json({ error: 'Could not load your plan options' });
  }
});

// ── GET /api/listings/:id ─────────────────────────────
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


// ── GET /api/listings/recent-sales ────────────────────
router.get('/recent-sales', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT l.title, l.category, l.state, l.city, l.price, l.price_type,
              l.quantity, l.sold_at
       FROM listings l
       WHERE l.status='sold' AND l.sold_at IS NOT NULL
       ORDER BY l.sold_at DESC LIMIT 20`
    );
    res.json(rows);
  } catch(e) { res.json([]); }
});

// ── Homepage section endpoints (MUST be before /:id) ──

const SECTION_COLS = `l.id, l.title, l.category, l.breed, l.price, l.price_type,
  l.quantity, l.state, l.city, l.tier, l.is_featured, l.created_at,
  u.name AS seller_name, u.is_verified AS seller_verified,`;

const SECTION_COLS_FULL = SECTION_COLS + `
  (SELECT url FROM listing_photos WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) AS thumb,
  (SELECT thumb_url FROM listing_photos WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) AS thumb_small`;

// ── Combined homepage endpoint — single API call for all sections ──
router.get('/homepage', async (_req, res) => {
  try {
    const { getCached, setCached } = global.apiCache || {};
    if (getCached) { const c = getCached('homepage-all'); if (c) { res.set('Cache-Control', 'no-cache'); return res.json(c); } }

    const ACTIVE = "l.status='active' AND (l.expires_at IS NULL OR l.expires_at>NOW())";
    const Q = (where, limit) => query(`SELECT ${SECTION_COLS_FULL} FROM listings l JOIN users u ON u.id=l.user_id WHERE ${where} AND ${ACTIVE} ORDER BY RANDOM() LIMIT ${limit}`);

    // Farm to Table rows: Prime first, then Choice, then the rest in a fresh order each time
    const F2T_ORDER = `CASE l.tier WHEN 'filet' THEN 0 WHEN 't_bone' THEN 1 ELSE 2 END, RANDOM()`;
    const [stakeholders, featuredAds, featuredCattle, featuredEquipment, farmToTable, processors, recent] = await Promise.all([
      // Steakholders and Featured Ads show every live placement; the side columns grow to fit
      Q("l.tier='filet'", 100),
      Q("l.tier='t_bone'", 100),
      Q("l.tier IN ('sirloin','ribeye') AND l.category IN ('bulls','bred_heifers','bred_cows','open_heifers','open_cows','cow_calf_pairs','feeder_stocker','showstock','dairy','bottle_calves','beef_cattle','fat_cattle','embryos','semen','full_herd')", 15),
      Q("l.tier IN ('sirloin','ribeye') AND l.category IN ('equipment','trailers','chutes_pens')", 8),
      query(`SELECT ${SECTION_COLS_FULL}, l.farm_name, l.farm_proteins, l.farm_production_methods, l.farm_operation_size FROM listings l JOIN users u ON u.id=l.user_id WHERE l.category='farm_to_table' AND ${ACTIVE} ORDER BY ${F2T_ORDER} LIMIT 12`),
      query(`SELECT ${SECTION_COLS_FULL}, l.proc_inspection, l.proc_species, l.proc_lead_weeks, l.proc_haul FROM listings l JOIN users u ON u.id=l.user_id WHERE l.category='processors' AND ${ACTIVE} ORDER BY ${F2T_ORDER} LIMIT 12`),
      query(`SELECT ${SECTION_COLS_FULL} FROM listings l JOIN users u ON u.id=l.user_id WHERE l.status='active' AND NOT (l.category IN ('farm_to_table','processors') AND l.tier IN ('filet','t_bone')) ORDER BY l.created_at DESC LIMIT 12`),
    ]);

    const result = {
      stakeholders: stakeholders.rows,
      featuredAds: featuredAds.rows,
      featuredCattle: featuredCattle.rows,
      featuredEquipment: featuredEquipment.rows,
      farmToTable: farmToTable.rows,
      processors: processors.rows,
      recent: recent.rows,
    };

    if (setCached) setCached('homepage-all', result, 300);
    res.set('Cache-Control', 'no-cache');
    res.json(result);
  } catch (e) {
    console.error('Homepage query error:', e.message);
    res.status(500).json({ error: 'Could not load listings right now. Please try again.' });
  }
});

router.get('/stakeholders', async (_req, res) => {
  try { const { rows } = await query(`SELECT ${SECTION_COLS_FULL} FROM listings l JOIN users u ON u.id=l.user_id WHERE l.tier='filet' AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at>NOW()) ORDER BY RANDOM() LIMIT 100`); res.json(rows); }
  catch (e) { res.json([]); }
});
router.get('/featured-ads', async (_req, res) => {
  try { const { rows } = await query(`SELECT ${SECTION_COLS_FULL} FROM listings l JOIN users u ON u.id=l.user_id WHERE l.tier='t_bone' AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at>NOW()) ORDER BY RANDOM() LIMIT 100`); res.json(rows); }
  catch (e) { res.json([]); }
});
router.get('/farm-to-table', async (_req, res) => {
  try { const { rows } = await query(`SELECT ${SECTION_COLS_FULL}, l.farm_name, l.farm_proteins, l.farm_production_methods, l.farm_operation_size FROM listings l JOIN users u ON u.id=l.user_id WHERE l.category='farm_to_table' AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at>NOW()) ORDER BY RANDOM() LIMIT 8`); res.json(rows); }
  catch (e) { res.json([]); }
});
router.get('/featured-cattle', async (_req, res) => {
  try { const { rows } = await query(`SELECT ${SECTION_COLS_FULL} FROM listings l JOIN users u ON u.id=l.user_id WHERE l.tier IN ('sirloin','ribeye') AND l.category IN ('bulls','bred_heifers','bred_cows','open_heifers','open_cows','cow_calf_pairs','feeder_stocker','showstock','dairy','bottle_calves','beef_cattle','fat_cattle','embryos','semen','full_herd') AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at>NOW()) ORDER BY RANDOM() LIMIT 15`); res.json(rows); }
  catch (e) { res.json([]); }
});
router.get('/featured-equipment', async (_req, res) => {
  try { const { rows } = await query(`SELECT ${SECTION_COLS_FULL} FROM listings l JOIN users u ON u.id=l.user_id WHERE l.tier IN ('sirloin','ribeye') AND l.category IN ('equipment','trailers','chutes_pens') AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at>NOW()) ORDER BY RANDOM() LIMIT 8`); res.json(rows); }
  catch (e) { res.json([]); }
});
router.get('/working-dogs', async (_req, res) => {
  try { const { rows } = await query(`SELECT ${SECTION_COLS_FULL} FROM listings l JOIN users u ON u.id=l.user_id WHERE l.tier IN ('sirloin','ribeye') AND l.category='working_dogs' AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at>NOW()) ORDER BY RANDOM() LIMIT 6`); res.json(rows); }
  catch (e) { res.json([]); }
});
router.get('/hay-feed', async (_req, res) => {
  try { const { rows } = await query(`SELECT ${SECTION_COLS_FULL} FROM listings l JOIN users u ON u.id=l.user_id WHERE l.tier IN ('sirloin','ribeye') AND l.category='feed_hay' AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at>NOW()) ORDER BY RANDOM() LIMIT 6`); res.json(rows); }
  catch (e) { res.json([]); }
});

// ── GET /api/listings/:id ─────────────────────────────
// ── GET /api/listings/:id/mine ── owner's copy for editing (any status, no view count)
router.get('/:id/mine', authenticateToken, async (req, res) => {
  try {
    const l = await ownListing(req, res); if (!l) return;
    const { rows } = await query(
      'SELECT id, url, thumb_url, width, height, size_bytes, sort_order FROM listing_photos WHERE listing_id=$1 ORDER BY sort_order',
      [l.id]
    );
    delete l.search_vector;
    l.photos = rows;
    l.photo_limit = tierPhotoLimit(l.tier);
    res.json(l);
  } catch (err) {
    console.error('GET /listings/:id/mine:', err.message);
    res.status(500).json({ error: 'Could not load your listing. Please try again.' });
  }
});

router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid listing ID' });

    const { rows } = await query(
      `SELECT l.*, u.name AS seller_name, u.is_verified AS seller_verified,
              u.state AS seller_state, u.city AS seller_city
       FROM listings l
       JOIN users u ON u.id = l.user_id
       WHERE l.id = $1 AND l.status = 'active' AND l.deleted_at IS NULL`,
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
      if (contactRows.length && listing.contact_pref !== 'message') listing.seller_phone = contactRows[0].phone;
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
router.post('/', authenticateToken, requireVerifiedEmail, upload.array('photos', 20), async (req, res) => {
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
      'farm_to_table','processors','livestock_services','feed_stores',
      'insurance_finance','full_herd'
    ];
    if (!validCategories.includes(category))
      return res.status(400).json({ error: 'Invalid category' });
    const extra = listingExtras(req.body);
    if (extra.error) return res.status(400).json({ error: extra.error });
    const place = extra.zip_place || null;
    // Farm to Table listings take the Farm to Table plan, Choice or Prime; the Farm to Table plan is only for them
    const isF2T = F2T_CATEGORIES.includes(category);
    let safeTier = ['burger','sirloin','ribeye','filet','t_bone','farm_to_table'].includes(tier) ? tier : 'burger';
    if (isF2T && !F2T_TIERS.includes(safeTier)) safeTier = 'farm_to_table';
    if (!isF2T && safeTier === 'farm_to_table') safeTier = 'burger';
    const f2tProblem = f2tMissing(category, extra);
    if (f2tProblem) return res.status(400).json({ error: f2tProblem });
    const isFeatured = ['sirloin','ribeye','filet','t_bone','farm_to_table'].includes(safeTier);
    const photoLimit = tierPhotoLimit(safeTier);
    const launchTrial   = plans.isLaunchTrial(safeTier);
    const needsApproval = launchTrial && plans.NEEDS_APPROVAL.includes(safeTier);

    // Launch: one free Sirloin/Ribeye featured spot per seller at a time
    if (launchTrial && plans.SELLER_FEATURED.includes(safeTier)) {
      const running = await runningFeaturedTrial(req.user.id);
      if (running) {
        return res.status(409).json({
          code: 'FEATURED_LIMIT',
          error: `You already have a featured listing running ("${running.title}"). While we launch, each seller gets one free featured spot at a time. Post this one on the free Burger plan, or post it after that run ends.`,
        });
      }
    }

    await client.query('BEGIN');

    // 1. Insert listing (with optional client-side lat/lng)
    // A known ZIP gives the map point; otherwise the client's point, otherwise geocode below
    const clientLat = place ? place.lat : (req.body.lat ? parseFloat(req.body.lat) : null);
    const clientLng = place ? place.lng : (req.body.lng ? parseFloat(req.body.lng) : null);
    const { rows } = await client.query(
      `INSERT INTO listings
         (user_id, title, description, category, subcategory, breed,
          price, price_type, quantity, weight_lbs, age_months, sex,
          state, city, zip, tier, is_featured, expires_at, payment_status, website_url,
          lat, lng,
          farm_name, farm_proteins, farm_product_forms, farm_production_methods,
          farm_processing, farm_delivery, farm_availability, farm_harvest_date,
          farm_certifications, farm_price_hanging, farm_price_takehome,
          farm_deposit_required, farm_deposit_amount, farm_call_for_price,
          farm_tours, farm_operation_size, farm_years,
          status, launch_promo, awaiting_approval, contact_pref,
          proc_inspection, proc_species, proc_services, proc_lead_weeks, proc_haul, proc_capacity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,
               $40,$41,$42,$43,$44,$45,$46,$47,$48,$49)
       RETURNING id`,
      [
        req.user.id, sanitizeText(title, MAX_TITLE_LEN), sanitizeText(description, MAX_DESC_LEN), category,
        subcategory || null, sanitizeText(breed, 60),
        price ? +price : null, extra.price_type || 'fixed',
        Math.max(1, parseInt(quantity) || 1),
        extra.weight_lbs ?? null,
        extra.age_months ?? null,
        extra.sex ?? null, sanitizeText(state, 2), sanitizeText(city, MAX_CITY_LEN), extra.zip ?? null,
        // Prime/Choice launch trials wait for approval; their run starts when approved
        safeTier, isFeatured, needsApproval ? null : expiresAt(safeTier),
        (launchTrial || safeTier === 'burger' || safeTier === 'farm_to_table') ? 'free' : 'pending',
        extra.website_url ?? null,
        clientLat, clientLng,
        // Farm to Table fields
        extra.farm_name ?? null,
        extra.farm_proteins ?? null,
        extra.farm_product_forms ?? null,
        extra.farm_production_methods ?? null,
        extra.farm_processing ?? null,
        extra.farm_delivery ?? null,
        extra.farm_availability ?? null,
        extra.farm_harvest_date ?? null,
        null, null, null,
        extra.farm_deposit_required === true,
        extra.farm_deposit_amount ?? null,
        false, false, null, null,
        needsApproval ? 'pending' : 'active', launchTrial, needsApproval,
        extra.contact_pref || 'either',
        extra.proc_inspection ?? null, extra.proc_species ?? null, extra.proc_services ?? null,
        extra.proc_lead_weeks ?? null, extra.proc_haul === true, extra.proc_capacity ?? null,
      ]
    );
    const listingId = rows[0].id;

    // Geocode city+state → lat/lng (fallback if client didn't provide coordinates)
    if (!clientLat && !clientLng && city && state) {
      (async () => {
        try {
          const geo = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city+', '+state+', USA')}&format=json&limit=1`,
            { headers: { 'User-Agent': 'HerdHub/1.0 (ad@theherdhub.com)' } }
          );
          const geoData = await geo.json();
          if (geoData.length) {
            await query(
              'UPDATE listings SET lat=$1, lng=$2 WHERE id=$3',
              [parseFloat(geoData[0].lat), parseFloat(geoData[0].lon), listingId]
            );
          }
        } catch(e) { /* geocoding is best-effort */ }
      })();
    }

    // 2. Upload photos to cloud storage (in parallel, up to tier limit)
    if (req.files && req.files.length) {
      // Validate magic bytes on every file
      for (const file of req.files) {
        if (!validateImageBytes(file.buffer)) {
          await client.query('ROLLBACK');
          return res.status(415).json({ error: 'Invalid image file. Only real JPEG, PNG, WEBP, or GIF files are accepted.' });
        }
      }
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

    // Clear homepage cache so new listing appears immediately
    if (global.apiCache?.clearListingCache) global.apiCache.clearListingCache();

    // Beef Box First 1000 Check
    let show_beef_box_offer = false;
    let lister_number = null;
    try {
      const { rows: prev } = await query('SELECT COUNT(*)::int as cnt FROM listings WHERE user_id=$1 AND id!=$2', [req.user.id, listingId]);
      if (prev[0].cnt === 0) {
        const { rows: ud } = await query('SELECT lister_number, beef_box_claimed FROM users WHERE id=$1', [req.user.id]);
        if (!ud[0].lister_number) {
          const { rows: ct } = await query('SELECT COUNT(DISTINCT user_id)::int as cnt FROM listings');
          lister_number = ct[0].cnt;
          await query('UPDATE users SET lister_number=$1 WHERE id=$2', [lister_number, req.user.id]);
        } else {
          lister_number = ud[0].lister_number;
        }
        if (lister_number <= 1000 && !ud[0].beef_box_claimed) show_beef_box_offer = true;
      }
    } catch(e) { console.error('Beef box check error:', e.message); }

    console.log(`Listing ${listingId} created by user ${req.user.id} — beef_box: ${show_beef_box_offer}, lister#: ${lister_number}`);
    res.status(201).json({
      id: listingId, message: 'Listing created', show_beef_box_offer, lister_number,
      tier: safeTier, launch_trial: launchTrial, awaiting_approval: needsApproval,
      run_days: plans.runDays(safeTier),
    });

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
// Edits the listing's details. Only the fields sent are changed, so a partial
// body never blanks the rest. Status changes go through /sold and /renew.
const VALID_CATEGORIES = [
  'bulls','bucking_bulls','bred_heifers','bred_cows','open_heifers','open_cows',
  'feeder_stocker','fat_cattle','bottle_calves','cow_calf_pairs',
  'embryos','semen','showstock','dairy',
  'equipment','trailers','chutes_pens','working_dogs','feed_hay',
  'sale_barns','ranches_farms','breed_associations',
  'farm_to_table','processors','livestock_services','feed_stores',
  'insurance_finance','full_herd'
];

async function ownListing(req, res) {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid listing ID' }); return null; }
  const { rows } = await query('SELECT * FROM listings WHERE id=$1 AND deleted_at IS NULL', [id]);
  if (!rows.length) { res.status(404).json({ error: 'Listing not found. It may have been deleted.' }); return null; }
  if (rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
    res.status(403).json({ error: 'You can only change your own listings.' }); return null;
  }
  return rows[0];
}

router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const l = await ownListing(req, res); if (!l) return;
    const b = req.body || {};
    const has = k => Object.prototype.hasOwnProperty.call(b, k);

    const title = has('title') ? sanitizeText(b.title, MAX_TITLE_LEN) : l.title;
    const description = has('description') ? sanitizeText(b.description, MAX_DESC_LEN) : l.description;
    const state = has('state') ? sanitizeText(b.state, 2) : l.state;
    const city = has('city') ? sanitizeText(b.city, MAX_CITY_LEN) : l.city;
    if (!title || !description || !state || !city)
      return res.status(400).json({ error: 'Title, description, state and city can\'t be blank.' });
    if (has('category') && !VALID_CATEGORIES.includes(b.category))
      return res.status(400).json({ error: 'Pick a category from the list.' });
    const price = has('price') ? (b.price === '' || b.price == null ? null : +b.price) : l.price;
    if (price != null && (!isFinite(price) || price < 0))
      return res.status(400).json({ error: 'Price must be a number, or leave it blank.' });
    const quantity = has('quantity') ? parseInt(b.quantity) : l.quantity;
    if (!(quantity > 0)) return res.status(400).json({ error: 'Quantity must be 1 or more.' });

    // The old edit form also sent status; only "sold" is honored here.
    const markSold = b.status === 'sold' && l.status !== 'sold';
    const extra = listingExtras(b);
    if (extra.error) return res.status(400).json({ error: extra.error });
    const keep = (k) => Object.prototype.hasOwnProperty.call(extra, k) ? extra[k] : l[k];
    const place = extra.zip_place || null;
    // Farm to Table listings stay in Farm to Table, and other listings stay out, so the plan keeps working
    const newCat = has('category') ? b.category : l.category;
    if (F2T_CATEGORIES.includes(l.category) !== F2T_CATEGORIES.includes(newCat))
      return res.status(400).json({ error: F2T_CATEGORIES.includes(l.category) ? 'A Farm to Table listing stays in Farm to Table. Post a new listing for anything else.' : 'To list in Farm to Table, post a new Farm to Table listing.' });
    const F2T_KEYS = [...Object.keys(OPTIONS), 'farm_name', 'farm_availability', 'farm_harvest_date', 'farm_deposit_amount', 'farm_deposit_required', 'proc_lead_weeks', 'proc_haul', 'proc_capacity'];
    const merged = {}; F2T_KEYS.forEach(k => { merged[k] = keep(k); });
    const f2tProblem = f2tMissing(newCat, merged);
    if (f2tProblem) return res.status(400).json({ error: f2tProblem });

    await query(
      `UPDATE listings
       SET title=$1, description=$2, breed=$3, price=$4, price_type=$5,
           quantity=$6, state=$7, city=$8, zip=$9, category=$10,
           status = CASE WHEN $11 THEN 'sold' ELSE status END,
           sold_at = CASE WHEN $11 THEN NOW() ELSE sold_at END,
           weight_lbs=$13, age_months=$14, sex=$15, contact_pref=$16, website_url=$17,
           lat = COALESCE($18, lat), lng = COALESCE($19, lng),
           farm_name=$20, farm_proteins=$21, farm_product_forms=$22, farm_production_methods=$23,
           farm_processing=$24, farm_delivery=$25, farm_availability=$26, farm_harvest_date=$27,
           farm_deposit_amount=$28, farm_deposit_required=$29,
           proc_inspection=$30, proc_species=$31, proc_services=$32, proc_lead_weeks=$33, proc_haul=$34, proc_capacity=$35,
           updated_at=NOW()
       WHERE id=$12`,
      [
        title, description,
        has('breed') ? (b.breed || null) : l.breed,
        price,
        keep('price_type'),
        quantity, state, city,
        keep('zip'),
        has('category') ? b.category : l.category,
        markSold, l.id,
        keep('weight_lbs'), keep('age_months'), keep('sex'), keep('contact_pref'), keep('website_url'),
        place ? place.lat : null, place ? place.lng : null,
        ...['farm_name','farm_proteins','farm_product_forms','farm_production_methods','farm_processing','farm_delivery',
            'farm_availability','farm_harvest_date','farm_deposit_amount'].map(k => merged[k]), merged.farm_deposit_required === true,
        merged.proc_inspection, merged.proc_species, merged.proc_services, merged.proc_lead_weeks, merged.proc_haul === true, merged.proc_capacity,
      ]
    );
    if (global.apiCache?.clearListingCache) global.apiCache.clearListingCache();
    res.json({ message: 'Listing updated' });
  } catch (err) {
    console.error('PUT /listings/:id:', err.message);
    res.status(500).json({ error: 'Could not save your changes. Please try again.' });
  }
});

// ── PUT /api/listings/:id/photos/order ── { ids: [photoId, ...] } first one is the cover
router.put('/:id/photos/order', authenticateToken, async (req, res) => {
  try {
    const l = await ownListing(req, res); if (!l) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(n => parseInt(n)).filter(n => n > 0) : [];
    const { rows } = await query('SELECT id FROM listing_photos WHERE listing_id=$1', [l.id]);
    const have = new Set(rows.map(r => Number(r.id)));
    if (!ids.length || ids.length !== have.size || !ids.every(id => have.has(id)) || new Set(ids).size !== ids.length)
      return res.status(400).json({ error: 'Photo order is out of date. Reopen the listing and try again.' });
    for (let i = 0; i < ids.length; i++) {
      await query('UPDATE listing_photos SET sort_order=$1 WHERE id=$2 AND listing_id=$3', [i, ids[i], l.id]);
    }
    if (global.apiCache?.clearListingCache) global.apiCache.clearListingCache();
    res.json({ message: 'Photo order saved' });
  } catch (err) {
    console.error('PUT /listings/:id/photos/order:', err.message);
    res.status(500).json({ error: 'Could not save the photo order. Please try again.' });
  }
});

// ── POST /api/listings/:id/sold ───────────────────────
router.post('/:id/sold', authenticateToken, async (req, res) => {
  try {
    const l = await ownListing(req, res); if (!l) return;
    if (l.status === 'sold') return res.json({ message: 'Already marked sold' });
    await query(`UPDATE listings SET status='sold', sold_at=NOW(), awaiting_approval=FALSE, updated_at=NOW() WHERE id=$1`, [l.id]);
    if (global.apiCache?.clearListingCache) global.apiCache.clearListingCache();
    res.json({ message: 'Marked sold' });
  } catch (err) {
    console.error('POST /listings/:id/sold:', err.message);
    res.status(500).json({ error: 'Could not mark it sold. Please try again.' });
  }
});

// ── POST /api/listings/:id/renew ──────────────────────
// Relist a sold or expired listing, or renew one that is close to running out.
// A renewal is always a regular free listing for 30 days; a launch featured
// trial is not renewed (it drops to a regular listing on its own).
router.post('/:id/renew', authenticateToken, async (req, res) => {
  try {
    const l = await ownListing(req, res); if (!l) return;
    if (l.awaiting_approval)
      return res.status(400).json({ error: 'This listing is still waiting for review. It goes live once it is approved.' });
    if (l.status === 'pending')
      return res.status(400).json({ error: 'This listing is under review after a report. We will restore it if everything checks out.' });
    if (l.status === 'active' && l.launch_promo)
      return res.status(400).json({ error: 'Your free featured run is still going. When it ends, the listing stays up as a regular listing.' });
    const photoCount = (await query('SELECT COUNT(*)::int AS c FROM listing_photos WHERE listing_id=$1', [l.id])).rows[0].c;
    if (!photoCount)
      return res.status(400).json({ error: 'Add at least one photo (Edit) before relisting.' });

    // Active: add 30 days to whatever is left. Sold or expired: 30 days from now.
    const fromDate = l.status === 'active' && l.expires_at && new Date(l.expires_at) > new Date() ? new Date(l.expires_at) : new Date();
    const renewDays = F2T_CATEGORIES.includes(l.category) ? plans.runDays('farm_to_table') : plans.REGULAR_RUN_DAYS;
    const newExpiry = new Date(fromDate.getTime() + renewDays * 86400000);
    const paidRunGoing = !l.launch_promo && plans.PAID_TIERS.includes(l.tier) && l.payment_status === 'paid';
    await query(
      `UPDATE listings
          SET status='active', sold_at=NULL, expires_at=$1, updated_at=NOW(),
              tier = CASE WHEN $2 THEN tier WHEN category IN ('farm_to_table','processors') THEN 'farm_to_table' ELSE 'burger' END,
              is_featured = CASE WHEN $2 THEN is_featured ELSE FALSE END,
              launch_promo = FALSE
        WHERE id=$3`,
      [newExpiry, paidRunGoing, l.id]
    );
    if (global.apiCache?.clearListingCache) global.apiCache.clearListingCache();
    res.json({ message: 'Listing is live', expires_at: newExpiry });
  } catch (err) {
    console.error('POST /listings/:id/renew:', err.message);
    res.status(500).json({ error: 'Could not relist it. Please try again.' });
  }
});

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

    // Same real-image check as listing creation: the MIME type is client-supplied
    for (const file of (req.files || [])) {
      if (!validateImageBytes(file.buffer)) {
        return res.status(415).json({ error: 'Invalid image file. Only real JPEG, PNG, WEBP, or GIF files are accepted.' });
      }
    }

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

    const newIds = [];
    for (const r of succeeded) {
      const ins = await client.query(
        `INSERT INTO listing_photos
           (listing_id, url, thumb_url, storage_key, thumb_key,
            width, height, size_bytes, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          req.params.id, r.url, r.thumbUrl || null,
          r.key, r.thumbKey || null,
          r.width || null, r.height || null, r.size || null, sortOrder++,
        ]
      );
      newIds.push(ins.rows[0].id);
    }

    await client.query('COMMIT');
    if (global.apiCache?.clearListingCache) global.apiCache.clearListingCache();
    res.json({ added: succeeded.length, failed: failed.length, slots_remaining: slots - succeeded.length, ids: newIds });
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

    // Soft-delete the listing (deleted_at keeps it out of My Listings and relisting)
    await query(`UPDATE listings SET status='expired', deleted_at=NOW(), awaiting_approval=FALSE WHERE id=$1`, [req.params.id]);
    await query('DELETE FROM listing_photos WHERE listing_id=$1', [req.params.id]);
    if (global.apiCache?.clearListingCache) global.apiCache.clearListingCache();

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

module.exports = router;
