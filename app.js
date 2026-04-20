"use strict";

const S = window.PharmacyState;
const FS = window.PharmacyStorage;

const MIN_SCAN_LEN = 4;
const MAX_INTER_KEY_GAP_MS = 80;
const POLL_INTERVAL_MS = 1000;
const PREVIEW_MAX = 28;

const $ = (id) => document.getElementById(id);
const scanMagnet = $("scan-magnet");
const scanState = $("scan-state");
const entriesEl = $("entries");
const filterEl = $("filter");
const emptyEl = $("empty");
const countEl = $("count");
const statusEl = $("status");
const tpl = $("entry-template");
const onboardingEl = $("onboarding");
const mainEl = $("main");
const filePathEl = $("file-path");

let handle = null;
let state = { version: 1, entries: [] };
let lastMtime = 0;
let filter = "";
const mutex = FS.makeMutex();

/**
 * GS1 NORMALIZATION
 * PURE DIGITS & LETTERS ONLY.
 * Strips all hidden characters, line feeds, and spaces so the Gov portal can accept the paste.
 */
function normalizeGS1(raw) {
  return raw.replace(/[^\w]/g, ""); 
}

function isEditable(el) {
  if (!el) return false;
  const t = el.tagName;
  return t === "INPUT" || t === "TEXTAREA" || el.isContentEditable;
}

function ensureScanFocus() {
  if (!mainEl.hidden && !isEditable(document.activeElement)) scanMagnet.focus();
}

function setStatus(msg, kind) {
  statusEl.textContent = msg || "";
  statusEl.dataset.kind = kind || "";
}

function formatTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function previewOf(raw) {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    out += code < 0x20 || code === 0x7f ? "·" : ch;
    if (out.length >= PREVIEW_MAX) { out = out.slice(0, PREVIEW_MAX) + "…"; break; }
  }
  return out;
}

function render() {
  const q = filter.trim().toLowerCase();
  const visible = q
    ? state.entries.filter((e) => (e.note || "").toLowerCase().includes(q))
    : state.entries;

  countEl.textContent = String(state.entries.length);
  emptyEl.hidden = state.entries.length > 0;

  entriesEl.innerHTML = "";
  for (const entry of visible) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.dataset.id = entry.id;
    li.querySelector(".time").textContent = formatTime(entry.scannedAt);
    const prev = li.querySelector(".preview");
    prev.textContent = previewOf(entry.rawCode);
    prev.title = `${entry.rawCode.length} chars · Click to copy`;
    const noteInput = li.querySelector(".note");
    noteInput.value = entry.note || "";
    li.classList.toggle("copied", !!entry.copiedAt);
    wireRow(li);
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

async function readFromDisk() {
  const { state: loaded, mtime } = await FS.readFile(handle);
  state = loaded;
  lastMtime = mtime;
  render();
}

async function mutate(apply) {
  if (!handle) return;
  await mutex(async () => {
    let current;
    try {
      current = (await FS.readFile(handle)).state;
    } catch (err) {
      setStatus("Read failed", "err");
      throw err;
    }
    const next = apply(current);
    if (!next) return;
    try {
      await FS.writeState(handle, next);
    } catch (err) {
      setStatus("Write failed", "err");
      throw err;
    }
    state = next;
    render();
    const file = await handle.getFile();
    lastMtime = file.lastModified;
  });
}

async function submitScan(rawCode) {
  const cleanCode = normalizeGS1(rawCode);
  
  if (!S.validateRawCode(cleanCode)) {
    setStatus("Scan too short", "warn");
    return;
  }
  
  const entry = S.createEntry(cleanCode, "");
  try {
    await mutate((cur) => S.addEntry(cur, entry));
    setStatus(`Parked (${cleanCode.length} chars)`, "ok");
    setTimeout(() => {
      const li = entriesEl.querySelector(`li[data-id="${entry.id}"]`);
      if (li) li.querySelector(".note").focus();
    }, 30);
  } catch {}
}

async function copyRow(id) {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;
  try {
    await navigator.clipboard.writeText(entry.rawCode);
    setStatus("Copied to clipboard. Paste into portal.", "ok");
  } catch (err) {
    setStatus("Copy failed", "err");
    return;
  }
  mutate((cur) => S.updateEntry(cur, id, { markedCopied: true })).catch(() => {});
}

async function removeRow(id) {
  try { await mutate((cur) => S.removeEntry(cur, id)); }
  catch {}
}

async function saveNote(id, note) {
  const current = state.entries.find((e) => e.id === id);
  if (!current || (current.note || "") === note) return;
  try { await mutate((cur) => S.updateEntry(cur, id, { note })); }
  catch {}
}

// --- Keydown debug overlay ---------------------------------------------
const debugState = { enabled: false, start: 0, lines: [] };

function debugLog(line) {
  if (!debugState.enabled) return;
  debugState.lines.push(line);
  if (debugState.lines.length > 200) debugState.lines.shift();
  const ta = $("debug-log");
  if (ta) { ta.value = debugState.lines.join("\n"); ta.scrollTop = ta.scrollHeight; }
}

function debugAction(msg) { debugLog("    " + msg); }

(function setupScanCapture() {
  let buffer = "";
  let lastKey = 0;
  let altNumpad = "";

  function updateIndicator() {
    if (buffer.length === 0) { scanState.textContent = "Ready"; scanState.dataset.kind = ""; }
    else { scanState.textContent = `Scanning… ${buffer.length}`; scanState.dataset.kind = "active"; }
  }
  
  function reset() { 
    buffer = ""; 
    altNumpad = ""; 
    updateIndicator(); 
  }

  function flushAltNumpad() {
    if (!altNumpad) return;
    const code = parseInt(altNumpad, 10);
    
    // Discard the hidden GS1 character entirely to match the Gov Portal's behavior
    if (code === 29) {
      debugAction(`Alt+029 → DISCARDED (Gov portal expects pure digits)`);
    } else if (!isNaN(code)) {
      buffer += String.fromCharCode(code);
      debugAction(`Alt+${altNumpad} → Append U+${code.toString(16)}`);
    }
    
    altNumpad = "";
    updateIndicator();
  }

  document.addEventListener("keydown", (e) => {
    const magnetFocused = document.activeElement === scanMagnet;
    
    if (debugState.enabled) {
        const t = Math.round(performance.now() - debugState.start);
        debugLog(`[T+${t}ms] key="${e.key}" code=${e.code} mods=${e.altKey?'Alt':''}${e.ctrlKey?'Ctrl':''} focus=${magnetFocused}`);
    }

    if (!magnetFocused) return;

    const now = performance.now();
    const gap = now - lastKey;
    lastKey = now;

    // Evaluate the gap BEFORE processing the key.
    // This silently neutralizes the stray Alt+010 leak from previous scans.
    if (gap > MAX_INTER_KEY_GAP_MS && !e.ctrlKey) {
      reset();
    }

    if (e.altKey && /^Numpad\d$/.test(e.code)) {
      e.preventDefault();
      altNumpad += e.code.slice(-1);
      debugAction(`Alt-numpad collect "${e.code.slice(-1)}"`);
      return;
    }

    if (!e.altKey && altNumpad) flushAltNumpad();

    if (["Shift","Control","Alt","Meta"].includes(e.key)) return;

    if (e.key === "Enter") {
      e.preventDefault();
      if (buffer.length >= MIN_SCAN_LEN) {
        debugAction(`ENTER → submit (len=${buffer.length})`);
        submitScan(buffer);
      }
      reset();
      return;
    }

    // Capture Ctrl + ] as FNC1, but we discard it here too just to be safe.
    if (e.ctrlKey && (e.code === "BracketRight" || e.key === "]")) {
      e.preventDefault();
      debugAction(`Ctrl+] → DISCARDED`);
      return;
    }

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); 
      buffer += e.key;
      updateIndicator(); 
      return;
    }
  }, true);

  scanMagnet.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData("text");
    if (text && text.length >= MIN_SCAN_LEN) {
      e.preventDefault(); reset(); submitScan(text);
    }
  });
})();

document.addEventListener("click", (e) => {
  if (!isEditable(e.target)) ensureScanFocus();
});

filterEl.addEventListener("input", () => { filter = filterEl.value; render(); });

$("settings-toggle").addEventListener("click", () => {
  $("settings-panel").hidden = !$("settings-panel").hidden;
});

$("toggle-debug").addEventListener("click", () => {
  debugState.enabled = !debugState.enabled;
  $("toggle-debug").textContent = debugState.enabled ? "Disable debug" : "Enable debug";
  if (debugState.enabled) {
    debugState.start = performance.now();
    debugState.lines = ["Debug started"];
  }
});

$("clear-debug").addEventListener("click", () => { $("debug-log").value = ""; debugState.lines = []; });

$("change-file").addEventListener("click", () => pickAndStart("existing"));
$("forget-file").addEventListener("click", async () => {
  await FS.forget();
  location.reload();
});

$("pick-existing").addEventListener("click", () => pickAndStart("existing"));
$("pick-new").addEventListener("click", () => pickAndStart("new"));

async function pickAndStart(mode) {
  try {
    handle = mode === "new" ? await FS.pickNew() : await FS.pickExisting();
  } catch (err) {
    if (err.name === "AbortError") return;
    setStatus("Pick failed", "err");
    return;
  }
  await start();
}

function showOnboarding() {
  onboardingEl.hidden = false;
  mainEl.hidden = true;
}

function showMain() {
  onboardingEl.hidden = true;
  mainEl.hidden = false;
  filePathEl.textContent = handle ? handle.name : "—";
  ensureScanFocus();
}

let pollTimer = null;

async function pollOnce() {
  if (!handle) return;
  await mutex(async () => {
    const probe = await handle.getFile();
    if (probe.lastModified === lastMtime) return;
    const { state: loaded, mtime } = await FS.readFile(handle);
    state = loaded;
    render();
    lastMtime = mtime;
  });
}

function startPolling() {
  if (pollTimer) return;
  const loop = async () => {
    try { await pollOnce(); }
    catch (err) {}
    finally { pollTimer = setTimeout(loop, POLL_INTERVAL_MS); }
  };
  pollTimer = setTimeout(loop, POLL_INTERVAL_MS);
}

async function start() {
  const perm = await FS.ensurePermission(handle, "readwrite");
  if (perm !== "granted") {
    setStatus("Permission denied", "err");
    showOnboarding();
    return;
  }
  try {
    await readFromDisk();
  } catch (err) {
    showOnboarding();
    return;
  }
  showMain();
  setStatus("Ready", "ok");
  startPolling();
}

async function init() {
  if (!FS.supported()) { showOnboarding(); return; }
  const saved = await FS.loadHandle();
  if (!saved) { showOnboarding(); return; }
  handle = saved;
  const perm = await handle.queryPermission({ mode: "readwrite" });
  if (perm === "granted") { await start(); return; }
  showOnboarding();
}

init();
