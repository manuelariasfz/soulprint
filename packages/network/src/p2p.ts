/**
 * Soulprint P2P Layer — Phase 5
 *
 * libp2p con:
 *  - TCP transport
 *  - Noise encryption
 *  - Yamux multiplexing
 *  - Kademlia DHT (peer discovery internet)
 *  - GossipSub (attestation pub/sub)
 *  - mDNS (descubrimiento en LAN)
 *  - Bootstrap nodes (entry points a la red)
 */

import { createLibp2p }             from "libp2p";
import { tcp }                       from "@libp2p/tcp";
import { noise }                     from "@chainsafe/libp2p-noise";
import { yamux }                     from "@chainsafe/libp2p-yamux";
import { kadDHT }                    from "@libp2p/kad-dht";
import { gossipsub }                 from "@chainsafe/libp2p-gossipsub";
import { mdns }                      from "@libp2p/mdns";
import { bootstrap }                 from "@libp2p/bootstrap";
import { identify }                  from "@libp2p/identify";
import { ping }                      from "@libp2p/ping";
import { fromString, toString }      from "uint8arrays";
import type { Libp2p }               from "libp2p";
import type { BotAttestation }       from "soulprint-core";

// ─── Topics ──────────────────────────────────────────────────────────────────

export const TOPIC_ATTESTATIONS = "soulprint:attestations:v1";
export const TOPIC_NULLIFIERS   = "soulprint:nullifiers:v1";

// ─── Bootstrap nodes públicos (mainnet) ──────────────────────────────────────
// Vacíos hasta que desplegamos nodos públicos.
// Se pueden pasar vía SOULPRINT_BOOTSTRAP=multiaddr1,multiaddr2
export const MAINNET_BOOTSTRAP: string[] = [];

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface P2PConfig {
  /** Puerto TCP para libp2p (default: HTTP_PORT + 2000, e.g. 6888) */
  port:       number;
  /** Multiaddrs de nodos bootstrap (para conectar a la red principal) */
  bootstraps: string[];
  /** true = solo mDNS (desarrollo local). false = DHT público activado */
  localOnly:  boolean;
}

export interface P2PStats {
  peerId:       string;
  peers:        number;
  multiaddrs:   string[];
  pubsubPeers:  number;
}

export type SoulprintP2PNode = Libp2p;

// ─── Crear nodo libp2p ────────────────────────────────────────────────────────

export async function createSoulprintP2PNode(
  config: P2PConfig
): Promise<SoulprintP2PNode> {

  // Peer discovery: siempre mDNS (LAN) + bootstrap si hay nodos configurados
  const peerDiscovery: any[] = [ mdns() ];
  if (config.bootstraps.length > 0) {
    peerDiscovery.push(bootstrap({ list: config.bootstraps }));
  }

  const node = await createLibp2p({
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${config.port}`],
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery,
    services: {
      // Kademlia DHT — descubrimiento de peers en internet
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dht: kadDHT({ clientMode: false }) as any,
      // GossipSub — broadcast de attestations
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,  // publica aunque no haya peers aún
        emitSelf: false,
        // Thresholds permisivos para redes pequeñas
        scoreThresholds: {
          gossipThreshold:        -Infinity,
          publishThreshold:       -Infinity,
          graylistThreshold:      -Infinity,
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      // Identify — intercambio de metadatos entre peers
      identify: identify(),
      // Ping — requerido por KadDHT para health checks
      ping: ping(),
    },
  });

  await node.start();

  // Suscribirse a los topics de Soulprint
  (node.services as any).pubsub.subscribe(TOPIC_ATTESTATIONS);
  (node.services as any).pubsub.subscribe(TOPIC_NULLIFIERS);

  return node;
}

// ─── Publicar attestation via P2P ────────────────────────────────────────────

export async function publishAttestationP2P(
  node: SoulprintP2PNode,
  att:  BotAttestation
): Promise<number> {
  try {
    const data = fromString(JSON.stringify(att), "utf8");
    const result = await (node.services as any).pubsub.publish(
      TOPIC_ATTESTATIONS,
      data
    );
    return result?.recipients?.length ?? 0;
  } catch {
    return 0; // sin peers aún — no es error
  }
}

// ─── Recibir attestations via P2P ─────────────────────────────────────────────

export function onAttestationReceived(
  node:    SoulprintP2PNode,
  handler: (att: BotAttestation, fromPeer: string) => void
): void {
  (node.services as any).pubsub.addEventListener("message", (evt: any) => {
    if (evt.detail?.topic !== TOPIC_ATTESTATIONS) return;
    try {
      const att: BotAttestation = JSON.parse(
        toString(evt.detail.data, "utf8")
      );
      const fromPeer = evt.detail?.from?.toString() ?? "unknown";
      handler(att, fromPeer);
    } catch {
      // mensaje malformado — ignorar
    }
  });
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export function getP2PStats(node: SoulprintP2PNode): P2PStats {
  const pubsub = (node.services as any).pubsub;
  return {
    peerId:      node.peerId.toString(),
    peers:       node.getPeers().length,
    multiaddrs:  node.getMultiaddrs().map((m: any) => m.toString()),
    pubsubPeers: pubsub.getPeers?.()?.length ?? 0,
  };
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

export async function stopP2PNode(node: SoulprintP2PNode): Promise<void> {
  try { await node.stop(); } catch { /* ignorar */ }
}
