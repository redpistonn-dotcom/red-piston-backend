-- Enterprise v1: Add version columns for optimistic concurrency control
-- Run: psql $DIRECT_URL -f enterprise_v1_version_cols.sql
ALTER TABLE shop_inventory ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parties ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE movements ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(36);
ALTER TABLE movements ADD COLUMN IF NOT EXISTS causation_id INTEGER;
CREATE INDEX IF NOT EXISTS movements_correlation_id_idx ON movements (correlation_id) WHERE correlation_id IS NOT NULL;
