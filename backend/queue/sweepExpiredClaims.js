import { randomUUID } from 'crypto';
import { pool } from '../db/index.js';
import { GRACE_MINUTES, SLIP_PLACES, TAIL_MINUTES } from './constants.js';
import { notifyN8n } from './notifyN8n.js';

/**
 * Expire claims that were called but never arrived (the slip/no-show ladder).
 *
 * A called claim that goes quiet past the grace window gets one second
 * chance: it slips back SLIP_PLACES places and returns to 'waiting'. A
 * claim that has already used that chance, or whose tail deadline has
 * passed, is closed out as a no_show.
 *
 * Each claim is processed in its own transaction so one bad row cannot
 * block the rest of the sweep, and the scan below is only a candidate
 * list: every decision is re-checked under a row lock, because a rider
 * may arrive or release in the gap between the scan and the write.
 */
export async function sweepExpiredClaims() {
  const { rows: candidates } = await pool.query(
    `SELECT claim_id FROM claims
     WHERE status = 'called'
       AND called_at <= now() - ($1::numeric * interval '1 minute')
     ORDER BY called_at ASC`,
    [GRACE_MINUTES]
  );

  const summary = { slipped: 0, noShowed: 0, skipped: 0, failed: 0 };

  for (const { claim_id: claimId } of candidates) {
    try {
      const outcome = await sweepOneClaim(claimId);
      if (outcome === 'slipped') summary.slipped++;
      else if (outcome === 'no_show') summary.noShowed++;
      else summary.skipped++;
    } catch (err) {
      // One unsweepable claim must not strand the ones behind it.
      summary.failed++;
      console.error(`sweep: claim ${claimId} failed:`, err);
    }
  }

  return summary;
}

async function sweepOneClaim(claimId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Re-read under a row lock. The claim may have arrived, been released,
    // or been swept by an overlapping run since the scan. within_tail is
    // computed here so the database clock stays the only clock involved.
    const { rows } = await client.query(
      `SELECT *,
              (first_called_at IS NOT NULL
               AND now() - first_called_at < ($3::numeric * interval '1 minute')) AS within_tail
       FROM claims
       WHERE claim_id = $1
         AND status = 'called'
         AND called_at <= now() - ($2::numeric * interval '1 minute')
       FOR UPDATE`,
      [claimId, GRACE_MINUTES, TAIL_MINUTES]
    );

    const claim = rows[0];
    if (!claim) {
      await client.query('ROLLBACK');
      return 'skipped';
    }

    // first_called_at is stamped by callNext, so within_tail is only false
    // for a genuinely expired tail. A row that somehow carries a NULL falls
    // through to no_show rather than slipping forever, which is the safe
    // way for this to be wrong.
    const outcome = claim.slip_count === 0 && claim.within_tail
      ? await slipBack(client, claim)
      : await markNoShow(client, claim);

    await client.query('COMMIT');

    // After the commit so n8n reads the settled row, and not awaited so a
    // slow webhook cannot stall the rest of the sweep.
    if (outcome === 'slipped') notifyN8n('slipped_back', claim.claim_id);
    else if (outcome === 'no_show') notifyN8n('no_show', claim.claim_id);

    return outcome;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Push the claim back SLIP_PLACES places rather than to the very end: it
 * lands directly behind the SLIP_PLACES-th claim currently waiting in the
 * same station + battery type. With fewer than that many waiting it lands
 * at the back, which is the same thing.
 */
async function slipBack(client, claim) {
  const anchor = await slipAnchorPosition(client, claim);

  if (anchor !== null) {
    // position is a plain bigint, so there is no value to slot "between"
    // two adjacent claims. Open a gap by pushing everyone behind the
    // anchor back one place, then take the slot that frees up.
    await client.query(
      `UPDATE claims SET position = position + 1
       WHERE station_id = $1
         AND battery_type = $2
         AND status = 'waiting'
         AND position > $3::bigint`,
      [claim.station_id, claim.battery_type, anchor]
    );
  }

  const { rows } = await client.query(
    `UPDATE claims
     SET status = 'waiting',
         slip_count = 1,
         called_at = NULL,
         position = COALESCE($2::bigint + 1, position)
     WHERE claim_id = $1
     RETURNING *`,
    [claim.claim_id, anchor]
  );

  await client.query(
    `INSERT INTO events (event_id, event_type, rider_id, station_id, battery_type, payload)
     VALUES ($1, 'claim_released', $2, $3, $4, $5)`,
    [randomUUID(), claim.rider_id, claim.station_id, claim.battery_type,
     JSON.stringify({ claim_id: claim.claim_id, reason: 'slipped_back', slip_count: 1 })]
  );

  return rows[0] ? 'slipped' : 'skipped';
}

/**
 * Position of the SLIP_PLACES-th claim currently waiting in this queue, or
 * the last one if the queue is shorter than that, or null if nobody is
 * waiting at all (in which case the slipped claim keeps its position, as
 * there is nobody to land behind). Returned as a string: node-pg hands
 * back bigint as text, so the arithmetic is left to the database.
 */
async function slipAnchorPosition(client, claim) {
  const { rows } = await client.query(
    `SELECT position FROM (
       SELECT position, row_number() OVER (ORDER BY position ASC) AS rn
       FROM claims
       WHERE station_id = $1
         AND battery_type = $2
         AND status = 'waiting'
     ) ranked
     WHERE rn = $3`,
    [claim.station_id, claim.battery_type, SLIP_PLACES]
  );
  if (rows[0]) return rows[0].position;

  const { rows: last } = await client.query(
    `SELECT max(position) AS position FROM claims
     WHERE station_id = $1
       AND battery_type = $2
       AND status = 'waiting'`,
    [claim.station_id, claim.battery_type]
  );
  return last[0].position ?? null;
}

async function markNoShow(client, claim) {
  const { rows } = await client.query(
    `UPDATE claims
     SET status = 'no_show'
     WHERE claim_id = $1
     RETURNING *`,
    [claim.claim_id]
  );

  await client.query(
    `INSERT INTO events (event_id, event_type, rider_id, station_id, battery_type, payload)
     VALUES ($1, 'no_show', $2, $3, $4, $5)`,
    [randomUUID(), claim.rider_id, claim.station_id, claim.battery_type,
     JSON.stringify({ claim_id: claim.claim_id, slip_count: claim.slip_count })]
  );

  return rows[0] ? 'no_show' : 'skipped';
}
