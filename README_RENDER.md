# StockHub Backend - Render deploy

1. Push this repo to GitHub (branch `main`).
2. Create a new Web Service on Render -> Connect the repo -> Branch `main`.
3. Build command: `npm install`
4. Start command: `npm start`
5. Set env vars in Render:
   - `ALLOWED_ORIGINS` = `https://<your-infinity-domain>` (or `*` for testing)
   - `BROADCAST_INTERVAL_MS` = `1000`
   - (optional) `START_PRICE` = `4200`
6. Deploy. Note the service url: e.g. `https://stockhub-backend.onrender.com`
7. Health check: `https://<service>/health`
