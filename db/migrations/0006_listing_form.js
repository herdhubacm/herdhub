/**
 * 0006_listing_form — the step-by-step listing form (2026-11-23).
 *   contact_pref  how buyers reach the seller on this listing:
 *                 'message' (Herd Hub messages only, phone hidden),
 *                 'phone' or 'either' (phone shown to signed-in buyers).
 *                 Existing listings default to 'either', which is how they behave today.
 *   price_type    adds 'each' (semen straws, embryos, single items) and
 *                 'per_pair' (cow/calf pairs) to the allowed units. NOT VALID: new and
 *                 changed rows are checked; any odd legacy value can't fail the migration.
 */
module.exports = {
  async up(query) {
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS contact_pref TEXT NOT NULL DEFAULT 'either'`);
    await query(`ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_contact_pref_check`);
    await query(`ALTER TABLE listings ADD CONSTRAINT listings_contact_pref_check
                   CHECK (contact_pref IN ('message','phone','either'))`);
    await query(`ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_price_type_check`);
    await query(`ALTER TABLE listings ADD CONSTRAINT listings_price_type_check
                   CHECK (price_type IN ('fixed','negotiable','obo','call','per_head','per_lb','per_cwt','firm','each','per_pair')) NOT VALID`);
    console.log('✅  0006: listings.contact_pref ready; price types each and per_pair allowed');
  },
};
