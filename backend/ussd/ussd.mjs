/**
 * USSD simulator: a feature-phone session against the real backend.
 * Every screen is a real HTTP call, so a claim made here is an ordinary
 * claim and appears in the station app like any other.
 *
 *   npm run ussd                                 # the deployed API
 *   API_URL=http://localhost:3000 npm run ussd   # a local backend
 */
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL || 'https://sharijavuba-backend.onrender.com';
const BATTERY = process.env.USSD_BATTERY || 'standard';
const CODE = '*111*1#';
const WIDTH = 38;

const catalog = JSON.parse(
  readFileSync(new URL('../../strings.rw.json', import.meta.url), 'utf8')
).strings;
const t = (id, fallback) => (catalog[id] && catalog[id].rw) || fallback || id;

const session = { riderId: randomUUID(), claimId: null };

// readline hands over lines as fast as the stream produces them, so a piped
// session would lose whatever arrives while an HTTP call is in flight.
// Buffer the lines and serve one per question.
const rl = createInterface({ input: process.stdin });
const buffered = [];
const waiting = [];
let closed = false;
rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : buffered.push(line)));
rl.on('close', () => {
  closed = true;
  while (waiting.length) waiting.shift()(null);
});

function nextLine() {
  if (buffered.length) return Promise.resolve(buffered.shift());
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => waiting.push(resolve));
}

// Wrapped on word boundaries the way a handset does, so a long plate does
// not push the end of the confirmation off the screen.
function wrap(line) {
  const out = [];
  let current = '';
  for (const word of String(line).split(' ')) {
    if (current && (current + ' ' + word).length > WIDTH - 2) {
      out.push(current);
      current = word;
    } else current = current ? current + ' ' + word : word;
  }
  return out.length || current ? [...out, current] : [''];
}

function screen(lines) {
  if (process.stdout.isTTY) console.clear();
  const edge = '─'.repeat(WIDTH);
  const row = (text) => console.log('│ ' + text.padEnd(WIDTH - 1) + '│');
  console.log('┌' + edge + '┐');
  row(CODE);
  console.log('├' + edge + '┤');
  for (const line of lines) wrap(line).forEach(row);
  console.log('└' + edge + '┘');
}

// null means the input ended: callers unwind and the session closes.
async function ask(lines) {
  screen(lines);
  process.stdout.write('> ');
  const line = await nextLine();
  return line === null ? null : line.trim();
}

async function show(lines) {
  screen([...lines, '', '[enter]']);
  process.stdout.write('> ');
  await nextLine();
}

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((body && body.error) || 'HTTP ' + res.status);
  return body;
}

const statusLabel = (status) => t('status.' + status, status);
const fail = (error) => show([t('rider.errReserveFailed', 'Byanze, ongera'), '', error.message]);

async function pickStation() {
  const rows = (await api('/stations/summary'))
    .filter((row) => row.battery_type === BATTERY)
    .sort((a, b) => a.in_queue - b.in_queue);

  if (!rows.length) {
    await show([t('station.noStationsError', 'There are no stations yet.')]);
    return null;
  }

  // Same rule as the app: everything tied for shortest is recommended.
  const shortest = rows[0].in_queue;
  const lines = [t('rider.chooseStation', 'Hitamo sitasiyo'), ''];
  rows.forEach((row, i) => {
    const badge = row.in_queue === shortest ? ' (' + t('rider.recommended', 'Nziza') + ')' : '';
    lines.push(`${i + 1}. ${row.name} [${row.in_queue}]${badge}`);
  });
  lines.push('', `0. ${t('ussd.cancel', 'Subira')}`);

  const choice = await ask(lines);
  if (choice === null || choice === '0') return null;

  const picked = rows[Number(choice) - 1];
  if (!picked) await show([t('ussd.invalid', 'Wibeshye')]);
  return picked || null;
}

async function reserve() {
  const station = await pickStation();
  if (!station) return;

  const plate = await ask([
    station.name,
    `${t('rider.inQueue', 'Mu murongo')}: ${station.in_queue}`,
    '',
    t('ussd.enterPlate', 'Andika Plaque yawe.'),
  ]);
  if (plate === null) return;
  if (!plate) return show([t('rider.errNoPlate', 'Shyiramo Plaque')]);

  const confirm = await ask([
    `${t('rider.station', 'Sitasiyo')}: ${station.name}`,
    `${t('rider.plateNumber', 'Plaque')}: ${plate.toUpperCase().replace(/\s+/g, '')}`,
    '',
    `1. ${t('ussd.confirm', 'Emeza')}`,
    `2. ${t('ussd.cancel', 'Subira')}`,
  ]);
  if (confirm !== '1') return;

  try {
    const made = await api('/claims', {
      method: 'POST',
      body: JSON.stringify({
        rider_id: session.riderId,
        station_id: station.station_id,
        battery_type: BATTERY,
        plate_number: plate,
        event_id: randomUUID(),
      }),
    });
    if (!made || !made.claim) return show([t('rider.errReserveFailed', 'Byanze, ongera')]);
    session.claimId = made.claim.claim_id;

    // The reserve response carries no place_in_line, so read the claim back
    // to show the same sentence the app's notification uses.
    const { claim } = await api('/claims/' + session.claimId);
    await show([
      t('notif.reserved', 'Plaque {plate}, uri uwa {place} mu murongo.')
        .replace('{plate}', claim.plate_number)
        .replace('{place}', claim.place_in_line ?? '-'),
    ]);
  } catch (error) {
    await fail(error);
  }
}

async function checkPlace() {
  if (!session.claimId) return show([t('ussd.noClaim', 'Nturabona slot.')]);
  try {
    const { claim } = await api('/claims/' + session.claimId);
    await show([
      `${t('rider.plateNumber', 'Plaque')}: ${claim.plate_number}`,
      `${t('rider.status', 'Uko uhagaze')}: ${statusLabel(claim.status)}`,
      `${t('rider.placeInLine', 'Aho ugeze')}: ${claim.place_in_line ?? '-'}`,
    ]);
  } catch (error) {
    await fail(error);
  }
}

async function main() {
  for (;;) {
    const choice = await ask([
      'SharijaVuba',
      '',
      `1. ${t('rider.reserveHeading', 'Fata umwanya')}`,
      `2. ${t('ussd.checkPlace', 'Reba aho ugeze')}`,
      `3. ${t('ussd.exit', 'Sohoka')}`,
    ]);
    if (choice === null || choice === '3') break;
    if (choice === '1') await reserve();
    else if (choice === '2') await checkPlace();
    else await show([t('ussd.invalid', 'Wibeshye')]);
  }
  screen([t('ussd.exit', 'Sohoka')]);
}

main()
  .catch((error) => {
    screen([t('rider.errReserveFailed', 'Byanze, ongera'), '', String(error.message)]);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
