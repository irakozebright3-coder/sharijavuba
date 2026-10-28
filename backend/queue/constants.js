// Placeholders from planning, not confirmed with riders or attendants.
// See build brief section 8 before submission.
export const GRACE_MINUTES = 10;
export const SLIP_PLACES = 5;
export const TAIL_MINUTES = 30;

// How long a called rider can go without arriving before the station app
// flags them. Only ever read: nothing expires at this threshold, it is the
// attendant's early warning well before GRACE_MINUTES slips the claim back.
// Keep it below GRACE_MINUTES or the flag fires after the sweep has already
// acted and the row is gone.
export const SLOW_MINUTES = 3;
