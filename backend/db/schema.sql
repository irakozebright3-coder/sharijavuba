-- SharijaVuba backend schema
-- Events is the only table that gets written on every action.
-- riders and stations are thin reference tables.
-- claims is a derived / rebuildable cache table for fast queue lookups,
-- never treated as authoritative on its own. If it were dropped and
-- rebuilt from events, the queue would come back exactly as it was.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS riders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  -- Set by hand by the attendant, never computed. Nothing in the queue
  -- decrements it: a served claim does not touch this number, because the
  -- rack is restocked and drained by people the backend cannot observe.
  batteries_available INT NOT NULL DEFAULT 12,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE TYPE event_type AS ENUM (
    'intent_set', 'advice_given', 'claim_made', 'claim_released',
    'called', 'arrived', 'served', 'reported', 'no_show', 'overruled'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Added alongside the serve-time battery decrement. ALTER TYPE ... ADD VALUE
-- is permitted inside migrate.js's single implicit transaction from
-- PostgreSQL 12 on, provided nothing uses the new label before that
-- transaction commits, which nothing here does. Deliberately not wrapped in
-- a DO block: ADD VALUE is rejected inside a subtransaction even where it is
-- accepted at the top level of one.
ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'battery_count_changed';

-- event_id is generated client-side (a UUID) before the request is sent.
-- That makes it the idempotency key: a retried request after a dropped
-- connection carries the same event_id, and the second insert is a no-op.
CREATE TABLE IF NOT EXISTS events (
  event_id UUID PRIMARY KEY,
  event_type event_type NOT NULL,
  rider_id UUID REFERENCES riders(id),
  station_id UUID REFERENCES stations(id),
  battery_type TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_station_type_idx
  ON events (station_id, event_type, created_at);

CREATE TABLE IF NOT EXISTS claims (
  claim_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id UUID NOT NULL REFERENCES riders(id),
  station_id UUID NOT NULL REFERENCES stations(id),
  battery_type TEXT NOT NULL,
  -- Normalized on write (uppercased, whitespace stripped) so "rac 123b" and
  -- "RAC123B" are the same plate and cannot both hold a slot.
  plate_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  -- Shared BIGSERIAL across all stations, values interleave between queues. Never compare or order by position without filtering on station_id + battery_type first.
  position BIGSERIAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  called_at TIMESTAMPTZ,
  first_called_at TIMESTAMPTZ,
  arrived_at TIMESTAMPTZ,
  served_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  slip_count INT NOT NULL DEFAULT 0
);

-- Added alongside the attendant's manual battery count, same reason as the
-- claims columns below: the CREATE TABLE above only runs on a fresh
-- database. The DEFAULT applies to every existing row, so there is no
-- backfill to do and no window where the column is NULL.
ALTER TABLE stations ADD COLUMN IF NOT EXISTS batteries_available INT NOT NULL DEFAULT 12;

-- Added alongside the arrived/served operations. The CREATE TABLE above
-- only runs on a fresh database, so existing ones pick the column up here.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;

-- Added alongside the slip/no-show ladder, same reason as arrived_at above.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS first_called_at TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS slip_count INT NOT NULL DEFAULT 0;

-- Added when the live-claim rule moved from per-rider to per-plate. NOT NULL
-- with no default only succeeds while claims is empty; a database that
-- already holds claim rows needs a backfill (or a DEFAULT) before this line
-- will apply.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS plate_number TEXT NOT NULL;

-- Backfill for claims that were already called before the column existed.
-- Without this they would carry a NULL first_called_at and be treated as
-- past their tail deadline on the next sweep.
UPDATE claims SET first_called_at = called_at
  WHERE first_called_at IS NULL AND called_at IS NOT NULL;

-- Invariant 1: a plate holds at most one live claim at a time. A claim is
-- not concluded until it is served, so 'arrived' still counts as live.
--
-- Keyed on the plate rather than the rider: the queue slot belongs to the
-- bike, so one person managing several bikes can hold a slot for each,
-- while the same bike cannot be queued twice under two rider accounts.
-- This only holds because plate_number is normalized on write.
--
-- The DROP of the old per-rider index runs first so an existing database
-- does not keep enforcing the superseded rule. Both statements run inside
-- migrate.js's single implicit transaction, so there is no window where
-- neither constraint is present.
DROP INDEX IF EXISTS one_live_claim_per_rider;
CREATE UNIQUE INDEX IF NOT EXISTS one_live_claim_per_plate
  ON claims (plate_number)
  WHERE status IN ('waiting', 'called', 'arrived');

-- Invariant 5 support: fast, ordered lookup of the next eligible claim
-- for a given station and battery type.
CREATE INDEX IF NOT EXISTS claims_queue_lookup
  ON claims (station_id, battery_type, status, position);

-- Supports the expiry sweep: the candidate scan is a range read over
-- called_at across the small set of claims currently sitting on 'called'.
CREATE INDEX IF NOT EXISTS claims_expiry_sweep
  ON claims (called_at)
  WHERE status = 'called';
