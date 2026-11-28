/**
 * 0007_farm_to_table_split — Farm to Table becomes two categories (2026-11-27).
 *   category 'processors'   new: processors and lockers, for producers. Buy Beef keeps 'farm_to_table'.
 *   proc_inspection TEXT[]  usda | state | custom_exempt
 *   proc_species    TEXT[]  beef | hogs | sheep_goats | bison | deer_game | poultry
 *   proc_services   TEXT[]  slaughter | mobile_slaughter | cut_wrap | sausage | smoking_curing | dry_aging | vacuum_pack
 *   proc_lead_weeks INTEGER how far out they are booking, in weeks (0 = taking animals now)
 *   proc_haul       BOOLEAN they can pick up live animals
 *   proc_capacity   INTEGER head per week (optional)
 *   price_type      adds 'per_lb_hanging' (beef sold by hanging weight).
 * Both checks are NOT VALID: new and changed rows are checked; legacy rows can't fail the migration.
 */
const CATEGORIES = ['bulls','bucking_bulls','bred_heifers','bred_cows','open_heifers','open_cows',
  'feeder_stocker','fat_cattle','bottle_calves','cow_calf_pairs','embryos','semen','showstock','dairy',
  'equipment','trailers','chutes_pens','working_dogs','feed_hay','sale_barns','ranches_farms','breed_associations',
  'farm_to_table','processors','livestock_services','feed_stores','insurance_finance','full_herd'];
const PRICE_TYPES = ['fixed','negotiable','obo','call','per_head','per_lb','per_cwt','firm','each','per_pair','per_lb_hanging'];
const list = a => a.map(v => `'${v}'`).join(',');

module.exports = {
  async up(query) {
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS proc_inspection TEXT[]`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS proc_species TEXT[]`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS proc_services TEXT[]`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS proc_lead_weeks INTEGER`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS proc_haul BOOLEAN NOT NULL DEFAULT FALSE`);
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS proc_capacity INTEGER`);
    await query(`ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_category_check`);
    await query(`ALTER TABLE listings ADD CONSTRAINT listings_category_check CHECK (category IN (${list(CATEGORIES)})) NOT VALID`);
    await query(`ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_price_type_check`);
    await query(`ALTER TABLE listings ADD CONSTRAINT listings_price_type_check CHECK (price_type IN (${list(PRICE_TYPES)})) NOT VALID`);
    console.log('✅  0007: processors category and fields ready; per_lb_hanging allowed');
  },
};
