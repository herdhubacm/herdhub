-- ╔══════════════════════════════════════════════════════╗
-- ║   HERD HUB – PostgreSQL Schema  v2.1                ║
-- ╚══════════════════════════════════════════════════════╝

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ── USERS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                 BIGSERIAL    PRIMARY KEY,
  email              TEXT         NOT NULL UNIQUE,
  password_hash      TEXT         NOT NULL,
  name               TEXT         NOT NULL,
  phone              TEXT,
  state              TEXT,
  city               TEXT,
  bio                TEXT,
  avatar_url         TEXT,
  role               TEXT         NOT NULL DEFAULT 'user'
                                  CHECK (role IN ('user','admin','moderator')),
  is_verified        BOOLEAN      NOT NULL DEFAULT FALSE,
  stripe_customer_id TEXT,
  terms_accepted     BOOLEAN      NOT NULL DEFAULT FALSE,
  terms_accepted_at  TIMESTAMPTZ,
  newsletter_opt_in  BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ── LISTINGS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listings (
  id               BIGSERIAL    PRIMARY KEY,
  user_id          BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT         NOT NULL,
  description      TEXT         NOT NULL,
  category         TEXT         NOT NULL
                                CHECK (category IN (
                                  'bulls','bucking_bulls','bred_heifers','bred_cows','open_heifers','open_cows',
                                  'feeder_stocker','fat_cattle','bottle_calves','cow_calf_pairs',
                                  'embryos','semen','showstock','dairy',
                                  'equipment','trailers','chutes_pens','working_dogs','feed_hay',
                                  'sale_barns','ranches_farms','breed_associations',
                                  'farm_to_table','livestock_services','feed_stores',
                                  'insurance_finance','full_herd'
                                )),
  subcategory      TEXT,
  breed            TEXT,
  price            NUMERIC(12,2),
  price_type       TEXT         NOT NULL DEFAULT 'fixed'
                                CHECK (price_type IN (
                                  'fixed','negotiable','obo','call',
                                  'per_head','per_lb','per_cwt','firm'
                                )),
  quantity         INTEGER      NOT NULL DEFAULT 1 CHECK (quantity > 0),
  weight_lbs       NUMERIC(8,1),
  age_months       INTEGER,
  sex              TEXT         CHECK (sex IN ('bull','cow','heifer','steer','calf',NULL)),
  state            TEXT         NOT NULL,
  city             TEXT         NOT NULL,
  zip              TEXT,
  status           TEXT         NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','sold','expired','draft','pending')),
  tier             TEXT         NOT NULL DEFAULT 'basic'
                                CHECK (tier IN ('burger','sirloin','ribeye','filet','t_bone','farm_to_table')),
  is_featured      BOOLEAN      NOT NULL DEFAULT FALSE,
  views            INTEGER      NOT NULL DEFAULT 0,
  expires_at       TIMESTAMPTZ,
  stripe_session_id TEXT,
  payment_status   TEXT         NOT NULL DEFAULT 'free'
                                CHECK (payment_status IN ('free','pending','paid','refunded')),
  search_vector    TSVECTOR,
  website_url      TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listings_category   ON listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_state      ON listings(state);
CREATE INDEX IF NOT EXISTS idx_listings_status     ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_featured   ON listings(is_featured) WHERE is_featured = TRUE;
CREATE INDEX IF NOT EXISTS idx_listings_user       ON listings(user_id);
CREATE INDEX IF NOT EXISTS idx_listings_breed      ON listings(breed);
CREATE INDEX IF NOT EXISTS idx_listings_price      ON listings(price);
CREATE INDEX IF NOT EXISTS idx_listings_created    ON listings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_fts        ON listings USING GIN(search_vector);

CREATE OR REPLACE FUNCTION listings_search_vector(
  title TEXT, description TEXT, breed TEXT, city TEXT, state TEXT, category TEXT
) RETURNS TSVECTOR AS $$
  SELECT
    setweight(to_tsvector('english', coalesce(title, '')),       'A') ||
    setweight(to_tsvector('english', coalesce(breed, '')),        'B') ||
    setweight(to_tsvector('english', coalesce(category, '')),     'B') ||
    setweight(to_tsvector('english', coalesce(city, '')),         'C') ||
    setweight(to_tsvector('english', coalesce(state, '')),        'C') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'D')
$$ LANGUAGE SQL IMMUTABLE;

CREATE OR REPLACE FUNCTION update_listing_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := listings_search_vector(
    NEW.title, NEW.description, NEW.breed, NEW.city, NEW.state, NEW.category
  );
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trig_listings_search ON listings;
CREATE TRIGGER trig_listings_search
  BEFORE INSERT OR UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION update_listing_search_vector();

-- ── LISTING PHOTOS ─────────────────────────────────────
-- v2.1: Added storage_key, thumb_url, thumb_key, width, height, size_bytes
CREATE TABLE IF NOT EXISTS listing_photos (
  id           BIGSERIAL    PRIMARY KEY,
  listing_id   BIGINT       NOT NULL REFERENCES listings(id) ON DELETE CASCADE,

  -- Full-size image
  url          TEXT         NOT NULL,   -- public CDN / S3 / local URL
  storage_key  TEXT,                    -- key used for deletion (e.g. listings/2026/03/abc.webp)

  -- Thumbnail (auto-generated, ~640×480)
  thumb_url    TEXT,                    -- public CDN URL of thumbnail
  thumb_key    TEXT,                    -- storage key for thumbnail deletion

  -- Metadata (populated by sharp during upload)
  width        INTEGER,
  height       INTEGER,
  size_bytes   INTEGER,

  sort_order   INTEGER      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_photos_listing ON listing_photos(listing_id, sort_order);

-- Safely add new columns if migrating from v2.0 (already has the table)
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned   BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason  TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE listing_photos ADD COLUMN IF NOT EXISTS storage_key TEXT;
  ALTER TABLE listing_photos ADD COLUMN IF NOT EXISTS thumb_url   TEXT;
  ALTER TABLE listing_photos ADD COLUMN IF NOT EXISTS thumb_key   TEXT;
  ALTER TABLE listing_photos ADD COLUMN IF NOT EXISTS width       INTEGER;
  ALTER TABLE listing_photos ADD COLUMN IF NOT EXISTS height      INTEGER;
  ALTER TABLE listing_photos ADD COLUMN IF NOT EXISTS size_bytes  INTEGER;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ── SAVED LISTINGS ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS saved_listings (
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id BIGINT      NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  saved_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_listings(user_id);

-- ── MESSAGES ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL    PRIMARY KEY,
  listing_id  BIGINT       REFERENCES listings(id) ON DELETE SET NULL,
  from_user   BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user     BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject     TEXT,
  body        TEXT         NOT NULL,
  is_read     BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_to_user   ON messages(to_user, is_read);
CREATE INDEX IF NOT EXISTS idx_messages_from_user ON messages(from_user);

-- ── MARKET CACHE ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS market_cache (
  report_id   TEXT         PRIMARY KEY,
  data        JSONB        NOT NULL,
  fetched_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── FORUM ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS forum_topics (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT         NOT NULL DEFAULT 'general',
  title       TEXT         NOT NULL,
  body        TEXT         NOT NULL,
  views       INTEGER      NOT NULL DEFAULT 0,
  is_pinned   BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS forum_replies (
  id          BIGSERIAL    PRIMARY KEY,
  topic_id    BIGINT       NOT NULL REFERENCES forum_topics(id) ON DELETE CASCADE,
  user_id     BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_replies_topic ON forum_replies(topic_id);

-- ── AUDIT LOG ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     BIGINT       REFERENCES users(id),
  action      TEXT         NOT NULL,
  entity      TEXT,
  entity_id   BIGINT,
  meta        JSONB,
  ip          TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

-- ── Shared updated_at trigger ──────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trig_users_updated_at ON users;
CREATE TRIGGER trig_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trig_forum_updated_at ON forum_topics;
CREATE TRIGGER trig_forum_updated_at
  BEFORE UPDATE ON forum_topics FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Articles ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS articles (
  id          SERIAL PRIMARY KEY,
  title       TEXT    NOT NULL,
  excerpt     TEXT,
  body        TEXT,
  category    TEXT    NOT NULL DEFAULT 'General',
  image_url   TEXT,
  author      TEXT    NOT NULL DEFAULT 'Herd Hub Staff',
  published   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default articles if empty
INSERT INTO articles (title, excerpt, category, image_url, author, created_at)
SELECT * FROM (VALUES
  (
    'Cattle Prices Surge to Multi-Year Highs Amid Tight Supplies',
    'Fed cattle prices have climbed to their highest levels since 2015 as the U.S. cow herd remains at historically low numbers following drought-driven liquidation. Analysts say the tight supply cycle could persist through 2027.',
    'Market Report',
    'https://images.unsplash.com/photo-1500595046743-cd271d694d30?w=240&q=75',
    'Herd Hub Staff',
    NOW() - INTERVAL '5 days'
  ),
  (
    'What to Look for When Buying a Used Round Baler in 2026',
    'A thorough pre-purchase inspection can save you thousands. Here is a practical checklist from experienced ranchers for evaluating balers in the field — from the pickup teeth to the drive chain.',
    'Equipment',
    'https://images.unsplash.com/photo-1589739900243-4b52cd9b104e?w=240&q=75',
    'Herd Hub Staff',
    NOW() - INTERVAL '9 days'
  ),
  (
    'Border Collies vs. Australian Shepherds: Which Breed for Your Ranch?',
    'Both breeds excel in different scenarios. We break down temperament, trainability, and herd-handling ability to help you choose the right working dog partner for your operation.',
    'Working Dogs',
    'https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=240&q=75',
    'Herd Hub Staff',
    NOW() - INTERVAL '12 days'
  ),
  (
    'Direct-to-Consumer Beef: How Ranchers Are Capturing More Margin',
    'More producers are cutting out the middleman. Learn how to set up your own direct beef sales and processing program, from USDA-inspected lockers to online storefronts.',
    'Farm to Table',
    'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=240&q=75',
    'Herd Hub Staff',
    NOW() - INTERVAL '16 days'
  )
) AS v(title, excerpt, category, image_url, author, created_at)
WHERE NOT EXISTS (SELECT 1 FROM articles LIMIT 1);


-- ── BEEF BOX WAITLIST ──────────────────────────────────
CREATE TABLE IF NOT EXISTS beefbox_waitlist (
  id         BIGSERIAL    PRIMARY KEY,
  name       TEXT         NOT NULL,
  email      TEXT         NOT NULL UNIQUE,
  state      TEXT,
  type       TEXT,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_beefbox_email ON beefbox_waitlist(email);

-- ── SELLER RATINGS & REVIEWS ────────────────────────────
CREATE TABLE IF NOT EXISTS seller_reviews (
  id            BIGSERIAL    PRIMARY KEY,
  seller_id     BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewer_id   BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id    BIGINT       REFERENCES listings(id) ON DELETE SET NULL,
  rating        SMALLINT     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title         TEXT,
  body          TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(seller_id, reviewer_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_seller ON seller_reviews(seller_id);

-- ── PASSWORD RESET TOKENS ───────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         BIGSERIAL    PRIMARY KEY,
  user_id    BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT         NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ  NOT NULL,
  used       BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── FRAUD/SCAM REPORTS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS listing_reports (
  id          BIGSERIAL    PRIMARY KEY,
  listing_id  BIGINT       NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  reporter_id BIGINT       REFERENCES users(id) ON DELETE SET NULL,
  reason      TEXT         NOT NULL,
  details     TEXT,
  status      TEXT         NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','dismissed')),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reports_listing ON listing_reports(listing_id);
CREATE INDEX IF NOT EXISTS idx_reports_status  ON listing_reports(status);
