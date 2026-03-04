-- Migration 003: Multi-tenant Room Management
-- Creates user-room subscription table and admin role support

-- Add role field to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';

-- Create admin user if not exists (default admin account)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users WHERE email = 'admin@localhost') THEN
        INSERT INTO users (email, password_hash, nickname, role, email_verified)
        VALUES ('admin@localhost', 
                -- Default password: admin123 (PBKDF2 hash, CHANGE IN PRODUCTION!)
                'pbkdf2:sha256:600000$salt$fakehashdontuseinproduction',
                '管理员', 'admin', true);
    END IF;
END $$;

-- User-Room subscription table
-- Allows multiple users to subscribe to the same room
CREATE TABLE IF NOT EXISTS user_room (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL,              -- TikTok username (matches room.room_id)
    alias VARCHAR(100),                 -- User-defined alias for this room
    notes TEXT,                         -- User notes about this room
    is_enabled BOOLEAN DEFAULT TRUE,    -- User's enable/disable toggle
    notify_on_live BOOLEAN DEFAULT FALSE,  -- Notify when room goes live
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, room_id)            -- Prevent duplicate subscriptions
);

CREATE INDEX IF NOT EXISTS idx_user_room_user ON user_room(user_id);
CREATE INDEX IF NOT EXISTS idx_user_room_room ON user_room(room_id);

-- View to get rooms with subscriber count (for monitoring decisions)
CREATE OR REPLACE VIEW room_subscribers AS
SELECT 
    room_id,
    COUNT(*) as subscriber_count,
    COUNT(*) FILTER (WHERE is_enabled) as active_subscribers,
    MAX(created_at) as last_subscribed_at
FROM user_room
GROUP BY room_id;

-- Function to check if a room should be monitored (has active subscribers)
CREATE OR REPLACE FUNCTION should_monitor_room(p_room_id TEXT)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM user_room 
        WHERE room_id = p_room_id AND is_enabled = TRUE
    );
END;
$$ LANGUAGE plpgsql;

-- Track this migration
INSERT INTO schema_migrations (version) VALUES ('003_multi_tenant') ON CONFLICT DO NOTHING;
