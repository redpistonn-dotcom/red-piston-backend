/**
 * migrate-v5.js — Vehicles & Fitment Database Upgrades
 *
 * What this does:
 *   1. vehicles      — add abs_equipped (BOOLEAN), vehicle_type (TEXT)
 *   2. master_parts  — add is_universal (BOOLEAN), requires_fitment (BOOLEAN)
 *   3. Backfill      — set is_universal = true for Engine Oils, Fluids, generic consumables
 *   4. Backfill      — set requires_fitment = true for Brakes, Filters, Ignition, Clutch
 *   5. Indexes       — fast lookup by is_universal and requires_fitment
 *
 * Run:  node backend/scripts/migrate-v5.js
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
  console.error('[migrate-v5] ❌ No DIRECT_URL or DATABASE_URL found in environment');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

const steps = [
  // ── 1. vehicles: abs_equipped ─────────────────────────────────────────────
  {
    name: 'vehicles: add abs_equipped',
    sql: `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS abs_equipped BOOLEAN NOT NULL DEFAULT false`,
  },

  // ── 2. vehicles: vehicle_type ─────────────────────────────────────────────
  {
    name: 'vehicles: add vehicle_type',
    sql: `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_type TEXT NOT NULL DEFAULT 'Car'`,
  },

  // ── 3. master_parts: is_universal ─────────────────────────────────────────
  // Universal parts appear in ALL marketplace searches regardless of vehicle filter.
  // Engine oils, batteries, fuses, cleaning products, nuts/bolts/washers.
  {
    name: 'master_parts: add is_universal',
    sql: `ALTER TABLE master_parts ADD COLUMN IF NOT EXISTS is_universal BOOLEAN NOT NULL DEFAULT false`,
  },

  // ── 4. master_parts: requires_fitment ────────────────────────────────────
  // Vehicle-specific parts MUST have a fitment record to appear when a vehicle is selected.
  // Brake pads, filters, clutch kits, headlights, shock absorbers, etc.
  {
    name: 'master_parts: add requires_fitment',
    sql: `ALTER TABLE master_parts ADD COLUMN IF NOT EXISTS requires_fitment BOOLEAN NOT NULL DEFAULT false`,
  },

  // ── 5. Indexes for fast browse filtering ──────────────────────────────────
  {
    name: 'master_parts: index on is_universal',
    sql: `CREATE INDEX IF NOT EXISTS master_parts_is_universal_idx ON master_parts(is_universal)`,
  },
  {
    name: 'master_parts: index on requires_fitment',
    sql: `CREATE INDEX IF NOT EXISTS master_parts_requires_fitment_idx ON master_parts(requires_fitment)`,
  },
  {
    name: 'vehicles: index on make + model + year_from',
    sql: `CREATE INDEX IF NOT EXISTS vehicles_make_model_year_idx ON vehicles(make, model, year_from)`,
  },

  // ── 6. Backfill: universal parts (engine oils, fluids, generic consumables) ─
  // These show in ALL searches regardless of selected vehicle.
  {
    name: 'backfill: mark universal categories',
    sql: `
      UPDATE master_parts
      SET is_universal = true
      WHERE category_l1 IN ('Engine Oils', 'Fluids', 'Lubricants', 'Coolant', 'Additives')
         OR lower(part_name) LIKE '%engine oil%'
         OR lower(part_name) LIKE '%gear oil%'
         OR lower(part_name) LIKE '%brake fluid%'
         OR lower(part_name) LIKE '%coolant%'
         OR lower(part_name) LIKE '%antifreeze%'
         OR lower(part_name) LIKE '%fuse%'
         OR lower(part_name) LIKE '%battery terminal%'
    `,
  },

  // ── 7. Backfill: vehicle-specific parts that REQUIRE fitment records ───────
  // Without a fitment record these parts must NOT appear when a vehicle is selected.
  {
    name: 'backfill: mark vehicle-specific categories as requires_fitment',
    sql: `
      UPDATE master_parts
      SET requires_fitment = true
      WHERE category_l1 IN (
        'Brakes', 'Filters', 'Ignition', 'Clutch & Transmission',
        'Suspension', 'Steering', 'Exhaust', 'Cooling System',
        'Body & Exterior', 'Electrical'
      )
      AND is_universal = false
    `,
  },

  // ── 8. part_fitments: add engine_code match column (future-proof) ─────────
  {
    name: 'part_fitments: add engine_code_match column',
    sql: `ALTER TABLE part_fitments ADD COLUMN IF NOT EXISTS engine_code_match TEXT`,
  },
];

async function run() {
  console.log(`[migrate-v5] Running ${steps.length} migration steps...\n`);
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
  console.log(`\n[migrate-v5] Done — ✔ ${passed} OK, ✘ ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('[migrate-v5] Fatal:', err.message);
  prisma.$disconnect();
  process.exit(1);
});
