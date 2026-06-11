-- Purchase bills: supplier invoices uploaded by shop owners (parse → review → stock-in)
CREATE TABLE IF NOT EXISTS purchase_bills (
  bill_id         SERIAL PRIMARY KEY,
  shop_id         INTEGER NOT NULL REFERENCES shops(shop_id),
  file_url        TEXT,
  file_name       TEXT,
  supplier_name   TEXT,
  supplier_gstin  TEXT,
  invoice_number  TEXT,
  invoice_date    TEXT,
  taxable_total   DECIMAL(12,2),
  grand_total     DECIMAL(12,2),
  item_count      INTEGER NOT NULL DEFAULT 0,
  extracted       JSONB,
  sum_matches     BOOLEAN NOT NULL DEFAULT FALSE,
  status          TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  imported_at     TIMESTAMP,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS purchase_bills_shop_created_idx
  ON purchase_bills (shop_id, created_at);
