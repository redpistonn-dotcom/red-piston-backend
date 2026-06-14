/**
 * Generates signed test JWTs for UAT using the app's own JWT_SECRET.
 * NOT a bypass — used because MSG91_AUTH_KEY is blank (OTP SMS non-operational in this env).
 */
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const SECRET = process.env.JWT_SECRET || 'autospace-jwt-secret-hyderabad-2025-changeme-prod';
const EXPIRES = '8h';

async function main() {
  // Pick representative users from DB
  const users = await prisma.user.findMany({
    where: { isActive: true, userId: { in: [3, 13, 14, 22] } },
    include: { shop: true, userType: true },
  });

  console.log('=== UAT TEST TOKENS ===');
  for (const u of users) {
    const payload = {
      userId:  u.userId,
      shopId:  u.shopId,
      role:    u.role,
    };
    const token = jwt.sign(payload, SECRET, { expiresIn: EXPIRES });
    console.log(`\n--- userId=${u.userId} name="${u.name}" role=${u.role} shopId=${u.shopId} ---`);
    console.log(`TOKEN: ${token}`);
  }
}

main()
  .catch(e => { console.error(e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
