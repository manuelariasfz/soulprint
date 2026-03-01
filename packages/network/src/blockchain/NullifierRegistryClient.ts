/**
 * NullifierRegistryClient
 * On-chain nullifier registry for Soulprint (Base Sepolia).
 *
 * The soulprint.digital validator (authorizedValidator) signs every nullifier
 * before writing it on-chain. Read-only access is public — anyone can verify
 * isRegistered(nullifier) without trust in any third party.
 *
 * Architecture (v0.5.0):
 *  - WRITE: only soulprint.digital validator (ADMIN_PRIVATE_KEY)
 *  - READ:  anyone, cached 2 min
 */
import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const NULLIFIER_REGISTRY_RPC = "https://sepolia.base.org";

function loadAddress(): string {
  try {
    const f = join(__dirname, "addresses.json");
    const d = JSON.parse(readFileSync(f, "utf8"));
    return d["NullifierRegistry"] ?? "";
  } catch {
    return "";
  }
}

export const NULLIFIER_REGISTRY_ADDRESS = loadAddress();

const ABI = [
  "function registerNullifier(bytes32 nullifier, string did, uint256 score, bytes sig) external",
  "function isRegistered(bytes32 nullifier) external view returns (bool)",
  "function getNullifier(bytes32 nullifier) external view returns (bytes32 nul, string did, uint256 score, uint256 timestamp)",
  "function getAllNullifiers() external view returns (tuple(bytes32 nullifier, string did, uint256 score, uint256 timestamp)[])",
  "function getNullifierCount() external view returns (uint256)",
  "function authorizedValidator() external view returns (address)",
  "event NullifierRegistered(bytes32 indexed nullifier, string did, uint256 score, uint256 timestamp)",
];

export interface NullifierEntry {
  nullifier: string;
  did:       string;
  score:     number;
  timestamp: number;
}

export class NullifierRegistryClient {
  private provider:   ethers.JsonRpcProvider;
  private contract:   ethers.Contract;
  private wallet?:    ethers.Wallet;
  private cache:      NullifierEntry[] | null = null;
  private cacheAt:    number = 0;
  private cacheTTLMs: number;
  private address:    string;

  constructor(opts?: {
    rpc?:        string;
    address?:    string;
    privateKey?: string;
    cacheTTLMs?: number;
  }) {
    this.address    = opts?.address    ?? NULLIFIER_REGISTRY_ADDRESS;
    this.cacheTTLMs = opts?.cacheTTLMs ?? 60 * 60 * 1000;  // 60 min
    const rpc       = opts?.rpc        ?? NULLIFIER_REGISTRY_RPC;
    this.provider   = new ethers.JsonRpcProvider(rpc);

    if (!this.address) {
      console.warn("[nullifier-registry] ⚠️  No contract address — registry disabled");
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
   * Sign a nullifier payload with the validator's private key and register on-chain.
   * Non-blocking — logs warning on failure.
   *
   * The contract verifies the ECDSA signature over keccak256(nullifier, did, score).
   */
  async registerNullifier(opts: {
    nullifier: string;  // bytes32 hex string
    did:       string;
    score?:    number;
  }): Promise<void> {
    if (!this.wallet) {
      console.warn("[nullifier-registry] ⚠️  No private key — cannot register nullifier");
      return;
    }
    if (!this.address) {
      console.warn("[nullifier-registry] ⚠️  No contract address — skipping registration");
      return;
    }
    try {
      const nullifierBytes = opts.nullifier.startsWith("0x")
        ? opts.nullifier
        : `0x${opts.nullifier}`;
      const score = BigInt(opts.score ?? 0);

      // Create the message hash matching what the contract verifies
      const msgHash = ethers.keccak256(
        ethers.solidityPacked(
          ["bytes32", "string", "uint256"],
          [nullifierBytes, opts.did, score]
        )
      );

      // Sign with Ethereum personal_sign prefix (matches contract's \x19Ethereum Signed Message:\n32)
      const sig = await this.wallet.signMessage(ethers.getBytes(msgHash));

      const feeData = await this.provider.getFeeData();
      const tx = await this.contract.registerNullifier(
        nullifierBytes,
        opts.did,
        score,
        sig,
        { gasPrice: feeData.gasPrice }
      );
      console.log(`[nullifier-registry] 📡 Registering nullifier on-chain... tx: ${tx.hash}`);
      await tx.wait();
      console.log(`[nullifier-registry] ✅ Nullifier registered: ${nullifierBytes.slice(0, 18)}... did=${opts.did.slice(0, 20)}...`);
      // Invalidate cache
      this.cache = null;
    } catch (err: any) {
      console.warn(`[nullifier-registry] ⚠️  Registration failed (non-fatal): ${err.shortMessage ?? err.message}`);
    }
  }

  /**
   * Check if a nullifier is registered on-chain.
   */
  async isRegistered(nullifier: string): Promise<boolean> {
    if (!this.address) return false;
    try {
      const n = nullifier.startsWith("0x") ? nullifier : `0x${nullifier}`;
      return await this.contract.isRegistered(n);
    } catch (err: any) {
      console.warn(`[nullifier-registry] ⚠️  isRegistered failed: ${err.shortMessage ?? err.message}`);
      return false;
    }
  }

  /**
   * Get all registered nullifiers (cached 2 min).
   */
  async getAllNullifiers(): Promise<NullifierEntry[]> {
    if (this.cache && Date.now() - this.cacheAt < this.cacheTTLMs) {
      return this.cache;
    }
    return this.refreshNullifiers();
  }

  async refreshNullifiers(): Promise<NullifierEntry[]> {
    if (!this.address) return [];
    try {
      const raw: any[] = await this.contract.getAllNullifiers();
      this.cache = raw.map((e: any) => ({
        nullifier: e.nullifier,
        did:       e.did,
        score:     Number(e.score),
        timestamp: Number(e.timestamp),
      }));
      this.cacheAt = Date.now();
      return this.cache;
    } catch (err: any) {
      console.warn(`[nullifier-registry] ⚠️  getAllNullifiers failed: ${err.shortMessage ?? err.message}`);
      return this.cache ?? [];
    }
  }

  async getCount(): Promise<number> {
    if (!this.address) return 0;
    try {
      const n = await this.contract.getNullifierCount();
      return Number(n);
    } catch {
      return 0;
    }
  }

  get contractAddress(): string { return this.address; }
}

export const nullifierRegistryClient = new NullifierRegistryClient();
