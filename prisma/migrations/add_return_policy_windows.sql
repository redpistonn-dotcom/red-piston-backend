-- Category/brand-level return-window overrides. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "return_policy_windows" (
  "id" SERIAL PRIMARY KEY,
  "shop_id" INTEGER NOT NULL REFERENCES "shops"("shop_id") ON DELETE CASCADE,
  "scope" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "days" INTEGER NOT NULL,
  UNIQUE ("shop_id", "scope", "value")
);
