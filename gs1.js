"use strict";

// GS1 parser + validator for medicine 2D DataMatrix payloads.
//
// Scope: the four AIs mandated by EU FMD / EMVS (and therefore by every
// national verification hub including HMNO): 01 GTIN, 17 expiry,
// 10 batch, 21 serial. Plus a handful of other AIs commonly present on
// pharma packs (11, 13, 15, 240, 710-713, 8005) so we don't bail out
// when we see them.
//
// Input: the raw keystroke buffer captured from the scanner, with
// FNC1 (U+001D) preserved between variable-length AIs. The parser
// does not tolerate blind FNC1-stripping — the whole point is to use
// FNC1 as the authoritative separator while we still have it, so the
// clipboard payload we produce is unambiguous.
//
// Output: { raw, fields: { "01": "...", ... }, order: [...],
//           errors: [], warnings: [] }
//
// Also exported: validateMedicine (checks the four FMD-required AIs),
// toCanonicalPlain (digits+letters only, canonical order — what the
// HMNO portal's paste box wants), toCanonicalGS1 (with FNC1 — strict
// GS1 element-string form, for receivers that honor the separator).

(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.PharmacyGS1 = mod;
})(typeof self !== "undefined" ? self : globalThis, function () {
  const FNC1 = "\u001D";

  // Fixed-length AIs: AI prefix → fixed data length in characters.
  // Source: GS1 General Specifications, Release 24, §3.2.
  const FIXED_LEN = {
    "00": 18, "01": 14, "02": 14,
    "11": 6, "12": 6, "13": 6, "14": 6, "15": 6, "16": 6, "17": 6,
    "20": 2,
  };

  // Variable-length AIs: AI prefix → max data length. Must be
  // terminated by FNC1 (or end of buffer).
  const VAR_MAX = {
    "10": 20, "21": 20, "22": 20, "30": 8,
    "240": 30, "241": 30, "242": 6, "243": 20,
    "250": 30, "251": 30, "253": 30, "254": 20,
    "710": 20, "711": 20, "712": 20, "713": 20,
    "8005": 6, "8006": 18, "8017": 18, "8018": 18,
  };

  // AI-82 character set (GS1 General Specifications §7.11):
  //   ! " % & ' ( ) * + , - . / 0-9 : ; < = > ? A-Z _ a-z
  // The serial (AI 21) and batch (AI 10) data fields are both AI-82.
  const AI82 = /^[A-Za-z0-9!"%&'()*+,./:;<=>?_\-]+$/;

  // Labels used for display / error messages.
  const AI_LABEL = {
    "01": "GTIN",
    "10": "Batch",
    "17": "Expiry",
    "21": "Serial",
    "11": "Production date",
    "13": "Packaging date",
    "15": "Best before",
    "240": "Additional ID",
    "710": "NHRN DE",
    "711": "NHRN FR",
    "712": "NHRN ES",
    "713": "NHRN BR",
  };

  function lookupAI(s, i) {
    // Try 4-digit, then 3-digit, then 2-digit AI prefixes. Longest
    // match wins — per the GS1 spec the prefix length is not encoded
    // in the stream, so we rely on the known AI table.
    for (const len of [4, 3, 2]) {
      if (i + len > s.length) continue;
      const code = s.substr(i, len);
      if (FIXED_LEN[code] !== undefined || VAR_MAX[code] !== undefined) {
        return code;
      }
    }
    return null;
  }

  function parse(raw) {
    const result = {
      raw: typeof raw === "string" ? raw : "",
      fields: Object.create(null),
      order: [],
      errors: [],
      warnings: [],
    };
    if (!result.raw) { result.errors.push("empty"); return result; }

    // Strip trailing CR/LF only — do NOT strip internal FNC1.
    let input = result.raw.replace(/[\r\n]+$/, "");

    let i = 0;
    // Optional leading symbology identifier (]d2 etc.) that some
    // imagers prepend before the first AI. Strip it if present.
    if (input.startsWith("]d2") || input.startsWith("]D2") ||
        input.startsWith("]C1") || input.startsWith("]c1")) {
      input = input.substring(3);
    }
    // Optional leading FNC1.
    if (input.charAt(i) === FNC1) i++;

    while (i < input.length) {
      if (input.charAt(i) === FNC1) { i++; continue; }

      const ai = lookupAI(input, i);
      if (!ai) {
        result.errors.push(
          `unknown AI at position ${i}: "${input.substr(i, 4)}…"`,
        );
        break;
      }
      i += ai.length;

      let value;
      if (FIXED_LEN[ai] !== undefined) {
        const dlen = FIXED_LEN[ai];
        if (i + dlen > input.length) {
          result.errors.push(
            `AI ${ai} (${AI_LABEL[ai] || "fixed-length"}) truncated: ` +
            `expected ${dlen} chars, got ${input.length - i}`,
          );
          break;
        }
        value = input.substr(i, dlen);
        i += dlen;
      } else {
        // Variable length — read until FNC1 or end-of-buffer.
        const fnc1 = input.indexOf(FNC1, i);
        const end = fnc1 === -1 ? input.length : fnc1;
        value = input.substring(i, end);
        i = fnc1 === -1 ? input.length : fnc1 + 1;

        const max = VAR_MAX[ai];
        if (max !== undefined && value.length > max) {
          result.warnings.push(
            `AI ${ai} (${AI_LABEL[ai] || "variable"}) exceeds ${max} chars ` +
            `(got ${value.length})`,
          );
        }
        if (value.length === 0) {
          result.warnings.push(
            `AI ${ai} (${AI_LABEL[ai] || "variable"}) is empty`,
          );
        }
      }

      if (result.fields[ai] !== undefined) {
        result.warnings.push(`AI ${ai} appears more than once`);
      }
      result.fields[ai] = value;
      result.order.push(ai);
    }

    return result;
  }

  // GTIN-14 Mod-10 check digit.
  // Rightmost (check) digit excluded from the sum; remaining digits
  // alternate weights 3,1,3,1,… starting from the rightmost data digit.
  function gtinCheckDigit(digits13) {
    if (!/^\d{13}$/.test(digits13)) return NaN;
    let sum = 0;
    for (let k = 0; k < 13; k++) {
      const n = digits13.charCodeAt(12 - k) - 48;
      sum += (k % 2 === 0) ? n * 3 : n;
    }
    return (10 - (sum % 10)) % 10;
  }

  function validateGTIN(gtin) {
    if (typeof gtin !== "string") return "GTIN missing";
    if (!/^\d{14}$/.test(gtin)) return "GTIN must be 14 digits";
    const expected = gtinCheckDigit(gtin.substring(0, 13));
    if (expected !== gtin.charCodeAt(13) - 48) {
      return `GTIN check digit invalid (expected ${expected}, got ${gtin[13]})`;
    }
    return null;
  }

  function validateExpiry(yymmdd) {
    if (typeof yymmdd !== "string") return "Expiry missing";
    if (!/^\d{6}$/.test(yymmdd)) return "Expiry must be 6 digits YYMMDD";
    const mm = parseInt(yymmdd.substr(2, 2), 10);
    const dd = parseInt(yymmdd.substr(4, 2), 10);
    if (mm < 1 || mm > 12) {
      return `Expiry month invalid (${yymmdd.substr(2, 2)})`;
    }
    // GS1: DD = 00 is valid and means "last day of the month".
    if (dd > 31) return `Expiry day invalid (${yymmdd.substr(4, 2)})`;
    if (dd !== 0) {
      // Spot-check against the actual month length (accept GS1 YY→20YY
      // century convention: YY 00-49 → 2000-2049, 50-99 → 1950-1999).
      const yy = parseInt(yymmdd.substr(0, 2), 10);
      const year = yy < 50 ? 2000 + yy : 1900 + yy;
      const maxDay = new Date(year, mm, 0).getDate();
      if (dd > maxDay) {
        return `Expiry day ${dd} invalid for ${year}-${String(mm).padStart(2, "0")}`;
      }
    }
    return null;
  }

  function validateAI82(value, label) {
    if (typeof value !== "string" || value.length === 0) {
      return `${label} is empty`;
    }
    if (value.length > 20) return `${label} exceeds 20 characters`;
    if (!AI82.test(value)) {
      return `${label} contains non-GS1 characters (AI-82 violated)`;
    }
    return null;
  }

  // FMD / EMVS / HMNO: all four of GTIN, expiry, batch, serial are
  // mandatory on prescription-medicine packs.
  function validateMedicine(parsed) {
    const errors = [];
    const warnings = [];
    const check = (ai, label, fn) => {
      const v = parsed.fields[ai];
      if (v === undefined) {
        errors.push(`missing ${label} (AI ${ai})`);
        return;
      }
      const e = fn(v);
      if (e) errors.push(e);
    };
    check("01", "GTIN",   (v) => validateGTIN(v));
    check("17", "expiry", (v) => validateExpiry(v));
    check("10", "batch",  (v) => validateAI82(v, "Batch"));
    check("21", "serial", (v) => validateAI82(v, "Serial"));

    // Propagate parser-level issues into the medicine-level report too.
    for (const e of parsed.errors)   errors.push(e);
    for (const w of parsed.warnings) warnings.push(w);
    return { errors, warnings, ok: errors.length === 0 };
  }

  // Canonical order for emission: 01 → 17 → 10 → 21, then anything else
  // preserving original order. This order is what HMNO and other EMVS
  // national systems expect when the payload arrives without FNC1
  // separators: the only variable-length AIs (10, 21) come last, and
  // since they sit on opposite sides of the fixed prefix "21" marker,
  // a dirty parser can unambiguously split batch vs. serial.
  const EMIT_ORDER = ["01", "17", "10", "21"];

  function _emitInOrder(parsed, withSeparators) {
    const seen = new Set();
    let out = "";
    const emit = (ai) => {
      const v = parsed.fields[ai];
      if (v === undefined || seen.has(ai)) return;
      out += ai + v;
      if (withSeparators && VAR_MAX[ai] !== undefined) out += FNC1;
      seen.add(ai);
    };
    for (const ai of EMIT_ORDER) emit(ai);
    for (const ai of parsed.order) if (!seen.has(ai)) emit(ai);
    if (withSeparators && out.endsWith(FNC1)) out = out.slice(0, -1);
    return out;
  }

  // Pure digits/letters — no FNC1. Safe to paste into any edit control,
  // including edit controls that silently strip control characters on
  // paste (which is exactly what the Greek/Hungarian gov portals do).
  function toCanonicalPlain(parsed) { return _emitInOrder(parsed, false); }

  // Strict GS1 element-string form, with FNC1 terminating every
  // variable-length AI. Use this when pasting into a receiver that
  // honors FNC1 (rare in web portals, common in ERP/warehouse systems).
  function toCanonicalGS1(parsed) { return _emitInOrder(parsed, true); }

  // Human-readable one-liner for display / tooltips.
  function describe(parsed) {
    const parts = [];
    if (parsed.fields["01"]) parts.push("GTIN " + parsed.fields["01"]);
    if (parsed.fields["17"]) {
      const d = parsed.fields["17"];
      parts.push("EXP 20" + d.substr(0, 2) + "-" + d.substr(2, 2) + "-" + d.substr(4, 2));
    }
    if (parsed.fields["10"]) parts.push("LOT " + parsed.fields["10"]);
    if (parsed.fields["21"]) parts.push("SN "  + parsed.fields["21"]);
    return parts.join(" · ");
  }

  return {
    FNC1,
    FIXED_LEN,
    VAR_MAX,
    AI_LABEL,
    parse,
    gtinCheckDigit,
    validateGTIN,
    validateExpiry,
    validateAI82,
    validateMedicine,
    toCanonicalPlain,
    toCanonicalGS1,
    describe,
  };
});
