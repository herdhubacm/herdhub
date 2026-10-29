const jwt = require('jsonwebtoken');
const { query } = require('../db/database');

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next();
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (!err) req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Blocks actions that need a confirmed email address (posting a listing).
// Reads the database each time, so a confirmation takes effect immediately
// without waiting for a new login token. Admins pass.
async function requireVerifiedEmail(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'No token provided' });
    if (req.user.role === 'admin') return next();
    const { rows } = await query('SELECT email_verified_at FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length) return res.status(401).json({ error: 'Account not found' });
    if (!rows[0].email_verified_at) {
      return res.status(403).json({
        error: 'Confirm your email address before posting. Check your inbox for the link, or send a new one.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }
    next();
  } catch (err) {
    console.error('requireVerifiedEmail error:', err);
    res.status(500).json({ error: 'Could not check account status' });
  }
}

module.exports = { authenticateToken, optionalAuth, requireAdmin, requireVerifiedEmail };
