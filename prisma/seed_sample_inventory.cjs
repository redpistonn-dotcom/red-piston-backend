/**
 * seed_sample_inventory.cjs
 *
 * Creates sample marketplace-listed shop_inventory rows for all active shops,
 * using master parts already in the database.
 *
 * What it does:
 *   1. Loads all active shops.
 *   2. Picks ~200 clean, recognizable master parts (skips garbage names).
 *   3. Splits them across shops so each shop carries a different mix
 *      (realistic multi-seller scenario — popular parts in 4-5 shops,
 *       niche parts unique per shop).
 *   4. Assigns sensible selling / buying prices based on part-name keywords.
 *   5. Sets isMarketplaceListed = true so customers see them immediately.
 *
 * Uses createMany + skipDuplicates — fast (one batch per shop), safe to re-run.
 *
 * Run:   node prisma/seed_sample_inventory.cjs
 * Clear: node prisma/seed_sample_inventory.cjs --clear
 */

'use strict';
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── Pricing heuristics ────────────────────────────────────────────────────────
function guessPricing(partName) {
  const n = partName.toLowerCase();

  if (/strut assy|shock absorber|radiator|ac compressor|alternator|starter motor/.test(n))
    return { buying: 3500, selling: 4800 };
  if (/clutch kit|clutch cover assy|pressure plate/.test(n))
    return { buying: 2200, selling: 3200 };
  if (/front bumper|rear bumper|bumper complete/.test(n))
    return { buying: 2000, selling: 2900 };
  if (/timing chain kit|timing belt kit/.test(n))
    return { buying: 1800, selling: 2600 };
  if (/brake disc|brake rotor/.test(n))
    return { buying: 1400, selling: 1999 };
  if (/clutch disc|clutch plate/.test(n))
    return { buying: 1200, selling: 1750 };
  if (/water pump/.test(n))
    return { buying: 900, selling: 1350 };
  if (/fuel pump/.test(n))
    return { buying: 1100, selling: 1600 };
  if (/suspension bush kit|bush kit|susp.*kit/.test(n))
    return { buying: 700, selling: 1050 };
  if (/brake pad/.test(n))
    return { buying: 600, selling: 899 };
  if (/timing belt(?! kit)/.test(n))
    return { buying: 550, selling: 849 };
  if (/wiper blade|wiper set/.test(n))
    return { buying: 350, selling: 549 };
  if (/oil filter|fuel filter|air filter|cabin filter|pre filter/.test(n))
    return { buying: 180, selling: 299 };
  if (/spark plug/.test(n))
    return { buying: 120, selling: 199 };
  if (/gear shift cable/.test(n))
    return { buying: 450, selling: 699 };
  if (/release bearing|clutch bearing/.test(n))
    return { buying: 380, selling: 579 };
  if (/gasket|seal/.test(n))
    return { buying: 90, selling: 149 };
  if (/kit-pad|brake kit|pad assy/.test(n))
    return { buying: 700, selling: 1050 };
  if (/filter kit/.test(n))
    return { buying: 400, selling: 649 };
  return { buying: 250, selling: 399 };
}

// ±15% price variation per shop so prices differ between sellers
function jitter(price, seed) {
  const s = Math.abs(Math.sin(seed * 9301 + 49297));
  return Math.round(price * (0.87 + s * 0.26));
}

// Deterministic shuffle using a seed
function seededShuffle(arr, seed) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = Math.abs(s) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Filter garbage-named parts
function isCleanName(name) {
  if (!name || name.length < 4) return false;
  if (/^[.\-\d\s]/.test(name)) return false;
  if (/^\d{4,}/.test(name)) return false;
  if (/^[A-Z0-9\s\-\/\.]{1,8}$/.test(name) && !/[a-z]/.test(name)) return false;
  return true;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const isClear = process.argv.includes('--clear');

  // ── 0. Clear mode ──────────────────────────────────────────────────────────
  if (isClear) {
    console.log('\n⚠️   --clear flag: removing SEEDED inventory rows...\n');
    const deleted = await prisma.shopInventory.deleteMany({
      where: { shopSpecificNotes: 'SEEDED' },
    });
    console.log(`  ✅  Removed ${deleted.count} seeded rows.\n`);
    return;
  }

  console.log('\n🛒  Seeding sample marketplace inventory...\n');

  // ── 1. Load shops ──────────────────────────────────────────────────────────
  const shops = await prisma.shop.findMany({
    where: { isActive: true },
    select: { shopId: true, name: true, city: true },
    orderBy: { shopId: 'asc' },
  });
  if (shops.length === 0) throw new Error('No active shops found.');
  console.log(`  Found ${shops.length} active shops:`);
  shops.forEach(s => console.log(`    Shop ${s.shopId} — ${s.name} (${s.city || 'n/a'})`));

  // ── 2. Load + filter master parts ─────────────────────────────────────────
  console.log('\n  Loading master parts from DB...');
  const raw = await prisma.masterPart.findMany({
    where:   { status: 'VERIFIED' },
    select:  { masterPartId: true, partName: true },
    take:    5000,
    skip:    90,
    orderBy: { masterPartId: 'asc' },
  });
  const clean = raw.filter(p => isCleanName(p.partName));
  const chosen = seededShuffle(clean, 42).slice(0, 200);
  console.log(`  Chosen ${chosen.length} clean parts for seeding.`);

  const popular = chosen.slice(0, 60);   // these go into most shops
  const niche   = chosen.slice(60);      // distributed uniquely per shop

  const TOTAL_PER_SHOP = 70;
  const NICHE_PER_SHOP = TOTAL_PER_SHOP - popular.length; // 10

  // ── 3. Batch insert per shop ───────────────────────────────────────────────
  console.log('\n  Inserting inventory rows...\n');
  let totalCreated = 0;

  for (const shop of shops) {
    const shopNiche = seededShuffle(niche, shop.shopId * 1337).slice(0, NICHE_PER_SHOP);
    const shopParts = [...popular, ...shopNiche];

    // Build all data rows for this shop in memory
    const rows = shopParts.map((part, idx) => {
      const base  = guessPricing(part.partName);
      const seed  = shop.shopId * 10000 + part.masterPartId;
      const stock = 5 + Math.floor(Math.abs(Math.sin(seed)) * 80);
      return {
        shopId:              shop.shopId,
        masterPartId:        part.masterPartId,
        sellingPrice:        jitter(base.selling, seed),
        buyingPrice:         jitter(base.buying,  seed + 1),
        stockQty:            stock,
        reservedQty:         0,
        minStockAlert:       5,
        isMarketplaceListed: true,
        shopSpecificNotes:   'SEEDED',
      };
    });

    // One batch insert per shop — skipDuplicates handles re-runs
    const result = await prisma.shopInventory.createMany({
      data: rows,
      skipDuplicates: true,
    });

    console.log(`  Shop ${shop.shopId} (${shop.name}): inserted ${result.count} / ${rows.length} rows`);
    totalCreated += result.count;
  }

  // ── 4. Summary ─────────────────────────────────────────────────────────────
  const totalInv    = await prisma.shopInventory.count();
  const totalListed = await prisma.shopInventory.count({ where: { isMarketplaceListed: true } });

  console.log('\n' + '═'.repeat(55));
  console.log('  Seed complete!');
  console.log(`  Rows inserted this run  : ${totalCreated}`);
  console.log(`  Total shop_inventory    : ${totalInv}`);
  console.log(`  Marketplace listed      : ${totalListed}`);
  console.log('═'.repeat(55));
  console.log('\n  💡  Run with --clear to remove these seeded rows later.\n');
}

main()
  .catch(e => { console.error('\n❌  Seed failed:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
