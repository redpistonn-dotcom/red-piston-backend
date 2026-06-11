// Usage: node scripts/run-migration.mjs prisma/migrations/<file>.sql
import fs from 'fs';
import prisma from '../src/db/prisma.js';

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/run-migration.mjs <sql-file>'); process.exit(1); }

const sql = fs.readFileSync(file, 'utf8');
const stmts = sql
  .split(';')
  .map((s) => s.replace(/--[^\n]*/g, '').trim())
  .filter(Boolean);

for (const s of stmts) {
  await prisma.$executeRawUnsafe(s);
  console.log('OK:', s.slice(0, 70).replace(/\s+/g, ' '));
}
console.log('Migration complete.');
process.exit(0);
