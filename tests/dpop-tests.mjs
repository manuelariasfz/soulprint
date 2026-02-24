/**
 * dpop-tests.mjs — Tests para DPoP (Demonstrating Proof of Possession) — v0.3.8
 *
 * Verifica:
 *  1. signDPoP / serializeDPoP / deserializeDPoP — generación y serialización
 *  2. verifyDPoP — verificación completa
 *  3. Ataques bloqueados: replay, token robado, firma falsa, MITM de URL
 *  4. NonceStore — anti-replay
 *  5. Integración con Express middleware (requireDPoP: true)
 */

import assert from "node:assert";
import { createServer } from "node:http";

const {
  signDPoP, serializeDPoP, deserializeDPoP, verifyDPoP,
  NonceStore, DPOP_MAX_AGE_SECS,
} = await import("../packages/core/dist/dpop.js");

const {
  generateKeypair, createToken,
} = await import("../packages/core/dist/index.js");

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch(e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
}

async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch(e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
}

// ── Setup ─────────────────────────────────────────────────────────────────────
const kp  = generateKeypair();
const kp2 = generateKeypair(); // atacante
const spt = createToken(kp, "0x" + "ab".repeat(32), ["DocumentVerified"]);
const url = "https://api.example.com/tool";

// ── SECCIÓN 1: Generación de DPoP ─────────────────────────────────────────────
console.log("\n🔑 signDPoP / serialize / deserialize");

test("signDPoP produce proof con todos los campos", () => {
  const proof = signDPoP(kp.privateKey, kp.did, "POST", url, spt);
  assert.strictEqual(proof.payload.typ, "soulprint-dpop");
  assert.strictEqual(proof.payload.method, "POST");
  assert.strictEqual(proof.payload.url, url);
  assert.ok(proof.payload.nonce?.length >= 32, "nonce debe ser hex de 16 bytes");
  assert.ok(proof.payload.spt_hash?.length === 64, "spt_hash debe ser sha256 hex");
  assert.ok(proof.signature?.length > 0, "debe tener signature");
  assert.strictEqual(proof.did, kp.did);
});

test("Dos calls a signDPoP producen nonces diferentes", () => {
  const p1 = signDPoP(kp.privateKey, kp.did, "POST", url, spt);
  const p2 = signDPoP(kp.privateKey, kp.did, "POST", url, spt);
  assert.notStrictEqual(p1.payload.nonce, p2.payload.nonce, "nonce único por request");
});

test("serializeDPoP / deserializeDPoP son inversos", () => {
  const proof  = signDPoP(kp.privateKey, kp.did, "POST", url, spt);
  const serial = serializeDPoP(proof);
  assert.ok(typeof serial === "string", "serializado debe ser string");
  const back   = deserializeDPoP(serial);
  assert.strictEqual(back.payload.nonce, proof.payload.nonce, "nonce preservado");
  assert.strictEqual(back.signature, proof.signature, "signature preservado");
  assert.strictEqual(back.did, proof.did, "did preservado");
});

test("method se normaliza a mayúsculas", () => {
  const proof = signDPoP(kp.privateKey, kp.did, "post", url, spt);
  assert.strictEqual(proof.payload.method, "POST");
});

// ── SECCIÓN 2: verifyDPoP — caso feliz ────────────────────────────────────────
console.log("\n✅ verifyDPoP — caso correcto");

test("Proof válido → passed: true", () => {
  const store = new NonceStore();
  const proof  = signDPoP(kp.privateKey, kp.did, "POST", url, spt);
  const header = serializeDPoP(proof);
  const result = verifyDPoP(header, spt, "POST", url, store, kp.did);
  assert.strictEqual(result.valid, true, `Esperaba true: ${result.reason}`);
});

test("Proof válido consume el nonce (nonce queda en store)", () => {
  const store = new NonceStore();
  const proof  = signDPoP(kp.privateKey, kp.did, "POST", url, spt);
  const header = serializeDPoP(proof);
  verifyDPoP(header, spt, "POST", url, store, kp.did);
  assert.strictEqual(store.size(), 1, "Store debe tener 1 nonce");
});

// ── SECCIÓN 3: Ataques bloqueados ─────────────────────────────────────────────
console.log("\n🔐 Ataques bloqueados");

test("ATAQUE: Replay — mismo proof usado dos veces → bloqueado", () => {
  const store  = new NonceStore();
  const proof  = signDPoP(kp.privateKey, kp.did, "POST", url, spt);
  const header = serializeDPoP(proof);
  verifyDPoP(header, spt, "POST", url, store, kp.did); // primera vez OK
  const r2 = verifyDPoP(header, spt, "POST", url, store, kp.did); // replay
  assert.strictEqual(r2.valid, false, "Replay debe ser bloqueado");
  assert.ok(r2.reason?.includes("Nonce ya visto") || r2.reason?.includes("replay"),
    `reason: ${r2.reason}`);
});

test("ATAQUE: Token robado (SPT distinto) → spt_hash no coincide → bloqueado", () => {
  const store  = new NonceStore();
  const spt2   = createToken(kp2, "0x" + "cc".repeat(32), ["DocumentVerified"]);
  // Atacante genera proof para spt2 pero intenta usarlo con spt original
  const proof  = signDPoP(kp2.privateKey, kp2.did, "POST", url, spt2);
  const header = serializeDPoP(proof);
  const r = verifyDPoP(header, spt, "POST", url, store, kp.did); // spt ≠ spt2
  assert.strictEqual(r.valid, false, "Token robado debe ser bloqueado");
  // Could fail on DID mismatch first, which is also correct
  assert.ok(r.reason?.includes("DID") || r.reason?.includes("spt_hash"),
    `reason: ${r.reason}`);
});

test("ATAQUE: Firma falsa (sin llave privada real) → bloqueado", () => {
  const store  = new NonceStore();
  const proof  = signDPoP(kp2.privateKey, kp.did, "POST", url, spt); // firma con kp2 pero claim kp.did
  const header = serializeDPoP(proof);
  const r = verifyDPoP(header, spt, "POST", url, store, kp.did);
  assert.strictEqual(r.valid, false, "Firma falsa debe ser bloqueada");
  assert.ok(r.reason?.includes("Firma") || r.reason?.includes("inválida"),
    `reason: ${r.reason}`);
});

test("ATAQUE: DID mismatch (proof de otro usuario para mi SPT) → bloqueado", () => {
  const store  = new NonceStore();
  const proof  = signDPoP(kp2.privateKey, kp2.did, "POST", url, spt);
  const header = serializeDPoP(proof);
  const r = verifyDPoP(header, spt, "POST", url, store, kp.did); // sptDid = kp.did
  assert.strictEqual(r.valid, false, "DID mismatch debe ser bloqueado");
  assert.ok(r.reason?.includes("DID"), `reason: ${r.reason}`);
});

test("ATAQUE: URL MITM (proof generado para otra URL) → bloqueado", () => {
  const store  = new NonceStore();
  const proof  = signDPoP(kp.privateKey, kp.did, "POST", "https://attacker.com/evil", spt);
  const header = serializeDPoP(proof);
  const r = verifyDPoP(header, spt, "POST", url, store, kp.did);
  assert.strictEqual(r.valid, false, "URL MITM debe ser bloqueado");
  assert.ok(r.reason?.includes("URL") || r.reason?.includes("path"),
    `reason: ${r.reason}`);
});

test("ATAQUE: Method MITM (proof generado para GET, usado en POST) → bloqueado", () => {
  const store  = new NonceStore();
  const proof  = signDPoP(kp.privateKey, kp.did, "GET", url, spt);
  const header = serializeDPoP(proof);
  const r = verifyDPoP(header, spt, "POST", url, store, kp.did);
  assert.strictEqual(r.valid, false, "Method mismatch debe ser bloqueado");
  assert.ok(r.reason?.includes("Method") || r.reason?.includes("method"),
    `reason: ${r.reason}`);
});

test("ATAQUE: Proof expirado (> 5 min) → bloqueado", () => {
  const store = new NonceStore();
  const proof = signDPoP(kp.privateKey, kp.did, "POST", url, spt);
  // Mutar el iat para que parezca viejo
  proof.payload.iat = Math.floor(Date.now() / 1000) - (DPOP_MAX_AGE_SECS + 10);
  const header = serializeDPoP(proof);
  const r = verifyDPoP(header, spt, "POST", url, store, kp.did);
  assert.strictEqual(r.valid, false, "Proof expirado debe ser bloqueado");
  assert.ok(r.reason?.includes("expirado"), `reason: ${r.reason}`);
});

test("ATAQUE: Proof malformado → bloqueado", () => {
  const store  = new NonceStore();
  const r = verifyDPoP("not-valid-base64url!!", spt, "POST", url, store, kp.did);
  assert.strictEqual(r.valid, false, "Proof malformado debe ser bloqueado");
});

// ── SECCIÓN 4: NonceStore ─────────────────────────────────────────────────────
console.log("\n⏱️  NonceStore — anti-replay");

test("NonceStore.has() devuelve false para nonce nuevo", () => {
  const store = new NonceStore();
  assert.strictEqual(store.has("abc123"), false);
});

test("NonceStore.has() devuelve true después de .add()", () => {
  const store = new NonceStore();
  store.add("abc123");
  assert.strictEqual(store.has("abc123"), true);
});

test("NonceStore.size() refleja cantidad de nonces activos", () => {
  const store = new NonceStore();
  assert.strictEqual(store.size(), 0);
  store.add("n1");
  store.add("n2");
  assert.strictEqual(store.size(), 2);
});

// ── SECCIÓN 5: Integración — Express middleware con requireDPoP ────────────────
console.log("\n🏛️  Express middleware — requireDPoP");

await testAsync("Sin DPoP y requireDPoP: true → 401 dpop_required", async () => {
  // Mock server with express-like handler
  const { soulprint: middleware } = await import("../packages/express/dist/index.js");
  const mw = middleware({ minScore: 0, requireDPoP: true });

  let statusSent = 0, bodySent = null;
  const req = {
    headers:     { "x-soulprint": spt },
    method:      "POST",
    protocol:    "http",
    originalUrl: "/tool",
    query:       {},
  };
  const res = {
    status: (s) => { statusSent = s; return res; },
    json:   (b) => { bodySent = b; },
    setHeader: () => {},
  };

  await mw(req, res, () => { throw new Error("next() should not be called"); });
  assert.strictEqual(statusSent, 401, `Esperaba 401, recibí ${statusSent}`);
  assert.strictEqual(bodySent?.error, "dpop_required", `error: ${bodySent?.error}`);
});

await testAsync("Con DPoP válido y requireDPoP: true → next() llamado", async () => {
  const { soulprint: middleware } = await import("../packages/express/dist/index.js");
  const mw = middleware({ minScore: 0, requireDPoP: true });

  const proof  = signDPoP(kp.privateKey, kp.did, "POST",
    "http://localhost/tool", spt);
  const header = serializeDPoP(proof);

  let nextCalled = false;
  const req = {
    headers:     { "x-soulprint": spt, "x-soulprint-proof": header },
    method:      "POST",
    protocol:    "http",
    originalUrl: "/tool",
    query:       {},
  };
  const res = {
    status: (s) => { throw new Error(`Unexpected status ${s}`); },
    setHeader: () => {},
    json: (b) => { throw new Error(`Unexpected json ${JSON.stringify(b)}`); },
  };

  await mw(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, "next() debe ser llamado con DPoP válido");
});

await testAsync("DPoP replay en mismo proceso → segundo request bloqueado", async () => {
  const { soulprint: middleware } = await import("../packages/express/dist/index.js");
  const mw = middleware({ minScore: 0, requireDPoP: true });

  const proof  = signDPoP(kp.privateKey, kp.did, "POST", "http://localhost/tool", spt);
  const header = serializeDPoP(proof);

  const makeReq = () => ({
    headers:     { "x-soulprint": spt, "x-soulprint-proof": header },
    method:      "POST",
    protocol:    "http",
    originalUrl: "/tool",
    query:       {},
  });

  // Primera petición: OK
  let nextCalled = false;
  const res1 = { status: () => res1, json: () => {}, setHeader: () => {} };
  await mw(makeReq(), res1, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, "Primera petición debe pasar");

  // Segunda petición con mismo proof: replay detectado
  let status2 = 0;
  const res2 = {
    status: (s) => { status2 = s; return res2; },
    json: () => {},
    setHeader: () => {},
  };
  await mw(makeReq(), res2, () => { throw new Error("next() no debe llamarse en replay"); });
  assert.strictEqual(status2, 401, "Replay debe devolver 401");
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
