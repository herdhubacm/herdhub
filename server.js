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
const rateLimit = require('express-rate-limit');

const { testConnection: testDb } = require('./db/database');
const { testConnection: testStorage } = require('./services/storage');

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust Railway/Render/Heroku proxy — required for rate limiting + correct IPs
app.set('trust proxy', 1);

// ── Security ──────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://js.stripe.com", "https://fonts.googleapis.com"],
      scriptSrcAttr:  ["'unsafe-inline'"],  // allows onclick in older helmet versions
      styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:        ["'self'", "https://fonts.gstatic.com"],
      imgSrc:         ["'self'", "data:", "https:", "blob:"],
      connectSrc:     ["'self'", "https://api.stripe.com", "https://*.amazonaws.com", "https://*.r2.cloudflarestorage.com"],
      frameSrc:       ["https://js.stripe.com"],
    }
  }
}));

app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));

// ── Rate limiting ─────────────────────────────────────
const limiter = (max) => rateLimit({
  windowMs: 15 * 60 * 1000, max,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// ── Body parsing ──────────────────────────────────────
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── Static files (local uploads fallback) ─────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// ── API Routes ────────────────────────────────────────
app.use('/api/auth',     limiter(30),  require('./routes/auth'));
app.use('/api/admin',    limiter(100), require('./routes/admin'));
app.use('/api/listings', limiter(200), require('./routes/listings'));
app.use('/api/market',   limiter(60),  require('./routes/market'));
app.use('/api/forum',    limiter(100), require('./routes/forum'));
app.use('/api/payments', limiter(50),  require('./routes/payments'));

// ── Health check ──────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  let dbOk = false;
  try { const { pool } = require('./db/database'); await pool.query('SELECT 1'); dbOk = true; } catch {}
  const { getStorageInfo } = require('./services/storage');
  const storageInfo = getStorageInfo();
  res.status(dbOk ? 200 : 503).json({
    status:  dbOk ? 'ok' : 'degraded',
    version: '2.1.0',
    db:      dbOk ? 'postgres connected' : 'postgres unreachable',
    storage: { provider: storageInfo.provider, configured: storageInfo.configured },
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
  } catch (err) {
    console.error('❌  Startup failed:', err.message);
    process.exit(1);
  }
}

start();
