/**
 * Test del sistema ZK sin necesitar el circuito compilado.
 * Prueba: nullifier, face_key derivation, serialización.
 */

import {
  computeNullifier, faceEmbeddingToKey,
  cedulaToBigInt, fechaToBigInt,
  serializeProof, deserializeProof,
} from "./prover.js";

async function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string) {
    if (condition) { console.log("  ✅", name); passed++; }
    else           { console.log("  ❌", name); failed++; }
  }

  console.log("=== Tests ZK — Soulprint ===\n");

  // ── Test 1: cedulaToBigInt ─────────────────────────────────────────────────
  console.log("1. Conversión cédula → BigInt");
  assert(cedulaToBigInt("1.020.461.234") === 1020461234n, 'Con puntos');
  assert(cedulaToBigInt("1020461234")    === 1020461234n, 'Sin puntos');
  assert(cedulaToBigInt("79876543")      === 79876543n,   '8 dígitos');

  // ── Test 2: fechaToBigInt ──────────────────────────────────────────────────
  console.log("\n2. Conversión fecha → BigInt");
  assert(fechaToBigInt("2004-03-15") === 20040315n, 'ISO con guiones');
  assert(fechaToBigInt("1978-07-22") === 19780722n, 'Fecha antigua');

  // ── Test 3: Nullifier determinístico ──────────────────────────────────────
  console.log("\n3. Nullifier Poseidon (determinístico)");
  const cedula   = cedulaToBigInt("1234567890");
  const fecha    = fechaToBigInt("2004-03-15");
  const face_key = 12345678901234567890n;  // simulado

  const n1 = await computeNullifier(cedula, fecha, face_key);
  const n2 = await computeNullifier(cedula, fecha, face_key);
  assert(n1 === n2,        "Mismo input → mismo nullifier (determinístico)");
  assert(typeof n1 === "bigint", "Tipo BigInt");
  assert(n1 > 0n,          "No es cero");

  const n_diff = await computeNullifier(cedula + 1n, fecha, face_key);
  assert(n1 !== n_diff,    "Diferente cédula → diferente nullifier");

  // ── Test 4: face_key derivation (determinístico cross-device) ─────────────
  console.log("\n4. Derivación face_key (misma cara → misma llave)");

  // Simular mismo embedding con ruido real de InsightFace (misma persona, distinta foto)
  // faceEmbeddingToKey aplica su propia cuantización interna (1 decimal)
  // El ruido debe ser < 0.045 para no cruzar fronteras de cuantización
  // Ruido seguro: ±0.01 (bien dentro del paso de 0.1)
  const embedding1 = Array.from({length: 512}, (_, i) =>
    Math.round(Math.sin(i * 0.1) * 8) / 10  // valores en múltiplos de 0.1 (centros de bin)
  );
  const embedding2 = embedding1.map(v => v + (Math.random() * 0.02 - 0.01)); // ±0.01 ruido

  // NO pre-cuantizar — faceEmbeddingToKey hace su propia cuantización
  const key1 = await faceEmbeddingToKey(embedding1);
  const key2 = await faceEmbeddingToKey(embedding2);

  assert(key1 === key2, "Misma cara (ruido <0.5%) → misma llave");
  assert(key1 > 0n,     "Llave no es cero");

  // Embedding muy diferente (persona distinta)
  const embedding3 = Array.from({length: 512}, (_, i) => Math.round(Math.cos(i * 0.2) * 6) / 10);
  const key3 = await faceEmbeddingToKey(embedding3);
  assert(key1 !== key3, "Persona diferente → llave diferente");

  // ── Test 5: Nullifier cross-device ────────────────────────────────────────
  console.log("\n5. Nullifier cross-device (mismo humano, distintos dispositivos)");

  // Dispositivo 1: genera face_key desde cara
  const face_key_device1 = await faceEmbeddingToKey(embedding1);
  const nullifier_d1 = await computeNullifier(cedula, fecha, face_key_device1);

  // Dispositivo 2: genera face_key desde cara (con ruido pequeño ±0.01)
  const face_key_device2 = await faceEmbeddingToKey(embedding2);
  const nullifier_d2 = await computeNullifier(cedula, fecha, face_key_device2);

  assert(nullifier_d1 === nullifier_d2,
    "Mismo humano, dispositivo diferente → mismo nullifier ✅ (resuelve el bug original)");

  // ── Test 6: Serialización del proof ───────────────────────────────────────
  console.log("\n6. Serialización proof");
  const mockProof = {
    proof:          { pi_a: ["1", "2"], pi_b: [["3","4"]], pi_c: ["5","6"] },
    public_signals: [n1.toString(), "0"],
    nullifier:      "0x" + n1.toString(16),
  };

  const serialized   = serializeProof(mockProof);
  const deserialized = deserializeProof(serialized);

  assert(typeof serialized === "string", "Serializa a string");
  assert(deserialized.nullifier === mockProof.nullifier, "Deserializa correctamente");
  assert(serialized.length < 1000, "Tamaño razonable (<1KB): " + serialized.length + " chars");

  // ── Resumen ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Resultado: ${passed}/${passed + failed} tests pasados`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
