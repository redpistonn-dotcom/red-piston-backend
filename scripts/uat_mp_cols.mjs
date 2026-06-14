import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const cols = await p.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='master_parts' ORDER BY ordinal_position`;
console.log('master_parts columns:', cols.map(c=>c.column_name).join(', '));
await p.$disconnect();
