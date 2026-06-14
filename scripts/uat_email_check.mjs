import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

// Check which users have password hashes and emails
const users = await p.user.findMany({
  where: { isActive: true, passwordHash: { not: null }, email: { not: null } },
  select: { userId: true, name: true, email: true, role: true, shopId: true, emailVerified: true },
  orderBy: { userId: 'asc' },
  take: 20,
});
console.log('Users with email+password:');
users.forEach(u => console.log(`  userId=${u.userId} role=${u.role} shopId=${u.shopId} email="${u.email}" verified=${u.emailVerified} name="${u.name}"`));

// Check Cloudinary env in .env (confirm what's actually loaded)
console.log('\nCloudinary env:');
console.log('  CLOUDINARY_CLOUD_NAME:', process.env.CLOUDINARY_CLOUD_NAME || '(not set)');
console.log('  CLOUDINARY_API_KEY:', process.env.CLOUDINARY_API_KEY ? 'SET' : '(not set)');
console.log('  CLOUDINARY_API_SECRET:', process.env.CLOUDINARY_API_SECRET ? 'SET' : '(BLANK)');

// Check recent invoices for any shop to know which shops have data
const invoices = await p.invoice.findMany({
  orderBy: { createdAt: 'desc' }, take: 5,
  select: { invoiceId: true, shopId: true, invoiceNumber: true, invoiceType: true, totalAmount: true, createdAt: true },
});
console.log('\nRecent invoices:', invoices.length);
invoices.forEach(i => console.log(`  invId=${i.invoiceId} shopId=${i.shopId} num=${i.invoiceNumber} type=${i.invoiceType} amount=${i.totalAmount}`));

// Check shops with inventory
const invCounts = await p.shopInventory.groupBy({ by: ['shopId'], _count: { inventoryId: true } });
console.log('\nInventory counts per shop:');
invCounts.forEach(i => console.log(`  shopId=${i.shopId} items=${i._count.inventoryId}`));

await p.$disconnect();
