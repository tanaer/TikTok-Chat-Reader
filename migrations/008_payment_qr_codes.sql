-- ============================================
-- Payment QR Codes Table
-- For fixed code payment channel
-- ============================================

CREATE TABLE IF NOT EXISTS payment_qr_codes (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100),                -- 二维码名称，如"支付宝收款码"
    image_data TEXT,                  -- Base64 编码的图片数据
    image_url TEXT,                   -- 图片URL路径（可选）
    payment_type VARCHAR(20) DEFAULT 'fixed_qr',  -- alipay/wxpay/fixed_qr
    is_active BOOLEAN DEFAULT true,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_qr_codes_active ON payment_qr_codes(is_active);
CREATE INDEX IF NOT EXISTS idx_payment_qr_codes_sort ON payment_qr_codes(sort_order);

-- Migration record
INSERT INTO schema_migrations (version) VALUES ('008_payment_qr_codes')
ON CONFLICT (version) DO NOTHING;
