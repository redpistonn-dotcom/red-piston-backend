import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { sendShopOwnerVerificationAlert, sendShopOwnerUnderReviewEmail } from '../../services/email.js';
import { findUserByEmailInsensitive } from './helpers.js';
import { emailQueue } from '../../jobs/queues.js';

const router = Router();

// GST state codes (ISO 3166-2:IN numeric codes used in GSTIN)
const STATE_CODE_MAP = {
  'Andhra Pradesh': '37', 'Arunachal Pradesh': '12', 'Assam': '18', 'Bihar': '10',
  'Chhattisgarh': '22', 'Goa': '30', 'Gujarat': '24', 'Haryana': '06',
  'Himachal Pradesh': '02', 'Jharkhand': '20', 'Karnataka': '29', 'Kerala': '32',
  'Madhya Pradesh': '23', 'Maharashtra': '27', 'Manipur': '14', 'Meghalaya': '17',
  'Mizoram': '15', 'Nagaland': '13', 'Odisha': '21', 'Punjab': '03',
  'Rajasthan': '08', 'Sikkim': '11', 'Tamil Nadu': '33', 'Telangana': '36',
  'Tripura': '16', 'Uttar Pradesh': '09', 'Uttarakhand': '05', 'West Bengal': '19',
  'Andaman and Nicobar Islands': '35', 'Chandigarh': '04',
  'Dadra and Nagar Haveli and Daman and Diu': '26', 'Delhi': '07',
  'Jammu and Kashmir': '01', 'Ladakh': '38', 'Lakshadweep': '31', 'Puducherry': '34',
};

/**
 * POST /api/auth/shop-setup
 *
 * Called after a new shop owner verifies their phone/email but BEFORE
 * we set their account to PENDING. Collects the shop details, creates
 * the Shop record, then sets verificationStatus = PENDING and alerts admins.
 *
 * Requires a valid JWT (Bearer token) — userId is always sourced from the
 * verified token claim, never from the request body (which would allow any
 * authenticated user to submit a shop setup as an arbitrary userId).
 */
router.post('/shop-setup', authenticate, async (req, res, next) => {
  try {
    const { ownerName, shopName, address, city, state, pincode, contactPhone, email, gstin, shopCategory, whatsappNumber, operatingHours, photoUrl } = req.body;
    // userId always comes from the verified JWT — never trusts the request body
    const userId = req.user.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHENTICATED', message: 'Valid authentication token required' },
      });
    }
    if (!ownerName?.trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_OWNER_NAME', message: 'Owner name is required' },
      });
    }
    if (!shopName?.trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_SHOP_NAME', message: 'Shop name is required' },
      });
    }
    if (!address?.trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_ADDRESS', message: 'Shop address is required' },
      });
    }
    if (!city?.trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_CITY', message: 'City is required' },
      });
    }
    if (!pincode?.trim() || !/^\d{6}$/.test(pincode.trim())) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PINCODE', message: 'A valid 6-digit pincode is required' },
      });
    }
    if (!contactPhone || !/^\d{10}$/.test(contactPhone.replace(/\s/g, ''))) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PHONE', message: 'A valid 10-digit contact phone number is required' },
      });
    }
    if (whatsappNumber && !/^\d{10}$/.test(whatsappNumber.replace(/\s/g, ''))) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_WHATSAPP', message: 'WhatsApp number must be 10 digits' },
      });
    }

    // ── Find user ────────────────────────────────────────────────────────────
    const user = await prisma.user.findUnique({ where: { userId } });
    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      });
    }
    if (user.role !== 'SHOP_OWNER') {
      return res.status(403).json({
        success: false,
        error: { code: 'NOT_SHOP_OWNER', message: 'This endpoint is for shop owners only' },
      });
    }
    // Prevent double-submit (already gone through setup)
    if (user.verificationStatus === 'PENDING' || user.verificationStatus === 'APPROVED') {
      return res.status(409).json({
        success: false,
        error: { code: 'ALREADY_SUBMITTED', message: 'Shop details have already been submitted for this account' },
      });
    }

    // ── Check phone uniqueness for the shop ─────────────────────────────────
    const cleanPhone = contactPhone.replace(/\s/g, '');
    const existingShop = await prisma.shop.findUnique({ where: { phone: cleanPhone } }).catch(() => null);
    if (existingShop) {
      return res.status(409).json({
        success: false,
        error: { code: 'PHONE_TAKEN', message: 'A shop with this phone number already exists. Use a different number.' },
      });
    }

    // ── Derive GST state code from state name ────────────────────────────────
    const resolvedState = state?.trim() || 'Telangana';
    const stateCode = STATE_CODE_MAP[resolvedState] || null;

    // ── Create shop + update user in a single transaction ───────────────────
    const shopEmail = email?.trim() || null;

    const [shop, updatedUser] = await prisma.$transaction([
      prisma.shop.create({
        data: {
          name: shopName.trim(),
          ownerName: ownerName.trim(),
          phone: cleanPhone,
          email: shopEmail,
          address: address.trim(),
          city: city.trim(),
          state: resolvedState,
          stateCode: stateCode,
          pincode: pincode.trim(),
          gstin: gstin?.trim() || null,
          shopCategory: shopCategory?.trim() || null,
          whatsappNumber: whatsappNumber?.replace(/\s/g, '') || null,
          operatingHours: operatingHours || null,
          photoUrl: photoUrl?.trim() || null,
        },
      }),
      prisma.user.update({
        where: { userId },
        data: {
          name: ownerName.trim(),
          phone: cleanPhone,
          verificationStatus: 'PENDING',
          // save email on the user record so future sends work
          ...(shopEmail && !user.email ? { email: shopEmail } : {}),
        },
      }),
    ]);

    // Link shop to user
    await prisma.user.update({
      where: { userId },
      data: { shopId: shop.shopId },
    });

    // Revoke all sessions: the account is now PENDING and must not keep a live
    // session from the setup flow (tokens were issued so /shop-setup could be called).
    await prisma.refreshToken.deleteMany({ where: { userId } }).catch(() => {});

    // ── Alert all platform admins ────────────────────────────────────────────
    const admins = await prisma.user.findMany({
      where: { role: { in: ['PLATFORM_ADMIN', 'SUPER_ADMIN'] }, isActive: true, email: { not: null } },
      select: { email: true },
    });

    const hasResendKey = !!process.env.RESEND_API_KEY;
    const hasSenderEmail = !!process.env.RESEND_SENDER_EMAIL;
    const ownerEmail = shopEmail || user.email || null;
    console.log(`[EMAIL] env: RESEND_API_KEY=${hasResendKey}, RESEND_SENDER_EMAIL=${hasSenderEmail}`);
    console.log(`[EMAIL] admin count with email: ${admins.length}`);
    console.log(`[EMAIL] owner email present: ${!!ownerEmail}`);

    if (!hasResendKey || !hasSenderEmail) {
      console.error('[EMAIL] SKIPPING sends — missing RESEND_API_KEY or RESEND_SENDER_EMAIL in environment. Set these in Render dashboard → Environment.');
    } else {
      // ── Admin verification alert ─────────────────────────────────────────
      const adminAlertSubject = `[RedPiston] New Shop Owner Pending Verification — ${ownerName.trim() || shopEmail}`;
      const adminAlertText = `New shop owner awaiting verification:\nName: ${ownerName.trim() || '—'}\nEmail: ${shopEmail || '—'}\n\nPlease review in the Admin Console.`;

      if (emailQueue) {
        admins.forEach(a => {
          emailQueue.add('shop-notification', {
            to: a.email,
            subject: adminAlertSubject,
            html: null,
            text: adminAlertText,
          }).catch(err => console.error('[Email Queue] Admin alert enqueue failed:', err));
        });
      } else {
        // direct send fallback
        sendShopOwnerVerificationAlert(
          { ...updatedUser, shop },
          admins.map(a => a.email)
        ).catch(e => console.error('[EMAIL] Admin alert failed:', e?.message || e));
      }

      // ── Under-review acknowledgement to the applicant ────────────────────
      const underReviewSubject = 'Profile Under Review — RedPiston';
      const underReviewText = `Thank you for registering. Your shop profile is currently under review. You will receive another email once approved — usually within 24 hours.`;

      if (emailQueue) {
        if (ownerEmail) {
          emailQueue.add('shop-notification', {
            to: ownerEmail,
            subject: underReviewSubject,
            html: null,
            text: underReviewText,
          }).catch(err => console.error('[Email Queue] Under-review enqueue failed:', err));
        }
      } else {
        // direct send fallback
        sendShopOwnerUnderReviewEmail(ownerEmail, ownerName.trim())
          .catch(e => console.error('[EMAIL] Under-review email failed:', e?.message || e));
      }
    }

    res.json({
      success: true,
      pending: true,
      message: 'Your shop details have been submitted. You will receive an email once approved by our team — usually within 24 hours.',
    });
  } catch (err) {
    next(err);
  }
});

export default router;
