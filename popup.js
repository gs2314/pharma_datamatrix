"use strict";

// Renderer for the always-on-top QR popup window. Receives the bracketed
// GS1 AI string from main via IPC and renders it as a scannable DataMatrix.

const BWIP = window.bwipjs;

const canvas  = document.getElementById("popup-canvas");
const aiEl    = document.getElementById("popup-ai");
const gtinEl  = document.getElementById("row-gtin");
const lotEl   = document.getElementById("row-lot");
const snEl    = document.getElementById("row-sn");
const closeBtn = document.getElementById("close-btn");

function render(payload) {
  if (!payload || typeof payload.bracketed !== "string") return;
  aiEl.textContent = payload.bracketed;
  gtinEl.textContent = payload.gtin || "—";
  lotEl.textContent  = payload.lot  || "—";
  snEl.textContent   = payload.sn   || "—";
  try {
    BWIP.toCanvas(canvas, {
      bcid: "gs1datamatrix",
      text: payload.bracketed,
      scale: payload.scale || 7,
      padding: 4,
      backgroundcolor: "FFFFFF",
    });
  } catch (err) {
    aiEl.textContent = "Render failed: " + (err.message || err);
  }
}

// electronAPI is injected by preload.js.
if (window.electronAPI && window.electronAPI.onPopupData) {
  window.electronAPI.onPopupData(render);
}

closeBtn.addEventListener("click", () => {
  if (window.electronAPI) window.electronAPI.popup.close();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (window.electronAPI) window.electronAPI.popup.close();
  }
});
