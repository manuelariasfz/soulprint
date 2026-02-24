import { ed25519 }   from "@noble/curves/ed25519";
import { sha256 }     from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/curves/abstract/utils";
import { base58btc }  from "multiformats/bases/base58";

// ── Tipos ────────────────────────────────────────────────────────────────────

export interface SoulprintKeypair {
  did:        string;   // did:key:z6Mk...
  publicKey:  Uint8Array;
  privateKey: Uint8Array;
}

export interface SoulprintToken {
  sip:          "1";
  did:          string;
  score:        number;
  level:        TrustLevel;
  country?:     string;
  credentials:  CredentialType[];
  nullifier:    string;
  issued:       number;
  expires:      number;
  network_sig?: string;
}

export type TrustLevel     = "Unverified" | "EmailVerified" | "PhoneVerified" | "KYCLite" | "KYCFull";
export type CredentialType = "EmailVerified" | "PhoneVerified" | "GitHubLinked"
                           | "DocumentVerified" | "FaceMatch" | "BiometricBound";

// ── DID generation ────────────────────────────────────────────────────────────

/**
 * Genera un keypair Ed25519 y construye un did:key
 * El DID es portable — mismo keypair = mismo DID en cualquier dispositivo
 */
export function generateKeypair(): SoulprintKeypair {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey  = ed25519.getPublicKey(privateKey);
  const did        = publicKeyToDID(publicKey);
  return { did, publicKey, privateKey };
}

/**
 * Reconstruye el keypair desde una llave privada guardada
 */
export function keypairFromPrivateKey(privateKey: Uint8Array): SoulprintKeypair {
  const publicKey = ed25519.getPublicKey(privateKey);
  const did       = publicKeyToDID(publicKey);
  return { did, publicKey, privateKey };
}

/**
 * did:key format: did:key:z6Mk<base58btc(0xed01 + publicKey)>
 * 0xed01 = multicodec prefix para Ed25519
 */
function publicKeyToDID(publicKey: Uint8Array): string {
  const multicodec = new Uint8Array([0xed, 0x01, ...publicKey]);
  const encoded    = base58btc.encode(multicodec);
  return `did:key:${encoded}`;
}

// ── Nullifier ─────────────────────────────────────────────────────────────────

/**
 * Deriva el nullifier desde datos del documento + embedding de cara cuantizado.
 * Determinístico: mismo documento + misma cara = mismo nullifier en cualquier dispositivo.
 * Resistente a Sybil: misma cédula no puede generar dos nullifiers distintos
 * si el face embedding se mantiene.
 *
 * @param cedulaNumber     Número de cédula colombiana
 * @param fechaNacimiento  YYYY-MM-DD
 * @param faceEmbedding    Float32Array (512 dims de InsightFace), cuantizado a 2 decimales
 */
export function deriveNullifier(
  cedulaNumber:    string,
  fechaNacimiento: string,
  faceEmbedding:   Float32Array
): string {
  // Cuantizar embedding para absorber ruido entre fotos del mismo rostro
  const quantized = quantizeEmbedding(faceEmbedding, 2);

  // Combinar datos estables del documento con la llave biométrica
  const input = `${cedulaNumber}:${fechaNacimiento}:${float32ToHex(quantized)}`;

  // Hash final — 32 bytes = 256 bits de seguridad
  const hash = sha256(new TextEncoder().encode(input));
  return "0x" + bytesToHex(hash);
}

/**
 * Cuantiza el embedding de cara para que pequeñas variaciones
 * entre fotos del mismo rostro produzcan el mismo resultado.
 * precision=2 → rounds to 0.01 increments
 */
export function quantizeEmbedding(embedding: Float32Array, precision: number): Float32Array {
  const factor = Math.pow(10, precision);
  return new Float32Array(embedding.map(v => Math.round(v * factor) / factor));
}

function float32ToHex(arr: Float32Array): string {
  return Array.from(arr).map(v => {
    // Representación fija de 4 decimales para consistencia cross-platform
    return v.toFixed(2).replace("-", "n").replace(".", "p");
  }).join(",");
}

// ── Firmas ────────────────────────────────────────────────────────────────────

/**
 * Firma un payload con la llave privada del DID
 */
export function sign(payload: object, privateKey: Uint8Array): string {
  const msg = sha256(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = ed25519.sign(msg, privateKey);
  return bytesToHex(sig);
}

/**
 * Verifica una firma contra un DID did:key:...
 */
export function verify(payload: object, signature: string, did: string): boolean {
  try {
    const publicKey = didToPublicKey(did);
    const msg       = sha256(new TextEncoder().encode(JSON.stringify(payload)));
    return ed25519.verify(hexToBytes(signature), msg, publicKey);
  } catch { return false; }
}

function didToPublicKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:")) throw new Error("Solo did:key soportado");
  const encoded    = did.replace("did:key:", "");
  const multicodec = base58btc.decode(encoded);
  // Saltar los 2 bytes del prefijo multicodec (0xed 0x01)
  return multicodec.slice(2);
}

// ── SPT Token ─────────────────────────────────────────────────────────────────

/**
 * Crea un Soulprint Token (SPT) firmado — el JWT de Soulprint.
 * Lifetime por defecto: 24 horas.
 */
export function createToken(
  keypair:     SoulprintKeypair,
  nullifier:   string,
  credentials: CredentialType[],
  options:     { lifetimeSeconds?: number; country?: string } = {}
): string {
  const now = Math.floor(Date.now() / 1000);

  const payload: SoulprintToken = {
    sip:         "1",
    did:         keypair.did,
    score:       calculateScore(credentials),
    level:       calculateLevel(credentials),
    country:     options.country,
    credentials,
    nullifier,
    issued:      now,
    expires:     now + (options.lifetimeSeconds ?? 86400),
  };

  const signature = sign(payload, keypair.privateKey);
  const tokenData = { ...payload, sig: signature };
  return Buffer.from(JSON.stringify(tokenData)).toString("base64url");
}

/**
 * Decodifica y verifica un SPT. Retorna null si es inválido o expirado.
 */
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

const CREDENTIAL_SCORES: Record<CredentialType, number> = {
  EmailVerified:    10,
  PhoneVerified:    15,
  GitHubLinked:     20,
  DocumentVerified: 25,
  FaceMatch:        20,
  BiometricBound:   10,
};

export function calculateScore(credentials: CredentialType[]): number {
  return credentials.reduce((sum, c) => sum + (CREDENTIAL_SCORES[c] ?? 0), 0);
}

export function calculateLevel(credentials: CredentialType[]): TrustLevel {
  const score = calculateScore(credentials);
  const has   = (c: CredentialType) => credentials.includes(c);
  if (has("DocumentVerified") && has("FaceMatch")) return "KYCFull";
  if (has("DocumentVerified") || has("FaceMatch"))  return "KYCLite";
  if (has("PhoneVerified"))                          return "PhoneVerified";
  if (has("EmailVerified"))                          return "EmailVerified";
  return "Unverified";
}
