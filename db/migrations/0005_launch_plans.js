/**
 * 0005_launch_plans — free launch trials of the paid plans (2026-11-20).
 *   launch_promo       this listing's paid plan is a free launch trial
 *   awaiting_approval  Prime/Choice trial held for admin approval (status 'pending')
 *   launch_ended_at    when the free featured run ended and it became a regular listing
 *   deleted_at         seller or admin deleted it (until now delete only set 'expired',
 *                      so deleted listings showed in My Listings as expired)
 * Backfill: paid-plan listings that never paid (payment_status 'pending', because
 * Stripe was never wired into posting) are free. Sirloin/Ribeye ones become
 * launch trials, so when they run out they drop to a regular listing instead of
 * vanishing. Prime/Choice ones are left as placed (several were placed by hand).
 */
module.exports = {
  async up(query) {
    await query(`ALTER TABLE listings
      ADD COLUMN IF NOT EXISTS launch_promo      BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS awaiting_approval BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS launch_ended_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ`);
    const a = await query(`UPDATE listings SET launch_promo = TRUE, payment_status = 'free'
      WHERE tier IN ('sirloin','ribeye') AND payment_status = 'pending'`);
    const b = await query(`UPDATE listings SET payment_status = 'free'
      WHERE tier IN ('t_bone','filet') AND payment_status = 'pending'`);
    await query(`CREATE INDEX IF NOT EXISTS idx_listings_awaiting ON listings (awaiting_approval) WHERE awaiting_approval`);
    console.log(`✅  0005: launch plan columns ready (${a.rowCount || 0} Sirloin/Ribeye marked launch trials, ${b.rowCount || 0} Prime/Choice marked free)`);
  },
};
