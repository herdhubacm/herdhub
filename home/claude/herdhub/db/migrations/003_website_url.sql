-- Migration 003: Add website_url to listings table
ALTER TABLE listings ADD COLUMN IF NOT EXISTS website_url TEXT;
