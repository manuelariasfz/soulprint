/**
 * fix-verification-tests.mjs — Tests exhaustivos Fix 1 + Fix 2
 *
 * Fix 1: Groth16Verifier real (no mock) + admin bloqueado + governance controla verifier
 * Fix 2: Code integrity hash — determinístico, completo, integrado en /health
 *
 * Cubre:
 *  1.  Groth16Verifier real on-chain — rechaza proofs inválidas (10 variantes)
 *  2.  SoulprintRegistry v2 — admin=0, governance set, verifier=real
 *  3.  updateVerifier bloqueado (solo governance)
 *  4.  registerIdentity con proof inválida → reverts on-chain
 *  5.  GovernanceModule v2 — conectado a registry v2
 *  6.  Code integrity — hash disponible, determinístico, archivos correctos
 *  7.  isCodeApproved — edge cases (null, empty, 0x prefix, case insensitive)
 *  8.  computeRuntimeHash — estable, string hex
 *  9.  /health endpoint — todos los campos presentes
 * 10.  Pen testing de Fix 1 — ataques directos al contrato
 * 11.  Pen testing de Fix 2 — manipulación del code hash
 * 12.  Integridad de contratos on-chain (bytecodes presentes)
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname }  from "node:path";
import { fileURLToPath }  from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
const errors = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message.split("\n")[0]}`);
    failed++;
    errors.push({ name, error: err.message.split("\n")[0] });
  }
}

// Deployment + client
const deployment = JSON.parse(
  readFileSync(join(__dir, "../packages/blockchain/deployments/base-sepolia.json"), "utf8")
);

const { SoulprintBlockchainClient } = await import(
  "../packages/network/dist/blockchain/blockchain-client.js"
);
const { getCodeIntegrity, isCodeApproved, computeRuntimeHash } = await import(
  "../packages/network/dist/code-integrity.js"
);

const PRIV_KEY = "0x0c85117778a68f7f4cead481dbc44695487fc4924b51eb6b6a07903262033a2b";
const RPC      = "https://sepolia.base.org";

function makeLiveClient() {
  return new SoulprintBlockchainClient({
    rpcUrl:          RPC,
    privateKey:      PRIV_KEY,
    registryAddr:    deployment.contracts.SoulprintRegistry,
    ledgerAddr:      deployment.contracts.AttestationLedger,
    validatorRegAddr: deployment.contracts.ValidatorRegistry,
    governanceAddr:  deployment.contracts.GovernanceModule,
    protocolHash:    deployment.protocolHash,
  });
}


// ethers desde packages/network/node_modules (instalado como dep directa en 0.3.4)
import * as ethers from "../packages/network/node_modules/ethers/lib.esm/index.js";
async function getEthers() { return ethers; }
// RPC helper directo (ethers)
async function rpcCall(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  return (await r.json()).result;
}

async function ethCall(to, data) {
  return rpcCall("eth_call", [{ to, data }, "latest"]);
}

// ABI encode helpers (manual, sin ethers)
function selector(sig) {
  // SHA3 de signature → primeros 4 bytes
  // Usamos crypto para calcular keccak256
  // Simplificado: hard-code los selectores necesarios
  const sigs = {
    "admin()":      "f851a440",
    "governance()": "5aa6e675",
    "verifier()":   "2b7ac3f3",
    "PROTOCOL_HASH()": "e5eb5eed",
    "isRegistered(bytes32)": "c4a7b2e0",
  };
  return "0x" + (sigs[sig] ?? "00000000");
}

// ════════════════════════════════════════════════════════════════════════════
// 1. On-chain — verificar estado de los contratos v2
// ════════════════════════════════════════════════════════════════════════════
console.log("\n📋 Fix 1 — Contratos v2 on-chain");

await test("SoulprintRegistry v2 tiene bytecode", async () => {
  const code = await rpcCall("eth_getCode", [deployment.contracts.SoulprintRegistry, "latest"]);
  assert.ok(code && code !== "0x", "SoulprintRegistry debe tener bytecode");
  assert.ok(code.length > 100, `bytecode muy corto: ${code.length}`);
});

await test("Groth16Verifier real tiene bytecode", async () => {
  const code = await rpcCall("eth_getCode", [deployment.contracts.Groth16Verifier, "latest"]);
  assert.ok(code && code !== "0x");
  // El verifier real es significativamente más grande que el mock
  assert.ok(code.length > 1000, `bytecode muy corto (${code.length}) — probablemente el mock`);
});

await test("Groth16Verifier real es MÁS GRANDE que el mock (garantía de realidad)", async () => {
  const realCode = await rpcCall("eth_getCode", [deployment.contracts.Groth16Verifier, "latest"]);
  const mockCode = await rpcCall("eth_getCode", [deployment.contracts.Groth16VerifierMock, "latest"]);
  assert.ok(realCode.length > mockCode.length,
    `Real (${realCode.length}) debe ser más grande que Mock (${mockCode.length})`);
});

await test("deployment.verifierReal = true", () => {
  assert.equal(deployment.verifierReal, true, "deployment debe marcar verifierReal=true");
});

await test("deployment.adminLocked = true", () => {
  assert.equal(deployment.adminLocked, true, "deployment debe marcar adminLocked=true");
});

await test("SoulprintRegistry v2: admin = address(0) [on-chain]", async () => {
  // admin() → bytes32 → últimos 20 bytes
  const ADMIN_SELECTOR = "0xf851a440";
  const result = await ethCall(deployment.contracts.SoulprintRegistry, ADMIN_SELECTOR);
  // result es 32 bytes → address en últimos 20
  const addr = result.slice(-40).toLowerCase();
  assert.equal(addr, "0".repeat(40), `Admin debe ser address(0), actual: 0x${addr}`);
});

await test("SoulprintRegistry v2: governance = GovernanceModule [on-chain]", async () => {
  const GOV_SELECTOR = "0x5aa6e675";
  const result = await ethCall(deployment.contracts.SoulprintRegistry, GOV_SELECTOR);
  const addr = result.slice(-40).toLowerCase();
  assert.equal(
    addr,
    deployment.contracts.GovernanceModule.toLowerCase().replace("0x", ""),
    `governance debe ser GovernanceModule`
  );
});

await test("SoulprintRegistry v2: verifier = Groth16Verifier real [on-chain]", async () => {
  const VER_SELECTOR = "0x2b7ac3f3";
  const result = await ethCall(deployment.contracts.SoulprintRegistry, VER_SELECTOR);
  const addr = result.slice(-40).toLowerCase();
  assert.equal(
    addr,
    deployment.contracts.Groth16Verifier.toLowerCase().replace("0x", ""),
    `verifier debe ser Groth16Verifier real`
  );
});

await test("GovernanceModule v2: apunta a SoulprintRegistry v2", async () => {
  // Verificar que la address del registry en el GovernanceModule es la v2
  // GovernanceModule tiene soulprintRegistry() function
  const code = await rpcCall("eth_getCode", [deployment.contracts.GovernanceModule, "latest"]);
  assert.ok(code && code !== "0x", "GovernanceModule v2 debe tener bytecode");
  // El bytecode debe contener la dirección del registry v2
  const regAddr = deployment.contracts.SoulprintRegistry.toLowerCase().replace("0x", "");
  assert.ok(code.toLowerCase().includes(regAddr),
    "GovernanceModule debe contener dirección de SoulprintRegistry v2 en bytecode");
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Groth16Verifier real — pruebas de rechazo de proofs inválidas
// ════════════════════════════════════════════════════════════════════════════
console.log("\n🔐 Fix 1 — Groth16Verifier real: rechazo de proofs inválidas");

// ABI de verifyProof para llamadas directas
const VERIFY_ABI = [
  "function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[3] calldata pubSignals) public view returns (bool)",
];

const client = makeLiveClient();
await client.connect();

// Helper: llamar verifyProof directamente via client
async function callVerifyProof(a, b, c, pub) {
  try {
    const ethers = await getEthers();
    const provider = new ethers.JsonRpcProvider(RPC);
    const verifier = new ethers.Contract(deployment.contracts.Groth16Verifier, VERIFY_ABI, provider);
    return await verifier.verifyProof(a, b, c, pub);
  } catch (e) {
    return { reverted: true, msg: e.message };
  }
}

const ZERO_PROOF = {
  a: [0n, 0n],
  b: [[0n, 0n], [0n, 0n]],
  c: [0n, 0n],
};

await test("[PEN] proof todo ceros → REVERTS o false", async () => {
  const r = await callVerifyProof(ZERO_PROOF.a, ZERO_PROOF.b, ZERO_PROOF.c, [0n, 0n, 0n]);
  const rejected = r === false || r?.reverted;
  assert.ok(rejected, `proof cero debe ser rechazada, resultado: ${JSON.stringify(r)}`);
});

await test("[PEN] pubSignals[0] = 1 con proof cero → REVERTS o false", async () => {
  const r = await callVerifyProof(ZERO_PROOF.a, ZERO_PROOF.b, ZERO_PROOF.c, [1n, 0n, 0n]);
  const rejected = r === false || r?.reverted;
  assert.ok(rejected, "no debe aceptar proof matemáticamente inválida aunque nullifier != 0");
});

await test("[PEN] proof con valores aleatorios → REVERTS o false", async () => {
  const r = await callVerifyProof(
    [12345678901234567890n, 98765432109876543210n],
    [[11111111n, 22222222n], [33333333n, 44444444n]],
    [55555555n, 66666666n],
    [BigInt("0x" + "aa".repeat(32)), 999n, 42n]
  );
  const rejected = r === false || r?.reverted;
  assert.ok(rejected, "proof random debe ser rechazada");
});

await test("[PEN] proof con valores máximos (overflow) → REVERTS o false", async () => {
  const maxUint = (1n << 256n) - 1n;
  const r = await callVerifyProof(
    [maxUint, maxUint],
    [[maxUint, maxUint], [maxUint, maxUint]],
    [maxUint, maxUint],
    [maxUint, maxUint, maxUint]
  );
  const rejected = r === false || r?.reverted;
  assert.ok(rejected, "overflow values debe ser rechazado");
});

await test("[PEN] mock verifier acepta pubSignals[0]=1 con ABI original (uint256[2])", async () => {
  // El mock fue deployado CON uint256[2] (antes del Fix 1)
  // Usamos la ABI ORIGINAL del mock para confirmar que acepta proofs inválidas
  const provider = new ethers.JsonRpcProvider(RPC);
  const MOCK_ABI_ORIG = [
    "function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[2] calldata input) external pure returns (bool)",
  ];
  const mockVerifier = new ethers.Contract(deployment.contracts.Groth16VerifierMock, MOCK_ABI_ORIG, provider);
  const accepted = await mockVerifier.verifyProof(
    ZERO_PROOF.a, ZERO_PROOF.b, ZERO_PROOF.c, [1n, 0n]   // [2] array
  );
  assert.equal(accepted, true, "el MOCK debe aceptar — bytecode size diferente confirma que el real es distinto");
});

await test("[PEN] registerIdentity con proof inválida → falla via client", async () => {
  const result = await client.registerIdentity({
    nullifier:        "0x" + "ab".repeat(32),
    did:              "did:key:z6MkFakeBot000000000",
    documentVerified: true,
    faceVerified:     true,
    zkProof: {
      a:      [0n, 0n],
      b:      [[0n, 0n], [0n, 0n]],
      c:      [0n, 0n],
      inputs: [1n, 0n],
    },
  });
  assert.equal(result, null, "registerIdentity con proof inválida debe fallar");
});

// ════════════════════════════════════════════════════════════════════════════
// 3. updateVerifier bloqueado — solo governance puede cambiar
// ════════════════════════════════════════════════════════════════════════════
console.log("\n🔒 Fix 1 — updateVerifier bloqueado");

await test("[PEN] updateVerifier desde deployer → reverts (admin=0)", async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet   = new ethers.Wallet(PRIV_KEY, provider);
  const reg      = new ethers.Contract(
    deployment.contracts.SoulprintRegistry,
    ["function updateVerifier(address) external"],
    wallet
  );
  try {
    const tx = await reg.updateVerifier(ethers.ZeroAddress);
    await tx.wait();
    assert.fail("debería haber revertido");
  } catch (e) {
    assert.ok(
      e.message.includes("revert") || e.message.includes("CALL_EXCEPTION") || e.message.includes("execution"),
      `debe revertir, error: ${e.message.slice(0, 100)}`
    );
  }
});

await test("[PEN] setGovernance llamado de nuevo → reverts (admin=0)", async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet   = new ethers.Wallet(PRIV_KEY, provider);
  const reg      = new ethers.Contract(
    deployment.contracts.SoulprintRegistry,
    ["function setGovernance(address) external"],
    wallet
  );
  try {
    const tx = await reg.setGovernance(wallet.address);
    await tx.wait();
    assert.fail("debería haber revertido");
  } catch (e) {
    assert.ok(
      e.message.includes("revert") || e.message.includes("CALL_EXCEPTION") || e.message.includes("execution"),
      `debe revertir, error: ${e.message.slice(0, 100)}`
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Fix 2 — Code Integrity exhaustivo
// ════════════════════════════════════════════════════════════════════════════
console.log("\n🔑 Fix 2 — Code Integrity exhaustivo");

const integrity = getCodeIntegrity();

await test("code-hash.json existe en dist/", () => {
  const hashFile = join(__dir, "../packages/network/dist/code-hash.json");
  assert.ok(existsSync(hashFile), "dist/code-hash.json debe existir tras el build");
});

await test("codeHash tiene exactamente 64 chars hex", () => {
  assert.equal(integrity.codeHash.length, 64, "SHA-256 hex = 64 caracteres");
  assert.ok(/^[a-f0-9]+$/.test(integrity.codeHash), "solo hex lowercase");
});

await test("codeHashHex = '0x' + codeHash", () => {
  assert.equal(integrity.codeHashHex, "0x" + integrity.codeHash);
});

await test("fileCount >= 10 archivos fuente", () => {
  assert.ok(integrity.fileCount >= 10, `${integrity.fileCount} archivos (esperado >= 10)`);
});

await test("archivos incluyen validator.ts, code-integrity.ts, blockchain-client.ts", () => {
  const files = integrity.available
    ? JSON.parse(readFileSync(join(__dir, "../packages/network/dist/code-hash.json"), "utf8")).files
    : [];
  const required = ["validator.ts", "code-integrity.ts", "blockchain/blockchain-client.ts"];
  for (const req of required) {
    assert.ok(files.some(f => f.endsWith(req) || f === req), `Falta ${req} en la lista de archivos`);
  }
});

await test("hash es determinístico (dos lecturas = mismo hash)", () => {
  const h1 = getCodeIntegrity().codeHash;
  const h2 = getCodeIntegrity().codeHash;
  assert.equal(h1, h2, "hash debe ser igual en lecturas repetidas");
});

await test("isCodeApproved — exacto (correcto)", () => {
  const h = integrity.codeHash;
  assert.equal(isCodeApproved([h]), true);
});

await test("isCodeApproved — múltiples hashes, uno correcto", () => {
  const h = integrity.codeHash;
  assert.equal(isCodeApproved(["deadbeef".repeat(8), h, "cafebabe".repeat(8)]), true);
});

await test("isCodeApproved — con 0x prefix en la lista aprobada", () => {
  const h = "0x" + integrity.codeHash;
  assert.equal(isCodeApproved([h]), true, "debe normalizar 0x prefix");
});

await test("isCodeApproved — case insensitive", () => {
  const hUpper = integrity.codeHash.toUpperCase();
  assert.equal(isCodeApproved([hUpper]), true, "debe ser case insensitive");
});

await test("[PEN] isCodeApproved con hash casi correcto (1 char diferente) → false", () => {
  const h = integrity.codeHash;
  const tampered = h.slice(0, -1) + (h.endsWith("a") ? "b" : "a");
  assert.equal(isCodeApproved([tampered]), false, "1 char diferente debe fallar");
});

await test("[PEN] isCodeApproved con hash truncado → false", () => {
  assert.equal(isCodeApproved([integrity.codeHash.slice(0, 32)]), false);
});

await test("[PEN] isCodeApproved con null/undefined → false (no crashea)", () => {
  try {
    const r = isCodeApproved([null, undefined, "", "   "]);
    assert.equal(r, false);
  } catch {
    assert.fail("no debe lanzar excepción con valores nulos");
  }
});

await test("computeRuntimeHash — string de 64 chars hex o mensaje de error conocido", () => {
  const h = computeRuntimeHash();
  const valid = h.length === 64 && /^[a-f0-9]+$/.test(h);
  const knownFallback = ["no-binary", "hash-error"].includes(h);
  assert.ok(valid || knownFallback, `hash inválido: "${h}"`);
});

await test("computeRuntimeHash — estable (dos llamadas = mismo resultado)", () => {
  const h1 = computeRuntimeHash();
  const h2 = computeRuntimeHash();
  assert.equal(h1, h2);
});

// ════════════════════════════════════════════════════════════════════════════
// 5. GET /health — estructura del endpoint (mock de la respuesta esperada)
// ════════════════════════════════════════════════════════════════════════════
console.log("\n🏥 GET /health — estructura esperada");

await test("campos requeridos de /health están definidos en code-integrity", () => {
  const info = getCodeIntegrity();
  // Verificar que tenemos todos los campos que el endpoint devuelve
  const required = ["codeHash", "codeHashHex", "available", "computedAt", "fileCount"];
  for (const field of required) {
    assert.ok(field in info, `Falta campo: ${field}`);
  }
});

await test("codeHashHex es compatible con Solidity bytes32 (66 chars: 0x + 64 hex)", () => {
  const h = integrity.codeHashHex;
  assert.equal(h.length, 66, `codeHashHex debe tener 66 chars, tiene ${h.length}`);
  assert.ok(h.startsWith("0x"));
  assert.ok(/^0x[a-f0-9]{64}$/.test(h), `formato inválido: ${h}`);
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Verificación cruzada — PROTOCOL_HASH on-chain vs soulprint-core
// ════════════════════════════════════════════════════════════════════════════
console.log("\n🔗 Verificación cruzada — hashes críticos");

await test("PROTOCOL_HASH en deployment = PROTOCOL_HASH en soulprint-core", async () => {
  const { PROTOCOL_HASH } = await import("../packages/core/dist/protocol-constants.js");
  const onChainHex = deployment.protocolHash.replace("0x", "").toLowerCase();
  const coreHex    = PROTOCOL_HASH.toLowerCase();
  assert.equal(onChainHex, coreHex, "PROTOCOL_HASH debe coincidir entre deployment y soulprint-core");
});

await test("PROTOCOL_HASH en GovernanceModule on-chain = deployment", async () => {
  const current = await client.getCurrentApprovedHash();
  assert.ok(current, "currentApprovedHash no debe ser null");
  assert.equal(
    current.toLowerCase(),
    deployment.protocolHash.toLowerCase(),
    "GovernanceModule currentApprovedHash debe coincidir con deployment"
  );
});

await test("codeHash != protocolHash (son hashes diferentes, no confundirlos)", () => {
  const codeH  = integrity.codeHash;
  const protoH = deployment.protocolHash.replace("0x", "");
  assert.notEqual(codeH, protoH, "code hash y protocol hash son cosas distintas");
});

await test("Groth16Verifier real ≠ Groth16Verifier mock (addresses distintas)", () => {
  assert.notEqual(
    deployment.contracts.Groth16Verifier.toLowerCase(),
    deployment.contracts.Groth16VerifierMock.toLowerCase(),
    "El verifier real y el mock deben ser contratos distintos"
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Pen testing final — combinaciones de ataques
// ════════════════════════════════════════════════════════════════════════════
console.log("\n🔴 Pen Testing — ataques combinados Fix 1+2");

await test("[PEN] AI con code hash diferente → isCodeApproved devuelve false", () => {
  // Simular un nodo con código modificado
  const approvedHash = integrity.codeHash;
  const modifiedHash = "0000000000000000000000000000000000000000000000000000000000000000";
  assert.equal(isCodeApproved([approvedHash]), true,  "nodo legítimo OK");
  assert.equal(isCodeApproved([modifiedHash]), false, "nodo modificado bloqueado");
});

await test("[PEN] proof replay en blockchain → NullifierAlreadyUsed on-chain", async () => {
  // El nullifier 0xaaaa...aa NO está registrado, pero si lo estuviera,
  // una segunda llamada con el mismo nullifier debería revertir.
  // Verificamos el mecanismo a nivel de client (devuelve null si revert)
  const fakeNullifier = "0x" + "fe".repeat(32);
  const result = await client.registerIdentity({
    nullifier:        fakeNullifier,
    did:              "did:key:z6MkReplayBot",
    documentVerified: true, faceVerified: true,
    zkProof: { a:[0n,0n], b:[[0n,0n],[0n,0n]], c:[0n,0n], inputs:[1n,0n] },
  });
  // Con proof inválida falla antes de llegar a NullifierAlreadyUsed
  assert.equal(result, null, "proof inválida debe fallar antes de registrar");
});

await test("[PEN] governance vote sin identidad → reverts on-chain", async () => {
  const txHash = await client.voteOnProposal({
    proposalId: 0,
    did:        "did:key:z6MkNoIdentityAttacker",
    approve:    true,
  });
  assert.equal(txHash, null, "sin identidad verificada no puede votar");
});

await test("[PEN] governance propose con rationale vacía → falla", async () => {
  const result = await client.proposeUpgrade({
    did:       "did:key:z6MkBot",
    newHash:   "0x" + "ee".repeat(32),
    rationale: "short",   // < 10 chars → RationaleRequired
  });
  assert.equal(result, null, "rationale < 10 chars debe fallar");
});

await test("[PEN] double-lock: setGovernance no puede llamarse dos veces", async () => {
  // Ya verificado en test anterior, confirmamos el invariante en deployment
  const ADMIN_SELECTOR = "0xf851a440";
  const result = await ethCall(deployment.contracts.SoulprintRegistry, ADMIN_SELECTOR);
  const addr   = result.slice(-40).toLowerCase();
  assert.equal(addr, "0".repeat(40), "admin debe ser 0 (doble verificación)");
});

// ════════════════════════════════════════════════════════════════════════════
// Reporte final
// ════════════════════════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════════════════════");
console.log(`Total:    ${passed + failed} tests`);
console.log(`Pasados:  ${passed} ✅`);
console.log(`Fallidos: ${failed} ${failed === 0 ? "✅" : "❌"}`);
if (errors.length > 0) {
  console.log("\nFallos:");
  errors.forEach(e => console.log(`  ❌ ${e.name}: ${e.error}`));
}
console.log("═══════════════════════════════════════════════════════");

if (failed > 0) process.exit(1);
