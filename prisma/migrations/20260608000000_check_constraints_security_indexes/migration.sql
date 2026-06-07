-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: check_constraints_security_indexes
-- Date:      2026-06-08
-- Purpose:   Phase 3 — Add CHECK constraints that Prisma schema DSL cannot express.
--            Indexes added to schema.prisma are emitted by `prisma migrate dev`;
--            this file handles the raw SQL constraints only.
-- ─────────────────────────────────────────────────────────────────────────────

-- Prevent negative stock — a shop_inventory row with stockQty < 0 means data
-- was corrupted (race condition or double-decrement). Hard block at DB level.
ALTER TABLE shop_inventory
  ADD CONSTRAINT chk_stock_qty_non_negative
    CHECK (stock_qty >= 0);

-- Prevent negative reserved quantity — reserved_qty counts held/pending stock.
ALTER TABLE shop_inventory
  ADD CONSTRAINT chk_reserved_qty_non_negative
    CHECK (reserved_qty >= 0);

-- reserved_qty can never exceed available stock
ALTER TABLE shop_inventory
  ADD CONSTRAINT chk_reserved_lte_stock
    CHECK (reserved_qty <= stock_qty);

-- Marketplace review ratings must be 1–5 (integer)
ALTER TABLE marketplace_reviews
  ADD CONSTRAINT chk_rating_range
    CHECK (rating BETWEEN 1 AND 5);

-- Invoice and movement amounts must be positive
ALTER TABLE invoice_items
  ADD CONSTRAINT chk_invoice_item_qty_positive
    CHECK (qty > 0);

ALTER TABLE invoice_items
  ADD CONSTRAINT chk_invoice_item_unit_price_non_negative
    CHECK (unit_price >= 0);

ALTER TABLE movements
  ADD CONSTRAINT chk_movement_qty_positive
    CHECK (qty > 0);

-- Job card labour charge cannot be negative
ALTER TABLE job_cards
  ADD CONSTRAINT chk_labour_charge_non_negative
    CHECK (labour_charge >= 0);

-- Party outstanding balance: no constraint — can be negative (credit owed by shop to party).
-- credit_limit must be non-negative
ALTER TABLE parties
  ADD CONSTRAINT chk_credit_limit_non_negative
    CHECK (credit_limit >= 0);

-- Purchase order item quantities must be positive
ALTER TABLE purchase_order_items
  ADD CONSTRAINT chk_po_item_ordered_qty_positive
    CHECK (ordered_qty > 0);

ALTER TABLE purchase_order_items
  ADD CONSTRAINT chk_po_item_received_lte_ordered
    CHECK (received_qty <= ordered_qty);
