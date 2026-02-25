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

  // ── Verificar que es un documento colombiano válido ───────────────────────
  // Acepta: cédula, licencia de conducción y otros documentos con número CC
  const esDocumentoColombia = /COLOMBIA|REGISTRADURÍA|REPÚBLICA|CIUDADANÍA|C\.C\.|CÉDULA|LICENCIA|CONDUCCIÓN|CONDUCCION|MOVILIDAD|BOGOTA|MEDELLIN|TRANSPORTE/i.test(text);
  const tieneDatosValidos   = !!cedula_number && !!nombre && !!fecha_nacimiento;

  if (!esDocumentoColombia && !tieneDatosValidos) {
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

// ── ICAO 9303 check digit ──────────────────────────────────────────────────────
/**
 * Calcula el dígito de control ICAO 9303 (estándar internacional MRTD).
 * Algoritmo: suma ponderada con pesos 7, 3, 1 (cíclicos) sobre cada carácter.
 *
 * Tabla de valores:
 *   '0'-'9' → 0-9
 *   'A'-'Z' → 10-35
 *   '<'     → 0
 *
 * Resultado: suma mod 10
 *
 * Referencia: ICAO Doc 9303 Part 3, §4.9
 */
export function icaoCheckDigit(field: string): number {
  const WEIGHTS = [7, 3, 1];

  const charValue = (ch: string): number => {
    if (ch >= "0" && ch <= "9") return parseInt(ch, 10);
    if (ch >= "A" && ch <= "Z") return ch.charCodeAt(0) - 65 + 10; // A=10, B=11...
    return 0; // '<' y cualquier relleno = 0
  };

  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    sum += charValue(field[i]) * WEIGHTS[i % 3];
  }

  return sum % 10;
}

/**
 * Verifica si el dígito de control ICAO de un campo es correcto.
 * `fieldWithCheck`: el campo + el dígito de control como último carácter.
 */
export function verifyCheckDigit(
  field:    string,
  expected: string | number
): { valid: boolean; computed: number; expected: number } {
  const computed  = icaoCheckDigit(field);
  const exp       = typeof expected === "string" ? parseInt(expected, 10) : expected;
  return { valid: computed === exp, computed, expected: exp };
}


// ── MRZ TD1 parser (reverso cédula digital colombiana) ────────────────────────
/**
 * Parsea el MRZ TD1 del reverso de la cédula colombiana digital.
 * Formato: 3 líneas de 30 caracteres cada una.
 *
 * Línea 1 (TD1): IDCOL<NUMDOC<CHECK<<<<<<<<<<<<<<<<
 *   - [0-1]   = tipo doc "ID"
 *   - [2-4]   = país emisor "COL"
 *   - [5-14]  = número documento (cédula, 9 chars relleno <)
 *   - [14]    = check digit del número de documento
 *
 * Línea 2: DDMMYYCSEXEXPIRYNATCHECKNUMDOC<CHECK
 *   - [0-5]   = fecha nacimiento YYMMDD
 *   - [6]     = check digit fecha nac
 *   - [7]     = sexo M/F
 *   - [8-13]  = fecha expiración YYMMDD
 *   - [14]    = check digit expiración
 *   - [15-17] = código país (COL)
 *   - [18-28] = número documento (cédula)
 *   - [29]    = check digit compuesto
 *
 * Línea 3: APELLIDOS<<NOMBRES<<<...
 *
 * Todos los check digits se verifican con ICAO 9303 (peso 7/3/1 mod 10).
 */
export function parseMRZ(mrzText: string): DocumentValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Limpiar y encontrar líneas MRZ
  const allLines = mrzText
    .split("\n")
    .map(l => l.replace(/[^A-Z0-9<]/gi, "").toUpperCase())
    .filter(l => l.length >= 10);

  const lines = allLines.filter(l => l.length >= 28);

  if (lines.length < 2) {
    return { valid: false, errors: ["MRZ incompleto — se necesitan al menos 2 líneas"] };
  }

  // ── Línea 1: número de documento + check digit ───────────────────────────
  const line1 = lines[0];
  let docNumFromLine1: string | undefined;

  if (line1.length >= 15) {
    const docRaw   = line1.slice(5, 14);   // posiciones 5-13 (9 chars)
    const checkCh  = line1[14];            // posición 14 = check digit

    const checkResult = verifyCheckDigit(docRaw, checkCh);

    if (!checkResult.valid) {
      errors.push(
        `MRZ línea 1: check digit inválido en número de documento ` +
        `(calculado=${checkResult.computed}, encontrado=${checkResult.expected})`
      );
    } else {
      docNumFromLine1 = docRaw.replace(/</g, "").replace(/^0+/, "");
    }
  }

  // ── Línea 2: fecha nacimiento + sexo + expiración + check digits ─────────
  const line2 = lines.find(l => /^\d{6}[0-9<][MF<]/.test(l));
  if (!line2) {
    return { valid: false, errors: ["No se encontró línea MRZ con datos biográficos"] };
  }

  const yy  = line2.slice(0, 2);
  const mm  = line2.slice(2, 4);
  const dd  = line2.slice(4, 6);
  const sex = line2[7] as "M" | "F";

  // Verificar check digit de fecha de nacimiento (posición 6)
  const dobField    = line2.slice(0, 6);
  const dobCheck    = line2[6];
  const dobVerify   = verifyCheckDigit(dobField, dobCheck);
  if (!dobVerify.valid && dobCheck !== "<") {
    errors.push(
      `MRZ: check digit inválido en fecha de nacimiento ` +
      `(calculado=${dobVerify.computed}, encontrado=${dobVerify.expected})`
    );
  }

  // Verificar check digit de fecha de expiración (posición 14)
  const expField    = line2.slice(8, 14);
  const expCheck    = line2[14];
  const expVerify   = verifyCheckDigit(expField, expCheck);
  if (!expVerify.valid && expCheck !== "<") {
    warnings.push(
      `MRZ: check digit de expiración no coincide ` +
      `(calculado=${expVerify.computed}, encontrado=${expVerify.expected})`
    );
  }

  // Inferir siglo: YY > 24 → 19xx, YY <= 24 → 20xx
  const century          = parseInt(yy) > 24 ? "19" : "20";
  const fecha_nacimiento = `${century}${yy}-${mm}-${dd}`;

  // ── Número de cédula: prioridad línea 1 → fallback línea 2 pos 18-27 ────
  let docNum: string;
  if (docNumFromLine1) {
    docNum = docNumFromLine1;
  } else {
    const raw = line2.slice(18, 29).replace(/</g, "").trim();
    docNum    = raw.replace(/^0+/, "");
  }

  const numValidation = validateCedulaNumber(docNum);
  if (!numValidation.valid) {
    errors.push(`Número en MRZ inválido: ${numValidation.error}`);
  }

  // ── Línea 3: nombre ───────────────────────────────────────────────────────
  const line3 = allLines.find(l =>
    l.includes("<<") &&
    !/^\d{6}/.test(l) &&
    /^[A-Z]{3,}<</.test(l)
  );
  let nombre: string | undefined;
  if (line3) {
    const parts    = line3.split("<<");
    const apellido = parts[0]?.replace(/</g, " ").trim();
    const nombres  = parts.slice(1).join(" ").replace(/</g, " ").replace(/\s+/g, " ").trim();
    nombre         = nombres && apellido
      ? `${nombres} ${apellido}`.trim()
      : (apellido || nombres);
  }

  return {
    valid:            errors.length === 0 && numValidation.valid,
    cedula_number:    numValidation.valid ? docNum : undefined,
    nombre,
    fecha_nacimiento,
    sexo:             sex === "M" || sex === "F" ? sex : undefined,
    errors,
    raw_ocr:          mrzText,
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
