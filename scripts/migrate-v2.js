/**
 * migrate-v2.js — Apply schema additions that Prisma can't auto-migrate
 * (avoids dropping indexes / breaking prod).
 *
 * Run: node backend/scripts/migrate-v2.js
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

// Use DIRECT_URL for DDL (pgbouncer=true blocks DDL statements)
const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

const steps = [
  // ── part_fitments: position + source ─────────────────────────────────────
  {
    name: 'part_fitments.position',
    sql: `ALTER TABLE part_fitments ADD COLUMN IF NOT EXISTS position TEXT`,
  },
  {
    name: 'part_fitments.source',
    sql: `ALTER TABLE part_fitments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'SHOP_CONFIRMED'`,
  },

  // ── shop_inventory: notes + timestamps ───────────────────────────────────
  {
    name: 'shop_inventory.shop_specific_notes',
    sql: `ALTER TABLE shop_inventory ADD COLUMN IF NOT EXISTS shop_specific_notes TEXT`,
  },
  {
    name: 'shop_inventory.last_purchased_at',
    sql: `ALTER TABLE shop_inventory ADD COLUMN IF NOT EXISTS last_purchased_at TIMESTAMPTZ`,
  },
  {
    name: 'shop_inventory.last_sold_at',
    sql: `ALTER TABLE shop_inventory ADD COLUMN IF NOT EXISTS last_sold_at TIMESTAMPTZ`,
  },
  {
    name: 'shop_inventory.created_at',
    sql: `ALTER TABLE shop_inventory ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
  },
  {
    name: 'shop_inventory.updated_at',
    sql: `ALTER TABLE shop_inventory ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
  },

  // ── marketplace_reviews table ──────────────────────────────────────────────
  {
    name: 'CREATE marketplace_reviews',
    sql: `
      CREATE TABLE IF NOT EXISTS marketplace_reviews (
        review_id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
        master_part_id    TEXT NOT NULL REFERENCES master_parts(master_part_id),
        inventory_id      TEXT REFERENCES shop_inventory(inventory_id),
        order_id          TEXT,
        customer_name     TEXT NOT NULL,
        customer_phone    TEXT,
        rating            SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
        title             TEXT,
        body              TEXT,
        verified_purchase BOOLEAN NOT NULL DEFAULT FALSE,
        helpful_count     INT NOT NULL DEFAULT 0,
        is_hidden         BOOLEAN NOT NULL DEFAULT FALSE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
  },
  {
    name: 'idx_reviews_master_part',
    sql: `CREATE INDEX IF NOT EXISTS idx_reviews_master_part ON marketplace_reviews(master_part_id)`,
  },
  {
    name: 'idx_reviews_inventory',
    sql: `CREATE INDEX IF NOT EXISTS idx_reviews_inventory ON marketplace_reviews(inventory_id)`,
  },
  {
    name: 'idx_reviews_rating',
    sql: `CREATE INDEX IF NOT EXISTS idx_reviews_rating ON marketplace_reviews(master_part_id, rating)`,
  },

  // ── shop_inventory: updated_at trigger ───────────────────────────────────
  {
    name: 'updated_at trigger function',
    sql: `
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql
    `,
  },
  {
    name: 'shop_inventory drop old trigger',
    sql: `DROP TRIGGER IF EXISTS trg_shop_inventory_updated_at ON shop_inventory`,
  },
  {
    name: 'shop_inventory updated_at trigger',
    sql: `
      CREATE TRIGGER trg_shop_inventory_updated_at
        BEFORE UPDATE ON shop_inventory
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `,
  },
];

async function run() {
  console.log('[migrate-v2] Starting schema migration...\n');
  let ok = 0;
  let fail = 0;
  for (const step of steps) {
    try {
      await prisma.$executeRawUnsafe(step.sql);
      console.log(`  ✔  ${step.name}`);
      ok++;
    } catch (e) {
      console.error(`  ✘  ${step.name}: ${e.message}`);
      fail++;
    }
  }
  console.log(`\n[migrate-v2] Done — ${ok} OK, ${fail} failed.`);
  await prisma.$disconnect();
}

run().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
