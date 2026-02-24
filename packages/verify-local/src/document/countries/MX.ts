/**
 * 🇲🇽 Mexico — Credencial para Votar (INE/IFE) & Pasaporte
 * =============================================================
 * Supported documents:
 *   - Credencial para Votar (INE) — issued by Instituto Nacional Electoral
 *   - Pasaporte mexicano — ICAO TD3
 *
 * Key fields on INE:
 *   - CURP: 18-char alphanumeric (Clave Única de Registro de Población)
 *   - Clave de elector: 18 chars
 *   - Número de emisión: 2 digits
 *
 * Resources:
 *   - CURP format: https://www.gob.mx/curp
 *   - INE layout: https://www.ine.mx/credencial/
 *
 * 👋 CONTRIBUTOR: implement parse(), validate(), parseMRZ()
 * Status: STUB — contributions welcome!
 */

import type { CountryVerifier, DocumentResult, NumberValidation } from "../verifier.interface.js";

// CURP format: 4 letters + 6 digits (birthdate) + 6 letters + 2 alphanum
// Example: LOOE890725HDFPLL09
const CURP_REGEX = /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]{2}$/;

// Clave de elector: 18 alphanumeric chars
const CLAVE_ELECTOR_REGEX = /^[A-Z0-9]{18}$/;

const MX: CountryVerifier = {
  countryCode:   "MX",
  countryName:   "Mexico",
  documentTypes: ["ine", "ife", "passport", "curp"],

  parse(ocrText: string): DocumentResult {
    const errors: string[] = [];
    const text = ocrText.toUpperCase().replace(/\s+/g, " ").trim();

    // ── Extract CURP ──────────────────────────────────────────────────────
    let doc_number: string | undefined;
    const curpMatch = text.match(/CURP[:\s]+([A-Z0-9]{18})/);
    if (curpMatch && CURP_REGEX.test(curpMatch[1])) {
      doc_number = curpMatch[1];
    }

    // ── Detect document type ──────────────────────────────────────────────
    const isMexico = /INSTITUTO NACIONAL ELECTORAL|INE|IFE|ESTADOS UNIDOS MEXICANOS/i.test(text);
    if (!isMexico) errors.push("El documento no parece ser una credencial mexicana");

    // TODO: extract full_name, date_of_birth, sex, expiry_date
    // See CONTRIBUTING.md for field locations on INE front/back

    if (!doc_number) errors.push("No se pudo extraer CURP válida");

    return {
      valid:         errors.length === 0 && !!doc_number,
      doc_number,
      document_type: "ine",
      country:       "MX",
      errors,
      raw_ocr:       ocrText,
    };
  },

  validate(docNumber: string): NumberValidation {
    const clean = docNumber.replace(/\s/g, "").toUpperCase();

    if (CURP_REGEX.test(clean)) return { valid: true, normalized: clean };
    if (CLAVE_ELECTOR_REGEX.test(clean)) return { valid: true, normalized: clean };

    return {
      valid: false,
      error: "No es una CURP válida (18 chars: XXXXDDDDDDXXXXXXXXX) ni una clave de elector válida",
    };
  },

  // TODO: implement MRZ parser for pasaporte mexicano (TD3)
  parseMRZ(mrzText: string): DocumentResult {
    return {
      valid:   false,
      country: "MX",
      errors:  ["MRZ parser para México no implementado — contribuye en GitHub!"],
    };
  },
};

export default MX;
