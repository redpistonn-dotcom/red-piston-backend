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
import { writeAudit, ET, ACT } from '../lib/audit.js';

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

    // Generate a unique job number, retrying on collision.
    // IMPORTANT: nextSeq must run OUTSIDE the create's transaction. The counter
    // (`number_counters`) can drift BEHIND existing job_number rows (e.g. jobs
    // created under the older client-side numbering scheme), so the first
    // generated number may already exist → P2002. If nextSeq were inside the
    // create transaction, a P2002 rollback would also undo the counter bump and
    // the retry would get the SAME number forever. By incrementing the counter
    // in its own committed statement each attempt, every retry climbs past the
    // collision until it surpasses the max existing number — self-healing.
    const yyyymm = currentYYYYMM();
    const jobData = {
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
    };

    let job;
    const MAX_ATTEMPTS = 25;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const seq = await nextSeq(prisma, req.shopId, `JOB-${yyyymm}`);
      const jobNumber = `JOB-${yyyymm}-${String(seq).padStart(4, '0')}`;
      try {
        job = await prisma.jobCard.create({
          data: { ...jobData, jobNumber },
          include: { items: true },
        });
        break;
      } catch (e) {
        // Only swallow the job_number uniqueness collision; rethrow anything else.
        const isDupJobNumber = e?.code === 'P2002'
          && (e?.meta?.target?.includes?.('job_number') || String(e?.meta?.target || '').includes('job_number'));
        if (isDupJobNumber && attempt < MAX_ATTEMPTS) continue;
        throw e;
      }
    }

    writeAudit(req, { entityType: ET.ORDER, entityId: job.jobId, action: ACT.CREATE, newValue: { jobNumber: job.jobNumber, customerName, vehicleMake, vehicleModel, priority: job.priority } });
    res.status(201).json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

// GET /api/shop/workshop/jobs/:id
router.get('/jobs/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const job = await prisma.jobCard.findFirst({
      where: { jobId: parseInt(req.params.id, 10), shopId: req.shopId },
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
      where: { jobId: parseInt(req.params.id, 10), shopId: req.shopId },
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
      where: { jobId: parseInt(req.params.id, 10) },
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
      where: { jobId: parseInt(req.params.id, 10), shopId: req.shopId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found' } });
    }

    const data = { status };
    if (status === 'DELIVERED') data.deliveredAt = new Date();
    if (status === 'READY' && !existing.completedAt) data.completedAt = new Date();

    const updated = await prisma.jobCard.update({
      where: { jobId: parseInt(req.params.id, 10) },
      data,
      include: { items: true },
    });
    writeAudit(req, { entityType: ET.ORDER, entityId: req.params.id, action: ACT.UPDATE, oldValue: { status: existing.status }, newValue: { status } });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/workshop/jobs/:id/items
router.post('/jobs/:id/items', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const existing = await prisma.jobCard.findFirst({
      where: { jobId: parseInt(req.params.id, 10), shopId: req.shopId },
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
        jobId: parseInt(req.params.id, 10),
        inventoryId: inventoryId || null,
        description,
        qty: parsedQty,
        unitPrice: parsedPrice,
        total,
        type,
      },
    });

    // Recalculate partsTotal and totalAmount
    const allItems = await prisma.jobCardItem.findMany({ where: { jobId: parseInt(req.params.id, 10) } });
    const partsTotal = allItems.filter(i => i.type === 'PART').reduce((s, i) => s + parseFloat(i.total), 0);
    const totalAmount = partsTotal + parseFloat(existing.labourCharge);

    await prisma.jobCard.update({
      where: { jobId: parseInt(req.params.id, 10) },
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
      where: { jobId: parseInt(req.params.id, 10), shopId: req.shopId },
    });
    if (!job) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found' } });
    }

    await prisma.jobCardItem.delete({ where: { id: parseInt(req.params.itemId, 10) } });

    // Recalculate totals
    const allItems = await prisma.jobCardItem.findMany({ where: { jobId: parseInt(req.params.id, 10) } });
    const partsTotal = allItems.filter(i => i.type === 'PART').reduce((s, i) => s + parseFloat(i.total), 0);
    const totalAmount = partsTotal + parseFloat(job.labourCharge);

    await prisma.jobCard.update({
      where: { jobId: parseInt(req.params.id, 10) },
      data: { partsTotal, totalAmount },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
