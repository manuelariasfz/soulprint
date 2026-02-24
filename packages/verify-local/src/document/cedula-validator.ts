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
    /NUIP\s*([0-9][0-9.\s]{6,14})/,                // "NUIP1.234.567.890" — primero
    /C\.?C\.?\s*([0-9][0-9.\s]{4,12})/,             // "CC 12.345.678"
    /CÉDULA[^0-9]*([0-9][0-9.\s]{4,12})/,           // "CÉDULA DE CIUDADANÍA 12345678"
    /CIUDADANÍA[^0-9]*([0-9][0-9.\s]{4,12})/,
    /N[UÚ]MERO[^0-9]*([0-9][0-9.\s]{4,12})/,
    /(?<![0-9])(\d{1,3}(?:\.\d{3}){2,3})(?![0-9])/, // "1.234.567.890" con puntos
    /(?<![0-9])(\d{7,10})(?![0-9])/,                 // número largo sin formato
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

// ── MRZ TD1 parser (reverso cédula digital colombiana) ────────────────────────
/**
 * Parsea el MRZ TD1 del reverso de la cédula colombiana digital.
 * Formato: 3 líneas de 30 caracteres cada una.
 *
 * Línea 2: DDMMYYCSEXEXPIRYNATCHECKNUMDOC<CHECK
 *   - [0-5]   = fecha nacimiento YYMMDD
 *   - [6]     = dígito verificador
 *   - [7]     = sexo M/F
 *   - [8-13]  = fecha expiración YYMMDD
 *   - [14]    = dígito verificador
 *   - [15-17] = código país (COL)
 *   - [18-28] = número documento (cédula)
 *
 * Línea 3: APELLIDOS<<NOMBRES<<<...
 */
export function parseMRZ(mrzText: string): DocumentValidationResult {
  const errors: string[] = [];

  // Limpiar y encontrar líneas MRZ
  const allLines = mrzText
    .split("\n")
    .map(l => l.replace(/[^A-Z0-9<]/gi, "").toUpperCase())
    .filter(l => l.length >= 10);

  const lines = allLines.filter(l => l.length >= 28);

  if (lines.length < 2) {
    return { valid: false, errors: ["MRZ incompleto — se necesitan al menos 2 líneas"] };
  }

  // Línea 2: datos biográficos
  const line2 = lines.find(l => /^\d{6}[0-9<][MF<]/.test(l));
  if (!line2) {
    return { valid: false, errors: ["No se encontró línea MRZ con datos biográficos"] };
  }

  const yy   = line2.slice(0, 2);
  const mm   = line2.slice(2, 4);
  const dd   = line2.slice(4, 6);
  const sex  = line2[7] as "M" | "F";

  // Inferir siglo (si YY > 24 → 19xx, si <= 24 → 20xx)
  const century = parseInt(yy) > 24 ? "19" : "20";
  const fecha_nacimiento = `${century}${yy}-${mm}-${dd}`;

  // Número de cédula: aparece en línea 2 posición 18-27 (o en línea 1)
  const docNumRaw = line2.slice(18, 29).replace(/</g, "").trim();
  const docNum    = docNumRaw.replace(/^0+/, ""); // quitar ceros a la izquierda

  const numValidation = validateCedulaNumber(docNum);

  // Línea 3: nombre — buscar en TODAS las líneas (puede ser más corta)
  const line3 = allLines.find(l =>
    l.includes("<<") &&
    !/^\d{6}/.test(l) &&
    /^[A-Z]{3,}<</.test(l)
  );
  let nombre: string | undefined;
  if (line3) {
    const parts = line3.split("<<");
    const apellido = parts[0]?.replace(/</g, " ").trim();
    const nombres  = parts.slice(1).join(" ").replace(/</g, " ").replace(/\s+/g," ").trim();
    nombre = nombres && apellido ? `${nombres} ${apellido}`.trim() : (apellido || nombres);
  }

  if (!numValidation.valid) {
    errors.push(`Número en MRZ inválido: ${numValidation.error}`);
  }

  return {
    valid:           errors.length === 0,
    cedula_number:   numValidation.valid ? docNum : undefined,
    nombre,
    fecha_nacimiento,
    sexo:            sex === "M" || sex === "F" ? sex : undefined,
    errors,
    raw_ocr:         mrzText,
  };
}



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
