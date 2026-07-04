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
        const senderName = process.env.RESEND_SENDER_NAME || 'RedPiston';
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

function baseTemplate(content, { accentColor = '#8B1A0F', accentLabel = null } = {}) {
  const appUrl = getFrontendAppUrl();
  // EMAIL_LOGO_URL takes priority (set it to the full CDN/public URL of logo.png).
  // Falls back to ${appUrl}/logo.png but MUST be an absolute public URL —
  // email clients cannot load localhost or relative paths.
  const logoUrl = process.env.EMAIL_LOGO_URL || `${appUrl}/logo.png`;
  const year = new Date().getFullYear();
  const accentBadge = accentLabel
    ? `<tr><td style="padding:20px 40px 0;"><div style="display:inline-block;background:${accentColor}18;border:1px solid ${accentColor}55;border-radius:6px;padding:5px 14px;"><span style="font-size:11px;font-weight:700;color:${accentColor};text-transform:uppercase;letter-spacing:0.09em;">${accentLabel}</span></div></td></tr>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>RedPiston</title>
<style>
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table,td{mso-table-lspace:0;mso-table-rspace:0}
  img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none}
  body{margin:0;padding:0;background:#F2F2F2}
  @media only screen and (max-width:600px){
    .email-card{width:100%!important;border-radius:0!important}
    .email-content{padding:28px 24px!important}
    .email-header{padding:24px 24px 20px!important}
    .email-footer{padding:20px 24px!important}
    .btn-cta{display:block!important;text-align:center!important}
    .otp-code{font-size:32px!important;letter-spacing:8px!important}
    .detail-table td{display:block!important;width:100%!important}
  }
</style>
</head>
<body>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F2F2;padding:32px 16px;">
  <tr>
    <td align="center">
      <!-- Card -->
      <table role="presentation" class="email-card" width="600" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.10);">

        <!-- Top accent bar -->
        <tr>
          <td style="background:#8B1A0F;height:4px;font-size:1px;line-height:1px;">&nbsp;</td>
        </tr>

        <!-- Header -->
        <tr>
          <td class="email-header" style="padding:28px 40px 24px;border-bottom:1px solid #F0F0F0;">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="line-height:0;vertical-align:middle;">
                  <!--[if !mso]><!-->
                  <img src="${logoUrl}" width="48" height="48" alt="RedPiston"
                    style="display:block;width:48px;height:48px;border-radius:10px;object-fit:contain;"
                    onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
                  <div style="display:none;width:48px;height:48px;border-radius:10px;background:#8B1A0F;align-items:center;justify-content:center;color:#fff;font-size:18px;font-weight:900;font-family:-apple-system,sans-serif;">RP</div>
                  <!--<![endif]-->
                  <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" style="width:48px;height:48px;" arcsize="20%" fillcolor="#8B1A0F" strokecolor="none"><v:textbox inset="0,0,0,0"><center style="color:#FFFFFF;font-family:Arial;font-size:18px;font-weight:900;line-height:48px;">RP</center></v:textbox></v:roundrect><![endif]-->
                </td>
                <td style="padding-left:12px;vertical-align:middle;">
                  <span style="font-size:18px;font-weight:800;color:#111111;letter-spacing:-0.3px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">RedPiston</span>
                  <div style="font-size:11px;color:#888888;margin-top:1px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">India's Auto Parts Platform</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        ${accentBadge}

        <!-- Content -->
        <tr>
          <td class="email-content" style="padding:32px 40px 36px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
            ${content}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td class="email-footer" style="padding:20px 40px 24px;background:#F9FAFB;border-top:1px solid #F0F0F0;">
            <p style="margin:0;font-size:12px;color:#9CA3AF;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
              This email was sent by RedPiston. If you didn't request this, you can safely ignore it.
            </p>
            <p style="margin:6px 0 0;font-size:11px;color:#C4C4C4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
              &copy; ${year} RedPiston &mdash; India's Auto Parts Platform
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
    <h1 style="margin:0 0 6px;font-size:24px;font-weight:800;color:#111111;line-height:1.3;">Verify your email</h1>
    <p style="margin:0 0 28px;font-size:15px;color:#6B7280;line-height:1.7;">
      Use the code below to verify your email address. It's valid for <strong style="color:#111111;">10 minutes</strong>.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td align="center" style="background:#FBF4F4;border:2px solid #8B1A0F;border-radius:12px;padding:28px 20px;">
          <div style="font-size:11px;font-weight:700;color:#8B1A0F;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:12px;">Your verification code</div>
          <div class="otp-code" style="font-size:42px;font-weight:800;letter-spacing:14px;color:#8B1A0F;font-family:'Courier New',Courier,monospace;line-height:1;">${code}</div>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 6px;font-size:13px;color:#9CA3AF;line-height:1.6;">
      Do not share this code with anyone. RedPiston will never ask for it.
    </p>
    <p style="margin:0;font-size:13px;color:#9CA3AF;">
      Didn't create an account? You can ignore this email.
    </p>
  `);
}

function passwordResetHtml(resetUrl, isFirstPassword = false) {
  const heading = isFirstPassword ? 'Set your password' : 'Reset your password';
  const subtext = isFirstPassword
    ? 'You signed up with Google or phone. Click the button below to add an email + password login to your account.'
    : 'We received a request to reset the password for your account. Click the button below to choose a new one.';
  const btnLabel = isFirstPassword ? 'Set My Password' : 'Reset Password';
  const ignoreNote = isFirstPassword
    ? "If you didn't request this, you can safely ignore this email."
    : "If you didn't request a password reset, ignore this email — your password won't change.";

  return baseTemplate(`
    <h1 style="margin:0 0 6px;font-size:24px;font-weight:800;color:#111111;line-height:1.3;">${heading}</h1>
    <p style="margin:0 0 28px;font-size:15px;color:#6B7280;line-height:1.7;">${subtext}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td align="center">
          <a href="${resetUrl}" class="btn-cta"
             style="display:inline-block;background:#8B1A0F;color:#FFFFFF;font-size:15px;font-weight:700;padding:15px 40px;border-radius:8px;text-decoration:none;letter-spacing:0.2px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
            ${btnLabel} &rarr;
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 10px;font-size:13px;color:#9CA3AF;line-height:1.5;">
      Button not working? Copy and paste this link into your browser:
    </p>
    <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:12px 16px;margin-bottom:24px;word-break:break-all;">
      <a href="${resetUrl}" style="font-size:13px;color:#8B1A0F;text-decoration:none;">${resetUrl}</a>
    </div>
    <p style="margin:0;font-size:13px;color:#9CA3AF;line-height:1.6;">
      This link expires in <strong style="color:#374151;">1 hour</strong>. ${ignoreNote}
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
    <h1 style="margin:0 0 6px;font-size:24px;font-weight:800;color:#111111;line-height:1.3;">Welcome to RedPiston, ${displayName}!</h1>
    <p style="margin:0 0 28px;font-size:15px;color:#6B7280;line-height:1.7;">
      Your account is all set. Here's everything you can do on the platform:
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td style="padding:14px 18px;background:#FBF4F4;border-left:3px solid #8B1A0F;border-radius:0 8px 8px 0;margin-bottom:10px;">
          <p style="margin:0;font-size:14px;font-weight:700;color:#8B1A0F;">&#x1F50D; Browse Parts</p>
          <p style="margin:4px 0 0;font-size:13px;color:#6B7280;">Find parts with guaranteed fitment for your vehicle</p>
        </td>
      </tr>
      <tr><td style="height:10px;"></td></tr>
      <tr>
        <td style="padding:14px 18px;background:#F0FDF4;border-left:3px solid #16A34A;border-radius:0 8px 8px 0;">
          <p style="margin:0;font-size:14px;font-weight:700;color:#15803D;">&#x1F3EA; Compare Shops</p>
          <p style="margin:4px 0 0;font-size:13px;color:#6B7280;">Compare prices across local shops near you</p>
        </td>
      </tr>
      <tr><td style="height:10px;"></td></tr>
      <tr>
        <td style="padding:14px 18px;background:#EFF6FF;border-left:3px solid #2563EB;border-radius:0 8px 8px 0;">
          <p style="margin:0;font-size:14px;font-weight:700;color:#1D4ED8;">&#x1F6D2; Order Online</p>
          <p style="margin:4px 0 0;font-size:13px;color:#6B7280;">Get hyperlocal delivery from shops near you</p>
        </td>
      </tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9CA3AF;line-height:1.6;">Questions? Just reply to this email and we'll be happy to help.</p>
  `);
}

function passwordChangedHtml() {
  return baseTemplate(`
    <h1 style="margin:0 0 6px;font-size:24px;font-weight:800;color:#111111;line-height:1.3;">Password changed</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#6B7280;line-height:1.7;">
      Your RedPiston password was successfully updated. If you made this change, no further action is needed.
    </p>
    <div style="background:#FEF2F2;border:1px solid #FCA5A5;border-radius:10px;padding:18px 20px;margin-bottom:24px;">
      <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#DC2626;">&#x26A0;&#xFE0F; Didn't change your password?</p>
      <p style="margin:0;font-size:13px;color:#7F1D1D;line-height:1.6;">
        Your account may be compromised. Reset your password immediately and contact our support team.
      </p>
    </div>
    <p style="margin:0;font-size:13px;color:#9CA3AF;">If you have any concerns, reply to this email and we'll help secure your account.</p>
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
    subject: `${code} — Verify your RedPiston email`,
    html: otpEmailHtml(code),
    text: `Your RedPiston verification code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, ignore this email.`,
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
    ? 'Set a password for your RedPiston account'
    : 'Reset your RedPiston password';
  const plainText = isFirstPassword
    ? `Add a password to your RedPiston account by visiting: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`
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
    subject: `Welcome to RedPiston${name ? `, ${name}` : ''}!`,
    html: welcomeEmailHtml(name),
    text: `Welcome to RedPiston${name ? `, ${name}` : ''}! Your account is ready. Browse parts, compare shops, and order online.`,
  });
}

/**
 * Send notification when password is changed (security alert).
 */
export async function sendPasswordChangedEmail(email) {
  await sendMail({
    to: email,
    subject: 'Your RedPiston password was changed',
    html: passwordChangedHtml(),
    text: `Your RedPiston password was successfully changed. If you didn't do this, your account may be compromised. Reset your password immediately.`,
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
    <h1 style="margin:0 0 6px;font-size:24px;font-weight:800;color:#111111;line-height:1.3;">New Shop Owner Awaiting Verification</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#6B7280;line-height:1.7;">
      A new shop owner has registered and needs your approval before they can access the platform.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;margin-bottom:24px;">
      <tr>
        <td style="padding:12px 18px;border-bottom:1px solid #E5E7EB;">
          <span style="font-size:12px;color:#9CA3AF;display:block;margin-bottom:2px;">Name</span>
          <span style="font-size:14px;font-weight:600;color:#111111;">${shopOwner.name || '—'}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 18px;border-bottom:1px solid #E5E7EB;">
          <span style="font-size:12px;color:#9CA3AF;display:block;margin-bottom:2px;">Email</span>
          <span style="font-size:14px;color:#8B1A0F;">${shopOwner.email || '—'}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 18px;">
          <span style="font-size:12px;color:#9CA3AF;display:block;margin-bottom:2px;">Registered</span>
          <span style="font-size:14px;color:#374151;">${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>
        </td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      <tr>
        <td align="center">
          <a href="${appUrl}/admin" class="btn-cta"
             style="display:inline-block;background:#8B1A0F;color:#FFFFFF;font-size:15px;font-weight:700;padding:15px 40px;border-radius:8px;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
            Review in Admin Console &rarr;
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9CA3AF;text-align:center;">Go to the Verifications tab to approve or reject this application.</p>
  `, { accentColor: '#D97706', accentLabel: 'Action Required' });
  await Promise.allSettled(adminEmails.map(email =>
    sendMail({ to: email, subject: `[RedPiston] New Shop Owner Pending Verification — ${shopOwner.name || shopOwner.email}`, html,
      text: `New shop owner awaiting verification:\nName: ${shopOwner.name || '—'}\nEmail: ${shopOwner.email || '—'}\n\nReview at: ${appUrl}/admin` })
  ));
}

/**
 * Notify shop owner their account has been approved.
 */
export async function sendShopOwnerApprovedEmail(shopOwner) {
  if (!shopOwner.email) return;
  const appUrl = getFrontendAppUrl();
  const html = baseTemplate(`
    <h1 style="margin:0 0 6px;font-size:24px;font-weight:800;color:#111111;line-height:1.3;">Your Shop is Approved!</h1>
    <p style="margin:0 0 28px;font-size:15px;color:#6B7280;line-height:1.7;">
      Hey ${shopOwner.name || 'there'}, great news! Your shop owner account on RedPiston has been verified and approved. You can now log in and start managing your shop.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td align="center">
          <a href="${appUrl}/login" class="btn-cta"
             style="display:inline-block;background:#8B1A0F;color:#FFFFFF;font-size:15px;font-weight:700;padding:15px 40px;border-radius:8px;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
            Log In to Your Shop &rarr;
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9CA3AF;line-height:1.6;">Need help getting started? Reply to this email and our team will assist you.</p>
  `, { accentColor: '#16A34A', accentLabel: '&#10003; Account Approved' });
  await sendMail({
    to: shopOwner.email,
    subject: 'Your RedPiston Shop Account is Approved!',
    html,
    text: `Great news! Your RedPiston shop owner account has been approved. Log in at: ${appUrl}/login`,
  });
}

/**
 * Notify shop owner their account was rejected, with the admin's reason.
 */
export async function sendShopOwnerRejectedEmail(shopOwner, reason) {
  if (!shopOwner.email) return;
  const html = baseTemplate(`
    <h1 style="margin:0 0 6px;font-size:24px;font-weight:800;color:#111111;line-height:1.3;">Your Application Was Reviewed</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#6B7280;line-height:1.7;">
      Hey ${shopOwner.name || 'there'}, after reviewing your shop owner application, we were unable to approve it at this time.
    </p>
    <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:18px 20px;margin-bottom:24px;">
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">Reason provided</p>
      <p style="margin:0;font-size:15px;color:#374151;line-height:1.7;">${reason || 'Your application did not meet our current requirements.'}</p>
    </div>
    <p style="margin:0;font-size:13px;color:#9CA3AF;line-height:1.6;">
      If you believe this is a mistake or would like to reapply, please contact our support team by replying to this email.
    </p>
  `, { accentColor: '#EF4444', accentLabel: 'Application Not Approved' });
  await sendMail({
    to: shopOwner.email,
    subject: 'Update on your RedPiston Shop Owner Application',
    html,
    text: `Your RedPiston shop owner application was not approved.\n\nReason: ${reason || 'Your application did not meet our current requirements.'}\n\nContact support by replying to this email.`,
  });
}

/**
 * Acknowledge the APPLICANT right after they submit shop details —
 * "your profile is under review". (The admin alert is a separate email.)
 */
export async function sendShopOwnerUnderReviewEmail(email, ownerName) {
  if (!email) return;
  const html = baseTemplate(`
    <h1 style="margin:0 0 6px;font-size:24px;font-weight:800;color:#111111;line-height:1.3;">Thanks for registering${ownerName ? `, ${ownerName}` : ''}!</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#6B7280;line-height:1.7;">
      Your shop profile has been submitted and is currently under review by our team.
    </p>
    <div style="background:#FFFBEB;border:1px solid #FCD34D;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
      <p style="margin:0;font-size:14px;color:#92400E;line-height:1.6;">
        &#x23F3; We'll notify you once your account is approved — usually within <strong>24 hours</strong>. No action is needed from you right now.
      </p>
    </div>
    <p style="margin:0;font-size:13px;color:#9CA3AF;line-height:1.6;">
      Questions? Just reply to this email and our team will help.
    </p>
  `, { accentColor: '#D97706', accentLabel: 'Profile Under Review' });
  await sendMail({
    to: email,
    subject: 'Profile Under Review — RedPiston',
    html,
    text: `Thank you for registering. Your shop profile is currently under review. You will receive another email once approved — usually within 24 hours.`,
  });
}

/**
 * Send a Purchase Order to a supplier via email, with the PO PDF attached.
 * Throws with code NO_SUPPLIER_EMAIL if the party has no email on file.
 * Throws with code EMAIL_SEND_FAILED on a Resend delivery error.
 */
export async function sendPurchaseOrderEmail(po, pdfBuffer) {
  const supplierEmail = po.party?.email || po.supplierEmail || null;
  if (!supplierEmail) {
    const err = new Error('Supplier has no email address on file. Add one in Parties first.');
    err.code = 'NO_SUPPLIER_EMAIL';
    throw err;
  }

  const shopName   = po.shop?.name || process.env.RESEND_SENDER_NAME || 'RedPiston Shop';
  const poNumber   = po.poNumber;
  const itemCount  = (po.items || []).length;
  const total      = Number(po.totalAmount).toLocaleString('en-IN', { maximumFractionDigits: 0 });

  const html = baseTemplate(`
    <h1 style="margin:0 0 6px;font-size:24px;font-weight:800;color:#111111;line-height:1.3;">Purchase Order ${poNumber}</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#6B7280;line-height:1.7;">
      Please find our Purchase Order attached. Kindly confirm availability and expected delivery date.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;margin-bottom:24px;">
      <tr>
        <td style="padding:12px 18px;border-bottom:1px solid #E5E7EB;">
          <span style="font-size:12px;color:#9CA3AF;display:block;margin-bottom:2px;">PO Number</span>
          <span style="font-size:15px;font-weight:700;color:#8B1A0F;">${poNumber}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 18px;border-bottom:1px solid #E5E7EB;">
          <span style="font-size:12px;color:#9CA3AF;display:block;margin-bottom:2px;">From</span>
          <span style="font-size:14px;color:#374151;">${shopName}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 18px;border-bottom:1px solid #E5E7EB;">
          <span style="font-size:12px;color:#9CA3AF;display:block;margin-bottom:2px;">Items</span>
          <span style="font-size:14px;color:#374151;">${itemCount} line item${itemCount !== 1 ? 's' : ''}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 18px;">
          <span style="font-size:12px;color:#9CA3AF;display:block;margin-bottom:2px;">Total Value</span>
          <span style="font-size:16px;font-weight:800;color:#111111;">&#x20B9;${total}</span>
        </td>
      </tr>
    </table>
    ${po.notes ? `<div style="background:#FFFBEB;border:1px solid #FCD34D;border-radius:8px;padding:14px 18px;margin-bottom:24px;"><p style="margin:0;font-size:14px;color:#92400E;line-height:1.6;"><strong>Remarks:</strong> ${po.notes}</p></div>` : ''}
    <p style="margin:0;font-size:13px;color:#9CA3AF;line-height:1.6;">
      The PO PDF is attached to this email. Please reply to confirm acceptance or raise any queries.
    </p>
  `, { accentColor: '#8B1A0F', accentLabel: `PO ${poNumber}` });

  const resend      = getResendClient();
  const senderEmail = process.env.RESEND_SENDER_EMAIL;
  const senderName  = process.env.RESEND_SENDER_NAME || shopName;
  if (!senderEmail) throw new Error('Missing RESEND_SENDER_EMAIL in backend environment');

  const { error } = await resend.emails.send({
    from:    `${senderName} <${senderEmail}>`,
    to:      supplierEmail,
    subject: `Purchase Order ${poNumber} from ${shopName}`,
    html,
    text:    `Purchase Order ${poNumber} from ${shopName}\n\nItems: ${itemCount}\nTotal: ₹${total}\n\n${po.notes ? `Remarks: ${po.notes}\n\n` : ''}Please confirm availability and expected delivery date. The PO PDF is attached to this email.`,
    attachments: [{ filename: `${poNumber}.pdf`, content: pdfBuffer }],
  });

  if (error) {
    const err = new Error(`Email delivery failed: ${error.message || JSON.stringify(error)}`);
    err.code = 'EMAIL_SEND_FAILED';
    throw err;
  }
}

/**
 * Order confirmation to the customer right after a marketplace order is placed.
 */
export async function sendOrderConfirmationEmail(email, { customerName, orderNumber, shopName, itemCount, totalAmount }) {
  if (!email) return;
  const html = baseTemplate(`
    <h1 style="margin:0 0 6px;font-size:24px;font-weight:800;color:#111111;line-height:1.3;">Order confirmed${customerName ? `, ${customerName}` : ''}!</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#6B7280;line-height:1.7;">
      Your order has been placed and the shop has been notified. You'll receive an update when it's ready.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;margin-bottom:24px;">
      <tr>
        <td style="padding:12px 18px;border-bottom:1px solid #E5E7EB;">
          <span style="font-size:12px;color:#9CA3AF;display:block;margin-bottom:2px;">Order Number</span>
          <span style="font-size:15px;font-weight:700;color:#8B1A0F;">#${orderNumber}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 18px;border-bottom:1px solid #E5E7EB;">
          <span style="font-size:12px;color:#9CA3AF;display:block;margin-bottom:2px;">Shop</span>
          <span style="font-size:14px;color:#374151;">${shopName || '—'}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 18px;border-bottom:1px solid #E5E7EB;">
          <span style="font-size:12px;color:#9CA3AF;display:block;margin-bottom:2px;">Items</span>
          <span style="font-size:14px;color:#374151;">${itemCount} item${itemCount !== 1 ? 's' : ''}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 18px;">
          <span style="font-size:12px;color:#9CA3AF;display:block;margin-bottom:2px;">Total Amount</span>
          <span style="font-size:16px;font-weight:800;color:#16A34A;">&#x20B9;${Number(totalAmount).toFixed(2)}</span>
        </td>
      </tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9CA3AF;line-height:1.6;">
      Track your order anytime from the Orders section of your account.
    </p>
  `, { accentColor: '#16A34A', accentLabel: '&#10003; Order Placed' });
  await sendMail({
    to: email,
    subject: `Order #${orderNumber} confirmed — RedPiston`,
    html,
    text: `Your order #${orderNumber} from ${shopName || 'the shop'} (${itemCount} items, ₹${Number(totalAmount).toFixed(2)}) has been placed. Track it from the Orders section.`,
  });
}
