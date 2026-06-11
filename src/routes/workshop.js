/**
 * workshop.js — Job Cards / Workshop Management
 *
 * Mounted at: /api/shop/workshop
 *
 * Routes:
 *   GET    /api/shop/workshop/jobs                — list job cards (filterable)
 *   POST   /api/shop/workshop/jobs                — create job card
 *   GET    /api/shop/workshop/jobs/:id            — get job card detail
 *   PATCH  /api/shop/workshop/jobs/:id            — update job card fields
 *   PATCH  /api/shop/workshop/jobs/:id/status     — advance status
 *   POST   /api/shop/workshop/jobs/:id/items      — add line item
 *   DELETE /api/shop/workshop/jobs/:id/items/:itemId — remove line item
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';
import { nextSeq, currentYYYYMM } from '../lib/sequence.js';

const router = Router();

const VALID_STATUSES = ['RECEIVED', 'IN_PROGRESS', 'WAITING_PARTS', 'READY', 'DELIVERED', 'CANCELLED'];
const VALID_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];


// GET /api/shop/workshop/jobs
router.get('/jobs', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { status, priority, limit = 50, offset = 0 } = req.query;
    const where = { shopId: req.shopId };
    if (status) where.status = status;
    if (priority) where.priority = priority;

    const [jobs, total] = await Promise.all([
      prisma.jobCard.findMany({
        where,
        include: { items: true },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.jobCard.count({ where }),
    ]);

    res.json({ success: true, data: jobs, total });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/workshop/jobs
router.post('/jobs', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const {
      customerName, customerPhone, vehicleMake, vehicleModel, vehicleYear, vehicleReg,
      vehicleFuel, odometerIn, complaint, priority, estimatedAt, labourCharge, notes, assignedTo,
    } = req.body;

    if (!customerName || !vehicleMake || !vehicleModel) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'customerName, vehicleMake, vehicleModel are required' },
      });
    }

    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PRIORITY', message: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` },
      });
    }

    // Generate job number and create the job card in one atomic transaction.
    // nextSeq uses INSERT ON CONFLICT DO UPDATE which takes a row-level lock on
    // (shop_id, counter_key), serialising concurrent requests on the same key.
    const job = await prisma.$transaction(async (tx) => {
      const yyyymm = currentYYYYMM();
      const seq = await nextSeq(tx, req.shopId, `JOB-${yyyymm}`);
      const jobNumber = `JOB-${yyyymm}-${String(seq).padStart(4, '0')}`;

      return tx.jobCard.create({
        data: {
          jobNumber,
          shopId: req.shopId,
          createdBy: req.user.userId,
          assignedTo: assignedTo || null,
          customerName,
          customerPhone: customerPhone || null,
          vehicleMake,
          vehicleModel,
          vehicleYear: vehicleYear ? parseInt(vehicleYear) : null,
          vehicleReg: vehicleReg || null,
          vehicleFuel: vehicleFuel || null,
          odometerIn: odometerIn ? parseInt(odometerIn) : null,
          complaint: complaint || null,
          priority: priority || 'NORMAL',
          estimatedAt: estimatedAt ? new Date(estimatedAt) : null,
          labourCharge: labourCharge ? parseFloat(labourCharge) : 0,
          notes: notes || null,
        },
        include: { items: true },
      });
    });

    res.status(201).json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

// GET /api/shop/workshop/jobs/:id
router.get('/jobs/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const job = await prisma.jobCard.findFirst({
      where: { jobId: req.params.id, shopId: req.shopId },
      include: { items: { include: { inventory: { include: { masterPart: true } } } } },
    });
    if (!job) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found' } });
    }
    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shop/workshop/jobs/:id
router.patch('/jobs/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const existing = await prisma.jobCard.findFirst({
      where: { jobId: req.params.id, shopId: req.shopId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found' } });
    }

    const {
      assignedTo, customerPhone, odometerOut, diagnosis, complaint,
      labourCharge, paymentMode, paymentStatus, notes, estimatedAt,
    } = req.body;
    const data = {};

    if (assignedTo !== undefined) data.assignedTo = assignedTo;
    if (customerPhone !== undefined) data.customerPhone = customerPhone;
    if (odometerOut !== undefined) data.odometerOut = odometerOut ? parseInt(odometerOut) : null;
    if (diagnosis !== undefined) data.diagnosis = diagnosis;
    if (complaint !== undefined) data.complaint = complaint;
    if (labourCharge !== undefined) data.labourCharge = parseFloat(labourCharge);
    if (paymentMode !== undefined) data.paymentMode = paymentMode;
    if (paymentStatus !== undefined) data.paymentStatus = paymentStatus;
    if (notes !== undefined) data.notes = notes;
    if (estimatedAt !== undefined) data.estimatedAt = estimatedAt ? new Date(estimatedAt) : null;

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, error: { code: 'NO_CHANGES', message: 'Nothing to update' } });
    }

    const updated = await prisma.jobCard.update({
      where: { jobId: req.params.id },
      data,
      include: { items: true },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shop/workshop/jobs/:id/status
router.patch('/jobs/:id/status', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `status must be one of: ${VALID_STATUSES.join(', ')}` },
      });
    }

    const existing = await prisma.jobCard.findFirst({
      where: { jobId: req.params.id, shopId: req.shopId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found' } });
    }

    const data = { status };
    if (status === 'DELIVERED') data.deliveredAt = new Date();
    if (status === 'READY' && !existing.completedAt) data.completedAt = new Date();

    const updated = await prisma.jobCard.update({
      where: { jobId: req.params.id },
      data,
      include: { items: true },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/workshop/jobs/:id/items
router.post('/jobs/:id/items', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const existing = await prisma.jobCard.findFirst({
      where: { jobId: req.params.id, shopId: req.shopId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found' } });
    }

    const { inventoryId, description, qty = 1, unitPrice, type = 'PART' } = req.body;
    if (!description || !unitPrice) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'description and unitPrice are required' },
      });
    }

    const parsedQty = parseInt(qty);
    const parsedPrice = parseFloat(unitPrice);
    if (!Number.isFinite(parsedQty) || parsedQty <= 0 || !Number.isFinite(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_VALUES', message: 'qty must be a positive integer and unitPrice a non-negative number' },
      });
    }
    const total = parsedQty * parsedPrice;

    const item = await prisma.jobCardItem.create({
      data: {
        jobId: req.params.id,
        inventoryId: inventoryId || null,
        description,
        qty: parsedQty,
        unitPrice: parsedPrice,
        total,
        type,
      },
    });

    // Recalculate partsTotal and totalAmount
    const allItems = await prisma.jobCardItem.findMany({ where: { jobId: req.params.id } });
    const partsTotal = allItems.filter(i => i.type === 'PART').reduce((s, i) => s + parseFloat(i.total), 0);
    const totalAmount = partsTotal + parseFloat(existing.labourCharge);

    await prisma.jobCard.update({
      where: { jobId: req.params.id },
      data: { partsTotal, totalAmount },
    });

    res.status(201).json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/shop/workshop/jobs/:id/items/:itemId
router.delete('/jobs/:id/items/:itemId', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const job = await prisma.jobCard.findFirst({
      where: { jobId: req.params.id, shopId: req.shopId },
    });
    if (!job) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found' } });
    }

    await prisma.jobCardItem.delete({ where: { id: req.params.itemId } });

    // Recalculate totals
    const allItems = await prisma.jobCardItem.findMany({ where: { jobId: req.params.id } });
    const partsTotal = allItems.filter(i => i.type === 'PART').reduce((s, i) => s + parseFloat(i.total), 0);
    const totalAmount = partsTotal + parseFloat(job.labourCharge);

    await prisma.jobCard.update({
      where: { jobId: req.params.id },
      data: { partsTotal, totalAmount },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
