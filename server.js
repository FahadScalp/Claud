// server.js - Copier SaaS + Dashboard (Render Disk Ready) - ES Modules
import express from "express";
import cors from "cors";
import fs from "fs";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ================= ENV =================
const PORT = process.env.PORT || 10000;

// Optional for dashboard/agent endpoints (not copier)
const API_KEY = process.env.API_KEY || "";

// Admin panel protect
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// Master push protect (IMPORTANT)
const MASTER_KEY = process.env.MASTER_KEY || "";

// Render Disk mount path suggestion: /var/data
const DATA_DIR = process.env.DATA_DIR || "/var/data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  CLIENTS_FILE: `${DATA_DIR}/clients.json`,
  COPIER_FILE: `${DATA_DIR}/copier_events.json`,
  SLAVES_FILE: `${DATA_DIR}/slaves.json`,
};

console.log("DATA_DIR:", DATA_DIR);
console.log("FILES:", FILES);
console.log("ENV:", { hasAPI: !!API_KEY, hasADMIN: !!ADMIN_KEY, hasMASTER: !!MASTER_KEY });

// ================= Helpers =================
function nowMs() { return Date.now(); }
function ok(res, obj = {}) { return res.json({ ok: true, ...obj }); }
function bad(res, code, msg) { return res.status(code).json({ ok: false, error: msg }); }

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const txt = fs.readFileSync(file, "utf8");
    if (!txt.trim()) return fallback;
    return JSON.parse(txt);
  } catch (e) {
    console.log("readJsonSafe error:", file, e?.message);
    return fallback;
  }
}
function writeJsonSafe(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
function randKeyHex(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}
function addDurationMs(code) {
  const day = 24 * 60 * 60 * 1000;
  if (code === "M1") return 31 * day;
  if (code === "M3") return 93 * day;
  if (code === "M6") return 186 * day;
  if (code === "Y1") return 366 * day;
  return 31 * day;
}

// ================= Auth =================
function authOk(req) {
  // حماية قديمة (API_KEY) اختيارية
  if (!API_KEY) return true;
  return (req.get("x-api-key") || "") === API_KEY;
}

function adminOk(req) {
  // ADMIN_KEY اختياري (لو فاضي = بدون حماية)
  if (!ADMIN_KEY) return true;
  return (req.get("x-admin-key") || "") === ADMIN_KEY;
}

function masterOk(req) {
  // MASTER_KEY اختياري (لو فاضي = بدون حماية)
  if (!MASTER_KEY) return true;
  return (req.get("x-master-key") || "") === MASTER_KEY;
}

// ================= Clients Store =================
let clients = readJsonSafe(FILES.CLIENTS_FILE, { clients: [] });

function saveClients() { writeJsonSafe(FILES.CLIENTS_FILE, clients); }

function findClientByApiKey(apiKey) {
  return (clients.clients || []).find(c => c.apiKey === apiKey) || null;
}
function findClientById(clientId) {
  return (clients.clients || []).find(c => c.clientId === clientId) || null;
}
function clientActive(c) {
  if (!c) return false;
  if (!c.enabled) return false;
  if (Number(c.expiresAt || 0) <= nowMs()) return false;
  return true;
}

// Require Client API key for slave endpoints
function requireClientOptional(req, res, groupIdFromReq) {
  const k = (req.get("x-api-key") || "").trim();

  // ✅ إذا ما في api key -> اسمح (مثل قبل)
  if (!k) return null; // null معناها "بدون عميل/بدون تحقق"

  // إذا فيه api key -> تحقق SaaS
  const c = findClientByApiKey(k);
  if (!c) { bad(res, 401, "invalid api key"); return "DENY"; }

  if (!clientActive(c)) { bad(res, 403, "expired/disabled"); return "DENY"; }

  if (groupIdFromReq && String(c.groupId) !== String(groupIdFromReq)) {
    bad(res, 403, "group mismatch");
    return "DENY";
  }
  return c;
}

// ================= Dashboard/Agent (optional) =================
const accounts = new Map();
const commands = new Map();
let nextCmdId = 1;

app.get("/health", (req, res) => ok(res, { now: nowMs() }));

app.post("/report", (req, res) => {
  if (!authOk(req)) return bad(res, 401, "unauthorized");
  const b = req.body || {};
  const accountId = String(b.accountId || "");
  if (!accountId) return bad(res, 400, "missing accountId");

  accounts.set(accountId, { ...b, ts: nowMs(), accountId });
  ok(res, {});
});

app.get("/api/accounts", (req, res) => {
  if (!authOk(req)) return bad(res, 401, "unauthorized");
  ok(res, { now: nowMs(), accounts: Array.from(accounts.values()).sort((a, b) => b.ts - a.ts) });
});

app.post("/api/panic", (req, res) => {
  if (!authOk(req)) return bad(res, 401, "unauthorized");
  const b = req.body || {};
  const accountId = String(b.accountId || "");
  const target = String(b.target || "ALL");

  if (accountId === "ALL") {
    for (const accId of accounts.keys()) {
      commands.set(accId, { id: nextCmdId++, type: "PANIC_CLOSE", target, ts: nowMs(), status: "NEW", errMsg: "" });
    }
    return ok(res, { issued: "ALL" });
  }

  if (!accountId) return bad(res, 400, "missing accountId");
  commands.set(accountId, { id: nextCmdId++, type: "PANIC_CLOSE", target, ts: nowMs(), status: "NEW", errMsg: "" });
  ok(res, { issued: accountId });
});

app.get("/command", (req, res) => {
  if (!authOk(req)) return bad(res, 401, "unauthorized");
  const accountId = String(req.query.accountId || "");
  if (!accountId) return bad(res, 400, "missing accountId");

  const cmd = commands.get(accountId);
  if (!cmd || cmd.status !== "NEW") return ok(res, { has: false });
  ok(res, { has: true, command: cmd });
});

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
    cmd.status = status;
    cmd.errMsg = errMsg;
    cmd.ackTs = nowMs();
    commands.set(accountId, cmd);
  }
  ok(res, {});
});

// ================= Copier (Disk) =================
let copier = readJsonSafe(FILES.COPIER_FILE, { nextId: 1, events: [], lastMasterEquityByGroup: {} });
let slaves = readJsonSafe(FILES.SLAVES_FILE, { slaves: {} }); // key group|slaveId -> { lastAckId,lastSeenAt }

function saveCopier() {
  // keep last 50k
  if (copier.events.length > 50000) copier.events = copier.events.slice(-50000);
  writeJsonSafe(FILES.COPIER_FILE, copier);
}
function saveSlaves() { writeJsonSafe(FILES.SLAVES_FILE, slaves); }
function slaveKey(group, slaveId) { return `${group}|${slaveId}`; }

app.get("/copier/health", (req, res) => {
  ok(res, {
    now: nowMs(),
    maxEventId: (copier.nextId || 1) - 1,
    eventsStored: (copier.events || []).length,
    slaves: Object.keys(slaves.slaves || {}).length,
    clients: (clients.clients || []).length,
    lastMasterEquityByGroup: copier.lastMasterEquityByGroup || {},
  });
});

// ✅ Master pushes OPEN/MODIFY/CLOSE (protected by MASTER_KEY)
app.post("/copier/push", (req, res) => {
  if (!masterOk(req)) return bad(res, 401, "unauthorized master");

  const e = req.body || {};
  const group = String(e.group || "");
  const type = String(e.type || "");
  if (!group || !type) return bad(res, 400, "missing group/type");

  const ev = {
    id: copier.nextId++,
    group,
    type,                     // OPEN | MODIFY | CLOSE
    ts: nowMs(),

    master_ticket: Number(e.master_ticket || 0),
    open_time: Number(e.open_time || 0),
    symbol: String(e.symbol || ""),
    cmd: Number(e.cmd || 0),
    lots: Number(e.lots || 0),
    price: Number(e.price || 0),
    sl: Number(e.sl || 0),
    tp: Number(e.tp || 0),
    magic: Number(e.magic || 0),
    comment: String(e.comment || ""),
    master_equity: Number(e.master_equity || 0),
  };

  if (!ev.master_ticket || !ev.symbol) return bad(res, 400, "missing master_ticket/symbol");
console.log("[PUSH]", {
  id,
  group,
  type,
  master_ticket: evt.master_ticket,
  symbol: evt.symbol,
  open_time: evt.open_time,
  ts: evt.ts
});

  copier.events.push(ev);

  // store last master equity for equity ratio
  copier.lastMasterEquityByGroup = copier.lastMasterEquityByGroup || {};
  if (ev.master_equity > 0) copier.lastMasterEquityByGroup[group] = ev.master_equity;

  saveCopier();
  ok(res, { id: ev.id });
});

// Slave registers (bind 1 account per client)
app.post("/copier/registerSlave", (req, res) => {
  const b = req.body || {};
  const group = String(b.group || "");
  const slaveId = String(b.slaveId || "");
  if (!group || !slaveId) return bad(res, 400, "missing group/slaveId");

  const c = requireClientOptional(req, res, group);
  if (c === "DENY") return;

  // ✅ إذا فيه عميل (api key موجود) طبق bind
  if (c) {
    if (!c.boundSlaveId) {
      c.boundSlaveId = slaveId;
      saveClients();
    } else if (c.boundSlaveId !== slaveId) {
      return bad(res, 403, "this api key is already bound to another slaveId");
    }
  }

  // تسجيل السلايف عادي
  const k = slaveKey(group, slaveId);
  if (!slaves.slaves[k]) slaves.slaves[k] = { lastAckId: 0, lastSeenAt: 0 };
  slaves.slaves[k].lastSeenAt = nowMs();
  saveSlaves();

  return ok(res, { boundSlaveId: c ? c.boundSlaveId : "" });
});


// Slave polls events
app.get("/copier/events", (req, res) => {
  const group = String(req.query.group || "");
  const slaveId = String(req.query.slaveId || "");
  const since = Number(req.query.since || 0);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));

  if (!group || !slaveId) return bad(res, 400, "missing group/slaveId");

  const c = requireClientOptional(req, res, group);
  if (c === "DENY") return;

  // ✅ إذا api key موجود -> enforce bind
  if (c) {
    if (!c.boundSlaveId) {
      c.boundSlaveId = slaveId;
      saveClients();
    } else if (c.boundSlaveId !== slaveId) {
      return bad(res, 403, "boundSlaveId mismatch (1 account per client)");
    }
  }

  const k = slaveKey(group, slaveId);
  if (!slaves.slaves[k]) slaves.slaves[k] = { lastAckId: 0, lastSeenAt: 0 };
  slaves.slaves[k].lastSeenAt = nowMs();
  saveSlaves();

  const out = [];
  for (const ev of copier.events) {
    if (ev.group !== group) continue;
    if (ev.id <= since) continue;
    out.push(ev);
    if (out.length >= limit) break;
  }

  return ok(res, { now: nowMs(), events: out });
});


// Slave ACK
app.post("/copier/ack", (req, res) => {
  const b = req.body || {};
  const group = String(b.group || "");
  const slaveId = String(b.slaveId || "");
  const event_id = Number(b.event_id || 0);
  const status = String(b.status || "");
  if (!group || !slaveId || !event_id || !status) return bad(res, 400, "missing fields");

  const c = requireClientOptional(req, res, group);
  if (c === "DENY") return;

  // ✅ إذا api key موجود -> enforce bind
  if (c && c.boundSlaveId && c.boundSlaveId !== slaveId) {
    return bad(res, 403, "boundSlaveId mismatch");
  }

  const k = slaveKey(group, slaveId);
  if (!slaves.slaves[k]) slaves.slaves[k] = { lastAckId: 0, lastSeenAt: 0 };
  slaves.slaves[k].lastAckId = Math.max(Number(slaves.slaves[k].lastAckId || 0), event_id);
  slaves.slaves[k].lastSeenAt = nowMs();
  saveSlaves();

  return ok(res, {});
});


// ================= Admin endpoints =================
app.get("/admin/clients", (req, res) => {
  if (!adminOk(req)) return bad(res, 401, "unauthorized admin");
  ok(res, { now: nowMs(), clients: clients.clients || [] });
});

app.post("/admin/clients/add", (req, res) => {
  if (!adminOk(req)) return bad(res, 401, "unauthorized admin");

  const b = req.body || {};
  const fullName = String(b.fullName || "").trim();
  const groupId = String(b.groupId || "").trim();
  const duration = String(b.duration || "M1").trim();
  if (!fullName || !groupId) return bad(res, 400, "missing fullName/groupId");

  const clientId = crypto.randomBytes(6).toString("hex");
  const apiKey = randKeyHex(24);

  const createdAt = nowMs();
  const expiresAt = createdAt + addDurationMs(duration);

  const c = { clientId, fullName, groupId, apiKey, enabled: true, createdAt, expiresAt, boundSlaveId: "" };

  clients.clients = clients.clients || [];
  clients.clients.push(c);
  saveClients();

  ok(res, { client: c });
});

app.post("/admin/clients/disable", (req, res) => {
  if (!adminOk(req)) return bad(res, 401, "unauthorized admin");
  const b = req.body || {};
  const clientId = String(b.clientId || "");
  const enabled = Boolean(b.enabled);

  const c = findClientById(clientId);
  if (!c) return bad(res, 404, "not found");
  c.enabled = enabled;
  saveClients();
  ok(res, {});
});

app.post("/admin/clients/extend", (req, res) => {
  if (!adminOk(req)) return bad(res, 401, "unauthorized admin");
  const b = req.body || {};
  const clientId = String(b.clientId || "");
  const duration = String(b.duration || "M1");

  const c = findClientById(clientId);
  if (!c) return bad(res, 404, "not found");

  const base = Math.max(nowMs(), Number(c.expiresAt || 0));
  c.expiresAt = base + addDurationMs(duration);
  saveClients();

  ok(res, { expiresAt: c.expiresAt });
});

app.post("/admin/clients/resetBind", (req, res) => {
  if (!adminOk(req)) return bad(res, 401, "unauthorized admin");
  const b = req.body || {};
  const clientId = String(b.clientId || "");

  const c = findClientById(clientId);
  if (!c) return bad(res, 404, "not found");

  c.boundSlaveId = "";
  saveClients();
  ok(res, {});
});

app.post("/admin/clients/delete", (req, res) => {
  if (!adminOk(req)) return bad(res, 401, "unauthorized admin");
  const b = req.body || {};
  const clientId = String(b.clientId || "");
  clients.clients = (clients.clients || []).filter(x => x.clientId !== clientId);
  saveClients();
  ok(res, {});
});

// ================= Static =================
app.use(express.static("."));
app.listen(PORT, () => console.log("Server listening on", PORT));
