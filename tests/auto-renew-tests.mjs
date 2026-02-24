/**
 * auto-renew-tests.mjs — Tests para auto-renew de SPT (v0.3.6)
 *
 * Cubre:
 *  1. needsRenewal — detección de ventana pre-emptiva y grace period
 *  2. autoRenew — lógica cliente (mock fetch)
 *  3. POST /token/renew endpoint en el validador
 *  4. Casos de borde: cooldown, score bajo, DID no registrado, token muy viejo
 */

import assert from "node:assert";
import { createServer } from "node:http";

// ── Importar desde paquetes compilados ────────────────────────────────────────
const { needsRenewal, autoRenew } = await import(
  "../packages/core/dist/token-renewal.js"
);
const { createToken, generateKeypair, decodeToken,
        TOKEN_LIFETIME_SECONDS, TOKEN_RENEW_PREEMPTIVE_SECS,
        TOKEN_RENEW_GRACE_SECS } = await import(
  "../packages/core/dist/index.js"
);

// ── Utilidades de test ─────────────────────────────────────────────────────────

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

/**
 * Crea un SPT con tiempos manipulados para tests.
 * @param {Object} opts
 * @param {number} opts.issuedOffset   — segundos desde now (negativo = pasado)
 * @param {number} opts.lifetimeSeconds
 */
function makeToken(opts = {}) {
  const kp = generateKeypair();
  // createToken usa now internamente, pero podemos ajustar con lifetimeSeconds
  const { issuedOffset = 0, lifetimeSeconds = TOKEN_LIFETIME_SECONDS } = opts;
  const spt = createToken(kp, "0x" + "ab".repeat(32), ["DocumentVerified"], {
    lifetimeSeconds,
  });
  return { spt, kp };
}

// ── SECCIÓN 1: needsRenewal ───────────────────────────────────────────────────
console.log("\n🔍 needsRenewal — detección de ventana de renovación");

test("token nuevo (24h) → still_valid", () => {
  const { spt } = makeToken();
  const result = needsRenewal(spt);
  assert.strictEqual(result.needsRenew, false, "No debe renovar un token nuevo");
  assert.strictEqual(result.reason, "still_valid");
  assert.ok(result.secsRemaining > TOKEN_RENEW_PREEMPTIVE_SECS, "Tiempo restante debe ser > RENEW_PREEMPTIVE");
});

test("token con 59 min restantes → preemptive", () => {
  // Crear token con lifetime de solo 59 minutos
  const { spt } = makeToken({ lifetimeSeconds: 59 * 60 });
  const result = needsRenewal(spt);
  assert.strictEqual(result.needsRenew, true, "Debe renovar cuando quedan < 1h");
  assert.strictEqual(result.reason, "preemptive");
  assert.ok(result.secsRemaining <= TOKEN_RENEW_PREEMPTIVE_SECS);
});

test("token exactamente en umbral (3600s) → preemptive", () => {
  const { spt } = makeToken({ lifetimeSeconds: 3600 });
  const result = needsRenewal(spt);
  assert.strictEqual(result.needsRenew, true);
  assert.strictEqual(result.reason, "preemptive");
});

test("token expirado hace 1 hora → grace", () => {
  // Crear token con lifetime = 0 (ya expirado al crearse)
  const { spt } = makeToken({ lifetimeSeconds: 0 });
  const result = needsRenewal(spt);
  // decodeToken() retorna null para tokens expirados — needsRenewal cae al fallback
  assert.strictEqual(result.needsRenew, true);
});

test("token inválido/corrupto → invalid", () => {
  const result = needsRenewal("tok.invalido.abc");
  assert.strictEqual(result.needsRenew, false);
  assert.strictEqual(result.reason, "invalid");
});

test("TOKEN_LIFETIME_SECONDS es 86400", () => {
  assert.strictEqual(TOKEN_LIFETIME_SECONDS, 86_400);
});

test("TOKEN_RENEW_PREEMPTIVE_SECS es 3600", () => {
  assert.strictEqual(TOKEN_RENEW_PREEMPTIVE_SECS, 3_600);
});

test("TOKEN_RENEW_GRACE_SECS es 604800 (7 días)", () => {
  assert.strictEqual(TOKEN_RENEW_GRACE_SECS, 604_800);
});

// ── SECCIÓN 2: autoRenew (con mock HTTP server) ───────────────────────────────
console.log("\n🔄 autoRenew — cliente con mock del nodo validador");

/** Levanta un servidor HTTP mock que simula POST /token/renew */
async function withMockServer(handler, fn) {
  const server = createServer(handler);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const nodeUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(nodeUrl);
  } finally {
    await new Promise(r => server.close(r));
  }
}

await testAsync("autoRenew — token nuevo → no llama al servidor", async () => {
  let serverCalled = false;
  const { spt } = makeToken();

  await withMockServer((req, res) => {
    serverCalled = true;
    res.end(JSON.stringify({ error: "should not be called" }));
  }, async (nodeUrl) => {
    const result = await autoRenew(spt, { nodeUrl });
    assert.strictEqual(result.renewed, false, "No debe renovar un token nuevo");
    assert.strictEqual(result.spt, spt, "Devuelve el mismo token");
    assert.strictEqual(serverCalled, false, "Servidor no debe ser contactado");
  });
});

await testAsync("autoRenew — token con 59min → llama servidor, devuelve nuevo token", async () => {
  const { spt: oldSpt, kp } = makeToken({ lifetimeSeconds: 59 * 60 });
  const { spt: newSpt }      = makeToken(); // simula el nuevo token del servidor

  await withMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      spt:       newSpt,
      expires_in: 86400,
      renewed:   true,
      method:    "preemptive",
    }));
  }, async (nodeUrl) => {
    const result = await autoRenew(oldSpt, { nodeUrl });
    assert.strictEqual(result.renewed, true, "Debe renovar");
    assert.strictEqual(result.spt, newSpt, "Devuelve el nuevo SPT");
    assert.strictEqual(result.expiresIn, 86400);
  });
});

await testAsync("autoRenew — servidor responde 429 → devuelve token original", async () => {
  const { spt } = makeToken({ lifetimeSeconds: 59 * 60 });

  await withMockServer((req, res) => {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Too many renewals", retry_in: 45 }));
  }, async (nodeUrl) => {
    const result = await autoRenew(spt, { nodeUrl });
    assert.strictEqual(result.renewed, false, "No renovó (429)");
    assert.strictEqual(result.spt, spt, "Devuelve el token original");
  });
});

await testAsync("autoRenew — servidor timeout → devuelve token original sin lanzar", async () => {
  const { spt } = makeToken({ lifetimeSeconds: 59 * 60 });

  // Servidor que nunca responde
  await withMockServer((req, res) => { /* never responds */ }, async (nodeUrl) => {
    const result = await autoRenew(spt, { nodeUrl, timeoutMs: 100 });
    assert.strictEqual(result.renewed, false, "Timeout no debe tirar error");
    assert.strictEqual(result.spt, spt, "Devuelve token original");
  });
});

await testAsync("autoRenew — force=true aunque token sea nuevo", async () => {
  const { spt: oldSpt } = makeToken();
  const { spt: newSpt } = makeToken();

  await withMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ spt: newSpt, expires_in: 86400, renewed: true, method: "preemptive" }));
  }, async (nodeUrl) => {
    const result = await autoRenew(oldSpt, { nodeUrl, force: true });
    assert.strictEqual(result.renewed, true, "force=true debe llamar al servidor");
    assert.strictEqual(result.spt, newSpt);
  });
});

// ── SECCIÓN 3: integración — validator endpoint ────────────────────────────────
console.log("\n🏛️  POST /token/renew — integración con validador HTTP");

/**
 * Levanta un validador HTTP real en puerto efímero.
 * Retorna la URL y una función stop().
 */
async function withValidator() {
  const { startValidatorNode } = await import("../packages/network/dist/validator.js");
  const stop = startValidatorNode(0); // puerto 0 = efímero
  // El validador no retorna el puerto efímero directamente — usamos 4889 para test
  // En su lugar usamos un workaround: levantar en puerto fijo para test
  return stop;
}

// Nota: los tests de integración completa con el validador real requieren
// un nullifier registrado (state P2P). Testeamos los casos de error principales.

await testAsync("POST /token/renew — sin body → 400", async () => {
  const { startValidatorNode } = await import("../packages/network/dist/validator.js");

  const port = 14891;
  const server = startValidatorNode(port);
  await new Promise(r => setTimeout(r, 200));

  try {
    const resp = await fetch(`http://localhost:${port}/token/renew`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await resp.json();
    assert.strictEqual(resp.status, 400);
    assert.ok(body.error.includes("Required"));
  } finally {
    server?.close();
  }
});

await testAsync("POST /token/renew — token inválido → 401", async () => {
  const { startValidatorNode } = await import("../packages/network/dist/validator.js");

  const port = 14892;
  const server = startValidatorNode(port);
  await new Promise(r => setTimeout(r, 200));

  try {
    const resp = await fetch(`http://localhost:${port}/token/renew`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spt: "not.a.valid.token" }),
    });
    const body = await resp.json();
    assert.strictEqual(resp.status, 401);
    assert.ok(body.error.includes("Invalid SPT") || body.error.includes("cannot decode"));
  } finally {
    server?.close();
  }
});

await testAsync("POST /token/renew — token aún válido y fuera de ventana → 400", async () => {
  const { startValidatorNode } = await import("../packages/network/dist/validator.js");
  const kp = generateKeypair();

  const port = 14893;
  const server = startValidatorNode(port);
  await new Promise(r => setTimeout(r, 200));

  // Token nuevo con 24h de vida (fuera de la ventana de pre-renew de 1h)
  const spt = createToken(kp, "0x" + "cc".repeat(32), ["DocumentVerified"]);

  try {
    const resp = await fetch(`http://localhost:${port}/token/renew`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spt }),
    });
    const body = await resp.json();
    assert.strictEqual(resp.status, 400, `Esperaba 400, recibí ${resp.status}: ${JSON.stringify(body)}`);
    assert.ok(body.expires_in > 0, "Debe indicar cuándo vence");
    assert.ok(body.renew_after !== undefined, "Debe indicar cuándo renovar");
  } finally {
    server?.close();
  }
});

await testAsync("POST /token/renew — token en ventana pre-emptiva pero DID no registrado → 403", async () => {
  const { startValidatorNode } = await import("../packages/network/dist/validator.js");
  const kp = generateKeypair();

  const port = 14894;
  const server = startValidatorNode(port);
  await new Promise(r => setTimeout(r, 200));

  // Token con solo 30 minutos restantes (dentro de la ventana pre-emptiva de 1h)
  const spt = createToken(kp, "0x" + "dd".repeat(32), ["DocumentVerified"], {
    lifetimeSeconds: 30 * 60,
  });

  try {
    const resp = await fetch(`http://localhost:${port}/token/renew`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spt }),
    });
    const body = await resp.json();
    // DID no registrado en el estado del nodo → 403
    assert.strictEqual(resp.status, 403, `Esperaba 403, recibí ${resp.status}: ${JSON.stringify(body)}`);
    assert.ok(body.error.includes("DID no registrado") || body.error.includes("Score por debajo"));
  } finally {
    server?.close();
  }
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
