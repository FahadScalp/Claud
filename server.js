// server.js - MT4 Account Manager (Dashboard + Panic Close)
// Run on Render

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

// ===== In-memory stores =====
const accounts = new Map(); 
// accountId -> { accountId, name, login, server, ts, balance, equity, margin, free, leverage, currency, orders:[], stats:{} }

const commands = new Map();
// accountId -> { id, type:"PANIC_CLOSE", target:"ALL", ts, status:"NEW|DONE|ERR", errMsg }

let nextCmdId = 1;

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

  const out = Array.from(accounts.values()).sort((a, b) => (b.ts - a.ts));
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



// ===== Copier (Master/Slave Trade Copy) =====
// Endpoints:
//  POST /copier/push   (Master)  body: {group,type,uid,master_ticket,open_time,symbol,cmd,lot,price}
//  GET  /copier/events (Slave)   ?group=G1&slaveId=S01&since=0&limit=200
//  POST /copier/ack    (Slave)   body: {group,slaveId,event_id,status,uid,master_ticket,open_time,slave_ticket,err}

let copierNextEventId = 1;
const copierEvents = [];
const COPIER_MAX_EVENTS = 50000;

// `${group}|${slaveId}` -> lastAckEventId
const copierLastAckBySlave = new Map();

// `${group}|${uid}` -> { open:boolean, lastType:"OPEN"|"CLOSE", ts:number }
const copierUidState = new Map();

function copierCleanup(){
  const cutoff = nowMs() - 7*24*3600*1000; // 7 days
  for(const [k, st] of copierUidState.entries()){
    if((st?.ts||0) < cutoff) copierUidState.delete(k);
  }
  // keep events bounded
  if(copierEvents.length > COPIER_MAX_EVENTS){
    copierEvents.splice(0, copierEvents.length - COPIER_MAX_EVENTS);
  }
}

app.get('/copier/health', (req,res)=>{
  res.json({
    ok:true,
    now: nowMs(),
    events: copierEvents.length,
    slaves: copierLastAckBySlave.size,
    uids: copierUidState.size,
  });
});

app.post('/copier/push', (req,res)=>{
  if(!authOk(req)) return res.status(401).json({ok:false, error:'unauthorized'});

  const e = req.body || {};
  const group = String(e.group || 'G1');
  const type = String(e.type || '');
  const uid  = String(e.uid || '');
  const master_ticket = Number(e.master_ticket || 0);
  const open_time     = Number(e.open_time || 0);
  const symbol = String(e.symbol || '');
  const cmd    = Number(e.cmd ?? -1);
  const lot    = Number(e.lot || 0);
  const price  = Number(e.price || 0);

  if(type !== 'OPEN' && type !== 'CLOSE'){
    return res.status(400).json({ok:false, error:'type must be OPEN/CLOSE'});
  }
  if(!uid || !master_ticket || !open_time || !symbol || cmd < 0){
    return res.status(400).json({ok:false, error:'missing fields'});
  }

  const ukey = `${group}|${uid}`;
  const st = copierUidState.get(ukey) || { open:false, lastType:'', ts:0 };

  // Hard idempotency per UID
  if(type === 'OPEN'){
    if(st.open === true){
      return res.json({ok:true, duplicated:true, reason:'OPEN_ALREADY'});
    }
    st.open = true;
    st.lastType = 'OPEN';
    st.ts = nowMs();
    copierUidState.set(ukey, st);
  }else{ // CLOSE
    if(st.open === false){
      return res.json({ok:true, duplicated:true, reason:'CLOSE_WITHOUT_OPEN'});
    }
    if(st.lastType === 'CLOSE'){
      return res.json({ok:true, duplicated:true, reason:'CLOSE_ALREADY'});
    }
    st.open = false;
    st.lastType = 'CLOSE';
    st.ts = nowMs();
    copierUidState.set(ukey, st);
  }

  const payload = {
    event_id: copierNextEventId++,
    group,
    type,
    uid,
    master_ticket,
    open_time,
    symbol,
    cmd,
    lot,
    price,
    ts: nowMs(), // ms
  };

  copierEvents.push(payload);
  copierCleanup();

  res.json({ok:true, event_id: payload.event_id});
});

app.post('/copier/ack', (req,res)=>{
  if(!authOk(req)) return res.status(401).json({ok:false, error:'unauthorized'});

  const b = req.body || {};
  const group = String(b.group || 'G1');
  const slaveId = String(b.slaveId || 'S01');
  const event_id = Number(b.event_id || 0);

  if(!event_id) return res.status(400).json({ok:false, error:'missing event_id'});

  const key = `${group}|${slaveId}`;
  const last = copierLastAckBySlave.get(key) || 0;
  if(event_id > last) copierLastAckBySlave.set(key, event_id);

  res.json({ok:true, group, slaveId, last_ack: copierLastAckBySlave.get(key) || 0});
});

app.get('/copier/events', (req,res)=>{
  if(!authOk(req)) return res.status(401).json({ok:false, error:'unauthorized'});

  const group = String(req.query.group || 'G1');
  const slaveId = String(req.query.slaveId || 'S01');
  const since = Number(req.query.since || 0);
  const limit = Math.min(Number(req.query.limit || 200), 500);

  const key = `${group}|${slaveId}`;
  const lastAck = copierLastAckBySlave.get(key) || 0;

  const out = [];
  for(let i=0;i<copierEvents.length;i++){
    const ev = copierEvents[i];
    if(ev.group !== group) continue;
    if(ev.event_id <= since) continue;
    if(ev.event_id <= lastAck) continue;
    out.push(ev);
    if(out.length >= limit) break;
  }

  res.json({ok:true, group, slaveId, since, lastAck, count: out.length, events: out});
});

// ===== Serve dashboard static =====
app.use(express.static(".")); // serves dashboard.html from same folder

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Account Manager listening on", port));
