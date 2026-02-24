/**
 * 🇦🇷 Argentina — Documento Nacional de Identidad (DNI)
 * =========================================================
 * Supported documents:
 *   - DNI (Documento Nacional de Identidad) — TD1 format since 2009
 *   - Old DNI (libreta) — pre-2009, no MRZ
 *
 * Issuing authority: Registro Nacional de las Personas (RENAPER)
 * Format: 7–8 digits (new DNI), may have leading zeros
 * MRZ: TD1 (3 lines × 30 chars) on back of card DNI
 *
 * Key fields:
 *   - "DOCUMENTO NACIONAL DE IDENTIDAD"
 *   - CUIL/CUIT derived: 20/DNI/1 (men) or 27/DNI/1 (women)
 *
 * Resources:
 *   - RENAPER: https://www.argentina.gob.ar/interior/renaper
 *   - DNI spec: TD1 ICAO 9303
 *
 * 👋 CONTRIBUTOR: implement parse(), parseMRZ()
 * Status: STUB — contributions welcome!
 */

import type { CountryVerifier, DocumentResult, NumberValidation } from "../verifier.interface.js";

const AR: CountryVerifier = {
  countryCode:   "AR",
  countryName:   "Argentina",
  documentTypes: ["dni"],

  parse(ocrText: string): DocumentResult {
    const errors: string[] = [];
    const text = ocrText.toUpperCase().replace(/\s+/g, " ").trim();

    // ── Extract DNI number ────────────────────────────────────────────────
    let doc_number: string | undefined;
    const dniPatterns = [
      /DNI[:\s#Nº]+([0-9][0-9.\s]{6,9})/,
      /NÚMERO[:\s]+([0-9][0-9.\s]{6,9})/,
      /(?<![0-9])(\d{2}\.?\d{3}\.?\d{3})(?![0-9])/,  // XX.XXX.XXX
    ];
    for (const pat of dniPatterns) {
      const m = text.match(pat);
      if (m) {
        const candidate = m[1].replace(/[.\s]/g, "");
        const v = AR.validate(candidate);
        if (v.valid) { doc_number = v.normalized; break; }
      }
    }

    const isArgentina = /ARGENTINA|RENAPER|DOCUMENTO NACIONAL/i.test(text);
    if (!isArgentina) errors.push("El documento no parece ser un DNI argentino");
    if (!doc_number)  errors.push("No se pudo extraer número de DNI válido");

    // TODO: extract full_name, date_of_birth, sex, expiry_date

    return {
      valid:         errors.length === 0 && !!doc_number,
      doc_number,
      document_type: "dni",
      country:       "AR",
      errors,
      raw_ocr:       ocrText,
    };
  },

  validate(docNumber: string): NumberValidation {
    const clean = docNumber.replace(/[.\s\-]/g, "");
    if (!/^\d+$/.test(clean))            return { valid: false, error: "El DNI solo debe contener números" };
    if (clean.length < 7 || clean.length > 8) return { valid: false, error: `Longitud inválida: ${clean.length} dígitos (debe ser 7-8)` };
    if (/^(\d)\1+$/.test(clean))         return { valid: false, error: "Número inválido (todos los dígitos iguales)" };
    return { valid: true, normalized: clean };
  },

  parseMRZ(mrzText: string): DocumentResult {
    // TODO: implement TD1 MRZ parser for DNI argentino
    // Similar structure to Colombian cedula — see CO.ts
    return {
      valid:   false,
      country: "AR",
      errors:  ["MRZ parser para Argentina no implementado — contribuye en GitHub!"],
    };
  },
};

export default AR;
