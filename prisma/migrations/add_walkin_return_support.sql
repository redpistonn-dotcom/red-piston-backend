-- Walk-in return/exchange support: a customer with no findable original invoice.
-- Idempotent — safe to re-run.

ALTER TABLE "sales_returns" ALTER COLUMN "original_invoice_id" DROP NOT NULL;
ALTER TABLE "sales_returns" ADD COLUMN IF NOT EXISTS "is_walk_in" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "sales_return_items" ALTER COLUMN "invoice_item_id" DROP NOT NULL;

ALTER TABLE "credit_notes" ALTER COLUMN "linked_invoice_id" DROP NOT NULL;
