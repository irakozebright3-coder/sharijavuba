# SharijaVuba

**SharijaVuba** ni urubuga rufasha abatwara moto n’abandi bakoresha serivisi ya bateri gufata umwanya mu murongo wa sitasiyo, no gufasha abakozi ba sitasiyo guhamagara abakiriya hakurikijwe uko umurongo uteye. Imigaragarire y’urubuga ishyizwe mu Kinyarwanda ku buryo busanzwe.

## Ibigize umushinga

- `rider-app/` — urubuga rw’umukoresha ufata umwanya mu murongo.
- `station-app/` — urubuga rw’umukozi wa sitasiyo ucunga umurongo.
- `strings.rw.js` na `strings.rw.json` — amagambo n’ubutumwa byahinduwe mu Kinyarwanda.
- `backend/` — Express na API. `backend/app.js` ni routes; `backend/server.js`
  ni iyo app itangira kuri seriveri isanzwe (Render cyangwa mudasobwa yawe).
- `api/[...path].js` — iyo app nyine itangira nka function imwe ya Vercel, ku
  murongo `/api/*`. Icyo ni cyo gituma ikintu kimwe gihagije kuri Vercel.
- `backend/db/schema.sql` — imiterere y’imbonerahamwe zo muri PostgreSQL.
- `API.md` — ibisobanuro bya API n’amakuru ku nzira zayo.

## Gushyira kuri Vercel

Uyu mushinga ubu uhetse ikintu kimwe: imigaragarire ni dosiye zisanzwe, na API
ni function imwe ya Vercel iri muri `api/[...path].js`. Nta build command
ikenewe kandi nta backend ya kabiri igomba gutangira.

1. Muri Vercel, hitamo **Add New → Project**, uhitemo repository ya GitHub ya
   `sharijavuba`.
2. `Root Directory`: reka ku mizi y’umushinga. Ntuyishyire kuri `backend`,
   `rider-app` cyangwa `station-app`.
3. `Framework Preset`: **Other**. Build Command na Output Directory: reka
   ubusa.
4. Muri **Environment Variables**, shyiraho:
   - `DATABASE_URL` — connection string ya Neon (koresha iya `-pooler` kubera
     ko function zisaba kugabana connections).
   - `FRONTEND_ORIGINS` — ntibisabwa iyo imigaragarire na API biri kuri domain
     imwe. Shyiraho gusa niba hari urubuga rundi rukoresha API.
   - `N8N_WEBHOOK_URL` — uhitamo, nta gahunda iba ihindutse niba itabonetse.
   - `CRON_SECRET` — uhitamo. Igihe kiriho, `POST /api/cron/sweep` isaba
     `Authorization: Bearer <CRON_SECRET>`; itarishyizweho ihita iba ifunze.
5. Kora migration ku mudasobwa yawe uhuye na Neon (Vercel ntisaba kuyikora):
   `npm install` hanyuma `npm run migrate` ifite `DATABASE_URL` mu `.env`.
6. Deploy. Hanyuma ufungure:
   - `/rider` — urubuga rw’umumotari.
   - `/station` — urubuga rwa sitasiyo.
   - `/api/healthz` — kugenzura ko API na database bihuye (`database:
     postgres`).

Iyo `DATABASE_URL` itabonetse, API ntihagarara: ikoresha ububiko bwo muri
memory (demo). Ni nziza ku igerageza, ariko kuri Vercel buri instance ifite
ubwabo bubiko, nta makuru asangirwa kandi ntayagumaho. `GET /api/healthz` ni
yo ibivuga.

Imigaragarire zombi zikoresha API iri kuri domain imwe, munsi ya `/api`. Niba
backend iri ahandi (Render, cyangwa mudasobwa iri kuri LAN), zishobora
kuyerekwa ahandi hantu: `https://ADERESI-YA-FRONTEND/rider?api=https://ADERESI-YA-BACKEND`.

## Ubundi buryo: backend kuri Render

Niba ushaka API ya Node isanzwe itandukanye n’imigaragarire, `render.yaml` na
`backend/package.json` biracyahari kandi bikora nk’mbere. Noneho uhuza
imigaragarire na backend ukoresheje `?api=`. Ubu buryo ntibukenewe kuri Vercel.

## Gukoresha kuri mudasobwa yawe

- `npm install` rimwe uhereye mu mizi y’umushinga.
- Backend: tegura `.env` uhereye kuri `backend/.env.example`, shyiramo
  `DATABASE_URL`, hanyuma ukore `npm run migrate` na `npm start` (API kuri
  `http://localhost:3000`).
- Frontend: `npm run dev`, hanyuma ufungure `http://localhost:5173`. Iyo
  uyifunguye uturutse kuri aderesi ya LAN, shyiraho `?api=http://ADERESI:3000`.
- Ku igerageza gusa, ushobora gushyiraho `DEMO_DATABASE=true` muri environment ya backend kugira ngo ukoreshe ububiko bw’agateganyo bwo muri memory. Ntukoreshe ubu buryo ku makuru nyakuri yo mu kazi.

## Icyitonderwa

Uyu mushinga ushyira mu bikorwa uburyo bwo gufata no gucunga umurongo wo guhinduranya bateri. Gushyira urubuga kuri internet ntibivuze ko buri gitekerezo cy’inyongera cyamaze gushyirwa mu bikorwa. Reba `API.md` na `backend/README.md` ku bisobanuro bya tekiniki.
