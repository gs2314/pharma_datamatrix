"use strict";

// File System Access API wrapper.
// Persists a FileSystemFileHandle in IndexedDB so the shared
// entries.json on an SMB share is reopened automatically on reload.
// Reads, merges, and writes are serialized per tab to avoid self-races.
// Cross-counter races are bounded by the read→write window (~10–50 ms)
// which is acceptable for the expected scan volume.

(function (root) {
  const DB_NAME = "pharmacy-parker";
  const STORE = "handles";
  const HANDLE_KEY = "sharedFile";

  let dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idbGet(key) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, "readonly");
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbPut(key, value) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      const r = tx.objectStore(STORE).put(value, key);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }
  async function idbDel(key) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      const r = tx.objectStore(STORE).delete(key);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }

  function supported() {
    return typeof window !== "undefined" && "showSaveFilePicker" in window;
  }

  async function ensurePermission(handle, mode) {
    if (!handle) return "denied";
    const opts = { mode: mode || "readwrite" };
    let perm = await handle.queryPermission(opts);
    if (perm === "granted") return perm;
    perm = await handle.requestPermission(opts);
    return perm;
  }

  async function loadHandle() {
    return (await idbGet(HANDLE_KEY)) || null;
  }

  async function pickExisting() {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "Parker data file", accept: { "application/json": [".json"] } }],
      multiple: false,
      excludeAcceptAllOption: false,
    });
    await idbPut(HANDLE_KEY, handle);
    return handle;
  }

  async function pickNew() {
    const handle = await window.showSaveFilePicker({
      suggestedName: "entries.json",
      types: [{ description: "Parker data file", accept: { "application/json": [".json"] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify({ version: 1, entries: [] }, null, 2));
    await writable.close();
    await idbPut(HANDLE_KEY, handle);
    return handle;
  }

  async function forget() {
    await idbDel(HANDLE_KEY);
  }

  async function readFile(handle) {
    const file = await handle.getFile();
    const text = await file.text();
    if (text.trim() === "") {
      return { state: { version: 1, entries: [] }, mtime: file.lastModified, size: file.size };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const e = new Error(
        `Shared file is not valid JSON (${err.message}). ` +
        `Refusing to overwrite so parked codes are not lost. ` +
        `Inspect or restore entries.json manually.`
      );
      e.code = "INVALID_JSON";
      e.cause = err;
      throw e;
    }
    return { state: PharmacyState.normalizeState(parsed), mtime: file.lastModified, size: file.size };
  }

  async function writeState(handle, state) {
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      await writable.write(JSON.stringify(state, null, 2));
    } finally {
      await writable.close();
    }
  }

  // Serialize per-tab mutations. Cross-tab/cross-counter writes are
  // still possible during the read→write window; callers can check the
  // final mtime to detect that and retry.
  function makeMutex() {
    let chain = Promise.resolve();
    return function run(fn) {
      const next = chain.then(fn, fn);
      chain = next.catch(() => {});
      return next;
    };
  }

  root.PharmacyStorage = {
    supported,
    loadHandle,
    ensurePermission,
    pickExisting,
    pickNew,
    forget,
    readFile,
    writeState,
    makeMutex,
  };
})(typeof self !== "undefined" ? self : globalThis);
