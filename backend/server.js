import express from 'express';
import 'dotenv/config';
import { reserveClaim } from './queue/reserveClaim.js';
import { callNext } from './queue/nextClaim.js';
import { markArrived } from './queue/arrived.js';
import { markServed } from './queue/served.js';
import { releaseClaim } from './queue/releaseClaim.js';
import { sweepExpiredClaims } from './queue/sweepExpiredClaims.js';
import {
  listQueue,
  listRecentlyConcluded,
  listStations,
  listBatteryTypes,
  listSlowClaims,
  getStationBatteries,
  setStationBatteries,
  getClaim,
  stationsSummary,
} from './queue/listQueue.js';
import { SLOW_MINUTES } from './queue/constants.js';

if (process.env.DEMO_DATABASE !== 'true' && !process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required unless DEMO_DATABASE=true.');
  process.exit(1);
}

const app = express();
app.use(express.json());

// CORS: configure FRONTEND_ORIGINS as a comma-separated list in production.
// If unset, allow all origins for local/demo use only.
const allowedOrigins = (process.env.FRONTEND_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes('*')) {
    res.set('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Health check for the hosting provider. This confirms the process is alive;
// database-dependent routes will still report their own errors if DB is down.
app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, service: 'sharijavuba-backend' });
});

// --- reads, for the station app ---

// Every station, for the app's station picker
app.get('/stations', async (req, res, next) => {
  try {
    res.json(await listStations());
  } catch (err) {
    next(err);
  }
});

// How long every queue is, one row per station per battery type
app.get('/stations/summary', async (req, res, next) => {
  try {
    res.json(await stationsSummary());
  } catch (err) {
    next(err);
  }
});

// Battery types already in use, for the app's battery picker
app.get('/battery-types', async (req, res, next) => {
  try {
    res.json(await listBatteryTypes());
  } catch (err) {
    next(err);
  }
});

// The current queue for one station + battery type, what just left it, and
// the called riders who have not turned up yet. `slow` rides along here
// rather than being a second poll: the station app already asks for this
// every few seconds, and the two lists have to agree with each other or the
// screen contradicts itself.
app.get('/stations/:stationId/queue', async (req, res, next) => {
  try {
    const { stationId } = req.params;
    const { battery_type } = req.query;
    if (!battery_type) return res.status(400).json({ error: 'battery_type is required' });
    const [queue, recent, slow, batteriesAvailable] = await Promise.all([
      listQueue(stationId, battery_type),
      listRecentlyConcluded(stationId, battery_type),
      listSlowClaims(stationId, battery_type),
      getStationBatteries(stationId),
    ]);
    res.json({
      station_id: stationId,
      battery_type,
      queue,
      recent,
      slow,
      slow_threshold_minutes: SLOW_MINUTES,
      // Carried here so the station app sees a serve-time decrement, or
      // another attendant's adjustment, on its ordinary poll. Before this
      // the count was read once at load and went stale silently.
      batteries_available: batteriesAvailable,
    });
  } catch (err) {
    next(err);
  }
});

// Called riders who have not arrived within SLOW_MINUTES. Every battery
// type at the station unless one is named.
app.get('/stations/:stationId/slow', async (req, res, next) => {
  try {
    const { stationId } = req.params;
    const { battery_type } = req.query;
    const slow = await listSlowClaims(stationId, battery_type || null);
    res.json({
      station_id: stationId,
      battery_type: battery_type || null,
      threshold_minutes: SLOW_MINUTES,
      slow,
    });
  } catch (err) {
    next(err);
  }
});

// One claim by id, with its place in line while it is still queueing
app.get('/claims/:claimId', async (req, res, next) => {
  try {
    const { claimId } = req.params;
    const claim = await getClaim(claimId);
    if (!claim) return res.status(404).json({ error: 'claim_not_found' });
    res.json({ claim });
  } catch (err) {
    next(err);
  }
});

// --- writes ---

// Attendant corrects the rack count (PATCH /stations/:stationId).
//
// Absolute, not a delta: the +/- buttons in the station app send the value
// they want, so two attendants adjusting at once end on a number one of
// them chose rather than on the sum of both taps.
app.patch('/stations/:stationId', async (req, res, next) => {
  try {
    const { stationId } = req.params;
    const { batteries_available } = req.body;
    if (!Number.isInteger(batteries_available) || batteries_available < 0) {
      return res.status(400).json({
        error: 'batteries_available must be a non-negative integer',
      });
    }
    const station = await setStationBatteries(stationId, batteries_available);
    if (!station) return res.status(404).json({ error: 'station_not_found' });
    res.json(station);
  } catch (err) {
    next(err);
  }
});

// Rider taps "yes" on the app's advice (claim_made)
app.post('/claims', async (req, res, next) => {
  try {
    const { rider_id, station_id, battery_type, plate_number, event_id } = req.body;
    if (!rider_id || !station_id || !battery_type || !plate_number) {
      return res.status(400).json({
        error: 'rider_id, station_id, battery_type, and plate_number are required',
      });
    }
    const result = await reserveClaim(rider_id, station_id, battery_type, plate_number, event_id);
    if (result.error) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// Attendant presses NEXT (called)
app.post('/stations/:stationId/next', async (req, res, next) => {
  try {
    const { stationId } = req.params;
    const { battery_type } = req.body;
    if (!battery_type) return res.status(400).json({ error: 'battery_type is required' });
    const claim = await callNext(stationId, battery_type);
    if (!claim) return res.status(204).end();
    res.json(claim);
  } catch (err) {
    next(err);
  }
});

// Rider taps ARRIVED at the geofence (arrived)
app.post('/claims/:claimId/arrived', async (req, res, next) => {
  try {
    const { claimId } = req.params;
    const { event_id } = req.body;
    const result = await markArrived(claimId, event_id);
    if (result.error === 'claim_not_found') return res.status(404).json(result);
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Attendant confirms the swap happened (served)
app.post('/claims/:claimId/served', async (req, res, next) => {
  try {
    const { claimId } = req.params;
    const result = await markServed(claimId);
    if (result.error === 'claim_not_found') return res.status(404).json(result);
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Rider gives up their slot (claim_released, reason 'manual')
app.post('/claims/:claimId/release', async (req, res, next) => {
  try {
    const { claimId } = req.params;
    const result = await releaseClaim(claimId);
    if (result.error === 'claim_not_found') return res.status(404).json(result);
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

// The slip/no-show ladder runs on a timer rather than a job scheduler: one
// pass a minute over the claims sitting on 'called' is well within what a
// setInterval can carry at this scale, and a missed tick costs nothing
// because the next pass picks the same claims up.
const SWEEP_INTERVAL_MS = 60_000;

setInterval(async () => {
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
