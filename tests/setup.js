/**
 * Global test setup — loaded by Vitest before every test file.
 *
 * Responsibilities:
 *  1. Inject required env vars so JWT signing / crypto helpers work without a
 *     real .env file present in CI or local runs.
 *  2. Provide a fully-stubbed Prisma singleton so no real DB connection is
 *     attempted during tests.
 *  3. Stub the Resend email client so no real emails are sent.
 *  4. Stub firebase-admin auth so token verification is controllable.
 */

import { vi, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';

// ── 1. Environment variables ───────────────────────────────────────────────────

process.env.NODE_ENV             = 'test';
process.env.JWT_SECRET           = 'test-jwt-secret-at-least-32-chars-long';
process.env.JWT_REFRESH_SECRET    = 'test-refresh-secret-at-least-32-chars-long';
process.env.FIELD_ENCRYPTION_KEY = 'test-encryption-key-for-unit-tests-here';

// ── 2. Prisma mock ─────────────────────────────────────────────────────────────
//
// Every model is stubbed with vi.fn() so individual tests can call
// .mockResolvedValue() / .mockRejectedValue() without importing vi themselves.
// $transaction is a fn that by default executes the callback with the prisma
// stub (mirrors the real Prisma interactive-transaction signature).

vi.mock('../src/db/prisma.js', () => {
  const makeModel = () => ({
    findUnique:  vi.fn(),
    findFirst:   vi.fn(),
    findMany:    vi.fn(),
    create:      vi.fn(),
    createMany:  vi.fn(),
    update:      vi.fn(),
    updateMany:  vi.fn(),
    upsert:      vi.fn(),
    delete:      vi.fn(),
    deleteMany:  vi.fn(),
    count:       vi.fn(),
    aggregate:   vi.fn(),
    groupBy:     vi.fn(),
  });

  const prisma = {
    user:            makeModel(),
    shop:            makeModel(),
    shopInventory:   makeModel(),
    invoice:         makeModel(),
    movement:        makeModel(),
    party:           makeModel(),
    partyLedger:     makeModel(),
    auditLog:        makeModel(),
    numberCounter:   makeModel(),
    otpCode:         makeModel(),
    refreshToken:    makeModel(),
    shopUser:        makeModel(),
    adminProfile:    makeModel(),
    featureFlag:     makeModel(),

    // Prisma client-level methods
    $transaction: vi.fn((cbOrArray) => {
      if (typeof cbOrArray === 'function') {
        // Interactive transaction: call the callback with the stub itself
        return cbOrArray(prisma);
      }
      // Batch transaction: resolve each promise in order
      return Promise.all(cbOrArray);
    }),
    $queryRaw:    vi.fn(),
    $disconnect:  vi.fn().mockResolvedValue(undefined),
  };

  // Real AsyncLocalStorage — middleware/auth.js's authenticate() calls
  // shopContext.run(...) for any user with a shopId. Without this named
  // export the mock module has no `shopContext` at all (undefined),
  // authenticate() throws on `.run`, and every shopId-bearing user 401s
  // with INVALID_TOKEN instead of reaching next().
  const shopContext = new AsyncLocalStorage();

  return { default: prisma, shopContext };
});

// ── 3. Resend email mock ───────────────────────────────────────────────────────

vi.mock('resend', () => {
  const sendFn = vi.fn().mockResolvedValue({
    data:  { id: 'mock-email-id' },
    error: null,
  });

  // Resend is consumed as `new Resend(apiKey)` → instance.emails.send(...)
  const ResendClass = vi.fn().mockImplementation(() => ({
    emails: { send: sendFn },
  }));

  return { Resend: ResendClass };
});

// ── 4. Firebase Admin mock ────────────────────────────────────────────────────

vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => ({
    verifyIdToken: vi.fn().mockResolvedValue({ uid: 'mock-uid' }),
  })),
}));

vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(),
  getApps:       vi.fn(() => []),
  cert:          vi.fn(),
}));

// ── Lifecycle hooks ───────────────────────────────────────────────────────────

beforeAll(() => {
  // Nothing additional needed; mocks are hoisted by Vitest before module load.
});

afterAll(() => {
  vi.restoreAllMocks();
});
