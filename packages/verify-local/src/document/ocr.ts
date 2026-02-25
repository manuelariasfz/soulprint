import Tesseract from "tesseract.js";
import { parseCedulaOCR, DocumentValidationResult } from "./cedula-validator.js";

export interface OCROptions {
  lang?:    string;   // default "spa" (español)
  verbose?: boolean;
}

/**
 * Extrae y valida datos de una cédula colombiana desde una imagen.
 *
 * On-demand: Tesseract.js carga el worker solo cuando se llama,
 * y se termina al final. No hay proceso persistente.
 */
export async function ocrCedula(
  imagePath: string,
  opts: OCROptions = {}
): Promise<DocumentValidationResult> {
  const lang = opts.lang ?? "spa";

  // Tesseract carga on-demand, se termina después de extraer
  const tesseractOpts: any = {};
  if (opts.verbose) {
    tesseractOpts.logger = (m: any) =>
      process.stderr.write(`[OCR] ${m.status} ${Math.round((m.progress ?? 0) * 100)}%\r`);
  } else {
    tesseractOpts.logger = () => {};  // silencioso — no undefined
  }

  const { data: { text } } = await Tesseract.recognize(
    imagePath,
    lang,
    tesseractOpts
  );

  if (opts.verbose) process.stderr.write("\n");

  return parseCedulaOCR(text);
}

/**
 * Valida que la imagen parece ser una cédula antes de hacer OCR completo.
 * Revisión superficial de dimensiones y tamaño — no carga Tesseract.
 */
export async function quickValidateImage(imagePath: string, opts: { requireLandscape?: boolean } = {}): Promise<{
  valid: boolean;
  error?: string;
}> {
  const requireLandscape = opts.requireLandscape ?? true;
  try {
    // Dynamic import de sharp para no cargar si no es necesario
    const sharp = (await import("sharp")).default;
    const meta  = await sharp(imagePath).metadata();

    if (!meta.width || !meta.height) {
      return { valid: false, error: "No se pudo leer las dimensiones de la imagen" };
    }

    // Cédula colombiana: proporción ~1.59:1 (85.6mm × 53.98mm, formato ID-1 ISO 7810)
    const ratio = meta.width / meta.height;
    const isLandscape = meta.width > meta.height;

    if (requireLandscape && !isLandscape) {
      return { valid: false, error: "La imagen debe estar en horizontal (la cédula es apaisada)" };
    }

    if (requireLandscape && (ratio < 0.9 || ratio > 2.5)) {
      return { valid: false, error: `Proporción de imagen inusual (${ratio.toFixed(2)}). Asegúrate de fotografiar el documento completo` };
    }

    // Mínimo 400x250 para OCR confiable
    if (meta.width < 400 || meta.height < 250) {
      return { valid: false, error: "Imagen muy pequeña. Usa al menos 400×250 píxeles" };
    }

    return { valid: true };
  } catch (e: any) {
    return { valid: false, error: `Error leyendo imagen: ${e.message}` };
  }
}
