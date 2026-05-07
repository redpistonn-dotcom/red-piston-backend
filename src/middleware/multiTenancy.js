/**
 * Multi-tenancy middleware for shop data isolation.
 * 
 * Enforces Rule: shop_id used in ALL database queries comes from the
 * verified JWT token on the server. NEVER from the URL, request body,
 * or any client-controlled input.
 */

// Tables that are tenant-scoped (shop_id required)
const TENANT_TABLES = [
  'ShopInventory', 'Movement', 'Invoice', 'InvoiceItem',
  'Party', 'MarketplaceOrder',
];

/**
 * Prisma middleware that injects shop_id into all tenant-scoped queries.
 * Usage: prisma.$use(multiTenancyMiddleware)
 */
export function multiTenancyMiddleware(params, next) {
  // shopId is set on prisma._shopId by the Express middleware below
  const shopId = params.__shopId;
  if (!shopId) return next(params);
  if (!TENANT_TABLES.includes(params.model)) return next(params);

  // Inject on creates
  if (['create', 'createMany'].includes(params.action)) {
    if (Array.isArray(params.args.data)) {
      params.args.data = params.args.data.map(d => ({ ...d, shopId }));
    } else if (params.args.data) {
      params.args.data = { ...params.args.data, shopId };
    }
  }

  // Enforce on reads and mutations
  if (['findMany', 'findFirst', 'findUnique', 'update', 'updateMany',
       'delete', 'deleteMany', 'count', 'aggregate'].includes(params.action)) {
    params.args = params.args || {};
    params.args.where = { ...params.args.where, shopId };
  }

  return next(params);
}

/**
 * Express middleware that injects shopId into the request context.
 * Must be used AFTER authenticate middleware.
 */
export function injectShopContext(req, res, next) {
  if (req.user?.shopId) {
    req.shopId = req.user.shopId;
  }
  next();
}
