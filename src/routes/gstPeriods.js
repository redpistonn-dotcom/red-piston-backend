/**
 * gstPeriods.js — GST period locking
 *
 * Mounted at: /api/shop/gst-periods
 *
 * Once an accountant has filed/reconciled a month, locking it here forces any
 * NEW credit note that would otherwise declare into that period to COMMERCIAL
 * instead (see salesReturns.js createSalesReturn) — flagged, not blocked, same
 * philosophy as Shop.returnPolicyDays. Unlocking is always available for a
 * genuine correction.
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';
import { writeAudit, ET, ACT } from '../lib/audit.js';

const router = Router();

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// ─── GET / — list locked periods ───────────────────────────────────────────────
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const locks = await prisma.gstPeriodLock.findMany({
      where: { shopId: req.shopId },
      orderBy: { period: 'desc' },
    });
    res.json({ success: true, locks });
  } catch (err) { next(err); }
});

// ─── POST /:period/lock — lock a period ("YYYY-MM") ────────────────────────────
router.post('/:period/lock', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { period } = req.params;
    if (!PERIOD_RE.test(period)) {
      return res.status(400).json({ success: false, error: { message: 'period must be in YYYY-MM format' } });
    }
    const lock = await prisma.gstPeriodLock.upsert({
      where: { shopId_period: { shopId: req.shopId, period } },
      create: { shopId: req.shopId, period, lockedBy: req.user.userId },
      update: {},
    });
    writeAudit(req, { entityType: ET.SHOP, entityId: req.shopId, action: ACT.UPDATE, newValue: { gstPeriodLocked: period } });
    res.status(201).json({ success: true, lock });
  } catch (err) { next(err); }
});

// ─── DELETE /:period/lock — unlock a period ────────────────────────────────────
router.delete('/:period/lock', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { period } = req.params;
    await prisma.gstPeriodLock.deleteMany({ where: { shopId: req.shopId, period } });
    writeAudit(req, { entityType: ET.SHOP, entityId: req.shopId, action: ACT.UPDATE, newValue: { gstPeriodUnlocked: period } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
