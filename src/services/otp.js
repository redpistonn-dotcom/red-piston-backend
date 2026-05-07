import axios from 'axios';
import prisma from '../db/prisma.js';

const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

export const sendOtp = async (phone) => {
  const code = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Invalidate previous OTPs for this phone
  await prisma.otpCode.updateMany({
    where: { phone, used: false },
    data: { used: true },
  });

  // Store new OTP
  await prisma.otpCode.create({
    data: { phone, code, expiresAt },
  });

  // In development, just log it
  if (process.env.NODE_ENV === 'development') {
    console.log(`[OTP] Phone: ${phone} | Code: ${code}`);
    return { success: true, dev: true };
  }

  // Production: send via MSG91
  const response = await axios.post(
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
  // Find the latest active OTP for this phone (used to return on failure for attempt tracking)
  const latest = await prisma.otpCode.findFirst({
    where: { phone, used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });

  if (!latest || latest.code !== code) return { valid: false, otpRecord: latest };

  // Don't mark as used here — the route does it after ensureAuthProvider so we keep the record
  // for the `if (otpRecord?.id)` block in the route
  return { valid: true, otpRecord: latest };
};
