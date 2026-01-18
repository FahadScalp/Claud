// server.js - MT4 Account Manager + Cloud Copier (Dashboard + Panic Close + Copy)
// Run on Render (type: module)

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const API_KEY = process.env.API_KEY || ""; // optional

function authOk(req) {
  if (!API_KEY) return true;
  return (req.get("x-api-key") || "") === API_KEY;
}
function nowMs() { return Date.now(); }
function ok(res, obj) { return res.json({ ok: true, ...obj }); }
function bad(res, code, msg) { return res.status(code).json({ ok: false, error: msg }); }

// ===================== Account Manager (Dashboard + Agent Panic) =====================
const accounts = new Map();   // accountId -> payload
const commands = new Map();   // accountId -> cmd
let nextCmdId = 1;

app.get("/health", (req, res) => {
  ok(res, { now: nowMs(), accounts: accounts.size, commands: commands.size });
});

// Agent -> report
app.post("/report", (req, res) => {
  if (!authOk(req)) return bad(res, 401, "unauthorized");

  const b = req.body || {};
  const accountId = String(b.accountId || "");
  if (!accountId) return bad(res, 400, "missing accountId");

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
  ok(res, {});
});

// Agent polls command
app.get("/command", (req, res) => {
  if (!authOk(req)) return bad(res, 401, "unauthorized");

  const accountId = String(req.query.accountId || "");
  if (!accountId) return bad(res, 400, "missing accountId");

  const cmd = commands.get(accountId);
  if (!cmd || cmd.status !== "NEW") return ok(res, { has: false });

  ok(res, { has: true, command: cmd });
});

// Agent ACK command
app.post("/command_ack", (req, res) => {
  if (!authOk(req)) return bad(res, 401, "unauthorized");

  const b = req.body || {};
  const accountId = String(b.accountId || "");
  const id = Number(b.id || 0);
  const status = String(b.status || "");
  const errMsg = String(b.errMsg || "");

  if (!accountId || !id || !status) return bad(res, 400, "missing fields");

  const cmd = commands.get(accountId);
  if (cmd && cmd.id === id) {
    cmd.status = status; // DONE | ERR
    cmd.errMsg = errMsg;
    cmd.ackTs = nowMs();
    commands.set(accountId, cmd);
  }

  ok(res, {});
});

// Dashboard API
app.get("/api/accounts", (req, res) => {
  if (!authOk(req)) return bad(res, 401, "unauthorized");
  const out = Array.from(accounts.values()).sort((a, b) => (b.ts - a.ts));
  ok(res, { now: nowMs(), accounts: out });
});

// Create Panic Close command (single account or ALL)
app.post("/api/panic", (req, res) => {
  if (!authOk(req)) return bad(res, 401, "unauthorized");

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
    return ok(res, { issued: "ALL" });
  }

  if (!accountId) return bad(res, 400, "missing accountId");

  commands.set(accountId, {
    id: nextCmdId++,
    type: "PANIC_CLOSE",
    target,
    ts: nowMs(),
    status: "NEW",
    errMsg: "",
  });

  ok(res, { issued: accountId });
});

// ===================== Cloud Copier =====================
// events are kept in-memory (Render free tier: restart wipes, this is OK for now)

const copier = {
  next_event_id: 1,
  // id, group, type, master_ticket, symbol, cmd, lots, price, sl, tp, magic, comment, open_time, ts
  events: [],
  // group -> Map(slaveId -> { slaveId, lastSeen, lastAckEventId })
  slaves: new Map(),
};

function getGroupSlaves(group) {
  if (!copier.slaves.has(group)) copier.slaves.set(group, new Map());
  return copier.slaves.get(group);
}

function markSlaveSeen(group, slaveId) {
  const g = getGroupSlaves(group);
  if (!g.has(slaveId)) g.set(slaveId, { slaveId, lastSeen: nowMs(), lastAckEventId: 0 });
  const s = g.get(slaveId);
  s.lastSeen = nowMs();
  g.set(slaveId, s);
  return s;
}

// health
app.get("/copier/health", (req, res) => {
  const groups = [];
  for (const [group, gmap] of copier.slaves.entries()) {
    groups.push({ group, slaves: gmap.size });
  }
  ok(res, {
    now: nowMs(),
    nextEventId: copier.next_event_id,
    maxEventId: copier.next_event_id - 1,
    events: copier.events.length,
    slaves: Array.from(copier.slaves.values()).reduce((a, m) => a + m.size, 0),
    groups,
  });
});

// slave register (optional but useful for UI/health)
app.post("/copier/registerSlave", (req, res) => {
  if (!authOk(req)) return bad(res, 401, "unauthorized");
  const b = req.body || {};
  const group = String(b.group || "");
  const slaveId = String(b.slaveId || "");
  if (!group || !slaveId) return bad(res, 400, "missing group/slaveId");
  markSlaveSeen(group, slaveId);
  ok(res, {});
});

// master push event
app.post("/copier/push", (req, res) => {
  if (!authOk(req)) return bad(res, 401, "unauthorized");

  const e = req.body || {};
  const group = String(e.group || "");
  const type = String(e.type || ""); // OPEN|MODIFY|CLOSE
  if (!group || !type) return bad(res, 400, "missing group/type");

  const id = copier.next_event_id++;
  const evt = {
    id,
    group,
    type,
    ts: nowMs(),

    master_ticket: Number(e.master_ticket || 0),
    symbol: String(e.symbol || ""),
    cmd: Number(e.cmd || 0),
    lots: Number(e.lots || 0),
    price: Number(e.price || 0),
    sl: Number(e.sl || 0),
    tp: Number(e.tp || 0),
    magic: Number(e.magic || 0),
    comment: String(e.comment || ""),
    open_time: Number(e.open_time || 0),

    // per-slave ack map: slaveId -> { status, err, ts }
    acks: {},
  };

  copier.events.push(evt);
  ok(res, { id });
});

// slave pull events
app.get("/copier/events", (req, res) => {
  if (!authOk(req)) return bad(res, 401, "unauthorized");

  const group = String(req.query.group || "");
  const slaveId = String(req.query.slaveId || "");
  const since = Number(req.query.since || 0);
  const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);

  if (!group || !slaveId) return bad(res, 400, "missing group/slaveId");

  markSlaveSeen(group, slaveId);

  const out = [];
  for (const evt of copier.events) {
    if (evt.group !== group) continue;
    if (evt.id <= since) continue;

    // if already acked by this slave, skip
    if (evt.acks && evt.acks[slaveId]) continue;

    out.push(evt);
    if (out.length >= limit) break;
  }

  ok(res, { now: nowMs(), events: out });
});

// slave ack
app.post("/copier/ack", (req, res) => {
  if (!authOk(req)) return bad(res, 401, "unauthorized");

  const b = req.body || {};
  const group = String(b.group || "");
  const slaveId = String(b.slaveId || "");
  const event_id = Number(b.event_id || 0);
  const status = String(b.status || ""); // DONE|ERR|SKIP_OLD|DUP
  const err = String(b.err || "");

  if (!group || !slaveId || !event_id || !status) return bad(res, 400, "missing fields");

  const g = getGroupSlaves(group);
  if (!g.has(slaveId)) g.set(slaveId, { slaveId, lastSeen: nowMs(), lastAckEventId: 0 });
  const s = g.get(slaveId);
  s.lastSeen = nowMs();
  s.lastAckEventId = Math.max(s.lastAckEventId || 0, event_id);
  g.set(slaveId, s);

  const evt = copier.events.find(x => x.id === event_id && x.group === group);
  if (evt) {
    evt.acks = evt.acks || {};
    evt.acks[slaveId] = { status, err, ts: nowMs() };
  }

  // cleanup: remove events that are acked by ALL known slaves in that group
  const slavesInGroup = getGroupSlaves(group);
  const slaveIds = Array.from(slavesInGroup.keys());
  copier.events = copier.events.filter(ev => {
    if (ev.group !== group) return true;
    if (!ev.acks) return true;
    // if group has 0 slaves, keep events
    if (slaveIds.length === 0) return true;
    for (const sid of slaveIds) {
      if (!ev.acks[sid]) return true;
    }
    return false; // all acked => remove
  });

  ok(res, {});
});

// ===================== Serve dashboard static =====================
app.use(express.static(".")); // serves dashboard.html from same folder

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Account Manager + Copier listening on", port));
