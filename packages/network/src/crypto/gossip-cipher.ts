/**
 * gossip-cipher.ts — Cifrado end-to-end para el tráfico P2P de Soulprint
 *
 * DISEÑO:
 * ─────────────────────────────────────────────────────────────────────────
 * • Algoritmo: AES-256-GCM (AEAD — autenticado + cifrado)
 * • Clave derivada de: HMAC-SHA256(PROTOCOL_HASH + epoch)
 *   → Solo nodos con PROTOCOL_HASH correcto pueden cifrar/descifrar
 *   → Refuerza el hash enforcement: no basta con conocer el hash,
 *     el hash correcto ES la clave de acceso a la red
 * • Rotación: epoch de 5 minutos → forward secrecy básica
 * • Nonce: 96 bits aleatorios por mensaje (GCM requirement)
 * • AuthTag: 128 bits — detecta cualquier tampering en tránsito
 *
 * FLUJO:
 *   Emisor:  payload → encryptGossip() → { ciphertext, nonce, epoch, tag }
 *   Receptor: → decryptGossip() → payload original  ← solo si tiene hash correcto
 *
 * VENTAJAS SOBRE PLAINTEXT:
 * 1. Un nodo modificado (hash diferente) no puede leer el tráfico de la red
 * 2. Un atacante MitM no puede modificar attestations (AuthTag falla)
 * 3. Replay protection: epoch cambia cada 5 min, aceptamos ±1 epoch
 * 4. Doble enforcement: hash = identidad de red + llave de cifrado
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { PROTOCOL_HASH } from "soulprint-core";

// ── Constantes ────────────────────────────────────────────────────────────────

/** Duración de cada epoch de cifrado (5 minutos). */
const EPOCH_MS   = 5 * 60 * 1000;

/** Epochs aceptados en recepción: actual ± EPOCH_TOLERANCE. */
const EPOCH_TOLERANCE = 1;

/** Tamaño del nonce GCM (96 bits — recomendación NIST). */
const NONCE_BYTES  = 12;

/** Tamaño del AuthTag GCM (128 bits — máximo, más seguro). */
const AUTH_TAG_BYTES = 16;

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Deriva la clave AES-256 para el epoch dado.
 * PROTOCOL_HASH es el secreto compartido — solo nodos honestos lo tienen.
 *
 * @param epochMs Timestamp del epoch (default: now)
 */
export function deriveGossipKey(epochMs: number = Date.now()): Buffer {
  const epoch    = Math.floor(epochMs / EPOCH_MS);
  const material = `soulprint-gossip-v1:${PROTOCOL_HASH}:epoch:${epoch}`;
  return createHmac("sha256", PROTOCOL_HASH).update(material).digest();
}

/**
 * Retorna el epoch actual y el anterior (para ventana de tolerancia).
 */
export function currentEpochs(): number[] {
  const now   = Date.now();
  const epoch = Math.floor(now / EPOCH_MS);
  return Array.from(
    { length: EPOCH_TOLERANCE * 2 + 1 },
    (_, i) => epoch - EPOCH_TOLERANCE + i
  );
}

// ── Cifrado ───────────────────────────────────────────────────────────────────

export interface EncryptedGossip {
  /** Payload cifrado + AuthTag (base64). */
  ct:    string;
  /** Nonce aleatorio de 96 bits (base64). */
  iv:    string;
  /** Epoch en que fue cifrado (para seleccionar la clave correcta). */
  ep:    number;
  /** Versión del esquema de cifrado. */
  v:     1;
}

/**
 * Cifra un payload de gossip con AES-256-GCM.
 * Solo nodos con el PROTOCOL_HASH correcto pueden descifrar.
 *
 * @param payload Objeto JSON a cifrar
 * @returns EncryptedGossip listo para transmitir
 */
export function encryptGossip(payload: object): EncryptedGossip {
  const epoch  = Math.floor(Date.now() / EPOCH_MS);
  const key    = deriveGossipKey(Date.now());
  const nonce  = randomBytes(NONCE_BYTES);

  const cipher    = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`epoch:${epoch}`)); // Additional data autenticada

  const plaintext  = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted  = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag    = cipher.getAuthTag(); // 16 bytes

  // ciphertext = encrypted || authTag (concatenados)
  return {
    ct: Buffer.concat([encrypted, authTag]).toString("base64"),
    iv: nonce.toString("base64"),
    ep: epoch,
    v:  1,
  };
}

// ── Descifrado ────────────────────────────────────────────────────────────────

export interface DecryptResult {
  ok:       boolean;
  payload?: object;
  error?:   string;
}

/**
 * Descifra un payload de gossip recibido de un peer.
 *
 * Valida:
 * 1. Epoch dentro de la ventana aceptada (±EPOCH_TOLERANCE epochs)
 * 2. AuthTag GCM — rechaza cualquier mensaje tampered
 * 3. JSON válido
 *
 * @param enc EncryptedGossip recibido del peer
 */
export function decryptGossip(enc: EncryptedGossip): DecryptResult {
  if (enc.v !== 1) return { ok: false, error: "Unknown cipher version" };

  // Validar epoch
  const validEpochs = currentEpochs();
  if (!validEpochs.includes(enc.ep)) {
    return {
      ok:    false,
      error: `Epoch ${enc.ep} fuera de ventana aceptada [${validEpochs[0]}–${validEpochs[validEpochs.length - 1]}]`,
    };
  }

  try {
    const key        = deriveGossipKey(enc.ep * EPOCH_MS);
    const nonce      = Buffer.from(enc.iv, "base64");
    const ctAndTag   = Buffer.from(enc.ct, "base64");

    // Separar ciphertext del authTag
    const ciphertext = ctAndTag.subarray(0, ctAndTag.length - AUTH_TAG_BYTES);
    const authTag    = ctAndTag.subarray(ctAndTag.length - AUTH_TAG_BYTES);

    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(`epoch:${enc.ep}`));

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload   = JSON.parse(decrypted.toString("utf8"));

    return { ok: true, payload };
  } catch (err: any) {
    return {
      ok:    false,
      error: err.message?.includes("Unsupported state")
        ? "AuthTag inválido — mensaje tampered o clave incorrecta"
        : `Decrypt error: ${err.message?.slice(0, 80)}`,
    };
  }
}
