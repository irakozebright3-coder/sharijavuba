import app from '../backend/app.js';
import { maybeSweep } from '../backend/queue/opportunisticSweep.js';

/**
 * The whole API as one Vercel Node function.
 *
 * `[...path]` is a catch-all, so every /api/* request lands here and the
 * Express app decides what it is. That keeps the front ends on the same
 * origin as the API (no CORS, no second deploy to point at), and it means
 * the routes live in exactly one place: backend/app.js, shared with the
 * long-lived server in backend/server.js.
 *
 * Vercel passes the full path (/api/stations), while the Express routes are
 * defined without the prefix, because the same app is served at the root of
 * a Render URL. So the prefix comes off here.
 */
export default async function handler(req, res) {
  const url = req.url || '/';
  const queryAt = url.indexOf('?');
  const pathname = queryAt === -1 ? url : url.slice(0, queryAt);
  const search = queryAt === -1 ? '' : url.slice(queryAt);

  let path = pathname;
  if (path === '/api' || path === '/api/') {
    // Opening /api in a browser should say something useful rather than 404.
    path = '/healthz';
  } else if (path.startsWith('/api/')) {
    path = path.slice('/api'.length);
  }

  req.url = path + search;

  // No timer survives between invocations, so the slip/no-show ladder runs
  // here, once a minute per warm instance. It never fails the request.
  await maybeSweep();

  return app(req, res);
}
