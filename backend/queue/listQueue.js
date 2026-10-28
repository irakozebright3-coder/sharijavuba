import { pool, usingDemoDatabase } from '../db/index.js';
import { SLOW_MINUTES } from './constants.js';

/**
 * Views for the station app. Everything here but setStationBatteries is
 * read-only, and none of it needs a transaction: each call is a single
 * statement and the queue is re-read every few seconds anyway.
 */

/**
 * The live queue for one station + battery type, in call order.
 *
 * Ordering by position is only meaningful because the query is already
 * filtered to a single station and battery type; positions come from one
 * sequence shared by every queue and interleave between them.
 */
export async function listQueue(stationId, batteryType) {
  // pg-mem powers the zero-setup local demo, but it does not implement SQL
  // window functions. Compute this one derived display field in JavaScript
  // there; PostgreSQL keeps the single-query version below in production.
  if (usingDemoDatabase) {
    const { rows } = await pool.query(
      `SELECT claim_id, plate_number, status, position, slip_count,
              created_at, called_at, first_called_at, arrived_at
       FROM claims
       WHERE station_id = $1
         AND battery_type = $2
         AND status IN ('waiting', 'called', 'arrived')
       ORDER BY position ASC`,
      [stationId, batteryType]
    );
    let placeInLine = 0;
    return rows.map((claim) => ({
      ...claim,
      place_in_line: ['waiting', 'called'].includes(claim.status)
        ? ++placeInLine
        : null,
    }));
  }

  const { rows } = await pool.query(
    `SELECT claim_id, plate_number, status, position, slip_count,
            created_at, called_at, first_called_at, arrived_at,
            -- 1, 2, 3... over the claims still in line, in position order.
            -- Cast to int because row_number() is a bigint, which the driver
            -- would otherwise hand back as a string.
            (CASE WHEN status IN ('waiting', 'called')
                  THEN row_number() OVER (
                         PARTITION BY status IN ('waiting', 'called')
                         ORDER BY position ASC)
             END)::int AS place_in_line
     FROM claims
     WHERE station_id = $1
       AND battery_type = $2
       AND status IN ('waiting', 'called', 'arrived')
     ORDER BY position ASC`,
    [stationId, batteryType]
  );
  return rows;
}

/**
 * One claim by id, with its place in line when it is still queueing.
 *
 * place_in_line is counted the same way as in listQueue: over the claims
 * ahead of it in the same station + battery type that are still 'waiting'
 * or 'called'. It is null for any claim that has left the line, because a
 * served or no_show claim does not have one.
 */
export async function getClaim(claimId) {
  const { rows } = await pool.query(
    `SELECT c.*,
            (CASE WHEN c.status IN ('waiting', 'called') THEN (
               SELECT count(*) + 1 FROM claims ahead
               WHERE ahead.station_id = c.station_id
                 AND ahead.battery_type = c.battery_type
                 AND ahead.status IN ('waiting', 'called')
                 AND ahead.position < c.position
             ) END)::int AS place_in_line
     FROM claims c
     WHERE c.claim_id = $1`,
    [claimId]
  );
  return rows[0] ?? null;
}

/**
 * Recently concluded claims for the same queue, newest first.
 *
 * Without this a no_show would simply vanish from the list, giving the
 * attendant no sign the sweep did anything. There is no no_show_at column,
 * so the concluding time is approximated from whichever timestamp the
 * claim last set.
 */
export async function listRecentlyConcluded(stationId, batteryType) {
  const { rows } = await pool.query(
    `SELECT claim_id, plate_number, status, position, slip_count,
            COALESCE(served_at, released_at, called_at, created_at) AS concluded_at
     FROM claims
     WHERE station_id = $1
       AND battery_type = $2
       AND status IN ('served', 'no_show', 'released')
       AND COALESCE(served_at, released_at, called_at, created_at)
             > now() - interval '15 minutes'
     ORDER BY concluded_at DESC
     LIMIT 5`,
    [stationId, batteryType]
  );
  return rows;
}

/**
 * How long every queue is right now: one row per station per battery type,
 * counting the claims still waiting or called.
 *
 * Driven from stations rather than from claims so that a station with an
 * empty queue still appears, with a count of zero. Grouping over claims
 * alone would drop exactly the stations worth sending a rider to. The
 * battery types come from the ones in use, with 'standard' always present
 * so a fresh database still returns something.
 */
export async function stationsSummary() {
  // pg-mem deliberately supports only a subset of PostgreSQL joins. Keep the
  // production query below (it is the efficient single query on Postgres),
  // while composing the same response for the local disposable demo store.
  if (usingDemoDatabase) {
    const [stationsResult, typesResult, claimsResult] = await Promise.all([
      pool.query('SELECT id, name, batteries_available FROM stations ORDER BY name ASC'),
      pool.query("SELECT DISTINCT battery_type FROM claims UNION SELECT 'standard' AS battery_type"),
      pool.query("SELECT station_id, battery_type, count(*)::int AS in_queue FROM claims WHERE status IN ('waiting', 'called') GROUP BY station_id, battery_type"),
    ]);
    const counts = new Map(claimsResult.rows.map((row) => [
      `${row.station_id}:${row.battery_type}`,
      row.in_queue,
    ]));
    return stationsResult.rows.flatMap((station) => typesResult.rows.map((type) => ({
      station_id: station.id,
      name: station.name,
      batteries_available: station.batteries_available,
      battery_type: type.battery_type,
      in_queue: counts.get(`${station.id}:${type.battery_type}`) ?? 0,
    })));
  }

  const { rows } = await pool.query(
    `WITH types AS (
       SELECT DISTINCT battery_type FROM claims
       UNION
       SELECT 'standard'
     )
     SELECT s.id AS station_id,
            s.name,
            s.batteries_available,
            t.battery_type,
            count(c.claim_id)::int AS in_queue
     FROM stations s
     CROSS JOIN types t
     LEFT JOIN claims c
       ON c.station_id = s.id
      AND c.battery_type = t.battery_type
      AND c.status IN ('waiting', 'called')
     GROUP BY s.id, s.name, s.batteries_available, t.battery_type
     ORDER BY s.name ASC, t.battery_type ASC`
  );
  return rows;
}

/** Every station, for the app's picker. There is no other way to get one. */
export async function listStations() {
  const { rows } = await pool.query(
    'SELECT id, name, batteries_available FROM stations ORDER BY name ASC'
  );
  return rows;
}

/**
 * One station's battery count, for the queue response.
 *
 * Kept as its own tiny query rather than joined onto listQueue: the queue
 * rows are per claim and this is per station, so a join would repeat the
 * same number on every row and return nothing at all for an empty queue,
 * which is exactly when the attendant still needs to see the count.
 */
export async function getStationBatteries(stationId) {
  const { rows } = await pool.query(
    'SELECT batteries_available FROM stations WHERE id = $1',
    [stationId]
  );
  return rows[0] ? rows[0].batteries_available : null;
}

/**
 * Riders who were called but have not arrived within SLOW_MINUTES.
 *
 * These are still 'called' and still hold their slot, so they are already
 * in listQueue's result; this is the same set narrowed to the ones the
 * attendant should chase. Nothing here expires anything — that is the
 * sweep's job at GRACE_MINUTES, which is deliberately later.
 *
 * batteryType is optional: pass null for every queue at the station.
 * minutes_since_called is floored, so a rider called 3 minutes 50 seconds
 * ago reads as 3, never as 4.
 */
export async function listSlowClaims(stationId, batteryType = null) {
  if (usingDemoDatabase) {
    const query = batteryType
      ? `SELECT claim_id, plate_number, battery_type, position, slip_count, called_at
         FROM claims
         WHERE station_id = $1 AND battery_type = $2 AND status = 'called'
         ORDER BY called_at ASC`
      : `SELECT claim_id, plate_number, battery_type, position, slip_count, called_at
         FROM claims
         WHERE station_id = $1 AND status = 'called'
         ORDER BY called_at ASC`;
    const params = batteryType ? [stationId, batteryType] : [stationId];
    const { rows } = await pool.query(query, params);
    const now = Date.now();
    return rows
      .map((claim) => ({
        ...claim,
        minutes_since_called: Math.floor((now - new Date(claim.called_at).getTime()) / 60_000),
      }))
      .filter((claim) => claim.minutes_since_called >= SLOW_MINUTES);
  }

  const { rows } = await pool.query(
    `SELECT claim_id, plate_number, battery_type, position, slip_count,
            called_at,
            floor(extract(epoch FROM (now() - called_at)) / 60)::int
              AS minutes_since_called
     FROM claims
     WHERE station_id = $1
       AND status = 'called'
       AND called_at <= now() - ($2::numeric * interval '1 minute')
       AND ($3::text IS NULL OR battery_type = $3)
     ORDER BY called_at ASC`,
    [stationId, SLOW_MINUTES, batteryType]
  );
  return rows;
}

/**
 * Set a station's battery count (PATCH /stations/:stationId).
 *
 * This is the one write in this file. The number is whatever the attendant
 * says it is: nothing in the queue reads it to make a decision, and no
 * queue operation changes it, because the rack is stocked and drained by
 * people the backend never sees. Returns null when no such station exists,
 * so the caller can answer 404 rather than a silent success.
 */
export async function setStationBatteries(stationId, batteriesAvailable) {
  const { rows } = await pool.query(
    `UPDATE stations
     SET batteries_available = $2
     WHERE id = $1
     RETURNING id, name, batteries_available`,
    [stationId, batteriesAvailable]
  );
  return rows[0] ?? null;
}

/**
 * Battery types actually in use, for the app's picker. battery_type is free
 * text on claims with no reference table, so the only honest source is the
 * set of values already recorded.
 */
export async function listBatteryTypes() {
  const { rows } = await pool.query(
    'SELECT DISTINCT battery_type FROM claims ORDER BY battery_type ASC'
  );
  return rows.map((r) => r.battery_type);
}
