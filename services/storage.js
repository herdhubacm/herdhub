/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  HERD HUB – Cloud Storage Service                          ║
 * ║                                                              ║
 * ║  Supports three backends — auto-detected from .env:         ║
 * ║    1. Cloudflare R2  (STORAGE_PROVIDER=r2)                  ║
 * ║    2. AWS S3          (STORAGE_PROVIDER=s3)                  ║
 * ║    3. Local disk      (STORAGE_PROVIDER=local  ← default)   ║
 * ║                                                              ║
 * ║  R2 and S3 use the same @aws-sdk/client-s3 — R2 just        ║
 * ║  points at Cloudflare's S3-compatible endpoint.             ║
 * ║                                                              ║
 * ║  Public API (used by routes/listings.js):                   ║
 * ║    uploadFile(buffer, originalName, mimeType, folder)        ║
 * ║      → { url, key, provider, size, width, height }          ║
 * ║    deleteFile(key)                                           ║
 * ║      → { deleted: true }                                     ║
 * ║    getPresignedUploadUrl(key, mimeType, maxBytes)            ║
 * ║      → { url, fields?, key, expires_in }                    ║
 * ║    getStorageInfo()                                          ║
 * ║      → { provider, bucket, configured, publicUrl }          ║
 * ╚══════════════════════════════════════════════════════════════╝
 */
require('dotenv').config();

const path  = require('path');
const fs    = require('fs');
const crypto = require('crypto');

// ── AWS SDK v3 (shared by S3 + R2) ──────────────────────────────
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// ── Sharp for image optimisation ─────────────────────────────────
let sharp;
try {
  sharp = require('sharp');
} catch {
  console.warn('⚠️  sharp not installed — images will be stored as-is (no optimisation)');
}

// ════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════
const PROVIDER     = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
const MAX_BYTES    = (parseInt(process.env.MAX_UPLOAD_MB) || 10) * 1024 * 1024;
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const LOCAL_DIR    = process.env.UPLOAD_DIR || './public/uploads';

// Image optimisation defaults
const OPT = {
  maxWidth:  parseInt(process.env.IMG_MAX_WIDTH  || '1920'),
  maxHeight: parseInt(process.env.IMG_MAX_HEIGHT || '1440'),
  quality:   parseInt(process.env.IMG_QUALITY    || '82'),
  thumbW:    parseInt(process.env.THUMB_WIDTH    || '640'),
  thumbH:    parseInt(process.env.THUMB_HEIGHT   || '480'),
  thumbQ:    parseInt(process.env.THUMB_QUALITY  || '70'),
};

// ════════════════════════════════════════════════════════════════
// S3 CLIENT  (used for both AWS S3 and Cloudflare R2)
// ════════════════════════════════════════════════════════════════
function buildS3Client() {
  if (PROVIDER === 'r2') {
    const accountId = process.env.R2_ACCOUNT_ID;
    if (!accountId) throw new Error('R2_ACCOUNT_ID is required for Cloudflare R2');
    return new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
      forcePathStyle: false,
    });
  }

  if (PROVIDER === 's3') {
    return new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }

  return null; // local provider — no client needed
}

let s3;
let BUCKET;
let PUBLIC_BASE_URL;

if (PROVIDER !== 'local') {
  try {
    s3     = buildS3Client();
    BUCKET = process.env.S3_BUCKET || process.env.R2_BUCKET;
    if (!BUCKET) throw new Error(`${PROVIDER === 'r2' ? 'R2_BUCKET' : 'S3_BUCKET'} env var is required`);

    // Public URL base for serving files
    PUBLIC_BASE_URL =
      process.env.STORAGE_PUBLIC_URL ||          // custom CDN / R2 custom domain
      (PROVIDER === 's3'
        ? `https://${BUCKET}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com`
        : null);

    if (!PUBLIC_BASE_URL) {
      throw new Error(
        'STORAGE_PUBLIC_URL is required.\n' +
        '  For R2: set a custom domain in Cloudflare R2 dashboard → Bucket → Custom Domain\n' +
        '  For S3: set to https://your-bucket.s3.us-east-1.amazonaws.com  OR use a CloudFront URL'
      );
    }
    console.log(`☁️   Storage: ${PROVIDER.toUpperCase()} | bucket=${BUCKET} | url=${PUBLIC_BASE_URL}`);
  } catch (err) {
    console.error(`❌  Storage init error (${PROVIDER}):`, err.message);
    console.warn('⚠️   Falling back to local disk storage');
    s3 = null;
  }
} else {
  // Ensure local upload dir exists
  if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });
  PUBLIC_BASE_URL = '/uploads';
  console.log(`💾  Storage: LOCAL | dir=${LOCAL_DIR}`);
}

// Effective provider (may have fallen back to local)
const effectiveProvider = s3 ? PROVIDER : 'local';

// ════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════

/** Generate a unique storage key like  listings/2026/03/abc123.webp */
function generateKey(originalName, folder = 'listings') {
  const now  = new Date();
  const yy   = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const uid  = crypto.randomBytes(12).toString('hex');
  const ext  = path.extname(originalName).toLowerCase() || '.jpg';
  return `${folder}/${yy}/${mm}/${uid}${ext}`;
}

/** Validate mime type */
function validateMime(mimeType) {
  if (!ALLOWED_MIME.includes(mimeType)) {
    throw Object.assign(
      new Error(`Invalid file type: ${mimeType}. Allowed: ${ALLOWED_MIME.join(', ')}`),
      { code: 'INVALID_MIME', status: 415 }
    );
  }
}

/** Validate file size */
function validateSize(buffer) {
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(
      new Error(`File too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max: ${MAX_BYTES / 1024 / 1024} MB`),
      { code: 'FILE_TOO_LARGE', status: 413 }
    );
  }
}

/**
 * Optimise an image buffer with sharp.
 * Resizes to fit within maxWidth×maxHeight, converts to webp.
 * Returns { buffer, mimeType, width, height, originalSize, optimisedSize }
 */
async function optimiseImage(buffer, mimeType) {
  if (!sharp) {
    return { buffer, mimeType, width: null, height: null,
             originalSize: buffer.length, optimisedSize: buffer.length };
  }

  const img  = sharp(buffer);
  const meta = await img.metadata();

  const needsResize = meta.width > OPT.maxWidth || meta.height > OPT.maxHeight;

  const optimised = await img
    .rotate()               // auto-rotate from EXIF
    .resize(needsResize ? { width: OPT.maxWidth, height: OPT.maxHeight, fit: 'inside', withoutEnlargement: true } : undefined)
    .webp({ quality: OPT.quality })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer:        optimised.data,
    mimeType:      'image/webp',
    width:         optimised.info.width,
    height:        optimised.info.height,
    originalSize:  buffer.length,
    optimisedSize: optimised.data.length,
  };
}

/**
 * Generate a thumbnail buffer.
 * Returns Buffer or null if sharp unavailable.
 */
async function generateThumbnail(buffer) {
  if (!sharp) return null;
  return sharp(buffer)
    .rotate()
    .resize({ width: OPT.thumbW, height: OPT.thumbH, fit: 'cover' })
    .webp({ quality: OPT.thumbQ })
    .toBuffer();
}

// ════════════════════════════════════════════════════════════════
// UPLOAD
// ════════════════════════════════════════════════════════════════

/**
 * Upload a file buffer to the configured provider.
 *
 * @param {Buffer}  buffer        Raw file bytes (from multer memoryStorage)
 * @param {string}  originalName  Original filename (for extension)
 * @param {string}  mimeType      MIME type (e.g. 'image/jpeg')
 * @param {string}  [folder]      Destination folder prefix (default: 'listings')
 * @param {object}  [opts]
 * @param {boolean} [opts.generateThumb=true]  Also upload a thumbnail
 * @param {boolean} [opts.optimise=true]       Run sharp optimisation
 *
 * @returns {Promise<{
 *   url:          string,   // full public URL of the main image
 *   key:          string,   // storage key (used for deletion)
 *   thumbUrl:     string|null,
 *   thumbKey:     string|null,
 *   provider:     string,
 *   size:         number,   // bytes stored (after optimisation)
 *   originalSize: number,
 *   width:        number|null,
 *   height:       number|null,
 *   mimeType:     string,
 * }>}
 */
async function uploadFile(buffer, originalName, mimeType, folder = 'listings', opts = {}) {
  const { generateThumb = true, optimise = true } = opts;

  validateMime(mimeType);
  validateSize(buffer);

  // ── Optimise ─────────────────────────────────────────
  let uploadBuffer = buffer;
  let uploadMime   = mimeType;
  let width        = null;
  let height       = null;
  let originalSize = buffer.length;
  let optimisedSize = buffer.length;

  if (optimise) {
    const result = await optimiseImage(buffer, mimeType);
    uploadBuffer  = result.buffer;
    uploadMime    = result.mimeType;
    width         = result.width;
    height        = result.height;
    originalSize  = result.originalSize;
    optimisedSize = result.optimisedSize;
  }

  // Key always uses .webp when optimised, otherwise original ext
  const ext = optimise ? '.webp' : path.extname(originalName) || '.jpg';
  const key = generateKey(originalName.replace(/\.[^.]+$/, '') + ext, folder);

  // ── Thumbnail ─────────────────────────────────────────
  let thumbUrl = null;
  let thumbKey = null;
  if (generateThumb) {
    const thumbBuf = await generateThumbnail(uploadBuffer);
    if (thumbBuf) {
      thumbKey = key.replace(/(\.[^.]+)$/, '_thumb$1').replace(folder + '/', folder + '/thumbs/');
      thumbUrl = await _putObject(thumbKey, thumbBuf, 'image/webp');
    }
  }

  // ── Main upload ───────────────────────────────────────
  const url = await _putObject(key, uploadBuffer, uploadMime);

  const savings = originalSize > 0
    ? Math.round((1 - optimisedSize / originalSize) * 100)
    : 0;

  if (process.env.NODE_ENV !== 'production') {
    console.log(`📸  Uploaded ${key} | ${(optimisedSize/1024).toFixed(0)}KB${savings > 0 ? ` (${savings}% smaller)` : ''} | ${effectiveProvider}`);
  }

  return {
    url, key, thumbUrl, thumbKey,
    provider:     effectiveProvider,
    size:         optimisedSize,
    originalSize,
    width, height,
    mimeType:     uploadMime,
  };
}

/** Internal — puts a buffer to S3/R2/local, returns public URL */
async function _putObject(key, buffer, mimeType) {
  if (effectiveProvider === 'local') {
    const localPath = path.join(LOCAL_DIR, key.replace(/\//g, '_'));
    fs.writeFileSync(localPath, buffer);
    return `${PUBLIC_BASE_URL}/${path.basename(localPath)}`;
  }

  const putParams = {
    Bucket:        BUCKET,
    Key:           key,
    Body:          buffer,
    ContentType:   mimeType,
    ContentLength: buffer.length,
    CacheControl:  'public, max-age=31536000, immutable',
    Metadata:      { 'uploaded-by': 'herdhub' },
  };
  // No ACL — public access handled by bucket policy
  await s3.send(new PutObjectCommand(putParams));

  return `${PUBLIC_BASE_URL}/${key}`;
}

// ════════════════════════════════════════════════════════════════
// DELETE
// ════════════════════════════════════════════════════════════════

/**
 * Delete a file (and its thumbnail if it exists) from storage.
 *
 * @param {string} key  The storage key returned from uploadFile()
 */
async function deleteFile(key) {
  if (!key) return { deleted: false, reason: 'No key provided' };

  if (effectiveProvider === 'local') {
    const localPath = path.join(LOCAL_DIR, key.replace(/\//g, '_'));
    try { fs.unlinkSync(localPath); } catch {}
    // Also try thumb
    const thumbPath = localPath.replace(/(\.[^.]+)$/, '_thumb$1');
    try { fs.unlinkSync(thumbPath); } catch {}
    return { deleted: true, provider: 'local' };
  }

  // Delete main + thumbnail in parallel (ignore thumb NotFound errors)
  const thumbKey = key.replace(/(\.[^.]+)$/, '_thumb$1').replace(
    key.split('/')[0] + '/',
    key.split('/')[0] + '/thumbs/'
  );

  await Promise.allSettled([
    s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })),
    s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: thumbKey })),
  ]);

  console.log(`🗑️   Deleted ${key} from ${effectiveProvider}`);
  return { deleted: true, provider: effectiveProvider, key };
}

// ════════════════════════════════════════════════════════════════
// PRESIGNED URLS  (direct browser → cloud uploads, bypassing server)
// ════════════════════════════════════════════════════════════════

/**
 * Generate a presigned PUT URL so the browser can upload directly
 * to S3/R2 without the file passing through your server.
 *
 * Best for large files and mobile uploads.
 *
 * Flow:
 *   1. Browser calls GET /api/listings/presign?type=image/jpeg&ext=.jpg
 *   2. Server returns { presignedUrl, key, publicUrl }
 *   3. Browser PUTs the file directly to presignedUrl
 *   4. Browser calls POST /api/listings with { uploadedKeys: [key] }
 *
 * @param {string} mimeType   e.g. 'image/jpeg'
 * @param {string} [ext]      File extension, default .jpg
 * @param {string} [folder]   Storage folder prefix
 * @param {number} [expiresIn] Seconds until URL expires (default 300)
 *
 * @returns {Promise<{ presignedUrl, key, publicUrl, expiresIn, provider }>}
 */
async function getPresignedUploadUrl(mimeType, ext = '.jpg', folder = 'listings', expiresIn = 300) {
  validateMime(mimeType);

  if (effectiveProvider === 'local') {
    // No presigned URLs for local — caller should use the regular multipart endpoint
    throw Object.assign(
      new Error('Presigned URLs are not available with local storage. Use the multipart upload endpoint instead.'),
      { code: 'PRESIGN_LOCAL', status: 400 }
    );
  }

  const key = generateKey(`upload${ext}`, folder);
  const command = new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    ContentType: mimeType,
  });

  const presignedUrl = await getSignedUrl(s3, command, { expiresIn });
  const publicUrl    = `${PUBLIC_BASE_URL}/${key}`;

  return { presignedUrl, key, publicUrl, expiresIn, provider: effectiveProvider };
}

// ════════════════════════════════════════════════════════════════
// MULTI-FILE UPLOAD  (used by the listing creation route)
// ════════════════════════════════════════════════════════════════

/**
 * Upload multiple files in parallel, respecting the tier photo limit.
 * Returns array of upload results.
 */
async function uploadMany(files, folder = 'listings', limit = 20) {
  const batch = files.slice(0, limit);
  const results = await Promise.allSettled(
    batch.map(f => uploadFile(f.buffer, f.originalname, f.mimetype, folder))
  );

  const succeeded = [];
  const failed    = [];

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      succeeded.push(r.value);
    } else {
      console.error(`Photo ${i} upload failed:`, r.reason?.message);
      failed.push({ index: i, error: r.reason?.message });
    }
  });

  return { succeeded, failed };
}

// ════════════════════════════════════════════════════════════════
// DIAGNOSTICS
// ════════════════════════════════════════════════════════════════

function getStorageInfo() {
  return {
    provider:   effectiveProvider,
    bucket:     BUCKET     || null,
    publicUrl:  PUBLIC_BASE_URL || null,
    configured: effectiveProvider !== 'local',
    settings: {
      maxUploadMb: MAX_BYTES / 1024 / 1024,
      allowedTypes: ALLOWED_MIME,
      optimisation: {
        enabled:    !!sharp,
        maxWidth:   OPT.maxWidth,
        maxHeight:  OPT.maxHeight,
        quality:    OPT.quality,
        thumbWidth: OPT.thumbW,
        thumbHeight:OPT.thumbH,
      },
    },
  };
}

/**
 * Ping the storage backend to verify credentials and connectivity.
 * Runs at startup when STORAGE_PROVIDER != local.
 */
async function testConnection() {
  if (effectiveProvider === 'local') {
    console.log(`✅  Storage: local disk at ${LOCAL_DIR}`);
    return true;
  }
  try {
    await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1 }));
    console.log(`✅  Storage: ${effectiveProvider.toUpperCase()} connected | bucket=${BUCKET}`);
    return true;
  } catch (err) {
    console.error(`❌  Storage connection failed (${effectiveProvider}):`, err.message);
    return false;
  }
}

module.exports = {
  uploadFile,
  uploadMany,
  deleteFile,
  getPresignedUploadUrl,
  getStorageInfo,
  testConnection,
  // expose for testing
  _generateKey: generateKey,
  _effectiveProvider: () => effectiveProvider,
};
