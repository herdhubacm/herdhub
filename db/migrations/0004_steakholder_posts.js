/**
 * 0004_steakholder_posts — rotation log for the admin "Steakholder spotlight"
 * action (2026-11-04). When the brand last posted a thank-you for a Prime
 * (filet) placement. Separate from social_posted_at, which is the listing post.
 */
module.exports = {
  async up(query) {
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS steakholder_posted_at TIMESTAMPTZ`);
    console.log('✅  0004: listings.steakholder_posted_at ready');
  },
};
