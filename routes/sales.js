const express = require('express');
const { query } = require('../db/database');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const router = express.Router();

// GET /api/sales — list sales
router.get('/', async (req, res) => {
  try {
    const { state, status, breed } = req.query;
    const conds = [];
    const params = [];
    let p = 1;
    if (state) { conds.push('se.location_state=$' + p); params.push(state); p++; }
    if (status) { conds.push('se.status=$' + p); params.push(status); p++; }
    else { conds.push("se.status IN ('published','live','completed')"); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { rows } = await query(`
      SELECT se.*, u.name AS seller_name,
        rp.ranch_name, rp.logo_url AS ranch_logo,
        (SELECT COUNT(*) FROM sale_lots sl WHERE sl.sale_id=se.id) AS lot_count
      FROM sales_events se
      JOIN users u ON u.id=se.user_id
      LEFT JOIN ranch_profiles rp ON rp.user_id=se.user_id
      ${where} ORDER BY se.sale_date DESC`, params);
    res.json(rows);
  } catch (err) {
    console.error('GET sales error:', err.message);
    res.status(500).json({ error: 'Failed to load sales' });
  }
});

// GET /api/sales/my/events
router.get('/my/events', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT se.*, (SELECT COUNT(*) FROM sale_lots sl WHERE sl.sale_id=se.id) AS lot_count
       FROM sales_events se WHERE se.user_id=$1 ORDER BY se.created_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load' });
  }
});

// GET /api/sales/my/bids
router.get('/my/bids', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT sb.*, sl.title AS lot_title, sl.lot_number, se.title AS sale_title
      FROM sale_bids sb
      JOIN sale_lots sl ON sl.id=sb.lot_id
      JOIN sales_events se ON se.id=sl.sale_id
      WHERE sb.user_id=$1 ORDER BY sb.bid_time DESC`, [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load bids' });
  }
});

// GET /api/sales/:id
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows } = await query(`
      SELECT se.*, u.name AS seller_name, rp.ranch_name, rp.logo_url AS ranch_logo
      FROM sales_events se
      JOIN users u ON u.id=se.user_id
      LEFT JOIN ranch_profiles rp ON rp.user_id=se.user_id
      WHERE se.id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Sale not found' });
    const lots = await query(
      'SELECT * FROM sale_lots WHERE sale_id=$1 ORDER BY lot_number ASC', [id]);
    res.json({ ...rows[0], lots: lots.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load sale' });
  }
});

// POST /api/sales
router.post('/', authenticateToken, async (req, res) => {
  try {
    const b = req.body;
    const { rows } = await query(`
      INSERT INTO sales_events (user_id, title, description, sale_date, registration_deadline,
        location_name, location_state, sale_type, status, terms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.id, (b.title||'').slice(0,200), (b.description||'').slice(0,5000),
       b.sale_date||null, b.registration_deadline||null,
       (b.location_name||'').slice(0,200), (b.location_state||'').slice(0,2),
       (b.sale_type||'production').slice(0,30), 'draft',
       (b.terms||'').slice(0,5000)]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST sale error:', err.message);
    res.status(500).json({ error: 'Failed to create sale' });
  }
});

// PUT /api/sales/:id
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body;
    const { rows, rowCount } = await query(`
      UPDATE sales_events SET title=$2, description=$3, sale_date=$4, registration_deadline=$5,
        location_name=$6, location_state=$7, sale_type=$8, status=$9, terms=$10
      WHERE id=$1 AND user_id=$11 RETURNING *`,
      [id, (b.title||'').slice(0,200), (b.description||'').slice(0,5000),
       b.sale_date||null, b.registration_deadline||null,
       (b.location_name||'').slice(0,200), (b.location_state||'').slice(0,2),
       (b.sale_type||'production').slice(0,30), (b.status||'draft').slice(0,20),
       (b.terms||'').slice(0,5000), req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

// POST /api/sales/:id/lots
router.post('/:id/lots', authenticateToken, async (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    // Verify ownership
    const own = await query('SELECT id FROM sales_events WHERE id=$1 AND user_id=$2', [saleId, req.user.id]);
    if (!own.rows.length) return res.status(403).json({ error: 'Not your sale' });
    const b = req.body;
    const { rows } = await query(`
      INSERT INTO sale_lots (sale_id, lot_number, title, description, head_count, breed, sex,
        avg_weight, avg_age_months, reserve_price, starting_bid, video_url, epd_data, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [saleId, parseInt(b.lot_number)||1, (b.title||'').slice(0,200), (b.description||'').slice(0,3000),
       parseInt(b.head_count)||1, (b.breed||'').slice(0,50), (b.sex||'').slice(0,20),
       parseFloat(b.avg_weight)||null, parseInt(b.avg_age_months)||null,
       parseFloat(b.reserve_price)||null, parseFloat(b.starting_bid)||null,
       (b.video_url||'').slice(0,500), b.epd_data ? JSON.stringify(b.epd_data) : null,
       (b.notes||'').slice(0,1000)]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST lot error:', err.message);
    res.status(500).json({ error: 'Failed to add lot' });
  }
});

// PUT /api/sales/lots/:id
router.put('/lots/:id', authenticateToken, async (req, res) => {
  try {
    const lotId = parseInt(req.params.id);
    const b = req.body;
    const check = await query(
      `SELECT sl.id FROM sale_lots sl JOIN sales_events se ON se.id=sl.sale_id
       WHERE sl.id=$1 AND se.user_id=$2`, [lotId, req.user.id]);
    if (!check.rows.length) return res.status(403).json({ error: 'Not your lot' });
    const { rows } = await query(`
      UPDATE sale_lots SET title=$2, description=$3, head_count=$4, breed=$5, sex=$6,
        avg_weight=$7, reserve_price=$8, starting_bid=$9, video_url=$10, epd_data=$11, notes=$12
      WHERE id=$1 RETURNING *`,
      [lotId, (b.title||'').slice(0,200), (b.description||'').slice(0,3000),
       parseInt(b.head_count)||1, (b.breed||'').slice(0,50), (b.sex||'').slice(0,20),
       parseFloat(b.avg_weight)||null, parseFloat(b.reserve_price)||null,
       parseFloat(b.starting_bid)||null, (b.video_url||'').slice(0,500),
       b.epd_data ? JSON.stringify(b.epd_data) : null, (b.notes||'').slice(0,1000)]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update lot' });
  }
});

// POST /api/sales/lots/:id/bid
router.post('/lots/:id/bid', authenticateToken, async (req, res) => {
  try {
    const lotId = parseInt(req.params.id);
    const amount = parseFloat(req.body.bid_amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid bid amount' });

    // Check lot exists and get current bid
    const lot = await query('SELECT * FROM sale_lots WHERE id=$1', [lotId]);
    if (!lot.rows.length) return res.status(404).json({ error: 'Lot not found' });
    const l = lot.rows[0];
    if (l.status !== 'pending' && l.status !== 'active') return res.status(400).json({ error: 'Lot not accepting bids' });

    const currentBid = parseFloat(l.current_bid) || parseFloat(l.starting_bid) || 0;
    if (amount <= currentBid) return res.status(400).json({ error: 'Bid must exceed current bid of $' + currentBid.toFixed(2) });

    // Check buyer is registered
    const sale = await query('SELECT sale_id FROM sale_lots WHERE id=$1', [lotId]);
    const reg = await query(
      'SELECT id FROM sale_registrations WHERE sale_id=$1 AND user_id=$2 AND approved=true',
      [sale.rows[0].sale_id, req.user.id]);
    if (!reg.rows.length) return res.status(403).json({ error: 'You must register and be approved to bid' });

    await query(
      `UPDATE sale_lots SET current_bid=$1, current_bidder_id=$2, bid_count=bid_count+1, status='active'
       WHERE id=$3`, [amount, req.user.id, lotId]);
    await query(
      `INSERT INTO sale_bids (lot_id, user_id, bid_amount) VALUES ($1,$2,$3)`,
      [lotId, req.user.id, amount]);
    res.json({ success: true, new_bid: amount });
  } catch (err) {
    console.error('Bid error:', err.message);
    res.status(500).json({ error: 'Failed to place bid' });
  }
});

// POST /api/sales/:id/register
router.post('/:id/register', authenticateToken, async (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    await query(
      `INSERT INTO sale_registrations (sale_id, user_id, approved) VALUES ($1,$2,true)
       ON CONFLICT DO NOTHING`,
      [saleId, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

module.exports = router;
