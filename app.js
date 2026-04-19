"use strict";

const S = window.PharmacyState;
const FS = window.PharmacyStorage;

const MIN_SCAN_LEN = 4;
const MAX_INTER_KEY_GAP_MS = 80;
const POLL_INTERVAL_MS = 1000;
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
const onboardingEl = $("onboarding");
const mainEl = $("main");
const filePathEl = $("file-path");

let handle = null;
let state = { version: 1, entries: [] };
let lastMtime = 0;
let filter = "";
const mutex = FS.makeMutex();

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
    prev.title = `${entry.rawCode.length} characters · click row to copy`;
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
      setStatus("Read failed: " + err.message, "err");
      throw err;
    }
    const next = apply(current);
    if (!next) return;
    try {
      await FS.writeState(handle, next);
    } catch (err) {
      setStatus("Write failed: " + err.message, "err");
      throw err;
    }
    state = next;
    const file = await handle.getFile();
    lastMtime = file.lastModified;
    render();
  });
}

async function submitScan(rawCode) {
  if (!S.validateRawCode(rawCode)) {
    setStatus("Scan ignored (length)", "warn");
    return;
  }
  const entry = S.createEntry(rawCode, "");
  try {
    await mutate((cur) => S.addEntry(cur, entry));
    setStatus(`Parked (${rawCode.length} chars)`, "ok");
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
    setStatus("Copied. Paste into the gov system.", "ok");
  } catch (err) {
    setStatus("Copy failed: " + err.message, "err");
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

    if (buffer.length > 0 && gap > MAX_INTER_KEY_GAP_MS && !e.ctrlKey) reset();

    if (["Shift","Control","Alt","AltGraph","Meta","CapsLock","NumLock","ScrollLock","Dead"].includes(e.key)) {
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (buffer.length >= MIN_SCAN_LEN) { const c = buffer; reset(); submitScan(c); }
      else reset();
      return;
    }

    if (e.ctrlKey && (e.code === "BracketRight" || e.key === "]")) {
      e.preventDefault();
      buffer += "\u001D";
      updateIndicator();
      return;
    }

    if (e.key === "Tab") { e.preventDefault(); buffer += "\t"; updateIndicator(); return; }

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault(); buffer += e.key; updateIndicator(); return;
    }

    if (e.ctrlKey || e.altKey || e.metaKey) e.preventDefault();
  });

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
window.addEventListener("focus", ensureScanFocus);

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
    setStatus("Pick failed: " + err.message, "err");
    return;
  }
  await start();
}

function showOnboarding() {
  onboardingEl.hidden = false;
  mainEl.hidden = true;
  $("unsupported").hidden = FS.supported();
}

function showMain() {
  onboardingEl.hidden = true;
  mainEl.hidden = false;
  filePathEl.textContent = handle ? (handle.name || "selected file") : "—";
  ensureScanFocus();
}

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!handle) return;
    try {
      const file = await handle.getFile();
      if (file.lastModified !== lastMtime) {
        lastMtime = file.lastModified;
        state = S.normalizeState(JSON.parse((await file.text()) || "{}"));
        render();
      }
    } catch (err) {
      setStatus("Poll failed: " + err.message, "warn");
    }
  }, POLL_INTERVAL_MS);
}

async function start() {
  const perm = await FS.ensurePermission(handle, "readwrite");
  if (perm !== "granted") {
    setStatus("Permission denied. Click the page then try again.", "err");
    showOnboarding();
    return;
  }
  try {
    await readFromDisk();
  } catch (err) {
    setStatus("Initial read failed: " + err.message, "err");
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
  setStatus("Click “Choose existing file” to resume.", "warn");
}

init();
