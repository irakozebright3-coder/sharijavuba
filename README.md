# SharijaVuba

**SharijaVuba** ni urubuga rufasha abatwara moto n’abandi bakoresha serivisi ya bateri gufata umwanya mu murongo wa sitasiyo, no gufasha abakozi ba sitasiyo guhamagara abakiriya hakurikijwe uko umurongo uteye. Imigaragarire y’urubuga ishyizwe mu Kinyarwanda ku buryo busanzwe.

## Ibigize umushinga

- `rider-app/` — urubuga rw’umukoresha ufata umwanya mu murongo.
- `station-app/` — urubuga rw’umukozi wa sitasiyo ucunga umurongo.
- `strings.rw.js` na `strings.rw.json` — amagambo n’ubutumwa byahinduwe mu Kinyarwanda.
- `backend/` — seriveri ya Express na API.
- `backend/db/schema.sql` — imiterere y’imbonerahamwe zo muri PostgreSQL.
- `API.md` — ibisobanuro bya API n’amakuru ku nzira zayo.

## Gushyira imigaragarire kuri Vercel

1. Ohereza dosiye zose z’uyu mushinga kuri GitHub.
2. Muri Vercel, hitamo ububiko (repository) bukwiye, maze `Root Directory` uyishyire ku mizi y’umushinga; ntuyishyire kuri `backend`, `rider-app` cyangwa `station-app`.
3. Hitamo `Other` nka Framework Preset. Kuri aya mapaji ya HTML nta build command ikenewe.
4. Sohora deployment. Urubuga rw’umumotari rufunguka kuri `/` cyangwa `/rider`; urwa sitasiyo rufunguka kuri `/station`.

## Gushyira backend kuri seriveri no kuyihuza na Neon

Backend igomba gukora nka serivisi ya Node.js itandukanye n’imigaragarire iri kuri Vercel. Iyi mishinga ifite `render.yaml` igenewe Render.

1. Kora Web Service muri Render uhereye kuri repository, ushyire `Root Directory` kuri `backend`.
2. Build command: `npm ci`; start command: `npm start`.
3. Shyira `DATABASE_URL` muri Environment Variables za seriveri ukoresheje connection string ya Neon. **Ntushyire ijambo ry’ibanga cyangwa connection string y’ibanga muri GitHub.**
4. Muri `backend`, koresha `npm run migrate` kugira ngo utegure database ya Neon.
5. Shyira `FRONTEND_ORIGINS` ku aderesi nyayo ya Vercel, nta `/` ku mpera. Niba hari aderesi nyinshi, zitandukanye n’akabago koma.
6. Reba niba `https://ADERESI-YA-BACKEND/healthz` isubiza `ok: true`.

Porogaramu zombi zisanzwe zikoresha `https://sharijavuba-backend.onrender.com`. Niba backend yawe iri ahandi, hindura aderesi ya API mu mapaji yombi cyangwa ukoreshe query parameter `?api=https://ADERESI-YA-BACKEND`.

## Gukoresha kuri mudasobwa yawe

- Backend: `cd backend`, `npm ci`, tegura `.env` uhereye kuri `.env.example`, shyiramo `DATABASE_URL`, hanyuma ukore `npm run migrate` na `npm start`.
- Frontend: uhereye mu mizi y’umushinga koresha `node dev-server.mjs`, hanyuma ufungure `http://localhost:5173`.
- Ku igerageza gusa, ushobora gushyiraho `DEMO_DATABASE=true` muri environment ya backend kugira ngo ukoreshe ububiko bw’agateganyo bwo muri memory. Ntukoreshe ubu buryo ku makuru nyakuri yo mu kazi.

## Icyitonderwa

Uyu mushinga ushyira mu bikorwa uburyo bwo gufata no gucunga umurongo wo guhinduranya bateri. Gushyira urubuga kuri internet ntibivuze ko buri gitekerezo cy’inyongera cyamaze gushyirwa mu bikorwa. Reba `API.md` na `backend/README.md` ku bisobanuro bya tekiniki.
