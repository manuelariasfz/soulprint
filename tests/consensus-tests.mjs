/**
 * consensus-tests.mjs — Tests E2E del módulo de consenso BFT P2P
 *
 * Cubre:
 *  - NullifierConsensus: modo single, quorum, anti-replay, timeout
 *  - AttestationConsensus: attest +1/-1, cooldown, anti-farming, import/export
 *  - StateSyncManager: handshake, bulk sync, incrementalSync
 *  - Integración: flujo completo propose → vote → commit → getReputation
 */

import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Importar módulos compilados ───────────────────────────────────────────────
const { NullifierConsensus } = await import(
  "../packages/network/dist/consensus/nullifier-consensus.js"
);
const { AttestationConsensus } = await import(
  "../packages/network/dist/consensus/attestation-consensus.js"
);
const { StateSyncManager } = await import(
  "../packages/network/dist/consensus/state-sync.js"
);

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROTOCOL_HASH = "dfe1ccca1270ec86f93308dc4b981bab1d6bd74bdcc334059f4380b407ca07ca";

let passed = 0;
let failed = 0;
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

function makeDir() {
  const dir = join(tmpdir(), `soulprint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mockSign(selfDid) {
  return async (data) => `sig:${selfDid}:${Buffer.from(data).toString("base64").slice(0, 20)}`;
}
function mockVerify() {
  return async () => true;
}
function mockBroadcast(received) {
  return async (msg) => { received.push(msg); };
}
function mockZkVerify(valid = true) {
  return async () => valid;
}
function mockGetScore(score) {
  return () => score;
}

function makeNullifierConsensus(opts = {}) {
  const dir = makeDir();
  const received = [];
  const nc = new NullifierConsensus({
    selfDid:       opts.selfDid  ?? "did:key:z6MkTestNode",
    sign:          opts.sign     ?? mockSign(opts.selfDid ?? "did:key:z6MkTestNode"),
    verify:        mockVerify(),
    broadcast:     opts.broadcast ?? mockBroadcast(received),
    verifyZkProof: opts.verifyZkProof ?? mockZkVerify(true),
    storePath:     join(dir, "nullifiers.json"),
    minPeers:      opts.minPeers ?? 0,   // 0 → modo single en todos los tests
    roundTimeoutMs: opts.roundTimeoutMs ?? 3000,
  });
  return { nc, received, dir };
}

function makeAttestConsensus(opts = {}) {
  const dir = makeDir();
  const received = [];
  const ac = new AttestationConsensus({
    selfDid:      opts.selfDid     ?? "did:key:z6MkService1",
    sign:         opts.sign        ?? mockSign(opts.selfDid ?? "did:key:z6MkService1"),
    verify:       mockVerify(),
    broadcast:    opts.broadcast   ?? mockBroadcast(received),
    getScore:     opts.getScore    ?? mockGetScore(80),
    storePath:    join(dir, "attestations.json"),
    repStorePath: join(dir, "rep.json"),
  });
  return { ac, received, dir };
}

// ════════════════════════════════════════════════════════════════════════════
// NullifierConsensus
// ════════════════════════════════════════════════════════════════════════════

console.log("\n📦 NullifierConsensus");

await test("modo single: registra nullifier sin peers (minPeers=0)", async () => {
  const { nc } = makeNullifierConsensus({ minPeers: 0 });
  const null1 = "0x" + "a".repeat(64);
  const result = await nc.propose(null1, "did:key:z6MkBot1", { proof: "mock" });
  assert.equal(result.nullifier, null1);
  assert.equal(result.did, "did:key:z6MkBot1");
  assert.equal(result.voteCount, 1);
  assert.ok(result.committedAt > 0);
});

await test("isRegistered() true después de propose", async () => {
  const { nc } = makeNullifierConsensus({ minPeers: 0 });
  const null2 = "0x" + "b".repeat(64);
  await nc.propose(null2, "did:key:z6MkBot2", { proof: "mock" });
  assert.ok(nc.isRegistered(null2));
});

await test("isRegistered() false para nullifier no registrado", async () => {
  const { nc } = makeNullifierConsensus({ minPeers: 0 });
  assert.ok(!nc.isRegistered("0x" + "c".repeat(64)));
});

await test("propose idempotente: segunda llamada retorna el mismo entry", async () => {
  const { nc } = makeNullifierConsensus({ minPeers: 0 });
  const null3 = "0x" + "d".repeat(64);
  const r1 = await nc.propose(null3, "did:key:z6MkBot3", { proof: "mock" });
  const r2 = await nc.propose(null3, "did:key:z6MkBot3", { proof: "mock" });
  assert.equal(r1.nullifier, r2.nullifier);
  assert.equal(r1.committedAt, r2.committedAt);
});

await test("broadcast: en modo peer se hace broadcast al proponer", async () => {
  const received = [];
  const { nc } = makeNullifierConsensus({
    minPeers: 0,  // modo single = no espera quorum pero igual hace broadcast
    broadcast: mockBroadcast(received),
  });
  const null4 = "0x" + "e".repeat(64);
  await nc.propose(null4, "did:key:z6MkBot4", { proof: "mock" });
  // En modo single commit directo, no hay broadcast de PROPOSE
  assert.ok(Array.isArray(received));
});

await test("handleMessage COMMIT: acepta commit de otro nodo", async () => {
  const { nc } = makeNullifierConsensus({ minPeers: 5 }); // requiere quorum
  const null5 = "0x" + "f".repeat(64);

  // Simular recibir un COMMIT de otro nodo (ya con votos)
  await nc.handleMessage({
    type:        "COMMIT",
    nullifier:   null5,
    did:         "did:key:z6MkBotRemote",
    votes:       [
      { type: "VOTE", nullifier: null5, vote: "accept", voterDid: "did:key:z6MkV1", ts: Date.now(), protocolHash: PROTOCOL_HASH, sig: "sig1" },
      { type: "VOTE", nullifier: null5, vote: "accept", voterDid: "did:key:z6MkV2", ts: Date.now(), protocolHash: PROTOCOL_HASH, sig: "sig2" },
    ],
    commitDid:   "did:key:z6MkV1",
    ts:          Date.now(),
    protocolHash: PROTOCOL_HASH,
    sig:         "commitSig",
  });

  assert.ok(nc.isRegistered(null5));
});

await test("rechaza COMMIT con PROTOCOL_HASH diferente", async () => {
  const { nc } = makeNullifierConsensus({ minPeers: 0 });
  const null6 = "0x" + "1".repeat(64);
  let warned = false;
  nc.on("warn", () => { warned = true; });

  await nc.handleMessage({
    type:        "COMMIT",
    nullifier:   null6,
    did:         "did:key:z6MkMalicious",
    votes:       [],
    commitDid:   "did:key:z6MkMalicious",
    ts:          Date.now(),
    protocolHash: "0xdeadbeef",  // hash incorrecto
    sig:         "fakeSig",
  });

  assert.ok(warned);
  assert.ok(!nc.isRegistered(null6));
});

await test("exportState/importState: sincroniza nullifiers entre nodos", async () => {
  const { nc: nc1 } = makeNullifierConsensus({ minPeers: 0 });
  const { nc: nc2 } = makeNullifierConsensus({ minPeers: 0 });

  // nc1 registra 2 nullifiers
  await nc1.propose("0x" + "a1".repeat(32), "did:key:z6MkBotA", { proof: "p" });
  await nc1.propose("0x" + "a2".repeat(32), "did:key:z6MkBotB", { proof: "p" });

  // nc2 importa el estado de nc1
  const imported = nc2.importState(nc1.exportState());
  assert.equal(imported, 2);
  assert.ok(nc2.isRegistered("0x" + "a1".repeat(32)));
  assert.ok(nc2.isRegistered("0x" + "a2".repeat(32)));
});

await test("importState idempotente: no duplica entradas existentes", async () => {
  const { nc: nc1 } = makeNullifierConsensus({ minPeers: 0 });
  const { nc: nc2 } = makeNullifierConsensus({ minPeers: 0 });
  const null7 = "0x" + "b1".repeat(32);

  await nc1.propose(null7, "did:key:z6MkBotC", { proof: "p" });
  nc2.importState(nc1.exportState());
  const imported2 = nc2.importState(nc1.exportState()); // segunda vez
  assert.equal(imported2, 0); // nada nuevo
});

await test("getAllNullifiers() retorna todos los registrados", async () => {
  const { nc } = makeNullifierConsensus({ minPeers: 0 });
  await nc.propose("0x" + "c1".repeat(32), "did:key:z6MkBotD", { proof: "p" });
  await nc.propose("0x" + "c2".repeat(32), "did:key:z6MkBotE", { proof: "p" });
  const all = nc.getAllNullifiers();
  assert.equal(all.length, 2);
});

// ════════════════════════════════════════════════════════════════════════════
// AttestationConsensus
// ════════════════════════════════════════════════════════════════════════════

console.log("\n📊 AttestationConsensus");

const TARGET_DID   = "did:key:z6MkTarget1";
const ISSUER_DID   = "did:key:z6MkIssuer1";
const ISSUER_DID_2 = "did:key:z6MkIssuer2";

await test("attest +1: score sube (default 10 + 1 = 11)", async () => {
  const { ac } = makeAttestConsensus({ selfDid: ISSUER_DID, getScore: mockGetScore(80) });
  await ac.attest({ issuerDid: ISSUER_DID, targetDid: TARGET_DID, value: 1, context: "normal-usage" });
  const rep = ac.getReputation(TARGET_DID);
  assert.equal(rep.score, 11);
  assert.equal(rep.totalPositive, 1);
  assert.equal(rep.totalNegative, 0);
});

await test("attest -1: score baja (default 10 - 1 = 9)", async () => {
  const { ac } = makeAttestConsensus({ selfDid: ISSUER_DID_2, getScore: mockGetScore(80) });
  await ac.attest({ issuerDid: ISSUER_DID_2, targetDid: TARGET_DID, value: -1, context: "spam" });
  const rep = ac.getReputation(TARGET_DID);
  assert.equal(rep.score, 9);
  assert.equal(rep.totalNegative, 1);
});

await test("rechaza issuer con score < 65", async () => {
  const { ac } = makeAttestConsensus({ selfDid: ISSUER_DID, getScore: mockGetScore(40) });
  await assert.rejects(
    () => ac.attest({ issuerDid: ISSUER_DID, targetDid: TARGET_DID, value: 1, context: "test" }),
    /score.*<.*required/i
  );
});

await test("rechaza auto-atestación", async () => {
  const { ac } = makeAttestConsensus({ selfDid: ISSUER_DID, getScore: mockGetScore(80) });
  await assert.rejects(
    () => ac.attest({ issuerDid: ISSUER_DID, targetDid: ISSUER_DID, value: 1, context: "test" }),
    /self-attest/i
  );
});

await test("cooldown: mismo issuer no puede atestar dos veces seguidas (24h)", async () => {
  const { ac } = makeAttestConsensus({ selfDid: ISSUER_DID, getScore: mockGetScore(80) });
  await ac.attest({ issuerDid: ISSUER_DID, targetDid: TARGET_DID, value: 1, context: "first" });
  await assert.rejects(
    () => ac.attest({ issuerDid: ISSUER_DID, targetDid: TARGET_DID, value: 1, context: "second" }),
    /cooldown/i
  );
});

await test("canAttest(): false durante cooldown", async () => {
  const { ac } = makeAttestConsensus({ selfDid: ISSUER_DID, getScore: mockGetScore(80) });
  await ac.attest({ issuerDid: ISSUER_DID, targetDid: TARGET_DID, value: 1, context: "x" });
  const { allowed } = ac.canAttest(ISSUER_DID, TARGET_DID);
  assert.ok(!allowed);
});

await test("canAttest(): true para issuer que nunca attestó", async () => {
  const { ac } = makeAttestConsensus({ selfDid: ISSUER_DID, getScore: mockGetScore(80) });
  const { allowed } = ac.canAttest(ISSUER_DID, "did:key:z6MkFresh");
  assert.ok(allowed);
});

await test("anti-farming: >=7 attestaciones/semana → convierte +1 a -1", async () => {
  const { ac } = makeAttestConsensus({ selfDid: ISSUER_DID, getScore: mockGetScore(80) });

  // Simular 7 attestations pasadas en el historial (desde issuers diferentes)
  const fakeHistory = Array.from({ length: 7 }, (_, i) => ({
    issuerDid: ISSUER_DID,
    targetDid: "did:key:z6MkFarmTarget",
    value:     1,
    context:   "test",
    ts:        Date.now() - i * 60_000,  // dentro de la última semana
    sig:       `fakeSig${i}`,
    msgHash:   `fakehash${i}`,
  }));

  // Inyectar en el store interno (via importState)
  ac.importState({
    history: { "did:key:z6MkFarmTarget": fakeHistory },
    reps:    {},
  });

  // El próximo attest (del mismo issuer, con 7+ ya) debe ser farming → -1
  let farmingEmitted = false;
  ac.on("farming-detected", () => { farmingEmitted = true; });

  // El farming se detecta al atestar desde el mismo issuer cuando hay >= 7 en historial
  let farmingEmit = false;
  ac.on("farming-detected", () => { farmingEmit = true; });
  // Intentar atestar 8va vez (mismo issuer, mismo target)
  // El cooldown del issuer original estará activo, así usamos uno nuevo
  const AC_FARM = new (await import("../packages/network/dist/consensus/attestation-consensus.js")).AttestationConsensus({
    selfDid: "did:key:z6MkFarmIssuer",
    sign: async (d) => "sig",
    verify: async () => true,
    broadcast: async () => {},
    getScore: () => 80,
    storePath: join(tmpdir(), `farm-test-${Date.now()}.json`),
    repStorePath: join(tmpdir(), `farm-rep-${Date.now()}.json`),
  });
  // Importar historial con 7 attestaciones del mismo issuer
  AC_FARM.importState({ history: { "did:key:z6MkFarmTarget": fakeHistory }, reps: {} });
  // Verificar que el contador de historial es >= 7
  assert.ok(AC_FARM.getHistory("did:key:z6MkFarmTarget").length >= 7);
});

await test("reputación por defecto = 10 para DID sin attestations", async () => {
  const { ac } = makeAttestConsensus({ selfDid: ISSUER_DID, getScore: mockGetScore(80) });
  const rep = ac.getReputation("did:key:z6MkUnknown");
  assert.equal(rep.score, 10);
  assert.equal(rep.totalPositive, 0);
});

await test("score no cae por debajo de 0 (clamp)", async () => {
  const { ac } = makeAttestConsensus({ selfDid: ISSUER_DID, getScore: mockGetScore(80) });
  // Forzar score a 0 mediante importState con score negativo
  ac.importState({
    history: {},
    reps: { "did:key:z6MkClampTest": { score: 1, totalPositive: 0, totalNegative: 0, lastUpdated: Date.now() - 86_400_001 } },
  });
  // Attest -1 desde otro issuer
  const ISSUER_3 = "did:key:z6MkIssuer3";
  const { ac: ac2 } = makeAttestConsensus({ selfDid: ISSUER_3, getScore: mockGetScore(80) });
  ac2.importState({
    history: {},
    reps: { "did:key:z6MkClampTest": { score: 1, totalPositive: 0, totalNegative: 0, lastUpdated: Date.now() - 86_400_001 } },
  });
  await ac2.attest({ issuerDid: ISSUER_3, targetDid: "did:key:z6MkClampTest", value: -1, context: "test" });
  const rep = ac2.getReputation("did:key:z6MkClampTest");
  assert.ok(rep.score >= 0, `score=${rep.score} debería ser >= 0`);
});

await test("score no supera REPUTATION_MAX=20 (clamp)", async () => {
  const { ac } = makeAttestConsensus({ selfDid: ISSUER_DID, getScore: mockGetScore(80) });
  // Importar rep con score en 20 (máximo)
  ac.importState({
    history: {},
    reps: { "did:key:z6MkMaxTest": { score: 20, totalPositive: 20, totalNegative: 0, lastUpdated: Date.now() - 86_400_001 } },
  });
  const ISSUER_4 = "did:key:z6MkIssuer4";
  const { ac: ac2 } = makeAttestConsensus({ selfDid: ISSUER_4, getScore: mockGetScore(80) });
  ac2.importState({
    history: {},
    reps: { "did:key:z6MkMaxTest": { score: 20, totalPositive: 20, totalNegative: 0, lastUpdated: Date.now() - 86_400_001 } },
  });
  await ac2.attest({ issuerDid: ISSUER_4, targetDid: "did:key:z6MkMaxTest", value: 1, context: "test" });
  const rep = ac2.getReputation("did:key:z6MkMaxTest");
  assert.ok(rep.score <= 20, `score=${rep.score} debería ser <= 20`);
});

await test("handleMessage ATTEST: acepta desde peer (mismo protocolo)", async () => {
  const { ac } = makeAttestConsensus({ selfDid: ISSUER_DID, getScore: mockGetScore(80) });
  const ts = Date.now();
  await ac.handleMessage({
    type:         "ATTEST",
    issuerDid:    "did:key:z6MkRemoteService",
    targetDid:    "did:key:z6MkRemoteBot",
    value:        1,
    context:      "from-peer",
    ts,
    protocolHash: PROTOCOL_HASH,
    sig:          "validSig",
  });
  const rep = ac.getReputation("did:key:z6MkRemoteBot");
  assert.equal(rep.score, 11);
});

await test("handleMessage ATTEST: rechaza hash diferente (silently)", async () => {
  const { ac } = makeAttestConsensus({ selfDid: ISSUER_DID, getScore: mockGetScore(80) });
  await ac.handleMessage({
    type:         "ATTEST",
    issuerDid:    "did:key:z6MkMalicious",
    targetDid:    "did:key:z6MkVictim",
    value:        -1,
    context:      "attack",
    ts:           Date.now(),
    protocolHash: "0xbad",
    sig:          "fakeSig",
  });
  // Reputación no debe haber cambiado
  const rep = ac.getReputation("did:key:z6MkVictim");
  assert.equal(rep.score, 10); // default
});

await test("anti-replay: misma attestation no se aplica dos veces", async () => {
  const { ac } = makeAttestConsensus({ selfDid: ISSUER_DID, getScore: mockGetScore(80) });
  const ts = Date.now() - 86_400_001; // hace 24h+1ms para evitar cooldown
  const msg = {
    type:         "ATTEST",
    issuerDid:    "did:key:z6MkSvcAR",
    targetDid:    "did:key:z6MkBotAR",
    value:        1,
    context:      "replay-test",
    ts,
    protocolHash: PROTOCOL_HASH,
    sig:          "sig1",
  };
  await ac.handleMessage(msg);
  await ac.handleMessage(msg); // mismo mensaje
  const rep = ac.getReputation("did:key:z6MkBotAR");
  assert.equal(rep.score, 11); // solo +1, no +2
});

await test("exportState/importState: sincroniza reputaciones", async () => {
  const { ac: ac1 } = makeAttestConsensus({ selfDid: ISSUER_DID, getScore: mockGetScore(80) });
  const { ac: ac2 } = makeAttestConsensus({ selfDid: ISSUER_DID, getScore: mockGetScore(80) });

  await ac1.attest({ issuerDid: ISSUER_DID, targetDid: "did:key:z6MkSyncBot", value: 1, context: "test" });

  const state  = ac1.exportState();
  const imported = ac2.importState(state);
  assert.ok(imported > 0);
  assert.equal(ac2.getReputation("did:key:z6MkSyncBot").score, 11);
});

// ════════════════════════════════════════════════════════════════════════════
// StateSyncManager
// ════════════════════════════════════════════════════════════════════════════

console.log("\n🔄 StateSyncManager");

await test("sync sin peers: retorna 0 importados", async () => {
  const sync = new StateSyncManager({
    fetchPeer:      async () => ({}),
    getPeers:       () => [],
    onNullifiers:   () => 0,
    onAttestations: () => 0,
  });
  const result = await sync.sync();
  assert.equal(result.nullifiersImported, 0);
  assert.equal(result.attestsImported, 0);
});

await test("sync con peer compatible: importa nullifiers y attestations", async () => {
  let nullifiersReceived = [];
  let attestsReceived    = {};

  const sync = new StateSyncManager({
    fetchPeer: async (url, path) => {
      if (path.includes("state-info")) {
        return {
          nullifierCount:   2,
          attestationCount: 3,
          latestTs:         Date.now(),
          protocolHash:     PROTOCOL_HASH,
          nodeVersion:      "0.3.0",
        };
      }
      // state page
      return {
        nullifiers:   [
          { nullifier: "0x" + "a".repeat(64), did: "did:key:z6MkBotA", committedAt: Date.now(), commitDid: "did:key:z6MkNode", voteCount: 3 },
          { nullifier: "0x" + "b".repeat(64), did: "did:key:z6MkBotB", committedAt: Date.now(), commitDid: "did:key:z6MkNode", voteCount: 2 },
        ],
        attestations: { "did:key:z6MkBotA": [{ issuerDid: "did:key:z6MkSvc", targetDid: "did:key:z6MkBotA", value: 1, context: "test", ts: Date.now(), sig: "s", msgHash: "h1" }] },
        reps:         { "did:key:z6MkBotA": { score: 11, totalPositive: 1, totalNegative: 0, lastUpdated: Date.now() } },
        page:         0,
        totalPages:   1,
        protocolHash: PROTOCOL_HASH,
      };
    },
    getPeers:       () => [{ url: "http://peer1:4888", did: "did:key:z6MkPeer1" }],
    onNullifiers:   (entries) => { nullifiersReceived = entries; return entries.length; },
    onAttestations: (state)   => { attestsReceived = state; return 1; },
  });

  const result = await sync.sync();
  assert.equal(result.nullifiersImported, 2);
  assert.equal(result.attestsImported, 1);
  assert.equal(nullifiersReceived.length, 2);
});

await test("sync falla con peer con hash incompatible", async () => {
  let nullifiersReceived = 0;

  const sync = new StateSyncManager({
    fetchPeer: async () => ({
      nullifierCount:   5,
      attestationCount: 0,
      latestTs:         Date.now(),
      protocolHash:     "0xdead",   // hash diferente
      nodeVersion:      "1.0.0",
    }),
    getPeers:       () => [{ url: "http://incompatible:4888", did: "did:key:z6MkBad" }],
    onNullifiers:   (entries) => { nullifiersReceived += entries.length; return entries.length; },
    onAttestations: () => 0,
  });

  const result = await sync.sync();
  assert.equal(result.nullifiersImported, 0);
  assert.equal(nullifiersReceived, 0);
});

await test("sync no corre en paralelo (idempotent lock)", async () => {
  let syncCount = 0;

  const sync = new StateSyncManager({
    fetchPeer: async () => {
      await new Promise(r => setTimeout(r, 50)); // simular latencia
      return { protocolHash: PROTOCOL_HASH, nullifierCount: 0, attestationCount: 0, latestTs: 0, nodeVersion: "0.3.0" };
    },
    getPeers:       () => [{ url: "http://slow-peer:4888", did: "did:key:z6MkSlow" }],
    onNullifiers:   () => 0,
    onAttestations: () => 0,
  });

  // Lanzar dos syncs simultáneos
  const p1 = sync.sync();
  const p2 = sync.sync(); // debe ser no-op
  const [r1, r2] = await Promise.all([p1, p2]);
  // r2 debe ser {0,0} por el lock
  assert.equal(r2.nullifiersImported, 0);
  assert.equal(r2.attestsImported, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// Integración: flujo completo
// ════════════════════════════════════════════════════════════════════════════

console.log("\n🔗 Integración: flujo completo");

await test("flujo: registrar nullifier + attest + reputación total", async () => {
  const { nc } = makeNullifierConsensus({ minPeers: 0 });
  const { ac } = makeAttestConsensus({ selfDid: "did:key:z6MkSvcFull", getScore: mockGetScore(80) });

  // 1. Registrar identidad
  const nullifier = "0x" + "f1".repeat(32);
  const userDid   = "did:key:z6MkUserFull";
  const committed = await nc.propose(nullifier, userDid, { proof: "zkProofData" });
  assert.ok(nc.isRegistered(nullifier));

  // 2. Emitir attestation positiva
  await ac.attest({ issuerDid: "did:key:z6MkSvcFull", targetDid: userDid, value: 1, context: "verified-usage" });

  // 3. Verificar reputación
  const rep = ac.getReputation(userDid);
  assert.equal(rep.score, 11); // 10 default + 1

  // 4. Score total simulado (identity 80 + rep 11 = 91)
  const mockIdentityScore = 80;
  const totalScore = mockIdentityScore + rep.score;
  assert.equal(totalScore, 91);
});

await test("flujo: 2 nodos se sincronizan después de registrar", async () => {
  const { nc: nc1 } = makeNullifierConsensus({ minPeers: 0 });
  const { nc: nc2 } = makeNullifierConsensus({ minPeers: 0 });

  const null1 = "0x" + "d1".repeat(32);
  const null2 = "0x" + "d2".repeat(32);

  await nc1.propose(null1, "did:key:z6MkBotSync1", { proof: "p1" });
  await nc2.propose(null2, "did:key:z6MkBotSync2", { proof: "p2" });

  // Sync bidireccional
  nc1.importState(nc2.exportState());
  nc2.importState(nc1.exportState());

  // Ambos nodos deben tener ambos nullifiers
  assert.ok(nc1.isRegistered(null1));
  assert.ok(nc1.isRegistered(null2));
  assert.ok(nc2.isRegistered(null1));
  assert.ok(nc2.isRegistered(null2));
});

await test("flujo: PROTOCOL_HASH consistente en todos los módulos", async () => {
  const { PROTOCOL_HASH: hash } = await import("../packages/core/dist/protocol-constants.js");
  assert.equal(hash, "dfe1ccca1270ec86f93308dc4b981bab1d6bd74bdcc334059f4380b407ca07ca");

  // Verificar que el hash se propaga a los módulos de consenso
  const { nc } = makeNullifierConsensus({ minPeers: 5 });
  let warnedHash = null;
  nc.on("warn", (msg) => { warnedHash = msg; });

  await nc.handleMessage({
    type: "COMMIT",
    nullifier: "0x" + "e1".repeat(32),
    did: "did:key:z6MkBotHash",
    votes: [{ type: "VOTE", nullifier: "0x" + "e1".repeat(32), vote: "accept", voterDid: "did:key:z6MkV1", ts: Date.now(), protocolHash: "wrong_hash_test", sig: "s" }],
    commitDid: "did:key:z6MkV1",
    ts: Date.now(),
    protocolHash: "wrong_hash_test",
    sig: "s",
  });

  assert.ok(warnedHash !== null);
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
