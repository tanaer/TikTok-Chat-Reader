-- Migration 007: Add missing price_quarterly to room_addon_packages
-- Root cause: pricing.html and subscription.js query price_quarterly but column didn't exist

ALTER TABLE room_addon_packages ADD COLUMN IF NOT EXISTS price_quarterly INTEGER;

-- Backfill: quarterly = monthly * 3 * 0.85 (15% discount)
UPDATE room_addon_packages SET price_quarterly = ROUND(price_monthly * 3 * 0.85) WHERE price_quarterly IS NULL;

-- Track this migration
INSERT INTO schema_migrations (version) VALUES ('007_fix_addon_pricing') ON CONFLICT DO NOTHING;
