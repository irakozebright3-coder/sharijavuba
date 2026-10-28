import pg from 'pg';
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { newDb } from 'pg-mem';

const connectionString = process.env.DATABASE_URL;

// Set DEMO_DATABASE=true for a fully local, disposable development setup.
// A deploy with no DATABASE_URL at all falls back to the same thing rather
// than crashing: an empty Vercel project should serve the apps and say so,
// not return 500s. Production sets DATABASE_URL and never comes near this.
export const usingDemoDatabase = process.env.DEMO_DATABASE === 'true' || !connectionString;

if (!connectionString && process.env.DEMO_DATABASE !== 'true') {
  console.warn(
    'DATABASE_URL is not set: using the in-memory demo database. Data is not ' +
      'persisted, and on a serverless host each instance has its own copy.'
  );
}

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

/**
 * Managed Postgres (Neon, Supabase, Render) needs TLS; a local socket does
 * not. Deriving it from the host instead of asking for another env var
 * means the same DATABASE_URL works in both places. PGSSL=disable is the
 * escape hatch for a host that terminates TLS somewhere else.
 */
function poolConfig(url) {
  const isLocal = /(^|@|\/\/)(localhost|127\.0\.0\.1|\[::1\])/.test(url);
  const serverless = Boolean(process.env.VERCEL);

  return {
    connectionString: url,
    ssl: isLocal || process.env.PGSSL === 'disable' ? undefined : { rejectUnauthorized: false },
    // A serverless instance should hold one connection, not a pool of ten:
    // the function may be frozen at any moment and every extra idle
    // connection is one the database keeps paying for. Point this at the
    // provider's pooler connection string (Neon's `-pooler` host) so
    // parallel functions share connections instead of opening their own.
    max: Number(process.env.PG_POOL_MAX || (serverless ? 1 : 10)),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Lets a function finish and freeze once its client is idle, instead of
    // holding the invocation open until the timeout.
    allowExitOnIdle: serverless,
  };
}

export const pool = usingDemoDatabase
  ? createDemoPool()
  : new pg.Pool(poolConfig(connectionString));
