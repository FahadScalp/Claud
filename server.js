// server.js - MT4 Account Manager (Dashboard + Panic Close)
// Run on Render

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const API_KEY = process.env.API_KEY || ""; // optional

function authOk(req) {
  if (!API_KEY) return true;
  return req.get("x-api-key") === API_KEY;
}

function nowMs() { return Date.now(); }

function ensureSettings(accountId) {
  const cur = settings.get(accountId);
  if (cur) return cur;
  const s = { tpUsd: 0, slUsd: 0, updatedAt: nowMs() };
  settings.set(accountId, s);
  return s;
}

function canIssueNewCommand(accountId) {
  const existing = commands.get(accountId);
  if (!existing) return true;
  if (existing.status === "NEW") return false; // still pending
  // small cooldown to avoid spam
  const age = nowMs() - (existing.ts || 0);
  return age > 1500;
}

// ===== In-memory stores =====
const accounts = new Map(); 
// accountId -> { accountId, name, login, server, ts, balance, equity, margin, free, leverage, currency, orders:[], stats:{} }

// Per-account settings (USD)
// tpUsd: close when floating profit >= tpUsd (0 disables)
// slUsd: close when floating profit <= -slUsd (0 disables)
const settings = new Map(); // accountId -> { tpUsd, slUsd, updatedAt }

const commands = new Map();
// accountId -> { id, type:"PANIC_CLOSE", target:"ALL", ts, status:"NEW|DONE|ERR", errMsg }

let nextCmdId = 1;

// Safety: avoid spamming same account with repeated PANIC commands
const CMD_COOLDOWN_MS = 10_000;

function n2(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function sumOrdersProfit(orders) {
  if (!Array.isArray(orders)) return 0;
  let s = 0;
  for (const o of orders) {
    // Agent sends: profit (OrderProfit+Swap+Commission)
    // Be tolerant with other keys
    s += n2(o?.profit ?? o?.Profit ?? o?.pnl ?? o?.PnL ?? 0);
  }
  return s;
}

function ensureSettings(accountId) {
  if (!settings.has(accountId)) settings.set(accountId, { tpUsd: 0, slUsd: 0, updatedAt: nowMs() });
  return settings.get(accountId);
}

function issuePanic(accountId, reason = "MANUAL") {
  if (!accounts.has(accountId)) return { ok: false, error: "unknown accountId" };

  const prev = commands.get(accountId);
  if (prev && prev.status === "NEW" && (nowMs() - (prev.ts || 0)) < CMD_COOLDOWN_MS) {
    return { ok: true, issued: accountId, dedup: true };
  }

  commands.set(accountId, {
    id: nextCmdId++,
    type: "PANIC_CLOSE",
    target: "ALL",
    ts: nowMs(),
    status: "NEW",
    errMsg: "",
    reason,
  });

  return { ok: true, issued: accountId };
}

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
  if (!accounts.has(accountId)) {
    return res.status(404).json({ ok: false, error: "unknown accountId" });
  }

  const prev = commands.get(accountId);
  if (prev && prev.status === "NEW") {
    return res.json({ ok: true, issued: accountId, duplicated: true });
  }

  const ordersArr = Array.isArray(b.orders) ? b.orders : [];
  const floatProfit = sumOrdersProfit(ordersArr);

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
    orders: ordersArr,
    stats: {
      ...(b.stats && typeof b.stats === "object" ? b.stats : {}),
      ordersCount: ordersArr.length,
      floatProfit,
    },
    settings: ensureSettings(accountId),
  };

  accounts.set(accountId, payload);

  // Auto panic close by TP/SL (USD). 0 disables.
  // Uses floating profit (sum of open orders profit). If no open orders => floatProfit=0.
  const s = payload.settings;
  if (s) {
    const tp = n2(s.tpUsd || 0);
    const sl = n2(s.slUsd || 0);
    const cmdExisting = commands.get(accountId);
    const hasNew = cmdExisting && cmdExisting.status === "NEW";

    // Don't spam commands: minimum 10s between NEW commands
    const canIssue = !hasNew && (!cmdExisting || nowMs() - (cmdExisting.ts || 0) >= 10000);

    if (canIssue) {
      if (tp > 0 && floatProfit >= tp && ordersArr.length > 0) {
        commands.set(accountId, {
          id: nextCmdId++,
          type: "PANIC_CLOSE",
          target: "ALL",
          ts: nowMs(),
          status: "NEW",
          errMsg: "",
          reason: `TP_REACHED ${floatProfit.toFixed(2)}>=${tp.toFixed(2)}`,
        });
      } else if (sl > 0 && floatProfit <= -sl && ordersArr.length > 0) {
        commands.set(accountId, {
          id: nextCmdId++,
          type: "PANIC_CLOSE",
          target: "ALL",
          ts: nowMs(),
          status: "NEW",
          errMsg: "",
          reason: `SL_REACHED ${floatProfit.toFixed(2)}<=-${sl.toFixed(2)}`,
        });
      }
    }
  }

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

  // IMPORTANT: keep stable order (Map insertion order) so rows don't jump on every refresh.
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
      const prev = commands.get(accId);
      if (prev && prev.status === "NEW") continue; // don't spam
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
  if (!accounts.has(accountId)) {
    return res.status(404).json({ ok: false, error: "unknown accountId" });
  }

  const prev = commands.get(accountId);
  if (prev && prev.status === "NEW") {
    return res.json({ ok: true, issued: accountId, duplicated: true, reason: "PENDING" });
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

// ===== Settings API (USD) =====
app.get("/api/settings", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const accountId = String(req.query.accountId || "");
  if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });
  if (!accounts.has(accountId)) return res.status(404).json({ ok: false, error: "unknown accountId" });
  res.json({ ok: true, accountId, settings: ensureSettings(accountId) });
});

app.post("/api/settings", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const b = req.body || {};
  const accountId = String(b.accountId || "");
  if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });
  if (accountId !== "ALL" && !accounts.has(accountId)) return res.status(404).json({ ok: false, error: "unknown accountId" });

  const tpUsd = n2(b.tpUsd ?? b.tp ?? 0);
  const slUsd = n2(b.slUsd ?? b.sl ?? 0);

  if (accountId === "ALL") {
    for (const accId of accounts.keys()) {
      settings.set(accId, { tpUsd, slUsd, updatedAt: nowMs() });
      // also update cached account object (so dashboard sees it immediately)
      const acc = accounts.get(accId);
      if (acc) { acc.settings = ensureSettings(accId); accounts.set(accId, acc); }
    }
    return res.json({ ok: true, updated: "ALL", tpUsd, slUsd });
  }

  settings.set(accountId, { tpUsd, slUsd, updatedAt: nowMs() });
  const acc = accounts.get(accountId);
  if (acc) { acc.settings = ensureSettings(accountId); accounts.set(accountId, acc); }
  res.json({ ok: true, updated: accountId, tpUsd, slUsd });
});

// ===== Serve dashboard static =====
app.get("/", (req, res) => {
  // Serve dashboard.html at the root
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.use(express.static(".")); // serve files in repo root

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Account Manager listening on", port));
