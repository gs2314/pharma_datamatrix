# QR Ordering System — PRD

## Original problem statement

Commercial Windows desktop app, distributed as a signed `.exe`
installer. Tracks scanned GS1 DataMatrix codes ("QRs") grouped
under Orders grouped under Contacts. Starts as a rename/repackage of
the Pharmacy Parker alpha once it hit 20/20 real-world scans.

### Commercial constraints

- Single-file deliverable (Electron .exe) that the vendor ships
  per license.
- Online license activation bound to workstation HWID, with a
  vendor-hosted PHP backend (user-implemented, spec in README).
- 7-day offline grace.
- Persistent file access (no per-session permission prompts —
  vendor-grade UX).
- Always-on-top floating scannable-QR window so the pharmacist can
  keep the gov validator focused while scanning from screen.

### Data model constraints (fresh start)

Three-level hierarchy:

- **Contact** { id, name, surname, tel, createdAt }
- **Order**   { id (global UUID), contactId, orderNumber (per-contact
                sequential 1,2,3…), orderDate, confirmationDate,
                status (confirmed/unconfirmed), createdAt }
- **QR**      { id, orderId, rawCode (FNC1 preserved), parsed,
                canonical, valid, issues, note, scannedAt }

No v1 data to migrate (alpha hadn't been commercialized); however
a v1-migration path is implemented so old files don't get silently
clobbered.

## Architecture

### Process split

**Electron main process** (`main.js`):
- Owns both BrowserWindows (main + always-on-top popup).
- Mediates filesystem I/O via IPC → renderer never sees the File
  System Access API permission prompt.
- Computes a stable HWID (SHA-256 over non-internal MAC addresses
  + hostname).
- Is the HTTP client for the PHP license server (native `https`
  module, no renderer-side fetch).
- Caches license response in `%APPDATA%/QR Ordering System/license.json`.

**Preload** (`preload.js`):
- Context-isolated IPC bridge. Exposes a typed `window.electronAPI`
  surface to the renderer; nothing else.

**Renderer** (`app.js`, `license.js`, `state.js`, `gs1.js`,
`storage.js`, `popup.js`):
- UI, data mutations, scanner capture, validation, rendering.
- Dual-mode storage backend: Electron (native paths via IPC) or Web
  (File System Access API — for dev).

### File layout

See `README.md` "Files" section.

### License protocol

Single endpoint: `POST <LICENSE_SERVER>/verify`. Request:
`{license_number, hwid, app_version}`. Response: `{valid:true, owner:{…}}`
or `{valid:false, reason:…}`. Full schema + PHP-side suggestion in
README.

Client caches a successful response and re-verifies weekly; offline
grace 7 days before gate re-appears.

## User personas

- **Pharmacist** (Greek pharmacy counter). Daily user. Non-technical.
  Expects: double-click icon, enter license, pick file once, then
  pick contact → pick order → scan → eventually scan-from-popup
  into the gov validator.
- **Vendor** (you). Packages the `.exe`, issues license keys into
  the PHP DB, charges manually. Sees activation telemetry via
  `last_seen_at` in the DB.

## Core requirements

- **Lossless capture**: scan → parsed structure + raw bytes stored.
- **Validation at capture time**: GTIN check digit, expiry date,
  AI-82 charset for batch/serial. Invalid rows visually flagged.
- **Three registration paths per QR**:
  1. **Pop-out** → always-on-top native window with bwip-js-
     regenerated DataMatrix, for re-scan from screen.
  2. **Copy** → canonical pure-digit clipboard payload.
  3. **Raw** → original scan bytes (FNC1 intact) for strict-GS1
     receivers.
- **No server for the data plane**. Shared JSON on SMB, polled 1 Hz.
- **Activated, HWID-bound license** on startup. 7-day offline grace.
- **Per-contact sequential order numbering** (#1, #2, … per
  customer; independent across customers).
- **Confirm/unconfirm order**. Confirmed orders lock out further
  QR additions.
- **Cascading deletes** with confirm dialogs at Contact and Order
  levels.
- **Duplicate-serial detection** with operator override dialog.

## What's been implemented (this iteration)

### Renamed / repackaged from Pharmacy Parker alpha
- Every string, code identifier, file, doc renamed to "QR Ordering
  System". `PharmacyState → AppState`, `PharmacyGS1 → QRGS1`,
  `PharmacyStorage → AppStorage`.

### New data model + state helpers (state.js)
- Pure CRUD for Contact / Order / QR with cascading deletes,
  per-contact order numbering, duplicate-serial finder, orphan
  filter, v1→v2 migration. 10 unit tests.

### Electron shell
- `main.js` (300 LOC): main + popup windows, IPC handlers for fs /
  popup / license, HWID, HTTPS license client with 7-day offline
  grace.
- `preload.js`: context-isolated `window.electronAPI` bridge.
- `package.json`: `electron` + `electron-builder` configured for
  NSIS installer + portable `.exe`.
- `popup.html` + `popup.js`: always-on-top floating window UI.

### License client (license.js)
- Thin wrapper around IPC. Auto-passes in web dev mode.
- Reason labels localized-ish (English for now, easy to translate).

### Dual-backend storage (storage.js)
- Electron backend: native fs via IPC. No permission prompts; atomic
  write via `.tmp` rename.
- Web backend: File System Access API + IndexedDB handle cache
  (prior alpha behavior). Used for browser dev only.

### Three-panel renderer (app.js + index.html + style.css)
- Left: Contacts list with filter, order-count badge, cascading
  delete, double-click to edit, **+ New** → modal.
- Middle: Orders list for selected contact, confirmed/unconfirmed
  status chips, QR-count badge, cascading delete.
- Right: QR list for selected order, scan magnet (enabled only on
  unconfirmed selected order), Confirm/Unconfirm order button,
  per-row Pop-out/Copy/Raw/× buttons, inline DataMatrix thumbnail.
- License gate screen as a full-viewport modal before the rest of
  the UI paints.
- Owner badge (company + name) shown in top bar once activated.

### Documentation
- README: build instructions, license HTTP contract with PHP
  schema suggestion, counter setup, files, dev mode.
- TESTING.md: 58 numbered test items across license flow, file
  access, 3-panel CRUD, scanning, always-on-top popup, multi-
  counter sync, storage integrity, end-to-end scenarios, known
  limitations.

## Prioritized backlog

- **P1** — Rebind UX for HWID (after motherboard replacement). Today
  the customer calls the vendor; possible self-service via a
  "rebind" button + email OTP.
- **P1** — CSV export of contacts / orders / QRs for audit.
- **P2** — NHRN (AI 710-713) chip support in the QR row.
- **P3** — Batch scan-from-popup (queue up 5 QRs → autoplay them
  into the popup with a keystroke to advance).
- **P3** — Lock-file coordinator for multi-counter races (currently
  10-50 ms window).
- **P3** — Additional languages beyond Greek (framework is in place
  via `i18n.js`).

## Iteration history

- alpha 2026-01 — Pharmacy Parker. Flat `entries[]`, File System
  Access API, in-page modal, no license. 20/20 real-world scans at
  one pharmacy → validates the scanner/parser/regeneration pipeline
  is production-ready.
- alpha 2026-01 (late) — this iteration: rename + 3-level data
  model + Electron shell + online license + always-on-top popup +
  persistent file access. Product is now commercially shippable.
- **2026-02-20** — Greek localization pass:
  - `i18n.js`: central Greek dictionary + tiny DOM binder
    (`data-i18n`, `data-i18n-html`, `data-i18n-placeholder`,
    `data-i18n-title`, `data-i18n-aria-label`). Single call
    `I18N.apply(document)` at boot paints all static copy.
  - `index.html`: `lang="el"`, title and all user-facing strings
    bound via `data-i18n*`. `data-testid` added to every
    actionable control for automated testing.
  - `app.js`: every dynamic status message, `confirm()` dialog,
    render label, placeholder, scan-state indicator, license
    gate message, settings-panel string, and owner badge now
    flows through `I18N.*`. 0 leftover English strings.
  - `style.css` + HTML: **order-level notes** textarea added above
    the scan panel (parity with per-QR notes). Auto-saves
    (debounced 400ms), read-only + locked styling when the order
    is confirmed, caret preserved through poll-driven re-renders.
  - **Help modal** (`#help-modal`) accessible via new top-bar
    button (next to Ρυθμίσεις): left-nav with 6 Greek help
    sections (Πρώτη εκκίνηση, Καθημερινή ροή εργασίας,
    Αιωρούμενο παράθυρο QR, Πολλαπλοί σταθμοί, Άδεια χρήσης,
    Επίλυση προβλημάτων), Esc/overlay/× to close.
  - `package.json` build `files` list updated to include
    `i18n.js` in the NSIS/portable installer.
  - All 32 unit tests still pass. Smoke-tested in browser:
    onboarding, main UI, help modal navigation, settings panel,
    and owner badge all render in Greek with no console errors.
