import { randomUUID } from 'crypto';
import { pool } from '../db/index.js';

/**
 * Attendant confirms the swap happened (served).
 *
 * This is the operation invariant 2 protects. The UPDATE ... WHERE ...
 * RETURNING is one statement: whichever concurrent call commits first
 * moves the row off 'arrived', and a second call arriving at the same
 * instant finds nothing matching status = 'arrived' and returns an error
 * instead of marking the same claim served twice. No explicit lock, no
 * separate select-then-update round trip.
 */
export async function markServed(claimId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE claims
       SET status = 'served', served_at = now()
       WHERE claim_id = $1
         AND status = 'arrived'
       RETURNING *`,
      [claimId]
    );

    const claim = rows[0];
    if (!claim) {
      // Nothing was updated: either no such claim, or it was not 'arrived'.
      const { rows: found } = await client.query(
        'SELECT status FROM claims WHERE claim_id = $1',
        [claimId]
      );
      await client.query('ROLLBACK');
      if (found.length === 0) return { error: 'claim_not_found' };
      if (found[0].status === 'served') return { error: 'claim_already_served' };
      return { error: 'claim_not_arrived', status: found[0].status };
    }

    await client.query(
      `INSERT INTO events (event_id, event_type, rider_id, station_id, battery_type, payload)
       VALUES ($1, 'served', $2, $3, $4, $5)`,
      [randomUUID(), claim.rider_id, claim.station_id, claim.battery_type, JSON.stringify({ claim_id: claim.claim_id })]
    );

    // A completed swap takes one battery off the rack. This runs in the same
    // transaction as the status change, and only on the path where that
    // change actually happened: the UPDATE above is guarded on
    // status = 'arrived', so two concurrent calls cannot both get here and
    // the count cannot be decremented twice for one claim.
    //
    // GREATEST floors the result at 0. The count is an attendant's estimate
    // that no queue operation raises, so it can legitimately already be 0
    // when a swap completes, and going negative would be a worse lie than
    // standing still.
    const { rows: stationRows } = await client.query(
      `UPDATE stations
       SET batteries_available = GREATEST(batteries_available - 1, 0)
       WHERE id = $1
       RETURNING batteries_available`,
      [claim.station_id]
    );
    const batteriesAvailable = stationRows[0] ? stationRows[0].batteries_available : null;

    // Recorded as its own event rather than folded into the served payload:
    // the count is station state, not claim state, and the log is meant to
    // be replayable into the tables it describes.
    await client.query(
      `INSERT INTO events (event_id, event_type, rider_id, station_id, battery_type, payload)
       VALUES ($1, 'battery_count_changed', $2, $3, $4, $5)`,
      [randomUUID(), claim.rider_id, claim.station_id, claim.battery_type,
       JSON.stringify({
         claim_id: claim.claim_id,
         batteries_available: batteriesAvailable,
         reason: 'served',
       })]
    );

    await client.query('COMMIT');
    return { claim, batteries_available: batteriesAvailable };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
