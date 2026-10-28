import { randomUUID } from 'crypto';
import { pool } from '../db/index.js';

/**
 * Normalize a plate to its canonical form: uppercase, no whitespace. The
 * live-claim rule is enforced by a unique index on the stored value, so
 * "rac 123b" and "RAC123B" have to collapse to one string before insert or
 * the same bike could hold two slots.
 */
export function normalizePlate(plateNumber) {
  return String(plateNumber).replace(/\s+/g, '').toUpperCase();
}

/**
 * Reserve a queue slot for a rider (claim_made).
 *
 * plateNumber is required and identifies the bike, which is what the queue
 * slot actually belongs to: invariant 1 allows one live claim per plate,
 * not per rider.
 *
 * eventId should be generated client-side (a UUID) before the request is
 * sent, so a retried request after a dropped connection is recognized as
 * already-applied instead of creating a second claim.
 */
export async function reserveClaim(riderId, stationId, batteryType, plateNumber, eventId = randomUUID()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT 1 FROM events WHERE event_id = $1', [eventId]);
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return { alreadyProcessed: true };
    }

    // The rider app mints its own rider id on first visit and keeps it in
    // localStorage, so the first reservation from a new phone arrives with
    // an id that has no row behind it and the claims foreign key rejects
    // the insert. Create the row here, in the same transaction, so a failed
    // reservation cannot leave a stray rider behind. Repeat visits hit the
    // conflict and do nothing.
    await client.query(
      'INSERT INTO riders (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [riderId]
    );

    let claim;
    try {
      const { rows } = await client.query(
        `INSERT INTO claims (rider_id, station_id, battery_type, plate_number, status)
         VALUES ($1, $2, $3, $4, 'waiting')
         RETURNING *`,
        [riderId, stationId, batteryType, normalizePlate(plateNumber)]
      );
      claim = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        // unique_violation on one_live_claim_per_plate
        await client.query('ROLLBACK');
        return { error: 'plate_already_has_a_live_claim' };
      }
      throw err;
    }

    try {
      await client.query(
        `INSERT INTO events (event_id, event_type, rider_id, station_id, battery_type, payload)
         VALUES ($1, 'claim_made', $2, $3, $4, $5)`,
        // plate_number is recorded here, in its normalized form, because it
        // lives nowhere else in the log: without it the claims table could
        // not be rebuilt from events and invariant 1 would be unenforceable
        // after a replay.
        [eventId, riderId, stationId, batteryType,
         JSON.stringify({ claim_id: claim.claim_id, plate_number: claim.plate_number })]
      );
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'events_pkey') {
        // A concurrent request carrying the same event_id cleared the
        // SELECT above at the same instant and won the insert. Its work
        // stands; ours rolls back, claim row included.
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
