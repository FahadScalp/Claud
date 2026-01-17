// server.js
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ===== Simple in-memory event store (MVP) =====
let nextEventId = 1;
const events = []; // {event_id, group, type, ... , ts}
const MAX_EVENTS = 20000;

// Optional simple API key
const API_KEY = process.env.API_KEY || "";

// Health
app.get("/health", (req, res) => res.json({ ok: true, now: Date.now(), events: events.length }));

// Master pushes events
app.post("/push", (req, res) => {
  if (API_KEY && req.get("x-api-key") !== API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const e = req.body || {};
  // required fields
  const group = String(e.group || "G1");
  const type = String(e.type || "");
  if (!type || (type !== "OPEN" && type !== "CLOSE")) {
    return res.status(400).json({ ok: false, error: "type must be OPEN/CLOSE" });
  }

  // Normalize payload
  const payload = {
    event_id: nextEventId++,
    group,
    type,
    master_ticket: Number(e.master_ticket || 0),
    symbol: String(e.symbol || ""),
    cmd: Number(e.cmd ?? -1),       // OP_BUY=0, OP_SELL=1
    lot: Number(e.lot || 0),
    price: Number(e.price || 0),
    ts: Date.now(),
  };

  if (!payload.master_ticket || !payload.symbol || payload.cmd < 0) {
    return res.status(400).json({ ok: false, error: "missing fields" });
  }

  events.push(payload);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

  res.json({ ok: true, event_id: payload.event_id });
});

// Slave polls events since last_event_id
app.get("/events", (req, res) => {
  const group = String(req.query.group || "G1");
  const since = Number(req.query.since || 0);
  const limit = Math.min(Number(req.query.limit || 100), 500);

  const out = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.group !== group) continue;
    if (e.event_id <= since) continue;
    out.push(e);
    if (out.length >= limit) break;
  }

  res.json({ ok: true, group, since, count: out.length, events: out });
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Copier server listening on", port));
