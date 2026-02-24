import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join }     from "node:path";
import { homedir }  from "node:os";
import {
  generateKeypair, keypairFromPrivateKey, SoulprintKeypair,
  decodeToken, sign,
  BotAttestation, BotReputation,
  verifyAttestation, computeReputation, defaultReputation,
} from "soulprint-core";
import { verifyProof, deserializeProof } from "soulprint-zkp";

// ── Config ────────────────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.SOULPRINT_PORT ?? "4888");
const NODE_DIR     = join(homedir(), ".soulprint", "node");
const KEYPAIR_FILE = join(NODE_DIR, "node-identity.json");
const NULLIFIER_DB = join(NODE_DIR, "nullifiers.json");
const REPUTE_DB    = join(NODE_DIR, "reputation.json");
const PEERS_DB     = join(NODE_DIR, "peers.json");
const VERSION      = "0.1.2";

const MAX_BODY_BYTES       = 64 * 1024;
const RATE_LIMIT_MS        = 60_000;
const RATE_LIMIT_MAX       = 10;
const CLOCK_SKEW_MAX       = 300;        // ±5 min
const MIN_ATTESTER_SCORE   = 60;         // solo servicios verificados emiten attestations
const ATT_MAX_AGE_SECONDS  = 3600;       // attestation no puede tener >1h de antigüedad
const GOSSIP_TIMEOUT_MS    = 3_000;      // timeout del gossip P2P

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
  score:        number;
  base:         number;          // score base calculado desde attestations
  attestations: BotAttestation[];
  last_updated: number;
}
let repStore: Record<string, ReputeEntry> = {};

function loadReputation() {
  if (existsSync(REPUTE_DB)) try { repStore = JSON.parse(readFileSync(REPUTE_DB, "utf8")); } catch { repStore = {}; }
}
function saveReputation() { writeFileSync(REPUTE_DB, JSON.stringify(repStore, null, 2)); }

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

  repStore[att.target_did] = {
    score:        rep.score,
    base:         10,
    attestations: allAtts,
    last_updated: rep.last_updated,
  };
  saveReputation();
  return rep;
}

// ── Peers registry (P2P gossip) ───────────────────────────────────────────────
let peers: string[] = [];   // URLs de otros nodos (ej: "http://node2.example.com:4888")

function loadPeers() {
  if (existsSync(PEERS_DB)) try { peers = JSON.parse(readFileSync(PEERS_DB, "utf8")); } catch { peers = []; }
}
function savePeers() { writeFileSync(PEERS_DB, JSON.stringify(peers, null, 2)); }

/**
 * Gossip: reenvía la attestation a todos los peers conocidos de forma async.
 * Fire-and-forget — no bloquea la respuesta al cliente.
 * Si un peer falla, se ignora silenciosamente (eventual consistency).
 */
function gossipAttestation(att: BotAttestation, excludeUrl?: string) {
  const targets = peers.filter(p => p !== excludeUrl);
  for (const peerUrl of targets) {
    fetch(`${peerUrl}/reputation/attest`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "X-Gossip": "1" },
      body:    JSON.stringify({ attestation: att }),
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
  json(res, 200, {
    node_did:            nodeKeypair.did,
    version:             VERSION,
    protocol:            "sip/0.1",
    total_verified:      Object.keys(nullifiers).length,
    total_reputation:    Object.keys(repStore).length,
    known_peers:         peers.length,
    supported_countries: ["CO"],
    capabilities:        ["zk-verify", "anti-sybil", "co-sign", "bot-reputation"],
    rate_limit:          `${RATE_LIMIT_MAX} req/min per IP`,
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
  const updatedRep = applyAttestation(att);

  // ── Gossip a los peers (async, fire-and-forget) ───────────────────────────
  if (!from_peer) {
    gossipAttestation(att, undefined);
  }

  json(res, 200, {
    ok:          true,
    target_did:  att.target_did,
    reputation:  updatedRep,
    gossiped_to: from_peer ? 0 : peers.length,
  });
}

// ── POST /peers/register ──────────────────────────────────────────────────────
async function handlePeerRegister(req: IncomingMessage, res: ServerResponse) {
  let body: any;
  try { body = await readBody(req); } catch (e: any) { return json(res, 400, { error: e.message }); }

  const { url } = body ?? {};
  if (!url || typeof url !== "string") return json(res, 400, { error: "Missing field: url" });
  if (!/^https?:\/\//.test(url))       return json(res, 400, { error: "url must start with http:// or https://" });
  if (peers.includes(url))             return json(res, 200, { ok: true, peers: peers.length, msg: "Already registered" });

  peers.push(url);
  savePeers();
  json(res, 200, { ok: true, peers: peers.length });
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
  const nodeKeypair = loadOrCreateNodeKeypair();

  const server = createServer(async (req, res) => {
    const ip  = getIP(req);
    const url = req.url?.split("?")[0] ?? "/";

    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (url === "/info"                 && req.method === "GET")  return handleInfo(res, nodeKeypair);
    if (url === "/verify"               && req.method === "POST") return handleVerify(req, res, nodeKeypair, ip);
    if (url === "/reputation/attest"    && req.method === "POST") return handleAttest(req, res, ip);
    if (url === "/peers/register"       && req.method === "POST") return handlePeerRegister(req, res);
    if (url === "/peers"                && req.method === "GET")  return handleGetPeers(res);
    if (url.startsWith("/reputation/")  && req.method === "GET")
      return handleGetReputation(res, decodeURIComponent(url.replace("/reputation/", "")));
    if (url.startsWith("/nullifier/")   && req.method === "GET")
      return handleNullifierCheck(res, decodeURIComponent(url.replace("/nullifier/", "")));

    json(res, 404, { error: "Not found" });
  });

  server.listen(port, () => {
    console.log(`\n🌐 Soulprint Validator Node v${VERSION}`);
    console.log(`   Node DID:     ${nodeKeypair.did}`);
    console.log(`   Listening:    http://0.0.0.0:${port}`);
    console.log(`   Nullifiers:   ${Object.keys(nullifiers).length}`);
    console.log(`   Reputations:  ${Object.keys(repStore).length}`);
    console.log(`   Known peers:  ${peers.length}`);
    console.log(`\n   POST /verify              verify ZK proof + co-sign`);
    console.log(`   GET  /info                node info`);
    console.log(`   GET  /nullifier/:n        anti-sybil check`);
    console.log(`   POST /reputation/attest   issue +1/-1 attestation`);
    console.log(`   GET  /reputation/:did     get bot reputation`);
    console.log(`   POST /peers/register      join P2P network`);
    console.log(`   GET  /peers               list known peers`);
    console.log(`\n   Anyone can run a Soulprint node. More nodes = more security.\n`);
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
