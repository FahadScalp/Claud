// server.js (UID + OPEN_TIME version) - OPEN/CLOSE only
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

let nextEventId = 1;
const events = []; // {event_id, group, type, uid, open_time, master_ticket, symbol, cmd, lot, price, ts}
const MAX_EVENTS = 20000;

const API_KEY = process.env.API_KEY || "";

// ACK per slave: `${group}|${slaveId}` -> lastAckEventId
const lastAckBySlave = new Map();

// HARD idempotency per UID: `${group}|${uid}` -> { open:boolean, lastType:"OPEN"/"CLOSE", ts }
const uidState = new Map();

function nowMs() { return Date.now(); }

function authOk(req) {
  if (!API_KEY) return true;
  return req.get("x-api-key") === API_KEY;
}

// Health
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    now: nowMs(),
    events: events.length,
    slaves: lastAckBySlave.size,
    uids: uidState.size,
  })
);

// Master pushes events (OPEN/CLOSE)
app.post("/push", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const e = req.body || {};
  const group = String(e.group || "G1");
  const type = String(e.type || "");

  if (type !== "OPEN" && type !== "CLOSE") {
    return res.status(400).json({ ok: false, error: "type must be OPEN/CLOSE" });
  }

  const master_ticket = Number(e.master_ticket || 0);
  const open_time = Number(e.open_time || 0);
  let uid = String(e.uid || "");

  const symbol = String(e.symbol || "");
  const cmd = Number(e.cmd ?? -1);
  const lot = Number(e.lot || 0);
  const price = Number(e.price || 0);

  // uid fallback if missing
  if (!uid && master_ticket > 0 && open_time > 0) {
    uid = `${master_ticket}_${open_time}`;
  }

  // Validate fields
  if (!uid || !master_ticket || !symbol || cmd < 0 || !open_time) {
    return res.status(400).json({ ok: false, error: "missing fields (need uid, open_time, master_ticket, symbol, cmd)" });
  }

  const ukey = `${group}|${uid}`;
  const st = uidState.get(ukey) || { open: false, lastType: "", ts: 0 };

  // ===== HARD anti-duplicate logic by UID =====
  if (type === "OPEN") {
    if (st.open === true) {
      return res.json({ ok: true, duplicated: true, reason: "OPEN_ALREADY", uid });
    }
    st.open = true;
    st.lastType = "OPEN";
    st.ts = nowMs();
    uidState.set(ukey, st);
  } else { // CLOSE
    if (st.open === false) {
      return res.json({ ok: true, duplicated: true, reason: "CLOSE_WITHOUT_OPEN", uid });
    }
    if (st.lastType === "CLOSE") {
      return res.json({ ok: true, duplicated: true, reason: "CLOSE_ALREADY", uid });
    }
    st.open = false;
    st.lastType = "CLOSE";
    st.ts = nowMs();
    uidState.set(ukey, st);
  }

  const payload = {
    event_id: nextEventId++,
    group,
    type,
    uid,
    open_time,
    master_ticket,
    symbol,
    cmd,
    lot,
    price,
    ts: nowMs(),
  };

  events.push(payload);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

  res.json({ ok: true, event_id: payload.event_id, uid });
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
