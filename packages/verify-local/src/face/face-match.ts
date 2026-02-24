import { spawn }       from "node:child_process";
import { join }        from "node:path";
import { existsSync }  from "node:fs";
import { PROTOCOL }    from "soulprint-core";

export interface FaceMatchResult {
  match:       boolean;
  similarity:  number;       // 0.0 - 1.0
  embedding?:  number[];     // 512-dim vector para derivar nullifier
  liveness?:   boolean;      // detección de foto de foto
  errors:      string[];
}

export interface FaceMatchOptions {
  minSimilarity?: number;   // default PROTOCOL.FACE_SIM_DOC_SELFIE (0.35); use PROTOCOL.FACE_SIM_SELFIE_SELFIE (0.65) para re-verificación
  checkLiveness?: boolean;  // default false (requiere más proceso)
  verbose?:       boolean;
}

// Path al script Python que corre on-demand
const PYTHON_SCRIPT = join(__dirname, "face_match.py");

/**
 * Compara la cara de un selfie con la foto del documento de identidad.
 *
 * ARQUITECTURA ON-DEMAND:
 * - Lanza un subprocess Python con InsightFace
 * - InsightFace (~500MB) se carga SOLO durante esta llamada
 * - El proceso termina al final → memoria completamente liberada
 * - En reposo: 0MB de modelos ML en memoria
 *
 * @param selfiePhoto    Path a la foto selfie
 * @param documentPhoto  Path a la foto del documento (cédula)
 */
export async function matchFaceWithDocument(
  selfiePhoto:    string,
  documentPhoto:  string,
  opts: FaceMatchOptions = {}
): Promise<FaceMatchResult> {
  const minSim = opts.minSimilarity ?? PROTOCOL.FACE_SIM_DOC_SELFIE;

  // Verificar que existe el script Python
  if (!existsSync(PYTHON_SCRIPT)) {
    return {
      match:      false,
      similarity: 0,
      errors:     [`Script Python no encontrado: ${PYTHON_SCRIPT}. Ejecuta: soulprint install-deps`],
    };
  }

  // Verificar que Python e InsightFace están disponibles
  const pythonCheck = await checkPythonDeps();
  if (!pythonCheck.ok) {
    return {
      match:      false,
      similarity: 0,
      errors:     [pythonCheck.error!],
    };
  }

  return new Promise((resolve) => {
    const args = [
      PYTHON_SCRIPT,
      "--selfie",   selfiePhoto,
      "--document", documentPhoto,
      "--min-sim",  String(minSim),
    ];

    if (opts.checkLiveness) args.push("--liveness");

    // Lanzar subprocess — muere solo cuando termina
    const proc = spawn("python3", args, {
      stdio: ["ignore", "pipe", opts.verbose ? "inherit" : "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (d: Buffer) => stdout += d.toString());
    if (!opts.verbose && proc.stderr) {
      proc.stderr.on("data", (d: Buffer) => stderr += d.toString());
    }

    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({
          match:      false,
          similarity: 0,
          errors:     [`Proceso de verificación falló (código ${code}): ${stderr.slice(0, 200)}`],
        });
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        resolve({
          match:      result.match ?? false,
          similarity: result.similarity ?? 0,
          embedding:  result.embedding,
          liveness:   result.liveness,
          errors:     result.errors ?? [],
        });
      } catch {
        resolve({
          match:      false,
          similarity: 0,
          errors:     ["Error parseando resultado de verificación facial"],
        });
      }
    });

    proc.on("error", (err) => {
      resolve({
        match:      false,
        similarity: 0,
        errors:     [`No se pudo lanzar Python: ${err.message}. Instala Python 3.8+`],
      });
    });
  });
}

// ── Verificar dependencias Python ─────────────────────────────────────────────

async function checkPythonDeps(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("python3", ["-c", "import insightface; import cv2; print('ok')"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => out += d.toString());
    proc.on("close", (code) => {
      if (code === 0 && out.includes("ok")) {
        resolve({ ok: true });
      } else {
        resolve({
          ok: false,
          error: "InsightFace no instalado. Ejecuta: pip install insightface opencv-python-headless",
        });
      }
    });
    proc.on("error", () => resolve({
      ok: false,
      error: "Python3 no encontrado. Instala Python 3.8+ para verificación facial.",
    }));
  });
}
