/**
 * audit.js — server-side audit trail helper.
 *
 * All mutating API actions call writeAudit() to record who did what,
 * from where, and what changed. The function is intentionally non-blocking:
 * if the DB write fails (e.g. table migration hasn't run yet), it logs an error
 * but does NOT propagate the failure to the caller.
 *
 * Usage:
 *   import { writeAudit, ET, ACT } from '../lib/audit.js';
 *   // after the main action succeeds:
 *   writeAudit(req, { entityType: ET.INVOICE, entityId: inv.invoiceId, action: ACT.SALE, newValue: inv });
 */
import prisma from '../db/prisma.js';

// ─── Entity type constants ────────────────────────────────────────────────────
export const ET = {
  PRODUCT:      'PRODUCT',
  INVOICE:      'INVOICE',
  PARTY:        'PARTY',
  ORDER:        'ORDER',
  AUTH:         'AUTH',
  BILL:         'BILL',
  STOCK:        'STOCK',
  PROFILE:      'PROFILE',
  SHOP:         'SHOP',
  ADMIN:        'ADMIN',
  SALES_RETURN: 'SALES_RETURN',
  CREDIT_NOTE:  'CREDIT_NOTE',
};

// ─── Action constants ─────────────────────────────────────────────────────────
export const ACT = {
  CREATE:   'CREATE',
  UPDATE:   'UPDATE',
  DELETE:   'DELETE',
  EXPORT:   'EXPORT',
  LOGIN:    'LOGIN',
  LOGOUT:   'LOGOUT',
  IMPORT:   'IMPORT',
  ADJUST:   'ADJUST',
  SALE:     'SALE',
  PURCHASE: 'PURCHASE',
  APPROVE:  'APPROVE',
  REJECT:   'REJECT',
};

function extractDeviceInfo(req) {
  return {
    userAgent: req.headers?.['user-agent'] || null,
    referer:   req.headers?.referer        || null,
    origin:    req.headers?.origin         || null,
  };
}

const SENSITIVE_KEYS = new Set([
  'phone', 'email', 'passwordHash', 'bankAccountNumber',
  'bankIfsc', 'gstin', 'panNumber', 'partyPhone', 'tokenHash',
]);

function maskSensitive(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) =>
      SENSITIVE_KEYS.has(k) ? [k, '***'] : [k, maskSensitive(v)]
    )
  );
}

/**
 * Write one immutable audit log row.
 * Non-blocking — errors are logged but never thrown to the caller.
 *
 * @param {import('express').Request} req
 * @param {{ entityType: string, entityId?: string|number|null, action: string,
 *           oldValue?: object|null, newValue?: object|null, metadata?: object|null }} opts
 */
export async function writeAudit(req, { entityType, entityId = null, action, oldValue = null, newValue = null, metadata = null }) {
  try {
    await prisma.auditLog.create({
      data: {
        userId:     req.user?.userId             || null,
        shopId:     req.shopId ?? req.user?.shopId ?? null,
        entityType,
        entityId:   entityId != null ? String(entityId) : null,
        action,
        oldValue:   oldValue  ? maskSensitive(oldValue)  : null,
        newValue:   newValue  ? maskSensitive(newValue)  : null,
        ipAddress:  req.ip || req.connection?.remoteAddress || null,
        deviceInfo: extractDeviceInfo(req),
        sessionId:  req.sessionId || null,
        metadata:   metadata ?? null,
      },
    });
  } catch (err) {
    console.error('[Audit] Write failed (non-blocking):', err?.message);
  }
}
