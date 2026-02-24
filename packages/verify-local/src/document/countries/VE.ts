/**
 * 🇻🇪 Venezuela — Cédula de Identidad
 * ======================================
 * Supported documents:
 *   - Cédula de Identidad venezolana (V- / E-)
 *
 * Issuing authority: Servicio Administrativo de Identificación, Migración y Extranjería (SAIME)
 * Format: V-XXXXXXXX (venezolano) or E-XXXXXXXX (extranjero)
 * Prefix: "V" for citizens, "E" for residents
 *
 * Resources:
 *   - SAIME: https://www.saime.gob.ve
 *
 * 👋 CONTRIBUTOR: implement parse(), parseMRZ()
 * Status: STUB — contributions welcome!
 */

import type { CountryVerifier, DocumentResult, NumberValidation } from "../verifier.interface.js";

const VE: CountryVerifier = {
  countryCode:   "VE",
  countryName:   "Venezuela",
  documentTypes: ["cedula"],

  parse(ocrText: string): DocumentResult {
    const errors: string[] = [];
    const text = ocrText.toUpperCase().replace(/\s+/g, " ").trim();

    // ── Extract cédula ────────────────────────────────────────────────────
    let doc_number: string | undefined;
    const patterns = [
      /(?:C[EÉ]DULA|C\.I\.?|CI)[:\s]*([VEve]-?\s*\d{6,8})/,
      /([VEve]-?\s*\d{6,8})/,
    ];
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m) {
        const v = VE.validate(m[1]);
        if (v.valid) { doc_number = v.normalized; break; }
      }
    }

    const isVenezuela = /VENEZUELA|REPÚBLICA BOLIVARIANA|SAIME/i.test(text);
    if (!isVenezuela) errors.push("El documento no parece ser una cédula venezolana");
    if (!doc_number)  errors.push("No se pudo extraer número de cédula venezolana");

    // TODO: extract full_name, date_of_birth, sex

    return {
      valid:         errors.length === 0 && !!doc_number,
      doc_number,
      document_type: "cedula",
      country:       "VE",
      errors,
      raw_ocr:       ocrText,
    };
  },

  validate(docNumber: string): NumberValidation {
    // Remove spaces, dashes; normalize prefix to uppercase
    const clean = docNumber.replace(/[\s\-]/g, "").toUpperCase();
    const m     = clean.match(/^([VE])(\d{6,8})$/);
    if (!m) return { valid: false, error: "Formato inválido. Debe ser V-XXXXXXXX o E-XXXXXXXX" };
    return { valid: true, normalized: `${m[1]}-${m[2]}` };
  },
};

export default VE;
