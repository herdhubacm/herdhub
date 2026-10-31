/**
 * 0002_batch4 — Sweep Batch 4 (2026-10-31)
 *   H9  indexes on the hot queries the sweep found unindexed
 *   H15 ON DELETE SET NULL on the six foreign keys to users(id) that had no
 *       ON DELETE rule and could block an account deletion
 */

// (table, column) pairs whose FK to users(id) gets ON DELETE SET NULL
const SET_NULL_FKS = [
  ['beef_box_claims',       'user_id'],
  ['sale_lots',             'current_bidder_id'],
  ['sale_lots',             'winner_user_id'],
  ['sale_bids',             'user_id'],
  ['verification_requests', 'reviewed_by'],
  ['audit_log',             'user_id'],
];

module.exports = {
  SET_NULL_FKS,
  async up(query) {
    // ── H9: indexes ───────────────────────────────────────
    await query(`CREATE INDEX IF NOT EXISTS idx_sale_lots_sale        ON sale_lots(sale_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sale_lots_status_end  ON sale_lots(status, end_date)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sale_bids_lot         ON sale_bids(lot_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sale_bids_user        ON sale_bids(user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_messages_listing      ON messages(listing_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_listings_expires      ON listings(expires_at) WHERE expires_at IS NOT NULL`);
    await query(`CREATE INDEX IF NOT EXISTS idx_market_prices_region  ON market_prices(region)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_forum_topics_category ON forum_topics(category)`);

    // ── H15: foreign keys ─────────────────────────────────
    // Whatever the existing constraint is called, drop every FK on that
    // column and add one with ON DELETE SET NULL under a predictable name.
    for (const [table, column] of SET_NULL_FKS) {
      const { rows } = await query(
        `SELECT con.conname
           FROM pg_constraint con
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
          WHERE con.contype = 'f' AND con.conrelid = $1::regclass AND a.attname = $2`,
        [table, column]
      );
      for (const r of rows) await query(`ALTER TABLE ${table} DROP CONSTRAINT "${r.conname}"`);
      await query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_${column}_fkey FOREIGN KEY (${column}) REFERENCES users(id) ON DELETE SET NULL`);
    }
    console.log('✅  Batch 4: indexes and ON DELETE rules applied');
  },
};
