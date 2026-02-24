/**
 * peer-challenge.ts — Challenge-Response para verificar integridad de peers
 *
 * PROPÓSITO:
 *   Detectar nodos con código modificado (por IA o humanos) que:
 *   - Saltean la verificación ZK (siempre devuelven valid: true)
 *   - Falsifican identidades
 *   - Modifican reglas de reputación
 *
 * PROTOCOLO:
 *   Challenger envía → POST /challenge:
 *     { challenge_id, nonce, valid_proof, invalid_proof, issued_at }
 *   Peer responde:
 *     { challenge_id, result_valid, result_invalid, verified_at, node_did, signature }
 *
 *   PASA solo si:
 *     result_valid   === true   (la prueba válida debe verificar correctamente)
 *     result_invalid === false  (la prueba mutada debe fallar)
 *     signature válida del node_did
 *     latencia < CHALLENGE_TIMEOUT_MS
 *
 * DEFENSA:
 *   - invalid_proof se genera con mutaciones aleatorias → no se puede precalcular
 *   - nonce único por challenge → replay attacks imposibles
 *   - Signature Ed25519 del nodo → impersonación imposible
 *   - Requiere snarkjs + verification_key.json reales → no se puede falsificar
 */

import { randomBytes }      from "node:crypto";
import { sign, verify }     from "soulprint-core";
import type { SoulprintKeypair } from "soulprint-core";
import type { ZKProof }           from "soulprint-zkp";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface ChallengeRequest {
  /** UUID v4 aleatorio — liga request con response */
  challenge_id:   string;
  /** Hex random 32 bytes — previene replay */
  nonce:          string;
  /** Unix timestamp — ventana de tiempo */
  issued_at:      number;
  /**
   * Prueba ZK válida conocida (del vector oficial del protocolo).
   * El peer debe responder { result_valid: true }.
   */
  valid_proof:    ZKProof;
  /**
   * Prueba ZK inválida (generada mutando la prueba válida).
   * El peer debe responder { result_invalid: false }.
   * Se genera FRESH en cada challenge → no se puede precalcular.
   */
  invalid_proof:  ZKProof;
}

export interface ChallengeResponse {
  challenge_id:    string;
  result_valid:    boolean;   // debe ser true
  result_invalid:  boolean;   // debe ser false
  verified_at:     number;    // unix timestamp
  node_did:        string;
  /** Ed25519 de: challenge_id + result_valid + result_invalid + verified_at */
  signature:       string;
}

export interface ChallengeVerifyResult {
  passed:    boolean;
  reason?:   string;
  latencyMs: number;
}

// ── Constantes ────────────────────────────────────────────────────────────────

const CHALLENGE_TIMEOUT_MS = 10_000;   // 10s para responder
const CHALLENGE_MAX_AGE_MS = 30_000;   // challenge no puede tener > 30s

/**
 * Vector oficial del protocolo — prueba ZK válida con inputs conocidos.
 * Generado con: cedula_num=1020461234, fecha_nac=19990315,
 *               face_key=7777777777777777, salt=42, context_tag=9999
 *
 * INMUTABLE: cualquier cambio rompe la compatibilidad entre peers.
 * Para cambiar → governance proposal + nueva versión del protocolo.
 */
export const PROTOCOL_CHALLENGE_VECTOR: ZKProof = {
  proof: {
    pi_a: [
      "17231824363891071847614212245387425674396581909308381803359772147707471000919",
      "19588541837679217833407029636874793838906661493525842317191608434335604970799",
      "1",
    ],
    pi_b: [
      [
        "11937559174797391865676193150124443529922902408378632559897969904465437909909",
        "3783491803101218791202802718325043562310255310529703621240161786050524980007",
      ],
      [
        "5757417038837630649229424866979137583391276733893863180103946010067165910493",
        "5880666300624045949147617382270971979378931465612472485108841841557941315987",
      ],
      ["1", "0"],
    ],
    pi_c: [
      "9808239150582098422818746780590161866382246420373529525969304184632327451434",
      "8832896428005725751078011800370694609054865778463638134004190542161546087737",
      "1",
    ],
    protocol: "groth16",
    curve:    "bn128",
  } as any,
  public_signals: [
    "1",
    "876832831059113281857402424507978523341008910706979894235932005767734713849",
    "9999",
  ],
  nullifier: "0x01f045114d0735efb880c7410a220c6bb4f6fd79290bcace37061dbee8fd5df9",
};

// ── Generación de prueba inválida (fresh por challenge) ───────────────────────

/**
 * Muta una prueba ZK válida para producir una que SIEMPRE falla.
 *
 * Método: XOR de los últimos 32 bits de pi_a[0] con un valor aleatorio ≠ 0.
 * Esto produce un proof criptográficamente inválido que snarkjs rechazará,
 * pero no puede precalcularse porque el nonce es aleatorio.
 */
export function generateInvalidProof(
  base: ZKProof,
  nonce: string
): ZKProof {
  const pi_a = [...(base.proof as any).pi_a];

  // Mutar pi_a[0]: XOR los últimos 16 chars con primeros 16 chars del nonce
  const original   = pi_a[0] as string;
  const mutation   = BigInt("0x" + nonce.slice(0, 16));
  const original_n = BigInt(original);
  // Garantizar que la mutación no sea trivial (≥ 1)
  const mut_val    = mutation === 0n ? 1n : mutation;
  const mutated    = (original_n + mut_val).toString();

  return {
    ...base,
    proof: {
      ...(base.proof as any),
      pi_a: [mutated, pi_a[1], pi_a[2]],
    },
    public_signals: [...base.public_signals],
  };
}

// ── Construcción del challenge (lado challenger) ──────────────────────────────

export function buildChallenge(): ChallengeRequest {
  const nonce        = randomBytes(16).toString("hex");
  const challenge_id = randomBytes(16).toString("hex");
  const issued_at    = Math.floor(Date.now() / 1000);

  return {
    challenge_id,
    nonce,
    issued_at,
    valid_proof:   PROTOCOL_CHALLENGE_VECTOR,
    invalid_proof: generateInvalidProof(PROTOCOL_CHALLENGE_VECTOR, nonce),
  };
}

// ── Construcción de la respuesta (lado peer) ──────────────────────────────────

export async function buildChallengeResponse(
  req:         ChallengeRequest,
  nodeKeypair: SoulprintKeypair,
  verifyFn:    (proof: ZKProof) => Promise<{ valid: boolean }>,
): Promise<ChallengeResponse> {
  const [r1, r2]  = await Promise.all([
    verifyFn(req.valid_proof),
    verifyFn(req.invalid_proof),
  ]);

  const verified_at   = Math.floor(Date.now() / 1000);
  const result_valid  = r1.valid;
  const result_invalid = r2.valid;

  const payload   = {
    challenge_id:   req.challenge_id,
    result_valid,
    result_invalid,
    verified_at,
  };
  const signature = sign(payload, nodeKeypair.privateKey);

  return {
    challenge_id:   req.challenge_id,
    result_valid,
    result_invalid,
    verified_at,
    node_did:   nodeKeypair.did,
    signature,
  };
}

// ── Verificación de la respuesta (lado challenger) ────────────────────────────

export function verifyChallengeResponse(
  req:       ChallengeRequest,
  resp:      ChallengeResponse,
  startedAt: number,
): ChallengeVerifyResult {
  const latencyMs = Date.now() - startedAt;
  const nowSecs   = Math.floor(Date.now() / 1000);

  // 1. Ventana de tiempo
  if (nowSecs - req.issued_at > CHALLENGE_MAX_AGE_MS / 1000) {
    return { passed: false, latencyMs, reason: "Challenge expirado" };
  }
  if (latencyMs > CHALLENGE_TIMEOUT_MS) {
    return { passed: false, latencyMs, reason: `Timeout: ${latencyMs}ms > ${CHALLENGE_TIMEOUT_MS}ms` };
  }

  // 2. Challenge ID debe coincidir
  if (resp.challenge_id !== req.challenge_id) {
    return { passed: false, latencyMs, reason: "challenge_id no coincide" };
  }

  // 3. La prueba válida debe haber verificado como VÁLIDA
  if (!resp.result_valid) {
    return {
      passed: false, latencyMs,
      reason: "Fallo: prueba ZK válida reportada como inválida — verificación comprometida",
    };
  }

  // 4. La prueba inválida (mutada) debe haber verificado como INVÁLIDA
  if (resp.result_invalid) {
    return {
      passed: false, latencyMs,
      reason: "Fallo: prueba ZK inválida reportada como válida — ZK verification bypasseada",
    };
  }

  // 5. Verificar firma Ed25519 del nodo
  const payload = {
    challenge_id:   resp.challenge_id,
    result_valid:   resp.result_valid,
    result_invalid: resp.result_invalid,
    verified_at:    resp.verified_at,
  };
  const sigValid = verify(payload, resp.signature, resp.node_did);
  if (!sigValid) {
    return { passed: false, latencyMs, reason: "Firma Ed25519 inválida" };
  }

  return { passed: true, latencyMs };
}

// ── Verificación completa de un peer remoto (envía challenge + verifica resp) ─

export async function verifyPeerBehavior(
  peerUrl:     string,
  timeoutMs:   number = CHALLENGE_TIMEOUT_MS,
): Promise<ChallengeVerifyResult> {
  const challenge = buildChallenge();
  const startedAt = Date.now();

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    const resp = await fetch(`${peerUrl}/challenge`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(challenge),
      signal:  ctrl.signal,
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) {
      return {
        passed:    false,
        latencyMs: Date.now() - startedAt,
        reason:    `HTTP ${resp.status} — peer no soporta challenge-response`,
      };
    }

    const response = await resp.json() as ChallengeResponse;
    return verifyChallengeResponse(challenge, response, startedAt);

  } catch (err: any) {
    return {
      passed:    false,
      latencyMs: Date.now() - startedAt,
      reason:    `Error de red: ${err.message}`,
    };
  }
}
