-- Exchange Orders (Phase 4 of Returns/Exchange/Warranty spec)
-- Purely additive: one new table only. No drops, no data loss.
-- Run this on the Supabase Postgres database before deploying the updated backend.

CREATE TABLE IF NOT EXISTS exchange_orders (
  exchange_id      SERIAL PRIMARY KEY,
  exchange_no      VARCHAR(60) NOT NULL UNIQUE,
  shop_id          INTEGER NOT NULL REFERENCES shops(shop_id),
  sales_return_id  INTEGER NOT NULL UNIQUE REFERENCES sales_returns(return_id),
  new_invoice_id   INTEGER NOT NULL UNIQUE REFERENCES invoices(invoice_id),
  price_difference NUMERIC(10,2) NOT NULL,
  gst_difference   NUMERIC(10,2) NOT NULL,
  net_amount       NUMERIC(10,2) NOT NULL,
  settlement_type  VARCHAR(20) NOT NULL,  -- COLLECT | REFUND | EVEN
  created_by       INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_exchange_orders_shop_created ON exchange_orders (shop_id, created_at DESC);
