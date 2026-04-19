"use strict";

const MIN_SCAN_LEN = 4;
const MAX_INTER_KEY_GAP_MS = 80;
const PREVIEW_MAX = 28;
const TEST_FIXTURE = "TESTA\u001DTESTB";

const $ = (id) => document.getElementById(id);
const scanMagnet = $("scan-magnet");
const scanState = $("scan-state");
const entriesEl = $("entries");
const filterEl = $("filter");
const emptyEl = $("empty");
const countEl = $("count");
const statusEl = $("status");
const tpl = $("entry-template");

let entries = [];
let filter = "";

function isEditable(el) {
  if (!el) return false;
  const t = el.tagName;
  return t === "INPUT" || t === "TEXTAREA" || el.isContentEditable;
}

function ensureScanFocus() {
  if (!isEditable(document.activeElement)) scanMagnet.focus();
}

document.addEventListener("click", (e) => {
  if (!isEditable(e.target)) ensureScanFocus();
});
window.addEventListener("focus", ensureScanFocus);

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function previewOf(raw) {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) out += "·";
    else out += ch;
    if (out.length >= PREVIEW_MAX) { out = out.slice(0, PREVIEW_MAX) + "…"; break; }
  }
  return out;
}

function setStatus(msg, kind) {
  statusEl.textContent = msg || "";
  statusEl.dataset.kind = kind || "";
}

function render() {
  const q = filter.trim().toLowerCase();
  const visible = q
    ? entries.filter((e) => (e.note || "").toLowerCase().includes(q))
    : entries;

  countEl.textContent = String(entries.length);
  emptyEl.hidden = entries.length > 0;

  const existing = new Map();
  for (const li of Array.from(entriesEl.children)) existing.set(li.dataset.id, li);

  entriesEl.innerHTML = "";
  for (const entry of visible) {
    let li = existing.get(entry.id);
    if (!li) {
      li = tpl.content.firstElementChild.cloneNode(true);
      li.dataset.id = entry.id;
      wireRow(li);
    }
    li.querySelector(".time").textContent = formatTime(entry.scannedAt);
    const prev = li.querySelector(".preview");
    prev.textContent = previewOf(entry.rawCode);
    prev.title = `${entry.rawCode.length} characters · click row to copy`;
    const noteInput = li.querySelector(".note");
    if (document.activeElement !== noteInput) noteInput.value = entry.note || "";
    li.classList.toggle("copied", !!entry.copiedAt);
    entriesEl.appendChild(li);
  }
}

function wireRow(li) {
  const copyBtn = li.querySelector(".copy");
  const removeBtn = li.querySelector(".remove");
  const noteInput = li.querySelector(".note");

  copyBtn.addEventListener("click", (e) => { e.stopPropagation(); copyRow(li.dataset.id); });
  removeBtn.addEventListener("click", (e) => { e.stopPropagation(); removeRow(li.dataset.id); });

  li.addEventListener("click", (e) => {
    if (isEditable(e.target) || e.target.tagName === "BUTTON") return;
    copyRow(li.dataset.id);
  });
  li.addEventListener("keydown", (e) => {
    if (isEditable(e.target)) return;
    if (e.key === "Enter") { e.preventDefault(); copyRow(li.dataset.id); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeRow(li.dataset.id); }
  });

  let noteTimer = null;
  noteInput.addEventListener("input", () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => saveNote(li.dataset.id, noteInput.value), 300);
  });
  noteInput.addEventListener("blur", () => {
    clearTimeout(noteTimer);
    saveNote(li.dataset.id, noteInput.value);
  });
  noteInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); noteInput.blur(); scanMagnet.focus(); }
  });
}

async function copyRow(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  try {
    await navigator.clipboard.writeText(entry.rawCode);
    setStatus("Copied. Paste into the gov system.", "ok");
  } catch (err) {
    setStatus("Copy failed: " + err.message, "err");
    return;
  }
  try {
    await fetch(`/entries/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markedCopied: true }),
    });
  } catch {}
}

async function removeRow(id) {
  try {
    await fetch(`/entries/${id}`, { method: "DELETE" });
  } catch (err) {
    setStatus("Remove failed: " + err.message, "err");
  }
}

async function saveNote(id, note) {
  const current = entries.find((e) => e.id === id);
  if (!current) return;
  if ((current.note || "") === note) return;
  try {
    await fetch(`/entries/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
  } catch (err) {
    setStatus("Note save failed: " + err.message, "err");
  }
}

async function submitScan(rawCode) {
  try {
    const r = await fetch("/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawCode }),
    });
    if (!r.ok) throw new Error(`server ${r.status}`);
    const entry = await r.json();
    setStatus(`Parked (${rawCode.length} chars)`, "ok");
    setTimeout(() => {
      const li = entriesEl.querySelector(`li[data-id="${entry.id}"]`);
      if (li) li.querySelector(".note").focus();
    }, 50);
  } catch (err) {
    setStatus("Save failed: " + err.message, "err");
  }
}

// Scan capture: intercept keydown while the scan magnet is focused.
(function setupScanCapture() {
  let buffer = "";
  let lastKey = 0;

  function updateIndicator() {
    if (buffer.length === 0) { scanState.textContent = "Ready"; scanState.dataset.kind = ""; }
    else { scanState.textContent = `Scanning… ${buffer.length}`; scanState.dataset.kind = "active"; }
  }

  function reset() { buffer = ""; updateIndicator(); }

  document.addEventListener("keydown", (e) => {
    if (document.activeElement !== scanMagnet) return;

    const now = performance.now();
    const gap = now - lastKey;
    lastKey = now;

    if (buffer.length > 0 && gap > MAX_INTER_KEY_GAP_MS && !e.ctrlKey) {
      // Stray keypress; scanner bursts at << 80ms between keys.
      reset();
    }

    if (["Shift","Control","Alt","AltGraph","Meta","CapsLock","NumLock","ScrollLock","Dead"].includes(e.key)) {
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (buffer.length >= MIN_SCAN_LEN) {
        const captured = buffer;
        reset();
        submitScan(captured);
      } else {
        reset();
      }
      return;
    }

    // Ctrl+] → GS (U+001D). Canonical keystroke for GS1 FNC1.
    if (e.ctrlKey && (e.code === "BracketRight" || e.key === "]")) {
      e.preventDefault();
      buffer += "\u001D";
      updateIndicator();
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      buffer += "\t";
      updateIndicator();
      return;
    }

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      buffer += e.key;
      updateIndicator();
      return;
    }

    // Unknown combos inside the scan magnet are swallowed to avoid shortcuts firing.
    if (e.ctrlKey || e.altKey || e.metaKey) e.preventDefault();
  });

  // Also catch paste mode (some scanners can be configured to emit clipboard instead of keystrokes).
  scanMagnet.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData("text");
    if (text && text.length >= MIN_SCAN_LEN) {
      e.preventDefault();
      reset();
      submitScan(text);
    }
  });
})();

filterEl.addEventListener("input", () => { filter = filterEl.value; render(); });
filterEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const first = entriesEl.querySelector("li");
  if (first) copyRow(first.dataset.id);
});

$("settings-toggle").addEventListener("click", () => {
  const panel = $("settings-panel");
  const shown = !panel.hidden;
  panel.hidden = shown;
  $("settings-toggle").setAttribute("aria-expanded", String(!shown));
});

$("test-paste").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(TEST_FIXTURE);
    setStatus("Fixture copied. Paste into the gov field.", "ok");
  } catch (err) {
    setStatus("Copy failed: " + err.message, "err");
  }
});

// Live stream.
(function connectLive() {
  let attempt = 0;
  function open() {
    const es = new EventSource("/live");
    es.onopen = () => { attempt = 0; setStatus("Connected", "ok"); };
    es.onmessage = (e) => {
      try {
        const state = JSON.parse(e.data);
        entries = Array.isArray(state.entries) ? state.entries : [];
        render();
      } catch {}
    };
    es.onerror = () => {
      es.close();
      const delay = Math.min(8000, 500 * 2 ** attempt++);
      setStatus("Reconnecting…", "warn");
      setTimeout(open, delay);
    };
  }
  open();
})();

ensureScanFocus();
