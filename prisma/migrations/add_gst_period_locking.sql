-- GST period locking. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "gst_period_locks" (
  "id" SERIAL PRIMARY KEY,
  "shop_id" INTEGER NOT NULL REFERENCES "shops"("shop_id") ON DELETE CASCADE,
  "period" TEXT NOT NULL,
  "locked_by" INTEGER,
  "locked_at" TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE ("shop_id", "period")
);

ALTER TABLE "credit_notes" ADD COLUMN IF NOT EXISTS "gst_block_reason" TEXT;
