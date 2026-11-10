/**
 * HERD HUB – USDA AMS Market Data Service
 * ─────────────────────────────────────────
 * Pulls cattle prices from the USDA Livestock Mandatory Reporting (LMR)
 * datamart. No API key. Cached in PostgreSQL (JSONB) for MARKET_CACHE_TTL
 * seconds (default 15 min); the reports themselves are weekly.
 *
 *   https://mpr.datamart.ams.usda.gov/services/v1.1/reports/<slug>/<section>?q=<dateField>=MM/DD/YYYY:MM/DD/YYYY
 *
 * Sources (slug, section, what we take):
 *   2477 LM_CT150  5 Area Weekly Weighted Average Direct Slaughter Cattle, "Detail"
 *                  → fed steers and heifers, live FOB and dressed, "Total all grades"
 *   2488 LM_CT168  National Weekly Direct Cow and Bull Report, Negotiated Price, "Detail"
 *                  → cull cows (breaker, boner, cutter) and slaughter bulls, live and dressed, national
 *   2461 LM_XB459  National Weekly Boxed Beef Cutout, "Weekly Average Cutout Values"
 *                  → Choice and Select cutout, 600-900 lb carcasses
 *
 * Feeder and stocker cattle (auction prices by weight) are NOT in the LMR
 * datamart. They come from USDA Market News, which needs a free API key
 * (USDA_MARS_API_KEY). Until that is wired, the site says so instead of
 * showing a number. Nothing here invents a price.
 */
const express = require('express');
const fetch   = require('node-fetch');
const { query } = require('../db/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router    = express.Router();
const BASE_URL  = process.env.USDA_AMS_BASE_URL || 'https://mpr.datamart.ams.usda.gov/services/v1.1';
const CACHE_TTL = parseInt(process.env.MARKET_CACHE_TTL) || 900; // seconds
const LOOKBACK_DAYS = 28; // enough for two weekly reports even around holidays

// ── USDA 403/429 backoff — stop hammering when blocked ─
let usdaBackoffUntil = 0;
const USDA_BACKOFF_MS = 10 * 60 * 1000;

const SOURCES = {
  fed_cattle: { slug: '2477', section: 'Detail', dateField: 'report_date',
    report: 'LM_CT150', name: '5 Area Weekly Weighted Average Direct Slaughter Cattle' },
  cow_bull:   { slug: '2488', section: 'Detail', dateField: 'report_date_end',
    report: 'LM_CT168', name: 'National Weekly Direct Cow and Bull Report, Negotiated Price' },
  boxed_beef: { slug: '2461', section: 'Weekly Average Cutout Values', dateField: 'report_date',
    report: 'LM_XB459', name: 'National Weekly Boxed Beef Cutout' },
};

// Series the site shows. key → which source, label, how to recognise the row.
const SERIES = {
  fed_steers_live:    { source: 'fed_cattle', label: 'Fed Steers, live',         basis: 'live FOB, 5-area direct',   group: 'fed' },
  fed_heifers_live:   { source: 'fed_cattle', label: 'Fed Heifers, live',        basis: 'live FOB, 5-area direct',   group: 'fed' },
  fed_steers_dressed: { source: 'fed_cattle', label: 'Fed Steers, dressed',      basis: 'dressed delivered, 5-area', group: 'fed' },
  cull_cows_breaker:  { source: 'cow_bull',   label: 'Cull Cows, Breaker 75%',   basis: 'live, packer direct',       group: 'cows' },
  cull_cows_boner:    { source: 'cow_bull',   label: 'Cull Cows, Boner 85%',     basis: 'live, packer direct',       group: 'cows' },
  cull_cows_cutter:   { source: 'cow_bull',   label: 'Cull Cows, Cutter 90%',    basis: 'live, packer direct',       group: 'cows' },
  bulls_live:         { source: 'cow_bull',   label: 'Slaughter Bulls',          basis: 'live, packer direct',       group: 'cows' },
  bulls_dressed:      { source: 'cow_bull',   label: 'Slaughter Bulls, dressed', basis: 'dressed, 600 lb and up',    group: 'cows' },
  boxed_choice:       { source: 'boxed_beef', label: 'Choice Boxed Beef Cutout', basis: '600-900 lb carcasses',      group: 'beef' },
  boxed_select:       { source: 'boxed_beef', label: 'Select Boxed Beef Cutout', basis: '600-900 lb carcasses',      group: 'beef' },
};

// ── Small helpers ──────────────────────────────────────
const num = v => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const isoDate = mdy => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(mdy || '')); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };
const mdyDate = d => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
const upper = v => String(v || '').trim().toUpperCase();

// Turn raw datamart rows into {key, date, avg, low, high, head, weight} points.
function normalizeRows(sourceKey, rows) {
  const out = [];
  const push = (key, r, date, avg, low, high, head, weight) => {
    if (avg === null || !date) return;
    out.push({ key, date, avg, low, high, head, weight });
  };
  for (const r of rows || []) {
    if (sourceKey === 'fed_cattle') {
      if (upper(r.grade_description) !== 'TOTAL ALL GRADES') continue;
      const cls = upper(r.class_description), basis = upper(r.selling_basis_description);
      const date = isoDate(r.report_date);
      const avg = num(r.weighted_avg_price), low = num(r.price_range_low), high = num(r.price_range_high);
      const head = num(r.head_count), weight = num(r.weight_range_avg);
      if (cls === 'STEER'  && basis === 'LIVE FOB')          push('fed_steers_live',    r, date, avg, low, high, head, weight);
      if (cls === 'HEIFER' && basis === 'LIVE FOB')          push('fed_heifers_live',   r, date, avg, low, high, head, weight);
      if (cls === 'STEER'  && basis === 'DRESSED DELIVERED') push('fed_steers_dressed', r, date, avg, low, high, head, weight);
    } else if (sourceKey === 'cow_bull') {
      if (upper(r.region_name) !== 'NATIONAL') continue;
      const basis = upper(r.selling_basis_desc), cls = upper(r.classification_desc), wr = upper(r.weight_range_desc);
      const date = isoDate(r.report_date_end);
      const avg = num(r.wtd_avg_price), low = num(r.price_range_low), high = num(r.price_range_high);
      const head = num(r.head_count), weight = num(r.avg_weight);
      if (basis === 'LIVE - DOMESTIC' && wr === 'ALL WEIGHTS') {
        if (cls.startsWith('BREAKER')) push('cull_cows_breaker', r, date, avg, low, high, head, weight);
        if (cls.startsWith('BONER'))   push('cull_cows_boner',   r, date, avg, low, high, head, weight);
        if (cls.startsWith('CUTTER'))  push('cull_cows_cutter',  r, date, avg, low, high, head, weight);
        if (cls.startsWith('BULL'))    push('bulls_live',        r, date, avg, low, high, head, weight);
      }
      if (basis === 'DRESSED - DOMESTIC' && cls.startsWith('BULL') && wr === '600 LBS AND UP') push('bulls_dressed', r, date, avg, low, high, head, weight);
    } else if (sourceKey === 'boxed_beef') {
      const date = isoDate(r.report_date);
      push('boxed_choice', r, date, num(r.choice_600_900_simple_avg), null, null, null, null);
      push('boxed_select', r, date, num(r.select_600_900_simple_avg), null, null, null, null);
    }
  }
  return out;
}

// Latest point per series plus the one before it (for week-over-week change).
function latestBySeries(points) {
  const byKey = {};
  for (const p of points) (byKey[p.key] = byKey[p.key] || []).push(p);
  const out = {};
  for (const [key, arr] of Object.entries(byKey)) {
    arr.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    // one point per date (datamart can repeat a week when a report is corrected)
    const seen = new Set(); const uniq = arr.filter(p => !seen.has(p.date) && seen.add(p.date));
    const cur = uniq[0], prev = uniq[1] || null;
    out[key] = { ...SERIES[key], key, unit: 'cwt', ...cur, prev_avg: prev ? prev.avg : null, prev_date: prev ? prev.date : null };
  }
  return out;
}

// ── Cache helpers (PostgreSQL JSONB) ──────────────────
async function getCached(id) {
  try {
    const { rows } = await query(
      `SELECT data, EXTRACT(EPOCH FROM (NOW() - fetched_at)) AS age_seconds FROM market_cache WHERE report_id = $1`, [id]);
    if (!rows.length || parseFloat(rows[0].age_seconds) > CACHE_TTL) return null;
    return rows[0].data;
  } catch { return null; }
}
async function getStaleCached(id) {
  try { const { rows } = await query('SELECT data, fetched_at FROM market_cache WHERE report_id=$1', [id]); return rows.length ? { data: rows[0].data, fetched_at: rows[0].fetched_at } : null; }
  catch { return null; }
}
async function setCache(id, data) {
  try {
    await query(`INSERT INTO market_cache (report_id, data, fetched_at) VALUES ($1, $2, NOW())
                 ON CONFLICT (report_id) DO UPDATE SET data=$2, fetched_at=NOW()`, [id, JSON.stringify(data)]);
  } catch (err) { console.warn('Cache write failed:', err.message); }
}

// ── USDA fetch ─────────────────────────────────────────
async function fetchSection(src, fromDate, toDate) {
  if (Date.now() < usdaBackoffUntil) throw new Error('USDA temporarily unavailable (rate limited)');
  const q = `${src.dateField}=${mdyDate(fromDate)}:${mdyDate(toDate)}`;
  const url = `${BASE_URL}/reports/${src.slug}/${encodeURIComponent(src.section)}?q=${encodeURIComponent(q)}`;
  const resp = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'HerdHub/1.0 (https://theherdhub.com)' }, timeout: 20000 });
  if (resp.status === 403 || resp.status === 429) {
    usdaBackoffUntil = Date.now() + USDA_BACKOFF_MS;
    console.warn(`USDA blocked (${resp.status}); backing off 10 minutes`);
    throw new Error(`USDA ${resp.status}: ${resp.statusText}`);
  }
  if (!resp.ok) throw new Error(`USDA ${resp.status}: ${resp.statusText}`);
  const data = await resp.json();
  return Array.isArray(data) ? data : (data.results || []);
}

async function loadPoints(days) {
  const to = new Date(); const from = new Date(to.getTime() - days * 86400000);
  const points = []; const errors = {};
  await Promise.allSettled(Object.entries(SOURCES).map(async ([key, src]) => {
    try { points.push(...normalizeRows(key, await fetchSection(src, from, to))); }
    catch (err) { errors[key] = err.message; console.error(`USDA fetch error [${src.report}]:`, err.message); }
  }));
  return { points, errors };
}

function buildTicker(latest) {
  const items = [];
  const add = (key, label) => { const s = latest[key]; if (s && s.avg) items.push(`${label}: $${s.avg.toFixed(2)}/cwt`); };
  add('fed_steers_live', 'Fed Steers (5-Area Live)');
  add('fed_heifers_live', 'Fed Heifers (5-Area Live)');
  add('cull_cows_boner', 'Cull Cows, Boner (live)');
  add('cull_cows_cutter', 'Cull Cows, Cutter (live)');
  add('bulls_dressed', 'Slaughter Bulls (dressed)');
  add('boxed_choice', 'Choice Boxed Beef');
  add('boxed_select', 'Select Boxed Beef');
  const dates = Object.values(latest).map(s => s.date).filter(Boolean).sort();
  if (items.length && dates.length) {
    const [y, m, d] = dates[dates.length - 1].split('-');
    const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1];
    items.push(`Source: USDA AMS, week ending ${month} ${+d}, ${y}`);
  }
  return items;
}

const UNAVAILABLE = ['USDA market data is unavailable right now. Check back shortly.'];

// ── GET /api/market/prices ─────────────────────────────
router.get('/prices', async (_req, res) => {
  const cached = await getCached('unified_prices');
  if (cached) return res.json({ ...cached, cached: true });

  const { points, errors } = await loadPoints(LOOKBACK_DAYS);
  const latest = latestBySeries(points);
  const series = Object.values(latest);
  if (series.length) {
    const response = { series, ticker: buildTicker(latest), errors, sources: SOURCES, fetched_at: new Date().toISOString(), cached: false, stale: false };
    await setCache('unified_prices', response);
    return res.json(response);
  }
  const stale = await getStaleCached('unified_prices');
  if (stale && stale.data && stale.data.series && stale.data.series.length) {
    return res.json({ ...stale.data, cached: true, stale: true, stale_since: stale.fetched_at, errors });
  }
  res.json({ series: [], ticker: UNAVAILABLE, unavailable: true, errors, sources: SOURCES, fetched_at: new Date().toISOString(), cached: false });
});

// ── GET /api/market/ticker ─────────────────────────────
router.get('/ticker', async (_req, res) => {
  const cached = await getCached('unified_prices');
  if (cached && cached.ticker && cached.ticker.length) return res.json({ ticker: cached.ticker, cached: true, stale: !!cached.stale });
  const stale = await getStaleCached('unified_prices');
  if (stale && stale.data && stale.data.ticker && stale.data.ticker.length && !stale.data.unavailable) return res.json({ ticker: stale.data.ticker, stale: true });
  res.json({ ticker: UNAVAILABLE, unavailable: true });
});

// ── GET /api/market/prices/history?series=<key>&days=90 ─
router.get('/prices/history', async (req, res) => {
  const key = String(req.query.series || '');
  const days = Math.min(Math.max(parseInt(req.query.days) || 90, 14), 365);
  if (!SERIES[key]) return res.status(400).json({ error: 'Unknown series' });
  const id = `hist:${key}:${days}`;
  const cached = await getCached(id);
  if (cached) return res.json({ ...cached, cached: true });
  try {
    const src = SOURCES[SERIES[key].source];
    const to = new Date(); const from = new Date(to.getTime() - days * 86400000);
    const rows = await fetchSection(src, from, to);
    const seen = new Set();
    const points = normalizeRows(SERIES[key].source, rows).filter(p => p.key === key)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .filter(p => !seen.has(p.date) && seen.add(p.date));
    const payload = { series: key, label: SERIES[key].label, basis: SERIES[key].basis, source: src, days, points, fetched_at: new Date().toISOString() };
    await setCache(id, payload);
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error('Price history error:', err.message);
    const stale = await getStaleCached(id);
    if (stale && stale.data) return res.json({ ...stale.data, cached: true, stale: true });
    res.status(502).json({ error: 'USDA history is unavailable right now.' });
  }
});

// ── GET /api/market/report/:id  (raw datamart section, for checking) ──
router.get('/report/:id', async (req, res) => {
  const slug = String(req.params.id).replace(/\D/g, '');
  if (!slug) return res.status(400).json({ error: 'Report id must be a datamart slug number' });
  const src = Object.values(SOURCES).find(s => s.slug === slug);
  if (!src) return res.status(404).json({ error: 'Not a report this site uses' });
  try {
    const to = new Date(); const from = new Date(to.getTime() - LOOKBACK_DAYS * 86400000);
    const rows = await fetchSection(src, from, to);
    res.json({ source: src, rows: rows.length, points: normalizeRows(Object.keys(SOURCES).find(k => SOURCES[k] === src), rows), fetched_at: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ error: 'Live market data is unavailable right now. Please try again shortly.' });
  }
});

// ── GET /api/market/reports ────────────────────────────
router.get('/reports', (_req, res) => res.json({ sources: SOURCES, series: SERIES }));

// ── GET /api/market/cache-status ──────────────────────
router.get('/cache-status', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT report_id, fetched_at, ROUND(EXTRACT(EPOCH FROM (NOW()-fetched_at))/60, 1) as age_minutes,
              EXTRACT(EPOCH FROM (NOW()-fetched_at)) < $1 as is_fresh
       FROM market_cache ORDER BY fetched_at DESC`, [CACHE_TTL]);
    res.json(rows);
  } catch (err) {
    console.error('Market cache status error:', err.message);
    res.status(500).json({ error: 'Could not load market data right now.' });
  }
});

// ── DELETE /api/market/cache ───────────────────────────
router.delete('/cache', authenticateToken, requireAdmin, async (_req, res) => {
  try { await query('DELETE FROM market_cache'); res.json({ message: 'Market cache cleared. The next request fetches fresh USDA data.' }); }
  catch (err) { res.status(500).json({ error: 'Could not clear the cache' }); }
});

// ── GET /api/market/calculator ────────────────────────
// Break-even sell price. Sell weight = target if given, else purchase weight + ADG x days.
router.get('/calculator', (req, res) => {
  const purchasePrice  = parseFloat(req.query.purchase_price) || 0;
  const purchaseWeight = parseFloat(req.query.purchase_weight) || 0;
  const dailyCost      = parseFloat(req.query.daily_cost) || 0;
  const daysOnFeed     = parseInt(req.query.days_on_feed) || 0;
  const adg            = parseFloat(req.query.adg) || 0;
  const targetWeight   = parseFloat(req.query.target_weight) || 0;
  const feedCost   = dailyCost * daysOnFeed;
  const totalCost  = purchasePrice + feedCost;
  const sellWeight = targetWeight > 0 ? targetWeight : purchaseWeight + adg * daysOnFeed;
  const gain       = Math.max(0, sellWeight - purchaseWeight);
  res.json({
    total_purchase: purchasePrice, feed_cost: feedCost, total_cost: totalCost, sell_weight: sellWeight,
    break_even_cwt: sellWeight > 0 ? Math.round((totalCost / sellWeight) * 10000) / 100 : 0,
    cost_of_gain_per_lb: gain > 0 ? Math.round((feedCost / gain) * 100) / 100 : null,
  });
});

// ── POST /api/market/alerts ───────────────────────────
// Alerts are stored. Nothing evaluates them yet, and the page says so.
router.post('/alerts', authenticateToken, async (req, res) => {
  try {
    const { category, weight_low, weight_high, target_price, alert_type } = req.body;
    const price = parseFloat(target_price);
    if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'A target price is required' });
    const { rows } = await query(
      `INSERT INTO price_alerts (user_id, category, weight_low, weight_high, target_price, alert_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, category ? String(category).slice(0, 50) : null, parseInt(weight_low) || null, parseInt(weight_high) || null,
       price, alert_type === 'below' ? 'below' : 'above']);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST alerts error:', err.message);
    res.status(500).json({ error: 'Failed to save alert' });
  }
});

router.get('/alerts', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM price_alerts WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to load alerts' }); }
});

router.delete('/alerts/:id', authenticateToken, async (req, res) => {
  try {
    const { rowCount } = await query('DELETE FROM price_alerts WHERE id=$1 AND user_id=$2', [parseInt(req.params.id), req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Alert not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to delete alert' }); }
});

module.exports = router;
module.exports._test = { normalizeRows, latestBySeries, buildTicker, SERIES, SOURCES, isoDate, num };
