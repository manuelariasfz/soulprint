/**
 * Validador de Cédula de Ciudadanía colombiana
 *
 * La cédula colombiana tiene:
 * - 5 a 10 dígitos numéricos
 * - Emitida por Registraduría Nacional del Estado Civil
 * - Serie por región/año: rangos conocidos
 * - Dígito de verificación implícito en la secuencia
 */

export interface DocumentValidationResult {
  valid:          boolean;
  cedula_number?: string;
  nombre?:        string;
  fecha_nacimiento?: string;
  sexo?:          "M" | "F";
  errors:         string[];
  raw_ocr?:       string;
}

// ── Rangos válidos de cédulas colombianas ─────────────────────────────────────
// Fuente: Registraduría Nacional — rangos históricos por décadas
const CEDULA_RANGES: [number, number][] = [
  [1_000_000,   9_999_999],    // primeras series (7 dígitos)
  [10_000_000,  99_999_999],   // series modernas (8 dígitos)
  [100_000_000, 999_999_999],  // series recientes (9 dígitos)
  [1_000_000_000, 1_299_999_999], // series nuevas (10 dígitos)
];

export function validateCedulaNumber(cedula: string): {
  valid: boolean;
  error?: string;
} {
  // Limpiar espacios y guiones
  const clean = cedula.replace(/[\s\-\.]/g, "");

  // Solo dígitos
  if (!/^\d+$/.test(clean)) {
    return { valid: false, error: "La cédula solo debe contener números" };
  }

  const num = parseInt(clean, 10);

  // Longitud válida: 5-10 dígitos
  if (clean.length < 5 || clean.length > 10) {
    return { valid: false, error: `Longitud inválida: ${clean.length} dígitos (debe ser 5-10)` };
  }

  // No puede ser todo el mismo dígito (111111111, 000000000, etc.)
  if (/^(\d)\1+$/.test(clean)) {
    return { valid: false, error: "Número de cédula inválido (dígitos repetidos)" };
  }

  // Verificar que esté en un rango conocido (para cédulas de 7+ dígitos)
  if (clean.length >= 7) {
    const inRange = CEDULA_RANGES.some(([min, max]) => num >= min && num <= max);
    if (!inRange) {
      return { valid: false, error: "Número fuera de rangos válidos de Registraduría" };
    }
  }

  return { valid: true };
}

// ── Parser de texto OCR de cédula colombiana ──────────────────────────────────

export function parseCedulaOCR(ocrText: string): DocumentValidationResult {
  const errors: string[] = [];
  const text = ocrText.toUpperCase().replace(/\s+/g, " ").trim();

  // ── Extraer número de cédula ───────────────────────────────────────────────
  // Patrones en cédulas colombianas:
  // "C.C. 12.345.678" | "CC 12345678" | "1.234.567.890"
  let cedula_number: string | undefined;

  const cedulaPatterns = [
    /C\.?C\.?\s*([0-9][0-9.\s]{4,12})/,           // "CC 12.345.678"
    /CÉDULA[^0-9]*([0-9][0-9.\s]{4,12})/,           // "CÉDULA DE CIUDADANÍA 12345678"
    /CIUDADANÍA[^0-9]*([0-9][0-9.\s]{4,12})/,
    /N[UÚ]MERO[^0-9]*([0-9][0-9.\s]{4,12})/,
    /\b(\d{1,3}(?:\.\d{3}){1,3})\b/,               // "12.345.678" formato con puntos
    /\b(\d{7,10})\b/,                               // número largo sin formato
  ];

  for (const pattern of cedulaPatterns) {
    const m = text.match(pattern);
    if (m) {
      const candidate = m[1].replace(/[\.\s]/g, "");
      const validation = validateCedulaNumber(candidate);
      if (validation.valid) {
        cedula_number = candidate;
        break;
      }
    }
  }

  if (!cedula_number) {
    errors.push("No se pudo extraer un número de cédula válido del documento");
  }

  // ── Extraer nombre ─────────────────────────────────────────────────────────
  let nombre: string | undefined;

  // La cédula tiene: apellidos en una línea, nombres en la siguiente
  const nombrePatterns = [
    /APELLIDOS[:\s]+([A-ZÁÉÍÓÚÑ\s]+)\s*NOMBRES?[:\s]+([A-ZÁÉÍÓÚÑ\s]+)/,
    /NOMBRES?[:\s]+([A-ZÁÉÍÓÚÑ\s]{5,50})/,
  ];

  for (const pattern of nombrePatterns) {
    const m = text.match(pattern);
    if (m) {
      nombre = m[2] ? `${m[2].trim()} ${m[1].trim()}` : m[1].trim();
      nombre = nombre.replace(/\s+/g, " ").trim();
      break;
    }
  }

  // ── Extraer fecha de nacimiento ────────────────────────────────────────────
  let fecha_nacimiento: string | undefined;

  const fechaPatterns = [
    /FECHA\s+(?:DE\s+)?NACIMIENTO[:\s]+(\d{1,2}[\-\/]\d{1,2}[\-\/]\d{4})/,
    /NACIMIENTO[:\s]+(\d{1,2}[\-\/]\d{1,2}[\-\/]\d{4})/,
    /(\d{2}[\-\/]\d{2}[\-\/]\d{4})/,   // DD/MM/YYYY o DD-MM-YYYY
    /(\d{4}[\-\/]\d{2}[\-\/]\d{2})/,   // YYYY-MM-DD
  ];

  for (const pattern of fechaPatterns) {
    const m = text.match(pattern);
    if (m) {
      fecha_nacimiento = normalizeFecha(m[1]);
      break;
    }
  }

  // ── Extraer sexo ───────────────────────────────────────────────────────────
  let sexo: "M" | "F" | undefined;

  if (/\bSEXO\s*[:\s]\s*M\b/.test(text) || /\bMASCULINO\b/.test(text)) sexo = "M";
  if (/\bSEXO\s*[:\s]\s*F\b/.test(text) || /\bFEMENINO\b/.test(text))  sexo = "F";

  // ── Verificar que es una cédula colombiana ─────────────────────────────────
  const esCedula = /COLOMBIA|REGISTRADURÍA|REPÚBLICA|CIUDADANÍA|C\.C\.|CÉDULA/i.test(text);
  if (!esCedula) {
    errors.push("El documento no parece ser una cédula colombiana");
  }

  return {
    valid:           errors.length === 0 && !!cedula_number,
    cedula_number,
    nombre,
    fecha_nacimiento,
    sexo,
    errors,
    raw_ocr:         ocrText,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function normalizeFecha(fecha: string): string {
  // Normalizar a YYYY-MM-DD
  const clean = fecha.replace(/\//g, "-");
  const parts = clean.split("-");

  if (parts.length !== 3) return fecha;

  if (parts[0].length === 4) {
    // YYYY-MM-DD
    return clean;
  } else {
    // DD-MM-YYYY → YYYY-MM-DD
    const [d, m, y] = parts;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
}
