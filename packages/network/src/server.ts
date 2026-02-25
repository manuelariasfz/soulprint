#!/usr/bin/env node
/**
 * Soulprint Validator Node — entrypoint
 *
 * Arranca:
 *  1. HTTP server (port 4888)    — clientes y legado
 *  2. libp2p P2P node (port 6888) — Kademlia DHT + GossipSub + mDNS
 */
import { startValidatorNode, setP2PNode } from "./validator.js";
import { createSoulprintP2PNode, MAINNET_BOOTSTRAP, stopP2PNode } from "./p2p.js";

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
