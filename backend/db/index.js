import pg from 'pg';
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { newDb } from 'pg-mem';

// Set DEMO_DATABASE=true for a fully local, disposable development setup.
// Production continues to use DATABASE_URL exactly as before.
export const usingDemoDatabase = process.env.DEMO_DATABASE === 'true';

function createDemoPool() {
  const db = newDb();
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: randomUUID,
    impure: true,
  });

  db.public.none(`
    CREATE TABLE riders (
      id UUID PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE stations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      batteries_available INT NOT NULL DEFAULT 12,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE events (
      event_id UUID PRIMARY KEY,
      event_type TEXT NOT NULL,
      rider_id UUID,
      station_id UUID,
      battery_type TEXT,
      payload JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE claims (
      claim_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rider_id UUID NOT NULL,
      station_id UUID NOT NULL,
      battery_type TEXT NOT NULL,
      plate_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      position SERIAL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      called_at TIMESTAMPTZ,
      first_called_at TIMESTAMPTZ,
      arrived_at TIMESTAMPTZ,
      served_at TIMESTAMPTZ,
      released_at TIMESTAMPTZ,
      slip_count INT NOT NULL DEFAULT 0,
      UNIQUE (plate_number)
    );
    INSERT INTO stations (name, batteries_available) VALUES
      ('Kigali Central', 12),
      ('Remera', 10),
      ('Nyamirambo', 8);
  `);

  const { Pool } = db.adapters.createPg();
  return new Pool();
}

export const pool = usingDemoDatabase
  ? createDemoPool()
  : new pg.Pool({ connectionString: process.env.DATABASE_URL });
