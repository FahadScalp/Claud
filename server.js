// server.js - MT4 Dashboard + Panic Close + Copier (Master/Slave)
// Node.js (ESM). Works on Render.

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const API_KEY = process.env.API_KEY || ""; // optional

function authOk(req) {
  if (!API_KEY) return true;
  return req.get("x-api-key") === API_KEY;
}

function nowMs() { return Date.now(); }

function safeStr(x) {
  return (x === undefined || x === null) ? "" : String(x);
}

// ===== In-memory (Dashboard) =====
const accounts = new Map();
// accountId -> { accountId, name, login, server, currency, leverage, ts, balance, equity, margin, free, orders:[], stats:{}, firstSeenIdx }
let firstSeenSeq = 1;

const commands = new Map();
// accountId -> { id, type, target, ts, status: NEW|DONE|ERR, errMsg, ackTs }
let nextCmdId = 1;

// ===== Copier (Master/Slave) =====
let nextEventId = 1;
const eventsById = new Map(); // id -> event
const eventOrder = []; // [id]
const acksByEventId = new Map(); // id -> Map(slaveId -> {status, ts, err})
const eventKeyToId = new Map(); // dedupe: key -> id

const groupState = new Map();
// group -> { slaves: Map(slaveId -> {lastSeen, lastSince}), lastCleanup }

function getGroupState(group) {
  const g = safeStr(group) || "default";
  if (!groupState.has(g)) groupState.set(g, { slaves: new Map(), lastCleanup: 0 });
  return groupState.get(g);
}

function cleanupCopier(group) {
  const st = getGroupState(group);
  const now = nowMs();
  if (now - (st.lastCleanup || 0) < 5000) return;
  st.lastCleanup = now;

  // prune dead slaves (no poll for 60s)
  for (const [sid, s] of st.slaves.entries()) {
    if (now - (s.lastSeen || 0) > 60000) st.slaves.delete(sid);
  }

  // prune very old events (safety) older than 24h
  const cutoff = now - 24 * 3600 * 1000;
  while (eventOrder.length) {
    const id = eventOrder[0];
    const ev = eventsById.get(id);
    if (!ev) { eventOrder.shift(); continue; }
    if ((ev.ts || 0) < cutoff) {
      deleteEvent(id);
      continue;
    }
    break;
  }
}

function deleteEvent(id) {
  const ev = eventsById.get(id);
  if (!ev) return;
  eventsById.delete(id);
  acksByEventId.delete(id);

  // remove from order list (lazy)
  // (keep it simple; order list is small)
  const idx = eventOrder.indexOf(id);
  if (idx >= 0) eventOrder.splice(idx, 1);

  // remove from dedupe key map
  const key = eventKey(ev);
  if (key) eventKeyToId.delete(key);
}

function eventKey(ev) {
  const group = safeStr(ev.group);
  const uid = safeStr(ev.uid);
  const type = safeStr(ev.type);
  const ticket = safeStr(ev.master_ticket);
  const openTime = safeStr(ev.open_time);
  if (!uid && !ticket) return "";
  return `${group}|${type}|${uid || ticket}|${openTime || ""}`;
}

function snapshotExpectedSlaves(group) {
  const st = getGroupState(group);
  // all currently active slaves
  return Array.from(st.slaves.keys());
}

function computePanicProfitFromOrders(orders) {
  if (!Array.isArray(orders) || orders.length === 0) return 0;
  let s = 0;
  for (const o of orders) {
    const v = o?.profit ?? o?.Profit ?? o?.pnl ?? o?.PnL ?? o?.pl ?? o?.PL;
    const n = Number(v);
    if (Number.isFinite(n)) s += n;
  }
  return s;
}

// ===== Health =====
app.get(["/health", "/"], (req, res) => {
  res.json({
    ok: true,
    now: nowMs(),
    accounts: accounts.size,
    commands: commands.size,
    copier: {
      next_event_id: nextEventId,
      events: eventOrder.length,
      groups: groupState.size,
    },
  });
});

// ===== Dashboard Agent -> report status + orders =====
app.post("/report", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const accountId = safeStr(b.accountId);
  if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });

  const prev = accounts.get(accountId);
  const firstSeenIdx = prev?.firstSeenIdx || firstSeenSeq++;

  const payload = {
    accountId,
    name: safeStr(b.name),
    login: Number(b.login || 0),
    server: safeStr(b.server),
    currency: safeStr(b.currency),
    leverage: Number(b.leverage || 0),
    ts: nowMs(),
    balance: Number(b.balance || 0),
    equity: Number(b.equity || 0),
    margin: Number(b.margin || 0),
    free: Number(b.free || 0),
    orders: Array.isArray(b.orders) ? b.orders : [],
    stats: (b.stats && typeof b.stats === "object") ? b.stats : {},
    firstSeenIdx,
  };

  accounts.set(accountId, payload);
  res.json({ ok: true });
});

// ===== Agent polls command for its account =====
app.get("/command", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const accountId = safeStr(req.query.accountId);
  if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });

  const cmd = commands.get(accountId);
  if (!cmd || cmd.status !== "NEW") return res.json({ ok: true, has: false });

  res.json({ ok: true, has: true, command: cmd });
});

// ===== Agent ACK command result =====
app.post("/command_ack", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const accountId = safeStr(b.accountId);
  const id = Number(b.id || 0);
  const status = safeStr(b.status);
  const errMsg = safeStr(b.errMsg);

  if (!accountId || !id || !status) return res.status(400).json({ ok: false, error: "missing fields" });

  const cmd = commands.get(accountId);
  if (cmd && cmd.id === id) {
    cmd.status = status; // DONE | ERR
    cmd.errMsg = errMsg;
    cmd.ackTs = nowMs();
    commands.set(accountId, cmd);
  }

  res.json({ ok: true });
});

// ===== Dashboard API =====
app.get("/api/accounts", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  // stable order: firstSeenIdx asc
  const out = Array.from(accounts.values()).sort((a, b) => (a.firstSeenIdx - b.firstSeenIdx));

  // optional: compute total floating profit from orders
  let totalOrdersProfit = 0;
  for (const acc of out) totalOrdersProfit += computePanicProfitFromOrders(acc.orders);

  res.json({ ok: true, now: nowMs(), totalOrdersProfit, accounts: out });
});

// Create Panic Close command (single account or ALL)
app.post("/api/panic", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const accountId = safeStr(b.accountId);
  const target = safeStr(b.target || "ALL");

  const issueOne = (accId) => {
    const prev = commands.get(accId);
    // prevent spam: if there's NEW command within 5s, don't create another
    if (prev && prev.status === "NEW" && (nowMs() - prev.ts) < 5000) {
      return { issued: false, reason: "already_pending" };
    }

    commands.set(accId, {
      id: nextCmdId++,
      type: "PANIC_CLOSE",
      target,
      ts: nowMs(),
      status: "NEW",
      errMsg: "",
    });
    return { issued: true };
  };

  if (accountId === "ALL") {
    const results = {};
    for (const accId of accounts.keys()) results[accId] = issueOne(accId);
    return res.json({ ok: true, issued: "ALL", results });
  }

  if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });
  const r = issueOne(accountId);
  return res.json({ ok: true, issued: accountId, ...r });
});

// ===== Copier endpoints =====
// health
app.get("/copier/health", (req, res) => {
  const group = safeStr(req.query.group || "default");
  const st = getGroupState(group);
  cleanupCopier(group);

  res.json({
    ok: true,
    now: nowMs(),
    nextEventId,
    maxEventId: eventOrder.length ? Math.max(...eventOrder) : 0,
    events: eventOrder.length,
    slaves: st.slaves.size,
    uids: eventKeyToId.size,
    groups: Array.from(groupState.entries()).map(([g, gs]) => ({ group: g, slaves: gs.slaves.size })),
  });
});

// Master pushes events
app.post(["/copier/push", "/push"], (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const group = safeStr(b.group || "default");
  const type = safeStr(b.type || "").toUpperCase(); // OPEN/CLOSE/MODIFY

  if (!type) return res.status(400).json({ ok: false, error: "missing type" });

  cleanupCopier(group);

  const ev = {
    id: nextEventId++,
    ts: nowMs(),
    group,
    type,
    uid: safeStr(b.uid || ""),
    master_ticket: Number(b.master_ticket || 0),
    open_time: Number(b.open_time || 0),
    symbol: safeStr(b.symbol || ""),
    cmd: Number(b.cmd || 0),
    lots: Number(b.lots || 0),
    price: Number(b.price || 0),
    sl: Number(b.sl || 0),
    tp: Number(b.tp || 0),
    comment: safeStr(b.comment || ""),
    // for CLOSE: might include close_ticket or close_time
    close_time: Number(b.close_time || 0),
    // snapshot expected slaves for CLOSE events (delete after all ack)
    expectedSlaves: (type === "CLOSE") ? snapshotExpectedSlaves(group) : undefined,
  };

  const key = eventKey(ev);
  if (key && eventKeyToId.has(key)) {
    // already exists
    return res.json({ ok: true, dedup: true, id: eventKeyToId.get(key) });
  }

  eventsById.set(ev.id, ev);
  eventOrder.push(ev.id);
  if (key) eventKeyToId.set(key, ev.id);

  // init ack map
  acksByEventId.set(ev.id, new Map());

  // if CLOSE and no slaves => delete immediately (nothing to do)
  if (type === "CLOSE" && Array.isArray(ev.expectedSlaves) && ev.expectedSlaves.length === 0) {
    deleteEvent(ev.id);
    return res.json({ ok: true, queued: true, id: ev.id, note: "no_slaves" });
  }

  res.json({ ok: true, queued: true, id: ev.id });
});

// Slave pulls events
app.get("/copier/events", (req, res) => {
  const group = safeStr(req.query.group || "default");
  const slaveId = safeStr(req.query.slaveId || "");
  const since = Number(req.query.since || 0);
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));

  const st = getGroupState(group);
  if (slaveId) st.slaves.set(slaveId, { lastSeen: nowMs(), lastSince: since });
  cleanupCopier(group);

  const out = [];
  for (const id of eventOrder) {
    if (id <= since) continue;
    const ev = eventsById.get(id);
    if (!ev) continue;
    if (ev.group !== group) continue;
    out.push(ev);
    if (out.length >= limit) break;
  }

  res.json({
    ok: true,
    now: nowMs(),
    nextEventId,
    maxEventId: eventOrder.length ? Math.max(...eventOrder) : 0,
    events: out,
    slaves: st.slaves.size,
    uids: eventKeyToId.size,
    groups: Array.from(groupState.entries()).map(([g, gs]) => ({ group: g, slaves: gs.slaves.size })),
  });
});

// Slave ACK
app.post("/copier/ack", (req, res) => {
  const b = req.body || {};
  const group = safeStr(b.group || "default");
  const slaveId = safeStr(b.slaveId || "");
  const eventId = Number(b.eventId || 0);
  const status = safeStr(b.status || "").toUpperCase(); // DONE/ERR/SKIP
  const err = safeStr(b.err || "");

  if (!slaveId || !eventId || !status) return res.status(400).json({ ok: false, error: "missing fields" });

  const st = getGroupState(group);
  st.slaves.set(slaveId, { lastSeen: nowMs(), lastSince: st.slaves.get(slaveId)?.lastSince || 0 });

  const ev = eventsById.get(eventId);
  if (!ev) return res.json({ ok: true, gone: true });

  const m = acksByEventId.get(eventId) || new Map();
  m.set(slaveId, { status, ts: nowMs(), err });
  acksByEventId.set(eventId, m);

  // deletion rule: if event is CLOSE and all expected slaves acked (DONE or SKIP), delete all events for same uid
  if (ev.type === "CLOSE" && Array.isArray(ev.expectedSlaves)) {
    const expected = ev.expectedSlaves;
    const allAck = expected.every((sid) => {
      const a = m.get(sid);
      return a && (a.status === "DONE" || a.status === "SKIP");
    });

    if (allAck) {
      // delete all events that share same (group, uid/master_ticket, open_time)
      const uid = safeStr(ev.uid);
      const ticket = safeStr(ev.master_ticket);
      const openTime = safeStr(ev.open_time);

      const toDel = [];
      for (const id of [...eventOrder]) {
        const e2 = eventsById.get(id);
        if (!e2) continue;
        if (e2.group !== group) continue;
        const sameUid = uid && (safeStr(e2.uid) === uid);
        const sameTicket = !uid && ticket && (safeStr(e2.master_ticket) === ticket) && (safeStr(e2.open_time) === openTime);
        if (sameUid || sameTicket) toDel.push(id);
      }
      for (const id of toDel) deleteEvent(id);
    }
  }

  res.json({ ok: true });
});

// ===== Serve static dashboard =====
app.use(express.static(".")); // serves dashboard.html from same folder

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Server listening on", port));
