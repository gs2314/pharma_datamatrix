"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const S = require("../state.js");

const GS = "\u001D";
const SAMPLE = `01052036221087401000437X${GS}17270531` +
               `2137664107698060`;

test("validateRawCode rejects empty and overly long", () => {
  assert.equal(S.validateRawCode(""), false);
  assert.equal(S.validateRawCode("x".repeat(S.MAX_RAW + 1)), false);
  assert.equal(S.validateRawCode(SAMPLE), true);
  assert.equal(S.validateRawCode(42), false);
  assert.equal(S.validateRawCode(null), false);
});

test("sanitizeNote strips control chars and trims", () => {
  assert.equal(S.sanitizeNote(`Maria\u001Da\u0007`), "Mariaa");
  assert.equal(S.sanitizeNote(`  hi  `), "hi");
  assert.equal(S.sanitizeNote("x".repeat(200)).length, S.MAX_NOTE);
  assert.equal(S.sanitizeNote(null), "");
});

test("createEntry preserves 0x1D byte-for-byte in rawCode", () => {
  const e = S.createEntry(SAMPLE, "");
  assert.equal(e.rawCode, SAMPLE);
  assert.ok(e.rawCode.includes(GS));
  assert.equal(e.rawCode.indexOf(GS), SAMPLE.indexOf(GS));
  assert.match(e.id, /^[0-9a-f-]{36}$/i);
  assert.ok(e.scannedAt > 0);
});

test("addEntry prepends without mutating input", () => {
  const s0 = { version: 1, entries: [] };
  const e = S.createEntry(SAMPLE, "first");
  const s1 = S.addEntry(s0, e);
  assert.equal(s0.entries.length, 0);
  assert.equal(s1.entries.length, 1);
  assert.equal(s1.entries[0].rawCode, SAMPLE);
});

test("updateEntry merges patch and sanitizes note", () => {
  const e = S.createEntry(SAMPLE, "");
  const s0 = S.addEntry({ version: 1, entries: [] }, e);
  const s1 = S.updateEntry(s0, e.id, { note: "Maria\u0007" });
  assert.equal(s1.entries[0].note, "Maria");
  assert.equal(s1.entries[0].rawCode, SAMPLE);
  const s2 = S.updateEntry(s1, e.id, { markedCopied: true });
  assert.ok(s2.entries[0].copiedAt);
  // Idempotent on non-existent id.
  const s3 = S.updateEntry(s0, "no-such-id", { note: "x" });
  assert.deepEqual(s3, s0);
});

test("removeEntry filters by id", () => {
  const e1 = S.createEntry(SAMPLE + "A", "");
  const e2 = S.createEntry(SAMPLE + "B", "");
  let s = S.addEntry({ version: 1, entries: [] }, e1);
  s = S.addEntry(s, e2);
  s = S.removeEntry(s, e1.id);
  assert.equal(s.entries.length, 1);
  assert.equal(s.entries[0].id, e2.id);
});

test("normalizeState tolerates malformed input", () => {
  assert.deepEqual(S.normalizeState(null), { version: 1, entries: [] });
  assert.deepEqual(S.normalizeState({}), { version: 1, entries: [] });
  assert.deepEqual(S.normalizeState({ entries: "nope" }), { version: 1, entries: [] });
  const good = { entries: [{ id: "a", rawCode: "x" }, { junk: true }] };
  assert.equal(S.normalizeState(good).entries.length, 1);
});

test("round-trip: state → JSON → parse preserves 0x1D", () => {
  const e = S.createEntry(SAMPLE, "note");
  const s = S.addEntry({ version: 1, entries: [] }, e);
  const json = JSON.stringify(s);
  const parsed = JSON.parse(json);
  const restored = S.normalizeState(parsed);
  assert.equal(restored.entries[0].rawCode, SAMPLE);
  assert.ok(restored.entries[0].rawCode.includes(GS));
  // The on-disk JSON must encode the GS as the \u001d escape, per JSON spec.
  assert.match(json, /\\u001[dD]/);
});
