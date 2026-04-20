"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const G = require("../gs1.js");

const FNC1 = "\u001D";

// Real-world Greek pharma sample used elsewhere in the test suite.
// Matches the layout 01 + GTIN(14) + 10 + batch + FNC1 + 17 + YYMMDD + 21 + serial.
// GTIN 05203622108740 has a valid Mod-10 check digit.
const SAMPLE =
  "01" + "05203622108740" +
  "10" + "00437X" +
  FNC1 +
  "17" + "270531" +
  "21" + "37664107698060";

test("parse: canonical FNC1-separated pharma sample", () => {
  const r = G.parse(SAMPLE);
  assert.equal(r.errors.length, 0, r.errors.join("; "));
  assert.equal(r.fields["01"], "05203622108740");
  assert.equal(r.fields["10"], "00437X");
  assert.equal(r.fields["17"], "270531");
  assert.equal(r.fields["21"], "37664107698060");
  assert.deepEqual(r.order, ["01", "10", "17", "21"]);
});

test("parse: tolerates symbology identifier ]d2", () => {
  const r = G.parse("]d2" + SAMPLE);
  assert.equal(r.errors.length, 0);
  assert.equal(r.fields["01"], "05203622108740");
});

test("parse: tolerates leading FNC1", () => {
  const r = G.parse(FNC1 + SAMPLE);
  assert.equal(r.errors.length, 0);
});

test("parse: fixed-length AI eats exactly its declared length", () => {
  // GTIN must consume exactly 14 chars regardless of surrounding content.
  const r = G.parse("01" + "05203622108740" + "21" + "ABCDEF");
  assert.equal(r.fields["01"], "05203622108740");
  assert.equal(r.fields["21"], "ABCDEF");
});

test("parse: reports unknown AI and stops at boundary", () => {
  const r = G.parse("01" + "05203622108740" + "99" + "JUNK");
  assert.equal(r.fields["01"], "05203622108740");
  assert.ok(r.errors.some((e) => /unknown AI/i.test(e)), r.errors.join("; "));
});

test("parse: flags truncated fixed-length AI", () => {
  const r = G.parse("01" + "0520362210"); // 10 digits, need 14
  assert.ok(r.errors.some((e) => /truncated/i.test(e)), r.errors.join("; "));
});

test("parse: variable AI consumes until FNC1", () => {
  const r = G.parse("10" + "LOT21A" + FNC1 + "21" + "SER" + FNC1);
  assert.equal(r.fields["10"], "LOT21A");
  assert.equal(r.fields["21"], "SER");
});

test("parse: variable AI consumes until end when no FNC1", () => {
  // Without FNC1 the parser cannot know where batch ends — it greedily
  // consumes the rest. This is by design; the caller sees only batch
  // populated and can warn the operator that the scan lacks FNC1.
  const r = G.parse("10" + "LOT123" + "21" + "SERIAL");
  assert.equal(r.fields["10"], "LOT12321SERIAL");
  assert.equal(r.fields["21"], undefined);
});

test("gtinCheckDigit: known-good GTINs", () => {
  // Real pharma GTIN from SAMPLE; last digit 0.
  assert.equal(G.gtinCheckDigit("0520362210874"), 0);
  // Spot-check against the classic GS1 worked example (GTIN-13 629104150021 → 3):
  //   pad to 13 → "0629104150021" then compute.
  //   digits (l→r): 0,6,2,9,1,0,4,1,5,0,0,2,1
  //   weights (l→r): 3,1,3,1,3,1,3,1,3,1,3,1,3
  //   sum = 0+6+6+9+3+0+12+1+15+0+0+2+3 = 57 → check = (10-7)%10 = 3
  assert.equal(G.gtinCheckDigit("0629104150021"), 3);
});

test("validateGTIN: accepts valid, rejects malformed", () => {
  assert.equal(G.validateGTIN("05203622108740"), null);
  assert.match(G.validateGTIN("0520362210874X"), /14 digits/);
  assert.match(G.validateGTIN("05203622108741"), /check digit/i);
  assert.match(G.validateGTIN(""), /14 digits/);
});

test("validateExpiry: YYMMDD rules including DD=00", () => {
  assert.equal(G.validateExpiry("270531"), null);
  assert.equal(G.validateExpiry("270200"), null);  // last-day-of-month convention
  assert.match(G.validateExpiry("271301"), /month invalid/);
  assert.match(G.validateExpiry("270230"), /day 30 invalid for 2027-02/);
  assert.match(G.validateExpiry("27053"), /6 digits/);
});

test("validateAI82: rejects control chars, tolerates allowed punctuation", () => {
  assert.equal(G.validateAI82("LOT-001", "Batch"), null);
  assert.equal(G.validateAI82("AB.12/34", "Batch"), null);
  assert.match(G.validateAI82("LOT\u001D", "Batch"), /non-GS1/);
  assert.match(G.validateAI82("".padEnd(21, "A"), "Serial"), /exceeds/);
  assert.match(G.validateAI82("", "Batch"), /empty/);
});

test("validateMedicine: FMD-required AIs all present → ok", () => {
  const r = G.parse(SAMPLE);
  const v = G.validateMedicine(r);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(v.errors.length, 0);
});

test("validateMedicine: missing serial → error", () => {
  const r = G.parse("01" + "05203622108740" + "17" + "270531" + "10" + "LOT");
  const v = G.validateMedicine(r);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /serial/i.test(e)), v.errors.join("; "));
});

test("validateMedicine: bad check digit → error", () => {
  const r = G.parse("01" + "05203622108741" + "17" + "270531" + "10" + "A" + FNC1 + "21" + "B");
  const v = G.validateMedicine(r);
  assert.ok(v.errors.some((e) => /check digit/i.test(e)), v.errors.join("; "));
});

test("toCanonicalPlain: deterministic order, no FNC1", () => {
  const r = G.parse(SAMPLE);
  const out = G.toCanonicalPlain(r);
  assert.equal(out.includes(FNC1), false);
  assert.equal(
    out,
    "01" + "05203622108740" +
    "17" + "270531" +
    "10" + "00437X" +
    "21" + "37664107698060",
  );
});

test("toCanonicalGS1: FNC1 terminates variable AIs (except the last)", () => {
  const r = G.parse(SAMPLE);
  const out = G.toCanonicalGS1(r);
  assert.equal(
    out,
    "01" + "05203622108740" +
    "17" + "270531" +
    "10" + "00437X" + FNC1 +
    "21" + "37664107698060",
  );
});

test("toCanonicalPlain: re-emits in canonical order regardless of scan order", () => {
  // Same payload, scanned in a different order (some imagers do this).
  const scrambled = "21" + "SER" + FNC1 + "10" + "LOT" + FNC1 +
                    "01" + "05203622108740" + "17" + "270531";
  const straight  = "01" + "05203622108740" + "17" + "270531" +
                    "10" + "LOT" + FNC1 + "21" + "SER";
  const a = G.parse(scrambled);
  const b = G.parse(straight);
  const oa = G.toCanonicalPlain(a);
  const ob = G.toCanonicalPlain(b);
  // Both should produce the identical canonical string:
  //   01<gtin>17<yymmdd>10<batch>21<serial>
  const expected = "01" + "05203622108740" + "17" + "270531" +
                   "10" + "LOT" + "21" + "SER";
  assert.equal(oa, expected);
  assert.equal(ob, expected);
});

test("describe: human-readable one-liner", () => {
  const r = G.parse(SAMPLE);
  const s = G.describe(r);
  assert.match(s, /GTIN 05203622108740/);
  assert.match(s, /EXP 2027-05-31/);
  assert.match(s, /LOT 00437X/);
  assert.match(s, /SN 37664107698060/);
});
