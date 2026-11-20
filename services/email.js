/**
 * HERD HUB — Email Service
 * Uses Resend API (resend.com) — free tier: 3,000 emails/mo
 * Set RESEND_API_KEY in Railway env vars
 * Set EMAIL_FROM in Railway env vars (e.g. noreply@theherdhub.com)
 */

const FROM    = process.env.EMAIL_FROM    || 'Herd Hub <noreply@theherdhub.com>';
const API_KEY = process.env.RESEND_API_KEY;

async function sendEmail({ to, subject, html, text }) {
  if (!API_KEY) {
    console.warn('⚠️  Email not sent — RESEND_API_KEY not configured');
    console.log(`   To: ${to}\n   Subject: ${subject}`);
    return { ok: false, skipped: true };
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to, subject, html, text }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error('Email send error:', data);
      return { ok: false, error: data };
    }
    console.log(`✉️  Email sent to ${to}: ${subject}`);
    return { ok: true, id: data.id };
  } catch(e) {
    console.error('Email service error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Email templates ────────────────────────────────────
function emailBase(content) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:Georgia,serif;background:#f5efe0;margin:0;padding:20px}
  .wrap{max-width:560px;margin:0 auto;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  .header{background:#2c1a0e;padding:24px 32px;text-align:center}
  .header h1{font-family:Georgia,serif;color:#f5efe0;font-size:24px;margin:0}
  .header span{color:#C4A060}
  .body{padding:32px}
  .body p{color:#333;line-height:1.7;margin:0 0 16px}
  .btn{display:inline-block;background:#8b3214;color:#fff!important;padding:12px 28px;border-radius:4px;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:.05em;margin:8px 0}
  .footer{background:#f9f4ec;padding:16px 32px;text-align:center;font-size:12px;color:#888;border-top:1px solid #e8dcc8}
  .divider{height:1px;background:#e8dcc8;margin:20px 0}
</style></head>
<body><div class="wrap">
  <div class="header"><h1>Herd <span>Hub</span></h1></div>
  <div class="body">${content}</div>
  <div class="footer">Herd Hub · American Cattle Marketplace · <a href="https://theherdhub.com" style="color:#8b3214">theherdhub.com</a><br>
  You're receiving this because you have an account with Herd Hub.</div>
</div></body></html>`;
}

// Welcome email after registration. Carries the confirm-email link.
function welcomeEmail(name, verifyUrl) {
  const first = (name || '').trim().split(' ')[0] || 'there';
  return {
    subject: `Welcome to Herd Hub, ${first}. One quick step.`,
    html: emailBase(`
      <p>Hey ${first},</p>
      <p>Welcome to <strong>Herd Hub</strong>, the American cattle marketplace. Glad to have you.</p>
      <p>One quick step before you post your first listing: confirm this is your email address.</p>
      <a href="${verifyUrl}" class="btn">Confirm My Email</a>
      <p style="font-size:13px;color:#666">The link is good for 24 hours. Until you confirm, you can still browse listings, save searches and message sellers.</p>
      <div class="divider"></div>
      <p>Once you're in:</p>
      <p><strong>Post a free listing.</strong> Cattle, equipment, hay, working dogs, farm-fresh beef. Buyers in all 50 states.<br>
         <strong>Browse</strong> what's for sale near you.<br>
         <strong>Use the free ranch tools.</strong> Market prices, gestation, genetics, finance.</p>
      <p style="font-size:13px;color:#666">Questions? Reply to this email or reach us at <a href="mailto:ad@theherdhub.com" style="color:#8b3214">ad@theherdhub.com</a></p>
    `),
    text: `Welcome to Herd Hub, ${first}.\n\nOne quick step before you post your first listing: confirm your email address.\n${verifyUrl}\n\nThe link is good for 24 hours. Until you confirm, you can still browse, save searches and message sellers.\n\nQuestions? Reply to this email.`,
  };
}

// Fresh confirm-email link, sent on request
function verifyEmailReminder(name, verifyUrl) {
  const first = (name || '').trim().split(' ')[0] || 'there';
  return {
    subject: 'Confirm your Herd Hub email',
    html: emailBase(`
      <p>Hey ${first},</p>
      <p>Here's a fresh link to confirm your email address. Click it and you're clear to post.</p>
      <a href="${verifyUrl}" class="btn">Confirm My Email</a>
      <div class="divider"></div>
      <p style="font-size:13px;color:#666">The link is good for 24 hours. If you didn't ask for this, you can ignore it.</p>
    `),
    text: `Confirm your Herd Hub email: ${verifyUrl}\n\nThe link is good for 24 hours. If you didn't ask for this, ignore it.`,
  };
}

// Password reset email
function passwordResetEmail(name, resetUrl) {
  return {
    subject: 'Reset your Herd Hub password',
    html: emailBase(`
      <p>Hey ${name},</p>
      <p>We received a request to reset your Herd Hub password. Click the button below to set a new one.</p>
      <a href="${resetUrl}" class="btn">Reset My Password →</a>
      <div class="divider"></div>
      <p style="font-size:13px;color:#666">This link expires in <strong>1 hour</strong>. If you didn't request a password reset, you can safely ignore this email — your password won't change.</p>
    `),
    text: `Reset your Herd Hub password: ${resetUrl}\n\nThis link expires in 1 hour.`,
  };
}

// New message notification
function newMessageEmail(recipientName, senderName, listingTitle, messageBody) {
  return {
    subject: `New message about "${listingTitle}"`,
    html: emailBase(`
      <p>Hey ${recipientName},</p>
      <p><strong>${senderName}</strong> sent you a message about your listing: <strong>${listingTitle}</strong></p>
      <div style="background:#f9f4ec;border-left:3px solid #C4A060;padding:14px 18px;border-radius:0 4px 4px 0;margin:16px 0">
        <p style="margin:0;color:#333;font-style:italic">"${messageBody.slice(0, 200)}${messageBody.length > 200 ? '…' : ''}"</p>
      </div>
      <a href="https://theherdhub.com" class="btn">Reply on Herd Hub →</a>
      <div class="divider"></div>
      <p style="font-size:13px;color:#666">Log in to your account to view and reply to messages.</p>
    `),
    text: `${senderName} sent you a message about "${listingTitle}": ${messageBody.slice(0,200)}. Reply at https://theherdhub.com`,
  };
}

// Listing expiring soon
function listingExpiryEmail(name, listingTitle, expiresAt, listingId) {
  const days = Math.ceil((new Date(expiresAt) - new Date()) / 86400000);
  return {
    subject: `Your listing "${listingTitle}" expires in ${days} day${days !== 1 ? 's' : ''}`,
    html: emailBase(`
      <p>Hey ${name},</p>
      <p>Your listing <strong>${listingTitle}</strong> is expiring in <strong>${days} day${days !== 1 ? 's' : ''}</strong>.</p>
      <p>Renew it with one tap from My Listings to keep it in front of buyers for another 30 days. It's free.</p>
      <a href="https://theherdhub.com/?my=listings" class="btn">Renew My Listing →</a>
      <div class="divider"></div>
      <p style="font-size:13px;color:#666">If it has sold, tap Mark Sold on the same screen.</p>
    `),
    text: `Your listing "${listingTitle}" expires in ${days} days. Renew it free from My Listings: https://theherdhub.com/?my=listings`,
  };
}

// A free launch trial of a paid plan (Sirloin, Ribeye, Choice, Prime) is ending.
// The listing is not going away: it becomes a regular free listing.
function launchRunEndingEmail(name, listingTitle, endsAt) {
  const when = new Date(endsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  return {
    subject: `Your free featured run for "${listingTitle}" ends ${when}`,
    html: emailBase(`
      <p>Hey ${name},</p>
      <p>Your free featured run for <strong>${listingTitle}</strong> ends on <strong>${when}</strong>.</p>
      <p>Your listing stays up after that as a regular free listing, so buyers can still find it. There's nothing you need to do, and you won't be charged.</p>
      <a href="https://theherdhub.com/?my=listings" class="btn">See My Listings →</a>
      <div class="divider"></div>
      <p style="font-size:13px;color:#666">If it has sold, tap Mark Sold in My Listings.</p>
    `),
    text: `Your free featured run for "${listingTitle}" ends ${when}. Your listing stays up as a regular free listing after that. Nothing to do, and you won't be charged. My Listings: https://theherdhub.com/?my=listings`,
  };
}

module.exports = {
  sendEmail,
  welcomeEmail,
  verifyEmailReminder,
  passwordResetEmail,
  newMessageEmail,
  listingExpiryEmail,
  launchRunEndingEmail,
};
