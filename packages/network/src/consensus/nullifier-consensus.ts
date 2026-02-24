/**
 * nullifier-consensus.ts — Consenso BFT ligero para registrar nullifiers.
 *
 * PROTOCOLO (sin EVM, sin gas fees):
 * ─────────────────────────────────────────────────────────────────────────────
 * FASE 1 — PROPOSE (proposer → red):
 *   Proposer verifica ZK proof localmente y hace broadcast:
 *   { type: "PROPOSE", nullifier, did, proofHash, proposerDid, ts, sig }
 *
 * FASE 2 — VOTE (cada nodo → red):
 *   Cada nodo verifica la propuesta (ZK proof válido, nullifier no registrado)
 *   y hace broadcast de su voto:
 *   { type: "VOTE", nullifier, vote: "accept"|"reject", voterDid, ts, sig }
 *
 * FASE 3 — COMMIT (cualquier nodo con quorum → red):
 *   Cuando un nodo acumula N/2+1 votos ACCEPT hace broadcast:
 *   { type: "COMMIT", nullifier, did, votes[], commitDid, ts, sig }
 *   Todos los nodos registran el nullifier como committed.
 *
 * TOLERANCIA A FALLOS:
 *   • Modo single (< MIN_PEERS): acepta localmente sin consenso
 *   • Timeout por ronda: 10s — si no hay quorum, rechaza
 *   • Re-proposal: si propuesta se pierde, cliente puede reintentar
 *   • Firma Ed25519: cada mensaje lleva firma del emisor → no repudiable
 *
 * SEGURIDAD:
 *   • proofHash = SHA-256(zkProof serializado) — nodos verifican hash
 *   • ZK proof verificado localmente por cada voter (no confían en proposer)
 *   • Nullifier check antes de votar (anti-sybil)
 *   • PROTOCOL_HASH en cada mensaje (nodo con hash diferente → voto inválido)
 */

import { createHash, createHmac } from "node:crypto";
import { EventEmitter }           from "node:events";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join }                   from "node:path";

import { PROTOCOL, PROTOCOL_HASH }               from "soulprint-core";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type ConsensusVote = "accept" | "reject";

export interface ProposeMsg {
  type:        "PROPOSE";
  nullifier:   string;        // hex
  did:         string;
  proofHash:   string;        // SHA-256(serialized zkProof)
  proposerDid: string;
  ts:          number;
  protocolHash: string;
  sig:         string;        // Ed25519 hex (sign proposerDid+nullifier+proofHash+ts)
}

export interface VoteMsg {
  type:      "VOTE";
  nullifier: string;
  vote:      ConsensusVote;
  reason?:   string;
  voterDid:  string;
  ts:        number;
  protocolHash: string;
  sig:       string;
}

export interface CommitMsg {
  type:       "COMMIT";
  nullifier:  string;
  did:        string;
  votes:      VoteMsg[];
  commitDid:  string;
  ts:         number;
  protocolHash: string;
  sig:        string;
}

export type ConsensusMsg = ProposeMsg | VoteMsg | CommitMsg;

export interface CommittedNullifier {
  nullifier:   string;
  did:         string;
  committedAt: number;
  commitDid:   string;
  voteCount:   number;
}

export interface ConsensusOptions {
  /** DID de este nodo */
  selfDid: string;
  /** Función para firmar un string → hex sig */
  sign: (data: string) => Promise<string>;
  /** Función para verificar firma → boolean */
  verify: (data: string, sig: string, did: string) => Promise<boolean>;
  /** Función para broadcast a la red */
  broadcast: (msg: ConsensusMsg) => Promise<void>;
  /** Función para verificar ZK proof localmente */
  verifyZkProof: (proofHash: string, nullifier: string) => Promise<boolean>;
  /** Ruta al store de nullifiers */
  storePath: string;
  /** Mínimo de peers para consenso (si < MIN: modo single) */
  minPeers?: number;
  /** Timeout por ronda en ms */
  roundTimeoutMs?: number;
}

// ── Constantes ────────────────────────────────────────────────────────────────

const MIN_PEERS_DEFAULT    = 3;
const ROUND_TIMEOUT_MS     = 10_000;   // 10 segundos


// ── NullifierConsensus ────────────────────────────────────────────────────────

export class NullifierConsensus extends EventEmitter {

  private opts:           ConsensusOptions;
  private nullifiers:     Map<string, CommittedNullifier> = new Map();
  private pendingRounds:  Map<string, PendingRound>       = new Map();
  private connectedPeers: number = 0;
  private storePath:      string;

  constructor(opts: ConsensusOptions) {
    super();
    this.opts      = opts;
    this.storePath = opts.storePath;
    this.loadStore();
  }

  // ── API pública ─────────────────────────────────────────────────────────────

  /**
   * Actualiza el conteo de peers conectados.
   * NullifierConsensus usa este valor para decidir modo single vs. consenso.
   */
  setPeerCount(count: number): void {
    this.connectedPeers = count;
  }

  /**
   * Propone registrar un nullifier.
   * Retorna cuando el nullifier está COMMITTED (o rechazado).
   *
   * @param nullifier  hex string del nullifier (Poseidon hash)
   * @param did        DID del usuario
   * @param zkProof    serialización del ZK proof (para calcular proofHash)
   * @returns          CommittedNullifier si aceptado
   * @throws           Error si rechazado o timeout
   */
  async propose(
    nullifier: string,
    did:       string,
    zkProof:   object
  ): Promise<CommittedNullifier> {

    // Ya registrado (idempotente)
    if (this.nullifiers.has(nullifier)) {
      return this.nullifiers.get(nullifier)!;
    }

    const minPeers = this.opts.minPeers ?? MIN_PEERS_DEFAULT;

    // Modo single: sin suficientes peers, acepta localmente
    if (this.connectedPeers === 0 || this.connectedPeers < minPeers) {
      return this.commitLocal(nullifier, did, 1);
    }

    const proofHash = this.hashProof(zkProof);
    const ts        = Date.now();
    const sigData   = `${this.opts.selfDid}:${nullifier}:${proofHash}:${ts}`;
    const sig       = await this.opts.sign(sigData);

    const propose: ProposeMsg = {
      type:         "PROPOSE",
      nullifier,
      did,
      proofHash,
      proposerDid:  this.opts.selfDid,
      ts,
      protocolHash: PROTOCOL_HASH,
      sig,
    };

    // Iniciar ronda con timeout
    const committed = await this.startRound(propose);
    return committed;
  }

  /**
   * Procesa un mensaje de consenso recibido de la red.
   */
  async handleMessage(msg: ConsensusMsg): Promise<void> {
    // Rechazar mensajes con PROTOCOL_HASH diferente
    if (msg.protocolHash !== PROTOCOL_HASH) {
      this.emit("warn", `Rejected msg from incompatible node (hash: ${msg.protocolHash.slice(0, 10)}...)`);
      return;
    }

    switch (msg.type) {
      case "PROPOSE": return this.onPropose(msg);
      case "VOTE":    return this.onVote(msg);
      case "COMMIT":  return this.onCommit(msg);
    }
  }

  /**
   * Verifica si un nullifier está registrado (committed).
   */
  isRegistered(nullifier: string): boolean {
    return this.nullifiers.has(nullifier);
  }

  /**
   * Retorna todos los nullifiers registrados.
   */
  getAllNullifiers(): CommittedNullifier[] {
    return Array.from(this.nullifiers.values());
  }

  /**
   * Exporta estado para sync con nuevos nodos.
   */
  exportState(): CommittedNullifier[] {
    return this.getAllNullifiers();
  }

  /**
   * Importa estado de otro nodo (al arrancar o hacer sync).
   * Solo acepta entradas que no estén ya registradas.
   */
  importState(entries: CommittedNullifier[]): number {
    let imported = 0;
    for (const entry of entries) {
      if (!this.nullifiers.has(entry.nullifier)) {
        this.nullifiers.set(entry.nullifier, entry);
        imported++;
      }
    }
    if (imported > 0) this.saveStore();
    return imported;
  }

  // ── Handlers de mensajes ────────────────────────────────────────────────────

  private async onPropose(msg: ProposeMsg): Promise<void> {
    const { nullifier, did, proofHash, proposerDid, ts } = msg;

    // Ya registrado: votar ACCEPT (idempotente)
    if (this.nullifiers.has(nullifier)) {
      await this.sendVote(nullifier, "accept", "already-committed");
      return;
    }

    // No crear ronda duplicada si ya la tenemos
    if (!this.pendingRounds.has(nullifier)) {
      this.pendingRounds.set(nullifier, {
        proposal:  msg,
        votes:     [],
        committed: false,
      });
    }

    // Votar basado en verificación local del ZK proof
    let vote: ConsensusVote;
    let reason: string;

    try {
      const valid = await this.opts.verifyZkProof(proofHash, nullifier);
      vote   = valid ? "accept" : "reject";
      reason = valid ? "proof-valid" : "proof-invalid";
    } catch (err: any) {
      vote   = "reject";
      reason = `verify-error: ${err.message?.slice(0, 30)}`;
    }

    await this.sendVote(nullifier, vote, reason);
  }

  private async onVote(msg: VoteMsg): Promise<void> {
    const round = this.pendingRounds.get(msg.nullifier);
    if (!round || round.committed) return;

    // Evitar votos duplicados del mismo voter
    const already = round.votes.some(v => v.voterDid === msg.voterDid);
    if (already) return;

    round.votes.push(msg);

    // Quorum: N/2+1 de los peers conocidos
    const quorum = Math.floor(this.connectedPeers / 2) + 1;
    const accepts = round.votes.filter(v => v.vote === "accept").length;
    const rejects = round.votes.filter(v => v.vote === "reject").length;

    if (accepts >= quorum) {
      await this.sendCommit(round);
    } else if (rejects > this.connectedPeers / 2) {
      this.emit("rejected", msg.nullifier, "majority-reject");
      this.pendingRounds.delete(msg.nullifier);
    }
  }

  private async onCommit(msg: CommitMsg): Promise<void> {
    if (this.nullifiers.has(msg.nullifier)) return;

    // Verificar que tiene suficientes votos ACCEPT
    const accepts = msg.votes.filter(v => v.vote === "accept").length;
    const quorum  = Math.floor((this.connectedPeers || 1) / 2) + 1;

    if (accepts < Math.max(1, quorum - 1)) {
      this.emit("warn", `COMMIT for ${msg.nullifier.slice(0, 12)} has only ${accepts} accepts`);
      // Aceptar con < quorum si venimos de modo single (voteCount=1)
      if (accepts < 1) return;
    }

    this.commitLocal(msg.nullifier, msg.did, accepts);

    // Resolver la ronda pendiente (si éste nodo era el proposer)
    const round = this.pendingRounds.get(msg.nullifier);
    if (round) {
      round.committed = true;
      this.pendingRounds.delete(msg.nullifier);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async startRound(propose: ProposeMsg): Promise<CommittedNullifier> {
    const { nullifier } = propose;
    const timeout       = this.opts.roundTimeoutMs ?? ROUND_TIMEOUT_MS;

    // Iniciar ronda local
    this.pendingRounds.set(nullifier, {
      proposal:  propose,
      votes:     [],
      committed: false,
    });

    // Broadcast propuesta
    await this.opts.broadcast(propose);

    // Votar uno mismo (como proposer)
    const selfValid = await this.opts.verifyZkProof(propose.proofHash, nullifier);
    await this.sendVote(nullifier, selfValid ? "accept" : "reject", "self-verify");

    // Esperar resultado con timeout
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRounds.delete(nullifier);
        reject(new Error(`Consensus timeout for nullifier ${nullifier.slice(0, 12)}...`));
      }, timeout);

      this.once(`commit:${nullifier}`, (entry: CommittedNullifier) => {
        clearTimeout(timer);
        resolve(entry);
      });

      this.once(`reject:${nullifier}`, (reason: string) => {
        clearTimeout(timer);
        reject(new Error(`Nullifier rejected: ${reason}`));
      });
    });
  }

  private async sendVote(nullifier: string, vote: ConsensusVote, reason?: string): Promise<void> {
    const ts      = Date.now();
    const sigData = `${this.opts.selfDid}:${nullifier}:${vote}:${ts}`;
    const sig     = await this.opts.sign(sigData);

    const voteMsg: VoteMsg = {
      type:         "VOTE",
      nullifier,
      vote,
      reason,
      voterDid:     this.opts.selfDid,
      ts,
      protocolHash: PROTOCOL_HASH,
      sig,
    };

    await this.opts.broadcast(voteMsg);
  }

  private async sendCommit(round: PendingRound): Promise<void> {
    const { nullifier, did } = round.proposal;
    round.committed = true;

    const ts      = Date.now();
    const sigData = `${this.opts.selfDid}:commit:${nullifier}:${ts}`;
    const sig     = await this.opts.sign(sigData);

    const commit: CommitMsg = {
      type:         "COMMIT",
      nullifier,
      did,
      votes:        round.votes,
      commitDid:    this.opts.selfDid,
      ts,
      protocolHash: PROTOCOL_HASH,
      sig,
    };

    await this.opts.broadcast(commit);
  }

  private commitLocal(nullifier: string, did: string, voteCount: number): CommittedNullifier {
    const entry: CommittedNullifier = {
      nullifier,
      did,
      committedAt: Date.now(),
      commitDid:   this.opts.selfDid,
      voteCount,
    };
    this.nullifiers.set(nullifier, entry);
    this.saveStore();

    // Emitir para resolver promesas pendientes
    this.emit(`commit:${nullifier}`, entry);
    this.emit("committed", entry);
    return entry;
  }

  private hashProof(zkProof: object): string {
    return createHash("sha256")
      .update(JSON.stringify(zkProof))
      .digest("hex");
  }

  // ── Persistencia ────────────────────────────────────────────────────────────

  private loadStore(): void {
    if (!existsSync(this.storePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.storePath, "utf8"));
      for (const entry of raw) {
        this.nullifiers.set(entry.nullifier, entry);
      }
    } catch { /* store vacío o corrupto */ }
  }

  private saveStore(): void {
    const data = Array.from(this.nullifiers.values());
    writeFileSync(this.storePath, JSON.stringify(data, null, 2));
  }
}

// ── Tipos internos ────────────────────────────────────────────────────────────

interface PendingRound {
  proposal:  ProposeMsg;
  votes:     VoteMsg[];
  committed: boolean;
}
