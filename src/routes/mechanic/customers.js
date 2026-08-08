/**
 * mechanic/customers.js — Read-only customer & supplier access for mechanics
 *
 * Mounted at /api/mechanic (behind authenticate + requireMechanic)
 *
 * Routes:
 *   GET /customers          — list CUSTOMER/BOTH parties for this shop
 *   GET /customers/:id      — customer detail + vehicles
 *   GET /suppliers          — list SUPPLIER/BOTH parties (parts sourcing context)
 */

import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { authenticate, requireMechanic } from '../../middleware/auth.js';

const router = Router();

// GET /api/mechanic/customers/search?phone=&q= — quick lookup for job creation flow
// Returns distinct customers from past job cards (works for both shop + independent mechanics)
router.get('/customers/search', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const phone = req.query.phone?.toString().trim() || '';
    const q = req.query.q?.toString().trim() || '';
    if (!phone && !q) return res.json({ success: true, data: [] });

    const shopClause = req.shopId ? `AND shop_id = ${Number(req.shopId)}` : '';
    const phoneFilter = phone ? `AND customer_phone ILIKE '%${phone.replace(/'/g, "''")}%'` : '';
    const nameFilter  = q     ? `AND customer_name  ILIKE '%${q.replace(/'/g, "''")}%'`     : '';

    const rows = await prisma.$queryRawUnsafe(`
      SELECT DISTINCT ON (customer_phone, customer_name)
        customer_name, customer_phone
      FROM job_cards
      WHERE assigned_to_user_id = $1
        ${shopClause}
        ${phoneFilter}
        ${nameFilter}
      ORDER BY customer_phone, customer_name, created_at DESC
      LIMIT 10
    `, req.user.userId);

    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/mechanic/customers/history?phone= — service history for independent mechanic customers
router.get('/customers/history', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const phone = req.query.phone?.toString().trim() || '';
    const name = req.query.name?.toString().trim() || '';
    if (!phone && !name) return res.status(400).json({ success: false, error: { message: 'phone or name required' } });

    const rows = await prisma.$queryRawUnsafe(`
      SELECT job_id, job_number, status, vehicle_make, vehicle_model, vehicle_reg,
             complaint, diagnosis, created_at, total_amount, mechanic_progress
      FROM job_cards
      WHERE assigned_to_user_id = $1
        AND status NOT IN ('CANCELLED')
        AND ($2 = '' OR customer_phone = $2)
        AND ($3 = '' OR customer_name ILIKE '%' || $3 || '%')
      ORDER BY created_at DESC
      LIMIT 30
    `, req.user.userId, phone, name);

    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/mechanic/customers
router.get('/customers', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? `%${req.query.q.trim()}%` : '%';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    let customers;
    if (req.shopId) {
      // Shop mechanic — query parties table scoped to shop
      customers = await prisma.$queryRawUnsafe(`
        SELECT
          p.party_id, p.name, p.type, p.email, p.address, p.gstin,
          COUNT(DISTINCT sv.vehicle_id) AS vehicle_count,
          COUNT(DISTINCT jc.job_id) FILTER (WHERE jc.status NOT IN ('CANCELLED')) AS job_count,
          MAX(jc.created_at) AS last_visit
        FROM parties p
        LEFT JOIN shop_vehicles sv ON sv.owner_id = p.party_id AND sv.shop_id = p.shop_id
        LEFT JOIN job_cards jc ON (jc.party_id = p.party_id OR jc.customer_name ILIKE p.name) AND jc.shop_id = p.shop_id
        WHERE p.shop_id = $1
          AND p.type IN ('CUSTOMER', 'BOTH')
          AND p.is_active = TRUE
          AND (p.name ILIKE $2 OR p.email ILIKE $2)
        GROUP BY p.party_id
        ORDER BY p.name ASC
        LIMIT $3 OFFSET $4
      `, req.shopId, q, limit, offset);
    } else {
      // Independent mechanic — derive unique customers from own past job cards
      customers = await prisma.$queryRawUnsafe(`
        SELECT
          customer_name AS name,
          customer_phone AS phone,
          COUNT(DISTINCT job_id) AS job_count,
          MAX(created_at) AS last_visit,
          array_agg(DISTINCT vehicle_make || ' ' || vehicle_model) AS vehicles
        FROM job_cards
        WHERE assigned_to_user_id = $1
          AND status NOT IN ('CANCELLED')
          AND (customer_name ILIKE $2 OR customer_phone ILIKE $2)
        GROUP BY customer_name, customer_phone
        ORDER BY last_visit DESC
        LIMIT $3 OFFSET $4
      `, req.user.userId, q, limit, offset);
    }

    res.json({ success: true, data: customers });
  } catch (err) {
    next(err);
  }
});

// GET /api/mechanic/customers/:id
router.get('/customers/:id', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const partyId = parseInt(req.params.id, 10);
    const [party, vehicles, recentJobs] = await Promise.all([
      prisma.$queryRaw`
        SELECT party_id, name, type, email, address, gstin, credit_limit, is_active
        FROM parties
        WHERE party_id = ${partyId} AND shop_id = ${req.shopId} AND type IN ('CUSTOMER', 'BOTH')
      `,
      prisma.$queryRaw`
        SELECT vehicle_id, make, model, year, registration_number, fuel_type, vin
        FROM shop_vehicles
        WHERE owner_id = ${partyId} AND shop_id = ${req.shopId}
        ORDER BY created_at DESC
      `,
      prisma.$queryRaw`
        SELECT job_id, job_number, status, vehicle_make, vehicle_model, vehicle_reg,
               complaint, diagnosis, created_at, delivered_at, total_amount
        FROM job_cards
        WHERE party_id = ${partyId} AND shop_id = ${req.shopId}
        ORDER BY created_at DESC
        LIMIT 10
      `,
    ]);

    if (!party[0]) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Customer not found' } });
    }
    res.json({ success: true, data: { ...party[0], vehicles, recentJobs } });
  } catch (err) {
    next(err);
  }
});

// GET /api/mechanic/suppliers — read-only supplier list
router.get('/suppliers', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? `%${req.query.q.trim()}%` : '%';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const suppliers = await prisma.$queryRawUnsafe(`
      SELECT party_id, name, type, email, address, gstin
      FROM parties
      WHERE shop_id = $1
        AND type IN ('SUPPLIER', 'BOTH')
        AND is_active = TRUE
        AND (name ILIKE $2 OR email ILIKE $2)
      ORDER BY name ASC
      LIMIT $3 OFFSET $4
    `, req.shopId, q, limit, offset);

    res.json({ success: true, data: suppliers });
  } catch (err) {
    next(err);
  }
});

export default router;
