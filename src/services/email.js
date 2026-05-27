import prisma from '../db/prisma.js';
import { Resend } from 'resend';

let resendClient = null;

function getResendClient() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) {
    throw new Error('Missing RESEND_API_KEY in backend environment');
  }
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

    /**
     * Send an email using Resend
     */
    async function sendMail({ to, subject, html, text }) {
      try {
        const resend = getResendClient();
        const senderEmail = process.env.RESEND_SENDER_EMAIL;
        const senderName = process.env.RESEND_SENDER_NAME || 'AutoSpace';
        if (!senderEmail) {
          throw new Error('Missing RESEND_SENDER_EMAIL in backend environment');
        }

        await resend.emails.send({
          from: `${senderName} <${senderEmail}>`,
          to,
          subject,
          html,
          text,
        });
      } catch (err) {
        console.error(`[EMAIL] Failed to send email to ${to}:`, err?.message || err);
        if (err?.statusCode) console.error(`[EMAIL] Resend status: ${err.statusCode}`, err?.message);
        throw err;
      }
    }

// ─── HTML Email Templates ────────────────────────────────────────────

function baseTemplate(content) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AutoSpace</title>
</head>
<body style="margin:0;padding:0;background:#0A0F1D;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0A0F1D;padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#111827;border-radius:16px;border:1px solid #1F2937;overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="padding:32px 40px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:40px;height:40px;background:#F59E0B;border-radius:10px;text-align:center;vertical-align:middle;font-size:20px;">
                    &#9881;
                  </td>
                  <td style="padding-left:12px;font-size:20px;font-weight:800;color:#F3F4F6;letter-spacing:-0.5px;">
                    AutoSpace
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding:32px 40px 40px;">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #1F2937;">
              <p style="margin:0;font-size:12px;color:#6B7280;line-height:1.5;">
                This email was sent by AutoSpace. If you didn't request this, you can safely ignore it.
              </p>
              <p style="margin:8px 0 0;font-size:11px;color:#4B5563;">
                &copy; ${new Date().getFullYear()} AutoSpace &mdash; India's Auto Parts Platform
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function otpEmailHtml(code) {
  return baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#F3F4F6;">
      Verify your email
    </h1>
    <p style="margin:0 0 28px;font-size:15px;color:#9CA3AF;line-height:1.6;">
      Enter this code to verify your email address and complete your registration.
    </p>
    <div style="background:#0A0F1D;border:2px solid #F59E0B;border-radius:12px;padding:20px;text-align:center;margin-bottom:28px;">
      <span style="font-size:36px;font-weight:800;letter-spacing:12px;color:#F59E0B;font-family:'Courier New',monospace;">
        ${code}
      </span>
    </div>
    <p style="margin:0 0 4px;font-size:13px;color:#6B7280;">
      This code expires in <strong style="color:#9CA3AF;">10 minutes</strong>.
    </p>
    <p style="margin:0;font-size:13px;color:#6B7280;">
      If you didn't create an account, ignore this email.
    </p>
  `);
}

function passwordResetHtml(resetUrl, isFirstPassword = false) {
  const heading = isFirstPassword ? 'Set a password for your account' : 'Reset your password';
  const subtext = isFirstPassword
    ? 'You signed up with Google or phone. Click the button below to add an email + password login to your account.'
    : 'We received a request to reset the password for your account. Click the button below to set a new password.';
  const btnLabel = isFirstPassword ? 'Set My Password' : 'Reset Password';
  const ignoreNote = isFirstPassword
    ? "If you didn't request this, you can safely ignore this email."
    : "If you didn't request a password reset, ignore this email. Your password won't change.";

  return baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#F3F4F6;">
      ${heading}
    </h1>
    <p style="margin:0 0 28px;font-size:15px;color:#9CA3AF;line-height:1.6;">
      ${subtext}
    </p>
    <div style="text-align:center;margin-bottom:28px;">
      <a href="${resetUrl}"
         style="display:inline-block;background:#F59E0B;color:#000;font-size:15px;font-weight:700;
                padding:14px 36px;border-radius:10px;text-decoration:none;letter-spacing:0.3px;">
        ${btnLabel}
      </a>
    </div>
    <p style="margin:0 0 16px;font-size:13px;color:#6B7280;line-height:1.5;">
      Or copy and paste this link into your browser:
    </p>
    <div style="background:#0A0F1D;border-radius:8px;padding:12px 16px;margin-bottom:28px;word-break:break-all;">
      <a href="${resetUrl}" style="font-size:13px;color:#F59E0B;text-decoration:none;">
        ${resetUrl}
      </a>
    </div>
    <p style="margin:0 0 4px;font-size:13px;color:#6B7280;">
      This link expires in <strong style="color:#9CA3AF;">1 hour</strong>.
    </p>
    <p style="margin:0;font-size:13px;color:#6B7280;">
      ${ignoreNote}
    </p>
  `);
}

function getFrontendAppUrl() {
  // Highest priority: dedicated reset route URL (can include path)
  if (process.env.RESET_PASSWORD_URL) {
    return process.env.RESET_PASSWORD_URL.trim().replace(/\/$/, '');
  }

  // Prefer explicit app URL for links sent over email.
  if (process.env.FRONTEND_APP_URL) {
    return process.env.FRONTEND_APP_URL.trim().replace(/\/$/, '');
  }

  // If FRONTEND_URL is a comma-separated allowlist (used for CORS), use the first one.
  const allowList = process.env.FRONTEND_URL || 'http://localhost:5173';
  const firstUrl = allowList.split(',').map((v) => v.trim()).filter(Boolean)[0] || 'http://localhost:5173';
  return firstUrl.replace(/\/$/, '');
}

function welcomeEmailHtml(name) {
  const displayName = name || 'there';
  return baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#F3F4F6;">
      Welcome to AutoSpace!
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#9CA3AF;line-height:1.6;">
      Hey ${displayName}, your account is all set. Here's what you can do:
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td style="padding:12px 16px;background:#0A0F1D;border-radius:10px;margin-bottom:8px;">
          <p style="margin:0;font-size:14px;color:#F3F4F6;">
            <span style="color:#F59E0B;font-weight:700;">&#x1F50D; Browse Parts</span>
            &mdash; Find parts with guaranteed fitment for your vehicle
          </p>
        </td>
      </tr>
      <tr><td style="height:8px;"></td></tr>
      <tr>
        <td style="padding:12px 16px;background:#0A0F1D;border-radius:10px;">
          <p style="margin:0;font-size:14px;color:#F3F4F6;">
            <span style="color:#10B981;font-weight:700;">&#x1F3EA; Compare Shops</span>
            &mdash; Compare prices across local shops near you
          </p>
        </td>
      </tr>
      <tr><td style="height:8px;"></td></tr>
      <tr>
        <td style="padding:12px 16px;background:#0A0F1D;border-radius:10px;">
          <p style="margin:0;font-size:14px;color:#F3F4F6;">
            <span style="color:#38BDF8;font-weight:700;">&#x1F6D2; Order Online</span>
            &mdash; Get hyperlocal delivery from shops near you
          </p>
        </td>
      </tr>
    </table>
    <p style="margin:0;font-size:13px;color:#6B7280;">
      Need help? Just reply to this email.
    </p>
  `);
}

function passwordChangedHtml() {
  return baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#F3F4F6;">
      Password changed
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#9CA3AF;line-height:1.6;">
      Your password was successfully changed. If you did this, no further action is needed.
    </p>
    <div style="background:#0A0F1D;border:1px solid #EF4444;border-radius:10px;padding:16px;margin-bottom:24px;">
      <p style="margin:0;font-size:14px;color:#EF4444;font-weight:600;">
        &#x26A0; Didn't change your password?
      </p>
      <p style="margin:8px 0 0;font-size:13px;color:#9CA3AF;line-height:1.5;">
        If you didn't make this change, your account may be compromised. Reset your password immediately and contact support.
      </p>
    </div>
  `);
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Generate a 6-digit OTP, store in DB, and email it to the user.
 */
export async function sendEmailOtp(email) {
  const code = String(Math.floor(100000 + Math.random() * 900000));

  // Invalidate previous unused OTPs for this email
  await prisma.otpCode.updateMany({
    where: { email, type: 'EMAIL_VERIFY', used: false },
    data: { used: true },
  });

  await prisma.otpCode.create({
    data: {
      email,
      code,
      type: 'EMAIL_VERIFY',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 min
    },
  });

  await sendMail({
    to: email,
    subject: `${code} — Verify your AutoSpace email`,
    html: otpEmailHtml(code),
    text: `Your AutoSpace verification code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, ignore this email.`,
  });

  return code;
}

/**
 * Verify an email OTP code.
 */
export async function verifyEmailOtp(email, code) {
  const otp = await prisma.otpCode.findFirst({
    where: {
      email,
      code,
      type: 'EMAIL_VERIFY',
      used: false,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) return { valid: false };

  await prisma.otpCode.update({
    where: { id: otp.id },
    data: { used: true },
  });

  return { valid: true };
}

/**
 * Send password reset (or first-time set) email with a tokenized link.
 * @param {string} email
 * @param {string} token - raw reset token
 * @param {boolean} isFirstPassword - true if the user has no password yet (Google/phone account)
 */
export async function sendPasswordResetEmail(email, token, isFirstPassword = false) {
  const frontendUrl = getFrontendAppUrl();
  const resetPath = frontendUrl.toLowerCase().includes('/reset-password')
    ? frontendUrl
    : `${frontendUrl}/reset-password`;
  const resetUrl = `${resetPath}?token=${token}`;

  const subject = isFirstPassword
    ? 'Set a password for your AutoSpace account'
    : 'Reset your AutoSpace password';
  const plainText = isFirstPassword
    ? `Add a password to your AutoSpace account by visiting: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`
    : `Reset your password by visiting: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`;

  await sendMail({
    to: email,
    subject,
    html: passwordResetHtml(resetUrl, isFirstPassword),
    text: plainText,
  });
}

/**
 * Send welcome email after successful registration.
 */
export async function sendWelcomeEmail(email, name) {
  await sendMail({
    to: email,
    subject: `Welcome to AutoSpace${name ? `, ${name}` : ''}!`,
    html: welcomeEmailHtml(name),
    text: `Welcome to AutoSpace${name ? `, ${name}` : ''}! Your account is ready. Browse parts, compare shops, and order online.`,
  });
}

/**
 * Send notification when password is changed (security alert).
 */
export async function sendPasswordChangedEmail(email) {
  await sendMail({
    to: email,
    subject: 'Your AutoSpace password was changed',
    html: passwordChangedHtml(),
    text: `Your AutoSpace password was successfully changed. If you didn't do this, your account may be compromised. Reset your password immediately.`,
  });
}

/**
 * Alert all platform admins: new shop owner needs verification.
 * adminEmails: string[] — list of all active admin email addresses
 */
export async function sendShopOwnerVerificationAlert(shopOwner, adminEmails) {
  if (!adminEmails || adminEmails.length === 0) return;
  const appUrl = getFrontendAppUrl();
  const html = baseTemplate(`
    <div style="background:#1A1200;border:1px solid #D97706;border-radius:10px;padding:14px 18px;margin-bottom:20px;">
      <p style="margin:0;font-size:12px;font-weight:700;color:#D97706;text-transform:uppercase;letter-spacing:0.06em;">Action Required</p>
    </div>
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#F3F4F6;">New Shop Owner Awaiting Verification</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#9CA3AF;line-height:1.6;">
      A new shop owner has registered and is waiting for your approval before they can access the platform.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0A0F1D;border-radius:10px;padding:20px;margin-bottom:24px;">
      <tr><td style="padding:6px 0;font-size:13px;color:#6B7280;">Name</td><td style="padding:6px 0;font-size:14px;font-weight:600;color:#F3F4F6;">${shopOwner.name || '—'}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#6B7280;">Email</td><td style="padding:6px 0;font-size:14px;color:#F59E0B;">${shopOwner.email || '—'}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#6B7280;">Phone</td><td style="padding:6px 0;font-size:14px;color:#F3F4F6;">${shopOwner.phone || '—'}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#6B7280;">Registered</td><td style="padding:6px 0;font-size:14px;color:#F3F4F6;">${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td></tr>
    </table>
    <div style="text-align:center;margin-bottom:20px;">
      <a href="${appUrl}/admin"
         style="display:inline-block;background:#F59E0B;color:#000;font-size:15px;font-weight:700;padding:14px 36px;border-radius:10px;text-decoration:none;">
        Review in Admin Console →
      </a>
    </div>
    <p style="margin:0;font-size:13px;color:#6B7280;text-align:center;">
      Go to the Verifications tab in the Admin Console to approve or reject.
    </p>
  `);
  // Send to all admins (concurrently, don't fail if one bounces)
  await Promise.allSettled(adminEmails.map(email =>
    sendMail({ to: email, subject: `[AutoSpace] New Shop Owner Pending Verification — ${shopOwner.name || shopOwner.email}`, html,
      text: `New shop owner awaiting verification:\nName: ${shopOwner.name || '—'}\nEmail: ${shopOwner.email || '—'}\nPhone: ${shopOwner.phone || '—'}\n\nReview at: ${appUrl}/admin` })
  ));
}

/**
 * Notify shop owner their account has been approved.
 */
export async function sendShopOwnerApprovedEmail(shopOwner) {
  if (!shopOwner.email) return;
  const appUrl = getFrontendAppUrl();
  const html = baseTemplate(`
    <div style="background:#0A2E1A;border:1px solid #16A34A;border-radius:10px;padding:14px 18px;margin-bottom:20px;">
      <p style="margin:0;font-size:12px;font-weight:700;color:#4ADE80;text-transform:uppercase;letter-spacing:0.06em;">✓ Account Approved</p>
    </div>
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#F3F4F6;">Your Shop is Approved!</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#9CA3AF;line-height:1.6;">
      Hey ${shopOwner.name || 'there'}, great news! Your shop owner account on AutoSpace has been verified and approved. You can now log in and start managing your shop.
    </p>
    <div style="text-align:center;margin-bottom:28px;">
      <a href="${appUrl}/login"
         style="display:inline-block;background:#10B981;color:#fff;font-size:15px;font-weight:700;padding:14px 36px;border-radius:10px;text-decoration:none;">
        Log In to Your Shop →
      </a>
    </div>
    <p style="margin:0;font-size:13px;color:#6B7280;">
      Need help getting started? Reply to this email and our team will assist you.
    </p>
  `);
  await sendMail({
    to: shopOwner.email,
    subject: '🎉 Your AutoSpace Shop Account is Approved!',
    html,
    text: `Great news! Your AutoSpace shop owner account has been approved. Log in at: ${appUrl}/login`,
  });
}

/**
 * Notify shop owner their account was rejected, with the admin's reason.
 */
export async function sendShopOwnerRejectedEmail(shopOwner, reason) {
  if (!shopOwner.email) return;
  const html = baseTemplate(`
    <div style="background:#2E0A0A;border:1px solid #EF4444;border-radius:10px;padding:14px 18px;margin-bottom:20px;">
      <p style="margin:0;font-size:12px;font-weight:700;color:#F87171;text-transform:uppercase;letter-spacing:0.06em;">Application Not Approved</p>
    </div>
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#F3F4F6;">Your Application Was Reviewed</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#9CA3AF;line-height:1.6;">
      Hey ${shopOwner.name || 'there'}, after reviewing your shop owner application, we were unable to approve it at this time.
    </p>
    <div style="background:#0A0F1D;border:1px solid #374151;border-radius:10px;padding:18px;margin-bottom:24px;">
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.06em;">Reason provided:</p>
      <p style="margin:0;font-size:15px;color:#F3F4F6;line-height:1.6;">${reason || 'Your application did not meet our current requirements.'}</p>
    </div>
    <p style="margin:0;font-size:13px;color:#9CA3AF;line-height:1.5;">
      If you believe this is a mistake or want to reapply, please contact our support team by replying to this email.
    </p>
  `);
  await sendMail({
    to: shopOwner.email,
    subject: 'Update on your AutoSpace Shop Owner Application',
    html,
    text: `Your AutoSpace shop owner application was not approved.\n\nReason: ${reason || 'Your application did not meet our current requirements.'}\n\nContact support by replying to this email.`,
  });
}
