"use strict";

const S  = window.PharmacyState;
const G  = window.PharmacyGS1;
const FS = window.PharmacyStorage;

const MIN_SCAN_LEN         = 4;
const MAX_INTER_KEY_GAP_MS = 80;
const POLL_INTERVAL_MS     = 1000;
const PREVIEW_MAX          = 28;

// A real-world valid-but-non-commercial fixture. Same structure as a
// live pack: AI 01 GTIN, 17 expiry 2027-05-31, 10 batch "00437X",
// 21 serial "37664107698060". Passes every GS1 + FMD check.
const TEST_FIXTURE =
  "01" + "05203622108740" +
  "17" + "270531" +
  "10" + "00437X" +
  "21" + "37664107698060";

const $ = (id) => document.getElementById(id);
const scanMagnet = $("scan-magnet");
const scanState  = $("scan-state");
const entriesEl  = $("entries");
const filterEl   = $("filter");
const emptyEl    = $("empty");
const countEl    = $("count");
const statusEl   = $("status");
const tpl        = $("entry-template");
const onboarding = $("onboarding");
const mainEl     = $("main");
const filePathEl = $("file-path");

let handle = null;
let state  = { version: 1, entries: [] };
let lastMtime = 0;
let filter = "";
const mutex = FS.makeMutex();

// --- tiny helpers --------------------------------------------------------

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
  // Fallback preview for old entries with no parsed structure.
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    out += code < 0x20 || code === 0x7f ? "·" : ch;
    if (out.length >= PREVIEW_MAX) { out = out.slice(0, PREVIEW_MAX) + "…"; break; }
  }
  return out;
}
function formatExpiry(yymmdd) {
  if (!/^\d{6}$/.test(yymmdd || "")) return yymmdd || "";
  return "20" + yymmdd.substr(0, 2) + "-" + yymmdd.substr(2, 2) + "-" + yymmdd.substr(4, 2);
}

// --- render --------------------------------------------------------------

function matchesFilter(entry, q) {
  if (!q) return true;
  const hay = [
    entry.note || "",
    entry.parsed?.fields?.["10"] || "",
    entry.parsed?.fields?.["21"] || "",
    entry.parsed?.fields?.["01"] || "",
    entry.canonical || entry.rawCode || "",
  ].join(" ").toLowerCase();
  return hay.includes(q);
}

function render() {
  const q = filter.trim().toLowerCase();
  const visible = state.entries.filter((e) => matchesFilter(e, q));

  countEl.textContent = String(state.entries.length);
  emptyEl.hidden = state.entries.length > 0;

  entriesEl.innerHTML = "";
  for (const entry of visible) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.dataset.id = entry.id;
    li.querySelector(".time").textContent = formatTime(entry.scannedAt);

    const gtinEl   = li.querySelector(".chip.gtin");
    const expEl    = li.querySelector(".chip.exp");
    const batchEl  = li.querySelector(".chip.batch");
    const serialEl = li.querySelector(".chip.serial");
    const flagEl   = li.querySelector(".chip.flag");

    const fields = entry.parsed?.fields || {};
    gtinEl.textContent   = fields["01"] || "";
    expEl.textContent    = formatExpiry(fields["17"]);
    batchEl.textContent  = fields["10"] || "";
    serialEl.textContent = fields["21"] || "";

    // If the scan never produced structured fields at all, fall back
    // to the old preview so the pharmacist still sees something useful.
    if (!fields["01"] && !fields["21"] && !fields["10"]) {
      gtinEl.classList.remove("gtin");
      gtinEl.textContent = previewOf(entry.rawCode || "");
      gtinEl.title = `${(entry.rawCode || "").length} chars`;
    }

    if (entry.issues && entry.issues.length) {
      flagEl.hidden = false;
      flagEl.textContent = entry.issues[0];
      flagEl.title = entry.issues.join(" · ");
      li.classList.add("invalid");
    }

    li.querySelector(".note").value = entry.note || "";
    li.classList.toggle("copied", !!entry.copiedAt);
    wireRow(li, entry);
    entriesEl.appendChild(li);
  }
}

function wireRow(li, entry) {
  const copyBtn    = li.querySelector(".copy");
  const copyRawBtn = li.querySelector(".copy-raw");
  const removeBtn  = li.querySelector(".remove");
  const noteInput  = li.querySelector(".note");

  // If the entry has no canonical payload, there is nothing to copy
  // beyond the raw scan — hide the canonical button in that case.
  if (!entry.canonical) copyBtn.hidden = true;
  // If the raw scan has no separators and equals the canonical form,
  // hide the raw button to reduce visual noise.
  if (entry.canonical === entry.rawCode) copyRawBtn.hidden = true;

  copyBtn   .addEventListener("click", (e) => { e.stopPropagation(); copyRow(li.dataset.id, "canonical"); });
  copyRawBtn.addEventListener("click", (e) => { e.stopPropagation(); copyRow(li.dataset.id, "raw"); });
  removeBtn .addEventListener("click", (e) => { e.stopPropagation(); removeRow(li.dataset.id); });

  li.addEventListener("click", (e) => {
    if (isEditable(e.target) || e.target.tagName === "BUTTON") return;
    copyRow(li.dataset.id, "canonical");
  });
  li.addEventListener("keydown", (e) => {
    if (isEditable(e.target)) return;
    if (e.key === "Enter") { e.preventDefault(); copyRow(li.dataset.id, "canonical"); }
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

// --- disk mutations (under per-tab mutex) --------------------------------

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
    try { current = (await FS.readFile(handle)).state; }
    catch (err) { setStatus("Read failed: " + err.message, "err"); throw err; }
    const next = apply(current);
    if (!next) return;
    try { await FS.writeState(handle, next); }
    catch (err) { setStatus("Write failed: " + err.message, "err"); throw err; }
    state = next;
    render();
    const file = await handle.getFile();
    lastMtime = file.lastModified;
  });
}

// --- scan pipeline -------------------------------------------------------

function buildEntryFromScan(rawScan) {
  const parsed = G.parse(rawScan);
  const report = G.validateMedicine(parsed);
  const canonical = G.toCanonicalPlain(parsed);
  return {
    rawCode: rawScan,
    parsed,
    canonical,
    valid: report.ok,
    issues: report.errors,
  };
}

async function submitScan(rawCode) {
  if (!S.validateRawCode(rawCode)) {
    setStatus("Scan ignored (too short)", "warn");
    return;
  }
  const built = buildEntryFromScan(rawCode);
  const entry = S.createEntry(built.rawCode, "", {
    parsed:    built.parsed,
    canonical: built.canonical,
    valid:     built.valid,
    issues:    built.issues,
  });

  const label = built.valid
    ? `Parked ✓ GS1 valid · ${G.describe(built.parsed)}`
    : `Parked ⚠ ${built.issues[0] || "GS1 issue"}`;

  try {
    await mutate((cur) => S.addEntry(cur, entry));
    setStatus(label, built.valid ? "ok" : "warn");
    setTimeout(() => {
      const li = entriesEl.querySelector(`li[data-id="${entry.id}"]`);
      if (li) li.querySelector(".note").focus();
    }, 30);
  } catch {}
}

async function copyRow(id, mode) {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;
  let payload;
  let label;
  if (mode === "raw") {
    payload = entry.rawCode;
    label = "Copied raw scan (with FNC1). Paste into ERP/strict-GS1 receiver.";
  } else {
    payload = entry.canonical || entry.rawCode;
    label = "Copied canonical payload. Paste into the gov portal.";
  }
  try {
    await navigator.clipboard.writeText(payload);
    setStatus(label, "ok");
  } catch (err) {
    setStatus("Copy failed: " + err.message, "err");
    return;
  }
  mutate((cur) => S.updateEntry(cur, id, { markedCopied: true })).catch(() => {});
}

async function removeRow(id) {
  try { await mutate((cur) => S.removeEntry(cur, id)); } catch {}
}
async function saveNote(id, note) {
  const current = state.entries.find((e) => e.id === id);
  if (!current || (current.note || "") === note) return;
  try { await mutate((cur) => S.updateEntry(cur, id, { note })); } catch {}
}

// --- keydown debug overlay -----------------------------------------------

const debugState = { enabled: false, start: 0, lines: [] };

function debugFmtKey(s) {
  if (typeof s !== "string") return String(s);
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out;
}
function debugLog(line) {
  if (!debugState.enabled) return;
  debugState.lines.push(line);
  if (debugState.lines.length > 400) debugState.lines.splice(0, debugState.lines.length - 400);
  const ta = $("debug-log");
  if (ta) { ta.value = debugState.lines.join("\n"); ta.scrollTop = ta.scrollHeight; }
}
function debugKeydown(e, magnetFocused) {
  if (!debugState.enabled) return;
  const t = Math.round(performance.now() - debugState.start);
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"]
    .filter(Boolean).join("+") || "-";
  debugLog(
    `[T+${String(t).padStart(5, " ")}ms] ` +
    `key=${JSON.stringify(debugFmtKey(e.key))} ` +
    `code=${e.code} mods=${mods} ` +
    `kc=${e.keyCode} charCode=${e.charCode || 0} ` +
    `repeat=${e.repeat} scanFocus=${magnetFocused}`
  );
}
function debugAction(msg) { debugLog("    " + msg); }

// --- scan capture --------------------------------------------------------
//
// FNC1 (U+001D, the GS1 Group Separator) is what tells the parser where
// batch ends and serial begins. Scanners emit it as Ctrl+] or as an
// Alt+numpad 029 sequence. We inject it into the buffer here — and
// then the parser uses it during submitScan(). The clipboard payload
// is produced from the parsed structure (not from the raw buffer), so
// the outgoing string is always pure digits/letters regardless of how
// many FNC1s we captured.

(function setupScanCapture() {
  let buffer = "";
  let lastKey = 0;
  let altNumpad = "";

  function updateIndicator() {
    if (buffer.length === 0) { scanState.textContent = "Ready"; scanState.dataset.kind = ""; }
    else { scanState.textContent = `Scanning… ${buffer.length}`; scanState.dataset.kind = "active"; }
  }
  function reset() { buffer = ""; altNumpad = ""; updateIndicator(); }

  function flushAltNumpad() {
    if (!altNumpad) return;
    const code = parseInt(altNumpad, 10);
    if (Number.isFinite(code) && code >= 0 && code <= 0xFFFF) {
      const ch = String.fromCharCode(code);
      buffer += ch;
      debugAction(
        `Alt+${altNumpad} → append U+${code.toString(16).toUpperCase().padStart(4, "0")} ` +
        `[buffer=${buffer.length}]`,
      );
    } else {
      debugAction(`Alt+${altNumpad} → invalid code, dropped`);
    }
    altNumpad = "";
    updateIndicator();
  }

  document.addEventListener("keydown", (e) => {
    const magnetFocused = document.activeElement === scanMagnet;
    debugKeydown(e, magnetFocused);
    if (!magnetFocused) {
      debugAction(`ignored (scan magnet not focused; activeElement=${document.activeElement?.tagName || "none"})`);
      return;
    }

    // Collect numpad digits while Alt is held.
    if (e.altKey && /^Numpad\d$/.test(e.code)) {
      e.preventDefault();
      altNumpad += e.code.slice(-1);
      debugAction(`alt-numpad collect "${e.code.slice(-1)}" [altBuf="${altNumpad}"]`);
      return;
    }
    // Alt released with digits pending → decode composed char into buffer.
    if (!e.altKey && altNumpad) flushAltNumpad();

    const now = performance.now();
    const gap = now - lastKey;
    lastKey = now;

    // Burst reset: any gap wider than the inter-key budget starts a
    // fresh scan. Does the double duty of silently eating trailing LF
    // from a previous scan.
    if (buffer.length > 0 && gap > MAX_INTER_KEY_GAP_MS && !e.ctrlKey) {
      debugAction(`reset buffer (gap ${Math.round(gap)}ms > ${MAX_INTER_KEY_GAP_MS}ms)`);
      reset();
    }

    if (["Shift","Control","Alt","AltGraph","Meta","CapsLock","NumLock","ScrollLock","Dead"].includes(e.key)) {
      debugAction(`modifier ignored`);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (buffer.length >= MIN_SCAN_LEN) {
        const c = buffer;
        debugAction(
          `ENTER → submit (len=${c.length}, ` +
          `bytes=${[...c].map(ch => ch.codePointAt(0).toString(16)).join(",")})`,
        );
        reset();
        submitScan(c);
      } else {
        debugAction(`ENTER → discard (buffer too short: ${buffer.length})`);
        reset();
      }
      return;
    }

    // FNC1 emitted as Ctrl+]. Injected as real U+001D so the parser
    // can use it to split variable-length AIs.
    if (e.ctrlKey && (e.code === "BracketRight" || e.key === "]")) {
      e.preventDefault();
      buffer += "\u001D";
      debugAction(`Ctrl+] → append \\u001D  [buffer=${buffer.length}]`);
      updateIndicator();
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      buffer += "\t";
      debugAction(`Tab → append \\t  [buffer=${buffer.length}]`);
      updateIndicator();
      return;
    }

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      buffer += e.key;
      debugAction(`append ${JSON.stringify(debugFmtKey(e.key))}  [buffer=${buffer.length}]`);
      updateIndicator();
      return;
    }

    if (e.ctrlKey || e.altKey || e.metaKey) {
      e.preventDefault();
      debugAction(`swallowed (unrecognized modifier combo)`);
    } else {
      debugAction(`ignored (non-printable: ${e.key})`);
    }
  }, true);

  scanMagnet.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData("text");
    if (text && text.length >= MIN_SCAN_LEN) {
      debugLog(
        `[paste] len=${text.length} ` +
        `bytes=${[...text].slice(0, 40).map(ch => ch.codePointAt(0).toString(16)).join(",")}` +
        `${text.length > 40 ? ",…" : ""}`,
      );
      e.preventDefault();
      reset();
      submitScan(text);
    }
  });
})();

// --- UI plumbing ---------------------------------------------------------

document.addEventListener("click", (e) => {
  if (!isEditable(e.target)) ensureScanFocus();
});
window.addEventListener("focus", ensureScanFocus);

filterEl.addEventListener("input", () => { filter = filterEl.value; render(); });
filterEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const first = entriesEl.querySelector("li");
  if (first) copyRow(first.dataset.id, "canonical");
});

$("settings-toggle").addEventListener("click", () => {
  const panel = $("settings-panel");
  const shown = !panel.hidden;
  panel.hidden = shown;
  $("settings-toggle").setAttribute("aria-expanded", String(!shown));
});

const toggleDebugBtn = $("toggle-debug");
const debugLogEl     = $("debug-log");
toggleDebugBtn.addEventListener("click", () => {
  debugState.enabled = !debugState.enabled;
  toggleDebugBtn.textContent = debugState.enabled ? "Disable keydown debug" : "Enable keydown debug";
  if (debugState.enabled) {
    debugState.start = performance.now();
    debugState.lines = [`[debug on] scanMagnet focused=${document.activeElement === scanMagnet}`];
    debugLogEl.value = debugState.lines.join("\n");
    setStatus("Keydown debug enabled. Focus the scan box, then scan.", "warn");
  } else {
    setStatus("Keydown debug disabled.", "ok");
  }
});
$("clear-debug").addEventListener("click", () => {
  debugState.lines = [];
  debugState.start = performance.now();
  debugLogEl.value = "";
});
$("copy-debug").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(debugLogEl.value);
    setStatus("Debug log copied.", "ok");
  } catch (err) {
    setStatus("Copy failed: " + err.message, "err");
  }
});

$("test-paste").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(TEST_FIXTURE);
    setStatus(`Reference payload copied (${TEST_FIXTURE.length} chars). Paste into the gov field.`, "ok");
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
$("pick-new")     .addEventListener("click", () => pickAndStart("new"));

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
  onboarding.hidden = false;
  mainEl.hidden = true;
  $("unsupported").hidden = FS.supported();
}
function showMain() {
  onboarding.hidden = true;
  mainEl.hidden = false;
  filePathEl.textContent = handle ? (handle.name || "selected file") : "—";
  ensureScanFocus();
}

// --- polling -------------------------------------------------------------

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
    catch (err) { setStatus("Poll failed: " + err.message, "warn"); }
    finally { pollTimer = setTimeout(loop, POLL_INTERVAL_MS); }
  };
  pollTimer = setTimeout(loop, POLL_INTERVAL_MS);
}

async function start() {
  const perm = await FS.ensurePermission(handle, "readwrite");
  if (perm !== "granted") {
    setStatus("Permission denied. Click the page then try again.", "err");
    showOnboarding();
    return;
  }
  try { await readFromDisk(); }
  catch (err) { setStatus("Initial read failed: " + err.message, "err"); showOnboarding(); return; }
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
