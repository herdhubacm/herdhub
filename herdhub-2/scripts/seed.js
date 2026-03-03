/**
 * Herd Hub – PostgreSQL Seed Script
 * Inserts sample users, listings, forum topics and market cache.
 * Safe to re-run (uses ON CONFLICT DO NOTHING for users).
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, testConnection } = require('../db/database');

async function seed() {
  console.log('\n🌱  Seeding Herd Hub database...\n');
  await testConnection();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── Users ─────────────────────────────────────────
    const hash = await bcrypt.hash('Password123!', 12);
    const users = [
      ['admin@herdhub.com',   'HH Admin',          'admin', 'TX', 'Austin'],
      ['rancher@example.com', 'Jake Harrington',   'user',  'TX', 'Amarillo'],
      ['cattleman@test.com',  'Linda Kowalski',    'user',  'KS', 'Dodge City'],
      ['ranchhand@demo.com',  'Travis Beulah',     'user',  'MT', 'Billings'],
      ['farmer@example.com',  'Sue Ellen Parsons', 'user',  'WY', 'Cheyenne'],
      ['beef@demo.com',       'Ray Dunkleman',     'user',  'NE', 'Omaha'],
    ];

    const userIds = {};
    for (const [email, name, role, state, city] of users) {
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, name, role, state, city)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name
         RETURNING id, email`,
        [email, hash, name, role, state, city]
      );
      userIds[email] = rows[0].id;
    }
    console.log(`  ✅  ${users.length} users seeded`);

    // ── Listings ──────────────────────────────────────
    const exp = (days) => new Date(Date.now() + days * 86400000);

    const listings = [
      {
        user: 'rancher@example.com', title: '2022 Registered Black Angus Herd Sire',
        desc: 'Excellent calving ease EPDs. Weaning Wt +65, REA +0.72. 1,850 lbs. Current on all vaccines and tested. Ready to work.',
        cat: 'bulls', breed: 'Black Angus', price: 8500, pt: 'obo',
        wt: 1850, age: 28, sex: 'bull', state: 'TX', city: 'Amarillo',
        tier: 'featured', featured: true, exp: exp(90), pay: 'paid'
      },
      {
        user: 'cattleman@test.com', title: '25 Hereford Bred Heifers – Spring Calving',
        desc: 'All bred to low-birth-weight Angus bull. 900-1,050 lbs. Vaccinated and wormed. Gentle, pasture-raised.',
        cat: 'heifers', breed: 'Hereford', price: 2100, pt: 'per_head',
        qty: 25, wt: 975, age: 26, sex: 'heifer', state: 'KS', city: 'Dodge City',
        tier: 'standard', featured: false, exp: exp(60), pay: 'paid'
      },
      {
        user: 'ranchhand@demo.com', title: '2021 Featherlite 8127 – 24ft Livestock Trailer',
        desc: 'Aluminum frame, 9,900 lb GVW. Slide-gate dividers, rubber mat flooring. Very clean, one owner.',
        cat: 'trucks_trailers', price: 38500, pt: 'fixed',
        state: 'MT', city: 'Billings', tier: 'featured', featured: true, exp: exp(90), pay: 'paid'
      },
      {
        user: 'farmer@example.com', title: 'Started Border Collie – 18 Months, Cow-Dog Trained',
        desc: 'ABCA registered. Works cattle on both sides. 3rd generation ranch dog pedigree available.',
        cat: 'working_dogs', breed: 'Border Collie', price: 3200, pt: 'fixed',
        age: 18, state: 'WY', city: 'Cheyenne', tier: 'basic', featured: false, exp: exp(30), pay: 'free'
      },
      {
        user: 'rancher@example.com', title: 'John Deere 559 Round Baler – 850 Hours',
        desc: 'MegaWide HC pickup, net wrap. Stored inside entire life. Excellent condition. Service records available.',
        cat: 'equipment', price: 31000, pt: 'firm',
        state: 'TX', city: 'Lubbock', tier: 'standard', featured: false, exp: exp(60), pay: 'paid'
      },
      {
        user: 'beef@demo.com', title: 'Grass-Fed Black Angus Beef – Whole/Half Steer',
        desc: 'All-natural, no hormones or antibiotics. USDA-inspected facility. Custom cut. Ships nationwide.',
        cat: 'farm_to_table', breed: 'Black Angus', price: 6.50, pt: 'per_lb',
        state: 'NE', city: 'Omaha', tier: 'featured', featured: true, exp: exp(90), pay: 'paid'
      },
      {
        user: 'cattleman@test.com', title: '50 Head Angus-Cross Steer Calves – Spring Drop',
        desc: 'Uniform 500-550 lb Angus-cross steers. All worked, banded, dehorned. Weaned 60+ days.',
        cat: 'beef_cattle', breed: 'Angus Cross', price: 1650, pt: 'per_head',
        qty: 50, wt: 525, age: 7, sex: 'steer', state: 'KS', city: 'Salina',
        tier: 'standard', featured: false, exp: exp(60), pay: 'paid'
      },
      {
        user: 'ranchhand@demo.com', title: '2019 Ford F-350 Dually – Ranch Truck',
        desc: '6.7L Power Stroke diesel, 4x4, crew cab. 87,000 miles. Fifth wheel prep, gooseneck hitch. Very clean.',
        cat: 'trucks_trailers', price: 54500, pt: 'obo',
        state: 'MT', city: 'Great Falls', tier: 'basic', featured: false, exp: exp(30), pay: 'free'
      },
      {
        user: 'farmer@example.com', title: '5 Purebred Texas Longhorn Cow-Calf Pairs',
        desc: 'Registered longhorns with impressive horn spreads. 3-6 yrs old. All with spring 2025 bull calves at side.',
        cat: 'beef_cattle', breed: 'Texas Longhorn', price: 2800, pt: 'per_head',
        qty: 5, state: 'TX', city: 'San Antonio', tier: 'basic', featured: false, exp: exp(30), pay: 'free'
      },
      {
        user: 'beef@demo.com', title: '100-Ton Prairie Hay – Delivery Available',
        desc: 'Grass hay, 1st cutting 2025. Tested at 9.2% CP. 1,200 lb round bales. Delivery within 100 miles.',
        cat: 'feed_hay', price: 95, pt: 'per_head',
        qty: 167, state: 'NE', city: 'Norfolk', tier: 'basic', featured: false, exp: exp(30), pay: 'free'
      },
    ];

    let listingCount = 0;
    for (const l of listings) {
      await client.query(
        `INSERT INTO listings
           (user_id, title, description, category, breed, price, price_type, quantity,
            weight_lbs, age_months, sex, state, city, tier, is_featured, expires_at, payment_status, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'active')`,
        [
          userIds[l.user], l.title, l.desc, l.cat, l.breed||null,
          l.price||null, l.pt||'fixed', l.qty||1,
          l.wt||null, l.age||null, l.sex||null,
          l.state, l.city, l.tier, l.featured, l.exp, l.pay
        ]
      );
      listingCount++;
    }
    console.log(`  ✅  ${listingCount} listings seeded`);

    // ── Forum topics ──────────────────────────────────
    const topics = [
      ['rancher@example.com', 'cattle',   'Best handling system for a 500-head operation?',
       'We are expanding and looking at Powder River vs. WW vs. Hi-Qual setups. Any recommendations from folks who have used them?'],
      ['cattleman@test.com',  'market',   'Are feeder prices going to hold this fall?',
       'Curious what everyone thinks. Supply is tight but grain inputs are still high. Thinking of holding calves past weaning.'],
      ['farmer@example.com',  'dogs',     'Border Collie vs. Australian Shepherd for working cattle',
       'Just started looking into cow dogs. What breeds do you all prefer for cattle work specifically?'],
      ['beef@demo.com',       'farm_to_table', 'Setting up direct beef sales – where to start?',
       'We want to start selling freezer beef direct to consumers. What are the regulations around custom-exempt processing?'],
      ['ranchhand@demo.com',  'health',   'BRD protocol for newly weaned calves',
       'What vaccination protocol are people using for fresh-weaned calves coming off grass?'],
    ];

    for (const [user, cat, title, body] of topics) {
      await client.query(
        'INSERT INTO forum_topics (user_id, category, title, body) VALUES ($1,$2,$3,$4)',
        [userIds[user], cat, title, body]
      );
    }
    console.log(`  ✅  ${topics.length} forum topics seeded`);

    // ── Default market cache ──────────────────────────
    const defaultMarket = {
      ticker: [
        'Fed Cattle (5-Area Live): $198.50/cwt',
        'Feeder Steers 600-700 lbs: $274.00/cwt',
        'Choice Boxed Beef: $317.50/cwt',
        'Cull Cows: $118.00/cwt',
        'Source: USDA AMS (auto-updating every 15 min)'
      ],
      fetched_at: new Date().toISOString(),
      seeded: true
    };
    await client.query(
      `INSERT INTO market_cache (report_id, data)
       VALUES ('unified_prices', $1)
       ON CONFLICT (report_id) DO NOTHING`,
      [JSON.stringify(defaultMarket)]
    );
    console.log('  ✅  Default market cache seeded');

    await client.query('COMMIT');
    console.log('\n🎉  Seed complete!\n');
    console.log('   Credentials:');
    console.log('   Admin:  admin@herdhub.com   / Password123!');
    console.log('   User:   rancher@example.com / Password123!\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌  Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
