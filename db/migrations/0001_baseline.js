/**
 * 0001_baseline — everything the database needed as of 2026-10-31.
 *
 * Part 1 applies db/schema.sql (tables, indexes, search function and
 * trigger, article seed). Part 2 is the former server.js startup block,
 * moved here verbatim. Every statement is idempotent, so on the live
 * database this runs once, harmlessly, and is then recorded in
 * schema_migrations and never run again.
 */
const fs   = require('fs');
const path = require('path');

module.exports = {
  async up(query) {
    // ── Part 1: schema.sql ──────────────────────────────
    const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    // Extensions need privileges a managed database may not grant; run them
    // one by one and carry on if one is refused (they already exist on Railway).
    const extensions = schema.match(/^CREATE EXTENSION[^;]*;/gm) || [];
    for (const ext of extensions) {
      try { await query(ext); } catch (e) { console.warn('⚠️  Extension skipped:', ext.trim(), '-', e.message.split('\n')[0]); }
    }
    await query(schema.replace(/^CREATE EXTENSION[^;]*;\s*$/gm, ''));
    console.log('✅  schema.sql applied');

    // ── Part 2: former startup block (verbatim) ─────────

    // Note: tier and category CHECK constraints are defined in schema.sql and
    // validated in app routes. Do not drop them here.

    // Ensure articles table exists (added in v3.1)
    await query(`CREATE TABLE IF NOT EXISTS articles (
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
    )`);
    console.log('✅  Articles table ready');

    // Fix article categories (one-time migration)
    await query("UPDATE articles SET category='Genetics & Breeding' WHERE category IN ('Cattle','General') AND (title ILIKE '%EPD%' OR title ILIKE '%bull%' OR title ILIKE '%breed%' OR title ILIKE '%genetic%')");
    await query("UPDATE articles SET category='Ranch Management' WHERE category IN ('Cattle','General') AND (title ILIKE '%Health Record%' OR title ILIKE '%manage%' OR title ILIKE '%ranch%')");
    await query("UPDATE articles SET category='Markets & Prices' WHERE category IN ('Market','Markets','General') AND (title ILIKE '%feeder%' OR title ILIKE '%price%' OR title ILIKE '%market%' OR title ILIKE '%worth%')");
    await query("UPDATE articles SET category='Industry & Opinion' WHERE category='General' AND (title ILIKE '%Middleman%' OR title ILIKE '%Lab-Grown%' OR title ILIKE '%lab grown%')");
    await query("UPDATE articles SET category='Farm & Land' WHERE category='General' AND (title ILIKE '%land%' OR title ILIKE '%pasture%' OR title ILIKE '%succession%')");

    await query(`CREATE TABLE IF NOT EXISTS catalog_signups (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      email VARCHAR(255) NOT NULL,
      street VARCHAR(200) NOT NULL,
      city VARCHAR(100) NOT NULL,
      state VARCHAR(50) NOT NULL,
      zip VARCHAR(20) NOT NULL,
      ip_address VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      catalog_sent BOOLEAN DEFAULT FALSE,
      notes TEXT
    )`);
    console.log('✅  Catalog signups table ready');

    // Beef Box waitlist table
    await query(`CREATE TABLE IF NOT EXISTS beefbox_waitlist (
      id         BIGSERIAL    PRIMARY KEY,
      name       TEXT         NOT NULL,
      email      TEXT         NOT NULL UNIQUE,
      state      TEXT,
      type       TEXT,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    await query(`ALTER TABLE beefbox_waitlist ADD COLUMN IF NOT EXISTS street VARCHAR(150)`);
    await query(`ALTER TABLE beefbox_waitlist ADD COLUMN IF NOT EXISTS city VARCHAR(100)`);
    await query(`ALTER TABLE beefbox_waitlist ADD COLUMN IF NOT EXISTS zip VARCHAR(20)`);
    console.log('✅  Beef Box waitlist table ready');

    // Ensure columns exist on users table
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS city VARCHAR(100)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS state VARCHAR(50)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS website_url VARCHAR(255)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS operation_type VARCHAR(50)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS breeds TEXT[]`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS county VARCHAR(100)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS years_in_operation INTEGER`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_contact VARCHAR(20)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS facebook_url VARCHAR(255)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS instagram_url VARCHAR(255)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS head_count_range VARCHAR(50)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bqa_certified BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS shipping_street VARCHAR(200)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS shipping_city VARCHAR(100)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS shipping_zip VARCHAR(20)`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS beef_box_claimed BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS lister_number INTEGER`);

    // Email confirmation (H4, shipped 2026-10-29). New signups get a token at
    // register and must confirm before posting. Accounts that never received a
    // token (everyone from before the feature) are grandfathered as confirmed.
    // The date cap makes the backfill inert after rollout.
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token_hash TEXT`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_sent_at TIMESTAMPTZ`);
    await query(`CREATE INDEX IF NOT EXISTS idx_users_verify_token ON users(email_verify_token_hash) WHERE email_verify_token_hash IS NOT NULL`);
    await query(`UPDATE users SET email_verified_at = created_at
                  WHERE email_verified_at IS NULL
                    AND email_verify_token_hash IS NULL
                    AND created_at < '2026-11-01 00:00:00+00'`);
    console.log('✅  Email confirmation columns ready');

    // Audit log (defined in schema.sql; ensured here so admin actions can
    // record to it on databases that never ran the schema file). First
    // writer: admin account deletion (C2).
    await query(`CREATE TABLE IF NOT EXISTS audit_log (
      id          BIGSERIAL    PRIMARY KEY,
      user_id     BIGINT       REFERENCES users(id),
      action      TEXT         NOT NULL,
      entity      TEXT,
      entity_id   BIGINT,
      meta        JSONB,
      ip          TEXT,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_log(user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id)`);
    console.log('✅  Audit log table ready');

    // Session versioning (H6, 2026-10-30): tokens carry users.token_version;
    // ban, password change, sign-out-everywhere and admin invalidate-all bump it.
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0`);
    console.log('✅  Session versioning column ready');

    await query(`CREATE TABLE IF NOT EXISTS beef_box_claims (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      name VARCHAR(150) NOT NULL,
      email VARCHAR(255),
      phone VARCHAR(20),
      street VARCHAR(200) NOT NULL,
      city VARCHAR(100) NOT NULL,
      state VARCHAR(50) NOT NULL,
      zip VARCHAR(20) NOT NULL,
      listing_id INTEGER,
      lister_number INTEGER,
      claimed_at TIMESTAMPTZ DEFAULT NOW(),
      fulfilled BOOLEAN DEFAULT FALSE,
      fulfilled_at TIMESTAMPTZ,
      tracking_number VARCHAR(100),
      notes TEXT
    )`);

    await query(`CREATE TABLE IF NOT EXISTS advertiser_inquiries (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      business VARCHAR(160) NOT NULL,
      email VARCHAR(160) NOT NULL,
      phone VARCHAR(40),
      website VARCHAR(200),
      interests TEXT,
      message TEXT,
      status VARCHAR(20) DEFAULT 'new',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('✅  Advertiser inquiries table ready');

    // Ensure updated_at column exists on listings
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

    // Ensure website_url column exists on listings
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS website_url TEXT`);
    console.log('✅  website_url column ready');

    // Reviews table
    await query(`CREATE TABLE IF NOT EXISTS seller_reviews (
      id          BIGSERIAL    PRIMARY KEY,
      seller_id   BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reviewer_id BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      listing_id  BIGINT       REFERENCES listings(id) ON DELETE SET NULL,
      rating      SMALLINT     NOT NULL CHECK (rating BETWEEN 1 AND 5),
      title       TEXT,
      body        TEXT,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE(seller_id, reviewer_id, listing_id)
    )`);

    // Password reset tokens
    await query(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id         BIGSERIAL    PRIMARY KEY,
      user_id    BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT         NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ  NOT NULL,
      used       BOOLEAN      NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);

    // Listing reports
    await query(`CREATE TABLE IF NOT EXISTS listing_reports (
      id          BIGSERIAL    PRIMARY KEY,
      listing_id  BIGINT       NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      reporter_id BIGINT       REFERENCES users(id) ON DELETE SET NULL,
      reason      TEXT         NOT NULL,
      details     TEXT,
      status      TEXT         NOT NULL DEFAULT 'open',
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    console.log('✅  Reviews, reset tokens, reports tables ready');

    // Geo columns for map view
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS lat NUMERIC(9,6)`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS lng NUMERIC(9,6)`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ`);

    // Farm to Table columns
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_name VARCHAR(150)`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_proteins TEXT[]`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_product_forms TEXT[]`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_production_methods TEXT[]`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_processing TEXT[]`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_delivery TEXT[]`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_availability VARCHAR(50)`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_harvest_date DATE`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_certifications TEXT[]`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_price_hanging DECIMAL(8,2)`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_price_takehome DECIMAL(8,2)`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_deposit_required BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_deposit_amount DECIMAL(8,2)`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_call_for_price BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_tours BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_operation_size VARCHAR(50)`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS farm_years INTEGER`);

    // Saved searches table
    await query(`CREATE TABLE IF NOT EXISTS saved_searches (
      id          BIGSERIAL    PRIMARY KEY,
      user_id     BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT         NOT NULL,
      category    TEXT,
      state       TEXT,
      min_price   NUMERIC,
      max_price   NUMERIC,
      min_weight  NUMERIC,
      max_weight  NUMERIC,
      keywords    TEXT,
      last_alerted_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    console.log('✅  Geo columns, sold_at, saved_searches ready');

    // Email drip log table
    await query(`CREATE TABLE IF NOT EXISTS email_drip_log (
      id         BIGSERIAL    PRIMARY KEY,
      user_id    BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      drip_day   INTEGER      NOT NULL,
      sent_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, drip_day)
    )`);
    console.log('✅  Email drip log table ready');

    // Login attempt tracking
    await query(`CREATE TABLE IF NOT EXISTS login_attempts (
      id           BIGSERIAL    PRIMARY KEY,
      identifier   TEXT         NOT NULL UNIQUE,
      attempts     INTEGER      NOT NULL DEFAULT 0,
      last_attempt TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      locked_until TIMESTAMPTZ
    )`);
    console.log('✅  Login attempts table ready');

    // Site settings table
    await query(`CREATE TABLE IF NOT EXISTS site_settings (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // Seed defaults if empty
    await query(`INSERT INTO site_settings (key, value) VALUES
      ('stat_members', '350'),
      ('stat_sales',   '$25K+'),
      ('stat_since',   'Since 2018')
      ON CONFLICT (key) DO NOTHING`);
    console.log('✅  Site settings table ready');

    // Calving records table
    await query(`CREATE TABLE IF NOT EXISTS calving_records (
      id             BIGSERIAL    PRIMARY KEY,
      user_id        BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cow_name       VARCHAR(100),
      breed          VARCHAR(50),
      breeding_date  DATE         NOT NULL,
      due_date       DATE         NOT NULL,
      gestation_days INTEGER,
      notes          TEXT,
      created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_calving_user ON calving_records(user_id)`);
    console.log('✅  Calving records table ready');

    // Herd manager tables
    await query(`CREATE TABLE IF NOT EXISTS animals (
      id              BIGSERIAL      PRIMARY KEY,
      user_id         BIGINT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tag_id          VARCHAR(50),
      name            VARCHAR(100),
      species         VARCHAR(20)    DEFAULT 'cattle',
      sex             VARCHAR(10),
      breed           VARCHAR(50),
      birth_date      DATE,
      birth_weight    DECIMAL(6,2),
      color           VARCHAR(50),
      sire_id         BIGINT         REFERENCES animals(id) ON DELETE SET NULL,
      dam_id          BIGINT         REFERENCES animals(id) ON DELETE SET NULL,
      sire_name       VARCHAR(100),
      dam_name        VARCHAR(100),
      purchase_date   DATE,
      purchase_price  DECIMAL(10,2),
      status          VARCHAR(20)    DEFAULT 'active',
      notes           TEXT,
      photo_url       TEXT,
      created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_animals_user ON animals(user_id)`);

    await query(`CREATE TABLE IF NOT EXISTS animal_weights (
      id          BIGSERIAL    PRIMARY KEY,
      animal_id   BIGINT       NOT NULL REFERENCES animals(id) ON DELETE CASCADE,
      weight      DECIMAL(6,2) NOT NULL,
      weigh_date  DATE         NOT NULL,
      notes       TEXT,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_weights_animal ON animal_weights(animal_id)`);

    await query(`CREATE TABLE IF NOT EXISTS animal_health (
      id                    BIGSERIAL    PRIMARY KEY,
      animal_id             BIGINT       NOT NULL REFERENCES animals(id) ON DELETE CASCADE,
      event_type            VARCHAR(50),
      event_date            DATE         NOT NULL,
      product               VARCHAR(100),
      dosage                VARCHAR(50),
      withdrawal_days       INTEGER,
      withdrawal_clear_date DATE,
      administered_by       VARCHAR(100),
      cost                  DECIMAL(8,2),
      notes                 TEXT,
      created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_health_animal ON animal_health(animal_id)`);

    await query(`CREATE TABLE IF NOT EXISTS animal_production (
      id            BIGSERIAL    PRIMARY KEY,
      animal_id     BIGINT       NOT NULL REFERENCES animals(id) ON DELETE CASCADE,
      event_type    VARCHAR(30),
      event_date    DATE         NOT NULL,
      bull_id       BIGINT       REFERENCES animals(id) ON DELETE SET NULL,
      bull_name     VARCHAR(100),
      calving_ease  INTEGER,
      calf_id       BIGINT       REFERENCES animals(id) ON DELETE SET NULL,
      notes         TEXT,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_production_animal ON animal_production(animal_id)`);
    console.log('✅  Herd manager tables ready');

    // Market price intelligence tables
    await query(`CREATE TABLE IF NOT EXISTS market_prices (
      id          BIGSERIAL      PRIMARY KEY,
      report_date DATE,
      source      VARCHAR(50),
      region      VARCHAR(50),
      category    VARCHAR(50),
      weight_low  INTEGER,
      weight_high INTEGER,
      price_low   DECIMAL(8,2),
      price_high  DECIMAL(8,2),
      price_avg   DECIMAL(8,2),
      head_count  INTEGER,
      created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_market_prices_cat ON market_prices(category, report_date)`);

    await query(`CREATE TABLE IF NOT EXISTS price_alerts (
      id           BIGSERIAL      PRIMARY KEY,
      user_id      BIGINT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category     VARCHAR(50),
      weight_low   INTEGER,
      weight_high  INTEGER,
      target_price DECIMAL(8,2),
      alert_type   VARCHAR(20)    DEFAULT 'above',
      active       BOOLEAN        DEFAULT true,
      created_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_price_alerts_user ON price_alerts(user_id)`);
    console.log('✅  Market price tables ready');

    // Finance tables
    await query(`CREATE TABLE IF NOT EXISTS finance_transactions (
      id              BIGSERIAL      PRIMARY KEY,
      user_id         BIGINT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      transaction_date DATE,
      category        VARCHAR(50),
      type            VARCHAR(10),
      description     VARCHAR(200),
      amount          DECIMAL(10,2),
      head_count      INTEGER,
      price_per_head  DECIMAL(10,2),
      weight_lbs      DECIMAL(8,2),
      price_per_cwt   DECIMAL(8,2),
      animal_id       BIGINT         REFERENCES animals(id) ON DELETE SET NULL,
      tax_year        INTEGER,
      notes           TEXT,
      created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_finance_user_year ON finance_transactions(user_id, tax_year)`);

    await query(`CREATE TABLE IF NOT EXISTS finance_budgets (
      id              BIGSERIAL      PRIMARY KEY,
      user_id         BIGINT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category        VARCHAR(50),
      budgeted_amount DECIMAL(10,2),
      tax_year        INTEGER,
      created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_budgets_user ON finance_budgets(user_id, tax_year)`);
    console.log('✅  Finance tables ready');

    // Genetic pairings
    await query(`CREATE TABLE IF NOT EXISTS genetic_pairings (
      id               BIGSERIAL    PRIMARY KEY,
      user_id          BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bull_name        VARCHAR(100),
      bull_breed       VARCHAR(50),
      bull_epds        JSONB,
      cow_herd_epds    JSONB,
      cow_herd_breed   VARCHAR(50),
      predicted_results JSONB,
      notes            TEXT,
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_pairings_user ON genetic_pairings(user_id)`);
    console.log('✅  Genetic pairings table ready');

    // Ranch profiles
    await query(`CREATE TABLE IF NOT EXISTS ranch_profiles (
      id              BIGSERIAL    PRIMARY KEY,
      user_id         BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
      ranch_name      VARCHAR(150),
      tagline         VARCHAR(200),
      story           TEXT,
      founded_year    INTEGER,
      acres           INTEGER,
      location_city   VARCHAR(100),
      location_state  VARCHAR(2),
      phone           VARCHAR(20),
      website         VARCHAR(200),
      facebook        VARCHAR(200),
      instagram       VARCHAR(200),
      specialties     TEXT[],
      breeds          TEXT[],
      logo_url        TEXT,
      banner_url      TEXT,
      is_premium      BOOLEAN      DEFAULT false,
      is_verified     BOOLEAN      DEFAULT false,
      premium_since   TIMESTAMPTZ,
      views           INTEGER      DEFAULT 0,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    console.log('✅  Ranch profiles table ready');

    // Digital sales
    await query(`CREATE TABLE IF NOT EXISTS sales_events (
      id                     BIGSERIAL    PRIMARY KEY,
      user_id                BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title                  VARCHAR(200),
      description            TEXT,
      sale_date              TIMESTAMPTZ,
      registration_deadline  TIMESTAMPTZ,
      location_name          VARCHAR(200),
      location_state         VARCHAR(2),
      sale_type              VARCHAR(30)  DEFAULT 'production',
      status                 VARCHAR(20)  DEFAULT 'draft',
      banner_url             TEXT,
      terms                  TEXT,
      commission_rate        DECIMAL(4,2) DEFAULT 2.00,
      created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS sale_lots (
      id                BIGSERIAL    PRIMARY KEY,
      sale_id           BIGINT       NOT NULL REFERENCES sales_events(id) ON DELETE CASCADE,
      lot_number        INTEGER,
      title             VARCHAR(200),
      description       TEXT,
      head_count        INTEGER,
      breed             VARCHAR(50),
      sex               VARCHAR(20),
      avg_weight        DECIMAL(6,2),
      avg_age_months    INTEGER,
      reserve_price     DECIMAL(10,2),
      starting_bid      DECIMAL(10,2),
      current_bid       DECIMAL(10,2),
      current_bidder_id BIGINT       REFERENCES users(id),
      bid_count         INTEGER      DEFAULT 0,
      status            VARCHAR(20)  DEFAULT 'pending',
      video_url         TEXT,
      epd_data          JSONB,
      notes             TEXT,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS sale_bids (
      id         BIGSERIAL    PRIMARY KEY,
      lot_id     BIGINT       NOT NULL REFERENCES sale_lots(id) ON DELETE CASCADE,
      user_id    BIGINT       REFERENCES users(id),
      bid_amount DECIMAL(10,2),
      bid_time   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      status     VARCHAR(20)  DEFAULT 'active'
    )`);
    await query(`CREATE TABLE IF NOT EXISTS sale_registrations (
      id            BIGSERIAL    PRIMARY KEY,
      sale_id       BIGINT       REFERENCES sales_events(id) ON DELETE CASCADE,
      user_id       BIGINT       REFERENCES users(id) ON DELETE CASCADE,
      approved      BOOLEAN      DEFAULT false,
      registered_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE(sale_id, user_id)
    )`);
    console.log('✅  Digital sales tables ready');

    // Silent auction columns for sale_lots
    await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ`);
    await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS sale_confirmed BOOLEAN DEFAULT false`);
    await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS winner_user_id BIGINT REFERENCES users(id)`);
    await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS winner_notified BOOLEAN DEFAULT false`);
    await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS location_state VARCHAR(2)`);
    await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS photo_urls JSONB`);
    console.log('✅  Silent auction columns ready');

    // Commission columns for sale_lots
    await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS commission_amount DECIMAL(10,2)`);
    await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS commission_paid BOOLEAN DEFAULT false`);
    await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS commission_invoice_url TEXT`);
    await query(`ALTER TABLE sale_lots ADD COLUMN IF NOT EXISTS final_sale_price DECIMAL(10,2)`);
    console.log('✅  Commission columns ready');

    // Verification requests table
    await query(`CREATE TABLE IF NOT EXISTS verification_requests (
      id              BIGSERIAL    PRIMARY KEY,
      user_id         BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      full_name       VARCHAR(150),
      business_name   VARCHAR(150),
      phone           VARCHAR(20),
      state           VARCHAR(2),
      operation_type  VARCHAR(100),
      head_count      VARCHAR(50),
      reason          TEXT,
      status          VARCHAR(20)  DEFAULT 'pending',
      admin_notes     TEXT,
      reviewed_by     BIGINT       REFERENCES users(id),
      reviewed_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    console.log('✅  Verification requests table ready');

    // Performance indexes for homepage queries
    await query(`CREATE INDEX IF NOT EXISTS idx_listings_tier_status ON listings(tier, status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_listings_cat_tier_status ON listings(category, tier, status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_listings_status_created ON listings(status, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_listings_featured_status ON listings(is_featured, status)`);
    console.log('✅  Performance indexes ready');

  },
};
