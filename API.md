# SharijaVuba API

The contract for the rider and station front ends. Every endpoint below was
read from the route definitions in [`backend/app.js`](backend/app.js) and the
queue modules they call, and every status code and body shape was verified
against a running server. Nothing here is inferred.

Base URL: `http://localhost:3000` (`PORT` env var, defaults to `3000`).

Every route is served twice, from the same handlers: at the root
(`/stations`) and under `/api` (`/api/stations`). The root mount is what the
USSD simulator and the curl examples below use; the `/api` mount is what the
front ends use, because a host that serves the pages and the API from one
origin (Render, Vercel) needs a prefix to tell them apart. `?api=https://host`
still points a page at any other backend.

All request bodies are JSON and need `Content-Type: application/json`.
There is no authentication and no rate limiting.

CORS is wide open when `FRONTEND_ORIGINS` is unset: every response carries
`Access-Control-Allow-Origin: *`, and `OPTIONS` preflights return `204`. That
exists so the station app can be opened straight from disk (`file://`, which
reports an origin of `null`), and it is not needed at all on Vercel, where the
apps and the API share an origin. Set `FRONTEND_ORIGINS` to a comma-separated
list to restrict it.

`/cron/sweep` is the one route that can require a secret, because it is the
only one an outside scheduler may call: with `CRON_SECRET` set it needs
`Authorization: Bearer <secret>`, and with it unset the route answers `503`
rather than standing open. On Vercel the sweep also runs by itself on incoming
traffic, so this endpoint is only for keeping it going while nobody has an app
open.

## Endpoint summary

| Method | Path | Purpose | Success |
| --- | --- | --- | --- |
| GET | `/stations` | List stations | `200` |
| GET | `/stations/summary` | Queue length per station and battery type | `200` |
| GET | `/battery-types` | List battery types in use | `200` |
| GET | `/stations/:stationId/queue` | Read one queue | `200` |
| GET | `/claims/:claimId` | Read one claim | `200` |
| POST | `/claims` | Rider reserves a queue slot | `201` |
| POST | `/stations/:stationId/next` | Attendant presses NEXT | `200` / `204` |
| POST | `/claims/:claimId/arrived` | Rider taps ARRIVED | `200` |
| POST | `/claims/:claimId/served` | Attendant confirms the swap | `200` |
| POST | `/claims/:claimId/release` | Rider gives up their slot | `200` |
| POST | `/cron/sweep` | Run the slip/no-show ladder now (needs `CRON_SECRET`) | `200` |

### place_in_line

Two endpoints return `place_in_line`: a plain `1, 2, 3...` counted over the
claims still `waiting` or `called` in the same station and battery type,
ordered by `position` ascending.

**Show this to riders, never `position`.** `position` is a sequence shared
by every station, so its values interleave between queues and jump — the
two claims in the same queue below sit at positions `8` and `12` while
being 1st and 2nd in line. `place_in_line` is the number that means what a
rider thinks it means, and it is a real JSON number, not a string.

It is `null` for any claim not currently in line — `arrived`, `served`,
`no_show`, `released` — because those claims do not have a place. A rider
whose `place_in_line` goes from `3` to `null` has left the queue; check
`status` to find out how.

## The claim object

Most responses carry a claim. It is the full `claims` row (`RETURNING *`),
so it always has all fourteen fields:

```json
{
  "claim_id": "de762a6c-bcd3-47e4-8324-675ebe2b1e8c",
  "rider_id": "4de1c00d-9a8f-42c0-a7f4-a8d61ea4d346",
  "station_id": "525f577c-a858-46f7-a166-1f800f40ba29",
  "battery_type": "standard",
  "plate_number": "RAC123B",
  "status": "waiting",
  "position": "3",
  "created_at": "2026-08-23T06:29:48.594Z",
  "called_at": null,
  "first_called_at": "2026-08-23T06:29:51.675Z",
  "arrived_at": null,
  "served_at": null,
  "released_at": null,
  "slip_count": 1
}
```

Field notes that will bite if missed:

- **`position` is a JSON string, not a number.** It is a Postgres `bigint`,
  which the driver serializes as a string. `"10" < "9"` is true in
  JavaScript, so compare with `BigInt(a) > BigInt(b)`, never `>` on the raw
  values.
- `position` values come from one sequence shared by every station, so they
  interleave between queues and are **not** a rider's place in line. A
  position of `"47"` does not mean 47 people are ahead. It is only
  meaningful when ordering claims already filtered to one station and
  battery type — and no endpoint currently exposes that ordering.
- **`plate_number` is returned normalized, not as submitted.** The server
  uppercases it and strips all whitespace before storing, so a request
  sending `"rac 123b"` gets back `"RAC123B"`. Display the returned value,
  not the one typed, or the rider will see a plate that does not match what
  the station sees.
- `slip_count` is a real number (`0` or `1`).
- All timestamps are ISO-8601 UTC strings, or `null` when unset.
- `status` is one of `waiting`, `called`, `arrived`, `served`, `released`,
  `no_show`.

---

## GET /stations

Every station, ordered by name. No parameters.

**`200 OK`**

```json
[{ "id": "6dca8099-...", "name": "Kicukiro Test" }]
```

Returns `[]` when none exist. Station names are not unique — several rows
can share a name, so key any UI list on `id`.

---

## GET /stations/summary

One row per station per battery type, with the number of claims currently
`waiting` or `called`. This is what the rider app's station picker is built
from. No parameters.

**`200 OK`**

```json
[
  { "station_id": "60a6edaf-...", "name": "Kicukiro Test", "battery_type": "standard", "in_queue": 0 },
  { "station_id": "6dca8099-...", "name": "Kicukiro Test", "battery_type": "standard", "in_queue": 2 }
]
```

- Ordered by station name, then battery type. **Sort by `in_queue` yourself**
  if you want shortest-queue-first; the endpoint does not do it for you.
- A station with an empty queue is included with `in_queue: 0`. The query is
  driven from `stations`, not from `claims`, precisely so the stations worth
  sending a rider to do not vanish from the list.
- `in_queue` is a real number, not a string.
- Battery types are the ones already in use, plus `standard`, so the row
  count is stations x types and every station appears once per type.
- Counts `waiting` and `called` only. A rider who has `arrived` is at the
  counter, not in the line, and is not counted.

**It is a count, not a wait time.** Nothing in the system measures how long a
swap takes, so any minutes figure derived from this would be invented.

---

## GET /battery-types

The distinct `battery_type` values already recorded on claims, ascending.

**`200 OK`**

```json
["standard"]
```

There is no battery-type reference table; the column is free text on
`claims`. So this returns only what has actually been used, and it returns
`[]` on a fresh database. A picker built from it should merge in a default
of its own, or the first claim can never be created.

---

## GET /stations/:stationId/queue

The live queue for one station and battery type, plus what recently left it.
This is the endpoint the station app polls.

**Path:** `stationId` — station UUID.
**Query:** `battery_type` — required.

**`200 OK`**

```json
{
  "station_id": "6dca8099-...",
  "battery_type": "standard",
  "queue": [
    {
      "claim_id": "17402ff8-...",
      "plate_number": "RAC123A",
      "status": "waiting",
      "position": "8",
      "place_in_line": 1,
      "slip_count": 0,
      "created_at": "2026-08-23T07:40:40.125Z",
      "called_at": null,
      "first_called_at": null,
      "arrived_at": null
    },
    {
      "claim_id": "5dee8e2b-...",
      "plate_number": "RAC783C",
      "status": "waiting",
      "position": "12",
      "place_in_line": 2,
      "slip_count": 0,
      "created_at": "2026-08-23T08:52:16.320Z",
      "called_at": null,
      "first_called_at": null,
      "arrived_at": null
    }
  ],
  "recent": []
}
```

- `queue` holds claims in `waiting`, `called`, or `arrived`, ordered by
  `position` ascending — call order. This is the one context where
  `position` is meaningful, because the rows are already filtered to a
  single station and battery type. Note the real response above: positions
  `8` and `12` for the 1st and 2nd claims in line.
- `place_in_line` is `1, 2, 3...` over the `waiting` and `called` claims
  only. An `arrived` claim still appears in `queue` — the attendant needs
  to see it — but carries `place_in_line: null`, because it has reached
  the counter and is no longer in line.
- `recent` holds up to 5 claims that reached `served`, `no_show`, or
  `released` in the last 15 minutes, newest first. It exists so a `no_show`
  is visibly *somewhere* instead of silently vanishing from `queue`. Its
  `concluded_at` is approximate: there is no `no_show_at` column, so it
  falls back through `served_at`, `released_at`, `called_at`, `created_at`.
- Both arrays are `[]` when empty. Claim rows here are a **subset** of the
  full claim object — no `rider_id`, `station_id`, `battery_type`,
  `served_at`, `released_at`.

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `400` | `{"error": "battery_type is required"}` | `battery_type` query param missing |

An unknown but well-formed `stationId` returns `200` with empty arrays, not
`404` — the station is never checked for existence.

---

## GET /claims/:claimId

One claim by id, with its place in line while it is still queueing. This is
what a rider app polls.

**Path:** `claimId` — claim UUID. No query parameters.

**`200 OK`**

```json
{
  "claim": {
    "claim_id": "17402ff8-...",
    "rider_id": "23dae32f-...",
    "station_id": "6dca8099-...",
    "battery_type": "standard",
    "plate_number": "RAC123A",
    "status": "waiting",
    "position": "8",
    "place_in_line": 1,
    "created_at": "2026-08-23T07:40:40.125Z",
    "called_at": null,
    "first_called_at": null,
    "arrived_at": null,
    "served_at": null,
    "released_at": null,
    "slip_count": 0
  }
}
```

The claim is **wrapped** in `{"claim": ...}`, matching the POST endpoints
rather than the bare object `POST /stations/:stationId/next` returns. It is
the full fourteen-field claim object plus `place_in_line` — unlike the
trimmed rows inside `GET /stations/:stationId/queue`.

`place_in_line` is `null` unless the claim is `waiting` or `called`. See
[place_in_line](#place_in_line).

Because the sweep changes status with no client request, this endpoint is
how a rider app notices a slip (`place_in_line` jumps up, `slip_count`
becomes `1`) or a no-show (`status` becomes `no_show`, `place_in_line`
becomes `null`).

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{"error": "claim_not_found"}` | no claim with that id |

A `claimId` that is not a valid UUID returns `500`, not `404` — see
[Errors that apply everywhere](#errors-that-apply-everywhere).

---

## POST /claims

Rider reserves a slot. Writes a `claim_made` event.

**Body**

| Field | Type | Required |
| --- | --- | --- |
| `rider_id` | UUID string | yes |
| `station_id` | UUID string | yes |
| `battery_type` | string | yes |
| `plate_number` | string | yes |
| `event_id` | UUID string | no — generated server-side if omitted |

`plate_number` is the bike's plate. It is normalized server-side
(uppercased, whitespace stripped) before it is stored or checked, so
`"rac 123b"`, `"RAC 123B"`, and `"RAC123B"` are all the same plate and only
one of them can hold a slot. Send it however the rider typed it; the
response carries the normalized form.

`event_id` is the idempotency key. Generate it on the client *before* the
request, and reuse the same value when retrying after a dropped connection;
the retry is then recognized instead of creating a second claim.

**`201 Created`**

```json
{ "claim": { ...claim object... } }
```

**`201 Created` — already applied.** When `event_id` has been seen before:

```json
{ "alreadyProcessed": true }
```

> This is still a `201`, and **there is no `claim` key**. Code that does
> `res.data.claim.claim_id` will throw on a retry. Check
> `alreadyProcessed` first. Nothing in the response tells you which claim
> the original request created — hold onto it client-side.

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `400` | `{"error": "rider_id, station_id, battery_type, and plate_number are required"}` | any of the four missing or falsy |
| `409` | `{"error": "plate_already_has_a_live_claim"}` | that plate already holds a claim in `waiting`, `called`, or `arrived` |

**The live-claim rule is per plate, not per rider.** The queue slot belongs
to the bike. One rider account can hold several simultaneous claims as long
as each is for a different plate — useful for someone managing a small
fleet — but the same plate cannot be queued twice, even from two different
rider accounts.

A plate must reach `served`, `released`, or `no_show` before it can reserve
again. `409` is the expected, routine response for a double-tap.

---

## POST /stations/:stationId/next

Attendant calls the next rider. Writes a `called` event. Safe to press
concurrently from two devices: at most one wins the claim, the other gets
`204`.

**Path:** `stationId` — station UUID.

**Body**

| Field | Type | Required |
| --- | --- | --- |
| `battery_type` | string | yes |

**`200 OK`**

The claim object is returned **bare, not wrapped**:

```json
{ "claim_id": "...", "status": "called", ... }
```

> Note the asymmetry: this endpoint returns the claim at the top level,
> while every other endpoint wraps it as `{"claim": {...}}`. Handle both.

**`204 No Content`** — nothing eligible is waiting for that station and
battery type. Empty body. This is the normal "queue is empty" response,
not an error, and it is also what a losing concurrent NEXT press receives.

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `400` | `{"error": "battery_type is required"}` | `battery_type` missing or falsy |

An unknown but well-formed `stationId` returns `204`, not `404` — the
station is never checked for existence, the query simply matches no claims.

---

## POST /claims/:claimId/arrived

Rider taps ARRIVED at the geofence. Requires the claim to be `called`.
Writes an `arrived` event.

**Path:** `claimId` — claim UUID.

**Body** — optional.

| Field | Type | Required |
| --- | --- | --- |
| `event_id` | UUID string | no — generated server-side if omitted |

Same idempotency key semantics as `POST /claims`. The request works with no
body at all.

**`200 OK`**

```json
{ "claim": { ...claim object, status "arrived", arrived_at set... } }
```

**`200 OK` — already applied:** `{"alreadyProcessed": true}`, with no
`claim` key. Same caveat as `POST /claims`.

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{"error": "claim_not_found"}` | no claim with that id |
| `409` | `{"error": "claim_already_arrived"}` | already `arrived` |
| `409` | `{"error": "claim_not_called", "status": "<current>"}` | any other status |

`claim_not_called` carries a `status` field with the claim's actual status
— useful for telling a rider *why* (e.g. `"no_show"` after the grace window
expired, or `"waiting"` after a slip-back).

---

## POST /claims/:claimId/served

Attendant confirms the swap. Requires the claim to be `arrived`. Writes a
`served` event.

**Path:** `claimId` — claim UUID. **Body:** none.

**`200 OK`**

```json
{ "claim": { ...claim object, status "served", served_at set... } }
```

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{"error": "claim_not_found"}` | no claim with that id |
| `409` | `{"error": "claim_already_served"}` | already `served` |
| `409` | `{"error": "claim_not_arrived", "status": "<current>"}` | any other status |

A claim must go through `arrived` first; an attendant cannot serve straight
from `called`. This endpoint takes **no** `event_id` — a retry after a
dropped connection returns `409 claim_already_served`, which for this
operation is the safe outcome, not a failure. Treat it as success.

---

## POST /claims/:claimId/release

Rider gives up their slot voluntarily. Valid from `waiting` or `called`.
Writes a `claim_released` event with `reason: "manual"`.

**Path:** `claimId` — claim UUID. **Body:** none.

**`200 OK`**

```json
{ "claim": { ...claim object, status "released", released_at set... } }
```

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{"error": "claim_not_found"}` | no claim with that id |
| `409` | `{"error": "claim_already_released"}` | already `released` |
| `409` | `{"error": "claim_not_releasable", "status": "<current>"}` | any other status |

A claim that has reached `arrived` can no longer be released. Releasing
frees the rider to reserve again immediately.

---

## Errors that apply everywhere

| Status | Body | When |
| --- | --- | --- |
| `500` | `{"error": "internal_error"}` | any unhandled server or database error |
| `404` | HTML, not JSON | unknown path or wrong method |

**`500` is not always a server bug.** Three client-side mistakes surface as
`500 internal_error`, all verified:

- **Malformed JSON body.** Express's parse error is not special-cased, so a
  bad body returns `500`, not `400`.
- **A path parameter that is not a valid UUID** (e.g.
  `/claims/not-a-uuid/served`). Postgres rejects it with `22P02` and the
  error handler turns that into `500`.
- **A `rider_id` or `station_id` that does not exist** on `POST /claims`.
  This is a foreign key violation (`23503`) and returns `500`, *not* a
  `404` or a validation error.

Validate UUIDs client-side; the API will not do it for you, and the
response will not tell you which of the three went wrong. The real cause is
logged server-side only.

**Unknown routes return HTML.** Express's default handler produces an HTML
error page with `Content-Type: text/html`, so a client that assumes every
response parses as JSON will throw on a typo'd URL rather than surfacing a
clean error.

## Background behavior the UI must expect

A sweep runs server-side every 60 seconds and **changes claim status
without any client request**:

- A `called` claim that goes quiet past the grace window slips back once —
  status returns to `waiting`, `slip_count` becomes `1`, `called_at` is
  cleared, and the claim moves behind others in its queue.
- A claim that has already slipped, or whose tail deadline has passed, is
  closed out as `no_show`.

So a claim the UI last saw as `called` may be `waiting` or `no_show` by the
next interaction, with no request from the rider. Never cache status as
authoritative; re-read it from each response, and expect
`claim_not_called` / `claim_not_arrived` errors carrying a surprising
`status` field.

The windows come from `backend/queue/constants.js`: grace 10 minutes, slip
5 places, tail 30 minutes. These are **unvalidated placeholders from
planning**, not confirmed with riders or attendants — do not build copy
that quotes them as fact ("you have 10 minutes") until they are confirmed.

## Not in the API yet

Needed before either front end is fully buildable, and not currently
possible through any endpoint:

- **Creating riders and stations.** Both must exist before `POST /claims`
  will succeed, and there is no endpoint for either — insert them directly
  into the database for now.
- Station rack-state and batch-ETA endpoints, offline sync for the rider
  PWA, and the n8n webhook for EjoChat notifications.
