/**
 * HERD HUB — Account data export and deletion (C2)
 * Shared by the account page (a producer acting on their own account) and
 * the admin panel. Policy (who may delete whom) stays in the routes.
 */
const { query, pool } = require('../db/database');
const { deleteFile } = require('./storage');

// Never leaves the building, even in the owner's own export
const STRIP = new Set(['password_hash', 'email_verify_token_hash', 'email_verify_sent_at', 'token_version']);

/**
 * Everything we hold on one account, as plain JSON. Each section is
 * fetched on its own so one missing table can't sink the whole file;
 * anything skipped is named in `warnings`.
 */
async function collectUserData(userId) {
  const { rows: u } = await query('SELECT * FROM users WHERE id = $1', [userId]);
  if (!u.length) return null;
  const out = {
    exported_at: new Date().toISOString(),
    account: Object.fromEntries(Object.entries(u[0]).filter(([k]) => !STRIP.has(k))),
    warnings: [],
  };
  const grab = async (key, sql) => {
    try { out[key] = (await query(sql, [userId])).rows; }
    catch (e) { out[key] = []; out.warnings.push(`${key}: ${String(e.message).split('\n')[0]}`); }
  };
  await grab('listings',             'SELECT * FROM listings WHERE user_id = $1 ORDER BY created_at');
  await grab('listing_photos',       'SELECT lp.* FROM listing_photos lp JOIN listings l ON l.id = lp.listing_id WHERE l.user_id = $1 ORDER BY lp.listing_id, lp.sort_order');
  await grab('saved_listings',       'SELECT * FROM saved_listings WHERE user_id = $1');
  await grab('saved_searches',       'SELECT * FROM saved_searches WHERE user_id = $1');
  await grab('messages_sent',        'SELECT * FROM messages WHERE from_user = $1 ORDER BY created_at');
  await grab('messages_received',    'SELECT * FROM messages WHERE to_user = $1 ORDER BY created_at');
  await grab('reviews_written',      'SELECT * FROM seller_reviews WHERE reviewer_id = $1');
  await grab('reviews_received',     'SELECT * FROM seller_reviews WHERE seller_id = $1');
  await grab('forum_topics',         'SELECT * FROM forum_topics WHERE user_id = $1');
  await grab('forum_replies',        'SELECT * FROM forum_replies WHERE user_id = $1');
  await grab('reports_filed',        'SELECT * FROM listing_reports WHERE reporter_id = $1');
  await grab('ranch_profile',        'SELECT * FROM ranch_profiles WHERE user_id = $1');
  await grab('animals',              'SELECT * FROM animals WHERE user_id = $1');
  await grab('animal_weights',       'SELECT w.* FROM animal_weights w JOIN animals a ON a.id = w.animal_id WHERE a.user_id = $1');
  await grab('animal_health',        'SELECT h.* FROM animal_health h JOIN animals a ON a.id = h.animal_id WHERE a.user_id = $1');
  await grab('animal_production',    'SELECT p.* FROM animal_production p JOIN animals a ON a.id = p.animal_id WHERE a.user_id = $1');
  await grab('calving_records',      'SELECT * FROM calving_records WHERE user_id = $1');
  await grab('price_alerts',         'SELECT * FROM price_alerts WHERE user_id = $1');
  await grab('finance_transactions', 'SELECT * FROM finance_transactions WHERE user_id = $1');
  await grab('finance_budgets',      'SELECT * FROM finance_budgets WHERE user_id = $1');
  await grab('genetic_pairings',     'SELECT * FROM genetic_pairings WHERE user_id = $1');
  await grab('sales_events',         'SELECT * FROM sales_events WHERE user_id = $1');
  await grab('sale_lots',            'SELECT l.* FROM sale_lots l JOIN sales_events s ON s.id = l.sale_id WHERE s.user_id = $1');
  await grab('sale_bids',            'SELECT * FROM sale_bids WHERE user_id = $1');
  await grab('sale_registrations',   'SELECT * FROM sale_registrations WHERE user_id = $1');
  await grab('verification_requests','SELECT * FROM verification_requests WHERE user_id = $1');
  await grab('beef_box_claims',      'SELECT * FROM beef_box_claims WHERE user_id = $1');
  return out;
}

/**
 * Permanently removes an account. Deletes the account's listing photos from
 * storage, clears the nullable pointers that have no ON DELETE (beef box
 * claims, auction bidder/winner, bids, verification reviewer, audit rows),
 * drops the login lockout row, then deletes the user; the cascades take the
 * rest. Writes one audit_log row. Returns { ok, ...counts } or { ok:false }.
 */
async function deleteUserAccount(userId, { actorId = null, ip = null, reason = 'admin' } = {}) {
  const id = Number(userId);
  const client = await pool.connect();
  let inTx = false;
  try {
    const { rows } = await client.query('SELECT id, email, name FROM users WHERE id=$1', [id]);
    const user = rows[0];
    if (!user) return { ok: false, status: 404, error: 'User not found' };

    // Listing photos out of storage first (best effort) so nothing orphans in S3
    const { rows: photos } = await client.query(
      `SELECT lp.storage_key, lp.thumb_key
         FROM listing_photos lp JOIN listings l ON l.id = lp.listing_id
        WHERE l.user_id = $1`, [id]);
    await Promise.allSettled(
      photos.flatMap(p => [p.storage_key, p.thumb_key].filter(Boolean).map(k => deleteFile(k)))
    );

    await client.query('BEGIN'); inTx = true;
    const { rows: lc } = await client.query('SELECT COUNT(*)::int AS n FROM listings WHERE user_id=$1', [id]);
    await client.query('DELETE FROM beef_box_claims WHERE user_id=$1', [id]);
    await client.query('UPDATE sale_lots SET current_bidder_id=NULL WHERE current_bidder_id=$1', [id]);
    await client.query('UPDATE sale_lots SET winner_user_id=NULL WHERE winner_user_id=$1', [id]);
    await client.query('DELETE FROM sale_bids WHERE user_id=$1', [id]);
    await client.query('UPDATE verification_requests SET reviewed_by=NULL WHERE reviewed_by=$1', [id]);
    await client.query('UPDATE audit_log SET user_id=NULL WHERE user_id=$1', [id]);
    await client.query('DELETE FROM login_attempts WHERE identifier=$1', [String(user.email).toLowerCase()]);
    await client.query('DELETE FROM users WHERE id=$1', [id]);
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip)
       VALUES ($1, 'user.delete', 'user', $2, $3, $4)`,
      [actorId, id, JSON.stringify({ email: user.email, name: user.name, listings: lc[0].n, photos: photos.length, reason }), ip]
    );
    await client.query('COMMIT'); inTx = false;
    return { ok: true, id, email: user.email, name: user.name, listings: lc[0].n, photos: photos.length };
  } catch (err) {
    if (inTx) { try { await client.query('ROLLBACK'); } catch {} }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { collectUserData, deleteUserAccount };
