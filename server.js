/**
 * ╔══════════════════════════════════════════════════════╗
 * ║   HERD HUB – American Cattle Market  v2.1           ║
 * ║   PostgreSQL + Cloud Storage (S3 / R2 / local)      ║
 * ╚══════════════════════════════════════════════════════╝
 */
require('dotenv').config();

const express   = require('express');
const cookieParser = require('cookie-parser');
const cors      = require('cors');
const helmet    = require('helmet');
const path      = require('path');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const compression = require('compression');

// ── CSRF token store (in-memory, 1hr TTL) ─────────────
const csrfTokens = new Map();
function generateCsrfToken() {
  const token = crypto.randomBytes(32).toString('hex');
  csrfTokens.set(token, Date.now());
  const cutoff = Date.now() - 3600000;
  for (const [t, ts] of csrfTokens) { if (ts < cutoff) csrfTokens.delete(t); }
  return token;
}
function validateCsrfToken(token) {
  if (!token || !csrfTokens.has(token)) return false;
  const age = Date.now() - csrfTokens.get(token);
  if (age > 3600000) { csrfTokens.delete(token); return false; }
  return true;
}

const { testConnection: testDb, query } = require('./db/database');
const { testConnection: testStorage } = require('./services/storage');

// ── Simple in-memory cache ────────────────────────────
const apiCache = new Map();
function getCached(key) {
  const item = apiCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) { apiCache.delete(key); return null; }
  return item.data;
}
function setCached(key, data, ttlSeconds = 300) {
  apiCache.set(key, { data, expires: Date.now() + ttlSeconds * 1000 });
}
setInterval(() => { const now = Date.now(); for (const [k, v] of apiCache) { if (now > v.expires) apiCache.delete(k); } }, 3600000);
function clearListingCache() {
  apiCache.clear();
  console.log('📦 Listing cache cleared');
}
// Available globally via require from routes
global.apiCache = { getCached, setCached, clearListingCache };

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust Railway/Render/Heroku proxy — required for rate limiting + correct IPs
app.set('trust proxy', 1);

// ── Compression — gzip all text responses ─────────────
app.use(compression({
  level: 6,           // balanced speed vs size (1=fastest, 9=smallest)
  threshold: 1024,    // only compress responses > 1KB (no point for tiny responses)
  filter: (req, res) => {
    // Don't compress already-compressed formats
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// ── Security ──────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", "'unsafe-eval'",
                       "https://js.stripe.com",
                       "https://fonts.googleapis.com",
                       "https://sdks.shopifycdn.com",
                       "https://cdn.shopify.com",
                       "https://*.shopifycdn.com",
                       "https://*.myshopify.com",
                       "https://*.shopify.com",
                       "https://static.cloudflareinsights.com",
                       "https://www.googletagmanager.com",
                       "https://www.google-analytics.com",
                       "https://challenges.cloudflare.com",
                       "https://unpkg.com"],
      scriptSrcAttr:  ["'unsafe-inline'"],
      styleSrc:       ["'self'", "'unsafe-inline'",
                       "https://fonts.googleapis.com",
                       "https://sdks.shopifycdn.com",
                       "https://cdn.shopify.com",
                       "https://*.shopify.com"],
      fontSrc:        ["'self'", "https://fonts.gstatic.com",
                       "https://sdks.shopifycdn.com",
                       "https://cdn.shopify.com",
                       "https://*.shopify.com"],
      imgSrc:         ["'self'", "data:", "https:", "blob:", "https://*.tile.openstreetmap.org"],
      connectSrc:     ["'self'",
                       "https://api.stripe.com",
                       "https://*.amazonaws.com",
                       "https://*.r2.cloudflarestorage.com",
                       "https://*.myshopify.com",
                       "https://*.shopify.com",
                       "https://sdks.shopifycdn.com",
                       "https://cdn.shopify.com",
                       "https://monorail-edge.shopifysvc.com",
                       "https://stats.g.doubleclick.net",
                       "https://nominatim.openstreetmap.org"],
      frameSrc:       ["https://js.stripe.com",
                       "https://*.myshopify.com",
                       "https://*.shopify.com",
                       "https://checkout.shopify.com",
                       "https://button.app.shopify.com",
                       "https://challenges.cloudflare.com"],
      frameAncestors: ["'none'"],
    }
  }
}));

// ── CORS — locked to your domain in production ───────
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? [
      process.env.CORS_ORIGIN || 'https://theherdhub.com',
      'https://www.theherdhub.com',
      'https://theherdhub.com',
    ]
  : ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000'];

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, same-origin, health checks)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // Return null (blocked) instead of throwing — prevents unhandled error crash
    cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-ID', 'X-CSRF-Token'],
}));

// ── Rate limiting ─────────────────────────────────────
const limiter = (max, windowMinutes = 15) => rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  message: { error: 'Too many requests. Please slow down.' },
  // Use real IP behind Railway/Cloudflare proxy
  keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
});

// Strict limiter for sensitive operations
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' },
  keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
});

// ── Body parsing ──────────────────────────────────────
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// ── Global input sanitizer ────────────────────────────
// Strips null bytes and enforces length caps on all API inputs
function sanitizeValue(v, depth) {
  if (depth > 5) return v;
  if (typeof v === 'string') return v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, 50000);
  if (Array.isArray(v)) return v.slice(0, 100).map(i => sanitizeValue(i, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof k === 'string' && k.length < 100) out[k] = sanitizeValue(val, depth + 1);
    }
    return out;
  }
  return v;
}
app.use((req, _res, next) => {
  if (req.body) req.body = sanitizeValue(req.body, 0);
  next();
});
// Sanitize query strings — prevent basic injection via URL params
app.use((req, res, next) => {
  for (const key in req.query) {
    if (typeof req.query[key] === 'string') {
      // Remove null bytes and script tags from query params
      req.query[key] = req.query[key].replace(/\x00/g, '').replace(/<script[^>]*>.*?<\/script>/gi, '');
    }
  }
  next();
});
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── Anti-scraping & security middleware ──────────────
app.use((req, res, next) => {
  // Block obviously malicious/scraping user agents
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const blockedAgents = ['scrapy', 'wget', 'libwww', 'python-requests', 'go-http-client', 'java/', 'curl/'];
  if (blockedAgents.some(b => ua.includes(b)) && !req.path.startsWith('/api/health')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  // Add security headers not covered by helmet
  if (req.path.startsWith('/api')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Prevent caching of sensitive API responses
  if (req.path.startsWith('/api/auth')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});

// ── Static files ──────────────────────────────────────
// HTML — no cache so users always get latest version
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (/\.(css|js|woff2?|ttf|otf)$/.test(filePath)) {
      // Fonts and scripts — cache for 7 days
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    } else if (/\.(jpe?g|png|webp|gif|svg|ico)$/.test(filePath)) {
      // Local images — cache for 30 days
      res.setHeader('Cache-Control', 'public, max-age=2592000');
    }
  }
}));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// ── API Routes ────────────────────────────────────────
app.use('/api/auth',     strictLimiter, require('./routes/auth'));
app.use('/api/admin',    limiter(100), require('./routes/admin'));
app.use('/api/listings', limiter(200), require('./routes/listings'));
app.use('/api/market',   limiter(60),  require('./routes/market'));
app.use('/api/forum',    limiter(100), require('./routes/forum'));
app.use('/api/payments', limiter(50),  require('./routes/payments'));
app.use('/api/beefbox',  limiter(30),  require('./routes/beefbox'));
app.use('/api/reviews',  limiter(60),  require('./routes/reviews'));
app.use('/api/reports',  limiter(30),  require('./routes/reports'));
app.use('/api/searches', limiter(60),  require('./routes/searches'));
app.use('/api/sellers',  limiter(60),  require('./routes/sellers'));
app.use('/api/cattle',   limiter(100), require('./routes/cattle'));
app.use('/api/herd',     limiter(200), require('./routes/herd'));
app.use('/api/finance',  limiter(200), require('./routes/finance'));
app.use('/api/genetics', limiter(100), require('./routes/genetics'));
app.use('/api/ranch',    limiter(100), require('./routes/ranch'));
app.use('/api/sales',    limiter(100), require('./routes/sales'));

// ── GET /api/settings (public — stats bar) ───────────
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await query('SELECT key, value FROM site_settings');
    const s = {};
    rows.forEach(r => { s[r.key] = r.value; });
    res.json(s);
  } catch(e) { res.json({}); }
});

// ── GET /api/csrf-token ───────────────────────────────
// Frontend fetches this on page load — attached to state-changing requests
app.get('/api/csrf-token', (req, res) => {
  const token = generateCsrfToken();
  res.json({ token });
});

// ── CSRF middleware for state-changing API routes ─────
app.use('/api/auth/register', (req, res, next) => {
  if (req.method === 'POST') {
    const token = req.headers['x-csrf-token'] || req.body?.csrf_token;
    if (process.env.NODE_ENV === 'production' && !validateCsrfToken(token)) {
      return res.status(403).json({ error: 'Invalid or missing CSRF token. Please refresh and try again.' });
    }
  }
  next();
});


// ── Online counter ────────────────────────────────────
let activeVisitors = 0;
const visitorSessions = new Map();
app.post('/api/heartbeat', (req, res) => {
  const sid = req.headers['x-session-id'] || req.ip;
  visitorSessions.set(sid, Date.now());
  // Clean sessions older than 3 minutes
  const cutoff = Date.now() - 3 * 60 * 1000;
  for (const [k, t] of visitorSessions) { if (t < cutoff) visitorSessions.delete(k); }
  activeVisitors = visitorSessions.size;
  res.json({ ok: true });
});
app.get('/api/online', (_req, res) => {
  // Add social-proof base of 800 + real active sessions
  const base = 800;
  const count = base + visitorSessions.size;
  // Round to nearest 10 for natural feel
  const display = Math.round(count / 10) * 10;
  res.json({ online: display });
});

// ── Health check ──────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  let dbOk = false, poolStats = {};
  try {
    const { pool } = require('./db/database');
    await pool.query('SELECT 1');
    dbOk = true;
    poolStats = {
      total:   pool.totalCount,
      idle:    pool.idleCount,
      waiting: pool.waitingCount,
    };
  } catch {}
  const { getStorageInfo } = require('./services/storage');
  const storageInfo = getStorageInfo();
  res.status(dbOk ? 200 : 503).json({
    status:  dbOk ? 'ok' : 'degraded',
    version: '2.3.0',
    db:      dbOk ? 'postgres connected' : 'postgres unreachable',
    pool:    poolStats,
    storage: { provider: storageInfo.provider, configured: storageInfo.configured },
    uptime:  Math.floor(process.uptime()) + 's',
    memory:  Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB used',
    time:    new Date().toISOString(),
    env:     process.env.NODE_ENV || 'development',
  });
});

// ── 404 for unmatched API routes ──────────────────────
app.use('/api/*', (req, res) =>
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` })
);

// ── Admin panel ───────────────────────────────────────
// Admin panel — protected by a secret URL token to prevent discovery
// Set ADMIN_PATH_SECRET in Railway env vars (any random string)
const adminPath = process.env.ADMIN_PATH_SECRET
  ? `/admin-${process.env.ADMIN_PATH_SECRET}`
  : '/admin';

app.get(adminPath, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);
app.get(adminPath + '/*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);
// Old /admin path — return 404 if secret is set (security through obscurity layer)
if (process.env.ADMIN_PATH_SECRET) {
  app.get('/admin', (_req, res) => res.status(404).send('Not found'));
  app.get('/admin/*', (_req, res) => res.status(404).send('Not found'));
} else {
  app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
  app.get('/admin/*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
}

// ── SPA fallback ──────────────────────────────────────
// ── Catalog generator page ────────────────────────────
app.get('/catalog', (_req, res) =>
  res.sendFile(require('path').join(__dirname, 'public', 'catalog.html'))
);

// ── SEO Landing Pages — real URLs Google can index ───
const SEO_PAGES = [
  '/angus-bulls-for-sale',
  '/hereford-bulls-for-sale',
  '/simmental-bulls-for-sale',
  '/charolais-bulls-for-sale',
  '/red-angus-bulls-for-sale',
  '/bred-heifers-for-sale',
  '/angus-heifers-for-sale',
  '/cow-calf-pairs-for-sale',
  '/feeder-cattle-for-sale',
  '/stocker-cattle-for-sale',
  '/angus-cattle-for-sale',
  '/grass-fed-beef-for-sale',
  '/wagyu-beef-for-sale',
  '/farm-fresh-beef',
  '/cattle-trailers-for-sale',
  '/cattle-equipment-for-sale',
  '/working-cattle-dogs-for-sale',
  '/border-collies-for-sale',
  '/show-cattle-for-sale',
  '/dairy-cattle-for-sale',
  '/bottle-calves-for-sale',
  '/hay-for-sale',
];

SEO_PAGES.forEach(path => {
  app.get(path, (_req, res) =>
    res.sendFile(require('path').join(__dirname, 'public', 'index.html'))
  );
});

app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ── Global error handler ──────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: 'File too large' });
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// ── Start ─────────────────────────────────────────────
async function start() {
  try {
    await testDb();
    await testStorage();

    // ── One-time migrations ──────────────────────────────
    try {
      const { query } = require('./db/database');

      // Drop old tier and category CHECK constraints — validated in app routes
      await query(`ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_tier_check`);
      await query(`ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_category_check`);
      console.log('✅  Tier + category constraints removed (validated in app layer)');

      // Ensure articles table exists (added in v3.1)
      await query(`CREATE TABLE IF NOT EXISTS articles (
        id          SERIAL PRIMARY KEY,
        title       TEXT    NOT NULL,
        excerpt     TEXT,
        body        TEXT,
        category    TEXT    NOT NULL DEFAULT 'General',
        image_url   TEXT,
        author      TEXT    NOT NULL DEFAULT 'Herd Hub Staff',
        published   BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      console.log('✅  Articles table ready');

      // Beef Box waitlist table
      await query(`CREATE TABLE IF NOT EXISTS beefbox_waitlist (
        id         BIGSERIAL    PRIMARY KEY,
        name       TEXT         NOT NULL,
        email      TEXT         NOT NULL UNIQUE,
        state      TEXT,
        type       TEXT,
        created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`);
      await query(`ALTER TABLE beefbox_waitlist ADD COLUMN IF NOT EXISTS street VARCHAR(150)`);
      await query(`ALTER TABLE beefbox_waitlist ADD COLUMN IF NOT EXISTS city VARCHAR(100)`);
      await query(`ALTER TABLE beefbox_waitlist ADD COLUMN IF NOT EXISTS zip VARCHAR(20)`);
      console.log('✅  Beef Box waitlist table ready');

      // Ensure updated_at column exists on listings
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

      // Ensure website_url column exists on listings
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS website_url TEXT`);
      console.log('✅  website_url column ready');

      // Reviews table
      await query(`CREATE TABLE IF NOT EXISTS seller_reviews (
        id          BIGSERIAL    PRIMARY KEY,
        seller_id   BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reviewer_id BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        listing_id  BIGINT       REFERENCES listings(id) ON DELETE SET NULL,
        rating      SMALLINT     NOT NULL CHECK (rating BETWEEN 1 AND 5),
        title       TEXT,
        body        TEXT,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE(seller_id, reviewer_id, listing_id)
      )`);

      // Password reset tokens
      await query(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id         BIGSERIAL    PRIMARY KEY,
        user_id    BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      TEXT         NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ  NOT NULL,
        used       BOOLEAN      NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`);

      // Listing reports
      await query(`CREATE TABLE IF NOT EXISTS listing_reports (
        id          BIGSERIAL    PRIMARY KEY,
        listing_id  BIGINT       NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        reporter_id BIGINT       REFERENCES users(id) ON DELETE SET NULL,
        reason      TEXT         NOT NULL,
        details     TEXT,
        status      TEXT         NOT NULL DEFAULT 'open',
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`);
      console.log('✅  Reviews, reset tokens, reports tables ready');

      // Geo columns for map view
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS lat NUMERIC(9,6)`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS lng NUMERIC(9,6)`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ`);

      // Farm to Table columns
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_name VARCHAR(150)`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_proteins TEXT[]`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_product_forms TEXT[]`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_production_methods TEXT[]`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_processing TEXT[]`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_delivery TEXT[]`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_availability VARCHAR(50)`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_harvest_date DATE`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_certifications TEXT[]`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_price_hanging DECIMAL(8,2)`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_price_takehome DECIMAL(8,2)`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_deposit_required BOOLEAN DEFAULT FALSE`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_deposit_amount DECIMAL(8,2)`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_call_for_price BOOLEAN DEFAULT FALSE`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_tours BOOLEAN DEFAULT FALSE`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_operation_size VARCHAR(50)`);
      await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_years INTEGER`);

      // Saved searches table
      await query(`CREATE TABLE IF NOT EXISTS saved_searches (
        id          BIGSERIAL    PRIMARY KEY,
        user_id     BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT         NOT NULL,
        category    TEXT,
        state       TEXT,
        min_price   NUMERIC,
        max_price   NUMERIC,
        min_weight  NUMERIC,
        max_weight  NUMERIC,
        keywords    TEXT,
        last_alerted_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`);
      console.log('✅  Geo columns, sold_at, saved_searches ready');

      // Email drip log table
      await query(`CREATE TABLE IF NOT EXISTS email_drip_log (
        id         BIGSERIAL    PRIMARY KEY,
        user_id    BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        drip_day   INTEGER      NOT NULL,
        sent_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, drip_day)
      )`);
      console.log('✅  Email drip log table ready');

      // Login attempt tracking — migrate old table to new schema
      try {
        await query(`DROP TABLE IF EXISTS login_attempts`);
        await query(`CREATE TABLE login_attempts (
          id           BIGSERIAL    PRIMARY KEY,
          identifier   TEXT         NOT NULL UNIQUE,
          attempts     INTEGER      NOT NULL DEFAULT 0,
          last_attempt TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          locked_until TIMESTAMPTZ
        )`);
      } catch (e) {
        console.warn('login_attempts migration note:', e.message);
      }
      console.log('✅  Login attempts table ready');

      // Site settings table
      await query(`CREATE TABLE IF NOT EXISTS site_settings (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // Seed defaults if empty
      await query(`INSERT INTO site_settings (key, value) VALUES
        ('stat_members', '350'),
        ('stat_sales',   '$25K+'),
        ('stat_since',   'Since 2018')
        ON CONFLICT (key) DO NOTHING`);
      console.log('✅  Site settings table ready');

      // Calving records table
      await query(`CREATE TABLE IF NOT EXISTS calving_records (
        id             BIGSERIAL    PRIMARY KEY,
        user_id        BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        cow_name       VARCHAR(100),
        breed          VARCHAR(50),
        breeding_date  DATE         NOT NULL,
        due_date       DATE         NOT NULL,
        gestation_days INTEGER,
        notes          TEXT,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_calving_user ON calving_records(user_id)`);
      console.log('✅  Calving records table ready');

      // Herd manager tables
      await query(`CREATE TABLE IF NOT EXISTS animals (
        id              BIGSERIAL      PRIMARY KEY,
        user_id         BIGINT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tag_id          VARCHAR(50),
        name            VARCHAR(100),
        species         VARCHAR(20)    DEFAULT 'cattle',
        sex             VARCHAR(10),
        breed           VARCHAR(50),
        birth_date      DATE,
        birth_weight    DECIMAL(6,2),
        color           VARCHAR(50),
        sire_id         BIGINT         REFERENCES animals(id) ON DELETE SET NULL,
        dam_id          BIGINT         REFERENCES animals(id) ON DELETE SET NULL,
        sire_name       VARCHAR(100),
        dam_name        VARCHAR(100),
        purchase_date   DATE,
        purchase_price  DECIMAL(10,2),
        status          VARCHAR(20)    DEFAULT 'active',
        notes           TEXT,
        photo_url       TEXT,
        created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_animals_user ON animals(user_id)`);

      await query(`CREATE TABLE IF NOT EXISTS animal_weights (
        id          BIGSERIAL    PRIMARY KEY,
        animal_id   BIGINT       NOT NULL REFERENCES animals(id) ON DELETE CASCADE,
        weight      DECIMAL(6,2) NOT NULL,
        weigh_date  DATE         NOT NULL,
        notes       TEXT,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_weights_animal ON animal_weights(animal_id)`);

      await query(`CREATE TABLE IF NOT EXISTS animal_health (
        id                    BIGSERIAL    PRIMARY KEY,
        animal_id             BIGINT       NOT NULL REFERENCES animals(id) ON DELETE CASCADE,
        event_type            VARCHAR(50),
        event_date            DATE         NOT NULL,
        product               VARCHAR(100),
        dosage                VARCHAR(50),
        withdrawal_days       INTEGER,
        withdrawal_clear_date DATE,
        administered_by       VARCHAR(100),
        cost                  DECIMAL(8,2),
        notes                 TEXT,
        created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_health_animal ON animal_health(animal_id)`);

      await query(`CREATE TABLE IF NOT EXISTS animal_production (
        id            BIGSERIAL    PRIMARY KEY,
        animal_id     BIGINT       NOT NULL REFERENCES animals(id) ON DELETE CASCADE,
        event_type    VARCHAR(30),
        event_date    DATE         NOT NULL,
        bull_id       BIGINT       REFERENCES animals(id) ON DELETE SET NULL,
        bull_name     VARCHAR(100),
        calving_ease  INTEGER,
        calf_id       BIGINT       REFERENCES animals(id) ON DELETE SET NULL,
        notes         TEXT,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_production_animal ON animal_production(animal_id)`);
      console.log('✅  Herd manager tables ready');

      // Market price intelligence tables
      await query(`CREATE TABLE IF NOT EXISTS market_prices (
        id          BIGSERIAL      PRIMARY KEY,
        report_date DATE,
        source      VARCHAR(50),
        region      VARCHAR(50),
        category    VARCHAR(50),
        weight_low  INTEGER,
        weight_high INTEGER,
        price_low   DECIMAL(8,2),
        price_high  DECIMAL(8,2),
        price_avg   DECIMAL(8,2),
        head_count  INTEGER,
        created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_market_prices_cat ON market_prices(category, report_date)`);

      await query(`CREATE TABLE IF NOT EXISTS price_alerts (
        id           BIGSERIAL      PRIMARY KEY,
        user_id      BIGINT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category     VARCHAR(50),
        weight_low   INTEGER,
        weight_high  INTEGER,
        target_price DECIMAL(8,2),
        alert_type   VARCHAR(20)    DEFAULT 'above',
        active       BOOLEAN        DEFAULT true,
        created_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_price_alerts_user ON price_alerts(user_id)`);
      console.log('✅  Market price tables ready');

      // Finance tables
      await query(`CREATE TABLE IF NOT EXISTS finance_transactions (
        id              BIGSERIAL      PRIMARY KEY,
        user_id         BIGINT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        transaction_date DATE,
        category        VARCHAR(50),
        type            VARCHAR(10),
        description     VARCHAR(200),
        amount          DECIMAL(10,2),
        head_count      INTEGER,
        price_per_head  DECIMAL(10,2),
        weight_lbs      DECIMAL(8,2),
        price_per_cwt   DECIMAL(8,2),
        animal_id       BIGINT         REFERENCES animals(id) ON DELETE SET NULL,
        tax_year        INTEGER,
        notes           TEXT,
        created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_finance_user_year ON finance_transactions(user_id, tax_year)`);

      await query(`CREATE TABLE IF NOT EXISTS finance_budgets (
        id              BIGSERIAL      PRIMARY KEY,
        user_id         BIGINT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category        VARCHAR(50),
        budgeted_amount DECIMAL(10,2),
        tax_year        INTEGER,
        created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_budgets_user ON finance_budgets(user_id, tax_year)`);
      console.log('✅  Finance tables ready');

      // Genetic pairings
      await query(`CREATE TABLE IF NOT EXISTS genetic_pairings (
        id               BIGSERIAL    PRIMARY KEY,
        user_id          BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bull_name        VARCHAR(100),
        bull_breed       VARCHAR(50),
        bull_epds        JSONB,
        cow_herd_epds    JSONB,
        cow_herd_breed   VARCHAR(50),
        predicted_results JSONB,
        notes            TEXT,
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_pairings_user ON genetic_pairings(user_id)`);
      console.log('✅  Genetic pairings table ready');

      // Ranch profiles
      await query(`CREATE TABLE IF NOT EXISTS ranch_profiles (
        id              BIGSERIAL    PRIMARY KEY,
        user_id         BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        ranch_name      VARCHAR(150),
        tagline         VARCHAR(200),
        story           TEXT,
        founded_year    INTEGER,
        acres           INTEGER,
        location_city   VARCHAR(100),
        location_state  VARCHAR(2),
        phone           VARCHAR(20),
        website         VARCHAR(200),
        facebook        VARCHAR(200),
        instagram       VARCHAR(200),
        specialties     TEXT[],
        breeds          TEXT[],
        logo_url        TEXT,
        banner_url      TEXT,
        is_premium      BOOLEAN      DEFAULT false,
        is_verified     BOOLEAN      DEFAULT false,
        premium_since   TIMESTAMPTZ,
        views           INTEGER      DEFAULT 0,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`);
      console.log('✅  Ranch profiles table ready');

      // Digital sales
      await query(`CREATE TABLE IF NOT EXISTS sales_events (
        id                     BIGSERIAL    PRIMARY KEY,
        user_id                BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title                  VARCHAR(200),
        description            TEXT,
        sale_date              TIMESTAMPTZ,
        registration_deadline  TIMESTAMPTZ,
        location_name          VARCHAR(200),
        location_state         VARCHAR(2),
        sale_type              VARCHAR(30)  DEFAULT 'production',
        status                 VARCHAR(20)  DEFAULT 'draft',
        banner_url             TEXT,
        terms                  TEXT,
        commission_rate        DECIMAL(4,2) DEFAULT 2.00,
        created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`);
      await query(`CREATE TABLE IF NOT EXISTS sale_lots (
        id                BIGSERIAL    PRIMARY KEY,
        sale_id           BIGINT       NOT NULL REFERENCES sales_events(id) ON DELETE CASCADE,
        lot_number        INTEGER,
        title             VARCHAR(200),
        description       TEXT,
        head_count        INTEGER,
        breed             VARCHAR(50),
        sex               VARCHAR(20),
        avg_weight        DECIMAL(6,2),
        avg_age_months    INTEGER,
        reserve_price     DECIMAL(10,2),
        starting_bid      DECIMAL(10,2),
        current_bid       DECIMAL(10,2),
        current_bidder_id BIGINT       REFERENCES users(id),
        bid_count         INTEGER      DEFAULT 0,
        status            VARCHAR(20)  DEFAULT 'pending',
        video_url         TEXT,
        epd_data          JSONB,
        notes             TEXT,
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`);
      await query(`CREATE TABLE IF NOT EXISTS sale_bids (
        id         BIGSERIAL    PRIMARY KEY,
        lot_id     BIGINT       NOT NULL REFERENCES sale_lots(id) ON DELETE CASCADE,
        user_id    BIGINT       REFERENCES users(id),
        bid_amount DECIMAL(10,2),
        bid_time   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        status     VARCHAR(20)  DEFAULT 'active'
      )`);
      await query(`CREATE TABLE IF NOT EXISTS sale_registrations (
        id            BIGSERIAL    PRIMARY KEY,
        sale_id       BIGINT       REFERENCES sales_events(id) ON DELETE CASCADE,
        user_id       BIGINT       REFERENCES users(id) ON DELETE CASCADE,
        approved      BOOLEAN      DEFAULT false,
        registered_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE(sale_id, user_id)
      )`);
      console.log('✅  Digital sales tables ready');

      // Silent auction columns for sale_lots
      await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ`);
      await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS sale_confirmed BOOLEAN DEFAULT false`);
      await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS winner_user_id BIGINT REFERENCES users(id)`);
      await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS winner_notified BOOLEAN DEFAULT false`);
      await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS location_state VARCHAR(2)`);
      await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS photo_urls JSONB`);
      console.log('✅  Silent auction columns ready');

      // Commission columns for sale_lots
      await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS commission_amount DECIMAL(10,2)`);
      await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS commission_paid BOOLEAN DEFAULT false`);
      await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS commission_invoice_url TEXT`);
      await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS final_sale_price DECIMAL(10,2)`);
      console.log('✅  Commission columns ready');

      // Verification requests table
      await query(`CREATE TABLE IF NOT EXISTS verification_requests (
        id              BIGSERIAL    PRIMARY KEY,
        user_id         BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        full_name       VARCHAR(150),
        business_name   VARCHAR(150),
        phone           VARCHAR(20),
        state           VARCHAR(2),
        operation_type  VARCHAR(100),
        head_count      VARCHAR(50),
        reason          TEXT,
        status          VARCHAR(20)  DEFAULT 'pending',
        admin_notes     TEXT,
        reviewed_by     BIGINT       REFERENCES users(id),
        reviewed_at     TIMESTAMPTZ,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`);
      console.log('✅  Verification requests table ready');

      // Performance indexes for homepage queries
      await query(`CREATE INDEX IF NOT EXISTS idx_listings_tier_status ON listings(tier, status)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_listings_cat_tier_status ON listings(category, tier, status)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_listings_status_created ON listings(status, created_at DESC)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_listings_featured_status ON listings(is_featured, status)`);
      console.log('✅  Performance indexes ready');

    } catch (migErr) {
      console.warn('⚠️  Migration warning:', migErr.message);
    }

    // Auto-promote ADMIN_EMAIL to admin role on startup
    if (process.env.ADMIN_EMAIL) {
      try {
        const { query } = require('./db/database');
        const email = process.env.ADMIN_EMAIL.toLowerCase().trim();
        console.log(`🔑  Attempting to promote: ${email}`);
        const check = await query('SELECT id, email, name, role FROM users WHERE LOWER(email)=$1', [email]);
        console.log(`🔑  Found ${check.rows.length} matching user(s)`);
        if (check.rows.length) {
          const { rows } = await query(
            "UPDATE users SET role='admin' WHERE LOWER(email)=$1 RETURNING email, name, role",
            [email]
          );
          console.log(`✅  Promoted ${rows[0].name} (${rows[0].email}) to role: ${rows[0].role}`);
        } else {
          console.warn(`⚠️   No user found with email: ${email}`);
        }
      } catch (e) {
        console.warn('Admin promotion error:', e.message);
      }
    }

    app.listen(PORT, () => {
      console.log(`\n🐄  Herd Hub running → http://localhost:${PORT}`);
      console.log(`☁️   Storage: ${(process.env.STORAGE_PROVIDER || 'local').toUpperCase()}`);
      console.log(`📊  USDA feed: ${process.env.USDA_AMS_BASE_URL || 'https://marsapi.ams.usda.gov/services/v1.2'}`);
      console.log(`🌍  Environment: ${process.env.NODE_ENV || 'development'}\n`);
    });

    // ── Geocoding backfill — fill missing lat/lng on startup ──
    async function geocodeExistingListings() {
      try {
        const { rows } = await pool.query(
          "SELECT id, city, state FROM listings WHERE lat IS NULL AND lng IS NULL AND status = 'active' LIMIT 50"
        );
        if (!rows.length) return;
        console.log(`🌍  Geocoding ${rows.length} listings with missing coordinates...`);
        for (const listing of rows) {
          try {
            const q = encodeURIComponent(`${listing.city}, ${listing.state}, USA`);
            const resp = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
              headers: { 'User-Agent': 'HerdHub/1.0 (ad@theherdhub.com)' }
            });
            const data = await resp.json();
            if (data && data[0]) {
              await pool.query('UPDATE listings SET lat=$1, lng=$2 WHERE id=$3',
                [parseFloat(data[0].lat), parseFloat(data[0].lon), listing.id]);
            }
            await new Promise(r => setTimeout(r, 1100)); // Nominatim rate limit: 1 req/sec
          } catch(e) { console.error(`  Geocode failed for listing ${listing.id}:`, e.message); }
        }
        console.log('✅  Geocoding backfill complete');
      } catch(e) { console.error('Geocoding backfill error:', e.message); }
    }
    setTimeout(geocodeExistingListings, 5000);

    // ── Category validation — check for unknown categories on startup ──
    async function validateCategories() {
      try {
        const { rows } = await pool.query("SELECT DISTINCT category FROM listings WHERE status='active'");
        const valid = new Set(['bulls','bucking_bulls','bred_heifers','bred_cows','open_heifers','open_cows',
          'feeder_stocker','fat_cattle','bottle_calves','cow_calf_pairs','embryos','semen','showstock','dairy',
          'equipment','trailers','chutes_pens','working_dogs','feed_hay','farm_to_table',
          'sale_barns','ranches_farms','breed_associations','livestock_services','feed_stores',
          'insurance_finance','full_herd','beef_cattle']);
        const unknown = rows.map(r => r.category).filter(c => !valid.has(c));
        if (unknown.length) console.warn('⚠️  Unknown listing categories in DB:', unknown.join(', '));
        else console.log('✅  All listing categories valid');
      } catch(e) { /* non-fatal */ }
    }
    setTimeout(validateCategories, 3000);

    // ── Silent auction cron — check for ended auctions every hour ──
    const { endExpiredAuctions } = require('./routes/sales');
    setInterval(endExpiredAuctions, 60 * 60 * 1000); // every hour
    setTimeout(endExpiredAuctions, 30 * 1000); // also run 30s after startup
    console.log('⏰  Silent auction cron scheduled (hourly)');

    // ── Listing expiry cron — runs every 6 hours ──────
    const { sendEmail, listingExpiryEmail } = require('./services/email');
    async function runExpiryCron() {
      try {
        // 1. Expire listings that have passed their expiry date
        const { rows: expired } = await query(
          `UPDATE listings SET status='expired'
           WHERE status='active' AND expires_at IS NOT NULL AND expires_at < NOW()
           RETURNING id, title`
        );
        if (expired.length) console.log(`⏰  Expired ${expired.length} listing(s)`);

        // 2. Send expiry warnings for listings expiring in 3 days
        const { rows: expiringSoon } = await query(
          `SELECT l.id, l.title, l.expires_at, u.name, u.email
           FROM listings l JOIN users u ON u.id = l.user_id
           WHERE l.status='active'
             AND l.expires_at IS NOT NULL
             AND l.expires_at BETWEEN NOW() + INTERVAL '2 days 22 hours'
                                   AND NOW() + INTERVAL '3 days 2 hours'`
        );
        for (const l of expiringSoon) {
          const tmpl = listingExpiryEmail(l.name, l.title, l.expires_at, l.id);
          await sendEmail({ to: l.email, ...tmpl }).catch(() => {});
        }
        if (expiringSoon.length) console.log(`📧  Sent ${expiringSoon.length} expiry warning(s)`);
      } catch(e) {
        console.warn('Expiry cron error:', e.message);
      }
    }
    // Run immediately then every 6 hours
    runExpiryCron();
    setInterval(runExpiryCron, 6 * 60 * 60 * 1000);

    // ── Saved search alert cron — runs every 6 hours ──
    async function runSearchAlertCron() {
      try {
        const { rows: searches } = await query(
          `SELECT s.*, u.email, u.name AS user_name
           FROM saved_searches s
           JOIN users u ON u.id = s.user_id
           WHERE u.email IS NOT NULL`
        );

        for (const s of searches) {
          // Find listings posted since last alert (or last 24h if never alerted)
          const since = s.last_alerted_at || new Date(Date.now() - 86400000);
          const conditions = [`l.status='active'`, `l.created_at > $1`];
          const params = [since];
          let p = 2;
          if (s.category)   { conditions.push(`l.category=$${p}`);        params.push(s.category);  p++; }
          if (s.state)      { conditions.push(`l.state=$${p}`);           params.push(s.state);     p++; }
          if (s.min_price)  { conditions.push(`l.price>=$${p}`);          params.push(+s.min_price);p++; }
          if (s.max_price)  { conditions.push(`l.price<=$${p}`);          params.push(+s.max_price);p++; }
          if (s.min_weight) { conditions.push(`l.weight_lbs>=$${p}`);     params.push(+s.min_weight);p++; }
          if (s.max_weight) { conditions.push(`l.weight_lbs<=$${p}`);     params.push(+s.max_weight);p++; }
          if (s.keywords)   {
            conditions.push(`l.search_vector @@ plainto_tsquery('english',$${p})`);
            params.push(s.keywords); p++;
          }

          const { rows: matches } = await query(
            `SELECT l.id, l.title, l.category, l.city, l.state, l.price, l.price_type
             FROM listings l WHERE ${conditions.join(' AND ')}
             ORDER BY l.created_at DESC LIMIT 5`,
            params
          );

          if (!matches.length) continue;

          // Send email
          const listingRows = matches.map(l => {
            const price = l.price ? `$${Number(l.price).toLocaleString()}` : 'Call';
            return `<tr><td style="padding:10px 0;border-bottom:1px solid #e8dcc8">
              <a href="https://theherdhub.com" style="color:#8b3214;font-weight:600;text-decoration:none">${l.title}</a>
              <div style="font-size:12px;color:#888;margin-top:2px">${l.city||''}, ${l.state} · ${price}</div>
            </td></tr>`;
          }).join('');

          const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Georgia,serif;background:#f5efe0;margin:0;padding:20px">
            <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:6px;overflow:hidden">
              <div style="background:#2c1a0e;padding:24px 32px;text-align:center">
                <h1 style="font-family:Georgia,serif;color:#f5efe0;font-size:24px;margin:0">Herd <span style="color:#c9a96e">Hub</span></h1>
              </div>
              <div style="padding:32px">
                <p style="color:#333;line-height:1.7">Hey ${s.user_name},</p>
                <p style="color:#333;line-height:1.7">${matches.length} new listing${matches.length>1?'s':''} match your saved search <strong>"${s.name}"</strong>:</p>
                <table style="width:100%;border-collapse:collapse">${listingRows}</table>
                <div style="margin-top:20px;text-align:center">
                  <a href="https://theherdhub.com" style="display:inline-block;background:#8b3214;color:#fff;padding:12px 28px;border-radius:4px;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:700">View All Listings →</a>
                </div>
              </div>
              <div style="background:#f9f4ec;padding:16px 32px;text-align:center;font-size:12px;color:#888">
                <a href="https://theherdhub.com" style="color:#8b3214">Manage saved searches</a> · Herd Hub American Cattle Marketplace
              </div>
            </div>
          </body></html>`;

          await sendEmail({
            to: s.email,
            subject: `${matches.length} new listing${matches.length>1?'s':''} match "${s.name}"`,
            html,
            text: `${matches.length} new listings match your saved search "${s.name}". View at https://theherdhub.com`
          }).catch(() => {});

          // Update last_alerted_at
          await query(
            'UPDATE saved_searches SET last_alerted_at=NOW() WHERE id=$1',
            [s.id]
          );
        }
        if (searches.length) console.log(`🔔  Saved search alerts checked (${searches.length} searches)`);
      } catch(e) {
        console.warn('Search alert cron error:', e.message);
      }
    }
    // Run every 6 hours (offset by 1 hour from expiry cron)
    setTimeout(() => {
      runSearchAlertCron();
      setInterval(runSearchAlertCron, 6 * 60 * 60 * 1000);
    }, 3600000);

    // ── Email drip cron — runs every 12 hours ─────────
    async function runDripCron() {
      try {
        const { sendEmail } = require('./services/email');

        // Day 3 — "Have you posted your first listing?"
        const { rows: day3 } = await query(`
          SELECT u.id, u.name, u.email, u.state
          FROM users u
          WHERE u.created_at BETWEEN NOW() - INTERVAL '3 days 12 hours'
                                  AND NOW() - INTERVAL '2 days 12 hours'
            AND u.newsletter_opt_in = TRUE
            AND NOT EXISTS (SELECT 1 FROM email_drip_log d WHERE d.user_id=u.id AND d.drip_day=3)
            AND NOT EXISTS (SELECT 1 FROM listings l WHERE l.user_id=u.id)
        `);

        for (const u of day3) {
          const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
            <body style="font-family:Georgia,serif;background:#f5efe0;margin:0;padding:20px">
            <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:6px;overflow:hidden">
              <div style="background:#2c1a0e;padding:24px 32px;text-align:center">
                <h1 style="font-family:Georgia,serif;color:#f5efe0;font-size:24px;margin:0">Herd <span style="color:#c9a96e">Hub</span></h1>
              </div>
              <div style="padding:32px">
                <p style="color:#333;line-height:1.7">Hey ${u.name},</p>
                <p style="color:#333;line-height:1.7">You joined Herd Hub a few days ago — have you had a chance to post your first listing yet?</p>
                <p style="color:#333;line-height:1.7">It only takes 2 minutes. Add a photo, a description, and a price — and your listing goes live in front of buyers across all 50 states.</p>
                <div style="text-align:center;margin:24px 0">
                  <a href="https://theherdhub.com" style="display:inline-block;background:#8b3214;color:#fff;padding:14px 32px;border-radius:4px;text-decoration:none;font-family:Arial,sans-serif;font-size:15px;font-weight:700">Post My First Listing →</a>
                </div>
                <p style="color:#888;font-size:13px;line-height:1.7">Listings are free to post. Upgrade anytime for featured placement.</p>
              </div>
              <div style="background:#f9f4ec;padding:16px 32px;text-align:center;font-size:12px;color:#888">
                <a href="https://theherdhub.com" style="color:#8b3214">theherdhub.com</a>
              </div>
            </div></body></html>`;

          await sendEmail({
            to: u.email,
            subject: `${u.name}, ready to post your first listing?`,
            html,
            text: `Hey ${u.name}, you joined Herd Hub a few days ago. Post your first listing at https://theherdhub.com — it takes 2 minutes.`
          }).catch(() => {});

          await query(
            'INSERT INTO email_drip_log (user_id, drip_day) VALUES ($1, 3) ON CONFLICT DO NOTHING',
            [u.id]
          );
        }
        if (day3.length) console.log(`💧 Drip Day 3: sent to ${day3.length} user(s)`);

        // Day 7 — "Here's what's new in your state"
        const { rows: day7 } = await query(`
          SELECT u.id, u.name, u.email, u.state
          FROM users u
          WHERE u.created_at BETWEEN NOW() - INTERVAL '7 days 12 hours'
                                  AND NOW() - INTERVAL '6 days 12 hours'
            AND u.newsletter_opt_in = TRUE
            AND u.state IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM email_drip_log d WHERE d.user_id=u.id AND d.drip_day=7)
        `);

        for (const u of day7) {
          // Find recent listings in their state
          const { rows: stateListings } = await query(
            `SELECT l.id, l.title, l.category, l.city, l.price, l.price_type
             FROM listings l
             WHERE l.state=$1 AND l.status='active'
               AND l.created_at > NOW() - INTERVAL '7 days'
             ORDER BY l.created_at DESC LIMIT 5`,
            [u.state]
          );

          const listingRows = stateListings.length
            ? stateListings.map(l => {
                const price = l.price ? `$${Number(l.price).toLocaleString()}` : 'Call';
                return `<tr><td style="padding:10px 0;border-bottom:1px solid #e8dcc8">
                  <div style="font-weight:600;color:#2c1a0e">${l.title}</div>
                  <div style="font-size:12px;color:#888;margin-top:2px">${l.city} · ${price}</div>
                </td></tr>`;
              }).join('')
            : `<tr><td style="padding:16px 0;color:#888;font-size:13px">No new listings in ${u.state} this week yet — check back soon.</td></tr>`;

          const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
            <body style="font-family:Georgia,serif;background:#f5efe0;margin:0;padding:20px">
            <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:6px;overflow:hidden">
              <div style="background:#2c1a0e;padding:24px 32px;text-align:center">
                <h1 style="font-family:Georgia,serif;color:#f5efe0;font-size:24px;margin:0">Herd <span style="color:#c9a96e">Hub</span></h1>
              </div>
              <div style="padding:32px">
                <p style="color:#333;line-height:1.7">Hey ${u.name},</p>
                <p style="color:#333;line-height:1.7">Here's what's been listed in <strong>${u.state}</strong> this week:</p>
                <table style="width:100%;border-collapse:collapse">${listingRows}</table>
                <div style="text-align:center;margin:24px 0">
                  <a href="https://theherdhub.com" style="display:inline-block;background:#8b3214;color:#fff;padding:14px 32px;border-radius:4px;text-decoration:none;font-family:Arial,sans-serif;font-size:15px;font-weight:700">Browse All Listings →</a>
                </div>
              </div>
              <div style="background:#f9f4ec;padding:16px 32px;text-align:center;font-size:12px;color:#888">
                <a href="https://theherdhub.com" style="color:#8b3214">theherdhub.com</a>
              </div>
            </div></body></html>`;

          await sendEmail({
            to: u.email,
            subject: `New listings in ${u.state} this week — Herd Hub`,
            html,
            text: `Hey ${u.name}, see what's been listed in ${u.state} this week at https://theherdhub.com`
          }).catch(() => {});

          await query(
            'INSERT INTO email_drip_log (user_id, drip_day) VALUES ($1, 7) ON CONFLICT DO NOTHING',
            [u.id]
          );
        }
        if (day7.length) console.log(`💧 Drip Day 7: sent to ${day7.length} user(s)`);

      } catch(e) {
        console.warn('Drip cron error:', e.message);
      }
    }
    // Run every 12 hours
    setTimeout(() => {
      runDripCron();
      setInterval(runDripCron, 12 * 60 * 60 * 1000);
    }, 7200000);
  } catch (err) {
    console.error('❌  Startup failed:', err.message);
    process.exit(1);
  }
}

start();
