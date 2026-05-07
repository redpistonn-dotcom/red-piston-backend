/**
 * migrate-v4.js — Layer 2 Role-Specific Profiles
 *
 * What this does:
 *   1. customer_profiles    — wallet_balance, loyalty_points, notification_prefs,
 *                             total_orders, total_spent
 *   2. customer_addresses   — full address book per user with is_default flag
 *   3. customer_vehicle_garage — saved vehicles (garage) per customer
 *   4. shop_users           — staff roster: links users to shops with role + permissions JSONB
 *   5. admin_profiles       — internal ops team: admin_role, department, permissions, ip_whitelist
 *   6. Backfill             — create customer_profiles for existing CUSTOMER role users
 *
 * Run:  node backend/scripts/migrate-v4.js
 * Requires DIRECT_URL env var (pgbouncer URL blocks DDL).
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[migrate-v4] ❌ No DIRECT_URL or DATABASE_URL found in environment');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

const steps = [
  // ── 1. customer_profiles ─────────────────────────────────────────────────────
  // NOTE: existing tables use TEXT PKs (Prisma @default(uuid()) stores as TEXT),
  // so FK columns must also be TEXT, not UUID.
  {
    name: 'create customer_profiles table',
    sql: `
      CREATE TABLE IF NOT EXISTS customer_profiles (
        id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id         TEXT        UNIQUE NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        wallet_balance  DECIMAL(10,2) NOT NULL DEFAULT 0,
        loyalty_points  INTEGER     NOT NULL DEFAULT 0,
        notification_prefs JSONB   NOT NULL DEFAULT '{}',
        total_orders    INTEGER     NOT NULL DEFAULT 0,
        total_spent     DECIMAL(12,2) NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
  },

  // ── 2. customer_profiles: updated_at trigger ──────────────────────────────────
  { name: 'drop old customer_profiles updated_at trigger',
    sql: `DROP TRIGGER IF EXISTS set_customer_profiles_updated_at ON customer_profiles` },
  {
    name: 'attach updated_at trigger to customer_profiles',
    sql: `
      CREATE TRIGGER set_customer_profiles_updated_at
        BEFORE UPDATE ON customer_profiles
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    `,
  },

  // ── 3. customer_addresses ─────────────────────────────────────────────────────
  {
    name: 'create customer_addresses table',
    sql: `
      CREATE TABLE IF NOT EXISTS customer_addresses (
        address_id  TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id     TEXT        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        label       TEXT        NOT NULL DEFAULT 'Home',
        full_name   TEXT        NOT NULL DEFAULT '',
        phone       TEXT        NOT NULL DEFAULT '',
        line1       TEXT        NOT NULL DEFAULT '',
        line2       TEXT,
        landmark    TEXT,
        city        TEXT        NOT NULL DEFAULT '',
        state       TEXT        NOT NULL DEFAULT '',
        pincode     TEXT        NOT NULL DEFAULT '',
        latitude    DECIMAL(9,6),
        longitude   DECIMAL(9,6),
        is_default  BOOLEAN     NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
  },
  {
    name: 'customer_addresses: index on user_id',
    sql: `CREATE INDEX IF NOT EXISTS customer_addresses_user_id_idx ON customer_addresses(user_id)`,
  },

  // ── 4. customer_vehicle_garage ───────────────────────────────────────────────
  {
    name: 'create customer_vehicle_garage table',
    sql: `
      CREATE TABLE IF NOT EXISTS customer_vehicle_garage (
        garage_id        TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id          TEXT        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        vehicle_id       TEXT        REFERENCES vehicles(vehicle_id) ON DELETE SET NULL,
        nickname         TEXT,
        make             TEXT        NOT NULL DEFAULT '',
        model            TEXT        NOT NULL DEFAULT '',
        variant          TEXT,
        year             INTEGER     NOT NULL DEFAULT 0,
        fuel_type        TEXT,
        registration_no  TEXT,
        year_of_purchase INTEGER,
        is_default       BOOLEAN     NOT NULL DEFAULT false,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
  },
  {
    name: 'customer_vehicle_garage: index on user_id',
    sql: `CREATE INDEX IF NOT EXISTS customer_vehicle_garage_user_id_idx ON customer_vehicle_garage(user_id)`,
  },

  // ── 5. shop_users ─────────────────────────────────────────────────────────────
  {
    name: 'create shop_users table',
    sql: `
      CREATE TABLE IF NOT EXISTS shop_users (
        id             TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
        shop_id        TEXT        NOT NULL REFERENCES shops(shop_id) ON DELETE CASCADE,
        user_id        TEXT        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        role           TEXT        NOT NULL DEFAULT 'CASHIER',
        permissions    JSONB       NOT NULL DEFAULT '{}',
        invited_by     TEXT        REFERENCES users(user_id) ON DELETE SET NULL,
        is_active      BOOLEAN     NOT NULL DEFAULT true,
        joined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_active_at TIMESTAMPTZ,
        UNIQUE(shop_id, user_id)
      )
    `,
  },
  {
    name: 'shop_users: index on shop_id',
    sql: `CREATE INDEX IF NOT EXISTS shop_users_shop_id_idx ON shop_users(shop_id)`,
  },

  // ── 6. admin_profiles ────────────────────────────────────────────────────────
  {
    name: 'create admin_profiles table',
    sql: `
      CREATE TABLE IF NOT EXISTS admin_profiles (
        id           TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id      TEXT        UNIQUE NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        admin_role   TEXT        NOT NULL DEFAULT 'SUPPORT',
        department   TEXT,
        permissions  JSONB       NOT NULL DEFAULT '[]',
        ip_whitelist TEXT[]      NOT NULL DEFAULT '{}',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
  },
  { name: 'drop old admin_profiles updated_at trigger',
    sql: `DROP TRIGGER IF EXISTS set_admin_profiles_updated_at ON admin_profiles` },
  {
    name: 'attach updated_at trigger to admin_profiles',
    sql: `
      CREATE TRIGGER set_admin_profiles_updated_at
        BEFORE UPDATE ON admin_profiles
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    `,
  },

  // ── 7. Backfill: create customer_profiles for existing CUSTOMER users ─────────
  {
    name: 'backfill customer_profiles for existing CUSTOMER users',
    sql: `
      INSERT INTO customer_profiles (user_id)
      SELECT user_id FROM users WHERE role = 'CUSTOMER'
      ON CONFLICT (user_id) DO NOTHING
    `,
  },

  // ── 8. Backfill: add OWNER row in shop_users for existing SHOP_OWNER users ────
  {
    name: 'backfill shop_users for existing SHOP_OWNER users',
    sql: `
      INSERT INTO shop_users (shop_id, user_id, role, permissions)
      SELECT shop_id, user_id, 'OWNER',
        '{"billing":true,"inventory":true,"reports":true,"parties":true,"workshop":true,"staff":true}'::jsonb
      FROM users
      WHERE role = 'SHOP_OWNER' AND shop_id IS NOT NULL
      ON CONFLICT (shop_id, user_id) DO NOTHING
    `,
  },
];

async function run() {
  console.log(`[migrate-v4] Running ${steps.length} migration steps...\n`);
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
  console.log(`\n[migrate-v4] Done — ✔ ${passed} OK, ✘ ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('[migrate-v4] Fatal:', err.message);
  prisma.$disconnect();
  process.exit(1);
});
