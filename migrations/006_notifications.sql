-- Migration 006: Notifications + Disable Free Tier
-- Adds notification system and removes free plan

-- 1. Notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL,        -- expiry_warning/balance_low/auto_renew_success/auto_renew_fail/room_disabled
    title VARCHAR(200) NOT NULL,
    content TEXT,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;

-- 2. Disable free plan (users must purchase to use)
UPDATE subscription_plans SET is_active = false WHERE code = 'free';

-- Track this migration
INSERT INTO schema_migrations (version) VALUES ('006_notifications') ON CONFLICT DO NOTHING;
