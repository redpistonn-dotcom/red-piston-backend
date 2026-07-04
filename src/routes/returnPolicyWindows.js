/**
 * returnPolicyWindows.js — category/brand-level return-window overrides
 *
 * Mounted at: /api/shop/return-policy-windows
 *
 * Shop.returnPolicyDays (set on the Shop Settings page) remains the default;
 * these rows override it for a specific brand or category. See
 * src/lib/return-policy.js for the resolution order (brand > category > default).
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';
import { writeAudit, ET, ACT } from '../lib/audit.js';

const router = Router();
const VALID_SCOPES = ['CATEGORY', 'BRAND'];

// ─── GET / — list overrides ────────────────────────────────────────────────────
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const windows = await prisma.returnPolicyWindow.findMany({
      where: { shopId: req.shopId },
      orderBy: [{ scope: 'asc' }, { value: 'asc' }],
    });
    res.json({ success: true, windows });
  } catch (err) { next(err); }
});

// ─── POST / — create or update an override ─────────────────────────────────────
router.post('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { scope, value, days } = req.body;
    if (!VALID_SCOPES.includes(scope)) {
      return res.status(400).json({ success: false, error: { message: `scope must be one of: ${VALID_SCOPES.join(', ')}` } });
    }
    if (!value || typeof value !== 'string') {
      return res.status(400).json({ success: false, error: { message: 'value is required' } });
    }
    const daysNum = parseInt(days, 10);
    if (!Number.isFinite(daysNum) || daysNum < 0) {
      return res.status(400).json({ success: false, error: { message: 'days must be a non-negative integer' } });
    }

    const window = await prisma.returnPolicyWindow.upsert({
      where: { shopId_scope_value: { shopId: req.shopId, scope, value } },
      create: { shopId: req.shopId, scope, value, days: daysNum },
      update: { days: daysNum },
    });

    writeAudit(req, { entityType: ET.SHOP, entityId: req.shopId, action: ACT.UPDATE, newValue: { returnPolicyWindow: { scope, value, days: daysNum } } });
    res.status(201).json({ success: true, window });
  } catch (err) { next(err); }
});

// ─── DELETE /:id — remove an override ──────────────────────────────────────────
router.delete('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await prisma.returnPolicyWindow.deleteMany({ where: { id, shopId: req.shopId } });
    writeAudit(req, { entityType: ET.SHOP, entityId: req.shopId, action: ACT.DELETE, newValue: { returnPolicyWindowId: id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
