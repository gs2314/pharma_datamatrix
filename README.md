# Pharmacy Parker

Park the GS1 DataMatrix on a meds box now, register it with the
government system later — once the prescription actually arrives. A
digital replacement for the old peelable stickers that Greek
pharmacists used to keep for emergency dispenses.

**No server. No cloud. No accounts.** A single HTML page running in
each counter's browser reads and writes one shared JSON file on a
Windows file share. Every counter sees the same list within ~1 second
of any change. The raw scanner payload — including the invisible
`0x1D` GS separator that vanilla edit controls silently strip — is
captured at the keystroke level and replayed verbatim via the
clipboard.

## What it looks like

```
┌─────────────────────────────────────────────────────┐
│  Scan here                                          │
│  [ ............................... ]  Ready        │
│                                                     │
│  Pending (3)                 [ filter by note ... ] │
│  ────────────────────────────────────────────────── │
│  12:41  01034···8821S       Maria K.    [Copy] [×]  │
│  12:17  01034···7710S       —           [Copy] [×]  │
│  11:58  01034···4433S       G. Papadop  [Copy] [×]  │
└─────────────────────────────────────────────────────┘
```

## How it works

1. **Share:** one PC hosts a shared folder on the pharmacy LAN, e.g.
   `\\mainpc\parker\entries.json`. Any Windows file share works.
2. **Pick:** each counter opens `index.html` in **Microsoft Edge** and
   clicks **Choose existing file** on first launch. The browser
   remembers the handle in its own IndexedDB, so subsequent launches
   reconnect automatically.
3. **Park:** focus the window, scan a box. The keystrokes are
   captured at `keydown` level — including `Ctrl+]` from the scanner,
   remapped to the real U+001D byte. Trailing `Enter` commits the
   entry. The app reads the shared file, appends the new entry, and
   writes it back atomically (via the File System Access API's
   swap-on-close semantics). Optionally type a patient note.
4. **Sync:** every counter polls the shared file once per second. On
   any change (mtime differs), it re-reads and re-renders. No server,
   no push.
5. **Register:** when the prescription arrives, find the entry
   (newest on top, or type-to-filter by note), press Enter on the
   row. The full raw string — GS bytes intact — lands on the
   clipboard. Paste into the gov system's scan field and submit.
   Delete the row with the `×` button or Delete key.

## Why no server

The whole "keep a list of pending codes shared across a few counters"
problem only needs a shared file. The File System Access API lets
browsers read and write local / network files directly, with a
user-granted persistent handle. Adding a server process adds a
component that can crash, needs starting on boot, requires firewall
rules, and has to be kept in sync with the frontend. Just writing
JSON to an SMB share is simpler.

## Why the keystroke-level capture matters

GS1 DataMatrix payloads contain the `0x1D` Group Separator as
FNC1 between variable-length Application Identifiers. Keyboard-wedge
scanners emit it as `Ctrl+]`. **Standard Windows edit controls —
including Notepad and vanilla HTML `<input>` — silently strip
`0x1D` on input.** That is why pharmacists who try to copy the
scanner's output out of Notepad find it rejected by the gov system:
the separator was never in Notepad in the first place.

Pharmacy Parker hooks `keydown` on the window *before* any edit
control sees the key, so `Ctrl+]` becomes a real `\u001D` in our
buffer and stays there through storage, the clipboard, and paste.

## Browser support

Microsoft Edge or Google Chrome on Windows, version 108 or newer.
(Any Chromium-based browser with the File System Access API.)
Firefox and Safari do not implement the API; they are not supported.
In practice every Greek pharmacy ships with Edge pre-installed, so
this is not a practical constraint.

## Gov-system paste compatibility check

Most Windows edit controls accept `0x1D` on paste. Some custom apps
strip it. Verify yours in 20 seconds:

- Open **Settings → Copy test string** to load the fixture
  `TESTA\u001DTESTB` onto the clipboard.
- Focus the gov system's scan field and press **Ctrl+V**.
- **11 characters** pasted means the gov field accepts paste — done.
- **10 characters** (`TESTATESTB`) means it strips control chars on
  paste. Use the `tools/paste-raw.ahk` keystroke helper below.

### Fallback: keystroke helper

`tools/paste-raw.ahk` is a tiny AutoHotKey v2 script. Compile it to
`paste-raw.exe` with
[Ahk2Exe](https://www.autohotkey.com/docs/v2/Compile.htm) and drop
it in the Windows Startup folder on each counter. It registers
**F12** as a global hotkey: when pressed, it reads the clipboard and
types each character as an HID keystroke, sending `Ctrl+]` for every
`0x1D`. Identical at the hardware level to the scanner. Use **F12**
instead of **Ctrl+V** on machines whose gov field strips control
chars on paste.

## Setup (under 5 minutes per pharmacy)

1. **On the main counter PC:** create a shared folder
   (e.g. `C:\parker\`, shared as `\\mainpc\parker\`) with
   Read/Write permissions for the other counters.
2. **Copy the app files** (`index.html`, `app.js`, `state.js`,
   `storage.js`, `style.css`) into a local folder on **every**
   counter, e.g. `C:\Users\Public\Parker\`. (Keeping the HTML local
   avoids `file://` cross-share quirks; only `entries.json` needs
   to live on the share.)
3. On each counter, **double-click `index.html`**. Edge opens it.
   Click **Choose existing file** (or **Create new file** on the
   first counter) and select `\\mainpc\parker\entries.json`. Grant
   read/write permission. The selection is remembered.
4. Run the **Test paste** step above once per pharmacy. Install the
   AHK helper only if paste strips the separator.
5. Smoke test: scan a real meds box on counter A, confirm the row
   appears on counter B within ~1 s, copy on B, paste into the gov
   system, confirm accepted.

## Files

```
index.html         Single-page UI.
state.js           Pure state helpers (add/update/remove/sanitize).
storage.js         File System Access API + IndexedDB handle cache.
app.js             Scan capture (keydown-level), rendering, polling, mutations.
style.css          Dark, high-contrast counter UI.
tools/
  paste-raw.ahk    Optional AutoHotkey v2 keystroke-synth fallback.
test/
  state.test.js    Unit tests for state helpers (byte-fidelity for 0x1D).
```

## Running the tests

Requires Node 18+.

```
node --test test/state.test.js
```

## Design notes

- **Raw payload is sacred.** `rawCode` is stored and rendered
  verbatim. Nothing normalizes, trims, or re-encodes it.
  `JSON.stringify` escapes `0x1D` as `\u001d` on disk; `JSON.parse`
  restores the real code point in memory; `navigator.clipboard.writeText`
  preserves it onto the clipboard.
- **Atomic writes.** `FileSystemFileHandle.createWritable()` stages
  the new content and `close()` swaps it in. Mid-write crashes cannot
  produce a partially written file.
- **Cross-counter races.** Each mutation does a read → apply → write
  under a per-tab mutex. Two counters writing within ~10–50 ms of
  each other could still lose one of the two writes; at expected
  volumes (20–50 scans/day across 2–3 counters) this is negligible.
  If it ever matters in practice, the fix is a lock file, not a
  server.
- **Polling, not watching.** The API doesn't expose file-change
  notifications, so each counter checks `lastModified` once a second.
  Overhead is a single stat + occasional read.

## What it deliberately does not do

- No camera / OCR capture.
- No server of any kind.
- No cloud, no accounts, no internet dependency.
- No GS1 AI parsing — the gov system already does that.
- No duplicate detection, audit reports, or exports.

The point is to beat "cutting the DataMatrix off the box with
scissors" on the first use. Everything beyond that is YAGNI.
