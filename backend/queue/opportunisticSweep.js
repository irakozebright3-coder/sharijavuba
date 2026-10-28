import { sweepExpiredClaims } from './sweepExpiredClaims.js';
import { usingDemoDatabase } from '../db/index.js';

/**
 * The slip/no-show ladder, driven by traffic instead of a timer.
 *
 * A serverless function has no clock between requests: anything left in a
 * setInterval is frozen the moment the response goes out. Two claims sat
 * on 'called' past the grace window would stay there until somebody
 * happened to load the station app, which is exactly when it is too late
 * to matter. So the sweep rides along with the poll the station app
 * already sends every three seconds, throttled to one pass a minute per
 * instance.
 *
 * Running it on several warm instances at once is expected and safe: every
 * decision is re-checked under a row lock, so the second pass sees the row
 * has already been swept and skips it.
 */
const SWEEP_INTERVAL_MS = 60_000;

let lastStartedAt = 0;
let inFlight = null;

export async function maybeSweep() {
  // The in-memory demo database has nothing to expire and does not speak
  // the interval arithmetic the sweep uses. Skipping it keeps demo logs
  // clean instead of failing once a minute by design.
  if (usingDemoDatabase) return null;

  // A pass already running on this instance: wait for it rather than
  // stacking a second one behind it.
  if (inFlight) return inFlight;

  const now = Date.now();
  if (now - lastStartedAt < SWEEP_INTERVAL_MS) return null;
  lastStartedAt = now;

  inFlight = run();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function run() {
  try {
    const summary = await sweepExpiredClaims();
    const acted = summary.slipped + summary.noShowed + summary.failed;
    // Quiet by default: this runs on someone's queue request, and a line
    // per poll would bury the logs. Only passes that changed something
    // are worth a line.
    if (acted > 0) {
      console.log(
        `sweep: ${summary.slipped} slipped, ${summary.noShowed} no-showed, ` +
          `${summary.skipped} skipped, ${summary.failed} failed`
      );
    }
    return summary;
  } catch (err) {
    // A failed sweep must never fail the request that triggered it: the
    // rider or attendant asked for a queue, not for a cron run.
    console.error('sweep failed:', err);
    return null;
  }
}
