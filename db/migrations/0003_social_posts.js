/**
 * 0003_social_posts — rotation log for the admin "Post this listing" action
 * (2026-11-04). When the brand last posted a listing to its own socials.
 */
module.exports = {
  async up(query) {
    await query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS social_posted_at TIMESTAMPTZ`);
    console.log('✅  0003: listings.social_posted_at ready');
  },
};
