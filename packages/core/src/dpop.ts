/**
 * dpop.ts — DPoP (Demonstrating Proof of Possession) para Soulprint
 *
 * PROBLEMA QUE RESUELVE:
 *   El SPT es un bearer token — quien lo tiene, lo puede usar.
 *   Si alguien lo intercepta (MITM, leak de logs, XSS), puede impersonarte.
 *
 * SOLUCIÓN — DPoP:
 *   Con cada request, el cliente firma:
 *     { method, url, nonce, iat, spt_hash }
 *   con su llave privada Ed25519.
 *
 *   El servidor verifica:
 *   1. La firma corresponde a la llave pública del DID en el SPT
 *   2. El nonce no fue usado antes (anti-replay, ventana de 5 min)
 *   3. El spt_hash coincide con el SPT presentado
 *   4. El token no tiene más de 300 segundos
 *
 * RESULTADO:
 *   Robar solo el SPT → INÚTIL (sin la llave privada no se puede firmar)
 *   Robar SPT + interceptar UN request → solo ese request, el nonce quema el replay
 *
 * USO (cliente):
 *   const proof = await signDPoP(privateKey, "POST", "https://api.../verify", spt);
 *   headers["X-Soulprint-Proof"] = proof;
 *   headers["X-Soulprint"] = spt;
 *
 * USO (servidor):
 *   const result = verifyDPoP(proof, spt, "POST", url, nonceStore);
 *   if (!result.valid) return 401;
 */

import { createHash, randomBytes } from "node:crypto";
import { ed25519 }    from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { sha256 }     from "@noble/hashes/sha256";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface DPoPPayload {
  typ:      "soulprint-dpop";
  method:   string;         // HTTP method en mayúsculas: "POST", "GET"...
  url:      string;         // URL exacta del request (sin query si se prefiere)
  nonce:    string;         // hex(16 bytes aleatorios) — único por request
  iat:      number;         // unix timestamp en segundos
  spt_hash: string;         // sha256(spt) — vincula el proof a UN SPT específico
}

export interface DPoPProof {
  payload:   DPoPPayload;
  signature: string;        // Ed25519(sha256(JSON.stringify(payload)), privateKey)
  did:       string;        // DID del firmante — para extraer la llave pública
}

export interface DPoPVerifyResult {
  valid:    boolean;
  reason?:  string;
}

// ── Constantes ────────────────────────────────────────────────────────────────

export const DPOP_MAX_AGE_SECS  = 300;   // 5 minutos — ventana de validez
export const DPOP_NONCE_TTL_MS  = 300_000; // misma ventana en ms para el cache

// ── Cache de nonces (anti-replay) ─────────────────────────────────────────────

/**
 * NonceStore — almacena nonces vistos en los últimos 5 minutos.
 * Cada nodo mantiene uno en memoria. Para clusters usar Redis.
 */
export class NonceStore {
  private seen = new Map<string, number>(); // nonce → timestamp ms

  /** Devuelve true si el nonce ya fue visto (replay) */
  has(nonce: string): boolean {
    this.cleanup();
    return this.seen.has(nonce);
  }

  /** Registra un nonce nuevo */
  add(nonce: string): void {
    this.seen.set(nonce, Date.now());
  }

  /** Limpia nonces expirados */
  private cleanup(): void {
    const cutoff = Date.now() - DPOP_NONCE_TTL_MS;
    for (const [n, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(n);
    }
  }

  size(): number { return this.seen.size; }
}

// ── Utilidades ────────────────────────────────────────────────────────────────

function hashSpt(spt: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(spt)));
}

function didToPublicKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) throw new Error("Solo did:key:z... soportado");
  // bs58 decode — inline sin dependencia extra
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const encoded  = did.replace("did:key:z", "");
  let n = BigInt(0);
  for (const char of encoded) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error(`Invalid base58 char: ${char}`);
    n = n * BigInt(58) + BigInt(digit);
  }
  // To bytes
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // Strip multicodec prefix (2 bytes: 0xed 0x01)
  const arr = new Uint8Array(bytes);
  return arr.slice(2); // 32 bytes Ed25519 public key
}

// ── Firma del cliente ─────────────────────────────────────────────────────────

/**
 * Genera un DPoP proof para un request.
 * Llamar JUSTO ANTES de enviar el request (el iat se establece ahora).
 *
 * @param privateKey  Uint8Array Ed25519 de 32 bytes (la llave del usuario)
 * @param did         DID del usuario (para incluir en el proof)
 * @param method      HTTP method: "GET", "POST", etc.
 * @param url         URL exacta del request
 * @param spt         El SPT actual del usuario
 */
export function signDPoP(
  privateKey: Uint8Array,
  did:        string,
  method:     string,
  url:        string,
  spt:        string,
): DPoPProof {
  const payload: DPoPPayload = {
    typ:      "soulprint-dpop",
    method:   method.toUpperCase(),
    url,
    nonce:    randomBytes(16).toString("hex"),
    iat:      Math.floor(Date.now() / 1000),
    spt_hash: hashSpt(spt),
  };

  const msg       = sha256(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = bytesToHex(ed25519.sign(msg, privateKey));

  return { payload, signature, did };
}

/**
 * Serializa un DPoP proof para incluirlo en el header X-Soulprint-Proof.
 */
export function serializeDPoP(proof: DPoPProof): string {
  return Buffer.from(JSON.stringify(proof)).toString("base64url");
}

/**
 * Deserializa el header X-Soulprint-Proof.
 */
export function deserializeDPoP(header: string): DPoPProof {
  return JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as DPoPProof;
}

// ── Verificación del servidor ─────────────────────────────────────────────────

/**
 * Verifica un DPoP proof en el servidor.
 *
 * @param proofHeader   Contenido del header X-Soulprint-Proof (base64url)
 * @param spt           El SPT del mismo request (X-Soulprint header)
 * @param method        HTTP method del request actual
 * @param url           URL del request actual
 * @param nonceStore    Cache compartido de nonces
 * @param sptDid        DID extraído del SPT (ya decodificado) — para verificar firma
 */
export function verifyDPoP(
  proofHeader: string,
  spt:         string,
  method:      string,
  url:         string,
  nonceStore:  NonceStore,
  sptDid:      string,
): DPoPVerifyResult {
  // 1. Deserializar
  let proof: DPoPProof;
  try {
    proof = deserializeDPoP(proofHeader);
  } catch {
    return { valid: false, reason: "DPoP proof malformado — no se puede deserializar" };
  }

  const { payload, signature, did } = proof;

  // 2. Tipo correcto
  if (payload.typ !== "soulprint-dpop") {
    return { valid: false, reason: `typ inválido: ${payload.typ}` };
  }

  // 3. Fresco (no más de 5 minutos)
  const nowSecs = Math.floor(Date.now() / 1000);
  const age     = nowSecs - payload.iat;
  if (age < 0 || age > DPOP_MAX_AGE_SECS) {
    return { valid: false, reason: `DPoP expirado: ${age}s (máx ${DPOP_MAX_AGE_SECS}s)` };
  }

  // 4. Anti-replay: nonce único
  if (nonceStore.has(payload.nonce)) {
    return { valid: false, reason: "Nonce ya visto — replay attack detectado" };
  }

  // 5. Method y URL coinciden con el request actual
  if (payload.method !== method.toUpperCase()) {
    return { valid: false, reason: `Method mismatch: ${payload.method} ≠ ${method}` };
  }
  // URL: compara solo path para evitar problemas con http vs https en dev
  try {
    const claimedPath = new URL(payload.url).pathname;
    const actualPath  = new URL(url).pathname;
    if (claimedPath !== actualPath) {
      return { valid: false, reason: `URL path mismatch: ${claimedPath} ≠ ${actualPath}` };
    }
  } catch {
    // Si no se puede parsear, comparar directo
    if (payload.url !== url) {
      return { valid: false, reason: `URL mismatch: ${payload.url} ≠ ${url}` };
    }
  }

  // 6. spt_hash vincula el proof a ESTE SPT (previene usar el proof con otro SPT)
  const expectedHash = hashSpt(spt);
  if (payload.spt_hash !== expectedHash) {
    return { valid: false, reason: "spt_hash no coincide — proof generado para otro token" };
  }

  // 7. DID del proof coincide con el DID del SPT
  if (did !== sptDid) {
    return { valid: false, reason: `DID mismatch: proof=${did} ≠ spt=${sptDid}` };
  }

  // 8. Verificar firma Ed25519
  try {
    const publicKey = didToPublicKey(did);
    const msg       = sha256(new TextEncoder().encode(JSON.stringify(payload)));
    const sigBytes  = hexToBytes(signature);
    const valid     = ed25519.verify(sigBytes, msg, publicKey);
    if (!valid) {
      return { valid: false, reason: "Firma Ed25519 inválida — llave privada incorrecta o payload alterado" };
    }
  } catch (e: any) {
    return { valid: false, reason: `Error verificando firma: ${e.message}` };
  }

  // ✅ Todo OK — registrar nonce para prevenir replay
  nonceStore.add(payload.nonce);
  return { valid: true };
}
