"use strict";

// Pure state helpers. Runs in both browser and Node (for tests).
// All functions return new state objects; never mutate inputs.

(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.PharmacyState = mod;
})(typeof self !== "undefined" ? self : globalThis, function () {
  const INITIAL = { version: 1, entries: [] };
  const MIN_RAW = 1;
  const MAX_RAW = 512;
  const MAX_NOTE = 120;

  function sanitizeNote(s) {
    if (typeof s !== "string") return "";
    return s.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, MAX_NOTE).trim();
  }

  function validateRawCode(s) {
    return typeof s === "string" && s.length >= MIN_RAW && s.length <= MAX_RAW;
  }

  function createEntry(rawCode, note, opts) {
    opts = opts || {};
    return {
      id: opts.id || globalThis.crypto.randomUUID(),
      rawCode: rawCode,
      scannedAt: opts.scannedAt || Date.now(),
      note: sanitizeNote(note || ""),
    };
  }

  function addEntry(state, entry) {
    return { version: 1, entries: [entry, ...(state.entries || [])] };
  }

  function updateEntry(state, id, patch) {
    const entries = (state.entries || []).map((e) => {
      if (e.id !== id) return e;
      const next = { ...e };
      if ("note" in patch) next.note = sanitizeNote(patch.note);
      if (patch.markedCopied === true) next.copiedAt = Date.now();
      return next;
    });
    return { version: 1, entries };
  }

  function removeEntry(state, id) {
    return { version: 1, entries: (state.entries || []).filter((e) => e.id !== id) };
  }

  function normalizeState(raw) {
    if (!raw || typeof raw !== "object") return { version: 1, entries: [] };
    const entries = Array.isArray(raw.entries)
      ? raw.entries.filter(
          (e) => e && typeof e.id === "string" && typeof e.rawCode === "string",
        )
      : [];
    return { version: 1, entries };
  }

  function diffLastModified(a, b) {
    return a !== b;
  }

  return {
    INITIAL,
    MIN_RAW,
    MAX_RAW,
    MAX_NOTE,
    sanitizeNote,
    validateRawCode,
    createEntry,
    addEntry,
    updateEntry,
    removeEntry,
    normalizeState,
    diffLastModified,
  };
});
