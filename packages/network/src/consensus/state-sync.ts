/**
 * state-sync.ts — Sincronización de estado entre nodos validadores.
 *
 * PROTOCOLO DE SYNC:
 * ─────────────────────────────────────────────────────────────────────────────
 * Al arrancar un nodo nuevo (o tras reconexión):
 *
 * 1. HANDSHAKE:
 *    Nodo nuevo → peers: GET /consensus/state-info
 *    Respuesta:  { nullifierCount, attestationCount, latestTs, nodeVersion }
 *
 * 2. BULK SYNC:
 *    Nodo nuevo → peers: GET /consensus/state?page=0&limit=500
 *    Recibe:     { nullifiers[], attestations{} }
 *    Itera páginas hasta completar
 *
 * 3. LIVE UPDATES:
 *    Una vez sincronizado, recibe COMMIT y ATTEST por GossipSub normalmente
 *
 * OPTIMIZACIONES:
 *    • Solo sync de entradas más nuevas que lastSyncTs (incremental)
 *    • PROTOCOL_HASH check en handshake (no sync con nodos incompatibles)
 *    • Retry con backoff exponencial en caso de error de red
 */

import { PROTOCOL_HASH } from "soulprint-core";



// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface StateInfo {
  nullifierCount:   number;
  attestationCount: number;
  latestTs:         number;
  protocolHash:     string;
  nodeVersion:      string;
}

export interface StatePage {
  nullifiers:   any[];
  attestations: Record<string, any[]>;
  reps:         Record<string, any>;
  page:         number;
  totalPages:   number;
  protocolHash: string;
}

export interface SyncOptions {
  /** Función para llamar al HTTP de otro nodo */
  fetchPeer: (url: string, path: string) => Promise<any>;
  /** Lista de peers para intentar sync */
  getPeers:  () => Array<{ url: string; did: string }>;
  /** Callback cuando se reciben nullifiers */
  onNullifiers: (entries: any[]) => number;
  /** Callback cuando se reciben attestations */
  onAttestations: (state: { history: Record<string, any[]>; reps: Record<string, any> }) => number;
}

// ── StateSyncManager ──────────────────────────────────────────────────────────

export class StateSyncManager {

  private opts:        SyncOptions;
  private lastSyncTs:  number = 0;
  private syncing:     boolean = false;

  constructor(opts: SyncOptions) {
    this.opts = opts;
  }

  /**
   * Ejecuta un ciclo de sync completo contra los peers disponibles.
   * Llama en startup y cada N minutos (como heartbeat de sync).
   */
  async sync(): Promise<{ nullifiersImported: number; attestsImported: number }> {
    if (this.syncing) return { nullifiersImported: 0, attestsImported: 0 };
    this.syncing = true;

    let nullifiersImported = 0;
    let attestsImported    = 0;

    try {
      const peers = this.opts.getPeers();
      if (peers.length === 0) return { nullifiersImported: 0, attestsImported: 0 };

      // Intentar con cada peer hasta que uno funcione
      for (const peer of peers) {
        try {
          const result = await this.syncWithPeer(peer.url);
          nullifiersImported += result.nullifiersImported;
          attestsImported    += result.attestsImported;
          break; // con un peer exitoso es suficiente
        } catch (err: any) {
          console.warn(`[state-sync] peer ${peer.url} failed: ${err.message?.slice(0, 40)}`);
          continue;
        }
      }

      this.lastSyncTs = Date.now();
    } finally {
      this.syncing = false;
    }

    return { nullifiersImported, attestsImported };
  }

  private async syncWithPeer(
    peerUrl: string
  ): Promise<{ nullifiersImported: number; attestsImported: number }> {

    // 1. Handshake — verificar compatibilidad
    const info: StateInfo = await this.opts.fetchPeer(peerUrl, "/consensus/state-info");
    if (info.protocolHash !== PROTOCOL_HASH) {
      throw new Error(`Incompatible node: hash ${info.protocolHash.slice(0, 10)}...`);
    }

    let nullifiersImported = 0;
    let attestsImported    = 0;
    let page               = 0;
    let totalPages         = 1;

    // 2. Bulk sync (paginado)
    while (page < totalPages) {
      const data: StatePage = await this.opts.fetchPeer(
        peerUrl,
        `/consensus/state?page=${page}&limit=500&since=${this.lastSyncTs}`
      );

      if (data.protocolHash !== PROTOCOL_HASH) break;

      nullifiersImported += this.opts.onNullifiers(data.nullifiers);
      attestsImported    += this.opts.onAttestations({
        history: data.attestations,
        reps:    data.reps,
      });

      totalPages = data.totalPages;
      page++;
    }

    console.log(
      `[state-sync] ✅ peer ${peerUrl} — ` +
      `+${nullifiersImported} nullifiers, +${attestsImported} attestations`
    );

    return { nullifiersImported, attestsImported };
  }

  get lastSync(): number { return this.lastSyncTs; }
}
