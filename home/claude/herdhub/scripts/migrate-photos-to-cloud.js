/**
 * Herd Hub – Migrate Local Photos to Cloud Storage
 *
 * Run this AFTER switching STORAGE_PROVIDER from 'local' to 's3' or 'r2'
 * in your .env. It will:
 *   1. Find all listing_photos with local /uploads/ URLs
 *   2. Read each file from disk
 *   3. Upload to S3/R2
 *   4. Update the database URL
 *
 * Usage:
 *   node scripts/migrate-photos-to-cloud.js [--dry-run]
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool, testConnection } = require('../db/database');
const { uploadFile, getStorageInfo, testConnection: testStorage } = require('../services/storage');

const DRY_RUN = process.argv.includes('--dry-run');
const LOCAL_DIR = process.env.UPLOAD_DIR || './public/uploads';

async function migrate() {
  console.log(`\n${DRY_RUN ? '🔍  DRY RUN — ' : ''}🚚  Migrating local photos to cloud storage\n`);

  await testConnection();
  const info = getStorageInfo();
  if (!info.configured) {
    console.error('❌  STORAGE_PROVIDER is still "local". Set it to "s3" or "r2" in .env first.');
    process.exit(1);
  }
  await testStorage();

  const client = await pool.connect();
  try {
    // Find all photos with local URLs
    const { rows: photos } = await client.query(
      `SELECT id, listing_id, url, sort_order
       FROM listing_photos
       WHERE url LIKE '/uploads/%' OR url LIKE '%/uploads/%'
       ORDER BY listing_id, sort_order`
    );

    console.log(`Found ${photos.length} local photo(s) to migrate\n`);

    let success = 0, skipped = 0, failed = 0;

    for (const photo of photos) {
      // Derive local file path from URL
      const filename  = path.basename(photo.url);
      const localPath = path.join(LOCAL_DIR, filename);

      if (!fs.existsSync(localPath)) {
        console.warn(`  ⚠️  Photo ${photo.id}: file not found at ${localPath} — skipping`);
        skipped++;
        continue;
      }

      try {
        const buffer   = fs.readFileSync(localPath);
        const mimeType = filename.endsWith('.png') ? 'image/png'
          : filename.endsWith('.webp') ? 'image/webp'
          : 'image/jpeg';

        console.log(`  📸  Migrating photo ${photo.id} (listing ${photo.listing_id}) — ${filename}`);

        if (!DRY_RUN) {
          const result = await uploadFile(
            buffer, filename, mimeType, `listings/${photo.listing_id}`
          );
          await client.query(
            `UPDATE listing_photos
             SET url=$1, thumb_url=$2, storage_key=$3, thumb_key=$4,
                 width=$5, height=$6, size_bytes=$7
             WHERE id=$8`,
            [result.url, result.thumbUrl, result.key, result.thumbKey,
             result.width, result.height, result.size, photo.id]
          );
        }

        success++;
        console.log(`    ✅  Done${DRY_RUN ? ' (dry run)' : ''}`);
      } catch (err) {
        failed++;
        console.error(`  ❌  Photo ${photo.id} failed:`, err.message);
      }
    }

    console.log(`\n📊  Migration complete:`);
    console.log(`    Migrated: ${success}`);
    console.log(`    Skipped:  ${skipped} (file not on disk)`);
    console.log(`    Failed:   ${failed}`);

    if (DRY_RUN) {
      console.log('\n💡  This was a dry run. Re-run without --dry-run to apply changes.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
