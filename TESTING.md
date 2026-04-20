# Pharmacy Parker — Test Plan

This document covers every shipped feature of Pharmacy Parker. Work
through it top-to-bottom. Every item has a concrete **Action**, an
**Expected result**, and where relevant the **Code reference** so a
failure can be attributed to a specific file/function.

Legend:
- **[U]** user-perspective (use the app in the browser)
- **[C]** code-perspective (run a shell command / read a file / run tests)
- **BLOCKER** = a failure here means ship is blocked
- **WARN**    = a failure here is worth fixing but non-blocking

---

## 0. Test environment

### 0.1 [C] Required software

- Node.js 18+ (for running unit tests)
- A Chromium-based browser (Microsoft Edge 108+, Google Chrome 108+)
  on Windows. **Firefox and Safari are explicitly not supported** —
  the File System Access API doesn't exist there; do not file bugs
  about them.
- `python3` (for serving the app locally during testing — the
  production deploy is `file://`, but Chrome restricts some APIs
  over `file://`, so use `http://localhost:NNNN` when testing)
- A working GS1 hardware scanner that emits FNC1 as `Ctrl+]`.
  Any scanner that works directly with the HMNO / EMVS validator is
  correctly configured for our purposes.

### 0.2 [C] Repository layout

Expected files under `/app`:

```
app.js                 index.html        state.js           style.css
gs1.js                 storage.js        README.md          TESTING.md
vendor/bwip-js.min.js                    (≥1 MB, bwip-js 4.9.0)
test/state.test.js     test/gs1.test.js
tools/paste-raw.ahk
memory/PRD.md
```

### 0.3 [C] Spin up the test server

```bash
cd /app && python3 -m http.server 8765
```

Open `http://localhost:8765/index.html` in Edge/Chrome. Keep this
tab open for every **[U]** step.

### 0.4 [U] BLOCKER — bwip-js loaded

**Action:** open the page with DevTools → Network open. Reload.

**Expected:** `vendor/bwip-js.min.js` returns **200** (~1.09 MB).
No `ERR_FILE_NOT_FOUND` or `404` in the Console.

In the DevTools console:
```javascript
typeof window.bwipjs          // "object"
window.bwipjs.BWIPJS_VERSION  // "4.9.0 (...)"
```

If `bwipjs` is `undefined`, the status banner at the top of the
page reads *"bwip-js failed to load (expected at
./vendor/bwip-js.min.js). Confirm the vendor/ folder is deployed
next to index.html on this workstation."* — this is the expected
friendly error. Fix by copying the missing `vendor/` subfolder
alongside `index.html`, not by trying to work around in code.

**Code ref:** `app.js` `init()` — first-thing-after-load check
against `window.bwipjs`.

---

## 1. Unit tests (pre-flight — must pass before any manual testing)

### 1.1 [C] BLOCKER — state + gs1 unit tests

```bash
cd /app && node --test test/state.test.js test/gs1.test.js
```

**Expected:** `# tests 30`, `# pass 30`, `# fail 0`.

Contents in brief — if you see a failure, locate the specific test:

**`test/state.test.js` (8 tests):**
- `validateRawCode rejects empty and overly long`
- `sanitizeNote strips control chars and trims`
- `createEntry preserves 0x1D byte-for-byte in rawCode`
- `addEntry prepends without mutating input`
- `updateEntry merges patch and sanitizes note`
- `removeEntry filters by id`
- `normalizeState tolerates malformed input`
- `round-trip: state → JSON → parse preserves 0x1D`

**`test/gs1.test.js` (22 tests):**
- Parser: canonical pharma sample / symbology identifier `]d2` /
  leading FNC1 / fixed-length AI exact consumption / unknown AI
  reported / truncated fixed-length AI reported / variable AI
  until FNC1 / variable AI until end-of-buffer.
- Check digit: `gtinCheckDigit` known-good values; `validateGTIN`
  accepts valid and rejects malformed + bad check digit.
- Expiry: valid YYMMDD, `DD=00` last-of-month, invalid month,
  invalid day for month.
- AI-82 character set: accepted / rejected / empty / too long.
- `validateMedicine`: all four FMD AIs present / missing serial /
  bad check digit propagates.
- Emitters: `toCanonicalPlain` deterministic no-FNC1 output /
  `toCanonicalGS1` with FNC1 terminators / `toBracketedAI` for
  bwip-js input preserving scan order / partial payload / can't
  regenerate when parser errored.
- `describe`: human-readable one-liner.

### 1.2 [C] BLOCKER — lint clean

```bash
cd /app && npx eslint app.js gs1.js state.js storage.js test/*.js
```
or via the repo's linter tool.

**Expected:** no lint errors.

---

## 2. Onboarding flow

### 2.1 [U] BLOCKER — unsupported browser notice

**Action:** open `http://localhost:8765/index.html` in Firefox.

**Expected:**
- `#onboarding` section visible with title *"Pick your shared data file"*.
- `#unsupported` paragraph is **visible** and reads
  *"This browser does not support the File System Access API…"*.
- **No console errors** (check DevTools → Console).

**Code ref:** `app.js` `showOnboarding()` → toggles `#unsupported.hidden`
based on `FS.supported()`.

### 2.2 [U] BLOCKER — first-launch file pick (create new)

**Action:** in Edge/Chrome:
1. Open the page.
2. Click **Create new file…**.
3. In the save dialog, pick a writable folder and save as `entries.json`.
4. Grant read-write permission.

**Expected:**
- Onboarding disappears; main view appears with empty list and
  status *"Ready"*.
- The `entries.json` file on disk contains
  `{"version":1,"entries":[]}` (pretty-printed).
- Refreshing the page **auto-reconnects** to the same file without
  re-prompting (IndexedDB handle cache in `storage.js`).

**Code ref:** `storage.js` `pickNew`, `ensurePermission`, IndexedDB
`HANDLE_KEY` cache; `app.js` `init()` → `start()`.

### 2.3 [U] BLOCKER — first-launch file pick (choose existing)

**Action:** clear handle via **Settings → Forget this file** (reloads
page), then click **Choose existing file…**. Pick a pre-existing
`entries.json` with two or more entries.

**Expected:** list renders those entries immediately, count in the
header matches. No modifications made to the file during load.

### 2.4 [U] WARN — permission denial

**Action:** click **Settings → Forget this file**, then refresh.
Click **Choose existing file…**, pick a file, then in Chrome's
permission dialog click "Block".

**Expected:**
- Status shows *"Permission denied. Click the page then try again."*
- Returns to onboarding.

**Code ref:** `app.js` `start()` handles `ensurePermission` returning
anything other than `"granted"`.

---

## 3. Scan capture

Every test in this section assumes the main view is open and the
scan box (`#scan-magnet`) is focused (placeholder says "Focus here,
then scan a box").

### 3.1 [U] BLOCKER — scanner directly produces a parked entry

**Action:** point your hardware scanner at a real medicine pack
DataMatrix and pull the trigger.

**Expected:**
- During the scan burst, `#scan-state` shows `Scanning… N` (counting
  keystrokes received).
- On scanner's terminating `Enter`, status shows
  `Parked ✓ GS1 valid · GTIN … · EXP … · LOT … · SN …`.
- A new row appears at the **top** of the pending list (newest first).
- The row has: timestamp, inline white DataMatrix thumbnail,
  four chips (GTIN, EXP, LOT, SN) with the scanned values, empty
  note input, **Scan** / **Copy** / **Raw** / **×** buttons.
- Focus jumps to the note input.

**Code ref:** `app.js` `setupScanCapture()` keydown handler,
`submitScan()`, `render()`.

### 3.2 [C] BLOCKER — FNC1 capture

A scanner emits FNC1 between batch (AI 10) and expiry (AI 17) as
`Ctrl+]`. We must inject `\u001D` into the buffer.

**Action:** open **Settings → Enable keydown debug**. Focus the scan
box, scan one pack. Click **Copy log**; paste elsewhere.

**Expected in the log:**
- A line `Ctrl+]  →  append \u001D  [buffer=N]` at the moment the
  scanner's FNC1 keystroke arrives.
- Final `ENTER` line lists bytes including `1d` at the correct
  offset between batch and expiry.

**Code ref:** `app.js` inside `setupScanCapture()` — the
`if (e.ctrlKey && (e.code === "BracketRight" || e.key === "]"))`
branch.

### 3.3 [C] WARN — Alt+numpad FNC1 fallback

Some scanners emit FNC1 as `Alt+0 2 9` instead of `Ctrl+]`.

**Action:** with keydown debug enabled, manually type
`Alt` (hold) `0 2 9` (numpad) `Alt` (release) into the scan box.

**Expected:** log shows `Alt+029  →  append U+001D  [buffer=1]`.

**Code ref:** `flushAltNumpad()` in `app.js`.

### 3.4 [C] BLOCKER — inter-key gap reset

**Action:** in the scan box:
1. Type three characters fast (`abc`); `#scan-state` shows
   `Scanning… 3`.
2. Wait 2 seconds.
3. Type three more characters (`def`).

**Expected:** after the 2-second gap the buffer was reset. When the
next `d` arrives, the buffer starts at 1, not 4. `#scan-state` goes
through `Scanning… 1 … 2 … 3`, not `…4 …5 …6`. Submitting with Enter
after `def` parks a 3-character scan (which then fails the min-length
check: status *"Scan ignored (too short)"*, no row created).

**Code ref:** `app.js` the `gap > MAX_INTER_KEY_GAP_MS` reset inside
the keydown handler; `MIN_SCAN_LEN = 4`.

### 3.5 [U] WARN — min scan length

**Action:** focus the scan box, type `abc`, press Enter.

**Expected:** status *"Scan ignored (too short)"*. No row added.

### 3.6 [U] WARN — paste into scan box

**Action:** copy a full GS1 string from elsewhere (e.g., the
reference payload in Settings), focus the scan box, press Ctrl+V.

**Expected:** the scan is parked as if it had been scanned — same
parse / validate / render pipeline.

**Code ref:** `scanMagnet.addEventListener("paste", …)`.

---

## 4. GS1 parsing and validation

The four FMD-required AIs are: **01** GTIN, **17** expiry,
**10** batch, **21** serial.

### 4.1 [U] BLOCKER — valid pack → green row, all chips populated

**Action:** scan a pack with GTIN + expiry + batch + serial.
Example real payload (the test fixture in `app.js` `TEST_FIXTURE`):

```
01 05203622108740 10 00437X <FNC1> 17 270531 21 37664107698060
```

**Expected row:**
- No red tint.
- `GTIN 05203622108740`
- `EXP 2027-05-31`  (formatted from AI 17 YYMMDD)
- `LOT 00437X`
- `SN 37664107698060`
- No `⚠` flag chip.
- Inline DataMatrix thumbnail visible.
- Status bar: `Parked ✓ GS1 valid · GTIN … · EXP … · LOT … · SN …`.

### 4.2 [U] BLOCKER — invalid GTIN check digit → red row

**Action:** scan (or paste) a payload whose GTIN has a wrong Mod-10
check digit. Using the reference payload but flipping the last GTIN
digit from `0` to `1`:

```
(paste this into the scan box:)
0105203622108741 1000437X<FNC1>17270531 2137664107698060
```

Or produce this synthetically:

```javascript
// In DevTools:
const s = "01" + "05203622108741" + "10" + "00437X" + "\u001D"
        + "17" + "270531" + "21" + "37664107698060";
document.getElementById("scan-magnet").focus();
document.execCommand("insertText", false, s);  // or just paste
```

**Expected:**
- Row appears with **red background** (dark red tint).
- The `⚠` chip reads: `GTIN check digit invalid (expected 0, got 1)`.
- Status: `Parked ⚠ GTIN check digit invalid…`.
- **Scan** button is **hidden** (we won't regenerate a bad symbol).
- `Copy` and `Raw` remain available.

**Code ref:** `gs1.js` `validateGTIN()`; `app.js` `renderBarcodeTo()`
catches BWIPP's `GS1badChecksum` throw and hides the thumbnail +
Scan button.

### 4.3 [U] BLOCKER — invalid expiry month → red row

**Action:** paste a payload with month `13`:

```
0105203622108740 1000437X<FNC1>17271301 2137664107698060
```

**Expected:** red row, ⚠ chip reads
`Expiry month invalid (13)` or similar.

### 4.4 [U] WARN — expiry DD=00 = last-of-month is accepted

**Action:** scan/paste with `17 270200` (Feb last day, 2027):

```
0105203622108740 1000437X<FNC1>17270200 2137664107698060
```

**Expected:** green row, `EXP 2027-02-00` shown in the chip.
(DD=00 is a GS1 convention meaning "last day of the month"; it's
valid.)

### 4.5 [U] BLOCKER — missing serial → red row

**Action:** scan/paste with no AI 21:

```
0105203622108740 1000437X<FNC1>17270531
```

**Expected:** red row, ⚠ chip shows `missing serial (AI 21)`.

### 4.6 [C] BLOCKER — parser handles symbology identifier

**Action:** in the DevTools console on the main view:

```javascript
PharmacyGS1.parse("]d201" + "05203622108740" + "1000437X\u001D" +
                  "17270531" + "2137664107698060").fields
```

**Expected:** object with keys `01`, `10`, `17`, `21` holding the
right values. No errors. The `]d2` prefix should have been stripped.

### 4.7 [C] WARN — unknown AI reports error, stops parse

**Action:** DevTools:

```javascript
PharmacyGS1.parse("01" + "05203622108740" + "99JUNK").errors
```

**Expected:** array with `"unknown AI at position 16: \"99JU…\""`.

### 4.8 [C] WARN — variable AI without FNC1 greedy-consumes (warning case)

**Action:** DevTools:

```javascript
PharmacyGS1.parse("10LOT12321SERIAL").fields
```

**Expected:** `{ "10": "LOT12321SERIAL" }`. The parser cannot know
where batch ends without FNC1; the whole tail becomes batch. In the
UI, such a scan presents as "only LOT chip filled, no SN" → the
pharmacist sees at a glance that the scanner missed FNC1.

---

## 5. DataMatrix regeneration (bwip-js)

The on-row DataMatrix thumbnails and the enlarge-for-rescan modal
are produced by `bwip-js` 4.9.0 (vendored at `/app/vendor/bwip-js.min.js`)
in `gs1datamatrix` mode with bracketed AI input from `toBracketedAI()`.

### 5.1 [U] BLOCKER — thumbnails render per row

**Action:** after parking a valid scan (§4.1), visually inspect the
row.

**Expected:**
- White 64×64 pixel box to the left of the chips.
- Contains a real DataMatrix pattern (square black-and-white module
  grid, fixed "L" pattern on two edges).
- On hover: scales up slightly, blue outline appears.
- On click: opens the enlarge modal (§5.3).

### 5.2 [C] BLOCKER — thumbnail is a real compliant symbol

**Action:** in DevTools:

```javascript
const canvases = document.querySelectorAll(".entry .barcode");
const c = canvases[0];
const d = c.getContext("2d").getImageData(0,0,c.width,c.height).data;
let dark = 0;
for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
console.log("dark pixels:", dark, "size:", c.width, "×", c.height);
```

**Expected:** `dark pixels` is a 4-digit number in the range
~7000–15000 for a 64×64 canvas with ~4px padding. Zero means BWIPP
silently failed (would indicate a regression).

### 5.3 [U] BLOCKER — Scan modal opens, shows large DataMatrix

**Action:** click either the inline thumbnail or the row's **Scan**
button.

**Expected:**
- Dark backdrop with blurred page behind.
- Centered white box containing a much larger (~450×450 px)
  DataMatrix.
- Header shows `Scan this — GTIN … · EXP … · LOT … · SN …`.
- Below the barcode: bracketed AI source string
  `(01)…(17)…(10)…(21)…` — for operator verification.
- Focus is on the close button (not the scan magnet), so keystrokes
  are not parked while the pharmacist waves the scanner at the screen.
- **Esc** or **clicking the backdrop** closes the modal.

**Code ref:** `app.js` `openScanModal()`, `closeScanModal()`.

### 5.4 [U] BLOCKER — re-scan from screen reproduces original

**Action:** with the modal open, point your hardware scanner at the
screen while some other text field (e.g., Notepad, or a second
`entries.json` instance of Parker, or — the real test — the gov
validator's scan field) is focused.

**Expected:** the scanner emits the same keystroke stream it would
have emitted if pointed at the original printed pack, **including
Ctrl+] at the FNC1 position**. If you re-scan into a fresh Parker
instance, you get an identical row (same 4 AI values, same fields).

**If the validator rejects this** — two possible causes, both outside
Parker:
1. Scanner symbology configuration doesn't emit FNC1 as Ctrl+].
   (Should not happen if the scanner already works when pointed at
   the original pack.)
2. Display too small / too glossy for the scanner's optics. Bump
   `scale: 8` in `app.js` `openScanModal()`, or dim room lighting.

### 5.5 [U] WARN — invalid rows don't offer regeneration

**Action:** park a payload with bad GTIN check digit (§4.2).

**Expected:**
- The inline barcode thumbnail is invisible (hidden via `.empty`
  CSS class).
- The **Scan** button on that row is hidden.
- `Copy` and `Raw` remain usable.
- No console errors; BWIPP's `GS1badChecksum` throw is caught in
  `renderBarcodeTo()`.

---

## 6. Copy to clipboard (two modes)

### 6.1 [U] BLOCKER — Copy button = canonical pure digits

**Action:** on a valid row, click **Copy**.

**Expected:**
- Status: `Copied canonical payload. Paste into the gov portal.`.
- Row background turns dark teal (`copied` class) — visual
  confirmation that this row has been registered.
- Paste the clipboard into a plain text editor. You should see:
  `01<GTIN>17<YYMMDD>10<BATCH>21<SERIAL>` with **no hidden bytes**.
  For the canonical test fixture the clipboard content is
  `0105203622108740172705311000437X2137664107698060` (48 chars).

**Code ref:** `app.js` `copyRow(id, "canonical")` →
`navigator.clipboard.writeText(entry.canonical)`.

### 6.2 [U] BLOCKER — Raw button = original scan bytes

**Action:** on the same row, click **Raw**.

**Expected:**
- Status: `Copied raw scan (with FNC1). Paste into ERP/strict-GS1 receiver.`.
- Paste into a hex-aware editor (e.g., run
  `xclip -o | xxd -c 32` on Linux, or use Notepad++'s Hex plugin).
  The payload must include `0x1D` at the correct position — for
  the test fixture, between offsets 24 and 25.

### 6.3 [U] WARN — row click / Enter default action

**Action:** click on a row's empty space (not the note, not a button);
also focus the row with Tab then press Enter.

**Expected:**
- If the row has a valid DataMatrix (Scan button visible),
  **opens the Scan modal**.
- Otherwise (invalid / unregenerable): **copies canonical** to
  clipboard.

**Code ref:** `wireRow()` — the row-level `click` and `keydown`
handlers.

### 6.4 [U] WARN — filter Enter triggers first row's primary action

**Action:** scan several packs. Type part of a serial into the
`#filter` input. Press Enter.

**Expected:** same behavior as §6.3 but on the first visible row.

---

## 7. List operations

### 7.1 [U] BLOCKER — multiple entries, newest first

**Action:** scan three different packs in sequence.

**Expected:** most recent row is at the **top**; pending count in
header reads `Pending (3)`.

### 7.2 [U] BLOCKER — filter by note / batch / serial / GTIN

**Action:** add a note `"Maria K."` to one row. In the filter input,
type:
1. `maria` — only that row visible.
2. `37664` — row whose serial starts with 37664 visible.
3. `0437X` — row whose batch contains `0437X` visible.
4. `052036` — all rows (if they share a GTIN prefix).
5. Clear the filter — all rows return.

**Code ref:** `app.js` `matchesFilter()` — searches across note,
AI 10, AI 21, AI 01, and canonical fields.

### 7.3 [U] BLOCKER — delete row via × button

**Action:** click `×` on any row.

**Expected:** row disappears immediately; pending count decrements;
file on disk no longer contains that entry.

### 7.4 [U] BLOCKER — delete row via Backspace / Delete key

**Action:** focus a row (Tab to it), press Delete.

**Expected:** same as §7.3.

### 7.5 [U] BLOCKER — note auto-saves on blur / 300 ms idle

**Action:** click into a note input, type `Smith`. Click elsewhere.

**Expected:** after ~300 ms of idle, or on blur, the note is saved
to disk. Refresh the page — the note is still there.

**Code ref:** `wireRow()` — `noteInput` input handler debounces for
300 ms; blur flushes immediately.

### 7.6 [U] WARN — note Enter commits and returns focus to scan box

**Action:** type into a note, press Enter.

**Expected:** note saves, input blurs, `#scan-magnet` regains focus
(so the next scan goes where expected).

---

## 8. Multi-counter sync

Requires two browser windows (or two physical counter PCs) both
pointed at the same `entries.json` on a network share — for testing,
a local folder with both Edge windows works.

### 8.1 [U] BLOCKER — A scans → B sees the row within ≤ 1.5 s

**Action:**
1. Open Parker in two browser windows; both point at the same file.
2. In window A, scan a pack.
3. Watch window B without interacting.

**Expected:** within at most ~1.5 seconds (polling interval ≈ 1 s
plus read latency), the row appears in window B's list at the top.

**Code ref:** `app.js` `startPolling()` / `pollOnce()`;
`POLL_INTERVAL_MS = 1000`.

### 8.2 [U] WARN — A deletes → B loses the row within ≤ 1.5 s

**Action:** in window A, click `×` on a shared row.

**Expected:** row disappears in window B within ~1.5 s.

### 8.3 [C] WARN — mtime unchanged → no re-render

With both windows idle, the polling loop should NOT re-render
uselessly. Check via DevTools Performance: per-second task spike
should do a single `getFile()` stat and no DOM churn when nothing
changed.

**Code ref:** `pollOnce()` — short-circuits on
`probe.lastModified === lastMtime`.

---

## 9. File storage integrity

### 9.1 [C] BLOCKER — JSON on disk is well-formed

**Action:** after several scans, open `entries.json` in a text editor.

**Expected:**
- Valid JSON, pretty-printed (2-space indent).
- Top level: `{ "version": 1, "entries": [ … ] }`.
- Each entry has at minimum: `id` (UUID v4), `rawCode` (string,
  may contain `\u001d`), `scannedAt` (millisecond epoch).
- Valid entries additionally have: `note`, `parsed`, `canonical`,
  `valid`, `issues`.
- Any `\u001d` bytes in `rawCode` are encoded as the JSON escape
  `\u001d` (lowercase is fine; uppercase also fine per JSON spec).

### 9.2 [C] BLOCKER — FNC1 round-trip survives disk

**Action:** from `entries.json`:
```bash
grep -o '"rawCode":"[^"]*"' /path/to/entries.json | head -1 | xxd
```

**Expected:** the byte sequence includes `5c 75 30 30 31 64` (the
ASCII for `\u001d`).

Reload Parker. The entry should still render identically — parsed
fields unchanged — which proves the JSON round-trip preserves
FNC1 byte-for-byte.

**Code ref:** `state.test.js` `round-trip: state → JSON → parse preserves 0x1D`.

### 9.3 [C] WARN — malformed JSON refusal

**Action:** with Parker open and connected to a file, externally
edit the file to introduce a syntax error (e.g., delete the closing
`]`). Wait ≥ 1 s.

**Expected:**
- Status banner turns orange: `Poll failed: Shared file is not
  valid JSON …`.
- The previously-rendered in-memory list stays visible; Parker does
  **not** overwrite the broken file.
- Fix the file externally; within ~1 s Parker resumes normal
  operation.

**Code ref:** `storage.js` `readFile()` — throws `INVALID_JSON`
with a message mandating manual inspection rather than clobbering.

### 9.4 [C] BLOCKER — atomic write

**Action:** while continuously scanning, externally run
`watch -n 0.1 stat entries.json` (Linux) or similar on Windows.

**Expected:** file size never drops to 0 or to a partial state.
Either fully-old or fully-new contents are visible. This is
guaranteed by `FileSystemFileHandle.createWritable()` semantics
(stage-then-swap on `close()`).

---

## 10. Settings panel

### 10.1 [U] BLOCKER — toggle

**Action:** click the top-right **Settings** button.

**Expected:** settings panel slides into view below the main list.
Clicking again hides it.

### 10.2 [U] BLOCKER — Change file

**Action:** Settings → **Change file…**. Pick a different
`entries.json`.

**Expected:** list re-loads to show the new file's contents.
File path at top of Settings updates.

### 10.3 [U] BLOCKER — Forget this file

**Action:** Settings → **Forget this file**.

**Expected:** page reloads; returns to onboarding. The IndexedDB
`sharedFile` handle is removed.

### 10.4 [U] BLOCKER — Copy reference payload

**Action:** Settings → **Copy reference payload**.

**Expected:**
- Status: `Reference payload copied (48 chars). Paste into the gov field.`.
- Clipboard contains
  `0105203622108740172705311000437X2137664107698060` — the known-good
  canonical form of the real Greek pharma test fixture.

### 10.5 [U] WARN — Keydown debug

**Action:**
1. **Enable keydown debug**.
2. Scan a pack.
3. **Copy log** → paste elsewhere.

**Expected:**
- Log lists every keydown with timestamp, key, code, modifiers,
  whether the scan magnet was focused.
- Alt-numpad composed characters get a `Alt+NNN → append U+…` line.
- `Ctrl+]` appears as `Ctrl+]  →  append \u001D`.
- `Enter` at end shows `ENTER → submit (len=N, bytes=…hex…)`.

**Clear log** empties the textarea. **Disable keydown debug** stops
appending new lines.

### 10.6 [U] WARN — file path display

**Action:** observe `Current:` code in the Settings panel.

**Expected:** shows the actual file name chosen. Updates when you
change files.

---

## 11. End-to-end acceptance scenarios

These are the "does the whole thing actually work" stories. Each
should pass.

### 11.1 [U] BLOCKER — happy path

1. Pharmacist at counter A scans pack X. Row appears with green
   status.
2. Counter B (running in another browser window against the same
   shared file) sees the row within 1.5 s.
3. A week later, counter B wants to register pack X into the gov
   validator:
   a. Opens Parker, finds the row (filter by batch or just find it
      by time).
   b. Clicks the inline DataMatrix (or Scan button).
   c. The gov validator is open on another monitor / window with
      its scan field focused.
   d. Pharmacist points the hardware scanner at Parker's modal.
   e. Validator accepts the scan — treating it as if pack X had
      been placed in front of the scanner.
4. Pharmacist closes the Parker modal, optionally clicks `×` to
   remove the now-registered row.

**Expected:** every step succeeds without keyboard or clipboard
intervention except opening the modal.

### 11.2 [U] BLOCKER — clipboard fallback path

Same as §11.1, but instead of re-scanning, the validator's scan
field is focused and the pharmacist clicks **Copy** on the row and
presses Ctrl+V.

**Expected:** the validator accepts the pasted pure-digit canonical
form. This relies on the validator's input parser handling
AI concatenation without FNC1 (the "dirty parser" model that HMNO
and most EU NMVS portals use).

### 11.3 [U] BLOCKER — strict-GS1 receiver (ERP)

Same but paste the **Raw** form into a strict-GS1-compliant ERP
(any SAP / Odoo-style system configured for GS1 DataMatrix input).

**Expected:** ERP correctly splits batch and serial because FNC1
is present.

### 11.4 [U] WARN — invalid scan is caught on the counter, not at the validator

1. Scanner accidentally picks up a damaged / mis-printed barcode
   whose GTIN check digit is off by one.
2. The row appears red-tinted with `⚠ GTIN check digit invalid…`.

**Expected:** the pharmacist sees the issue before ever attempting
to register. The Scan button is hidden so they can't try to
re-scan a symbol BWIPP refused to render.

---

## 12. Known limitations (do NOT file bugs about these)

- **Browsers without File System Access API** (Firefox, Safari, any
  Chromium before 86 without flag): onboarding shows "unsupported".
  This is intentional.
- **Paste into the scan box bypasses the FNC1 keystroke capture.**
  If you paste a payload without FNC1 (e.g., from the gov portal's
  own "copy barcode text" feature), the parser may greedy-consume
  the tail into AI 10. This is an expected consequence of FNC1 being
  stripped by clipboard-layer software on most systems.
- **Pixel-identical regeneration vs. the original printed pack is
  not guaranteed.** ISO/IEC 16022 allows multiple valid codeword
  encodings for the same data. What IS guaranteed:
  - Matrix size matches (22×22 for standard 4-AI GS1 pharma packs).
  - "FNC1 in first" GS1 indicator is present.
  - FNC1 separator between variable-length AIs is present.
  - A compliant scanner decodes the regenerated symbol to the same
    AI values as the original.
- **Cross-counter race window of ~10–50 ms.** If counter A and
  counter B both mutate within that window, one of the two writes
  can be lost. At the expected ~20–50 scans/day volume this is
  negligible; if it ever matters the fix is a lock file, not a
  server.
- **Emergent-specific Cookie / camera / OCR / label-print features**
  are explicitly out of scope.

---

## 13. Regression checks after any code change

If anyone touches `app.js` / `gs1.js` / `state.js` / `storage.js`,
rerun the full test plan — **at minimum**:

1. **§1** unit tests pass.
2. **§3.1** scan a real pack produces a green row with all four chips.
3. **§4.2** a bad-check-digit payload produces a red row.
4. **§5.3** Scan modal opens and shows a real DataMatrix.
5. **§6.1 + §6.2** Copy and Raw populate the clipboard differently.
6. **§8.1** cross-counter sync propagates within 1.5 s.

Record pass/fail for each numbered item in a plain text log. Any
BLOCKER failure means ship is blocked.

---

## 14. Reporting a failure

For any failing item, capture:

1. The item number from this document (e.g. "§4.3 — invalid expiry
   month").
2. **Browser + version** (Edge `chrome://version` / Chrome
   `chrome://version`).
3. The **scanner model** if scanner-related.
4. The **exact payload** used (for paste-based tests, the hex dump
   is ideal: `echo -n "..." | xxd`).
5. For UI issues: a screenshot + the DevTools Console output
   (any errors or warnings).
6. For parse/validate issues: the output of
   `PharmacyGS1.parse(payload)` from the DevTools console.
7. For scan issues: the keydown debug log (§10.5).
8. For storage issues: the current contents of `entries.json`
   (or a note that it's well-formed).

File against the Pharmacy Parker repo with the `bug` label.
