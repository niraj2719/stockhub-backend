// server.js
import express from "express";
import WebSocket from "ws";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8080;

let accessToken = "";

// ====== Step 1: Get access token after manual auth ======
app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  const response = await fetch("https://api.upstox.com/v2/login/authorization/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.UPSTOX_CLIENT_ID,
      client_secret: process.env.UPSTOX_CLIENT_SECRET,
      redirect_uri: "https://stockhub-backend-b142.onrender.com/auth/callback",
      grant_type: "authorization_code",
    }),
  });
  const data = await response.json();
  accessToken = data.access_token;
  res.send("Access token saved. You can now connect WebSocket for live data.");
});

// ====== Step 2: WebSocket live feed ======
let wsClient = null;
function connectWS() {
  wsClient = new WebSocket(`wss://api.upstox.com/v2/feed/market-data?Authorization=${accessToken}`);
  wsClient.on("open", () => console.log("Connected to Upstox live feed ✅"));
  wsClient.on("message", (msg) => console.log("Market Data:", msg.toString()));
  wsClient.on("close", () => {
    console.log("Reconnecting...");
    setTimeout(connectWS, 5000);
  });
}

// ====== Step 3: Express server ======
app.get("/", (req, res) => {
  res.send("StockHub backend running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
