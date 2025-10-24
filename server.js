// server.js
// Node 18+ required (uses global fetch). Uses token_store.js for SQLite persistence.
import express from "express";
import http from "http";
import WebSocket from "ws";
import dotenv from "dotenv";
import cors from "cors";
import { initDb, saveTokens, loadTokens } from "./token_store.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const UPSTOX_TOKEN_URL = "https://api.upstox.com/v2/login/authorization/token";
const UPSTOX_LTP_URL = "https://api.upstox.com/v2/market-quote/ltp?symbol=";

let db;
let upstoxAccessToken = "";
let upstoxRefreshToken = "";
let tokenExpiresAt = 0; // epoch seconds
let upstoxWS = null;
const frontendClients = new Set(); // connected browser clients (ws)
let reconnectTimer = null;

// Helper to log with prefix
function log(...args) { console.log("[stockhub]", ...args); }
function logErr(...args) { console.error("[stockhub][ERR]", ...args); }

// Initialize DB, load tokens, and start refresh loop
(async function init() {
  try {
    db = await initDb();
    const saved = await loadTokens(db);
    if (saved) {
      upstoxAccessToken = saved.access_token || "";
      upstoxRefreshToken = saved.refresh_token || "";
      tokenExpiresAt = saved.expires_at || 0;
      log("Loaded tokens from DB. Expires at:", tokenExpiresAt);
      // If token near expiry, refresh; else connect WS
      if (tokenExpiresAt - Math.floor(Date.now() / 1000) < 60) {
        await refreshAccessToken();
      } else {
        connectUpstoxWS();
      }
    } else {
      log("No saved tokens found. Perform OAuth to populate tokens.");
    }

    // Periodic check to refresh token when near expiry (runs every 45s)
    setInterval(async () => {
      try {
        if (tokenExpiresAt && tokenExpiresAt - Math.floor(Date.now() / 1000) < 120) {
          await refreshAccessToken();
        }
      } catch (e) {
        logErr("Periodic refresh error", e);
      }
    }, 45 * 1000);
  } catch (e) {
    logErr("Init error", e);
    process.exit(1);
  }
})();

// ===== Upstox WebSocket connection & forwarding =====
function connectUpstoxWS() {
  if (!upstoxAccessToken) {
    log("No access token available yet — skipping Upstox WS connect");
    return;
  }

  // Prevent multiple simultaneous connect attempts
  if (upstoxWS && upstoxWS.readyState === WebSocket.OPEN) {
    log("Upstox WS already connected");
    return;
  }

  const url = `wss://api.upstox.com/v2/feed/market-data?Authorization=${upstoxAccessToken}`;
  log("Connecting to Upstox WS:", url);

  // clear any previous timer
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  upstoxWS = new WebSocket(url);

  upstoxWS.on("open", () => {
    log("Connected to Upstox live feed ✅");
  });

  upstoxWS.on("message", (message) => {
    // Try to parse JSON; if not JSON, forward raw string
    let parsed;
    try { parsed = JSON.parse(message.toString()); } catch (e) { parsed = message.toString(); }

    // Wrap and broadcast to frontend clients so UI can handle consistent format
    const payload = JSON.stringify({ source: "upstox", data: parsed });
    for (const ws of frontendClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  });

  upstoxWS.on("close", (code, reason) => {
    log("Upstox WS closed:", code, reason?.toString?.() || reason);
    // Attempt reconnect after a short delay
    reconnectTimer = setTimeout(() => {
      log("Reconnecting to Upstox WS...");
      connectUpstoxWS();
    }, 5000);
  });

  upstoxWS.on("error", (err) => {
    logErr("Upstox WS error:", err && err.message ? err.message : err);
    try { upstoxWS.close(); } catch (_) {}
  });
}

// If we need to forward subscription messages to Upstox
function forwardSubscriptionToUpstox(symbols = []) {
  if (!Array.isArray(symbols) || symbols.length === 0) return false;
  if (upstoxWS && upstoxWS.readyState === WebSocket.OPEN) {
    try {
      // Upstox expects a certain subscribe payload — here we forward a generic JSON.
      // Adjust format if Upstox expects a specific message shape.
      const out = JSON.stringify({ action: "subscribe", symbols });
      upstoxWS.send(out);
      return true;
    } catch (e) {
      logErr("Failed to forward subscription:", e);
      return false;
    }
  } else {
    return false;
  }
}

// ===== Token refresh helper =====
async function refreshAccessToken() {
  if (!upstoxRefreshToken) {
    log("No refresh token available to refresh access token");
    return;
  }
  try {
    const params = new URLSearchParams({
      client_id: process.env.UPSTOX_CLIENT_ID,
      client_secret: process.env.UPSTOX_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: upstoxRefreshToken,
      redirect_uri: process.env.UPSTOX_REDIRECT_URI,
    });

    const resp = await fetch(UPSTOX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const data = await resp.json();
    if (data && data.access_token) {
      upstoxAccessToken = data.access_token;
      upstoxRefreshToken = data.refresh_token || upstoxRefreshToken;
      tokenExpiresAt = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);
      await saveTokens(db, { access_token: upstoxAccessToken, refresh_token: upstoxRefreshToken, expires_in: data.expires_in });
      log("Refreshed Upstox access token and saved to DB");

      // Reconnect WS to use new token
      if (!upstoxWS || upstoxWS.readyState !== WebSocket.OPEN) connectUpstoxWS();
    } else {
      logErr("Refresh token response did not contain access_token:", data);
    }
  } catch (e) {
    logErr("Error refreshing access token:", e);
  }
}

// ===== OAuth callback: exchange code for tokens =====
app.get("/auth/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Missing code query param");

    const params = new URLSearchParams({
      code,
      client_id: process.env.UPSTOX_CLIENT_ID,
      client_secret: process.env.UPSTOX_CLIENT_SECRET,
      redirect_uri: process.env.UPSTOX_REDIRECT_URI,
      grant_type: "authorization_code",
    });

    const response = await fetch(UPSTOX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const data = await response.json();
    if (!data || !data.access_token) {
      logErr("Token exchange failed:", data);
      return res.status(500).send("Token exchange failed - check server logs");
    }

    upstoxAccessToken = data.access_token;
    upstoxRefreshToken = data.refresh_token || "";
    tokenExpiresAt = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);

    await saveTokens(db, { access_token: upstoxAccessToken, refresh_token: upstoxRefreshToken, expires_in: data.expires_in });
    log("Access token saved to DB via /auth/callback");

    // Start WS connection now that we have token
    connectUpstoxWS();

    res.send("Access token saved. You can close this window.");
  } catch (err) {
    logErr("Auth callback error:", err);
    res.status(500).send("Auth callback error - check server logs");
  }
});

// ===== Example REST: fetch LTP via Upstox REST =====
app.get("/api/ltp", async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: "Missing symbol query param. Example: NSE_EQ|RELIANCE" });
    if (!upstoxAccessToken) return res.status(400).json({ error: "No access token. Complete OAuth first." });

    const fullUrl = UPSTOX_LTP_URL + encodeURIComponent(symbol);
    const resp = await fetch(fullUrl, { headers: { Authorization: `Bearer ${upstoxAccessToken}` } });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    logErr("LTP fetch error:", err);
    res.status(500).json({ error: "Failed to fetch LTP" });
  }
});

// ===== Health / status =====
app.get("/", (req, res) => {
  res.send("StockHub backend running");
});

app.get("/status", (req, res) => {
  res.json({
    upstox_ws_connected: !!(upstoxWS && upstoxWS.readyState === WebSocket.OPEN),
    access_token_present: !!upstoxAccessToken,
    token_expires_at: tokenExpiresAt,
  });
});

// ===== HTTP server + /live WebSocket server for frontends =====
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/live" });

wss.on("connection", (ws, req) => {
  log("Frontend client connected");
  frontendClients.add(ws);

  ws.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      // Support: { action: 'subscribe', symbols: ['NSE_EQ|RELIANCE'] }
      if (parsed.action === "subscribe" && Array.isArray(parsed.symbols)) {
        const ok = forwardSubscriptionToUpstox(parsed.symbols);
        if (ok) ws.send(JSON.stringify({ ok: true, info: "Subscription forwarded to Upstox" }));
        else ws.send(JSON.stringify({ ok: false, error: "Upstox WS not connected yet" }));
        return;
      }

      // Allow backend-level requests: e.g. client can ask for a REST LTP via backend
      if (parsed.action === "ltp" && parsed.symbol) {
        (async () => {
          try {
            const resp = await fetch(UPSTOX_LTP_URL + encodeURIComponent(parsed.symbol), {
              headers: { Authorization: `Bearer ${upstoxAccessToken}` },
            });
            const j = await resp.json();
            ws.send(JSON.stringify({ type: "ltp_response", symbol: parsed.symbol, data: j }));
          } catch (e) {
            ws.send(JSON.stringify({ type: "ltp_response", error: "failed" }));
          }
        })();
        return;
      }

      // Unknown message -> echo back
      ws.send(JSON.stringify({ echo: parsed }));
    } catch (e) {
      logErr("Invalid message from frontend:", e);
      ws.send(JSON.stringify({ error: "Invalid message format" }));
    }
  });

  ws.on("close", () => {
    log("Frontend client disconnected");
    frontendClients.delete(ws);
  });

  ws.on("error", (e) => {
    logErr("Frontend WS error:", e);
    frontendClients.delete(ws);
    try { ws.close(); } catch (_) {}
  });
});

server.listen(PORT, () => {
  log(`Server listening on port ${PORT}`);
});
