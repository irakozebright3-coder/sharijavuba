# SharijaVuba backend

Battery swap queue backend for the STP'26 hackathon. The event log is the
source of truth, everything else is a view over it.

## What's in this slice

Per the risk order in the build brief: schema, the operations that carry
the actual concurrency risk, and the expiry ladder that keeps a called
slot from blocking the queue forever.

- `db/schema.sql`, the events table (the spine), thin `riders` and
  `stations` reference tables, and `claims` as a derived, rebuildable
  cache table for fast queue lookups.
- `queue/reserveClaim.js`, reserve-on-tap (`claim_made`). Enforces
  invariant 1 (one live claim per plate) via a database constraint, and
  invariant 4 (safe retries) via a client-supplied `event_id` used as
  the idempotency key. The slot belongs to the bike, not the account, so
  `plate_number` is required and is normalized on write (uppercased,
  whitespace stripped) before the uniqueness check sees it.
- `queue/nextClaim.js`, the NEXT button (`called`). Enforces invariant 3
  (two attendants can never call the same slot) with `FOR UPDATE SKIP
  LOCKED` on the inner `SELECT`, so a second attendant pressing at the
  same instant steps over the locked row and takes the next waiting
  claim, plus `AND status = 'waiting'` on the outer `UPDATE` as a
  backstop. A single statement was not enough on its own: under READ
  COMMITTED a caller that blocked on the row lock re-checked a
  `claim_id = (subquery)` condition that was still true and called the
  same rider twice. `test/concurrentNext.test.mjs` covers it.
- `queue/arrived.js`, the rider tapping ARRIVED at the geofence
  (`arrived`). Requires the claim to be `called`, and carries the same
  client-supplied `event_id` idempotency as reserve.
- `queue/served.js`, the attendant confirming the swap (`served`).
  Enforces invariant 2 (a claim can never be served twice) with the same
  atomic status-guarded update.
- `queue/releaseClaim.js`, the rider giving up their slot voluntarily
  (`claim_released`, reason `manual`), freeing the position for whoever
  is behind them.
- `queue/sweepExpiredClaims.js`, the grace/slip/tail ladder. A called
  claim that goes quiet past the grace window slips back once and
  returns to `waiting`; one that has already used that chance, or whose
  tail deadline has passed, is closed out as `no_show`.
- `server.js`, a thin Express wrapper so all of it is runnable and
  testable right now, with the sweep running on a timer.

The tuning constants in `queue/constants.js` (`GRACE_MINUTES`,
`SLIP_PLACES`, `TAIL_MINUTES`) are unvalidated placeholders from
planning, not confirmed with riders or attendants. See build brief
section 8 before submission.

## Setup

```bash
npm install
cp .env.example .env   # fill in your real DATABASE_URL
npm run migrate
npm start
```

## USSD simulator

```bash
npm run ussd                                 # against the deployed API
API_URL=http://localhost:3000 npm run ussd   # against a local backend
```

It defaults to `https://sharijavuba-backend.onrender.com`, so it works from a
clean checkout with nothing running locally. On the free plan that instance
sleeps after a quiet spell, so the first screen can take up to a minute to
appear while it wakes.

`ussd/ussd.mjs` renders a feature-phone session for `*111*1#`: dial, pick a
station from the live queue lengths, type a plate, confirm. It is Kinyarwanda
throughout, read from `strings.rw.json`, and every screen is a real HTTP call
against the API — a claim reserved over USSD is an ordinary claim and shows
up in the station app immediately. Session state is in memory, so "check my
place" only knows about a claim made in the same run.

## Tests

```bash
npm test    # node test/concurrentNext.test.mjs
```

`test/concurrentNext.test.mjs` covers invariant 3, that two attendants
pressing NEXT at the same instant are never handed the same rider. It fires
both calls with `Promise.all` against the live database, because the bug it
exists to catch only appears while both transactions are open at once — a
sequential test passes happily against code that hands one rider to two
attendants. It creates its own station and claims and deletes them again,
but it does write to whatever `DATABASE_URL` points at.

## Deploying

[`render.yaml`](../render.yaml) at the repo root is a Render Blueprint for
this service. `rootDir` is `backend`, the build is `npm ci`, the start is
`npm start`.

`DATABASE_URL` is declared with `sync: false`, which means Render asks for
it once and keeps it in the dashboard. It is never written to this repo.
`PORT` is not declared at all: Render assigns one and `server.js` reads it
from the environment, binding to `0.0.0.0` so the container is reachable.

Two things the Blueprint deliberately does not do:

- **It does not run migrations.** `buildCommand` is `npm ci` only, so a
  database that is unreachable at build time cannot block a deploy. Apply
  schema changes with `npm run migrate` against the same `DATABASE_URL`, or
  append `&& npm run migrate` to the build command if you would rather it
  be automatic — `schema.sql` is written to be re-runnable.
- **It sets no health check path.** Every read endpoint queries the
  database, so a health check would put a permanent trickle of queries on
  the Neon instance. Add a plain `/healthz` first if you want one.

On the free plan the service sleeps after roughly 15 minutes of no
traffic, and **the sweep sleeps with it** — a called claim will not slip or
no-show while nothing is hitting the API. That is fine for a demo you are
actively clicking through and wrong for anything real; the ladder needs
either a paid instance or its own Render Cron Job.

## Try it

```bash
# create a rider and station first (psql, or add a seed script later)

curl -X POST http://localhost:3000/claims \
  -H "Content-Type: application/json" \
  -d '{"rider_id":"<uuid>","station_id":"<uuid>","battery_type":"standard","plate_number":"RAC123B"}'

curl -X POST http://localhost:3000/stations/<station_uuid>/next \
  -H "Content-Type: application/json" \
  -d '{"battery_type":"standard"}'
```

## Not built yet, on purpose

Following the same risk order: the station rack-state and batch-ETA
endpoints, offline sync from the rider PWA, and the n8n webhook for
EjoChat notifications. Build order and the full feature list are in the
agent build brief, keep that file next to this repo, the agent should
treat it as the spec.
