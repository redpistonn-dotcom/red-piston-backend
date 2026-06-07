import crypto from 'crypto';
import axios from 'axios';
import prisma from '../db/prisma.js';

// Cryptographically secure 6-digit OTP — crypto.randomInt is CSPRNG, Math.random() is not
const generateOtp = () => crypto.randomInt(100000, 1000000).toString();

// SHA-256 hash of the OTP — only the hash is ever stored in the DB
// Plaintext OTP is generated, sent to user once, then discarded
const hashOtp = (code) => crypto.createHash('sha256').update(code).digest('hex');

export const sendOtp = async (phone) => {
  const code = generateOtp();
  const codeHash = hashOtp(code);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Invalidate previous OTPs for this phone
  await prisma.otpCode.updateMany({
    where: { phone, used: false },
    data: { used: true },
  });

  // Store HASH only — plaintext never persisted to DB
  await prisma.otpCode.create({
    data: { phone, code: codeHash, expiresAt },
  });

  // In development, log that an OTP was sent — never log the actual code
  if (process.env.NODE_ENV === 'development') {
    console.log(`[OTP DEV] Code dispatched for phone ending ...${phone.slice(-3)}`);
    return { success: true, dev: true };
  }

  // Production: send plaintext OTP via MSG91; hash is already stored above
  await axios.post(
    'https://api.msg91.com/api/v5/otp',
    {
      mobile: `91${phone}`,
      authkey: process.env.MSG91_AUTH_KEY,
      template_id: process.env.MSG91_TEMPLATE_ID,
      otp: code,
    }
  );
  return { success: true };
};

export const verifyOtp = async (phone, code) => {
  const codeHash = hashOtp(code);

  // Query by hash — if the hash doesn't match, findFirst returns null
  // Constant-time DB lookup: hash comparison happens inside Postgres, not in JS
  const latest = await prisma.otpCode.findFirst({
    where: { phone, code: codeHash, used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });

  if (!latest) return { valid: false, otpRecord: null };

  // Don't mark as used here — the route does it after ensureAuthProvider so we keep the record
  // for the `if (otpRecord?.id)` block in the route
  return { valid: true, otpRecord: latest };
};
