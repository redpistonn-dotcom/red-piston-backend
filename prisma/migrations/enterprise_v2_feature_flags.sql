-- Enterprise v2: Feature flags table
CREATE TABLE IF NOT EXISTS feature_flags (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  enabled_for_all BOOLEAN NOT NULL DEFAULT false,
  enabled_shop_ids INTEGER[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO feature_flags (key, description, is_active, enabled_for_all)
VALUES ('bulk_stock_upload', 'Bulk stock CSV upload', true, true)
ON CONFLICT (key) DO NOTHING;
