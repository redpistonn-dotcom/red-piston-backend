import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';
import prismaReader from '../db/prisma-reader.js';
import { getOrSet } from '../lib/cache.js';

const router = Router();

/**
 * Resolve the date range from query params.
 * Supports explicit `from`+`to` ISO date strings, or a `period` shorthand.
 * Returns { startDate: Date, endDate: Date }.
 */
function resolveDateRange({ period = 'today', from, to }) {
  if (from && to) {
    return { startDate: new Date(from), endDate: new Date(to + 'T23:59:59.999Z') };
  }
  const now = new Date();
  let startDate;
  if (period === 'today') {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === 'week') {
    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (period === 'month') {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  return { startDate, endDate: now };
}

// GET /api/shop/dashboard?period=today|week|month  (or ?from=YYYY-MM-DD&to=YYYY-MM-DD)
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { period = 'today', from, to } = req.query;
    const shopId = req.shopId;

    const { startDate, endDate } = resolveDateRange({ period, from, to });

    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = from && to
      ? `shop:dashboard:${shopId}:${from}:${to}`
      : `shop:dashboard:${shopId}:${today}:${period}`;

    // These five reads are independent — run them in parallel so the dashboard
    // pays ONE round-trip's latency, not five stacked serially (matters most on
    // a cold/cross-AZ Supabase connection).
    const [salesAgg, purchaseAgg, lowStockRows, topProducts, totalOutstanding] = await getOrSet(cacheKey, 120, async () => Promise.all([
      // Sales aggregates
      prismaReader.movement.aggregate({
        where: { shopId, type: 'SALE', createdAt: { gte: startDate, lte: endDate } },
        _sum: { totalAmount: true, profit: true },
        _count: true,
      }),
      // Purchase aggregates
      prismaReader.movement.aggregate({
        where: { shopId, type: 'PURCHASE', createdAt: { gte: startDate, lte: endDate } },
        _sum: { totalAmount: true },
        _count: true,
      }),
      // Low stock items — cross-column comparison requires raw SQL
      // (Prisma does not support WHERE column_a <= column_b in its query builder)
      prismaReader.$queryRaw`
        SELECT si.inventory_id, si.shop_id, si.master_part_id,
               si.selling_price, si.buying_price, si.stock_qty,
               si.min_stock_alert, si.rack_location, si.is_marketplace_listed,
               mp.part_name, mp.brand, mp.category_l1, mp.hsn_code, mp.gst_rate,
               mp.oem_numbers, mp.unit_of_sale, mp.image_url
        FROM   shop_inventory si
        JOIN   master_parts mp ON mp.master_part_id = si.master_part_id
        WHERE  si.shop_id = ${shopId}
          AND  si.stock_qty <= si.min_stock_alert
        ORDER  BY si.stock_qty ASC
        LIMIT  10
      `,
      // Top selling products
      prismaReader.movement.groupBy({
        by: ['inventoryId'],
        where: { shopId, type: 'SALE', createdAt: { gte: startDate, lte: endDate } },
        _sum: { qty: true, totalAmount: true },
        orderBy: { _sum: { totalAmount: 'desc' } },
        take: 5,
      }),
      // Outstanding dues
      prismaReader.party.aggregate({
        where: { shopId, type: { in: ['CUSTOMER', 'BOTH'] } },
        _sum: { outstanding: true },
      }),
    ]));

    const lowStockItems = lowStockRows.map(r => ({
      inventoryId: r.inventory_id,
      shopId: r.shop_id,
      masterPartId: r.master_part_id,
      sellingPrice: r.selling_price,
      buyingPrice: r.buying_price,
      stockQty: r.stock_qty,
      minStockAlert: r.min_stock_alert,
      rackLocation: r.rack_location,
      isMarketplaceListed: r.is_marketplace_listed,
      masterPart: {
        masterPartId: r.master_part_id,
        partName: r.part_name,
        brand: r.brand,
        categoryL1: r.category_l1,
        hsnCode: r.hsn_code,
        gstRate: r.gst_rate,
        oemNumbers: r.oem_numbers,
        unitOfSale: r.unit_of_sale,
        imageUrl: r.image_url,
      },
    }));

    res.json({
      period: from && to ? 'custom' : period,
      from: startDate.toISOString(),
      to:   endDate.toISOString(),
      revenue: Number(salesAgg._sum.totalAmount || 0),
      profit: Number(salesAgg._sum.profit || 0),
      salesCount: salesAgg._count,
      purchaseAmount: Number(purchaseAgg._sum.totalAmount || 0),
      purchaseCount: purchaseAgg._count,
      totalOutstanding: Number(totalOutstanding._sum.outstanding || 0),
      lowStockCount: lowStockItems.length,
      lowStockItems,
      topProducts,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/shop/dashboard/trend?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns daily revenue / profit / salesCount for the requested range (default: last 30 days).
router.get('/trend', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const shopId = req.shopId;
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
    const from = req.query.from ? new Date(req.query.from) : defaultFrom;
    const to   = req.query.to   ? new Date(req.query.to + 'T23:59:59.999Z') : now;

    const cacheKey = `shop:dashboard:trend:${shopId}:${from.toISOString().slice(0,10)}:${to.toISOString().slice(0,10)}`;

    const rows = await getOrSet(cacheKey, 300, async () =>
      prismaReader.$queryRaw`
        SELECT
          DATE_TRUNC('day', created_at)::date  AS date,
          COALESCE(SUM(total_amount), 0)::float AS revenue,
          COALESCE(SUM(profit), 0)::float       AS profit,
          COUNT(*)::int                          AS "salesCount"
        FROM movements
        WHERE shop_id   = ${shopId}
          AND type      = 'SALE'
          AND created_at >= ${from}
          AND created_at <= ${to}
        GROUP BY DATE_TRUNC('day', created_at)
        ORDER BY DATE_TRUNC('day', created_at) ASC
      `
    );

    const days = rows.map(r => ({
      date:       r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
      revenue:    Number(r.revenue),
      profit:     Number(r.profit),
      salesCount: Number(r.salesCount),
    }));

    res.json({ days });
  } catch (err) {
    next(err);
  }
});

// GET /api/shop/dashboard/product-breakdown?from=YYYY-MM-DD&to=YYYY-MM-DD
// Top products by revenue for the date range, joined to inventory + master parts.
router.get('/product-breakdown', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const shopId = req.shopId;
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
    const from = req.query.from ? new Date(req.query.from) : defaultFrom;
    const to   = req.query.to   ? new Date(req.query.to + 'T23:59:59.999Z') : now;

    const cacheKey = `shop:dashboard:breakdown:${shopId}:${from.toISOString().slice(0,10)}:${to.toISOString().slice(0,10)}`;

    const rows = await getOrSet(cacheKey, 300, async () =>
      prismaReader.$queryRaw`
        SELECT
          m.inventory_id                          AS "inventoryId",
          mp.part_name                            AS "partName",
          mp.brand,
          COALESCE(SUM(m.qty), 0)::int            AS "qtySold",
          COALESCE(SUM(m.total_amount), 0)::float AS revenue,
          COALESCE(SUM(m.profit), 0)::float       AS profit
        FROM movements m
        JOIN shop_inventory si ON si.inventory_id = m.inventory_id
        JOIN master_parts    mp ON mp.master_part_id = si.master_part_id
        WHERE m.shop_id    = ${shopId}
          AND m.type       = 'SALE'
          AND m.created_at >= ${from}
          AND m.created_at <= ${to}
        GROUP BY m.inventory_id, mp.part_name, mp.brand
        ORDER BY revenue DESC
        LIMIT 20
      `
    );

    const products = rows.map(r => ({
      inventoryId: Number(r.inventoryId),
      partName:    r.partName,
      brand:       r.brand,
      qtySold:     Number(r.qtySold),
      revenue:     Number(r.revenue),
      profit:      Number(r.profit),
    }));

    res.json({ products });
  } catch (err) {
    next(err);
  }
});

export default router;
