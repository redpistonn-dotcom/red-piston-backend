-- Sales Return + Credit Note engine (Phase 1 + 2 of Returns/Exchange/Warranty spec)
-- Purely additive: new nullable/defaulted columns + new tables. No drops, no data loss.
-- Run this on the Supabase Postgres database before deploying the updated backend.

-- ── 1. Shop: per-shop return policy window (days) ────────────────────────────
ALTER TABLE shops ADD COLUMN IF NOT EXISTS return_policy_days INTEGER NOT NULL DEFAULT 30;

-- ── 2. ShopInventory: damaged-stock bucket, sibling to stock_qty ─────────────
-- Fungible bulk stock needs a separate quantity counter (not a status flag) so a
-- shop can carry both sellable and damaged units of the same SKU simultaneously.
ALTER TABLE shop_inventory ADD COLUMN IF NOT EXISTS damaged_qty INTEGER NOT NULL DEFAULT 0;

-- ── 3. StockBatch: per-lot/serial status ─────────────────────────────────────
-- AVAILABLE | DAMAGED | WARRANTY | RETURNED_TO_SUPPLIER | SCRAPPED
ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE';

-- ── 4. Credit notes (customer-side GST/commercial credit notes) ─────────────
-- Created first — sales_returns.credit_note_id references it.
CREATE TABLE IF NOT EXISTS credit_notes (
  credit_note_id       SERIAL PRIMARY KEY,
  credit_note_no       VARCHAR(60) NOT NULL UNIQUE,
  shop_id              INTEGER NOT NULL REFERENCES shops(shop_id),
  type                 VARCHAR(20) NOT NULL,                 -- GST | COMMERCIAL
  linked_invoice_id    INTEGER NOT NULL REFERENCES invoices(invoice_id),
  party_id             INTEGER REFERENCES parties(party_id),
  issue_date           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  taxable_value        NUMERIC(10,2) NOT NULL,
  cgst                 NUMERIC(10,2) NOT NULL,
  sgst                 NUMERIC(10,2) NOT NULL,
  igst                 NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_amount         NUMERIC(10,2) NOT NULL,
  status               VARCHAR(20) NOT NULL DEFAULT 'UNUSED', -- UNUSED | PARTIALLY_USED | FULLY_USED | REFUNDED
  remaining_balance    NUMERIC(10,2) NOT NULL,
  gst_period_declared  VARCHAR(7),                            -- "YYYY-MM", set only when type=GST
  reason               TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_notes_shop_issue_date ON credit_notes (shop_id, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_credit_notes_shop_type       ON credit_notes (shop_id, type);
CREATE INDEX IF NOT EXISTS idx_credit_notes_shop_status     ON credit_notes (shop_id, status);

-- ── 5. Sales returns (header) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_returns (
  return_id            SERIAL PRIMARY KEY,
  return_no            VARCHAR(60) NOT NULL UNIQUE,
  shop_id              INTEGER NOT NULL REFERENCES shops(shop_id),
  original_invoice_id  INTEGER NOT NULL REFERENCES invoices(invoice_id),
  party_id             INTEGER REFERENCES parties(party_id),
  reason               VARCHAR(30) NOT NULL,                  -- WRONG_PART | DEFECTIVE | WARRANTY | CHANGED_MIND | OTHER
  requires_approval    BOOLEAN NOT NULL DEFAULT false,
  approved_by          INTEGER,
  status               VARCHAR(20) NOT NULL DEFAULT 'COMPLETED', -- PENDING_APPROVAL | COMPLETED | CANCELLED
  refund_mode          VARCHAR(20),                            -- CASH | UPI | BANK | STORE_CREDIT
  credit_note_id       INTEGER UNIQUE REFERENCES credit_notes(credit_note_id),
  notes                TEXT,
  created_by           INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sales_returns_shop_created ON sales_returns (shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_returns_invoice      ON sales_returns (original_invoice_id);
CREATE INDEX IF NOT EXISTS idx_sales_returns_party        ON sales_returns (party_id);

-- ── 6. Sales return line items ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_return_items (
  item_id          SERIAL PRIMARY KEY,
  return_id        INTEGER NOT NULL REFERENCES sales_returns(return_id) ON DELETE CASCADE,
  inventory_id     INTEGER NOT NULL REFERENCES shop_inventory(inventory_id),
  invoice_item_id  INTEGER NOT NULL REFERENCES invoice_items(item_id),
  qty              INTEGER NOT NULL,
  condition        VARCHAR(20) NOT NULL,                      -- SEALED | GOOD | DAMAGED | USED
  disposition      VARCHAR(20) NOT NULL,                      -- RESELLABLE | DAMAGED_STOCK
  unit_price       NUMERIC(10,2) NOT NULL,
  taxable_value    NUMERIC(10,2) NOT NULL,
  gst_rate         NUMERIC(5,2) NOT NULL,
  cgst             NUMERIC(10,2) NOT NULL,
  sgst             NUMERIC(10,2) NOT NULL,
  igst             NUMERIC(10,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sales_return_items_return  ON sales_return_items (return_id);
CREATE INDEX IF NOT EXISTS idx_sales_return_items_invitem ON sales_return_items (invoice_item_id);
