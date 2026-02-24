/**
 * 🇨🇴 Colombia — Cédula de Ciudadanía & Cédula de Extranjería
 * ================================================================
 * Supported documents:
 *   - Cédula de Ciudadanía (CC) — TD1 format, MRZ on back
 *   - Cédula de Extranjería (CE) — for foreign residents
 *
 * Issuing authority: Registraduría Nacional del Estado Civil
 * Format: 5–10 numeric digits
 * MRZ: TD1 (3 lines × 30 chars), ICAO 9303
 *
 * Contributor: @manuelariasfz
 */

import type { CountryVerifier, DocumentResult, NumberValidation, ImageValidation } from "../verifier.interface.js";
import { validateCedulaNumber, parseCedulaOCR, parseMRZ as parseCedulaMRZ } from "../cedula-validator.js";

const CO: CountryVerifier = {
  countryCode:   "CO",
  countryName:   "Colombia",
  documentTypes: ["cedula", "cedula_extranjeria"],

  parse(ocrText: string): DocumentResult {
    const r = parseCedulaOCR(ocrText);
    return {
      valid:          r.valid,
      doc_number:     r.cedula_number,
      full_name:      r.nombre,
      date_of_birth:  r.fecha_nacimiento,
      sex:            r.sexo,
      document_type:  "cedula",
      country:        "CO",
      errors:         r.errors,
      raw_ocr:        r.raw_ocr,
    };
  },

  validate(docNumber: string): NumberValidation {
    const r = validateCedulaNumber(docNumber);
    if (!r.valid) return { valid: false, error: r.error };
    const normalized = docNumber.replace(/[\s\-\.]/g, "");
    return { valid: true, normalized };
  },

  parseMRZ(mrzText: string): DocumentResult {
    const r = parseCedulaMRZ(mrzText);
    return {
      valid:          r.valid,
      doc_number:     r.cedula_number,
      full_name:      r.nombre,
      date_of_birth:  r.fecha_nacimiento,
      sex:            r.sexo,
      document_type:  "cedula",
      country:        "CO",
      errors:         r.errors,
      raw_ocr:        r.raw_ocr,
    };
  },

  async quickValidate(imagePath: string): Promise<ImageValidation> {
    try {
      const sharp = (await import("sharp")).default;
      const meta  = await sharp(imagePath).metadata();
      if (!meta.width || !meta.height) return { valid: false, error: "No se pudo leer dimensiones" };

      const ratio      = meta.width / meta.height;
      const isLandscape = meta.width > meta.height;
      if (!isLandscape) return { valid: false, error: "La cédula debe estar en horizontal" };
      if (ratio < 1.2 || ratio > 2.0) return { valid: false, error: `Proporción inusual (${ratio.toFixed(2)}) — fotografia solo la cédula` };
      if (meta.width < 400 || meta.height < 250) return { valid: false, error: "Imagen muy pequeña — usa al menos 400×250px" };

      return { valid: true };
    } catch (e: any) {
      return { valid: false, error: `Error leyendo imagen: ${e.message}` };
    }
  },
};

export default CO;
