import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { authenticate, requireMechanic } from '../../middleware/auth.js';

const router = Router();

// GET /api/mechanic/team
router.get('/team', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const members = await prisma.$queryRawUnsafe(`
      SELECT
        mt.id,
        mt.member_user_id,
        mt.member_name,
        mt.member_phone,
        mt.created_at AS joined_at,
        COALESCE(u.name, mt.member_name) AS name,
        COALESCE(u.email, '') AS email,
        COALESCE(u.phone, mt.member_phone) AS phone,
        (u.user_id IS NOT NULL) AS is_registered
      FROM mechanic_team mt
      LEFT JOIN users u ON u.user_id = mt.member_user_id
      WHERE mt.owner_user_id = $1
      ORDER BY mt.created_at ASC
    `, req.user.userId);
    res.json({ success: true, data: members });
  } catch (err) {
    next(err);
  }
});

// POST /api/mechanic/team — add member by name + phone
router.post('/team', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELD', message: 'name and phone are required' } });
    }

    const trimmedPhone = phone.trim();
    const trimmedName = name.trim();

    // Try to find a registered user with this phone
    const rows = await prisma.$queryRawUnsafe(
      `SELECT user_id, name FROM users WHERE phone = $1 LIMIT 1`, trimmedPhone
    );
    const foundUser = rows[0];

    if (foundUser && Number(foundUser.user_id) === req.user.userId) {
      return res.status(400).json({ success: false, error: { code: 'SELF_ADD', message: 'Cannot add yourself as a team member' } });
    }

    const memberId = foundUser ? Number(foundUser.user_id) : null;

    await prisma.$executeRawUnsafe(
      `INSERT INTO mechanic_team (owner_user_id, member_user_id, member_name, member_phone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      req.user.userId, memberId, trimmedName, trimmedPhone
    );

    res.status(201).json({
      success: true,
      data: {
        member_user_id: memberId,
        name: trimmedName,
        phone: trimmedPhone,
        is_registered: !!foundUser,
      }
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/mechanic/team/:id — remove by mechanic_team.id (not user_id, since member may be unregistered)
router.delete('/team/:id', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const teamId = parseInt(req.params.id, 10);
    await prisma.$executeRawUnsafe(
      `DELETE FROM mechanic_team WHERE id = $1 AND owner_user_id = $2`,
      teamId, req.user.userId
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
