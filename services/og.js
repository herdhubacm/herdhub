/**
 * HERD HUB — Per-listing share previews (H1)
 *
 * renderListingPage(listing)  -> index.html with <title>, description,
 *                                Open Graph and Twitter tags rewritten
 *                                for one listing, plus a canonical link.
 * listingOgImage(listing)     -> 1200x630 JPEG cut from the first photo
 *                                (crawlers don't all accept WebP), cached.
 *
 * Pure functions over a listing row; the route in server.js does the
 * database work.
 */
const fs   = require('fs');
const path = require('path');

const SITE = 'https://theherdhub.com';
const INDEX_PATH = path.join(__dirname, '..', 'public', 'index.html');

let sharp = null;
try { sharp = require('sharp'); } catch { /* og.jpg falls back to the site image */ }

// index.html is read once per process; a deploy restarts the process
let indexHtml = null;
function loadIndex() {
  if (indexHtml === null) indexHtml = fs.readFileSync(INDEX_PATH, 'utf8');
  return indexHtml;
}

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function fmtCat(cat) {
  return String(cat || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function fmtPrice(price, type) {
  if (type === 'call' || price === null || price === undefined || price === '') return 'Contact for price';
  const n = Number(price);
  if (!Number.isFinite(n)) return 'Contact for price';
  const cents = n % 1 !== 0;
  const dollars = '$' + n.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  switch (type) {
    case 'per_head':   return `${dollars}/head`;
    case 'per_lb':     return `${dollars}/lb`;
    case 'per_cwt':    return `${dollars}/cwt`;
    case 'negotiable': return `${dollars} (negotiable)`;
    case 'obo':        return `${dollars} OBO`;
    default:           return dollars;
  }
}

function excerpt(text, max = 150) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

// What a shared card says. Pure, so it can be unit-tested.
function listingMeta(l) {
  const sold = l.status === 'sold';
  const where = [l.city, l.state].filter(Boolean).join(', ');
  const title = (sold ? 'SOLD: ' : '') + String(l.title || 'Listing').trim();
  const bits = [fmtPrice(l.price, l.price_type), fmtCat(l.category), where].filter(Boolean);
  const description = bits.join(' · ') + (l.description ? '. ' + excerpt(l.description) : '');
  return {
    title,
    pageTitle: `${title} | Herd Hub`,
    description,
    url: `${SITE}/listing/${l.id}`,
    image: l.photo_url ? `${SITE}/listing/${l.id}/og.jpg` : `${SITE}/og-image.jpg`,
    imageAlt: title,
  };
}

// Replacer functions, never replacement strings: a "$2,100" price in a
// string replacement would be read as capture group 2 and corrupt the tag.
function setMeta(html, attr, key, value) {
  const re = new RegExp(`(<meta\\s+${attr}="${key}"\\s+content=")[^"]*(")`);
  return html.replace(re, (_, open, close) => open + esc(value) + close);
}

function renderListingPage(l) {
  const m = listingMeta(l);
  let html = loadIndex();
  html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(m.pageTitle)}</title>\n<link rel="canonical" href="${esc(m.url)}">`);
  html = setMeta(html, 'name', 'description', m.description);
  html = setMeta(html, 'property', 'og:url', m.url);
  html = setMeta(html, 'property', 'og:title', m.title);
  html = setMeta(html, 'property', 'og:description', m.description);
  html = setMeta(html, 'property', 'og:image', m.image);
  html = setMeta(html, 'property', 'og:image:alt', m.imageAlt);
  html = setMeta(html, 'name', 'twitter:title', m.title);
  html = setMeta(html, 'name', 'twitter:description', m.description);
  html = setMeta(html, 'name', 'twitter:image', m.image);
  return html;
}

// ── og.jpg ────────────────────────────────────────────
const OG_W = 1200, OG_H = 630;
const imageCache = new Map(); // listing id -> { buf, exp }
const IMAGE_TTL_MS = 6 * 60 * 60 * 1000;
const IMAGE_CACHE_MAX = 200;

async function listingOgImage(l, { fetchImpl = fetch } = {}) {
  if (!sharp || !l.photo_url) return null;
  const now = Date.now();
  const hit = imageCache.get(l.id);
  if (hit && hit.exp > now) return hit.buf;
  const r = await fetchImpl(l.photo_url);
  if (!r.ok) throw new Error(`photo fetch ${r.status}`);
  const src = Buffer.from(await r.arrayBuffer());
  const buf = await sharp(src).rotate().resize(OG_W, OG_H, { fit: 'cover', position: 'attention' }).jpeg({ quality: 82 }).toBuffer();
  if (imageCache.size >= IMAGE_CACHE_MAX) {
    for (const [k, v] of imageCache) if (v.exp <= now) imageCache.delete(k);
    if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  }
  imageCache.set(l.id, { buf, exp: now + IMAGE_TTL_MS });
  return buf;
}

module.exports = { renderListingPage, listingMeta, listingOgImage, fmtPrice, excerpt, esc, _resetIndexCache: () => { indexHtml = null; } };
