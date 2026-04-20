"use strict";

// QR Ordering System — Electron main process.
//
// Responsibilities:
//   - Open the main window and the always-on-top QR popup window.
//   - Mediate all filesystem I/O via IPC so the renderer never needs
//     the File System Access API permission prompt.
//   - Generate a stable per-machine hardware fingerprint (HWID) used
//     by the license check.
//   - Forward license-server calls on behalf of the renderer.

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const fs   = require("fs");
const fsp  = require("fs").promises;
const path = require("path");
const os   = require("os");
const crypto = require("crypto");
const https  = require("https");
const http   = require("http");
const { URL } = require("url");

const USERDATA = app.getPath("userData");
const LICENSE_FILE   = path.join(USERDATA, "license.json");
const LAST_FILE_PATH = path.join(USERDATA, "lastFile.txt");

let mainWindow = null;
let popupWindow = null;
let watchedPath = null;
let watcher = null;

// --- Windows -----------------------------------------------------------------

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: "#0f172a",
    title: "QR Ordering System",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile("index.html");
  mainWindow.on("closed", () => { mainWindow = null; closePopup(); });
}

function openPopup(payload) {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send("popup:data", payload);
    popupWindow.focus();
    return;
  }
  popupWindow = new BrowserWindow({
    width: 340,
    height: 420,
    alwaysOnTop: true,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    backgroundColor: "#1e293b",
    title: "QR — always on top",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  popupWindow.setAlwaysOnTop(true, "screen-saver");   // above every normal OS window
  popupWindow.setMenuBarVisibility(false);
  popupWindow.loadFile("popup.html");
  popupWindow.once("ready-to-show", () => {
    popupWindow.webContents.send("popup:data", payload);
    popupWindow.show();
  });
  popupWindow.on("closed", () => { popupWindow = null; });
}
function closePopup() {
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.close();
  popupWindow = null;
}

// --- IPC: filesystem ---------------------------------------------------------

ipcMain.handle("fs:readFile",  async (_e, p) => {
  return fsp.readFile(p, "utf8");
});
ipcMain.handle("fs:writeFile", async (_e, p, contents) => {
  // Atomic-ish: write to .tmp then rename. Works across same filesystem.
  const tmp = p + ".tmp";
  await fsp.writeFile(tmp, contents, "utf8");
  await fsp.rename(tmp, p);
  return true;
});
ipcMain.handle("fs:statMtime", async (_e, p) => {
  try { return (await fsp.stat(p)).mtimeMs; } catch { return 0; }
});
ipcMain.handle("fs:fileExists", async (_e, p) => {
  try { await fsp.access(p); return true; } catch { return false; }
});
ipcMain.handle("fs:pickExisting", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "Pick shared data file",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  await fsp.writeFile(LAST_FILE_PATH, r.filePaths[0], "utf8");
  return r.filePaths[0];
});
ipcMain.handle("fs:pickNew", async () => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: "Create shared data file",
    defaultPath: "entries.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (r.canceled || !r.filePath) return null;
  await fsp.writeFile(r.filePath, JSON.stringify({ version: 2, contacts: [], orders: [], qrs: [] }, null, 2), "utf8");
  await fsp.writeFile(LAST_FILE_PATH, r.filePath, "utf8");
  return r.filePath;
});
ipcMain.handle("fs:loadLastPath", async () => {
  try { return (await fsp.readFile(LAST_FILE_PATH, "utf8")).trim(); } catch { return null; }
});
ipcMain.handle("fs:forgetLastPath", async () => {
  try { await fsp.unlink(LAST_FILE_PATH); } catch {}
  return true;
});

// --- IPC: popup window --------------------------------------------------------

ipcMain.handle("popup:open",  (_e, payload) => { openPopup(payload); });
ipcMain.handle("popup:close", () => { closePopup(); });

// --- IPC: license -------------------------------------------------------------
//
// Client → main: "license:verify" { licenseNumber }
// Main:   reads LICENSE_SERVER env (or hardcoded build-time URL), posts to it,
//         writes the response to license.json on disk, returns to renderer.
//
// HTTP contract (documented in README.md; server is user-owned PHP):
//   POST <LICENSE_SERVER>/verify
//   Body:     { license_number, hwid, app_version }
//   Success:  200 { valid: true, owner: { name, surname, company, afm, tel }, ... }
//   Reject:   200 { valid: false, reason: "not_found"|"revoked"|"hwid_mismatch"|"expired" }

const LICENSE_SERVER = process.env.LICENSE_SERVER || "https://licenses.example.com";
const OFFLINE_GRACE_DAYS = 7;

function hwid() {
  // Stable per-machine fingerprint: sha256 over the MAC addresses of all
  // non-internal interfaces + the OS hostname. Not secure against motivated
  // tampering; sufficient to prevent "copy the folder to another PC and go".
  const nets = os.networkInterfaces();
  const macs = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (!n.internal && n.mac && n.mac !== "00:00:00:00:00:00") macs.push(n.mac);
    }
  }
  macs.sort();
  const h = crypto.createHash("sha256");
  h.update(os.hostname());
  h.update("\0");
  h.update(macs.join(","));
  return h.digest("hex").slice(0, 32);
}

function httpPostJson(urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
        "User-Agent": "QROS/" + app.getVersion(),
      },
      timeout: timeoutMs || 8000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: res.statusCode, body: JSON.parse(text) });
        } catch (e) {
          reject(new Error("Invalid JSON from license server: " + text.slice(0, 120)));
        }
      });
    });
    req.on("timeout", () => { req.destroy(new Error("license server timeout")); });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function readLocalLicense() {
  try {
    const raw = await fsp.readFile(LICENSE_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return obj;
  } catch {}
  return null;
}
async function writeLocalLicense(obj) {
  await fsp.writeFile(LICENSE_FILE, JSON.stringify(obj, null, 2), "utf8");
}

ipcMain.handle("license:hwid", () => hwid());

ipcMain.handle("license:status", async () => {
  const cached = await readLocalLicense();
  if (!cached) return { ok: false, reason: "no_license_installed" };
  const ageDays = (Date.now() - (cached.lastCheckAt || 0)) / (86400 * 1000);
  if (cached.valid && cached.hwid === hwid() && ageDays < OFFLINE_GRACE_DAYS) {
    return { ok: true, cached, offlineGraceRemainingDays: OFFLINE_GRACE_DAYS - ageDays };
  }
  // Try online re-verify, fall back to cached if still within grace.
  try {
    const { status, body } = await httpPostJson(LICENSE_SERVER + "/verify", {
      license_number: cached.license_number,
      hwid: hwid(),
      app_version: app.getVersion(),
    });
    if (status === 200 && body.valid) {
      const next = { ...cached, ...body, hwid: hwid(), lastCheckAt: Date.now() };
      await writeLocalLicense(next);
      return { ok: true, cached: next, offlineGraceRemainingDays: OFFLINE_GRACE_DAYS };
    }
    return { ok: false, reason: body.reason || "rejected_by_server" };
  } catch (err) {
    if (cached.valid && ageDays < OFFLINE_GRACE_DAYS) {
      return { ok: true, cached, offlineGraceRemainingDays: OFFLINE_GRACE_DAYS - ageDays, offline: true };
    }
    return { ok: false, reason: "offline_and_grace_expired", detail: String(err.message || err) };
  }
});

ipcMain.handle("license:activate", async (_e, licenseNumber) => {
  if (typeof licenseNumber !== "string" || licenseNumber.trim().length === 0) {
    return { ok: false, reason: "empty_license_number" };
  }
  try {
    const { status, body } = await httpPostJson(LICENSE_SERVER + "/verify", {
      license_number: licenseNumber.trim(),
      hwid: hwid(),
      app_version: app.getVersion(),
    });
    if (status === 200 && body.valid) {
      const rec = {
        license_number: licenseNumber.trim(),
        hwid: hwid(),
        valid: true,
        owner: body.owner || null,
        lastCheckAt: Date.now(),
        activatedAt: Date.now(),
      };
      await writeLocalLicense(rec);
      return { ok: true, cached: rec };
    }
    return { ok: false, reason: body.reason || "rejected_by_server", detail: body };
  } catch (err) {
    return { ok: false, reason: "network_error", detail: String(err.message || err) };
  }
});

ipcMain.handle("license:deactivate", async () => {
  try { await fsp.unlink(LICENSE_FILE); } catch {}
  return { ok: true };
});

// --- IPC: misc ----------------------------------------------------------------

ipcMain.handle("app:version", () => app.getVersion());
ipcMain.handle("app:openExternal", (_e, url) => shell.openExternal(url));

// --- bootstrap ---------------------------------------------------------------

app.whenReady().then(createMainWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
