-- Purchase Return (Phase 3 of Returns/Exchange/Warranty spec)
-- Purely additive: new tables only. No drops, no data loss.
-- Run this on the Supabase Postgres database before deploying the updated backend.

CREATE TABLE IF NOT EXISTS purchase_returns (
  return_id               SERIAL PRIMARY KEY,
  return_no               VARCHAR(60) NOT NULL UNIQUE,
  shop_id                 INTEGER NOT NULL REFERENCES shops(shop_id),
  original_bill_id        INTEGER NOT NULL REFERENCES purchase_bills(bill_id),
  party_id                INTEGER REFERENCES parties(party_id),
  supplier_name           VARCHAR(255),
  supplier_gstin          VARCHAR(20),
  reason                  VARCHAR(30) NOT NULL,                    -- DAMAGED | WRONG_ITEM | EXCESS_SUPPLY | QUALITY_ISSUE
  resolution              VARCHAR(20) NOT NULL DEFAULT 'PENDING',   -- PENDING | SUPPLIER_REFUND | SUPPLIER_CREDIT | REPLACEMENT
  supplier_credit_note_no VARCHAR(60),
  status                  VARCHAR(20) NOT NULL DEFAULT 'COMPLETED', -- COMPLETED | CANCELLED
  notes                   TEXT,
  version                 INTEGER NOT NULL DEFAULT 0,
  created_by              INTEGER,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_shop_created ON purchase_returns (shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_bill         ON purchase_returns (original_bill_id);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_shop_resol   ON purchase_returns (shop_id, resolution);

CREATE TABLE IF NOT EXISTS purchase_return_items (
  item_id            SERIAL PRIMARY KEY,
  return_id          INTEGER NOT NULL REFERENCES purchase_returns(return_id) ON DELETE CASCADE,
  inventory_id       INTEGER NOT NULL REFERENCES shop_inventory(inventory_id),
  source_movement_id INTEGER NOT NULL REFERENCES movements(movement_id),
  qty                INTEGER NOT NULL,
  unit_price         NUMERIC(10,2) NOT NULL,
  taxable_value      NUMERIC(10,2) NOT NULL,
  gst_rate           NUMERIC(5,2) NOT NULL,
  cgst               NUMERIC(10,2) NOT NULL,
  sgst               NUMERIC(10,2) NOT NULL,
  igst               NUMERIC(10,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_purchase_return_items_return ON purchase_return_items (return_id);
CREATE INDEX IF NOT EXISTS idx_purchase_return_items_srcmv  ON purchase_return_items (source_movement_id);
