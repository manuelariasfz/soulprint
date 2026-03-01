#!/usr/bin/env node
/**
 * Soulprint Validator Node — entrypoint
 *
 * Arranca:
 *  1. HTTP server (port 4888)    — clientes y legado
 *  2. libp2p P2P node (port 6888) — Kademlia DHT + GossipSub + mDNS
 */
import { startValidatorNode, setP2PNode, setPeerRegistryClient, getNodeState, setLastSyncTs } from "./validator.js";
import { computeHash, saveState } from "./state/StateStore.js";
import { createSoulprintP2PNode, MAINNET_BOOTSTRAP, stopP2PNode } from "./p2p.js";
import { PeerRegistryClient } from "./blockchain/PeerRegistryClient.js";

// ─── Config ──────────────────────────────────────────────────────────────────
const HTTP_PORT = parseInt(process.env.SOULPRINT_PORT     ?? "4888");
const P2P_PORT  = parseInt(process.env.SOULPRINT_P2P_PORT ?? String(HTTP_PORT + 2000));
(globalThis as any)._startTime = Date.now();

// Bootstrap nodes: variables de entorno o mainnet predefinidos
const bootstrapEnv = (process.env.SOULPRINT_BOOTSTRAP ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const bootstraps = bootstrapEnv.length > 0 ? bootstrapEnv : MAINNET_BOOTSTRAP;
const localOnly  = bootstraps.length === 0;

// ─── Arranque ────────────────────────────────────────────────────────────────
const httpServer = startValidatorNode(HTTP_PORT);
let   p2pNode: Awaited<ReturnType<typeof createSoulprintP2PNode>> | null = null;

// Intentar arrancar P2P (no fatal si falla)
try {
  console.log(`\n🔗 Arrancando nodo P2P en puerto ${P2P_PORT}...`);
  console.log(`   Modo: ${localOnly ? "local (mDNS only)" : `red principal + ${bootstraps.length} bootstrap(s)`}`);

  p2pNode = await createSoulprintP2PNode({ port: P2P_PORT, bootstraps, localOnly });

  setP2PNode(p2pNode);

  console.log(`✅ P2P activo`);
  console.log(`   Peer ID:    ${p2pNode.peerId.toString()}`);
  console.log(`   Multiaddrs: ${p2pNode.getMultiaddrs().map((m: any) => m.toString()).join(", ") || "(pendiente)"}`);
  console.log(`\n   Gossip:     HTTP fallback + GossipSub P2P`);
  console.log(`   Discovery:  mDNS${bootstraps.length > 0 ? " + DHT + Bootstrap" : " (LAN only)"}\n`);

  if (localOnly) {
    console.log(`   💡 Para conectarte a la red principal, configura SOULPRINT_BOOTSTRAP`);
    console.log(`      con multiaddrs de nodos conocidos y reinicia.\n`);
  }

} catch (err: any) {
  console.warn(`⚠️  P2P no disponible — solo HTTP gossip activo`);
  console.warn(`   Error: ${err?.message ?? String(err)}\n`);
}

// ─── On-chain PeerRegistry (auto-registro + bootstrap desde chain) ────────────
const adminPrivateKey = process.env.ADMIN_PRIVATE_KEY;
const peerRegistry = new PeerRegistryClient({
  privateKey: adminPrivateKey,
});
setPeerRegistryClient(peerRegistry);

// Bootstrap P2P + register self after node is ready (non-blocking)
setTimeout(async () => {
  try {
    // 1. Leer peers on-chain y hacer dial P2P a sus multiaddrs
    const chainPeers = await peerRegistry.getAllPeers().catch(() => []);
    if (chainPeers.length > 0) {
      console.log(`[peer-registry] 🔗 ${chainPeers.length} peer(s) encontrados on-chain — conectando...`);
      for (const peer of chainPeers) {
        try {
          if (!peer.multiaddr) continue;
          // Si es multiaddr P2P (/ip4/.../tcp/.../p2p/...) intentamos dial
          if (peer.multiaddr.startsWith("/ip4") || peer.multiaddr.startsWith("/dns")) {
            // Agregar como peer conocido via HTTP bootstrap (más estable que dial directo)
            const httpUrl = peer.multiaddr.replace(/\/ip4\/([^/]+)\/tcp\/(\d+).*/, "http://$1:$2").replace("/p2p/", "");
            if (httpUrl.startsWith("http")) {
              const PROTOCOL_HASH = "dfe1ccca1270ec86f93308dc4b981bab1d6bd74bdcc334059f4380b407ca07ca";
              await fetch(`http://localhost:${HTTP_PORT}/peers/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: httpUrl, protocol_hash: PROTOCOL_HASH }),
                signal: AbortSignal.timeout(5_000),
              }).catch(() => null);
            }
            console.log(`[peer-registry]   ✅ Peer P2P registrado: ${peer.multiaddr.slice(0, 40)}`);
          } else if (peer.multiaddr.startsWith("http")) {
            // HTTP peer — registrar vía /peers/register
            const PROTOCOL_HASH = "dfe1ccca1270ec86f93308dc4b981bab1d6bd74bdcc334059f4380b407ca07ca";
            await fetch(`http://localhost:${HTTP_PORT}/peers/register`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: peer.multiaddr, protocol_hash: PROTOCOL_HASH }),
              signal: AbortSignal.timeout(5_000),
            }).catch(() => null);
            console.log(`[peer-registry]   🌐 Peer HTTP registrado: ${peer.multiaddr}`);
          }
        } catch (e: any) {
          console.warn(`[peer-registry]   ⚠️  No se pudo conectar a ${peer.multiaddr}: ${e.message}`);
        }
      }
    } else {
      console.log("[peer-registry] ℹ️  No hay peers registrados on-chain aún — primer nodo de la red");
    }

    // 2. Registrar self on-chain
    if (!adminPrivateKey) {
      console.warn("[peer-registry] ⚠️  ADMIN_PRIVATE_KEY not set — skipping on-chain registration");
      return;
    }
    let multiaddr = `http://localhost:${HTTP_PORT}`;
    if (p2pNode) {
      const addrs: string[] = p2pNode.getMultiaddrs().map((m: any) => m.toString());
      const publicAddr = addrs.find(a => !a.includes("127.0.0.1") && !a.includes("/ip4/0.0.0.0"));
      multiaddr = publicAddr ?? addrs[0] ?? multiaddr;
    }
    const nodeDid  = (globalThis as any)._nodeDid ?? `did:soulprint:node:${Date.now()}`;
    const nodePeer = p2pNode?.peerId?.toString()  ?? "";
    await peerRegistry.registerSelf({ peerDid: nodeDid, peerId: nodePeer, multiaddr, score: 0 });
    console.log(`[peer-registry] ✅ Registrado on-chain: ${nodeDid.slice(0, 30)}…`);
  } catch (e: any) {
    console.warn(`[peer-registry] ⚠️  Error en bootstrap on-chain: ${e.message}`);
  }
}, 3_000);

// ─── HTTP Bootstrap Peers (auto-registro) ─────────────────────────────────────
// SOULPRINT_BOOTSTRAP_HTTP=http://node1:4888,http://node2:4888
// Registra peers HTTP automáticamente al arrancar (útil en WSL2 / Docker / cloud)
const httpBootstraps = (process.env.SOULPRINT_BOOTSTRAP_HTTP ?? "")
  .split(",").map(s => s.trim()).filter(s => s.startsWith("http"));

if (httpBootstraps.length > 0) {
  console.log(`🔗 Bootstrap HTTP: ${httpBootstraps.length} peer(s) configurados`);
  // Esperar 2s a que el HTTP server esté listo antes de registrar
  setTimeout(async () => {
    const PROTOCOL_HASH = process.env.SOULPRINT_PROTOCOL_HASH
      ?? "dfe1ccca1270ec86f93308dc4b981bab1d6bd74bdcc334059f4380b407ca07ca";
    for (const peerUrl of httpBootstraps) {
      try {
        const r = await fetch(`http://localhost:${HTTP_PORT}/peers/register`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ url: peerUrl, protocol_hash: PROTOCOL_HASH }),
          signal:  AbortSignal.timeout(15_000),
        });
        const d = await r.json() as any;
        if (d.ok) {
          console.log(`  ✅ Bootstrap peer registrado: ${peerUrl} (total peers: ${d.peers})`);
        } else {
          console.warn(`  ⚠️  Bootstrap peer rechazado: ${peerUrl} — ${d.error ?? d.reason ?? "?"}`);
        }
      } catch (e: any) {
        console.warn(`  ❌ No se pudo conectar a bootstrap peer: ${peerUrl} — ${e.message}`);
      }
    }
  }, 2_000);
}

// ─── Anti-entropy sync loop (v0.4.4) ─────────────────────────────────────────
// Every 60 seconds: compare state hash with each known peer.
// If diverged, fetch full state and merge locally.
setInterval(async () => {
  const { nullifiers, repStore, peers: knownPeers } = getNodeState();
  if (knownPeers.length === 0) return;

  const localHash = computeHash(Object.keys(nullifiers));

  for (const peerUrl of knownPeers) {
    try {
      const hashRes = await fetch(`${peerUrl}/state/hash`, { signal: AbortSignal.timeout(5_000) });
      if (!hashRes.ok) continue;
      const hashData = await hashRes.json() as any;
      const peerHash = hashData.hash;

      if (peerHash === localHash) {
        console.log(`[sync] peer ${peerUrl}: hash match ✅`);
        continue;
      }

      // Hashes differ — fetch full state and merge
      const exportRes = await fetch(`${peerUrl}/state/export`, { signal: AbortSignal.timeout(10_000) });
      if (!exportRes.ok) { console.warn(`[sync] peer ${peerUrl}: export failed (${exportRes.status})`); continue; }
      const peerState = await exportRes.json() as any;

      const mergeRes = await fetch(`http://localhost:${HTTP_PORT}/state/merge`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(peerState),
        signal:  AbortSignal.timeout(5_000),
      });
      const merged = await mergeRes.json() as any;
      console.log(`[sync] peer ${peerUrl}: diverged → merged ${merged.new_nullifiers ?? 0} nullifiers, ${merged.new_attestations ?? 0} attestations`);

      // Persist updated state
      const { nullifiers: n2, repStore: r2, peers: p2 } = getNodeState();
      const ts = Date.now();
      saveState({
        nullifiers:   Object.keys(n2),
        reputation:   Object.fromEntries(Object.entries(r2).map(([d, e]: [string, any]) => [d, e.score])),
        attestations: Object.values(r2).flatMap((e: any) => e.attestations ?? []),
        peers:        p2,
        lastSync:     ts,
        stateHash:    computeHash(Object.keys(n2)),
      }, 0);
      setLastSyncTs(ts);

    } catch (e: any) {
      console.warn(`[sync] peer ${peerUrl}: error — ${e.message}`);
    }
  }
}, 60_000);

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  console.log(`\n${signal} recibido — cerrando...`);
  if (p2pNode) {
    await stopP2PNode(p2pNode);
    console.log("  ✓ Nodo P2P cerrado");
  }
  httpServer.close(() => {
    console.log("  ✓ HTTP server cerrado");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
