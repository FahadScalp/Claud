// server.js - MT4 Account Manager (Dashboard + Per-Account Settings + Panic Close)
// Deploy on Render (Node 18+). Works with package.json {"type":"module"}

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

function nowMs() {
  return Date.now();
}

// ---------------- In-memory stores ----------------
// accountId -> last reported snapshot
const accounts = new Map();
// accountId -> last-seen order (stable ordering)
const firstSeenOrder = new Map();
let firstSeenSeq = 1;

// accountId -> settings
// { profitTargetUsd: number (>=0; 0 disables), lossLimitUsd: number (>=0; 0 disables) }
const settings = new Map();

// accountId -> pending command
// { id:number, type:"PANIC_CLOSE", target:"ALL", ts:number, status:"NEW"|"DONE"|"ERR", errMsg?:string }
const commands = new Map();
let nextCmdId = 1;

function normalizeNumber(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

function ensureAccountId(accountId) {
  if (!firstSeenOrder.has(accountId)) firstSeenOrder.set(accountId, firstSeenSeq++);
}

function getSettingsFor(accountId) {
  const s = settings.get(accountId);
  if (s) return s;
  return { profitTargetUsd: 0, lossLimitUsd: 0 };
}

function upsertSettings(accountId, patch) {
  const cur = getSettingsFor(accountId);
  const next = {
    profitTargetUsd: Math.max(0, normalizeNumber(patch.profitTargetUsd ?? cur.profitTargetUsd, 0)),
    lossLimitUsd: Math.max(0, normalizeNumber(patch.lossLimitUsd ?? cur.lossLimitUsd, 0)),
  };
  settings.set(accountId, next);
  return next;
}

function issuePanic(accountId) {
  // If there is already a NEW command, do not spam (prevents “too many requests / exceed” issues)
  const existing = commands.get(accountId);
  if (existing && existing.status === "NEW") return { alreadyPending: true, cmd: existing };

  const cmd = {
    id: nextCmdId++,
    type: "PANIC_CLOSE",
    target: "ALL",
    ts: nowMs(),
    status: "NEW",
    errMsg: "",
  };
  commands.set(accountId, cmd);
  return { alreadyPending: false, cmd };
}

// ---------------- Health ----------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    now: nowMs(),
    accounts: accounts.size,
    commands: commands.size,
  });
});

// ---------------- Agent -> report snapshot ----------------
// Agent posts:
// {accountId,name,login,server,currency,leverage,balance,equity,margin,free,orders:[{...}], stats:{...}}
app.post("/report", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const accountId = String(b.accountId || "").trim();
  if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });

  ensureAccountId(accountId);

  const payload = {
    accountId,
    name: String(b.name || ""),
    login: normalizeNumber(b.login, 0),
    server: String(b.server || ""),
    currency: String(b.currency || ""),
    leverage: normalizeNumber(b.leverage, 0),
    ts: nowMs(),
    balance: normalizeNumber(b.balance, 0),
    equity: normalizeNumber(b.equity, 0),
    margin: normalizeNumber(b.margin, 0),
    free: normalizeNumber(b.free, 0),
    orders: Array.isArray(b.orders) ? b.orders : [],
    stats: b.stats && typeof b.stats === "object" ? b.stats : {},
  };

  accounts.set(accountId, payload);

  // Auto-issue panic if thresholds are exceeded (optional). Agent will also enforce locally.
  const s = getSettingsFor(accountId);
  // profit from orders is best; fallback to equity-balance (open PnL)
  const ordersProfit = Array.isArray(payload.orders)
    ? payload.orders.reduce((sum, o) => sum + normalizeNumber(o.profit ?? o.Profit ?? o.pnl ?? o.PnL ?? 0, 0), 0)
    : 0;
  const pnl = payload.orders.length ? ordersProfit : (payload.equity - payload.balance);

  if (s.profitTargetUsd > 0 && pnl >= s.profitTargetUsd) {
    issuePanic(accountId);
  }
  if (s.lossLimitUsd > 0 && pnl <= -s.lossLimitUsd) {
    issuePanic(accountId);
  }

  return res.json({ ok: true });
});

// ---------------- Agent -> get settings ----------------
app.get("/settings", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const accountId = String(req.query.accountId || "").trim();
  if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });

  ensureAccountId(accountId);
  const s = getSettingsFor(accountId);
  res.json({ ok: true, accountId, settings: s });
});

// ---------------- Agent -> poll command ----------------
app.get("/command", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false });

  const accountId = String(req.query.accountId || "");
  if (!accountId) return res.json({ ok: true, has: false });

  const cmd = commands.get(accountId);
  if (!cmd || cmd.status !== "NEW") {
    return res.json({ ok: true, has: false });
  }

  // 🔒 أرسل نسخة فقط
  res.json({
    ok: true,
    has: true,
    command: {
      id: cmd.id,
      type: cmd.type,
      target: cmd.target
    }
  });
});


// ---------------- Agent -> ack command result ----------------
app.post("/command_ack", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const accountId = String(b.accountId || "").trim();
  const id = normalizeNumber(b.id, 0);
  const status = String(b.status || "").trim();
  const errMsg = String(b.errMsg || "");

  if (!accountId || !id || !status) return res.status(400).json({ ok: false, error: "missing fields" });

  const cmd = commands.get(accountId);
  if (cmd && cmd.id === id) {
    cmd.status = status; // DONE | ERR
    cmd.errMsg = errMsg;
    cmd.ackTs = nowMs();
    commands.delete(accountId);
  }

  res.json({ ok: true });
});

// ---------------- Dashboard API ----------------
app.get("/api/accounts", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  // stable order: first seen
  const out = Array.from(accounts.values()).sort((a, b) => {
    const oa = firstSeenOrder.get(a.accountId) || 999999;
    const ob = firstSeenOrder.get(b.accountId) || 999999;
    return oa - ob;
  });

  const withSettings = out.map((a) => ({
    ...a,
    settings: getSettingsFor(a.accountId),
  }));

  res.json({ ok: true, now: nowMs(), accounts: withSettings });
});

app.get("/api/settings", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const accountId = String(req.query.accountId || "").trim();
  if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });

  ensureAccountId(accountId);
  res.json({ ok: true, accountId, settings: getSettingsFor(accountId) });
});

app.post("/api/settings", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const accountId = String(b.accountId || "").trim();
  if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });

  ensureAccountId(accountId);

  const next = upsertSettings(accountId, {
    profitTargetUsd: b.profitTargetUsd,
    lossLimitUsd: b.lossLimitUsd,
  });

  res.json({ ok: true, accountId, settings: next });
});

// Panic close (single account or ALL)
app.post("/api/panic", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const accountId = String(b.accountId || "").trim();

  if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });

  if (accountId === "ALL") {
    const issued = [];
    const skipped = [];

    for (const accId of accounts.keys()) {
      const r = issuePanic(accId);
      if (r.alreadyPending) skipped.push(accId);
      else issued.push(accId);
    }

    return res.json({ ok: true, issued, skipped });
  }

  if (!accounts.has(accountId)) {
    // still allow issuing, but warn
    const r = issuePanic(accountId);
    return res.json({ ok: true, issued: accountId, warning: "account not yet reported", alreadyPending: r.alreadyPending });
  }

  const r = issuePanic(accountId);
  return res.json({ ok: true, issued: accountId, alreadyPending: r.alreadyPending });
});

// ---------------- Static dashboard ----------------
// Place dashboard.html in the same folder as server.js
app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/dashboard.html");
});
app.use(express.static("."));

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Account Manager listening on", port));
