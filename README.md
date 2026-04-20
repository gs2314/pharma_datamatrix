# Pharmacy Parker

Park the GS1 DataMatrix on a meds box now, register it with the
government system later — once the prescription actually arrives. A
digital replacement for the old peelable stickers that Greek
pharmacists used to keep for emergency dispenses.

**No server. No cloud. No accounts.** A single HTML page running in
each counter's browser reads and writes one shared JSON file on a
Windows file share. Every counter sees the same list within ~1 second
of any change.

## What it looks like

```
┌──────────────────────────────────────────────────────────────────┐
│  Scan here                                                       │
│  [ ............................................ ]  Ready        │
│                                                                  │
│  Pending (3)                 [ filter by note, batch, serial… ]  │
│  ─────────────────────────────────────────────────────────────── │
│  12:41  GTIN 05203622108740  EXP 2027-05-31                      │
│         LOT 00437X  SN 37664107698060  Maria K.  [Copy] [Raw] [×]│
│  12:17  GTIN 05203622108740  EXP 2027-05-31                      │
│         LOT 00437X  SN 31427890123456  —         [Copy] [Raw] [×]│
│  11:58  ⚠ GTIN check digit invalid (expected 0, got 1)           │
│         GTIN 05203622108741  …                   [Copy] [Raw] [×]│
└──────────────────────────────────────────────────────────────────┘
```

## How it works

1. **Share:** one PC hosts a shared folder on the pharmacy LAN, e.g.
   `\\mainpc\parker\entries.json`. Any Windows file share works.
2. **Pick:** each counter opens `index.html` in **Microsoft Edge** and
   clicks **Choose existing file** on first launch. The browser
   remembers the handle in its own IndexedDB, so subsequent launches
   reconnect automatically.
3. **Park:** focus the window, scan a box. Keystrokes are captured at
   `keydown` level, including `Ctrl+]` (the scanner's standard encoding
   for FNC1) and `Alt+numpad 029` sequences, both of which are
   translated to the real U+001D byte in our buffer. Enter commits the
   scan.
4. **Parse + validate:** on commit, the scan is parsed by `gs1.js`
   into its GS1 Application Identifiers and validated against the
   [GS1 General Specifications](https://www.gs1.org/standards/barcodes-epcrfid-id-keys/gs1-general-specifications):
   - AI 01 GTIN: 14 digits, Mod-10 check digit
   - AI 17 expiry: YYMMDD, valid month & day, GS1 `DD=00` "last day of
     month" convention honored
   - AI 10 batch: 1–20 chars, AI-82 character set (§7.11)
   - AI 21 serial: 1–20 chars, AI-82 character set (§7.11)
   Fixed-length AIs (01, 11, 13, 15, 17, 20) consume their declared
   length exactly. Variable-length AIs (10, 21, 240, 710-713, 8005…)
   are terminated by FNC1 or end-of-buffer. Any validation issue is
   shown on the row as a red ⚠ chip before the pharmacist copies to
   the portal.
5. **Sync:** every counter polls the shared file once per second. On
   any change (mtime differs), it re-reads and re-renders.
6. **Register:** when the prescription arrives, find the entry,
   click the inline DataMatrix (or the **Scan** button on the row).
   A modal opens with a freshly-generated, **fully standards-
   compliant** GS1 DataMatrix rendered via
   [bwip-js](https://github.com/metafloor/bwip-js) (BWIPP,
   `bcid: "gs1datamatrix"`, bracketed-AI input). Point your
   hardware scanner at the screen from the gov validator — the
   scanner produces the exact same keystroke stream it would have
   produced from the original printed box, **FNC1 and all**, so the
   validator treats it as a live direct-scan. No clipboard tricks
   required.
   Secondary paths on the same row: **Copy** = canonical pure-digit
   payload (FNC1 stripped, unambiguous canonical order
   `01 · 17 · 10 · 21` — for portals that accept paste);
   **Raw** = original scan bytes including FNC1 (for strict-GS1
   ERP/warehouse receivers). Delete with `×` or Delete key.

## Why strip FNC1 on copy, but keep it on scan — and why we render
## a fresh DataMatrix instead of relying on paste

GS1 DataMatrix payloads use FNC1 (U+001D) to mark the end of
variable-length AIs — without it, `10LOT21SERIAL` is ambiguous
(batch "LOT21SERIAL" vs. batch "LOT" + serial "SERIAL"). So we
**must** keep FNC1 on the way in, or we lose information.

The HMNO / EMVS portals' edit controls (and most Windows edit
controls in general) silently **strip U+001D on paste**. Pasting a
string with embedded FNC1 therefore ends up concatenated anyway.

Parker solves this in two independent ways from the same parsed
structure:

1. **Re-scan from screen** (primary). Each row renders a real
   GS1 DataMatrix via bwip-js's `gs1datamatrix` encoder, which is
   BWIPP's dedicated pipeline for GS1 symbology — parentheses-
   bracketed AIs in, fully-compliant symbol out (FNC1-in-first
   header, Reed-Solomon ECC, correct matrix sizing, GS separators
   between variable AIs). A hardware scanner pointed at this
   rendered symbol produces keystrokes byte-identical to scanning
   the original printed box, so the gov validator treats it as a
   direct scan. This path does not depend on clipboard behavior,
   edit-control quirks, or the validator's paste parser.

2. **Canonical pure-digit paste** (fallback). If re-scanning isn't
   practical, Copy emits the payload in canonical order
   `01 · 17 · 10 · 21` with no FNC1. That order puts the only two
   variable-length AIs (batch, serial) on opposite sides of the
   fixed prefix `21`, which a "dirty" paste parser (one that
   ignores FNC1 and pattern-matches on AI prefixes) can split
   unambiguously.

## Browser support

Microsoft Edge or Google Chrome on Windows, version 108 or newer.
(Any Chromium-based browser with the File System Access API.)
Firefox and Safari do not implement the API; they are not supported.

## Files

```
index.html         Single-page UI.
state.js           Pure state helpers (add/update/remove/sanitize).
gs1.js             GS1 parser + validator (GTIN check digit, AI-82,
                   YYMMDD, canonical + bracketed-AI emission).
storage.js         File System Access API + IndexedDB handle cache.
app.js             Scan capture (keydown-level), rendering, polling,
                   validated mutations, per-row DataMatrix rendering
                   via bwip-js, enlarge-for-re-scan modal.
style.css          Dark, high-contrast counter UI.
vendor/
  bwip-js.min.js   bwip-js 4.9.0 (Terry Burton, MIT). The industry-
                   standard pure-JS GS1 barcode generator; used in
                   `gs1datamatrix` mode for standards-compliant
                   regeneration of parked scans.
tools/
  paste-raw.ahk    Optional AutoHotkey v2 keystroke-synth fallback
                   for receivers that strip FNC1 on paste *and*
                   reject canonical pure-digit payloads.
test/
  state.test.js    Unit tests for state helpers.
  gs1.test.js      Unit tests for the GS1 parser / validator.
```

## Running the tests

Requires Node 18+.

```
node --test test/state.test.js test/gs1.test.js
```

## Design notes

- **Raw payload preserved alongside canonical + bracketed AIs.** Each
  entry stores `rawCode` (verbatim scan, FNC1 intact), the parsed AI
  structure, and `canonical` (pure-digit payload). The UI can copy
  canonical text, copy the raw scan, or regenerate a fresh GS1
  DataMatrix on demand — all three come from the same parsed
  structure, and every re-emission round-trips cleanly.
- **Barcode regeneration is standards-first.** `gs1.js`'s
  `toBracketedAI(parsed)` produces the `(01)value(17)value…` form
  that bwip-js's `gs1datamatrix` encoder expects. We never hand-roll
  FNC1 in the generator path — BWIPP handles FNC1-in-first, the
  inter-AI separators, and ECC. That avoids the classic
  "hand-injected ^029" trap that produces invalid GS1 symbols.
- **Parse failures are loud.** A scan missing any of the four
  FMD-required AIs, or with an invalid GTIN check digit, or with a
  malformed expiry, is still parked — but the row is tinted red and
  the first validation error is shown as a chip on the row. No
  silent "looks fine, paste it, portal rejects" loop.
- **Atomic writes.** `FileSystemFileHandle.createWritable()` stages
  the new content and `close()` swaps it in. Mid-write crashes
  cannot produce a partially written file.
- **Cross-counter races.** Each mutation does read → apply → write
  under a per-tab mutex. Cross-tab writes within the ~10–50 ms
  window can still collide; at expected volumes (20–50 scans/day
  across 2–3 counters) this is negligible. If it ever matters, the
  fix is a lock file, not a server.
- **Polling, not watching.** The File System Access API doesn't
  expose change notifications, so each counter checks `lastModified`
  once a second.

## What it deliberately does not do

- No camera / OCR capture.
- No server of any kind.
- No cloud, no accounts, no internet dependency.
- No duplicate detection, audit reports, or exports (yet).
- Does not generate labels for printing (the on-screen DataMatrix is
  sized for hand-held scanning off a monitor, not for label output).
