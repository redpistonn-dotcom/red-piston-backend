/**
 * workshop/quotation.js — Quotation / Estimate management
 *
 * Mounted inside workshopRoutes at /api/shop/workshop
 *
 * Routes:
 *   POST   /jobs/:id/quotation        — generate/refresh quotation from current items
 *   GET    /jobs/:id/quotation        — get quotation detail + items
 *   PATCH  /jobs/:id/quotation        — update discount or status
 *   POST   /jobs/:id/quotation/send   — share via EMAIL / WHATSAPP_LINK
 */

import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { authenticate, requireShopOwner } from '../../middleware/auth.js';
import { nextSeq, currentYYYYMM } from '../../lib/sequence.js';
import { writeAudit, ET, ACT } from '../../lib/audit.js';

const router = Router();

const VALID_SEND_CHANNELS = ['EMAIL', 'WHATSAPP_LINK', 'SMS'];
const VALID_QUOTATION_STATUSES = ['DRAFT', 'SENT', 'APPROVED', 'REVISION', 'REJECTED'];

async function loadJob(req, res, id) {
  const rows = await prisma.$queryRaw`
    SELECT jc.*, s.name AS shop_name, s.phone AS shop_phone, s.address AS shop_address
    FROM job_cards jc
    JOIN shops s ON s.shop_id = jc.shop_id
    WHERE jc.job_id = ${id} AND jc.shop_id = ${req.shopId}
  `;
  if (!rows[0]) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found' } });
    return null;
  }
  return rows[0];
}

// POST /jobs/:id/quotation — generate or refresh quotation from current items
router.post('/jobs/:id/quotation', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const job = await loadJob(req, res, jobId);
    if (!job) return;

    const { discount = 0 } = req.body;
    const parsedDiscount = Math.max(0, parseFloat(discount) || 0);

    // Sum current items for quotation
    const items = await prisma.$queryRaw`
      SELECT jci.*, COALESCE(mp.gst_rate, 0) AS gst_rate
      FROM job_card_items jci
      LEFT JOIN shop_inventory si ON si.inventory_id = jci.inventory_id
      LEFT JOIN master_parts mp ON mp.part_id = si.master_part_id
      WHERE jci.job_id = ${jobId}
    `;

    const labourCharge = parseFloat(job.labour_charge ?? 0);
    const partsSubtotal = items.filter(i => i.type === 'PART').reduce((s, i) => s + parseFloat(i.total), 0);
    const otherSubtotal = items.filter(i => i.type !== 'PART').reduce((s, i) => s + parseFloat(i.total), 0);
    const subtotal = partsSubtotal + otherSubtotal + labourCharge;

    const gstAmount = items.reduce((s, i) => {
      const taxable = parseFloat(i.total);
      const rate = parseFloat(i.gst_rate ?? 0);
      return s + (taxable * rate / 100);
    }, 0);

    const grandTotal = Math.round(subtotal + gstAmount - parsedDiscount);

    // Generate quotation number if not already present
    let quotationNumber = job.quotation_number;
    if (!quotationNumber) {
      const yyyymm = currentYYYYMM();
      const seq = await nextSeq(prisma, req.shopId, `QT-${yyyymm}`);
      quotationNumber = `QT-${yyyymm}-${String(seq).padStart(4, '0')}`;
    }

    await prisma.$executeRaw`
      UPDATE job_cards SET
        quotation_number = ${quotationNumber},
        quotation_status = 'DRAFT',
        quotation_discount = ${parsedDiscount},
        quotation_grand_total = ${grandTotal},
        updated_at = NOW()
      WHERE job_id = ${jobId}
    `;

    await prisma.$executeRaw`
      INSERT INTO job_card_timeline (job_id, actor_user_id, event, note)
      VALUES (${jobId}, ${req.user.userId}, 'QUOTATION_GENERATED', ${quotationNumber})
    `;

    writeAudit(req, { entityType: ET.ORDER, entityId: jobId, action: ACT.CREATE, newValue: { quotationNumber, grandTotal } });
    res.status(201).json({
      success: true,
      data: {
        quotationNumber,
        status: 'DRAFT',
        discount: parsedDiscount,
        subtotal,
        gstAmount: parseFloat(gstAmount.toFixed(2)),
        grandTotal,
        items,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /jobs/:id/quotation
router.get('/jobs/:id/quotation', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const job = await loadJob(req, res, jobId);
    if (!job) return;

    if (!job.quotation_number) {
      return res.status(404).json({ success: false, error: { code: 'NO_QUOTATION', message: 'No quotation generated yet' } });
    }

    const [items, sends] = await Promise.all([
      prisma.$queryRaw`
        SELECT jci.*, COALESCE(mp.gst_rate, 0) AS gst_rate
        FROM job_card_items jci
        LEFT JOIN shop_inventory si ON si.inventory_id = jci.inventory_id
        LEFT JOIN master_parts mp ON mp.part_id = si.master_part_id
        WHERE jci.job_id = ${jobId}
        ORDER BY jci.id
      `,
      prisma.$queryRaw`
        SELECT qs.*, u.name AS sent_by_name
        FROM job_card_quotation_sends qs
        LEFT JOIN users u ON u.user_id = qs.sent_by
        WHERE qs.job_id = ${jobId}
        ORDER BY qs.sent_at DESC
      `,
    ]);

    res.json({
      success: true,
      data: {
        quotationNumber: job.quotation_number,
        status: job.quotation_status,
        discount: parseFloat(job.quotation_discount ?? 0),
        grandTotal: parseFloat(job.quotation_grand_total ?? 0),
        sentAt: job.quotation_sent_at,
        sentVia: job.quotation_sent_via,
        customerName: job.customer_name,
        customerPhone: job.customer_phone,
        vehicleMake: job.vehicle_make,
        vehicleModel: job.vehicle_model,
        vehicleReg: job.vehicle_reg,
        jobNumber: job.job_number,
        items,
        sends,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /jobs/:id/quotation — update status or discount
router.patch('/jobs/:id/quotation', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const job = await loadJob(req, res, jobId);
    if (!job) return;

    if (!job.quotation_number) {
      return res.status(404).json({ success: false, error: { code: 'NO_QUOTATION', message: 'Generate a quotation first' } });
    }

    const { status, discount } = req.body;
    if (status && !VALID_QUOTATION_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: `status must be one of: ${VALID_QUOTATION_STATUSES.join(', ')}` } });
    }

    const updates = [];
    const params = [];

    if (status) {
      params.push(status);
      updates.push(`quotation_status = $${params.length}`);
    }
    if (discount !== undefined) {
      params.push(Math.max(0, parseFloat(discount) || 0));
      updates.push(`quotation_discount = $${params.length}`);
    }
    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'NO_CHANGES', message: 'Nothing to update' } });
    }

    params.push(jobId);
    await prisma.$executeRawUnsafe(
      `UPDATE job_cards SET ${updates.join(', ')}, updated_at = NOW() WHERE job_id = $${params.length}`,
      ...params
    );

    if (status) {
      await prisma.$executeRaw`
        INSERT INTO job_card_timeline (job_id, actor_user_id, event, note)
        VALUES (${jobId}, ${req.user.userId}, 'QUOTATION_STATUS_CHANGED', ${status})
      `;
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /jobs/:id/quotation/send — share via EMAIL or generate WHATSAPP_LINK
router.post('/jobs/:id/quotation/send', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const job = await loadJob(req, res, jobId);
    if (!job) return;

    if (!job.quotation_number) {
      return res.status(422).json({ success: false, error: { code: 'NO_QUOTATION', message: 'Generate a quotation before sharing' } });
    }

    const { channel, sentTo } = req.body;
    if (!VALID_SEND_CHANNELS.includes(channel)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_CHANNEL', message: `channel must be one of: ${VALID_SEND_CHANNELS.join(', ')}` } });
    }

    const grandTotal = parseFloat(job.quotation_grand_total ?? 0);
    const discount = parseFloat(job.quotation_discount ?? 0);

    let result = {};

    if (channel === 'WHATSAPP_LINK') {
      const text = [
        `*${job.shop_name}* — Quotation`,
        ``,
        `Job: *${job.job_number}*`,
        `Vehicle: ${job.vehicle_make} ${job.vehicle_model}${job.vehicle_reg ? ` (${job.vehicle_reg})` : ''}`,
        `Complaint: ${job.complaint || 'General service'}`,
        ``,
        `Estimate No: ${job.quotation_number}`,
        discount > 0 ? `Discount: ₹${discount.toFixed(2)}` : null,
        `*Grand Total: ₹${grandTotal.toFixed(2)}*`,
        ``,
        `Please reply to approve or request changes.`,
      ].filter(Boolean).join('\n');

      const digits = (sentTo || job.customer_phone || '').replace(/\D/g, '');
      const waLink = digits
        ? `https://wa.me/${digits.startsWith('91') ? digits : '91' + digits}?text=${encodeURIComponent(text)}`
        : null;

      result = { whatsappLink: waLink, message: text };
    }

    if (channel === 'EMAIL') {
      // Basic email notification — reuses existing Resend infrastructure
      const { Resend } = await import('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const toEmail = sentTo || null;
      if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_EMAIL', message: 'sentTo must be a valid email address for EMAIL channel' } });
      }

      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'noreply@redpiston.in',
        to: toEmail,
        subject: `Estimate from ${job.shop_name} — ${job.quotation_number}`,
        html: `
          <h2>${job.shop_name}</h2>
          <p><strong>Job:</strong> ${job.job_number}</p>
          <p><strong>Vehicle:</strong> ${job.vehicle_make} ${job.vehicle_model}${job.vehicle_reg ? ` (${job.vehicle_reg})` : ''}</p>
          <p><strong>Complaint:</strong> ${job.complaint || 'General service'}</p>
          <hr/>
          <p><strong>Estimate No:</strong> ${job.quotation_number}</p>
          ${discount > 0 ? `<p><strong>Discount:</strong> ₹${discount.toFixed(2)}</p>` : ''}
          <p style="font-size:18px"><strong>Grand Total: ₹${grandTotal.toFixed(2)}</strong></p>
          <p>Please contact us to approve the estimate or request changes.</p>
        `,
      });
      result = { emailSent: true };
    }

    // Log the send event
    await prisma.$executeRaw`
      INSERT INTO job_card_quotation_sends (job_id, sent_via, sent_to, sent_by, sent_at)
      VALUES (${jobId}, ${channel}, ${sentTo || null}, ${req.user.userId}, NOW())
    `;

    await prisma.$executeRaw`
      UPDATE job_cards SET
        quotation_status = CASE WHEN quotation_status = 'DRAFT' THEN 'SENT' ELSE quotation_status END,
        quotation_sent_at = NOW(),
        quotation_sent_via = ${channel},
        updated_at = NOW()
      WHERE job_id = ${jobId}
    `;

    await prisma.$executeRaw`
      INSERT INTO job_card_timeline (job_id, actor_user_id, event, note)
      VALUES (${jobId}, ${req.user.userId}, 'QUOTATION_SENT', ${channel})
    `;

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
