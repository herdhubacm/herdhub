/**
 * ╔══════════════════════════════════════════════════════╗
 * ║   HERD HUB – American Cattle Market  v2.1           ║
 * ║   PostgreSQL + Cloud Storage (S3 / R2 / local)      ║
 * ╚══════════════════════════════════════════════════════╝
 */
require('dotenv').config();

const express   = require('express');
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

// ── Cloudflare Turnstile verification ─────────────────
async function verifyTurnstile(token) {
  if (!process.env.TURNSTILE_SECRET_KEY) return true; // skip if not configured
  if (!token) return false;
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.TURNSTILE_SECRET_KEY, response: token })
    });
    const data = await resp.json();
    return data.success === true;
  } catch(e) {
    console.warn('Turnstile verify error:', e.message);
    return true; // fail open — don't block legit users if Cloudflare is down
  }
}

const { testConnection: testDb } = require('./db/database');
const { testConnection: testStorage } = require('./services/storage');

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
                       "https://www.google-analytics.com"],
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
      imgSrc:         ["'self'", "data:", "https:", "blob:"],
      connectSrc:     ["'self'",
                       "https://api.stripe.com",
                       "https://*.amazonaws.com",
                       "https://*.r2.cloudflarestorage.com",
                       "https://*.myshopify.com",
                       "https://*.shopify.com",
                       "https://sdks.shopifycdn.com",
                       "https://cdn.shopify.com",
                       "https://monorail-edge.shopifysvc.com",
                       "https://stats.g.doubleclick.net"],
      frameSrc:       ["https://js.stripe.com",
                       "https://*.myshopify.com",
                       "https://*.shopify.com",
                       "https://checkout.shopify.com",
                       "https://button.app.shopify.com"],
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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-ID'],
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
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes before trying again.' },
  keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
});

// ── Body parsing ──────────────────────────────────────
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));
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

// Export verifyTurnstile for use in auth route
app.locals.verifyTurnstile = verifyTurnstile;

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
app.get('/admin', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);
app.get('/admin/*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);

// ── SPA fallback ──────────────────────────────────────
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
  } catch (err) {
    console.error('❌  Startup failed:', err.message);
    process.exit(1);
  }
}

start();
