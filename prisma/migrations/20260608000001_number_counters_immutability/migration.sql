-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: number_counters_immutability
-- Date:      2026-06-08
-- Issues:    #7 Invoice number race, #9 Job number race, #10 Ledger immutability
-- ─────────────────────────────────────────────────────────────────────────────

-- ══════════════════════════════════════════════════════════════════════════════
-- FIX #7 / #9 — Atomic per-shop per-month sequence counter
--
-- Uses INSERT ... ON CONFLICT DO UPDATE (upsert) which takes a row-level lock
-- on (shop_id, counter_key) before incrementing.  Two concurrent transactions
-- arriving at the same key will serialize: the second blocks until the first
-- commits, then reads the already-incremented value.  This is guaranteed by
-- PostgreSQL's locking model for upserts and requires no application-level
-- locking or advisory locks.
--
-- Gaps are acceptable (a failed transaction rolls back the increment too since
-- it runs inside the same transaction as the insert it is numbering).
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS number_counters (
  shop_id      INTEGER      NOT NULL,
  counter_key  VARCHAR(30)  NOT NULL,   -- e.g. 'INV-202606', 'JOB-202606'
  last_value   INTEGER      NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),

  PRIMARY KEY (shop_id, counter_key),

  CONSTRAINT fk_number_counters_shop
    FOREIGN KEY (shop_id) REFERENCES shops(shop_id) ON DELETE CASCADE
);

COMMENT ON TABLE number_counters IS
  'Atomic per-shop sequential counters. Incremented via INSERT ON CONFLICT DO UPDATE RETURNING.';

-- ══════════════════════════════════════════════════════════════════════════════
-- FIX #10 — Immutability triggers on movements and party_ledger
--
-- The schema comment says "INSERT ONLY" but no DB enforcement existed.
-- These triggers make UPDATE and DELETE raise an exception, enforcing the
-- append-only contract at the storage layer regardless of what the application
-- (or a connected psql session) attempts.
-- ══════════════════════════════════════════════════════════════════════════════

-- movements — stock ledger: once written, never altered
CREATE OR REPLACE FUNCTION _prevent_movements_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'movements rows are immutable (INSERT-ONLY). Attempted: %. Row id: %',
    TG_OP, COALESCE(OLD.movement_id::text, 'unknown');
END;
$$;

DROP TRIGGER IF EXISTS trg_movements_no_update ON movements;
CREATE TRIGGER trg_movements_no_update
  BEFORE UPDATE ON movements
  FOR EACH ROW
  EXECUTE FUNCTION _prevent_movements_mutation();

DROP TRIGGER IF EXISTS trg_movements_no_delete ON movements;
CREATE TRIGGER trg_movements_no_delete
  BEFORE DELETE ON movements
  FOR EACH ROW
  EXECUTE FUNCTION _prevent_movements_mutation();

-- party_ledger — financial audit trail: same insert-only constraint
CREATE OR REPLACE FUNCTION _prevent_ledger_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'party_ledger rows are immutable (INSERT-ONLY). Attempted: %. Row id: %',
    TG_OP, COALESCE(OLD.ledger_id::text, 'unknown');
END;
$$;

DROP TRIGGER IF EXISTS trg_party_ledger_no_update ON party_ledger;
CREATE TRIGGER trg_party_ledger_no_update
  BEFORE UPDATE ON party_ledger
  FOR EACH ROW
  EXECUTE FUNCTION _prevent_ledger_mutation();

DROP TRIGGER IF EXISTS trg_party_ledger_no_delete ON party_ledger;
CREATE TRIGGER trg_party_ledger_no_delete
  BEFORE DELETE ON party_ledger
  FOR EACH ROW
  EXECUTE FUNCTION _prevent_ledger_mutation();
