// @ts-ignore — circomlibjs sin tipos
import { buildPoseidon }  from "circomlibjs";
import { existsSync, readFileSync } from "node:fs";
import { join }           from "node:path";
// @ts-ignore — snarkjs exports CJS with __esModule:true but no default
import * as snarkjs from "snarkjs";
import { PROTOCOL }        from "soulprint-core";

const KEYS_DIR  = join(__dirname, "..", "keys");
const BUILD_DIR = join(__dirname, "..", "build");
const CIRCUIT   = "soulprint_identity";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface ZKProofInput {
  cedula_num:    bigint;   // número de cédula como BigInt
  fecha_nac:     bigint;   // YYYYMMDD como BigInt
  face_key:      bigint;   // llave biométrica derivada del embedding
  salt:          bigint;   // aleatorio por sesión
  context_tag:   bigint;   // 0n para global, hash del servicio para contexto
}

export interface ZKProof {
  proof:          object;   // el proof de Groth16
  public_signals: string[]; // señales públicas [nullifier, context_tag]
  nullifier:      string;   // el nullifier en hex
}

export interface ZKVerifyResult {
  valid:     boolean;
  nullifier: string;
}

// ── Poseidon (función hash ZK-friendly) ───────────────────────────────────────

let _poseidon: any = null;
async function getPoseidon() {
  if (!_poseidon) _poseidon = await buildPoseidon();
  return _poseidon;
}

/**
 * Calcula el nullifier usando Poseidon (mismo hash que usa el circuito).
 * Se usa para derivar el nullifier ANTES de generar el proof.
 */
export async function computeNullifier(
  cedula_num:    bigint,
  fecha_nac:     bigint,
  face_key:      bigint
): Promise<bigint> {
  const poseidon = await getPoseidon();
  const hash = poseidon([cedula_num, fecha_nac, face_key]);
  return poseidon.F.toObject(hash) as bigint;
}

/**
 * Deriva face_key desde un embedding cuantizado.
 * Determinístico: mismo rostro → mismo face_key en cualquier dispositivo.
 *
 * Precisión: 1 decimal (pasos de 0.1) — más robusto al ruido real de fotos
 * Dimensiones: 32 primeras — balance unicidad vs velocidad
 *
 * Con vectores L2-normalizados de InsightFace:
 * - Ruido intra-persona (misma persona, fotos diferentes): ~0.02-0.05 por dimensión
 * - Con paso 0.1, el ruido debe cruzar 0.05 para cambiar el valor → ~25% de dims
 * - Solución: usar hash iterativo robusto, no bit-por-bit
 */
export async function faceEmbeddingToKey(quantizedEmbedding: number[]): Promise<bigint> {
  const poseidon = await getPoseidon();

  // Cuantizar según PROTOCOL.FACE_KEY_PRECISION (1 decimal = pasos 0.1, robusto ante ±0.03)
  const PRECISION = PROTOCOL.FACE_KEY_PRECISION;   // INAMOVIBLE — Object.freeze()
  const DIMS      = PROTOCOL.FACE_KEY_DIMS;         // INAMOVIBLE — Object.freeze()

  const stabilized = quantizedEmbedding
    .slice(0, DIMS)
    .map(v => {
      const rounded = Math.round(v * Math.pow(10, PRECISION)) / Math.pow(10, PRECISION);
      // Escalar a entero positivo para el campo del circuito
      return BigInt(Math.round((rounded + 2.0) * 1000)); // +2 para evitar negativos, *1000 para precisión
    });

  // Hash iterativo en grupos de 4 (máximo que acepta Poseidon con este config)
  let acc = BigInt(0);
  for (let i = 0; i < stabilized.length; i += 4) {
    const chunk = stabilized.slice(i, i + 4);
    while (chunk.length < 4) chunk.push(BigInt(0));
    const h       = poseidon(chunk);
    const h_obj   = poseidon.F.toObject(h) as bigint;
    const combined = poseidon([acc, h_obj, BigInt(i)]);
    acc = poseidon.F.toObject(combined) as bigint;
  }
  return acc;
}

/**
 * Convierte número de cédula string → BigInt para el circuito
 */
export function cedulaToBigInt(cedula: string): bigint {
  return BigInt(cedula.replace(/[^0-9]/g, ""));
}

/**
 * Convierte fecha "YYYY-MM-DD" → BigInt YYYYMMDD
 */
export function fechaToBigInt(fecha: string): bigint {
  return BigInt(fecha.replace(/[-\/]/g, ""));
}

// ── Generación del proof ──────────────────────────────────────────────────────

/**
 * Genera un ZK proof de identidad.
 *
 * El proof demuestra:
 *   "Conozco cedula + fecha + face_key tal que Poseidon(cedula, fecha, face_key) == nullifier"
 * Sin revelar cedula, fecha ni face_key.
 *
 * Requiere que el circuito haya sido compilado (build:circuits).
 */
export async function generateProof(input: ZKProofInput): Promise<ZKProof> {
  const wasmPath = join(BUILD_DIR, `${CIRCUIT}_js`, `${CIRCUIT}.wasm`);
  const zkeyPath = join(KEYS_DIR, `${CIRCUIT}_final.zkey`);

  if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
    throw new Error(
      "Circuito no compilado. Ejecuta: pnpm --filter soulprint-zkp build:circuits"
    );
  }

  // Calcular nullifier (debe coincidir con el del circuito)
  const nullifier = await computeNullifier(input.cedula_num, input.fecha_nac, input.face_key);

  const circuitInput = {
    cedula_num:   input.cedula_num.toString(),
    fecha_nac:    input.fecha_nac.toString(),
    face_key:     input.face_key.toString(),
    salt:         input.salt.toString(),
    nullifier:    nullifier.toString(),
    context_tag:  input.context_tag.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    wasmPath,
    zkeyPath
  );

  return {
    proof,
    public_signals: publicSignals,
    nullifier:      "0x" + nullifier.toString(16).padStart(64, "0"),
  };
}

// ── Verificación del proof ────────────────────────────────────────────────────

/**
 * Verifica un ZK proof.
 * No necesita los datos privados — solo el proof y la verification key.
 * Se puede ejecutar offline, sin internet, en <50ms.
 */
export async function verifyProof(zkProof: ZKProof): Promise<ZKVerifyResult> {
  const vkeyPath = join(KEYS_DIR, "verification_key.json");

  if (!existsSync(vkeyPath)) {
    throw new Error("Verification key no encontrada. El circuito no está configurado.");
  }

  const vKey = JSON.parse(readFileSync(vkeyPath, "utf8"));

  const valid = await snarkjs.groth16.verify(
    vKey,
    zkProof.public_signals,
    zkProof.proof
  );

  return {
    valid,
    nullifier: zkProof.nullifier,
  };
}

// ── Serialización compacta del proof ─────────────────────────────────────────

/**
 * Serializa un ZK proof a string base64url para incluir en el SPT.
 */
export function serializeProof(zkProof: ZKProof): string {
  const compact = {
    p:  zkProof.proof,
    s:  zkProof.public_signals,
    n:  zkProof.nullifier,
  };
  return Buffer.from(JSON.stringify(compact)).toString("base64url");
}

/**
 * Deserializa un ZK proof desde string base64url.
 */
export function deserializeProof(serialized: string): ZKProof {
  const compact = JSON.parse(Buffer.from(serialized, "base64url").toString());
  return {
    proof:          compact.p,
    public_signals: compact.s,
    nullifier:      compact.n,
  };
}
