/**
 * challenge-tests.mjs — Tests para el sistema de challenge-response (v0.3.7)
 *
 * Verifica que:
 *  1. buildChallenge() genera vectores únicos (nonce diferente cada vez)
 *  2. generateInvalidProof() produce pruebas que SIEMPRE fallan snarkjs
 *  3. verifyChallengeResponse() detecta nodos comprometidos
 *  4. POST /challenge endpoint del validador funciona correctamente
 *  5. handlePeerRegister rechaza peers con ZK bypasseado
 */

import assert from "node:assert";

// Importar peer-challenge desde el dist compilado
const {
  buildChallenge,
  generateInvalidProof,
  verifyChallengeResponse,
  verifyPeerBehavior,
  PROTOCOL_CHALLENGE_VECTOR,
  buildChallengeResponse,
} = await import("../packages/network/dist/peer-challenge.js");

const {
  generateKeypair,
  sign,
} = await import("../packages/core/dist/index.js");

const {
  verifyProof,
} = await import("../packages/zkp/dist/index.js");

import { createServer }    from "node:http";

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

// ── SECCIÓN 1: Vectores del protocolo ─────────────────────────────────────────
console.log("\n📦 PROTOCOL_CHALLENGE_VECTOR — vector oficial del protocolo");

test("Vector oficial contiene prueba válida (structure check)", () => {
  assert.ok(PROTOCOL_CHALLENGE_VECTOR.proof, "debe tener proof");
  assert.ok(PROTOCOL_CHALLENGE_VECTOR.public_signals?.length > 0, "debe tener public_signals");
  assert.ok(PROTOCOL_CHALLENGE_VECTOR.nullifier?.startsWith("0x"), "nullifier debe empezar con 0x");
});

await testAsync("Vector oficial verifica como VÁLIDO con snarkjs", async () => {
  const result = await verifyProof(PROTOCOL_CHALLENGE_VECTOR);
  assert.strictEqual(result.valid, true, "El vector oficial debe verificar como válido");
});

// ── SECCIÓN 2: generateInvalidProof ───────────────────────────────────────────
console.log("\n🔀 generateInvalidProof — mutación del proof");

test("generateInvalidProof produce proof diferente al original", () => {
  const nonce   = "aabbccdd11223344";
  const invalid = generateInvalidProof(PROTOCOL_CHALLENGE_VECTOR, nonce);
  const orig_a0 = (PROTOCOL_CHALLENGE_VECTOR.proof).pi_a[0];
  const mut_a0  = (invalid.proof).pi_a[0];
  assert.notStrictEqual(orig_a0, mut_a0, "pi_a[0] debe ser diferente");
  assert.strictEqual((invalid.proof).pi_a[1], (PROTOCOL_CHALLENGE_VECTOR.proof).pi_a[1],
    "pi_a[1] no debe cambiar");
});

test("Nonces diferentes → pi_a[0] diferente (no predecible)", () => {
  const inv1 = generateInvalidProof(PROTOCOL_CHALLENGE_VECTOR, "aabb0011ccdd2233");
  const inv2 = generateInvalidProof(PROTOCOL_CHALLENGE_VECTOR, "1234567890abcdef");
  const a0_1 = (inv1.proof).pi_a[0];
  const a0_2 = (inv2.proof).pi_a[0];
  assert.notStrictEqual(a0_1, a0_2, "Nonces distintos → mutaciones distintas");
});

await testAsync("Invalid proof NO verifica (rechazado por snarkjs)", async () => {
  const nonce   = "deadbeef01234567";
  const invalid = generateInvalidProof(PROTOCOL_CHALLENGE_VECTOR, nonce);
  const result  = await verifyProof(invalid);
  assert.strictEqual(result.valid, false, "Proof mutado debe fallar snarkjs");
});

await testAsync("Múltiples nonces → todos los proofs inválidos fallan", async () => {
  const nonces = ["0000111122223333", "ffffeeeeddddcccc", "a1b2c3d4e5f60718"];
  for (const nonce of nonces) {
    const inv    = generateInvalidProof(PROTOCOL_CHALLENGE_VECTOR, nonce);
    const result = await verifyProof(inv);
    assert.strictEqual(result.valid, false, `Nonce ${nonce}: proof mutado debe fallar`);
  }
});

// ── SECCIÓN 3: buildChallenge ─────────────────────────────────────────────────
console.log("\n🎲 buildChallenge — generación de challenge único");

test("Dos challenges tienen challenge_id diferentes", () => {
  const c1 = buildChallenge();
  const c2 = buildChallenge();
  assert.notStrictEqual(c1.challenge_id, c2.challenge_id);
});

test("Dos challenges tienen nonces diferentes", () => {
  const c1 = buildChallenge();
  const c2 = buildChallenge();
  assert.notStrictEqual(c1.nonce, c2.nonce);
});

test("Dos challenges tienen invalid_proof diferentes (derivado del nonce)", () => {
  const c1 = buildChallenge();
  const c2 = buildChallenge();
  const a1 = (c1.invalid_proof.proof).pi_a[0];
  const a2 = (c2.invalid_proof.proof).pi_a[0];
  assert.notStrictEqual(a1, a2, "Proofs inválidos deben ser únicos");
});

test("Challenge tiene issued_at reciente", () => {
  const c     = buildChallenge();
  const nowSecs = Math.floor(Date.now() / 1000);
  assert.ok(nowSecs - c.issued_at < 5, "issued_at debe ser muy reciente");
});

// ── SECCIÓN 4: verifyChallengeResponse ───────────────────────────────────────
console.log("\n🔎 verifyChallengeResponse — detección de nodos comprometidos");

function makeHonestResponse(challenge, kp, sig) {
  return {
    challenge_id:   challenge.challenge_id,
    result_valid:   true,   // prueba válida → correcto
    result_invalid: false,  // prueba inválida → correcto
    verified_at:    Math.floor(Date.now() / 1000),
    node_did:       kp.did,
    signature:      sig,
  };
}

test("Nodo honesto → passed: true", () => {
  const kp        = generateKeypair();
  const challenge = buildChallenge();
  const payload   = {
    challenge_id:   challenge.challenge_id,
    result_valid:   true,
    result_invalid: false,
    verified_at:    Math.floor(Date.now() / 1000),
  };
  const sig  = sign(payload, kp.privateKey);
  const resp = { ...payload, node_did: kp.did, signature: sig };
  const r    = verifyChallengeResponse(challenge, resp, Date.now() - 50);
  assert.strictEqual(r.passed, true, "Nodo honesto debe pasar");
});

test("ZK siempre true (bypasseado) → detectado por invalid_proof", () => {
  const kp        = generateKeypair();
  const challenge = buildChallenge();
  // Nodo comprometido: devuelve valid=true para TODO (incluso proof inválido)
  const payload   = {
    challenge_id:   challenge.challenge_id,
    result_valid:   true,
    result_invalid: true,  // BUG: devolvió true para proof inválido
    verified_at:    Math.floor(Date.now() / 1000),
  };
  const sig  = sign(payload, kp.privateKey);
  const resp = { ...payload, node_did: kp.did, signature: sig };
  const r    = verifyChallengeResponse(challenge, resp, Date.now() - 50);
  assert.strictEqual(r.passed, false, "ZK bypasseado debe ser detectado");
  assert.ok(r.reason?.includes("inválida reportada como válida"), `reason inesperado: ${r.reason}`);
});

test("ZK siempre false (roto) → detectado por valid_proof", () => {
  const kp        = generateKeypair();
  const challenge = buildChallenge();
  const payload   = {
    challenge_id:   challenge.challenge_id,
    result_valid:   false,  // BUG: no puede verificar proofs válidos
    result_invalid: false,
    verified_at:    Math.floor(Date.now() / 1000),
  };
  const sig  = sign(payload, kp.privateKey);
  const resp = { ...payload, node_did: kp.did, signature: sig };
  const r    = verifyChallengeResponse(challenge, resp, Date.now() - 50);
  assert.strictEqual(r.passed, false, "ZK roto debe ser detectado");
  assert.ok(r.reason?.includes("válida reportada como inválida"), `reason inesperado: ${r.reason}`);
});

test("challenge_id diferente → detectado", () => {
  const kp        = generateKeypair();
  const challenge = buildChallenge();
  const payload   = {
    challenge_id:   "diferente-id-00000",
    result_valid:   true,
    result_invalid: false,
    verified_at:    Math.floor(Date.now() / 1000),
  };
  const sig  = sign(payload, kp.privateKey);
  const resp = { ...payload, node_did: kp.did, signature: sig };
  const r    = verifyChallengeResponse(challenge, resp, Date.now() - 50);
  assert.strictEqual(r.passed, false, "challenge_id diferente debe ser detectado");
});

test("Firma inválida (impersonación) → detectado", () => {
  const kp1       = generateKeypair();
  const kp2       = generateKeypair(); // attacker's keypair
  const challenge = buildChallenge();
  const payload   = {
    challenge_id:   challenge.challenge_id,
    result_valid:   true,
    result_invalid: false,
    verified_at:    Math.floor(Date.now() / 1000),
  };
  const sig  = sign(payload, kp2.privateKey); // firmado con kp2 pero DID de kp1
  const resp = { ...payload, node_did: kp1.did, signature: sig };
  const r    = verifyChallengeResponse(challenge, resp, Date.now() - 50);
  assert.strictEqual(r.passed, false, "Impersonación debe ser detectada");
  assert.ok(r.reason?.includes("Firma"), `reason inesperado: ${r.reason}`);
});

test("Respuesta lenta (timeout) → detectado", () => {
  const kp        = generateKeypair();
  const challenge = buildChallenge();
  const payload   = {
    challenge_id:   challenge.challenge_id,
    result_valid:   true,
    result_invalid: false,
    verified_at:    Math.floor(Date.now() / 1000),
  };
  const sig      = sign(payload, kp.privateKey);
  const resp     = { ...payload, node_did: kp.did, signature: sig };
  // Simular que la respuesta llegó hace 11s (> 10s timeout)
  const startedAt = Date.now() - 11_000;
  const r = verifyChallengeResponse(challenge, resp, startedAt);
  assert.strictEqual(r.passed, false, "Respuesta lenta debe fallar");
  assert.ok(r.reason?.toLowerCase().includes("timeout"), `reason inesperado: ${r.reason}`);
});

// ── SECCIÓN 5: Integración — POST /challenge endpoint ──────────────────────────
console.log("\n🏛️  POST /challenge — integración con validador HTTP");

const { startValidatorNode } = await import("../packages/network/dist/validator.js");

await testAsync("POST /challenge — nodo honesto responde correctamente", async () => {
  const port   = 15001;
  const server = startValidatorNode(port);
  await new Promise(r => setTimeout(r, 200));

  try {
    const challenge = buildChallenge();
    const resp = await fetch(`http://localhost:${port}/challenge`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(challenge),
    });
    assert.strictEqual(resp.status, 200, `HTTP ${resp.status}`);
    const body = await resp.json();
    assert.strictEqual(body.result_valid,   true,  "válida debe dar true");
    assert.strictEqual(body.result_invalid, false, "inválida debe dar false");
    assert.ok(body.node_did?.startsWith("did:key:"), "debe tener node_did");
    assert.ok(body.signature, "debe tener signature");

    // Verificar con verifyChallengeResponse
    const r = verifyChallengeResponse(challenge, body, Date.now() - 100);
    assert.strictEqual(r.passed, true, `Challenge failed: ${r.reason}`);
  } finally {
    server?.close();
  }
});

await testAsync("POST /challenge — sin body → 400", async () => {
  const port   = 15002;
  const server = startValidatorNode(port);
  await new Promise(r => setTimeout(r, 200));

  try {
    const resp = await fetch(`http://localhost:${port}/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(resp.status, 400);
  } finally {
    server?.close();
  }
});

await testAsync("POST /challenge — challenge expirado → 400", async () => {
  const port   = 15003;
  const server = startValidatorNode(port);
  await new Promise(r => setTimeout(r, 200));

  try {
    const challenge = buildChallenge();
    challenge.issued_at = Math.floor(Date.now() / 1000) - 60; // 60s en el pasado
    const resp = await fetch(`http://localhost:${port}/challenge`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(challenge),
    });
    assert.strictEqual(resp.status, 400, "Challenge viejo debe ser rechazado");
    const body = await resp.json();
    assert.ok(body.error?.includes("expirado"), `error inesperado: ${body.error}`);
  } finally {
    server?.close();
  }
});

await testAsync("verifyPeerBehavior — nodo real en localhost pasa", async () => {
  const port   = 15004;
  const server = startValidatorNode(port);
  await new Promise(r => setTimeout(r, 300));

  try {
    const result = await verifyPeerBehavior(`http://localhost:${port}`);
    assert.strictEqual(result.passed, true, `Peer real debe pasar: ${result.reason}`);
    assert.ok(result.latencyMs < 5000, "Latencia debe ser < 5s");
  } finally {
    server?.close();
  }
});

await testAsync("verifyPeerBehavior — peer inexistente → passed: false", async () => {
  const result = await verifyPeerBehavior("http://localhost:29999");
  assert.strictEqual(result.passed, false, "Peer offline debe fallar");
  assert.ok(result.reason?.includes("Error de red") || result.reason?.includes("connect"),
    `reason: ${result.reason}`);
});

// ── RESUMEN ────────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n${"═".repeat(55)}`);
console.log(`Total:    ${total} tests`);
console.log(`Pasados:  ${passed} ✅`);
if (failed > 0) {
  console.log(`  Fallidos: ${failed} ❌`);
} else {
  console.log(`  Fallidos: 0 ✅`);
}
process.exit(failed > 0 ? 1 : 0);
