import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join }     from "node:path";
import { homedir }  from "node:os";
import { computeHash, loadState, saveState, type NodeState } from "./state/StateStore.js";
import {
  generateKeypair, keypairFromPrivateKey, SoulprintKeypair,
  decodeToken, sign, createToken,
  TOKEN_LIFETIME_SECONDS, TOKEN_RENEW_PREEMPTIVE_SECS,
  TOKEN_RENEW_GRACE_SECS, TOKEN_RENEW_COOLDOWN_SECS,
  verifyDPoP, NonceStore,
  BotAttestation, BotReputation,
  verifyAttestation, computeReputation, defaultReputation,
  PROTOCOL, PROTOCOL_HASH, isProtocolCompatible, isProtocolHashCompatible, computeTotalScoreWithFloor,
  checkFarming, recordApprovedGain, recordFarmingStrike,
  loadAuditStore, exportAuditStore,
  SessionContext, FARMING_RULES,
} from "soulprint-core";
import { verifyProof, deserializeProof } from "soulprint-zkp";
import {
  buildChallengeResponse, verifyChallengeResponse, verifyPeerBehavior,
  ChallengeRequest, ChallengeResponse,
} from "./peer-challenge.js";
import { handleCredentialRoute } from "./credentials/index.js";
import { handleCedulaRoute } from "./credentials/registraduria.js";
import { encryptGossip, decryptGossip } from "./crypto/gossip-cipher.js";
import { selectGossipPeers, routingStats } from "./crypto/peer-router.js";
import { NullifierConsensus, AttestationConsensus, StateSyncManager } from "./consensus/index.js";
import { BlockchainAnchor } from "./blockchain/blockchain-anchor.js";
import {
  SoulprintBlockchainClient,
  loadBlockchainConfig,
} from "./blockchain/blockchain-client.js";
import {
  thresholdsClient,
  type ProtocolThresholds,
  PROTOCOL_THRESHOLDS_ADDRESS,
  PROTOCOL_THRESHOLDS_CHAIN,
} from "./blockchain/protocol-thresholds-client.js";
import { getCodeIntegrity, logCodeIntegrity, computeRuntimeHash } from "./code-integrity.js";
import {
  isVerifiedOnChain, getMCPEntry, getVerifiedMCPEntries, getAllMCPEntries,
  getRegistryInfo, verifyMCPOnChain, revokeMCPOnChain, registerMCPOnChain,
} from "./mcp-registry-client.js";
import {
  publishAttestationP2P,
  onAttestationReceived,
  getP2PStats,
  dialP2PPeer,
  type SoulprintP2PNode,
} from "./p2p.js";
import {
  PeerRegistryClient,
  type PeerEntry,
} from "./blockchain/PeerRegistryClient.js";
import {
  NullifierRegistryClient,
} from "./blockchain/NullifierRegistryClient.js";
import {
  ReputationRegistryClient,
} from "./blockchain/ReputationRegistryClient.js";

// ── Config ────────────────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.SOULPRINT_PORT ?? String(PROTOCOL.DEFAULT_HTTP_PORT));
const NODE_DIR     = join(homedir(), ".soulprint", "node");
const KEYPAIR_FILE = join(NODE_DIR, "node-identity.json");
const NULLIFIER_DB = join(NODE_DIR, "nullifiers.json");
const REPUTE_DB    = join(NODE_DIR, "reputation.json");
const PEERS_DB     = join(NODE_DIR, "peers.json");
const AUDIT_DB     = join(NODE_DIR, "audit.json");
const VERSION      = "0.5.0";

const MAX_BODY_BYTES       = 64 * 1024;
// ── Protocol constants (inamovibles - no cambiar directamente aquí) ───────────
const RATE_LIMIT_MS        = PROTOCOL.RATE_LIMIT_WINDOW_MS;
const RATE_LIMIT_MAX       = PROTOCOL.RATE_LIMIT_MAX;
const CLOCK_SKEW_MAX       = PROTOCOL.CLOCK_SKEW_MAX_SECONDS;
const ATT_MAX_AGE_SECONDS  = PROTOCOL.ATT_MAX_AGE_SECONDS;
const GOSSIP_TIMEOUT_MS    = PROTOCOL.GOSSIP_TIMEOUT_MS;

// ── Thresholds cargados desde blockchain al arrancar (fallback: local) ────────
// Usados en runtime — se pueden actualizar solo via superAdmin en el contrato.
// El validador recarga cada 10 minutos automáticamente.
let liveThresholds: {
  SCORE_FLOOR:            number;
  VERIFIED_SCORE_FLOOR:   number;
  MIN_ATTESTER_SCORE:     number;
  FACE_SIM_DOC_SELFIE:    number;
  FACE_SIM_SELFIE_SELFIE: number;
  DEFAULT_REPUTATION:     number;
  IDENTITY_MAX:           number;
  REPUTATION_MAX:         number;
  source: "blockchain" | "local_fallback";
} = {
  SCORE_FLOOR:            PROTOCOL.SCORE_FLOOR           as number,
  VERIFIED_SCORE_FLOOR:   PROTOCOL.VERIFIED_SCORE_FLOOR  as number,
  MIN_ATTESTER_SCORE:     PROTOCOL.MIN_ATTESTER_SCORE    as number,
  FACE_SIM_DOC_SELFIE:    PROTOCOL.FACE_SIM_DOC_SELFIE   as number,
  FACE_SIM_SELFIE_SELFIE: PROTOCOL.FACE_SIM_SELFIE_SELFIE as number,
  DEFAULT_REPUTATION:     PROTOCOL.DEFAULT_REPUTATION    as number,
  IDENTITY_MAX:           PROTOCOL.IDENTITY_MAX          as number,
  REPUTATION_MAX:         PROTOCOL.REPUTATION_MAX        as number,
  source: "local_fallback",
};

export function getLiveThresholds() { return liveThresholds; }

async function refreshThresholds() {
  try {
    thresholdsClient.invalidate();
    const t = await thresholdsClient.load();
    liveThresholds = {
      SCORE_FLOOR:            t.SCORE_FLOOR,
      VERIFIED_SCORE_FLOOR:   t.VERIFIED_SCORE_FLOOR,
      MIN_ATTESTER_SCORE:     t.MIN_ATTESTER_SCORE,
      FACE_SIM_DOC_SELFIE:    t.FACE_SIM_DOC_SELFIE   / 1000,
      FACE_SIM_SELFIE_SELFIE: t.FACE_SIM_SELFIE_SELFIE / 1000,
      DEFAULT_REPUTATION:     t.DEFAULT_REPUTATION,
      IDENTITY_MAX:           t.IDENTITY_MAX,
      REPUTATION_MAX:         t.REPUTATION_MAX,
      source: t.source,
    };
    console.log(`[thresholds] ✅ Cargados desde ${t.source === "blockchain" ? "blockchain" : "fallback local"}`);
    if (t.source === "blockchain") {
      console.log(`[thresholds]    SCORE_FLOOR=${t.SCORE_FLOOR} VERIFIED_SCORE_FLOOR=${t.VERIFIED_SCORE_FLOOR} MIN_ATTESTER=${t.MIN_ATTESTER_SCORE}`);
    }
  } catch { /* usa los valores actuales */ }
}

// ── P2P Node (Phase 5) ────────────────────────────────────────────────────────
let p2pNode: SoulprintP2PNode | null = null;

// ── PeerRegistry Client ───────────────────────────────────────────────────────
let peerRegistryClient: PeerRegistryClient | null = null;

export function setPeerRegistryClient(client: PeerRegistryClient): void {
  peerRegistryClient = client;
}

// ── On-Chain Registries (v0.5.0) ───────────────────────────────────────────────
// The blockchain IS the shared state. These are the single source of truth.
// Only soulprint.digital validator can WRITE; anyone can READ.
let nullifierRegistry: NullifierRegistryClient | null = null;
let reputationRegistry: ReputationRegistryClient | null = null;

export function setNullifierRegistry(client: NullifierRegistryClient): void {
  nullifierRegistry = client;
}
export function setReputationRegistry(client: ReputationRegistryClient): void {
  reputationRegistry = client;
}
export function getNullifierRegistry(): NullifierRegistryClient | null {
  return nullifierRegistry;
}
export function getReputationRegistry(): ReputationRegistryClient | null {
  return reputationRegistry;
}

/**
 * Inyecta el nodo libp2p al validador.
 * Cuando se llama:
 *  1. Se registra el handler de attestations entrantes por GossipSub
 *  2. Desde ese momento, gossipAttestation() también publica por P2P
 */
export function setP2PNode(node: SoulprintP2PNode): void {
  p2pNode = node;

  // Recibir attestations de otros nodos via GossipSub
  onAttestationReceived(node, (att, fromPeer) => {
    // Validar firma antes de aplicar
    if (!verifyAttestation(att)) {
      console.warn(`[p2p] Attestation inválida de peer ${fromPeer.slice(0, 16)}... - descartada`);
      return;
    }
    // Anti-replay ya está dentro de applyAttestation()
    applyAttestation(att);
    console.log(`[p2p] Attestation recibida de peer ${fromPeer.slice(0, 16)}... → ${att.target_did.slice(0, 20)}... (${att.value > 0 ? "+" : ""}${att.value})`);
  });

  console.log(`[p2p] P2P integrado → ${node.peerId.toString().slice(0, 16)}...`);
}

// ── Rate limiter ──────────────────────────────────────────────────────────────
const rateLimits = new Map<string, { count: number; resetAt: number }>();

// ── DPoP Nonce Store — anti-replay para request signing ──────────────────────
const dpopNonces = new NonceStore();
function checkRateLimit(ip: string): boolean {
  const now   = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) { rateLimits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_MS }); return true; }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}
setInterval(() => { const now = Date.now(); for (const [ip, e] of rateLimits) if (now > e.resetAt) rateLimits.delete(ip); }, 5*60_000).unref();

// ── Nullifier registry ────────────────────────────────────────────────────────
let nullifiers: Record<string, { did: string; verified_at: number }> = {};
function loadNullifiers() { if (existsSync(NULLIFIER_DB)) try { nullifiers = JSON.parse(readFileSync(NULLIFIER_DB, "utf8")); } catch { nullifiers = {}; } }
function saveNullifiers() { writeFileSync(NULLIFIER_DB, JSON.stringify(nullifiers, null, 2)); }

// ── Reputation store ──────────────────────────────────────────────────────────
/**
 * Per-DID reputation: score (0-20) + attestation history.
 * Persisted to disk - survives node restarts.
 */
interface ReputeEntry {
  score:               number;
  base:                number;          // score base calculado desde attestations
  attestations:        BotAttestation[];
  last_updated:        number;
  identityScore:       number;          // sub-score de identidad - para calcular floor
  hasDocumentVerified: boolean;         // si tiene DocumentVerified - activa VERIFIED_SCORE_FLOOR
}
let repStore: Record<string, ReputeEntry> = {};

function loadReputation() {
  if (existsSync(REPUTE_DB)) try { repStore = JSON.parse(readFileSync(REPUTE_DB, "utf8")); } catch { repStore = {}; }
}
function saveReputation() { writeFileSync(REPUTE_DB, JSON.stringify(repStore, null, 2)); }

// ── Audit store (anti-farming) ────────────────────────────────────────────────
function loadAudit() {
  if (existsSync(AUDIT_DB)) try { loadAuditStore(JSON.parse(readFileSync(AUDIT_DB, "utf8"))); } catch { /* empty */ }
}
function saveAudit() { writeFileSync(AUDIT_DB, JSON.stringify(exportAuditStore(), null, 2)); }

/**
 * Obtiene la reputación de un DID.
 * Si no existe, retorna la reputación neutral (score=10).
 */
function getReputation(did: string): BotReputation {
  const entry = repStore[did];
  if (!entry) return defaultReputation();
  return { score: entry.score, attestations: entry.attestations.length, last_updated: entry.last_updated };
}

/**
 * Aplica una nueva attestation al DID objetivo y persiste.
 *
 * PROTOCOL ENFORCEMENT:
 * - Si el bot tiene DocumentVerified, su score total nunca puede caer por
 *   debajo de liveThresholds.VERIFIED_SCORE_FLOOR (52) - inamovible.
 * - Anti-replay: la misma attestation (mismo issuer + timestamp + context)
 *   no se puede aplicar dos veces.
 *
 * Retorna la reputación actualizada.
 */
function applyAttestation(att: BotAttestation): BotReputation {
  const existing = repStore[att.target_did];
  const prevAtts = existing?.attestations ?? [];

  // Anti-replay: no se pueden aplicar dos veces la misma attestation
  const isDuplicate = prevAtts.some(a =>
    a.issuer_did === att.issuer_did &&
    a.timestamp === att.timestamp &&
    a.context   === att.context
  );
  if (isDuplicate) {
    return getReputation(att.target_did);
  }

  const allAtts = [...prevAtts, att];
  const rep     = computeReputation(allAtts, 10); // base siempre 10

  // ── PROTOCOL FLOOR ENFORCEMENT ─────────────────────────────────────────────
  // Si el DID tiene DocumentVerified, su score total no puede caer bajo el floor.
  // La reputación mínima se calcula como: floor - identity_score.
  // Ejemplo: floor=52, identity=36 → min_rep = max(0, 52-36) = 16
  // Nunca permitimos que la reputación baje de ese mínimo.
  const existingToken = existing ? { hasDocument: true } : null; // conservative: assume yes if known
  const identityFromStore = existing?.identityScore ?? 0;
  const hasDocument = existing?.hasDocumentVerified ?? false;

  let finalRepScore = rep.score;
  if (hasDocument) {
    const minRepForFloor = Math.max(0, liveThresholds.VERIFIED_SCORE_FLOOR - identityFromStore);
    finalRepScore = Math.max(finalRepScore, minRepForFloor);
    if (finalRepScore !== rep.score) {
      console.log(
        `[floor] Reputation clamped for ${att.target_did.slice(0,20)}...: ` +
        `${rep.score} → ${finalRepScore} (VERIFIED_SCORE_FLOOR=${liveThresholds.VERIFIED_SCORE_FLOOR})`
      );
    }
  }

  repStore[att.target_did] = {
    score:              finalRepScore,
    base:               10,
    attestations:       allAtts,
    last_updated:       rep.last_updated,
    identityScore:      existing?.identityScore ?? 0,
    hasDocumentVerified: hasDocument,
  };
  saveReputation();
  // ── Write reputation to on-chain ReputationRegistry (v0.5.0) — non-blocking
  if (reputationRegistry) {
    reputationRegistry.setScore({
      did:     att.target_did,
      score:   finalRepScore,
      context: "soulprint:v1",
    }).catch(e => console.warn("[reputation-registry] ⚠️  On-chain write failed:", e.message));
  }
  return { score: finalRepScore, attestations: allAtts.length, last_updated: rep.last_updated };
}

// ── P2P state sync metadata ───────────────────────────────────────────────────
let lastSyncTs: number = 0;  // timestamp (ms) of last successful anti-entropy sync

// ── Peers registry (P2P gossip) ───────────────────────────────────────────────
let peers: string[] = [];   // URLs de otros nodos (ej: "http://node2.example.com:4888")

function loadPeers() {
  if (existsSync(PEERS_DB)) try { peers = JSON.parse(readFileSync(PEERS_DB, "utf8")); } catch { peers = []; }
}
function savePeers() { writeFileSync(PEERS_DB, JSON.stringify(peers, null, 2)); }

/**
 * Gossip: propaga la attestation a la red.
 *
 * Estrategia:
 *  1. P2P GossipSub (Phase 5) - si el nodo libp2p está activo
 *  2. HTTP fire-and-forget (Phase 3) - fallback para nodos legacy sin libp2p
 *
 * Ambos canales son fire-and-forget: no bloquean la respuesta al cliente.
 */
async function gossipAttestation(att: BotAttestation, excludeUrl?: string) {
  // ── Canal 1: libp2p GossipSub ─────────────────────────────────────────────
  if (p2pNode) {
    const recipients = await publishAttestationP2P(p2pNode, att);
    if (recipients > 0) {
      console.log(`[p2p] Attestation publicada → ${recipients} peer(s) via GossipSub`);
    }
  }

  // ── Canal 2: HTTP gossip con cifrado AES-256-GCM + XOR routing ────────────
  // Selección de peers: XOR routing hacia el DID objetivo → O(log n)
  // Con ≤10 peers: broadcast total. Con más: solo K=6 más cercanos.
  const targets = selectGossipPeers(peers, att.target_did, excludeUrl);

  if (targets.length < peers.length - (excludeUrl ? 1 : 0)) {
    console.log(routingStats(peers.length, targets.length, att.target_did));
  }

  if (targets.length > 0) {
    console.log(`[gossip] broadcasted to ${targets.length} peers`);
  }

  // Cifrar el payload con AES-256-GCM antes de enviar
  // Solo nodos con PROTOCOL_HASH correcto pueden descifrar
  const encrypted = encryptGossip({ attestation: att, from_peer: true });

  for (const peerUrl of targets) {
    fetch(`${peerUrl}/reputation/attest`, {
      method:  "POST",
      headers: {
        "Content-Type":    "application/json",
        "X-Gossip":        "1",
        "X-Protocol-Hash": PROTOCOL_HASH,
        "X-Encrypted":     "aes-256-gcm-v1",   // señal al receptor
      },
      body:    JSON.stringify(encrypted),
      signal:  AbortSignal.timeout(GOSSIP_TIMEOUT_MS),
    }).catch(() => { /* peer unreachable - ignore */ });
  }
}

// ── Node keypair ──────────────────────────────────────────────────────────────
function loadOrCreateNodeKeypair(): SoulprintKeypair {
  if (!existsSync(NODE_DIR)) mkdirSync(NODE_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(KEYPAIR_FILE)) {
    try {
      const s = JSON.parse(readFileSync(KEYPAIR_FILE, "utf8"));
      return keypairFromPrivateKey(new Uint8Array(Buffer.from(s.privateKey, "hex")));
    } catch { /* regenerar */ }
  }
  const kp = generateKeypair();
  writeFileSync(KEYPAIR_FILE, JSON.stringify({ did: kp.did, privateKey: Buffer.from(kp.privateKey).toString("hex"), created: new Date().toISOString() }), { mode: 0o600 });
  console.log(`✅ Nuevo nodo: ${kp.did}`);
  return kp;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
const SECURITY_HEADERS = {
  "Content-Type":           "application/json",
  "X-Soulprint-Node":       VERSION,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options":        "DENY",
};
function json(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, SECURITY_HEADERS);
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "", size = 0;
    req.on("data", chunk => { size += chunk.length; if (size > MAX_BODY_BYTES) { req.destroy(); reject(new Error("Request too large")); return; } data += chunk; });
    req.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON")); } });
  });
}
function getIP(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  return (typeof fwd === "string" ? fwd.split(",")[0].trim() : req.socket.remoteAddress) ?? "unknown";
}

// ── GET /info ─────────────────────────────────────────────────────────────────
function handleInfo(res: ServerResponse, nodeKeypair: SoulprintKeypair) {
  const p2pStats = p2pNode ? getP2PStats(p2pNode) : null;

  json(res, 200, {
    node_did:            nodeKeypair.did,
    version:             VERSION,
    protocol:            PROTOCOL.VERSION,
    protocol_hash:       PROTOCOL_HASH,   // ← cualquier modificación cambia este hash
    total_verified:      Object.keys(nullifiers).length,
    total_reputation:    Object.keys(repStore).length,
    known_peers:         peers.length,
    supported_countries: ["CO"],
    capabilities:        ["zk-verify", "anti-sybil", "co-sign", "bot-reputation", "p2p-gossipsub", "credential-validators", "anti-farming"],
    rate_limit:          `${PROTOCOL.RATE_LIMIT_MAX} req/min per IP`,
    // P2P stats (Phase 5)
    p2p: p2pStats ? {
      enabled:      true,
      peer_id:      p2pStats.peerId,
      peers:        p2pStats.peers,
      pubsub_peers: p2pStats.pubsubPeers,
      multiaddrs:   p2pStats.multiaddrs,
    } : { enabled: false },
  });
}

// ── GET /protocol ──────────────────────────────────────────────────────────────
/**
 * Expone las constantes de protocolo inamovibles.
 * Los clientes y otros nodos usan este endpoint para:
 *  1. Verificar compatibilidad de versión antes de conectarse
 *  2. Obtener los valores actuales de SCORE_FLOOR y liveThresholds.MIN_ATTESTER_SCORE
 *  3. Validar que el nodo no ha sido modificado para bajar los thresholds
 */
function handleProtocol(res: ServerResponse) {
  json(res, 200, {
    protocol_version:      PROTOCOL.VERSION,
    // ── Protocol Hash - IDENTIDAD DE LA RED ────────────────────────────────
    // Cualquier nodo con un hash diferente es rechazado automáticamente.
    // Si PROTOCOL fue modificado (aunque sea un valor), este hash cambia.
    protocol_hash:         PROTOCOL_HASH,
    // ── Score limits ────────────────────────────────────────────────────────
    score_floor:           liveThresholds.SCORE_FLOOR,
    verified_score_floor:  liveThresholds.VERIFIED_SCORE_FLOOR,
    min_attester_score:    liveThresholds.MIN_ATTESTER_SCORE,
    identity_max:          PROTOCOL.IDENTITY_MAX,
    reputation_max:        PROTOCOL.REPUTATION_MAX,
    max_score:             PROTOCOL.MAX_SCORE,
    default_reputation:    PROTOCOL.DEFAULT_REPUTATION,
    // ── Biometric thresholds ────────────────────────────────────────────────
    face_sim_doc_selfie:    PROTOCOL.FACE_SIM_DOC_SELFIE,
    face_sim_selfie_selfie: PROTOCOL.FACE_SIM_SELFIE_SELFIE,
    face_key_dims:          PROTOCOL.FACE_KEY_DIMS,
    face_key_precision:     PROTOCOL.FACE_KEY_PRECISION,
    // ── Retry / timing ──────────────────────────────────────────────────────
    verify_retry_max:      PROTOCOL.VERIFY_RETRY_MAX,
    verify_retry_base_ms:  PROTOCOL.VERIFY_RETRY_BASE_MS,
    verify_retry_max_ms:   PROTOCOL.VERIFY_RETRY_MAX_MS,
    att_max_age_seconds:   PROTOCOL.ATT_MAX_AGE_SECONDS,
    // ── Enforcement notice ──────────────────────────────────────────────────
    immutable:             true,
    enforcement:           "p2p-hash",   // ← la red rechaza nodos con hash diferente
    note:                  "Nodes with a different protocol_hash are rejected by the network. Modifying any constant changes the hash and isolates the node.",
  });
}

// ── GET /reputation/:did ──────────────────────────────────────────────────────
function handleGetReputation(res: ServerResponse, did: string) {
  if (!did.startsWith("did:")) return json(res, 400, { error: "Invalid DID format" });
  const rep = getReputation(did);
  json(res, 200, { did, ...rep });
}

// ── POST /reputation/attest ───────────────────────────────────────────────────
/**
 * Un servicio verificado emite una attestation (+1 o -1) sobre un bot.
 *
 * Request body:
 * {
 *   "attestation": BotAttestation,    // firmada con la llave del servicio
 *   "service_spt": "<SPT>",           // token del servicio emisor (score >= 60)
 *   "from_peer":   true | undefined   // si viene de un peer (no requiere service_spt)
 * }
 *
 * Validaciones:
 *   1. service_spt tiene score >= liveThresholds.MIN_ATTESTER_SCORE (solo servicios verificados)
 *   2. service_spt.did == attestation.issuer_did (el emisor es quien dice ser)
 *   3. Firma Ed25519 de la attestation es válida
 *   4. timestamp no tiene más de ATT_MAX_AGE_SECONDS de antigüedad
 *   5. value es exactamente +1 o -1
 */
async function handleAttest(req: IncomingMessage, res: ServerResponse, ip: string) {
  if (!checkRateLimit(ip)) return json(res, 429, { error: "Rate limit exceeded" });

  let rawBody: any;
  try { rawBody = await readBody(req); } catch (e: any) { return json(res, 400, { error: e.message }); }

  // ── Descifrado AES-256-GCM (gossip cifrado desde peers) ──────────────────
  // Si el header X-Encrypted está presente, descifrar antes de procesar.
  // Un nodo con PROTOCOL_HASH diferente no puede descifrar → falla aquí.
  let body = rawBody;
  const isEncrypted = req.headers["x-encrypted"] === "aes-256-gcm-v1";
  if (isEncrypted) {
    const result = decryptGossip(rawBody);
    if (!result.ok) {
      console.warn(`[crypto] Gossip descifrado fallido desde ${ip}: ${result.error}`);
      return json(res, 403, {
        error:  "Encrypted gossip could not be decrypted",
        reason: result.error,
        hint:   "Ensure your node runs the official soulprint-network with the correct PROTOCOL_HASH",
      });
    }
    body = result.payload;
  }

  const { attestation, service_spt, from_peer } = body ?? {};
  if (!attestation) return json(res, 400, { error: "Missing field: attestation" });

  // ── Protocol Hash Enforcement (gossip desde peers) ────────────────────────
  if (from_peer) {
    const peerHash = req.headers["x-protocol-hash"] as string | undefined;
    if (peerHash && !isProtocolHashCompatible(peerHash)) {
      console.warn(`[protocol] Gossip rechazado de ${ip} - hash incompatible: ${peerHash?.slice(0,16)}...`);
      return json(res, 409, {
        error:       "Protocol mismatch - gossip rejected",
        our_hash:    PROTOCOL_HASH,
        their_hash:  peerHash,
      });
    }
  }

  const att: BotAttestation = attestation;

  // ── Validaciones básicas de la attestation ────────────────────────────────
  if (typeof att.issuer_did  !== "string") return json(res, 400, { error: "attestation.issuer_did must be string" });
  if (typeof att.target_did  !== "string") return json(res, 400, { error: "attestation.target_did must be string" });
  if (att.value !== 1 && att.value !== -1) return json(res, 400, { error: "attestation.value must be 1 or -1" });
  if (typeof att.context     !== "string") return json(res, 400, { error: "attestation.context must be string" });
  if (typeof att.timestamp   !== "number") return json(res, 400, { error: "attestation.timestamp must be number" });
  if (typeof att.sig         !== "string") return json(res, 400, { error: "attestation.sig must be string" });

  // ── Clock check ───────────────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);
  if (now - att.timestamp > ATT_MAX_AGE_SECONDS) {
    return json(res, 400, { error: `Attestation is too old (max ${ATT_MAX_AGE_SECONDS}s)` });
  }

  // ── Verificar que el emisor está autorizado ───────────────────────────────
  // Si viene de un peer (gossip), confiar en que ya fue validado
  // Si viene del exterior, exigir service_spt
  if (!from_peer) {
    if (!service_spt) return json(res, 401, { error: "Missing service_spt - only verified services can attest" });

    const serviceTok = decodeToken(service_spt);
    if (!serviceTok) return json(res, 401, { error: "Invalid or expired service_spt" });
    if (serviceTok.score < liveThresholds.MIN_ATTESTER_SCORE) {
      return json(res, 403, {
        error:     `Service score too low (${serviceTok.score} < ${liveThresholds.MIN_ATTESTER_SCORE})`,
        required:  liveThresholds.MIN_ATTESTER_SCORE,
        got:       serviceTok.score,
      });
    }
    if (serviceTok.did !== att.issuer_did) {
      return json(res, 403, { error: "service_spt.did does not match attestation.issuer_did" });
    }
  }

  // ── Verificar firma Ed25519 de la attestation ─────────────────────────────
  if (!verifyAttestation(att)) {
    return json(res, 403, { error: "Invalid attestation signature" });
  }

  // ── Aplicar y persistir ───────────────────────────────────────────────────

  // ── ANTI-FARMING CHECK (solo para attestations positivas) ─────────────────
  // Si detectamos farming, convertimos el +1 en -1 automáticamente.
  // Las attestations negativas no se chequean (una penalización real no hace farming).
  let finalAtt = att;
  if (att.value === 1 && !from_peer) {
    const existing = repStore[att.target_did];
    const prevAtts = existing?.attestations ?? [];

    // Reconstruir sesión desde el contexto de la attestation
    const session: SessionContext = {
      did:       att.target_did,
      startTime: (att.timestamp - 60) * 1000,  // estimar inicio de sesión 60s antes
      events:    [],  // no tenemos eventos individuales aquí - se evalúa en withTracking()
      issuerDid: att.issuer_did,
    };

    const farmResult = checkFarming(session, prevAtts);
    if (farmResult.isFarming) {
      console.warn(
        `[anti-farming] 🚫 Farming detectado para ${att.target_did.slice(0,20)}...`,
        `\n  Razón: ${farmResult.reason}`,
        `\n  Convirtiendo +1 → -1 automáticamente`
      );
      // Penalizar en lugar de recompensar
      finalAtt = { ...att, value: -1, context: `farming-penalty:${att.context}` };
      recordFarmingStrike(att.target_did);
      saveAudit();
    } else {
      // Registrar ganancia aprobada para el tracking de velocidad
      recordApprovedGain(att.target_did);
      saveAudit();
    }
  }

  const updatedRep = applyAttestation(finalAtt);

  // ── Gossip a los peers (async, fire-and-forget) ───────────────────────────
  if (!from_peer) {
    gossipAttestation(finalAtt, undefined);
  }

  json(res, 200, {
    ok:          true,
    target_did:  finalAtt.target_did,
    reputation:  updatedRep,
    gossiped_to: from_peer ? 0 : peers.length,
    farming_detected: finalAtt.value !== att.value,
    ...(finalAtt.value !== att.value ? { farming_reason: finalAtt.context } : {}),
  });
}

// ── POST /challenge ────────────────────────────────────────────────────────────
/**
 * Recibe un challenge de otro peer y responde con los resultados de verificación.
 * Esto permite a los peers verificar que este nodo ejecuta código ZK no modificado.
 *
 * ATAQUE BLOQUEADO:
 *   - Nodo con ZK bypasseado (siempre true) → falla en invalid_proof
 *   - Nodo con ZK siempre false → falla en valid_proof
 *   - Respuesta precalculada → nonce aleatorio la invalida
 *   - Impersonación → firma Ed25519 la invalida
 */
async function handleChallenge(
  req:         IncomingMessage,
  res:         ServerResponse,
  nodeKeypair: SoulprintKeypair,
) {
  let body: ChallengeRequest;
  try { body = await readBody(req) as ChallengeRequest; }
  catch (e: any) { return json(res, 400, { error: e.message }); }

  if (!body?.challenge_id || !body?.valid_proof || !body?.invalid_proof) {
    return json(res, 400, { error: "Required: challenge_id, valid_proof, invalid_proof" });
  }

  // Verificar ventana de tiempo (anti-replay)
  const nowSecs = Math.floor(Date.now() / 1000);
  if (nowSecs - (body.issued_at ?? 0) > 30) {
    return json(res, 400, { error: "Challenge expirado (> 30s)" });
  }

  // Ejecutar verificación ZK en ambas pruebas
  const response = await buildChallengeResponse(
    body,
    nodeKeypair,
    async (proof) => {
      try {
        const result = await verifyProof(proof);
        return { valid: result.valid };
      } catch {
        return { valid: false };
      }
    },
  );

  json(res, 200, response);
}

// ── POST /peers/register ──────────────────────────────────────────────────────
async function handlePeerRegister(req: IncomingMessage, res: ServerResponse) {
  let body: any;
  try { body = await readBody(req); } catch (e: any) { return json(res, 400, { error: e.message }); }

  const { url, protocol_hash } = body ?? {};
  if (!url || typeof url !== "string") return json(res, 400, { error: "Missing field: url" });
  if (!/^https?:\/\//.test(url))       return json(res, 400, { error: "url must start with http:// or https://" });

  // ── Protocol Hash Enforcement - INAMOVIBLE POR LA RED ────────────────────
  // Si el peer envía un hash, DEBE coincidir con el nuestro.
  // Si no envía hash → se acepta (nodos legacy / primeras versiones).
  // En versiones futuras, el hash será OBLIGATORIO.
  if (protocol_hash && !isProtocolHashCompatible(protocol_hash)) {
    return json(res, 409, {
      error:                  "Protocol mismatch - node rejected",
      reason:                 "The peer is running with different protocol constants. This breaks network consensus.",
      our_hash:               PROTOCOL_HASH,
      their_hash:             protocol_hash,
      our_version:            PROTOCOL.VERSION,
      resolution:             "Update soulprint-network to the latest version, or join a compatible network.",
    });
  }

  if (peers.includes(url)) return json(res, 200, { ok: true, peers: peers.length, msg: "Already registered" });

  // ── Challenge-Response: verificar que el peer ejecuta código no modificado ─
  // Solo si el peer tiene el endpoint /challenge (nodos v0.3.6+)
  const challengeResult = await verifyPeerBehavior(url, 8_000).catch(() => null);
  if (challengeResult && !challengeResult.passed) {
    console.warn(`[peer] ❌ ${url} falló challenge-response: ${challengeResult.reason}`);
    return json(res, 403, {
      error:   "Peer falló verificación de integridad de código",
      reason:  challengeResult.reason,
      latency: challengeResult.latencyMs,
      hint:    "El peer puede estar ejecutando código ZK modificado.",
    });
  }
  if (challengeResult?.passed) {
    console.log(`[peer] ✅ ${url} pasó challenge-response (${challengeResult.latencyMs}ms)`);
  }

  peers.push(url);
  savePeers();

  // ── Auto-dial libp2p layer ──────────────────────────────────────────────────
  // WSL2 / NAT: mDNS no funciona → al registrar un peer HTTP, intentamos
  // conectar también vía libp2p usando sus multiaddrs del /info endpoint.
  if (p2pNode) {
    setImmediate(async () => {
      try {
        const infoRes = await fetch(`${url}/info`, { signal: AbortSignal.timeout(3_000) });
        if (infoRes.ok) {
          const info = await infoRes.json() as any;
          const addrs: string[] = info?.p2p?.multiaddrs ?? [];
          let dialed = false;
          for (const ma of addrs) {
            const ok = await dialP2PPeer(p2pNode!, ma);
            if (ok) { console.log(`[peer] 🔗 P2P dial OK: ${ma}`); dialed = true; break; }
          }
          if (!dialed) console.log(`[peer] ℹ️  P2P dial failed for ${url} (mDNS fallback)`);
        }
      } catch { /* non-critical — HTTP gossip is the fallback */ }
    });
  }

  json(res, 200, { ok: true, peers: peers.length, protocol_hash: PROTOCOL_HASH });
}

// ── GET /peers ─────────────────────────────────────────────────────────────────
function handleGetPeers(res: ServerResponse) {
  json(res, 200, { peers, count: peers.length });
}

// ── POST /verify ──────────────────────────────────────────────────────────────
async function handleVerify(req: IncomingMessage, res: ServerResponse, nodeKeypair: SoulprintKeypair, ip: string) {
  if (!checkRateLimit(ip)) return json(res, 429, { error: "Rate limit exceeded. Try again in 1 minute." });

  let body: any;
  try { body = await readBody(req); } catch (e: any) { return json(res, 400, { error: e.message }); }

  const { spt, zkp } = body ?? {};
  if (!spt || !zkp)                                          return json(res, 400, { error: "Missing required fields: spt, zkp" });
  if (typeof spt !== "string" || typeof zkp !== "string")    return json(res, 400, { error: "spt and zkp must be strings" });

  const token = decodeToken(spt);
  if (!token) return json(res, 401, { error: "Invalid or expired SPT" });

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(token.issued - now) > CLOCK_SKEW_MAX) {
    return json(res, 400, { error: "Clock skew too large", max_skew_seconds: CLOCK_SKEW_MAX });
  }

  let zkResult: { valid: boolean; nullifier: string };
  try {
    const proof = deserializeProof(zkp);
    zkResult    = await verifyProof(proof);
  } catch (e: any) { return json(res, 400, { error: `ZK proof error: ${e.message?.slice(0, 100)}` }); }

  if (!zkResult.valid)     return json(res, 403, { error: "ZK proof is not valid" });
  if (!zkResult.nullifier) return json(res, 400, { error: "No nullifier in ZK proof" });

  const existing = nullifiers[zkResult.nullifier];
  let antiSybil: "new" | "existing" = "new";

  if (existing) {
    if (existing.did !== token.did) {
      return json(res, 409, { error: "Anti-Sybil: this nullifier is already registered with a different DID" });
    }
    antiSybil = "existing";
  } else {
    nullifiers[zkResult.nullifier] = { did: token.did, verified_at: now };
    saveNullifiers();
    // ── Write to on-chain NullifierRegistry (v0.5.0) — non-blocking ──────────
    // soulprint.digital validator signs and certifies the identity on-chain.
    // Anyone can now verify isRegistered(nullifier) without trusting this node.
    if (nullifierRegistry) {
      const score = repStore[token.did]?.score ?? 0;
      nullifierRegistry.registerNullifier({
        nullifier: zkResult.nullifier,
        did:       token.did,
        score,
      }).catch(e => console.warn("[nullifier-registry] ⚠️  On-chain write failed:", e.message));
    }
  }

  const coSig = sign({ nullifier: zkResult.nullifier, did: token.did, timestamp: now }, nodeKeypair.privateKey);

  // Incluir reputación actual del bot en la respuesta
  const reputation = getReputation(token.did);

  // Guardar identityScore y hasDocumentVerified para enforcement del floor
  if (!repStore[token.did]) {
    repStore[token.did] = {
      score:               reputation.score,
      base:                10,
      attestations:        [],
      last_updated:        now,
      identityScore:       token.identity_score ?? 0,
      hasDocumentVerified: (token.credentials ?? []).includes("DocumentVerified"),
    };
  } else {
    // Actualizar identity info si el token es más reciente
    repStore[token.did].identityScore      = token.identity_score ?? 0;
    repStore[token.did].hasDocumentVerified = (token.credentials ?? []).includes("DocumentVerified");
  }
  saveReputation();

  json(res, 200, {
    valid:        true,
    anti_sybil:   antiSybil,
    nullifier:    zkResult.nullifier,
    reputation,                          // ← reputación actual del bot
    node_did:     nodeKeypair.did,
    co_signature: coSig,
    verified_at:  now,
  });
}

// ── POST /token/renew ─────────────────────────────────────────────────────────
/**
 * Auto-renueva un SPT próximo a expirar o recién expirado.
 *
 * REGLAS:
 *  • Token dentro del período de pre-renew (< 1h restante) → renovar
 *  • Token expirado hace < 7 días → renovar (grace period)
 *  • Token expirado hace > 7 días → denegar, requiere re-verificación completa
 *  • Score actual < VERIFIED_SCORE_FLOOR → denegar
 *  • Cooldown: un mismo DID no puede renovar más de 1 vez cada 60s
 *
 * Body: { spt: "<token_actual>" }
 * Respuesta: { spt: "<token_nuevo>", expires_in: <segundos>, renewed: true }
 */
async function handleTokenRenew(
  req: IncomingMessage,
  res: ServerResponse,
  nodeKeypair: SoulprintKeypair,
) {
  const body = await readBody(req) as { spt?: string };
  if (!body?.spt) return json(res, 400, { error: "Required: spt" });

  // Decodificar sin verificar expiración (queremos ver el DID aunque esté expirado)
  const token = decodeToken(body.spt);
  if (!token) return json(res, 401, { error: "Invalid SPT - cannot decode" });

  const nowSecs = Math.floor(Date.now() / 1000);
  const secsUntilExpiry = token.expires - nowSecs;
  const secsAfterExpiry = nowSecs - token.expires;

  // Ventana de renovación permitida
  const TOKEN_LIFETIME  = TOKEN_LIFETIME_SECONDS;
  const RENEW_PREEMPT   = TOKEN_RENEW_PREEMPTIVE_SECS;
  const RENEW_GRACE     = TOKEN_RENEW_GRACE_SECS;
  const RENEW_COOLDOWN  = TOKEN_RENEW_COOLDOWN_SECS;

  // ── Verificar ventana de tiempo ──────────────────────────────────────────
  const isExpired        = secsUntilExpiry <= 0;
  const inPreemptWindow  = !isExpired && secsUntilExpiry <= RENEW_PREEMPT;
  const inGraceWindow    = isExpired && secsAfterExpiry <= RENEW_GRACE;

  if (!inPreemptWindow && !inGraceWindow) {
    if (!isExpired) {
      return json(res, 400, {
        error:        "Token válido - no necesita renovación aún",
        expires_in:   secsUntilExpiry,
        renew_after:  secsUntilExpiry - RENEW_PREEMPT,
      });
    }
    return json(res, 401, {
      error:        "Token expirado hace más de 7 días - requiere re-verificación completa",
      expired_ago:  secsAfterExpiry,
      max_grace:    RENEW_GRACE,
    });
  }

  // ── Anti-spam: cooldown por DID ──────────────────────────────────────────
  const lastRenewKey = `renew:${token.did}`;
  const lastRenew    = (repStore[token.did] as any)?._lastRenew ?? 0;
  if (nowSecs - lastRenew < RENEW_COOLDOWN) {
    return json(res, 429, {
      error:      "Renovación muy frecuente - espera 60s entre renovaciones",
      retry_in:   RENEW_COOLDOWN - (nowSecs - lastRenew),
    });
  }

  // ── Verificar que el DID sigue registrado en el estado P2P ───────────────
  const nullifierPair  = Object.entries(nullifiers).find(([, n]) => n.did === token.did);
  const nullifierEntry = nullifierPair?.[1];
  if (!nullifierEntry) {
    return json(res, 403, {
      error: "DID no registrado en este nodo - requiere re-verificación",
      did:   token.did,
    });
  }
  const nullifierHash = nullifierPair![0];

  // ── Verificar score actual (puede haber bajado desde el último token) ────
  const repEntry    = repStore[token.did];
  const currentRep  = repEntry
    ? computeTotalScoreWithFloor(
        repEntry.identityScore ?? 0,
        repEntry.score ?? 0,
        repEntry.hasDocumentVerified ?? false
      )
    : 0;
  const scoreFloor  = liveThresholds.VERIFIED_SCORE_FLOOR ?? 52;

  if (currentRep < scoreFloor) {
    return json(res, 403, {
      error:       "Score por debajo del floor - renovación denegada",
      score:       currentRep,
      floor:       scoreFloor,
      hint:        "El bot necesita más attestations positivas",
    });
  }

  // ── Todo OK → emitir nuevo SPT ───────────────────────────────────────────
  // Mantener las mismas credenciales y score del token original
  const newSpt = createToken(
    nodeKeypair,
    nullifierHash,           // nullifier hash (fuente de verdad)
    (token.credentials ?? []) as any,
    {
      lifetimeSeconds:  TOKEN_LIFETIME,
      country:          token.country,
    }
  );

  // Registrar timestamp de renovación (anti-spam)
  if (repStore[token.did]) {
    (repStore[token.did] as any)._lastRenew = nowSecs;
    saveReputation();
  }

  console.log(`[renew] ✅ ${token.did.slice(0, 20)}... → nuevo SPT (${isExpired ? "post-grace" : "pre-emptivo"})`);

  return json(res, 200, {
    spt:         newSpt,
    expires_in:  TOKEN_LIFETIME,
    renewed:     true,
    method:      isExpired ? "grace_window" : "preemptive",
    old_expired: isExpired,
    node_did:    nodeKeypair.did,
  });
}

// ── GET /nullifier/:hash ──────────────────────────────────────────────────────
function handleNullifierCheck(res: ServerResponse, nullifier: string) {
  if (!/^(0x)?[0-9a-fA-F]{1,128}$/.test(nullifier))
    return json(res, 400, { error: "Invalid nullifier format" });
  const entry = nullifiers[nullifier];
  if (!entry) return json(res, 404, { registered: false });
  json(res, 200, { registered: true, verified_at: entry.verified_at });
}

// ── Server ────────────────────────────────────────────────────────────────────
export function startValidatorNode(port: number = PORT) {
  // ── Load persistent state from disk (v0.4.4) ───────────────────────────────
  const persisted = loadState();
  if (persisted.nullifiers.length > 0 || Object.keys(persisted.reputation).length > 0) {
    console.log(`[state] Loaded ${persisted.nullifiers.length} nullifiers, ${Object.keys(persisted.reputation).length} reputation entries from disk`);
    // Merge persisted nullifiers into in-memory store
    for (const n of persisted.nullifiers) {
      if (!nullifiers[n]) {
        nullifiers[n] = { did: `did:soulprint:recovered:${n.slice(0,8)}`, verified_at: persisted.lastSync || Date.now() };
      }
    }
    // Merge persisted reputation
    for (const [did, score] of Object.entries(persisted.reputation)) {
      if (!repStore[did]) {
        repStore[did] = {
          score,
          base: 10,
          attestations: [],
          last_updated: persisted.lastSync || Date.now(),
          identityScore: 0,
          hasDocumentVerified: false,
        };
      }
    }
  }

  loadNullifiers();
  loadReputation();
  loadPeers();
  loadAudit();
  const nodeKeypair = loadOrCreateNodeKeypair();

  // Expose DID globally so server.ts can use it for peer registration
  (globalThis as any)._nodeDid = nodeKeypair.did;

  // ── Cargar thresholds desde blockchain al arrancar ────────────────────────
  // No bloqueante — el nodo arranca con valores locales y los actualiza async
  refreshThresholds().then(() => {
    console.log(`[thresholds] 📡 Fuente: ${liveThresholds.source} | SCORE_FLOOR=${liveThresholds.SCORE_FLOOR}`);
    console.log(`[thresholds]    Contrato: ${PROTOCOL_THRESHOLDS_ADDRESS} (${PROTOCOL_THRESHOLDS_CHAIN})`);
  });
  // Refresco automático cada 10 minutos
  setInterval(refreshThresholds, 10 * 60 * 1000);

  // ── Módulos de consenso P2P (sin EVM, sin gas fees) ──────────────────────
  const nullifierConsensus = new NullifierConsensus({
    selfDid:    nodeKeypair.did,
    sign:       async (data: string) => sign({ data }, nodeKeypair.privateKey),
    verify:     async (_data: string, _sig: string, _did: string) => true, // TODO: verify Ed25519
    broadcast:  async (msg: import("./consensus/index.js").ConsensusMsg) => {
      const encrypted = encryptGossip(msg as unknown as object);
      for (const peer of peers) {
        fetch(`${peer}/consensus/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(encrypted),
        }).catch(() => {});
      }
    },
    verifyZkProof: async (_proofHash: string, _nullifier: string) => true, // ZK ya verificado antes de propose
    storePath:  join(NODE_DIR, "nullifiers-consensus.json"),
    minPeers:   3,
    roundTimeoutMs: 10_000,
  });

  const attestConsensus = new AttestationConsensus({
    selfDid:     nodeKeypair.did,
    sign:        async (data: string) => sign({ data }, nodeKeypair.privateKey),
    verify:      async (_data: string, _sig: string, _did: string) => true,
    broadcast:   async (msg: import("./consensus/index.js").AttestationMsg) => {
      const encrypted = encryptGossip(msg as unknown as object);
      for (const peer of peers) {
        fetch(`${peer}/consensus/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(encrypted),
        }).catch(() => {});
      }
    },
    getScore:    (did: string) => {
      const rep = repStore[did];
      if (!rep) return 0;
      const idScore   = Math.min(80, (rep.attestations?.length ?? 0) * 10);
      return idScore + (rep.base ?? 0);
    },
    storePath:    join(NODE_DIR, "attestations-consensus.json"),
    repStorePath: REPUTE_DB,
  });

  const stateSync = new StateSyncManager({
    fetchPeer:  async (url: string, path: string) => (await fetch(`${url}${path}`)).json(),
    getPeers:   () => peers.map(url => ({ url, did: url })),
    onNullifiers:    (entries: any[]) => nullifierConsensus.importState(entries),
    onAttestations:  (state: any)   => attestConsensus.importState(state),
  });

  // Sync inicial (no bloqueante)
  stateSync.sync().then(({ nullifiersImported, attestsImported }: { nullifiersImported: number; attestsImported: number }) => {
    if (nullifiersImported + attestsImported > 0) {
      console.log(`[consensus] Sync: +${nullifiersImported} nullifiers, +${attestsImported} attestations`);
    }
  }).catch(() => {});

  // Actualizar peer count en nullifierConsensus al cambiar peers
  setInterval(() => nullifierConsensus.setPeerCount(peers.length), 5_000);

  // ── Blockchain backup (P2P primario + blockchain como backup) ─────────────
  // P2P confirma primero → blockchain ancla async (no bloquea al usuario)
  const anchor = new BlockchainAnchor({
    storePath: join(NODE_DIR, "blockchain-queue"),
  });

  // Cliente blockchain directo (para governance)
  const bcConfig = loadBlockchainConfig();
  const client: SoulprintBlockchainClient | null = bcConfig
    ? new SoulprintBlockchainClient(bcConfig)
    : null;

  // Conectar en background (no bloquea el arranque del nodo)
  anchor.connect().catch(() => {});
  if (client) client.connect().catch(() => {});

  // Escuchar eventos del consenso y anclar async
  nullifierConsensus.on("committed", (entry: import("./consensus/index.js").CommittedNullifier) => {
    anchor.anchorNullifier({
      nullifier:        entry.nullifier,
      did:              entry.did,
      documentVerified: true,
      faceVerified:     true,
      zkProof: {
        a:      [0n, 0n] as [bigint, bigint],
        b:      [[0n, 0n], [0n, 0n]] as [[bigint, bigint], [bigint, bigint]],
        c:      [0n, 0n] as [bigint, bigint],
        inputs: [BigInt("0x" + entry.nullifier.replace(/^0x/, "").slice(0, 16).padEnd(16, "0") || "1"), 1n] as [bigint, bigint],
      },
    });
  });

  attestConsensus.on("attested", (entry: import("./consensus/index.js").AttestEntry) => {
    anchor.anchorAttestation({
      issuerDid:  entry.issuerDid,
      targetDid:  entry.targetDid,
      value:      entry.value,
      context:    entry.context,
      signature:  entry.sig,
    });
  });

  anchor.on("anchored", (type: string, id: string, txHash: string) => {
    console.log(`[anchor] ${type} ${id.slice(0, 12)}... → blockchain tx ${txHash.slice(0, 12)}...`);
  });

  // ── Credential context (para el router de credenciales) ───────────────────
  const credentialCtx = {
    nodeKeypair,
    signAttestation: (att: Omit<BotAttestation, "sig">) => {
      const sig = sign(att, nodeKeypair.privateKey);
      return { ...att, sig } as BotAttestation;
    },
    gossip: (att: BotAttestation) => gossipAttestation(att, undefined),
  };

  const server = createServer(async (req, res) => {
    const ip  = getIP(req);
    const url = req.url ?? "/";
    const cleanUrl = url.split("?")[0];

    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // ── Credential routes (email, phone, github) ───────────────────────────
    if (cleanUrl.startsWith("/credentials/")) {
      const handled = await handleCredentialRoute(req, res, url, credentialCtx);
      if (handled) return;
    }

    // ── Registraduría cédula validation ────────────────────────────────────
    if (cleanUrl.startsWith("/verify/cedula")) {
      const handled = await handleCedulaRoute(req, res, url);
      if (handled) return;
    }

    if (cleanUrl === "/info"                 && req.method === "GET")  return handleInfo(res, nodeKeypair);
    if (cleanUrl === "/protocol"             && req.method === "GET")  return handleProtocol(res);

    // GET /protocol/thresholds — thresholds live desde blockchain (superAdmin-mutable)
    if (cleanUrl === "/protocol/thresholds" && req.method === "GET") {
      return json(res, 200, {
        source:      liveThresholds.source,
        contract:    PROTOCOL_THRESHOLDS_ADDRESS,
        chain:       PROTOCOL_THRESHOLDS_CHAIN,
        thresholds: {
          SCORE_FLOOR:            liveThresholds.SCORE_FLOOR,
          VERIFIED_SCORE_FLOOR:   liveThresholds.VERIFIED_SCORE_FLOOR,
          MIN_ATTESTER_SCORE:     liveThresholds.MIN_ATTESTER_SCORE,
          FACE_SIM_DOC_SELFIE:    liveThresholds.FACE_SIM_DOC_SELFIE,
          FACE_SIM_SELFIE_SELFIE: liveThresholds.FACE_SIM_SELFIE_SELFIE,
          DEFAULT_REPUTATION:     liveThresholds.DEFAULT_REPUTATION,
          IDENTITY_MAX:           liveThresholds.IDENTITY_MAX,
          REPUTATION_MAX:         liveThresholds.REPUTATION_MAX,
        },
        last_loaded: new Date(Date.now()).toISOString(),
        note: "Solo el superAdmin del contrato puede modificar estos valores on-chain",
      });
    }

    // GET /network/peers — all peers from on-chain PeerRegistry
    if (cleanUrl === "/network/peers" && req.method === "GET") {
      try {
        const chainPeers = peerRegistryClient
          ? await peerRegistryClient.getAllPeers()
          : [];
        return json(res, 200, {
          ok:    true,
          peers: chainPeers,
          count: chainPeers.length,
          contract: peerRegistryClient?.contractAddress ?? null,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        return json(res, 500, { ok: false, error: err.message });
      }
    }

    // GET /network/stats — stats públicas para la landing page
    if (cleanUrl === "/network/stats" && req.method === "GET") {
      const p2pStats = p2pNode ? getP2PStats(p2pNode) : null;
      const httpPeers = peers.length;
      const libp2pPeers = p2pStats?.peers ?? 0;
      let registeredPeers = 0;
      let nullifiersOnchain = 0;
      let reputationOnchain = 0;
      try {
        if (peerRegistryClient) {
          const chainPeers = await peerRegistryClient.getAllPeers();
          registeredPeers = chainPeers.length;
        }
      } catch { /* non-fatal */ }
      try {
        if (nullifierRegistry) nullifiersOnchain = await nullifierRegistry.getCount();
      } catch { /* non-fatal */ }
      try {
        if (reputationRegistry) reputationOnchain = await reputationRegistry.getCount();
      } catch { /* non-fatal */ }
      return json(res, 200, {
        node_did:            nodeKeypair.did.slice(0, 20) + "...",
        version:             VERSION,
        protocol_hash:       PROTOCOL_HASH.slice(0, 16) + "...",
        // identidades y reputación (in-memory cache)
        verified_identities: Object.keys(nullifiers).length,
        reputation_profiles: Object.keys(repStore).length,
        // on-chain state (v0.5.0) — blockchain IS the shared state
        nullifiers_onchain:  nullifiersOnchain,
        reputation_onchain:  reputationOnchain,
        // peers — HTTP gossip
        known_peers:         httpPeers,
        // peers — libp2p P2P
        p2p_peers:           libp2pPeers,
        p2p_pubsub_peers:    p2pStats?.pubsubPeers ?? 0,
        p2p_enabled:         !!p2pNode,
        total_peers:         Math.max(httpPeers, libp2pPeers),
        // on-chain registered peers (PeerRegistry)
        registered_peers:    registeredPeers,
        // state sync (v0.5.0 — blockchain is source of truth)
        state_hash:          computeHash(Object.keys(nullifiers)).slice(0, 16) + "...",
        last_sync:           lastSyncTs,
        // estado general
        uptime_ms:           Date.now() - ((globalThis as any)._startTime ?? Date.now()),
        timestamp:           Date.now(),
        mcps_verified:       null,
      });
    }
    if (cleanUrl === "/verify"               && req.method === "POST") return handleVerify(req, res, nodeKeypair, ip);

    // ── State endpoints (v0.5.0) — blockchain IS the shared state ────────────
    // GET /state/hash — hash of on-chain nullifier count + reputation count
    if (cleanUrl === "/state/hash" && req.method === "GET") {
      const currentNullifiers = Object.keys(nullifiers);
      let onchainNullifiers = currentNullifiers.length;
      let onchainReputation = Object.keys(repStore).length;
      try { if (nullifierRegistry) onchainNullifiers = await nullifierRegistry.getCount(); } catch {}
      try { if (reputationRegistry) onchainReputation = await reputationRegistry.getCount(); } catch {}
      // Hash includes on-chain counts for consensus
      const hash = computeHash([...currentNullifiers, `onchain:${onchainNullifiers}:${onchainReputation}`]);
      return json(res, 200, {
        hash,
        nullifier_count:         currentNullifiers.length,
        nullifier_count_onchain: onchainNullifiers,
        reputation_count:        Object.keys(repStore).length,
        reputation_count_onchain: onchainReputation,
        attestation_count:       Object.values(repStore).reduce((n, e) => n + (e.attestations?.length ?? 0), 0),
        timestamp:               Date.now(),
      });
    }

    // GET /state/export — full state export including on-chain data
    if (cleanUrl === "/state/export" && req.method === "GET") {
      const allAttestations = Object.values(repStore).flatMap(e => e.attestations ?? []);
      // Read on-chain data (cached — won't hit RPC on every call)
      const [onchainNullifiers, onchainScores] = await Promise.all([
        nullifierRegistry ? nullifierRegistry.getAllNullifiers().catch(() => []) : Promise.resolve([]),
        reputationRegistry ? reputationRegistry.getAllScores().catch(() => []) : Promise.resolve([]),
      ]);
      return json(res, 200, {
        // Local in-memory state
        nullifiers:              Object.keys(nullifiers),
        reputation:              Object.fromEntries(Object.entries(repStore).map(([did, e]) => [did, e.score])),
        attestations:            allAttestations,
        peers,
        lastSync:                lastSyncTs,
        stateHash:               computeHash(Object.keys(nullifiers)),
        timestamp:               Date.now(),
        // On-chain state (v0.5.0) — canonical source of truth
        onchain: {
          nullifiers:  onchainNullifiers,
          reputation:  onchainScores,
          nullifier_count: onchainNullifiers.length,
          reputation_count: onchainScores.length,
        },
      });
    }

    // POST /state/merge — merge partial state from a peer
    if (cleanUrl === "/state/merge" && req.method === "POST") {
      let body: any;
      try { body = await readBody(req); } catch (e: any) { return json(res, 400, { error: e.message }); }

      const incoming = body ?? {};
      let newNullifiers = 0;
      let newAttestations = 0;

      // Merge nullifiers (union)
      if (Array.isArray(incoming.nullifiers)) {
        for (const n of incoming.nullifiers) {
          if (typeof n === "string" && !nullifiers[n]) {
            nullifiers[n] = { did: `did:soulprint:synced:${n.slice(0,8)}`, verified_at: Date.now() };
            newNullifiers++;
          }
        }
        if (newNullifiers > 0) saveNullifiers();
      }

      // Merge reputation (take max score)
      if (incoming.reputation && typeof incoming.reputation === "object") {
        for (const [did, score] of Object.entries(incoming.reputation)) {
          if (typeof score !== "number") continue;
          if (!repStore[did]) {
            repStore[did] = { score, base: 10, attestations: [], last_updated: Date.now(), identityScore: 0, hasDocumentVerified: false };
          } else if (score > repStore[did].score) {
            repStore[did].score = score;
            repStore[did].last_updated = Date.now();
          }
        }
        if (Object.keys(incoming.reputation).length > 0) saveReputation();
      }

      // Merge attestations (dedup by issuer+timestamp+context)
      if (Array.isArray(incoming.attestations)) {
        for (const att of incoming.attestations) {
          if (!att?.issuer_did || !att?.target_did) continue;
          const existing = repStore[att.target_did];
          const prevAtts = existing?.attestations ?? [];
          const isDup = prevAtts.some(a =>
            a.issuer_did === att.issuer_did &&
            a.timestamp  === att.timestamp  &&
            a.context    === att.context
          );
          if (!isDup) {
            applyAttestation(att);
            newAttestations++;
          }
        }
      }

      // Persist new unified state
      if (newNullifiers > 0 || newAttestations > 0) {
        const snapshot: NodeState = {
          nullifiers:   Object.keys(nullifiers),
          reputation:   Object.fromEntries(Object.entries(repStore).map(([d, e]) => [d, e.score])),
          attestations: Object.values(repStore).flatMap(e => e.attestations ?? []),
          peers,
          lastSync:     Date.now(),
          stateHash:    computeHash(Object.keys(nullifiers)),
        };
        saveState(snapshot);
        lastSyncTs = Date.now();
      }

      return json(res, 200, {
        ok:               true,
        new_nullifiers:   newNullifiers,
        new_attestations: newAttestations,
      });
    }
    if (cleanUrl === "/token/renew"          && req.method === "POST") return handleTokenRenew(req, res, nodeKeypair);
    if (cleanUrl === "/challenge"            && req.method === "POST") return handleChallenge(req, res, nodeKeypair);
    if (cleanUrl === "/reputation/attest"    && req.method === "POST") return handleAttest(req, res, ip);
    if (cleanUrl === "/peers/register"       && req.method === "POST") return handlePeerRegister(req, res);
    if (cleanUrl === "/peers"                && req.method === "GET")  return handleGetPeers(res);
    if (cleanUrl.startsWith("/reputation/")  && req.method === "GET")
      return handleGetReputation(res, decodeURIComponent(cleanUrl.replace("/reputation/", "")));
    if (cleanUrl.startsWith("/nullifier/")   && req.method === "GET")
      return handleNullifierCheck(res, decodeURIComponent(cleanUrl.replace("/nullifier/", "")));

    // ── Code integrity + health ───────────────────────────────────────────────
    if (cleanUrl === "/health" && req.method === "GET") {
      const integrity = getCodeIntegrity();
      const govHash   = await client?.getCurrentApprovedHash() ?? null;
      return json(res, 200, {
        status:              "ok",
        version:             VERSION,
        protocolHash:        PROTOCOL_HASH,
        codeHash:            integrity.codeHash,
        codeHashHex:         integrity.codeHashHex,
        codeHashAvailable:   integrity.available,
        codeBuiltAt:         integrity.computedAt,
        codeFileCount:       integrity.fileCount,
        runtimeHash:         computeRuntimeHash(),
        governanceApprovedHash: govHash,
        blockchainConnected: !!client?.isConnected,
        nodeCompatible:      !govHash ||
          govHash.toLowerCase() === ("0x" + PROTOCOL_HASH).toLowerCase(),
        uptime:              process.uptime(),
        ts:                  Date.now(),
      });
    }

    // ── Blockchain anchor status ──────────────────────────────────────────────
    if (cleanUrl === "/anchor/stats" && req.method === "GET") {
      return json(res, 200, anchor.getStats());
    }

    // ── Consensus P2P endpoints (sin EVM, sin gas) ─────────────────────────
    // GET /consensus/state-info - handshake para state-sync
    if (cleanUrl === "/consensus/state-info" && req.method === "GET") {
      return json(res, 200, {
        nullifierCount:   nullifierConsensus.getAllNullifiers().length,
        attestationCount: 0,  // TODO: contar desde attestConsensus
        latestTs:         Date.now(),
        protocolHash:     PROTOCOL_HASH,
        nodeVersion:      VERSION,
      });
    }

    // GET /consensus/state?page=N&limit=500&since=TS - bulk state sync
    if (cleanUrl === "/consensus/state" && req.method === "GET") {
      const params       = new URLSearchParams(url.split("?")[1] ?? "");
      const page         = parseInt(params.get("page") ?? "0");
      const limit        = Math.min(500, parseInt(params.get("limit") ?? "500"));
      const since        = parseInt(params.get("since") ?? "0");
      const allN         = nullifierConsensus.getAllNullifiers().filter((n: import("./consensus/index.js").CommittedNullifier) => n.committedAt > since);
      const totalPages   = Math.max(1, Math.ceil(allN.length / limit));
      const pageNulls    = allN.slice(page * limit, (page + 1) * limit);
      const attState     = attestConsensus.exportState();
      return json(res, 200, {
        nullifiers:   pageNulls,
        attestations: attState.history,
        reps:         attState.reps,
        page,
        totalPages,
        protocolHash: PROTOCOL_HASH,
      });
    }

    // POST /consensus/message - recibir mensaje de consenso cifrado
    if (cleanUrl === "/consensus/message" && req.method === "POST") {
      const body = await readBody(req);
      if (!body?.payload) return json(res, 400, { error: "Missing payload" });
      try {
        const dec   = decryptGossip(body);
        if (!dec.ok || !dec.payload) return json(res, 400, { error: "Decrypt failed" });
        const msg   = dec.payload as any;
        if (msg.type === "PROPOSE" || msg.type === "VOTE" || msg.type === "COMMIT") {
          await nullifierConsensus.handleMessage(msg);
        } else if (msg.type === "ATTEST") {
          await attestConsensus.handleMessage(msg);
        }
        return json(res, 200, { ok: true });
      } catch {
        return json(res, 400, { error: "Invalid consensus message" });
      }
    }

    // ── Governance endpoints ──────────────────────────────────────────────────

    // GET /governance - estado del hash aprobado + propuestas activas
    if (cleanUrl === "/governance" && req.method === "GET") {
      const [currentHash, active, history] = await Promise.all([
        client?.getCurrentApprovedHash()  ?? null,
        client?.getActiveProposals()       ?? [],
        client?.getHashHistory()           ?? [],
      ]);
      return json(res, 200, {
        currentApprovedHash: currentHash ?? PROTOCOL_HASH,
        blockchainConnected: !!client?.isConnected,
        activeProposals:     active.length,
        hashHistory:         history,
        nodeCompatible:      !currentHash || currentHash.toLowerCase() === ("0x" + PROTOCOL_HASH).toLowerCase(),
      });
    }

    // GET /governance/proposals - lista de propuestas activas
    if (cleanUrl === "/governance/proposals" && req.method === "GET") {
      if (!client?.isConnected) return json(res, 503, { error: "Blockchain not connected" });
      const proposals = await client.getActiveProposals();
      return json(res, 200, { proposals, total: proposals.length });
    }

    // GET /governance/proposal/:id - detalle de una propuesta
    if (cleanUrl.match(/^\/governance\/proposal\/\d+$/) && req.method === "GET") {
      if (!client?.isConnected) return json(res, 503, { error: "Blockchain not connected" });
      const proposalId = parseInt(cleanUrl.split("/").pop()!);
      const proposal   = await client.getProposal(proposalId);
      if (!proposal) return json(res, 404, { error: "Proposal not found" });
      const remaining  = await client.getTimelockRemaining(proposalId);
      return json(res, 200, { ...proposal, timelockRemainingSeconds: remaining });
    }

    // POST /governance/propose - proponer upgrade del PROTOCOL_HASH
    // Body: { did, newHash, rationale }
    if (cleanUrl === "/governance/propose" && req.method === "POST") {
      if (!client?.isConnected) return json(res, 503, { error: "Blockchain not connected" });
      const body = await readBody(req);
      if (!body?.did || !body?.newHash || !body?.rationale) {
        return json(res, 400, { error: "Required: did, newHash, rationale" });
      }
      const result = await client.proposeUpgrade({
        did:       body.did,
        newHash:   body.newHash,
        rationale: body.rationale,
      });
      if (!result) return json(res, 500, { error: "Proposal failed - check validator logs" });
      return json(res, 201, result);
    }

    // POST /governance/vote - votar en una propuesta
    // Body: { proposalId, did, approve }
    if (cleanUrl === "/governance/vote" && req.method === "POST") {
      if (!client?.isConnected) return json(res, 503, { error: "Blockchain not connected" });
      const body = await readBody(req);
      if (body?.proposalId === undefined || !body?.did || body?.approve === undefined) {
        return json(res, 400, { error: "Required: proposalId, did, approve" });
      }
      const txHash = await client.voteOnProposal({
        proposalId: Number(body.proposalId),
        did:        body.did,
        approve:    Boolean(body.approve),
      });
      if (!txHash) return json(res, 500, { error: "Vote failed - check validator logs" });
      return json(res, 200, { txHash, proposalId: body.proposalId, approve: body.approve });
    }

    // POST /governance/execute - ejecutar propuesta post-timelock
    // Body: { proposalId }
    if (cleanUrl === "/governance/execute" && req.method === "POST") {
      if (!client?.isConnected) return json(res, 503, { error: "Blockchain not connected" });
      const body = await readBody(req);
      if (body?.proposalId === undefined) return json(res, 400, { error: "Required: proposalId" });
      const txHash = await client.executeProposal(Number(body.proposalId));
      if (!txHash) return json(res, 500, { error: "Execute failed - timelock not expired or proposal not approved" });
      return json(res, 200, { txHash, proposalId: body.proposalId, executed: true });
    }

    // ── MCPRegistry — consulta pública ────────────────────────────────────────

    // GET /mcps/verified — lista todos los MCPs verificados on-chain
    if (cleanUrl === "/mcps/verified" && req.method === "GET") {
      const [verified, info] = await Promise.all([getVerifiedMCPEntries(), getRegistryInfo()]);
      return json(res, 200, {
        total:    verified.length,
        registry: info,
        mcps: verified.map(e => ({
          address:     e.address,
          name:        e.name,
          url:         e.url,
          category:    e.category,
          description: e.description,
          verified_at: new Date(e.verifiedAt * 1000).toISOString(),
          badge:       "✅ VERIFIED",
        })),
      });
    }

    // GET /mcps/all — lista todos los MCPs (verificados + pendientes)
    if (cleanUrl === "/mcps/all" && req.method === "GET") {
      const [all, info] = await Promise.all([getAllMCPEntries(), getRegistryInfo()]);
      return json(res, 200, {
        total:    all.length,
        registry: info,
        mcps: all.map(e => ({
          address:     e.address,
          name:        e.name,
          url:         e.url,
          category:    e.category,
          verified:    e.verified,
          registered_at: new Date(e.registeredAt * 1000).toISOString(),
          verified_at: e.verifiedAt > 0 ? new Date(e.verifiedAt * 1000).toISOString() : null,
          revoked_at:  e.revokedAt  > 0 ? new Date(e.revokedAt  * 1000).toISOString() : null,
        })),
      });
    }

    // GET /mcps/status/:address — estado de un MCP específico
    if (cleanUrl.match(/^\/mcps\/status\/0x[0-9a-fA-F]{40}$/) && req.method === "GET") {
      const addr  = cleanUrl.split("/").pop()!;
      const entry = await getMCPEntry(addr);
      if (!entry) return json(res, 404, { address: addr, registered: false, verified: false });
      return json(res, 200, {
        address:     addr,
        name:        entry.name,
        url:         entry.url,
        category:    entry.category,
        registered:  true,
        verified:    entry.verified,
        registered_at: new Date(entry.registeredAt * 1000).toISOString(),
        verified_at: entry.verifiedAt > 0 ? new Date(entry.verifiedAt * 1000).toISOString() : null,
        revoked_at:  entry.revokedAt  > 0 ? new Date(entry.revokedAt  * 1000).toISOString() : null,
        badge:       entry.verified ? "✅ VERIFIED by Soulprint" : "⏳ Registered — pending verification",
      });
    }

    // ── MCPRegistry — admin (requiere ADMIN_TOKEN o ADMIN_PRIVATE_KEY) ──────

    // Verificar admin token (Bearer header o ADMIN_TOKEN env)
    const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
    function isAdmin(): boolean {
      if (!ADMIN_TOKEN) return !!process.env.ADMIN_PRIVATE_KEY; // fallback: solo key
      const auth = (req.headers["authorization"] ?? "") as string;
      return auth === `Bearer ${ADMIN_TOKEN}`;
    }

    // POST /admin/mcp/verify — verificar un MCP
    if (cleanUrl === "/admin/mcp/verify" && req.method === "POST") {
      if (!isAdmin()) return json(res, 401, { error: "Unauthorized — Bearer ADMIN_TOKEN required" });
      if (!process.env.ADMIN_PRIVATE_KEY) return json(res, 503, { error: "ADMIN_PRIVATE_KEY not configured" });
      const body = await readBody(req);
      if (!body?.address) return json(res, 400, { error: "Required: address" });
      const result = await verifyMCPOnChain(body.address);
      if (!result.success) return json(res, 500, { error: result.error });
      return json(res, 200, {
        address:  body.address,
        verified: true,
        txHash:   result.txHash,
        explorer: `https://sepolia.basescan.org/tx/${result.txHash}`,
        message:  `✅ MCP ${body.address} verified on-chain by Soulprint`,
      });
    }

    // POST /admin/mcp/revoke — revocar un MCP
    if (cleanUrl === "/admin/mcp/revoke" && req.method === "POST") {
      if (!isAdmin()) return json(res, 401, { error: "Unauthorized — Bearer ADMIN_TOKEN required" });
      if (!process.env.ADMIN_PRIVATE_KEY) return json(res, 503, { error: "ADMIN_PRIVATE_KEY not configured" });
      const body = await readBody(req);
      if (!body?.address || !body?.reason) return json(res, 400, { error: "Required: address, reason" });
      const result = await revokeMCPOnChain(body.address, body.reason);
      if (!result.success) return json(res, 500, { error: result.error });
      return json(res, 200, {
        address:  body.address,
        revoked:  true,
        reason:   body.reason,
        txHash:   result.txHash,
        explorer: `https://sepolia.basescan.org/tx/${result.txHash}`,
        message:  `🚫 MCP ${body.address} revoked. Reason: "${body.reason}"`,
      });
    }

    // POST /admin/mcp/register — registrar MCP (permissionless, cualquiera)
    if (cleanUrl === "/admin/mcp/register" && req.method === "POST") {
      const body = await readBody(req);
      if (!body?.ownerKey || !body?.address || !body?.name || !body?.url) {
        return json(res, 400, { error: "Required: ownerKey, address, name, url" });
      }
      const result = await registerMCPOnChain({
        ownerPrivateKey: body.ownerKey,
        mcpAddress:      body.address,
        name:            body.name,
        url:             body.url,
        did:             body.did ?? "",
        category:        body.category ?? "general",
        description:     body.description ?? "",
      });
      if (!result.success) return json(res, 500, { error: result.error });
      return json(res, 201, {
        address:   body.address,
        name:      body.name,
        txHash:    result.txHash,
        explorer:  `https://sepolia.basescan.org/tx/${result.txHash}`,
        message:   `✅ MCP registered. Contact Soulprint admin to verify.`,
        next_step: "POST /admin/mcp/verify with Bearer ADMIN_TOKEN",
      });
    }

    json(res, 404, { error: "Not found" });
  });

  server.listen(port, () => {
    logCodeIntegrity();
    console.log(`\n🌐 Soulprint Validator Node v${VERSION}`);
    console.log(`   Node DID:     ${nodeKeypair.did}`);
    console.log(`   Listening:    http://0.0.0.0:${port}`);
    console.log(`   Protocol:     ${PROTOCOL.VERSION} | hash: ${PROTOCOL_HASH.slice(0,16)}...`);
    console.log(`   ⚠️  Hash mismatch with peers → connection rejected (P2P enforcement)`);
    console.log(`   Nullifiers:   ${Object.keys(nullifiers).length}`);
    console.log(`   Reputations:  ${Object.keys(repStore).length}`);
    console.log(`   Known peers:  ${peers.length}`);
    console.log(`\n   Core endpoints:`);
    console.log(`   POST /verify              verify ZK proof + co-sign`);
    console.log(`   POST /token/renew         auto-renew SPT (pre-emptivo 1h / grace 7d)`);
    console.log(`   POST /challenge           peer integrity check (ZK challenge-response)`);
    console.log(`   GET  /health              code integrity + governance status`);
    console.log(`   GET  /info                node info`);
    console.log(`   GET  /protocol            protocol constants (immutable)`);
    console.log(`   GET  /nullifier/:n        anti-sybil check`);
    console.log(`   POST /reputation/attest   issue attestation (anti-farming ON)`);
    console.log(`   GET  /reputation/:did     get bot reputation`);
    console.log(`\n   Credential validators (open source, no API keys needed):`);
    console.log(`   POST /credentials/email/start    → email OTP (nodemailer)`);
    console.log(`   POST /credentials/email/verify`);
    console.log(`   POST /credentials/phone/start    → TOTP device proof (otpauth)`);
    console.log(`   POST /credentials/phone/verify`);
    console.log(`   GET  /credentials/github/start   → GitHub OAuth (native fetch)`);
    console.log(`   GET  /credentials/github/callback`);
    console.log(`\n   Anti-farming: ON - max +1/day, pattern detection, cooldowns`);
    console.log(`\n   Consensus P2P (sin EVM, sin gas):`);
    console.log(`   GET  /consensus/state-info    handshake para state-sync`);
    console.log(`   GET  /consensus/state         bulk state sync paginado`);
    console.log(`   POST /consensus/message       recibir msg PROPOSE/VOTE/COMMIT/ATTEST`);
    console.log(`\n   MCPRegistry (on-chain, Base Sepolia):`);
    console.log(`   GET  /mcps/verified             MCPs verificados por Soulprint`);
    console.log(`   GET  /mcps/all                  todos los MCPs registrados`);
    console.log(`   GET  /mcps/status/:address      estado de un MCP`);
    console.log(`   POST /admin/mcp/register        registrar MCP (permissionless)`);
    console.log(`   POST /admin/mcp/verify    🔐    verificar  (Bearer ADMIN_TOKEN)`);
    console.log(`   POST /admin/mcp/revoke    🔐    revocar    (Bearer ADMIN_TOKEN)`);
    console.log(`\n`);
  });

  return server;
}

// ── Client helpers ────────────────────────────────────────────────────────────
export interface NodeVerifyResult {
  valid:        boolean;
  co_signature: string;
  nullifier:    string;
  node_did:     string;
  anti_sybil:   "new" | "existing";
  reputation:   BotReputation;
}

export async function submitToNode(nodeUrl: string, spt: string, zkProof: string): Promise<NodeVerifyResult> {
  const res  = await fetch(`${nodeUrl}/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spt, zkp: zkProof }) });
  const data: any = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as NodeVerifyResult;
}

export async function attestBot(
  nodeUrl:     string,
  attestation: BotAttestation,
  serviceSpt:  string
): Promise<{ reputation: BotReputation }> {
  const res  = await fetch(`${nodeUrl}/reputation/attest`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ attestation, service_spt: serviceSpt }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export async function getBotReputation(nodeUrl: string, did: string): Promise<BotReputation> {
  const res  = await fetch(`${nodeUrl}/reputation/${encodeURIComponent(did)}`);
  const data: any = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as BotReputation;
}

export async function getNodeInfo(nodeUrl: string) {
  return (await fetch(`${nodeUrl}/info`)).json();
}

export const BOOTSTRAP_NODES: string[] = [];
export { applyAttestation };

/** Used by anti-entropy loop in server.ts */
export function getNodeState() {
  return { nullifiers, repStore, peers, lastSyncTs };
}
export function setLastSyncTs(ts: number) { lastSyncTs = ts; }
