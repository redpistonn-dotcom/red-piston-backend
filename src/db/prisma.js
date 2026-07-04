import { config } from 'dotenv';
config({ override: true }); // ensure Supabase URL wins over system env

import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request shop context — populated by authenticate middleware.
// Lets the Prisma safety-net middleware read shopId without touching params.
export const shopContext = new AsyncLocalStorage();

const TENANT_MODELS = new Set([
  'ShopInventory', 'Movement', 'Invoice', 'InvoiceItem', 'Party', 'MarketplaceOrder',
  'PurchaseOrder',
]);

// Append connection_limit to the URL if not already set.
// Supabase free tier allows ~60 total connections; Prisma's default of 10
// per instance exhausts it fast on Render restarts. 5 is safe for a single
// instance and leaves headroom for migrations / admin queries.
//
// connect_timeout / socket_timeout are the actual fix for the "dashboard
// stuck forever after the app sat idle for a day or two" bug: Supabase's
// PgBouncer (or an intermediate NAT/load balancer) silently drops idle
// connections without telling either side. Prisma's pool doesn't know the
// pooled connection is dead, hands it to the next query, and that query
// then waits on a socket that will never respond — with NO timeout set,
// that wait is unbounded (can hang for the OS's TCP retransmission ceiling,
// i.e. effectively forever from the user's point of view). socket_timeout
// bounds any single query to 20s before Prisma kills it and throws, so the
// route can return an error instead of hanging; connect_timeout bounds how
// long establishing a brand-new connection can take.
function buildDbUrl(raw = '') {
  if (!raw || raw.includes('connection_limit=')) return raw;
  const sep = raw.includes('?') ? '&' : '?';
  return `${raw}${sep}connection_limit=5&pool_timeout=10&connect_timeout=10&socket_timeout=20`;
}

const prisma = new PrismaClient({
  datasources: {
    db: { url: buildDbUrl(process.env.DATABASE_URL) },
  },
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});

// Defense-in-depth: auto-inject shopId on every tenant-scoped query.
// Routes already manually scope by shopId — this catches any that don't.
prisma.$use(async (params, next) => {
  const shopId = shopContext.getStore()?.shopId;
  if (!shopId || !params.model || !TENANT_MODELS.has(params.model)) return next(params);

  if (['create', 'createMany'].includes(params.action)) {
    if (Array.isArray(params.args?.data)) {
      params.args.data = params.args.data.map(d => ({ ...d, shopId }));
    } else if (params.args?.data) {
      params.args.data = { ...params.args.data, shopId };
    }
  }

  if (['findMany', 'findFirst', 'findUnique', 'update', 'updateMany',
       'delete', 'deleteMany', 'count', 'aggregate'].includes(params.action)) {
    params.args = params.args || {};
    params.args.where = { shopId, ...params.args.where };
  }

  return next(params);
});

// Log which DB we're connecting to (first 60 chars, hide password)
const dbUrl = process.env.DATABASE_URL || '';
const safePart = dbUrl.replace(/:([^@]+)@/, ':***@').substring(0, 60);
console.log(`[DB] Connecting to: ${safePart}...`);

export default prisma;
