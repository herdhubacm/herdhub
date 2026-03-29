/**
 * HerdHub — Seed 50 Realistic Listings
 * Run: node scripts/seed-listings.js
 * Creates test seller accounts + 50 listings spread across categories/states/tiers
 */

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const query = (text, params) => pool.query(text, params).then(r => r);

// ── Test seller accounts ──────────────────────────────
const sellers = [
  { name: 'Jake Harrington',   email: 'jake@herdhubtest.com',   phone: '8065551234', state: 'TX', city: 'Amarillo' },
  { name: 'Mae Colburn',       email: 'mae@herdhubtest.com',    phone: '4025557890', state: 'NE', city: 'Ogallala' },
  { name: 'Cody Whitfield',    email: 'cody@herdhubtest.com',   phone: '5805553456', state: 'OK', city: 'Woodward' },
  { name: 'Lena Burkhart',     email: 'lena@herdhubtest.com',   phone: '4065552345', state: 'MT', city: 'Miles City' },
  { name: 'Travis Dupree',     email: 'travis@herdhubtest.com', phone: '3175554567', state: 'IN', city: 'Tipton' },
  { name: 'Ruth Ann Skaggs',   email: 'ruth@herdhubtest.com',   phone: '6205558901', state: 'KS', city: 'Dodge City' },
  { name: 'Beau Olmstead',     email: 'beau@herdhubtest.com',   phone: '5122229876', state: 'TX', city: 'Fredericksburg' },
  { name: 'Norma Jean Holt',   email: 'norma@herdhubtest.com',  phone: '8505556789', state: 'TN', city: 'Cookeville' },
];

// ── 50 realistic listings ─────────────────────────────
const listings = [
  // BULLS (7)
  { title: 'Registered Black Angus Herd Bull — 3yr', category: 'bulls', breed: 'Angus', price: 5500, price_type: 'fixed', quantity: 1, weight_lbs: 1850, state: 'TX', city: 'Amarillo', tier: 'ribeye', description: 'Thick, deep-bodied 3-year-old registered Black Angus bull. EPDs in top 25% for growth and maternal traits. Semen tested, fully vaccinated on Bovi-Shield Gold 5 + Pyramid 5. Easy calving genetics — sired 14 calves this spring with zero pulls. Sound feet and legs, excellent disposition. Comes with registration papers and full health records. Can arrange delivery within 300 miles.', seller: 0 },

  { title: 'Hereford Bull — Thick & Easy Fleshing, 2yr', category: 'bulls', breed: 'Hereford', price: 4200, price_type: 'fixed', quantity: 1, weight_lbs: 1620, state: 'NE', city: 'Ogallala', tier: 'sirloin', description: 'Outstanding 2-year-old Hereford bull, structurally correct with excellent feet. EPDs: BW -1.2, WW +52, YW +88, Milk +22. Semen tested April 2026 — 75% motility. Current on all vaccinations. Has been running with 30 cows, proven breeder. Docile temperament, easy to work. Will sell with or without breeding guarantee.', seller: 1 },

  { title: 'Simmental x Angus Bull — Performance Tested', category: 'bulls', breed: 'SimAngus', price: 4800, price_type: 'fixed', quantity: 1, weight_lbs: 2050, state: 'KS', city: 'Dodge City', tier: 'sirloin', description: 'High-performing SimAngus bull, 2.5 years old. 205-day adjusted weaning weight of 812 lbs. Excellent hybrid vigor — calves consistently wean 50+ lbs heavier than straight-breds in our herd. Polled, black baldy, very gentle. Semen tested, vaccinated, dewormed. Selling because we are transitioning to a new breed program.', seller: 5 },

  { title: 'Brahman Bull — Registered, Heat Tolerant', category: 'bulls', breed: 'Brahman', price: 6200, price_type: 'fixed', quantity: 1, weight_lbs: 1780, state: 'TX', city: 'Fredericksburg', tier: 'ribeye', description: 'ABBA registered Grey Brahman bull, 4 years old. Perfect for Gulf Coast and Southern operations. Exceptional heat and tick tolerance. EPD ranked in top 10% for the breed. Has sired 3 calf crops — all calves grade Choice or better at harvest. Smooth coat, correct structure, wide muzzle. Health records available on request.', seller: 6 },

  { title: '2 Yearling Angus Bulls — Ready to Turn Out', category: 'bulls', breed: 'Angus', price: 3400, price_type: 'per_head', quantity: 2, weight_lbs: 1100, state: 'OK', city: 'Woodward', tier: 'burger', description: 'Pair of 14-month-old registered Angus bulls, both semen tested and ready to work. BW EPDs both negative — safe on first-calf heifers. Vaccinated on our standard program. Selling together or separately. Both are quiet and easy to handle. Sired by a son of Connealy Consensus.', seller: 2 },

  { title: 'Charolais Bull — High Growth, Low BW', category: 'bulls', breed: 'Charolais', price: 5000, price_type: 'fixed', quantity: 1, weight_lbs: 1920, state: 'MT', city: 'Miles City', tier: 'sirloin', description: '3-year-old Charolais bull with exceptional growth and low birth weight EPD. Ideal for crossing on Angus or Hereford cows to add muscle and frame. Tested clean for Trich and BVD-PI. Has serviced 45 cows this past season with excellent conception rates confirmed by preg check. Structural soundness score 8/8.', seller: 3 },

  { title: 'Red Angus Bull — Calving Ease Sire, 2yr', category: 'bulls', breed: 'Red Angus', price: 3900, price_type: 'fixed', quantity: 1, weight_lbs: 1580, state: 'IN', city: 'Tipton', tier: 'burger', description: 'Registered Red Angus bull, 26 months. Born 55 lbs, unassisted. BW EPD of -2.1 — outstanding heifer bull. Moderate frame, good milk EPD of +24. Current on all vaccinations. Well-mannered, has been halter broke. Selling to reduce bull battery. Price firm.', seller: 4 },

  // BRED HEIFERS (6)
  { title: '15 Black Angus Bred Heifers — Fall Calving', category: 'bred_heifers', breed: 'Angus', price: 2400, price_type: 'per_head', quantity: 15, weight_lbs: 1050, state: 'NE', city: 'Ogallala', tier: 't_bone', description: 'Exceptional set of 15 home-raised Black Angus bred heifers, bred to a low birth weight Angus bull for fall calving beginning October 1. All preg checked OB confirmed, due dates known within 2 weeks. Average weight 1,050 lbs. All heifers have been on a complete vaccination program since birth — IBR, BVD, PI3, BRSV, 7-way clostridial, Lepto. Dewormed and pour-on applied. Quiet cattle that have been worked through the chute regularly. These are from our best producing cow families — we retain heifers every year and these are surplus to our needs. Will consider selling as a group only.', seller: 1 },

  { title: '8 Hereford Bred Heifers — Spring Calvers', category: 'bred_heifers', breed: 'Hereford', price: 2100, price_type: 'per_head', quantity: 8, weight_lbs: 1020, state: 'KS', city: 'Dodge City', tier: 'sirloin', description: 'Nice set of 8 Hereford heifers bred to a calving ease Angus bull. Due to start calving March 15. Average weight 1,020 lbs. Pelvic measurements all 140+ cm². All current on vaccinations. Clean cattle, never been sick. Easy to work.', seller: 5 },

  { title: '6 Crossbred Bred Heifers — Ready to Calve', category: 'bred_heifers', breed: 'Angus x Hereford', price: 1950, price_type: 'per_head', quantity: 6, weight_lbs: 1080, state: 'TX', city: 'Amarillo', tier: 'burger', description: 'Six Angus x Hereford heifers, all preg checked confirmed, due beginning of November. Bred to a Simmental bull for added growth. These are commercial cattle — no papers but excellent conformation and disposition. Good buy for the commercial producer. Located near Amarillo, easy to access.', seller: 0 },

  { title: '20 SimAngus Bred Heifers — Preg Checked Open', category: 'bred_heifers', breed: 'SimAngus', price: 2650, price_type: 'per_head', quantity: 20, weight_lbs: 1120, state: 'MT', city: 'Miles City', tier: 't_bone', description: 'Twenty bred heifers, 5/8 Angus 3/8 Simmental. All OB checked in calf, due dates clustered in a tight 3-week window. Bred to a Baldridge EPD bull — calving ease sire. These are heifer development program graduates — pelvic scored, fertility tested, structure evaluated. Running on native grass, in excellent body condition score 5-6. Selling to fund a purchase of a bigger ranch. Serious buyers only, price reflects quality.', seller: 3 },

  { title: '10 Red Angus x Brahman Heifers — Fall Bred', category: 'bred_heifers', breed: 'Red Angus x Brahman', price: 2200, price_type: 'per_head', quantity: 10, weight_lbs: 995, state: 'TX', city: 'Fredericksburg', tier: 'sirloin', description: 'Ten F1 Red Angus x Brahman heifers, bred to a registered Red Angus bull. Due October 20 – November 10. Ideal for the Texas Hill Country or Gulf Coast producer. These cattle handle the heat and brush country exceptionally well. All vaccinated, dewormed, ear tagged. Currently grazing improved pasture.', seller: 6 },

  { title: '12 Commercial Angus Bred Heifers', category: 'bred_heifers', breed: 'Angus', price: 1850, price_type: 'per_head', quantity: 12, weight_lbs: 1010, state: 'OK', city: 'Woodward', tier: 'burger', description: 'Twelve commercial black Angus heifers, preg checked confirmed. All bred to a registered Angus bull, due dates March 5-25. Good cattle — sound, healthy, good doing. Current on vaccinations. Will sell in groups of 4 or all 12. Pickup or delivery available.', seller: 2 },

  // COW CALF PAIRS (5)
  { title: '18 Angus Cow-Calf Pairs — 3 to 6yr Cows', category: 'cow_calf_pairs', breed: 'Angus', price: 2800, price_type: 'per_head', quantity: 18, weight_lbs: 1250, state: 'NE', city: 'Ogallala', tier: 't_bone', description: 'Selling a set of 18 high-quality Angus pairs. Cows range from 3 to 6 years old — prime producing age. Calves are 60-90 days old, all creep fed and doing excellent. Calves average 285 lbs. Every cow has raised a calf every year — no open cows, no bad udders, no bad feet. Cows have been in our operation since birth. Full health records. Priced to move — we are downsizing operation.', seller: 1 },

  { title: '8 Hereford Pairs — Young Cows, Strong Calves', category: 'cow_calf_pairs', breed: 'Hereford', price: 2650, price_type: 'per_head', quantity: 8, weight_lbs: 1190, state: 'KS', city: 'Dodge City', tier: 'sirloin', description: 'Eight 3-4 year old Hereford cows with calves at side, 45-70 days old. Calves are steer and heifer calves about 50/50. Cows are in excellent flesh. All current on 7-way, Lepto, and Pour-on. Easy calving, quiet disposition. Would make excellent replacements or production unit.', seller: 5 },

  { title: '5 Crossbred Pairs — Great Starter Package', category: 'cow_calf_pairs', breed: 'Angus x Hereford', price: 2450, price_type: 'per_head', quantity: 5, weight_lbs: 1150, state: 'TN', city: 'Cookeville', tier: 'burger', description: 'Five Angus x Hereford pairs, ideal starter package for a small operation or addition to existing herd. Cows are 4-7 years old. Calves are 2-3 months old and nursing strong. Calves already crep fed and eating hay. Located in Middle Tennessee. Cattle are gentle and easy to work.', seller: 7 },

  { title: '25 Brahman x Angus Pairs — Dispersal', category: 'cow_calf_pairs', breed: 'Brahman x Angus', price: 2900, price_type: 'per_head', quantity: 25, weight_lbs: 1300, state: 'TX', city: 'Fredericksburg', tier: 't_bone', description: 'Full dispersal of 25 pairs from a top-end commercial operation. Cows are 3-8 years old, Brahman x Angus, some Brangus influence. All calves sired by a registered Angus bull. Calves 30-120 days old. Every cow has raised a calf without assistance. These cattle are acclimated to the Texas Hill Country and will thrive in hot, dry conditions. Preg checked — 22 confirmed back in calf already. Priced for quick sale.', seller: 6 },

  { title: '10 Red Angus Pairs — Home-Raised Cows', category: 'cow_calf_pairs', breed: 'Red Angus', price: 2750, price_type: 'per_head', quantity: 10, weight_lbs: 1220, state: 'MT', city: 'Miles City', tier: 'sirloin', description: 'Ten home-raised Red Angus pairs. Cows are 4-5 years old, excellent producers, all from AI-sired dams. Calves are 50-80 days old, sired by a son of Connealy Black Granite. Weaning weights will be exceptional. Cows run on native range, low input cattle. Very quiet — kids work these cattle. Preg checked back in calf to an Angus bull.', seller: 3 },

  // FEEDER CATTLE (5)
  { title: '45 Black Baldy Steers — 650lb Avg', category: 'feeder_stocker', breed: 'Angus x Hereford', price: 1.85, price_type: 'per_cwt', quantity: 45, weight_lbs: 650, state: 'NE', city: 'Ogallala', tier: 'sirloin', description: 'Uniform pen of 45 black baldy steers averaging 650 lbs, weaned 60 days, bunk broke, eating 20% range cube. Full Bovi-Shield Gold 5 and Pyramid 5 + Presponse program. All castrated, dehorned, healthy pen — no pulls. Ready for the feedlot or grass. Can arrange trucking within 500 miles. These cattle will grade well — excellent genetics on both sides.', seller: 1 },

  { title: '75 Angus x Hereford Heifers — 550lb', category: 'feeder_stocker', breed: 'Angus x Hereford', price: 1.72, price_type: 'per_cwt', quantity: 75, weight_lbs: 550, state: 'KS', city: 'Dodge City', tier: 't_bone', description: 'Large uniform pen of 75 commercial black baldy heifers averaging 550 lbs. Weaned 45 days, full pre-conditioning program — IBR, BVD, 7-way. Bunk broke, quiet, good doing cattle. Excellent genetics — sired by registered Angus bulls. Buyer can verify program. Ready to ship. Will sell as one pen only.', seller: 5 },

  { title: '30 Stocker Steers — Grass Ready, 480lb', category: 'feeder_stocker', breed: 'Angus', price: 1.95, price_type: 'per_cwt', quantity: 30, weight_lbs: 480, state: 'OK', city: 'Woodward', tier: 'sirloin', description: 'Thirty black Angus steers averaging 480 lbs. These cattle are ready to go to grass or a growing ration. Weaned 30 days, current on Blackleg and IBR/BVD. All black, steer-heads, home raised. Previous owner has impeccable records. Great buy for a stocker or backgrounder operation.', seller: 2 },

  { title: '20 Crossbred Steers — 750lb, Yard Ready', category: 'feeder_stocker', breed: 'SimAngus', price: 1.65, price_type: 'per_cwt', quantity: 20, weight_lbs: 750, state: 'TX', city: 'Amarillo', tier: 'sirloin', description: 'Twenty SimAngus steers, 750 lb average. These cattle have been backgrounded on a high-quality ration and are ready for a finishing yard. Full health program, negative BVD-PI by ear notch. Excellent frame, will finish efficiently. Available for inspection at our facility near Amarillo.', seller: 0 },

  { title: '60 Mixed Calves — 350-400lb, Fall Weaned', category: 'feeder_stocker', breed: 'Angus x Hereford', price: 2.10, price_type: 'per_cwt', quantity: 60, weight_lbs: 375, state: 'IN', city: 'Tipton', tier: 'burger', description: 'Fall weaned calves, 60 head, 350-400 lb range, steers and heifers mixed 60/40. Just weaned last week, starting pre-conditioning. Will be ready to ship in 3 weeks. Home raised, no sickness, excellent genetics. Contact for more information or to schedule a visit.', seller: 4 },

  // EQUIPMENT (6)
  { title: '2022 Featherlite 24ft Cattle Trailer — Excel Cond', category: 'trailers', price: 28500, price_type: 'fixed', quantity: 1, state: 'TX', city: 'Amarillo', tier: 'ribeye', description: '2022 Featherlite 8127 24-foot aluminum stock trailer. Used to haul cattle approximately 15,000 miles total. Inside dimensions: 24\' x 7\'6". Full-spread axles, electric brakes on all 4 wheels, interior lighting, rubber floor mats, butterfly center gate, rear swing gate with slider. No rust, excellent aluminum welds throughout. Tires at 85%. Kept in covered storage. Serious inquiries only — will not trade.', seller: 0 },

  { title: 'Powder River 14ft Sweep System — Complete', category: 'equipment', price: 8900, price_type: 'fixed', quantity: 1, state: 'KS', city: 'Dodge City', tier: 'sirloin', description: 'Complete Powder River sweep tub and alley system. 14-foot diameter tub, 20-foot curved alley, heavy-duty steel construction. Minor surface rust but structurally sound — welds are solid. Bought new 8 years ago and worked well for 500+ head operation. Dismantling operation and need to liquidate. Will help load.', seller: 5 },

  { title: 'WW 3-Ton Creep Feeder — Good Condition', category: 'equipment', price: 1200, price_type: 'fixed', quantity: 1, state: 'TN', city: 'Cookeville', tier: 'burger', description: '3-ton WW brand creep feeder with cattle-proof guard rails. Square legs, good welds, no leaks. Has been repainted once. 8 feeding slots — perfect for 30-50 calves. Selling because calves are weaned. Can load on your trailer with tractor. Local pickup preferred.', seller: 7 },

  { title: '2019 Priefert Hydraulic Squeeze Chute', category: 'chutes_pens', price: 6800, price_type: 'fixed', quantity: 1, state: 'MT', city: 'Miles City', tier: 'sirloin', description: 'Priefert S28 hydraulic squeeze chute, 2019 model. Poly floor in excellent shape. Self-catching headgate works perfectly. Side exit. All hydraulic functions operate correctly — squeeze, headgate, drop bar. Heavy use but well-maintained — greased and serviced annually. Comes with palpation cage. Selling to upgrade to a newer model.', seller: 3 },

  { title: '20ft Gooseneck Livestock Trailer — Needs Work', category: 'trailers', price: 4500, price_type: 'fixed', quantity: 1, state: 'OK', city: 'Woodward', tier: 'burger', description: '20-foot gooseneck stock trailer. Floor boards need replacing — price reflects this. Frame and welds are solid. Tires are good. Lights work. Would make an excellent project — these old trailers are tanks once the floor is done. Could haul horses or small loads with minimal repair. Selling as-is.', seller: 2 },

  { title: 'Ritchie Watermaster Automatic Waterer — 4 Station', category: 'equipment', price: 1850, price_type: 'fixed', quantity: 1, state: 'NE', city: 'Ogallala', tier: 'burger', description: 'Ritchie Watermaster 4-station automatic waterer, concrete bowl, electric heat. Installed 2018, worked perfectly until we switched to a pond system. Removed from service clean — no cracks, heater element is good. Will need to be plumbed in. A great buy for someone building out a drylot or feedyard. Pickup only, will help disassemble.', seller: 1 },

  // WORKING DOGS (4)
  { title: 'Trained Border Collie — 3yr, Cattle & Sheep', category: 'working_dogs', price: 3500, price_type: 'fixed', quantity: 1, state: 'MT', city: 'Miles City', tier: 'ribeye', description: 'Three-year-old registered Border Collie female, trained by a professional stockdog trainer with 20+ years experience. Works cattle and sheep with equal efficiency. Knows come-by, away, down, stand, walk up, and look back. Has penned and sorted in competitive trial settings. Quiet on stock — uses eye. Excellent for a working operation or competitive handler. Health tested — OFA hips Good, CEA clear, MDR1 clear. Will demo for serious buyers.', seller: 3 },

  { title: 'ACD Blue Heeler Pup — 10 Weeks, Both Parents Work', category: 'working_dogs', price: 450, price_type: 'fixed', quantity: 1, state: 'TX', city: 'Amarillo', tier: 'burger', description: 'Blue Australian Cattle Dog male pup, 10 weeks old. Both parents work cattle daily on our 2,000 acre operation — father is a proven heel dog, mother is a force to be reckoned with on the sort pen. Pup has been around cattle since birth. Blue merle coloring, natural bob tail. First shots and dewormed. Ready to start his working life.', seller: 0 },

  { title: 'Australian Shepherd — 2yr, Started on Cattle', category: 'working_dogs', price: 1800, price_type: 'fixed', quantity: 1, state: 'TN', city: 'Cookeville', tier: 'sirloin', description: 'Black tri Australian Shepherd female, 2 years old. Started on cattle — she will gather, drive, and hold a gate. Still developing but has excellent instinct and good stock sense. Listens well. ASCA registered. Current on vaccinations and heartworm prevention. Great prospect for a patient handler or working farm situation. Not a yard dog — needs a job.', seller: 7 },

  { title: 'McNab x Border Collie Female — 18 Months, Cattle Dog', category: 'working_dogs', price: 1200, price_type: 'fixed', quantity: 1, state: 'OK', city: 'Woodward', tier: 'burger', description: 'Eighteen-month-old McNab x Border Collie female, started on cattle. She has natural ability — gathers without being told and flanks correctly on her own. Needs consistent handling to reach her full potential. Good in all weather, tough feet. Selling because we have too many dogs for our operation size. Will transfer to the right working home only.', seller: 2 },

  // FARM TO TABLE (5)
  { title: 'Grass-Fed Black Angus Quarters & Halves — Nov Harvest', category: 'farm_to_table', breed: 'Angus', price: 6.50, price_type: 'per_lb', quantity: 4, state: 'TN', city: 'Cookeville', tier: 'filet', description: 'Pre-sell your beef now for November harvest. 100% grass-fed and grass-finished Black Angus beef raised on certified-clean Appalachian pastures. No hormones, no antibiotics, no grain — ever. Processed at a USDA-inspected facility. Hanging weights typically 300-350 lbs per half. Custom cut and wrapped to your specifications. Deposit required to reserve. We have been selling direct to consumers for 6 years — references available. Limited quarters and halves available.', seller: 7 },

  { title: 'Pasture-Raised Wagyu x Angus Beef — Whole/Half', category: 'farm_to_table', breed: 'Wagyu x Angus', price: 9.50, price_type: 'per_lb', quantity: 2, state: 'TX', city: 'Fredericksburg', tier: 'filet', description: 'Premium Wagyu x Angus beef, pasture-raised on our Texas Hill Country property. Animals finished on non-GMO grain for 120 days to develop extraordinary marbling. Typically grade mid-Choice to high-Choice. Processed at a USDA facility, custom cut. Whole or half available. Marbling you cannot find at the grocery store at this price point. Order now for January processing.', seller: 6 },

  { title: 'Freezer Beef — Angus Steers, Ready Now', category: 'farm_to_table', breed: 'Angus', price: 5.75, price_type: 'per_lb', quantity: 3, state: 'KS', city: 'Dodge City', tier: 'sirloin', description: 'Two Angus steers ready for processing now. Raised on our operation — same genetics as cattle we show at the Kansas State Fair. Grain-finished for 90 days. Hanging weight approximately 750-800 lbs per head. Price is per hanging weight pound, cut and wrap additional at the processor (~$0.75/lb). We can coordinate processing and pickup. This is how we eat beef ourselves.', seller: 5 },

  { title: 'Hereford x Angus Beef Share — Community Purchase', category: 'farm_to_table', breed: 'Hereford x Angus', price: 5.25, price_type: 'per_lb', quantity: 4, state: 'IN', city: 'Tipton', tier: 'sirloin', description: 'Selling beef shares for our upcoming fall harvest. Hereford x Angus steers raised on open pasture with minimal grain supplementation. Sweet corn silage and hay based ration. All calves born on our farm — we know every animal personally. Share sizes available: whole (approx 400 lbs take-home), half (approx 200 lbs), or quarter (approx 100 lbs). Processed at our family\'s USDA locker plant.', seller: 4 },

  { title: 'Lamb & Beef Combo Share — Mixed Farm', category: 'farm_to_table', price: 7.00, price_type: 'per_lb', quantity: 3, state: 'MT', city: 'Miles City', tier: 'burger', description: 'Unique combo share from our mixed operation — Angus beef and Rambouillet lamb. Get variety in your freezer from one trusted source. Both raised on native Montana range. Beef quarters from a 24-month Angus steer, lamb halves from 12-month grass-finished lambs. Processing in September. Contact for available sizes and pricing breakdown.', seller: 3 },

  // DAIRY (3)
  { title: '6 Holstein Springer Heifers — 2-4 Weeks from Calving', category: 'dairy', breed: 'Holstein', price: 1850, price_type: 'per_head', quantity: 6, weight_lbs: 1180, state: 'IN', city: 'Tipton', tier: 'sirloin', description: 'Six Holstein heifers, all springers expected to calve within 2-4 weeks. Preg checked confirmed. All tested Negative for BVD-PI, Johnes, Leukosis, and Brucellosis. Current on DA2PP, Lepto, and J-5 gram negative vaccine. These are production-quality heifers from a premium dairy operation transitioning to beef. Excellent udder attachment and teat placement observed in udder development.', seller: 4 },

  { title: 'Jersey x Holstein Nurse Cows — 3 Available', category: 'dairy', breed: 'Jersey x Holstein', price: 1400, price_type: 'per_head', quantity: 3, weight_lbs: 1050, state: 'TN', city: 'Cookeville', tier: 'burger', description: 'Three Jersey x Holstein cows, excellent nurse cows or small family milkers. All currently milking, will accept calves readily. Easy milkers — 15-20 lbs per milking twice daily. Good temperaments, halter broke, stand without kicking. Great for a homestead operation or to put calves on. Selling because we are going to a strictly beef operation.', seller: 7 },

  { title: 'Registered Brown Swiss Bull — Excellent for Crossbreeding', category: 'dairy', breed: 'Brown Swiss', price: 2800, price_type: 'fixed', quantity: 1, weight_lbs: 1650, state: 'KS', city: 'Dodge City', tier: 'sirloin', description: 'Registered Brown Swiss bull, 3 years old. Excellent for crossing on beef cows to improve milk production in replacement heifers while maintaining growth. Brown Swiss crosses are known for exceptional longevity and feed efficiency. Semen tested, good morphology. Gentle as a pet — has been around children his whole life. Papers available.', seller: 5 },

  // BOTTLE CALVES (3)
  { title: '20 Bottle Calves — Black & BWF, 3-7 Days Old', category: 'bottle_calves', breed: 'Angus x Hereford', price: 350, price_type: 'per_head', quantity: 20, weight_lbs: 95, state: 'NE', city: 'Ogallala', tier: 'burger', description: 'Fresh dairy pull calves, black and black white face, 3-7 days old. All received colostrum from dam. Strong, up and nursing. Dehorning paste applied. Perfect for a calf raising operation or to put on nurse cows. Available every week — call for availability and scheduling. Price varies slightly by age and weight.', seller: 1 },

  { title: '8 Angus Heifer Calves — 2 Weeks, Extra Colostrum', category: 'bottle_calves', breed: 'Angus', price: 475, price_type: 'per_head', quantity: 8, weight_lbs: 115, state: 'TX', city: 'Amarillo', tier: 'burger', description: 'Eight Black Angus heifer calves, 14 days old. All have been on extra colostrum for 5 days. Already transitioning to milk replacer and eating calf starter. Healthy, bright-eyed, no sickness. From a registered cow herd — good genetics. Good candidates for replacement heifers if raised out. Selling because we are over our capacity for raising calves this year.', seller: 0 },

  { title: '5 Texas Longhorn x Angus Calves — Unique Color', category: 'bottle_calves', breed: 'Longhorn x Angus', price: 400, price_type: 'per_head', quantity: 5, weight_lbs: 88, state: 'TX', city: 'Fredericksburg', tier: 'burger', description: 'Five young calves from our Longhorn x Angus cross program. Beautiful colors — roan, spotted, and brindle. 1-2 weeks old. All receiving milk replacer twice daily and doing well. These will make unique show calves or colorful additions to a cattle operation. Very thrifty and heat tolerant. Fun cattle to raise.', seller: 6 },

  // FEED & HAY (3)
  { title: '500 Round Bales Bermuda Grass Hay — 5x6, Stored Inside', category: 'feed_hay', price: 85, price_type: 'per_head', quantity: 500, state: 'OK', city: 'Woodward', tier: 'sirloin', description: '500 round bales of premium Bermuda grass hay, 5x6 rolls averaging 1,250 lbs each. Cut June 15, second cutting of the season. Baled at proper moisture (15-17%). All bales stored under cover in a hay barn — no weather damage, no spoilage. Nutrient tested — CP 12.4%, TDN 56%. Perfect for cow/calf operations, stocker cattle, or horse hay. Quantity discount available on 100+ bales. Will load for an additional charge.', seller: 2 },

  { title: '200 Small Square Bales Alfalfa — Horse Quality', category: 'feed_hay', price: 12, price_type: 'per_head', quantity: 200, state: 'MT', city: 'Miles City', tier: 'burger', description: 'Two hundred small square bales of high-quality alfalfa, 3rd cutting. Bales average 60 lbs. CP 22%, TDN 65% — tested and certified. Green color throughout, minimal leaf loss. No blister beetles. Perfect for horses, dairy cattle, or young breeding stock. Stored in dry barn. Will deliver within 50 miles for additional charge. Price is per bale.', seller: 3 },

  { title: 'Custom Cattle Mineral Program — Direct from Mill', category: 'feed_hay', price: 28, price_type: 'per_head', quantity: 50, state: 'KS', city: 'Dodge City', tier: 'burger', description: 'Selling 50 bags of our custom-formulated loose cattle mineral. Specifically formulated for High Plains cattle — addresses copper and selenium deficiencies common in this region. Contains all macro and trace minerals plus B vitamins. Same formula used by a 5,000 head stocker operation in western Kansas. 50 lb bags. Available for pickup or can arrange pallet delivery within KS, OK, TX, NE, CO. $28/bag or $25/bag on 25+.', seller: 5 },

  // SHOWSTOCK (3)
  { title: 'Reserve Grand Champion Angus Heifer — Ready to Show', category: 'showstock', breed: 'Angus', price: 8500, price_type: 'fixed', quantity: 1, weight_lbs: 850, state: 'IN', city: 'Tipton', tier: 'filet', description: 'Reserve Grand Champion Angus heifer from the 2025 Indiana State Fair junior show. Sired by a nationally ranked Angus sire. This heifer is show-ready — halter broke, stands perfectly, walks out beautiful. Currently being fitted and maintained by our show team. Would make an outstanding banner at any major junior show or open show. Serious inquiries only. Will consider trade for exceptional bull. References available.', seller: 4 },

  { title: 'Club Calf Steer Prospect — High Scoring, Thick', category: 'showstock', breed: 'Simmental x Angus', price: 3200, price_type: 'fixed', quantity: 1, weight_lbs: 680, state: 'TX', city: 'Amarillo', tier: 'ribeye', description: 'Outstanding club calf steer prospect, SimAngus genetics. 8 months old, 680 lbs. Extremely thick, deep-bodied, good length of body. Outstanding bone for his weight. Has been halter broke since 3 months — very gentle. Top genetics from a nationally competitive show cattle breeding program. Currently being fed a controlled show ration. Would score extremely well at major shows. Ready to go to your program.', seller: 0 },

  { title: '3 Show Heifer Prospects — Black Simmental, Sisters', category: 'showstock', breed: 'Simmental', price: 2800, price_type: 'per_head', quantity: 3, weight_lbs: 720, state: 'NE', city: 'Ogallala', tier: 'sirloin', description: 'Three full sisters by a top Simmental sire, dam is a proven show cow producer. All three are extremely correct, exceptional hair quality, outstanding structure. 9 months old. Any one of these could win a banner — hard to choose between them, which is why we are selling. They are halter broke and will be fitted before sale. Come evaluate in person.', seller: 1 },

  // FULL HERD (1)
  { title: 'Complete Commercial Herd Dispersal — 85 Head', category: 'full_herd', breed: 'Angus x Hereford', price: null, price_type: 'call', quantity: 85, state: 'MT', city: 'Miles City', tier: 't_bone', description: 'Complete dispersal of our commercial Angus x Hereford herd due to retirement. 85 total head: 60 cows ages 3-9, 20 heifer calves retained for replacement, 5 bulls. All cows preg checked — 58 confirmed bred, 2 open (older cows). Entire herd on same vaccination and management program for 15 years. Exceptional genetics and cattle that know how to live on native Montana range. This is a proven, producing cow herd — not a random assortment. Will sell as a complete unit only. Price on call — must be seen to be appreciated. Seller will consider financing for qualified buyers.', seller: 3 },
];

async function getOrCreateSeller(s) {
  const { rows: existing } = await query('SELECT id FROM users WHERE email=$1', [s.email]);
  if (existing.length) return existing[0].id;

  const hash = await bcrypt.hash('HerdHub2026!', 12);
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, phone, state, city, newsletter_opt_in, terms_accepted, terms_accepted_at, role)
     VALUES ($1,$2,$3,$4,$5,$6,true,true,NOW(),'user') RETURNING id`,
    [s.name, s.email, hash, s.phone, s.state, s.city]
  );
  console.log(`  Created seller: ${s.name} (id: ${rows[0].id})`);
  return rows[0].id;
}

async function geocode(city, state) {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city+', '+state+', USA')}&format=json&limit=1`,
      { headers: { 'User-Agent': 'HerdHub/1.0 seed script' } }
    );
    const data = await r.json();
    if (data.length) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch(e) {}
  return { lat: null, lng: null };
}

async function seed() {
  console.log('🌱 Starting HerdHub listing seed...\n');

  // Create seller accounts
  console.log('Creating seller accounts...');
  const sellerIds = [];
  for (const s of sellers) {
    const id = await getOrCreateSeller(s);
    sellerIds.push(id);
  }
  console.log(`✅ ${sellerIds.length} seller accounts ready\n`);

  // Insert listings
  console.log('Inserting listings...');
  let created = 0;
  let skipped = 0;

  for (const l of listings) {
    try {
      // Check if listing already exists
      const { rows: exists } = await query(
        'SELECT id FROM listings WHERE title=$1 AND user_id=$2',
        [l.title, sellerIds[l.seller]]
      );
      if (exists.length) { console.log(`  SKIP: "${l.title}"`); skipped++; continue; }

      const tier = l.tier || 'burger';
      const isFeatured = ['sirloin','ribeye','filet','t_bone'].includes(tier);
      const days = (tier === 't_bone' || tier === 'ribeye') ? 90 : 30;
      const expiresAt = new Date(Date.now() + days * 86400000);

      const { rows } = await query(
        `INSERT INTO listings
           (user_id, title, description, category, breed,
            price, price_type, quantity, weight_lbs,
            state, city, tier, is_featured, status,
            expires_at, payment_status, lat, lng)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active',$14,$15,$16,$17)
         RETURNING id`,
        [
          sellerIds[l.seller],
          l.title,
          l.description,
          l.category,
          l.breed || null,
          l.price || null,
          l.price_type || 'fixed',
          l.quantity || 1,
          l.weight_lbs || null,
          l.state,
          l.city,
          tier,
          isFeatured,
          expiresAt,
          tier === 'burger' ? 'free' : 'paid',
          null, null  // lat/lng geocoded below
        ]
      );

      const listingId = rows[0].id;

      // Geocode async
      const geo = await geocode(l.city, l.state);
      if (geo.lat) {
        await query('UPDATE listings SET lat=$1, lng=$2 WHERE id=$3', [geo.lat, geo.lng, listingId]);
      }

      // Add a search vector update
      await query(
        `UPDATE listings SET search_vector =
           setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
           setweight(to_tsvector('english', coalesce(breed,'')), 'B') ||
           setweight(to_tsvector('english', coalesce(category,'')), 'B') ||
           setweight(to_tsvector('english', coalesce(city,'')), 'C') ||
           setweight(to_tsvector('english', coalesce(state,'')), 'C') ||
           setweight(to_tsvector('english', coalesce(description,'')), 'D')
         WHERE id=$1`,
        [listingId]
      );

      console.log(`  ✅ [${tier.padEnd(10)}] ${l.title}`);
      created++;

      // Small delay to be respectful to Nominatim
      await new Promise(r => setTimeout(r, 1100));

    } catch(e) {
      console.error(`  ❌ Failed: "${l.title}" — ${e.message}`);
    }
  }

  console.log(`\n🎉 Done! Created: ${created} | Skipped: ${skipped}\n`);
  console.log('Breakdown by tier:');
  const { rows: tiers } = await query(
    `SELECT tier, COUNT(*) as c FROM listings WHERE status='active' GROUP BY tier ORDER BY c DESC`
  );
  tiers.forEach(t => console.log(`  ${t.tier.padEnd(12)} ${t.c} listings`));

  await pool.end();
}

seed().catch(e => { console.error(e); process.exit(1); });
