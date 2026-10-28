import { randomUUID } from 'crypto';
import { pool } from '../db/index.js';

/**
 * Rider taps ARRIVED at the geofence (arrived).
 *
 * eventId should be generated client-side (a UUID) before the request is
 * sent, so a retried request after a dropped connection is recognized as
 * already-applied instead of recording a second arrival.
 *
 * The UPDATE ... WHERE ... RETURNING is one statement, so the status
 * check and the write cannot drift apart under concurrency. A claim that
 * is not currently 'called' simply matches nothing, and we read the row
 * back afterwards only to say why.
 */
export async function markArrived(claimId, eventId = randomUUID()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT 1 FROM events WHERE event_id = $1', [eventId]);
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return { alreadyProcessed: true };
    }

    const { rows } = await client.query(
      `UPDATE claims
       SET status = 'arrived', arrived_at = now()
       WHERE claim_id = $1
         AND status = 'called'
       RETURNING *`,
      [claimId]
    );

    const claim = rows[0];
    if (!claim) {
      // Nothing was updated: either no such claim, or it was not 'called'.
      const { rows: found } = await client.query(
        'SELECT status FROM claims WHERE claim_id = $1',
        [claimId]
      );
      await client.query('ROLLBACK');
      if (found.length === 0) return { error: 'claim_not_found' };
      if (found[0].status === 'arrived') return { error: 'claim_already_arrived' };
      return { error: 'claim_not_called', status: found[0].status };
    }

    try {
      await client.query(
        `INSERT INTO events (event_id, event_type, rider_id, station_id, battery_type, payload)
         VALUES ($1, 'arrived', $2, $3, $4, $5)`,
        [eventId, claim.rider_id, claim.station_id, claim.battery_type, JSON.stringify({ claim_id: claim.claim_id })]
      );
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'events_pkey') {
        // A concurrent request carrying the same event_id cleared the
        // SELECT above at the same instant and won the insert. Its work
        // stands; ours rolls back, status change included.
        await client.query('ROLLBACK');
        return { alreadyProcessed: true };
      }
      throw err;
    }

    await client.query('COMMIT');
    return { claim };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
