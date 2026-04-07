const express = require('express');
const { query } = require('../db/database');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const router = express.Router();

let sendEmail;
try { sendEmail = require('../services/email').sendEmail; } catch { sendEmail = null; }

function notify(to, subject, html) {
  if (sendEmail) sendEmail({ to, subject, html }).catch(() => {});
}

// ── GET /api/sales/lots/active — all active lots ──────
router.get('/lots/active', async (req, res) => {
  try {
    const { category, state } = req.query;
    const conds = ["sl.status IN ('active','pending')", 'sl.end_date > NOW()'];
    const params = [];
    let p = 1;
    if (category) { conds.push('sl.breed ILIKE $' + p); params.push('%' + category + '%'); p++; }
    if (state) { conds.push('sl.location_state=$' + p); params.push(state); p++; }
    const { rows } = await query(`
      SELECT sl.*, se.title AS sale_title, se.user_id AS seller_id,
        u.name AS seller_name, rp.ranch_name
      FROM sale_lots sl
      JOIN sales_events se ON se.id=sl.sale_id
      JOIN users u ON u.id=se.user_id
      LEFT JOIN ranch_profiles rp ON rp.user_id=se.user_id
      WHERE ${conds.join(' AND ')}
      ORDER BY sl.end_date ASC`, params);
    res.json(rows);
  } catch (err) {
    console.error('GET active lots error:', err.message);
    res.status(500).json({ error: 'Failed to load lots' });
  }
});

// ── GET /api/sales/lots/ending-soon — next 24h ───────
router.get('/lots/ending-soon', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT sl.*, se.title AS sale_title, u.name AS seller_name, rp.ranch_name
      FROM sale_lots sl
      JOIN sales_events se ON se.id=sl.sale_id
      JOIN users u ON u.id=se.user_id
      LEFT JOIN ranch_profiles rp ON rp.user_id=se.user_id
      WHERE sl.status IN ('active','pending') AND sl.end_date > NOW()
        AND sl.end_date <= NOW() + INTERVAL '24 hours'
      ORDER BY sl.end_date ASC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load' });
  }
});

// ── GET /api/sales/lots/ended — recently ended ────────
router.get('/lots/ended', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT sl.*, se.title AS sale_title, u.name AS seller_name, rp.ranch_name
      FROM sale_lots sl
      JOIN sales_events se ON se.id=sl.sale_id
      JOIN users u ON u.id=se.user_id
      LEFT JOIN ranch_profiles rp ON rp.user_id=se.user_id
      WHERE sl.status='ended'
      ORDER BY sl.end_date DESC LIMIT 20`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load' });
  }
});

// ── GET /api/sales/lots/:id — single lot detail ──────
router.get('/lots/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows } = await query(`
      SELECT sl.*, se.title AS sale_title, se.user_id AS seller_id,
        u.name AS seller_name, u.email AS seller_email,
        rp.ranch_name, rp.location_city, rp.location_state AS ranch_state, rp.user_id AS ranch_user_id
      FROM sale_lots sl
      JOIN sales_events se ON se.id=sl.sale_id
      JOIN users u ON u.id=se.user_id
      LEFT JOIN ranch_profiles rp ON rp.user_id=se.user_id
      WHERE sl.id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Lot not found' });
    // Don't expose seller email to public — only return it if lot is ended and user is winner
    const lot = { ...rows[0] };
    delete lot.seller_email;
    // Get bid count and last bid time (no amounts or names — silent auction)
    const bidInfo = await query(
      'SELECT COUNT(*) AS total_bids, MAX(bid_time) AS last_bid FROM sale_bids WHERE lot_id=$1', [id]);
    lot.total_bids = parseInt(bidInfo.rows[0]?.total_bids) || 0;
    lot.last_bid_time = bidInfo.rows[0]?.last_bid || null;
    res.json(lot);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load lot' });
  }
});

// ── POST /api/sales/lots/:id/bid — place a bid ───────
router.post('/lots/:id/bid', authenticateToken, async (req, res) => {
  try {
    const lotId = parseInt(req.params.id);
    const amount = parseFloat(req.body.bid_amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid bid amount' });

    const lot = await query(`
      SELECT sl.*, se.user_id AS seller_id
      FROM sale_lots sl JOIN sales_events se ON se.id=sl.sale_id
      WHERE sl.id=$1`, [lotId]);
    if (!lot.rows.length) return res.status(404).json({ error: 'Lot not found' });
    const l = lot.rows[0];

    // Check auction is still open
    if (l.end_date && new Date(l.end_date) <= new Date()) {
      return res.status(400).json({ error: 'This auction has ended' });
    }
    if (l.status === 'ended' || l.status === 'sold') {
      return res.status(400).json({ error: 'This auction is no longer accepting bids' });
    }

    // Can't bid on own lot
    if (l.seller_id === req.user.id) {
      return res.status(400).json({ error: 'You cannot bid on your own lot' });
    }

    const currentBid = parseFloat(l.current_bid) || parseFloat(l.starting_bid) || 0;
    const minBid = currentBid + 1;
    if (amount < minBid) {
      return res.status(400).json({ error: 'Bid must be at least $' + minBid.toFixed(2) });
    }

    const previousBidderId = l.current_bidder_id;

    // Update lot
    await query(
      `UPDATE sale_lots SET current_bid=$1, current_bidder_id=$2, bid_count=COALESCE(bid_count,0)+1, status='active'
       WHERE id=$3`, [amount, req.user.id, lotId]);

    // Record bid
    await query(
      'INSERT INTO sale_bids (lot_id, user_id, bid_amount) VALUES ($1,$2,$3)',
      [lotId, req.user.id, amount]);

    // Email previous high bidder that they were outbid
    if (previousBidderId && previousBidderId !== req.user.id) {
      const prev = await query('SELECT email, name FROM users WHERE id=$1', [previousBidderId]);
      if (prev.rows.length) {
        notify(prev.rows[0].email,
          'You\'ve been outbid on ' + (l.title || 'Lot #' + l.lot_number),
          `<div style="font-family:sans-serif;max-width:500px;margin:0 auto">
            <h2 style="color:#2C1A0E">You've Been Outbid</h2>
            <p>Someone placed a higher bid on <strong>${l.title || 'Lot #' + l.lot_number}</strong>.</p>
            <p style="font-size:24px;color:#8B3214;font-weight:bold">Current high bid: $${amount.toFixed(2)}</p>
            <p><a href="https://theherdhub.com/digital-sales.html?lot=${lotId}" style="background:#8B3214;color:white;padding:12px 24px;border-radius:4px;text-decoration:none;display:inline-block">Place a New Bid</a></p>
            <p style="color:#666;font-size:12px">— Herd Hub Silent Auctions</p>
          </div>`);
      }
    }

    // Email seller of new high bid
    const seller = await query('SELECT email, name FROM users WHERE id=$1', [l.seller_id]);
    if (seller.rows.length) {
      notify(seller.rows[0].email,
        'New high bid on ' + (l.title || 'Lot #' + l.lot_number),
        `<div style="font-family:sans-serif;max-width:500px;margin:0 auto">
          <h2 style="color:#2C1A0E">New High Bid</h2>
          <p>Your lot <strong>${l.title || 'Lot #' + l.lot_number}</strong> has a new high bid.</p>
          <p style="font-size:24px;color:#2E7D4F;font-weight:bold">$${amount.toFixed(2)}</p>
          <p style="color:#666">Total bids: ${(l.bid_count || 0) + 1}</p>
          <p style="color:#666;font-size:12px">— Herd Hub Silent Auctions</p>
        </div>`);
    }

    res.json({ success: true, new_bid: amount });
  } catch (err) {
    console.error('Bid error:', err.message);
    res.status(500).json({ error: 'Failed to place bid' });
  }
});

// ── POST /api/sales/lots/:id/confirm — seller confirms sale ──
router.post('/lots/:id/confirm', authenticateToken, async (req, res) => {
  try {
    const lotId = parseInt(req.params.id);
    const check = await query(`
      SELECT sl.*, se.user_id AS seller_id
      FROM sale_lots sl JOIN sales_events se ON se.id=sl.sale_id
      WHERE sl.id=$1`, [lotId]);
    if (!check.rows.length) return res.status(404).json({ error: 'Lot not found' });
    const l = check.rows[0];
    if (l.seller_id !== req.user.id) return res.status(403).json({ error: 'Not your lot' });
    if (l.status !== 'ended') return res.status(400).json({ error: 'Auction has not ended yet' });
    if (!l.current_bidder_id) return res.status(400).json({ error: 'No bids received' });

    await query(
      `UPDATE sale_lots SET sale_confirmed=true, winner_user_id=$1, status='sold' WHERE id=$2`,
      [l.current_bidder_id, lotId]);

    // Email winner with seller contact info
    const winner = await query('SELECT email, name FROM users WHERE id=$1', [l.current_bidder_id]);
    const sellerInfo = await query('SELECT email, name, phone FROM users WHERE id=$1', [l.seller_id]);
    if (winner.rows.length && sellerInfo.rows.length) {
      notify(winner.rows[0].email,
        'You won: ' + (l.title || 'Lot #' + l.lot_number),
        `<div style="font-family:sans-serif;max-width:500px;margin:0 auto">
          <h2 style="color:#2E7D4F">Congratulations — You Won!</h2>
          <p>The seller has confirmed your winning bid on <strong>${l.title || 'Lot #' + l.lot_number}</strong>.</p>
          <p style="font-size:24px;color:#2E7D4F;font-weight:bold">Winning bid: $${parseFloat(l.current_bid).toFixed(2)}</p>
          <h3>Seller Contact Info</h3>
          <p><strong>${sellerInfo.rows[0].name}</strong><br>
          Email: ${sellerInfo.rows[0].email}<br>
          ${sellerInfo.rows[0].phone ? 'Phone: ' + sellerInfo.rows[0].phone : ''}</p>
          <p>Please contact the seller directly to arrange payment and delivery.</p>
          <p style="color:#666;font-size:12px">— Herd Hub Silent Auctions</p>
        </div>`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Confirm error:', err.message);
    res.status(500).json({ error: 'Failed to confirm sale' });
  }
});

// ── Cron: end expired auctions (call from setInterval in server.js) ──
async function endExpiredAuctions() {
  try {
    const { rows } = await query(`
      SELECT sl.*, se.user_id AS seller_id
      FROM sale_lots sl JOIN sales_events se ON se.id=sl.sale_id
      WHERE sl.status IN ('active','pending') AND sl.end_date <= NOW()`);

    for (const lot of rows) {
      await query("UPDATE sale_lots SET status='ended' WHERE id=$1", [lot.id]);

      // Email seller
      const seller = await query('SELECT email, name FROM users WHERE id=$1', [lot.seller_id]);
      if (seller.rows.length) {
        const hasBids = lot.current_bid && lot.current_bidder_id;
        const reserveMet = !lot.reserve_price || parseFloat(lot.current_bid) >= parseFloat(lot.reserve_price);
        let winnerInfo = '';
        if (hasBids) {
          const winner = await query('SELECT email, name, phone FROM users WHERE id=$1', [lot.current_bidder_id]);
          if (winner.rows.length) {
            winnerInfo = `<h3>Winning Bidder</h3><p><strong>${winner.rows[0].name}</strong><br>Email: ${winner.rows[0].email}${winner.rows[0].phone ? '<br>Phone: ' + winner.rows[0].phone : ''}</p>`;
            // Email winner
            notify(winner.rows[0].email,
              'Auction ended: ' + (lot.title || 'Lot #' + lot.lot_number),
              `<div style="font-family:sans-serif;max-width:500px;margin:0 auto">
                <h2 style="color:#2C1A0E">Auction Ended — You're the High Bidder!</h2>
                <p>You had the highest bid on <strong>${lot.title || 'Lot #' + lot.lot_number}</strong>.</p>
                <p style="font-size:24px;color:#C9A96E;font-weight:bold">Your bid: $${parseFloat(lot.current_bid).toFixed(2)}</p>
                <p>The seller will review and confirm the sale shortly. You'll receive their contact info once confirmed.</p>
                <p style="color:#666;font-size:12px">— Herd Hub Silent Auctions</p>
              </div>`);
          }
        }
        notify(seller.rows[0].email,
          'Auction ended: ' + (lot.title || 'Lot #' + lot.lot_number),
          `<div style="font-family:sans-serif;max-width:500px;margin:0 auto">
            <h2 style="color:#2C1A0E">Your Auction Has Ended</h2>
            <p><strong>${lot.title || 'Lot #' + lot.lot_number}</strong></p>
            ${hasBids ? `<p style="font-size:24px;color:#2E7D4F;font-weight:bold">Winning bid: $${parseFloat(lot.current_bid).toFixed(2)}</p><p>Total bids: ${lot.bid_count || 0}</p>${!reserveMet ? '<p style="color:#C0392B"><strong>Note: Reserve price was not met.</strong> You may decline this sale.</p>' : ''}${winnerInfo}<p><a href="https://theherdhub.com/digital-sales.html" style="background:#8B3214;color:white;padding:12px 24px;border-radius:4px;text-decoration:none;display:inline-block">Confirm or Decline Sale</a></p>` : '<p style="color:#666">No bids were received on this lot.</p>'}
            <p style="color:#666;font-size:12px">— Herd Hub Silent Auctions</p>
          </div>`);
      }
    }
    if (rows.length) console.log(`✅  Ended ${rows.length} expired auction(s)`);
  } catch (err) {
    console.error('End auctions cron error:', err.message);
  }
}

// ── Existing routes (keep for sale management) ──────

// GET /api/sales — list sales
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT se.*, u.name AS seller_name, rp.ranch_name, rp.logo_url AS ranch_logo,
        (SELECT COUNT(*) FROM sale_lots sl WHERE sl.sale_id=se.id) AS lot_count
      FROM sales_events se
      JOIN users u ON u.id=se.user_id
      LEFT JOIN ranch_profiles rp ON rp.user_id=se.user_id
      WHERE se.status IN ('published','live','completed')
      ORDER BY se.sale_date DESC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load sales' });
  }
});

// GET /api/sales/my/events
router.get('/my/events', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT se.*,
        (SELECT COUNT(*) FROM sale_lots sl WHERE sl.sale_id=se.id) AS lot_count,
        (SELECT COUNT(*) FROM sale_lots sl WHERE sl.sale_id=se.id AND sl.status='active') AS active_lots
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
      SELECT DISTINCT ON (sl.id) sl.id AS lot_id, sl.title, sl.current_bid, sl.current_bidder_id,
        sl.status, sl.end_date, sl.bid_count, sl.sale_confirmed,
        sb.bid_amount AS my_last_bid, sb.bid_time AS my_last_bid_time,
        (sl.current_bidder_id = $1) AS am_winning
      FROM sale_bids sb
      JOIN sale_lots sl ON sl.id=sb.lot_id
      WHERE sb.user_id=$1
      ORDER BY sl.id, sb.bid_time DESC`, [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load bids' });
  }
});

// POST /api/sales — create sale
router.post('/', authenticateToken, async (req, res) => {
  try {
    const b = req.body;
    const { rows } = await query(`
      INSERT INTO sales_events (user_id, title, description, sale_date,
        location_name, location_state, sale_type, status, terms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8) RETURNING *`,
      [req.user.id, (b.title||'').slice(0,200), (b.description||'').slice(0,5000),
       b.sale_date||new Date(), (b.location_name||'').slice(0,200),
       (b.location_state||'').slice(0,2), (b.sale_type||'auction').slice(0,30),
       (b.terms||'').slice(0,5000)]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST sale error:', err.message);
    res.status(500).json({ error: 'Failed to create sale' });
  }
});

// POST /api/sales/:id/lots — add lot to sale
router.post('/:id/lots', authenticateToken, async (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    const own = await query('SELECT id FROM sales_events WHERE id=$1 AND user_id=$2', [saleId, req.user.id]);
    if (!own.rows.length) return res.status(403).json({ error: 'Not your sale' });
    const b = req.body;
    // Calculate end_date from auction_days
    const auctionDays = parseInt(b.auction_days) || 7;
    const endDate = new Date(Date.now() + auctionDays * 86400000);

    const { rows } = await query(`
      INSERT INTO sale_lots (sale_id, lot_number, title, description, head_count, breed, sex,
        avg_weight, avg_age_months, reserve_price, starting_bid, end_date,
        location_state, video_url, epd_data, notes, photo_urls, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'active') RETURNING *`,
      [saleId, parseInt(b.lot_number)||1, (b.title||'').slice(0,200), (b.description||'').slice(0,3000),
       parseInt(b.head_count)||1, (b.breed||'').slice(0,50), (b.sex||'').slice(0,20),
       parseFloat(b.avg_weight)||null, parseInt(b.avg_age_months)||null,
       parseFloat(b.reserve_price)||null, parseFloat(b.starting_bid)||0,
       endDate, (b.location_state||'').slice(0,2),
       (b.video_url||'').slice(0,500), b.epd_data ? JSON.stringify(b.epd_data) : null,
       (b.notes||'').slice(0,1000), b.photo_urls ? JSON.stringify(b.photo_urls) : null]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST lot error:', err.message);
    res.status(500).json({ error: 'Failed to add lot' });
  }
});

module.exports = router;
module.exports.endExpiredAuctions = endExpiredAuctions;
