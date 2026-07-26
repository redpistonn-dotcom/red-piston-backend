import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { spawn } from 'child_process';
import os from 'os';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import prisma from '../db/prisma.js';
import { getCacheClient } from '../lib/cache.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { getNetworkStats } from '../middleware/networkLogger.js';
import { formatUserResponse, attachStaffSections } from './auth/helpers.js';
import { sendShopOwnerApprovedEmail, sendShopOwnerRejectedEmail } from '../services/email.js';
import { generateResetToken, hashResetToken } from '../services/password.js';
import {
  getScraperState, setScraperRunning, setScraperStopped,
  appendScraperLog, setScraperError,
} from '../lib/scraper-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Path to the Python scraper script (two levels up from src/routes → project root → scripts/)
const SCRAPER_SCRIPT = resolve(__dirname, '../../scripts/scrape_autodukan_full.py');

const router = Router();

// GET /api/admin/system-metrics
router.get('/system-metrics', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const dbSizeRes = await prisma.$queryRaw`SELECT pg_database_size(current_database()) as size`;
    const dbSizeBytes = dbSizeRes[0]?.size ? Number(dbSizeRes[0].size) : 0;
    
    const connRes = await prisma.$queryRaw`SELECT count(*) as count FROM pg_stat_activity`;
    const activeDbConnections = connRes[0]?.count ? Number(connRes[0].count) : 0;

    let redisMemory = '0B';
    let apiRateLimiters = 0;
    let apiWarnings = 0;
    let mutRateLimiters = 0;
    let mutWarnings = 0;

    const redisClient = getCacheClient();
    if (redisClient) {
      try {
        const info = await redisClient.info('memory');
        const match = info.match(/used_memory_human:(.*)/);
        if (match) redisMemory = match[1].trim();

        // Scan for active rate limiters
        const apiKeys = await redisClient.keys('rl:api:*');
        apiRateLimiters = apiKeys.length;
        for (const key of apiKeys) {
          const val = await redisClient.get(key);
          if (Number(val) > 150) apiWarnings++;
        }

        const mutKeys = await redisClient.keys('rl:mut:*');
        mutRateLimiters = mutKeys.length;
        for (const key of mutKeys) {
          const val = await redisClient.get(key);
          if (Number(val) > 45) mutWarnings++;
        }
      } catch (e) {
        console.error('Redis info error', e);
      }
    }

    const memoryUsage = process.memoryUsage();
    
    res.json({
      success: true,
      data: {
        database: {
          sizeBytes: dbSizeBytes,
          sizeMb: (dbSizeBytes / 1024 / 1024).toFixed(2),
          activeConnections: activeDbConnections,
        },
        cache: {
          usedMemoryHuman: redisMemory,
        },
        rateLimits: {
          api: { active: apiRateLimiters, warnings: apiWarnings },
          mutations: { active: mutRateLimiters, warnings: mutWarnings }
        },
        server: {
          freemem: os.freemem(),
          totalmem: os.totalmem(),
          loadavg: os.loadavg(),
          heapUsed: memoryUsage.heapUsed,
          heapTotal: memoryUsage.heapTotal,
        }
      }
    });
  } catch (err) { next(err); }
});

// GET /api/admin/stats
router.get('/stats', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const [totalUsers, totalShops, activeUsers, shopOwners, customers, admins] = await Promise.all([
      prisma.user.count(),
      prisma.shop.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.user.count({ where: { role: 'SHOP_OWNER' } }),
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
      prisma.user.count({ where: { role: 'PLATFORM_ADMIN' } }),
    ]);
    res.json({ success: true, data: { totalUsers, totalShops, activeUsers, shopOwners, customers, admins } });
  } catch (err) { next(err); }
});

// GET /api/admin/users
router.get('/users', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { q, role, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (role && role !== 'ALL') where.role = role;
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
      ];
    }
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          userId: true, name: true, email: true, phone: true,
          role: true, isActive: true, shopId: true, avatarUrl: true,
          createdAt: true, lastLoginAt: true, loginCount: true,
          shop: { select: { name: true, city: true } },
          userType: { select: { id: true, name: true, slug: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.user.count({ where }),
    ]);
    res.json({ success: true, data: users, total });
  } catch (err) { next(err); }
});

// POST /api/admin/impersonate/:userId
router.post('/impersonate/:userId', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) return res.status(400).json({ success: false, error: { code: 'INVALID_ID', message: 'Invalid userId' } });

    // Prevent admins from impersonating other admins
    if (userId === req.user.userId) {
      return res.status(400).json({ success: false, error: { code: 'SELF_IMPERSONATION', message: 'Cannot impersonate yourself' } });
    }

    const target = await prisma.user.findUnique({
      where: { userId },
      include: { shop: true },
    });

    if (!target) {
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    }
    if (!target.isActive) {
      return res.status(400).json({ success: false, error: { code: 'USER_INACTIVE', message: 'Cannot impersonate inactive user' } });
    }
    if (target.role === 'PLATFORM_ADMIN') {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Cannot impersonate another admin' } });
    }

    // Impersonation access token (no refresh token of its own). Match the normal
    // session length (8h) so it survives a full working session — at 2h it expired
    // mid-use, and since there's no impersonation refresh token the client would
    // fall back to the ADMIN's refresh token (admin has no shop) and every
    // shop-scoped endpoint started returning empty while still "logged in".
    const accessToken = jwt.sign(
      { userId: target.userId, shopId: target.shopId || null, role: target.role, impersonatedBy: req.user.userId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    // Same enrichment login/refresh/GET-me use — without it, a SHOP_STAFF
    // target's sections come back empty, breaking their nav/routes for the
    // whole impersonation session (they'd see barely more than Dashboard,
    // and any section-gated data the frontend skips fetching without a
    // granted section would look "empty" even though it exists).
    const impersonatedUser = await attachStaffSections(formatUserResponse(target), target);

    res.json({
      success: true,
      data: { accessToken, user: impersonatedUser, impersonatedBy: { userId: req.user.userId, name: req.user.name } },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/verifications — pending shop owner verifications
router.get('/verifications', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '100', 10), 500);
    const offset = Math.max(parseInt(req.query.offset || '0',   10), 0);
    const where  = { role: 'SHOP_OWNER', verificationStatus: { in: ['PENDING', 'REJECTED'] } };

    const [pending, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          userId: true, name: true, email: true, phone: true, avatarUrl: true,
          verificationStatus: true, verificationNote: true, verifiedAt: true,
          createdAt: true, isActive: true,
          userType: { select: { id: true, name: true, slug: true } },
        },
        orderBy: { createdAt: 'desc' },
        take:    limit,
        skip:    offset,
      }),
      prisma.user.count({ where }),
    ]);
    res.json({ success: true, data: pending, total, limit, offset });
  } catch (err) { next(err); }
});

// POST /api/admin/users/create — admin creates a user directly
router.post('/users/create', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;
    if (!email || !password || !role) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'name, email, password and role are required' } });
    }
    const allowedRoles = ['PLATFORM_ADMIN', 'SHOP_OWNER', 'CUSTOMER'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ROLE', message: `role must be one of: ${allowedRoles.join(', ')}` } });
    }

    // Check email not already taken
    const existing = await prisma.user.findFirst({ where: { email: { equals: email.trim().toLowerCase(), mode: 'insensitive' } } });
    if (existing) return res.status(409).json({ success: false, error: { code: 'EMAIL_TAKEN', message: 'An account with this email already exists' } });

    // Find the matching UserType
    const userType = await prisma.userType.findUnique({ where: { slug: role } });

    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.default.hash(password, 12);

    const newUser = await prisma.user.create({
      data: {
        name: name?.trim() || null,
        email: email.trim().toLowerCase(),
        passwordHash,
        role,
        userTypeId: userType?.id || null,
        emailVerified: true, // admin-created accounts are pre-verified
        isVerified: true,
        isActive: true,
        // Shop owners created by admin are pre-approved
        verificationStatus: role === 'SHOP_OWNER' ? 'APPROVED' : 'NOT_REQUIRED',
      },
      include: { userType: true },
    });

    // Link email auth provider
    await prisma.authProvider.create({ data: { userId: newUser.userId, provider: 'EMAIL', providerId: newUser.email } });

    res.status(201).json({ success: true, data: { userId: newUser.userId, name: newUser.name, email: newUser.email, role: newUser.role, userType: newUser.userType } });
  } catch (err) { next(err); }
});

// POST /api/admin/users/:userId/verify — approve or reject a shop owner
router.post('/users/:userId/verify', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) return res.status(400).json({ success: false, error: { code: 'INVALID_ID', message: 'Invalid userId' } });

    const { action, reason } = req.body; // action: 'APPROVE' | 'REJECT'
    if (!['APPROVE', 'REJECT'].includes(action)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ACTION', message: 'action must be APPROVE or REJECT' } });
    }
    if (action === 'REJECT' && !reason?.trim()) {
      return res.status(400).json({ success: false, error: { code: 'REASON_REQUIRED', message: 'A rejection reason is required' } });
    }

    const user = await prisma.user.findUnique({ where: { userId } });
    if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    if (user.role !== 'SHOP_OWNER') return res.status(400).json({ success: false, error: { code: 'NOT_SHOP_OWNER', message: 'Only shop owner accounts can be verified' } });

    const updateData = {
      verificationStatus: action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      verificationNote: action === 'REJECT' ? reason.trim() : null,
      verifiedAt: new Date(),
      verifiedBy: String(req.user.userId), // verifiedBy is String? in schema
      isActive: action === 'APPROVE' ? true : user.isActive,
    };

    const updated = await prisma.user.update({
      where: { userId },
      data: updateData,
    });

    // Send email notification
    if (action === 'APPROVE') {
      // Fire-and-forget, same pattern as staff welcome email — reuses the
      // forgot-password token mechanism so the "set/reset password" link in
      // this email lands on the existing /reset-password page.
      (async () => {
        try {
          await prisma.passwordResetToken.updateMany({ where: { userId: updated.userId, used: false }, data: { used: true } });
          const rawToken = generateResetToken();
          await prisma.passwordResetToken.create({
            data: { userId: updated.userId, tokenHash: hashResetToken(rawToken), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
          });
          await sendShopOwnerApprovedEmail(updated, rawToken);
        } catch (e) { console.error('[EMAIL] Approval email failed:', e); }
      })();
    } else {
      sendShopOwnerRejectedEmail(updated, reason).catch(e => console.error('[EMAIL] Rejection email failed:', e));
    }

    res.json({ success: true, data: { userId: updated.userId, verificationStatus: updated.verificationStatus } });
  } catch (err) { next(err); }
});

// PATCH /api/admin/users/:userId/toggle-active
router.patch('/users/:userId/toggle-active', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) return res.status(400).json({ success: false, error: { code: 'INVALID_ID', message: 'Invalid userId' } });

    const user = await prisma.user.findUnique({ where: { userId } });
    if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    if (user.role === 'PLATFORM_ADMIN') return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Cannot deactivate an admin' } });

    const updated = await prisma.user.update({
      where: { userId },
      data: { isActive: !user.isActive },
      select: { userId: true, isActive: true, name: true },
    });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

// GET /api/admin/usertypes — list all user types
router.get('/usertypes', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const types = await prisma.userType.findMany({ orderBy: { id: 'asc' } });
    res.json({ success: true, data: types });
  } catch (err) { next(err); }
});

// PATCH /api/admin/users/:userId/usertype — change a user's type (syncs role cache)
router.patch('/users/:userId/usertype', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) return res.status(400).json({ success: false, error: { code: 'INVALID_ID', message: 'Invalid userId' } });

    const userTypeId = parseInt(req.body.userTypeId);
    if (!userTypeId || isNaN(userTypeId)) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELD', message: 'userTypeId (integer) is required' } });
    }

    const userType = await prisma.userType.findUnique({ where: { id: userTypeId } });
    if (!userType) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'UserType not found' } });
    }

    const targetUser = await prisma.user.findUnique({ where: { userId } });
    if (!targetUser) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    }
    if (targetUser.userId === req.user.userId) {
      return res.status(400).json({ success: false, error: { code: 'SELF_MODIFY', message: 'Cannot change your own user type' } });
    }

    const updated = await prisma.user.update({
      where: { userId },
      data: { userTypeId, role: userType.slug },  // sync role cache
      include: { userType: true },
    });

    res.json({
      success: true,
      data: {
        userId: updated.userId,
        name: updated.name,
        role: updated.role,
        userType: { id: updated.userType.id, name: updated.userType.name, slug: updated.userType.slug },
      },
    });
  } catch (err) { next(err); }
});

// ─── CATALOG MANAGEMENT ──────────────────────────────────────────────────────

// GET /api/admin/catalog/parts — paginated master_parts list for admin console
router.get('/catalog/parts', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { q, status, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (status) where.status = status;
    if (q) {
      where.OR = [
        { partName: { contains: q, mode: 'insensitive' } },
        { primaryOemNumber: { contains: q, mode: 'insensitive' } },
        { brand: { contains: q, mode: 'insensitive' } },
      ];
    }
    const [parts, total] = await Promise.all([
      prisma.masterPart.findMany({
        where,
        select: {
          masterPartId: true, partName: true, brand: true,
          primaryOemNumber: true, categoryL1: true, categoryL2: true,
          hsnCode: true, gstRate: true, unitOfSale: true,
          status: true, source: true, createdAt: true, updatedAt: true,
          _count: { select: { inventory: true, fitments: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.masterPart.count({ where }),
    ]);
    res.json({ success: true, data: parts, total });
  } catch (err) { next(err); }
});

// POST /api/admin/catalog/bulk-import — upsert master_parts from Excel import
// Optimised: 1 findMany lookup + createMany + batched transaction updates per request
// Body: { parts: [{ partName, oemNumber, brand?, categoryL1?, mrp?, buyPrice?, ... }] }
router.post('/catalog/bulk-import', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { parts } = req.body;
    if (!Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'EMPTY_BATCH', message: 'parts array is required and must not be empty' } });
    }

    let created = 0, updated = 0, unchanged = 0, invalid = 0, fitments = 0;
    const errors = [];

    // ── 1. Validate & normalise every incoming row ──────────────────────────
    const valid = [];
    for (const p of parts) {
      if (!p.partName?.trim() && !p.oemNumber) { invalid++; continue; }
      const oemNumber = p.oemNumber ? String(p.oemNumber).trim() : null;
      const altOems   = Array.isArray(p.alternateOemNumbers)
        ? p.alternateOemNumbers.map(s => String(s).trim()).filter(Boolean)
        : [];
      const specs = {};
      if (p.mrp     != null) specs.mrp      = parseFloat(p.mrp);
      if (p.buyPrice != null) specs.buyPrice = parseFloat(p.buyPrice);
      valid.push({ ...p, _oemNumber: oemNumber, _altOems: altOems, _specs: Object.keys(specs).length ? specs : null });
    }

    // ── 2. One query to find all already-existing OEM numbers ───────────────
    // Enforce max batch size — prevents a single request from triggering a huge DB scan
    if (valid.length > 500) {
      return res.status(400).json({ success: false, error: { code: 'BATCH_TOO_LARGE', message: 'Max 500 rows per request. Split into smaller batches.' } });
    }
    const oemLookup = valid.map(p => p._oemNumber).filter(Boolean);
    // Only fetch heavy fields (oemNumbers[], specifications{}) when the batch
    // actually needs them — avoids pulling large JSON blobs on every lookup
    const needsOemMerge  = valid.some(p => p._altOems.length > 0);
    const needsSpecMerge = valid.some(p => p._specs !== null);
    const existingRows = oemLookup.length > 0
      ? await prisma.masterPart.findMany({
          where: { primaryOemNumber: { in: oemLookup } },
          select: {
            masterPartId:      true,
            primaryOemNumber:  true,
            oemNumbers:        needsOemMerge,
            specifications:    needsSpecMerge,
          },
        })
      : [];
    const existingMap = new Map(existingRows.map(e => [e.primaryOemNumber, e]));

    // ── 3. Split into creates / updates / unchanged ─────────────────────────
    const toCreate  = [];
    const toUpdate  = []; // { existing, updateData, incoming }

    for (const p of valid) {
      const existing = p._oemNumber ? existingMap.get(p._oemNumber) : null;
      if (existing) {
        const updateData = {};
        if (p.partName?.trim())     updateData.partName    = p.partName.trim();
        if (p.brand)                updateData.brand       = p.brand;
        if (p.categoryL1)           updateData.categoryL1  = p.categoryL1;
        if (p.categoryL2)           updateData.categoryL2  = p.categoryL2;
        if (p.categoryL3)           updateData.categoryL3  = p.categoryL3;
        if (p.hsnCode)              updateData.hsnCode     = p.hsnCode;
        if (p.gstRate != null)      updateData.gstRate     = parseFloat(p.gstRate);
        if (p.unit)                 updateData.unitOfSale  = p.unit;
        if (p.description)          updateData.description = p.description;
        if (p.weightGrams != null)  updateData.weightGrams = parseInt(p.weightGrams);
        if (p._specs) updateData.specifications = { ...(existing.specifications || {}), ...p._specs };
        if (p._altOems.length > 0) {
          const merged = [...new Set([...(existing.oemNumbers || []), ...p._altOems])];
          if (merged.length !== (existing.oemNumbers || []).length) updateData.oemNumbers = merged;
        }
        if (Object.keys(updateData).length > 0) toUpdate.push({ existing, updateData, incoming: p });
        else unchanged++;
      } else {
        toCreate.push(p);
      }
    }

    // ── 4. Bulk-create new parts in one DB round-trip ───────────────────────
    if (toCreate.length > 0) {
      const createResult = await prisma.masterPart.createMany({
        data: toCreate.map(p => ({
          partName:         (p.partName || p._oemNumber || '').trim(),
          primaryOemNumber: p._oemNumber,
          oemNumbers:       p._oemNumber ? [p._oemNumber, ...p._altOems.filter(o => o !== p._oemNumber)] : p._altOems,
          brand:            p.brand        || null,
          categoryL1:       p.categoryL1   || null,
          categoryL2:       p.categoryL2   || null,
          categoryL3:       p.categoryL3   || null,
          hsnCode:          p.hsnCode      || null,
          gstRate:          p.gstRate != null ? parseFloat(p.gstRate) : 18.00,
          unitOfSale:       p.unit         || 'Piece',
          description:      p.description  || null,
          weightGrams:      p.weightGrams != null ? parseInt(p.weightGrams) : null,
          specifications:   p._specs       || null,
          status:           'VERIFIED',
          source:           'SUPPLIER_IMPORT',
          verifiedAt:       new Date(),
        })),
        skipDuplicates: true,
      });
      created += createResult.count; // actual inserts (skipDuplicates may reduce this)
    }

    // ── 5. Bulk-update existing parts — single SQL statement via CTE ────────
    // Replaces N individual prisma.masterPart.update() calls with one raw SQL
    // UPDATE … FROM (jsonb_array_elements) which is O(1) round-trips regardless
    // of batch size.  NULL values are COALESCE'd to keep the existing column.
    if (toUpdate.length > 0) {
      const rows = toUpdate.map(({ existing, updateData }) => ({
        id:           existing.masterPartId,
        part_name:    updateData.partName     ?? null,
        brand:        updateData.brand        ?? null,
        category_l1:  updateData.categoryL1   ?? null,
        category_l2:  updateData.categoryL2   ?? null,
        category_l3:  updateData.categoryL3   ?? null,
        hsn_code:     updateData.hsnCode      ?? null,
        gst_rate:     updateData.gstRate      ?? null,
        unit_of_sale: updateData.unitOfSale   ?? null,
        description:  updateData.description  ?? null,
        weight_grams: updateData.weightGrams  ?? null,
        // JSON / array fields serialised as jsonb — null = don't touch
        specifications: updateData.specifications ?? null,
        oem_numbers:    updateData.oemNumbers     ?? null,
      }));

      await prisma.$executeRawUnsafe(`
        WITH data AS (
          SELECT
            (v->>'id')::uuid                                            AS id,
            v->>'part_name'                                             AS part_name,
            v->>'brand'                                                 AS brand,
            v->>'category_l1'                                           AS category_l1,
            v->>'category_l2'                                           AS category_l2,
            v->>'category_l3'                                           AS category_l3,
            v->>'hsn_code'                                              AS hsn_code,
            (v->>'gst_rate')::numeric                                   AS gst_rate,
            v->>'unit_of_sale'                                          AS unit_of_sale,
            v->>'description'                                           AS description,
            (v->>'weight_grams')::int                                   AS weight_grams,
            CASE WHEN jsonb_typeof(v->'specifications') = 'object'
                 THEN v->'specifications' ELSE NULL END                 AS specifications,
            CASE WHEN jsonb_typeof(v->'oem_numbers') = 'array'
                 THEN ARRAY(SELECT jsonb_array_elements_text(v->'oem_numbers'))
                 ELSE NULL END                                          AS oem_numbers
          FROM jsonb_array_elements($1::jsonb) AS v
        )
        UPDATE master_parts AS mp
        SET
          part_name      = COALESCE(data.part_name,      mp.part_name),
          brand          = COALESCE(data.brand,          mp.brand),
          category_l1    = COALESCE(data.category_l1,    mp.category_l1),
          category_l2    = COALESCE(data.category_l2,    mp.category_l2),
          category_l3    = COALESCE(data.category_l3,    mp.category_l3),
          hsn_code       = COALESCE(data.hsn_code,       mp.hsn_code),
          gst_rate       = COALESCE(data.gst_rate,       mp.gst_rate),
          unit_of_sale   = COALESCE(data.unit_of_sale,   mp.unit_of_sale),
          description    = COALESCE(data.description,    mp.description),
          weight_grams   = COALESCE(data.weight_grams,   mp.weight_grams),
          specifications = COALESCE(data.specifications, mp.specifications),
          oem_numbers    = COALESCE(data.oem_numbers,    mp.oem_numbers),
          updated_at     = NOW()
        FROM data
        WHERE mp.master_part_id = data.id
      `, JSON.stringify(rows));

      updated += toUpdate.length;
    }

    // ── 6. Vehicle fitments (only for newly created parts with vehicle data) ─
    const fitmentRows = toCreate.filter(p => p.vehicleMake && p.vehicleModel);
    if (fitmentRows.length > 0) {
      // Fetch the IDs of parts we just created
      const newOems = fitmentRows.map(p => p._oemNumber).filter(Boolean);
      const newParts = await prisma.masterPart.findMany({
        where: { primaryOemNumber: { in: newOems } },
        select: { masterPartId: true, primaryOemNumber: true },
      });
      const newMap = new Map(newParts.map(p => [p.primaryOemNumber, p]));

      // Cache vehicle type IDs
      const vtCache = new Map();
      const getVtId = async (slug) => {
        if (!slug) return null;
        if (vtCache.has(slug)) return vtCache.get(slug);
        const vt = await prisma.vehicleType.findUnique({ where: { slug } });
        vtCache.set(slug, vt?.id || null);
        return vt?.id || null;
      };

      for (const p of fitmentRows) {
        try {
          const part = newMap.get(p._oemNumber);
          if (!part) continue;
          const yearFrom = p.yearFrom ? parseInt(p.yearFrom) : new Date().getFullYear() - 10;
          const yearTo   = p.yearTo   ? parseInt(p.yearTo)   : null;
          let vehicle = await prisma.vehicle.findFirst({
            where: { make: p.vehicleMake, model: p.vehicleModel, yearFrom,
              ...(p.fuelType ? { fuelType: p.fuelType } : {}),
              ...(p.variant  ? { variant:  p.variant  } : {}) },
          });
          if (!vehicle) {
            vehicle = await prisma.vehicle.create({
              data: { make: p.vehicleMake, model: p.vehicleModel, variant: p.variant || null,
                yearFrom, yearTo, fuelType: p.fuelType || null,
                vehicleType: p.vehicleType || 'Car',
                vehicleTypeId: await getVtId(p.vehicleType) },
            });
          }
          await prisma.partFitment.upsert({
            where: { masterPartId_vehicleId: { masterPartId: part.masterPartId, vehicleId: vehicle.vehicleId } },
            update: {},
            create: { masterPartId: part.masterPartId, vehicleId: vehicle.vehicleId,
              fitType: 'EXACT', confidence: 'unverified', source: 'SUPPLIER_IMPORT' },
          });
          fitments++;
        } catch (fe) {
          errors.push({ oemNumber: p._oemNumber, error: fe.message });
        }
      }
    }

    res.json({
      success: true,
      data: { created, updated, unchanged, invalid, fitments, errors: errors.slice(0, 20), total: parts.length },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/vehicle-types — list all vehicle types (for admin dropdowns)
router.get('/vehicle-types', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const types = await prisma.vehicleType.findMany({ orderBy: { sortOrder: 'asc' } });
    res.json({ success: true, data: types });
  } catch (err) { next(err); }
});

// GET /api/admin/catalog/stats — quick catalog statistics
router.get('/catalog/stats', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const [total, verified, pending, rejected] = await Promise.all([
      prisma.masterPart.count(),
      prisma.masterPart.count({ where: { status: 'VERIFIED' } }),
      prisma.masterPart.count({ where: { status: 'PENDING' } }),
      prisma.masterPart.count({ where: { status: 'REJECTED' } }),
    ]);
    res.json({ success: true, data: { total, verified, pending, rejected } });
  } catch (err) { next(err); }
});

// GET /api/admin/catalog/parts?status=PENDING&q=&limit=50&offset=0
router.get('/catalog/parts', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { status, q, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (status && status !== 'ALL') where.status = status;
    if (q) where.partName = { contains: q, mode: 'insensitive' };
    const [parts, total] = await Promise.all([
      prisma.masterPart.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.masterPart.count({ where }),
    ]);

    // Attach shop name manually (contributedByShopId has no Prisma @relation)
    const shopIds = [...new Set(parts.map(p => p.contributedByShopId).filter(Boolean))];
    const shops = shopIds.length
      ? await prisma.shop.findMany({ where: { shopId: { in: shopIds } }, select: { shopId: true, name: true, city: true } })
      : [];
    const shopMap = Object.fromEntries(shops.map(s => [s.shopId, s]));
    const partsWithShop = parts.map(p => ({
      ...p,
      contributedByShop: p.contributedByShopId ? (shopMap[p.contributedByShopId] ?? null) : null,
    }));

    res.json({ success: true, parts: partsWithShop, total });
  } catch (err) { next(err); }
});

// PATCH /api/admin/catalog/parts/:id/approve
router.patch('/catalog/parts/:id/approve', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ success: false, error: { message: 'Invalid part id' } });
    const part = await prisma.masterPart.update({
      where: { masterPartId: id },
      data: { status: 'VERIFIED' },
    });
    res.json({ success: true, part });
  } catch (err) { next(err); }
});

// PATCH /api/admin/catalog/parts/:id/reject
router.patch('/catalog/parts/:id/reject', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ success: false, error: { message: 'Invalid part id' } });
    const part = await prisma.masterPart.update({
      where: { masterPartId: id },
      data: { status: 'INACTIVE' },
    });
    res.json({ success: true, part });
  } catch (err) { next(err); }
});

// ─── Autodukan Staging Import ─────────────────────────────────────────────────
// Controlled import from autodukan_parts_staging → master_parts
// Rate limit: 3 imports per UTC day, minimum 2 hours between each import

const AUTODUKAN_MAX_PER_DAY = 3;
const AUTODUKAN_MIN_HOURS_BETWEEN = 2;

const ALL_AUTODUKAN_CATEGORIES = [
  'AIR CONDITIONING','BELT & CHAIN DRIVE','BODY PARTS','BRAKE SYSTEM',
  'CAR ACCESSORIES','CAR CARE','CLUTCH SYSTEM','COOLING SYSTEM',
  'ELECTRICAL','ENGINE PARTS','EXHAUST SYSTEM','FASTENERS',
  'FILTERS','FUEL SYSTEM','GASKET & SEALS','HYBRID & ELECTRIC DRIVE',
  'INTERIORS COMFORT & SAFETY','LIGHTING','OILS & FLUIDS','SERVICE KIT',
  'STEERING','SUSPENSION','TRANSMISSION','WHEELS & TYRE',
  'WINDSCREEN CLEANING SYSTEM',
];

async function ensureImportLogTable() {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS autodukan_import_log (
      id            SERIAL PRIMARY KEY,
      admin_id      INTEGER NOT NULL,
      admin_email   TEXT,
      batch_size    INTEGER NOT NULL,
      category_filter TEXT,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

// GET /api/admin/autodukan/stats
// Returns staging totals, import progress, today's usage and rate-limit state.
router.get('/autodukan/stats', authenticate, requireAdmin, async (req, res, next) => {
  try {
    await ensureImportLogTable();

    const [stagingRes, masterRes, todayRes, lastImportRes, recentLogs, recentImports, brandStats, categoryStats, scrapeProgress] = await Promise.all([
      // Total products scraped into staging (source = autodukan only)
      prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM autodukan_parts_staging WHERE source = 'autodukan'`.catch(() => [{ count: 0 }]),

      // How many staging part_numbers already exist in master_parts
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS count
        FROM autodukan_parts_staging s
        JOIN master_parts mp ON mp.primary_oem_number = s.part_number
        WHERE s.source = 'autodukan'
      `.catch(() => [{ count: 0 }]),

      // How many imports done today (UTC day)
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS count
        FROM autodukan_import_log
        WHERE created_at >= date_trunc('day', NOW())
      `,

      // When was the last import (for min-hours check)
      prisma.$queryRaw`
        SELECT created_at FROM autodukan_import_log ORDER BY created_at DESC LIMIT 1
      `,

      // Last 10 import log entries for display
      prisma.$queryRaw`
        SELECT id, admin_email, batch_size, category_filter, inserted_count, created_at
        FROM autodukan_import_log
        ORDER BY created_at DESC
        LIMIT 10
      `,

      // Last 30 parts added to master from autodukan
      prisma.$queryRaw`
        SELECT master_part_id, part_name, brand, category_l1, part_type, primary_oem_number, status, created_at
        FROM master_parts
        WHERE source = 'SUPPLIER_IMPORT'
        ORDER BY created_at DESC
        LIMIT 30
      `.catch(() => []),

      // OEM brand breakdown — source-filtered
      prisma.$queryRaw`
        SELECT
          COALESCE(NULLIF(TRIM(brand), ''), 'Unknown') AS brand,
          COUNT(*)::int AS total,
          COUNT(CASE WHEN LOWER(type) LIKE '%oes%' THEN 1 END)::int AS oes_count,
          COUNT(CASE WHEN LOWER(type) NOT LIKE '%oes%' OR type IS NULL THEN 1 END)::int AS oem_count,
          COUNT(DISTINCT category)::int AS category_count
        FROM autodukan_parts_staging
        WHERE source = 'autodukan'
        GROUP BY COALESCE(NULLIF(TRIM(brand), ''), 'Unknown')
        ORDER BY COUNT(*) DESC
        LIMIT 50
      `.catch(() => []),

      // Category breakdown — source-filtered
      prisma.$queryRaw`
        SELECT
          COALESCE(NULLIF(TRIM(category), ''), 'Uncategorised') AS category,
          COUNT(*)::int AS total,
          COUNT(CASE WHEN LOWER(type) LIKE '%oes%' THEN 1 END)::int AS oes_count,
          COUNT(CASE WHEN LOWER(type) NOT LIKE '%oes%' OR type IS NULL THEN 1 END)::int AS oem_count
        FROM autodukan_parts_staging
        WHERE source = 'autodukan'
        GROUP BY COALESCE(NULLIF(TRIM(category), ''), 'Uncategorised')
        ORDER BY COUNT(*) DESC
      `.catch(() => []),

      // Per-category scrape progress (page_num > 0 = real pages; page_num = 0 = category fully done)
      prisma.$queryRaw`
        SELECT
          category,
          COUNT(CASE WHEN page_num > 0 THEN 1 END)::int AS pages_done,
          SUM(CASE WHEN page_num > 0 THEN products_count ELSE 0 END)::int AS products_scraped,
          MAX(completed_at) AS last_scraped_at,
          BOOL_OR(page_num = 0) AS fully_done
        FROM autodukan_scrape_progress
        GROUP BY category
        ORDER BY category
      `.catch(() => []),
    ]);

    const stagingTotal   = stagingRes[0]?.count  || 0;
    const alreadyInMaster = masterRes[0]?.count  || 0;
    const todayCount     = todayRes[0]?.count     || 0;
    const remaining      = Math.max(0, stagingTotal - alreadyInMaster);
    const importsLeft    = Math.max(0, AUTODUKAN_MAX_PER_DAY - todayCount);

    // Earliest next import time (cooldown)
    let nextAvailableAt = null;
    if (lastImportRes.length > 0) {
      const cooldownEnds = new Date(
        new Date(lastImportRes[0].created_at).getTime() +
        AUTODUKAN_MIN_HOURS_BETWEEN * 60 * 60 * 1000
      );
      if (cooldownEnds > new Date()) nextAvailableAt = cooldownEnds.toISOString();
    }

    res.json({
      success: true,
      data: {
        stagingTotal,
        alreadyInMaster,
        remaining,
        todayCount,
        maxPerDay:       AUTODUKAN_MAX_PER_DAY,
        importsLeft,
        nextAvailableAt,
        categories:      ALL_AUTODUKAN_CATEGORIES,
        recentLogs:      recentLogs.map(r => ({
          id:             r.id,
          adminEmail:     r.admin_email,
          batchSize:      r.batch_size,
          categoryFilter: r.category_filter,
          insertedCount:  r.inserted_count,
          createdAt:      r.created_at,
        })),
        recentImports: recentImports.map(r => ({
          id:             r.master_part_id,
          partName:       r.part_name,
          brand:          r.brand,
          category:       r.category_l1,
          partType:       r.part_type,
          oemNumber:      r.primary_oem_number,
          status:         r.status,
          addedAt:        r.created_at,
        })),
        brandStats: brandStats.map(r => ({
          brand:         r.brand,
          total:         r.total,
          oemCount:      r.oem_count,
          oesCount:      r.oes_count,
          categoryCount: r.category_count,
        })),
        categoryStats: categoryStats.map(r => ({
          category: r.category,
          total:    r.total,
          oemCount: r.oem_count,
          oesCount: r.oes_count,
        })),
        scrapeProgress: scrapeProgress.map(r => ({
          category:       r.category,
          pagesDone:      r.pages_done,
          productsScraped: r.products_scraped,
          lastScrapedAt:  r.last_scraped_at,
          fullyDone:      r.fully_done,
        })),
      },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/autodukan/parts
// Browse staging parts with search + brand/category filter + pagination.
router.get('/autodukan/parts', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const limit    = Math.min(100, Math.max(1, parseInt(req.query.limit)  || 50));
    const offset   = Math.max(0,               parseInt(req.query.offset) || 0);
    const q        = (req.query.q        || '').trim();
    const category = (req.query.category || '').trim();
    const brand    = (req.query.brand    || '').trim();

    // Build WHERE clauses dynamically
    const conditions = [`source = 'autodukan'`];
    const params     = [];
    let   pIdx       = 1;

    if (q) {
      conditions.push(`(LOWER(name) LIKE $${pIdx} OR LOWER(part_number) LIKE $${pIdx} OR LOWER(brand) LIKE $${pIdx})`);
      params.push(`%${q.toLowerCase()}%`);
      pIdx++;
    }
    if (category) {
      conditions.push(`LOWER(category) = $${pIdx}`);
      params.push(category.toLowerCase());
      pIdx++;
    }
    if (brand) {
      conditions.push(`LOWER(brand) = $${pIdx}`);
      params.push(brand.toLowerCase());
      pIdx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [partsRes, countRes] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT id, name, part_number, type, brand, category, price, mrp, image_url, scraped_at
         FROM autodukan_parts_staging
         ${where}
         ORDER BY scraped_at DESC
         LIMIT $${pIdx} OFFSET $${pIdx + 1}`,
        ...params, limit, offset
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count FROM autodukan_parts_staging ${where}`,
        ...params
      ),
    ]);

    res.json({
      success: true,
      data: {
        parts: partsRes.map(r => ({
          id:          r.id,
          name:        r.name,
          partNumber:  r.part_number,
          type:        r.type,
          brand:       r.brand,
          category:    r.category,
          price:       r.price ? Number(r.price) : null,
          mrp:         r.mrp   ? Number(r.mrp)   : null,
          imageUrl:    r.image_url,
          scrapedAt:   r.scraped_at,
        })),
        total: countRes[0]?.count || 0,
      },
    });
  } catch (err) { next(err); }
});

// POST /api/admin/autodukan/import
// Imports a batch of parts from autodukan_parts_staging into master_parts.
// Body: { batchSize: 100–2000, categoryFilter?: "FILTERS" }
router.post('/autodukan/import', authenticate, requireAdmin, async (req, res, next) => {
  try {
    await ensureImportLogTable();

    const { batchSize = 500, categoryFilter = null } = req.body;
    const size = Math.min(2000, Math.max(1, parseInt(batchSize) || 500));

    // ── Rate limit: max 3 per UTC day ──────────────────────────────────────
    const todayRes = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM autodukan_import_log
      WHERE created_at >= date_trunc('day', NOW())
    `;
    if ((todayRes[0]?.count || 0) >= AUTODUKAN_MAX_PER_DAY) {
      return res.status(429).json({
        success: false,
        error: {
          code: 'DAILY_LIMIT',
          message: `Limit of ${AUTODUKAN_MAX_PER_DAY} imports per day reached. Try again tomorrow.`,
        },
      });
    }

    // ── Rate limit: min 2 hours between imports ────────────────────────────
    const lastRes = await prisma.$queryRaw`
      SELECT created_at FROM autodukan_import_log ORDER BY created_at DESC LIMIT 1
    `;
    if (lastRes.length > 0) {
      const elapsed = Date.now() - new Date(lastRes[0].created_at).getTime();
      const minMs   = AUTODUKAN_MIN_HOURS_BETWEEN * 60 * 60 * 1000;
      if (elapsed < minMs) {
        const waitMin = Math.ceil((minMs - elapsed) / 60000);
        const cooldownEnds = new Date(new Date(lastRes[0].created_at).getTime() + minMs);
        return res.status(429).json({
          success: false,
          error: {
            code: 'COOLDOWN',
            message: `Please wait ${waitMin} more minute${waitMin !== 1 ? 's' : ''} before the next import.`,
            nextAvailableAt: cooldownEnds.toISOString(),
          },
        });
      }
    }

    // ── Fetch unimported rows from staging ─────────────────────────────────
    const where = categoryFilter
      ? `AND s.category = ${categoryFilter.replace(/'/g, "''")}`
      : '';

    const rows = await prisma.$queryRawUnsafe(`
      SELECT s.id, s.name, s.part_number, s.type, s.brand, s.category, s.image_url
      FROM autodukan_parts_staging s
      LEFT JOIN master_parts mp ON mp.primary_oem_number = s.part_number
      WHERE s.part_number IS NOT NULL
        AND s.part_number <> ''
        AND mp.master_part_id IS NULL
        ${categoryFilter ? `AND s.category = '${categoryFilter.replace(/'/g, "''")}'` : ''}
      ORDER BY s.id
      LIMIT ${size}
    `);

    if (!rows.length) {
      return res.json({
        success: true,
        data: { inserted: 0, attempted: 0, message: 'No new parts to import (staging is empty or all already imported).' },
      });
    }

    // ── Map to MasterPart shape ────────────────────────────────────────────
    const parts = rows
      .filter(r => r.part_number?.trim())
      .map(r => ({
        partName:         (r.name || r.part_number).trim().substring(0, 500),
        brand:            (r.brand || 'UNKNOWN').trim().substring(0, 100),
        primaryOemNumber: r.part_number.trim(),
        oemNumbers:       [r.part_number.trim()],
        categoryL1:       (r.category || 'General').trim(),
        partType:         (r.type || '').toLowerCase().includes('oes') ? 'OES' : 'OEM',
        imageUrl:         r.image_url || null,
        status:           'PENDING',
        source:           'SUPPLIER_IMPORT',
        unitOfSale:       'Piece',
        gstRate:          18,
        isUniversal:      false,
        requiresFitment:  true,
      }));

    const result = await prisma.masterPart.createMany({
      data: parts,
      skipDuplicates: true,
    });

    // Fetch the just-inserted parts for frontend preview (up to 50)
    const oemNumbers = parts.map(p => p.primaryOemNumber);
    const previewParts = await prisma.$queryRaw`
      SELECT master_part_id, part_name, brand, category_l1, part_type, primary_oem_number, status, created_at
      FROM master_parts
      WHERE source = 'SUPPLIER_IMPORT'
        AND primary_oem_number = ANY(${oemNumbers})
      ORDER BY created_at DESC
      LIMIT 50
    `.catch(() => []);

    // ── Log the import ─────────────────────────────────────────────────────
    await prisma.$executeRaw`
      INSERT INTO autodukan_import_log (admin_id, admin_email, batch_size, category_filter, inserted_count)
      VALUES (${req.user.userId}, ${req.user.email}, ${size}, ${categoryFilter || null}, ${result.count})
    `;

    await writeAudit(req, {
      entityType: ET.MASTER_PART,
      action:     ACT.CREATE,
      entityId:   null,
      metadata:   { source: 'autodukan_import', inserted: result.count, batchSize: size, categoryFilter },
    }).catch(() => {});

    res.json({
      success: true,
      data: {
        inserted:       result.count,
        attempted:      parts.length,
        batchSize:      size,
        categoryFilter: categoryFilter || null,
        message:        `Imported ${result.count} new parts into master catalog.`,
        previewParts:   previewParts.map(r => ({
          id:        r.master_part_id,
          partName:  r.part_name,
          brand:     r.brand,
          category:  r.category_l1,
          partType:  r.part_type,
          oemNumber: r.primary_oem_number,
          status:    r.status,
          addedAt:   r.created_at,
        })),
      },
    });
  } catch (err) { next(err); }
});

// ─── Autodukan Scraper — Monitor + Control ────────────────────────────────────

// GET /api/admin/autodukan/monitor
// Returns live scraper state + per-category progress from DB.
router.get('/autodukan/monitor', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const [catRows, lastActivityRow, stagingRow, brandRows] = await Promise.all([
      // Pages completed per category
      prisma.$queryRaw`
        SELECT category,
               COUNT(*)::int                     AS pages_done,
               COALESCE(SUM(products_count),0)::int AS products_scraped,
               MAX(completed_at)                 AS last_page_at
        FROM   autodukan_scrape_progress
        GROUP  BY category
        ORDER  BY category
      `.catch(() => []),

      // Most recent page saved (tells us if scraper is active)
      prisma.$queryRaw`
        SELECT MAX(completed_at) AS last_at
        FROM   autodukan_scrape_progress
      `.catch(() => [{}]),

      // Total rows in staging
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS total FROM autodukan_parts_staging
      `.catch(() => [{ total: 0 }]),

      // Top 10 brands in staging (gives a feel for what's been scraped)
      prisma.$queryRaw`
        SELECT brand, COUNT(*)::int AS cnt
        FROM   autodukan_parts_staging
        WHERE  brand IS NOT NULL AND brand <> ''
        GROUP  BY brand
        ORDER  BY cnt DESC
        LIMIT  10
      `.catch(() => []),
    ]);

    const runtime = getScraperState();
    const lastAt  = lastActivityRow[0]?.last_at || null;
    // "Active" = either in-memory says running OR a page was saved in the last 30s
    const recentSec = lastAt ? (Date.now() - new Date(lastAt).getTime()) / 1000 : Infinity;
    const active = runtime.running || recentSec < 30;

    res.json({
      success: true,
      data: {
        runtime: {
          running:         runtime.running,
          pid:             runtime.pid,
          startedAt:       runtime.startedAt,
          stoppedAt:       runtime.stoppedAt,
          currentCategory: runtime.currentCategory,
          currentPage:     runtime.currentPage,
          exitCode:        runtime.exitCode,
          error:           runtime.error,
          logs:            runtime.logs.slice(-30),
          active,
          lastActivityAt:  lastAt,
          secondsSinceLastPage: lastAt ? Math.round(recentSec) : null,
        },
        stagingTotal: stagingRow[0]?.total || 0,
        catProgress:  catRows,
        topBrands:    brandRows,
      },
    });
  } catch (err) { next(err); }
});

// POST /api/admin/autodukan/scrape/start
// Spawns the Python scraper as a child process.
// Requires Python 3 + playwright installed on the same server.
// Body: { category?: "FILTERS", delay?: 10, headless?: true }
router.post('/autodukan/scrape/start', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const runtime = getScraperState();
    if (runtime.running) {
      return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: 'Scraper is already running.' } });
    }

    if (!existsSync(SCRAPER_SCRIPT)) {
      return res.status(500).json({
        success: false,
        error: { code: 'SCRIPT_NOT_FOUND', message: `Python script not found at ${SCRAPER_SCRIPT}` },
      });
    }

    const { category = null, delay = 10, headless = true } = req.body;
    const rawDbUrl = process.env.DATABASE_URL;
    if (!rawDbUrl) {
      return res.status(500).json({ success: false, error: { code: 'NO_DB_URL', message: 'DATABASE_URL env var not set on server.' } });
    }
    // psycopg2 rejects Supabase's pgbouncer=true query param — strip it before passing to Python.
    const dbUrl = rawDbUrl.replace(/([?&])pgbouncer=true/i, '$1').replace(/[?&]$/, '');

    // Build args
    const args = [SCRAPER_SCRIPT, '--db-url', dbUrl, `--delay=${delay}`, '--resume'];
    if (category) args.push(`--category=${category}`);
    if (headless) args.push('--headless');

    // On Render, pip packages land in a virtualenv; use its Python so Playwright is importable.
    // Fall back to plain python3 for local dev (where there's no venv at that path).
    const RENDER_VENV_PYTHON = '/opt/render/project/src/.venv/bin/python3';
    const pythonBin = process.platform === 'win32'
      ? 'python'
      : (existsSync(RENDER_VENV_PYTHON) ? RENDER_VENV_PYTHON : 'python3');

    // Render's build and runtime containers have separate /opt/render/.cache/ filesystems,
    // so Chromium installed there during the build is gone at runtime.
    // Installing into the project dir (/opt/render/project/src/.playwright-browsers) persists
    // across both build and runtime. Pass the same path to the subprocess so Playwright finds it.
    const PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH
      || '/opt/render/project/src/.playwright-browsers';

    const child = spawn(pythonBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH,
        // Force Python to flush stdout immediately instead of buffering when piped.
        // Without this, print() output never appears in the live log until process exits.
        PYTHONUNBUFFERED: '1',
      },
    });

    setScraperRunning(child.pid, category || 'ALL');
    appendScraperLog(`Started PID ${child.pid}: ${pythonBin} ${args.slice(1).join(' ')}`);

    child.stdout.on('data', (chunk) => {
      chunk.toString().split('\n').filter(Boolean).forEach(appendScraperLog);
    });
    child.stderr.on('data', (chunk) => {
      chunk.toString().split('\n').filter(Boolean).forEach(line => {
        appendScraperLog(`[ERR] ${line}`);
        setScraperError(line);
      });
    });
    child.on('close', (code) => {
      setScraperStopped(code);
      appendScraperLog(`Process exited with code ${code}`);
    });
    child.on('error', (err) => {
      setScraperStopped(-1);
      setScraperError(err.message);
      appendScraperLog(`Spawn error: ${err.message}`);
    });

    res.json({
      success: true,
      data: { pid: child.pid, message: `Scraper started (PID ${child.pid})`, category: category || 'ALL', delay, headless },
    });
  } catch (err) { next(err); }
});

// POST /api/admin/autodukan/scrape/stop
// Sends SIGTERM to the running scraper process.
router.post('/autodukan/scrape/stop', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const runtime = getScraperState();
    if (!runtime.running || !runtime.pid) {
      return res.status(400).json({ success: false, error: { code: 'NOT_RUNNING', message: 'No scraper is currently running.' } });
    }
    try {
      process.kill(runtime.pid, 'SIGTERM');
      appendScraperLog(`SIGTERM sent to PID ${runtime.pid} by admin ${req.user.email}`);
    } catch (e) {
      // PID may already be gone
      setScraperStopped(-1);
    }
    res.json({ success: true, data: { message: `Stop signal sent to PID ${runtime.pid}` } });
  } catch (err) { next(err); }
});

// GET /api/admin/autodukan/image-proxy?url=<encoded-s3-url>
// Proxies product images from the autodukan S3 bucket.
// Direct S3 URLs 403 from non-autodukan origins; this adds a server-side hop
// so the browser fetches from our backend, not directly from S3.
router.get('/autodukan/image-proxy', authenticate, async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url || !url.startsWith('https://autodukan.s3.ap-south-1.amazonaws.com/')) {
    return res.status(400).json({ error: 'Invalid or missing url parameter' });
  }
  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RedPiston/1.0)',
        'Referer': 'https://autodukan.com/',
      },
    });
    if (!upstream.ok) {
      return res.status(upstream.status).send('Image not available');
    }
    const ct = upstream.headers.get('content-type') || 'image/png';
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('[image-proxy]', err);
    res.status(502).send('Failed to fetch image');
  }
});

// ─── Autodukan Image Migration (S3 → Cloudinary) ─────────────────────────────

// In-memory state so the UI can poll progress without re-starting the job
const imgMigState = {
  running:   false,
  total:     0,
  done:      0,
  failed:    0,
  startedAt: null,
  finishedAt: null,
  lastError:  null,
};

async function runImageMigration() {
  const { v2: cloudinary } = await import('cloudinary');
  const pg = (await import('pg')).default;

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure:     true,
  });

  const dbUrl = (process.env.DATABASE_URL || '')
    .replace(/([?&])pgbouncer=true/i, '$1')
    .replace(/[?&]$/, '');
  const pool = new pg.Pool({ connectionString: dbUrl });

  try {
    const { rows: [{ n }] } = await pool.query(`
      SELECT COUNT(*)::int AS n FROM autodukan_parts_staging
      WHERE image_url LIKE '%autodukan.s3.ap-south-1.amazonaws.com%'
        AND source = 'autodukan'
    `);
    imgMigState.total = n;

    if (n === 0) { imgMigState.running = false; imgMigState.finishedAt = new Date(); return; }

    while (true) {
      const { rows } = await pool.query(`
        SELECT id, image_url FROM autodukan_parts_staging
        WHERE image_url LIKE '%autodukan.s3.ap-south-1.amazonaws.com%'
          AND source = 'autodukan'
        ORDER BY id LIMIT 10
      `);
      if (rows.length === 0) break;

      for (const row of rows) {
        try {
          const res = await fetch(encodeURI(row.image_url), {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://autodukan.com/' },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());

          const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
              { folder: 'autodukan-parts', public_id: `part_${row.id}`, overwrite: true,
                resource_type: 'image', format: 'webp',
                transformation: [{ width: 400, height: 400, crop: 'limit' }] },
              (err, r) => err ? reject(err) : resolve(r)
            );
            stream.end(buf);
          });

          await pool.query(
            'UPDATE autodukan_parts_staging SET image_url = $1 WHERE id = $2',
            [result.secure_url, row.id]
          );
          imgMigState.done++;
        } catch (err) {
          console.error('[img-migration] row', row.id, err.message);
          await pool.query(
            'UPDATE autodukan_parts_staging SET image_url = NULL WHERE id = $1',
            [row.id]
          );
          imgMigState.failed++;
          imgMigState.lastError = err.message;
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }
  } finally {
    await pool.end();
    imgMigState.running    = false;
    imgMigState.finishedAt = new Date();
  }
}

// POST /api/admin/autodukan/migrate-images  — start the migration (idempotent)
router.post('/autodukan/migrate-images', authenticate, requireAdmin, (req, res) => {
  if (imgMigState.running) {
    return res.json({ success: true, message: 'Already running', state: imgMigState });
  }
  Object.assign(imgMigState, {
    running: true, total: 0, done: 0, failed: 0,
    startedAt: new Date(), finishedAt: null, lastError: null,
  });
  runImageMigration().catch(err => {
    console.error('[img-migration] fatal', err);
    imgMigState.running = false;
    imgMigState.lastError = err.message;
    imgMigState.finishedAt = new Date();
  });
  res.json({ success: true, message: 'Migration started', state: imgMigState });
});

// GET /api/admin/autodukan/migrate-images  — poll progress
router.get('/autodukan/migrate-images', authenticate, requireAdmin, (req, res) => {
  res.json({ success: true, state: imgMigState });
});

// === VERCEL DEPLOYMENT PROXY ===
router.get('/deployments/vercel', requireAdmin, async (req, res, next) => {
  try {
    const { token, projectId } = req.query;
    if (!token) return res.status(400).json({ success: false, error: 'Token required' });
    
    // Vercel v6 deployments API
    let url = 'https://api.vercel.com/v6/deployments?limit=5';
    if (projectId) url += `&projectId=${projectId}`;

    const vercelRes = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!vercelRes.ok) {
      return res.status(vercelRes.status).json({ success: false, error: 'Failed to fetch from Vercel' });
    }

    const data = await vercelRes.json();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// === NETWORK LOGS API ===
router.get('/network-logs', requireAdmin, (req, res) => {
  res.json({
    success: true,
    data: getNetworkStats()
  });
});

export default router;
