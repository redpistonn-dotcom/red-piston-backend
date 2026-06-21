/**
 * Unit tests for src/lib/crypto.js
 *
 * FIELD_ENCRYPTION_KEY is set here (and also in tests/setup.js) so the module
 * sees it regardless of import order.  We use dynamic import() inside beforeAll
 * to guarantee the env var is in place before getDerivedKey() is first called.
 */

process.env.FIELD_ENCRYPTION_KEY = "test-encryption-key-for-unit-tests-here";

import { describe, it, expect, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// Load the module under test after the env var is set
// ---------------------------------------------------------------------------

let encrypt;
let decrypt;

beforeAll(async () => {
  const mod = await import("../src/lib/crypto.js");
  encrypt = mod.encrypt;
  decrypt = mod.decrypt;
});

// ---------------------------------------------------------------------------
// encrypt()
// ---------------------------------------------------------------------------

describe("encrypt()", () => {
  it("returns a non-plaintext string in iv:tag:cipher format", () => {
    const plaintext = "hello world";
    const result = encrypt(plaintext);

    expect(result).not.toBe(plaintext);
    expect(typeof result).toBe("string");

    const parts = result.split(":");
    expect(parts).toHaveLength(3);

    const [ivHex, tagHex, cipherHex] = parts;
    // IV = 16 bytes → 32 hex chars
    expect(ivHex).toHaveLength(32);
    // GCM auth tag = 16 bytes → 32 hex chars
    expect(tagHex).toHaveLength(32);
    // Ciphertext must be non-empty
    expect(cipherHex.length).toBeGreaterThan(0);
  });

  it("returns null for null input", () => {
    expect(encrypt(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(encrypt(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    // Implementation treats "" as absent and returns null
    expect(encrypt("")).toBeNull();
  });

  it("produces different ciphertexts for the same value (random IV)", () => {
    const value = "same-value-encrypted-twice";
    const first = encrypt(value);
    const second = encrypt(value);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Each call generates a fresh random IV, so the full token always differs
    expect(first).not.toBe(second);
  });

  it("encrypts a phone number", () => {
    const phone = "+919876543210";
    const result = encrypt(phone);
    expect(result).not.toBe(phone);
    expect(result.split(":")).toHaveLength(3);
  });

  it("encrypts a GSTIN string", () => {
    const gstin = "27AAPFU0939F1ZV";
    const result = encrypt(gstin);
    expect(result).not.toBe(gstin);
    expect(result.split(":")).toHaveLength(3);
  });

  it("encrypts a bank account number", () => {
    const account = "50100123456789";
    const result = encrypt(account);
    expect(result).not.toBe(account);
    expect(result.split(":")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// decrypt()
// ---------------------------------------------------------------------------

describe("decrypt()", () => {
  it("round-trips: decrypt(encrypt(x)) returns the original value", () => {
    const original = "round-trip test value";
    expect(decrypt(encrypt(original))).toBe(original);
  });

  it("returns null for null input", () => {
    expect(decrypt(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(decrypt(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(decrypt("")).toBeNull();
  });

  it("returns plaintext unchanged when input is not in iv:tag:cipher format (backward compat)", () => {
    // A plain legacy value stored before encryption was introduced
    expect(decrypt("plaintext")).toBe("plaintext");
  });

  it("returns input unchanged for a two-part colon string (not exactly 3 parts)", () => {
    expect(decrypt("foo:bar")).toBe("foo:bar");
  });

  it("round-trips a phone number", () => {
    const phone = "+919876543210";
    expect(decrypt(encrypt(phone))).toBe(phone);
  });

  it("round-trips a GSTIN string", () => {
    const gstin = "27AAPFU0939F1ZV";
    expect(decrypt(encrypt(gstin))).toBe(gstin);
  });

  it("round-trips a bank account number", () => {
    const account = "50100123456789";
    expect(decrypt(encrypt(account))).toBe(account);
  });

  it("returns ciphertext unchanged when iv/tag hex lengths are wrong (malformed token)", () => {
    // 3 colon-separated parts but IV is only 6 bytes (12 hex chars) — invalid
    const malformed = "aabbccddeeff:aabbccddeeff00112233445566778899:deadbeef";
    expect(decrypt(malformed)).toBe(malformed);
  });
});
