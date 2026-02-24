/**
 * 🇧🇷 Brazil — RG (Registro Geral) & CPF
 * ==========================================
 * Supported documents:
 *   - RG (Registro Geral) — state-issued, format varies by state
 *   - CPF (Cadastro de Pessoas Físicas) — federal tax ID, 11 digits
 *   - CNH (Carteira Nacional de Habilitação) — driver's license
 *
 * Issuing authorities: Secretarias de Segurança Pública (RG), Receita Federal (CPF)
 * CPF format: XXX.XXX.XXX-YY (11 digits, last 2 = check digits)
 * CPF check: mod 11 algorithm (distinct from ICAO)
 *
 * Resources:
 *   - CPF: https://www.gov.br/receitafederal/pt-br
 *   - RG: varies by state
 *
 * 👋 CONTRIBUTOR: implement parse(), full CPF check digit validation
 * Status: PARTIAL — CPF validation done, OCR parser is stub
 */

import type { CountryVerifier, DocumentResult, NumberValidation } from "../verifier.interface.js";

/**
 * CPF check digit validation — mod 11 algorithm (Brazilian Receita Federal)
 * Different from ICAO! Two check digits, each computed with decreasing weights.
 */
function validateCPF(cpf: string): boolean {
  const clean = cpf.replace(/[.\-\s]/g, "");
  if (clean.length !== 11 || /^(\d)\1+$/.test(clean)) return false;

  const calcDigit = (digits: string, len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += parseInt(digits[i]) * (len + 1 - i);
    const rem = (sum * 10) % 11;
    return rem === 10 ? 0 : rem;
  };

  const d1 = calcDigit(clean, 9);
  const d2 = calcDigit(clean, 10);
  return parseInt(clean[9]) === d1 && parseInt(clean[10]) === d2;
}

const BR: CountryVerifier = {
  countryCode:   "BR",
  countryName:   "Brazil",
  documentTypes: ["rg", "cpf", "cnh"],

  parse(ocrText: string): DocumentResult {
    const errors: string[] = [];
    const text = ocrText.toUpperCase().replace(/\s+/g, " ").trim();

    // Try CPF first (more reliable pattern)
    let doc_number: string | undefined;
    let document_type = "rg";

    const cpfMatch = text.match(/CPF[:\s]*([0-9]{3}\.?[0-9]{3}\.?[0-9]{3}-?[0-9]{2})/);
    if (cpfMatch) {
      const v = BR.validate(cpfMatch[1]);
      if (v.valid) { doc_number = v.normalized; document_type = "cpf"; }
    }

    // TODO: extract RG number, full_name, date_of_birth, sex
    // RG format varies by issuing state (SP: X.XXX.XXX-X, MG: XXXXXXXXX, etc.)

    const isBrazil = /BRASIL|BRAZIL|REPÚBLICA FEDERATIVA|FEDERATIVA DO BRASIL/i.test(text);
    if (!isBrazil)   errors.push("O documento não parece ser brasileiro");
    if (!doc_number) errors.push("Não foi possível extrair CPF ou RG válido");

    return {
      valid:         errors.length === 0 && !!doc_number,
      doc_number,
      document_type,
      country:       "BR",
      errors,
      raw_ocr:       ocrText,
    };
  },

  validate(docNumber: string): NumberValidation {
    const clean = docNumber.replace(/[.\-\s]/g, "");

    // CPF: 11 digits
    if (/^\d{11}$/.test(clean)) {
      if (!validateCPF(clean)) return { valid: false, error: "CPF inválido (dígitos verificadores incorretos)" };
      return { valid: true, normalized: clean };
    }

    // RG: 7-9 digits (state-dependent) — basic check only
    if (/^\d{7,9}$/.test(clean)) return { valid: true, normalized: clean };

    return { valid: false, error: "Não é um CPF (11 dígitos) nem RG válido (7-9 dígitos)" };
  },
};

export default BR;
