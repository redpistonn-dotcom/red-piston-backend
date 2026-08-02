/**
 * workshop/feedback.js — Customer post-service feedback
 *
 * Mounted inside workshopRoutes at /api/shop/workshop
 *
 * Routes:
 *   POST   /jobs/:id/feedback   — submit feedback for a delivered job
 *   GET    /jobs/:id/feedback   — get feedback for a specific job
 *   GET    /feedback            — list all feedback for shop (summary + ratings)
 */

import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { authenticate, requireShopOwner } from '../../middleware/auth.js';

const router = Router();

// POST /jobs/:id/feedback — submit feedback (can be done by owner after delivery)
router.post('/jobs/:id/feedback', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const job = await prisma.$queryRaw`
      SELECT job_id, shop_id, status, customer_name FROM job_cards
      WHERE job_id = ${jobId} AND shop_id = ${req.shopId}
    `;
    if (!job[0]) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job card not found' } });
    }

    const { rating, comment, submittedByName } = req.body;
    const parsedRating = parseInt(rating);
    if (!Number.isFinite(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_RATING', message: 'rating must be 1-5' } });
    }

    const feedback = await prisma.$queryRaw`
      INSERT INTO job_card_feedback (job_id, shop_id, rating, comment, submitted_by_name)
      VALUES (${jobId}, ${req.shopId}, ${parsedRating}, ${comment || null}, ${submittedByName || job[0].customer_name})
      ON CONFLICT (job_id) DO UPDATE
        SET rating = ${parsedRating},
            comment = ${comment || null},
            submitted_by_name = ${submittedByName || job[0].customer_name}
      RETURNING *
    `;

    await prisma.$executeRaw`
      INSERT INTO job_card_timeline (job_id, actor_user_id, event, note)
      VALUES (${jobId}, ${req.user.userId}, 'FEEDBACK_RECEIVED', ${`${parsedRating}/5 stars`})
    `;

    res.status(201).json({ success: true, data: feedback[0] });
  } catch (err) {
    next(err);
  }
});

// GET /jobs/:id/feedback
router.get('/jobs/:id/feedback', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const feedback = await prisma.$queryRaw`
      SELECT f.*, jc.customer_name, jc.job_number
      FROM job_card_feedback f
      JOIN job_cards jc ON jc.job_id = f.job_id
      WHERE f.job_id = ${jobId} AND f.shop_id = ${req.shopId}
    `;
    if (!feedback[0]) {
      return res.status(404).json({ success: false, error: { code: 'NO_FEEDBACK', message: 'No feedback recorded for this job' } });
    }
    res.json({ success: true, data: feedback[0] });
  } catch (err) {
    next(err);
  }
});

// GET /feedback — shop-wide feedback list with avg rating
router.get('/feedback', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;

    const [list, summary] = await Promise.all([
      prisma.$queryRawUnsafe(`
        SELECT f.*, jc.customer_name, jc.job_number, jc.vehicle_make, jc.vehicle_model
        FROM job_card_feedback f
        JOIN job_cards jc ON jc.job_id = f.job_id
        WHERE f.shop_id = $1
        ORDER BY f.created_at DESC
        LIMIT $2 OFFSET $3
      `, req.shopId, lim, off),
      prisma.$queryRaw`
        SELECT
          COUNT(*) AS total,
          ROUND(AVG(rating)::numeric, 2) AS avg_rating,
          COUNT(*) FILTER (WHERE rating = 5) AS five_star,
          COUNT(*) FILTER (WHERE rating = 4) AS four_star,
          COUNT(*) FILTER (WHERE rating <= 3) AS three_or_less
        FROM job_card_feedback
        WHERE shop_id = ${req.shopId}
      `,
    ]);

    res.json({ success: true, data: list, summary: summary[0] });
  } catch (err) {
    next(err);
  }
});

export default router;
