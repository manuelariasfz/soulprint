/**
 * blockchain-client.ts — Cliente para interactuar con los contratos Soulprint on-chain.
 *
 * MODO HÍBRIDO:
 * El nodo validador opera en dos modos:
 *
 * 1. ONLINE (blockchain activo):
 *    - nullifierUsed()     → consulta SoulprintRegistry on-chain
 *    - registerIdentity()  → registra nullifier + ZK proof on-chain
 *    - attest()            → escribe attestation en AttestationLedger
 *    - getReputation()     → lee score on-chain
 *
 * 2. OFFLINE (sin conexión RPC):
 *    - Fallback a stores locales (nullifiers.json, repStore.json)
 *    - Los datos se sincronizan con blockchain cuando vuelve la conexión
 *    - Garantiza disponibilidad incluso sin internet
 *
 * CONFIGURACIÓN:
 *   SOULPRINT_RPC_URL=https://sepolia.base.org
 *   SOULPRINT_PRIVATE_KEY=0x...
 *   SOULPRINT_REGISTRY_ADDR=0x...
 *   SOULPRINT_LEDGER_ADDR=0x...
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname }   from "node:path";
import { homedir }  from "node:os";
import { fileURLToPath } from "node:url";

// ESM-compatible __dirname
const __dir = dirname(fileURLToPath(import.meta.url));

// ── ABI mínimos para interactuar con los contratos ────────────────────────────
// Solo las funciones que usa el nodo validador

const REGISTRY_ABI = [
  "function isRegistered(bytes32 nullifier) view returns (bool)",
  "function identityScore(string did) view returns (uint8)",
  "function registerIdentity(bytes32 nullifier, string did, bool docVerified, bool faceVerified, uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[2] inputs) external",
  "event IdentityRegistered(bytes32 indexed nullifier, string indexed did, uint8 identityScore, uint64 timestamp)",
  "function PROTOCOL_HASH() view returns (bytes32)",
] as const;

const LEDGER_ABI = [
  "function attest(string issuerDid, string targetDid, int8 value, string context, bytes signature) external",
  "function getTotalScore(string did) view returns (uint16)",
  "function getReputation(string did) view returns (tuple(int16 score, uint16 totalPositive, uint16 totalNegative, uint64 lastUpdated))",
  "function getAttestations(string did) view returns (tuple(string issuerDid, string targetDid, int8 value, string context, uint64 timestamp, bytes signature)[])",
  "function canAttest(string issuerDid, string targetDid) view returns (bool allowed, uint64 nextTs)",
  "event AttestationRecorded(string indexed targetDid, string issuerDid, int8 value, string context, uint64 timestamp)",
] as const;

const VALIDATOR_REG_ABI = [
  "function registerNode(string url, string did, bytes32 protocolHash) external",
  "function heartbeat(string did, uint32 totalVerified) external",
  "function getActiveNodes() view returns (tuple(string url, string did, bytes32 protocolHash, uint64 registeredAt, uint64 lastSeen, uint32 totalVerified, bool active, bool compatible)[])",
  "function PROTOCOL_HASH() view returns (bytes32)",
  "function compatibleNodes() view returns (uint256)",
] as const;

const GOVERNANCE_ABI = [
  // State
  "function currentApprovedHash() view returns (bytes32)",
  "function totalProposals() view returns (uint256)",
  "function APPROVAL_THRESHOLD_BPS() view returns (uint256)",
  "function VETO_THRESHOLD_BPS() view returns (uint256)",
  "function TIMELOCK_DELAY() view returns (uint64)",
  "function MINIMUM_QUORUM() view returns (uint32)",
  // Actions
  "function proposeUpgrade(string did, bytes32 newHash, string rationale) external returns (uint256)",
  "function voteOnProposal(uint256 proposalId, string did, bool approve) external",
  "function executeProposal(uint256 proposalId) external",
  // Views
  "function getProposal(uint256 id) view returns (tuple(uint256 id, bytes32 newHash, string rationale, string proposerDid, address proposerAddr, uint64 createdAt, uint64 approvedAt, uint64 executedAt, uint32 votesFor, uint32 votesAgainst, uint8 state))",
  "function getActiveProposals() view returns (tuple(uint256 id, bytes32 newHash, string rationale, string proposerDid, address proposerAddr, uint64 createdAt, uint64 approvedAt, uint64 executedAt, uint32 votesFor, uint32 votesAgainst, uint8 state)[])",
  "function getHashHistory() view returns (bytes32[])",
  "function isCurrentHashValid(bytes32 hash) view returns (bool)",
  "function getApprovalPercentage(uint256 id) view returns (uint256 forPct, uint256 againstPct, uint32 activeNodes)",
  "function timelockRemaining(uint256 id) view returns (uint64)",
  // Events
  "event ProposalCreated(uint256 indexed id, bytes32 newHash, string proposerDid, string rationale, uint64 expiresAt)",
  "event VoteCast(uint256 indexed proposalId, string voterDid, bool approve, uint32 totalFor, uint32 totalAgainst)",
  "event ProposalApproved(uint256 indexed id, bytes32 newHash, uint64 executeAfter)",
  "event ProposalExecuted(uint256 indexed id, bytes32 oldHash, bytes32 newHash, uint64 timestamp)",
  "event ProposalRejected(uint256 indexed id, string reason)",
  "event EmergencyVeto(uint256 indexed id, uint32 vetoes, uint32 totalVoters)",
] as const;

// ── ProposalState enum (mirror de Solidity) ───────────────────────────────────
export const ProposalState = {
  ACTIVE:   0,
  APPROVED: 1,
  EXECUTED: 2,
  REJECTED: 3,
  EXPIRED:  4,
} as const;

export type ProposalStateType = typeof ProposalState[keyof typeof ProposalState];

export interface GovernanceProposal {
  id:           number;
  newHash:      string;
  rationale:    string;
  proposerDid:  string;
  proposerAddr: string;
  createdAt:    number;
  approvedAt:   number;
  executedAt:   number;
  votesFor:     number;
  votesAgainst: number;
  state:        ProposalStateType;
  stateName:    string;
}

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface BlockchainConfig {
  rpcUrl:           string;
  privateKey:       string;
  registryAddr:     string;
  ledgerAddr:       string;
  validatorRegAddr?: string;
  governanceAddr?:  string;
  protocolHash:     string;   // must match PROTOCOL_HASH on-chain
}

export interface OnChainReputation {
  score:         number;
  totalPositive: number;
  totalNegative: number;
  lastUpdated:   number;
  source:        "blockchain" | "local";
}

// ── Load config from env + deployments ───────────────────────────────────────

export function loadBlockchainConfig(): BlockchainConfig | null {
  const rpcUrl     = process.env.SOULPRINT_RPC_URL;
  const privateKey = process.env.SOULPRINT_PRIVATE_KEY;
  const network    = process.env.SOULPRINT_NETWORK ?? "base-sepolia";

  if (!rpcUrl || !privateKey) return null;

  // Buscar direcciones en deployments/
  const deploymentsDir = join(__dir, "..", "..", "..", "blockchain", "deployments");
  const deployFile     = join(deploymentsDir, `${network}.json`);

  if (!existsSync(deployFile)) {
    console.warn(`[blockchain] No deployment found for ${network}. Run: npx hardhat run scripts/deploy.ts --network ${network}`);
    return null;
  }

  const deployment = JSON.parse(readFileSync(deployFile, "utf8"));

  return {
    rpcUrl,
    privateKey,
    registryAddr:     deployment.contracts.SoulprintRegistry,
    ledgerAddr:       deployment.contracts.AttestationLedger,
    validatorRegAddr: deployment.contracts.ValidatorRegistry,
    governanceAddr:   deployment.contracts.GovernanceModule,
    protocolHash:     deployment.protocolHash,
  };
}

// ── Blockchain Client ─────────────────────────────────────────────────────────

export class SoulprintBlockchainClient {
  private config: BlockchainConfig;
  private provider:     any = null;
  private signer:       any = null;
  private registry:     any = null;
  private ledger:       any = null;
  private validatorReg: any = null;
  private governance:   any = null;
  private connected = false;

  constructor(config: BlockchainConfig) {
    this.config = config;
  }

  /**
   * Inicializa la conexión con la blockchain.
   * Lanza error si ethers no está disponible (opcional dependency).
   */
  async connect(): Promise<boolean> {
    try {
      // @ts-ignore — ethers is an optional peer dependency
      const ethersModule = await import("ethers").catch(() => null);
      if (!ethersModule) return false;
      const ethers = ethersModule.ethers;

      this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
      this.signer   = new ethers.Wallet(this.config.privateKey, this.provider);

      this.registry     = new ethers.Contract(this.config.registryAddr, REGISTRY_ABI, this.signer);
      this.ledger       = new ethers.Contract(this.config.ledgerAddr,   LEDGER_ABI,   this.signer);

      if (this.config.validatorRegAddr) {
        this.validatorReg = new ethers.Contract(this.config.validatorRegAddr, VALIDATOR_REG_ABI, this.signer);
      }

      if (this.config.governanceAddr) {
        this.governance = new ethers.Contract(this.config.governanceAddr, GOVERNANCE_ABI, this.signer);
        const govHash = await this.governance.currentApprovedHash();
        console.log(`[blockchain]    Governance: ${this.config.governanceAddr}`);
        console.log(`[blockchain]    Current approved hash: ${govHash.slice(0, 10)}...`);
      }

      // Verificar que el contrato tiene el mismo PROTOCOL_HASH
      const onChainHash = await this.registry.PROTOCOL_HASH();
      if (onChainHash.toLowerCase() !== this.config.protocolHash.toLowerCase()) {
        console.error(`[blockchain] ❌ PROTOCOL_HASH mismatch!`);
        console.error(`  On-chain:  ${onChainHash}`);
        console.error(`  Expected:  ${this.config.protocolHash}`);
        return false;
      }

      this.connected = true;
      const network  = await this.provider.getNetwork();
      console.log(`[blockchain] ✅ Connected to chain ${network.chainId} (${network.name})`);
      console.log(`[blockchain]    Registry:  ${this.config.registryAddr}`);
      console.log(`[blockchain]    Ledger:    ${this.config.ledgerAddr}`);
      return true;
    } catch (err: any) {
      console.warn(`[blockchain] Offline mode — ${err.message?.slice(0, 60)}`);
      return false;
    }
  }

  get isConnected(): boolean { return this.connected; }

  // ── Registry ───────────────────────────────────────────────────────────────

  /**
   * Verifica si un nullifier ya está registrado (anti-sybil on-chain).
   */
  async isNullifierUsed(nullifier: string): Promise<boolean | null> {
    if (!this.connected) return null;
    try {
      return await this.registry.isRegistered(nullifier);
    } catch { return null; }
  }

  /**
   * Registra una identidad on-chain con ZK proof.
   * @returns txHash o null si falla
   */
  async registerIdentity(params: {
    nullifier:       string;
    did:             string;
    documentVerified: boolean;
    faceVerified:    boolean;
    zkProof: {
      a: [bigint, bigint];
      b: [[bigint, bigint], [bigint, bigint]];
      c: [bigint, bigint];
      inputs: [bigint, bigint];
    };
  }): Promise<string | null> {
    if (!this.connected) return null;
    try {
      const tx = await this.registry.registerIdentity(
        params.nullifier,
        params.did,
        params.documentVerified,
        params.faceVerified,
        params.zkProof.a,
        params.zkProof.b,
        params.zkProof.c,
        params.zkProof.inputs
      );
      const receipt = await tx.wait();
      console.log(`[blockchain] ✅ Identity registered | tx: ${receipt.hash}`);
      return receipt.hash;
    } catch (err: any) {
      console.error(`[blockchain] registerIdentity failed: ${err.message?.slice(0, 80)}`);
      return null;
    }
  }

  /**
   * Retorna el identity score on-chain de un DID.
   */
  async getIdentityScore(did: string): Promise<number | null> {
    if (!this.connected) return null;
    try {
      return Number(await this.registry.identityScore(did));
    } catch { return null; }
  }

  // ── Attestation Ledger ─────────────────────────────────────────────────────

  /**
   * Escribe una attestation on-chain.
   * @returns txHash o null si falla
   */
  async attest(params: {
    issuerDid: string;
    targetDid: string;
    value:     1 | -1;
    context:   string;
    signature: string;
  }): Promise<string | null> {
    if (!this.connected) return null;
    try {
      const tx = await this.ledger.attest(
        params.issuerDid,
        params.targetDid,
        params.value,
        params.context,
        params.signature
      );
      const receipt = await tx.wait();
      console.log(`[blockchain] ✅ Attestation recorded | tx: ${receipt.hash}`);
      return receipt.hash;
    } catch (err: any) {
      // Manejar CooldownActive gracefully
      if (err.message?.includes("CooldownActive")) {
        console.warn(`[blockchain] Attestation cooldown active for ${params.issuerDid} → ${params.targetDid}`);
      } else {
        console.error(`[blockchain] attest failed: ${err.message?.slice(0, 80)}`);
      }
      return null;
    }
  }

  /**
   * Obtiene la reputación on-chain de un DID.
   */
  async getReputation(did: string): Promise<OnChainReputation | null> {
    if (!this.connected) return null;
    try {
      const rep = await this.ledger.getReputation(did);
      return {
        score:         Number(rep.score),
        totalPositive: Number(rep.totalPositive),
        totalNegative: Number(rep.totalNegative),
        lastUpdated:   Number(rep.lastUpdated),
        source:        "blockchain",
      };
    } catch { return null; }
  }

  /**
   * Score total on-chain (identity + reputation).
   */
  async getTotalScore(did: string): Promise<number | null> {
    if (!this.connected) return null;
    try {
      return Number(await this.ledger.getTotalScore(did));
    } catch { return null; }
  }

  // ── Validator Registry ─────────────────────────────────────────────────────

  /**
   * Registra este nodo en el ValidatorRegistry on-chain.
   */
  async registerNode(params: {
    url:          string;
    did:          string;
    protocolHash: string;
  }): Promise<string | null> {
    if (!this.connected || !this.validatorReg) return null;
    try {
      const tx = await this.validatorReg.registerNode(
        params.url,
        params.did,
        params.protocolHash
      );
      const receipt = await tx.wait();
      console.log(`[blockchain] ✅ Node registered | tx: ${receipt.hash}`);
      return receipt.hash;
    } catch (err: any) {
      if (err.message?.includes("AlreadyRegistered")) {
        console.log(`[blockchain] Node already registered`);
      } else {
        console.error(`[blockchain] registerNode failed: ${err.message?.slice(0, 80)}`);
      }
      return null;
    }
  }

  /**
   * Envía heartbeat on-chain.
   */
  async heartbeat(did: string, totalVerified: number): Promise<void> {
    if (!this.connected || !this.validatorReg) return;
    try {
      const tx = await this.validatorReg.heartbeat(did, totalVerified);
      await tx.wait();
    } catch { /* non-critical */ }
  }

  /**
   * Lista nodos activos on-chain (para peer discovery).
   */
  async getActiveNodes(): Promise<Array<{ url: string; did: string; compatible: boolean }>> {
    if (!this.connected || !this.validatorReg) return [];
    try {
      const nodes = await this.validatorReg.getActiveNodes();
      return nodes.map((n: any) => ({
        url:        n.url,
        did:        n.did,
        compatible: n.compatible,
      }));
    } catch { return []; }
  }

  // ── Governance ─────────────────────────────────────────────────────────────

  /**
   * Retorna el hash actualmente aprobado por governance.
   * Los nodos deben comparar esto con su PROTOCOL_HASH al arrancar.
   */
  async getCurrentApprovedHash(): Promise<string | null> {
    if (!this.connected || !this.governance) return null;
    try {
      return await this.governance.currentApprovedHash();
    } catch { return null; }
  }

  /**
   * Verifica si el hash actual del nodo está aprobado por governance.
   */
  async isHashApproved(hash: string): Promise<boolean> {
    if (!this.connected || !this.governance) return true; // fallback: asumir OK
    try {
      return await this.governance.isCurrentHashValid(hash);
    } catch { return true; }
  }

  /**
   * Propone un upgrade del PROTOCOL_HASH.
   * Solo validadores con identidad verificada pueden proponer.
   *
   * @returns txHash + proposalId, o null si falla
   */
  async proposeUpgrade(params: {
    did:       string;
    newHash:   string;
    rationale: string;
  }): Promise<{ txHash: string; proposalId: number } | null> {
    if (!this.connected || !this.governance) return null;
    try {
      const tx      = await this.governance.proposeUpgrade(params.did, params.newHash, params.rationale);
      const receipt = await tx.wait();
      // Extraer proposalId del evento ProposalCreated
      const log = receipt.logs?.find((l: any) => l.fragment?.name === "ProposalCreated");
      const proposalId = log ? Number(log.args[0]) : -1;
      console.log(`[governance] ✅ Proposal #${proposalId} created | tx: ${receipt.hash}`);
      return { txHash: receipt.hash, proposalId };
    } catch (err: any) {
      console.error(`[governance] proposeUpgrade failed: ${err.message?.slice(0, 100)}`);
      return null;
    }
  }

  /**
   * Vota en una propuesta de governance.
   * @param approve true = a favor | false = en contra / veto
   */
  async voteOnProposal(params: {
    proposalId: number;
    did:        string;
    approve:    boolean;
  }): Promise<string | null> {
    if (!this.connected || !this.governance) return null;
    try {
      const tx      = await this.governance.voteOnProposal(params.proposalId, params.did, params.approve);
      const receipt = await tx.wait();
      const action  = params.approve ? "✅ FOR" : "🚫 AGAINST";
      console.log(`[governance] ${action} Proposal #${params.proposalId} | tx: ${receipt.hash}`);
      return receipt.hash;
    } catch (err: any) {
      console.error(`[governance] voteOnProposal failed: ${err.message?.slice(0, 100)}`);
      return null;
    }
  }

  /**
   * Ejecuta una propuesta aprobada una vez que el timelock expiró.
   */
  async executeProposal(proposalId: number): Promise<string | null> {
    if (!this.connected || !this.governance) return null;
    try {
      const tx      = await this.governance.executeProposal(proposalId);
      const receipt = await tx.wait();
      console.log(`[governance] ✅ Proposal #${proposalId} EXECUTED | tx: ${receipt.hash}`);
      return receipt.hash;
    } catch (err: any) {
      console.error(`[governance] executeProposal failed: ${err.message?.slice(0, 100)}`);
      return null;
    }
  }

  /**
   * Retorna estado completo de una propuesta.
   */
  async getProposal(proposalId: number): Promise<GovernanceProposal | null> {
    if (!this.connected || !this.governance) return null;
    try {
      // Verificar que la propuesta existe (Solidity retorna zero-struct si no existe)
      const total = Number(await this.governance.totalProposals());
      if (proposalId >= total) return null;
      const STATE_NAMES = ["ACTIVE", "APPROVED", "EXECUTED", "REJECTED", "EXPIRED"];
      const p = await this.governance.getProposal(proposalId);
      return {
        id:           Number(p.id),
        newHash:      p.newHash,
        rationale:    p.rationale,
        proposerDid:  p.proposerDid,
        proposerAddr: p.proposerAddr,
        createdAt:    Number(p.createdAt),
        approvedAt:   Number(p.approvedAt),
        executedAt:   Number(p.executedAt),
        votesFor:     Number(p.votesFor),
        votesAgainst: Number(p.votesAgainst),
        state:        Number(p.state) as ProposalStateType,
        stateName:    STATE_NAMES[Number(p.state)] ?? "UNKNOWN",
      };
    } catch { return null; }
  }

  /**
   * Lista todas las propuestas activas o en timelock.
   */
  async getActiveProposals(): Promise<GovernanceProposal[]> {
    if (!this.connected || !this.governance) return [];
    try {
      const STATE_NAMES = ["ACTIVE", "APPROVED", "EXECUTED", "REJECTED", "EXPIRED"];
      const proposals = await this.governance.getActiveProposals();
      return proposals.map((p: any) => ({
        id:           Number(p.id),
        newHash:      p.newHash,
        rationale:    p.rationale,
        proposerDid:  p.proposerDid,
        proposerAddr: p.proposerAddr,
        createdAt:    Number(p.createdAt),
        approvedAt:   Number(p.approvedAt),
        executedAt:   Number(p.executedAt),
        votesFor:     Number(p.votesFor),
        votesAgainst: Number(p.votesAgainst),
        state:        Number(p.state) as ProposalStateType,
        stateName:    STATE_NAMES[Number(p.state)] ?? "UNKNOWN",
      }));
    } catch { return []; }
  }

  /**
   * Historial de todos los hashes aprobados (auditoría).
   */
  async getHashHistory(): Promise<string[]> {
    if (!this.connected || !this.governance) return [];
    try {
      return await this.governance.getHashHistory();
    } catch { return []; }
  }

  /**
   * Segundos restantes del timelock de una propuesta aprobada.
   */
  async getTimelockRemaining(proposalId: number): Promise<number> {
    if (!this.connected || !this.governance) return 0;
    try {
      return Number(await this.governance.timelockRemaining(proposalId));
    } catch { return 0; }
  }
}
