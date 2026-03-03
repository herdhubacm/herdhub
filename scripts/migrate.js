/**
 * Herd Hub – Database Migration
 * Reads schema.sql and applies it to PostgreSQL.
 * Safe to run multiple times (all statements use IF NOT EXISTS / OR REPLACE).
 *
 * Usage: node scripts/migrate.js
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool, testConnection } = require('../db/database');

async function migrate() {
  console.log('\n🔧  Running Herd Hub database migration...\n');

  await testConnection();

  const sql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf-8');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('✅  Schema applied successfully\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌  Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
