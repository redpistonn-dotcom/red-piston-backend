import { config } from 'dotenv';
config({ override: true });

import prisma from '../src/db/prisma.js';

// id is auto-assigned: 1=Customer, 2=Shop Staff, 3=Shop Owner, 4=Platform Admin
const USER_TYPES = [
  {
    slug: 'CUSTOMER',
    name: 'Customer',
    description: 'Vehicle owners and mechanics browsing the marketplace',
  },
  {
    slug: 'SHOP_STAFF',
    name: 'Shop Staff',
    description: 'Cashiers and technicians at a shop',
  },
  {
    slug: 'SHOP_OWNER',
    name: 'Shop Owner',
    description: 'Shop owners with full ERP access',
  },
  {
    slug: 'PLATFORM_ADMIN',
    name: 'Platform Admin',
    description: 'Super admin with platform-wide access',
  },
];

async function main() {
  console.log('Seeding UserType rows…');

  // 1. Upsert all user types by slug
  for (const ut of USER_TYPES) {
    const result = await prisma.userType.upsert({
      where: { slug: ut.slug },
      update: {
        name: ut.name,
        description: ut.description,
      },
      create: {
        slug: ut.slug,
        name: ut.name,
        description: ut.description,
        isSystem: true,
      },
    });
    console.log(`  Upserted UserType: ${result.slug} (id=${result.id})`);
  }

  // 2. Build a slug → id map from DB (use what was actually stored)
  const allTypes = await prisma.userType.findMany();
  const slugToId = {};
  for (const ut of allTypes) {
    slugToId[ut.slug] = ut.id;
  }
  console.log('UserType slug→id map:', slugToId);

  // 3. For each user, set userTypeId matching their current role string
  const users = await prisma.user.findMany({
    select: { userId: true, role: true, userTypeId: true },
  });

  console.log(`Syncing userTypeId for ${users.length} user(s)…`);

  let updated = 0;
  let skipped = 0;

  for (const user of users) {
    const targetTypeId = slugToId[user.role];
    if (!targetTypeId) {
      console.warn(`  Warning: no UserType for role="${user.role}" on user ${user.userId} — skipping`);
      skipped++;
      continue;
    }
    if (user.userTypeId === targetTypeId) {
      skipped++;
      continue;
    }
    await prisma.user.update({
      where: { userId: user.userId },
      data: { userTypeId: targetTypeId },
    });
    updated++;
  }

  console.log(`Done. Updated ${updated} user(s), skipped ${skipped} (already correct or unknown role).`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
