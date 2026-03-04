-- ============================================
-- TikTok Monitor SaaS - Database Migration 001
-- Users, Subscriptions, Payments
-- ============================================

-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    nickname VARCHAR(100),
    avatar_url TEXT,
    phone VARCHAR(20),
    status VARCHAR(20) DEFAULT 'active',  -- active, suspended, deleted
    email_verified BOOLEAN DEFAULT false,
    last_login_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 用户表索引
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- 订阅方案表
CREATE TABLE IF NOT EXISTS subscription_plans (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,            -- 免费版/基础版/专业版/企业版
    code VARCHAR(20) UNIQUE NOT NULL,     -- free/basic/pro/enterprise
    price_monthly INTEGER DEFAULT 0,      -- 月价(分)
    price_quarterly INTEGER DEFAULT 0,    -- 季价(分)
    price_semiannual INTEGER DEFAULT 0,   -- 半年价(分)
    price_annual INTEGER DEFAULT 0,       -- 年价(分)
    room_limit INTEGER DEFAULT 1,         -- 房间数量限制 (-1 = 无限)
    history_days INTEGER DEFAULT 7,       -- 历史数据保留天数 (-1 = 无限)
    api_rate_limit INTEGER DEFAULT 60,    -- API 每分钟调用限制
    feature_flags JSONB DEFAULT '{}',     -- 功能开关
    sort_order INTEGER DEFAULT 0,         -- 排序顺序
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 用户订阅表
CREATE TABLE IF NOT EXISTS user_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),
    billing_cycle VARCHAR(20) NOT NULL,   -- monthly/quarterly/semiannual/annual
    start_date TIMESTAMP NOT NULL,
    end_date TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'active',  -- active/expired/cancelled/pending
    auto_renew BOOLEAN DEFAULT true,
    cancelled_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 订阅表索引
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_end_date ON user_subscriptions(end_date);

-- 支付记录表
CREATE TABLE IF NOT EXISTS payment_records (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription_id INTEGER REFERENCES user_subscriptions(id) ON DELETE SET NULL,
    order_no VARCHAR(64) UNIQUE NOT NULL, -- 内部订单号
    amount INTEGER NOT NULL,              -- 金额(分)
    currency VARCHAR(10) DEFAULT 'CNY',
    payment_method VARCHAR(50),           -- alipay/wxpay/stripe/manual
    transaction_id VARCHAR(255),          -- 第三方交易号
    status VARCHAR(20) DEFAULT 'pending', -- pending/paid/failed/refunded/cancelled
    paid_at TIMESTAMP,
    refunded_at TIMESTAMP,
    refund_amount INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}',          -- 额外信息
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 支付表索引
CREATE INDEX IF NOT EXISTS idx_payment_records_user ON payment_records(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_records_order ON payment_records(order_no);
CREATE INDEX IF NOT EXISTS idx_payment_records_status ON payment_records(status);

-- 刷新令牌表 (用于 JWT refresh token)
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    revoked BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- 密码重置令牌表
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);

-- ============================================
-- 初始数据: 订阅方案
-- ============================================

INSERT INTO subscription_plans (name, code, price_monthly, price_quarterly, price_semiannual, price_annual, room_limit, history_days, api_rate_limit, feature_flags, sort_order, description)
VALUES 
    ('免费版', 'free', 0, 0, 0, 0, 1, 7, 30, 
     '{"export": false, "ai_analysis": false, "api_access": false}', 
     1, '体验基础监控功能'),
    
    ('基础版', 'basic', 2900, 7900, 14900, 26900, 5, 30, 60, 
     '{"export": true, "ai_analysis": false, "api_access": false}', 
     2, '适合个人主播或小团队'),
    
    ('专业版', 'pro', 9900, 26900, 49900, 89900, 20, -1, 120, 
     '{"export": true, "ai_analysis": true, "api_access": true}', 
     3, '适合专业MCN机构'),
    
    ('企业版', 'enterprise', 29900, 79900, 149900, 269900, -1, -1, -1, 
     '{"export": true, "ai_analysis": true, "api_access": true, "white_label": true, "priority_support": true}', 
     4, '无限制，专属支持')
ON CONFLICT (code) DO NOTHING;

-- ============================================
-- 修改现有表: room 添加 user_id 关联
-- ============================================

-- 添加 user_id 列到 room 表 (如果不存在)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'room' AND column_name = 'user_id'
    ) THEN
        ALTER TABLE room ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
        CREATE INDEX idx_room_user ON room(user_id);
    END IF;
END $$;

-- ============================================
-- 迁移记录表 (跟踪已执行的迁移)
-- ============================================

CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(50) PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO schema_migrations (version) VALUES ('001_saas_schema')
ON CONFLICT (version) DO NOTHING;
