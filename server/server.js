"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 5577;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || process.cwd());
const DATA_FILE = path.join(DATA_DIR, "entries.json");
const CLIENT_DIR = path.resolve(__dirname, "..", "client");
const MAX_BODY = 32 * 1024;
const BACKUP_DAYS = 7;

const INITIAL_STATE = { version: 1, entries: [] };
let state = INITIAL_STATE;
let saveChain = Promise.resolve();
const sseClients = new Set();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

async function loadState() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fsp.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) {
      state = { version: 1, entries: parsed.entries };
      return;
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("entries.json unreadable, starting empty:", err.message);
    }
  }
  state = { version: 1, entries: [] };
  await persist();
}

function persist() {
  saveChain = saveChain.then(async () => {
    const tmp = DATA_FILE + ".tmp";
    const json = JSON.stringify(state, null, 2);
    await fsp.writeFile(tmp, json, "utf8");
    await fsp.rename(tmp, DATA_FILE);
    await rollBackup();
  }).catch((err) => {
    console.error("persist failed:", err);
  });
  return saveChain;
}

async function rollBackup() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const backup = path.join(DATA_DIR, `entries-${today}.json`);
  try {
    await fsp.access(backup);
  } catch {
    await fsp.copyFile(DATA_FILE, backup);
  }
  try {
    const files = await fsp.readdir(DATA_DIR);
    const cutoff = Date.now() - BACKUP_DAYS * 86400000;
    for (const f of files) {
      const m = f.match(/^entries-(\d{4})(\d{2})(\d{2})\.json$/);
      if (!m) continue;
      const at = Date.UTC(+m[1], +m[2] - 1, +m[3]);
      if (at < cutoff) await fsp.unlink(path.join(DATA_DIR, f));
    }
  } catch (err) {
    console.error("backup prune failed:", err.message);
  }
}

function broadcast() {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function sanitizeNote(s) {
  if (typeof s !== "string") return "";
  return s.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 120).trim();
}

function validRawCode(s) {
  return typeof s === "string" && s.length >= 1 && s.length <= 512;
}

async function parseJsonBody(req, res) {
  let raw;
  try { raw = await readBody(req); } catch { json(res, 413, { error: "body too large" }); return null; }
  try { return JSON.parse(raw); } catch { json(res, 400, { error: "invalid json" }); return null; }
}

async function handleAdd(req, res) {
  const body = await parseJsonBody(req, res);
  if (!body) return;
  if (!validRawCode(body.rawCode)) return json(res, 400, { error: "invalid rawCode" });
  const entry = {
    id: crypto.randomUUID(),
    rawCode: body.rawCode,
    scannedAt: Date.now(),
    note: sanitizeNote(body.note || ""),
  };
  state = { ...state, entries: [entry, ...state.entries] };
  await persist();
  broadcast();
  json(res, 201, entry);
}

async function handlePatch(req, res, id) {
  const body = await parseJsonBody(req, res);
  if (!body) return;
  const idx = state.entries.findIndex((e) => e.id === id);
  if (idx < 0) return json(res, 404, { error: "not found" });
  const current = state.entries[idx];
  const next = { ...current };
  if ("note" in body) next.note = sanitizeNote(body.note);
  if (body.markedCopied === true) next.copiedAt = Date.now();
  const entries = state.entries.slice();
  entries[idx] = next;
  state = { ...state, entries };
  await persist();
  broadcast();
  json(res, 200, next);
}

async function handleDelete(res, id) {
  const before = state.entries.length;
  const entries = state.entries.filter((e) => e.id !== id);
  if (entries.length === before) return json(res, 404, { error: "not found" });
  state = { ...state, entries };
  await persist();
  broadcast();
  json(res, 204, {});
}

function handleLive(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`data: ${JSON.stringify(state)}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try { res.write(":ping\n\n"); } catch {}
  }, 25000);
  req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
}

async function handleStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(CLIENT_DIR, safe);
  if (!file.startsWith(CLIENT_DIR)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await fsp.readFile(file);
    const mime = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}

async function route(req, res) {
  const url = req.url.split("?")[0];
  const m = url.match(/^\/entries\/([0-9a-f-]{36})$/i);

  if (url === "/state" && req.method === "GET") return json(res, 200, state);
  if (url === "/entries" && req.method === "POST") return handleAdd(req, res);
  if (m && req.method === "PATCH") return handlePatch(req, res, m[1]);
  if (m && req.method === "DELETE") return handleDelete(res, m[1]);
  if (url === "/live" && req.method === "GET") return handleLive(req, res);
  if (req.method === "GET") return handleStatic(req, res);

  res.writeHead(405); res.end("Method not allowed");
}

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => route(req, res))
    .catch((err) => {
      console.error(err);
      if (!res.headersSent) { res.writeHead(500); res.end("Server error"); }
      else { try { res.end(); } catch {} }
    });
});

(async () => {
  await loadState();
  server.listen(PORT, HOST, () => {
    const ifaces = require("os").networkInterfaces();
    const ips = [];
    for (const list of Object.values(ifaces)) {
      for (const i of list || []) {
        if (i.family === "IPv4" && !i.internal) ips.push(i.address);
      }
    }
    console.log(`\n  Pharmacy Parker running`);
    console.log(`  Data file: ${DATA_FILE}`);
    console.log(`  Open on this PC:  http://localhost:${PORT}/`);
    for (const ip of ips) console.log(`  Open on counters: http://${ip}:${PORT}/`);
    console.log("");
  });
})();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\nShutting down (${sig})`);
    server.close(() => process.exit(0));
  });
}
