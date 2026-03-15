/**
 * Usage: node scripts/make-admin.js your@email.com
 * Promotes a user to admin role
 */
require('dotenv').config();
const { query, pool } = require('../db/database');

async function makeAdmin() {
  const email = process.argv[2];
  if (!email) { console.error('Usage: node scripts/make-admin.js your@email.com'); process.exit(1); }

  try {
    const { rows } = await query(
      "UPDATE users SET role='admin' WHERE email=$1 RETURNING id, email, name, role",
      [email.toLowerCase()]
    );
    if (!rows.length) {
      console.error(`❌ No user found with email: ${email}`);
      process.exit(1);
    }
    console.log(`✅ ${rows[0].name} (${rows[0].email}) is now an admin`);
    pool.end();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

makeAdmin();
