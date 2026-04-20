# Pharmacy Parker — PRD

## Original problem statement

Counter app for Greek/EU pharmacies. Park GS1 DataMatrix scans from
prescription-medicine boxes into a shared JSON file on an SMB share;
at a later date, put the parked payload back into the national HMNO /
EMVS verification portal when the prescription actually arrives.
Original box is gone by that point.

User constraints (explicit):

1. Do not alter the hardware scanner's configuration. When the
   scanner is pointed at the original box directly, it already works
   with the gov validator — that path must stay authoritative.
2. The app should not require specific paste-or-re-scan behavior
   from the operator; it must cover whatever path is practical
   (paste when possible, re-scan from screen when paste is lossy).

## Architecture

- `index.html` — single-page UI, template-based entry rows, enlarge-
  for-scan modal.
- `state.js` — pure state helpers (browser + Node). Entries carry
  `rawCode` (verbatim), `parsed` (AI structure), `canonical` (pure-
  digit emission), `valid` + `issues` (validation report).
- `gs1.js` — GS1 parser + validator + three emission formats:
  - `parse(raw)` handles fixed + variable AIs, leading symbology
    identifier `]d2`/`]C1`, leading/mid/trailing FNC1, unknown AIs.
  - `validateMedicine(parsed)` enforces the four FMD-required AIs.
  - `validateGTIN` — Mod-10 check digit per §3.2.
  - `validateExpiry` — YYMMDD, GS1 `DD=00` last-of-month, month-
    range, month-length.
  - `validateAI82` — §7.11 character set for batch & serial.
  - `toCanonicalPlain` — pure digits/letters in canonical order
    `01 · 17 · 10 · 21`.
  - `toCanonicalGS1` — strict element-string form with FNC1
    separators.
  - `toBracketedAI` — bwip-js / BWIPP input form `(01)…(17)…(10)…
    (21)…`.
  - `canRegenerateBarcode` — gate for the re-scan-from-screen path.
- `vendor/bwip-js.min.js` — bwip-js 4.9.0, BWIPP 2026-03-31. Used
  exclusively in `gs1datamatrix` mode with bracketed-AI input — the
  documented standards-first path. FNC1 is never hand-injected in
  the generator pipeline.
- `storage.js` — unchanged: File System Access API + IndexedDB
  handle cache, atomic writes, per-tab mutex.
- `app.js` — scan capture (FNC1 preserved: Ctrl+] and Alt+numpad 029
  → U+001D), parse-on-submit, structured entry render with inline
  DataMatrix thumbnail per row, click-to-enlarge scan modal at
  scale 8 (≈40 mm symbol on a 96 DPI monitor, inside the operating
  range of every CCD/area imager).

## User personas

- Pharmacist at a Greek / EU pharmacy counter, running Edge on a
  shared Windows workstation. Shared `entries.json` on a network
  folder; 2–3 counters access concurrently. Hardware scanner is
  already tuned for the gov validator and must not be reconfigured.

## Core requirements (static)

- Park scans losslessly (raw bytes preserved on disk).
- Validate GS1 compliance at capture time, make validation failures
  visually unambiguous on the counter (red row + inline error chip)
  — not a silent "portal rejected it" surprise minutes later.
- Offer three independent registration paths from the same stored
  structure:
  - Re-scan from screen (primary): hardware scanner + on-screen
    bwip-js DataMatrix.
  - Canonical pure-digit paste (fallback): works with portals whose
    edit control strips control chars.
  - Raw scan paste with FNC1 intact: for strict-GS1 ERP systems.
- No server, no cloud, no accounts.

## What's been implemented (2026-01)

- **GS1 parser** (gs1.js, 22 unit tests) — AI-aware tokenizer, GTIN
  Mod-10 check digit, expiry validation with `DD=00` convention,
  AI-82 character set enforcement, canonical pure-digit emission,
  strict FNC1-separated emission, bracketed-AI emission for
  bwip-js, `canRegenerateBarcode` gate.
- **bwip-js integration** — vendored 4.9.0 locally (no CDN; app runs
  from file:// on pharmacy workstations), wired into `renderBarcodeTo`
  in app.js, called from both row-level thumbnail rendering
  (scale 3) and modal rendering (scale 8). All BWIPP errors
  (invalid checksum, bad AI structure) caught and gracefully hide
  both the barcode and the Scan button so operators never see a
  broken regeneration path offered.
- **Scan modal** — enlarged DataMatrix on white background, pure
  CSS, Esc/backdrop click to close, bracketed-AI source shown
  underneath for operator verification.
- **Three-button row UI** — Scan (re-scan from screen, primary),
  Copy (canonical pure-digit clipboard), Raw (original scan with
  FNC1), plus ×. Smart visibility: each button hides automatically
  when its path is unavailable for that entry (parse failure,
  invalid checksum, etc.).
- **Backward-compatible state shape** — `state.js` still preserves
  byte-for-byte `rawCode`; the original 8 state tests still pass.
- **HTML/CSS cleanup** — removed stale FNC1 test-fixture copy,
  wired the previously-dead Copy-log button, updated settings-panel
  copy to explain all three registration paths.
- **Tests** — 30 passing total (8 state + 22 gs1); lint clean.

## Prioritized backlog

- **P1** — Duplicate-serial detection: warn when scanning a serial
  already parked (AI 21 match). Catches re-scans of the same box.
- **P2** — CSV export with parsed AI fields, for shift handover /
  audit.
- **P2** — NHRN (national reimbursement number, AIs 710-713) chip
  when present on the pack.
- **P3** — Optional lock-file on the shared JSON to eliminate the
  10-50 ms cross-counter race window.
- **P3** — Optional print-to-label output via the same bwip-js
  pipeline, for pharmacies that want to re-label compounded/split
  stock.

## Next tasks

- None pending; iteration complete and tested.

## Iteration history

- 2026-01 iteration 1: basic FNC1 preservation on clipboard.
  Superseded — portals strip U+001D on paste.
- 2026-01 iteration 2: blind-strip all non-alphanumeric on copy.
  Superseded — loses AI-82 punctuation and makes batch/serial
  boundaries ambiguous.
- 2026-01 iteration 3: GS1 parser/validator + canonical pure-digit
  emission in `01 · 17 · 10 · 21` order. Partial win — works for
  "dirty parser" receivers but still depends on the portal
  accepting the canonical concatenation.
- 2026-01 iteration 4 (current): add bwip-js standards-first
  DataMatrix regeneration as the primary registration path.
  Clipboard paths retained as fallbacks. No assumption about
  portal paste behavior remains load-bearing.
