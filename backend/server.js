import app from './app.js';
import { sweepExpiredClaims } from './queue/sweepExpiredClaims.js';
import { usingDemoDatabase } from './db/index.js';

/**
 * Long-lived host entry point: Render, a container, or a laptop.
 *
 * Vercel does not use this file. There the same Express app is exported
 * from `api/[...path].js` and runs as a serverless function, with the
 * sweep moved onto incoming requests because a function has no timer
 * between them.
 */
if (process.env.DEMO_DATABASE !== 'true' && !process.env.DATABASE_URL) {
  console.warn(
    'DATABASE_URL is not set: using the in-memory demo database. Data is not ' +
      'persisted and is not shared between instances.'
  );
}

// The slip/no-show ladder runs on a timer rather than a job scheduler: one
// pass a minute over the claims sitting on 'called' is well within what a
// setInterval can carry at this scale, and a missed tick costs nothing
// because the next pass picks the same claims up.
const SWEEP_INTERVAL_MS = 60_000;

if (!usingDemoDatabase) setInterval(async () => {
  try {
    const { slipped, noShowed, skipped, failed } = await sweepExpiredClaims();
    console.log(
      `sweep: ${slipped} slipped, ${noShowed} no-showed, ${skipped} skipped, ${failed} failed`
    );
  } catch (err) {
    // A bad sweep must never take the server down. Log it and wait for the
    // next tick; the claims it did not reach are still eligible then.
    console.error('sweep failed:', err);
  }
}, SWEEP_INTERVAL_MS);

// PORT is assigned by the host (Render sets it); 3000 is only the local
// default. The bind address is spelled out because a server listening on
// localhost is unreachable from outside its own container, so a hosted
// deploy would look healthy and answer nothing.
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () =>
  console.log(`SharijaVuba backend listening on 0.0.0.0:${port}`)
);
