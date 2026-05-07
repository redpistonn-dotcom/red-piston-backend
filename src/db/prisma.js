import { config } from 'dotenv';
config({ override: true }); // ensure Supabase URL wins over system env

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_URL },
  },
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});

// Log which DB we're connecting to (first 60 chars, hide password)
const dbUrl = process.env.DATABASE_URL || '';
const safePart = dbUrl.replace(/:([^@]+)@/, ':***@').substring(0, 60);
console.log(`[DB] Connecting to: ${safePart}...`);

export default prisma;
