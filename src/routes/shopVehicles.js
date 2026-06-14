import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';

const router = Router();

// Shop-registered vehicles (customers' cars the shop services). Scoped to the
// shop; ownerId references a Party (the customer). Used to create job cards.

// GET /api/shop/vehicles
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const vehicles = await prisma.shopVehicle.findMany({
      where: { shopId: req.shopId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, vehicles });
  } catch (err) { console.error('[GET /shop/vehicles]', err); next(err); }
});

const parseBody = (b) => ({
  make:               b.make,
  model:              b.model,
  variant:            b.variant || null,
  year:               b.year ? parseInt(b.year) : null,
  fuelType:           b.fuelType || null,
  registrationNumber: b.registrationNumber || null,
  engineType:         b.engineType || null,
  odometer:           (b.odometer != null && b.odometer !== '') ? parseInt(b.odometer) : null,
  vin:                b.vin || null,
  ownerId:            b.ownerId ? parseInt(b.ownerId) : null,
  notes:              b.notes || null,
});

// POST /api/shop/vehicles
router.post('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    if (!req.body.make || !req.body.model) return res.status(400).json({ error: 'make and model are required' });
    const vehicle = await prisma.shopVehicle.create({
      data: { shopId: req.shopId, ...parseBody(req.body) },
    });
    res.status(201).json({ success: true, vehicle });
  } catch (err) { console.error('[POST /shop/vehicles]', err); next(err); }
});

// PUT /api/shop/vehicles/:id
router.put('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const vehicleId = parseInt(req.params.id, 10);
    const existing = await prisma.shopVehicle.findFirst({ where: { vehicleId, shopId: req.shopId } });
    if (!existing) return res.status(404).json({ error: 'Vehicle not found' });
    const vehicle = await prisma.shopVehicle.update({ where: { vehicleId }, data: parseBody(req.body) });
    res.json({ success: true, vehicle });
  } catch (err) { console.error('[PUT /shop/vehicles/:id]', err); next(err); }
});

// DELETE /api/shop/vehicles/:id
router.delete('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const vehicleId = parseInt(req.params.id, 10);
    const existing = await prisma.shopVehicle.findFirst({ where: { vehicleId, shopId: req.shopId } });
    if (!existing) return res.status(404).json({ error: 'Vehicle not found' });
    await prisma.shopVehicle.delete({ where: { vehicleId } });
    res.json({ success: true });
  } catch (err) { console.error('[DELETE /shop/vehicles/:id]', err); next(err); }
});

export default router;
