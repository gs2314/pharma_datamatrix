# Pharmacy Parker — PRD

## Original problem statement

Counter app for Greek/EU pharmacies. Park GS1 DataMatrix scans from
prescription-medicine boxes into a shared JSON file on an SMB share;
copy the payload to the clipboard later for pasting into the national
HMNO / EMVS verification portal.

Recent history:

- Previous iteration preserved FNC1 (U+001D) on the clipboard. The
  HMNO portal silently strips control characters on paste, causing
  silent corruption of the pasted payload.
- User requested a fix that produces pure-digits/letters on the
  clipboard while remaining **100% GS1 / HMNO compliant** for the
  encoded DataMatrix content, and requested that dead HTML UI
  elements be cleaned up.

## Architecture

- `index.html` — single-page UI, template-based entry rows.
- `state.js` — pure state helpers (browser + Node). Extended to
  carry optional parsed-AI structure on entries.
- `gs1.js` — **new.** GS1 parser + validator:
  - AI table covering fixed-length (01, 11, 13, 15, 17, 20, …) and
    variable-length (10, 21, 22, 30, 240-series, 710-713, 8005, …) AIs.
  - `parse(raw)` → `{ fields, order, errors, warnings }`.
  - `validateMedicine(parsed)` → checks the four FMD/EMVS-required
    AIs (01 GTIN, 17 expiry, 10 batch, 21 serial).
  - GTIN Mod-10 check digit (per GS1 General Specifications §3.2).
  - YYMMDD validation with GS1 `DD=00` last-of-month convention.
  - AI-82 character set enforcement (§7.11) for batch & serial.
  - `toCanonicalPlain(parsed)` → pure digits/letters in order
    `01 · 17 · 10 · 21` (portal-friendly; unambiguous without FNC1
    because variable-length AIs 10 & 21 sit on opposite sides of the
    fixed `21` prefix).
  - `toCanonicalGS1(parsed)` → strict GS1 element-string form with
    FNC1 separators (for ERP/strict-GS1 receivers).
- `storage.js` — unchanged. File System Access API + IndexedDB handle
  cache, atomic writes, per-tab mutex.
- `app.js` — scan capture (keydown-level) **restores** FNC1 injection
  from `Ctrl+]` and `Alt+numpad 029` so the parser can see AI
  boundaries. On submit: parse → validate → store structured entry →
  render with GTIN/EXP/LOT/SN chips and an inline ⚠ flag on failure.
  Row has **Copy** (canonical pure-digits) and **Raw** (original scan
  with FNC1 preserved) buttons.

## User personas

- Pharmacist at a Greek / EU pharmacy counter, running Edge on a
  shared Windows workstation. Shared `entries.json` on a network
  folder; 2–3 counters access it concurrently.

## Core requirements (static)

- Park scans with zero loss of information (keep raw + parsed).
- Canonical clipboard payload that the HMNO/EMVS portal accepts
  after FNC1-stripping by the portal's edit control.
- Visible validation of GTIN check digit, expiry date, and AI-82
  conformance so bad scans are caught on the counter, not at the
  portal.
- No server, no cloud, no accounts.

## What's been implemented (2026-01)

- GS1 parser with AI-aware tokenization (fixed + variable length).
- GTIN Mod-10 check digit validation.
- Expiry YYMMDD validation (month/day, `DD=00` last-of-month).
- AI-82 character set validation for batch & serial.
- Canonical clipboard emission in order `01 · 17 · 10 · 21` without
  FNC1.
- Strict GS1 emission with FNC1 separators (secondary copy mode).
- Structured entry rendering with GTIN/EXP/LOT/SN chips and a red
  validation flag chip.
- Filter extended to match note / batch / serial / GTIN / canonical.
- HTML cleanup: removed stale FNC1-test-fixture copy, updated
  settings-panel copy to describe the new parse→validate→emit flow.
- Dedicated `test/gs1.test.js` with 19 tests covering parser,
  validators, and canonical emitters. State tests (8) still green.

## Prioritized backlog

- **P1** — Optional toast/alert on duplicate serial detection
  (same AI 21 already parked): helps a busy counter catch a
  re-scan of an already-parked box.
- **P2** — CSV export of parked entries with parsed fields for
  audit / shift handover.
- **P2** — NHRN (national reimbursement number, AIs 710-713) display
  chip when present.
- **P3** — Optional lock-file discipline on the shared file to
  eliminate the 10–50 ms cross-counter race window.

## Next tasks

- None pending; iteration complete and tested.
