"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const SERVER = path.resolve(__dirname, "..", "server", "server.js");

// A realistic GS1 DataMatrix payload containing a GS separator (0x1D)
// between AI 10 (variable-length batch/lot) and AI 17 (fixed expiry):
//   01 05203622108740  (GTIN, AI 01)
//   10 00437X          (batch, AI 10, variable)
//   <GS>
//   17 270531          (expiry, AI 17)
//   21 37664107698060  (serial, AI 21)
const GS = "\u001D";
const SAMPLE = `01052036221087401000437X${GS}17270531` +
               `2137664107698060`;

async function pickPort() {
  const net = require("node:net");
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server not ready at ${url}`);
}

async function startServer() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "parker-"));
  const port = await pickPort();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await waitFor(`http://127.0.0.1:${port}/state`);
  return {
    port,
    dataDir,
    url: (p) => `http://127.0.0.1:${port}${p}`,
    async stop() {
      child.kill();
      await new Promise((r) => child.on("exit", r));
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

test("0x1D survives POST → disk → GET round trip", async () => {
  const s = await startServer();
  try {
    const r = await fetch(s.url("/entries"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawCode: SAMPLE, note: "roundtrip" }),
    });
    assert.equal(r.status, 201);
    const entry = await r.json();
    assert.equal(entry.rawCode, SAMPLE);
    assert.ok(entry.rawCode.includes("\u001D"), "rawCode retains GS byte");

    const onDisk = JSON.parse(
      await fs.readFile(path.join(s.dataDir, "entries.json"), "utf8")
    );
    assert.equal(onDisk.entries.length, 1);
    assert.equal(onDisk.entries[0].rawCode, SAMPLE);
    assert.ok(onDisk.entries[0].rawCode.includes("\u001D"));

    const r2 = await fetch(s.url("/state"));
    const state = await r2.json();
    assert.equal(state.entries[0].rawCode, SAMPLE);
  } finally {
    await s.stop();
  }
});

test("SSE stream delivers the entry with GS byte intact", async () => {
  const s = await startServer();
  try {
    const received = new Promise((resolve, reject) => {
      const req = require("node:http").get(s.url("/live"), (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const event = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = event.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.entries && data.entries.length) {
                req.destroy();
                resolve(data.entries[0]);
                return;
              }
            } catch {}
          }
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      setTimeout(() => reject(new Error("SSE timeout")), 3000);
    });

    await fetch(s.url("/entries"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawCode: SAMPLE }),
    });

    const entry = await received;
    assert.equal(entry.rawCode, SAMPLE);
    assert.ok(entry.rawCode.includes("\u001D"));
  } finally {
    await s.stop();
  }
});

test("PATCH note then DELETE leaves the file consistent", async () => {
  const s = await startServer();
  try {
    const created = await (await fetch(s.url("/entries"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawCode: SAMPLE }),
    })).json();

    await fetch(s.url(`/entries/${created.id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "patient Maria", markedCopied: true }),
    });

    let state = await (await fetch(s.url("/state"))).json();
    assert.equal(state.entries[0].note, "patient Maria");
    assert.ok(state.entries[0].copiedAt);
    assert.equal(state.entries[0].rawCode, SAMPLE);

    const del = await fetch(s.url(`/entries/${created.id}`), { method: "DELETE" });
    assert.equal(del.status, 204);
    state = await (await fetch(s.url("/state"))).json();
    assert.equal(state.entries.length, 0);

    const disk = JSON.parse(await fs.readFile(path.join(s.dataDir, "entries.json"), "utf8"));
    assert.deepEqual(disk.entries, []);
  } finally {
    await s.stop();
  }
});

test("rejects overly large or empty rawCode", async () => {
  const s = await startServer();
  try {
    const bad1 = await fetch(s.url("/entries"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawCode: "" }),
    });
    assert.equal(bad1.status, 400);
    const bad2 = await fetch(s.url("/entries"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawCode: "x".repeat(600) }),
    });
    assert.equal(bad2.status, 400);
  } finally {
    await s.stop();
  }
});

test("note input is stripped of control characters", async () => {
  const s = await startServer();
  try {
    const created = await (await fetch(s.url("/entries"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawCode: SAMPLE, note: "Mar\u001Dia\u0007" }),
    })).json();
    assert.equal(created.note, "Maria");
    // rawCode untouched.
    assert.equal(created.rawCode, SAMPLE);
  } finally {
    await s.stop();
  }
});
