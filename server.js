// server.js
import express from "express";
import http from "http";
import WebSocket from "ws";
import fetch from "node-fetch";
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

let upstoxAccessToken = "";
let upstoxRefreshToken = "";
let tokenExpiresAt = 0;
let upstoxWS = null;
let clients = new Set();

let db;

// ===== Initialize DB and load tokens =====
(async function init() {
  db = await initDb();
  const saved = await loadTokens(db);
  if (saved) {
    upstoxAccessToken = saved.access_token;
    upstoxRefreshToken = saved.refresh_token;
    tokenExpiresAt = saved.expires_at;
    console.log("Loaded saved tokens from DB");
    // If token expired or near expiry, refresh now
    if (tokenExpiresAt - Math.floor(Date.now() / 1000) < 60) {
      await refreshAccessToken();
    } else {
      connectUpstoxWS();
    }
  } else {
    console.log("No saved tokens - perform OAuth flow to get tokens.");
  }

  // Periodic refresh check (every 45 seconds)
  setInterval(async () => {
    if (tokenExpiresAt && tokenExpiresAt - Math.floor(Date.now() / 1000) < 120) {
      await refreshAccessToken();
    }
  }, 45 * 1000);
})();

// ===== Helper: connect to Upstox WS =====
function connectUpstoxWS() {
  if (!upstoxAccessToken) {
    console.log("No access token - can't connect Upstox WS yet.");
    return;
  }
  if (upstoxWS && upstoxWS.readyState === WebSocket.OPEN) return;

  const url = `wss://api.upstox.com/v2/feed/market-data?Authorization=${upstoxAccessToken}`;
  console.log("Connecting to Upstox WS:", url);

  upstoxWS = new WebSocket(url);

  upstoxWS.on("open", () => {
    console.log("Connected to Upstox live feed ✅");
  });

  upstoxWS.on("message", (message) => {
    // Try parse JSON; if not JSON, forward raw string
    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch (err) {
      payload = message.toString();
    }
    // Broadcast to all connected frontend clients
    const out = JSON.stringify({ source: "upstox", data: payload });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(out);
    }
  });

  upstoxWS.on("close", (code, reason) => {
    console.log("Upstox WS closed:", code, reason?.toString?.() || reason);
    // try reconnect after delay
    setTimeout(() => connectUpstoxWS(), 5000);
  });

  upstoxWS.on("error", (err) => {
    console.error("Upstox WS error:", err && err.message ? err.message : err);
    try { upstoxWS.close(); } catch (_) {}
  });
}

// ===== Token refresh helper =====
async function refreshAccessToken() {
  if (!upstoxRefreshToken) {
    console.log("No refresh token available.");
    return;
  }
  try {
    const params = new URLSearchParams({
      client_id: process.env.UPSTOX_CLIENT_ID,
      client_secret: process.env.UPSTOX_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: upstoxRefreshToken,
      redirect_uri: process.env.UPSTOX_REDIRECT_URI || process.env.UPSTOX_REDIRECT_URI,
    });

    const resp = await fetch(UPSTOX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const data = await resp.json();
    if (data.access_token) {
      upstoxAccessToken = data.access_token;
      upstoxRefreshToken = data.refresh_token || upstoxRefreshToken;
      tokenExpiresAt = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);
      await saveTokens(db, { access_token: upstoxAccessToken, refresh_token: upstoxRefreshToken, expires_in: data.expires_in });
      console.log("Refreshed Upstox access token");
      // Reconnect WS if needed
      if (!upstoxWS || upstoxWS.readyState !== WebSocket.OPEN) connectUpstoxWS();
    } else {
      console.error("Failed to refresh token:", data);
    }
  } catch (err) {
    console.error("Error refreshing token:", err);
  }
}

// ===== OAuth callback (authorization_code) =====
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
    if (!data.access_token) {
      console.error("Token exchange failed:", data);
      return res.status(500).send("Token exchange failed - check server logs.");
    }

    upstoxAccessToken = data.access_token;
    upstoxRefreshToken = data.refresh_token || "";
    tokenExpiresAt = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);

    await saveTokens(db, { access_token: upstoxAccessToken, refresh_token: upstoxRefreshToken, expires_in: data.expires_in });

    // connect WS now that we have token
    connectUpstoxWS();

    res.send("Access token saved. You may close this window.");
  } catch (err) {
    console.error("Auth callback error:", err);
    res.status(500).send("Auth callback error - check logs.");
  }
});

// ===== REST example: fetch single LTP =====
app.get("/api/ltp", async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: "Missing symbol query param. Example: NSE_EQ|RELIANCE" });
    if (!upstoxAccessToken) return res.status(400).json({ error: "No access token. Complete OAuth first." });

    const fullUrl = UPSTOX_LTP_URL + encodeURIComponent(symbol);
    const resp = await fetch(fullUrl, {
      headers: { Authorization: `Bearer ${upstoxAccessToken}` },
    });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error("LTP fetch error:", err);
    res.status(500).json({ error: "Failed to fetch LTP" });
  }
});

// ===== Simple status route =====
app.get("/", (req, res) => res.send("StockHub backend running"));

// ===== HTTP server + WebSocket server for frontend clients =====
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/live" });

wss.on("connection", (ws, req) => {
  console.log("Frontend client connected");
  clients.add(ws);

  ws.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      // Example: { action: 'subscribe', symbols: ['NSE_EQ|RELIANCE'] }
      if (parsed.action === "subscribe" && Array.isArray(parsed.symbols)) {
        if (upstoxWS && upstoxWS.readyState === WebSocket.OPEN) {
          const out = JSON.stringify({ action: "subscribe", symbols: parsed.symbols });
          upstoxWS.send(out);
          ws.send(JSON.stringify({ ok: true, info: "Subscription forwarded to Upstox" }));
        } else {
          ws.send(JSON.stringify({ ok: false, error: "Upstox WS not connected yet" }));
        }
      } else {
        // Optionally handle other actions or echo
        ws.send(JSON.stringify({ echo: parsed }));
      }
    } catch (e) {
      console.log("Invalid frontend message:", msg.toString());
      ws.send(JSON.stringify({ error: "Invalid message format" }));
    }
  });

  ws.on("close", () => {
    console.log("Frontend client disconnected");
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
