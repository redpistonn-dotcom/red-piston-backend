-- Fix: sales_returns.created_by had no FK to users, unlike every other createdBy
-- column in this schema (invoices, movements, job_cards, purchase_orders). Found
-- via the Phase 6 reports smoke test — the report needed a `creator` relation to
-- show "returns by staff" and Prisma had nothing to join against.
ALTER TABLE sales_returns
  DROP CONSTRAINT IF EXISTS fk_sales_returns_created_by;
ALTER TABLE sales_returns
  ADD CONSTRAINT fk_sales_returns_created_by
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL;
