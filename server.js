// server.js - MT4 Account Manager (Dashboard + Panic Close)
// Run on Render

import express from "express";
import cors from "cors";

// NOTE: this file is an ES module on Render ("type":"module")
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const API_KEY = process.env.API_KEY || ""; // optional

function authOk(req) {
  if (!API_KEY) return true;
  return req.get("x-api-key") === API_KEY;
}

function nowMs() { return Date.now(); }

// ===== In-memory stores =====
const accounts = new Map(); 
// accountId -> { accountId, name, login, server, ts, balance, equity, margin, free, leverage, currency, orders:[], stats:{} }

const commands = new Map();
// accountId -> { id, type:"PANIC_CLOSE", target:"ALL", ts, status:"NEW|DONE|ERR", errMsg }

let nextCmdId = 1;

// For Render + ES modules: resolve current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Health =====
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    now: nowMs(),
    accounts: accounts.size,
    commands: commands.size,
  });
});

// ===== Agent -> report status + orders =====
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

// ===== Agent polls command for its account =====
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

// ===== Agent ACK command result =====
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

// ===== Dashboard API =====
app.get("/api/accounts", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  // Keep a stable order (Map preserves insertion order)
  const out = Array.from(accounts.values());
  res.json({ ok: true, now: nowMs(), accounts: out });
});

// Create Panic Close command (single account or ALL)
app.post("/api/panic", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const b = req.body || {};
  const accountId = String(b.accountId || "");
  const target = String(b.target || "ALL");

  if (accountId === "ALL") {
    // issue to all known accounts
    for (const accId of accounts.keys()) {
      const existing = commands.get(accId);
      if (existing && existing.status === "NEW") continue; // don't spam same account

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

  // If a NEW command already exists for this account, don't overwrite it
  const existing = commands.get(accountId);
  if (existing && existing.status === "NEW") {
    return res.json({ ok: true, issued: accountId, pending: true, id: existing.id });
  }

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

// ===== Serve dashboard static =====
// Put dashboard.html next to server.js in the repo root.
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Account Manager listening on", port));
