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
import { usingDemoDatabase } from './db/index.js';

/**
 * The HTTP surface, exported as a plain request handler.
 *
 * Nothing here starts a listener or a timer. `server.js` owns those for a
 * long-lived host (Render, a laptop), and the Vercel entry point in `api/`
 * calls the same app per request. Keeping the routes in one place is what
 * stops the two deployment shapes from drifting apart.
 */
const app = express();

// Hosting platforms differ on who reads the JSON body. Vercel's Node
// runtime hands the function an already-parsed `req.body`, and express.json()
// would then wait on a stream with nothing left in it. Marking it parsed
// makes body-parser step aside; on a host that does not pre-parse (Render,
// a local node server) `req.body` is undefined and the normal read happens.
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    req._body = true;
  }
  next();
});
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
// `database` says which store is actually in play, because a deploy that
// silently fell back to the in-memory demo database otherwise looks healthy
// while sharing nothing between instances.
app.get('/healthz', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'sharijavuba-backend',
    runtime: process.env.VERCEL ? 'vercel' : 'node',
    database: usingDemoDatabase ? 'demo (in-memory)' : 'postgres',
  });
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

// Run the slip/no-show ladder on demand.
//
// A long-lived server runs the sweep on a timer. A serverless host has no
// timer between requests, so the same sweep also runs opportunistically on
// incoming traffic (see queue/opportunisticSweep.js). This endpoint exists
// for an external scheduler that wants the sweep to keep happening while
// nobody has the apps open, and it is the only route that needs a secret:
// with CRON_SECRET unset it stays closed rather than open.
app.all('/cron/sweep', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'cron_secret_not_configured' });
  const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (given !== secret) return res.status(401).json({ error: 'unauthorized' });
  if (usingDemoDatabase) {
    return res.status(503).json({
      error: 'demo_database',
      message: 'The sweep needs PostgreSQL; the demo database has nothing to expire.',
    });
  }
  try {
    res.json(await sweepExpiredClaims());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

export default app;
