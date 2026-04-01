/**
 * HERD HUB – USDA AMS Market Data Service
 * ─────────────────────────────────────────
 * Pulls live cattle prices from the USDA AMS MARS public API.
 * Cached in PostgreSQL (JSONB) for MARKET_CACHE_TTL seconds (default 15 min).
 *
 * USDA MARS API: https://marsapi.ams.usda.gov
 * No API key required.
 *
 * Reports:
 *   LM_CT155  – 5-Area Weekly Weighted Average Fed Cattle (Negotiated)
 *   LM_CT150  – National Weekly Feeder & Stocker Cattle Summary
 *   LM_XB459  – National Daily Boxed Beef Cutout
 *   LM_CT166  – Monthly Cattle on Feed
 */
const express = require('express');
const fetch   = require('node-fetch');
const { query } = require('../db/database');
const { authenticateToken } = require('../middleware/auth');

const router   = express.Router();
const BASE_URL = process.env.USDA_AMS_BASE_URL || 'https://marsapi.ams.usda.gov/services/v1.2';
const CACHE_TTL = parseInt(process.env.MARKET_CACHE_TTL) || 900; // seconds

// ── USDA 403 backoff — stop hammering when blocked ────
let usdaBackoffUntil = 0;
const USDA_BACKOFF_MS = 30 * 60 * 1000; // 30 min backoff after a 403

const REPORTS = {
  fed_cattle:     { id: 'LM_CT155', name: '5-Area Weekly Fed Cattle (Negotiated)' },
  feeder_stocker: { id: 'LM_CT150', name: 'National Weekly Feeder & Stocker Cattle' },
  boxed_beef:     { id: 'LM_XB459', name: 'National Daily Boxed Beef Cutout' },
  cattle_on_feed: { id: 'LM_CT166', name: 'Monthly Cattle on Feed' },
};

// ── Cache helpers (PostgreSQL JSONB) ──────────────────
async function getCached(reportId) {
  try {
    const { rows } = await query(
      `SELECT data, fetched_at,
              EXTRACT(EPOCH FROM (NOW() - fetched_at)) AS age_seconds
       FROM market_cache WHERE report_id = $1`,
      [reportId]
    );
    if (!rows.length) return null;
    if (parseFloat(rows[0].age_seconds) > CACHE_TTL) return null;
    return rows[0].data; // already parsed — PostgreSQL returns JSONB as JS object
  } catch { return null; }
}

async function getStaleCached(reportId) {
  try {
    const { rows } = await query('SELECT data FROM market_cache WHERE report_id=$1', [reportId]);
    return rows.length ? rows[0].data : null;
  } catch { return null; }
}

async function setCache(reportId, data) {
  try {
    await query(
      `INSERT INTO market_cache (report_id, data, fetched_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (report_id) DO UPDATE
         SET data=$2, fetched_at=NOW()`,
      [reportId, JSON.stringify(data)]
    );
  } catch (err) {
    console.warn('Cache write failed:', err.message);
  }
}

// ── USDA fetch + parse ─────────────────────────────────
async function fetchUSDA(reportId) {
  // If USDA blocked us recently, don't retry until backoff expires
  if (Date.now() < usdaBackoffUntil) {
    throw new Error('USDA temporarily unavailable (rate limited)');
  }
  const url = `${BASE_URL}/reports/${reportId}?allSections=true&_limit=50`;
  const resp = await fetch(url, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (compatible; HerdHub/1.0; +https://theherdhub.com)',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
    timeout: 15000
  });
  if (resp.status === 403 || resp.status === 429) {
    usdaBackoffUntil = Date.now() + USDA_BACKOFF_MS;
    console.warn(`USDA blocked (${resp.status}) — backing off for 30 minutes`);
    throw new Error(`USDA ${resp.status}: ${resp.statusText}`);
  }
  if (!resp.ok) throw new Error(`USDA ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

function parseMarsPrices(rawData) {
  try {
    const sections = Array.isArray(rawData) ? rawData : (rawData.results || rawData.report || []);
    const prices = [];
    sections.forEach(section => {
      const rows = Array.isArray(section) ? section : (section.data || []);
      rows.forEach(row => {
        const price = parseFloat(row.avg_price || row.AvgPrice || row.price || row.wtd_avg || 0);
        if (price > 0) {
          prices.push({
            commodity:    row.commodity    || row.Commodity || row.label || '',
            grade:        row.grade        || row.Grade     || row.class || '',
            weight_range: row.weight_range || row.WeightRange || row.weight || '',
            avg_price:    price,
            unit:         row.unit || row.Unit || 'cwt',
            location:     row.location    || row.market    || '',
            report_date:  row.report_date || row.ReportDate || row.date || '',
          });
        }
      });
    });
    return prices;
  } catch (e) {
    console.warn('Price parse warning:', e.message);
    return [];
  }
}

// ── GET /api/market/prices ─────────────────────────────
router.get('/prices', async (req, res) => {
  const cached = await getCached('unified_prices');
  if (cached) return res.json({ ...cached, cached: true });

  const results = {};
  const errors  = {};

  await Promise.allSettled(
    Object.entries(REPORTS).map(async ([key, report]) => {
      try {
        const reportCached = await getCached(report.id);
        if (reportCached) { results[key] = reportCached; return; }

        const raw    = await fetchUSDA(report.id);
        const prices = parseMarsPrices(raw);
        const payload = {
          report_id:   report.id,
          report_name: report.name,
          prices,
          fetched_at:  new Date().toISOString()
        };
        await setCache(report.id, payload);
        results[key] = payload;
      } catch (err) {
        console.error(`USDA fetch error [${report.id}]:`, err.message);
        errors[key]    = err.message;
        const stale    = await getStaleCached(report.id);
        if (stale) results[key] = { ...stale, stale: true };
      }
    })
  );

  const ticker   = buildTicker(results);
  const response = { reports: results, ticker, errors, fetched_at: new Date().toISOString(), cached: false };
  await setCache('unified_prices', response);
  res.json(response);
});

// ── GET /api/market/ticker ─────────────────────────────
router.get('/ticker', async (req, res) => {
  const cached = await getCached('unified_prices');
  if (cached?.ticker) return res.json({ ticker: cached.ticker, cached: true });

  const stale = await getStaleCached('unified_prices');
  if (stale?.ticker) return res.json({ ticker: stale.ticker, stale: true });

  res.json({ ticker: getDefaultTicker(), reference_only: true });
});

// ── GET /api/market/report/:id ─────────────────────────
router.get('/report/:id', async (req, res) => {
  const reportId = req.params.id.toUpperCase();
  const cached   = await getCached(reportId);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const raw    = await fetchUSDA(reportId);
    const prices = parseMarsPrices(raw);
    const payload = { report_id: reportId, prices, raw, fetched_at: new Date().toISOString() };
    await setCache(reportId, payload);
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error('Report fetch error:', err.message);
    const stale = await getStaleCached(reportId);
    if (stale) return res.json({ ...stale, stale: true, error: err.message });
    res.status(502).json({ error: `USDA API error: ${err.message}` });
  }
});

// ── GET /api/market/reports ────────────────────────────
router.get('/reports', (_req, res) =>
  res.json(Object.entries(REPORTS).map(([key, r]) => ({ key, ...r })))
);

// ── GET /api/market/cache-status ──────────────────────
router.get('/cache-status', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT report_id, fetched_at,
              ROUND(EXTRACT(EPOCH FROM (NOW()-fetched_at))/60, 1) as age_minutes,
              EXTRACT(EPOCH FROM (NOW()-fetched_at)) < $1 as is_fresh
       FROM market_cache ORDER BY fetched_at DESC`,
      [CACHE_TTL]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/market/cache ───────────────────────────
router.delete('/cache', async (_req, res) => {
  try {
    await query('DELETE FROM market_cache');
    res.json({ message: 'Market cache cleared — next request fetches fresh USDA data' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ────────────────────────────────────────────
function buildTicker(results) {
  const items = [];
  const fed = results.fed_cattle?.prices?.find(p => p.commodity?.toLowerCase().includes('steer') && p.avg_price > 100);
  if (fed) items.push(`Fed Steers (Live): $${fed.avg_price.toFixed(2)}/cwt`);

  (results.feeder_stocker?.prices || []).filter(p => p.avg_price > 100).slice(0, 3).forEach(p => {
    const label = [p.commodity, p.weight_range].filter(Boolean).join(' ');
    if (label) items.push(`${label}: $${p.avg_price.toFixed(2)}/cwt`);
  });

  const choice = results.boxed_beef?.prices?.find(p => p.commodity?.toLowerCase().includes('choice'));
  if (choice) items.push(`Choice Boxed Beef: $${choice.avg_price.toFixed(2)}/cwt`);

  return items.length >= 2 ? items : getDefaultTicker();
}

function getDefaultTicker() {
  return [
    'Fed Cattle (5-Area Live): $198.50/cwt',
    'Feeder Steers 600-700 lbs: $274.00/cwt',
    'Feeder Steers 700-800 lbs: $261.50/cwt',
    'Choice Boxed Beef: $317.50/cwt',
    'Select Boxed Beef: $296.75/cwt',
    'Cull Cows Utility: $118.00/cwt',
    'Source: USDA AMS Market News (connecting…)'
  ];
}

// ── GET /api/market/prices/history ─────────────────────
router.get('/prices/history', async (req, res) => {
  try {
    const { category, weight_low, weight_high, days = 90 } = req.query;
    const conditions = ['report_date >= CURRENT_DATE - $1::integer'];
    const params = [Math.min(parseInt(days) || 90, 365)];
    let p = 2;
    if (category) { conditions.push('category=$' + p); params.push(category); p++; }
    if (weight_low) { conditions.push('weight_low>=$' + p); params.push(parseInt(weight_low)); p++; }
    if (weight_high) { conditions.push('weight_high<=$' + p); params.push(parseInt(weight_high)); p++; }

    const { rows } = await query(
      `SELECT report_date, category, weight_low, weight_high,
              price_low, price_high, price_avg, head_count
       FROM market_prices WHERE ${conditions.join(' AND ')}
       ORDER BY report_date ASC`, params);
    res.json(rows);
  } catch (err) {
    console.error('Price history error:', err.message);
    res.status(500).json({ error: 'Failed to load price history' });
  }
});

// ── GET /api/market/calculator ────────────────────────
router.get('/calculator', (req, res) => {
  const purchasePrice = parseFloat(req.query.purchase_price) || 0;
  const purchaseWeight = parseFloat(req.query.purchase_weight) || 0;
  const dailyCost = parseFloat(req.query.daily_cost) || 0;
  const daysOnFeed = parseInt(req.query.days_on_feed) || 0;
  const targetWeight = parseFloat(req.query.target_weight) || 0;

  const totalPurchase = purchasePrice;
  const feedCost = dailyCost * daysOnFeed;
  const totalCost = totalPurchase + feedCost;
  const sellWeight = targetWeight > 0 ? targetWeight : purchaseWeight;
  const breakEvenCwt = sellWeight > 0 ? (totalCost / sellWeight) * 100 : 0;

  res.json({
    total_purchase: totalPurchase,
    feed_cost: feedCost,
    total_cost: totalCost,
    sell_weight: sellWeight,
    break_even_cwt: Math.round(breakEvenCwt * 100) / 100,
  });
});

// ── GET /api/market/nearby ────────────────────────────
router.get('/nearby', async (req, res) => {
  const { state } = req.query;
  const regionMap = {
    TX:'South Central',OK:'South Central',NM:'South Central',AR:'South Central',LA:'South Central',
    KS:'Central',NE:'Central',CO:'Central',IA:'Central',MO:'Central',SD:'Central',ND:'Central',MN:'Central',WI:'Central',IL:'Central',IN:'Central',OH:'Central',MI:'Central',
    MT:'Northwest',WY:'Northwest',ID:'Northwest',OR:'Northwest',WA:'Northwest',UT:'Northwest',NV:'Northwest',
    CA:'West',AZ:'West',HI:'West',
    FL:'Southeast',GA:'Southeast',AL:'Southeast',MS:'Southeast',SC:'Southeast',NC:'Southeast',TN:'Southeast',KY:'Southeast',VA:'Southeast',WV:'Southeast',
    PA:'Northeast',NY:'Northeast',NJ:'Northeast',CT:'Northeast',MA:'Northeast',ME:'Northeast',NH:'Northeast',VT:'Northeast',RI:'Northeast',DE:'Northeast',MD:'Northeast'
  };
  const region = regionMap[(state||'').toUpperCase()] || 'Central';
  try {
    const { rows } = await query(
      `SELECT * FROM market_prices WHERE region=$1
       ORDER BY report_date DESC LIMIT 20`, [region]);
    res.json({ region, prices: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load nearby prices' });
  }
});

// ── POST /api/market/alerts ───────────────────────────
router.post('/alerts', authenticateToken, async (req, res) => {
  try {
    const { category, weight_low, weight_high, target_price, alert_type } = req.body;
    if (!target_price) return res.status(400).json({ error: 'target_price required' });
    const { rows } = await query(
      `INSERT INTO price_alerts (user_id, category, weight_low, weight_high, target_price, alert_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, category || null, parseInt(weight_low)||null, parseInt(weight_high)||null,
       parseFloat(target_price), alert_type || 'above']);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST alerts error:', err.message);
    res.status(500).json({ error: 'Failed to save alert' });
  }
});

// ── GET /api/market/alerts ────────────────────────────
router.get('/alerts', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM price_alerts WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load alerts' });
  }
});

// ── DELETE /api/market/alerts/:id ─────────────────────
router.delete('/alerts/:id', authenticateToken, async (req, res) => {
  try {
    const { rowCount } = await query(
      'DELETE FROM price_alerts WHERE id=$1 AND user_id=$2',
      [parseInt(req.params.id), req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Alert not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete alert' });
  }
});

module.exports = router;
