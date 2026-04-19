# Pharmacy Parker

Park the GS1 DataMatrix on a meds box now, register it with the
government system later — once the prescription actually arrives. A
digital replacement for the old peelable stickers that Greek
pharmacists used to keep for emergency dispenses.

One counter PC runs the server. The others open it in a browser over
the pharmacy LAN. No internet. No cloud. No accounts. The raw scanner
payload (including the invisible `0x1D` / GS separator) is captured at
the keystroke level, stored verbatim in a JSON file, and re-emitted
byte-for-byte to the clipboard for paste into the gov system.

## What it looks like

```
┌─────────────────────────────────────────────────────┐
│  Scan here                                          │
│  [ ............................... ]  Ready        │
│                                                     │
│  Pending (3)                 [ filter by note ... ] │
│  ────────────────────────────────────────────────── │
│  12:41  01034...8821S       Maria K.    [Copy] [×]  │
│  12:17  01034...7710S       —           [Copy] [×]  │
│  11:58  01034...4433S       G. Papadop  [Copy] [×]  │
└─────────────────────────────────────────────────────┘
```

## How it works (the 30-second tour)

1. **Park:** focus the window, scan a box. The keystrokes from the
   scanner (including any `Ctrl+]` the scanner uses for the invisible
   GS separator) are captured globally and assembled into a raw string
   containing real `\u001D` bytes. Press Enter on a blank scan magnet
   and nothing happens — the trailing Enter from the scanner commits
   the entry. Optionally type a patient note and press Enter.
2. **Sync:** the server persists the entry to `entries.json` with an
   atomic rename, then broadcasts the new state to every connected
   counter over Server-Sent Events. Siblings see the row within ~1 s.
3. **Register:** when the prescription arrives, find the entry (newest
   on top, or type-to-filter by note), press Enter on the row. The
   full raw string — GS bytes intact — lands on the clipboard. Paste
   into the gov system's scan field and submit as normal. Delete the
   row.

## Why the clipboard (and when it is not enough)

Standard Windows edit controls — including Notepad and vanilla HTML
`<input>` — silently strip the `0x1D` GS character on input. That is
why pharmacists who try to copy a scanned code out of Notepad find it
rejected by the gov system: the separator was never in Notepad in the
first place.

Pharmacy Parker hooks `keydown` on the window *before* any edit
control sees the key, so `Ctrl+]` becomes a real `\u001D` in our
buffer and stays there through storage, the clipboard, and paste.

Almost every gov-system field is a standard Windows edit control that
accepts `0x1D` on paste. Verify yours in 20 seconds:

- Open **Settings → Copy test string**. The fixture
  `TESTA\u001DTESTB` lands on the clipboard.
- Focus the gov system's scan field and press **Ctrl+V**.
- Count the characters. **11 means your gov field accepts paste —
  done.** 10 (`TESTATESTB`) means it strips control chars; switch to
  the keystroke helper (below).

### Fallback: keystroke helper

`tools/paste-raw.ahk` is a tiny AutoHotKey v2 script. Compiled to
`paste-raw.exe`, it registers **F12** as a global hotkey: when
pressed, it reads the clipboard, types the characters as HID
keystrokes, and sends `Ctrl+]` for every `0x1D`. Identical at the
hardware level to the scanner. Use **F12** instead of **Ctrl+V** on
machines where the gov field strips control chars on paste.

## Setup (5 minutes per pharmacy)

1. Copy `pharmacy-parker.exe` (built from `server/`) to a folder on
   the main counter PC. Make a Desktop shortcut and add one to the
   Startup folder so it runs at login.
2. Double-click it. The console prints the URLs to bookmark on every
   counter — one `http://localhost:5577/` for this PC and one
   `http://<lan-ip>:5577/` for the others.
3. Open the URL in Chrome or Edge on every counter. Allow the
   "Clipboard" permission on first use (one click).
4. Run the **Test paste** step above once per pharmacy. If paste
   fails, also drop `paste-raw.exe` in Startup and use F12 instead of
   Ctrl+V for the register step.
5. Smoke test: scan a real meds box, confirm the row appears on every
   counter, copy, paste into the gov system, confirm it is accepted.

## Files

```
server/
  server.js         HTTP + SSE + atomic JSON persistence. Zero deps.
  package.json
client/
  index.html        Single-page UI.
  app.js            State, SSE client, keydown scan capture, clipboard.
  style.css         Layout, big fonts, high-contrast.
test/
  roundtrip.test.js End-to-end 0x1D byte-fidelity test.
tools/
  paste-raw.ahk     Fallback keystroke helper (AutoHotKey v2).
entries.json        (Created on first run.)
entries-YYYYMMDD.json (Daily rolling backups, 7 days.)
```

## Running from source

Requires Node 18+.

```
cd server
npm start
```

Environment variables:

- `PORT` (default `5577`)
- `HOST` (default `0.0.0.0`)
- `DATA_DIR` (default: current working directory)

## Building the Windows exe

```
cd server
npx pkg . --targets node18-win-x64 --output ../dist/pharmacy-parker.exe
```

`pkg` bundles Node + the script into a single exe. The `client/`
folder is included via the `pkg.assets` field.

## Tests

```
cd server
npm test
```

The roundtrip test starts the real server against a scratch
`entries.json`, POSTs a payload containing `\u001D`, subscribes to the
SSE stream, deletes the entry, and asserts byte equality at every
hop — including the JSON on disk.

## Design notes

- **No authentication.** Being on the pharmacy LAN is the
  authorization boundary. Same trust model as the shared printer or
  POS. The server binds to `0.0.0.0` by default so the other counters
  can reach it; bind it to a specific interface if your router has
  untrusted guests.
- **Single writer.** Clients `POST` / `PATCH` / `DELETE` intents; the
  server applies them and rebroadcasts the authoritative state over
  SSE. No client-side merge logic, no concurrency bugs.
- **Atomic persistence.** Every write goes to `entries.json.tmp` and
  is renamed over the live file, so a crash mid-save cannot corrupt
  the store. A dated copy is kept for 7 days.
- **Raw payload is sacred.** `rawCode` is stored and broadcast
  verbatim. Nothing normalizes, trims, or re-encodes it. The only
  transformation anywhere is URL-to-clipboard via
  `navigator.clipboard.writeText`, which preserves `U+001D`.

## What it deliberately does not do

- No camera / OCR capture.
- No GS1 AI parsing — the gov system already does that.
- No direct API to the gov system.
- No per-pharmacist accounts, logins, or multi-device cloud sync.
- No duplicate detection, audit reports, or exports.

These are omissions on purpose. The tool exists to beat "cutting the
DataMatrix off the box with scissors" on the first use.
