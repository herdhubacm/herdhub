/**
 * HERD HUB — Migration runner (C6)
 *
 * Migrations live in db/migrations/ as NNNN_name.sql or NNNN_name.js
 * (a .js file exports { up(query) }). Each runs once, in file order,
 * inside its own transaction, and is recorded in schema_migrations.
 * A failure rolls that migration back, is logged loudly, and stops the
 * run (later migrations may depend on it); the server still starts on
 * the schema it already has. An advisory lock keeps two instances from
 * migrating at once.
 */
const fs   = require('fs');
const path = require('path');
const { pool } = require('./database');

const DEFAULT_DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 727272;

async function runMigrations({ dir = DEFAULT_DIR, log = console } = {}) {
  const client = await pool.connect();
  const applied = [], failed = [];
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]); locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    const files = fs.readdirSync(dir).filter(f => /^\d{4}_[\w-]+\.(sql|js)$/.test(f)).sort();

    for (const file of files) {
      const name = file.replace(/\.(sql|js)$/, '');
      if (done.has(name)) continue;
      const q = (text, params) => client.query(text, params);
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL statement_timeout = 0'); // migrations may legitimately run long
        if (file.endsWith('.sql')) await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        else await require(path.join(dir, file)).up(q);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        applied.push(name);
        log.log(`✅  Migration applied: ${name}`);
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* connection may be gone */ }
        failed.push({ name, error: err.message });
        log.error(`❌  Migration failed and rolled back: ${name}: ${err.message}`);
        break;
      }
    }
    if (!applied.length && !failed.length) log.log('✅  Migrations: nothing to apply');
    return { applied, failed };
  } finally {
    if (locked) { try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (e) {} }
    client.release();
  }
}

module.exports = { runMigrations };
