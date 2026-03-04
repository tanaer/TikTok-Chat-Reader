-- Migration 005: Balance System
-- Adds user balance, balance change log, quarterly pricing

-- 1. Add balance column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS balance INTEGER DEFAULT 0;

-- 2. Balance change log table
CREATE TABLE IF NOT EXISTS balance_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL,           -- recharge/purchase/refund/admin_adjust
    amount INTEGER NOT NULL,              -- Change amount (cents), positive=income, negative=expense
    balance_after INTEGER NOT NULL,       -- Balance after change
    description TEXT,
    ref_order_no VARCHAR(64),             -- Related order number
    operator_id INTEGER,                  -- Admin user ID when admin adjusts
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_balance_log_user ON balance_log(user_id);
CREATE INDEX IF NOT EXISTS idx_balance_log_type ON balance_log(type);
CREATE INDEX IF NOT EXISTS idx_balance_log_date ON balance_log(created_at);

-- 3. Add quarterly price columns
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_quarterly INTEGER DEFAULT 0;
ALTER TABLE room_addon_packages ADD COLUMN IF NOT EXISTS price_quarterly INTEGER DEFAULT 0;

-- 4. Update subscription plan prices (monthly / quarterly ~15% off / annual ~25% off)
UPDATE subscription_plans SET 
    price_monthly = 0, price_quarterly = 0, price_annual = 0
WHERE code = 'free';

UPDATE subscription_plans SET 
    price_monthly = 2900, price_quarterly = 7400, price_annual = 25900
WHERE code = 'basic';

UPDATE subscription_plans SET 
    price_monthly = 9900, price_quarterly = 24900, price_annual = 89900
WHERE code = 'pro';

UPDATE subscription_plans SET 
    price_monthly = 29900, price_quarterly = 75900, price_annual = 269900
WHERE code = 'enterprise';

-- 5. Update room addon package prices with quarterly
UPDATE room_addon_packages SET price_quarterly = 4800 WHERE room_count = 5;
UPDATE room_addon_packages SET price_quarterly = 14900 WHERE room_count = 20;
UPDATE room_addon_packages SET price_quarterly = 29900 WHERE room_count = 50;

-- Track this migration
INSERT INTO schema_migrations (version) VALUES ('005_balance_system') ON CONFLICT DO NOTHING;
