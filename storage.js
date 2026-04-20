"use strict";

// Storage abstraction. Two backends behind the same interface:
//
//   Electron backend: file paths + native fs via preload IPC. No
//   permission prompts; the handle persists for the life of the
//   install because the filesystem is just the OS filesystem.
//
//   Web backend (fallback for dev / `file://` double-click): the File
//   System Access API + IndexedDB handle cache, as before. Requires
//   a one-time "Allow" click per launch.
//
// The renderer doesn't care which backend it gets — everything goes
// through `makeStorage()` which picks the right one at startup.

(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.AppStorage = mod;
})(typeof self !== "undefined" ? self : globalThis, function () {

  const AS = typeof self !== "undefined" ? (self.AppState || {}) : {};

  // ------------------------------------------------------------------
  // Mutex (shared)
  // ------------------------------------------------------------------
  function makeMutex() {
    let tail = Promise.resolve();
    return function run(task) {
      const next = tail.then(task, task);
      tail = next.catch(() => {});
      return next;
    };
  }

  // ------------------------------------------------------------------
  // Electron backend
  // ------------------------------------------------------------------
  function electronBackend(api) {
    async function readFile(path) {
      const txt = await api.fs.readFile(path);
      let obj;
      try { obj = JSON.parse(txt); }
      catch { throw new Error("Shared file is not valid JSON: " + path); }
      const state = AS.normalizeState(obj);
      const mtime = await api.fs.statMtime(path);
      return { state, mtime };
    }
    async function writeState(path, state) {
      const json = JSON.stringify(state, null, 2);
      await api.fs.writeFile(path, json);
    }
    async function pickExisting() {
      const p = await api.fs.pickExisting();
      if (!p) throw Object.assign(new Error("canceled"), { name: "AbortError" });
      return p;
    }
    async function pickNew() {
      const p = await api.fs.pickNew();
      if (!p) throw Object.assign(new Error("canceled"), { name: "AbortError" });
      return p;
    }
    async function loadHandle() { return await api.fs.loadLastPath(); }
    async function forget()     { await api.fs.forgetLastPath(); }
    async function ensurePermission() { return "granted"; }

    return {
      mode: "electron",
      supported: () => true,
      readFile, writeState,
      pickExisting, pickNew,
      loadHandle, forget,
      ensurePermission,
      makeMutex,
    };
  }

  // ------------------------------------------------------------------
  // Web backend (File System Access API + IndexedDB handle cache)
  // ------------------------------------------------------------------
  function webBackend() {
    const IDB_NAME = "qros";
    const IDB_STORE = "handles";
    const HANDLE_KEY = "sharedFile";

    function idbOpen() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    }
    async function idbGet() {
      const db = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).get(HANDLE_KEY);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    async function idbPut(handle) {
      const db = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(handle, HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    async function idbDelete() {
      const db = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    async function readFile(handle) {
      const file = await handle.getFile();
      const text = await file.text();
      let obj;
      try { obj = JSON.parse(text); }
      catch { throw new Error("Shared file is not valid JSON"); }
      return { state: AS.normalizeState(obj), mtime: file.lastModified };
    }
    async function writeState(handle, state) {
      const stream = await handle.createWritable();
      await stream.write(JSON.stringify(state, null, 2));
      await stream.close();
    }
    async function pickExisting() {
      const [h] = await window.showOpenFilePicker({
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
        excludeAcceptAllOption: false,
        multiple: false,
      });
      await idbPut(h);
      return h;
    }
    async function pickNew() {
      const h = await window.showSaveFilePicker({
        suggestedName: "entries.json",
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      const initial = { version: 2, contacts: [], orders: [], qrs: [] };
      const w = await h.createWritable();
      await w.write(JSON.stringify(initial, null, 2));
      await w.close();
      await idbPut(h);
      return h;
    }
    async function loadHandle() { return (await idbGet()) || null; }
    async function forget()     { await idbDelete(); }
    async function ensurePermission(handle, mode) {
      mode = mode || "readwrite";
      let p = await handle.queryPermission({ mode });
      if (p === "granted") return "granted";
      p = await handle.requestPermission({ mode });
      return p;
    }

    return {
      mode: "web",
      supported: () => typeof window !== "undefined" &&
                       "showOpenFilePicker" in window && "showSaveFilePicker" in window,
      readFile, writeState,
      pickExisting, pickNew,
      loadHandle, forget,
      ensurePermission,
      makeMutex,
    };
  }

  function makeStorage() {
    if (typeof window !== "undefined" && window.electronAPI && window.electronAPI.isElectron) {
      return electronBackend(window.electronAPI);
    }
    return webBackend();
  }

  return { makeStorage, makeMutex };
});
