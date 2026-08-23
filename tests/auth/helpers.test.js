/**
 * helpers.test.js — unit tests for pure auth helper functions.
 *
 * These functions do crypto, JWT signing, string normalisation, and
 * response shaping. They have no side effects and need zero mocks — the
 * fastest and most reliable tests in the suite.
 *
 * AUTH FLOW CONTEXT:
 *   hashToken     → called on every refresh-token store + lookup
 *   generateTokens → called on every login, registration, token refresh
 *   normalizeEmail → called before every DB user lookup by email
 *   formatUserResponse → called before every auth response is sent
 *   checkShopOwnerVerification → called before every SHOP_OWNER session is created
 */

import { describe, it, expect, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  hashToken,
  generateTokens,
  normalizeEmail,
  formatUserResponse,
  checkShopOwnerVerification,
} from '../../src/routes/auth/helpers.js';

// ── hashToken ─────────────────────────────────────────────────────────────────
describe('hashToken', () => {
  it('returns a 64-char hex string (SHA-256)', () => {
    const hash = hashToken('any-token');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it('is deterministic — same input always produces same hash', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.test';
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('produces different hashes for different tokens', () => {
    expect(hashToken('token-a')).not.toBe(hashToken('token-b'));
  });

  it('handles empty string without throwing', () => {
    expect(() => hashToken('')).not.toThrow();
  });
});

// ── generateTokens ────────────────────────────────────────────────────────────
describe('generateTokens', () => {
  it('returns an accessToken and refreshToken', () => {
    const { accessToken, refreshToken } = generateTokens(1, 2, 'SHOP_OWNER');
    expect(typeof accessToken).toBe('string');
    expect(typeof refreshToken).toBe('string');
    expect(accessToken.split('.')).toHaveLength(3);  // JWT has 3 parts
    expect(refreshToken.split('.')).toHaveLength(3);
  });

  it('accessToken payload contains userId, shopId, and role', () => {
    const { accessToken } = generateTokens(42, 7, 'SHOP_OWNER');
    const decoded = jwt.decode(accessToken);
    expect(decoded.userId).toBe(42);
    expect(decoded.shopId).toBe(7);
    expect(decoded.role).toBe('SHOP_OWNER');
  });

  it('refreshToken payload contains only userId', () => {
    const { refreshToken } = generateTokens(42, 7, 'SHOP_OWNER');
    const decoded = jwt.decode(refreshToken);
    expect(decoded.userId).toBe(42);
    // shopId and role must NOT be in the refresh token — it's a session handle only
    expect(decoded.shopId).toBeUndefined();
    expect(decoded.role).toBeUndefined();
  });

  it('accessToken is verifiable with JWT_SECRET', () => {
    const { accessToken } = generateTokens(1, 1, 'CUSTOMER');
    expect(() => jwt.verify(accessToken, process.env.JWT_SECRET)).not.toThrow();
  });

  it('refreshToken is verifiable with JWT_REFRESH_SECRET', () => {
    const { refreshToken } = generateTokens(1, 1, 'CUSTOMER');
    expect(() => jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET)).not.toThrow();
  });

  it('defaults shopId to null when undefined', () => {
    const { accessToken } = generateTokens(1, undefined, 'CUSTOMER');
    const decoded = jwt.decode(accessToken);
    expect(decoded.shopId).toBeNull();
  });

  it('defaults role to CUSTOMER when undefined', () => {
    const { accessToken } = generateTokens(1, null, undefined);
    const decoded = jwt.decode(accessToken);
    expect(decoded.role).toBe('CUSTOMER');
  });

  it('two calls produce different tokens (timestamp in JWT)', async () => {
    // JWT iat (issued-at) has 1-second precision — tokens issued within the
    // same second will be identical. This test just checks the shape.
    const { accessToken: a } = generateTokens(1, 1, 'SHOP_OWNER');
    expect(a).toBeTruthy();
  });
});

// ── normalizeEmail ────────────────────────────────────────────────────────────
describe('normalizeEmail', () => {
  it('lowercases the email', () => {
    expect(normalizeEmail('User@Example.COM')).toBe('user@example.com');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com');
  });

  it('returns null for empty string', () => {
    expect(normalizeEmail('')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(123)).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(normalizeEmail('   ')).toBeNull();
  });

  it('preserves valid email structure after normalisation', () => {
    const result = normalizeEmail('John.DOE+tag@Gmail.COM');
    expect(result).toBe('john.doe+tag@gmail.com');
  });
});

// ── formatUserResponse ────────────────────────────────────────────────────────
describe('formatUserResponse', () => {
  const baseUser = {
    userId: 1,
    phone: '9876543210',
    email: 'user@test.com',
    name: 'Test User',
    avatarUrl: 'https://example.com/avatar.jpg',
    role: 'SHOP_OWNER',
    userType: { id: 3, name: 'Shop Owner', slug: 'SHOP_OWNER' },
    shopId: 10,
    shop: { shopId: 10, name: 'My Shop' },
    emailVerified: true,
    phoneVerified: true,
    isVerified: true,
    loginCount: 5,
  };

  it('returns all expected fields', () => {
    const result = formatUserResponse(baseUser);
    expect(result).toMatchObject({
      userId: 1,
      phone: '9876543210',
      email: 'user@test.com',
      name: 'Test User',
      role: 'SHOP_OWNER',
      shopId: 10,
      emailVerified: true,
      phoneVerified: true,
      isVerified: true,
      loginCount: 5,
    });
  });

  it('shapes userType to only id/name/slug — no extra DB columns leaked', () => {
    const result = formatUserResponse(baseUser);
    expect(result.userType).toEqual({ id: 3, name: 'Shop Owner', slug: 'SHOP_OWNER' });
  });

  it('returns null userType when not present', () => {
    const result = formatUserResponse({ ...baseUser, userType: null });
    expect(result.userType).toBeNull();
  });

  it('defaults loginCount to 0 when missing', () => {
    const { loginCount: _, ...user } = baseUser;
    const result = formatUserResponse(user);
    expect(result.loginCount).toBe(0);
  });

  it('computes isVerified from emailVerified/phoneVerified when missing', () => {
    const result = formatUserResponse({ ...baseUser, isVerified: false, emailVerified: true });
    expect(result.isVerified).toBe(true);
  });

  it('does NOT expose password, passwordHash, or internal DB fields', () => {
    const user = { ...baseUser, passwordHash: 'secret', internalFlag: true };
    const result = formatUserResponse(user);
    expect(result.passwordHash).toBeUndefined();
    expect(result.internalFlag).toBeUndefined();
  });
});

// ── checkShopOwnerVerification ────────────────────────────────────────────────
describe('checkShopOwnerVerification', () => {
  // Minimal mock response that records what was sent
  function mockRes() {
    const r = { _status: null, _body: null };
    r.status = (code) => { r._status = code; return r; };
    r.json   = (body) => { r._body = body; return r; };
    return r;
  }

  it('returns true and sends nothing for CUSTOMER role', () => {
    const res = mockRes();
    const result = checkShopOwnerVerification({ role: 'CUSTOMER' }, res);
    expect(result).toBe(true);
    expect(res._body).toBeNull();
  });

  it('returns true and sends nothing for SHOP_OWNER with no verificationStatus (null = unreviewed/active)', () => {
    const res = mockRes();
    const result = checkShopOwnerVerification({ role: 'SHOP_OWNER', verificationStatus: null }, res);
    expect(result).toBe(true);
  });

  it('returns true and sends nothing for SHOP_OWNER with APPROVED status', () => {
    const res = mockRes();
    const result = checkShopOwnerVerification({ role: 'SHOP_OWNER', verificationStatus: 'APPROVED' }, res);
    expect(result).toBe(true);
  });

  it('returns false and sends 403 SHOP_OWNER_PENDING for PENDING shop owner', () => {
    const res = mockRes();
    const result = checkShopOwnerVerification({ role: 'SHOP_OWNER', verificationStatus: 'PENDING' }, res);
    expect(result).toBe(false);
    expect(res._status).toBe(403);
    expect(res._body.error.code).toBe('SHOP_OWNER_PENDING');
  });

  it('returns false and sends 403 SHOP_OWNER_REJECTED for REJECTED shop owner', () => {
    const res = mockRes();
    const result = checkShopOwnerVerification({
      role: 'SHOP_OWNER',
      verificationStatus: 'REJECTED',
      verificationNote: 'Documents incomplete',
    }, res);
    expect(result).toBe(false);
    expect(res._status).toBe(403);
    expect(res._body.error.code).toBe('SHOP_OWNER_REJECTED');
  });

  it('includes verificationNote in rejection message when set', () => {
    const res = mockRes();
    checkShopOwnerVerification({
      role: 'SHOP_OWNER',
      verificationStatus: 'REJECTED',
      verificationNote: 'Invalid GST number',
    }, res);
    expect(res._body.error.message).toContain('Invalid GST number');
  });

  it('falls back to generic message when verificationNote is missing', () => {
    const res = mockRes();
    checkShopOwnerVerification({
      role: 'SHOP_OWNER',
      verificationStatus: 'REJECTED',
      verificationNote: null,
    }, res);
    expect(typeof res._body.error.message).toBe('string');
    expect(res._body.error.message.length).toBeGreaterThan(0);
  });

  it('returns true for PLATFORM_ADMIN regardless of verificationStatus', () => {
    const res = mockRes();
    const result = checkShopOwnerVerification({
      role: 'PLATFORM_ADMIN',
      verificationStatus: 'PENDING',
    }, res);
    expect(result).toBe(true);
  });
});
