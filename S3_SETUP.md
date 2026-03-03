# Herd Hub – Cloud Photo Storage Setup

Full setup instructions for Cloudflare R2 and AWS S3.

---

## Option A: Cloudflare R2  ← Recommended

R2 is S3-compatible and has **zero egress fees** (you pay nothing for bandwidth when
serving images to users). It's significantly cheaper than AWS S3 for a photo-heavy
marketplace like Herd Hub.

**Pricing (as of 2026):**
- Storage: $0.015/GB/month
- PUT/POST operations: $4.50 per million
- GET operations: Free
- Egress: **Free** (huge advantage over S3)
- Free tier: 10 GB storage, 1M Class A ops, 10M Class B ops/month

### Step-by-step

**1. Create a Cloudflare account** at cloudflare.com (free)

**2. Create an R2 bucket**
```
Cloudflare Dashboard → R2 Object Storage → Create Bucket
Bucket name: herdhub-media
Location: Automatic (or closest to your users)
```

**3. Enable a custom domain** (required for public image URLs)
```
R2 → herdhub-media bucket → Settings → Custom Domains → Add Domain
Domain: media.herdhub.com (or images.herdhub.com)
```
This points that subdomain at your bucket and makes objects publicly accessible.
Add the DNS record in Cloudflare if prompted.

**4. Create R2 API credentials**
```
R2 Object Storage → Manage R2 API Tokens → Create API Token
Permissions: Object Read & Write
Specify bucket: herdhub-media
```
Copy the **Access Key ID** and **Secret Access Key** — you only see the secret once.

Also copy your **Account ID** from the R2 overview page (top right).

**5. Configure .env**
```env
STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=abc123def456...           # your Cloudflare Account ID
R2_ACCESS_KEY_ID=your_access_key_id
R2_SECRET_ACCESS_KEY=your_secret_key
R2_BUCKET=herdhub-media
STORAGE_PUBLIC_URL=https://media.herdhub.com   # your custom domain
```

**6. Test**
```bash
npm run storage:test
```

---

## Option B: AWS S3

**Pricing (us-east-1, as of 2026):**
- Storage: $0.023/GB/month
- PUT operations: $0.005 per 1,000
- GET operations: $0.0004 per 1,000
- **Egress: $0.09/GB** (this adds up fast — consider CloudFront)

### Step-by-step

**1. Create an S3 bucket**
```
AWS Console → S3 → Create Bucket
Bucket name: herdhub-media-yourname   (must be globally unique)
Region: us-east-1  (or your closest region)
Block Public Access: UNCHECK "Block all public access" → confirm
```

**2. Add a bucket policy for public read**
```
S3 → herdhub-media-yourname → Permissions → Bucket Policy → Edit
```
Paste this (replace YOUR-BUCKET-NAME):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/*"
    }
  ]
}
```

**3. Configure CORS** (required for presigned uploads from browser)
```
S3 → Bucket → Permissions → Cross-origin resource sharing (CORS) → Edit
```
```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedOrigins": ["https://herdhub.com", "http://localhost:3000"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

**4. Create an IAM user**
```
AWS Console → IAM → Users → Create User
Username: herdhub-s3-user
Attach policies: Select "Create inline policy"
```
Inline policy (replace YOUR-BUCKET-NAME):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME"
    }
  ]
}
```
Then: IAM User → Security Credentials → Create Access Key → Application running outside AWS.
Copy the **Access Key ID** and **Secret Access Key**.

**5. Configure .env**
```env
STORAGE_PROVIDER=s3
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=your_secret
AWS_REGION=us-east-1
S3_BUCKET=herdhub-media-yourname
STORAGE_PUBLIC_URL=https://herdhub-media-yourname.s3.us-east-1.amazonaws.com
```

**6. (Optional but recommended) Add CloudFront**
CloudFront caches images at 400+ edge locations globally, making them load faster
AND cutting your S3 egress costs by ~85%.

```
AWS Console → CloudFront → Create Distribution
Origin: your S3 bucket  (S3 website endpoint, not REST)
Viewer Protocol: Redirect HTTP to HTTPS
Cache Policy: CachingOptimized
```
Then set:
```env
STORAGE_PUBLIC_URL=https://d1abc123example.cloudfront.net
```

**7. Test**
```bash
npm run storage:test
```

---

## Image Optimisation

When photos are uploaded, Herd Hub automatically:

1. **Validates** file type (JPEG, PNG, WEBP, GIF only) and size (default 10 MB max)
2. **Resizes** to fit within 1920×1440px (configurable)
3. **Converts** to WebP format (typically 30-70% smaller than JPEG at equivalent quality)
4. **Generates a thumbnail** at 640×480px for listing cards (much faster load times)
5. **Strips EXIF** data (privacy + size)
6. Uploads main image and thumbnail to cloud **in parallel**

Configure via `.env`:
```env
IMG_MAX_WIDTH=1920      # max width in pixels
IMG_MAX_HEIGHT=1440     # max height in pixels  
IMG_QUALITY=82          # WebP quality 1-100
THUMB_WIDTH=640         # thumbnail width
THUMB_HEIGHT=480        # thumbnail height
THUMB_QUALITY=70        # thumbnail WebP quality
```

---

## Presigned URLs (Direct Browser Upload)

For large files or mobile uploads, you can skip routing the file through your server
entirely. The browser uploads directly to S3/R2:

**Flow:**
```
Browser                   Your Server              S3 / R2
   |                           |                      |
   |-- GET /api/listings/presign?type=image/jpeg ----→|
   |                           |--- getSignedUrl() →  |
   |←---- { presignedUrl, key, publicUrl } -----------|
   |                           |                      |
   |-- PUT presignedUrl (file bytes) ---------------→ |
   |                           |          ← 200 OK --|
   |-- POST /api/listings  { uploadedKey: key } ----→ |
   |                           |--- INSERT DB ------→ |
   |←---- { id: listingId } --------------------------|
```

**Frontend example:**
```javascript
// 1. Get presigned URL
const { presignedUrl, key, publicUrl } = await fetch(
  `/api/listings/presign?type=${file.type}&ext=${ext}`,
  { headers: { Authorization: `Bearer ${token}` } }
).then(r => r.json());

// 2. Upload directly to cloud
await fetch(presignedUrl, {
  method: 'PUT',
  body: file,
  headers: { 'Content-Type': file.type }
});

// 3. Reference by key when creating the listing
// (future enhancement — key-based listing creation route)
```

---

## Monitoring Storage Usage

```bash
# Check current cache/upload status
curl http://localhost:3000/api/listings/storage-info
curl http://localhost:3000/api/health

# Run storage test
npm run storage:test
```

**AWS S3 costs:** Monitor in AWS Cost Explorer → S3 service.
**Cloudflare R2:** Monitor in R2 dashboard → Usage tab.

---

## Migrating Existing Local Photos to Cloud

If you've been running with local storage and want to move files to S3/R2:

```bash
# Switch provider in .env first, then run:
node scripts/migrate-photos-to-cloud.js
```

(This script uploads all existing local files to your bucket and updates
 the database URLs — see scripts/migrate-photos-to-cloud.js for full implementation.)
