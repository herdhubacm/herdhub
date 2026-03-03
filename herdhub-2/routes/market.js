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

const router   = express.Router();
const BASE_URL = process.env.USDA_AMS_BASE_URL || 'https://marsapi.ams.usda.gov/services/v1.2';
const CACHE_TTL = parseInt(process.env.MARKET_CACHE_TTL) || 900; // seconds

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
  const url = `${BASE_URL}/reports/${reportId}?allSections=true&_limit=50`;
  const resp = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'HerdHub/1.0 (cattle-marketplace; contact@herdhub.com)'
    },
    timeout: 12000
  });
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

module.exports = router;
