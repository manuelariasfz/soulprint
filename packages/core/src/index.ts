import { ed25519 }   from "@noble/curves/ed25519";
import { sha256 }     from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/curves/abstract/utils";
import bs58           from "bs58";

// ── Tipos ────────────────────────────────────────────────────────────────────

export interface SoulprintKeypair {
  did:        string;   // did:key:z6Mk...
  publicKey:  Uint8Array;
  privateKey: Uint8Array;
}

// ── Bot Reputation ────────────────────────────────────────────────────────────

/**
 * Una attestation es un +1 o -1 emitido por un servicio verificado
 * contra el DID de un bot específico.
 *
 * Solo servicios con score >= 60 pueden emitir attestations válidas.
 * La firma Ed25519 vincula la attestation al DID del emisor.
 */
export interface BotAttestation {
  issuer_did:  string;   // DID del servicio verificado (ej: DID del MCP de Uber)
  target_did:  string;   // DID del bot que recibe la calificación
  value:       1 | -1;  // +1 = buen comportamiento, -1 = mal comportamiento
  context:     string;  // descriptor del evento ("on-time-delivery", "spam", etc.)
  timestamp:   number;  // Unix epoch
  sig:         string;  // Ed25519 de {issuer_did,target_did,value,context,timestamp}
}

/**
 * Snapshot de reputación de un bot — se incluye en el SPT como campo `bot_rep`.
 *
 * score: 0-20 (empieza en 10 — neutral)
 *   +1 por cada attestation positiva recibida de servicio verificado
 *   -1 por cada attestation negativa
 *   Clamped: nunca < 0 ni > 20
 *
 * Sin identidad humana: el bot puede tener hasta 20 puntos sólo por reputación.
 * Con identidad humana: identidad (0-80) + reputación (0-20) = 100 total.
 */
export interface BotReputation {
  score:        number;   // 0-20
  attestations: number;   // cantidad total de attestations recibidas
  last_updated: number;   // Unix epoch del último update
}

export interface SoulprintToken {
  sip:          "1";
  did:          string;
  score:        number;         // score total: identity (0-80) + bot_rep (0-20) = 0-100
  identity_score: number;       // solo credenciales humanas (0-80)
  bot_rep:      BotReputation;  // reputación del bot (0-20, empieza en 10)
  level:        TrustLevel;
  country?:     string;
  credentials:  CredentialType[];
  nullifier:    string;
  zkp?:         string;
  issued:       number;
  expires:      number;
  network_sig?: string;
}

export type TrustLevel     = "Unverified" | "EmailVerified" | "PhoneVerified" | "KYCLite" | "KYCFull";
export type CredentialType = "EmailVerified" | "PhoneVerified" | "GitHubLinked"
                           | "DocumentVerified" | "FaceMatch" | "BiometricBound";

// ── DID generation ────────────────────────────────────────────────────────────

export function generateKeypair(): SoulprintKeypair {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey  = ed25519.getPublicKey(privateKey);
  const did        = publicKeyToDID(publicKey);
  return { did, publicKey, privateKey };
}

export function keypairFromPrivateKey(privateKey: Uint8Array): SoulprintKeypair {
  const publicKey = ed25519.getPublicKey(privateKey);
  const did       = publicKeyToDID(publicKey);
  return { did, publicKey, privateKey };
}

function publicKeyToDID(publicKey: Uint8Array): string {
  const multicodec = new Uint8Array([0xed, 0x01, ...publicKey]);
  const encoded    = bs58.encode(multicodec);
  return `did:key:z${encoded}`;
}

// ── Nullifier ─────────────────────────────────────────────────────────────────

export function deriveNullifier(
  cedulaNumber:    string,
  fechaNacimiento: string,
  faceEmbedding:   Float32Array
): string {
  const quantized = quantizeEmbedding(faceEmbedding, 2);
  const input     = `${cedulaNumber}:${fechaNacimiento}:${float32ToHex(quantized)}`;
  const hash      = sha256(new TextEncoder().encode(input));
  return "0x" + bytesToHex(hash);
}

export function quantizeEmbedding(embedding: Float32Array, precision: number): Float32Array {
  const factor = Math.pow(10, precision);
  return new Float32Array(embedding.map(v => Math.round(v * factor) / factor));
}

function float32ToHex(arr: Float32Array): string {
  return Array.from(arr).map(v => v.toFixed(2).replace("-", "n").replace(".", "p")).join(",");
}

// ── Firmas ────────────────────────────────────────────────────────────────────

export function sign(payload: object, privateKey: Uint8Array): string {
  const msg = sha256(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = ed25519.sign(msg, privateKey);
  return bytesToHex(sig);
}

export function verify(payload: object, signature: string, did: string): boolean {
  try {
    const publicKey = didToPublicKey(did);
    const msg       = sha256(new TextEncoder().encode(JSON.stringify(payload)));
    return ed25519.verify(hexToBytes(signature), msg, publicKey);
  } catch { return false; }
}

function didToPublicKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) throw new Error("Solo did:key:z... soportado");
  const encoded    = did.replace("did:key:z", "");
  const multicodec = bs58.decode(encoded);
  return multicodec.slice(2);
}

// ── Bot Reputation — Attestations ─────────────────────────────────────────────

/**
 * Crea una attestation firmada desde un servicio verificado hacia un bot.
 *
 * @param serviceKeypair - Keypair del servicio que emite (ej: MCP de Uber)
 * @param targetDid      - DID del bot que recibe la calificación
 * @param value          - +1 buen comportamiento, -1 mal comportamiento
 * @param context        - Descriptor: "payment-completed", "spam-detected", etc.
 */
export function createAttestation(
  serviceKeypair: SoulprintKeypair,
  targetDid:      string,
  value:          1 | -1,
  context:        string
): BotAttestation {
  const payload = {
    issuer_did: serviceKeypair.did,
    target_did: targetDid,
    value,
    context,
    timestamp:  Math.floor(Date.now() / 1000),
  };
  const sig = sign(payload, serviceKeypair.privateKey);
  return { ...payload, sig };
}

/**
 * Verifica la firma de una attestation.
 * Retorna false si la firma no coincide con el issuer_did.
 */
export function verifyAttestation(att: BotAttestation): boolean {
  const { sig, ...payload } = att;
  return verify(payload, sig, att.issuer_did);
}

/**
 * Aplica una lista de attestations verificadas a una reputación base.
 * El score se clampea a [0, 20] y empieza en 10 (neutral).
 *
 * Solo attestations con firma válida son consideradas.
 *
 * @param attestations - Lista de attestations recibidas
 * @param base         - Score inicial (default: 10)
 */
export function computeReputation(
  attestations: BotAttestation[],
  base:         number = 10
): BotReputation {
  const valid = attestations.filter(verifyAttestation);

  const delta = valid.reduce((sum, a) => sum + a.value, 0);
  const score = Math.max(0, Math.min(20, base + delta));

  return {
    score,
    attestations: valid.length,
    last_updated: Math.floor(Date.now() / 1000),
  };
}

/**
 * Reputación neutral por defecto — para bots sin historial.
 */
export function defaultReputation(): BotReputation {
  return { score: 10, attestations: 0, last_updated: Math.floor(Date.now() / 1000) };
}

// ── SPT Token ─────────────────────────────────────────────────────────────────

export function createToken(
  keypair:     SoulprintKeypair,
  nullifier:   string,
  credentials: CredentialType[],
  options: {
    lifetimeSeconds?: number;
    country?:         string;
    zkProof?:         string;
    bot_rep?:         BotReputation;   // pasar reputación actual del bot
  } = {}
): string {
  const now          = Math.floor(Date.now() / 1000);
  const identity_s   = calculateScore(credentials);
  const botRep       = options.bot_rep ?? defaultReputation();
  const total_score  = Math.min(100, identity_s + botRep.score);

  const payload: SoulprintToken = {
    sip:            "1",
    did:            keypair.did,
    score:          total_score,
    identity_score: identity_s,
    bot_rep:        botRep,
    level:          calculateLevel(credentials),
    country:        options.country,
    credentials,
    nullifier,
    ...(options.zkProof ? { zkp: options.zkProof } : {}),
    issued:  now,
    expires: now + (options.lifetimeSeconds ?? 86400),
  };

  const signature = sign(payload, keypair.privateKey);
  const tokenData = { ...payload, sig: signature };
  return Buffer.from(JSON.stringify(tokenData)).toString("base64url");
}

export function decodeToken(spt: string): (SoulprintToken & { sig: string }) | null {
  try {
    const raw     = JSON.parse(Buffer.from(spt, "base64url").toString());
    const { sig, ...payload } = raw;
    if (!verify(payload, sig, payload.did)) return null;
    if (payload.expires < Math.floor(Date.now() / 1000)) return null;
    return raw;
  } catch { return null; }
}

// ── Trust Score ───────────────────────────────────────────────────────────────

/**
 * Puntajes de credenciales humanas — escalados a 80 puntos máximo.
 * Los 20 puntos restantes vienen de BotReputation.
 * Total máximo: 80 (identidad) + 20 (reputación) = 100.
 */
const CREDENTIAL_SCORES: Record<CredentialType, number> = {
  EmailVerified:     8,   // antes: 10
  PhoneVerified:    12,   // antes: 15
  GitHubLinked:     16,   // antes: 20
  DocumentVerified: 20,   // antes: 25
  FaceMatch:        16,   // antes: 20
  BiometricBound:    8,   // antes: 10
  // Total máximo: 80
};

export function calculateScore(credentials: CredentialType[]): number {
  return credentials.reduce((sum, c) => sum + (CREDENTIAL_SCORES[c] ?? 0), 0);
}

/**
 * Score total = identidad (0-80) + reputación bot (0-20) = 0-100
 */
export function calculateTotalScore(
  credentials: CredentialType[],
  botRep:      BotReputation = defaultReputation()
): number {
  return Math.min(100, calculateScore(credentials) + botRep.score);
}

export function calculateLevel(credentials: CredentialType[]): TrustLevel {
  const has = (c: CredentialType) => credentials.includes(c);
  if (has("DocumentVerified") && has("FaceMatch")) return "KYCFull";
  if (has("DocumentVerified") || has("FaceMatch"))  return "KYCLite";
  if (has("PhoneVerified"))                          return "PhoneVerified";
  if (has("EmailVerified"))                          return "EmailVerified";
  return "Unverified";
}
