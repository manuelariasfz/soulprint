import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join }     from "node:path";
import { homedir }  from "node:os";
import {
  generateKeypair, keypairFromPrivateKey, SoulprintKeypair,
  decodeToken, sign,
  BotAttestation, BotReputation,
  verifyAttestation, computeReputation, defaultReputation,
  PROTOCOL, PROTOCOL_HASH, isProtocolCompatible, isProtocolHashCompatible, computeTotalScoreWithFloor,
  checkFarming, recordApprovedGain, recordFarmingStrike,
  loadAuditStore, exportAuditStore,
  SessionContext, FARMING_RULES,
} from "soulprint-core";
import { verifyProof, deserializeProof } from "soulprint-zkp";
import { handleCredentialRoute } from "./credentials/index.js";
import {
  publishAttestationP2P,
  onAttestationReceived,
  getP2PStats,
  type SoulprintP2PNode,
} from "./p2p.js";

// ── Config ────────────────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.SOULPRINT_PORT ?? String(PROTOCOL.DEFAULT_HTTP_PORT));
const NODE_DIR     = join(homedir(), ".soulprint", "node");
const KEYPAIR_FILE = join(NODE_DIR, "node-identity.json");
const NULLIFIER_DB = join(NODE_DIR, "nullifiers.json");
const REPUTE_DB    = join(NODE_DIR, "reputation.json");
const PEERS_DB     = join(NODE_DIR, "peers.json");
const AUDIT_DB     = join(NODE_DIR, "audit.json");
const VERSION      = "0.2.0";

const MAX_BODY_BYTES       = 64 * 1024;
// ── Protocol constants (inamovibles — no cambiar directamente aquí) ───────────
const RATE_LIMIT_MS        = PROTOCOL.RATE_LIMIT_WINDOW_MS;
const RATE_LIMIT_MAX       = PROTOCOL.RATE_LIMIT_MAX;
const CLOCK_SKEW_MAX       = PROTOCOL.CLOCK_SKEW_MAX_SECONDS;
const MIN_ATTESTER_SCORE   = PROTOCOL.MIN_ATTESTER_SCORE;  // 65 — inamovible
const ATT_MAX_AGE_SECONDS  = PROTOCOL.ATT_MAX_AGE_SECONDS;
const GOSSIP_TIMEOUT_MS    = PROTOCOL.GOSSIP_TIMEOUT_MS;

// ── P2P Node (Phase 5) ────────────────────────────────────────────────────────
let p2pNode: SoulprintP2PNode | null = null;

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
      console.warn(`[p2p] Attestation inválida de peer ${fromPeer.slice(0, 16)}... — descartada`);
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
 * Persisted to disk — survives node restarts.
 */
interface ReputeEntry {
  score:               number;
  base:                number;          // score base calculado desde attestations
  attestations:        BotAttestation[];
  last_updated:        number;
  identityScore:       number;          // sub-score de identidad — para calcular floor
  hasDocumentVerified: boolean;         // si tiene DocumentVerified — activa VERIFIED_SCORE_FLOOR
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
 *   debajo de PROTOCOL.VERIFIED_SCORE_FLOOR (52) — inamovible.
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
    const minRepForFloor = Math.max(0, PROTOCOL.VERIFIED_SCORE_FLOOR - identityFromStore);
    finalRepScore = Math.max(finalRepScore, minRepForFloor);
    if (finalRepScore !== rep.score) {
      console.log(
        `[floor] Reputation clamped for ${att.target_did.slice(0,20)}...: ` +
        `${rep.score} → ${finalRepScore} (VERIFIED_SCORE_FLOOR=${PROTOCOL.VERIFIED_SCORE_FLOOR})`
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
  return { score: finalRepScore, attestations: allAtts.length, last_updated: rep.last_updated };
}

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
 *  1. P2P GossipSub (Phase 5) — si el nodo libp2p está activo
 *  2. HTTP fire-and-forget (Phase 3) — fallback para nodos legacy sin libp2p
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

  // ── Canal 2: HTTP gossip (fallback para nodos legacy) ─────────────────────
  // Incluye X-Protocol-Hash para que el peer receptor valide compatibilidad.
  const targets = peers.filter(p => p !== excludeUrl);
  for (const peerUrl of targets) {
    fetch(`${peerUrl}/reputation/attest`, {
      method:  "POST",
      headers: {
        "Content-Type":    "application/json",
        "X-Gossip":        "1",
        "X-Protocol-Hash": PROTOCOL_HASH,   // ← el receptor valida esto
      },
      body:    JSON.stringify({ attestation: att, from_peer: true }),
      signal:  AbortSignal.timeout(GOSSIP_TIMEOUT_MS),
    }).catch(() => { /* peer unreachable — ignore */ });
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
 *  2. Obtener los valores actuales de SCORE_FLOOR y MIN_ATTESTER_SCORE
 *  3. Validar que el nodo no ha sido modificado para bajar los thresholds
 */
function handleProtocol(res: ServerResponse) {
  json(res, 200, {
    protocol_version:      PROTOCOL.VERSION,
    // ── Protocol Hash — IDENTIDAD DE LA RED ────────────────────────────────
    // Cualquier nodo con un hash diferente es rechazado automáticamente.
    // Si PROTOCOL fue modificado (aunque sea un valor), este hash cambia.
    protocol_hash:         PROTOCOL_HASH,
    // ── Score limits ────────────────────────────────────────────────────────
    score_floor:           PROTOCOL.SCORE_FLOOR,
    verified_score_floor:  PROTOCOL.VERIFIED_SCORE_FLOOR,
    min_attester_score:    PROTOCOL.MIN_ATTESTER_SCORE,
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
 *   1. service_spt tiene score >= MIN_ATTESTER_SCORE (solo servicios verificados)
 *   2. service_spt.did == attestation.issuer_did (el emisor es quien dice ser)
 *   3. Firma Ed25519 de la attestation es válida
 *   4. timestamp no tiene más de ATT_MAX_AGE_SECONDS de antigüedad
 *   5. value es exactamente +1 o -1
 */
async function handleAttest(req: IncomingMessage, res: ServerResponse, ip: string) {
  if (!checkRateLimit(ip)) return json(res, 429, { error: "Rate limit exceeded" });

  let body: any;
  try { body = await readBody(req); } catch (e: any) { return json(res, 400, { error: e.message }); }

  const { attestation, service_spt, from_peer } = body ?? {};
  if (!attestation) return json(res, 400, { error: "Missing field: attestation" });

  // ── Protocol Hash Enforcement (gossip desde peers) ────────────────────────
  // Si la attestation viene de un peer (X-Gossip: 1), validamos que el peer
  // opera con las mismas constantes de protocolo.
  // Un nodo con constantes modificadas no puede inyectar attestations en la red.
  if (from_peer) {
    const peerHash = req.headers["x-protocol-hash"] as string | undefined;
    if (peerHash && !isProtocolHashCompatible(peerHash)) {
      console.warn(`[protocol] Gossip rechazado de ${ip} — hash incompatible: ${peerHash?.slice(0,16)}...`);
      return json(res, 409, {
        error:       "Protocol mismatch — gossip rejected",
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
    if (!service_spt) return json(res, 401, { error: "Missing service_spt — only verified services can attest" });

    const serviceTok = decodeToken(service_spt);
    if (!serviceTok) return json(res, 401, { error: "Invalid or expired service_spt" });
    if (serviceTok.score < MIN_ATTESTER_SCORE) {
      return json(res, 403, {
        error:     `Service score too low (${serviceTok.score} < ${MIN_ATTESTER_SCORE})`,
        required:  MIN_ATTESTER_SCORE,
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
      events:    [],  // no tenemos eventos individuales aquí — se evalúa en withTracking()
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

// ── POST /peers/register ──────────────────────────────────────────────────────
async function handlePeerRegister(req: IncomingMessage, res: ServerResponse) {
  let body: any;
  try { body = await readBody(req); } catch (e: any) { return json(res, 400, { error: e.message }); }

  const { url, protocol_hash } = body ?? {};
  if (!url || typeof url !== "string") return json(res, 400, { error: "Missing field: url" });
  if (!/^https?:\/\//.test(url))       return json(res, 400, { error: "url must start with http:// or https://" });

  // ── Protocol Hash Enforcement — INAMOVIBLE POR LA RED ────────────────────
  // Si el peer envía un hash, DEBE coincidir con el nuestro.
  // Si no envía hash → se acepta (nodos legacy / primeras versiones).
  // En versiones futuras, el hash será OBLIGATORIO.
  if (protocol_hash && !isProtocolHashCompatible(protocol_hash)) {
    return json(res, 409, {
      error:                  "Protocol mismatch — node rejected",
      reason:                 "The peer is running with different protocol constants. This breaks network consensus.",
      our_hash:               PROTOCOL_HASH,
      their_hash:             protocol_hash,
      our_version:            PROTOCOL.VERSION,
      resolution:             "Update soulprint-network to the latest version, or join a compatible network.",
    });
  }

  if (peers.includes(url)) return json(res, 200, { ok: true, peers: peers.length, msg: "Already registered" });

  peers.push(url);
  savePeers();
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
  loadNullifiers();
  loadReputation();
  loadPeers();
  loadAudit();
  const nodeKeypair = loadOrCreateNodeKeypair();

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

    if (cleanUrl === "/info"                 && req.method === "GET")  return handleInfo(res, nodeKeypair);
    if (cleanUrl === "/protocol"             && req.method === "GET")  return handleProtocol(res);
    if (cleanUrl === "/verify"               && req.method === "POST") return handleVerify(req, res, nodeKeypair, ip);
    if (cleanUrl === "/reputation/attest"    && req.method === "POST") return handleAttest(req, res, ip);
    if (cleanUrl === "/peers/register"       && req.method === "POST") return handlePeerRegister(req, res);
    if (cleanUrl === "/peers"                && req.method === "GET")  return handleGetPeers(res);
    if (cleanUrl.startsWith("/reputation/")  && req.method === "GET")
      return handleGetReputation(res, decodeURIComponent(cleanUrl.replace("/reputation/", "")));
    if (cleanUrl.startsWith("/nullifier/")   && req.method === "GET")
      return handleNullifierCheck(res, decodeURIComponent(cleanUrl.replace("/nullifier/", "")));

    json(res, 404, { error: "Not found" });
  });

  server.listen(port, () => {
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
    console.log(`\n   Anti-farming: ON — max +1/day, pattern detection, cooldowns\n`);
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
