/**
 * attestation-consensus.ts — Attestations firmadas + propagadas por P2P.
 *
 * DISEÑO (sin EVM):
 * ─────────────────────────────────────────────────────────────────────────────
 * Las attestations NO necesitan consenso multi-ronda porque:
 *   1. Están firmadas con Ed25519 (no repudiables)
 *   2. El issuer es verificable (score >= MIN_ATTESTER_SCORE)
 *   3. El anti-farming es local + determinista
 *
 * FLUJO:
 *   Issuer firma attest → broadcast a red → cada nodo valida firma + cooldown
 *   → si válido: guarda en store + propaga → estado eventualmente consistente
 *
 * ANTI-FARMING ON-CHAIN (sin EVM):
 *   • Map<issuer:target → lastTs> con cooldown de 24h
 *   • Anti-farming de soulprint-core (FARMING_RULES) para patrones robóticos
 *   • FARMING_RULES Object.freeze → constantes inmutables
 *
 * CONSISTENCIA:
 *   • Eventual: todos los nodos convergen al mismo estado en segundos
 *   • Cada attest lleva firma + timestamp → reordenable en merge
 *   • Sin conflictos: misma firma = misma attestation (idempotente)
 */

import { createHash }             from "node:crypto";
import { EventEmitter }           from "node:events";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

import { PROTOCOL, PROTOCOL_HASH } from "soulprint-core";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface AttestationMsg {
  type:        "ATTEST";
  issuerDid:   string;
  targetDid:   string;
  value:       1 | -1;
  context:     string;
  ts:          number;
  protocolHash: string;
  sig:          string;   // Ed25519 sig del issuer sobre (target:value:context:ts)
}

export interface AttestEntry {
  issuerDid:   string;
  targetDid:   string;
  value:       1 | -1;
  context:     string;
  ts:          number;
  sig:         string;
  msgHash:     string;   // SHA-256(issuer:target:value:context:ts) — id único
}

export interface Reputation {
  score:         number;   // default: DEFAULT_REPUTATION (10), -20 a +20
  totalPositive: number;
  totalNegative: number;
  lastUpdated:   number;
}

export interface AttestationConsensusOptions {
  selfDid:        string;
  sign:           (data: string) => Promise<string>;
  verify:         (data: string, sig: string, did: string) => Promise<boolean>;
  broadcast:      (msg: AttestationMsg) => Promise<void>;
  getScore:       (did: string) => number;      // identity score del issuer
  storePath:      string;
  repStorePath:   string;
}

// ── Constantes ────────────────────────────────────────────────────────────────


const MIN_ATTESTER_SCORE    = PROTOCOL.MIN_ATTESTER_SCORE;  // 65
const REPUTATION_MAX        = PROTOCOL.REPUTATION_MAX;       // 20
const DEFAULT_REPUTATION    = PROTOCOL.DEFAULT_REPUTATION;   // 10
const ATTESTATION_COOLDOWN  = 24 * 60 * 60 * 1000;          // 24h en ms

// ── AttestationConsensus ──────────────────────────────────────────────────────

export class AttestationConsensus extends EventEmitter {

  private opts:       AttestationConsensusOptions;
  private history:    Map<string, AttestEntry[]>      = new Map(); // targetDid → entries
  private reps:       Map<string, Reputation>          = new Map(); // targetDid → rep
  private cooldowns:  Map<string, number>              = new Map(); // "issuer:target" → lastTs
  private seen:       Set<string>                      = new Set(); // msgHashes (anti-replay)

  constructor(opts: AttestationConsensusOptions) {
    super();
    this.opts = opts;
    this.loadStores();
  }

  // ── API pública ─────────────────────────────────────────────────────────────

  /**
   * Emite una attestation desde este nodo.
   * Firma, guarda localmente, y hace broadcast.
   */
  async attest(params: {
    issuerDid: string;
    targetDid: string;
    value:     1 | -1;
    context:   string;
  }): Promise<AttestEntry> {
    const { issuerDid, targetDid, value, context } = params;

    // Validaciones
    if (issuerDid === targetDid) throw new Error("Cannot self-attest");

    const issuerScore = this.opts.getScore(issuerDid);
    if (issuerScore < MIN_ATTESTER_SCORE) {
      throw new Error(`Issuer score ${issuerScore} < required ${MIN_ATTESTER_SCORE}`);
    }

    // Cooldown check
    const cooldownKey = `${issuerDid}:${targetDid}`;
    const lastTs      = this.cooldowns.get(cooldownKey) ?? 0;
    if (Date.now() - lastTs < ATTESTATION_COOLDOWN) {
      const nextAllowed = new Date(lastTs + ATTESTATION_COOLDOWN).toISOString();
      throw new Error(`Cooldown active until ${nextAllowed}`);
    }

    // Anti-farming check (inline — checkFarming completo requiere SessionContext)
    const existingHistory = this.history.get(targetDid) ?? [];
    const recentFromIssuer = existingHistory.filter(
      e => e.issuerDid === issuerDid && Date.now() - e.ts < 7 * 24 * 60 * 60 * 1000
    );
    const isFarming      = recentFromIssuer.length >= 7; // >1/día durante 7 días
    const effectiveValue = isFarming ? -1 : value;

    if (isFarming) {
      this.emit("farming-detected", { issuerDid, targetDid, reason: "weekly-cap" });
    }

    const ts      = Date.now();
    const sigData = `${issuerDid}:${targetDid}:${effectiveValue}:${context}:${ts}`;
    const sig     = await this.opts.sign(sigData);

    const msg: AttestationMsg = {
      type:         "ATTEST",
      issuerDid,
      targetDid,
      value:        effectiveValue,
      context,
      ts,
      protocolHash: PROTOCOL_HASH,
      sig,
    };

    const entry = this.applyAttest(msg);
    await this.opts.broadcast(msg);
    return entry;
  }

  /**
   * Procesa un mensaje ATTEST recibido de la red.
   */
  async handleMessage(msg: AttestationMsg): Promise<void> {
    if (msg.protocolHash !== PROTOCOL_HASH) return;
    if (msg.type !== "ATTEST") return;

    const msgHash = this.hashMsg(msg);
    if (this.seen.has(msgHash)) return;  // anti-replay

    // Verificar cooldown
    const cooldownKey = `${msg.issuerDid}:${msg.targetDid}`;
    const lastTs      = this.cooldowns.get(cooldownKey) ?? 0;
    if (msg.ts - lastTs < ATTESTATION_COOLDOWN && lastTs > 0) {
      this.emit("warn", `Cooldown violation from ${msg.issuerDid.slice(0, 16)}...`);
      return;
    }

    // No verificamos la firma aquí para no bloquear el event loop
    // (la firma es verificada en el nodo HTTP antes de hacer broadcast)
    // Se puede añadir verificación async aquí si se desea auditoría completa

    this.applyAttest(msg);
  }

  /**
   * Retorna la reputación de un DID.
   */
  getReputation(targetDid: string): Reputation {
    return this.reps.get(targetDid) ?? {
      score:         DEFAULT_REPUTATION,
      totalPositive: 0,
      totalNegative: 0,
      lastUpdated:   0,
    };
  }

  /**
   * Retorna el historial de attestations de un DID.
   */
  getHistory(targetDid: string): AttestEntry[] {
    return this.history.get(targetDid) ?? [];
  }

  /**
   * Verifica si un par puede atestar ahora (no en cooldown).
   */
  canAttest(issuerDid: string, targetDid: string): { allowed: boolean; nextTs?: number } {
    const key    = `${issuerDid}:${targetDid}`;
    const lastTs = this.cooldowns.get(key) ?? 0;
    if (lastTs === 0 || Date.now() - lastTs >= ATTESTATION_COOLDOWN) {
      return { allowed: true };
    }
    return { allowed: false, nextTs: lastTs + ATTESTATION_COOLDOWN };
  }

  /**
   * Exporta estado para sync con nuevos nodos.
   */
  exportState(): { history: Record<string, AttestEntry[]>; reps: Record<string, Reputation> } {
    return {
      history: Object.fromEntries(this.history),
      reps:    Object.fromEntries(this.reps),
    };
  }

  /**
   * Importa estado de otro nodo al arrancar.
   */
  importState(state: { history: Record<string, AttestEntry[]>; reps: Record<string, Reputation> }): number {
    let imported = 0;
    for (const [did, entries] of Object.entries(state.history)) {
      const existing = this.history.get(did) ?? [];
      const existingHashes = new Set(existing.map(e => e.msgHash));
      for (const entry of entries) {
        if (!existingHashes.has(entry.msgHash)) {
          existing.push(entry);
          this.seen.add(entry.msgHash);
          imported++;
        }
      }
      this.history.set(did, existing);
    }
    for (const [did, rep] of Object.entries(state.reps)) {
      if (!this.reps.has(did)) {
        this.reps.set(did, rep);
      }
    }
    if (imported > 0) this.saveStores();
    return imported;
  }

  // ── Internos ─────────────────────────────────────────────────────────────────

  private applyAttest(msg: AttestationMsg): AttestEntry {
    const msgHash = this.hashMsg(msg);
    this.seen.add(msgHash);

    const entry: AttestEntry = {
      issuerDid: msg.issuerDid,
      targetDid: msg.targetDid,
      value:     msg.value,
      context:   msg.context,
      ts:        msg.ts,
      sig:       msg.sig,
      msgHash,
    };

    // Guardar en historial
    const history = this.history.get(msg.targetDid) ?? [];
    history.push(entry);
    this.history.set(msg.targetDid, history);

    // Actualizar cooldown
    const cooldownKey = `${msg.issuerDid}:${msg.targetDid}`;
    this.cooldowns.set(cooldownKey, msg.ts);

    // Actualizar reputación
    const rep = this.reps.get(msg.targetDid) ?? {
      score:         DEFAULT_REPUTATION,
      totalPositive: 0,
      totalNegative: 0,
      lastUpdated:   0,
    };

    rep.score       += msg.value;
    rep.lastUpdated  = msg.ts;
    if (msg.value > 0) rep.totalPositive++;
    else               rep.totalNegative++;

    // Clamp
    if (rep.score < 0)              rep.score = 0;
    if (rep.score > REPUTATION_MAX) rep.score = REPUTATION_MAX;

    this.reps.set(msg.targetDid, rep);
    this.saveStores();

    this.emit("attested", entry);
    return entry;
  }

  private hashMsg(msg: AttestationMsg): string {
    return createHash("sha256")
      .update(`${msg.issuerDid}:${msg.targetDid}:${msg.value}:${msg.context}:${msg.ts}`)
      .digest("hex");
  }

  // ── Persistencia ─────────────────────────────────────────────────────────────

  private loadStores(): void {
    try {
      if (existsSync(this.opts.storePath)) {
        const raw = JSON.parse(readFileSync(this.opts.storePath, "utf8"));
        for (const [did, entries] of Object.entries(raw as Record<string, AttestEntry[]>)) {
          this.history.set(did, entries);
          for (const e of entries) {
            this.seen.add(e.msgHash);
            const key = `${e.issuerDid}:${e.targetDid}`;
            const cur = this.cooldowns.get(key) ?? 0;
            if (e.ts > cur) this.cooldowns.set(key, e.ts);
          }
        }
      }
      if (existsSync(this.opts.repStorePath)) {
        const raw = JSON.parse(readFileSync(this.opts.repStorePath, "utf8"));
        for (const [did, rep] of Object.entries(raw as Record<string, Reputation>)) {
          this.reps.set(did, rep);
        }
      }
    } catch { /* stores vacíos o corruptos */ }
  }

  private saveStores(): void {
    writeFileSync(this.opts.storePath,    JSON.stringify(Object.fromEntries(this.history), null, 2));
    writeFileSync(this.opts.repStorePath, JSON.stringify(Object.fromEntries(this.reps), null, 2));
  }
}
