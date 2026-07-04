-- Purely additive: three new nullable/defaulted columns. No drops, no data loss.
-- Run this on the Supabase Postgres database before deploying the updated backend.

-- MRP (Maximum Retail Price) — independent ceiling price, separate from selling_price.
ALTER TABLE shop_inventory ADD COLUMN IF NOT EXISTS mrp DECIMAL(10, 2);

-- Customer-facing nickname — distinct from custom_part_name. Set only from the
-- Manual Entry "Part Name" field (master_parts.part_name there holds the OEM name).
ALTER TABLE shop_inventory ADD COLUMN IF NOT EXISTS nickname VARCHAR(255);

-- Guards the PartyLedger PURCHASE_RETURN_CREDIT entry so it's written exactly once,
-- the first time resolution transitions to SUPPLIER_CREDIT.
ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS credit_ledger_posted BOOLEAN NOT NULL DEFAULT FALSE;
