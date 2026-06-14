/**
 * audit.js — Audit log read endpoints.
 *
 * GET /api/audit/shop       — shop owner's own audit log (scoped to their shopId)
 * GET /api/audit/admin      — platform admin: all audit logs across all shops
 * GET /api/audit/shop/stats — summary counts per action/entity for the shop
 *
 * Query params (all routes):
 *   limit        default 50, max 200
 *   offset       default 0
 *   entityType   filter by entity type (PRODUCT, INVOICE, etc.)
 *   action       filter by action (CREATE, UPDATE, etc.)
 *   userId       filter by user (admin only)
 *   shopId       filter by shop (admin only)
 *   from         ISO date (createdAt >= from)
 *   to           ISO date (createdAt <= to, inclusive)
 *   search       free-text match on entityId or metadata (best-effort)
 */
import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner, requireAdmin } from '../middleware/auth.js';

const router = Router();

function buildWhere(query, fixedShopId = null) {
  const { entityType, action, userId, shopId, from, to } = query;
  const where = {};

  if (fixedShopId != null) {
    where.shopId = fixedShopId;
  } else if (shopId) {
    where.shopId = parseInt(shopId, 10);
  }

  if (entityType) where.entityType = entityType;
  if (action)     where.action     = action;
  if (userId)     where.userId     = parseInt(userId, 10);

  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to)   where.createdAt.lte = new Date(new Date(to).setHours(23, 59, 59, 999));
  }

  return where;
}

// ─── GET /api/audit/shop ──────────────────────────────────────────────────────
router.get('/shop', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const limit  = Math.min(Math.max(parseInt(req.query.limit)  || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const where  = buildWhere(req.query, req.shopId);

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take:    limit,
        skip:    offset,
        select: {
          auditId:    true,
          userId:     true,
          entityType: true,
          entityId:   true,
          action:     true,
          oldValue:   true,
          newValue:   true,
          ipAddress:  true,
          deviceInfo: true,
          metadata:   true,
          createdAt:  true,
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({ success: true, logs, total, limit, offset });
  } catch (err) {
    console.error('[GET /audit/shop]', err);
    next(err);
  }
});

// ─── GET /api/audit/shop/stats ───────────────────────────────────────────────
router.get('/shop/stats', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const where = buildWhere(req.query, req.shopId);

    const byAction = await prisma.auditLog.groupBy({
      by: ['action'],
      where,
      _count: { _all: true },
      orderBy: { _count: { action: 'desc' } },
    });

    const byEntity = await prisma.auditLog.groupBy({
      by: ['entityType'],
      where,
      _count: { _all: true },
      orderBy: { _count: { entityType: 'desc' } },
    });

    res.json({
      success: true,
      byAction: byAction.map(r => ({ action: r.action, count: r._count._all })),
      byEntity: byEntity.map(r => ({ entityType: r.entityType, count: r._count._all })),
    });
  } catch (err) {
    console.error('[GET /audit/shop/stats]', err);
    next(err);
  }
});

// ─── GET /api/audit/admin ─────────────────────────────────────────────────────
router.get('/admin', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const limit  = Math.min(Math.max(parseInt(req.query.limit)  || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const where  = buildWhere(req.query);

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take:    limit,
        skip:    offset,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({ success: true, logs, total, limit, offset });
  } catch (err) {
    console.error('[GET /audit/admin]', err);
    next(err);
  }
});

export default router;
