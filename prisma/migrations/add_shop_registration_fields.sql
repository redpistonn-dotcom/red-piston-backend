-- Add missing shop registration fields
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS shop_category     TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_number   TEXT,
  ADD COLUMN IF NOT EXISTS operating_hours   JSONB,
  ADD COLUMN IF NOT EXISTS photo_url         TEXT;

-- Add name to users table index for faster customer lookup
CREATE INDEX IF NOT EXISTS idx_users_name ON users(name);
