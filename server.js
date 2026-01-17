// server.js
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

let nextEventId = 1;
const events = [];
const MAX_EVENTS = 20000;

const API_KEY = process.env.API_KEY || "";

// ACK per slave: `${group}|${slaveId}` -> lastAckEventId
const lastAckBySlave = new Map();

// HARD idempotency per master_ticket: `${group}|${master_ticket}` -> { open:bool, lastType, ts }
const ticketState = new Map();

function nowMs() { return Date.now(); }
function authOk(req) {
  if (!API_KEY) return true;
  return req.get("x-api-key") === API_KEY;
}

app.get("/health", (req, res) =>
  res.json({
    ok: true,
    now: nowMs(),
    events: events.length,
    slaves: lastAckBySlave.size,
    tickets: ticketState.size,
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

  const master_ticket = Number(e.master_ticket || 0);
  const symbol = String(e.symbol || "");
  const cmd = Number(e.cmd ?? -1);
  const lot = Number(e.lot || 0);
  const price = Number(e.price || 0);

  if (!master_ticket || !symbol || cmd < 0) {
    return res.status(400).json({ ok: false, error: "missing fields" });
  }

  const tkey = `${group}|${master_ticket}`;
  const st = ticketState.get(tkey) || { open: false, lastType: "", ts: 0 };

  // ===== HARD anti-duplicate logic =====
  if (type === "OPEN") {
    if (st.open === true) {
      // already opened, ignore duplicate OPEN
      return res.json({ ok: true, duplicated: true, reason: "OPEN_ALREADY" });
    }
    // accept OPEN
    st.open = true;
    st.lastType = "OPEN";
    st.ts = nowMs();
    ticketState.set(tkey, st);
  } else { // CLOSE
    if (st.open === false) {
      // CLOSE without OPEN: ignore (or accept if you want)
      return res.json({ ok: true, duplicated: true, reason: "CLOSE_WITHOUT_OPEN" });
    }
    if (st.lastType === "CLOSE") {
      // duplicate CLOSE
      return res.json({ ok: true, duplicated: true, reason: "CLOSE_ALREADY" });
    }
    // accept CLOSE
    st.open = false;
    st.lastType = "CLOSE";
    st.ts = nowMs();
    ticketState.set(tkey, st);
  }

  const payload = {
    event_id: nextEventId++,
    group,
    type,
    master_ticket,
    symbol,
    cmd,
    lot,
    price,
    ts: nowMs(),
  };

  events.push(payload);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

  res.json({ ok: true, event_id: payload.event_id });
});

// Slave ACK
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

// Slave polls events (filtered by ACK)
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
    const ev = events[i];
    if (ev.group !== group) continue;
    if (ev.event_id <= since) continue;
    if (ev.event_id <= lastAck) continue;
    out.push(ev);
    if (out.length >= limit) break;
  }

  res.json({ ok: true, group, slaveId, since, lastAck, count: out.length, events: out });
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Copier server listening on", port));
