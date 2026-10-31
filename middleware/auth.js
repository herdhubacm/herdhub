const jwt = require('jsonwebtoken');
const { query } = require('../db/database');

// ── Session state (H6) ───────────────────────────────
// A token is live only while the account exists, is not banned, and the
// token's version (tv) matches users.token_version. Ban, any password
// change, "sign out everywhere" and the admin "invalidate all" bump the
// version. Checked per request through a 60-second in-memory cache; bumps
// made on this server clear the cache entry so they take effect at once.
// Tokens issued before versions existed carry no tv and count as version 0.
const SESSION_TTL_MS = 60 * 1000;
const sessionCache = new Map(); // user id -> { exists, tv, banned, exp }

function invalidateSessionCache(userId) {
  if (userId === undefined) { sessionCache.clear(); return; }
  sessionCache.delete(Number(userId));
}

async function sessionState(userId) {
  const id = Number(userId);
  const now = Date.now();
  const hit = sessionCache.get(id);
  if (hit && hit.exp > now) return hit;
  const { rows } = await query('SELECT token_version, is_banned FROM users WHERE id = $1', [id]);
  const state = rows.length
    ? { exists: true, tv: rows[0].token_version || 0, banned: !!rows[0].is_banned, exp: now + SESSION_TTL_MS }
    : { exists: false, tv: 0, banned: false, exp: now + SESSION_TTL_MS };
  sessionCache.set(id, state);
  if (sessionCache.size > 5000) {
    for (const [k, v] of sessionCache) if (v.exp <= now) sessionCache.delete(k);
  }
  return state;
}

async function tokenIsLive(payload) {
  if (!payload || !payload.id) return false;
  const s = await sessionState(payload.id);
  return s.exists && !s.banned && (payload.tv || 0) === s.tv;
}

const REVOKED = { error: 'Your session has ended. Please sign in again.', code: 'SESSION_REVOKED' };

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  jwt.verify(token, process.env.JWT_SECRET, async (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    try {
      if (!(await tokenIsLive(user))) return res.status(401).json(REVOKED);
    } catch (e) {
      console.error('Session check failed:', e.message);
      return res.status(500).json({ error: 'Could not check your session' });
    }
    req.user = user;
    next();
  });
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next();
  jwt.verify(token, process.env.JWT_SECRET, async (err, user) => {
    if (err) return next();
    try { if (await tokenIsLive(user)) req.user = user; } catch (e) { /* treat as anonymous */ }
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

module.exports = { authenticateToken, optionalAuth, requireAdmin, requireVerifiedEmail, invalidateSessionCache };
