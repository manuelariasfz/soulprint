/**
 * 🇵🇪 Peru — Documento Nacional de Identidad (DNI)
 * ====================================================
 * Supported documents:
 *   - DNI peruano — 8 digits, TD1 format (new)
 *
 * Issuing authority: Registro Nacional de Identificación y Estado Civil (RENIEC)
 * Format: 8 digits
 * MRZ: TD1 on back of new DNI
 *
 * Resources:
 *   - RENIEC: https://www.reniec.gob.pe
 *
 * 👋 CONTRIBUTOR: implement parse(), parseMRZ()
 * Status: STUB — contributions welcome!
 */

import type { CountryVerifier, DocumentResult, NumberValidation } from "../verifier.interface.js";

const PE: CountryVerifier = {
  countryCode:   "PE",
  countryName:   "Peru",
  documentTypes: ["dni"],

  parse(ocrText: string): DocumentResult {
    const errors: string[] = [];
    const text = ocrText.toUpperCase().replace(/\s+/g, " ").trim();

    let doc_number: string | undefined;
    const m = text.match(/DNI[:\s#Nº]*([0-9]{8})/);
    if (m) {
      const v = PE.validate(m[1]);
      if (v.valid) doc_number = v.normalized;
    }

    const isPeru = /PERÚ|PERU|RENIEC|REPÚBLICA DEL PERÚ/i.test(text);
    if (!isPeru)      errors.push("El documento no parece ser un DNI peruano");
    if (!doc_number)  errors.push("No se pudo extraer número de DNI peruano (8 dígitos)");

    // TODO: extract full_name, date_of_birth, sex, expiry_date, ubigeo

    return {
      valid:         errors.length === 0 && !!doc_number,
      doc_number,
      document_type: "dni",
      country:       "PE",
      errors,
      raw_ocr:       ocrText,
    };
  },

  validate(docNumber: string): NumberValidation {
    const clean = docNumber.replace(/\s/g, "");
    if (!/^\d{8}$/.test(clean)) return { valid: false, error: "El DNI peruano tiene exactamente 8 dígitos" };
    if (/^(\d)\1+$/.test(clean)) return { valid: false, error: "Número inválido (todos los dígitos iguales)" };
    return { valid: true, normalized: clean };
  },

  parseMRZ(mrzText: string): DocumentResult {
    return {
      valid:   false,
      country: "PE",
      errors:  ["MRZ parser para Perú no implementado — contribuye en GitHub!"],
    };
  },
};

export default PE;
