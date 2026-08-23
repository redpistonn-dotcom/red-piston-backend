/**
 * firebase.test.js — integration tests for POST /api/auth/firebase
 *
 * FULL AUTH FLOW BEING TESTED:
 *
 *  Request body: { firebaseToken, role?, mode? }
 *
 *  1. Guard:    missing token → 400 MISSING_TOKEN
 *  2. Verify:   verifyFirebaseToken(token) → { uid, email, phone, name, picture }
 *  3. Lookup:   authProvider(GOOGLE, uid) → user
 *  4. Fallback: user.phone → user
 *  5. Fallback: user.email (case-insensitive) → user
 *  6. Gate:     mode=signin + no user → 404 NO_ACCOUNT
 *  7. Create:   no user + mode≠signin → create new user (role from body)
 *  8. Update:   existing user → update stale email/name/avatarUrl
 *  9. Gate:     user.isActive=false → 403 ACCOUNT_INACTIVE
 * 10. Link:     ensureAuthProvider for GOOGLE / PHONE / EMAIL
 * 11. Gate:     new SHOP_OWNER → 200 needsShopDetails=true (no session)
 * 12. Gate:     PENDING shop owner → 403 SHOP_OWNER_PENDING
 * 13. Gate:     REJECTED shop owner → 403 SHOP_OWNER_REJECTED
 * 14. Session:  createSession → access + refresh tokens in response
 *
 * WHY mock at the service layer not the DB layer:
 *   Mocking prisma.$transaction etc. requires replicating complex internal
 *   Prisma state. Instead we mock the firebase service (verifyFirebaseToken)
 *   and the prisma singleton so each test controls exactly what the DB returns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

// ── Mocks (hoisted before imports by vitest) ──────────────────────────────────

// authenticate/createSession touch shopContext.run(...) for shopId-bearing
// users. Dynamic import inside the factory avoids vi.mock's hoisting
// restriction on referencing other module bindings.
vi.mock('../../src/db/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  return {
    default: {
      authProvider: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      userType: {
        findUnique: vi.fn(),
      },
      refreshToken: {
        deleteMany: vi.fn(),
        create: vi.fn(),
        // createSession() (routes/auth/helpers.js) caps active sessions at 4,
        // reading existing rows via findMany before pruning the rest.
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
    shopContext: new AsyncLocalStorage(),
  };
});

vi.mock('../../src/services/firebase.js', () => ({
  verifyFirebaseToken: vi.fn(),
}));

vi.mock('../../src/services/email.js', () => ({
  sendShopOwnerVerificationAlert: vi.fn().mockResolvedValue(undefined),
}));

// ── Import after mocks are registered ────────────────────────────────────────
import prisma from '../../src/db/prisma.js';
import { verifyFirebaseToken } from '../../src/services/firebase.js';
import firebaseRouter from '../../src/routes/auth/firebase.js';

// ── Test app ──────────────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', firebaseRouter);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const DECODED_GOOGLE = {
  uid: 'google-uid-123',
  email: 'user@example.com',
  name: 'Test User',
  picture: 'https://example.com/pic.jpg',
  phone_number: null,
};

const DB_CUSTOMER = {
  userId: 1,
  phone: null,
  email: 'user@example.com',
  name: 'Test User',
  avatarUrl: null,
  role: 'CUSTOMER',
  shopId: null,
  isActive: true,
  verificationStatus: null,
  emailVerified: true,
  phoneVerified: false,
  isVerified: true,
  loginCount: 3,
  shop: null,
  userType: { id: 2, name: 'Customer', slug: 'CUSTOMER' },
};

const DB_SHOP_OWNER = {
  ...DB_CUSTOMER,
  userId: 2,
  role: 'SHOP_OWNER',
  shopId: 10,
  verificationStatus: null,
  shop: { shopId: 10, name: 'Test Shop' },
  userType: { id: 3, name: 'Shop Owner', slug: 'SHOP_OWNER' },
};

// Setup default mock chain: provider not found, no phone/email match
function setupNoUser() {
  prisma.authProvider.findUnique.mockResolvedValue(null);
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.user.findMany.mockResolvedValue([]);
}

// Setup mock chain: existing customer found via Google UID
function setupExistingCustomer() {
  prisma.authProvider.findUnique.mockResolvedValue({ userId: 1, provider: 'GOOGLE', providerId: 'google-uid-123' });
  prisma.user.findUnique.mockResolvedValue(DB_CUSTOMER);
  prisma.user.update.mockResolvedValue(DB_CUSTOMER);
  prisma.authProvider.create.mockResolvedValue({});
  prisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
  prisma.refreshToken.create.mockResolvedValue({});
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/auth/firebase', () => {
  let app;
  beforeEach(() => {
    app = buildApp();
  });

  // ── Input validation ────────────────────────────────────────────────────────

  it('returns 400 MISSING_TOKEN when firebaseToken is absent', async () => {
    const res = await request(app).post('/api/auth/firebase').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_TOKEN');
  });

  it('returns 400 MISSING_TOKEN when firebaseToken is empty string', async () => {
    const res = await request(app).post('/api/auth/firebase').send({ firebaseToken: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_TOKEN');
  });

  // ── Sign-in mode + no account ───────────────────────────────────────────────

  it('returns 404 NO_ACCOUNT in signin mode when user does not exist', async () => {
    verifyFirebaseToken.mockResolvedValue(DECODED_GOOGLE);
    setupNoUser();

    const res = await request(app)
      .post('/api/auth/firebase')
      .send({ firebaseToken: 'valid-token', mode: 'signin' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NO_ACCOUNT');
  });

  // ── Existing user — lookup via Google UID ───────────────────────────────────

  it('returns 200 with tokens for existing user found via Google UID', async () => {
    verifyFirebaseToken.mockResolvedValue(DECODED_GOOGLE);
    setupExistingCustomer();

    const res = await request(app)
      .post('/api/auth/firebase')
      .send({ firebaseToken: 'valid-token', mode: 'signin' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
  });

  it('response user object contains userId, role, and email', async () => {
    verifyFirebaseToken.mockResolvedValue(DECODED_GOOGLE);
    setupExistingCustomer();

    const res = await request(app)
      .post('/api/auth/firebase')
      .send({ firebaseToken: 'valid-token' });

    expect(res.body.user).toMatchObject({
      userId: 1,
      role: 'CUSTOMER',
      email: 'user@example.com',
    });
  });

  it('sets an httpOnly refresh_token cookie on success', async () => {
    verifyFirebaseToken.mockResolvedValue(DECODED_GOOGLE);
    setupExistingCustomer();

    const res = await request(app)
      .post('/api/auth/firebase')
      .send({ firebaseToken: 'valid-token' });

    const cookies = res.headers['set-cookie'] || [];
    const rtCookie = cookies.find(c => c.startsWith('refresh_token='));
    expect(rtCookie).toBeTruthy();
    expect(rtCookie).toMatch(/HttpOnly/i);
  });

  // ── Existing user — phone fallback ─────────────────────────────────────────

  it('finds user via phone fallback when Google UID not in authProvider table', async () => {
    const decodedWithPhone = { ...DECODED_GOOGLE, phone_number: '+919876543210' };
    verifyFirebaseToken.mockResolvedValue(decodedWithPhone);

    // authProvider not found → existingProvider is null → user.findUnique for
    // userId lookup is NEVER called. The first user.findUnique call is the phone lookup.
    prisma.authProvider.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValueOnce(DB_CUSTOMER); // phone lookup → hit
    prisma.user.update.mockResolvedValue(DB_CUSTOMER);
    prisma.authProvider.create.mockResolvedValue({});
    prisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
    prisma.refreshToken.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/auth/firebase')
      .send({ firebaseToken: 'valid-token', mode: 'signin' });

    expect(res.status).toBe(200);
    expect(res.body.user.userId).toBe(1);
  });

  // ── Existing user — email fallback ─────────────────────────────────────────

  it('finds user via email fallback when neither UID nor phone matched', async () => {
    verifyFirebaseToken.mockResolvedValue(DECODED_GOOGLE);

    prisma.authProvider.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(null); // no phone match
    prisma.user.findMany.mockResolvedValue([DB_CUSTOMER]); // email match
    prisma.user.update.mockResolvedValue(DB_CUSTOMER);
    prisma.authProvider.create.mockResolvedValue({});
    prisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
    prisma.refreshToken.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/auth/firebase')
      .send({ firebaseToken: 'valid-token', mode: 'signin' });

    expect(res.status).toBe(200);
    expect(res.body.user.userId).toBe(1);
  });

  // ── Inactive account ────────────────────────────────────────────────────────

  it('returns 403 ACCOUNT_INACTIVE for deactivated user', async () => {
    verifyFirebaseToken.mockResolvedValue(DECODED_GOOGLE);
    prisma.authProvider.findUnique.mockResolvedValue({ userId: 1 });
    // Set avatarUrl to match DECODED_GOOGLE.picture so no profile-update query fires.
    // The route does: update stale fields THEN check isActive — if update runs with
    // no mock it returns undefined, and the isActive check never fires.
    const inactiveUser = { ...DB_CUSTOMER, isActive: false, avatarUrl: DECODED_GOOGLE.picture };
    prisma.user.findUnique.mockResolvedValue(inactiveUser);

    const res = await request(app)
      .post('/api/auth/firebase')
      .send({ firebaseToken: 'valid-token', mode: 'signin' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });

  // ── New CUSTOMER registration ───────────────────────────────────────────────

  it('creates a new CUSTOMER and returns isNewUser=true', async () => {
    verifyFirebaseToken.mockResolvedValue(DECODED_GOOGLE);
    setupNoUser();
    prisma.userType.findUnique.mockResolvedValue({ id: 2 });
    prisma.user.create.mockResolvedValue({ ...DB_CUSTOMER, loginCount: 0, isNew: true });
    prisma.user.update.mockResolvedValue(DB_CUSTOMER);
    prisma.authProvider.create.mockResolvedValue({});
    prisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
    prisma.refreshToken.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/auth/firebase')
      .send({ firebaseToken: 'valid-token', role: 'customer' });

    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(true);
  });

  // ── New SHOP_OWNER — needs shop details ────────────────────────────────────

  it('returns needsShopDetails=true for new SHOP_OWNER with a setup session', async () => {
    verifyFirebaseToken.mockResolvedValue(DECODED_GOOGLE);
    setupNoUser();
    prisma.userType.findUnique.mockResolvedValue({ id: 3 });
    // Fresh shop owners have the schema default verificationStatus NOT_REQUIRED
    prisma.user.create.mockResolvedValue({ ...DB_SHOP_OWNER, shopId: null, shop: null, verificationStatus: 'NOT_REQUIRED', loginCount: 0 });
    prisma.authProvider.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/auth/firebase')
      .send({ firebaseToken: 'valid-token', role: 'shop' });

    expect(res.status).toBe(200);
    expect(res.body.needsShopDetails).toBe(true);
    // Tokens ARE issued: POST /api/auth/shop-setup requires a Bearer token,
    // so the setup flow needs a session. shop-setup revokes it on submit.
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });

  // ── PENDING shop owner ─────────────────────────────────────────────────────

  it('returns 403 SHOP_OWNER_PENDING for shop owner awaiting approval', async () => {
    verifyFirebaseToken.mockResolvedValue(DECODED_GOOGLE);
    prisma.authProvider.findUnique.mockResolvedValue({ userId: 2 });
    prisma.user.findUnique.mockResolvedValue({ ...DB_SHOP_OWNER, verificationStatus: 'PENDING' });
    prisma.user.update.mockResolvedValue({ ...DB_SHOP_OWNER, verificationStatus: 'PENDING' });
    prisma.authProvider.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/auth/firebase')
      .send({ firebaseToken: 'valid-token', mode: 'signin' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SHOP_OWNER_PENDING');
  });

  // ── REJECTED shop owner ────────────────────────────────────────────────────

  it('returns 403 SHOP_OWNER_REJECTED for rejected shop owner', async () => {
    verifyFirebaseToken.mockResolvedValue(DECODED_GOOGLE);
    prisma.authProvider.findUnique.mockResolvedValue({ userId: 2 });
    prisma.user.findUnique.mockResolvedValue({
      ...DB_SHOP_OWNER,
      verificationStatus: 'REJECTED',
      verificationNote: 'Incomplete documents',
    });
    prisma.user.update.mockResolvedValue({ ...DB_SHOP_OWNER, verificationStatus: 'REJECTED' });
    prisma.authProvider.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/auth/firebase')
      .send({ firebaseToken: 'valid-token', mode: 'signin' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SHOP_OWNER_REJECTED');
  });

  // ── Firebase verification error ────────────────────────────────────────────

  it('propagates error when verifyFirebaseToken rejects', async () => {
    verifyFirebaseToken.mockRejectedValue(new Error('Firebase token invalid'));

    const res = await request(app)
      .post('/api/auth/firebase')
      .send({ firebaseToken: 'bad-token' });

    // errorHandler turns unhandled errors into 500
    expect(res.status).toBe(500);
  });

  // ── Profile update on re-login ─────────────────────────────────────────────

  it('updates stale name when Firebase returns a different name', async () => {
    const updatedDecoded = { ...DECODED_GOOGLE, name: 'Updated Name' };
    verifyFirebaseToken.mockResolvedValue(updatedDecoded);

    const staleUser = { ...DB_CUSTOMER, name: 'Old Name' };
    prisma.authProvider.findUnique.mockResolvedValue({ userId: 1 });
    prisma.user.findUnique.mockResolvedValue(staleUser);
    const updatedUser = { ...staleUser, name: 'Updated Name' };
    prisma.user.update.mockResolvedValue(updatedUser);
    prisma.authProvider.create.mockResolvedValue({});
    prisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
    prisma.refreshToken.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/auth/firebase')
      .send({ firebaseToken: 'valid-token', mode: 'signin' });

    expect(res.status).toBe(200);
    // prisma.user.update should have been called with the new name
    const updateCall = prisma.user.update.mock.calls.find(
      c => c[0]?.data?.name === 'Updated Name'
    );
    expect(updateCall).toBeTruthy();
  });
});
