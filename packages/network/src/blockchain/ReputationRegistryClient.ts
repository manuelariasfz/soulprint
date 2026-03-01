/**
 * ReputationRegistryClient
 * On-chain reputation scores for DIDs (Base Sepolia).
 *
 * Only the soulprint.digital validator (authorizedValidator) can write scores.
 * Anyone can read scores from the public ledger.
 *
 * Architecture (v0.5.0):
 *  - WRITE: only soulprint.digital validator wallet (ADMIN_PRIVATE_KEY)
 *  - READ:  anyone, cached 2 min
 */
import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const REPUTATION_REGISTRY_RPC = "https://sepolia.base.org";

function loadAddress(): string {
  try {
    const f = join(__dirname, "addresses.json");
    const d = JSON.parse(readFileSync(f, "utf8"));
    return d["ReputationRegistry"] ?? "";
  } catch {
    return "";
  }
}

export const REPUTATION_REGISTRY_ADDRESS = loadAddress();

const ABI = [
  "function setScore(string did, uint256 score, string context) external",
  "function getScore(string did) external view returns (string retDid, uint256 score, string context, uint256 updatedAt)",
  "function getAllScores() external view returns (tuple(string did, uint256 score, string context, uint256 updatedAt)[])",
  "function getScoreCount() external view returns (uint256)",
  "function authorizedValidators(address) external view returns (bool)",
  "event ScoreUpdated(string indexed did, uint256 score, string context, uint256 updatedAt)",
];

export interface ScoreEntry {
  did:       string;
  score:     number;
  context:   string;
  updatedAt: number;
}

export class ReputationRegistryClient {
  private provider:   ethers.JsonRpcProvider;
  private contract:   ethers.Contract;
  private wallet?:    ethers.Wallet;
  private cache:      ScoreEntry[] | null = null;
  private cacheAt:    number = 0;
  private cacheTTLMs: number;
  private address:    string;

  constructor(opts?: {
    rpc?:        string;
    address?:    string;
    privateKey?: string;
    cacheTTLMs?: number;
  }) {
    this.address    = opts?.address    ?? REPUTATION_REGISTRY_ADDRESS;
    this.cacheTTLMs = opts?.cacheTTLMs ?? 60 * 60 * 1000;  // 60 min
    const rpc       = opts?.rpc        ?? REPUTATION_REGISTRY_RPC;
    this.provider   = new ethers.JsonRpcProvider(rpc);

    if (!this.address) {
      console.warn("[reputation-registry] ⚠️  No contract address — registry disabled");
      this.contract = null as any;
      return;
    }

    if (opts?.privateKey) {
      this.wallet   = new ethers.Wallet(opts.privateKey, this.provider);
      this.contract = new ethers.Contract(this.address, ABI, this.wallet);
    } else {
      this.contract = new ethers.Contract(this.address, ABI, this.provider);
    }
  }

  /**
   * Set or update a reputation score for a DID.
   * Only works if the wallet is the authorized validator.
   * Non-blocking — logs warning on failure.
   */
  async setScore(opts: {
    did:      string;
    score:    number;
    context?: string;
  }): Promise<void> {
    if (!this.wallet) {
      console.warn("[reputation-registry] ⚠️  No private key — cannot write score");
      return;
    }
    if (!this.address) {
      console.warn("[reputation-registry] ⚠️  No contract address — skipping");
      return;
    }
    try {
      const feeData = await this.provider.getFeeData();
      const tx = await this.contract.setScore(
        opts.did,
        BigInt(Math.round(opts.score)),
        opts.context ?? "soulprint:v1",
        { gasPrice: feeData.gasPrice }
      );
      console.log(`[reputation-registry] 📡 Setting score on-chain... tx: ${tx.hash}`);
      await tx.wait();
      console.log(`[reputation-registry] ✅ Score set: did=${opts.did.slice(0, 20)}... score=${opts.score}`);
      // Invalidate cache
      this.cache = null;
    } catch (err: any) {
      console.warn(`[reputation-registry] ⚠️  setScore failed (non-fatal): ${err.shortMessage ?? err.message}`);
    }
  }

  /**
   * Get reputation score for a specific DID.
   */
  async getScore(did: string): Promise<ScoreEntry | null> {
    if (!this.address) return null;
    try {
      const r = await this.contract.getScore(did);
      return {
        did:       r.retDid,
        score:     Number(r.score),
        context:   r.context,
        updatedAt: Number(r.updatedAt),
      };
    } catch (err: any) {
      console.warn(`[reputation-registry] ⚠️  getScore failed: ${err.shortMessage ?? err.message}`);
      return null;
    }
  }

  /**
   * Get all DID scores (cached 2 min).
   */
  async getAllScores(): Promise<ScoreEntry[]> {
    if (this.cache && Date.now() - this.cacheAt < this.cacheTTLMs) {
      return this.cache;
    }
    return this.refreshScores();
  }

  async refreshScores(): Promise<ScoreEntry[]> {
    if (!this.address) return [];
    try {
      const raw: any[] = await this.contract.getAllScores();
      this.cache = raw.map((e: any) => ({
        did:       e.did,
        score:     Number(e.score),
        context:   e.context,
        updatedAt: Number(e.updatedAt),
      }));
      this.cacheAt = Date.now();
      return this.cache;
    } catch (err: any) {
      console.warn(`[reputation-registry] ⚠️  getAllScores failed: ${err.shortMessage ?? err.message}`);
      return this.cache ?? [];
    }
  }

  async getCount(): Promise<number> {
    if (!this.address) return 0;
    try {
      const n = await this.contract.getScoreCount();
      return Number(n);
    } catch {
      return 0;
    }
  }

  get contractAddress(): string { return this.address; }
}

export const reputationRegistryClient = new ReputationRegistryClient();
