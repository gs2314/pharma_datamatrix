"use strict";

const S   = window.AppState;
const G   = window.QRGS1;
const BWIP = window.bwipjs;
const I18N = window.I18N;

// Paint all static `data-i18n*` nodes immediately so the UI is Greek
// before any render() runs.
I18N.apply(document);

const MIN_SCAN_LEN         = 4;
const MAX_INTER_KEY_GAP_MS = 80;
const POLL_INTERVAL_MS     = 1000;
const PREVIEW_MAX          = 28;

const $ = (id) => document.getElementById(id);

// Surface elements.
const licenseGate  = $("license-gate");
const licenseMsg   = $("license-msg");
const onboarding   = $("onboarding");
const mainEl       = $("main");
const statusEl     = $("status");
const ownerBadge   = $("owner-badge");
const ownerCompany = $("owner-company");
const ownerName    = $("owner-name");

// Lists + panels
const contactListEl   = $("contact-list");
const contactCountEl  = $("contact-count");
const contactEmptyEl  = $("contact-empty");
const contactFilterEl = $("contact-filter");
const contactTpl      = $("contact-item-template");

const orderListEl   = $("order-list");
const orderEmptyEl  = $("order-empty");
const ordersTitle   = $("orders-title");
const orderNewBtn   = $("order-new");
const orderTpl      = $("order-item-template");

const qrListEl    = $("qr-list");
const qrEmptyEl   = $("qr-empty");
const qrsTitle    = $("qrs-title");
const qrTpl       = $("qr-item-template");
const orderConfirmBtn = $("order-confirm");

// Scan
const scanMagnet  = $("scan-magnet");
const scanStateEl = $("scan-state");

// Order-level notes (above the scan panel)
const orderNotesWrap  = $("order-notes-wrap");
const orderNotesInput = $("order-notes");

// Help modal
const helpModal       = $("help-modal");
const helpNavEl       = $("help-nav");
const helpContentEl   = $("help-content");
const helpToggleBtn   = $("help-toggle");
const helpModalClose  = $("help-modal-close");

// Scan modal (web fallback)
const scanModal       = $("scan-modal");
const scanModalCanvas = $("scan-modal-canvas");
const scanModalTitle  = $("scan-modal-title");
const scanModalAi     = $("scan-modal-ai");
const scanModalClose  = $("scan-modal-close");

// Contact modal
const contactModal      = $("contact-modal");
const contactModalTitle = $("contact-modal-title");
const contactModalSave  = $("contact-modal-save");
const contactModalClose = $("contact-modal-close");
const contactModalCancel= $("contact-modal-cancel");
const contactNameInput  = $("contact-name");
const contactSurnameInput = $("contact-surname");
const contactTelInput   = $("contact-tel");

// Storage
const storage = window.AppStorage.makeStorage();
const mutex   = storage.makeMutex();

// App-level state (not persisted).
let handle = null;                // electron: string path; web: FileSystemFileHandle
let state = { ...S.INITIAL };
let lastMtime = 0;
let contactFilter = "";
let selectedContactId = null;
let selectedOrderId   = null;
let contactModalEditId = null;    // null = creating new

// --- helpers -----------------------------------------------------------------

function setStatus(msg, kind) {
  statusEl.textContent = msg || "";
  statusEl.dataset.kind = kind || "";
}
function isEditable(el) {
  if (!el) return false;
  const t = el.tagName;
  return t === "INPUT" || t === "TEXTAREA" || el.isContentEditable;
}
function formatTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function formatDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function formatExpiry(yymmdd) {
  if (!/^\d{6}$/.test(yymmdd || "")) return yymmdd || "";
  return "20" + yymmdd.substr(0, 2) + "-" + yymmdd.substr(2, 2) + "-" + yymmdd.substr(4, 2);
}
function previewOf(raw) {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    out += code < 0x20 || code === 0x7f ? "·" : ch;
    if (out.length >= PREVIEW_MAX) { out = out.slice(0, PREVIEW_MAX) + "…"; break; }
  }
  return out;
}

// --- license gate ------------------------------------------------------------

async function runLicenseGate() {
  const hw = await window.License.hwid();
  $("license-hwid").textContent = hw;

  // Debug mode bypass: skip the gate entirely, paint the red badge.
  if (await window.License.debugMode()) {
    const s = await window.License.status();
    paintOwnerBadge(s.cached);
    $("debug-badge").hidden = false;
    return true;
  }

  const s = await window.License.status();
  if (s.ok) {
    paintOwnerBadge(s.cached);
    $("debug-badge").hidden = true;
    return true;
  }
  showLicenseGate(window.License.reasonLabel(s.reason));
  return false;
}

function showLicenseGate(msg) {
  mainEl.hidden = true;
  onboarding.hidden = true;
  licenseGate.hidden = false;
  licenseMsg.textContent = msg || "";
  licenseMsg.dataset.kind = msg ? "warn" : "";
  setTimeout(() => $("license-input").focus(), 30);
}
function hideLicenseGate() { licenseGate.hidden = true; }

$("license-activate").addEventListener("click", async () => {
  const key = $("license-input").value.trim();
  licenseMsg.textContent = I18N.license.contacting;
  licenseMsg.dataset.kind = "";
  const r = await window.License.activate(key);
  if (r.ok) {
    paintOwnerBadge(r.cached);
    hideLicenseGate();
    await bootstrapStorage();
    return;
  }
  licenseMsg.textContent = window.License.reasonLabel(r.reason) + (r.detail ? ` (${r.detail})` : "");
  licenseMsg.dataset.kind = "err";
});
$("license-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("license-activate").click();
});

function paintOwnerBadge(cached) {
  if (!cached || !cached.owner) { ownerBadge.hidden = true; return; }
  ownerBadge.hidden = false;
  // In DEBUG mode the backend fills in an English sentinel; swap it for the
  // localized version so the UI stays consistent.
  const company = (cached.license_number === "DEBUG")
    ? I18N.debugOwner
    : (cached.owner.company || "");
  ownerCompany.textContent = company;
  const nm = [cached.owner.name, cached.owner.surname].filter(Boolean).join(" ");
  ownerName.textContent = nm ? "· " + nm : "";
}

// --- rendering ---------------------------------------------------------------

function render() {
  renderContacts();
  renderOrders();
  renderOrderNotes();
  renderQRs();
  updateScanReadiness();
}

function renderContacts() {
  const q = contactFilter.trim().toLowerCase();
  const visible = (state.contacts || []).filter((c) => {
    if (!q) return true;
    return (c.name + " " + c.surname + " " + c.tel).toLowerCase().includes(q);
  });
  contactCountEl.textContent = String((state.contacts || []).length);
  contactEmptyEl.hidden = (state.contacts || []).length > 0;
  contactListEl.innerHTML = "";

  for (const c of visible) {
    const li = contactTpl.content.firstElementChild.cloneNode(true);
    li.dataset.id = c.id;
    li.classList.toggle("selected", c.id === selectedContactId);
    li.querySelector(".contact-name").textContent = (c.name + " " + c.surname).trim() || I18N.contacts.unnamed;
    li.querySelector(".contact-tel").textContent  = c.tel || "";
    const orderCount = S.ordersForContact(state, c.id).length;
    li.querySelector(".list-item-badge").textContent = String(orderCount);

    li.addEventListener("click", (e) => {
      if (e.target.classList.contains("remove")) return;
      selectContact(c.id);
    });
    li.addEventListener("dblclick", (e) => {
      if (e.target.classList.contains("remove")) return;
      openContactModal(c.id);
    });
    li.querySelector(".remove").addEventListener("click", async (e) => {
      e.stopPropagation();
      const label = (c.name + " " + c.surname).trim() || I18N.contacts.unnamed;
      if (!confirm(I18N.contacts.deleteConfirm(label))) return;
      await mutateState((cur) => S.removeContact(cur, c.id));
      if (selectedContactId === c.id) { selectedContactId = null; selectedOrderId = null; }
      render();
    });
    contactListEl.appendChild(li);
  }
}

function renderOrders() {
  orderListEl.innerHTML = "";
  if (!selectedContactId) {
    orderEmptyEl.hidden = false;
    orderEmptyEl.textContent = I18N.orders.emptyNoContact;
    ordersTitle.textContent = I18N.orders.title;
    orderNewBtn.disabled = true;
    orderNewBtn.title = I18N.orders.pickFirst;
    return;
  }
  const contact = S.contactById(state, selectedContactId);
  const orders = S.ordersForContact(state, selectedContactId)
    .slice().sort((a, b) => (b.orderDate || 0) - (a.orderDate || 0));

  ordersTitle.textContent = contact
    ? I18N.orders.titleFor((contact.name + " " + contact.surname).trim() || I18N.contacts.unnamed)
    : I18N.orders.title;
  orderNewBtn.disabled = false;
  orderNewBtn.title = "";

  orderEmptyEl.hidden = orders.length > 0;
  if (orders.length === 0) {
    orderEmptyEl.textContent = I18N.orders.emptyNoOrders;
    return;
  }

  for (const o of orders) {
    const li = orderTpl.content.firstElementChild.cloneNode(true);
    li.dataset.id = o.id;
    li.classList.toggle("selected", o.id === selectedOrderId);
    li.classList.toggle("confirmed", o.status === "confirmed");
    li.querySelector(".order-number").textContent = I18N.orders.orderNumber(o.orderNumber);
    li.querySelector(".order-date").textContent   = formatDate(o.orderDate);
    const statusEl = li.querySelector(".order-status");
    statusEl.textContent = o.status === "confirmed" ? I18N.orders.statusConfirmed : I18N.orders.statusUnconfirmed;
    statusEl.className = "order-status " + (o.status === "confirmed" ? "ok" : "warn");
    li.querySelector(".list-item-badge").textContent = String(S.qrsForOrder(state, o.id).length);

    li.addEventListener("click", (e) => {
      if (e.target.classList.contains("remove")) return;
      selectOrder(o.id);
    });
    li.querySelector(".remove").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(I18N.orders.deleteConfirm(o.orderNumber))) return;
      await mutateState((cur) => S.removeOrder(cur, o.id));
      if (selectedOrderId === o.id) selectedOrderId = null;
      render();
    });
    orderListEl.appendChild(li);
  }
}

function renderQRs() {
  qrListEl.innerHTML = "";
  if (!selectedOrderId) {
    qrEmptyEl.hidden = false;
    qrEmptyEl.textContent = I18N.qrs.emptyNoOrder;
    qrsTitle.textContent = I18N.qrs.title;
    orderConfirmBtn.disabled = true;
    orderConfirmBtn.textContent = I18N.orders.confirmBtn;
    return;
  }
  const order = S.orderById(state, selectedOrderId);
  const qrs = S.qrsForOrder(state, selectedOrderId)
    .slice().sort((a, b) => (b.scannedAt || 0) - (a.scannedAt || 0));
  qrsTitle.textContent = order ? I18N.qrs.titleFor(order.orderNumber, qrs.length) : I18N.qrs.title;
  qrEmptyEl.hidden = qrs.length > 0;
  if (qrs.length === 0) qrEmptyEl.textContent = I18N.qrs.emptyNoQrs;

  orderConfirmBtn.disabled = false;
  orderConfirmBtn.textContent = order && order.status === "confirmed"
    ? I18N.orders.unconfirmBtn
    : I18N.orders.confirmBtn;
  orderConfirmBtn.classList.toggle("primary", order && order.status !== "confirmed");

  for (const entry of qrs) {
    const li = qrTpl.content.firstElementChild.cloneNode(true);
    li.dataset.id = entry.id;
    li.querySelector(".time").textContent = formatTime(entry.scannedAt);

    const fields = entry.parsed?.fields || {};
    const gtinEl   = li.querySelector(".chip.gtin");
    const expEl    = li.querySelector(".chip.exp");
    const batchEl  = li.querySelector(".chip.batch");
    const serialEl = li.querySelector(".chip.serial");
    const flagEl   = li.querySelector(".chip.flag");
    gtinEl.textContent   = fields["01"] || "";
    expEl.textContent    = formatExpiry(fields["17"]);
    batchEl.textContent  = fields["10"] || "";
    serialEl.textContent = fields["21"] || "";

    if (!fields["01"] && !fields["21"] && !fields["10"]) {
      gtinEl.classList.remove("gtin");
      gtinEl.textContent = previewOf(entry.rawCode || "");
    }

    if (entry.issues && entry.issues.length) {
      flagEl.hidden = false;
      flagEl.textContent = entry.issues[0];
      flagEl.title = entry.issues.join(" · ");
      li.classList.add("invalid");
    }

    li.querySelector(".note").value = entry.note || "";
    li.classList.toggle("copied", !!entry.copiedAt);

    const barcodeCanvas = li.querySelector(".barcode");
    const rendered = renderBarcodeTo(barcodeCanvas, entry.parsed, 3);
    if (!rendered) barcodeCanvas.classList.add("empty");

    wireQRRow(li, entry, rendered);
    qrListEl.appendChild(li);
  }
}

function renderBarcodeTo(canvas, parsed, scale) {
  if (!canvas || !BWIP) return false;
  if (!G.canRegenerateBarcode(parsed)) return false;
  const text = G.toBracketedAI(parsed);
  if (!text) return false;
  try {
    BWIP.toCanvas(canvas, {
      bcid: "gs1datamatrix",
      text,
      scale: scale || 3,
      padding: 4,
      backgroundcolor: "FFFFFF",
    });
    return true;
  } catch (err) {
    console.warn("bwip-js render failed:", err.message || err);
    return false;
  }
}

// --- selections --------------------------------------------------------------

function selectContact(id) {
  selectedContactId = id;
  selectedOrderId = null;
  render();
}
function selectOrder(id) {
  selectedOrderId = id;
  const order = S.orderById(state, id);
  if (order && order.contactId !== selectedContactId) selectedContactId = order.contactId;
  render();
}

function updateScanReadiness() {
  const order = selectedOrderId ? S.orderById(state, selectedOrderId) : null;
  const canScan = order && order.status !== "confirmed";
  scanMagnet.disabled = !canScan;
  scanMagnet.readOnly = !canScan;
  if (canScan) {
    scanMagnet.placeholder = I18N.qrs.scanPlaceholderReady;
    scanStateEl.textContent = I18N.ready;
    scanStateEl.dataset.kind = "";
    if (document.activeElement !== scanMagnet && !isEditable(document.activeElement)) scanMagnet.focus();
  } else {
    scanMagnet.placeholder = order
      ? I18N.qrs.scanPlaceholderConfirmed
      : I18N.qrs.scanPlaceholderPickOrder;
    scanStateEl.textContent = I18N.locked;
    scanStateEl.dataset.kind = "";
  }
}

// -------------- order-level notes --------------
// One shared textarea above the scan panel (parity with per-QR notes). Hidden
// when no order is selected; read-only when the order is confirmed.

let orderNotesSaveTimer = null;
let orderNotesLastSavedFor = null;

function renderOrderNotes() {
  if (!selectedOrderId) {
    orderNotesWrap.hidden = true;
    orderNotesInput.value = "";
    orderNotesLastSavedFor = null;
    return;
  }
  const order = S.orderById(state, selectedOrderId);
  if (!order) { orderNotesWrap.hidden = true; return; }
  orderNotesWrap.hidden = false;

  // Preserve caret when polling paints remote changes mid-edit: only overwrite
  // value if the focus is elsewhere OR this is a different order.
  const focused = document.activeElement === orderNotesInput;
  if (!focused || orderNotesLastSavedFor !== order.id) {
    orderNotesInput.value = order.note || "";
  }
  orderNotesLastSavedFor = order.id;
  orderNotesInput.readOnly = order.status === "confirmed";
  orderNotesInput.classList.toggle("locked", order.status === "confirmed");
}

orderNotesInput.addEventListener("input", () => {
  if (!selectedOrderId) return;
  clearTimeout(orderNotesSaveTimer);
  const id = selectedOrderId;
  const val = orderNotesInput.value;
  orderNotesSaveTimer = setTimeout(() => saveOrderNote(id, val), 400);
});
orderNotesInput.addEventListener("blur", () => {
  if (!selectedOrderId) return;
  clearTimeout(orderNotesSaveTimer);
  saveOrderNote(selectedOrderId, orderNotesInput.value);
});

async function saveOrderNote(id, note) {
  const current = S.orderById(state, id);
  if (!current) return;
  if (current.status === "confirmed") return; // read-only guard
  if ((current.note || "") === (note || "")) return;
  try { await mutateState((cur) => S.updateOrder(cur, id, { note })); } catch {}
}

// --- disk mutations ----------------------------------------------------------

async function readFromDisk() {
  const { state: loaded, mtime } = await storage.readFile(handle);
  state = loaded;
  lastMtime = mtime;
  render();
}
async function mutateState(apply) {
  if (!handle) return;
  await mutex(async () => {
    let current;
    try { current = (await storage.readFile(handle)).state; }
    catch (err) { setStatus(I18N.generic.readFailed(err.message), "err"); throw err; }
    const next = apply(current);
    if (!next) return;
    try { await storage.writeState(handle, next); }
    catch (err) { setStatus(I18N.generic.writeFailed(err.message), "err"); throw err; }
    state = next;
    render();
    if (storage.mode === "electron") lastMtime = await window.electronAPI.fs.statMtime(handle);
    else                              lastMtime = (await handle.getFile()).lastModified;
  });
}

// --- contact modal -----------------------------------------------------------

function openContactModal(id) {
  contactModalEditId = id || null;
  const c = id ? S.contactById(state, id) : null;
  contactModalTitle.textContent = c ? I18N.contacts.modalEdit : I18N.contacts.modalNew;
  contactNameInput.value    = c?.name    || "";
  contactSurnameInput.value = c?.surname || "";
  contactTelInput.value     = c?.tel     || "";
  contactModal.hidden = false;
  setTimeout(() => contactNameInput.focus(), 30);
}
function closeContactModal() { contactModal.hidden = true; contactModalEditId = null; }

contactModalSave.addEventListener("click", async () => {
  const fields = {
    name: contactNameInput.value,
    surname: contactSurnameInput.value,
    tel: contactTelInput.value,
  };
  if (!fields.name && !fields.surname && !fields.tel) {
    setStatus(I18N.contacts.needFields, "warn");
    return;
  }
  if (contactModalEditId) {
    const id = contactModalEditId;
    await mutateState((cur) => S.updateContact(cur, id, fields));
  } else {
    const c = S.createContact(fields);
    await mutateState((cur) => S.addContact(cur, c));
    selectedContactId = c.id;
    selectedOrderId = null;
  }
  closeContactModal();
  render();
});
contactModalCancel.addEventListener("click", closeContactModal);
contactModalClose.addEventListener("click", closeContactModal);
contactModal.addEventListener("click", (e) => { if (e.target === contactModal) closeContactModal(); });

$("contact-new").addEventListener("click", () => openContactModal(null));

// --- order actions -----------------------------------------------------------

orderNewBtn.addEventListener("click", async () => {
  if (!selectedContactId) return;
  const contactId = selectedContactId;
  const o = S.createOrder(state, contactId);
  await mutateState((cur) => S.addOrder(cur, o));
  selectedOrderId = o.id;
  render();
});

orderConfirmBtn.addEventListener("click", async () => {
  if (!selectedOrderId) return;
  const order = S.orderById(state, selectedOrderId);
  if (!order) return;
  const id = order.id;
  if (order.status === "confirmed") {
    if (!confirm(I18N.orders.unconfirmConfirm)) return;
    await mutateState((cur) => S.unconfirmOrder(cur, id));
  } else {
    const count = S.qrsForOrder(state, id).length;
    if (count === 0 && !confirm(I18N.orders.confirmEmpty)) return;
    await mutateState((cur) => S.confirmOrder(cur, id));
  }
  render();
});

// --- scan pipeline -----------------------------------------------------------

function buildFromScan(raw) {
  const parsed = G.parse(raw);
  const report = G.validateMedicine(parsed);
  const canonical = G.toCanonicalPlain(parsed);
  return {
    rawCode: raw, parsed, canonical,
    valid: report.ok, issues: report.errors,
  };
}

async function submitScan(raw) {
  if (!selectedOrderId) { setStatus(I18N.qrs.statusPickOrder, "warn"); return; }
  const order = S.orderById(state, selectedOrderId);
  if (!order || order.status === "confirmed") { setStatus(I18N.qrs.statusOrderConfirmed, "warn"); return; }
  if (!S.sanitizeNote(raw) && (!raw || raw.length < MIN_SCAN_LEN)) {
    setStatus(I18N.qrs.statusTooShort, "warn");
    return;
  }
  const built = buildFromScan(raw);

  // Duplicate serial warning.
  const dupSerial = built.parsed.fields?.["21"];
  const existing = dupSerial ? S.findDuplicateBySerial(state, dupSerial) : null;
  if (existing) {
    const existingOrder = S.orderById(state, existing.orderId);
    if (!confirm(I18N.qrs.duplicateSerial(dupSerial, existingOrder?.orderNumber || "?"))) {
      setStatus(I18N.qrs.duplicateSkipped, "warn");
      return;
    }
  }

  const qr = S.createQR(selectedOrderId, built.rawCode, "", {
    parsed: built.parsed, canonical: built.canonical,
    valid: built.valid, issues: built.issues,
  });
  try {
    await mutateState((cur) => S.addQR(cur, qr));
    setStatus(built.valid
      ? I18N.qrs.statusAdded(G.describe(built.parsed))
      : I18N.qrs.statusAddedIssue(built.issues[0]),
      built.valid ? "ok" : "warn");
    setTimeout(() => {
      const li = qrListEl.querySelector(`li[data-id="${qr.id}"]`);
      if (li) li.querySelector(".note").focus();
    }, 30);
  } catch {}
}

// --- QR row wiring -----------------------------------------------------------

function wireQRRow(li, entry, canScan) {
  const copyBtn    = li.querySelector(".copy");
  const copyRawBtn = li.querySelector(".copy-raw");
  const scanBtn    = li.querySelector(".scan-btn");
  const removeBtn  = li.querySelector(".remove");
  const noteInput  = li.querySelector(".note");
  const barcodeEl  = li.querySelector(".barcode");

  // Button labels + tooltips (kept out of the HTML template so i18n owns them).
  scanBtn.textContent    = I18N.qrs.buttonPopOut;
  copyBtn.textContent    = I18N.qrs.buttonCopy;
  copyRawBtn.textContent = I18N.qrs.buttonRaw;
  noteInput.placeholder  = I18N.qrs.notePlaceholder;
  if (barcodeEl) barcodeEl.title = I18N.popup.modalBody;

  if (!entry.canonical) copyBtn.hidden = true;
  if (entry.canonical === entry.rawCode) copyRawBtn.hidden = true;
  if (!canScan) scanBtn.hidden = true;

  copyBtn.addEventListener("click", (e) => { e.stopPropagation(); copyRow(entry.id, "canonical"); });
  copyRawBtn.addEventListener("click", (e) => { e.stopPropagation(); copyRow(entry.id, "raw"); });
  scanBtn.addEventListener("click", (e) => { e.stopPropagation(); openPopup(entry); });
  removeBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await mutateState((cur) => S.removeQR(cur, entry.id));
  });

  if (canScan && barcodeEl) {
    barcodeEl.addEventListener("click", (e) => { e.stopPropagation(); openPopup(entry); });
  }

  li.addEventListener("click", (e) => {
    if (isEditable(e.target) || e.target.tagName === "BUTTON" || e.target === barcodeEl) return;
    if (canScan) openPopup(entry);
    else         copyRow(entry.id, "canonical");
  });

  let noteTimer = null;
  noteInput.addEventListener("input", () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => saveNote(entry.id, noteInput.value), 300);
  });
  noteInput.addEventListener("blur", () => {
    clearTimeout(noteTimer);
    saveNote(entry.id, noteInput.value);
  });
  noteInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); noteInput.blur(); scanMagnet.focus(); }
  });
}

async function copyRow(id, mode) {
  const entry = state.qrs.find((q) => q.id === id);
  if (!entry) return;
  const payload = mode === "raw" ? entry.rawCode : (entry.canonical || entry.rawCode);
  const label   = mode === "raw"
    ? I18N.qrs.statusCopiedRaw
    : I18N.qrs.statusCopiedCanonical;
  try {
    await navigator.clipboard.writeText(payload);
    setStatus(label, "ok");
  } catch (err) {
    setStatus(I18N.qrs.statusCopyFailed(err.message), "err");
    return;
  }
  mutateState((cur) => S.updateQR(cur, id, { markedCopied: true })).catch(() => {});
}

async function saveNote(id, note) {
  const current = state.qrs.find((q) => q.id === id);
  if (!current || (current.note || "") === note) return;
  try { await mutateState((cur) => S.updateQR(cur, id, { note })); } catch {}
}

// --- popup / scan modal ------------------------------------------------------

function openPopup(entry) {
  if (!entry || !entry.parsed) return;
  const bracketed = G.toBracketedAI(entry.parsed);
  if (!bracketed) { setStatus(I18N.qrs.statusCantRegen, "warn"); return; }

  if (window.electronAPI && window.electronAPI.popup) {
    window.electronAPI.popup.open({
      bracketed,
      gtin: entry.parsed.fields?.["01"] || "",
      lot:  entry.parsed.fields?.["10"] || "",
      sn:   entry.parsed.fields?.["21"] || "",
      scale: 7,
    });
    return;
  }

  // Web fallback: in-page modal (no always-on-top in pure browser).
  scanModalTitle.textContent = I18N.popup.modalTitle + " — " + (G.describe(entry.parsed) || "");
  scanModalAi.textContent = bracketed;
  try {
    BWIP.toCanvas(scanModalCanvas, {
      bcid: "gs1datamatrix", text: bracketed, scale: 8, padding: 6, backgroundcolor: "FFFFFF",
    });
    scanModal.hidden = false;
    scanModalClose.focus();
  } catch (err) {
    setStatus(I18N.qrs.statusRenderFailed(err.message), "err");
  }
}
scanModalClose.addEventListener("click", () => { scanModal.hidden = true; });
scanModal.addEventListener("click", (e) => { if (e.target === scanModal) scanModal.hidden = true; });
document.addEventListener("keydown", (e) => {
  if (!scanModal.hidden && e.key === "Escape") scanModal.hidden = true;
  if (!contactModal.hidden && e.key === "Escape") closeContactModal();
}, true);

// --- scan capture ------------------------------------------------------------

const debugState = { enabled: false, start: 0, lines: [] };
function debugLog(l) { if (!debugState.enabled) return; debugState.lines.push(l); const ta = $("debug-log"); if (ta) { ta.value = debugState.lines.join("\n"); ta.scrollTop = ta.scrollHeight; } }
function debugAction(m) { debugLog("    " + m); }

(function setupScanCapture() {
  let buffer = "", lastKey = 0, altNumpad = "";
  function updateInd() {
    if (scanMagnet.disabled) { scanStateEl.textContent = I18N.locked; scanStateEl.dataset.kind = ""; return; }
    if (buffer.length === 0) { scanStateEl.textContent = I18N.ready; scanStateEl.dataset.kind = ""; }
    else { scanStateEl.textContent = `${I18N.scanning}… ${buffer.length}`; scanStateEl.dataset.kind = "active"; }
  }
  function reset() { buffer = ""; altNumpad = ""; updateInd(); }
  function flushAlt() {
    if (!altNumpad) return;
    const c = parseInt(altNumpad, 10);
    if (Number.isFinite(c) && c >= 0 && c <= 0xFFFF) {
      buffer += String.fromCharCode(c);
      debugAction(`Alt+${altNumpad} → U+${c.toString(16).toUpperCase().padStart(4,"0")} [buf=${buffer.length}]`);
    }
    altNumpad = ""; updateInd();
  }
  document.addEventListener("keydown", (e) => {
    const focused = document.activeElement === scanMagnet && !scanMagnet.disabled;
    if (debugState.enabled) {
      const t = Math.round(performance.now() - debugState.start);
      debugLog(`[T+${t}ms] key=${JSON.stringify(e.key)} code=${e.code} mods=${[e.ctrlKey&&"C",e.altKey&&"A",e.shiftKey&&"S"].filter(Boolean).join("")||"-"} focus=${focused}`);
    }
    if (!focused) return;

    if (e.altKey && /^Numpad\d$/.test(e.code)) { e.preventDefault(); altNumpad += e.code.slice(-1); return; }
    if (!e.altKey && altNumpad) flushAlt();

    const now = performance.now(), gap = now - lastKey; lastKey = now;
    if (buffer.length > 0 && gap > MAX_INTER_KEY_GAP_MS && !e.ctrlKey) reset();

    if (["Shift","Control","Alt","AltGraph","Meta","CapsLock","NumLock","ScrollLock","Dead"].includes(e.key)) return;

    if (e.key === "Enter") {
      e.preventDefault();
      if (buffer.length >= MIN_SCAN_LEN) { const c = buffer; reset(); submitScan(c); }
      else reset();
      return;
    }
    if (e.ctrlKey && (e.code === "BracketRight" || e.key === "]")) {
      e.preventDefault(); buffer += "\u001D"; debugAction(`Ctrl+] → \\u001D [buf=${buffer.length}]`); updateInd(); return;
    }
    if (e.key === "Tab") { e.preventDefault(); buffer += "\t"; updateInd(); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); buffer += e.key; updateInd(); return; }
    if (e.ctrlKey || e.altKey || e.metaKey) e.preventDefault();
  }, true);

  scanMagnet.addEventListener("paste", (e) => {
    if (scanMagnet.disabled) return;
    const text = (e.clipboardData || window.clipboardData)?.getData("text");
    if (text && text.length >= MIN_SCAN_LEN) { e.preventDefault(); reset(); submitScan(text); }
  });
})();

// --- UI plumbing --------------------------------------------------------------

document.addEventListener("click", (e) => {
  if (!isEditable(e.target) && !scanMagnet.disabled) scanMagnet.focus();
});

contactFilterEl.addEventListener("input", () => { contactFilter = contactFilterEl.value; renderContacts(); });

$("settings-toggle").addEventListener("click", () => {
  const p = $("settings-panel");
  const shown = !p.hidden;
  p.hidden = shown;
  $("settings-toggle").setAttribute("aria-expanded", String(!shown));
  if (!shown) paintSettings();
});

async function paintSettings() {
  $("file-path").textContent = handle ? (typeof handle === "string" ? handle : handle.name) : "—";
  const s = await window.License.status();
  if (s.ok && s.cached) {
    $("settings-license-key").textContent  = s.cached.license_number || "—";
    $("settings-license-hwid").textContent = s.cached.hwid || "—";
    $("settings-license-time").textContent = s.cached.lastCheckAt ? formatDate(s.cached.lastCheckAt) : "—";
  } else {
    $("settings-license-key").textContent = I18N.license.notActivated;
    $("settings-license-hwid").textContent = await window.License.hwid();
    $("settings-license-time").textContent = "—";
  }
}

$("license-refresh").addEventListener("click", async () => {
  const s = await window.License.status();
  setStatus(s.ok ? I18N.license.ok : window.License.reasonLabel(s.reason), s.ok ? "ok" : "err");
  paintSettings();
});
$("license-reset").addEventListener("click", async () => {
  if (!confirm(I18N.license.resetConfirm)) return;
  await window.License.deactivate();
  location.reload();
});

const toggleDebugBtn = $("toggle-debug");
const debugLogEl = $("debug-log");
toggleDebugBtn.addEventListener("click", () => {
  debugState.enabled = !debugState.enabled;
  toggleDebugBtn.textContent = debugState.enabled ? I18N.settings.disableDebug : I18N.settings.enableDebug;
  if (debugState.enabled) {
    debugState.start = performance.now();
    debugState.lines = ["[debug on]"];
    debugLogEl.value = debugState.lines.join("\n");
    setStatus(I18N.settings.logEnabled, "ok");
  } else {
    setStatus(I18N.settings.logDisabled, "");
  }
});
$("clear-debug").addEventListener("click", () => { debugState.lines = []; debugState.start = performance.now(); debugLogEl.value = ""; });
$("copy-debug").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(debugLogEl.value); setStatus(I18N.settings.logCopied, "ok"); }
  catch (err) { setStatus(I18N.qrs.statusCopyFailed(err.message), "err"); }
});

$("change-file").addEventListener("click", () => pickAndStart("existing"));
$("forget-file").addEventListener("click", async () => { await storage.forget(); location.reload(); });
$("pick-existing").addEventListener("click", () => pickAndStart("existing"));
$("pick-new").addEventListener("click", () => pickAndStart("new"));

async function pickAndStart(mode) {
  try { handle = mode === "new" ? await storage.pickNew() : await storage.pickExisting(); }
  catch (err) { if (err.name === "AbortError") return; setStatus(I18N.generic.pickFailed(err.message), "err"); return; }
  await start();
}

function showOnboarding() {
  onboarding.hidden = false;
  mainEl.hidden = true;
  $("unsupported").hidden = storage.supported();
}
function showMain() {
  onboarding.hidden = true;
  mainEl.hidden = false;
  ensureFocus();
}
function ensureFocus() { if (!scanMagnet.disabled && !isEditable(document.activeElement)) scanMagnet.focus(); }

// --- polling -----------------------------------------------------------------

let pollTimer = null;
async function pollOnce() {
  if (!handle) return;
  await mutex(async () => {
    let probeMtime;
    if (storage.mode === "electron") probeMtime = await window.electronAPI.fs.statMtime(handle);
    else                              probeMtime = (await handle.getFile()).lastModified;
    if (probeMtime === lastMtime) return;
    const { state: loaded, mtime } = await storage.readFile(handle);
    state = loaded; lastMtime = mtime;
    render();
  });
}
function startPolling() {
  if (pollTimer) return;
  const loop = async () => { try { await pollOnce(); } catch {} finally { pollTimer = setTimeout(loop, POLL_INTERVAL_MS); } };
  pollTimer = setTimeout(loop, POLL_INTERVAL_MS);
}

async function start() {
  if (storage.mode === "web") {
    const p = await storage.ensurePermission(handle, "readwrite");
    if (p !== "granted") { setStatus(I18N.generic.permissionDenied, "err"); showOnboarding(); return; }
  }
  try { await readFromDisk(); }
  catch (err) { setStatus(I18N.generic.initReadFailed(err.message), "err"); showOnboarding(); return; }
  showMain();
  setStatus(I18N.generic.readyOk, "ok");
  startPolling();
}

async function bootstrapStorage() {
  if (!BWIP) {
    setStatus(I18N.generic.bwipMissing, "err");
    return;
  }
  if (!storage.supported()) { showOnboarding(); return; }
  const saved = await storage.loadHandle();
  if (!saved) { showOnboarding(); return; }
  handle = saved;
  if (storage.mode === "electron") {
    // Electron backend gives a path string; verify the file is readable.
    const exists = await window.electronAPI.fs.fileExists(handle);
    if (!exists) { handle = null; showOnboarding(); return; }
    await start();
  } else {
    const perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm === "granted") { await start(); }
    else { showOnboarding(); setStatus(I18N.generic.pickResume, "warn"); }
  }
}

// --- help modal --------------------------------------------------------------

let helpActiveSection = null;

function buildHelp() {
  const order = I18N.helpSectionsOrder || [];
  helpNavEl.innerHTML = "";
  for (const key of order) {
    const section = I18N.helpSections[key];
    if (!section) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "help-nav-item";
    btn.textContent = section.title;
    btn.dataset.key = key;
    btn.setAttribute("data-testid", `help-nav-${key}`);
    btn.addEventListener("click", () => showHelpSection(key));
    helpNavEl.appendChild(btn);
  }
  showHelpSection(order[0]);
}

function showHelpSection(key) {
  const section = I18N.helpSections[key];
  if (!section) return;
  helpActiveSection = key;
  helpContentEl.innerHTML = `<h3>${section.title}</h3>${section.html}`;
  helpNavEl.querySelectorAll(".help-nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.key === key);
  });
  helpContentEl.scrollTop = 0;
}

function openHelp() {
  if (!helpActiveSection) buildHelp();
  helpModal.hidden = false;
  setTimeout(() => helpModalClose.focus(), 30);
}
function closeHelp() { helpModal.hidden = true; }

helpToggleBtn.addEventListener("click", openHelp);
helpModalClose.addEventListener("click", closeHelp);
helpModal.addEventListener("click", (e) => { if (e.target === helpModal) closeHelp(); });
document.addEventListener("keydown", (e) => {
  if (!helpModal.hidden && e.key === "Escape") closeHelp();
}, true);

async function init() {
  const licenseOK = await runLicenseGate();
  if (!licenseOK) return;
  await bootstrapStorage();
}

init();
