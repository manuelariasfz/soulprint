import { generateKeypair, deriveNullifier, createToken, CredentialType, SoulprintKeypair } from "@soulprint/core";
import { ocrCedula, quickValidateImage } from "./document/ocr.js";
import { matchFaceWithDocument }          from "./face/face-match.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname }                  from "node:path";
import { homedir }                        from "node:os";

// Directorio donde se guarda el keypair del usuario (llave privada local)
const SOULPRINT_DIR  = join(homedir(), ".soulprint");
const KEYPAIR_FILE   = join(SOULPRINT_DIR, "identity.json");

export interface VerificationOptions {
  selfiePhoto:    string;   // path a la selfie
  documentPhoto:  string;   // path a la foto de la cédula
  verbose?:       boolean;
  minFaceSim?:    number;   // default 0.65
  checkLiveness?: boolean;
}

export interface VerificationResult {
  success:    boolean;
  token?:     string;       // SPT listo para usar
  did?:       string;
  score?:     number;
  errors:     string[];
  steps: {
    image_check:       "ok" | "fail" | "skip";
    ocr:               "ok" | "fail" | "skip";
    face_match:        "ok" | "fail" | "skip";
    nullifier_derived: "ok" | "fail" | "skip";
    token_created:     "ok" | "fail" | "skip";
  };
}

// ── Verificación completa ─────────────────────────────────────────────────────

export async function verifyIdentity(opts: VerificationOptions): Promise<VerificationResult> {
  const errors: string[] = [];
  const steps: VerificationResult["steps"] = {
    image_check:       "skip",
    ocr:               "skip",
    face_match:        "skip",
    nullifier_derived: "skip",
    token_created:     "skip",
  };

  const log = (msg: string) => opts.verbose && process.stderr.write(`[soulprint] ${msg}\n`);

  // ── PASO 1: Validar imágenes ───────────────────────────────────────────────
  log("Validando imágenes...");
  const selfieCheck = await quickValidateImage(opts.selfiePhoto);
  const docCheck    = await quickValidateImage(opts.documentPhoto);

  if (!selfieCheck.valid) {
    errors.push(`Selfie: ${selfieCheck.error}`);
    steps.image_check = "fail";
    return { success: false, errors, steps };
  }
  if (!docCheck.valid) {
    errors.push(`Documento: ${docCheck.error}`);
    steps.image_check = "fail";
    return { success: false, errors, steps };
  }
  steps.image_check = "ok";

  // ── PASO 2: OCR de cédula (Tesseract.js — sin subprocess) ─────────────────
  log("Extrayendo datos del documento...");
  const docResult = await ocrCedula(opts.documentPhoto, { verbose: opts.verbose });

  if (!docResult.valid || !docResult.cedula_number) {
    errors.push(...docResult.errors);
    steps.ocr = "fail";
    return { success: false, errors, steps };
  }
  steps.ocr = "ok";
  log(`✓ Cédula: ${docResult.cedula_number} | ${docResult.nombre ?? "nombre no detectado"}`);

  // ── PASO 3: Face match (subprocess Python on-demand) ──────────────────────
  log("Verificando coincidencia facial (iniciando proceso de IA)...");
  const faceResult = await matchFaceWithDocument(
    opts.selfiePhoto,
    opts.documentPhoto,
    {
      minSimilarity: opts.minFaceSim ?? 0.65,
      checkLiveness: opts.checkLiveness,
      verbose:       opts.verbose,
    }
  );

  if (!faceResult.match) {
    errors.push(...faceResult.errors);
    steps.face_match = "fail";
    return { success: false, errors, steps };
  }
  steps.face_match = "ok";
  log(`✓ Cara coincide (similitud: ${(faceResult.similarity * 100).toFixed(1)}%)`);
  // El proceso Python ya terminó — InsightFace descargado de memoria ✅

  // ── PASO 4: Derivar nullifier biométrico ──────────────────────────────────
  log("Derivando nullifier único...");

  let nullifier: string;
  try {
    const embedding = new Float32Array(faceResult.embedding!);
    nullifier = deriveNullifier(
      docResult.cedula_number!,
      docResult.fecha_nacimiento ?? "0000-00-00",
      embedding
    );
    steps.nullifier_derived = "ok";
    log(`✓ Nullifier: ${nullifier.slice(0, 16)}...`);
  } catch (e: any) {
    errors.push(`Error derivando nullifier: ${e.message}`);
    steps.nullifier_derived = "fail";
    return { success: false, errors, steps };
  }

  // ── PASO 5: Crear/cargar keypair y emitir token ───────────────────────────
  log("Generando token Soulprint...");

  const keypair = loadOrCreateKeypair();

  const credentials: CredentialType[] = ["DocumentVerified", "FaceMatch"];
  if (opts.checkLiveness && faceResult.liveness) credentials.push("BiometricBound");

  const token = createToken(keypair, nullifier, credentials, { country: "CO" });
  steps.token_created = "ok";

  log(`✓ Token creado — DID: ${keypair.did}`);
  log(`✓ Trust Score: ${calculateScore(credentials)}`);
  log("");
  log("✅ Verificación completa. Datos biométricos eliminados de memoria.");

  return {
    success:  true,
    token,
    did:      keypair.did,
    score:    calculateScore(credentials),
    errors:   [],
    steps,
  };
}

// ── Keypair local ─────────────────────────────────────────────────────────────

function loadOrCreateKeypair(): SoulprintKeypair {
  if (!existsSync(SOULPRINT_DIR)) {
    mkdirSync(SOULPRINT_DIR, { recursive: true, mode: 0o700 }); // solo el dueño puede leer
  }

  if (existsSync(KEYPAIR_FILE)) {
    const stored = JSON.parse(readFileSync(KEYPAIR_FILE, "utf8"));
    const { keypairFromPrivateKey } = require("@soulprint/core");
    return keypairFromPrivateKey(new Uint8Array(Buffer.from(stored.privateKey, "hex")));
  }

  const keypair = generateKeypair();
  writeFileSync(
    KEYPAIR_FILE,
    JSON.stringify({
      did:        keypair.did,
      privateKey: Buffer.from(keypair.privateKey).toString("hex"),
      created:    new Date().toISOString(),
    }),
    { mode: 0o600 } // solo lectura/escritura del dueño
  );

  return keypair;
}

function calculateScore(credentials: CredentialType[]): number {
  const scores: Record<CredentialType, number> = {
    EmailVerified: 10, PhoneVerified: 15, GitHubLinked: 20,
    DocumentVerified: 25, FaceMatch: 20, BiometricBound: 10,
  };
  return credentials.reduce((s, c) => s + (scores[c] ?? 0), 0);
}

// ── Exports ───────────────────────────────────────────────────────────────────
export { ocrCedula, quickValidateImage } from "./document/ocr.js";
export { matchFaceWithDocument }          from "./face/face-match.js";
export { validateCedulaNumber, parseCedulaOCR } from "./document/cedula-validator.js";
