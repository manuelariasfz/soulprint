/**
 * 🇨🇱 Chile — Cédula de Identidad (RUN/RUT)
 * =============================================
 * Supported documents:
 *   - Cédula de Identidad chilena — TD1 format
 *
 * Issuing authority: Servicio de Registro Civil e Identificación (SRCeI)
 * Format: XXXXXXXX-Y (RUN: 7-8 digits + verifier digit, '0'-'9' or 'K')
 * Check digit: mod 11 with weights 2,3,4,5,6,7 (right to left)
 *
 * Resources:
 *   - SRCeI: https://www.registrocivil.cl
 *   - RUN format: https://www.srcei.cl/run
 *
 * 👋 CONTRIBUTOR: implement parse(), parseMRZ()
 * Status: PARTIAL — RUN validation done, OCR parser is stub
 */

import type { CountryVerifier, DocumentResult, NumberValidation } from "../verifier.interface.js";

/** Chile RUN check digit — mod 11, returns '0'-'9' or 'K' */
function runCheckDigit(num: string): string {
  const digits = num.replace(/\./g, "").split("").reverse();
  const weights = [2, 3, 4, 5, 6, 7];
  let sum = 0;
  digits.forEach((d, i) => { sum += parseInt(d) * weights[i % weights.length]; });
  const rem = 11 - (sum % 11);
  if (rem === 11) return "0";
  if (rem === 10) return "K";
  return rem.toString();
}

const CL: CountryVerifier = {
  countryCode:   "CL",
  countryName:   "Chile",
  documentTypes: ["cedula_identidad", "rut"],

  parse(ocrText: string): DocumentResult {
    const errors: string[] = [];
    const text = ocrText.toUpperCase().replace(/\s+/g, " ").trim();

    let doc_number: string | undefined;
    const runPatterns = [
      /RUN[:\s]*(\d{1,2}\.?\d{3}\.?\d{3}-?[0-9K])/i,
      /RUT[:\s]*(\d{1,2}\.?\d{3}\.?\d{3}-?[0-9K])/i,
      /(\d{1,2}\.?\d{3}\.?\d{3}-[0-9K])/,
    ];
    for (const pat of runPatterns) {
      const m = text.match(pat);
      if (m) {
        const v = CL.validate(m[1]);
        if (v.valid) { doc_number = v.normalized; break; }
      }
    }

    const isChile = /CHILE|REGISTRO CIVIL|REPÚBLICA DE CHILE/i.test(text);
    if (!isChile)    errors.push("El documento no parece ser una cédula chilena");
    if (!doc_number) errors.push("No se pudo extraer RUN válido");

    // TODO: extract full_name, date_of_birth, sex, expiry_date

    return {
      valid:         errors.length === 0 && !!doc_number,
      doc_number,
      document_type: "cedula_identidad",
      country:       "CL",
      errors,
      raw_ocr:       ocrText,
    };
  },

  validate(docNumber: string): NumberValidation {
    const clean = docNumber.replace(/[.\s]/g, "").toUpperCase();
    const m = clean.match(/^(\d{7,8})-?([0-9K])$/);
    if (!m) return { valid: false, error: "Formato inválido. Debe ser XXXXXXXX-Y (dígito verificador 0-9 o K)" };

    const expected = runCheckDigit(m[1]);
    if (m[2] !== expected) return { valid: false, error: `Dígito verificador incorrecto (esperado: ${expected}, encontrado: ${m[2]})` };

    return { valid: true, normalized: `${m[1]}-${m[2]}` };
  },
};

export default CL;
