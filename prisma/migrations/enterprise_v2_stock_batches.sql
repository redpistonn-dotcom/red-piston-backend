-- Enterprise v2: Stock batch / lot / serial number tracking
CREATE TABLE IF NOT EXISTS stock_batches (
  batch_id        SERIAL PRIMARY KEY,
  shop_id         INTEGER NOT NULL REFERENCES shops(shop_id),
  inventory_id    INTEGER NOT NULL REFERENCES shop_inventory(inventory_id),
  batch_number    VARCHAR(100),
  serial_number   VARCHAR(100),
  qty_received    INTEGER NOT NULL DEFAULT 0,
  qty_remaining   INTEGER NOT NULL DEFAULT 0,
  cost_price      NUMERIC(10,2) NOT NULL DEFAULT 0,
  supplier_name   VARCHAR(255),
  party_id        INTEGER REFERENCES parties(party_id),
  received_date   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expiry_date     TIMESTAMPTZ,
  notes           TEXT,
  po_id           INTEGER REFERENCES purchase_orders(po_id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_batches_shop_inventory ON stock_batches (shop_id, inventory_id);
CREATE INDEX IF NOT EXISTS idx_stock_batches_batch_number ON stock_batches (shop_id, batch_number) WHERE batch_number IS NOT NULL;
