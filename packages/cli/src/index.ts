#!/usr/bin/env node
/**
 * soulprint CLI
 * npx soulprint verify-me --selfie ./yo.jpg --document ./cedula.jpg
 */

import { verifyIdentity } from "@soulprint/verify-local";
import { decodeToken }    from "@soulprint/core";
import { readFileSync, writeFileSync } from "node:fs";
import { join }           from "node:path";
import { homedir }        from "node:os";

const args = process.argv.slice(2);
const cmd  = args[0];

async function main() {
  switch (cmd) {
    case "verify-me":   return await cmdVerifyMe();
    case "show":        return cmdShow();
    case "install-deps":return cmdInstallDeps();
    case "help":
    default:            return cmdHelp();
  }
}

// ── verify-me ─────────────────────────────────────────────────────────────────

async function cmdVerifyMe() {
  const selfie   = getArg("--selfie");
  const document = getArg("--document");
  const verbose  = args.includes("--verbose");
  const liveness = args.includes("--liveness");
  const minSim   = parseFloat(getArg("--min-sim") ?? "0.65");

  if (!selfie || !document) {
    console.error("❌ Uso: soulprint verify-me --selfie <foto.jpg> --document <cedula.jpg>");
    console.error("   Opciones:");
    console.error("     --verbose         Mostrar progreso detallado");
    console.error("     --liveness        Verificar que no es foto de foto");
    console.error("     --min-sim <0.65>  Similitud mínima requerida (0.0-1.0)");
    process.exit(1);
  }

  console.log("🔍 Soulprint — Verificación de identidad local");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📂 Tus datos NUNCA salen de este dispositivo");
  console.log("🔒 Los modelos de IA se cargan y se borran de memoria automáticamente");
  console.log("");

  const startTime = Date.now();

  const result = await verifyIdentity({
    selfiePhoto:    selfie,
    documentPhoto:  document,
    verbose,
    minFaceSim:     minSim,
    checkLiveness:  liveness,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("");
  console.log("Resultado de cada paso:");
  Object.entries(result.steps).forEach(([step, status]) => {
    const icon = status === "ok" ? "✅" : status === "fail" ? "❌" : "⏭";
    console.log(`  ${icon}  ${step.replace(/_/g, " ")}`);
  });

  if (!result.success) {
    console.log("");
    console.log("❌ Verificación fallida:");
    result.errors.forEach(e => console.log(`   • ${e}`));
    process.exit(1);
  }

  // Guardar token en disco
  const tokenFile = join(homedir(), ".soulprint", "token.spt");
  writeFileSync(tokenFile, result.token!, "utf8");

  console.log("");
  console.log("✅ Identidad verificada exitosamente");
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🆔 DID:         ${result.did}`);
  console.log(`📊 Trust Score: ${result.score}/100`);
  console.log(`⏱  Tiempo:      ${elapsed}s`);
  console.log(`💾 Token:       ${tokenFile}`);
  console.log("");
  console.log("Tu token Soulprint está listo. Los servicios compatibles");
  console.log("lo usarán automáticamente para identificar tu bot.");
}

// ── show ──────────────────────────────────────────────────────────────────────

function cmdShow() {
  const tokenFile = join(homedir(), ".soulprint", "token.spt");
  try {
    const raw   = readFileSync(tokenFile, "utf8").trim();
    const token = decodeToken(raw);

    if (!token) {
      console.error("❌ Token inválido o expirado. Ejecuta: soulprint verify-me --selfie ... --document ...");
      process.exit(1);
    }

    console.log("📋 Tu Soulprint Token:");
    console.log(`  DID:         ${token.did}`);
    console.log(`  Trust Score: ${token.score}/100`);
    console.log(`  Nivel:       ${token.level}`);
    console.log(`  País:        ${token.country ?? "desconocido"}`);
    console.log(`  Credenciales: ${token.credentials.join(", ")}`);
    console.log(`  Expira:      ${new Date(token.expires * 1000).toLocaleString()}`);
  } catch {
    console.error("❌ No tienes token. Ejecuta: soulprint verify-me --selfie ... --document ...");
    process.exit(1);
  }
}

// ── install-deps ──────────────────────────────────────────────────────────────

async function cmdInstallDeps() {
  const { spawnSync } = await import("node:child_process");
  console.log("📦 Instalando dependencias Python para verificación facial...");
  console.log("   (insightface, opencv-python-headless, onnxruntime)");
  console.log("");

  const result = spawnSync(
    "pip3",
    ["install", "insightface", "opencv-python-headless", "onnxruntime", "--quiet"],
    { stdio: "inherit" }
  );

  if (result.status === 0) {
    console.log("\n✅ Dependencias instaladas. Ya puedes ejecutar soulprint verify-me");
  } else {
    console.error("\n❌ Error instalando dependencias.");
    console.error("Intenta manualmente: pip3 install insightface opencv-python-headless onnxruntime");
  }
}

// ── help ──────────────────────────────────────────────────────────────────────

function cmdHelp() {
  console.log(`
🔐 Soulprint — Identidad verificable para bots IA

COMANDOS:

  verify-me         Verifica tu identidad con cédula + selfie
    --selfie        <ruta>   Foto tuya (selfie)
    --document      <ruta>   Foto de tu cédula de ciudadanía
    --verbose                Mostrar progreso detallado
    --liveness               Verificar que la selfie es real (no foto de foto)
    --min-sim       <float>  Similitud mínima requerida (default: 0.65)

  show              Muestra tu token Soulprint actual

  install-deps      Instala dependencias Python (InsightFace)

EJEMPLOS:

  npx soulprint install-deps
  npx soulprint verify-me --selfie yo.jpg --document cedula.jpg
  npx soulprint show

PRIVACIDAD:
  Tus fotos NUNCA salen del dispositivo.
  Los modelos de IA se cargan solo durante la verificación y se borran al terminar.
  Solo se guarda un token criptográfico — sin datos personales.
`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

main().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
