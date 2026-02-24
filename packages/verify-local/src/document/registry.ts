/**
 * Soulprint Country Verifier Registry
 * =====================================
 * Auto-loads all country verifiers from the countries/ directory.
 * Adding a new country = dropping a file → zero registry changes needed.
 *
 * Usage:
 *   import { getVerifier, listCountries } from "./registry.js";
 *   const verifier = getVerifier("CO");          // by country code
 *   const verifier = await detectVerifier(text); // auto-detect from OCR
 */

import type { CountryVerifier } from "./verifier.interface.js";

// ── Static registry (tree-shakeable, no dynamic require) ──────────────────────
// Each import is a CountryVerifier default export.
// To add a country: just add one line here + create the file.

import CO from "./countries/CO.js";
import MX from "./countries/MX.js";
import AR from "./countries/AR.js";
import VE from "./countries/VE.js";
import PE from "./countries/PE.js";
import BR from "./countries/BR.js";
import CL from "./countries/CL.js";

const VERIFIERS: CountryVerifier[] = [
  CO, MX, AR, VE, PE, BR, CL,
];

// Build lookup map
const REGISTRY = new Map<string, CountryVerifier>();
for (const v of VERIFIERS) {
  REGISTRY.set(v.countryCode.toUpperCase(), v);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get a verifier by ISO 3166-1 alpha-2 country code.
 * Returns undefined if the country isn't supported yet.
 */
export function getVerifier(countryCode: string): CountryVerifier | undefined {
  return REGISTRY.get(countryCode.toUpperCase());
}

/**
 * List all supported countries.
 */
export function listCountries(): Array<{
  code: string;
  name: string;
  documentTypes: string[];
  hasMRZ: boolean;
}> {
  return VERIFIERS.map(v => ({
    code:          v.countryCode,
    name:          v.countryName,
    documentTypes: v.documentTypes,
    hasMRZ:        typeof v.parseMRZ === "function",
  }));
}

/**
 * Auto-detect the country from OCR text.
 * Tries each registered verifier's parse() and returns the first that succeeds.
 * Falls back to the verifier with the highest confidence (fewest errors).
 *
 * Pass countryHint for faster resolution (e.g. from phone locale or user input).
 */
export function detectVerifier(
  ocrText:     string,
  countryHint?: string
): CountryVerifier | undefined {
  // Fast path: hint provided
  if (countryHint) {
    const v = getVerifier(countryHint);
    if (v) return v;
  }

  // Try all verifiers, pick the one with fewest errors
  let best: CountryVerifier | undefined;
  let bestErrors = Infinity;

  for (const v of VERIFIERS) {
    try {
      const result = v.parse(ocrText);
      const errs   = result.errors.length;
      if (result.valid) return v;         // perfect match — return immediately
      if (errs < bestErrors) { best = v; bestErrors = errs; }
    } catch {
      // skip
    }
  }

  return best;
}

/**
 * Total number of registered countries.
 */
export function countryCount(): number {
  return REGISTRY.size;
}
