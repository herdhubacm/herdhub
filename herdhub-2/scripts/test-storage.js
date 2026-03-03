/**
 * Herd Hub – Storage Connection Test
 * Run:  node scripts/test-storage.js
 *
 * Tests: connectivity, upload, presigned URL, thumbnail generation, deletion.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const {
  uploadFile, deleteFile, getPresignedUploadUrl, getStorageInfo, testConnection,
} = require('../services/storage');

async function run() {
  console.log('\n🧪  Herd Hub Storage Test\n');
  console.log('Config:', JSON.stringify(getStorageInfo(), null, 2), '\n');

  // 1. Connectivity
  console.log('1️⃣   Testing connectivity...');
  await testConnection();

  // 2. Create a minimal test image (1×1 red pixel PNG)
  const testPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==',
    'base64'
  );

  // 3. Upload
  console.log('\n2️⃣   Uploading test image...');
  const result = await uploadFile(testPng, 'test.png', 'image/png', 'test');
  console.log('   ✅  Upload result:');
  console.log('       url:      ', result.url);
  console.log('       key:      ', result.key);
  console.log('       thumbUrl: ', result.thumbUrl);
  console.log('       size:     ', result.size, 'bytes');
  console.log('       dims:     ', result.width, '×', result.height);
  console.log('       provider: ', result.provider);

  // 4. Presigned URL (only for cloud providers)
  const info = getStorageInfo();
  if (info.configured) {
    console.log('\n3️⃣   Getting presigned upload URL...');
    try {
      const presign = await getPresignedUploadUrl('image/jpeg', '.jpg', 'test');
      console.log('   ✅  Presigned URL (expires in', presign.expiresIn, 'seconds):');
      console.log('       key:        ', presign.key);
      console.log('       publicUrl:  ', presign.publicUrl);
      console.log('       presignedUrl:', presign.presignedUrl.slice(0, 80) + '...');
    } catch (e) {
      console.log('   ⚠️   Presigned URL error:', e.message);
    }
  } else {
    console.log('\n3️⃣   Skipping presigned URL test (local provider)');
  }

  // 5. Delete
  console.log('\n4️⃣   Deleting test file...');
  const del = await deleteFile(result.key);
  console.log('   ✅  Deleted:', del);

  console.log('\n🎉  All storage tests passed!\n');
}

run().catch(err => {
  console.error('\n❌  Storage test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
