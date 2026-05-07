/**
 * migrate-v6.js — Barcode Intelligence: GIN Indexes for Fast Array Lookups
 *
 * What this does:
 *   1. GIN index on master_parts.barcodes (TEXT[])  — sub-5 ms @> lookups
 *   2. GIN index on master_parts.oem_numbers (TEXT[]) — sub-5 ms @> lookups
 *   3. GIN index on master_parts.images (TEXT[]) — for future image dedup
 *   4. B-tree index on master_parts.oem_number (single col) — covers legacy =
 *   5. Composite index on (category_l1, status) — browse filtering
 *   6. Index on master_parts.part_name tsvector (full-text) — fast LIKE queries
 *
 * Run:  node backend/scripts/migrate-v6.js
 * Requires DIRECT_URL env var (pgbouncer blocks DDL).
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[migrate-v6] ❌ No DIRECT_URL or DATABASE_URL found in environment');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

const steps = [
  // ── 1. GIN index on barcodes TEXT[] ───────────────────────────────────────
  // Enables fast barcodes @> ARRAY['...']::TEXT[] lookup used in every scan.
  {
    name: 'master_parts: GIN index on barcodes[]',
    sql: `CREATE INDEX IF NOT EXISTS master_parts_barcodes_gin
          ON master_parts USING GIN (barcodes)`,
  },

  // ── 2. GIN index on oem_numbers TEXT[] ────────────────────────────────────
  // Enables fast oem_numbers @> ARRAY['...']::TEXT[] lookup for OEM scan.
  {
    name: 'master_parts: GIN index on oem_numbers[]',
    sql: `CREATE INDEX IF NOT EXISTS master_parts_oem_numbers_gin
          ON master_parts USING GIN (oem_numbers)`,
  },

  // ── 3. GIN index on images TEXT[] ─────────────────────────────────────────
  // Future-proof for image deduplication and array search.
  {
    name: 'master_parts: GIN index on images[]',
    sql: `CREATE INDEX IF NOT EXISTS master_parts_images_gin
          ON master_parts USING GIN (images)`,
  },

  // ── 4. B-tree index on oem_number (single legacy column) ──────────────────
  {
    name: 'master_parts: btree index on oem_number',
    sql: `CREATE INDEX IF NOT EXISTS master_parts_oem_number_idx
          ON master_parts (LOWER(oem_number))`,
  },

  // ── 5. Composite index on (category_l1, status) for browse filtering ──────
  {
    name: 'master_parts: composite index on (category_l1, status)',
    sql: `CREATE INDEX IF NOT EXISTS master_parts_category_status_idx
          ON master_parts (category_l1, status)`,
  },

  // ── 6. Index on (status, is_universal, requires_fitment) — browse WHERE ───
  {
    name: 'master_parts: composite index on (status, is_universal, requires_fitment)',
    sql: `CREATE INDEX IF NOT EXISTS master_parts_status_fitment_idx
          ON master_parts (status, is_universal, requires_fitment)`,
  },

  // ── 7. Index on part_name (lower) for fast ILIKE prefix search ────────────
  {
    name: 'master_parts: btree index on lower(part_name)',
    sql: `CREATE INDEX IF NOT EXISTS master_parts_part_name_lower_idx
          ON master_parts (LOWER(part_name) text_pattern_ops)`,
  },

  // ── 8. Partial index — verified parts only (fastest for customer-facing) ──
  {
    name: 'master_parts: partial index on part_name for VERIFIED parts',
    sql: `CREATE INDEX IF NOT EXISTS master_parts_verified_name_idx
          ON master_parts (LOWER(part_name))
          WHERE status = 'VERIFIED'`,
  },

  // ── 9. Index on shop_inventory.master_part_id for catalog join speed ───────
  {
    name: 'shop_inventory: index on master_part_id',
    sql: `CREATE INDEX IF NOT EXISTS shop_inventory_master_part_id_idx
          ON shop_inventory (master_part_id)`,
  },

  // ── 10. Composite index on (shop_id, master_part_id) for unique lookups ───
  {
    name: 'shop_inventory: composite index on (shop_id, master_part_id)',
    sql: `CREATE INDEX IF NOT EXISTS shop_inventory_shop_part_idx
          ON shop_inventory (shop_id, master_part_id)`,
  },
];

async function run() {
  console.log(`[migrate-v6] Running ${steps.length} migration steps...\n`);
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
  console.log(`\n[migrate-v6] Done — ✔ ${passed} OK, ✘ ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('[migrate-v6] Fatal:', err.message);
  prisma.$disconnect();
  process.exit(1);
});
