/**
 * seed_body_types.cjs
 *
 * 1. Seeds the vehicle_body_types table (one row per body style per vehicle type).
 * 2. Backfills body_type_id + vehicle_type_id on vehicle_models from existing
 *    body_type / vehicle_type string columns.
 * 3. Backfills body_type_id + vehicle_type_id on vehicles the same way.
 *
 * Safe to re-run — upsert everywhere.
 *
 * Run:  node prisma/seed_body_types.cjs
 */

'use strict';
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── Body type definitions ─────────────────────────────────────────────────────
// vehicleTypeSlug must match vehicle_types.slug exactly.
// slug must match the values used in vehicle_models.body_type / vehicles.body_type.
const BODY_TYPES = [

  // ── Car / Passenger Vehicle (slug = 'car') ────────────────────────────────
  { vehicleTypeSlug: 'car', name: 'Hatchback',         slug: 'hatchback',    icon: '🚗', sortOrder: 1  },
  { vehicleTypeSlug: 'car', name: 'Sedan',              slug: 'sedan',        icon: '🚘', sortOrder: 2  },
  { vehicleTypeSlug: 'car', name: 'SUV',                slug: 'suv',          icon: '🚙', sortOrder: 3  },
  { vehicleTypeSlug: 'car', name: 'MPV / MUV',          slug: 'mpv',          icon: '🚐', sortOrder: 4  },
  { vehicleTypeSlug: 'car', name: 'Crossover',          slug: 'crossover',    icon: '🚗', sortOrder: 5  },
  { vehicleTypeSlug: 'car', name: 'Coupe',              slug: 'coupe',        icon: '🏎️', sortOrder: 6  },
  { vehicleTypeSlug: 'car', name: 'Convertible',        slug: 'convertible',  icon: '🏎️', sortOrder: 7  },
  { vehicleTypeSlug: 'car', name: 'Station Wagon',      slug: 'station-wagon',icon: '🚗', sortOrder: 8  },
  { vehicleTypeSlug: 'car', name: 'Van (Passenger)',    slug: 'van',          icon: '🚐', sortOrder: 9  },
  { vehicleTypeSlug: 'car', name: 'Minivan',            slug: 'minivan',      icon: '🚐', sortOrder: 10 },

  // ── Motorcycle / 2-Wheeler (slug = '2wheeler') ────────────────────────────
  { vehicleTypeSlug: '2wheeler', name: 'Motorcycle',          slug: 'motorcycle',       icon: '🏍️', sortOrder: 1 },
  { vehicleTypeSlug: '2wheeler', name: 'Scooter',              slug: 'scooter',          icon: '🛵', sortOrder: 2 },
  { vehicleTypeSlug: '2wheeler', name: 'Moped',                slug: 'moped',            icon: '🛵', sortOrder: 3 },
  { vehicleTypeSlug: '2wheeler', name: 'Sports Bike',          slug: 'sports-bike',      icon: '🏍️', sortOrder: 4 },
  { vehicleTypeSlug: '2wheeler', name: 'Cruiser',              slug: 'cruiser',          icon: '🏍️', sortOrder: 5 },
  { vehicleTypeSlug: '2wheeler', name: 'Adventure / Tourer',   slug: 'adventure-tourer', icon: '🏍️', sortOrder: 6 },
  { vehicleTypeSlug: '2wheeler', name: 'Off-Road / Enduro',    slug: 'off-road',         icon: '🏍️', sortOrder: 7 },

  // ── Commercial Vehicle / LCV / HCV (slug = 'commercial') ─────────────────
  { vehicleTypeSlug: 'commercial', name: 'Mini Truck (SCV)',          slug: 'mini-truck',   icon: '🚚', sortOrder: 1 },
  { vehicleTypeSlug: 'commercial', name: 'Pickup Truck',              slug: 'pickup',       icon: '🛻', sortOrder: 2 },
  { vehicleTypeSlug: 'commercial', name: 'Light Commercial (LCV)',     slug: 'lcv',          icon: '🚛', sortOrder: 3 },
  { vehicleTypeSlug: 'commercial', name: 'Medium & Heavy Truck (MHV)', slug: 'truck',        icon: '🚛', sortOrder: 4 },
  { vehicleTypeSlug: 'commercial', name: 'Tipper',                    slug: 'tipper',       icon: '🚛', sortOrder: 5 },
  { vehicleTypeSlug: 'commercial', name: 'Tanker',                    slug: 'tanker',       icon: '🚛', sortOrder: 6 },
  { vehicleTypeSlug: 'commercial', name: 'Bus',                       slug: 'bus',          icon: '🚌', sortOrder: 7 },
  { vehicleTypeSlug: 'commercial', name: 'Mini Bus / School Bus',      slug: 'mini-bus',     icon: '🚌', sortOrder: 8 },
  { vehicleTypeSlug: 'commercial', name: 'Cargo Van',                 slug: 'cargo-van',    icon: '🚚', sortOrder: 9 },

  // ── Tractor / Farm Equipment (slug = 'tractor') ───────────────────────────
  { vehicleTypeSlug: 'tractor', name: 'Tractor',           slug: 'tractor',      icon: '🚜', sortOrder: 1 },
  { vehicleTypeSlug: 'tractor', name: 'Mini Tractor',       slug: 'mini-tractor', icon: '🚜', sortOrder: 2 },
  { vehicleTypeSlug: 'tractor', name: 'Power Tiller',       slug: 'power-tiller', icon: '🚜', sortOrder: 3 },
  { vehicleTypeSlug: 'tractor', name: 'Harvester / Combine',slug: 'harvester',    icon: '🌾', sortOrder: 4 },
  { vehicleTypeSlug: 'tractor', name: 'Farm Implement',     slug: 'implement',    icon: '🌾', sortOrder: 5 },

  // ── Auto Rickshaw / 3-Wheeler (slug = 'autorickshaw') ────────────────────
  { vehicleTypeSlug: 'autorickshaw', name: 'Auto Rickshaw (Passenger)', slug: '3-wheeler',         icon: '🛺', sortOrder: 1 },
  { vehicleTypeSlug: 'autorickshaw', name: '3-Wheeler Cargo (Tempo)',   slug: '3-wheeler-cargo',   icon: '🛺', sortOrder: 2 },
  { vehicleTypeSlug: 'autorickshaw', name: 'E-Rickshaw',                slug: 'e-rickshaw',        icon: '🛺', sortOrder: 3 },

  // ── Electric Vehicle (slug = 'ev') ────────────────────────────────────────
  { vehicleTypeSlug: 'ev', name: 'Electric Car',          slug: 'electric-car',          icon: '⚡', sortOrder: 1 },
  { vehicleTypeSlug: 'ev', name: 'Electric Scooter',      slug: 'electric-scooter',      icon: '⚡', sortOrder: 2 },
  { vehicleTypeSlug: 'ev', name: 'Electric Motorcycle',   slug: 'electric-motorcycle',   icon: '⚡', sortOrder: 3 },
  { vehicleTypeSlug: 'ev', name: 'Electric 3-Wheeler',    slug: 'electric-3-wheeler',    icon: '⚡', sortOrder: 4 },
  { vehicleTypeSlug: 'ev', name: 'Electric Bus',          slug: 'electric-bus',          icon: '⚡', sortOrder: 5 },
  { vehicleTypeSlug: 'ev', name: 'Electric LCV',          slug: 'electric-lcv',          icon: '⚡', sortOrder: 6 },
];

async function main() {
  console.log('\n🚗  Seeding vehicle body types...\n');

  // ── Step 1: Load all vehicle types → build slug→id map ──────────────────
  const vehicleTypes = await prisma.vehicleType.findMany({
    select: { id: true, slug: true, name: true },
  });
  if (vehicleTypes.length === 0) {
    throw new Error('vehicle_types table is empty — run the vehicle_types seed first.');
  }
  const vtMap = Object.fromEntries(vehicleTypes.map(vt => [vt.slug, vt.id]));
  console.log(`  Found ${vehicleTypes.length} vehicle types: ${vehicleTypes.map(v => v.slug).join(', ')}\n`);

  // ── Step 2: Upsert body types ────────────────────────────────────────────
  console.log(`  Upserting ${BODY_TYPES.length} body types...`);
  let created = 0, updated = 0;

  for (const bt of BODY_TYPES) {
    const vehicleTypeId = vtMap[bt.vehicleTypeSlug];
    if (!vehicleTypeId) {
      console.warn(`  ⚠️  Unknown vehicleTypeSlug "${bt.vehicleTypeSlug}" — skipping ${bt.slug}`);
      continue;
    }
    const result = await prisma.vehicleBodyType.upsert({
      where: { slug: bt.slug },
      create: {
        vehicleTypeId,
        name:      bt.name,
        slug:      bt.slug,
        icon:      bt.icon || null,
        sortOrder: bt.sortOrder,
      },
      update: {
        vehicleTypeId,
        name:      bt.name,
        icon:      bt.icon || null,
        sortOrder: bt.sortOrder,
      },
    });
    // upsert always returns the record; we can't easily tell create vs update without extra query
    created++;
  }
  console.log(`  ✅  ${created} body types upserted.\n`);

  // Build slug→id map for body types
  const allBodyTypes = await prisma.vehicleBodyType.findMany({
    select: { bodyTypeId: true, slug: true, vehicleTypeId: true },
  });
  const btMap = Object.fromEntries(allBodyTypes.map(b => [b.slug, b.bodyTypeId]));

  // ── Step 3: Backfill vehicle_models.vehicle_type_id ─────────────────────
  console.log('  Backfilling vehicle_models.vehicle_type_id...');
  const models = await prisma.vehicleModel.findMany({
    select: { modelId: true, vehicleType: true, bodyType: true },
  });
  let modelVtUpdated = 0, modelBtUpdated = 0;
  for (const m of models) {
    const newVtId = vtMap[m.vehicleType] ?? null;
    const newBtId = m.bodyType ? (btMap[m.bodyType] ?? null) : null;
    if (newVtId !== null || newBtId !== null) {
      await prisma.vehicleModel.update({
        where: { modelId: m.modelId },
        data: {
          ...(newVtId !== null && { vehicleTypeId: newVtId }),
          ...(newBtId !== null && { bodyTypeId: newBtId }),
        },
      });
      if (newVtId !== null) modelVtUpdated++;
      if (newBtId !== null) modelBtUpdated++;
    }
  }
  console.log(`  ✅  vehicle_models: ${modelVtUpdated} vehicle_type_id set, ${modelBtUpdated} body_type_id set.\n`);

  // ── Step 4: Backfill vehicles.vehicle_type_id + vehicles.body_type_id ───
  console.log('  Backfilling vehicles.vehicle_type_id and vehicles.body_type_id...');
  // vehicle_type on Vehicle rows is stored as the slug (set by seed_vehicles.cjs)
  const vehicles = await prisma.vehicle.findMany({
    select: { vehicleId: true, vehicleType: true, bodyType: true },
  });
  let vehVtUpdated = 0, vehBtUpdated = 0;
  for (const v of vehicles) {
    // vehicle.vehicleType is the slug (e.g. "car", "2wheeler") from our seed
    const slug = (v.vehicleType || '').toLowerCase();
    const newVtId = vtMap[slug] ?? null;
    const newBtId = v.bodyType ? (btMap[v.bodyType] ?? null) : null;
    if (newVtId !== null || newBtId !== null) {
      await prisma.vehicle.update({
        where: { vehicleId: v.vehicleId },
        data: {
          ...(newVtId !== null && { vehicleTypeId: newVtId }),
          ...(newBtId !== null && { bodyTypeId: newBtId }),
        },
      });
      if (newVtId !== null) vehVtUpdated++;
      if (newBtId !== null) vehBtUpdated++;
    }
  }
  console.log(`  ✅  vehicles: ${vehVtUpdated} vehicle_type_id set, ${vehBtUpdated} body_type_id set.\n`);

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalBt = await prisma.vehicleBodyType.count();
  console.log('═'.repeat(50));
  console.log('  Seed complete!');
  console.log(`  Body types in DB    : ${totalBt}`);
  console.log(`  vehicle_models rows : ${models.length}`);
  console.log(`  vehicles rows       : ${vehicles.length}`);
  console.log('═'.repeat(50));
}

main()
  .catch(e => { console.error('\n❌  Seed failed:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
