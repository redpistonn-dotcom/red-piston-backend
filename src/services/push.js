/**
 * Web/mobile push via FCM. Reuses the same firebase-admin app already
 * initialised in services/firebase.js for ID-token verification — no
 * separate credentials needed.
 *
 * Best-effort by design: a push failure must never fail the caller's
 * request (job creation, assignment, etc). Invalid/expired tokens are
 * pruned automatically on send failure.
 */
import { getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import prisma from '../db/prisma.js';
import { initFirebase } from './firebase.js';

export async function registerPushToken(userId, token, platform = 'WEB') {
  if (!token || typeof token !== 'string') return;
  await prisma.$executeRaw`
    INSERT INTO device_push_tokens (user_id, token, platform)
    VALUES (${userId}, ${token}, ${platform})
    ON CONFLICT (token) DO UPDATE SET user_id = ${userId}, platform = ${platform}
  `;
}

export async function sendPushToUser(userId, { title, body, data = {} }) {
  try {
    initFirebase();
    if (getApps().length === 0) {
      if (process.env.NODE_ENV === 'development') {
        console.log(`[Push] (dev, no Firebase app) To user ${userId}: ${title} — ${body}`);
      }
      return;
    }

    const tokens = await prisma.$queryRaw`
      SELECT token FROM device_push_tokens WHERE user_id = ${userId}
    `;
    if (!tokens.length) return;

    const result = await getMessaging().sendEachForMulticast({
      tokens: tokens.map(t => t.token),
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      webpush: { fcmOptions: { link: data.link || '/' } },
    });

    const deadTokens = result.responses
      .map((r, i) => (!r.success ? tokens[i].token : null))
      .filter(Boolean);
    if (deadTokens.length) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM device_push_tokens WHERE token = ANY($1::text[])`,
        deadTokens
      );
    }
  } catch (err) {
    console.error('[Push] Send failed:', err.message);
  }
}
