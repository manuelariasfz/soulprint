/**
 * ProtocolThresholdsClient
 * Lee los thresholds del protocolo desde Base Sepolia.
 * - Cache con TTL (10 min por defecto)
 * - Fallback transparente a constantes locales si la blockchain no es accesible
 * - Solo el superAdmin puede actualizar on-chain; aquí solo leemos
 */
import { ethers } from "ethers";
import { PROTOCOL } from "soulprint-core";

export const PROTOCOL_THRESHOLDS_ADDRESS = "0xD8f78d65b35806101672A49801b57F743f2D2ab1";
export const PROTOCOL_THRESHOLDS_CHAIN   = "Base Sepolia (chainId: 84532)";
export const PROTOCOL_THRESHOLDS_RPC     = "https://sepolia.base.org";

const ABI = [
  "function getThreshold(string calldata name) external view returns (uint256)",
  "function superAdmin() external view returns (address)",
  "function pendingSuperAdmin() external view returns (address)",
  "function getAll() external view returns (string[] memory names, uint256[] memory values)",
  "event ThresholdUpdated(bytes32 indexed key, uint256 oldValue, uint256 newValue, address indexed by, uint256 timestamp)",
];

export interface ProtocolThresholds {
  SCORE_FLOOR:            number;
  VERIFIED_SCORE_FLOOR:   number;
  MIN_ATTESTER_SCORE:     number;
  FACE_SIM_DOC_SELFIE:    number;  // /1000
  FACE_SIM_SELFIE_SELFIE: number;  // /1000
  DEFAULT_REPUTATION:     number;
  IDENTITY_MAX:           number;
  REPUTATION_MAX:         number;
  VERIFY_RETRY_MAX:       number;
  // metadata
  source:    "blockchain" | "local_fallback";
  loadedAt:  number;
  superAdmin?: string;
}

// Valores locales como fallback
function localFallback(source: "blockchain" | "local_fallback" = "local_fallback"): ProtocolThresholds {
  return {
    SCORE_FLOOR:            PROTOCOL.SCORE_FLOOR,
    VERIFIED_SCORE_FLOOR:   PROTOCOL.VERIFIED_SCORE_FLOOR,
    MIN_ATTESTER_SCORE:     PROTOCOL.MIN_ATTESTER_SCORE,
    FACE_SIM_DOC_SELFIE:    Math.round(PROTOCOL.FACE_SIM_DOC_SELFIE    * 1000),
    FACE_SIM_SELFIE_SELFIE: Math.round(PROTOCOL.FACE_SIM_SELFIE_SELFIE * 1000),
    DEFAULT_REPUTATION:     PROTOCOL.DEFAULT_REPUTATION,
    IDENTITY_MAX:           PROTOCOL.IDENTITY_MAX,
    REPUTATION_MAX:         PROTOCOL.REPUTATION_MAX,
    VERIFY_RETRY_MAX:       PROTOCOL.VERIFY_RETRY_MAX,
    source,
    loadedAt: Date.now(),
  };
}

export class ProtocolThresholdsClient {
  private provider:   ethers.JsonRpcProvider;
  private contract:   ethers.Contract;
  private cache:      ProtocolThresholds | null = null;
  private cacheTTLMs: number;
  private address:    string;

  constructor(opts?: { rpc?: string; address?: string; cacheTTLMs?: number }) {
    this.address    = opts?.address    ?? PROTOCOL_THRESHOLDS_ADDRESS;
    this.cacheTTLMs = opts?.cacheTTLMs ?? 10 * 60 * 1000;   // 10 min
    const rpc       = opts?.rpc        ?? PROTOCOL_THRESHOLDS_RPC;
    this.provider   = new ethers.JsonRpcProvider(rpc);
    this.contract   = new ethers.Contract(this.address, ABI, this.provider);
  }

  /** Carga thresholds desde blockchain — fallback transparente a local */
  async load(): Promise<ProtocolThresholds> {
    // Cache hit
    if (this.cache && Date.now() - this.cache.loadedAt < this.cacheTTLMs) {
      return this.cache;
    }
    try {
      const [admin, floor, vfloor, minAtt, faceSim, faceSimSS, defRep, idMax, repMax, retryMax] =
        await Promise.all([
          this.contract.superAdmin(),
          this.contract.getThreshold("SCORE_FLOOR"),
          this.contract.getThreshold("VERIFIED_SCORE_FLOOR"),
          this.contract.getThreshold("MIN_ATTESTER_SCORE"),
          this.contract.getThreshold("FACE_SIM_DOC_SELFIE"),
          this.contract.getThreshold("FACE_SIM_SELFIE_SELFIE"),
          this.contract.getThreshold("DEFAULT_REPUTATION"),
          this.contract.getThreshold("IDENTITY_MAX"),
          this.contract.getThreshold("REPUTATION_MAX"),
          this.contract.getThreshold("VERIFY_RETRY_MAX"),
        ]);

      this.cache = {
        SCORE_FLOOR:            Number(floor),
        VERIFIED_SCORE_FLOOR:   Number(vfloor),
        MIN_ATTESTER_SCORE:     Number(minAtt),
        FACE_SIM_DOC_SELFIE:    Number(faceSim),
        FACE_SIM_SELFIE_SELFIE: Number(faceSimSS),
        DEFAULT_REPUTATION:     Number(defRep),
        IDENTITY_MAX:           Number(idMax),
        REPUTATION_MAX:         Number(repMax),
        VERIFY_RETRY_MAX:       Number(retryMax),
        source:     "blockchain",
        loadedAt:   Date.now(),
        superAdmin: admin,
      };
      return this.cache;
    } catch (err: any) {
      console.warn(`[thresholds] ⚠️  Blockchain no disponible — usando fallback local (${err.shortMessage ?? err.message})`);
      return localFallback("local_fallback");
    }
  }

  /** Invalida la cache — el siguiente load() irá a blockchain */
  invalidate(): void { this.cache = null; }

  /** Lee un threshold individual (con cache) */
  async get(name: keyof Omit<ProtocolThresholds,"source"|"loadedAt"|"superAdmin">): Promise<number> {
    const t = await this.load();
    return t[name] as number;
  }

  /** Devuelve la dirección del contrato */
  get contractAddress(): string { return this.address; }

  /** Acceso directo al contrato para uso en tests */
  get rawContract(): ethers.Contract { return this.contract; }
}

/** Instancia global (singleton) para uso en el validador */
export const thresholdsClient = new ProtocolThresholdsClient();
