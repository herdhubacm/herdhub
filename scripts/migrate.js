/**
 * Herd Hub – run pending database migrations and exit.
 * Same runner the server uses at startup (db/migrate.js).
 *
 * Usage: node scripts/migrate.js
 */
require('dotenv').config();
const { pool, testConnection } = require('../db/database');
const { runMigrations } = require('../db/migrate');

(async () => {
  console.log('\n🔧  Herd Hub migrations\n');
  try {
    await testConnection();
    const { applied, failed } = await runMigrations();
    console.log(`\nApplied: ${applied.length ? applied.join(', ') : 'none'}`);
    if (failed.length) { console.error(`Failed: ${failed.map(f => f.name).join(', ')}`); process.exitCode = 1; }
  } catch (err) {
    console.error('❌  Migration run failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
