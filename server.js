// server.js - MT4 Account Manager (Dashboard + Panic Close) + Cloud Copier
// Run on Render (Node 18+)

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

function nowMs() { return Date.now(); }

// ==========================================================
// 0) ENV
// ==========================================================
// API_KEY: (اختياري) لحماية /report و /api/accounts و /api/panic (Dashboard + Agent)
const API_KEY = process.env.API_KEY || "";

// MASTER_KEY: (مهم) لحماية /copier/push (الماستر فقط)
const MASTER_KEY = process.env.MASTER_KEY || "";

// ADMIN_KEY: (اختياري) لحماية /admin/* (إدارة العملاء)
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// ملف العملاء (اشتراكات النسخ)
const CLIENTS_FILE = process.env.CLIENTS_FILE || "./clients.json";

function headerAny(req, names) {
  for (const n of names) {
    const v = req.get(n);
    if (v) return String(v);
  }
  return "";
}

function authOk(req) {
  // Dashboard/Agent auth
  if (!API_KEY) return true;
  return headerAny(req, ["x-api-key"]) === API_KEY;
}

function adminOk(req) {
  if (!ADMIN_KEY) return false;
  const v = headerAny(req, ["x-admin-key", "x-api-key"]);
  return v === ADMIN_KEY;
}

function masterOk(req) {
  // الماستر فقط (لرفع الأحداث) + الادمن
  if (ADMIN_KEY && adminOk(req)) return true;
  if (!MASTER_KEY) return false;
  const v = headerAny(req, ["x-master-key", "x-api-key"]);
  return v === MASTER_KEY;
}

// ==========================================================
// 1) Clients (Subscriptions for Copier)
// ==========================================================
// clients.json format:
// {
//   "clients": [
//     {"apiKey":"K1","group":"G1","slaveId":"S01","expiresAt":"2026-02-18T00:00:00Z","enabled":true}
//   ]
// }

let clientsByKey = new Map();

function loadClients() {
  try {
    const p = path.resolve(process.cwd(), CLIENTS_FILE);
    if (!fs.existsSync(p)) {
      clientsByKey = new Map();
      return;
    }
    const raw = fs.readFileSync(p, "utf8");
    const js = JSON.parse(raw || "{}");
    const list = Array.isArray(js.clients) ? js.clients : [];
    const m = new Map();
    for (const c of list) {
      const apiKey = String(c.apiKey || "").trim();
      if (!apiKey) continue;
      m.set(apiKey, {
        apiKey,
        group: String(c.group || "").trim(),
        slaveId: String(c.slaveId || "").trim(),
        enabled: c.enabled === undefined ? true : !!c.enabled,
        expiresAt: String(c.expiresAt || "").trim(),
        note: String(c.note || "").trim(),
      });
    }
    clientsByKey = m;
  } catch (e) {
    console.error("Failed to load clients.json", e);
    clientsByKey = new Map();
  }
}

function saveClients() {
  const p = path.resolve(process.cwd(), CLIENTS_FILE);
  const list = Array.from(clientsByKey.values());
  fs.writeFileSync(p, JSON.stringify({ clients: list }, null, 2), "utf8");
}

function parseExpiresMs(expiresAt) {
  const s = String(expiresAt || "").trim();
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function validateClientKey(req) {
  const key = headerAny(req, ["x-api-key"]).trim();
  if (!key) return { ok: false, status: 401, error: "missing x-api-key" };

  const c = clientsByKey.get(key);
  if (!c) return { ok: false, status: 401, error: "invalid api key" };
  if (!c.enabled) return { ok: false, status: 403, error: "subscription disabled" };

  const exp = parseExpiresMs(c.expiresAt);
  if (exp && nowMs() > exp) return { ok: false, status: 403, error: "subscription expired" };

  return { ok: true, client: c };
}

function validateCopierSlave(req, group, slaveId) {
  const r = validateClientKey(req);
  if (!r.ok) return r;

  const c = r.client;
  if (!c.group || !c.slaveId) {
    return { ok: false, status: 403, error: "client config missing group/slaveId" };
  }
  if (String(group || "") !== c.group) {
    return { ok: false, status: 403, error: "group not allowed" };
  }
  if (String(slaveId || "") !== c.slaveId) {
    return { ok: false, status: 403, error: "slaveId not allowed" };
  }

  return { ok: true, client: c };
}

// load clients on start
loadClients();

// ==========================================================
// 2) Dashboard / Agent (كما هو)
// ==========================================================

// accountId -> payload
const accounts = new Map();
// accountId -> cmd
const commands = new Map();
let nextCmdId = 1;

// Health (public)
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    now: nowMs(),
    accounts: accounts.size,
    commands: commands.size,
  });
});

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

// Dashboard API
app.get("/api/accounts", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const out = Array.from(accounts.values()).sort((a, b) => (b.ts - a.ts));
  res.json({ ok: true, now: nowMs(), accounts: out });
});

function issuePanic(accountId, target = "ALL") {
  // إذا فيه أمر جديد بنفس الحساب، لا تكرر (يقلل spam)
  const existing = commands.get(accountId);
  if (existing && existing.status === "NEW" && existing.type === "PANIC_CLOSE") {
    return existing;
  }

  const cmd = {
    id: nextCmdId++,
    type: "PANIC_CLOSE",
    target,
    ts: nowMs(),
    status: "NEW",
    errMsg: "",
  };
  commands.set(accountId, cmd);
  return cmd;
}

// Create Panic Close command (single account or ALL)
app.post("/api/panic", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const accountId = String(b.accountId || "");
  const target = String(b.target || "ALL");

  if (accountId === "ALL") {
    for (const accId of accounts.keys()) {
      issuePanic(accId, target);
    }
    return res.json({ ok: true, issued: "ALL" });
  }

  if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });

  issuePanic(accountId, target);
  res.json({ ok: true, issued: accountId });
});

// ==========================================================
// 3) Cloud Copier (Master -> Server -> Slaves)
// ==========================================================

let nextEventId = 1;
const groupEvents = new Map(); // group -> array of events
const seenEventKey = new Map(); // group|type|uid -> id
const slaveLastAck = new Map(); // group|slaveId -> lastAckId
const groupSlaves = new Map(); // group -> Set(slaveId)

function getGroupArr(group) {
  const g = String(group || "").trim();
  if (!g) return null;
  if (!groupEvents.has(g)) groupEvents.set(g, []);
  return groupEvents.get(g);
}

function getGroupMaxId(group) {
  const arr = getGroupArr(group);
  if (!arr || arr.length === 0) return 0;
  return arr[arr.length - 1].id || 0;
}

function ensureGroupSlaves(group) {
  const g = String(group || "").trim();
  if (!groupSlaves.has(g)) groupSlaves.set(g, new Set());
  return groupSlaves.get(g);
}

function normalizeEvent(body) {
  const group = String(body.group || "").trim();
  const type = String(body.type || "").trim().toUpperCase();
  const master_ticket = Number(body.master_ticket || body.ticket || 0);
  const open_time = Number(body.open_time || 0);
  const uid = String(body.uid || "").trim();
  const symbol = String(body.symbol || "").trim();
  const cmd = Number(body.cmd || 0);

  const lots = Number(body.lots ?? body.lot ?? 0);
  const price = Number(body.price ?? 0);
  const sl = Number(body.sl ?? 0);
  const tp = Number(body.tp ?? 0);
  const magic = Number(body.magic ?? 0);

  return {
    group,
    type,
    master_ticket,
    open_time,
    uid,
    symbol,
    cmd,
    lots,
    price,
    sl,
    tp,
    magic,
  };
}

function cleanupGroup(group) {
  const arr = getGroupArr(group);
  if (!arr) return;

  // حافظ على آخر 20000 حدث (كفاية جدا)
  const MAX = 20000;
  if (arr.length > MAX) {
    arr.splice(0, arr.length - MAX);
  }

  // حذف الأحداث القديمة جدا (14 يوم)
  const cutoff = nowMs() - 14 * 24 * 3600 * 1000;
  while (arr.length && (arr[0].ts || 0) < cutoff) {
    const ev = arr.shift();
    if (ev && ev._key) seenEventKey.delete(ev._key);
  }
}

// Copier health (client protected)
app.get("/copier/health", (req, res) => {
  const group = String(req.query.group || "");

  // if group provided: enforce subscription
  if (group) {
    const r = validateClientKey(req);
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
    if (r.client.group !== group) return res.status(403).json({ ok: false, error: "group not allowed" });
  }

  res.json({ ok: true, now: nowMs(), maxEventId: group ? getGroupMaxId(group) : (nextEventId - 1) });
});

// Master pushes an event
app.post("/copier/push", (req, res) => {
  if (!masterOk(req)) return res.status(401).json({ ok: false, error: "unauthorized (master)" });

  const ev0 = normalizeEvent(req.body || {});
  if (!ev0.group || !ev0.type || !ev0.symbol || !ev0.master_ticket) {
    return res.status(400).json({ ok: false, error: "missing fields" });
  }
  if (ev0.type !== "OPEN" && ev0.type !== "CLOSE" && ev0.type !== "MODIFY") {
    return res.status(400).json({ ok: false, error: "bad type" });
  }

  const uid = ev0.uid || `${ev0.master_ticket}_${ev0.open_time || 0}`;
  const key = `${ev0.group}|${ev0.type}|${uid}`;

  // idempotent
  const prev = seenEventKey.get(key);
  if (prev) return res.json({ ok: true, id: prev, dup: true });

  const arr = getGroupArr(ev0.group);
  if (!arr) return res.status(400).json({ ok: false, error: "bad group" });

  const ev = {
    id: nextEventId++,
    group: ev0.group,
    type: ev0.type,
    ts: nowMs(),
    master_ticket: ev0.master_ticket,
    open_time: ev0.open_time || 0,
    uid,
    symbol: ev0.symbol,
    cmd: ev0.cmd,
    lots: ev0.lots,
    price: ev0.price,
    sl: ev0.sl,
    tp: ev0.tp,
    magic: ev0.magic,
    ack: {},
    _key: key,
  };

  arr.push(ev);
  seenEventKey.set(key, ev.id);
  cleanupGroup(ev.group);

  res.json({ ok: true, id: ev.id });
});

// Register slave (optional) - used for cleanup/visibility
app.post("/copier/registerSlave", (req, res) => {
  const b = req.body || {};
  const group = String(b.group || "").trim();
  const slaveId = String(b.slaveId || "").trim();

  const r = validateCopierSlave(req, group, slaveId);
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });

  ensureGroupSlaves(group).add(slaveId);
  const k = `${group}|${slaveId}`;
  if (!slaveLastAck.has(k)) slaveLastAck.set(k, 0);

  res.json({ ok: true });
});

// Slave pulls events
app.get("/copier/events", (req, res) => {
  const group = String(req.query.group || "").trim();
  const slaveId = String(req.query.slaveId || "").trim();
  const since = Number(req.query.since || 0);
  const limitRaw = Number(req.query.limit || 200);
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 200));

  const r = validateCopierSlave(req, group, slaveId);
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });

  ensureGroupSlaves(group).add(slaveId);

  const arr = getGroupArr(group) || [];
  const k = `${group}|${slaveId}`;
  const lastAck = slaveLastAck.get(k) || 0;
  const effSince = Math.max(Number.isFinite(since) ? since : 0, lastAck);

  const out = [];
  for (let i = 0; i < arr.length && out.length < limit; i++) {
    const ev = arr[i];
    if (!ev || !ev.id) continue;
    if (ev.id <= effSince) continue;

    // لا نرسل _key و ack لتصغير الحجم
    out.push({
      id: ev.id,
      group: ev.group,
      type: ev.type,
      ts: ev.ts,
      master_ticket: ev.master_ticket,
      open_time: ev.open_time,
      uid: ev.uid,
      symbol: ev.symbol,
      cmd: ev.cmd,
      lots: ev.lots,
      price: ev.price,
      sl: ev.sl,
      tp: ev.tp,
      magic: ev.magic,
    });
  }

  res.json({ ok: true, now: nowMs(), events: out });
});

// Slave acknowledges one event
app.post("/copier/ack", (req, res) => {
  const b = req.body || {};
  const group = String(b.group || "").trim();
  const slaveId = String(b.slaveId || "").trim();
  const event_id = Number(b.event_id || 0);
  const status = String(b.status || "").trim();
  const err = String(b.err || "").trim();

  const r = validateCopierSlave(req, group, slaveId);
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });

  if (!event_id) return res.status(400).json({ ok: false, error: "missing event_id" });

  ensureGroupSlaves(group).add(slaveId);

  const k = `${group}|${slaveId}`;
  const prev = slaveLastAck.get(k) || 0;
  if (event_id > prev) slaveLastAck.set(k, event_id);

  // سجل ack داخل الحدث إذا وجد (اختياري)
  const arr = getGroupArr(group) || [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const ev = arr[i];
    if (ev && ev.id === event_id) {
      ev.ack = ev.ack || {};
      ev.ack[slaveId] = { status, err, ts: nowMs() };
      break;
    }
  }

  res.json({ ok: true });
});

// ==========================================================
// 4) Admin endpoints (optional)
// ==========================================================

app.get("/admin/clients", (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const list = Array.from(clientsByKey.values()).map((c) => ({
    apiKey: c.apiKey,
    group: c.group,
    slaveId: c.slaveId,
    enabled: c.enabled,
    expiresAt: c.expiresAt,
    note: c.note,
  }));

  res.json({ ok: true, now: nowMs(), clients: list });
});

app.post("/admin/clients/reload", (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  loadClients();
  res.json({ ok: true, clients: clientsByKey.size });
});

app.post("/admin/clients/upsert", (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  let apiKey = String(b.apiKey || "").trim();
  const group = String(b.group || "").trim();
  const slaveId = String(b.slaveId || "").trim();
  const enabled = b.enabled === undefined ? true : !!b.enabled;
  const expiresAt = String(b.expiresAt || "").trim();
  const note = String(b.note || "").trim();

  if (!group || !slaveId) return res.status(400).json({ ok: false, error: "missing group/slaveId" });
  if (!apiKey) apiKey = crypto.randomBytes(18).toString("hex");

  clientsByKey.set(apiKey, { apiKey, group, slaveId, enabled, expiresAt, note });
  try { saveClients(); } catch (e) {}

  res.json({ ok: true, apiKey, group, slaveId, enabled, expiresAt });
});

app.post("/admin/clients/extend", (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const apiKey = String(b.apiKey || "").trim();
  const months = Number(b.months || 1);
  if (!apiKey) return res.status(400).json({ ok: false, error: "missing apiKey" });

  const c = clientsByKey.get(apiKey);
  if (!c) return res.status(404).json({ ok: false, error: "not found" });

  const base = parseExpiresMs(c.expiresAt);
  const start = base && base > nowMs() ? base : nowMs();
  const add = Math.max(1, Math.min(24, Number.isFinite(months) ? months : 1));
  // 30 يوم لكل شهر (تبسيط)
  const next = start + add * 30 * 24 * 3600 * 1000;
  c.expiresAt = new Date(next).toISOString();
  clientsByKey.set(apiKey, c);
  try { saveClients(); } catch (e) {}

  res.json({ ok: true, apiKey, expiresAt: c.expiresAt });
});

// ==========================================================
// 5) Serve dashboard static
// ==========================================================
app.use(express.static(".")); // serves dashboard.html from same folder

// Render often opens the service root. Serve dashboard.html by default.
app.get("/", (req, res) => {
  res.sendFile(path.resolve(process.cwd(), "dashboard.html"));
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Server listening on", port));
