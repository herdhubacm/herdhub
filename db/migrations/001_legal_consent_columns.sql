-- Migration 001: Add legal consent columns to users table
-- Run once on Railway PostgreSQL before deploying the updated auth route
-- Safe to run multiple times — uses IF NOT EXISTS / DO blocks

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='users' AND column_name='terms_accepted'
  ) THEN
    ALTER TABLE users ADD COLUMN terms_accepted     BOOLEAN     NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN terms_accepted_at  TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN newsletter_opt_in  BOOLEAN     NOT NULL DEFAULT FALSE;
    RAISE NOTICE 'Legal consent columns added to users table.';
  ELSE
    RAISE NOTICE 'Legal consent columns already exist — skipping.';
  END IF;
END $$;
