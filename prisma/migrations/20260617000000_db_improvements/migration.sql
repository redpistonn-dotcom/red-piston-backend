-- RedPiston DB Improvements Migration
-- Run this on your Supabase/Neon PostgreSQL database BEFORE deploying the updated backend.
-- All statements use IF NOT EXISTS / IF EXISTS so re-running is safe.

-- ── 1. Movement: make inventoryId nullable ────────────────────────────────────
ALTER TABLE movements ALTER COLUMN inventory_id DROP NOT NULL;

-- ── 2. Movement: add denormalized display columns ────────────────────────────
ALTER TABLE movements ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE movements ADD COLUMN IF NOT EXISTS party_name     TEXT;
ALTER TABLE movements ADD COLUMN IF NOT EXISTS payment_mode   TEXT;

-- ── 3. Movement: add invoiceId index ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_movements_invoice_id ON movements(invoice_id);

-- ── 4. MarketplaceReview: add inventoryId and userId indexes ──────────────────
CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_inventory_id ON marketplace_reviews(inventory_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_user_id      ON marketplace_reviews(user_id);

-- ── 5. RefreshToken: add expiresAt index (for nightly cleanup) ───────────────
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);

-- ── 6. OtpCode: add expiresAt index (for nightly cleanup) ────────────────────
CREATE INDEX IF NOT EXISTS idx_otp_codes_expires_at ON otp_codes(expires_at);

-- ── 7. ConfirmFitRequest: compound index on shopId + status ──────────────────
CREATE INDEX IF NOT EXISTS idx_confirm_fit_requests_shop_status ON confirm_fit_requests(shop_id, status);

-- ── 8. PurchaseBill: compound index on shopId + status ───────────────────────
CREATE INDEX IF NOT EXISTS idx_purchase_bills_shop_status ON purchase_bills(shop_id, status);

-- ── 9. Party: add soft-delete timestamp column ───────────────────────────────
ALTER TABLE parties ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP(3);

-- ── 10. ShopInventory: add soft-delete timestamp column ──────────────────────
ALTER TABLE shop_inventory ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP(3);

-- ── 11. ShopVehicle → Party FK (SET NULL on party delete) ────────────────────
-- Clean up any dangling owner_id values that don't map to a real party:
UPDATE shop_vehicles SET owner_id = NULL
  WHERE owner_id IS NOT NULL
    AND owner_id NOT IN (SELECT party_id FROM parties);
-- Add the FK:
ALTER TABLE shop_vehicles
  DROP CONSTRAINT IF EXISTS fk_shop_vehicles_owner;
ALTER TABLE shop_vehicles
  ADD CONSTRAINT fk_shop_vehicles_owner
  FOREIGN KEY (owner_id) REFERENCES parties(party_id) ON DELETE SET NULL;

-- ── 12. NumberCounter → Shop FK (CASCADE delete) ─────────────────────────────
ALTER TABLE number_counters
  DROP CONSTRAINT IF EXISTS fk_number_counters_shop;
ALTER TABLE number_counters
  ADD CONSTRAINT fk_number_counters_shop
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id) ON DELETE CASCADE;

-- ── 13. MasterPart: ensure oemNumbers and barcodes are proper text[] arrays ──
-- Convert any NULL values to empty arrays, set defaults, ensure NOT NULL:
UPDATE master_parts SET oem_numbers = '{}' WHERE oem_numbers IS NULL;
UPDATE master_parts SET barcodes    = '{}' WHERE barcodes IS NULL;
ALTER TABLE master_parts ALTER COLUMN oem_numbers SET DEFAULT '{}';
ALTER TABLE master_parts ALTER COLUMN barcodes    SET DEFAULT '{}';
ALTER TABLE master_parts ALTER COLUMN oem_numbers SET NOT NULL;
ALTER TABLE master_parts ALTER COLUMN barcodes    SET NOT NULL;

-- ── 14. GIN indexes for fast OEM/barcode array lookups ───────────────────────
CREATE INDEX IF NOT EXISTS idx_master_parts_oem_gin      ON master_parts USING GIN(oem_numbers);
CREATE INDEX IF NOT EXISTS idx_master_parts_barcodes_gin ON master_parts USING GIN(barcodes);
