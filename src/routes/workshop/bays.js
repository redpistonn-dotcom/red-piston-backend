/**
 * workshop/bays.js — Service Bay management
 *
 * Mounted inside workshopRoutes at /api/shop/workshop
 *
 * Routes:
 *   GET    /bays       — list bays for shop
 *   POST   /bays       — create bay
 *   PATCH  /bays/:id   — rename bay / toggle active
 *   DELETE /bays/:id   — deactivate bay
 */

import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { authenticate, requireShopOwner } from '../../middleware/auth.js';

const router = Router();

// GET /api/shop/workshop/bays
router.get('/bays', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const bays = await prisma.$queryRaw`
      SELECT b.*, COUNT(jc.job_id) FILTER (WHERE jc.status NOT IN ('DELIVERED','CANCELLED')) AS active_jobs
      FROM service_bays b
      LEFT JOIN job_cards jc ON jc.bay_id = b.id AND jc.shop_id = b.shop_id
      WHERE b.shop_id = ${req.shopId}
      GROUP BY b.id
      ORDER BY b.name ASC
    `;
    res.json({ success: true, data: bays });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/workshop/bays
router.post('/bays', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_NAME', message: 'name is required' } });
    }

    const bay = await prisma.$queryRaw`
      INSERT INTO service_bays (shop_id, name)
      VALUES (${req.shopId}, ${name})
      RETURNING *
    `;
    res.status(201).json({ success: true, data: bay[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shop/workshop/bays/:id
router.patch('/bays/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const bayId = parseInt(req.params.id, 10);
    const { name, isActive } = req.body;

    const existing = await prisma.$queryRaw`
      SELECT * FROM service_bays WHERE id = ${bayId} AND shop_id = ${req.shopId}
    `;
    if (!existing[0]) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Bay not found' } });
    }

    const updates = [];
    const params = [];

    if (name !== undefined) {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed) return res.status(400).json({ success: false, error: { code: 'INVALID_NAME', message: 'name cannot be empty' } });
      params.push(trimmed); updates.push(`name = $${params.length}`);
    }
    if (isActive !== undefined) {
      params.push(Boolean(isActive)); updates.push(`is_active = $${params.length}`);
    }
    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'NO_CHANGES', message: 'Nothing to update' } });
    }

    params.push(bayId);
    const updated = await prisma.$queryRawUnsafe(
      `UPDATE service_bays SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      ...params
    );
    res.json({ success: true, data: updated[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/shop/workshop/bays/:id — soft-delete (deactivate)
router.delete('/bays/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const bayId = parseInt(req.params.id, 10);

    // Check bay belongs to shop and has no active jobs
    const existing = await prisma.$queryRaw`
      SELECT b.id,
        COUNT(jc.job_id) FILTER (WHERE jc.status NOT IN ('DELIVERED','CANCELLED')) AS active_jobs
      FROM service_bays b
      LEFT JOIN job_cards jc ON jc.bay_id = b.id AND jc.shop_id = b.shop_id
      WHERE b.id = ${bayId} AND b.shop_id = ${req.shopId}
      GROUP BY b.id
    `;
    if (!existing[0]) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Bay not found' } });
    }
    if (Number(existing[0].active_jobs) > 0) {
      return res.status(422).json({ success: false, error: { code: 'HAS_ACTIVE_JOBS', message: 'Cannot deactivate a bay with active jobs. Reassign them first.' } });
    }

    await prisma.$executeRaw`
      UPDATE service_bays SET is_active = FALSE WHERE id = ${bayId} AND shop_id = ${req.shopId}
    `;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
