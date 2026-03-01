#!/usr/bin/env node
/**
 * Soulprint Validator Node — entrypoint v0.6.0
 *
 * Pure blockchain architecture — no libp2p.
 * The blockchain IS the network.
 */
import { startValidatorNode, setPeerRegistryClient, setNullifierRegistry, setReputationRegistry, getNodeState, setLastSyncTs } from "./validator.js";
import { computeHash, saveState } from "./state/StateStore.js";
import { PeerRegistryClient } from "./blockchain/PeerRegistryClient.js";
import { NullifierRegistryClient } from "./blockchain/NullifierRegistryClient.js";
import { ReputationRegistryClient } from "./blockchain/ReputationRegistryClient.js";

// ─── Config ──────────────────────────────────────────────────────────────────
const HTTP_PORT = parseInt(process.env.PORT ?? process.env.SOULPRINT_PORT ?? "4888");
const adminPrivateKey = process.env.ADMIN_PRIVATE_KEY;
const adminToken = process.env.ADMIN_TOKEN;
(globalThis as any)._startTime = Date.now();

// ─── Start HTTP server ────────────────────────────────────────────────────────
const httpServer = startValidatorNode(HTTP_PORT);

// ─── Init blockchain clients ──────────────────────────────────────────────────
const peerRegistry = new PeerRegistryClient({ privateKey: adminPrivateKey });
const nullifierRegistry = new NullifierRegistryClient({ privateKey: adminPrivateKey });
const reputationRegistry = new ReputationRegistryClient({ privateKey: adminPrivateKey });

setPeerRegistryClient(peerRegistry);
setNullifierRegistry(nullifierRegistry);
setReputationRegistry(reputationRegistry);

// ─── Bootstrap: read on-chain peers, register self ────────────────────────────
setTimeout(async () => {
  try {
    const chainPeers = await peerRegistry.getAllPeers().catch(() => []);
    console.log(`[peer-registry] ${chainPeers.length} peer(s) on-chain`);

    // Register HTTP peers
    for (const peer of chainPeers) {
      try {
        if (!peer.multiaddr) continue;
        if (peer.multiaddr.startsWith("http")) {
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

    // Register self on-chain
    if (!adminPrivateKey) {
      console.warn("[peer-registry] ⚠️  ADMIN_PRIVATE_KEY not set — skipping on-chain registration");
      return;
    }
    const nodeDid = (globalThis as any)._nodeDid ?? `did:soulprint:node:${Date.now()}`;
    await peerRegistry.registerSelf({
      peerDid: nodeDid,
      peerId: "",
      multiaddr: `http://localhost:${HTTP_PORT}`,
      score: 0,
    });
    console.log(`[peer-registry] ✅ Registered on-chain: ${nodeDid.slice(0, 30)}…`);
  } catch (e: any) {
    console.warn(`[peer-registry] ⚠️  Bootstrap error: ${e.message}`);
  }
}, 3_000);

// ─── HTTP Bootstrap Peers ─────────────────────────────────────────────────────
const httpBootstraps = (process.env.SOULPRINT_BOOTSTRAP_HTTP ?? "")
  .split(",").map(s => s.trim()).filter(s => s.startsWith("http"));

if (httpBootstraps.length > 0) {
  console.log(`🔗 Bootstrap HTTP: ${httpBootstraps.length} peer(s) configurados`);
  setTimeout(async () => {
    const PROTOCOL_HASH = process.env.SOULPRINT_PROTOCOL_HASH
      ?? "dfe1ccca1270ec86f93308dc4b981bab1d6bd74bdcc334059f4380b407ca07ca";
    for (const peerUrl of httpBootstraps) {
      try {
        const r = await fetch(`http://localhost:${HTTP_PORT}/peers/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: peerUrl, protocol_hash: PROTOCOL_HASH }),
          signal: AbortSignal.timeout(15_000),
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

// ─── HTTP peer sync every 5 min (simple HTTP gossip — no libp2p) ─────────────
setInterval(async () => {
  try {
    const peers = await peerRegistry.getAllPeers().catch(() => []);
    for (const peer of peers) {
      if (peer.multiaddr?.startsWith("http")) {
        await fetch(`${peer.multiaddr}/state/hash`, { signal: AbortSignal.timeout(3_000) }).catch(() => null);
      }
    }
  } catch {}
}, 30 * 60 * 1000);

// ─── Anti-entropy sync loop ───────────────────────────────────────────────────
setInterval(async () => {
  const { nullifiers, repStore, peers: knownPeers } = getNodeState();
  if (knownPeers.length === 0) return;

  const localHash = computeHash(Object.keys(nullifiers));

  for (const peerUrl of knownPeers) {
    try {
      const hashRes = await fetch(`${peerUrl}/state/hash`, { signal: AbortSignal.timeout(5_000) });
      if (!hashRes.ok) continue;
      const hashData = await hashRes.json() as any;
      if (hashData.hash === localHash) continue;

      const exportRes = await fetch(`${peerUrl}/state/export`, { signal: AbortSignal.timeout(10_000) });
      if (!exportRes.ok) continue;
      const peerState = await exportRes.json() as any;

      const mergeRes = await fetch(`http://localhost:${HTTP_PORT}/state/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(peerState),
        signal: AbortSignal.timeout(5_000),
      });
      const merged = await mergeRes.json() as any;
      console.log(`[sync] peer ${peerUrl}: merged ${merged.new_nullifiers ?? 0} nullifiers, ${merged.new_attestations ?? 0} attestations`);

      const { nullifiers: n2, repStore: r2, peers: p2 } = getNodeState();
      const ts = Date.now();
      saveState({
        nullifiers: Object.keys(n2),
        reputation: Object.fromEntries(Object.entries(r2).map(([d, e]: [string, any]) => [d, e.score])),
        attestations: Object.values(r2).flatMap((e: any) => e.attestations ?? []),
        peers: p2,
        lastSync: ts,
        stateHash: computeHash(Object.keys(n2)),
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
  httpServer.close(() => {
    console.log("  ✓ HTTP server cerrado");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
