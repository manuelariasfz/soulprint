/**
 * peer-router.ts — Routing XOR para búsqueda de peers eficiente
 *
 * PROBLEMA CON BROADCAST TOTAL:
 * ─────────────────────────────────────────────────────────────────────────
 * Gossip actual: envía attestation a TODOS los peers → O(n)
 * Con 100 nodos: 100 requests por attestation
 * Con 1000 nodos: 1000 requests — no escala
 *
 * SOLUCIÓN: Kademlia-style XOR routing
 * ─────────────────────────────────────────────────────────────────────────
 * • Cada nodo tiene un ID de 32 bytes (SHA-256 de su URL)
 * • Distancia entre dos nodos = XOR de sus IDs (métrica Kademlia)
 * • Para gossip de una attestation sobre DID X:
 *   → Seleccionar K peers más cercanos a SHA-256(X)
 *   → En redes grandes: O(log n) en lugar de O(n)
 * • Bucket table: 256 buckets por bit position
 *
 * CONFIGURACIÓN:
 * • K_FACTOR = 6: enviar a los 6 peers más cercanos al target
 * • ALPHA = 3: paralelismo de búsqueda (como Kademlia estándar)
 * • FULL_BROADCAST_THRESHOLD = 10: con ≤10 peers, broadcast total
 *   (no vale la pena routing con pocos nodos)
 */

import { createHash } from "node:crypto";

// ── Constantes ────────────────────────────────────────────────────────────────

/** Peers más cercanos a seleccionar para gossip dirigido. */
export const K_FACTOR = 6;

/** Umbral de peers bajo el cual se hace broadcast total (más simple). */
export const FULL_BROADCAST_THRESHOLD = 10;

// ── Node ID ───────────────────────────────────────────────────────────────────

/**
 * Deriva un ID de 32 bytes para una URL o DID.
 * Determinístico: misma entrada → mismo ID.
 */
export function nodeId(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

/**
 * Calcula la distancia XOR entre dos IDs (Buffer de 32 bytes).
 * Menor distancia = más cercano en el espacio Kademlia.
 */
export function xorDistance(a: Buffer, b: Buffer): Buffer {
  const result = Buffer.allocUnsafe(32);
  for (let i = 0; i < 32; i++) {
    result[i] = a[i] ^ b[i];
  }
  return result;
}

/**
 * Compara dos distancias XOR.
 * @returns negativo si a < b, 0 si iguales, positivo si a > b
 */
export function compareDistance(a: Buffer, b: Buffer): number {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// ── Peer selection ────────────────────────────────────────────────────────────

/**
 * Selecciona los K peers más cercanos al target para gossip dirigido.
 *
 * Con ≤ FULL_BROADCAST_THRESHOLD peers: retorna todos (broadcast).
 * Con más peers: retorna los K más cercanos al targetId (XOR routing).
 *
 * @param peers      Lista de URLs de peers conocidos
 * @param targetDid  DID del bot sobre el que se gossipea (target del routing)
 * @param exclude    URLs a excluir (ej: el peer que nos envió el mensaje)
 * @returns          Subconjunto de peers seleccionados para gossip
 */
export function selectGossipPeers(
  peers:     string[],
  targetDid: string,
  exclude?:  string
): string[] {
  const candidates = exclude ? peers.filter(p => p !== exclude) : [...peers];

  // Con pocos peers, broadcast total (más robusto)
  if (candidates.length <= FULL_BROADCAST_THRESHOLD) {
    return candidates;
  }

  // XOR routing: ordenar por distancia al target
  const targetBuf = nodeId(targetDid);

  const sorted = candidates
    .map(url => ({
      url,
      dist: xorDistance(nodeId(url), targetBuf),
    }))
    .sort((a, b) => compareDistance(a.dist, b.dist))
    .slice(0, K_FACTOR)
    .map(({ url }) => url);

  return sorted;
}

/**
 * Calcula estadísticas del routing para logging.
 */
export function routingStats(
  totalPeers: number,
  selectedPeers: number,
  targetDid: string
): string {
  const ratio = ((selectedPeers / totalPeers) * 100).toFixed(0);
  const mode  = totalPeers <= FULL_BROADCAST_THRESHOLD ? "broadcast" : `xor-routing(k=${K_FACTOR})`;
  return `[routing] ${selectedPeers}/${totalPeers} peers (${ratio}%) via ${mode} → ${targetDid.slice(0, 16)}...`;
}
