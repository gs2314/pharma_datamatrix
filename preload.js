"use strict";

// Context-isolated IPC bridge. Exposes a narrow, typed API on
// window.electronAPI that the renderer can call. Keeps Node APIs
// out of the renderer.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,

  // --- filesystem ---
  fs: {
    readFile:       (p)        => ipcRenderer.invoke("fs:readFile", p),
    writeFile:      (p, s)     => ipcRenderer.invoke("fs:writeFile", p, s),
    statMtime:      (p)        => ipcRenderer.invoke("fs:statMtime", p),
    fileExists:     (p)        => ipcRenderer.invoke("fs:fileExists", p),
    pickExisting:   ()         => ipcRenderer.invoke("fs:pickExisting"),
    pickNew:        ()         => ipcRenderer.invoke("fs:pickNew"),
    loadLastPath:   ()         => ipcRenderer.invoke("fs:loadLastPath"),
    forgetLastPath: ()         => ipcRenderer.invoke("fs:forgetLastPath"),
  },

  // --- popup window (always on top) ---
  popup: {
    open:  (payload) => ipcRenderer.invoke("popup:open", payload),
    close: ()        => ipcRenderer.invoke("popup:close"),
  },

  // --- license ---
  license: {
    hwid:       ()    => ipcRenderer.invoke("license:hwid"),
    debugMode:  ()    => ipcRenderer.invoke("license:debugMode"),
    status:     ()    => ipcRenderer.invoke("license:status"),
    activate:   (ln)  => ipcRenderer.invoke("license:activate", ln),
    deactivate: ()    => ipcRenderer.invoke("license:deactivate"),
  },

  // --- misc ---
  app: {
    version:      ()    => ipcRenderer.invoke("app:version"),
    openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
  },

  // --- popup receive channel ---
  onPopupData: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on("popup:data", h);
    return () => ipcRenderer.removeListener("popup:data", h);
  },
});
