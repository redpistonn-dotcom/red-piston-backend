/**
 * migrate-v3.js — Layer 1 Identity & Session Upgrades
 *
 * What this does:
 *   1. users          — add google_id, login_count, is_verified, updated_at
 *   2. refresh_tokens — rename token → token_hash, add shop_id / device_info /
 *                       ip_address / last_used_at / revoked_at / user_id index
 *   3. otp_codes      — add attempts, ip_address, verified_at + lookup index
 *
 * Run:  node backend/scripts/migrate-v3.js
 * Requires DIRECT_URL env var (pgbouncer URL blocks DDL).
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

// Use DIRECT_URL for DDL (pgbouncer=true blocks DDL statements)
const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[migrate-v3] ❌ No DIRECT_URL or DATABASE_URL found in environment');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

const steps = [
  // ── 1. users: add google_id ──────────────────────────────────────────────
  { name: 'users: add google_id',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE` },

  // ── 2. users: add login_count ────────────────────────────────────────────
  { name: 'users: add login_count',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0` },

  // ── 3. users: add is_verified ────────────────────────────────────────────
  { name: 'users: add is_verified',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT false` },

  // ── 4. users: add updated_at ─────────────────────────────────────────────
  { name: 'users: add updated_at',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` },

  // ── 5. users: backfill is_verified from existing flags ───────────────────
  { name: 'users: backfill is_verified',
    sql: `UPDATE users SET is_verified = true WHERE email_verified = true OR phone_verified = true` },

  // ── 6. refresh_tokens: add token_hash (nullable first) ───────────────────
  { name: 'refresh_tokens: add token_hash',
    sql: `ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS token_hash TEXT` },

  // ── 7. refresh_tokens: copy plain token → token_hash ─────────────────────
  //       Existing sessions are effectively invalidated: the old raw token
  //       won't match a SHA-256 hash. Users simply re-login once.
  { name: 'refresh_tokens: copy token → token_hash',
    sql: `UPDATE refresh_tokens SET token_hash = token WHERE token_hash IS NULL AND token IS NOT NULL` },

  // ── 8. refresh_tokens: token_hash NOT NULL ───────────────────────────────
  { name: 'refresh_tokens: NOT NULL token_hash',
    sql: `ALTER TABLE refresh_tokens ALTER COLUMN token_hash SET NOT NULL` },

  // ── 9. refresh_tokens: UNIQUE index on token_hash ────────────────────────
  { name: 'refresh_tokens: unique index token_hash',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_token_hash_key ON refresh_tokens(token_hash)` },

  // ── 10. refresh_tokens: add shop_id ──────────────────────────────────────
  { name: 'refresh_tokens: add shop_id',
    sql: `ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS shop_id TEXT` },

  // ── 11. refresh_tokens: add device_info ──────────────────────────────────
  { name: 'refresh_tokens: add device_info',
    sql: `ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS device_info JSONB NOT NULL DEFAULT '{}'` },

  // ── 12. refresh_tokens: add ip_address ───────────────────────────────────
  { name: 'refresh_tokens: add ip_address',
    sql: `ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS ip_address TEXT` },

  // ── 13. refresh_tokens: add last_used_at ─────────────────────────────────
  { name: 'refresh_tokens: add last_used_at',
    sql: `ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ` },

  // ── 14. refresh_tokens: add revoked_at ───────────────────────────────────
  { name: 'refresh_tokens: add revoked_at',
    sql: `ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ` },

  // ── 15. refresh_tokens: index on user_id ─────────────────────────────────
  { name: 'refresh_tokens: index on user_id',
    sql: `CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx ON refresh_tokens(user_id)` },

  // ── 16. otp_codes: add attempts ──────────────────────────────────────────
  { name: 'otp_codes: add attempts',
    sql: `ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0` },

  // ── 17. otp_codes: add ip_address ────────────────────────────────────────
  { name: 'otp_codes: add ip_address',
    sql: `ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS ip_address TEXT` },

  // ── 18. otp_codes: add verified_at ───────────────────────────────────────
  { name: 'otp_codes: add verified_at',
    sql: `ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ` },

  // ── 19. otp_codes: fast lookup index ─────────────────────────────────────
  { name: 'otp_codes: index on phone + expires_at',
    sql: `CREATE INDEX IF NOT EXISTS otp_codes_phone_expires_idx ON otp_codes(phone, expires_at DESC)` },

  // ── 20. users: updated_at trigger function ────────────────────────────────
  { name: 'create updated_at trigger function',
    sql: `
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    ` },

  // ── 21. drop old trigger if exists ───────────────────────────────────────
  { name: 'drop old users updated_at trigger',
    sql: `DROP TRIGGER IF EXISTS set_users_updated_at ON users` },

  // ── 22. attach trigger ───────────────────────────────────────────────────
  { name: 'attach updated_at trigger to users',
    sql: `
      CREATE TRIGGER set_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    ` },
];

async function run() {
  console.log(`[migrate-v3] Running ${steps.length} migration steps...\n`);
  let passed = 0;
  let failed = 0;

  for (const step of steps) {
    try {
      await prisma.$executeRawUnsafe(step.sql);
      console.log(`  ✔ ${step.name}`);
      passed++;
    } catch (err) {
      console.error(`  ✘ ${step.name}: ${err.message}`);
      failed++;
    }
  }

  await prisma.$disconnect();
  console.log(`\n[migrate-v3] Done — ✔ ${passed} OK, ✘ ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('[migrate-v3] Fatal:', err.message);
  prisma.$disconnect();
  process.exit(1);
});
