/**
 * PostgreSQL connection pool for Herd Hub.
 *
 * Supports both DATABASE_URL (Railway / Render / Supabase / Heroku style)
 * and individual PG* env vars for local dev.
 *
 * Usage in any route:
 *   const { pool, query } = require('../db/database');
 *   const { rows } = await query('SELECT * FROM users WHERE id = $1', [userId]);
 */
require('dotenv').config();
const { Pool } = require('pg');

const isProduction = process.env.NODE_ENV === 'production';

// TLS to the database (M20). With PG_CA_CERT set (the provider's CA, PEM,
// newlines may be escaped as \n in a Railway variable) the certificate is
// verified. Without it we connect encrypted but unverified, which is what
// Railway's self-signed Postgres certificate allows today; testConnection()
// logs that once at startup so it isn't forgotten.
const CA_CERT = process.env.PG_CA_CERT ? process.env.PG_CA_CERT.replace(/\\n/g, '\n') : null;
const sslConfig = !isProduction ? false
  : CA_CERT ? { ca: CA_CERT, rejectUnauthorized: true }
  : { rejectUnauthorized: false };

// Build pool config — prefer DATABASE_URL if present
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: sslConfig,
    }
  : {
      host:     process.env.PGHOST     || 'localhost',
      port:     parseInt(process.env.PGPORT || '5432'),
      database: process.env.PGDATABASE || 'herdhub',
      user:     process.env.PGUSER     || 'postgres',
      password: process.env.PGPASSWORD || '',
      ssl:      false,
    };

poolConfig.max             = parseInt(process.env.PG_POOL_MAX          || '10');
poolConfig.idleTimeoutMillis    = parseInt(process.env.PG_IDLE_TIMEOUT_MS   || '30000');
poolConfig.connectionTimeoutMillis = parseInt(process.env.PG_CONNECT_TIMEOUT_MS || '5000');
// M12: a runaway query is cancelled instead of holding a pool slot forever
poolConfig.statement_timeout = parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || '30000');

const pool = new Pool(poolConfig);

// Log pool errors so they don't crash the process silently
pool.on('error', (err) => {
  console.error('❌  PostgreSQL pool error:', err.message);
});

/**
 * Convenience wrapper — drop-in replacement for pool.query().
 * Logs slow queries (>1s) in development.
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== 'production' && duration > 1000) {
      console.warn(`⚠️  Slow query (${duration}ms):`, text.slice(0, 100));
    }
    return result;
  } catch (err) {
    console.error('DB query error:', err.message, '\nSQL:', text.slice(0, 200));
    throw err;
  }
}

/**
 * Test that the pool can reach the database.
 * Called once at startup.
 */
async function testConnection() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT version()');
    console.log('✅  PostgreSQL connected:', rows[0].version.split(' ').slice(0,2).join(' '));
    if (isProduction && !CA_CERT) {
      console.warn('⚠️  Database TLS is encrypted but the certificate is not verified. Set PG_CA_CERT to the provider CA to close this (M20).');
    }
  } finally {
    client.release();
  }
}

module.exports = { pool, query, testConnection };
