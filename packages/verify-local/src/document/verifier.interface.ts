/**
 * Soulprint Document Verifier Interface
 * ======================================
 * Every country verifier must implement this interface.
 *
 * To add a new country:
 *   1. Create packages/verify-local/src/document/countries/XX.ts
 *      (where XX = ISO 3166-1 alpha-2 country code, uppercase)
 *   2. Implement CountryVerifier
 *   3. Export a default instance
 *   4. Open a PR — that's it!
 *
 * See CONTRIBUTING.md → "Adding a Country" for full guide.
 */

// ── Result types ───────────────────────────────────────────────────────────────

export interface DocumentResult {
  /** Whether the document passed all validations */
  valid: boolean;

  /** Normalized document number (no dots, dashes, or spaces) */
  doc_number?: string;

  /** Full name — "NOMBRES APELLIDOS" order */
  full_name?: string;

  /** Date of birth — ISO 8601: YYYY-MM-DD */
  date_of_birth?: string;

  /** Legal sex as recorded on document */
  sex?: "M" | "F";

  /** Document expiry date — ISO 8601: YYYY-MM-DD */
  expiry_date?: string;

  /** Document type label (e.g. "cedula", "dni", "passport", "ine") */
  document_type?: string;

  /** ISO 3166-1 alpha-2 country code (filled by verifier) */
  country: string;

  /** Fatal errors — document is invalid if this array is non-empty */
  errors: string[];

  /** Non-fatal warnings — document may still be valid */
  warnings?: string[];

  /** Raw OCR text for debugging */
  raw_ocr?: string;
}

export interface NumberValidation {
  valid: boolean;
  error?: string;
  /** Normalized form (digits only, no formatting) */
  normalized?: string;
}

export interface ImageValidation {
  valid: boolean;
  error?: string;
}

// ── Main interface ─────────────────────────────────────────────────────────────

export interface CountryVerifier {
  // ── Identity ────────────────────────────────────────────────────────────────

  /** ISO 3166-1 alpha-2 uppercase (e.g. "CO", "MX", "AR") */
  readonly countryCode: string;

  /** Human-readable country name in English */
  readonly countryName: string;

  /** Document types this verifier handles */
  readonly documentTypes: string[];

  // ── Core methods (required) ──────────────────────────────────────────────────

  /**
   * Parse OCR text from a document image.
   * Input: raw text string from Tesseract (or similar).
   * Output: structured DocumentResult.
   */
  parse(ocrText: string): DocumentResult;

  /**
   * Validate a document number string.
   * Input: raw number (may have dots, dashes, spaces).
   * Output: validation result + normalized form.
   */
  validate(docNumber: string): NumberValidation;

  // ── Optional methods ─────────────────────────────────────────────────────────

  /**
   * Parse the MRZ zone (Machine Readable Zone) from a document.
   * Required for TD1/TD2/TD3 (ICAO 9303) documents.
   * Not needed for documents without MRZ (e.g. old-format IDs).
   */
  parseMRZ?(mrzText: string): DocumentResult;

  /**
   * Quick image-level validation before running full OCR.
   * Check aspect ratio, minimum resolution, orientation, etc.
   * Avoids loading Tesseract for obviously invalid images.
   */
  quickValidate?(imagePath: string): Promise<ImageValidation>;
}

// ── Registry entry (used internally) ──────────────────────────────────────────

export interface VerifierEntry {
  verifier:  CountryVerifier;
  module:    string;   // filename, e.g. "CO"
  loadedAt:  number;   // epoch ms
}
