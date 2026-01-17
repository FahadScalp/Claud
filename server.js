// server.js
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ===== In-memory event store (MVP) =====
let nextEventId = 1;
const events = []; // {event_id, group, type, master_ticket, symbol, cmd, lot, price, ts}
const MAX_EVENTS = 20000;

// Optional simple API key
const API_KEY = process.env.API_KEY || "";

// ===== ACK store (per slave) =====
// key: `${group}|${slaveId}` => lastAckEventId
const lastAckBySlave = new Map();

// ===== De-dup store for master pushes =====
// key: `${group}|${type}|${master_ticket}|${symbol}|${cmd}` => lastSeenTs
// reduces duplicate events if master sends same OPEN/CLOSE repeatedly
const dedup = new Map();
const DEDUP_TTL_MS = 30 * 1000; // 30 seconds

function nowMs() {
  return Date.now();
}

function authOk(req) {
  if (!API_KEY) return true;
  return req.get("x-api-key") === API_KEY;
}

function cleanDedup() {
  const t = nowMs();
  // lightweight cleanup: remove old keys occasionally
  // (called only when pushing)
  for (const [k, ts] of dedup.entries()) {
    if (t - ts > DEDUP_TTL_MS) dedup.delete(k);
  }
}

// Health
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    now: nowMs(),
    events: events.length,
    slaves: lastAckBySlave.size,
  })
);

// Master pushes events
app.post("/push", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const e = req.body || {};

  const group = String(e.group || "G1");
  const type = String(e.type || "");
  if (type !== "OPEN" && type !== "CLOSE") {
    return res.status(400).json({ ok: false, error: "type must be OPEN/CLOSE" });
  }

  const payload = {
    event_id: nextEventId++,
    group,
    type,
    master_ticket: Number(e.master_ticket || 0),
    symbol: String(e.symbol || ""),
    cmd: Number(e.cmd ?? -1), // OP_BUY=0, OP_SELL=1
    lot: Number(e.lot || 0),
    price: Number(e.price || 0),
    ts: nowMs(),
  };

  if (!payload.master_ticket || !payload.symbol || payload.cmd < 0) {
    return res.status(400).json({ ok: false, error: "missing fields" });
  }

  // ===== De-dup to avoid repeated OPEN/CLOSE from master =====
  // (does NOT replace ACK logic; just reduces noise)
  cleanDedup();
  const dk = `${payload.group}|${payload.type}|${payload.master_ticket}|${payload.symbol}|${payload.cmd}`;
  const lastTs = dedup.get(dk) || 0;
  if (payload.ts - lastTs <= DEDUP_TTL_MS) {
    // treat as duplicate; return ok without creating new event
    return res.json({ ok: true, duplicated: true });
  }
  dedup.set(dk, payload.ts);

  events.push(payload);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

  res.json({ ok: true, event_id: payload.event_id });
});

// Slave ACK: tell server "I processed event_id (success or fail) so don't resend"
app.post("/ack", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const group = String(b.group || "G1");
  const slaveId = String(b.slaveId || "S01");
  const event_id = Number(b.event_id || 0);

  if (!event_id) return res.status(400).json({ ok: false, error: "missing event_id" });

  const key = `${group}|${slaveId}`;
  const last = lastAckBySlave.get(key) || 0;
  if (event_id > last) lastAckBySlave.set(key, event_id);

  res.json({ ok: true, group, slaveId, last_ack: lastAckBySlave.get(key) || 0 });
});

// Slave polls events since last_event_id (and not ACKed for that slave)
app.get("/events", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const group = String(req.query.group || "G1");
  const slaveId = String(req.query.slaveId || "S01");
  const since = Number(req.query.since || 0);
  const limit = Math.min(Number(req.query.limit || 100), 500);

  const key = `${group}|${slaveId}`;
  const lastAck = lastAckBySlave.get(key) || 0;

  const out = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.group !== group) continue;
    if (e.event_id <= since) continue;
    if (e.event_id <= lastAck) continue; // 👈 prevents resend after ACK
    out.push(e);
    if (out.length >= limit) break;
  }

  res.json({ ok: true, group, slaveId, since, lastAck, count: out.length, events: out });
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Copier server listening on", port));
