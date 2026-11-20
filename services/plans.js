/**
 * Listing plans: one place for what each plan gets and how long it runs.
 *
 * Launch mode (Stormy, 2026-11-20): until Stripe is live every plan is free,
 * but each one works exactly as if paid (placement, photo limit, run length).
 * Paid plans posted during launch are "launch trials":
 *   - Sirloin and Ribeye: one running at a time per seller, 30 days free,
 *     then the listing drops to a regular free listing (it stays up).
 *   - Choice (t_bone) and Prime (filet): held for admin approval before they
 *     go live; the 30-day free run starts at approval.
 * Flip PAID_PLANS_LIVE when Stripe checkout is wired into the post flow.
 */
const PAID_PLANS_LIVE = false;

const PAID_TIERS       = ['sirloin', 'ribeye', 't_bone', 'filet'];
const SELLER_FEATURED  = ['sirloin', 'ribeye'];   // one launch trial per seller at a time
const NEEDS_APPROVAL   = ['t_bone', 'filet'];     // admin approves before live during launch
const LAUNCH_RUN_DAYS  = 30;
const REGULAR_RUN_DAYS = 30;                       // a free (burger) listing, and a renewal

// Run length when the plan is actually paid for (matches the plan cards).
const PAID_RUN_DAYS = { burger: 30, farm_to_table: 90, sirloin: 365, ribeye: 30, t_bone: 30, filet: 365 };

function isLaunchTrial(tier) {
  return !PAID_PLANS_LIVE && PAID_TIERS.includes(tier);
}

function runDays(tier) {
  if (isLaunchTrial(tier)) return LAUNCH_RUN_DAYS;
  return PAID_RUN_DAYS[tier] || REGULAR_RUN_DAYS;
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 86400000);
}

module.exports = {
  PAID_PLANS_LIVE, PAID_TIERS, SELLER_FEATURED, NEEDS_APPROVAL,
  LAUNCH_RUN_DAYS, REGULAR_RUN_DAYS, PAID_RUN_DAYS,
  isLaunchTrial, runDays, daysFromNow,
};
