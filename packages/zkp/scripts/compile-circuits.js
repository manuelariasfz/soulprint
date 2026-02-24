#!/usr/bin/env node
/**
 * compile-circuits.js
 * Compila el circuito Circom, genera las proving keys y verification key.
 *
 * Solo se ejecuta UNA VEZ para setup. Los keys resultantes van al repo.
 * No se necesita volver a ejecutar en producción.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname }       from "node:path";
import { fileURLToPath }       from "node:url";
import snarkjs                  from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, "..");
const CIRCUITS  = join(ROOT, "circuits");
const KEYS      = join(ROOT, "keys");
const BUILD     = join(ROOT, "build");

[KEYS, BUILD].forEach(d => !existsSync(d) && mkdirSync(d, { recursive: true }));

const CIRCUIT = "soulprint_identity";

async function main() {
  console.log("🔧 Compilando circuito Soulprint ZK...\n");

  // ── 1. Instalar circomlib si no existe ─────────────────────────────────────
  if (!existsSync(join(ROOT, "node_modules", "circomlib"))) {
    console.log("📦 Instalando circomlib...");
    execSync("npm install circomlib --save", { cwd: ROOT, stdio: "inherit" });
  }

  // ── 2. Compilar circuito con circom ───────────────────────────────────────
  console.log("⚙️  Compilando circuito Circom...");
  const compileResult = spawnSync("circom", [
    join(CIRCUITS, `${CIRCUIT}.circom`),
    "--r1cs", "--wasm", "--sym",
    "-o", BUILD,
    "-l", join(ROOT, "node_modules"),
  ], { stdio: "inherit" });

  if (compileResult.status !== 0) {
    console.error("❌ Error compilando circuito");
    process.exit(1);
  }
  console.log("✅ Circuito compilado\n");

  // ── 3. Descargar Powers of Tau (ceremonia pública de Hermez) ──────────────
  // Usamos la fase 1 ya disponible públicamente — evita que Soulprint haga
  // su propia ceremonia (que requiere participantes múltiples)
  const ptauFile = join(KEYS, "pot12_final.ptau");
  if (!existsSync(ptauFile)) {
    console.log("⬇️  Descargando Powers of Tau (ceremonia pública Hermez)...");
    execSync(
      `curl -L https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_12.ptau -o ${ptauFile}`,
      { stdio: "inherit" }
    );
  } else {
    console.log("✅ Powers of Tau ya disponible");
  }

  // ── 4. Setup de la proving key (fase 2) ───────────────────────────────────
  console.log("\n🔑 Generando proving key...");
  const zkeyPath     = join(KEYS, `${CIRCUIT}_0000.zkey`);
  const zkeyFinal    = join(KEYS, `${CIRCUIT}_final.zkey`);
  const verKeyPath   = join(KEYS, "verification_key.json");

  await snarkjs.zKey.newZKey(
    join(BUILD, `${CIRCUIT}.r1cs`),
    ptauFile,
    zkeyPath,
    console
  );

  // Contribución de entropía al setup (en producción: múltiples contribuyentes)
  await snarkjs.zKey.contribute(
    zkeyPath,
    zkeyFinal,
    "Soulprint Initial Contribution",
    // En producción: pedir entropía a la comunidad
    "soulprint_entropy_v1_" + Date.now()
  );

  // ── 5. Exportar verification key (va al repo, es pública) ─────────────────
  console.log("📋 Exportando verification key...");
  const vKey = await snarkjs.zKey.exportVerificationKey(zkeyFinal);
  writeFileSync(verKeyPath, JSON.stringify(vKey, null, 2));

  console.log("\n✅ Setup completo:");
  console.log(`   Circuit:          ${BUILD}/${CIRCUIT}_js/`);
  console.log(`   Proving key:      ${zkeyFinal}`);
  console.log(`   Verification key: ${verKeyPath}`);
  console.log("\n⚠️  NOTA: En producción, el setup debe hacerse con múltiples");
  console.log("   contribuyentes (ceremonia multi-party). Ver: snarkjs zKey contribute");
}

main().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
