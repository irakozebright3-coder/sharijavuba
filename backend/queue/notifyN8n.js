import { pool } from '../db/index.js';

/**
 * Fire-and-forget notification of a queue event to n8n.
 *
 * Never awaited by a caller and never throws. The NEXT button must not wait
 * on an outbound webhook, and n8n being slow, down, or misconfigured must
 * not turn a successful call into a failed request. Everything here is
 * wrapped: a failure is logged and forgotten.
 *
 * Call it AFTER the transaction commits. It reads the claim back itself, so
 * the row has to be visible, and doing the read here rather than in the
 * caller keeps the extra query off the request path too.
 */
const TIMEOUT_MS = 5000;

export function notifyN8n(eventType, claimId) {
  // No webhook configured is the normal case for a local checkout.
  if (!process.env.N8N_WEBHOOK_URL) return;

  // Deliberately not returned: callers must not be able to await this.
  send(eventType, claimId).catch((err) => {
    console.error(`n8n: ${eventType} for ${claimId} failed:`, err.message);
  });
}

async function send(eventType, claimId) {
  const { rows } = await pool.query(
    `SELECT c.claim_id,
            c.plate_number,
            s.name AS station_name,
            (CASE WHEN c.status IN ('waiting', 'called') THEN (
               SELECT count(*) + 1 FROM claims ahead
               WHERE ahead.station_id = c.station_id
                 AND ahead.battery_type = c.battery_type
                 AND ahead.status IN ('waiting', 'called')
                 AND ahead.position < c.position
             ) END)::int AS place_in_line
     FROM claims c
     JOIN stations s ON s.id = c.station_id
     WHERE c.claim_id = $1`,
    [claimId]
  );

  const claim = rows[0];
  if (!claim) {
    console.error(`n8n: ${eventType} for ${claimId} skipped, claim not found`);
    return;
  }

  const payload = {
    event_type: eventType,
    claim_id: claim.claim_id,
    plate_number: claim.plate_number,
    station_name: claim.station_name,
    place_in_line: claim.place_in_line,
    timestamp: new Date().toISOString(),
  };

  const res = await fetch(process.env.N8N_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    // A hung webhook must not hold a socket open indefinitely.
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    console.error(`n8n: ${eventType} for ${claimId} returned HTTP ${res.status}`);
    return;
  }
  console.log(`n8n: sent ${eventType} for ${claim.plate_number} at ${claim.station_name}`);
}
