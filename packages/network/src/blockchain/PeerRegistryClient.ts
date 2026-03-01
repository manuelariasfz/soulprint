/**
 * PeerRegistryClient
 * On-chain peer discovery for Soulprint validator nodes (Base Sepolia).
 *
 * - On startup: reads all peers from contract → used as bootstrap multiaddrs
 * - On startup: registers self (DID, peerId, multiaddr, score=0)
 * - Cache TTL 5 min, refreshPeers() to invalidate
 * - Non-blocking: RPC failures log a warning and continue
 */
import { ethers } from "ethers";

export const PEER_REGISTRY_RPC = "https://sepolia.base.org";

// Load address from addresses.json
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadAddress(): string {
  try {
    const f = join(__dirname, "addresses.json");
    const d = JSON.parse(readFileSync(f, "utf8"));
    return d["PeerRegistry"] ?? "";
  } catch {
    return "";
  }
}

export const PEER_REGISTRY_ADDRESS = loadAddress();

const ABI = [
  "function registerPeer(string peerDid, string peerId, string multiaddr, uint256 score) external",
  "function removePeer(string peerDid) external",
  "function getPeer(string peerDid) external view returns (string did, string peerId, string multiaddr, uint256 score, uint256 lastSeen)",
  "function getAllPeers() external view returns (tuple(string peerDid, string peerId, string multiaddr, uint256 score, uint256 lastSeen, address registrant)[])",
  "function peerCount() external view returns (uint256)",
  "event PeerRegistered(string indexed peerDid, string peerId, string multiaddr, uint256 score, address indexed registrant, uint256 timestamp)",
  "event PeerUpdated(string indexed peerDid, string peerId, string multiaddr, uint256 score, address indexed registrant, uint256 timestamp)",
  "event PeerRemoved(string indexed peerDid, address indexed removedBy, uint256 timestamp)",
];

export interface PeerEntry {
  peerDid:   string;
  peerId:    string;
  multiaddr: string;
  score:     number;
  lastSeen:  number;
}

export class PeerRegistryClient {
  private provider:    ethers.JsonRpcProvider;
  private contract:    ethers.Contract;
  private wallet?:     ethers.Wallet;
  private cache:       PeerEntry[] | null = null;
  private cacheAt:     number = 0;
  private cacheTTLMs:  number;
  private address:     string;

  constructor(opts?: {
    rpc?:         string;
    address?:     string;
    privateKey?:  string;
    cacheTTLMs?:  number;
  }) {
    this.address    = opts?.address    ?? PEER_REGISTRY_ADDRESS;
    this.cacheTTLMs = opts?.cacheTTLMs ?? 5 * 60 * 1000;  // 5 min
    const rpc       = opts?.rpc        ?? PEER_REGISTRY_RPC;
    this.provider   = new ethers.JsonRpcProvider(rpc);

    if (!this.address) {
      console.warn("[peer-registry] ⚠️  No contract address — peer registry disabled");
      this.contract = null as any;
      return;
    }

    if (opts?.privateKey) {
      this.wallet  = new ethers.Wallet(opts.privateKey, this.provider);
      this.contract = new ethers.Contract(this.address, ABI, this.wallet);
    } else {
      this.contract = new ethers.Contract(this.address, ABI, this.provider);
    }
  }

  /** Get all registered peers (cached, TTL 5 min) */
  async getAllPeers(): Promise<PeerEntry[]> {
    if (this.cache && Date.now() - this.cacheAt < this.cacheTTLMs) {
      return this.cache;
    }
    return this.refreshPeers();
  }

  /** Force refresh from blockchain */
  async refreshPeers(): Promise<PeerEntry[]> {
    if (!this.address) {
      console.warn("[peer-registry] ⚠️  No contract address configured — skipping peer fetch");
      return [];
    }
    try {
      const raw: any[] = await this.contract.getAllPeers();
      this.cache = raw.map((p: any) => ({
        peerDid:   p.peerDid,
        peerId:    p.peerId,
        multiaddr: p.multiaddr,
        score:     Number(p.score),
        lastSeen:  Number(p.lastSeen),
      }));
      this.cacheAt = Date.now();
      return this.cache;
    } catch (err: any) {
      console.warn(`[peer-registry] ⚠️  Could not fetch peers from chain: ${err.shortMessage ?? err.message}`);
      return this.cache ?? [];
    }
  }

  /** Register this node on-chain. Non-blocking — logs warning on failure. */
  async registerSelf(opts: {
    peerDid:   string;
    peerId:    string;
    multiaddr: string;
    score?:    number;
  }): Promise<void> {
    if (!this.wallet) {
      console.warn("[peer-registry] ⚠️  No private key — cannot register self on-chain");
      return;
    }
    if (!this.address) {
      console.warn("[peer-registry] ⚠️  No contract address — skipping self-registration");
      return;
    }
    try {
      const feeData = await this.provider.getFeeData();
      const tx = await this.contract.registerPeer(
        opts.peerDid,
        opts.peerId,
        opts.multiaddr,
        BigInt(opts.score ?? 0),
        { gasPrice: feeData.gasPrice }
      );
      console.log(`[peer-registry] 📡 Registering self on-chain... tx: ${tx.hash}`);
      await tx.wait();
      console.log(`[peer-registry] ✅ Registered: did=${opts.peerDid.slice(0, 20)}... multiaddr=${opts.multiaddr}`);
      // Invalidate cache so next getAllPeers() reflects the new entry
      this.cache = null;
    } catch (err: any) {
      console.warn(`[peer-registry] ⚠️  Self-registration failed (non-fatal): ${err.shortMessage ?? err.message}`);
    }
  }

  /** Returns multiaddrs of all peers (for bootstrap) */
  async getBootstrapMultiaddrs(): Promise<string[]> {
    const peers = await this.getAllPeers();
    return peers.map(p => p.multiaddr).filter(Boolean);
  }

  get contractAddress(): string { return this.address; }
}

/** Singleton instance (read-only) */
export const peerRegistryClient = new PeerRegistryClient();
