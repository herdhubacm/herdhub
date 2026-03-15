-- Migration 002: Add bucking_bulls category
-- The listings table uses a CHECK constraint on category.
-- We drop and recreate it to include the new value.
-- Safe to run once on Railway PostgreSQL.

ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_category_check;

ALTER TABLE listings ADD CONSTRAINT listings_category_check
  CHECK (category IN (
    'bulls','bucking_bulls','bred_heifers','bred_cows','open_heifers','open_cows',
    'feeder_stocker','fat_cattle','bottle_calves','cow_calf_pairs',
    'embryos','semen','showstock','dairy',
    'equipment','trailers','chutes_pens','working_dogs','feed_hay',
    'sale_barns','ranches_farms','breed_associations',
    'farm_to_table','livestock_services','feed_stores',
    'insurance_finance','full_herd'
  ));
