import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join }     from "node:path";
import { homedir }  from "node:os";
import { generateKeypair, keypairFromPrivateKey, SoulprintKeypair,
         decodeToken, sign } from "soulprint-core";
import { verifyProof, deserializeProof } from "soulprint-zkp";

// ── Config ────────────────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.SOULPRINT_PORT ?? "4888");
const NODE_DIR     = join(homedir(), ".soulprint", "node");
const KEYPAIR_FILE = join(NODE_DIR, "node-identity.json");
const NULLIFIER_DB = join(NODE_DIR, "nullifiers.json");
const VERSION      = "0.1.0";

const MAX_BODY_BYTES = 64 * 1024;   // 64KB max
const RATE_LIMIT_MS  = 60_000;      // 1 min window
const RATE_LIMIT_MAX = 10;          // 10 req/min/IP
const CLOCK_SKEW_MAX = 300;         // ±5 min

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
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateLimits) if (now > e.resetAt) rateLimits.delete(ip);
}, 5 * 60_000).unref();

// ── Nullifier registry ────────────────────────────────────────────────────────
let nullifiers: Record<string, { did: string; verified_at: number }> = {};

function loadNullifiers() {
  if (existsSync(NULLIFIER_DB)) {
    try { nullifiers = JSON.parse(readFileSync(NULLIFIER_DB, "utf8")); } catch { nullifiers = {}; }
  }
}
function saveNullifiers() { writeFileSync(NULLIFIER_DB, JSON.stringify(nullifiers, null, 2)); }

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
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); reject(new Error("Request too large (max 64KB)")); return; }
      data += chunk;
    });
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
    supported_countries: ["CO"],
    capabilities:        ["zk-verify", "anti-sybil", "co-sign"],
    rate_limit:          `${RATE_LIMIT_MAX} req/min per IP`,
  });
}

// ── POST /verify ──────────────────────────────────────────────────────────────
async function handleVerify(req: IncomingMessage, res: ServerResponse, nodeKeypair: SoulprintKeypair, ip: string) {
  if (!checkRateLimit(ip)) return json(res, 429, { error: "Rate limit exceeded. Try again in 1 minute." });

  let body: any;
  try { body = await readBody(req); } catch (e: any) { return json(res, 400, { error: e.message }); }

  const { spt, zkp } = body ?? {};
  if (!spt || !zkp)                             return json(res, 400, { error: "Missing required fields: spt, zkp" });
  if (typeof spt !== "string" || typeof zkp !== "string") return json(res, 400, { error: "spt and zkp must be strings" });

  // Verify SPT
  const token = decodeToken(spt);
  if (!token) return json(res, 401, { error: "Invalid or expired SPT" });

  // Clock skew check
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(token.issued - now) > CLOCK_SKEW_MAX) {
    return json(res, 400, { error: "Clock skew too large", max_skew_seconds: CLOCK_SKEW_MAX });
  }

  // Verify ZK proof
  let zkResult: { valid: boolean; nullifier: string };
  try {
    const proof = deserializeProof(zkp);
    zkResult    = await verifyProof(proof);
  } catch (e: any) { return json(res, 400, { error: `ZK proof error: ${e.message?.slice(0, 100)}` }); }

  if (!zkResult.valid)     return json(res, 403, { error: "ZK proof is not valid" });
  if (!zkResult.nullifier) return json(res, 400, { error: "No nullifier in ZK proof" });

  // Anti-Sybil
  const existing  = nullifiers[zkResult.nullifier];
  let antiSybil: "new" | "existing" = "new";

  if (existing) {
    if (existing.did !== token.did) {
      return json(res, 409, {
        error: "Anti-Sybil: this nullifier is already registered with a different DID",
      });
    }
    antiSybil = "existing";
  } else {
    nullifiers[zkResult.nullifier] = { did: token.did, verified_at: now };
    saveNullifiers();
  }

  const coSig = sign({ nullifier: zkResult.nullifier, did: token.did, timestamp: now }, nodeKeypair.privateKey);

  json(res, 200, {
    valid:        true,
    anti_sybil:   antiSybil,
    nullifier:    zkResult.nullifier,
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
  const nodeKeypair = loadOrCreateNodeKeypair();

  const server = createServer(async (req, res) => {
    const ip  = getIP(req);
    const url = req.url ?? "/";

    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (url === "/info"   && req.method === "GET")  return handleInfo(res, nodeKeypair);
    if (url === "/verify" && req.method === "POST") return handleVerify(req, res, nodeKeypair, ip);
    if (url.startsWith("/nullifier/") && req.method === "GET")
      return handleNullifierCheck(res, decodeURIComponent(url.replace("/nullifier/", "")));

    json(res, 404, { error: "Not found" });
  });

  server.listen(port, () => {
    console.log(`🌐 Soulprint Validator Node v${VERSION}`);
    console.log(`   Node DID: ${nodeKeypair.did}`);
    console.log(`   Listening on http://0.0.0.0:${port}`);
    console.log(`   Nullifiers registered: ${Object.keys(nullifiers).length}`);
    console.log(`   Rate limit: ${RATE_LIMIT_MAX} req/min per IP`);
    console.log(`\n   POST /verify        verify ZK proof + co-sign SPT`);
    console.log(`   GET  /info          node info`);
    console.log(`   GET  /nullifier/:n  check nullifier`);
    console.log(`\n   Anyone can run a Soulprint node. More nodes = more security.`);
  });

  return server;
}

// ── Client ────────────────────────────────────────────────────────────────────
export interface NodeVerifyResult {
  valid:        boolean;
  co_signature: string;
  nullifier:    string;
  node_did:     string;
  anti_sybil:   "new" | "existing";
}

export async function submitToNode(nodeUrl: string, spt: string, zkProof: string): Promise<NodeVerifyResult> {
  const res  = await fetch(`${nodeUrl}/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spt, zkp: zkProof }) });
  const data: any = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as NodeVerifyResult;
}

export async function getNodeInfo(nodeUrl: string) {
  return (await fetch(`${nodeUrl}/info`)).json();
}

// Bootstrap nodes — add yours via PR: https://github.com/manuelariasfz/soulprint
export const BOOTSTRAP_NODES: string[] = [];
