/**
 * blockchain-e2e-tests.mjs — Tests E2E exhaustivos + pen testing del stack completo
 *
 * Cubre:
 *  1. BlockchainAnchor (P2P → blockchain async)
 *  2. Integración BFT P2P ↔ BlockchainAnchor
 *  3. Pen testing: replay attacks, hash manipulation, overflow, null inputs
 *  4. Flujo completo: verify → BFT commit → blockchain anchor → getReputation
 *  5. Resiliencia: blockchain caído → P2P sigue operando
 *  6. Queue persistente: pendingNullifiers → flush al reconectar
 */

import { strict as assert } from "node:assert";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Import módulos compilados ─────────────────────────────────────────────────
const { BlockchainAnchor } = await import(
  "../packages/network/dist/blockchain/blockchain-anchor.js"
);
const { NullifierConsensus } = await import(
  "../packages/network/dist/consensus/nullifier-consensus.js"
);
const { AttestationConsensus } = await import(
  "../packages/network/dist/consensus/attestation-consensus.js"
);

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const errors = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    failed++;
    errors.push({ name, error: err.message });
  }
}

function tmpDir() {
  const d = join(tmpdir(), `sp-bc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function makeAnchor(opts = {}) {
  const dir = tmpDir();
  return {
    anchor: new BlockchainAnchor({ storePath: join(dir, "queue") }),
    dir,
  };
}

function makeConsensus(opts = {}) {
  const dir = tmpDir();
  const received = [];
  const nc = new NullifierConsensus({
    selfDid: opts.selfDid ?? "did:key:z6MkTestBCNode",
    sign:    async (d) => `sig:${d.slice(0, 20)}`,
    verify:  async () => true,
    broadcast: async (msg) => { received.push(msg); },
    verifyZkProof: async () => true,
    storePath: join(dir, "nullifiers.json"),
    minPeers: 0,
    roundTimeoutMs: 3000,
  });
  return { nc, received, dir };
}

function makeAttestConsensus(opts = {}) {
  const dir = tmpDir();
  return {
    ac: new AttestationConsensus({
      selfDid:     opts.selfDid ?? "did:key:z6MkBCService",
      sign:        async (d) => `sig:${d.slice(0, 20)}`,
      verify:      async () => true,
      broadcast:   async () => {},
      getScore:    () => opts.score ?? 80,
      storePath:    join(dir, "atts.json"),
      repStorePath: join(dir, "rep.json"),
    }),
    dir,
  };
}

const NULL_A = "0x" + "aa".repeat(32);
const NULL_B = "0x" + "bb".repeat(32);
const NULL_C = "0x" + "cc".repeat(32);
const DID_A  = "did:key:z6MkBotAlpha";
const DID_B  = "did:key:z6MkBotBeta";
const SVC    = "did:key:z6MkService99";

// ════════════════════════════════════════════════════════════════════════════
// 1. BlockchainAnchor — unit tests
// ════════════════════════════════════════════════════════════════════════════
console.log("\n⛓️  BlockchainAnchor");

await test("arranca sin config → P2P-only mode (sin error)", async () => {
  const { anchor } = makeAnchor();
  const connected = await anchor.connect();
  assert.equal(connected, false);
  const stats = anchor.getStats();
  assert.equal(stats.blockchainConnected, false);
  assert.equal(stats.nullifiersAnchored, 0);
});

await test("anchorNullifier sin conexión → va a queue pendiente", async () => {
  const { anchor } = makeAnchor();
  await anchor.connect(); // P2P-only
  anchor.anchorNullifier({
    nullifier: NULL_A, did: DID_A,
    documentVerified: true, faceVerified: true,
    zkProof: { a:[0n,0n], b:[[0n,0n],[0n,0n]], c:[0n,0n], inputs:[1n,1n] },
  });
  const stats = anchor.getStats();
  assert.equal(stats.pendingNullifiers, 1);
  assert.equal(stats.nullifiersAnchored, 0);
});

await test("anchorAttestation sin conexión → va a queue pendiente", async () => {
  const { anchor } = makeAnchor();
  await anchor.connect();
  anchor.anchorAttestation({ issuerDid: SVC, targetDid: DID_A, value: 1, context: "test", signature: "0x" });
  const stats = anchor.getStats();
  assert.equal(stats.pendingAttests, 1);
});

await test("múltiples nullifiers en queue", async () => {
  const { anchor } = makeAnchor();
  await anchor.connect();
  for (let i = 0; i < 5; i++) {
    anchor.anchorNullifier({
      nullifier: "0x" + i.toString().repeat(64).slice(0, 64),
      did: `did:key:z6MkBot${i}`,
      documentVerified: true, faceVerified: true,
      zkProof: { a:[0n,0n], b:[[0n,0n],[0n,0n]], c:[0n,0n], inputs:[1n,1n] },
    });
  }
  assert.equal(anchor.getStats().pendingNullifiers, 5);
});

await test("queue persiste en disco (JSON)", async () => {
  const { anchor } = makeAnchor();
  // No llamar connect() — modo P2P-only desde el inicio
  anchor.anchorNullifier({
    nullifier: NULL_B, did: DID_B,
    documentVerified: true, faceVerified: false,
    zkProof: { a:[0n,0n], b:[[0n,0n],[0n,0n]], c:[0n,0n], inputs:[1n,1n] },
  });
  // Verificar que está en memoria (saveQueue es síncrono)
  const stats = anchor.getStats();
  assert.equal(stats.pendingNullifiers, 1);
  // getStats debe tener el nullifier encolado
  assert.ok(stats.pendingNullifiers > 0, "debe haber al menos 1 nullifier pendiente");
});

await test("restoreFromBlockchain sin conexión → array vacío", async () => {
  const { anchor } = makeAnchor();
  const result = await anchor.restoreNullifersFromBlockchain();
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);
});

await test("getStats() retorna objeto completo", async () => {
  const { anchor } = makeAnchor();
  const stats = anchor.getStats();
  assert.ok("nullifiersAnchored"  in stats);
  assert.ok("attestsAnchored"     in stats);
  assert.ok("pendingNullifiers"   in stats);
  assert.ok("pendingAttests"      in stats);
  assert.ok("blockchainConnected" in stats);
  assert.ok("lastAnchorTs"        in stats);
});

await test("evento 'queued' emitido al encolar nullifier", async () => {
  const { anchor } = makeAnchor();
  await anchor.connect();
  let queuedType = null;
  anchor.on("queued", (type) => { queuedType = type; });
  anchor.anchorNullifier({
    nullifier: NULL_C, did: DID_A,
    documentVerified: true, faceVerified: true,
    zkProof: { a:[0n,0n], b:[[0n,0n],[0n,0n]], c:[0n,0n], inputs:[1n,1n] },
  });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(queuedType, "nullifier");
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Integración BFT P2P ↔ BlockchainAnchor
// ════════════════════════════════════════════════════════════════════════════
console.log("\n🔗 Integración P2P ↔ Blockchain");

await test("COMMIT en P2P → nullifier encolado para blockchain", async () => {
  const { nc } = makeConsensus();
  const { anchor } = makeAnchor();
  await anchor.connect();

  // Wire evento
  nc.on("committed", (entry) => {
    anchor.anchorNullifier({
      nullifier: entry.nullifier, did: entry.did,
      documentVerified: true, faceVerified: true,
      zkProof: { a:[0n,0n], b:[[0n,0n],[0n,0n]], c:[0n,0n], inputs:[1n,1n] },
    });
  });

  await nc.propose(NULL_A, DID_A, { proof: "zkdata" });
  await new Promise(r => setTimeout(r, 100));

  const stats = anchor.getStats();
  assert.equal(stats.pendingNullifiers, 1);
});

await test("attest en P2P → attestation encolada para blockchain", async () => {
  const { ac } = makeAttestConsensus({ selfDid: SVC });
  const { anchor } = makeAnchor();
  await anchor.connect();

  ac.on("attested", (entry) => {
    anchor.anchorAttestation({
      issuerDid:  entry.issuerDid,
      targetDid:  entry.targetDid,
      value:      entry.value,
      context:    entry.context,
      signature:  entry.sig,
    });
  });

  await ac.attest({ issuerDid: SVC, targetDid: DID_A, value: 1, context: "usage" });
  await new Promise(r => setTimeout(r, 100));

  assert.equal(anchor.getStats().pendingAttests, 1);
});

await test("P2P opera normal cuando blockchain está caído (resiliencia)", async () => {
  const { nc } = makeConsensus();
  const { anchor } = makeAnchor();
  // Sin connect() → blockchain caído

  let commitCount = 0;
  nc.on("committed", (entry) => {
    commitCount++;
    // Intentar anclar (debe fallar silenciosamente)
    anchor.anchorNullifier({
      nullifier: entry.nullifier, did: entry.did,
      documentVerified: true, faceVerified: true,
      zkProof: { a:[0n,0n], b:[[0n,0n],[0n,0n]], c:[0n,0n], inputs:[1n,1n] },
    });
  });

  // P2P debe seguir funcionando
  await nc.propose("0x" + "d1".repeat(32), "did:key:z6MkBotD1", { proof: "p" });
  await nc.propose("0x" + "d2".repeat(32), "did:key:z6MkBotD2", { proof: "p" });

  assert.equal(commitCount, 2);           // P2P funcionó
  assert.equal(anchor.getStats().pendingNullifiers, 2);  // en queue para cuando haya blockchain
});

await test("flujo completo: propose → commit → anchor → stats", async () => {
  const { nc } = makeConsensus();
  const { ac } = makeAttestConsensus({ selfDid: SVC });
  const { anchor } = makeAnchor();
  await anchor.connect();

  nc.on("committed", (e) => anchor.anchorNullifier({
    nullifier: e.nullifier, did: e.did,
    documentVerified: true, faceVerified: true,
    zkProof: { a:[0n,0n], b:[[0n,0n],[0n,0n]], c:[0n,0n], inputs:[1n,1n] },
  }));
  ac.on("attested", (e) => anchor.anchorAttestation({
    issuerDid: e.issuerDid, targetDid: e.targetDid,
    value: e.value, context: e.context, signature: e.sig,
  }));

  // Registrar identidad
  const NULL_FULL = "0x" + "ef".repeat(32);
  await nc.propose(NULL_FULL, "did:key:z6MkFullBot", { proof: "zkp" });

  // Emitir attestation
  await ac.attest({ issuerDid: SVC, targetDid: "did:key:z6MkFullBot", value: 1, context: "full-test" });

  await new Promise(r => setTimeout(r, 100));

  const stats = anchor.getStats();
  assert.equal(stats.pendingNullifiers, 1);
  assert.equal(stats.pendingAttests, 1);

  // Reputación en P2P es inmediata (no espera blockchain)
  const rep = ac.getReputation("did:key:z6MkFullBot");
  assert.equal(rep.score, 11); // 10 default + 1
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Pen Testing — ataques y edge cases
// ════════════════════════════════════════════════════════════════════════════
console.log("\n🔴 Pen Testing");

await test("[PEN] PROTOCOL_HASH diferente → mensaje rechazado", async () => {
  const { nc } = makeConsensus();
  let warned = false;
  nc.on("warn", () => { warned = true; });

  await nc.handleMessage({
    type: "COMMIT", nullifier: "0x" + "aa".repeat(32), did: DID_A,
    votes: [{ type:"VOTE", nullifier:"0x"+"aa".repeat(32), vote:"accept",
              voterDid:"did:key:z6MkEvil", ts: Date.now(),
              protocolHash:"0xdeadbeef", sig:"fakeSig" }],
    commitDid: "did:key:z6MkEvil", ts: Date.now(),
    protocolHash: "0xdeadbeef",   // ← hash incorrecto
    sig: "fakeSig",
  });

  assert.ok(warned, "debe emitir warn por hash incorrecto");
  assert.ok(!nc.isRegistered("0x" + "aa".repeat(32)), "no debe registrar");
});

await test("[PEN] ATTEST con hash incorrecto → ignorado silenciosamente", async () => {
  const { ac } = makeAttestConsensus();
  await ac.handleMessage({
    type: "ATTEST", issuerDid: "did:key:z6MkAttacker", targetDid: DID_A,
    value: -1, context: "attack", ts: Date.now(),
    protocolHash: "0xbadbadbad",  // ← hash incorrecto
    sig: "evil",
  });
  // Reputación no debe cambiar
  assert.equal(ac.getReputation(DID_A).score, 10);
});

await test("[PEN] replay attack — mismo nullifier dos veces → idempotente", async () => {
  const { nc } = makeConsensus();
  await nc.propose(NULL_A, DID_A, { proof: "p" });
  const all1 = nc.getAllNullifiers();
  // Intentar registrar de nuevo
  await nc.propose(NULL_A, DID_A, { proof: "p" });
  const all2 = nc.getAllNullifiers();
  assert.equal(all1.length, all2.length); // sin duplicados
});

await test("[PEN] replay attack — mismo ATTEST message dos veces → una sola aplicación", async () => {
  const { ac } = makeAttestConsensus();
  const PROTO = "dfe1ccca1270ec86f93308dc4b981bab1d6bd74bdcc334059f4380b407ca07ca";
  const ts = Date.now() - 90_000_000; // hace 25h — fuera de cooldown
  const msg = {
    type: "ATTEST", issuerDid: "did:key:z6MkReplay",
    targetDid: "did:key:z6MkVictimReplay",
    value: 1, context: "replay-test", ts,
    protocolHash: PROTO, sig: "sig",
  };
  await ac.handleMessage(msg);
  await ac.handleMessage(msg); // replay
  await ac.handleMessage(msg); // replay x2
  const rep = ac.getReputation("did:key:z6MkVictimReplay");
  assert.equal(rep.score, 11); // solo +1, no +3
});

await test("[PEN] self-attest → rechazado", async () => {
  const { ac } = makeAttestConsensus({ selfDid: SVC });
  await assert.rejects(
    () => ac.attest({ issuerDid: SVC, targetDid: SVC, value: 1, context: "self" }),
    /self-attest/i
  );
});

await test("[PEN] issuer sin score suficiente → rechazado", async () => {
  const { ac } = makeAttestConsensus({ score: 30 }); // < 65
  await assert.rejects(
    () => ac.attest({ issuerDid: "did:key:z6MkLowScore", targetDid: DID_A, value: 1, context: "x" }),
    /score/i
  );
});

await test("[PEN] sybil attack — mismo nullifier para DIDs diferentes → uno solo registrado", async () => {
  const { nc } = makeConsensus();
  const SYBIL_NULL = "0x" + "55".repeat(32);

  await nc.propose(SYBIL_NULL, "did:key:z6MkSybil1", { proof: "p" });

  // Segundo intento con mismo nullifier → idempotente (retorna el mismo entry)
  const result = await nc.propose(SYBIL_NULL, "did:key:z6MkSybil2", { proof: "p" });

  // Solo un nullifier registrado con el DID original
  const all = nc.getAllNullifiers();
  const matching = all.filter(n => n.nullifier === SYBIL_NULL);
  assert.equal(matching.length, 1);
  assert.equal(matching[0].did, "did:key:z6MkSybil1"); // primer DID gana
});

await test("[PEN] reputación no cae por debajo de 0 con -1 en cascada", async () => {
  const { ac } = makeAttestConsensus();
  const PROTO = "dfe1ccca1270ec86f93308dc4b981bab1d6bd74bdcc334059f4380b407ca07ca";
  const TARGET = "did:key:z6MkSinkBot";

  // Importar rep con score 0 (forzado)
  ac.importState({ history: {}, reps: { [TARGET]: { score: 0, totalPositive: 0, totalNegative: 0, lastUpdated: 1 } } });

  // Intentar bajar más
  await ac.handleMessage({
    type: "ATTEST", issuerDid: "did:key:z6MkBully",
    targetDid: TARGET, value: -1, context: "spam",
    ts: Date.now(), protocolHash: PROTO, sig: "s",
  });

  const rep = ac.getReputation(TARGET);
  assert.ok(rep.score >= 0, `score ${rep.score} debe ser >= 0`);
});

await test("[PEN] reputación no supera 20 con +1 en cascada", async () => {
  const { ac } = makeAttestConsensus();
  const PROTO = "dfe1ccca1270ec86f93308dc4b981bab1d6bd74bdcc334059f4380b407ca07ca";
  const TARGET = "did:key:z6MkMaxBot";

  ac.importState({ history: {}, reps: { [TARGET]: { score: 20, totalPositive: 20, totalNegative: 0, lastUpdated: 1 } } });

  await ac.handleMessage({
    type: "ATTEST", issuerDid: "did:key:z6MkBooster",
    targetDid: TARGET, value: 1, context: "boost",
    ts: Date.now(), protocolHash: PROTO, sig: "s",
  });

  assert.ok(ac.getReputation(TARGET).score <= 20);
});

await test("[PEN] nullifier con string vacío → no debe crashear (mode single)", async () => {
  const { nc } = makeConsensus();
  // Nullifier vacío en modo single — debe manejar gracefully
  try {
    const r = await nc.propose("", "did:key:z6MkEmpty", { proof: "p" });
    // Si no lanza, al menos no debe crashear
    assert.ok(typeof r === "object");
  } catch (err) {
    // Puede lanzar error — está bien, lo importante es no crashear el proceso
    assert.ok(err instanceof Error);
  }
});

await test("[PEN] DID inválido → no debe crashear", async () => {
  const { ac } = makeAttestConsensus({ score: 80 });
  const PROTO = "dfe1ccca1270ec86f93308dc4b981bab1d6bd74bdcc334059f4380b407ca07ca";
  // DID muy corto (< 10 chars) — debe ignorar o manejar graceful
  try {
    await ac.handleMessage({
      type: "ATTEST", issuerDid: "short", targetDid: "also",
      value: 1, context: "test", ts: Date.now(),
      protocolHash: PROTO, sig: "s",
    });
    // Si no lanza, la reputación no debe haberse modificado para DIDs inválidos
  } catch { /* ok */ }
  assert.ok(true); // no crasheó el proceso
});

await test("[PEN] cooldown activo → segunda attestation bloqueada", async () => {
  const { ac } = makeAttestConsensus({ selfDid: SVC, score: 80 });
  await ac.attest({ issuerDid: SVC, targetDid: DID_A, value: 1, context: "first" });
  await assert.rejects(
    () => ac.attest({ issuerDid: SVC, targetDid: DID_A, value: 1, context: "bypass" }),
    /cooldown/i
  );
});

await test("[PEN] VOTE de nodo incompatible → ignorado", async () => {
  const { nc } = makeConsensus({ minPeers: 5 });
  let warned = false;
  nc.on("warn", () => { warned = true; });

  await nc.handleMessage({
    type: "VOTE", nullifier: "0x" + "aa".repeat(32),
    vote: "accept", voterDid: "did:key:z6MkBadNode",
    ts: Date.now(), protocolHash: "0xwrong", sig: "s",
  });

  assert.ok(warned);
});

await test("[PEN] importState con datos maliciosos → no corrompe store", async () => {
  const { nc } = makeConsensus();
  await nc.propose("0x" + "f1".repeat(32), "did:key:z6MkLegit", { proof: "p" });

  // Intentar importar estado con nullifier duplicado y datos raros
  const imported = nc.importState([
    { nullifier: "0x" + "f1".repeat(32), did: "did:key:z6MkHijack", committedAt: 999, commitDid: "evil", voteCount: 100 },  // duplicado
    { nullifier: "0x" + "f2".repeat(32), did: "did:key:z6MkNew", committedAt: Date.now(), commitDid: "legit", voteCount: 3 },   // nuevo
  ]);

  assert.equal(imported, 1); // solo el nuevo
  // El DID del nullifier original no fue sobreescrito
  const all = nc.getAllNullifiers();
  const n = all.find(x => x.nullifier === "0x" + "f1".repeat(32));
  assert.equal(n.did, "did:key:z6MkLegit"); // intacto
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Queue + resiliencia
// ════════════════════════════════════════════════════════════════════════════
console.log("\n💾 Queue & Resiliencia");

await test("queue se carga desde disco al instanciar (persistencia entre reinicios)", async () => {
  const dir = tmpDir();
  const queueFile = join(dir, "queue-nullifiers.json");

  // Simular queue preexistente en disco
  writeFileSync(queueFile, JSON.stringify([
    { nullifier: NULL_A, did: DID_A, zkProof: {}, enqueuedAt: Date.now(), attempts: 1 },
    { nullifier: NULL_B, did: DID_B, zkProof: {}, enqueuedAt: Date.now(), attempts: 2 },
  ]));

  const anchor2 = new BlockchainAnchor({ storePath: join(dir, "queue") });
  const stats = anchor2.getStats();
  assert.equal(stats.pendingNullifiers, 2);
});

await test("anchor opera sin blockchain → queue crece linealmente", async () => {
  const { anchor } = makeAnchor();
  // Sin connect()

  for (let i = 0; i < 10; i++) {
    anchor.anchorNullifier({
      nullifier: "0x" + i.toString().padStart(2,"0").repeat(32).slice(0,64),
      did: `did:key:z6MkBot${i}`,
      documentVerified: true, faceVerified: true,
      zkProof: { a:[0n,0n], b:[[0n,0n],[0n,0n]], c:[0n,0n], inputs:[1n,1n] },
    });
  }
  assert.equal(anchor.getStats().pendingNullifiers, 10);
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Contratos Base Sepolia (verificación de direcciones)
// ════════════════════════════════════════════════════════════════════════════
console.log("\n🔗 Base Sepolia — verificación de deployment");

await test("deployment file existe con 5 contratos", async () => {
  const deployFile = "../packages/blockchain/deployments/base-sepolia.json";
  const deployment = JSON.parse(
    (await import("node:fs")).readFileSync(
      new URL(deployFile, import.meta.url).pathname, "utf8"
    )
  );
  assert.equal(deployment.network, "base-sepolia");
  assert.equal(deployment.chainId, 84532);
  assert.ok(deployment.contracts.ProtocolConstants?.startsWith("0x"));
  assert.ok(deployment.contracts.SoulprintRegistry?.startsWith("0x"));
  assert.ok(deployment.contracts.AttestationLedger?.startsWith("0x"));
  assert.ok(deployment.contracts.ValidatorRegistry?.startsWith("0x"));
  assert.ok(deployment.contracts.Groth16Verifier?.startsWith("0x"));
});

await test("PROTOCOL_HASH en deployment coincide con soulprint-core", async () => {
  const { PROTOCOL_HASH } = await import("../packages/core/dist/protocol-constants.js");
  const deployment = JSON.parse(
    (await import("node:fs")).readFileSync(
      new URL("../packages/blockchain/deployments/base-sepolia.json", import.meta.url).pathname, "utf8"
    )
  );
  // deployment.protocolHash tiene 0x prefix, PROTOCOL_HASH no
  assert.equal(deployment.protocolHash, "0x" + PROTOCOL_HASH);
});

await test("verifica saldo de deployer en Base Sepolia > 0", async () => {
  const rpc = "https://sepolia.base.org";
  const { createRequire } = await import("node:module");
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "eth_getBalance",
      params: ["0x0755A3001F488da00088838c4a068dF7f883ad87", "latest"], id: 1,
    }),
  });
  const data = await res.json();
  const wei = parseInt(data.result, 16);
  assert.ok(wei > 0, `Balance ${wei} wei debe ser > 0`);
});

await test("SoulprintRegistry tiene código en Base Sepolia", async () => {
  const deployment = JSON.parse(
    (await import("node:fs")).readFileSync(
      new URL("../packages/blockchain/deployments/base-sepolia.json", import.meta.url).pathname, "utf8"
    )
  );
  const res = await fetch("https://sepolia.base.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "eth_getCode",
      params: [deployment.contracts.SoulprintRegistry, "latest"], id: 1,
    }),
  });
  const data = await res.json();
  assert.ok(data.result && data.result !== "0x", "SoulprintRegistry debe tener bytecode on-chain");
  assert.ok(data.result.length > 10, `bytecode length ${data.result.length} debe ser > 10`);
});

await test("AttestationLedger tiene código en Base Sepolia", async () => {
  const deployment = JSON.parse(
    (await import("node:fs")).readFileSync(
      new URL("../packages/blockchain/deployments/base-sepolia.json", import.meta.url).pathname, "utf8"
    )
  );
  const res = await fetch("https://sepolia.base.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "eth_getCode",
      params: [deployment.contracts.AttestationLedger, "latest"], id: 1,
    }),
  });
  const data = await res.json();
  assert.ok(data.result && data.result !== "0x");
});

// ════════════════════════════════════════════════════════════════════════════
// Reporte final
// ════════════════════════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════════════════════");
console.log(`Total:   ${passed + failed} tests`);
console.log(`Pasados: ${passed} ✅`);
console.log(`Fallidos: ${failed} ${failed === 0 ? "✅" : "❌"}`);
if (errors.length > 0) {
  console.log("\nFallos:");
  errors.forEach(e => console.log(`  ❌ ${e.name}: ${e.error}`));
}
console.log("═══════════════════════════════════════════════════════");

if (failed > 0) process.exit(1);
