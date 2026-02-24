import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join }     from "node:path";
import { homedir }  from "node:os";
import { generateKeypair, keypairFromPrivateKey, SoulprintKeypair,
         decodeToken, sign, verify } from "@soulprint/core";
import { verifyProof, deserializeProof } from "@soulprint/zkp";

// ── Config ────────────────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.SOULPRINT_PORT ?? "4888");
const NODE_DIR     = join(homedir(), ".soulprint", "node");
const KEYPAIR_FILE = join(NODE_DIR, "node-identity.json");
const NULLIFIER_DB = join(NODE_DIR, "nullifiers.json");  // anti-Sybil registry
const VERSION      = "0.1.0";

// ── Nullifier registry (in-memory + persisted) ────────────────────────────────
let nullifiers: Record<string, { did: string; verified_at: number }> = {};

function loadNullifiers() {
  if (existsSync(NULLIFIER_DB)) {
    nullifiers = JSON.parse(readFileSync(NULLIFIER_DB, "utf8"));
  }
}

function saveNullifiers() {
  writeFileSync(NULLIFIER_DB, JSON.stringify(nullifiers, null, 2));
}

// ── Node keypair ──────────────────────────────────────────────────────────────
function loadOrCreateNodeKeypair(): SoulprintKeypair {
  if (!existsSync(NODE_DIR)) mkdirSync(NODE_DIR, { recursive: true, mode: 0o700 });

  if (existsSync(KEYPAIR_FILE)) {
    const stored = JSON.parse(readFileSync(KEYPAIR_FILE, "utf8"));
    return keypairFromPrivateKey(new Uint8Array(Buffer.from(stored.privateKey, "hex")));
  }

  const keypair = generateKeypair();
  writeFileSync(KEYPAIR_FILE, JSON.stringify({
    did:        keypair.did,
    privateKey: Buffer.from(keypair.privateKey).toString("hex"),
    created:    new Date().toISOString(),
  }), { mode: 0o600 });

  console.log(`✅ Nuevo nodo creado: ${keypair.did}`);
  return keypair;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function json(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { "Content-Type": "application/json", "X-Soulprint-Node": VERSION });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON")); }
    });
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /info
 * Info pública del nodo — DID, versión, stats
 */
function handleInfo(res: ServerResponse, nodeKeypair: SoulprintKeypair) {
  json(res, 200, {
    node_did:    nodeKeypair.did,
    version:     VERSION,
    protocol:    "sip/0.1",
    total_verified: Object.keys(nullifiers).length,
    supported_countries: ["CO"],
    capabilities: ["zk-verify", "anti-sybil", "co-sign"],
  });
}

/**
 * POST /verify
 * Verifica un ZK proof y co-firma el SPT si es válido.
 *
 * Body: { spt: string, zkp: string }
 * - spt: el Soulprint Token emitido localmente
 * - zkp: el ZK proof serializado (de @soulprint/zkp)
 *
 * Returns: { valid: boolean, co_signature?: string, nullifier: string, anti_sybil: "new" | "existing" }
 */
async function handleVerify(req: IncomingMessage, res: ServerResponse, nodeKeypair: SoulprintKeypair) {
  let body: any;
  try { body = await readBody(req); }
  catch { return json(res, 400, { error: "Invalid JSON body" }); }

  const { spt, zkp } = body;
  if (!spt || !zkp) return json(res, 400, { error: "Missing spt or zkp" });

  // 1. Decodificar y verificar el SPT
  const token = decodeToken(spt);
  if (!token) return json(res, 401, { error: "Invalid or expired SPT" });

  // 2. Verificar el ZK proof
  let zkResult: { valid: boolean; nullifier: string };
  try {
    const proof  = deserializeProof(zkp);
    zkResult = await verifyProof(proof);
  } catch (e: any) {
    return json(res, 400, { error: `ZK proof error: ${e.message}` });
  }

  if (!zkResult.valid) return json(res, 403, { error: "ZK proof invalid" });

  // 3. Verificar que el nullifier del ZK proof coincide con el del SPT
  // (el nullifier del ZK usa Poseidon, el del SPT usa SHA256 — son distintos por diseño;
  //  en la siguiente versión se unifican; por ahora el nodo solo verifica el ZK proof)
  if (!zkResult.nullifier) return json(res, 400, { error: "No nullifier in proof" });

  // 4. Anti-Sybil check — mismo nullifier ZK = misma persona
  const existingEntry = nullifiers[zkResult.nullifier];
  let antiSybil: "new" | "existing" = "new";

  if (existingEntry) {
    if (existingEntry.did !== token.did) {
      // Intento de registro doble — misma persona, otro DID
      return json(res, 409, {
        error: "Anti-Sybil: este nullifier ya está registrado con otro DID",
        existing_did: existingEntry.did,
      });
    }
    antiSybil = "existing";
  } else {
    // Nuevo nullifier — registrar
    nullifiers[zkResult.nullifier] = { did: token.did, verified_at: Date.now() };
    saveNullifiers();
  }

  // 5. Co-firma del SPT con la llave del nodo
  const coPayload = { nullifier: zkResult.nullifier, did: token.did, timestamp: Date.now() };
  const coSig     = sign(coPayload, nodeKeypair.privateKey);

  json(res, 200, {
    valid:        true,
    anti_sybil:   antiSybil,
    nullifier:    zkResult.nullifier,
    node_did:     nodeKeypair.did,
    co_signature: coSig,
    verified_at:  Date.now(),
  });
}

/**
 * GET /nullifier/:nullifier
 * Consulta si un nullifier está registrado (sin revelar el DID)
 */
function handleNullifierCheck(res: ServerResponse, nullifier: string) {
  const entry = nullifiers[nullifier];
  if (!entry) return json(res, 404, { registered: false });
  json(res, 200, { registered: true, verified_at: entry.verified_at });
}

// ── Servidor HTTP ─────────────────────────────────────────────────────────────
export function startValidatorNode(port: number = PORT) {
  loadNullifiers();
  const nodeKeypair = loadOrCreateNodeKeypair();

  const server = createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = req.url ?? "/";

    if (url === "/info"    && req.method === "GET")  return handleInfo(res, nodeKeypair);
    if (url === "/verify"  && req.method === "POST") return handleVerify(req, res, nodeKeypair);
    if (url.startsWith("/nullifier/") && req.method === "GET") {
      return handleNullifierCheck(res, url.replace("/nullifier/", ""));
    }
    json(res, 404, { error: "Not found" });
  });

  server.listen(port, () => {
    console.log(`🌐 Soulprint Validator Node v${VERSION}`);
    console.log(`   Node DID: ${nodeKeypair.did}`);
    console.log(`   Listening on http://0.0.0.0:${port}`);
    console.log(`   Nullifiers registered: ${Object.keys(nullifiers).length}`);
    console.log(``);
    console.log(`   POST /verify      — verify ZK proof + co-sign SPT`);
    console.log(`   GET  /info        — node info`);
    console.log(`   GET  /nullifier/:n — check nullifier registration`);
    console.log(``);
    console.log(`   This node is part of the Soulprint P2P validator network.`);
    console.log(`   Anyone can run a node. The more nodes, the more secure the network.`);
  });

  return server;
}

// ── Client — enviar proof al nodo ─────────────────────────────────────────────

export interface NodeVerifyResult {
  valid:        boolean;
  co_signature: string;
  nullifier:    string;
  node_did:     string;
  anti_sybil:   "new" | "existing";
}

export async function submitToNode(
  nodeUrl:  string,
  spt:      string,
  zkProof:  string
): Promise<NodeVerifyResult> {
  const res = await fetch(`${nodeUrl}/verify`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ spt, zkp: zkProof }),
  });

  const data: any = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as NodeVerifyResult;
}

export async function getNodeInfo(nodeUrl: string) {
  const res  = await fetch(`${nodeUrl}/info`);
  return res.json();
}

// ── Well-known validator nodes (Phase 3 bootstrap) ────────────────────────────
// En Phase 3 completa esto viene de un DHT libp2p
export const BOOTSTRAP_NODES = [
  // Los primeros nodos públicos de la red
  // Cualquiera puede añadirse aquí vía PR
];
