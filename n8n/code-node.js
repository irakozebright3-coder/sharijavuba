// Paste this into a Code node in the n8n canvas, wired downstream of the
// Webhook node that receives POSTs from the SharijaVuba backend.
//
// The Kinyarwanda below is a snapshot of strings.rw.json in the repo. A Code
// node has no access to that file, so the templates are inlined here. If a
// notification is retranslated, copy the new `rw` value across.
//
// In:  { event_type, claim_id, plate_number, station_name, place_in_line,
//        timestamp }
// Out: the same fields plus a ready-to-send `message`.

const TEMPLATES = {
  // notif.called — "It is your turn. Come to the station now with plate {plate}."
  called: 'Ugezeho. Ngwino kuri sitasiyo nonaha uzanye {plate}.',

  // notif.slipped — "You missed your turn. You are still in the queue, now number {place}."
  slipped_back: 'Warengejeho. Ukiri mu murongo, ubu uri nimero {place}.',

  // notif.noShow — "Your slot has expired. Take a new slot when you are ready."
  no_show: "Ukozeho byarangiye. Uzongere ufatireho undi murongo n'ubona ugeze hafi.",
};

return $input.all().map((item) => {
  // The Webhook node nests the POST body under .body, while a manual
  // execution or an upstream Set node may hand the fields over flat.
  const event = item.json.body ?? item.json;
  const template = TEMPLATES[event.event_type];

  if (!template) {
    // An unknown event type passes through instead of failing the run, so
    // adding an event to the backend cannot break a live workflow.
    return {
      json: {
        ...event,
        message: null,
        skipped: true,
        reason: 'no template for event_type: ' + event.event_type,
      },
    };
  }

  // place_in_line is null once a claim has left the line — a no_show has no
  // place — so it must never reach a rider as the word "null".
  const place =
    event.place_in_line === null || event.place_in_line === undefined
      ? '-'
      : String(event.place_in_line);

  const message = template
    .replace('{plate}', event.plate_number ?? '')
    .replace('{place}', place);

  return {
    json: {
      event_type: event.event_type,
      claim_id: event.claim_id,
      plate_number: event.plate_number,
      station_name: event.station_name,
      place_in_line: event.place_in_line ?? null,
      timestamp: event.timestamp,
      language: 'rw',
      message,
    },
  };
});
