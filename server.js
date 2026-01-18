import express from "express";
import cors from "cors";

// ===================== App =====================
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const API_KEY = process.env.API_KEY || ""; // optional
const DEBUG = String(process.env.DEBUG || "") === "1";

function authOk(req) {
  if (!API_KEY) return true;
  return req.get("x-api-key") === API_KEY;
}

function nowMs() {
  return Date.now();
}

// ===================== Dashboard stores =====================
// accountId -> { accountId, name, login, server, ts, balance, equity, margin, free, leverage, currency, orders:[], stats:{} }
const accounts = new Map();
// accountId -> { id, type:"PANIC_CLOSE", target:"ALL", ts, status:"NEW|DONE|ERR", errMsg }
const commands = new Map();
let nextCmdId = 1;

// ===================== Copier stores =====================
let nextEventId = 1;
const events = [];
const MAX_EVENTS = 20000;
const eventById = new Map(); // event_id -> event

// ACK per slave: `${group}|${slaveId}` -> lastAckEventId
const lastAckBySlave = new Map();
// Known slaves per group (registered via /copier/events or /copier/ack)
const groupSlaves = new Map(); // group -> Set(slaveId)

// State per uid: `${group}|${uid}` -> { open:boolean, master_ticket:number, open_time:number, openSlaves:Set, closeSlaves:Set, lastType:string, ts:number }
const uidState = new Map();

function regSlave(group, slaveId) {
  const g = String(group || "G1");
  const s = String(slaveId || "S01");
  if (!groupSlaves.has(g)) groupSlaves.set(g, new Set());
  groupSlaves.get(g).add(s);
}

function countSlaves(group) {
  const set = groupSlaves.get(String(group || "G1"));
  return set ? set.size : 0;
}

function debug(...args) {
  if (DEBUG) console.log(...args);
}

// ===================== Health =====================
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    now: nowMs(),
    accounts: accounts.size,
    commands: commands.size,
    copier: {
      next_event_id: nextEventId,
      events: events.length,
      slaves: lastAckBySlave.size,
      uids: uidState.size,
      groups: groupSlaves.size,
    },
  });
});

// ===================== Dashboard API =====================
// Agent -> report status + orders
app.post("/report", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const accountId = String(b.accountId || "");
  if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });

  const payload = {
    accountId,
    name: String(b.name || ""),
    login: Number(b.login || 0),
    server: String(b.server || ""),
    currency: String(b.currency || ""),
    leverage: Number(b.leverage || 0),
    ts: nowMs(),
    balance: Number(b.balance || 0),
    equity: Number(b.equity || 0),
    margin: Number(b.margin || 0),
    free: Number(b.free || 0),
    orders: Array.isArray(b.orders) ? b.orders : [],
    stats: b.stats && typeof b.stats === "object" ? b.stats : {},
  };

  accounts.set(accountId, payload);
  res.json({ ok: true });
});

// Agent polls command for its account
app.get("/command", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const accountId = String(req.query.accountId || "");
  if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });

  const cmd = commands.get(accountId);
  if (!cmd || cmd.status !== "NEW") {
    return res.json({ ok: true, has: false });
  }

  res.json({ ok: true, has: true, command: cmd });
});

// Agent ACK command result
app.post("/command_ack", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const accountId = String(b.accountId || "");
  const id = Number(b.id || 0);
  const status = String(b.status || "");
  const errMsg = String(b.errMsg || "");

  if (!accountId || !id || !status) {
    return res.status(400).json({ ok: false, error: "missing fields" });
  }

  const cmd = commands.get(accountId);
  if (cmd && cmd.id === id) {
    cmd.status = status; // DONE | ERR
    cmd.errMsg = errMsg;
    cmd.ackTs = nowMs();
    commands.set(accountId, cmd);
  }

  res.json({ ok: true });
});

// Dashboard: list accounts
app.get("/api/accounts", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const out = Array.from(accounts.values()).sort((a, b) => (a.accountId || "").localeCompare(b.accountId || ""));
  res.json({ ok: true, now: nowMs(), accounts: out });
});

// Dashboard: create Panic Close command (single account or ALL)
app.post("/api/panic", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const accountId = String(b.accountId || "");
  const target = String(b.target || "ALL");

  if (accountId === "ALL") {
    for (const accId of accounts.keys()) {
      commands.set(accId, {
        id: nextCmdId++,
        type: "PANIC_CLOSE",
        target,
        ts: nowMs(),
        status: "NEW",
        errMsg: "",
      });
    }
    return res.json({ ok: true, issued: "ALL" });
  }

  if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });

  commands.set(accountId, {
    id: nextCmdId++,
    type: "PANIC_CLOSE",
    target,
    ts: nowMs(),
    status: "NEW",
    errMsg: "",
  });

  res.json({ ok: true, issued: accountId });
});

// ===================== Copier API =====================
app.get("/copier/health", (req, res) => {
  res.json({
    ok: true,
    now: nowMs(),
    nextEventId,
    maxEventId: nextEventId - 1,
    events: events.length,
    slaves: lastAckBySlave.size,
    uids: uidState.size,
    groups: Array.from(groupSlaves.keys()).map((g) => ({ group: g, slaves: countSlaves(g) })),
  });
});

// Master pushes events
app.post("/copier/push", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const e = req.body || {};
  const group = String(e.group || "G1");
  const type = String(e.type || "");
  if (type !== "OPEN" && type !== "CLOSE") {
    return res.status(400).json({ ok: false, error: "type must be OPEN/CLOSE" });
  }

  const uid = String(e.uid || "");
  const open_time = Number(e.open_time || 0);
  const master_ticket = Number(e.master_ticket || 0);
  const symbol = String(e.symbol || "");
  const cmd = Number(e.cmd ?? -1);
  const lot = Number(e.lot || 0);
  const price = Number(e.price || 0);

  if (!uid || !open_time || !master_ticket || !symbol || (cmd !== 0 && cmd !== 1 && cmd < 0)) {
    // cmd: OP_BUY=0, OP_SELL=1 in MT4; but allow any >=0
    return res.status(400).json({ ok: false, error: "missing fields" });
  }

  const skey = `${group}|${uid}`;
  const st = uidState.get(skey) || {
    open: false,
    master_ticket,
    open_time,
    openSlaves: new Set(),
    closeSlaves: new Set(),
    lastType: "",
    ts: 0,
  };

  // ===== Hard anti-duplicate logic (by uid) =====
  if (type === "OPEN") {
    if (st.open === true) {
      return res.json({ ok: true, duplicated: true, reason: "OPEN_ALREADY" });
    }
    st.open = true;
    st.lastType = "OPEN";
    st.ts = nowMs();
    st.master_ticket = master_ticket;
    st.open_time = open_time;
    st.openSlaves = new Set();
    st.closeSlaves = new Set();
    uidState.set(skey, st);
  } else {
    if (st.open === false) {
      return res.json({ ok: true, duplicated: true, reason: "CLOSE_WITHOUT_OPEN" });
    }
    if (st.lastType === "CLOSE") {
      return res.json({ ok: true, duplicated: true, reason: "CLOSE_ALREADY" });
    }
    st.open = false;
    st.lastType = "CLOSE";
    st.ts = nowMs();
    uidState.set(skey, st);
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
  eventById.set(payload.event_id, payload);

  if (events.length > MAX_EVENTS) {
    const removed = events.splice(0, events.length - MAX_EVENTS);
    for (const ev of removed) eventById.delete(ev.event_id);
  }

  debug("COPIER PUSH", payload);
  res.json({ ok: true, event_id: payload.event_id });
});

// Slave ACK
app.post("/copier/ack", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const group = String(b.group || "G1");
  const slaveId = String(b.slaveId || "S01");
  const event_id = Number(b.event_id || 0);
  const status = String(b.status || "");

  if (!event_id) return res.status(400).json({ ok: false, error: "missing event_id" });

  regSlave(group, slaveId);

  const key = `${group}|${slaveId}`;
  const last = lastAckBySlave.get(key) || 0;
  if (event_id > last) lastAckBySlave.set(key, event_id);

  // optional: state cleanup when all known slaves DONE on CLOSE
  const ev = eventById.get(event_id);
  if (ev && ev.uid) {
    const skey = `${group}|${ev.uid}`;
    const st = uidState.get(skey);
    if (st) {
      if (ev.type === "OPEN" && status === "DONE") {
        st.openSlaves.add(slaveId);
      }
      if (ev.type === "CLOSE" && status === "DONE") {
        st.closeSlaves.add(slaveId);
        const need = countSlaves(group);
        if (need > 0 && st.closeSlaves.size >= need) {
          uidState.delete(skey);
          debug("COPIER CLEAN uid", skey, "after close acks", st.closeSlaves.size, "/", need);
        }
      }
    }
  }

  debug("COPIER ACK", { group, slaveId, event_id, status, lastAck: lastAckBySlave.get(key) || 0 });
  res.json({ ok: true, group, slaveId, last_ack: lastAckBySlave.get(key) || 0 });
});

// Slave polls events (filtered by ACK)
app.get("/copier/events", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const group = String(req.query.group || "G1");
  const slaveId = String(req.query.slaveId || "S01");
  const since = Number(req.query.since || 0);
  const limit = Math.min(Number(req.query.limit || 100), 500);

  regSlave(group, slaveId);

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

  res.json({
    ok: true,
    group,
    slaveId,
    since,
    lastAck,
    maxEventId: nextEventId - 1,
    count: out.length,
    events: out,
  });
});

// ===================== Serve dashboard =====================
app.use(express.static(".")); // serves dashboard.html from same folder

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Server listening on", port));
