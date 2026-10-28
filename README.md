# SharijaVuba

**SharijaVuba** ni urubuga rufasha abatwara moto n’abandi bakoresha serivisi ya bateri gufata umwanya mu murongo wa sitasiyo, no gufasha abakozi ba sitasiyo guhamagara abakiriya hakurikijwe uko umurongo uteye. Imigaragarire y’urubuga ishyizwe mu Kinyarwanda ku buryo busanzwe.

## Ibigize umushinga

- `rider-app/` — urubuga rw’umukoresha ufata umwanya mu murongo.
- `station-app/` — urubuga rw’umukozi wa sitasiyo ucunga umurongo.
- `strings.rw.js` na `strings.rw.json` — amagambo n’ubutumwa byahinduwe mu Kinyarwanda.
- `backend/` — Express na API, na yo itanga imigaragarire yombi. `backend/app.js`
  ni routes; `backend/server.js` ni iyo app itangira kuri seriveri isanzwe
  (Render cyangwa mudasobwa yawe).
- `api/[...path].js` — iyo app nyine itangira nka function imwe ya Vercel, ku
  murongo `/api/*`. Icyo ni cyo gituma ikintu kimwe gihagije kuri Vercel.
- `backend/db/schema.sql` — imiterere y’imbonerahamwe zo muri PostgreSQL.
- `API.md` — ibisobanuro bya API n’amakuru ku nzira zayo.

## Gushyira kuri Render

Serivisi imwe, URL imwe: `backend/app.js` itanga imigaragarire yombi na API.
Umusomyi (browser) ahura n'urubuga rumwe gusa, bityo CORS ntikiboneka, kandi
nta `?api=` ikenewe.

1. Muri Render: **New → Blueprint**, uhitemo repository ya GitHub ya
   `sharijavuba`. Render isoma `render.yaml` yikorera: root directory ni mizi
   y'umushinga, build `npm ci`, start `npm start`.
   - Niba utifuza Blueprint: **New → Web Service**, Root Directory = mizi
     y'umushinga (ntuyishyire kuri `backend`), Build Command `npm ci`, Start
     Command `npm start`, Health Check Path `/api/healthz`.
2. Shyiraho `DATABASE_URL`: connection string ya Neon. Ntukoreshe PostgreSQL
   y'ubuntu ya Render: iyo irangira nyuma y'iminsi 30.
3. Deploy. Ufungura:
   - `/rider` — urubuga rw'umumotari.
   - `/station` — urubuga rwa sitasiyo.
   - `/api/healthz` — kugenzura ko API na database bihuye (`database:
     postgres`).
4. Migration ikorwa rimwe gusa, ku mudasobwa yawe: `npm install`, hanyuma
   `DATABASE_URL=... npm run migrate`.

Icyitonderwa ku gahunda y'ubuntu (free plan): serivisi ihagarara nyuma
y'iminota 15 ntawakoresheje urubuga, kandi ikoresha amasegonda 30-50 kubyuka.
Uwagenda kuyifungura abanza abona gutegereza gato; nyuma y'ibyo, sitasiyo
isaba API buri masegonda atatu, bityo iguma izamuye igihe hari uwuyikoresha.
Ushaka ko itazima na rimwe: hindura plan ujye kuri Starter.

Iyo `DATABASE_URL` itabonetse, API ntihagarara: ikoresha ububiko bwo muri
memory (demo). `GET /api/healthz` ni yo ibivuga.

## Ubundi buryo: Vercel

Kuri Vercel, iyi app nyine itangira nka function imwe (`api/[...path].js`), ari
yo ituma ikintu kimwe gihagije: `Root Directory` = mizi y'umushinga,
`Framework Preset` = Other, build command na output directory bibaye ubusa,
`DATABASE_URL` mu Environment Variables. Icyo ni cyo gituma `/api/*` na yo
isubizwa (reba munsi).

## Kwerekana API ahandi hantu

API isubizwa ku nzira ebyiri: ku murongo wa mizi (`/stations`, nk'uko `API.md`
na `USSD` bikoresha) no munsi ya `/api` (`/api/stations`, nk'uko imigaragarire
izikoresha). Niba ushaka gukoresha backend iri ahandi (Vercel, cyangwa
mudasobwa iri kuri LAN), imigaragarire zishobora kuyerekwa ahandi:
`https://ADERESI-YA-FRONTEND/rider?api=https://ADERESI-YA-BACKEND`.

## Gukoresha kuri mudasobwa yawe

- `npm install` rimwe uhereye mu mizi y’umushinga.
- Backend: tegura `.env` uhereye kuri `backend/.env.example`, shyiramo
  `DATABASE_URL`, hanyuma ukore `npm run migrate` na `npm start` (API kuri
  `http://localhost:3000`).
- Imigaragarire: `npm start` irazitanga kuri `http://localhost:3000/rider` na
  `http://localhost:3000/station`, ku murongo umwe na API.
- Ku igerageza gusa, ushobora gushyiraho `DEMO_DATABASE=true` muri environment ya backend kugira ngo ukoreshe ububiko bw’agateganyo bwo muri memory. Ntukoreshe ubu buryo ku makuru nyakuri yo mu kazi.

## Icyitonderwa

Uyu mushinga ushyira mu bikorwa uburyo bwo gufata no gucunga umurongo wo guhinduranya bateri. Gushyira urubuga kuri internet ntibivuze ko buri gitekerezo cy’inyongera cyamaze gushyirwa mu bikorwa. Reba `API.md` na `backend/README.md` ku bisobanuro bya tekiniki.
