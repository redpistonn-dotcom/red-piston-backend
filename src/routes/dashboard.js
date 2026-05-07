import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';

const router = Router();

// GET /api/shop/dashboard?period=today|week|month
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { period = 'today' } = req.query;
    const shopId = req.shopId;

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

    // Sales aggregates
    const salesAgg = await prisma.movement.aggregate({
      where: { shopId, type: 'SALE', createdAt: { gte: startDate } },
      _sum: { totalAmount: true, profit: true },
      _count: true,
    });

    // Purchase aggregates
    const purchaseAgg = await prisma.movement.aggregate({
      where: { shopId, type: 'PURCHASE', createdAt: { gte: startDate } },
      _sum: { totalAmount: true },
      _count: true,
    });

    // Low stock items — cross-column comparison requires raw SQL
    // Prisma does not support WHERE column_a <= column_b in its query builder
    const lowStockRows = await prisma.$queryRaw`
      SELECT si.inventory_id, si.shop_id, si.master_part_id,
             si.selling_price, si.buying_price, si.stock_qty,
             si.min_stock_alert, si.rack_location, si.is_marketplace_listed,
             mp.part_name, mp.brand, mp.category_l1, mp.hsn_code, mp.gst_rate,
             mp.oem_number, mp.unit_of_sale, mp.image_url
      FROM   shop_inventory si
      JOIN   master_parts mp ON mp.master_part_id = si.master_part_id
      WHERE  si.shop_id = ${shopId}
        AND  si.stock_qty <= si.min_stock_alert
      ORDER  BY si.stock_qty ASC
      LIMIT  10
    `;
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
        oemNumber: r.oem_number,
        unitOfSale: r.unit_of_sale,
        imageUrl: r.image_url,
      },
    }));

    // Top selling products
    const topProducts = await prisma.movement.groupBy({
      by: ['inventoryId'],
      where: { shopId, type: 'SALE', createdAt: { gte: startDate } },
      _sum: { qty: true, totalAmount: true },
      orderBy: { _sum: { totalAmount: 'desc' } },
      take: 5,
    });

    // Outstanding dues
    const totalOutstanding = await prisma.party.aggregate({
      where: { shopId, type: { in: ['CUSTOMER', 'BOTH'] } },
      _sum: { outstanding: true },
    });

    res.json({
      period,
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

export default router;
