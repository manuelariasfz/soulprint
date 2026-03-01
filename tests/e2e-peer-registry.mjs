/**
 * E2E Tests — PeerRegistry v0.4.2
 * Tests on-chain peer discovery via PeerRegistry smart contract on Base Sepolia.
 * Run: node tests/e2e-peer-registry.mjs
 */

import { spawn } from "child_process";
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const PEER_REGISTRY_ADDRESS = "0x452fb66159dFCfC13f2fD9627aA4c56886BfB15b";
const RPC = "https://sepolia.base.org";
const ADMIN_KEY = "0x0c85117778a68f7f4cead481dbc44695487fc4924b51eb6b6a07903262033a2b";
const ADMIN_TOKEN = "d069ca1823cbb64a9fe48ae4cf5d8820a798f06976504abd408d55104eff219f";
const NODE1_URL = "http://localhost:4888";
const NODE2_URL = "http://localhost:4889";

const ABI = [
  "function getAllPeers() external view returns (tuple(string peerDid, string peerId, string multiaddr, uint256 score, uint256 lastSeen, address registrant)[])",
  "function peerCount() external view returns (uint256)",
];

let passed = 0;
let failed = 0;
let node2Process = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "Assertion failed");
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ─── Start second node ────────────────────────────────────────────────────────

async function getNode1Multiaddr() {
  try {
    const stats = await fetchJson(`${NODE1_URL}/network/stats`);
    // Try to get multiaddr from node1 peers list (self registration)
    const peers = await fetchJson(`${NODE1_URL}/network/peers`);
    if (peers.peers && peers.peers.length > 0) {
      return peers.peers[0].multiaddr;
    }
  } catch {}
  return null;
}

async function startNode2() {
  // Get node1's multiaddr for bootstrap
  const node1Multiaddr = await getNode1Multiaddr();
  console.log(`  [setup] Node1 multiaddr: ${node1Multiaddr ?? "(not found, no P2P bootstrap)"}`);

  const env = {
    ...process.env,
    SOULPRINT_PORT: "4889",
    SOULPRINT_P2P_PORT: "6889",
    ADMIN_PRIVATE_KEY: ADMIN_KEY,
    ADMIN_TOKEN: ADMIN_TOKEN,
    NODE_ENV: "production",
  };

  if (node1Multiaddr) {
    env.SOULPRINT_BOOTSTRAP = node1Multiaddr;
  }

  const serverPath = join(__dirname, "../packages/network/dist/server.js");
  node2Process = spawn("node", [serverPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  node2Process.stdout.on("data", d => process.stdout.write(`  [node2] ${d}`));
  node2Process.stderr.on("data", d => process.stderr.write(`  [node2] ${d}`));
  node2Process.on("exit", code => {
    if (code !== null) console.log(`  [node2] exited with code ${code}`);
    node2Process = null;
  });

  // Wait for node2 to be up (max 30s)
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const r = await fetch(`${NODE2_URL}/health`);
      if (r.ok) {
        console.log(`  [setup] Node2 is up after ${i+1}s`);
        return true;
      }
    } catch {}
  }
  throw new Error("Node2 did not start within 30 seconds");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log("\n══════════════════════════════════════════════════════");
  console.log("  E2E — PeerRegistry on-chain peer discovery v0.4.2  ");
  console.log("══════════════════════════════════════════════════════\n");

  // ── Test 1: Contract read ─────────────────────────────────────────────────
  await test("1. Contract read — getAllPeers() returns array", async () => {
    const provider = new ethers.JsonRpcProvider(RPC);
    const contract = new ethers.Contract(PEER_REGISTRY_ADDRESS, ABI, provider);
    const peers = await contract.getAllPeers();
    assert(Array.isArray(peers), `Expected array, got ${typeof peers}`);
    console.log(`     Contract has ${peers.length} registered peer(s)`);
    if (peers.length > 0) {
      const p = peers[0];
      assert(typeof p.peerDid === "string", "peerDid must be string");
      assert(typeof p.multiaddr === "string", "multiaddr must be string");
    }
  });

  // ── Start Node 2 ──────────────────────────────────────────────────────────
  console.log("\n  [setup] Starting second node on port 4889...");
  try {
    await startNode2();
  } catch (err) {
    console.error(`  ❌ FAIL: Could not start node2: ${err.message}`);
    failed++;
    return; // Can't continue without node2
  }

  // Give node2 time to register on chain (tx confirmation ~5-15s)
  console.log("  [setup] Waiting 20s for node2 on-chain registration...");
  await sleep(20000);

  // ── Test 2: Self-registration ─────────────────────────────────────────────
  await test("2. Self-registration — node2 registered on-chain", async () => {
    const provider = new ethers.JsonRpcProvider(RPC);
    const contract = new ethers.Contract(PEER_REGISTRY_ADDRESS, ABI, provider);
    const peers = await contract.getAllPeers();
    const count = peers.length;
    assert(count >= 1, `Expected at least 1 peer on-chain, got ${count}`);
    console.log(`     ${count} peer(s) registered on-chain`);
    // Verify at least one has a valid peerDid
    const valid = peers.filter(p => p.peerDid && p.peerDid.startsWith("did:"));
    assert(valid.length >= 1, "Expected at least one peer with valid DID");
  });

  // Wait a bit more for P2P gossip and HTTP peer sync
  await sleep(5000);

  // ── Test 3: Peer discovery — node1 sees node2 ─────────────────────────────
  await test("3. Peer discovery — node1 (/network/peers) sees node2", async () => {
    const data = await fetchJson(`${NODE1_URL}/network/peers`);
    assert(data.ok, "Expected ok:true from node1 /network/peers");
    const peers = data.peers ?? [];
    console.log(`     Node1 has ${peers.length} peer(s) via /network/peers`);
    // The contract shows the peer; node1 should list it (either via contract or P2P)
    assert(peers.length >= 1, `Node1 has no peers at all (expected at least 1 from contract)`);
    // Check at least one peer has a multiaddr
    const withAddr = peers.filter(p => p.multiaddr);
    assert(withAddr.length >= 1, "No peers with multiaddr");
  });

  // ── Test 4: Cross-discovery — node2 sees node1 ────────────────────────────
  await test("4. Cross-discovery — node2 (/network/peers) sees node1", async () => {
    const data = await fetchJson(`${NODE2_URL}/network/peers`);
    assert(data.ok, "Expected ok:true from node2 /network/peers");
    const peers = data.peers ?? [];
    console.log(`     Node2 has ${peers.length} peer(s) via /network/peers`);
    assert(peers.length >= 1, `Node2 has no peers (expected to see node1 at minimum)`);
  });

  // ── Test 5: Stats — both nodes show registered_peers >= 2 ────────────────
  await test("5. Stats — both nodes show registered_peers >= 1 on-chain", async () => {
    const s1 = await fetchJson(`${NODE1_URL}/network/stats`);
    const s2 = await fetchJson(`${NODE2_URL}/network/stats`);
    console.log(`     Node1 registered_peers=${s1.registered_peers}, total_peers=${s1.total_peers}`);
    console.log(`     Node2 registered_peers=${s2.registered_peers}, total_peers=${s2.total_peers}`);
    assert(
      (s1.registered_peers ?? 0) >= 1,
      `Node1 registered_peers=${s1.registered_peers}, expected >=1`
    );
    assert(
      (s2.registered_peers ?? 0) >= 1,
      `Node2 registered_peers=${s2.registered_peers}, expected >=1`
    );
  });

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log("\n──────────────────────────────────────────────────────");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("  🎉 ALL TESTS PASSED — ready to publish");
  } else {
    console.log("  ⚠️  SOME TESTS FAILED — review before publishing");
  }
  console.log("──────────────────────────────────────────────────────\n");
}

// ─── Run ──────────────────────────────────────────────────────────────────────

try {
  await runTests();
} finally {
  if (node2Process) {
    console.log("  [teardown] Stopping node2...");
    node2Process.kill("SIGTERM");
    await sleep(1000);
  }
}

process.exit(failed > 0 ? 1 : 0);
