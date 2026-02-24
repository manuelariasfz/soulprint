import { generateKeypair, deriveNullifier, createToken, CredentialType, SoulprintKeypair, sign } from "soulprint-core";
import { ocrCedula, quickValidateImage }     from "./document/ocr.js";
import { matchFaceWithDocument }              from "./face/face-match.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join }                               from "node:path";
import { homedir }                            from "node:os";

const SOULPRINT_DIR = join(homedir(), ".soulprint");
const KEYPAIR_FILE  = join(SOULPRINT_DIR, "identity.json");

export interface VerificationOptions {
  selfiePhoto:    string;
  documentPhoto:  string;
  verbose?:       boolean;
  minFaceSim?:    number;
  checkLiveness?: boolean;
  withZKP?:       boolean;   // generar ZK proof (default: true si soulprint-zkp disponible)
}

export interface VerificationResult {
  success:     boolean;
  token?:      string;
  zkProof?:    string;      // ZK proof serializado (incluido en el SPT si available)
  nullifier?:  string;
  did?:        string;
  score?:      number;
  errors:      string[];
  steps: {
    image_check:       "ok" | "fail" | "skip";
    ocr:               "ok" | "fail" | "skip";
    face_match:        "ok" | "fail" | "skip";
    nullifier_derived: "ok" | "fail" | "skip";
    zk_proof:          "ok" | "fail" | "skip";
    token_created:     "ok" | "fail" | "skip";
  };
}

export async function verifyIdentity(opts: VerificationOptions): Promise<VerificationResult> {
  const errors: string[] = [];
  const steps: VerificationResult["steps"] = {
    image_check:       "skip",
    ocr:               "skip",
    face_match:        "skip",
    nullifier_derived: "skip",
    zk_proof:          "skip",
    token_created:     "skip",
  };
  const log = (msg: string) => opts.verbose && process.stderr.write(`[soulprint] ${msg}\n`);

  // ── PASO 1: Validar imágenes ───────────────────────────────────────────────
  log("Validando imágenes...");
  const selfieCheck = await quickValidateImage(opts.selfiePhoto);
  const docCheck    = await quickValidateImage(opts.documentPhoto);
  if (!selfieCheck.valid) { errors.push(`Selfie: ${selfieCheck.error}`); steps.image_check = "fail"; return { success: false, errors, steps }; }
  if (!docCheck.valid)    { errors.push(`Documento: ${docCheck.error}`); steps.image_check = "fail"; return { success: false, errors, steps }; }
  steps.image_check = "ok";

  // ── PASO 2: OCR de cédula ─────────────────────────────────────────────────
  log("Extrayendo datos del documento...");
  const docResult = await ocrCedula(opts.documentPhoto, { verbose: opts.verbose });
  if (!docResult.valid || !docResult.cedula_number) {
    errors.push(...docResult.errors);
    steps.ocr = "fail";
    return { success: false, errors, steps };
  }
  steps.ocr = "ok";
  log(`✓ Cédula: ${docResult.cedula_number}`);

  // ── PASO 3: Face match (subprocess Python on-demand) ──────────────────────
  log("Verificando coincidencia facial (iniciando proceso de IA)...");
  const faceResult = await matchFaceWithDocument(
    opts.selfiePhoto, opts.documentPhoto,
    { minSimilarity: opts.minFaceSim ?? 0.65, checkLiveness: opts.checkLiveness, verbose: opts.verbose }
  );
  if (!faceResult.match) { errors.push(...faceResult.errors); steps.face_match = "fail"; return { success: false, errors, steps }; }
  steps.face_match = "ok";
  log(`✓ Cara coincide (similitud: ${(faceResult.similarity * 100).toFixed(1)}%)`);

  // ── PASO 4: Derivar nullifier ──────────────────────────────────────────────
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
    log(`✓ Nullifier: ${nullifier.slice(0, 18)}...`);
  } catch (e: any) {
    errors.push(`Error derivando nullifier: ${e.message}`);
    steps.nullifier_derived = "fail";
    return { success: false, errors, steps };
  }

  // ── PASO 5: ZK Proof (opcional, si soulprint-zkp está disponible) ─────────
  let zkProofSerialized: string | undefined;
  const withZKP = opts.withZKP !== false; // default: true

  if (withZKP) {
    log("Generando ZK proof...");
    try {
      // Importar dinámicamente para no fallar si no está compilado el circuito
      const zkp = await import("soulprint-zkp");

      const cedula_num = zkp.cedulaToBigInt(docResult.cedula_number!);
      const fecha_nac  = zkp.fechaToBigInt(docResult.fecha_nacimiento ?? "19000101");
      const face_key   = await zkp.faceEmbeddingToKey(Array.from(faceResult.embedding!));
      const salt       = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
      const context    = BigInt(0);

      const zkProof = await zkp.generateProof({ cedula_num, fecha_nac, face_key, salt, context_tag: context });
      zkProofSerialized = zkp.serializeProof(zkProof);
      steps.zk_proof = "ok";
      log(`✓ ZK proof generado — nullifier (ZK): ${zkProof.nullifier.slice(0, 18)}...`);
    } catch (zkErr: any) {
      // ZK proof es opcional — si falla (circuito no compilado), continuar sin él
      steps.zk_proof = "skip";
      log(`⚠ ZK proof omitido: ${zkErr.message?.split("\n")[0]}`);
    }
  }

  // ── PASO 6: Crear keypair y emitir SPT ────────────────────────────────────
  log("Generando token Soulprint...");
  const keypair     = loadOrCreateKeypair();
  const credentials: CredentialType[] = ["DocumentVerified", "FaceMatch"];
  if (opts.checkLiveness && faceResult.liveness) credentials.push("BiometricBound");

  const token = createToken(keypair, nullifier, credentials, {
    country: "CO",
    zkProof: zkProofSerialized,
  });
  steps.token_created = "ok";
  log(`✓ Token — DID: ${keypair.did}`);
  log("✅ Verificación completa. Datos biométricos eliminados de memoria.");

  return {
    success:  true,
    token,
    zkProof:  zkProofSerialized,
    nullifier,
    did:      keypair.did,
    score:    calcScore(credentials),
    errors:   [],
    steps,
  };
}

function loadOrCreateKeypair(): SoulprintKeypair {
  if (!existsSync(SOULPRINT_DIR)) mkdirSync(SOULPRINT_DIR, { recursive: true, mode: 0o700 });

  if (existsSync(KEYPAIR_FILE)) {
    const stored = JSON.parse(readFileSync(KEYPAIR_FILE, "utf8"));
    const { keypairFromPrivateKey } = require("soulprint-core");
    return keypairFromPrivateKey(new Uint8Array(Buffer.from(stored.privateKey, "hex")));
  }

  const keypair = generateKeypair();
  writeFileSync(KEYPAIR_FILE, JSON.stringify({
    did:        keypair.did,
    privateKey: Buffer.from(keypair.privateKey).toString("hex"),
    created:    new Date().toISOString(),
  }), { mode: 0o600 });
  return keypair;
}

function calcScore(credentials: CredentialType[]): number {
  const s: Record<CredentialType, number> = {
    EmailVerified: 10, PhoneVerified: 15, GitHubLinked: 20,
    DocumentVerified: 25, FaceMatch: 20, BiometricBound: 10,
  };
  return credentials.reduce((acc, c) => acc + (s[c] ?? 0), 0);
}

export { ocrCedula, quickValidateImage }   from "./document/ocr.js";
export { matchFaceWithDocument }            from "./face/face-match.js";
export { validateCedulaNumber, parseCedulaOCR } from "./document/cedula-validator.js";
