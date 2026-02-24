/**
 * blockchain-anchor.ts — Backup asíncrono de datos P2P a blockchain.
 *
 * ARQUITECTURA HÍBRIDA:
 * ─────────────────────────────────────────────────────────────────────────────
 * PRIMARIO   → BFT P2P Consensus (fast, $0, real-time)
 * BACKUP     → Base Sepolia / Base mainnet (permanent, auditable, free testnet)
 *
 * FLUJO NORMAL:
 *   1. BFT P2P: PROPOSE → VOTE → COMMIT (~2s, sin gas)
 *   2. onCommitted() → blockchainClient.registerIdentity() (async, no bloquea)
 *   3. Si blockchain falla → P2P sigue operando normal
 *
 * FLUJO DE RESTAURACIÓN (nodo arranca sin peers P2P):
 *   1. StateSyncManager no encuentra peers
 *   2. BlockchainAnchor.restoreFromBlockchain() carga nullifiers desde on-chain
 *   3. Nodo queda sincronizado aunque todos los peers P2P estuvieran caídos
 *
 * RETRY POLICY:
 *   - Reintentos con backoff exponencial (3 intentos)
 *   - Después de 3 fallos: guarda en pendingQueue para reintentar al reconectar
 *   - La queue persiste en disco (blockchain-pending.json)
 */

import { EventEmitter }            from "node:events";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  SoulprintBlockchainClient,
  loadBlockchainConfig,
}                                  from "./blockchain-client.js";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface PendingNullifier {
  nullifier:       string;
  did:             string;
  zkProof:         object;
  enqueuedAt:      number;
  attempts:        number;
}

export interface PendingAttestation {
  issuerDid:  string;
  targetDid:  string;
  value:      1 | -1;
  context:    string;
  signature:  string;
  enqueuedAt: number;
  attempts:   number;
}

export interface AnchorStats {
  nullifiersAnchored:  number;
  attestsAnchored:     number;
  pendingNullifiers:   number;
  pendingAttests:      number;
  blockchainConnected: boolean;
  lastAnchorTs:        number;
}

export interface BlockchainAnchorOptions {
  storePath: string;  // directorio para guardar la queue pendiente
}

// ── Constantes ────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS   = 3;
const RETRY_DELAY_MS = [0, 2000, 8000];   // backoff: 0s, 2s, 8s
const FLUSH_INTERVAL = 60_000;             // reintentar pendientes cada 60s

// ── BlockchainAnchor ──────────────────────────────────────────────────────────

export class BlockchainAnchor extends EventEmitter {

  private client:   SoulprintBlockchainClient | null = null;
  private connected = false;
  private storePath: string;

  private pendingNullifiers:  PendingNullifier[]  = [];
  private pendingAttests:     PendingAttestation[] = [];

  private stats: AnchorStats = {
    nullifiersAnchored:  0,
    attestsAnchored:     0,
    pendingNullifiers:   0,
    pendingAttests:      0,
    blockchainConnected: false,
    lastAnchorTs:        0,
  };

  constructor(opts: BlockchainAnchorOptions) {
    super();
    this.storePath = opts.storePath;
    this.loadQueue();
  }

  // ── Inicialización ──────────────────────────────────────────────────────────

  /**
   * Conecta al blockchain (Base Sepolia o mainnet).
   * Si no hay config → modo P2P-only (sin backup blockchain).
   */
  async connect(): Promise<boolean> {
    const config = loadBlockchainConfig();
    if (!config) {
      console.log("[anchor] No blockchain config — P2P-only mode (no backup)");
      console.log("[anchor] Set SOULPRINT_RPC_URL + SOULPRINT_PRIVATE_KEY to enable backup");
      return false;
    }

    this.client = new SoulprintBlockchainClient(config);
    this.connected = await this.client.connect();
    this.stats.blockchainConnected = this.connected;

    if (this.connected) {
      console.log("[anchor] ✅ Blockchain backup enabled — Base Sepolia");
      // Flush queue pendiente al conectar
      await this.flushQueue();
      // Programar flush periódico
      setInterval(() => this.flushQueue(), FLUSH_INTERVAL);
    }

    return this.connected;
  }

  // ── Anchor P2P → Blockchain ─────────────────────────────────────────────────

  /**
   * Ancla un nullifier committed en P2P al blockchain.
   * NO bloqueante — el usuario ya recibió su respuesta del P2P.
   */
  anchorNullifier(params: {
    nullifier:        string;
    did:              string;
    documentVerified: boolean;
    faceVerified:     boolean;
    zkProof: {
      a: [bigint, bigint];
      b: [[bigint, bigint], [bigint, bigint]];
      c: [bigint, bigint];
      inputs: [bigint, bigint];
    };
  }): void {
    if (!this.connected || !this.client) {
      // Guardar en queue para cuando se conecte
      this.pendingNullifiers.push({
        nullifier:  params.nullifier,
        did:        params.did,
        zkProof:    params as object,
        enqueuedAt: Date.now(),
        attempts:   0,
      });
      this.saveQueue();
      this.emit("queued", "nullifier", params.nullifier);
      return;
    }

    // Fire-and-forget con retry
    this.anchorNullifierWithRetry(params).catch(err => {
      console.warn(`[anchor] Nullifier ${params.nullifier.slice(0, 12)}... enqueued (${err.message?.slice(0, 40)})`);
    });
  }

  /**
   * Ancla una attestation al blockchain.
   * NO bloqueante.
   */
  anchorAttestation(params: {
    issuerDid:  string;
    targetDid:  string;
    value:      1 | -1;
    context:    string;
    signature:  string;
  }): void {
    if (!this.connected || !this.client) {
      this.pendingAttests.push({
        ...params,
        enqueuedAt: Date.now(),
        attempts:   0,
      });
      this.saveQueue();
      this.emit("queued", "attestation", params.issuerDid);
      return;
    }

    this.anchorAttestWithRetry(params).catch(err => {
      console.warn(`[anchor] Attestation ${params.issuerDid.slice(0, 16)}→${params.targetDid.slice(0, 16)} enqueued`);
    });
  }

  // ── Restauración desde blockchain ───────────────────────────────────────────

  /**
   * Intenta restaurar nullifiers desde blockchain cuando P2P no tiene peers.
   * Útil cuando todos los nodos P2P están caídos pero blockchain sigue vivo.
   *
   * @returns Lista de nullifiers restaurados (para importar en NullifierConsensus)
   */
  async restoreNullifersFromBlockchain(): Promise<Array<{ nullifier: string; did: string; score: number }>> {
    if (!this.connected || !this.client) return [];

    console.log("[anchor] Attempting restore from blockchain...");
    // TODO: implementar cuando el contrato tenga un getter de todos los nullifiers
    // Por ahora el contrato solo tiene isRegistered(bytes32) y identityScore(string)
    // En v0.4: agregar getAllNullifiers() al contrato o usar eventos
    console.log("[anchor] Restore not yet implemented — use P2P sync");
    return [];
  }

  /**
   * Retorna las estadísticas del anchor.
   */
  getStats(): AnchorStats {
    this.stats.pendingNullifiers = this.pendingNullifiers.length;
    this.stats.pendingAttests    = this.pendingAttests.length;
    return { ...this.stats };
  }

  // ── Internos ────────────────────────────────────────────────────────────────

  private async anchorNullifierWithRetry(params: any): Promise<void> {
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(RETRY_DELAY_MS[attempt] ?? 8000);
      }
      try {
        const txHash = await this.client!.registerIdentity({
          nullifier:        params.nullifier,
          did:              params.did,
          documentVerified: params.documentVerified ?? true,
          faceVerified:     params.faceVerified ?? true,
          zkProof:          params.zkProof ?? {
            a: [0n, 0n] as [bigint, bigint],
            b: [[0n, 0n], [0n, 0n]] as [[bigint, bigint], [bigint, bigint]],
            c: [0n, 0n] as [bigint, bigint],
            inputs: [BigInt(params.nullifier.replace(/^0x/, "").slice(0, 8) || "1"), 1n] as [bigint, bigint],
          },
        });

        if (txHash) {
          this.stats.nullifiersAnchored++;
          this.stats.lastAnchorTs = Date.now();
          this.emit("anchored", "nullifier", params.nullifier, txHash);
          console.log(`[anchor] ✅ nullifier ${params.nullifier.slice(0, 12)}... → tx ${txHash.slice(0, 12)}...`);
          return;
        }
      } catch (err: any) {
        lastErr = err;
        // Nullifier ya registrado on-chain — no es un error real
        if (err.message?.includes("NullifierAlreadyUsed")) {
          console.log(`[anchor] Nullifier ${params.nullifier.slice(0, 12)}... already on-chain — OK`);
          return;
        }
      }
    }

    // Después de 3 intentos → queue
    this.pendingNullifiers.push({
      nullifier:  params.nullifier,
      did:        params.did,
      zkProof:    params,
      enqueuedAt: Date.now(),
      attempts:   MAX_ATTEMPTS,
    });
    this.saveQueue();
  }

  private async anchorAttestWithRetry(params: any): Promise<void> {
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAY_MS[attempt] ?? 8000);
      try {
        const txHash = await this.client!.attest({
          issuerDid: params.issuerDid,
          targetDid: params.targetDid,
          value:     params.value,
          context:   params.context,
          signature: params.signature ?? "0x",
        });

        if (txHash) {
          this.stats.attestsAnchored++;
          this.stats.lastAnchorTs = Date.now();
          this.emit("anchored", "attestation", params.issuerDid, txHash);
          console.log(`[anchor] ✅ attest ${params.issuerDid.slice(0, 12)}→${params.targetDid.slice(0, 12)} → tx ${txHash.slice(0, 12)}...`);
          return;
        }
      } catch (err: any) {
        lastErr = err;
        if (err.message?.includes("CooldownActive")) {
          console.log(`[anchor] Attestation cooldown on-chain — skipping`);
          return;
        }
      }
    }

    this.pendingAttests.push({ ...params, enqueuedAt: Date.now(), attempts: MAX_ATTEMPTS });
    this.saveQueue();
  }

  private async flushQueue(): Promise<void> {
    if (!this.connected || !this.client) return;

    const nullifiers = [...this.pendingNullifiers];
    const attests    = [...this.pendingAttests];
    this.pendingNullifiers = [];
    this.pendingAttests    = [];

    for (const p of nullifiers) {
      await this.anchorNullifierWithRetry(p).catch(() => {});
    }
    for (const a of attests) {
      await this.anchorAttestWithRetry(a).catch(() => {});
    }

    this.saveQueue();
  }

  // ── Persistencia de queue ───────────────────────────────────────────────────

  private loadQueue(): void {
    const nullFile = this.storePath + "-nullifiers.json";
    const attFile  = this.storePath + "-attestations.json";
    try {
      if (existsSync(nullFile)) this.pendingNullifiers = JSON.parse(readFileSync(nullFile, "utf8"));
      if (existsSync(attFile))  this.pendingAttests    = JSON.parse(readFileSync(attFile,  "utf8"));
      const total = this.pendingNullifiers.length + this.pendingAttests.length;
      if (total > 0) console.log(`[anchor] Loaded ${total} pending items from queue`);
    } catch { /* queue vacía o corrupta */ }
  }

  private saveQueue(): void {
    try {
      writeFileSync(this.storePath + "-nullifiers.json",   JSON.stringify(this.pendingNullifiers, null, 2));
      writeFileSync(this.storePath + "-attestations.json", JSON.stringify(this.pendingAttests, null, 2));
    } catch { /* non-critical */ }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
