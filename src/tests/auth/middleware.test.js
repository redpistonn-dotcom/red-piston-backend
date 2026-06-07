/**
 * middleware.test.js — unit tests for authenticate and requireShopOwner.
 *
 * FLOWS TESTED:
 *
 * authenticate middleware:
 *   1. No Authorization header → 401 NO_TOKEN
 *   2. Authorization header without "Bearer " prefix → 401 NO_TOKEN
 *   3. Valid Bearer token + active user → next() called, req.user set
 *   4. Valid token but user not found in DB → 401 USER_INACTIVE
 *   5. Valid token but user.isActive=false → 401 USER_INACTIVE
 *   6. Expired JWT → 401 TOKEN_EXPIRED
 *   7. Invalid JWT signature → 401 INVALID_TOKEN
 *   8. Impersonation: decoded.impersonatedBy is attached to req
 *
 * requireShopOwner middleware (runs after authenticate):
 *   9.  SHOP_OWNER with shopId → next()
 *  10.  PLATFORM_ADMIN → next() (admins pass the shop-owner gate)
 *  11.  CUSTOMER → 403 FORBIDDEN
 *  12.  SHOP_OWNER without shopId → 403 FORBIDDEN (shop not yet set up)
 *
 * WHY test middleware separately:
 *   authenticate is called on EVERY protected endpoint (100+ routes).
 *   A single bug here locks out all authenticated users. Testing it in
 *   isolation means we can verify all 8 branches without mounting the
 *   full Express app or involving route-level business logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { authenticate, requireShopOwner } from '../../middleware/auth.js';

vi.mock('../../db/prisma.js', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

import prisma from '../../db/prisma.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeAccessToken(payload = {}, secret = process.env.JWT_SECRET) {
  return jwt.sign(
    { userId: 1, shopId: 5, role: 'SHOP_OWNER', ...payload },
    secret,
    { expiresIn: '8h' }
  );
}

function makeExpiredToken() {
  return jwt.sign(
    { userId: 1, shopId: 5, role: 'SHOP_OWNER' },
    process.env.JWT_SECRET,
    { expiresIn: '-1s' } // already expired
  );
}

function mockReqResNext(tokenOrHeader = null) {
  const req = {
    headers: {},
    user: null,
    shopId: null,
    impersonatedBy: null,
  };
  if (tokenOrHeader) {
    req.headers.authorization = tokenOrHeader.startsWith('Bearer ')
      ? tokenOrHeader
      : `Bearer ${tokenOrHeader}`;
  }
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body;   return this; },
  };
  const next = vi.fn();
  return { req, res, next };
}

const DB_SHOP_OWNER = {
  userId: 1,
  phone: '9876543210',
  email: 'owner@test.com',
  role: 'SHOP_OWNER',
  shopId: 5,
  isActive: true,
  shop: { shopId: 5, name: 'Test Shop' },
  userType: { id: 3, name: 'Shop Owner', slug: 'SHOP_OWNER' },
};

// ── authenticate ──────────────────────────────────────────────────────────────

describe('authenticate middleware', () => {
  it('returns 401 NO_TOKEN when Authorization header is absent', async () => {
    const { req, res, next } = mockReqResNext();
    await authenticate(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body.error.code).toBe('NO_TOKEN');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 NO_TOKEN when header does not start with "Bearer "', async () => {
    const { req, res, next } = mockReqResNext();
    req.headers.authorization = 'Token abc123'; // wrong scheme
    await authenticate(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body.error.code).toBe('NO_TOKEN');
  });

  it('calls next() and attaches req.user for a valid token + active user', async () => {
    prisma.user.findUnique.mockResolvedValue(DB_SHOP_OWNER);
    const { req, res, next } = mockReqResNext(makeAccessToken());

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ userId: 1, role: 'SHOP_OWNER' });
    expect(req.shopId).toBe(5);
  });

  it('attaches null impersonatedBy when not present in token', async () => {
    prisma.user.findUnique.mockResolvedValue(DB_SHOP_OWNER);
    const { req, res, next } = mockReqResNext(makeAccessToken());

    await authenticate(req, res, next);

    expect(req.impersonatedBy).toBeNull();
  });

  it('attaches impersonatedBy from token when present (impersonation session)', async () => {
    prisma.user.findUnique.mockResolvedValue(DB_SHOP_OWNER);
    const token = makeAccessToken({ impersonatedBy: 99 });
    const { req, res, next } = mockReqResNext(token);

    await authenticate(req, res, next);

    expect(req.impersonatedBy).toBe(99);
  });

  it('returns 401 USER_INACTIVE when user not found in DB', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const { req, res, next } = mockReqResNext(makeAccessToken());

    await authenticate(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body.error.code).toBe('USER_INACTIVE');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 USER_INACTIVE when user.isActive is false', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...DB_SHOP_OWNER, isActive: false });
    const { req, res, next } = mockReqResNext(makeAccessToken());

    await authenticate(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body.error.code).toBe('USER_INACTIVE');
  });

  it('returns 401 TOKEN_EXPIRED for an expired JWT', async () => {
    const { req, res, next } = mockReqResNext(makeExpiredToken());
    await authenticate(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('returns 401 INVALID_TOKEN for a JWT signed with the wrong secret', async () => {
    const badToken = makeAccessToken({}, 'wrong-secret');
    const { req, res, next } = mockReqResNext(badToken);
    await authenticate(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body.error.code).toBe('INVALID_TOKEN');
  });

  it('returns 401 INVALID_TOKEN for a completely malformed token string', async () => {
    const { req, res, next } = mockReqResNext('Bearer not.a.jwt');
    await authenticate(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body.error.code).toBe('INVALID_TOKEN');
  });
});

// ── requireShopOwner ──────────────────────────────────────────────────────────

describe('requireShopOwner middleware', () => {
  function reqWith(userOverrides = {}) {
    return {
      user: { ...DB_SHOP_OWNER, ...userOverrides },
      shopId: userOverrides.shopId ?? DB_SHOP_OWNER.shopId,
    };
  }

  it('calls next() for an active SHOP_OWNER with a shopId', () => {
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    requireShopOwner(reqWith(), res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('calls next() for PLATFORM_ADMIN (admin passes the shop-owner gate)', () => {
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    requireShopOwner(
      reqWith({ role: 'PLATFORM_ADMIN', userType: { slug: 'PLATFORM_ADMIN' }, shopId: null }),
      res,
      next
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 403 FORBIDDEN for CUSTOMER role', () => {
    const next = vi.fn();
    const res = { _status: null, _body: null };
    res.status = (c) => { res._status = c; return res; };
    res.json   = (b) => { res._body = b; return res; };

    requireShopOwner(
      reqWith({ role: 'CUSTOMER', userType: { slug: 'CUSTOMER' }, shopId: null }),
      res,
      next
    );

    expect(res._status).toBe(403);
    expect(res._body.error.code).toBe('FORBIDDEN');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 FORBIDDEN for SHOP_OWNER without a shopId (shop not yet set up)', () => {
    const next = vi.fn();
    const res = { _status: null, _body: null };
    res.status = (c) => { res._status = c; return res; };
    res.json   = (b) => { res._body = b; return res; };

    requireShopOwner(
      reqWith({ shopId: null }),
      res,
      next
    );

    expect(res._status).toBe(403);
    expect(res._body.error.code).toBe('FORBIDDEN');
  });

  it('uses userType.slug when available instead of user.role', () => {
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    // userType.slug = SHOP_OWNER but user.role might be a stale value
    requireShopOwner(
      reqWith({ role: 'CUSTOMER', userType: { slug: 'SHOP_OWNER' }, shopId: 5 }),
      res,
      next
    );

    // slug wins — should pass through
    expect(next).toHaveBeenCalledOnce();
  });
});
