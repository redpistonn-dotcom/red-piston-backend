/**
 * push.test.js — device-token registration and FCM sending.
 *
 * The global setup (tests/setup.js) mocks firebase-admin/app with
 * getApps() -> [] and initializeApp/cert as no-ops, and stubs
 * db/prisma.js's $queryRaw. We extend that stub per-test with the raw-SQL
 * methods push.js actually calls, and locally mock firebase-admin/messaging
 * since the global setup doesn't touch it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendEachForMulticast = vi.fn();
vi.mock('firebase-admin/messaging', () => ({
  getMessaging: vi.fn(() => ({ sendEachForMulticast })),
}));

import prisma from '../../src/db/prisma.js';
import { getApps } from 'firebase-admin/app';
import { registerPushToken, sendPushToUser } from '../../src/services/push.js';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$executeRaw = vi.fn().mockResolvedValue(undefined);
  prisma.$executeRawUnsafe = vi.fn().mockResolvedValue(undefined);
  prisma.$queryRaw = vi.fn().mockResolvedValue([]);
});

describe('registerPushToken', () => {
  it('upserts the token for the given user', async () => {
    await registerPushToken(42, 'tok-abc', 'WEB');
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it('is a no-op when token is missing', async () => {
    await registerPushToken(42, undefined, 'WEB');
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('is a no-op when token is not a string', async () => {
    await registerPushToken(42, 12345, 'WEB');
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty string token', async () => {
    await registerPushToken(42, '', 'WEB');
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('defaults platform to WEB when omitted', async () => {
    await registerPushToken(42, 'tok-xyz');
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
  });
});

describe('sendPushToUser', () => {
  it('no-ops when no firebase app is initialised (getApps() returns [])', async () => {
    expect(getApps()).toEqual([]);
    await sendPushToUser(1, { title: 'Hi', body: 'There' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('never throws even if something inside fails', async () => {
    prisma.$queryRaw = vi.fn().mockRejectedValue(new Error('db down'));
    await expect(sendPushToUser(1, { title: 'x', body: 'y' })).resolves.toBeUndefined();
  });

  describe('with an initialised firebase app', () => {
    beforeEach(() => {
      vi.mocked(getApps).mockReturnValue([{ name: '[DEFAULT]' }]);
    });

    it('does nothing when the user has no registered tokens', async () => {
      prisma.$queryRaw = vi.fn().mockResolvedValue([]);
      await sendPushToUser(7, { title: 'Hi', body: 'There' });
      expect(sendEachForMulticast).not.toHaveBeenCalled();
    });

    it('sends a multicast to every token on file', async () => {
      prisma.$queryRaw = vi.fn().mockResolvedValue([{ token: 't1' }, { token: 't2' }]);
      sendEachForMulticast.mockResolvedValue({ responses: [{ success: true }, { success: true }] });

      await sendPushToUser(7, { title: 'New job', body: 'Job #1', data: { jobId: '1' } });

      expect(sendEachForMulticast).toHaveBeenCalledWith(expect.objectContaining({
        tokens: ['t1', 't2'],
        notification: { title: 'New job', body: 'Job #1' },
        data: { jobId: '1' },
      }));
    });

    it('stringifies all data values for FCM (which requires string maps)', async () => {
      prisma.$queryRaw = vi.fn().mockResolvedValue([{ token: 't1' }]);
      sendEachForMulticast.mockResolvedValue({ responses: [{ success: true }] });

      await sendPushToUser(7, { title: 'x', body: 'y', data: { jobId: 1, count: 3 } });

      expect(sendEachForMulticast).toHaveBeenCalledWith(expect.objectContaining({
        data: { jobId: '1', count: '3' },
      }));
    });

    it('defaults the webpush link to "/" when data.link is not provided', async () => {
      prisma.$queryRaw = vi.fn().mockResolvedValue([{ token: 't1' }]);
      sendEachForMulticast.mockResolvedValue({ responses: [{ success: true }] });

      await sendPushToUser(7, { title: 'x', body: 'y' });

      expect(sendEachForMulticast).toHaveBeenCalledWith(expect.objectContaining({
        webpush: { fcmOptions: { link: '/' } },
      }));
    });

    it('prunes tokens that FCM reports as failed', async () => {
      prisma.$queryRaw = vi.fn().mockResolvedValue([{ token: 'good' }, { token: 'dead' }]);
      sendEachForMulticast.mockResolvedValue({
        responses: [{ success: true }, { success: false, error: new Error('not registered') }],
      });
      prisma.$executeRawUnsafe = vi.fn().mockResolvedValue(undefined);

      await sendPushToUser(7, { title: 'x', body: 'y' });

      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM device_push_tokens'),
        ['dead']
      );
    });

    it('does not touch the DB to prune when every token succeeds', async () => {
      prisma.$queryRaw = vi.fn().mockResolvedValue([{ token: 'good' }]);
      sendEachForMulticast.mockResolvedValue({ responses: [{ success: true }] });
      prisma.$executeRawUnsafe = vi.fn().mockResolvedValue(undefined);

      await sendPushToUser(7, { title: 'x', body: 'y' });

      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('swallows a messaging send failure instead of throwing', async () => {
      prisma.$queryRaw = vi.fn().mockResolvedValue([{ token: 't1' }]);
      sendEachForMulticast.mockRejectedValue(new Error('FCM unreachable'));

      await expect(sendPushToUser(7, { title: 'x', body: 'y' })).resolves.toBeUndefined();
    });
  });
});
