import { config } from 'dotenv';
config({ override: true });
import prisma from '../src/db/prisma.js';
import bcrypt from 'bcryptjs';

async function createAdmin() {
  // Credentials MUST come from environment — never hardcode them in source
  const email    = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('❌ ADMIN_EMAIL and ADMIN_PASSWORD environment variables must be set before running this script.');
    console.error('   Example: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=S3cure! node prisma/create-admin.js');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  // Check if already exists
  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } }
  });

  if (existing) {
    console.log('Admin user already exists:', existing.userId, existing.email, existing.role);
    // Update role to PLATFORM_ADMIN if not already
    if (existing.role !== 'PLATFORM_ADMIN') {
      await prisma.user.update({
        where: { userId: existing.userId },
        data: { role: 'PLATFORM_ADMIN' }
      });
      console.log('Updated role to PLATFORM_ADMIN');
    }
    await prisma.$disconnect();
    return;
  }

  const admin = await prisma.user.create({
    data: {
      email,
      name: 'Super Admin',
      role: 'PLATFORM_ADMIN',
      passwordHash,
      emailVerified: true,
      isVerified: true,
      isActive: true,
    }
  });

  // Link EMAIL auth provider
  await prisma.authProvider.create({
    data: {
      userId: admin.userId,
      provider: 'EMAIL',
      providerId: email,
    }
  });

  console.log('✅ Admin user created successfully!');
  console.log('   Email:', email);
  console.log('   UserId:', admin.userId);
  console.log('   Role:', admin.role);
  await prisma.$disconnect();
}

createAdmin().catch(e => { console.error(e); process.exit(1); });
