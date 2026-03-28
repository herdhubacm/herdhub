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

// ── POST /api/auth/register ────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, phone, state, city,
            terms_accepted, terms_accepted_at, newsletter_opt_in,
            cf_turnstile_token } = req.body;
    if (!email || !password || !name)
      return res.status(400).json({ error: 'email, password and name are required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!terms_accepted)
      return res.status(400).json({ error: 'You must agree to the Terms of Service to create an account.' });

    // Verify Turnstile token
    const turnstileOk = await req.app.locals.verifyTurnstile(cf_turnstile_token);
    if (!turnstileOk)
      return res.status(400).json({ error: 'Security check failed. Please try again.' });

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
      return res.status(400).json({ error: 'email and password required' });

    const { rows } = await query(
      'SELECT id, email, name, role, password_hash FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user  = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const payload = { id: user.id, email: user.email, name: user.name, role: user.role };
    const token   = signToken(payload);
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
    await query(
      `UPDATE users
       SET name=$1, phone=$2, state=$3, city=$4, bio=$5
       WHERE id=$6`,
      [name, phone || null, state || null, city || null, bio || null, req.user.id]
    );
    res.json({ message: 'Profile updated' });
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
