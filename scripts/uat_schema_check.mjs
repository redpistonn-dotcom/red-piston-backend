import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // Check actual columns on otp_codes table
  const cols = await prisma.$queryRaw`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'otp_codes'
    ORDER BY ordinal_position;
  `;
  console.log('\n=== otp_codes columns in DB ===');
  cols.forEach(c => console.log(`  ${c.column_name} | ${c.data_type} | nullable=${c.is_nullable}`));

  console.log('\n=== audit_logs columns in DB ===');
  const acols = await prisma.$queryRaw`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs'
    ORDER BY ordinal_position;
  `;
  acols.forEach(c => console.log(`  ${c.column_name} | ${c.data_type}`));

  console.log('\n=== All tables in schema ===');
  const tables = await prisma.$queryRaw`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name;
  `;
  tables.forEach(t => console.log(`  ${t.table_name}`));

  // Get live OTPs via raw SQL (bypassing Prisma model issue)
  console.log('\n=== Live OTP codes (raw SQL) ===');
  const otps = await prisma.$queryRaw`
    SELECT id, phone, email, code, attempts, expires_at, used, created_at
    FROM otp_codes
    WHERE used = false AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 10;
  `.catch(e => { console.log('  OTP raw query error:', e.message); return []; });
  otps.forEach(o => console.log(`  id=${o.id} phone=${o.phone} code=${o.code} attempts=${o.attempts} expires=${o.expires_at}`));

  // User phones
  console.log('\n=== User phones (for OTP testing) ===');
  const users = await prisma.$queryRaw`
    SELECT u.user_id, u.name, u.role, ap.provider_id as phone
    FROM users u
    LEFT JOIN auth_providers ap ON ap.user_id = u.user_id AND ap.provider = 'PHONE'
    WHERE u.is_active = true
    ORDER BY u.user_id
    LIMIT 15;
  `;
  users.forEach(u => console.log(`  userId=${u.user_id} role=${u.role} name="${u.name}" phone=${u.phone}`));
}

main().catch(e => { console.error(e.message); process.exit(1); }).finally(() => prisma.$disconnect());
