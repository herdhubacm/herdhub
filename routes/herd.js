const express = require('express');
const multer  = require('multer');
const { query } = require('../db/database');
const { authenticateToken } = require('../middleware/auth');
const storage = require('../services/storage');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','image/gif'];
    ok.includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error('Image files only'), { status: 415 }));
  },
});

function san(str, max) { return str ? String(str).trim().slice(0, max) : null; }
function numOrNull(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
function intOrNull(v) { const n = parseInt(v); return isNaN(n) ? null : n; }
// 'YYYY-MM-DD' or null. Anything else is refused so a bad date never reaches the table.
function dateOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const t = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return undefined;
  const d = new Date(t + 'T00:00:00Z');
  return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? undefined : t;
}
const today = () => new Date().toISOString().slice(0, 10);
const SEXES = ['cow', 'bull', 'heifer', 'steer', 'calf'];
const STATUSES = ['active', 'sold', 'deceased', 'culled'];
const HEALTH_TYPES = ['vaccination', 'treatment', 'deworming', 'preg_check', 'vet_visit', 'surgery', 'other'];
const PROD_TYPES = ['breeding', 'calving', 'preg_check', 'weaning'];
const GESTATION_DAYS = 283; // planning average; the Gestation Calculator has breed figures

// Shared checks for creating and editing an animal. Returns { error } or clean fields.
function cleanAnimal(b) {
  const tag = san(b.tag_id, 50), name = san(b.name, 100);
  if (!tag && !name) return { error: 'Give the animal a tag or a name' };
  const sex = b.sex ? String(b.sex).toLowerCase() : null;
  if (sex && !SEXES.includes(sex)) return { error: 'Sex must be cow, bull, heifer, steer or calf' };
  const status = b.status ? String(b.status).toLowerCase() : 'active';
  if (!STATUSES.includes(status)) return { error: 'Status must be active, sold, deceased or culled' };
  const birth = dateOrNull(b.birth_date), purchase = dateOrNull(b.purchase_date);
  if (birth === undefined || purchase === undefined) return { error: 'Dates must be valid' };
  if (birth && birth > today()) return { error: 'Birth date cannot be in the future' };
  const bw = numOrNull(b.birth_weight), price = numOrNull(b.purchase_price);
  if (bw !== null && (bw <= 0 || bw > 300)) return { error: 'Birth weight looks wrong. Enter pounds.' };
  if (price !== null && price < 0) return { error: 'Purchase price cannot be negative' };
  return { tag, name, sex, status, birth, purchase, bw, price };
}
async function ownsAnimal(id, userId) {
  const { rows } = await query('SELECT id, tag_id, name FROM animals WHERE id=$1 AND user_id=$2', [id, userId]);
  return rows[0] || null;
}

// ── GET /api/herd/stats/overview ─────────────────────────────────────────────
router.get('/stats/overview', authenticateToken, async (req, res) => {
  try {
    const uid = req.user.id;

    const totals = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status='active') AS total,
        COUNT(*) FILTER (WHERE status='active' AND sex='cow')    AS cows,
        COUNT(*) FILTER (WHERE status='active' AND sex='bull')   AS bulls,
        COUNT(*) FILTER (WHERE status='active' AND sex='heifer') AS heifers,
        COUNT(*) FILTER (WHERE status='active' AND sex IN ('steer','calf')) AS steers_calves
      FROM animals WHERE user_id=$1`, [uid]);

    const avgW = await query(`
      SELECT ROUND(AVG(w.weight)::numeric, 1) AS avg_weight
      FROM (
        SELECT DISTINCT ON (animal_id) weight
        FROM animal_weights
        WHERE animal_id IN (SELECT id FROM animals WHERE user_id=$1 AND status='active')
        ORDER BY animal_id, weigh_date DESC
      ) w`, [uid]);

    // Upcoming withdrawals
    const withdrawals = await query(`
      SELECT ah.withdrawal_clear_date, ah.product, a.tag_id, a.name, a.id AS animal_id
      FROM animal_health ah
      JOIN animals a ON a.id = ah.animal_id
      WHERE a.user_id=$1 AND a.status='active' AND ah.withdrawal_clear_date IS NOT NULL
        AND ah.withdrawal_clear_date >= CURRENT_DATE
      ORDER BY ah.withdrawal_clear_date ASC LIMIT 10`, [uid]);

    // Animals not weighed in 60+ days
    const staleWeights = await query(`
      SELECT a.id AS animal_id, a.tag_id, a.name,
        (SELECT MAX(weigh_date) FROM animal_weights WHERE animal_id=a.id) AS last_weighed
      FROM animals a
      WHERE a.user_id=$1 AND a.status='active'
        AND (SELECT MAX(weigh_date) FROM animal_weights WHERE animal_id=a.id) < CURRENT_DATE - INTERVAL '60 days'
      ORDER BY last_weighed ASC LIMIT 10`, [uid]);

    // Calvings due: 283 days after the latest breeding, from two weeks overdue to
    // 30 days out, unless a calving has been recorded since that breeding.
    const calvings = await query(`
      SELECT ap.event_date, (ap.event_date + ${GESTATION_DAYS})::date AS due_date,
             ap.bull_name, a.tag_id, a.name, a.id AS animal_id
      FROM animal_production ap
      JOIN animals a ON a.id = ap.animal_id
      WHERE a.user_id=$1 AND a.status='active' AND ap.event_type='breeding'
        AND ap.event_date + ${GESTATION_DAYS} >= CURRENT_DATE - 14
        AND ap.event_date + ${GESTATION_DAYS} <= CURRENT_DATE + 30
        AND NOT EXISTS (SELECT 1 FROM animal_production c WHERE c.animal_id = ap.animal_id
                         AND c.event_type='calving' AND c.event_date > ap.event_date)
        AND NOT EXISTS (SELECT 1 FROM animal_production b2 WHERE b2.animal_id = ap.animal_id
                         AND b2.event_type='breeding' AND b2.event_date > ap.event_date)
      ORDER BY due_date ASC LIMIT 10`, [uid]);

    // Recent activity (last 10 events across tables)
    const recent = await query(`
      (SELECT 'weight' AS type, a.tag_id, a.name, a.id AS animal_id,
        w.weigh_date AS event_date, w.weight::text AS detail, w.created_at
       FROM animal_weights w JOIN animals a ON a.id=w.animal_id
       WHERE a.user_id=$1 ORDER BY w.created_at DESC LIMIT 5)
      UNION ALL
      (SELECT 'health' AS type, a.tag_id, a.name, a.id AS animal_id,
        h.event_date, h.event_type || ': ' || COALESCE(h.product,'') AS detail, h.created_at
       FROM animal_health h JOIN animals a ON a.id=h.animal_id
       WHERE a.user_id=$1 ORDER BY h.created_at DESC LIMIT 5)
      ORDER BY created_at DESC LIMIT 10`, [uid]);

    res.json({
      counts: totals.rows[0],
      avg_weight: avgW.rows[0]?.avg_weight || null,
      withdrawals: withdrawals.rows,
      stale_weights: staleWeights.rows,
      upcoming_calvings: calvings.rows,
      recent_activity: recent.rows
    });
  } catch (err) {
    console.error('GET /herd/stats error:', err.message);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ── GET /api/herd ────────────────────────────────────────────────────────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT a.*,
        (SELECT w.weight FROM animal_weights w WHERE w.animal_id=a.id ORDER BY w.weigh_date DESC LIMIT 1) AS last_weight,
        (SELECT w.weigh_date FROM animal_weights w WHERE w.animal_id=a.id ORDER BY w.weigh_date DESC LIMIT 1) AS last_weigh_date
      FROM animals a WHERE a.user_id=$1
      ORDER BY a.status='active' DESC, a.tag_id ASC`, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error('GET /herd error:', err.message);
    res.status(500).json({ error: 'Failed to load herd' });
  }
});

// ── GET /api/herd/:id ────────────────────────────────────────────────────────
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows } = await query('SELECT * FROM animals WHERE id=$1 AND user_id=$2', [id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Animal not found' });

    const animal = rows[0];
    const weights = await query('SELECT * FROM animal_weights WHERE animal_id=$1 ORDER BY weigh_date DESC', [id]);
    const health = await query('SELECT * FROM animal_health WHERE animal_id=$1 ORDER BY event_date DESC', [id]);
    const production = await query('SELECT * FROM animal_production WHERE animal_id=$1 ORDER BY event_date DESC', [id]);
    // The form records sire and dam by name, so match those against this animal's tag or name.
    const keys = [animal.tag_id, animal.name].filter(Boolean).map(v => String(v).trim().toLowerCase());
    const progeny = await query(
      `SELECT id, tag_id, name, sex, breed, birth_date, status
       FROM animals WHERE user_id=$1 AND id<>$2 AND (sire_id=$2 OR dam_id=$2
          OR LOWER(TRIM(sire_name)) = ANY($3) OR LOWER(TRIM(dam_name)) = ANY($3))
       ORDER BY birth_date DESC NULLS LAST`,
      [req.user.id, id, keys]);

    res.json({
      ...animal,
      weights: weights.rows,
      health: health.rows,
      production: production.rows,
      progeny: progeny.rows
    });
  } catch (err) {
    console.error('GET /herd/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load animal' });
  }
});

// ── POST /api/herd ───────────────────────────────────────────────────────────
router.post('/', authenticateToken, upload.single('photo'), async (req, res) => {
  try {
    const b = req.body;
    const c = cleanAnimal(b);
    if (c.error) return res.status(400).json({ error: c.error });
    let photo_url = null;
    if (req.file) {
      const result = await storage.uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype, 'herd');
      photo_url = result.url;
    }

    const { rows } = await query(`
      INSERT INTO animals (user_id, tag_id, name, species, sex, breed, birth_date, birth_weight,
        color, sire_id, dam_id, sire_name, dam_name, purchase_date, purchase_price, status, notes, photo_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [req.user.id, c.tag, c.name, san(b.species,20)||'cattle',
       c.sex, san(b.breed,50), c.birth, c.bw,
       san(b.color,50), intOrNull(b.sire_id), intOrNull(b.dam_id),
       san(b.sire_name,100), san(b.dam_name,100),
       c.purchase, c.price,
       c.status, san(b.notes,2000), photo_url]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /herd error:', err.message);
    res.status(500).json({ error: 'Failed to add animal' });
  }
});

// ── PUT /api/herd/:id ────────────────────────────────────────────────────────
router.put('/:id', authenticateToken, upload.single('photo'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body;
    const c = cleanAnimal(b);
    if (c.error) return res.status(400).json({ error: c.error });

    // Verify ownership
    const check = await query('SELECT id, photo_url FROM animals WHERE id=$1 AND user_id=$2', [id, req.user.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Animal not found' });

    let photo_url = check.rows[0].photo_url;
    if (req.file) {
      const result = await storage.uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype, 'herd');
      photo_url = result.url;
    }

    const { rows } = await query(`
      UPDATE animals SET tag_id=$2, name=$3, species=$4, sex=$5, breed=$6, birth_date=$7,
        birth_weight=$8, color=$9, sire_id=$10, dam_id=$11, sire_name=$12, dam_name=$13,
        purchase_date=$14, purchase_price=$15, status=$16, notes=$17, photo_url=$18
      WHERE id=$1 AND user_id=$19 RETURNING *`,
      [id, c.tag, c.name, san(b.species,20)||'cattle',
       c.sex, san(b.breed,50), c.birth, c.bw,
       san(b.color,50), intOrNull(b.sire_id), intOrNull(b.dam_id),
       san(b.sire_name,100), san(b.dam_name,100),
       c.purchase, c.price,
       c.status, san(b.notes,2000), photo_url, req.user.id]);
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /herd/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update animal' });
  }
});

// ── DELETE /api/herd/:id ─────────────────────────────────────────────────────
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { rowCount } = await query('DELETE FROM animals WHERE id=$1 AND user_id=$2',
      [parseInt(req.params.id), req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Animal not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /herd/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete animal' });
  }
});

// ── Weights ──────────────────────────────────────────────────────────────────
router.get('/:id/weights', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const own = await query('SELECT id FROM animals WHERE id=$1 AND user_id=$2', [id, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Animal not found' });
    const { rows } = await query('SELECT * FROM animal_weights WHERE animal_id=$1 ORDER BY weigh_date DESC', [id]);
    res.json(rows);
  } catch (err) {
    console.error('GET weights error:', err.message);
    res.status(500).json({ error: 'Failed to load weights' });
  }
});

router.post('/:id/weights', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const own = await query('SELECT id FROM animals WHERE id=$1 AND user_id=$2', [id, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Animal not found' });

    const weight = numOrNull(req.body.weight);
    if (!weight || weight <= 0 || weight > 5000) return res.status(400).json({ error: 'Enter a weight in pounds' });
    const wDate = dateOrNull(req.body.weigh_date) === null ? today() : dateOrNull(req.body.weigh_date);
    if (wDate === undefined) return res.status(400).json({ error: 'Weigh date must be valid' });
    if (wDate > today()) return res.status(400).json({ error: 'Weigh date cannot be in the future' });

    const { rows } = await query(
      `INSERT INTO animal_weights (animal_id, weight, weigh_date, notes)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, weight, wDate, san(req.body.notes, 500)]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST weights error:', err.message);
    res.status(500).json({ error: 'Failed to save weight' });
  }
});

// ── Health ───────────────────────────────────────────────────────────────────
router.get('/:id/health', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const own = await query('SELECT id FROM animals WHERE id=$1 AND user_id=$2', [id, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Animal not found' });
    const { rows } = await query('SELECT * FROM animal_health WHERE animal_id=$1 ORDER BY event_date DESC', [id]);
    res.json(rows);
  } catch (err) {
    console.error('GET health error:', err.message);
    res.status(500).json({ error: 'Failed to load health records' });
  }
});

router.post('/:id/health', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const own = await query('SELECT id FROM animals WHERE id=$1 AND user_id=$2', [id, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Animal not found' });

    const b = req.body;
    const event_date = dateOrNull(b.event_date) === null ? today() : dateOrNull(b.event_date);
    if (event_date === undefined) return res.status(400).json({ error: 'Event date must be valid' });
    const event_type = HEALTH_TYPES.includes(b.event_type) ? b.event_type : 'other';
    const withdrawal_days = b.withdrawal_days === '' || b.withdrawal_days === undefined || b.withdrawal_days === null ? null : intOrNull(b.withdrawal_days);
    if (withdrawal_days !== null && (withdrawal_days < 0 || withdrawal_days > 365)) return res.status(400).json({ error: 'Withdrawal days must be between 0 and 365' });
    const cost = numOrNull(b.cost);
    if (cost !== null && cost < 0) return res.status(400).json({ error: 'Cost cannot be negative' });
    // Clear date = treatment date + label withdrawal days, in whole calendar days (UTC, no clock shifts).
    let withdrawal_clear_date = null;
    if (withdrawal_days && withdrawal_days > 0) {
      const d = new Date(event_date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + withdrawal_days);
      withdrawal_clear_date = d.toISOString().slice(0,10);
    }

    const { rows } = await query(
      `INSERT INTO animal_health (animal_id, event_type, event_date, product, dosage,
        withdrawal_days, withdrawal_clear_date, administered_by, cost, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, event_type, event_date, san(b.product,100), san(b.dosage,50),
       withdrawal_days, withdrawal_clear_date, san(b.administered_by,100),
       cost, san(b.notes,1000)]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST health error:', err.message);
    res.status(500).json({ error: 'Failed to save health record' });
  }
});

// ── Production ───────────────────────────────────────────────────────────────
router.get('/:id/production', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const own = await query('SELECT id FROM animals WHERE id=$1 AND user_id=$2', [id, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Animal not found' });
    const { rows } = await query('SELECT * FROM animal_production WHERE animal_id=$1 ORDER BY event_date DESC', [id]);
    res.json(rows);
  } catch (err) {
    console.error('GET production error:', err.message);
    res.status(500).json({ error: 'Failed to load production records' });
  }
});

router.post('/:id/production', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const own = await query('SELECT id FROM animals WHERE id=$1 AND user_id=$2', [id, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Animal not found' });

    const b = req.body;
    if (!PROD_TYPES.includes(b.event_type)) return res.status(400).json({ error: 'Pick breeding, calving, preg check or weaning' });
    const pDate = dateOrNull(b.event_date) === null ? today() : dateOrNull(b.event_date);
    if (pDate === undefined) return res.status(400).json({ error: 'Event date must be valid' });
    let ce = b.calving_ease === '' || b.calving_ease === undefined || b.calving_ease === null ? null : intOrNull(b.calving_ease);
    if (ce !== null && (ce < 1 || ce > 5)) return res.status(400).json({ error: 'Calving ease score is 1 to 5' });
    if (b.event_type !== 'calving') ce = null;
    const { rows } = await query(
      `INSERT INTO animal_production (animal_id, event_type, event_date, bull_id, bull_name, calving_ease, calf_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, b.event_type, pDate, intOrNull(b.bull_id),
       san(b.bull_name,100), ce, intOrNull(b.calf_id), san(b.notes,1000)]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST production error:', err.message);
    res.status(500).json({ error: 'Failed to save production record' });
  }
});

// ── Remove a single record (a mistyped weight or the wrong withdrawal days) ──
const RECORD_TABLES = { weights: 'animal_weights', health: 'animal_health', production: 'animal_production' };
router.delete('/:id/:kind(weights|health|production)/:recordId', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id), recordId = parseInt(req.params.recordId);
    if (!id || !recordId) return res.status(400).json({ error: 'Invalid id' });
    if (!(await ownsAnimal(id, req.user.id))) return res.status(404).json({ error: 'Animal not found' });
    const { rowCount } = await query(`DELETE FROM ${RECORD_TABLES[req.params.kind]} WHERE id=$1 AND animal_id=$2`, [recordId, id]);
    if (!rowCount) return res.status(404).json({ error: 'Record not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE record error:', err.message);
    res.status(500).json({ error: 'Failed to remove the record' });
  }
});

module.exports = router;
module.exports._test = { cleanAnimal, dateOrNull };
