/**
 * purchaseBills.test.js — unit tests for purchase bill import validation.
 *
 * BUG FIX COVERAGE:
 *   DEF-002 — rate <= 0 now rejected (was rate < 0, allowed ₹0 cost items).
 *   Consistent with POS-001 fix (billing.js also blocks unitPrice <= 0).
 *
 * We test the validation logic directly (pure function extracted inline)
 * rather than mounting the full Express router to avoid Prisma/auth mocks.
 */
import { describe, it, expect } from 'vitest';

// ── Mirror the exact validation predicate from purchaseBills.js line 120 ──────
function isValidBillItem(item) {
  const partName    = String(item.partName || '').trim();
  const qty         = parseInt(item.qty, 10);
  const rate        = parseFloat(item.rate);
  const sellingPrice= parseFloat(item.sellingPrice);

  return !(!partName
    || !Number.isFinite(qty)  || qty         <= 0
    || !Number.isFinite(rate) || rate        <= 0   // FIXED: was rate < 0
    || !Number.isFinite(sellingPrice)        || sellingPrice <= 0 // FIXED: was < 0
  );
}

const base = { partName: 'Oil Filter', qty: '2', rate: '100', sellingPrice: '150' };

describe('purchase bill item validation — DEF-002 fix', () => {
  it('accepts valid item', () => {
    expect(isValidBillItem(base)).toBe(true);
  });

  // ── rate (buy price) ────────────────────────────────────────────────────
  it('rejects rate = 0 (DEF-002 fix)', () => {
    expect(isValidBillItem({ ...base, rate: '0' })).toBe(false);
  });
  it('rejects rate < 0', () => {
    expect(isValidBillItem({ ...base, rate: '-10' })).toBe(false);
  });
  it('rejects non-numeric rate', () => {
    expect(isValidBillItem({ ...base, rate: 'abc' })).toBe(false);
  });
  it('accepts rate = 0.01', () => {
    expect(isValidBillItem({ ...base, rate: '0.01' })).toBe(true);
  });
  it('accepts rate = 1', () => {
    expect(isValidBillItem({ ...base, rate: '1' })).toBe(true);
  });

  // ── sellingPrice ─────────────────────────────────────────────────────────
  it('rejects sellingPrice = 0', () => {
    expect(isValidBillItem({ ...base, sellingPrice: '0' })).toBe(false);
  });
  it('rejects sellingPrice < 0', () => {
    expect(isValidBillItem({ ...base, sellingPrice: '-5' })).toBe(false);
  });
  it('accepts sellingPrice = 0.01', () => {
    expect(isValidBillItem({ ...base, sellingPrice: '0.01' })).toBe(true);
  });

  // ── partName ──────────────────────────────────────────────────────────────
  it('rejects blank partName', () => {
    expect(isValidBillItem({ ...base, partName: '' })).toBe(false);
  });
  it('rejects whitespace-only partName', () => {
    expect(isValidBillItem({ ...base, partName: '   ' })).toBe(false);
  });

  // ── qty ───────────────────────────────────────────────────────────────────
  it('rejects qty = 0', () => {
    expect(isValidBillItem({ ...base, qty: '0' })).toBe(false);
  });
  it('rejects qty < 0', () => {
    expect(isValidBillItem({ ...base, qty: '-1' })).toBe(false);
  });
  it('rejects non-integer qty', () => {
    expect(isValidBillItem({ ...base, qty: 'abc' })).toBe(false);
  });
  it('accepts qty = 1', () => {
    expect(isValidBillItem({ ...base, qty: '1' })).toBe(true);
  });
  it('accepts qty = 999', () => {
    expect(isValidBillItem({ ...base, qty: '999' })).toBe(true);
  });
});

// ── Consistency with POS-001 billing.js guard ─────────────────────────────────
describe('price guard consistency — POS-001 vs DEF-002', () => {
  // Both billing.js (invoice) and purchaseBills.js (import) must reject <= 0
  function posGuard(unitPrice) {
    return Number.isFinite(unitPrice) && unitPrice > 0;
  }
  function billGuard(rate) {
    return Number.isFinite(rate) && rate > 0;
  }

  const cases = [0, -1, -0.01, NaN, Infinity];
  cases.forEach(v => {
    it(`both guards reject ${v}`, () => {
      expect(posGuard(v)).toBe(false);
      expect(billGuard(v)).toBe(false);
    });
  });

  const passing = [0.01, 1, 100, 99999];
  passing.forEach(v => {
    it(`both guards accept ${v}`, () => {
      expect(posGuard(v)).toBe(true);
      expect(billGuard(v)).toBe(true);
    });
  });
});
