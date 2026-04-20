# QR Ordering System — Test Plan

Comprehensive acceptance tests for the commercial Electron build of
QR Ordering System. Work through top-to-bottom. Every item has an
**Action**, an **Expected result**, and (where applicable) a **Code
reference**.

Legend:
- **[U]** user test (run the app, click things)
- **[C]** code test (run a shell command or check a file)
- **BLOCKER** — a failure here must be fixed before release
- **WARN**    — a failure worth fixing but not release-blocking
- **[E]**     — test applies only in Electron build
- **[W]**     — test applies only in dev web mode

---

## 0. Environment

### 0.1 [C] BLOCKER — repo layout

Verify `/app` contains, at minimum:

```
main.js       preload.js      index.html      popup.html      app.js
popup.js      license.js      state.js        gs1.js          storage.js
style.css     package.json    README.md       TESTING.md
vendor/bwip-js.min.js
test/state.test.js   test/gs1.test.js
```

### 0.2 [C] BLOCKER — unit tests pass

```
npm install
npm test
```

Expect `# tests 32   # pass 32   # fail 0`.
10 state tests: sanitizers, Contact/Order/QR CRUD, per-contact order
numbering, cascading delete, confirm/unconfirm, duplicate-serial
finder, orphan filter in normalize, v1→v2 migration, FNC1 round-trip.
22 GS1 tests (unchanged from previous iteration).

### 0.3 [C] BLOCKER — lint clean

```
npx eslint app.js state.js gs1.js storage.js main.js preload.js popup.js license.js test/*.js
```

### 0.4 [E] [C] BLOCKER — Electron build produces installer

On a Windows build machine:

```
npm install
npm run dist:win
```

Expect `dist/QROS-1.0.0-x64.exe` (NSIS installer) and
`dist/QROS-1.0.0-x64.exe` (portable). Sizes roughly 80-130 MB.

### 0.5 [W] [C] BLOCKER — web dev mode launches

```
cd /app && python3 -m http.server 8765
# open http://localhost:8765/index.html in Edge/Chrome
```

No console errors. License gate is auto-bypassed (web dev mode).
Onboarding screen visible.

---

## 1. License flow  [E]

Run the installed `.exe`.

### 1.1 [U] BLOCKER — first-launch license gate

**Action:** fresh install, no cached license. Launch the app.

**Expected:**
- Full-screen centered card titled "QR Ordering System".
- Text: "Enter your license key to activate this workstation."
- Input field for license key.
- HWID shown at bottom (32 hex chars).
- No other UI chrome visible.

### 1.2 [U] BLOCKER — empty key → validation

**Action:** click Activate with no input.

**Expected:** banner reads "Please enter your license key."

### 1.3 [U] BLOCKER — valid key → activation

**Action:** enter a license key issued by your PHP server, click
Activate.

**Expected:**
- Banner shows "Contacting license server…" then disappears.
- License card closes; onboarding or main view appears.
- Top-right **owner badge** shows `Company Name · Maria Papadopoulos`
  (from server `owner` object).
- File `%APPDATA%/QR Ordering System/license.json` created, contains
  license_number + hwid + owner + lastCheckAt.

**Code ref:** `main.js` `license:activate` handler; `license.js`
`activate()`; `app.js` `runLicenseGate()`.

### 1.4 [U] BLOCKER — unknown key → rejection with clean message

**Action:** enter `BOGUS-KEY-0000`, click Activate.

**Expected:** banner shows "This license key was not found." Gate
remains visible. No license.json written.

### 1.5 [U] BLOCKER — HWID-bound to another machine → rejection

**Action:** take a license key already activated on PC #1, try to
activate it on PC #2.

**Expected:** banner shows "This license is bound to a different
machine." (server replies `reason: "hwid_mismatch"`).

### 1.6 [U] WARN — revoked license

**Action:** have the vendor flip `status = revoked` on the PHP side.
Close + relaunch the app.

**Expected:** on the next weekly re-check (forceable via Settings →
Re-verify), banner reads "This license has been revoked. Contact
the vendor." and gate re-appears.

### 1.7 [U] WARN — offline grace

**Action:** activate successfully. Then disconnect the internet.
Relaunch the app every day for 8 days.

**Expected:**
- Days 1-7: app launches normally. Settings → Re-verify shows the
  cached response; status bar may warn "License server unreachable,
  running on cache".
- Day 8+: license gate re-appears with "Offline grace period
  expired. Connect to the internet."

### 1.8 [U] WARN — Settings → Deactivate

**Action:** Settings panel → License section → Deactivate.

**Expected:** confirm dialog, then license.json deleted, app
relaunches to the license gate.

---

## 2. Onboarding + file access

### 2.1 [E] [U] BLOCKER — first-run file picker

**Action:** after activation, observe the onboarding screen.

**Expected:**
- Title "Pick your shared data file".
- Two buttons: **Choose existing file** and **Create new file**.
- Click **Create new file** → native Windows save dialog →
  pick e.g. `C:\Users\Public\QROS\entries.json`.
- Onboarding disappears; main 3-panel view appears with empty
  contact list.

### 2.2 [E] [U] BLOCKER — no permission prompt on subsequent launches

**Action:** close the app. Relaunch.

**Expected:** app goes straight from license verification into the
main view. **No file dialog reappears.** The file path is remembered
in `%APPDATA%/QR Ordering System/lastFile.txt`. This is the
distinguishing feature of Electron mode over the old web build.

### 2.3 [E] [U] BLOCKER — Change file

**Action:** Settings → Shared data file → Change file. Pick a
different `entries.json`.

**Expected:** list repopulates from the new file. `lastFile.txt`
updated.

### 2.4 [E] [U] WARN — Forget this file

**Action:** Settings → Forget this file.

**Expected:** app reloads, returns to onboarding. `lastFile.txt`
deleted.

### 2.5 [W] [U] BLOCKER — web mode onboarding falls back to FSA API

**Action:** in dev mode (http://localhost:8765), click "Create new
file". Chrome's File System Access save dialog appears. Pick a path.
Grant write permission.

**Expected:** subsequent launches still need the "Allow" click per
session (this is by design in web mode; Electron mode removes it).

---

## 3. Contacts panel (left)

### 3.1 [U] BLOCKER — create contact

**Action:** click **+ New** in the Contacts header.

**Expected:**
- Modal opens titled "New contact".
- Three inputs: Name, Surname, Tel.
- Type values and click Save.
- Modal closes; new contact appears at top of list; auto-selected.
- Contact count badge increments.

### 3.2 [U] BLOCKER — edit contact (double-click row)

**Action:** double-click an existing contact row.

**Expected:** modal titled "Edit contact" pre-populated with current
values. Change tel, click Save → the row updates in the list.

### 3.3 [U] BLOCKER — cascading delete

**Action:** contact has ≥1 order with ≥1 QR. Click the `×` on the
contact row.

**Expected:**
- Confirm dialog: "Delete {Name Surname} and all their orders + QRs?"
- On OK: contact disappears, middle and right panels blank.
- File on disk no longer contains the contact, their orders, or
  their QRs.

### 3.4 [U] WARN — filter

**Action:** type part of a name, surname, or tel into the filter
input.

**Expected:** list narrows live.

---

## 4. Orders panel (middle)

### 4.1 [U] BLOCKER — new order for selected contact

**Action:** with a contact selected, click **+ New** in Orders header.

**Expected:**
- New order row appears at top.
- `Order #1` if this is the contact's first order; `Order #N+1`
  otherwise. Number is scoped to **this contact** (not global).
- Date = now. Status badge = `UNCONFIRMED` (orange).
- Auto-selected; right panel shows empty QR list + Scan box enabled.

**Code ref:** `state.js` `nextOrderNumberFor()`.

### 4.2 [U] BLOCKER — per-contact numbering isolation

**Action:** with Contact A having orders 1 & 2, switch to Contact B
and create a new order.

**Expected:** Contact B's new order is `#1`, not `#3`.

### 4.3 [U] BLOCKER — confirm an order

**Action:** click **Confirm order** in the QR-panel header.

**Expected:**
- Confirmation timestamp stamped.
- Status badge flips to `CONFIRMED` (green).
- Scan box becomes disabled with placeholder "Order is confirmed —
  unconfirm to scan more".
- Button label changes to "Unconfirm order".
- File on disk has the order's `confirmationDate` set and
  `status: "confirmed"`.

### 4.4 [U] BLOCKER — unconfirm an order

**Action:** on a confirmed order, click **Unconfirm order**.

**Expected:** confirm dialog, then status reverts to unconfirmed,
`confirmationDate` cleared, scan box re-enabled.

### 4.5 [U] WARN — confirm with zero QRs

**Action:** create a new order, do not scan anything, click Confirm
order.

**Expected:** confirm dialog "Confirm order with zero QRs?" (safety
check). OK goes through.

### 4.6 [U] BLOCKER — cascading delete of order

**Action:** click `×` on an order row.

**Expected:** confirm dialog, then order + its QRs removed from the
file.

---

## 5. QR panel (right) + scanning

### 5.1 [U] BLOCKER — scan box locked until order selected

**Action:** deselect any order. Focus moves to scan magnet.

**Expected:**
- Scan box disabled, greyed out.
- Placeholder: "Pick an order, then scan a code".
- State indicator: "Locked".

### 5.2 [U] BLOCKER — scanning parks a QR in the active order

**Action:** with an unconfirmed order selected, scan a real
DataMatrix box.

**Expected:**
- During burst: state shows `Scanning… N`.
- On scanner's Enter: row appears at top of QR list with
  timestamp, 56×56 DataMatrix thumbnail, GTIN/EXP/LOT/SN chips,
  empty note field, Pop-out/Copy/Raw/× buttons.
- Status bar: `Added ✓ GS1 valid · GTIN … · EXP … · LOT … · SN …`.
- Order's QR count badge in middle panel increments.

### 5.3 [U] BLOCKER — FNC1 is captured

Same as previous TESTING §3.2: enable keydown debug, scan a pack,
copy log. Expect `Ctrl+]  →  \u001D` line; the final submit's bytes
include `1d` at the correct position.

### 5.4 [U] BLOCKER — invalid GTIN → red row

**Action:** paste or scan a payload with wrong check digit.

**Expected:** red row with inline ⚠ chip "GTIN check digit invalid
(expected N, got M)". Pop-out button **hidden** (we don't regenerate
non-compliant symbols). Copy and Raw still available.

### 5.5 [U] BLOCKER — duplicate-serial warning

**Action:** scan the same pack twice (first time into Order A, second
time while Order B is selected). Or scan twice into the same order.

**Expected:** browser `confirm()` dialog reading:
```
Serial SERIAL123 is already parked under Order #N.
Add it to this order anyway?
```
OK → added. Cancel → status "Duplicate serial — not added."

### 5.6 [U] BLOCKER — scanning locked on confirmed orders

**Action:** confirm an order, then try to scan.

**Expected:** scan box disabled. Attempted paste rejected with
status "Order is confirmed — cannot add more QRs."

### 5.7 [U] WARN — note auto-save

**Action:** type into the note field of a QR row. Click away.

**Expected:** after ~300 ms debounce, note saves to disk. Reload
app → note still there.

### 5.8 [U] BLOCKER — delete QR

**Action:** click `×` on a QR row.

**Expected:** row removed immediately. No confirmation dialog (it's
a single QR — low blast radius).

### 5.9 [U] WARN — QR inline DataMatrix thumbnail

**Action:** observe each QR row.

**Expected:**
- 56×56 px white square with a real DataMatrix pattern (real
  modules, fixed "L" on two edges).
- Invalid rows: thumbnail hidden (BWIPP refuses).
- Hover: slight scale-up + blue outline.
- Click: opens Pop-out (native popup in Electron / in-page modal in
  web mode).

### 5.10 [U] BLOCKER — Copy button

Same as previous §6.1 — canonical pure-digit clipboard.
Format: `01<GTIN>17<YYMMDD>10<BATCH>21<SERIAL>`, no FNC1.

### 5.11 [U] BLOCKER — Raw button

Same as previous §6.2 — original scan bytes including `\u001D`.

---

## 6. Always-on-top Pop-out window  [E]

This is the headline feature of the Electron build — a real OS
floating window that stays on top of the gov validator.

### 6.1 [E] [U] BLOCKER — Pop-out opens a native window

**Action:** on a valid QR row, click **Pop-out** (or click the
thumbnail).

**Expected:**
- A small (~340×420 px) frameless window opens.
- Titlebar reads "QR — always on top" with an × close button.
- Body contains a large white-background DataMatrix (~scale 7) and
  three rows: GTIN, LOT, SN with values.
- The bracketed AI source string is shown at the bottom.
- **The window stays above the main app window AND above every
  other normal application window** — verified by focusing a
  different app (Notepad, browser) and confirming the popup is
  still visible.
- The window is draggable by its titlebar.
- Close button or Esc closes it.

**Code ref:** `main.js` `openPopup()` —
`BrowserWindow({ alwaysOnTop: true, frame: false, skipTaskbar: true })`
and `setAlwaysOnTop(true, "screen-saver")`.

### 6.2 [E] [U] BLOCKER — popup re-use on second Pop-out

**Action:** with the popup open, click Pop-out on a different QR.

**Expected:** the same window updates to the new DataMatrix, does
not open a second window.

### 6.3 [E] [U] BLOCKER — re-scan from popup into gov validator

**Action:** open the gov validator's scan field in another window.
Click Pop-out in QROS. Point the hardware scanner at the popup from
inside the validator.

**Expected:** the validator accepts the scan identically to the
original printed pack.

### 6.4 [W] [U] BLOCKER — web mode falls back to in-page modal

**Action:** in dev web mode, click Pop-out.

**Expected:** a centered modal (backdrop + white box with the
barcode) appears inside the app window — not an always-on-top OS
window. This is an intentional limitation of the web target.

---

## 7. Multi-counter sync

### 7.1 [E] [U] BLOCKER — A scans → B within 1.5 s

(Same as previous §8.1 — shared JSON file on SMB share, 1-second
poll interval per workstation.)

### 7.2 [E] [U] WARN — A deletes → B within 1.5 s

(Same as previous §8.2.)

### 7.3 [E] [C] BLOCKER — atomic write

`main.js` writes via `.tmp` rename for atomicity. Externally watch
the file size during rapid scanning. It must never drop to 0 or
show a partial JSON document.

---

## 8. File storage integrity

### 8.1 [E] [C] BLOCKER — JSON schema v2

```json
{
  "version": 2,
  "contacts": [ { "id", "name", "surname", "tel", "createdAt" } ],
  "orders":   [ { "id", "contactId", "orderNumber", "orderDate",
                  "confirmationDate", "status", "createdAt" } ],
  "qrs":      [ { "id", "orderId", "rawCode", "scannedAt", "note",
                  "parsed", "canonical", "valid", "issues" } ]
}
```

No free-floating fields. QR `rawCode` preserves FNC1 as `\u001d`.

### 8.2 [E] [C] BLOCKER — v1 migration

**Action:** drop a v1 `{version:1, entries:[{id,rawCode,…}]}` file
into the location pointed at by the app.

**Expected:** on launch, normalizeState creates one sentinel
"Unassigned" contact with one order #1 under it, and moves every v1
entry into that order as a QR. No data silently lost.

**Code ref:** `state.js` `normalizeState()` — the v1 branch.

### 8.3 [E] [C] WARN — malformed JSON refusal

Externally corrupt the JSON file (delete the closing `}`). Expected:
status banner "Read failed: Shared file is not valid JSON". In-memory
data stays; Parker does not overwrite. Fix → within 1 s normal
operation resumes.

### 8.4 [E] [C] BLOCKER — orphan filter

An order whose `contactId` doesn't match any existing contact, or a
QR whose `orderId` doesn't exist: `normalizeState` drops it silently
on read. Verified by the `normalizeState drops orphan…` unit test.

---

## 9. Settings panel

### 9.1 [U] BLOCKER — toggle

Top-right Settings button opens/closes the panel.

### 9.2 [U] BLOCKER — Shared file section

- Current path shown in a code block.
- **Change file…** opens native file picker.
- **Forget this file** deletes `lastFile.txt`, reloads to onboarding.

### 9.3 [E] [U] BLOCKER — License section

- License key shown (masked if you want; currently shown in full).
- HWID shown.
- Last verified timestamp.
- **Re-verify** → calls license server, updates cached response.
  Shows "License OK." or the reason label on failure.
- **Deactivate** → confirm dialog, then deletes license.json,
  reloads to the license gate.

### 9.4 [U] WARN — Keydown debug

Same as previous §10.5 — enable / scan / copy log / clear / disable.

---

## 10. End-to-end acceptance scenarios

### 10.1 [E] [U] BLOCKER — happy path

1. Open app. License gate auto-passes (cached).
2. Maria Papadopoulos walks in. In Contacts, type "Maria" → row
   highlights. If not found, **+ New**, fill her details, Save.
3. She wants to track a new prescription. Middle panel → **+ New**.
   Order #N created for her.
4. She hands over 4 boxes. Pharmacist scans each one. All four
   rows appear at the top of the QR list, green, with inline
   DataMatrix thumbnails.
5. A day later, the prescription clears. Pharmacist opens the order,
   clicks **Pop-out** on each QR. The small always-on-top window
   shows the DataMatrix. They bring up the gov validator on a second
   monitor, click its scan field, and pass the scanner over the
   popup. Validator accepts.
6. Click **Confirm order**. Stamped with today's date. Row turns
   green in middle panel.

### 10.2 [E] [U] BLOCKER — duplicate detection catches a re-scan

Pharmacist accidentally scans the same box twice. Parker shows the
duplicate-serial confirm dialog. Operator chooses Cancel → second
scan is discarded, not charged.

### 10.3 [E] [U] BLOCKER — two counters working the same contact

Counter A creates Maria's Order #1 with three scans. Counter B
(looking at the same contact) sees Order #1 populate within ~1 s.
Counter B scans into Order #1 as well — row appears on A within ~1 s
too. No duplicate IDs.

### 10.4 [U] WARN — license lapse recovery

A pharmacy pays for a subscription but payment lapses. Vendor flips
`status=expired` on the PHP side. Within the weekly re-check, the
client flips to the license gate. Vendor reactivates in DB, client
clicks **Re-verify** in settings or restarts → works again, no data
lost.

---

## 11. Known limitations (do NOT file bugs)

- **Web dev mode** has no license enforcement, no persistent file
  permission, no always-on-top popup. Those three are deliberately
  Electron-only.
- **HWID binding is per-activation**. If a PC's MAC address
  changes (e.g. motherboard replaced), the cached HWID will no
  longer match. The customer calls the vendor; vendor resets
  `bound_hwid` to NULL in DB; customer re-activates. There is
  intentionally no client-side "rebind" UI.
- **Offline grace is 7 days** from last successful `/verify` call.
  Changeable in `main.js` constant `OFFLINE_GRACE_DAYS`.
- **Pixel-identical regeneration vs the original printed pack is
  not guaranteed** (see previous iteration docs). What IS
  guaranteed: a compliant scanner decodes the regenerated symbol
  to the same AI values as the original.

---

## 12. Regression checks after any code change

If anyone touches main.js / app.js / state.js / gs1.js / storage.js /
license.js, rerun at minimum:

1. §0.2 — unit tests pass.
2. §1.3 — license activation succeeds.
3. §2.2 — Electron mode skips file permission prompt on relaunch.
4. §4.1 + §4.2 — order numbering is per-contact sequential.
5. §5.2 + §5.3 — scan captures FNC1 and lands in active order.
6. §5.4 — invalid row red tint + Pop-out hidden.
7. §6.1 — native popup stays always on top.
8. §7.1 — multi-counter sync ≤1.5 s.
