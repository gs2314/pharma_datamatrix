"use strict";

// QR Ordering System — pure state layer.
//
// Three-level hierarchy: Contact → Order → QR.
// Storage shape:
//   {
//     version: 2,
//     contacts: [ { id, name, surname, tel, createdAt } ],
//     orders:   [ { id, contactId, orderNumber, orderDate, confirmationDate, status, createdAt } ],
//     qrs:      [ { id, orderId, rawCode, parsed, canonical, valid, issues, note, scannedAt } ],
//   }
//
// status ∈ "unconfirmed" | "confirmed"
// orderNumber: per-contact sequential (1, 2, 3…). contactId + orderNumber is unique.
// id fields: UUIDv4 strings (crypto.randomUUID()).
//
// All functions are pure: they take a state, return a new state. Never mutate input.

(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.AppState = mod;
})(typeof self !== "undefined" ? self : globalThis, function () {
  const SCHEMA_VERSION = 2;
  const INITIAL = { version: SCHEMA_VERSION, contacts: [], orders: [], qrs: [] };

  const MAX_NOTE = 120;
  const MAX_TEL  = 32;
  const MAX_NAME = 64;

  function uuid() {
    return globalThis.crypto.randomUUID();
  }

  function sanitizeString(s, max) {
    if (typeof s !== "string") return "";
    return s.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, max).trim();
  }
  function sanitizeNote(s) { return sanitizeString(s, MAX_NOTE); }
  function sanitizeName(s) { return sanitizeString(s, MAX_NAME); }
  function sanitizeTel(s)  { return sanitizeString(s, MAX_TEL); }

  // --- Contacts ----------------------------------------------------------

  function createContact(fields, opts) {
    opts = opts || {};
    return {
      id: opts.id || uuid(),
      name:    sanitizeName(fields.name),
      surname: sanitizeName(fields.surname),
      tel:     sanitizeTel(fields.tel),
      createdAt: opts.createdAt || Date.now(),
    };
  }
  function addContact(state, contact) {
    return { ...state, contacts: [contact, ...(state.contacts || [])] };
  }
  function updateContact(state, id, patch) {
    const contacts = (state.contacts || []).map((c) => {
      if (c.id !== id) return c;
      const next = { ...c };
      if ("name"    in patch) next.name    = sanitizeName(patch.name);
      if ("surname" in patch) next.surname = sanitizeName(patch.surname);
      if ("tel"     in patch) next.tel     = sanitizeTel(patch.tel);
      return next;
    });
    return { ...state, contacts };
  }
  // Cascading delete: contact → its orders → their QRs.
  function removeContact(state, id) {
    const ordersToDrop = new Set((state.orders || []).filter((o) => o.contactId === id).map((o) => o.id));
    return {
      ...state,
      contacts: (state.contacts || []).filter((c) => c.id !== id),
      orders:   (state.orders   || []).filter((o) => o.contactId !== id),
      qrs:      (state.qrs      || []).filter((q) => !ordersToDrop.has(q.orderId)),
    };
  }

  // --- Orders ------------------------------------------------------------

  function nextOrderNumberFor(state, contactId) {
    const nums = (state.orders || [])
      .filter((o) => o.contactId === contactId)
      .map((o) => o.orderNumber || 0);
    return nums.length === 0 ? 1 : Math.max(...nums) + 1;
  }
  function createOrder(state, contactId, opts) {
    opts = opts || {};
    return {
      id: opts.id || uuid(),
      contactId,
      orderNumber: opts.orderNumber || nextOrderNumberFor(state, contactId),
      orderDate: opts.orderDate || Date.now(),
      confirmationDate: opts.confirmationDate || null,
      status: opts.status || "unconfirmed",
      note: sanitizeString(opts.note || "", 2000),
      createdAt: opts.createdAt || Date.now(),
    };
  }
  function addOrder(state, order) {
    return { ...state, orders: [order, ...(state.orders || [])] };
  }
  function updateOrder(state, id, patch) {
    const orders = (state.orders || []).map((o) => {
      if (o.id !== id) return o;
      const next = { ...o };
      if ("orderDate"        in patch) next.orderDate = patch.orderDate;
      if ("confirmationDate" in patch) next.confirmationDate = patch.confirmationDate;
      if ("status"           in patch) next.status = patch.status === "confirmed" ? "confirmed" : "unconfirmed";
      if ("note"             in patch) next.note = sanitizeString(patch.note, 2000);
      return next;
    });
    return { ...state, orders };
  }
  // Confirm an order: stamps confirmationDate, sets status.
  function confirmOrder(state, id) {
    return updateOrder(state, id, { status: "confirmed", confirmationDate: Date.now() });
  }
  function unconfirmOrder(state, id) {
    return updateOrder(state, id, { status: "unconfirmed", confirmationDate: null });
  }
  function removeOrder(state, id) {
    return {
      ...state,
      orders: (state.orders || []).filter((o) => o.id !== id),
      qrs:    (state.qrs    || []).filter((q) => q.orderId !== id),
    };
  }

  // --- QRs ---------------------------------------------------------------

  function createQR(orderId, rawCode, note, opts) {
    opts = opts || {};
    const q = {
      id: opts.id || uuid(),
      orderId,
      rawCode,
      scannedAt: opts.scannedAt || Date.now(),
      note: sanitizeNote(note || ""),
      confirmedAt: opts.confirmedAt || null,
    };
    if (opts.parsed    !== undefined) q.parsed    = opts.parsed;
    if (opts.canonical !== undefined) q.canonical = opts.canonical;
    if (opts.valid     !== undefined) q.valid     = opts.valid;
    if (opts.issues    !== undefined) q.issues    = opts.issues;
    return q;
  }
  function addQR(state, qr) {
    return { ...state, qrs: [qr, ...(state.qrs || [])] };
  }
  function updateQR(state, id, patch) {
    const qrs = (state.qrs || []).map((q) => {
      if (q.id !== id) return q;
      const next = { ...q };
      if ("note"        in patch) next.note = sanitizeNote(patch.note);
      if ("confirmedAt" in patch) next.confirmedAt = patch.confirmedAt || null;
      if (patch.markedCopied === true) next.copiedAt = Date.now();
      return next;
    });
    return { ...state, qrs };
  }
  function confirmQR(state, id)   { return updateQR(state, id, { confirmedAt: Date.now() }); }
  function unconfirmQR(state, id) { return updateQR(state, id, { confirmedAt: null }); }
  // Bulk: confirm/unconfirm every QR in a given order in a single immutable pass.
  function confirmAllQRsForOrder(state, orderId) {
    const now = Date.now();
    const qrs = (state.qrs || []).map((q) =>
      q.orderId === orderId && !q.confirmedAt ? { ...q, confirmedAt: now } : q
    );
    return { ...state, qrs };
  }
  function unconfirmAllQRsForOrder(state, orderId) {
    const qrs = (state.qrs || []).map((q) =>
      q.orderId === orderId && q.confirmedAt ? { ...q, confirmedAt: null } : q
    );
    return { ...state, qrs };
  }
  function removeQR(state, id) {
    return { ...state, qrs: (state.qrs || []).filter((q) => q.id !== id) };
  }

  // Derived order status: computed from the child QRs, not stored.
  //   "empty"       — order has zero QRs
  //   "unconfirmed" — has QRs, none confirmed
  //   "partial"     — some QRs confirmed, at least one not
  //   "confirmed"   — every QR confirmed
  function computeOrderDerivedStatus(state, orderId) {
    const qrs = (state.qrs || []).filter((q) => q.orderId === orderId);
    if (qrs.length === 0) return "empty";
    const confirmed = qrs.filter((q) => q.confirmedAt).length;
    if (confirmed === 0) return "unconfirmed";
    if (confirmed === qrs.length) return "confirmed";
    return "partial";
  }

  // Duplicate-serial detection: warn if this serial (AI 21) is already parked
  // under any order. Returns the existing QR or null.
  function findDuplicateBySerial(state, serial) {
    if (!serial) return null;
    return (state.qrs || []).find((q) => q.parsed?.fields?.["21"] === serial) || null;
  }

  // --- Lookups -----------------------------------------------------------

  function contactById(state, id) { return (state.contacts || []).find((c) => c.id === id) || null; }
  function orderById(state, id)   { return (state.orders   || []).find((o) => o.id === id) || null; }
  function qrById(state, id)      { return (state.qrs      || []).find((q) => q.id === id) || null; }

  function ordersForContact(state, contactId) {
    return (state.orders || []).filter((o) => o.contactId === contactId);
  }
  function qrsForOrder(state, orderId) {
    return (state.qrs || []).filter((q) => q.orderId === orderId);
  }

  // --- Normalization & migration ----------------------------------------

  function normalizeState(raw) {
    if (!raw || typeof raw !== "object") return { ...INITIAL };

    // v1 (flat entries[]) → v2 (contacts/orders/qrs). Schema v1 was the
    // internal alpha format; we fresh-start since the user confirmed
    // there is no production data yet. If v1 data is encountered we
    // drop it into a sentinel "Unassigned" contact / order so nothing
    // is silently lost.
    if (Array.isArray(raw.entries) && (!raw.version || raw.version === 1)) {
      if (raw.entries.length === 0) return { ...INITIAL };
      const contact = {
        id: uuid(), name: "Unassigned", surname: "", tel: "",
        createdAt: Date.now(),
      };
      const order = {
        id: uuid(), contactId: contact.id, orderNumber: 1,
        orderDate: Date.now(), confirmationDate: null,
        status: "unconfirmed", createdAt: Date.now(),
      };
      const qrs = raw.entries
        .filter((e) => e && typeof e.id === "string" && typeof e.rawCode === "string")
        .map((e) => ({
          id: e.id, orderId: order.id, rawCode: e.rawCode,
          scannedAt: e.scannedAt || Date.now(), note: e.note || "",
          parsed: e.parsed, canonical: e.canonical, valid: e.valid, issues: e.issues,
        }));
      return { version: SCHEMA_VERSION, contacts: [contact], orders: [order], qrs };
    }

    const contacts = Array.isArray(raw.contacts)
      ? raw.contacts.filter((c) => c && typeof c.id === "string")
      : [];
    const orders = Array.isArray(raw.orders)
      ? raw.orders.filter((o) => o && typeof o.id === "string" && typeof o.contactId === "string")
      : [];
    const qrs = Array.isArray(raw.qrs)
      ? raw.qrs.filter((q) => q && typeof q.id === "string" && typeof q.rawCode === "string" && typeof q.orderId === "string")
      : [];

    // Orphan filter: orders whose contactId doesn't exist, QRs whose orderId doesn't exist.
    const contactIds = new Set(contacts.map((c) => c.id));
    const orderIds   = new Set(orders.filter((o) => contactIds.has(o.contactId)).map((o) => o.id));
    return {
      version: SCHEMA_VERSION,
      contacts,
      orders: orders.filter((o) => contactIds.has(o.contactId)),
      qrs:    qrs.filter((q) => orderIds.has(q.orderId)),
    };
  }

  return {
    SCHEMA_VERSION, INITIAL, MAX_NOTE, MAX_TEL, MAX_NAME,
    sanitizeNote, sanitizeName, sanitizeTel,
    createContact, addContact, updateContact, removeContact,
    createOrder, addOrder, updateOrder, confirmOrder, unconfirmOrder, removeOrder, nextOrderNumberFor,
    createQR, addQR, updateQR, removeQR, findDuplicateBySerial,
    confirmQR, unconfirmQR, confirmAllQRsForOrder, unconfirmAllQRsForOrder,
    computeOrderDerivedStatus,
    contactById, orderById, qrById, ordersForContact, qrsForOrder,
    normalizeState,
  };
});
