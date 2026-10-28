/**
 * Concurrency test for the NEXT button (invariant 3: two attendants can
 * never call the same slot).
 *
 * This has to be concurrent to mean anything. A sequential test calls
 * callNext twice with the first fully committed before the second starts,
 * which is exactly the case that was never broken. The bug lives in the
 * window where both transactions are open at once, so both calls are
 * fired with Promise.all.
 *
 * Runs against the live database in DATABASE_URL, creates its own station
 * and claims, and deletes them again at the end.
 *
 *   node test/concurrentNext.test.mjs
 */
import { pool } from '../db/index.js';
import { callNext } from '../queue/nextClaim.js';
import { reserveClaim } from '../queue/reserveClaim.js';

const ROUNDS = 6;
const BATTERY = 'concurrency_test';

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok && detail) console.log(`        ${detail}`);
  ok ? pass++ : fail++;
};

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

/**
 * Never throws. It runs from a finally, so letting it fail would mask
 * whatever actually went wrong, and it takes ids that may be null because
 * setup can fail halfway through.
 */
async function cleanup(station, rider) {
  if (!station && !rider) return;
  try {
    if (station) {
      await q('DELETE FROM events WHERE station_id = $1', [station]);
      await q('DELETE FROM claims WHERE station_id = $1', [station]);
    }
    if (rider) await q('DELETE FROM riders WHERE id = $1', [rider]);
    if (station) await q('DELETE FROM stations WHERE id = $1', [station]);

    const leftovers = station
      ? (await q('SELECT count(*)::int AS n FROM claims WHERE station_id = $1', [station]))[0].n
      : 0;
    console.log(`\ncleanup: ${leftovers === 0 ? 'test data removed' : leftovers + ' rows left behind'}`);
  } catch (err) {
    console.error('cleanup failed, rows may be left in the database:', err.message);
  }
}

async function main() {
  // Declared out here so the finally can clean up whatever got created,
  // including when setup itself fails between the two inserts.
  let station = null;
  let rider = null;

  try {
    station = (await q(
      "INSERT INTO stations (name) VALUES ('Concurrency test station') RETURNING id"
    ))[0].id;
    rider = (await q('INSERT INTO riders DEFAULT VALUES RETURNING id'))[0].id;
    console.log(`station ${station}\n`);

    // ---- two waiting claims, two simultaneous NEXT presses ----------------
    console.log(`A. two waiting claims, two simultaneous NEXT presses (${ROUNDS} rounds)`);
    let duplicates = 0;
    let missedSecond = 0;

    for (let round = 0; round < ROUNDS; round++) {
      const first = (await reserveClaim(rider, station, BATTERY, `CT${round}AAA`)).claim;
      const second = (await reserveClaim(rider, station, BATTERY, `CT${round}BBB`)).claim;
      if (!first || !second) throw new Error(`round ${round}: could not seed two claims`);

      // Both presses in flight at the same instant.
      const [a, b] = await Promise.all([
        callNext(station, BATTERY),
        callNext(station, BATTERY),
      ]);

      const ids = [a && a.claim_id, b && b.claim_id];
      if (a && b && a.claim_id === b.claim_id) {
        duplicates++;
        console.log(`   round ${round}: SAME CLAIM RETURNED TWICE -> ${a.claim_id}`);
      } else if (!a || !b) {
        missedSecond++;
        console.log(`   round ${round}: one press got nothing (${JSON.stringify(ids)}) while a claim was still waiting`);
      }
    }

    check('no round returned the same claim to both callers', duplicates === 0,
          `${duplicates}/${ROUNDS} rounds handed one claim to two attendants`);
    check('both callers got a claim when two were waiting', missedSecond === 0,
          `${missedSecond}/${ROUNDS} rounds left a waiting claim uncalled`);

    // ---- the event log is the real evidence -------------------------------
    const doubleCalled = await q(
      `SELECT payload->>'claim_id' AS claim_id, count(*)::int AS n
       FROM events
       WHERE station_id = $1 AND event_type = 'called'
       GROUP BY 1 HAVING count(*) > 1`,
      [station]
    );
    check('no claim has more than one called event', doubleCalled.length === 0,
          JSON.stringify(doubleCalled));

    const stillWaiting = (await q(
      "SELECT count(*)::int AS n FROM claims WHERE station_id = $1 AND status = 'waiting'",
      [station]
    ))[0].n;
    check('every seeded claim was called exactly once', stillWaiting === 0,
          `${stillWaiting} claims left waiting`);

    // ---- one waiting claim, two simultaneous presses -----------------------
    console.log(`\nB. one waiting claim, two simultaneous NEXT presses (${ROUNDS} rounds)`);
    let bothWon = 0;
    let nobodyWon = 0;

    for (let round = 0; round < ROUNDS; round++) {
      const only = (await reserveClaim(rider, station, BATTERY, `CT${round}SOLO`)).claim;
      if (!only) throw new Error(`round ${round}: could not seed the single claim`);

      const [a, b] = await Promise.all([
        callNext(station, BATTERY),
        callNext(station, BATTERY),
      ]);

      const winners = [a, b].filter(Boolean);
      if (winners.length === 2) {
        bothWon++;
        console.log(`   round ${round}: both presses won (${a.claim_id} / ${b.claim_id})`);
      } else if (winners.length === 0) {
        nobodyWon++;
        console.log(`   round ${round}: neither press got the waiting claim`);
      }
    }

    check('exactly one press wins when one claim is waiting', bothWon === 0,
          `${bothWon}/${ROUNDS} rounds let both presses win`);
    check('the waiting claim is never skipped entirely', nobodyWon === 0,
          `${nobodyWon}/${ROUNDS} rounds called nobody`);

  } finally {
    // Runs whether the assertions passed, failed, or the test threw
    // partway. This writes to the live database, so leftover rows would
    // turn up in the demo.
    await cleanup(station, rider);
    console.log(`\n${pass} passed, ${fail} failed`);
  }

  process.exitCode = fail ? 1 : 0;
}

main()
  .catch((err) => {
    console.error('test crashed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
