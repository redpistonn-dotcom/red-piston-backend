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
import { VALID_STATUSES, canOwnerTransition } from '../lib/mechanic-transitions.js';

const router = Router();

const VALID_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const VALID_APPROVAL_METHODS = ['IN_PERSON', 'PHONE', 'OWNER'];
const VALID_QC_RESULTS = ['QC_PASSED', 'QC_REWORK'];


// GET /api/shop/workshop/jobs
router.get('/jobs', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { status, priority, limit = 50, offset = 0 } = req.query;
    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;

    let statusClause = '';
    let priorityClause = '';
    const params = [req.shopId];

    if (status && VALID_STATUSES.includes(status)) {
      params.push(status);
      statusClause = `AND jc.status = $${params.length}`;
    }
    if (priority && ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(priority)) {
      params.push(priority);
      priorityClause = `AND jc.priority = $${params.length}`;
    }
    params.push(lim, off);

    const jobs = await prisma.$queryRawUnsafe(`
      SELECT
        jc.job_id, jc.job_number, jc.customer_name, jc.customer_phone,
        jc.vehicle_make, jc.vehicle_model, jc.vehicle_reg, jc.vehicle_year,
        jc.complaint, jc.diagnosis, jc.status, jc.priority,
        jc.estimated_at, jc.labour_charge, jc.parts_total, jc.total_amount,
        jc.payment_status, jc.created_at, jc.updated_at, jc.delivered_at,
        jc.assigned_to, jc.assigned_to_user_id,
        jc.qc_status, jc.mechanic_invoice_id, jc.mechanic_progress,
        jc.quotation_status, jc.quotation_number, jc.quotation_grand_total,
        jc.customer_notified_at, jc.delivery_at, jc.bay_id,
        jc.fuel_level, jc.check_in_at,
        u.name AS mechanic_name,
        b.name AS bay_name,
        (SELECT COUNT(*) FROM job_card_items WHERE job_id = jc.job_id) AS item_count,
        (SELECT COUNT(*) FROM job_card_photos WHERE job_id = jc.job_id) AS photo_count
      FROM job_cards jc
      LEFT JOIN users u ON u.user_id = jc.assigned_to_user_id
      LEFT JOIN service_bays b ON b.id = jc.bay_id
      WHERE jc.shop_id = $1 ${statusClause} ${priorityClause}
      ORDER BY jc.updated_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, ...params);

    const countParams = [req.shopId];
    let countStatusClause = '';
    let countPriorityClause = '';
    if (status && VALID_STATUSES.includes(status)) {
      countParams.push(status);
      countStatusClause = `AND status = $${countParams.length}`;
    }
    if (priority && ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(priority)) {
      countParams.push(priority);
      countPriorityClause = `AND priority = $${countParams.length}`;
    }
    const total = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM job_cards WHERE shop_id = $1 ${countStatusClause} ${countPriorityClause}`,
      ...countParams
    );

    res.json({ success: true, data: jobs, total: Number(total[0]?.count ?? 0) });
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
      assignedTo, assignedToUserId, customerPhone, odometerOut, diagnosis, complaint,
      labourCharge, paymentMode, paymentStatus, notes, estimatedAt,
    } = req.body;
    const data = {};

    if (assignedTo !== undefined) data.assignedTo = assignedTo;
    if (assignedToUserId !== undefined) data.assignedToUserId = assignedToUserId ? parseInt(assignedToUserId, 10) : null;
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

    if (!canOwnerTransition(existing.status, status)) {
      return res.status(422).json({
        success: false,
        error: { code: 'INVALID_TRANSITION', message: `Cannot move from ${existing.status} to ${status}` },
      });
    }

    const data = { status };
    if (status === 'DELIVERED') data.deliveredAt = new Date();
    if (status === 'READY' && !existing.completedAt) data.completedAt = new Date();

    const updated = await prisma.jobCard.update({
      where: { jobId: parseInt(req.params.id, 10) },
      data,
      include: { items: true },
    });

    await prisma.$executeRawUnsafe(
      `INSERT INTO job_card_timeline (job_id, actor_user_id, event, from_status, to_status)
       VALUES ($1, $2, 'STATUS_CHANGED', $3, $4)`,
      parseInt(req.params.id, 10), req.user.userId, existing.status, status
    );

    writeAudit(req, { entityType: ET.ORDER, entityId: req.params.id, action: ACT.UPDATE, oldValue: { status: existing.status }, newValue: { status } });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shop/workshop/jobs/:id/qc — QC pass or rework
router.patch('/jobs/:id/qc', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { result, notes } = req.body;
    if (!VALID_QC_RESULTS.includes(result)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_QC_RESULT', message: `result must be one of: ${VALID_QC_RESULTS.join(', ')}` },
      });
    }

    const existing = await prisma.jobCard.findFirst({
      where: { jobId: parseInt(req.params.id, 10), shopId: req.shopId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found' } });
    }
    if (existing.status !== 'READY') {
      return res.status(422).json({ success: false, error: { code: 'NOT_READY', message: 'QC can only be performed on jobs with status READY' } });
    }

    // QC_PASSED → status becomes QC_PASSED; QC_REWORK → status stays READY, mechanic gets rework
    const newStatus = result === 'QC_PASSED' ? 'QC_PASSED' : 'QC_REWORK';

    await prisma.$executeRawUnsafe(`
      UPDATE job_cards SET
        status = $1, qc_status = $2, qc_by = $3, qc_at = NOW(), qc_notes = $4, updated_at = NOW()
      WHERE job_id = $5
    `, newStatus, result, req.user.userId, notes || null, parseInt(req.params.id, 10));

    await prisma.$executeRawUnsafe(
      `INSERT INTO job_card_timeline (job_id, actor_user_id, event, from_status, to_status, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      parseInt(req.params.id, 10), req.user.userId, result, 'READY', newStatus, notes || null
    );

    writeAudit(req, { entityType: ET.ORDER, entityId: req.params.id, action: ACT.UPDATE, newValue: { qcResult: result } });
    res.json({ success: true, data: { status: newStatus, qcStatus: result } });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shop/workshop/jobs/:id/approve — record customer approval
router.patch('/jobs/:id/approve', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { approvalStatus, approvalMethod, remarks } = req.body;
    const VALID_APPROVAL_STATUSES = ['APPROVED', 'REVISION', 'REJECTED'];
    if (!VALID_APPROVAL_STATUSES.includes(approvalStatus)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: `approvalStatus must be one of: ${VALID_APPROVAL_STATUSES.join(', ')}` } });
    }
    if (!VALID_APPROVAL_METHODS.includes(approvalMethod)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_METHOD', message: `approvalMethod must be one of: ${VALID_APPROVAL_METHODS.join(', ')}` } });
    }

    const existing = await prisma.jobCard.findFirst({
      where: { jobId: parseInt(req.params.id, 10), shopId: req.shopId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found' } });
    }

    await prisma.$executeRawUnsafe(`
      UPDATE job_cards SET
        approval_status = $1, approval_method = $2, approved_by = $3,
        approved_at = NOW(), approval_remarks = $4, updated_at = NOW()
      WHERE job_id = $5
    `, approvalStatus, approvalMethod, req.user.userId, remarks || null, parseInt(req.params.id, 10));

    await prisma.$executeRawUnsafe(
      `INSERT INTO job_card_timeline (job_id, actor_user_id, event, note)
       VALUES ($1, $2, 'APPROVED', $3)`,
      parseInt(req.params.id, 10), req.user.userId,
      `${approvalStatus} via ${approvalMethod}${remarks ? ': ' + remarks : ''}`
    );

    writeAudit(req, { entityType: ET.ORDER, entityId: req.params.id, action: ACT.UPDATE, newValue: { approvalStatus, approvalMethod } });
    res.json({ success: true, data: { approvalStatus, approvalMethod } });
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

// PATCH /api/shop/workshop/jobs/:id/checkin — record vehicle check-in details
router.patch('/jobs/:id/checkin', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const existing = await prisma.jobCard.findFirst({
      where: { jobId, shopId: req.shopId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found' } });
    }

    const { fuelLevel, accessoriesReceived, spareKey, visibleCondition, consultationNotes } = req.body;
    const VALID_FUEL_LEVELS = ['EMPTY', 'QUARTER', 'HALF', 'THREE_QUARTER', 'FULL'];

    if (fuelLevel && !VALID_FUEL_LEVELS.includes(fuelLevel)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_FUEL_LEVEL', message: `fuelLevel must be one of: ${VALID_FUEL_LEVELS.join(', ')}` },
      });
    }

    const accessories = Array.isArray(accessoriesReceived)
      ? accessoriesReceived.filter(a => typeof a === 'string' && a.trim())
      : null;

    // Build PostgreSQL array literal {elem1,elem2} — JSON format won't cast to text[]
    const pgArray = accessories && accessories.length > 0
      ? '{' + accessories.map(a => '"' + a.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}'
      : null;

    await prisma.$executeRaw`
      UPDATE job_cards SET
        fuel_level = COALESCE(${fuelLevel || null}, fuel_level),
        accessories_received = COALESCE(${pgArray}::text[], accessories_received),
        spare_key = COALESCE(${spareKey !== undefined ? Boolean(spareKey) : null}, spare_key),
        visible_condition = COALESCE(${visibleCondition || null}, visible_condition),
        consultation_notes = COALESCE(${consultationNotes || null}, consultation_notes),
        check_in_at = COALESCE(check_in_at, NOW()),
        check_in_by = COALESCE(check_in_by, ${req.user.userId}),
        updated_at = NOW()
      WHERE job_id = ${jobId}
    `;

    await prisma.$executeRaw`
      INSERT INTO job_card_timeline (job_id, actor_user_id, event, note)
      VALUES (${jobId}, ${req.user.userId}, 'VEHICLE_CHECKED_IN',
        ${[fuelLevel ? `Fuel: ${fuelLevel}` : null, spareKey ? 'Spare key received' : null, visibleCondition || null].filter(Boolean).join(' | ') || 'Check-in recorded'})
    `;

    writeAudit(req, { entityType: ET.ORDER, entityId: jobId, action: ACT.UPDATE, newValue: { fuelLevel, spareKey } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shop/workshop/jobs/:id/bay — assign/unassign service bay
router.patch('/jobs/:id/bay', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const { bayId } = req.body;

    const existing = await prisma.jobCard.findFirst({ where: { jobId, shopId: req.shopId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found' } });
    }

    if (bayId !== null && bayId !== undefined) {
      const bay = await prisma.$queryRaw`
        SELECT id FROM service_bays WHERE id = ${parseInt(bayId, 10)} AND shop_id = ${req.shopId} AND is_active = TRUE
      `;
      if (!bay[0]) {
        return res.status(404).json({ success: false, error: { code: 'BAY_NOT_FOUND', message: 'Bay not found or inactive' } });
      }
    }

    const newBayId = bayId !== null && bayId !== undefined ? parseInt(bayId, 10) : null;
    await prisma.$executeRaw`
      UPDATE job_cards SET bay_id = ${newBayId}, updated_at = NOW() WHERE job_id = ${jobId}
    `;

    await prisma.$executeRaw`
      INSERT INTO job_card_timeline (job_id, actor_user_id, event, note)
      VALUES (${jobId}, ${req.user.userId}, 'BAY_ASSIGNED', ${newBayId ? `Bay #${newBayId}` : 'Bay unassigned'})
    `;

    res.json({ success: true, data: { bayId: newBayId } });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/workshop/jobs/:id/notify — notify customer vehicle is ready
router.post('/jobs/:id/notify', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);

    const rows = await prisma.$queryRaw`
      SELECT jc.*, s.name AS shop_name, s.address AS shop_address
      FROM job_cards jc
      JOIN shops s ON s.shop_id = jc.shop_id
      WHERE jc.job_id = ${jobId} AND jc.shop_id = ${req.shopId}
    `;
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found' } });
    }
    const job = rows[0];

    const grandTotal = parseFloat(job.total_amount ?? 0);
    const whatsappText = [
      `Hi ${job.customer_name}!`,
      ``,
      `Your vehicle is ready for pickup at *${job.shop_name}*.`,
      `Vehicle: ${job.vehicle_make} ${job.vehicle_model}${job.vehicle_reg ? ` (${job.vehicle_reg})` : ''}`,
      `Job No: ${job.job_number}`,
      grandTotal > 0 ? `Amount Due: ₹${grandTotal.toFixed(2)}` : null,
      ``,
      `We look forward to seeing you!`,
    ].filter(Boolean).join('\n');

    const digits = (job.customer_phone || '').replace(/\D/g, '');
    const whatsappLink = digits
      ? `https://wa.me/${digits.startsWith('91') ? digits : '91' + digits}?text=${encodeURIComponent(whatsappText)}`
      : null;

    // Record notification timestamp
    await prisma.$executeRaw`
      UPDATE job_cards SET customer_notified_at = NOW(), updated_at = NOW()
      WHERE job_id = ${jobId}
    `;

    await prisma.$executeRaw`
      INSERT INTO job_card_timeline (job_id, actor_user_id, event, note)
      VALUES (${jobId}, ${req.user.userId}, 'CUSTOMER_NOTIFIED', 'Customer notified vehicle is ready')
    `;

    // Fire-and-forget email if customer_email available
    if (job.customer_email) {
      (async () => {
        try {
          const { Resend } = await import('resend');
          const resend = new Resend(process.env.RESEND_API_KEY);
          await resend.emails.send({
            from: process.env.EMAIL_FROM || 'noreply@redpiston.in',
            to: job.customer_email,
            subject: `Your vehicle is ready — ${job.shop_name}`,
            html: `<p>Hi ${job.customer_name},</p><p>Your ${job.vehicle_make} ${job.vehicle_model} is ready for pickup at <strong>${job.shop_name}</strong>.</p><p>Job: ${job.job_number}${grandTotal > 0 ? `<br>Amount Due: ₹${grandTotal.toFixed(2)}` : ''}</p>`,
          });
        } catch (e) {
          console.error('[notify] email failed:', e?.message);
        }
      })();
    }

    writeAudit(req, { entityType: ET.ORDER, entityId: jobId, action: ACT.UPDATE, newValue: { customerNotified: true } });
    res.json({ success: true, data: { whatsappLink, notifiedAt: new Date().toISOString() } });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shop/workshop/jobs/:id/deliver — record vehicle delivery + signature
router.patch('/jobs/:id/deliver', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const existing = await prisma.jobCard.findFirst({ where: { jobId, shopId: req.shopId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found' } });
    }
    if (existing.status !== 'QC_PASSED') {
      return res.status(422).json({ success: false, error: { code: 'NOT_READY', message: 'Job must be QC_PASSED before delivery' } });
    }

    const { customerSignatureUrl, odometerOut } = req.body;

    await prisma.$executeRaw`
      UPDATE job_cards SET
        status = 'DELIVERED',
        delivered_at = NOW(),
        delivery_at = NOW(),
        delivery_by = ${req.user.userId},
        customer_signature_url = ${customerSignatureUrl || null},
        odometer_out = ${odometerOut ? parseInt(odometerOut) : null},
        updated_at = NOW()
      WHERE job_id = ${jobId}
    `;

    await prisma.$executeRaw`
      INSERT INTO job_card_timeline (job_id, actor_user_id, event, from_status, to_status, note)
      VALUES (${jobId}, ${req.user.userId}, 'STATUS_CHANGED', 'QC_PASSED', 'DELIVERED',
        ${customerSignatureUrl ? 'Customer signature captured' : 'Vehicle delivered'})
    `;

    writeAudit(req, { entityType: ET.ORDER, entityId: jobId, action: ACT.UPDATE, newValue: { status: 'DELIVERED', customerSignatureUrl: !!customerSignatureUrl } });
    res.json({ success: true, data: { status: 'DELIVERED' } });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shop/workshop/jobs/:id/part-requests/:reqId — approve/reject mechanic part request
router.patch('/jobs/:id/part-requests/:reqId', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const reqId = parseInt(req.params.reqId, 10);
    const { status, reviewNotes } = req.body;

    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'status must be APPROVED or REJECTED' } });
    }

    const request = await prisma.$queryRaw`
      SELECT * FROM job_card_part_requests WHERE id = ${reqId} AND job_id = ${jobId} AND shop_id = ${req.shopId}
    `;
    if (!request[0]) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Part request not found' } });
    }

    await prisma.$executeRaw`
      UPDATE job_card_part_requests SET
        status = ${status},
        reviewed_by = ${req.user.userId},
        review_notes = ${reviewNotes || null},
        updated_at = NOW()
      WHERE id = ${reqId}
    `;

    await prisma.$executeRaw`
      INSERT INTO job_card_timeline (job_id, actor_user_id, event, note)
      VALUES (${jobId}, ${req.user.userId}, 'PART_REQUEST_REVIEWED',
        ${`${request[0].description}: ${status}${reviewNotes ? ' — ' + reviewNotes : ''}`})
    `;

    res.json({ success: true, data: { status } });
  } catch (err) {
    next(err);
  }
});

// GET /api/shop/workshop/part-requests — all pending part requests for shop
router.get('/part-requests', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { status = 'PENDING' } = req.query;
    const requests = await prisma.$queryRaw`
      SELECT pr.*, u.name AS requested_by_name,
             jc.job_number, jc.customer_name, jc.vehicle_make, jc.vehicle_model
      FROM job_card_part_requests pr
      JOIN users u ON u.user_id = pr.requested_by
      JOIN job_cards jc ON jc.job_id = pr.job_id
      WHERE pr.shop_id = ${req.shopId}
        AND pr.status = ${status}
      ORDER BY pr.created_at DESC
    `;
    res.json({ success: true, data: requests });
  } catch (err) {
    next(err);
  }
});

// GET /api/shop/workshop/service-history?vehicleReg=XX00YY0000
router.get('/service-history', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const vehicleReg = typeof req.query.vehicleReg === 'string' ? req.query.vehicleReg.trim().toUpperCase() : '';
    if (!vehicleReg) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_REG', message: 'vehicleReg query param required' } });
    }

    const history = await prisma.$queryRaw`
      SELECT
        jc.job_id, jc.job_number, jc.status, jc.customer_name, jc.customer_phone,
        jc.vehicle_make, jc.vehicle_model, jc.vehicle_year, jc.vehicle_reg,
        jc.complaint, jc.diagnosis, jc.odometer_in, jc.odometer_out,
        jc.total_amount, jc.labour_charge, jc.parts_total,
        jc.created_at, jc.delivered_at,
        u.name AS mechanic_name,
        COUNT(jci.id) AS item_count
      FROM job_cards jc
      LEFT JOIN users u ON u.user_id = jc.assigned_to_user_id
      LEFT JOIN job_card_items jci ON jci.job_id = jc.job_id
      WHERE jc.shop_id = ${req.shopId}
        AND UPPER(TRIM(jc.vehicle_reg)) = ${vehicleReg}
      GROUP BY jc.job_id, u.name
      ORDER BY jc.created_at DESC
      LIMIT 30
    `;

    res.json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
});

export default router;
