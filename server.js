// stockhub-backend - minimal ws + express server
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';
const BROADCAST_INTERVAL_MS = process.env.BROADCAST_INTERVAL_MS ? Number(process.env.BROADCAST_INTERVAL_MS) : 1000;

const app = express();
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS === '*' || ALLOWED_ORIGINS.split(',').map(s => s.trim()).includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'), false);
  }
};
app.use(cors(corsOptions));

app.get('/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));
app.get('/', (req, res) => res.send('StockHub backend running'));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Helper: generate history (1-min candles)
function generateHistory(len = 300, startPrice = 4200) {
  const candles = [];
  let lastClose = startPrice;
  const now = Math.floor(Date.now() / 1000);
  for (let i = len - 1; i >= 0; i--) {
    const time = now - i * 60;
    const open = lastClose;
    const change = (Math.random() - 0.5) * 4;
    const close = Math.max(1, +(open + change).toFixed(2));
    const high = +(Math.max(open, close) + Math.random() * 2).toFixed(2);
    const low = +(Math.min(open, close) - Math.random() * 2).toFixed(2);
    candles.push({ time, open, high, low, close });
    lastClose = close;
  }
  return candles;
}

let history = generateHistory(300, process.env.START_PRICE ? Number(process.env.START_PRICE) : 4200);
let lastPrice = history.length ? history[history.length - 1].close : (process.env.START_PRICE ? Number(process.env.START_PRICE) : 4200);

function broadcastJSON(obj) {
  const raw = JSON.stringify(obj);
  wss.clients.forEach(client => {
    if (client.readyState === client.OPEN) client.send(raw);
  });
}

wss.on('connection', (ws, req) => {
  console.log('WS client connected', req.socket.remoteAddress);
  // send current history
  ws.send(JSON.stringify({ type: 'history', candles: history }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data?.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    } catch (e) { /* ignore */ }
  });

  ws.on('close', () => {
    console.log('WS client disconnected');
  });
});

// shared tick loop
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  lastPrice = +(lastPrice + (Math.random() - 0.5) * 2).toFixed(2);
  const tick = { type: 'tick', time: now, price: lastPrice };
  broadcastJSON(tick);

  const minute = Math.floor(now / 60) * 60;
  const lastCandle = history[history.length - 1];
  if (!lastCandle || lastCandle.time !== minute) {
    const newCandle = { time: minute, open: lastPrice, high: lastPrice, low: lastPrice, close: lastPrice };
    history.push(newCandle);
    if (history.length > 2000) history.shift();
    broadcastJSON({ type: 'new_candle', candle: newCandle });
  } else {
    lastCandle.high = Math.max(lastCandle.high, lastPrice);
    lastCandle.low = Math.min(lastCandle.low, lastPrice);
    lastCandle.close = lastPrice;
    broadcastJSON({ type: 'update_candle', candle: lastCandle });
  }
}, BROADCAST_INTERVAL_MS);

// graceful
function shutdown() {
  console.log('Shutting down...');
  wss.close(() => server.close(() => process.exit(0)));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
  console.log(`/health available`);
});
