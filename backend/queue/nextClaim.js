import { randomUUID } from 'crypto';
import { pool, usingDemoDatabase } from '../db/index.js';
import { notifyN8n } from './notifyN8n.js';

/**
 * Advance the queue for one station + battery type (the NEXT button).
 *
 * This is the operation invariant 3 protects: two attendants pressing NEXT
 * at the same instant must never be handed the same rider.
 *
 * Being a single statement is not enough on its own. Under READ COMMITTED,
 * a second caller that blocks on the first caller's row lock re-checks the
 * WHERE clause once that lock is released, and a clause of the form
 * `claim_id = (subquery)` is still true for the row that was just called,
 * so the second caller would call it a second time. Two guards close that:
 *
 * - FOR UPDATE SKIP LOCKED in the inner SELECT: a concurrent caller does
 *   not queue up behind the locked row at all, it steps over it and takes
 *   the next waiting claim. That is what makes two simultaneous presses
 *   return two different riders instead of one rider twice.
 * - AND status = 'waiting' on the outer UPDATE: the backstop. If a caller
 *   does end up re-checking a row that has since been called, the status
 *   no longer matches, nothing is updated, and the call returns null
 *   rather than double-calling.
 */
export async function callNext(stationId, batteryType) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let rows;
    if (usingDemoDatabase) {
      // pg-mem does not implement FOR UPDATE SKIP LOCKED. The local demo is
      // single-process and disposable, so select-then-status-guarded-update
      // is sufficient here; production keeps the locking statement below.
      const candidate = await client.query(
        `SELECT claim_id FROM claims
         WHERE station_id = $1
           AND battery_type = $2
           AND status = 'waiting'
         ORDER BY position ASC
         LIMIT 1`,
        [stationId, batteryType]
      );
      if (!candidate.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      ({ rows } = await client.query(
        `UPDATE claims
         SET status = 'called', called_at = now(),
             first_called_at = COALESCE(first_called_at, now())
         WHERE claim_id = $1 AND status = 'waiting'
         RETURNING *`,
        [candidate.rows[0].claim_id]
      ));
    } else {
      ({ rows } = await client.query(
        `UPDATE claims
       SET status = 'called', called_at = now(),
           first_called_at = COALESCE(first_called_at, now())
       WHERE claim_id = (
         SELECT claim_id FROM claims
         WHERE station_id = $1
           AND battery_type = $2
           AND status = 'waiting'
         ORDER BY position ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
         AND status = 'waiting'
       RETURNING *`,
        [stationId, batteryType]
      ));
    }

    const claim = rows[0];
    if (!claim) {
      await client.query('ROLLBACK');
      return null; // nothing eligible waiting right now
    }

    await client.query(
      `INSERT INTO events (event_id, event_type, rider_id, station_id, battery_type, payload)
       VALUES ($1, 'called', $2, $3, $4, $5)`,
      [randomUUID(), claim.rider_id, stationId, batteryType, JSON.stringify({ claim_id: claim.claim_id })]
    );

    await client.query('COMMIT');

    // Deliberately not awaited: an attendant pressing NEXT must never wait
    // on an outbound webhook, and an n8n outage must never fail the call.
    notifyN8n('called', claim.claim_id);

    return claim;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
