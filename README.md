# QR Ordering System

Commercial Windows desktop app for tracking scanned GS1 DataMatrix
codes through a **Contact → Order → QR** hierarchy, with online
license activation, native always-on-top QR popup window, and
standards-first DataMatrix regeneration via
[bwip-js](https://github.com/metafloor/bwip-js) (BWIPP
`gs1datamatrix` encoder, bracketed-AI input).

Deliverable: a single Windows `.exe` installer produced by
`electron-builder`.

## Hierarchy

```
Contact ───────────┐
  Name, Surname,   │
  Tel              │
                   ▼
                Order ─────────┐
                  Per-contact  │
                  sequential # │
                  Order date   │
                  Confirmation │
                  Status       │
                               ▼
                             QR
                               GTIN (AI 01)
                               Expiry (AI 17)
                               Batch (AI 10)
                               Serial (AI 21)
                               Raw scan bytes (FNC1 preserved)
                               Canonical pure-digit payload
                               Note
```

All three levels live in a single JSON file on a shared network
folder, polled every second by every workstation. No server runs
for the data plane. A separate license server (HTTP, vendor-hosted)
answers startup activation checks.

## Build (Windows)

Requires Node 18+ on the build machine. Do this on the machine that
will produce the final `.exe` (the license server is not called at
build time).

```
npm install
npm run dist:win
```

Outputs:

- `dist/QROS-1.0.0-x64.exe` — NSIS installer, creates Start Menu +
  Desktop shortcut, ~100 MB.
- `dist/QROS-1.0.0-x64.exe` (portable variant via
  `npm run dist:winportable`) — standalone .exe, no install.

### License server base URL at build time

The app calls `POST $LICENSE_SERVER/verify` on every startup. Set
`LICENSE_SERVER` in the environment when **running** the app
(it's read in the main process from `process.env.LICENSE_SERVER`).
For a production build you'll want to bake the URL in — change the
fallback in `main.js`:

```js
const LICENSE_SERVER = process.env.LICENSE_SERVER || "https://licenses.example.com";
```

to your actual domain.

## License server — HTTP contract (you implement in PHP)

Single endpoint, two request shapes, same response shape.

### `POST /verify`

Request body (JSON):

```json
{
  "license_number": "ABCD-EF12-3456-7890",
  "hwid":           "a1b2c3…",
  "app_version":    "1.0.0"
}
```

- `license_number` — the key the pharmacist typed (server-side,
  strip whitespace & compare case-insensitively if you like).
- `hwid` — a stable per-machine fingerprint (SHA-256 over MAC
  addresses + hostname, 32 hex chars). Issued by the client; the
  server records the first one it sees for a given license and
  rejects later mismatches. This is what prevents casual copy-the-
  folder-to-another-PC sharing.
- `app_version` — `package.json` `version`, for your telemetry.

Response body (JSON, always HTTP 200 — use the `valid` field to
distinguish success/failure):

```jsonc
// Success
{
  "valid": true,
  "owner": {
    "name":    "Maria",
    "surname": "Papadopoulos",
    "company": "Papadopoulos Pharmacy Ltd.",
    "afm":     "123456789",
    "tel":     "+30 210 1234567"
  }
}

// Failure
{
  "valid":  false,
  "reason": "not_found"        // or "revoked" / "hwid_mismatch" / "expired"
}
```

The client caches the successful response locally (per-workstation,
in `%APPDATA%/QR Ordering System/license.json`) and re-checks once
a week. If the server is unreachable, the app keeps working for up
to 7 days on the cached response, then shows the license gate again.

### Storage suggestion (your PHP side)

Minimal schema:

| Field            | Type        | Notes                                         |
|------------------|-------------|-----------------------------------------------|
| `license_number` | PK, varchar | The key you hand out.                         |
| `name`           | varchar     | Owner first name                              |
| `surname`        | varchar     | Owner last name                               |
| `company`        | varchar     | Company name                                  |
| `afm`            | varchar     | Greek tax ID                                  |
| `tel`            | varchar     | Phone number                                  |
| `bound_hwid`     | varchar     | Populated on first successful activation      |
| `status`         | enum        | `"active"` / `"revoked"` / `"expired"`        |
| `created_at`     | datetime    |                                               |
| `last_seen_at`   | datetime    | Update each verify call (for your telemetry) |

Logic:

1. Row not found → `{"valid":false,"reason":"not_found"}`.
2. `status != "active"` → `{"valid":false,"reason":"revoked"}` or `"expired"`.
3. `bound_hwid` NULL → bind it to the incoming `hwid`, return success.
4. `bound_hwid` = incoming hwid → return success.
5. `bound_hwid` ≠ incoming hwid → `{"valid":false,"reason":"hwid_mismatch"}`.
   (If you want to support "moved to a new PC" rebinds, add an
   admin page that resets `bound_hwid` to NULL.)

That's the entire protocol. The vendor side owns pricing, issuance,
reset, revocation — the client never cares.

## Setup at a pharmacy counter

1. On one PC, create a shared folder and `entries.json` file
   (e.g. `\\mainpc\qros\entries.json`). Share with read/write
   permissions.
2. On each counter PC, run the installer (or drop the portable
   `.exe`). Shortcut is created in Start Menu + Desktop.
3. First launch: enter the license key you (the vendor) gave them.
   Click Activate. The app calls your server, caches the response,
   paints the owner badge in the top bar.
4. After activation, the file picker opens. Pick
   `\\mainpc\qros\entries.json`. (Or Create New on the first
   counter.) No further file-permission prompts ever — the Electron
   backend uses native file I/O.
5. The pharmacist works three-panel: pick a **Contact** (or create
   one), pick an **Order** for that contact (or create one), then
   scan GS1 DataMatrix codes into that order. Each scan parses,
   validates, and appears as a QR row with an inline scannable
   DataMatrix thumbnail.
6. When the order is ready to register with the gov validator:
   click any QR's **Pop-out** button. A tiny **always-on-top** OS
   window opens containing the regenerated scannable DataMatrix.
   Point the hardware scanner at it, from inside the gov validator's
   scan field. The scanner produces identical keystrokes to scanning
   the original printed box.
7. Mark the order **Confirm order** to lock it from further QR
   additions; stamps the confirmation date.

## What works end-to-end

- Scanner keystroke capture including FNC1 (as `Ctrl+]`).
- GS1 parse + validate: GTIN Mod-10, expiry YYMMDD with
  `DD=00` last-of-month, AI-82 character set for batch/serial.
- Duplicate-serial warning on re-scan across any order.
- Three-panel master-detail-detail UI with filter + cascading
  deletes.
- Inline per-row DataMatrix thumbnails (scale 3).
- Always-on-top native popup window for scan-from-screen (Electron).
- Fallback in-page modal for scan-from-screen (web mode).
- Three copy formats per QR: canonical pure-digits, raw with FNC1,
  rendered DataMatrix.
- Multi-counter sync via polled shared JSON file.
- Online license activation + offline grace (7 days).
- Schema v1 → v2 auto-migration (parks flat entries under an
  "Unassigned" contact/order so nothing is silently lost).

## Files

```
main.js               Electron main process: windows, IPC,
                      native fs, license HTTP client.
preload.js            Context-isolated IPC bridge.
index.html            3-panel UI + license gate + onboarding.
popup.html            Always-on-top QR popup UI.
app.js                Renderer: 3-level CRUD, scan capture,
                      rendering, polling, license flow.
popup.js              Popup renderer: receives bracketed AI via
                      IPC, renders DataMatrix.
license.js            License client (renderer side).
state.js              Pure state helpers: Contact/Order/QR CRUD,
                      normalization, v1→v2 migration.
gs1.js                GS1 parser + validator + emitters.
storage.js            Dual-backend storage: Electron (native fs)
                      / Web (File System Access API).
style.css             Dark 3-panel UI.
vendor/bwip-js.min.js bwip-js 4.9.0, BWIPP engine.
package.json          Electron + electron-builder config.

test/state.test.js    Unit tests for 3-level state.
test/gs1.test.js      Unit tests for GS1 parser/validator.

TESTING.md            Full test plan (58 numbered items).
README.md             This file.
memory/PRD.md         Product requirements & iteration history.
```

## Running tests

```
npm test
# or:
node --test test/state.test.js test/gs1.test.js
```

Current count: 32 unit tests — 10 state + 22 GS1 — all passing.

## Dev mode (no Electron, no license server)

You can iterate on the renderer without installing Electron. Serve
the folder with any static HTTP server and open `index.html` in
Edge / Chrome:

```
python3 -m http.server 8765
# then open http://localhost:8765/index.html
```

In dev/web mode:
- License gate is bypassed (`License.status()` always returns OK).
- File access uses the File System Access API (one-time permission
  prompt per session).
- Pop-out uses the in-page modal, not a real always-on-top window.

All feature testing except #3 (persistent file permission) and #4
(always-on-top popup) can be done in dev mode.
