-- Warranty Claims (Phase 5 of Returns/Exchange/Warranty spec)
-- Purely additive: one new column + one new table. No drops, no data loss.
-- Run this on the Supabase Postgres database before deploying the updated backend.

-- Nullable — unset for virtually every catalog row today (never populated on bulk
-- import). Null means "unknown", not "no warranty".
ALTER TABLE master_parts ADD COLUMN IF NOT EXISTS warranty_months INTEGER;

CREATE TABLE IF NOT EXISTS warranty_claims (
  claim_id            SERIAL PRIMARY KEY,
  claim_no            VARCHAR(60) NOT NULL UNIQUE,
  shop_id             INTEGER NOT NULL REFERENCES shops(shop_id),
  original_invoice_id INTEGER NOT NULL REFERENCES invoices(invoice_id),
  invoice_item_id     INTEGER NOT NULL REFERENCES invoice_items(item_id),
  inventory_id        INTEGER NOT NULL REFERENCES shop_inventory(inventory_id),
  batch_id            INTEGER REFERENCES stock_batches(batch_id),
  qty                 INTEGER NOT NULL DEFAULT 1,
  status              VARCHAR(30) NOT NULL DEFAULT 'SENT_TO_SUPPLIER', -- SENT_TO_SUPPLIER | APPROVED | REJECTED | REPLACEMENT_RECEIVED | RETURNED_TO_CUSTOMER
  party_id            INTEGER REFERENCES parties(party_id),
  sent_date           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_date       TIMESTAMPTZ,
  notes               TEXT,
  version             INTEGER NOT NULL DEFAULT 0,
  created_by          INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_shop_status ON warranty_claims (shop_id, status);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_invoice     ON warranty_claims (original_invoice_id);
