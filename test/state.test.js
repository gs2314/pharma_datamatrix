"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const S = require("../state.js");

function withCrypto() {
  if (!globalThis.crypto) globalThis.crypto = require("node:crypto").webcrypto;
}
withCrypto();

test("sanitizers strip control chars and trim", () => {
  assert.equal(S.sanitizeNote("  hello\u0000\u001d world  "), "hello world");
  assert.equal(S.sanitizeName("Maria\u0007"), "Maria");
  assert.equal(S.sanitizeTel("+30 210 1234567"), "+30 210 1234567");
  assert.equal(S.sanitizeNote("".padEnd(500, "x")).length, S.MAX_NOTE);
});

test("contact CRUD", () => {
  let s = { ...S.INITIAL };
  const c1 = S.createContact({ name: "Maria", surname: "K.", tel: "+30 210 11" });
  s = S.addContact(s, c1);
  assert.equal(s.contacts.length, 1);
  s = S.updateContact(s, c1.id, { tel: "+30 210 22" });
  assert.equal(s.contacts[0].tel, "+30 210 22");
  s = S.removeContact(s, c1.id);
  assert.equal(s.contacts.length, 0);
});

test("order per-contact sequential numbering", () => {
  let s = { ...S.INITIAL };
  const a = S.createContact({ name: "Alice", surname: "", tel: "" });
  const b = S.createContact({ name: "Bob", surname: "", tel: "" });
  s = S.addContact(S.addContact(s, a), b);
  s = S.addOrder(s, S.createOrder(s, a.id));
  s = S.addOrder(s, S.createOrder(s, a.id));
  s = S.addOrder(s, S.createOrder(s, b.id));
  s = S.addOrder(s, S.createOrder(s, a.id));
  const aOrders = S.ordersForContact(s, a.id).map((o) => o.orderNumber).sort();
  const bOrders = S.ordersForContact(s, b.id).map((o) => o.orderNumber).sort();
  assert.deepEqual(aOrders, [1, 2, 3]);
  assert.deepEqual(bOrders, [1]);
});

test("confirmOrder / unconfirmOrder stamps date", () => {
  let s = { ...S.INITIAL };
  const c = S.createContact({ name: "X", surname: "", tel: "" });
  s = S.addContact(s, c);
  const o = S.createOrder(s, c.id);
  s = S.addOrder(s, o);
  s = S.confirmOrder(s, o.id);
  assert.equal(S.orderById(s, o.id).status, "confirmed");
  assert.ok(S.orderById(s, o.id).confirmationDate > 0);
  s = S.unconfirmOrder(s, o.id);
  assert.equal(S.orderById(s, o.id).status, "unconfirmed");
  assert.equal(S.orderById(s, o.id).confirmationDate, null);
});

test("QR CRUD + rawCode preserves 0x1D byte-for-byte", () => {
  const FNC1 = "\u001D";
  const SAMPLE = "01" + "05203622108740" + "10" + "00437X" + FNC1 + "17" + "270531" + "21" + "37664107698060";
  let s = { ...S.INITIAL };
  const c = S.createContact({ name: "X", surname: "", tel: "" });
  s = S.addContact(s, c);
  const o = S.createOrder(s, c.id);
  s = S.addOrder(s, o);
  const q = S.createQR(o.id, SAMPLE, "note1");
  s = S.addQR(s, q);
  assert.equal(S.qrsForOrder(s, o.id)[0].rawCode, SAMPLE);
  s = S.updateQR(s, q.id, { note: "note2" });
  assert.equal(S.qrById(s, q.id).note, "note2");
  s = S.removeQR(s, q.id);
  assert.equal(S.qrsForOrder(s, o.id).length, 0);
});

test("cascading delete: contact → orders → QRs", () => {
  let s = { ...S.INITIAL };
  const c = S.createContact({ name: "X", surname: "", tel: "" });
  s = S.addContact(s, c);
  const o1 = S.createOrder(s, c.id);
  s = S.addOrder(s, o1);
  s = S.addQR(s, S.createQR(o1.id, "01" + "05203622108740", "", {}));
  s = S.addQR(s, S.createQR(o1.id, "10LOT", "", {}));
  assert.equal(s.qrs.length, 2);
  s = S.removeContact(s, c.id);
  assert.equal(s.contacts.length, 0);
  assert.equal(s.orders.length, 0);
  assert.equal(s.qrs.length, 0);
});

test("duplicate serial finder", () => {
  let s = { ...S.INITIAL };
  const c = S.createContact({ name: "X", surname: "", tel: "" });
  s = S.addContact(s, c);
  const o = S.createOrder(s, c.id);
  s = S.addOrder(s, o);
  s = S.addQR(s, S.createQR(o.id, "raw", "", { parsed: { fields: { "21": "SERIAL123" } } }));
  assert.equal(S.findDuplicateBySerial(s, "SERIAL123")?.parsed.fields["21"], "SERIAL123");
  assert.equal(S.findDuplicateBySerial(s, "OTHER"), null);
});

test("normalizeState drops orphan orders and QRs", () => {
  const raw = {
    version: 2,
    contacts: [{ id: "c1", name: "A", surname: "", tel: "" }],
    orders:   [{ id: "o1", contactId: "c1" }, { id: "o2", contactId: "nonexistent" }],
    qrs:      [
      { id: "q1", orderId: "o1", rawCode: "x" },
      { id: "q2", orderId: "o99", rawCode: "x" },
    ],
  };
  const n = S.normalizeState(raw);
  assert.equal(n.contacts.length, 1);
  assert.equal(n.orders.length, 1);
  assert.equal(n.qrs.length, 1);
});

test("v1 migration: flat entries[] → Unassigned contact + single order", () => {
  const v1 = { version: 1, entries: [
    { id: "e1", rawCode: "01012345", scannedAt: 1, note: "legacy" },
  ]};
  const n = S.normalizeState(v1);
  assert.equal(n.version, 2);
  assert.equal(n.contacts.length, 1);
  assert.equal(n.contacts[0].name, "Unassigned");
  assert.equal(n.orders.length, 1);
  assert.equal(n.qrs.length, 1);
  assert.equal(n.qrs[0].orderId, n.orders[0].id);
});

test("JSON round-trip preserves 0x1D in QR rawCode", () => {
  const FNC1 = "\u001D";
  let s = { ...S.INITIAL };
  const c = S.createContact({ name: "X", surname: "", tel: "" });
  s = S.addContact(s, c);
  const o = S.createOrder(s, c.id);
  s = S.addOrder(s, o);
  const q = S.createQR(o.id, "10LOT" + FNC1 + "21SER", "");
  s = S.addQR(s, q);
  const round = S.normalizeState(JSON.parse(JSON.stringify(s)));
  assert.equal(round.qrs[0].rawCode, "10LOT" + FNC1 + "21SER");
});

// ---------------------------------------------------------------------------
// Per-QR confirmation + derived order status
// ---------------------------------------------------------------------------

function seedOrder(qrCount) {
  let s = { ...S.INITIAL };
  const c = S.createContact({ name: "X", surname: "", tel: "" });
  s = S.addContact(s, c);
  const o = S.createOrder(s, c.id);
  s = S.addOrder(s, o);
  for (let i = 0; i < qrCount; i++) {
    s = S.addQR(s, S.createQR(o.id, `raw${i}`, "", {}));
  }
  return { s, orderId: o.id };
}

test("confirmQR stamps confirmedAt; unconfirmQR clears it", () => {
  let { s, orderId } = seedOrder(1);
  const qrId = S.qrsForOrder(s, orderId)[0].id;
  assert.equal(S.qrById(s, qrId).confirmedAt, null);
  s = S.confirmQR(s, qrId);
  assert.ok(S.qrById(s, qrId).confirmedAt > 0);
  s = S.unconfirmQR(s, qrId);
  assert.equal(S.qrById(s, qrId).confirmedAt, null);
});

test("computeOrderDerivedStatus returns empty / unconfirmed / partial / confirmed", () => {
  // empty
  {
    let { s, orderId } = seedOrder(0);
    assert.equal(S.computeOrderDerivedStatus(s, orderId), "empty");
  }
  // unconfirmed — 3 QRs, none confirmed
  {
    let { s, orderId } = seedOrder(3);
    assert.equal(S.computeOrderDerivedStatus(s, orderId), "unconfirmed");
  }
  // partial — 1 of 3 confirmed
  {
    let { s, orderId } = seedOrder(3);
    const first = S.qrsForOrder(s, orderId)[0].id;
    s = S.confirmQR(s, first);
    assert.equal(S.computeOrderDerivedStatus(s, orderId), "partial");
  }
  // confirmed — all 3
  {
    let { s, orderId } = seedOrder(3);
    for (const q of S.qrsForOrder(s, orderId)) s = S.confirmQR(s, q.id);
    assert.equal(S.computeOrderDerivedStatus(s, orderId), "confirmed");
  }
});

test("confirmAllQRsForOrder / unconfirmAllQRsForOrder flip every QR in the order", () => {
  let { s, orderId } = seedOrder(4);
  // Add a QR in a different order to ensure bulk ops don't leak across orders.
  const otherOrder = S.createOrder(s, S.contactById(s, s.contacts[0].id).id, { orderNumber: 999 });
  s = S.addOrder(s, otherOrder);
  s = S.addQR(s, S.createQR(otherOrder.id, "other", "", {}));

  s = S.confirmAllQRsForOrder(s, orderId);
  assert.equal(S.computeOrderDerivedStatus(s, orderId), "confirmed");
  assert.equal(S.computeOrderDerivedStatus(s, otherOrder.id), "unconfirmed", "other order untouched");

  s = S.unconfirmAllQRsForOrder(s, orderId);
  assert.equal(S.computeOrderDerivedStatus(s, orderId), "unconfirmed");
});

test("createQR accepts confirmedAt option; updateQR confirmedAt patch accepts null", () => {
  let { s, orderId } = seedOrder(0);
  const q = S.createQR(orderId, "raw", "", { confirmedAt: 12345 });
  s = S.addQR(s, q);
  assert.equal(S.qrById(s, q.id).confirmedAt, 12345);
  s = S.updateQR(s, q.id, { confirmedAt: null });
  assert.equal(S.qrById(s, q.id).confirmedAt, null);
});
