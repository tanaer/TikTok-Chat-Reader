-- Migration 002: AI Credits and Pricing Update
-- Adds AI usage credits to subscriptions

-- Add ai_credits_monthly to subscription_plans
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS ai_credits_monthly INTEGER DEFAULT 0;

-- Add ai_credits_remaining to user_subscriptions
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS ai_credits_remaining INTEGER DEFAULT 0;
ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS ai_credits_used INTEGER DEFAULT 0;

-- AI credit purchase packages table
CREATE TABLE IF NOT EXISTS ai_credit_packages (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    credits INTEGER NOT NULL,
    price_cents INTEGER NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- AI usage log
CREATE TABLE IF NOT EXISTS ai_usage_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    usage_type VARCHAR(50) NOT NULL,  -- 'user_analysis', 'chat_summary', etc.
    credits_used INTEGER DEFAULT 1,
    target_id TEXT,  -- e.g., userId being analyzed
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage_log(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_date ON ai_usage_log(created_at);

-- Update existing subscription plans with AI credits
UPDATE subscription_plans SET ai_credits_monthly = 10 WHERE code = 'free';
UPDATE subscription_plans SET ai_credits_monthly = 50 WHERE code = 'basic';
UPDATE subscription_plans SET ai_credits_monthly = 200 WHERE code = 'pro';
UPDATE subscription_plans SET ai_credits_monthly = 1000 WHERE code = 'enterprise';

-- Also update feature flags: all features open for all plans
UPDATE subscription_plans SET feature_flags = jsonb_set(
    COALESCE(feature_flags, '{}'::jsonb),
    '{export}', 'true'::jsonb
);
UPDATE subscription_plans SET feature_flags = jsonb_set(
    COALESCE(feature_flags, '{}'::jsonb),
    '{advanced_stats}', 'true'::jsonb
);

-- Insert AI credit packages
INSERT INTO ai_credit_packages (name, credits, price_cents, description) VALUES
    ('基础包', 100, 1000, '100次AI分析额度'),
    ('标准包', 500, 4000, '500次AI分析额度，省20%'),
    ('专业包', 1500, 9000, '1500次AI分析额度，省40%')
ON CONFLICT DO NOTHING;

-- Track this migration
INSERT INTO schema_migrations (version) VALUES ('002_ai_credits') ON CONFLICT DO NOTHING;
