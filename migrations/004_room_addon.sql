-- Migration 004: Room Addon Packages
-- Allows users to purchase additional room slots beyond their plan limit

-- Room addon package definitions
CREATE TABLE IF NOT EXISTS room_addon_packages (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    room_count INTEGER NOT NULL,        -- Number of extra rooms
    price_monthly INTEGER NOT NULL,     -- Monthly price in cents (分)
    price_annual INTEGER NOT NULL,      -- Annual price in cents (分)
    is_active BOOLEAN DEFAULT TRUE,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- User purchased addons
CREATE TABLE IF NOT EXISTS user_room_addons (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    package_id INTEGER NOT NULL REFERENCES room_addon_packages(id),
    order_no VARCHAR(64),               -- Associated payment order
    billing_cycle VARCHAR(20) NOT NULL, -- monthly/annual
    start_date TIMESTAMP NOT NULL,
    end_date TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'active', -- active/expired/cancelled
    auto_renew BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_room_addons_user ON user_room_addons(user_id);
CREATE INDEX IF NOT EXISTS idx_user_room_addons_status ON user_room_addons(status);

-- Insert default addon packages
INSERT INTO room_addon_packages (name, room_count, price_monthly, price_annual, sort_order) VALUES
    ('小型包 (+5间)', 5, 1900, 19000, 1),
    ('中型包 (+20间)', 20, 5900, 59000, 2),
    ('大型包 (+50间)', 50, 11900, 119000, 3)
ON CONFLICT DO NOTHING;

-- Track this migration
INSERT INTO schema_migrations (version) VALUES ('004_room_addon') ON CONFLICT DO NOTHING;
