/**
 * mechanic/jobs.js — Mechanic's job card operations
 *
 * All routes: authenticated as MECHANIC, every query hard-scoped to
 *   assigned_to_user_id = req.user.userId + shop_id = req.shopId
 * IDOR impossible: mechanic cannot read or touch another mechanic's job.
 *
 * Mounted at: /api/mechanic (behind authenticate + requireMechanic)
 *
 * Routes:
 *   GET    /dashboard               — counts by status for today
 *   GET    /jobs                    — list own jobs (filterable by status)
 *   GET    /jobs/:id                — own job detail + items + timeline + photos
 *   PATCH  /jobs/:id/status         — advance status (transition-map validated)
 *   GET    /jobs/:id/parts          — search inventory for adding parts
 *   POST   /jobs/:id/items          — add part/labour line to job card
 *   DELETE /jobs/:id/items/:itemId  — remove line item from own job
 *   POST   /jobs/:id/photos         — add photo (URL from upload route)
 *   POST   /jobs/:id/notes          — append a note to job timeline
 *   POST   /jobs/:id/invoice        — generate invoice (QC_PASSED jobs only)
 */

import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { authenticate, requireMechanic } from '../../middleware/auth.js';
import { writeAudit, ET, ACT } from '../../lib/audit.js';
import {
  canMechanicTransition, VALID_STATUSES,
  isValidMechanicProgress, PROGRESS_TRIGGERS_STATUS,
} from '../../lib/mechanic-transitions.js';
import { nextSeq, currentYYYYMM } from '../../lib/sequence.js';

const router = Router();

// Resolve and authorise a job card for the calling mechanic.
// Returns the job or sends a 404 response.
async function loadOwnJob(req, res, id) {
  const job = await prisma.$queryRaw`
    SELECT jc.*, u.name AS assigned_mechanic_name
    FROM job_cards jc
    LEFT JOIN users u ON u.user_id = jc.assigned_to_user_id
    WHERE jc.job_id = ${id}
      AND jc.shop_id = ${req.shopId}
      AND jc.assigned_to_user_id = ${req.user.userId}
  `;
  if (!job[0]) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found or not assigned to you' } });
    return null;
  }
  return job[0];
}

async function writeTimeline(jobId, actorUserId, event, { fromStatus, toStatus, note } = {}) {
  await prisma.$executeRaw`
    INSERT INTO job_card_timeline (job_id, actor_user_id, event, from_status, to_status, note)
    VALUES (${jobId}, ${actorUserId}, ${event}, ${fromStatus ?? null}, ${toStatus ?? null}, ${note ?? null})
  `;
}

// GET /api/mechanic/dashboard
router.get('/dashboard', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const counts = await prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('DELIVERED','CANCELLED')) AS active,
        COUNT(*) FILTER (WHERE status = 'RECEIVED') AS pending,
        COUNT(*) FILTER (WHERE status = 'IN_PROGRESS') AS in_progress,
        COUNT(*) FILTER (WHERE status = 'WAITING_PARTS') AS waiting_parts,
        COUNT(*) FILTER (WHERE status = 'READY') AS ready_for_qc,
        COUNT(*) FILTER (WHERE status = 'QC_REWORK') AS rework,
        COUNT(*) FILTER (WHERE status = 'DELIVERED' AND delivered_at >= ${today}) AS completed_today
      FROM job_cards
      WHERE shop_id = ${req.shopId}
        AND assigned_to_user_id = ${req.user.userId}
    `;
    res.json({ success: true, data: counts[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/mechanic/jobs
router.get('/jobs', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const { status, priority, limit = 50, offset = 0 } = req.query;
    const safeStatus = status && VALID_STATUSES.includes(status) ? status : null;
    const lim = Math.min(parseInt(limit) || 50, 100);
    const off = parseInt(offset) || 0;

    // Build dynamic WHERE clauses (raw SQL, parameterised via executeRawUnsafe)
    let statusClause = '';
    let priorityClause = '';
    const params = [req.shopId, req.user.userId];
    if (safeStatus) { params.push(safeStatus); statusClause = `AND jc.status = $${params.length}`; }
    if (priority)   { params.push(priority);   priorityClause = `AND jc.priority = $${params.length}`; }
    params.push(lim, off);

    const jobs = await prisma.$queryRawUnsafe(`
      SELECT
        jc.job_id, jc.job_number, jc.customer_name, jc.customer_phone,
        jc.vehicle_make, jc.vehicle_model, jc.vehicle_reg, jc.vehicle_year,
        jc.complaint, jc.status, jc.priority, jc.mechanic_progress,
        jc.estimated_at, jc.labour_charge, jc.parts_total, jc.total_amount,
        jc.created_at, jc.updated_at, jc.qc_status, jc.mechanic_invoice_id,
        (SELECT COUNT(*) FROM job_card_items WHERE job_id = jc.job_id) AS item_count,
        (SELECT COUNT(*) FROM job_card_photos WHERE job_id = jc.job_id) AS photo_count
      FROM job_cards jc
      WHERE jc.shop_id = $1
        AND jc.assigned_to_user_id = $2
        ${statusClause}
        ${priorityClause}
      ORDER BY jc.updated_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, ...params);

    const countParams = [req.shopId, req.user.userId];
    let countStatusClause = '';
    if (safeStatus) { countParams.push(safeStatus); countStatusClause = `AND status = $${countParams.length}`; }
    const total = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM job_cards WHERE shop_id = $1 AND assigned_to_user_id = $2 ${countStatusClause}`,
      ...countParams
    );
    res.json({ success: true, data: jobs, total: Number(total[0]?.count ?? 0) });
  } catch (err) {
    next(err);
  }
});

// GET /api/mechanic/jobs/:id
router.get('/jobs/:id', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const job = await loadOwnJob(req, res, jobId);
    if (!job) return;

    const [items, timeline, photos] = await Promise.all([
      prisma.$queryRaw`
        SELECT jci.*, si.selling_price, mp.part_name, mp.brand
        FROM job_card_items jci
        LEFT JOIN shop_inventory si ON si.inventory_id = jci.inventory_id
        LEFT JOIN master_parts mp ON mp.part_id = si.master_part_id
        WHERE jci.job_id = ${jobId}
        ORDER BY jci.id ASC
      `,
      prisma.$queryRaw`
        SELECT jct.*, u.name AS actor_name
        FROM job_card_timeline jct
        LEFT JOIN users u ON u.user_id = jct.actor_user_id
        WHERE jct.job_id = ${jobId}
        ORDER BY jct.created_at ASC
      `,
      prisma.$queryRaw`
        SELECT * FROM job_card_photos WHERE job_id = ${jobId} ORDER BY created_at ASC
      `,
    ]);

    res.json({ success: true, data: { ...job, items, timeline, photos } });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/mechanic/jobs/:id/status
router.patch('/jobs/:id/status', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const { status, note } = req.body;

    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `status must be one of: ${VALID_STATUSES.join(', ')}` },
      });
    }

    const job = await loadOwnJob(req, res, jobId);
    if (!job) return;

    if (!canMechanicTransition(job.status, status)) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'INVALID_TRANSITION',
          message: `Cannot move from ${job.status} to ${status}`,
        },
      });
    }

    const data = { status };
    if (status === 'READY') data.completed_at = new Date();

    await prisma.$executeRaw`
      UPDATE job_cards
      SET status = ${status},
          completed_at = CASE WHEN ${status} = 'READY' AND completed_at IS NULL THEN NOW() ELSE completed_at END,
          updated_at = NOW()
      WHERE job_id = ${jobId}
    `;

    await writeTimeline(jobId, req.user.userId, 'STATUS_CHANGED', {
      fromStatus: job.status,
      toStatus: status,
      note: note || null,
    });

    writeAudit(req, { entityType: ET.ORDER, entityId: jobId, action: ACT.UPDATE, oldValue: { status: job.status }, newValue: { status } });
    res.json({ success: true, data: { jobId, status } });
  } catch (err) {
    next(err);
  }
});

// GET /api/mechanic/jobs/:id/parts — search inventory to add parts
router.get('/jobs/:id/parts', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const job = await loadOwnJob(req, res, jobId);
    if (!job) return;

    const q = typeof req.query.q === 'string' ? `%${req.query.q.trim()}%` : '%';
    const parts = await prisma.$queryRaw`
      SELECT
        si.inventory_id, si.selling_price, si.stock_qty, si.mrp,
        mp.part_id, mp.part_name, mp.brand, mp.gst_rate,
        mp.oem_numbers, si.location
      FROM shop_inventory si
      JOIN master_parts mp ON mp.part_id = si.master_part_id
      WHERE si.shop_id = ${req.shopId}
        AND si.stock_qty > 0
        AND (
          mp.part_name ILIKE ${q}
          OR mp.brand ILIKE ${q}
          OR EXISTS (
            SELECT 1 FROM unnest(mp.oem_numbers) AS o WHERE o ILIKE ${q}
          )
        )
      ORDER BY mp.part_name ASC
      LIMIT 50
    `;
    res.json({ success: true, data: parts });
  } catch (err) {
    next(err);
  }
});

// POST /api/mechanic/jobs/:id/items — add part/labour/service line
router.post('/jobs/:id/items', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const job = await loadOwnJob(req, res, jobId);
    if (!job) return;

    if (['DELIVERED', 'CANCELLED', 'QC_PASSED'].includes(job.status)) {
      return res.status(422).json({
        success: false,
        error: { code: 'JOB_LOCKED', message: 'Cannot add items to a delivered, cancelled, or QC-passed job' },
      });
    }

    const { inventoryId, description, qty = 1, unitPrice, type = 'PART' } = req.body;
    if (!description || unitPrice === undefined) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'description and unitPrice are required' } });
    }

    const parsedQty = parseInt(qty);
    const parsedPrice = parseFloat(unitPrice);
    if (!Number.isFinite(parsedQty) || parsedQty <= 0 || !Number.isFinite(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_VALUES', message: 'qty must be positive integer, unitPrice non-negative' } });
    }
    const total = parsedQty * parsedPrice;

    // If linking to inventory, validate stock and price server-side
    if (inventoryId) {
      const inv = await prisma.$queryRaw`
        SELECT inventory_id, stock_qty, selling_price FROM shop_inventory
        WHERE inventory_id = ${parseInt(inventoryId, 10)} AND shop_id = ${req.shopId}
      `;
      if (!inv[0]) {
        return res.status(404).json({ success: false, error: { code: 'PART_NOT_FOUND', message: 'Part not found in this shop' } });
      }
      if (inv[0].stock_qty < parsedQty) {
        return res.status(422).json({ success: false, error: { code: 'INSUFFICIENT_STOCK', message: `Only ${inv[0].stock_qty} units in stock` } });
      }
    }

    let item;
    await prisma.$transaction(async (tx) => {
      const itemRes = await tx.$queryRaw`
        INSERT INTO job_card_items (job_id, inventory_id, description, qty, unit_price, total, type)
        VALUES (${jobId}, ${inventoryId ? parseInt(inventoryId, 10) : null}, ${description}, ${parsedQty}, ${parsedPrice}, ${total}, ${type})
        RETURNING *
      `;
      item = itemRes[0];

      // Decrement stock and write movement record for inventory-linked parts
      if (inventoryId && type === 'PART') {
        await tx.$executeRaw`
          UPDATE shop_inventory
          SET stock_qty = stock_qty - ${parsedQty}
          WHERE inventory_id = ${parseInt(inventoryId, 10)} AND shop_id = ${req.shopId}
        `;
        await tx.$executeRaw`
          INSERT INTO movements (shop_id, inventory_id, type, qty, reference_number, created_by, created_at)
          VALUES (${req.shopId}, ${parseInt(inventoryId, 10)}, 'JOB_CARD', ${-parsedQty}, ${job.job_number}, ${req.user.userId}, NOW())
        `;
      }

      // Recompute partsTotal + totalAmount
      await tx.$executeRaw`
        UPDATE job_cards SET
          parts_total = (
            SELECT COALESCE(SUM(total), 0) FROM job_card_items
            WHERE job_id = ${jobId} AND type = 'PART'
          ),
          total_amount = (
            SELECT COALESCE(SUM(total), 0) FROM job_card_items WHERE job_id = ${jobId}
          ) + labour_charge,
          updated_at = NOW()
        WHERE job_id = ${jobId}
      `;
    });

    await writeTimeline(jobId, req.user.userId, 'PART_ADDED', { note: `${description} x${parsedQty}` });
    res.status(201).json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/mechanic/jobs/:id/items/:itemId
router.delete('/jobs/:id/items/:itemId', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const itemId = parseInt(req.params.itemId, 10);
    const job = await loadOwnJob(req, res, jobId);
    if (!job) return;

    if (['DELIVERED', 'CANCELLED', 'QC_PASSED'].includes(job.status)) {
      return res.status(422).json({ success: false, error: { code: 'JOB_LOCKED', message: 'Cannot remove items from a locked job' } });
    }

    let deleted;
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`
        DELETE FROM job_card_items WHERE id = ${itemId} AND job_id = ${jobId} RETURNING *
      `;
      deleted = rows[0];
      if (!deleted) return;

      // Restore stock for inventory-linked parts
      if (deleted.inventory_id && deleted.type === 'PART') {
        await tx.$executeRaw`
          UPDATE shop_inventory
          SET stock_qty = stock_qty + ${deleted.qty}
          WHERE inventory_id = ${deleted.inventory_id} AND shop_id = ${req.shopId}
        `;
        await tx.$executeRaw`
          INSERT INTO movements (shop_id, inventory_id, type, qty, reference_number, created_by, created_at)
          VALUES (${req.shopId}, ${deleted.inventory_id}, 'JOB_CARD', ${deleted.qty}, ${job.job_number}, ${req.user.userId}, NOW())
        `;
      }

      await tx.$executeRaw`
        UPDATE job_cards SET
          parts_total = (
            SELECT COALESCE(SUM(total), 0) FROM job_card_items WHERE job_id = ${jobId} AND type = 'PART'
          ),
          total_amount = (
            SELECT COALESCE(SUM(total), 0) FROM job_card_items WHERE job_id = ${jobId}
          ) + labour_charge,
          updated_at = NOW()
        WHERE job_id = ${jobId}
      `;
    });

    if (!deleted) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Item not found' } });
    }

    await writeTimeline(jobId, req.user.userId, 'PART_REMOVED', { note: deleted.description });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/mechanic/jobs/:id/photos
router.post('/jobs/:id/photos', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const job = await loadOwnJob(req, res, jobId);
    if (!job) return;

    const { url, stage = 'DURING' } = req.body;
    const VALID_STAGES = ['BEFORE', 'DURING', 'AFTER'];
    if (!url || typeof url !== 'string' || !url.startsWith('https://')) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_URL', message: 'url must be a valid https URL from the upload endpoint' } });
    }
    if (!VALID_STAGES.includes(stage)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STAGE', message: `stage must be one of: ${VALID_STAGES.join(', ')}` } });
    }

    const photo = await prisma.$queryRaw`
      INSERT INTO job_card_photos (job_id, stage, url, uploaded_by)
      VALUES (${jobId}, ${stage}, ${url}, ${req.user.userId})
      RETURNING *
    `;
    await writeTimeline(jobId, req.user.userId, 'PHOTO_UPLOADED', { note: `${stage} photo` });
    res.status(201).json({ success: true, data: photo[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/mechanic/jobs/:id/notes
router.post('/jobs/:id/notes', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const job = await loadOwnJob(req, res, jobId);
    if (!job) return;

    const { note } = req.body;
    if (!note || typeof note !== 'string' || !note.trim()) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_NOTE', message: 'note is required' } });
    }
    if (note.length > 2000) {
      return res.status(400).json({ success: false, error: { code: 'NOTE_TOO_LONG', message: 'note must be under 2000 characters' } });
    }

    await writeTimeline(jobId, req.user.userId, 'NOTE_ADDED', { note: note.trim() });
    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/mechanic/jobs/:id/invoice
// Mechanic generates invoice for own QC_PASSED job.
// Figures computed server-side from items + labourCharge.
// No GST edit, no discount edit, no payment collection.
router.post('/jobs/:id/invoice', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const job = await loadOwnJob(req, res, jobId);
    if (!job) return;

    if (job.status !== 'QC_PASSED') {
      return res.status(422).json({
        success: false,
        error: { code: 'NOT_READY', message: 'Invoice can only be generated after QC is passed' },
      });
    }

    // Check no invoice already generated
    const existingInv = await prisma.$queryRaw`
      SELECT mechanic_invoice_id FROM job_cards WHERE job_id = ${jobId}
    `;
    if (existingInv[0]?.mechanic_invoice_id) {
      return res.status(409).json({ success: false, error: { code: 'INVOICE_EXISTS', message: 'Invoice already generated for this job' } });
    }

    // Load items with GST from master_parts
    const items = await prisma.$queryRaw`
      SELECT
        jci.id, jci.inventory_id, jci.description, jci.qty, jci.unit_price, jci.total, jci.type,
        COALESCE(mp.gst_rate, 0) AS gst_rate
      FROM job_card_items jci
      LEFT JOIN shop_inventory si ON si.inventory_id = jci.inventory_id
      LEFT JOIN master_parts mp ON mp.part_id = si.master_part_id
      WHERE jci.job_id = ${jobId}
    `;

    const labourCharge = parseFloat(job.labour_charge ?? 0);
    const partsTotal = items
      .filter(i => i.type === 'PART')
      .reduce((s, i) => s + parseFloat(i.total), 0);
    const subtotal = labourCharge + partsTotal;

    // Generate invoice number
    const yyyymm = currentYYYYMM();
    const seq = await nextSeq(prisma, req.shopId, `INV-${yyyymm}`);
    const invoiceNumber = `INV-${yyyymm}-${String(seq).padStart(4, '0')}`;

    let invoice;
    await prisma.$transaction(async (tx) => {
      // Create invoice header
      const invRes = await tx.$queryRaw`
        INSERT INTO invoices (
          invoice_number, shop_id, invoice_type, vehicle_reg,
          subtotal, total, payment_status, created_by, notes
        )
        VALUES (
          ${invoiceNumber}, ${req.shopId}, 'WORKSHOP', ${job.vehicle_reg ?? null},
          ${subtotal}, ${subtotal}, 'PENDING', ${req.user.userId},
          ${`Job Card: ${job.job_number} — ${job.customer_name}`}
        )
        RETURNING *
      `;
      invoice = invRes[0];

      // Create invoice items
      for (const item of items) {
        const taxable = parseFloat(item.total);
        const gstRate = parseFloat(item.gst_rate ?? 0);
        const gstAmt = taxable * gstRate / 100;
        await tx.$executeRaw`
          INSERT INTO invoice_items (invoice_id, description, qty, unit_price, total, gst_rate, taxable_value)
          VALUES (${Number(invoice.invoice_id)}, ${item.description}, ${item.qty}, ${parseFloat(item.unit_price)}, ${parseFloat(item.total)}, ${gstRate}, ${taxable})
        `;
      }

      // Labour line if any
      if (labourCharge > 0) {
        await tx.$executeRaw`
          INSERT INTO invoice_items (invoice_id, description, qty, unit_price, total, gst_rate, taxable_value)
          VALUES (${Number(invoice.invoice_id)}, 'Labour Charges', 1, ${labourCharge}, ${labourCharge}, 0, ${labourCharge})
        `;
      }

      // Link invoice to job card
      await tx.$executeRaw`
        UPDATE job_cards SET mechanic_invoice_id = ${Number(invoice.invoice_id)}, updated_at = NOW()
        WHERE job_id = ${jobId}
      `;
    });

    await writeTimeline(jobId, req.user.userId, 'INVOICE_GENERATED', { note: invoiceNumber });
    writeAudit(req, { entityType: ET.ORDER, entityId: jobId, action: ACT.CREATE, newValue: { invoiceNumber, invoiceId: invoice.invoice_id } });

    res.status(201).json({ success: true, data: { invoiceId: invoice.invoice_id, invoiceNumber, total: subtotal } });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/mechanic/jobs/:id/progress — set granular work sub-status
router.patch('/jobs/:id/progress', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const { progress } = req.body;

    if (!progress || !isValidMechanicProgress(progress)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PROGRESS', message: `progress must be one of the valid stages` },
      });
    }

    const job = await loadOwnJob(req, res, jobId);
    if (!job) return;

    if (['DELIVERED', 'CANCELLED'].includes(job.status)) {
      return res.status(422).json({ success: false, error: { code: 'JOB_LOCKED', message: 'Cannot update progress on a closed job' } });
    }

    // READY_FOR_QC triggers the main status to READY
    const statusTrigger = PROGRESS_TRIGGERS_STATUS[progress];
    const newStatus = statusTrigger && job.status !== statusTrigger ? statusTrigger : null;

    await prisma.$executeRaw`
      UPDATE job_cards SET
        mechanic_progress = ${progress},
        status = COALESCE(${newStatus}, status),
        completed_at = CASE WHEN ${newStatus} = 'READY' AND completed_at IS NULL THEN NOW() ELSE completed_at END,
        updated_at = NOW()
      WHERE job_id = ${jobId}
    `;

    await writeTimeline(jobId, req.user.userId, 'PROGRESS_UPDATED', {
      note: progress,
      ...(newStatus ? { fromStatus: job.status, toStatus: newStatus } : {}),
    });

    res.json({ success: true, data: { progress, status: newStatus ?? job.status } });
  } catch (err) {
    next(err);
  }
});

// GET /api/mechanic/jobs/:id/part-requests
router.get('/jobs/:id/part-requests', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const job = await loadOwnJob(req, res, jobId);
    if (!job) return;

    const requests = await prisma.$queryRaw`
      SELECT pr.*, u.name AS requested_by_name, ru.name AS reviewed_by_name
      FROM job_card_part_requests pr
      LEFT JOIN users u ON u.user_id = pr.requested_by
      LEFT JOIN users ru ON ru.user_id = pr.reviewed_by
      WHERE pr.job_id = ${jobId} AND pr.shop_id = ${req.shopId}
      ORDER BY pr.created_at DESC
    `;
    res.json({ success: true, data: requests });
  } catch (err) {
    next(err);
  }
});

// POST /api/mechanic/jobs/:id/part-requests
router.post('/jobs/:id/part-requests', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const job = await loadOwnJob(req, res, jobId);
    if (!job) return;

    const { description, partNumber, qtyRequested = 1, unitPrice } = req.body;
    if (!description || typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_DESCRIPTION', message: 'description is required' } });
    }
    const parsedQty = parseInt(qtyRequested);
    if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_QTY', message: 'qtyRequested must be a positive integer' } });
    }

    const request = await prisma.$queryRaw`
      INSERT INTO job_card_part_requests (job_id, shop_id, description, part_number, qty_requested, unit_price, requested_by)
      VALUES (${jobId}, ${req.shopId}, ${description.trim()}, ${partNumber || null}, ${parsedQty}, ${unitPrice ? parseFloat(unitPrice) : null}, ${req.user.userId})
      RETURNING *
    `;

    await writeTimeline(jobId, req.user.userId, 'PART_REQUESTED', { note: `${description.trim()} x${parsedQty}` });
    res.status(201).json({ success: true, data: request[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/mechanic/jobs/service-history?vehicleReg=KA01AB1234 — past jobs for same vehicle
router.get('/service-history', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const vehicleReg = typeof req.query.vehicleReg === 'string' ? req.query.vehicleReg.trim().toUpperCase() : '';
    if (!vehicleReg) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_REG', message: 'vehicleReg query param required' } });
    }

    const history = await prisma.$queryRaw`
      SELECT
        jc.job_id, jc.job_number, jc.status, jc.customer_name,
        jc.vehicle_make, jc.vehicle_model, jc.vehicle_year, jc.vehicle_reg,
        jc.complaint, jc.diagnosis, jc.odometer_in, jc.odometer_out,
        jc.total_amount, jc.created_at, jc.delivered_at,
        u.name AS mechanic_name
      FROM job_cards jc
      LEFT JOIN users u ON u.user_id = jc.assigned_to_user_id
      WHERE jc.shop_id = ${req.shopId}
        AND UPPER(TRIM(jc.vehicle_reg)) = ${vehicleReg}
      ORDER BY jc.created_at DESC
      LIMIT 20
    `;

    res.json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
});

export default router;
