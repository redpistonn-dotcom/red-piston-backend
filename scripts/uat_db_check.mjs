/**
 * UAT DB check — reads live DB state for runtime certification.
 * Run: node --experimental-vm-modules scripts/uat_db_check.mjs
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('\n=== DB USER SUMMARY ===');
  const users = await prisma.user.findMany({
    select: { userId: true, name: true, role: true, isActive: true, shopId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  console.log(`Total users fetched (last 20): ${users.length}`);
  users.forEach(u => console.log(
    `  userId=${u.userId} role=${u.role} shopId=${u.shopId} active=${u.isActive} name="${u.name}"`
  ));

  console.log('\n=== LIVE OTP CODES (not expired, not used) ===');
  const otps = await prisma.otpCode.findMany({
    where: { used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { otpId: true, phone: true, attempts: true, expiresAt: true, createdAt: true },
  });
  console.log(`Live OTPs: ${otps.length}`);
  otps.forEach(o => console.log(`  phone=${o.phone} attempts=${o.attempts} expires=${o.expiresAt.toISOString()}`));

  console.log('\n=== RECENT REFRESH TOKENS (last 5) ===');
  const tokens = await prisma.refreshToken.findMany({
    where: { revoked: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { userId: true, createdAt: true, expiresAt: true, ipAddress: true },
  });
  tokens.forEach(t => console.log(`  userId=${t.userId} expires=${t.expiresAt.toISOString()} ip=${t.ipAddress}`));

  console.log('\n=== AUDIT LOG (last 10 entries) ===');
  const audits = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { auditId: true, userId: true, shopId: true, entityType: true, action: true, createdAt: true },
  });
  if (audits.length === 0) console.log('  (no rows yet)');
  audits.forEach(a => console.log(
    `  auditId=${a.auditId} userId=${a.userId} shopId=${a.shopId} ${a.entityType}/${a.action} at=${a.createdAt.toISOString()}`
  ));

  console.log('\n=== SHOPS ===');
  const shops = await prisma.shop.findMany({
    take: 10,
    select: { shopId: true, shopName: true, isActive: true, isApproved: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  shops.forEach(s => console.log(`  shopId=${s.shopId} name="${s.shopName}" active=${s.isActive} approved=${s.isApproved}`));

  console.log('\n=== INVENTORY ITEM COUNT PER SHOP ===');
  const inv = await prisma.shopInventory.groupBy({ by: ['shopId'], _count: { inventoryId: true } });
  inv.forEach(i => console.log(`  shopId=${i.shopId} items=${i._count.inventoryId}`));

  console.log('\n=== INVOICE COUNT PER SHOP ===');
  const invCount = await prisma.invoice.groupBy({ by: ['shopId'], _count: { invoiceId: true } });
  invCount.forEach(i => console.log(`  shopId=${i.shopId} invoices=${i._count.invoiceId}`));

  console.log('\n=== MOVEMENTS (last 5) ===');
  const movs = await prisma.movement.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { movementId: true, shopId: true, type: true, quantity: true, createdAt: true },
  });
  movs.forEach(m => console.log(`  movId=${m.movementId} shopId=${m.shopId} type=${m.type} qty=${m.quantity}`));

  console.log('\n=== MARKETPLACE ORDERS (last 5) ===');
  const orders = await prisma.marketplaceOrder.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { orderId: true, shopId: true, status: true, createdAt: true },
  });
  orders.forEach(o => console.log(`  orderId=${o.orderId} shopId=${o.shopId} status=${o.status}`));

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
