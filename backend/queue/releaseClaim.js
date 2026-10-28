import { randomUUID } from 'crypto';
import { pool } from '../db/index.js';

/**
 * Rider gives up their slot voluntarily (claim_released, reason 'manual').
 *
 * The UPDATE ... WHERE ... RETURNING is one statement, so the status check
 * and the write cannot drift apart under concurrency. A claim the sweep is
 * slipping back or marking no_show at the same instant matches nothing
 * here, and we read the row back afterwards only to say why.
 *
 * Releasing moves the claim out of the one_live_claim_per_plate predicate,
 * so that plate is free to reserve again immediately.
 */
export async function releaseClaim(claimId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE claims
       SET status = 'released', released_at = now()
       WHERE claim_id = $1
         AND status IN ('waiting', 'called')
       RETURNING *`,
      [claimId]
    );

    const claim = rows[0];
    if (!claim) {
      // Nothing was updated: either no such claim, or it was not live.
      const { rows: found } = await client.query(
        'SELECT status FROM claims WHERE claim_id = $1',
        [claimId]
      );
      await client.query('ROLLBACK');
      if (found.length === 0) return { error: 'claim_not_found' };
      if (found[0].status === 'released') return { error: 'claim_already_released' };
      return { error: 'claim_not_releasable', status: found[0].status };
    }

    await client.query(
      `INSERT INTO events (event_id, event_type, rider_id, station_id, battery_type, payload)
       VALUES ($1, 'claim_released', $2, $3, $4, $5)`,
      [randomUUID(), claim.rider_id, claim.station_id, claim.battery_type,
       JSON.stringify({ claim_id: claim.claim_id, reason: 'manual' })]
    );

    await client.query('COMMIT');
    return { claim };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
