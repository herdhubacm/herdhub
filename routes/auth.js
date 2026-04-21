const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { query } = require('../db/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
}

// Set secure httpOnly cookie — XSS-proof token storage
function setAuthCookie(res, token) {
  res.cookie('hh_auth', token, {
    httpOnly: true,           // JS cannot read this — blocks XSS token theft
    secure: process.env.NODE_ENV === 'production', // HTTPS only in prod
    sameSite: 'strict',       // CSRF protection
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie('hh_auth', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' });
}

// ── POST /api/auth/register ────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, phone, state, city,
            terms_accepted, terms_accepted_at, newsletter_opt_in,
            website } = req.body;
    // Honeypot bot protection — hidden field should always be empty
    if (website) return res.status(400).json({ error: 'Registration failed.' });

    if (!email || !password || !name)
      return res.status(400).json({ error: 'email, password and name are required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!terms_accepted)
      return res.status(400).json({ error: 'You must agree to the Terms of Service to create an account.' });

    const { rows: exists } = await query(
      'SELECT id FROM users WHERE email = $1', [email.toLowerCase()]
    );
    if (exists.length) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    const acceptedAt = terms_accepted_at ? new Date(terms_accepted_at) : new Date();
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, name, phone, state, city,
                          terms_accepted, terms_accepted_at, newsletter_opt_in)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, email, name, role`,
      [email.toLowerCase(), hash, name, phone || null, state || null, city || null,
       true, acceptedAt, newsletter_opt_in === true]
    );

    const user  = rows[0];
    const token = signToken({ id: user.id, email: user.email, name: user.name, role: user.role });
    setAuthCookie(res, token);
    // Send welcome email (non-blocking)
    try {
      const { sendEmail, welcomeEmail } = require('../services/email');
      const tmpl = welcomeEmail(user.name);
      sendEmail({ to: user.email, ...tmpl }).catch(() => {});
    } catch(e) {}
    res.status(201).json({ token, user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── POST /api/auth/login ───────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const identifier = email.toLowerCase().trim();

    // Step 1 — Look up user
    const { rows } = await query(
      'SELECT id, email, name, role, password_hash FROM users WHERE email = $1',
      [identifier]
    );
    const user = rows[0] || null;
    const isAdmin = user && user.role === 'admin';

    // Step 2 — Rate limit check (admin bypass, non-fatal on error)
    if (!isAdmin) {
      try {
        const { rows: lockRows } = await query(
          'SELECT attempts, locked_until FROM login_attempts WHERE identifier=$1', [identifier]);
        const rec = lockRows[0];
        if (rec && rec.locked_until && new Date(rec.locked_until) > new Date()) {
          const mins = Math.ceil((new Date(rec.locked_until) - new Date()) / 60000);
          return res.status(429).json({ error: `Too many attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.` });
        }
      } catch (e) {
        console.warn('Rate limit check skipped (non-fatal):', e.message);
      }
    }

    // Step 3 — Verify password
    const valid = user ? await bcrypt.compare(password, user.password_hash) : false;

    if (!user || !valid) {
      // Step 4 — Record failed attempt (non-fatal)
      if (!isAdmin) {
        try {
          await query(`
            INSERT INTO login_attempts (identifier, attempts, last_attempt, locked_until)
            VALUES ($1, 1, NOW(), NULL)
            ON CONFLICT (identifier) DO UPDATE SET
              attempts = login_attempts.attempts + 1,
              last_attempt = NOW(),
              locked_until = CASE
                WHEN login_attempts.attempts + 1 >= 10
                THEN NOW() + INTERVAL '3 minutes' ELSE NULL END
          `, [identifier]);
        } catch (e) { console.warn('Failed to record attempt (non-fatal):', e.message); }
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Step 5 — Success: clear attempts and issue token
    try { await query('DELETE FROM login_attempts WHERE identifier=$1', [identifier]); }
    catch (e) { /* non-fatal */ }

    const payload = { id: user.id, email: user.email, name: user.name, role: user.role };
    const token   = signToken(payload);
    setAuthCookie(res, token);
    res.json({ token, user: payload });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── GET /api/auth/me ───────────────────────────────────
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, email, name, phone, state, city, bio, avatar_url, role,
              is_verified, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch profile' });
  }
});

// ── PUT /api/auth/me ───────────────────────────────────
router.put('/me', authenticateToken, async (req, res) => {
  try {
    const { name, phone, state, city, bio } = req.body;
    if (!name || name.trim().length < 2)
      return res.status(400).json({ error: 'Name must be at least 2 characters' });
    const { rows } = await query(
      `UPDATE users
       SET name=$1, phone=$2, state=$3, city=$4, bio=$5, updated_at=NOW()
       WHERE id=$6
       RETURNING id, email, name, phone, state, city, bio, role, avatar_url, created_at`,
      [name.trim(), phone || null, state || null, city || null, bio || null, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const user = rows[0];
    const token = signToken({ id: user.id, email: user.email, name: user.name, role: user.role });
    setAuthCookie(res, token);
    res.json({ user, token });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// ── POST /api/auth/change-password ────────────────────
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const { rows } = await query(
      'SELECT password_hash FROM users WHERE id = $1', [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Password change failed' });
  }
});

// ── GET /api/auth/saved-listings ──────────────────────
router.get('/saved-listings', authenticateToken, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT l.id, l.title, l.category, l.price, l.price_type, l.state, l.city,
              l.is_featured, l.created_at,
              (SELECT url FROM listing_photos WHERE listing_id=l.id ORDER BY sort_order LIMIT 1) as thumb
       FROM saved_listings s
       JOIN listings l ON l.id = s.listing_id
       WHERE s.user_id = $1
       ORDER BY s.saved_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch saved listings' });
  }
});

module.exports = router;

// ── POST /api/auth/forgot-password ────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { rows } = await query(
      'SELECT id, name, email FROM users WHERE email=$1', [email.toLowerCase()]
    );
    // Always return success — don't reveal if email exists
    if (!rows.length) return res.json({ message: 'If that email is registered you will receive a reset link shortly.' });

    const user  = rows[0];
    const token = require('crypto').randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600000); // 1 hour

    await query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [user.id, token, expires]
    );

    const resetUrl = `https://theherdhub.com?reset=${token}`;
    const { sendEmail, passwordResetEmail } = require('../services/email');
    const tmpl = passwordResetEmail(user.name, resetUrl);
    await sendEmail({ to: user.email, ...tmpl });

    res.json({ message: 'If that email is registered you will receive a reset link shortly.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ── POST /api/auth/reset-password ─────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const { rows } = await query(
      `SELECT t.user_id, u.name, u.email FROM password_reset_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token=$1 AND t.expires_at > NOW() AND t.used=FALSE`,
      [token]
    );
    if (!rows.length) return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });

    const { user_id } = rows[0];
    const hash = await require('bcryptjs').hash(newPassword, 12);

    await Promise.all([
      query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user_id]),
      query('UPDATE password_reset_tokens SET used=TRUE WHERE token=$1', [token]),
    ]);

    res.json({ message: 'Password reset successfully. You can now sign in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ── POST /api/auth/newsletter ──────────────────────────
// Saves email to DB + sends welcome email via Resend (already configured)
router.post('/newsletter', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@'))
      return res.status(400).json({ error: 'Valid email required' });

    const emailLower = email.toLowerCase();

    // Check if already subscribed in users table
    const { rows: existing } = await query(
      'SELECT id, newsletter_opt_in FROM users WHERE email=$1',
      [emailLower]
    );

    if (existing.length) {
      if (existing[0].newsletter_opt_in) {
        return res.json({ ok: true, message: "You're already subscribed!" });
      }
      await query(
        'UPDATE users SET newsletter_opt_in=TRUE WHERE email=$1',
        [emailLower]
      );
    }
    // If not a registered user, still send welcome email
    // and store in beefbox_waitlist as a newsletter-only signup
    else {
      try {
        await query(
          `INSERT INTO beefbox_waitlist (name, email, type)
           VALUES ($1, $2, 'newsletter')
           ON CONFLICT (email) DO NOTHING`,
          [emailLower.split('@')[0], emailLower]
        );
      } catch(e) { /* ignore duplicate */ }
    }

    // Send welcome newsletter email via Resend (already configured)
    try {
      const { sendEmail } = require('../services/email');
      await sendEmail({
        to: emailLower,
        subject: 'Welcome to the Herd Hub Newsletter!',
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
          <body style="font-family:Georgia,serif;background:#f5efe0;margin:0;padding:20px">
          <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:6px;overflow:hidden">
            <div style="background:#2c1a0e;padding:24px 32px;text-align:center">
              <h1 style="font-family:Georgia,serif;color:#f5efe0;font-size:24px;margin:0">Herd <span style="color:#c9a96e">Hub</span> Newsletter</h1>
            </div>
            <div style="padding:32px">
              <p style="color:#333;line-height:1.7">You're on the list!</p>
              <p style="color:#333;line-height:1.7">Every month you'll get cattle market prices, featured listings, ranch news, and exclusive deals — straight to your inbox.</p>
              <div style="text-align:center;margin:24px 0">
                <a href="https://theherdhub.com" style="display:inline-block;background:#8b3214;color:#fff;padding:12px 28px;border-radius:4px;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:700">Browse Latest Listings &rarr;</a>
              </div>
            </div>
            <div style="background:#f9f4ec;padding:16px 32px;text-align:center;font-size:12px;color:#888">
              Herd Hub &middot; American Cattle Marketplace &middot; <a href="https://theherdhub.com" style="color:#8b3214">theherdhub.com</a>
            </div>
          </div></body></html>`,
        text: `Welcome to the Herd Hub Newsletter! Visit https://theherdhub.com for the latest listings.`,
      }).catch(() => {});
    } catch(e) {}

    res.json({ ok: true, message: "You're subscribed! Check your inbox for a welcome email." });
  } catch(e) {
    console.error('Newsletter error:', e);
    res.status(500).json({ error: 'Subscription failed' });
  }
});

// ── POST /api/auth/contact ─────────────────────────────
// Support contact form — emails ad@theherdhub.com
router.post('/contact', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !subject || !message)
      return res.status(400).json({ error: 'All fields are required' });
    if (!email.includes('@'))
      return res.status(400).json({ error: 'Valid email required' });

    const { sendEmail } = require('../services/email');
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    await sendEmail({
      to: process.env.SUPPORT_EMAIL || 'ad@theherdhub.com',
      subject: `[Support] ${subject.slice(0,100)} — from ${name.slice(0,50)}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px">
          <h2 style="color:#2c1a0e">Support Request</h2>
          <table style="border-collapse:collapse;width:100%">
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:700;width:120px">Name</td><td style="padding:8px;border:1px solid #ddd">${esc(name)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:700">Email</td><td style="padding:8px;border:1px solid #ddd">${esc(email)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:700">Subject</td><td style="padding:8px;border:1px solid #ddd">${esc(subject)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:700;vertical-align:top">Message</td><td style="padding:8px;border:1px solid #ddd;white-space:pre-wrap">${esc(message)}</td></tr>
          </table>
        </div>`,
      text: `Support request from ${name} (${email})\nSubject: ${subject}\n\n${message}`,
    });

    // Auto-reply to sender
    await sendEmail({
      to: email,
      subject: 'We received your message — Herd Hub Support',
      html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto">
        <div style="background:#2c1a0e;padding:20px;text-align:center">
          <h1 style="color:#f5efe0;margin:0;font-size:22px">Herd <span style="color:#c9a96e">Hub</span></h1>
        </div>
        <div style="padding:28px;background:#fff">
          <p style="color:#333;line-height:1.7">Hey ${name},</p>
          <p style="color:#333;line-height:1.7">Thanks for reaching out! We received your message about <strong>"${subject}"</strong> and will get back to you within 24 hours.</p>
          <p style="color:#888;font-size:13px">If this is urgent, you can also reach us directly at <a href="mailto:ad@theherdhub.com" style="color:#8b3214">ad@theherdhub.com</a>.</p>
        </div>
      </div>`,
      text: `Hi ${name}, we received your message and will respond within 24 hours. — Herd Hub Support`,
    }).catch(() => {});

    res.json({ ok: true });
  } catch(e) {
    console.error('Contact form error:', e);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── GET /api/auth/refresh ──────────────────────────────
// Called on page load — reads httpOnly cookie, returns token to memory
router.get('/refresh', (req, res) => {
  const token = req.cookies?.hh_auth;
  if (!token) return res.status(401).json({ error: 'No session' });
  try {
    const payload = require('jsonwebtoken').verify(token, process.env.JWT_SECRET);
    // Rotate cookie to extend session
    setAuthCookie(res, require('jsonwebtoken').sign(
      { id: payload.id, email: payload.email, name: payload.name, role: payload.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    ));
    res.json({ token, user: { id: payload.id, email: payload.email, name: payload.name, role: payload.role } });
  } catch(e) {
    clearAuthCookie(res);
    res.status(401).json({ error: 'Session expired' });
  }
});

// ── POST /api/auth/logout ──────────────────────────────
router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// ── POST /api/auth/verify-request ─────────────────────
router.post('/verify-request', authenticateToken, async (req, res) => {
  try {
    // Check if already verified
    const { rows: urows } = await query('SELECT is_verified FROM users WHERE id=$1', [req.user.id]);
    if (urows[0]?.is_verified) return res.json({ message: 'Already verified' });

    // Check for pending request
    const { rows: existing } = await query(
      "SELECT id FROM verification_requests WHERE user_id=$1 AND status='pending'", [req.user.id]);
    if (existing.length) return res.status(400).json({ error: 'You already have a pending verification request' });

    const { full_name, business_name, phone, state, operation_type, head_count, reason } = req.body;
    if (!full_name || !phone || !state)
      return res.status(400).json({ error: 'Name, phone, and state are required' });

    await query(
      `INSERT INTO verification_requests (user_id, full_name, business_name, phone, state, operation_type, head_count, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.user.id, (full_name||'').slice(0,150), (business_name||'').slice(0,150),
       (phone||'').slice(0,20), (state||'').slice(0,2), (operation_type||'').slice(0,100),
       (head_count||'').slice(0,50), (reason||'').slice(0,2000)]);

    const { sendEmail } = require('../services/email');
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    sendEmail({
      to: process.env.SUPPORT_EMAIL || 'ad@theherdhub.com',
      subject: `New Verification Request — ${full_name}`,
      html: `<div style="font-family:sans-serif"><h2>New Verification Request</h2>
        <p><strong>${esc(full_name)}</strong> — ${esc(business_name||'No business name')}</p>
        <p>Phone: ${esc(phone)} | State: ${esc(state)} | Operation: ${esc(operation_type||'N/A')}</p>
        <p>Head count: ${esc(head_count||'N/A')}</p>
        <p>Reason: ${esc(reason||'N/A')}</p>
        <p><a href="https://theherdhub.com/admin.html">Review in Admin Panel</a></p></div>`,
    }).catch(() => {});

    res.json({ ok: true, message: 'Verification request submitted. You will be notified within 24-48 hours.' });
  } catch(e) {
    console.error('Verify request error:', e.message);
    res.status(500).json({ error: 'Failed to submit verification request' });
  }
});

// ── GET /api/auth/verify-status ──────────────────────
router.get('/verify-status', authenticateToken, async (req, res) => {
  try {
    const { rows: u } = await query('SELECT is_verified FROM users WHERE id=$1', [req.user.id]);
    const { rows: p } = await query(
      "SELECT id, status FROM verification_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [req.user.id]);
    res.json({ is_verified: u[0]?.is_verified || false, pending_request: p[0] || null });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// ── Admin: get verification requests ─────────────────
router.get('/admin/verification-requests', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { rows } = await query(`
      SELECT vr.*, u.email, u.name AS account_name, u.is_verified
      FROM verification_requests vr JOIN users u ON vr.user_id=u.id
      WHERE vr.status='pending' ORDER BY vr.created_at DESC`);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ── Admin: approve verification ──────────────────────
router.post('/admin/verification-requests/:id/approve', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { rows } = await query('SELECT * FROM verification_requests WHERE id=$1', [parseInt(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await query('UPDATE users SET is_verified=true WHERE id=$1', [rows[0].user_id]);
    await query("UPDATE verification_requests SET status='approved', reviewed_by=$1, reviewed_at=NOW() WHERE id=$2",
      [req.user.id, req.params.id]);
    // Email user
    const { sendEmail } = require('../services/email');
    const u = await query('SELECT email, name FROM users WHERE id=$1', [rows[0].user_id]);
    if (u.rows.length) sendEmail({
      to: u.rows[0].email,
      subject: 'You\'re Verified on Herd Hub!',
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto"><h2 style="color:#2E7D4F">Congratulations, ${u.rows[0].name}!</h2><p>Your Herd Hub seller verification has been approved. You can now post Lot Sales and reach buyers nationwide.</p><p><a href="https://theherdhub.com/digital-sales.html#post" style="background:#8B3214;color:white;padding:12px 24px;border-radius:4px;text-decoration:none;display:inline-block">Post Your First Lot Sale</a></p></div>`,
    }).catch(() => {});
    res.json({ message: 'User verified' });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Admin: deny verification ─────────────────────────
router.post('/admin/verification-requests/:id/deny', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await query("UPDATE verification_requests SET status='denied', admin_notes=$1, reviewed_by=$2, reviewed_at=NOW() WHERE id=$3",
      [(req.body.admin_notes||'').slice(0,1000), req.user.id, parseInt(req.params.id)]);
    res.json({ message: 'Request denied' });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ── Admin: clear all login lockouts ──────────────────
router.delete('/admin/clear-lockouts', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    await query('DELETE FROM login_attempts');
    res.json({ message: 'All login lockouts cleared' });
  } catch { res.status(500).json({ error: 'Failed' }); }
});
