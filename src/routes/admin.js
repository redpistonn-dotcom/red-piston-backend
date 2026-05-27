import { Router } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../db/prisma.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { formatUserResponse } from './auth/helpers.js';
import { sendShopOwnerApprovedEmail, sendShopOwnerRejectedEmail } from '../services/email.js';

const router = Router();

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
          role: true, isActive: true, shopId: true,
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

    // Short-lived access token with impersonation claim (no refresh token)
    const accessToken = jwt.sign(
      { userId: target.userId, shopId: target.shopId || null, role: target.role, impersonatedBy: req.user.userId },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.json({
      success: true,
      data: { accessToken, user: formatUserResponse(target), impersonatedBy: { userId: req.user.userId, name: req.user.name } },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/verifications — pending shop owner verifications
router.get('/verifications', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const pending = await prisma.user.findMany({
      where: { role: 'SHOP_OWNER', verificationStatus: { in: ['PENDING', 'REJECTED'] } },
      select: {
        userId: true, name: true, email: true, phone: true, avatarUrl: true,
        verificationStatus: true, verificationNote: true, verifiedAt: true,
        createdAt: true, isActive: true,
        userType: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: pending });
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
      sendShopOwnerApprovedEmail(updated).catch(e => console.error('[EMAIL] Approval email failed:', e));
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
    const oemLookup = valid.map(p => p._oemNumber).filter(Boolean);
    const existingRows = oemLookup.length > 0
      ? await prisma.masterPart.findMany({
          where: { primaryOemNumber: { in: oemLookup } },
          select: { masterPartId: true, primaryOemNumber: true, oemNumbers: true, specifications: true },
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

export default router;
