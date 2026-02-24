#!/usr/bin/env node
/**
 * @soulprint/cli
 * npx soulprint <command> [options]
 */

import { verifyIdentity }                    from "soulprint-verify";
import { decodeToken }                       from "soulprint-core";
import { readFileSync, writeFileSync,
         existsSync, mkdirSync }             from "node:fs";
import { join }                              from "node:path";
import { homedir }                           from "node:os";

const SOULPRINT_DIR = join(homedir(), ".soulprint");
const TOKEN_FILE    = join(SOULPRINT_DIR, "token.spt");

const args = process.argv.slice(2);
const cmd  = args[0];

async function main() {
  switch (cmd) {
    case "verify-me":    return await cmdVerifyMe();
    case "show":         return cmdShow();
    case "node":         return await cmdNode();
    case "renew":        return await cmdRenew();
    case "install-deps": return await cmdInstallDeps();
    case "help":
    default:             return cmdHelp();
  }
}

// ── verify-me ─────────────────────────────────────────────────────────────────

async function cmdVerifyMe() {
  const selfie   = getArg("--selfie");
  const document = getArg("--document");
  const verbose  = args.includes("--verbose");
  const liveness = args.includes("--liveness");
  const noZKP    = args.includes("--no-zkp");
  const minSim   = parseFloat(getArg("--min-sim") ?? "0.65");

  if (!selfie || !document) {
    console.error("❌ Uso: soulprint verify-me --selfie <foto.jpg> --document <cedula.jpg>");
    process.exit(1);
  }

  console.log("");
  console.log("🔐 Soulprint — Verificación de identidad");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📂 Tus datos NUNCA salen de este dispositivo");
  console.log("🧠 Los modelos de IA se cargan y borran de RAM automáticamente");
  console.log("");

  const t0 = Date.now();

  const result = await verifyIdentity({
    selfiePhoto:   selfie,
    documentPhoto: document,
    verbose,
    minFaceSim:    minSim,
    checkLiveness: liveness,
    withZKP:       !noZKP,
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log("");
  console.log("Pasos de verificación:");
  const icons: Record<string, string> = { ok: "✅", fail: "❌", skip: "⏭" };
  const labels: Record<string, string> = {
    image_check:       "Validación de imágenes",
    ocr:               "OCR del documento",
    face_match:        "Coincidencia facial",
    nullifier_derived: "Derivación de nullifier",
    zk_proof:          "Generación de ZK proof",
    token_created:     "Emisión del token SPT",
  };
  for (const [step, status] of Object.entries(result.steps)) {
    console.log(`  ${icons[status]} ${labels[step] ?? step}`);
  }

  if (!result.success) {
    console.log("");
    console.log("❌ Verificación fallida:");
    result.errors.forEach(e => console.log(`   • ${e}`));
    process.exit(1);
  }

  if (!existsSync(SOULPRINT_DIR)) mkdirSync(SOULPRINT_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, result.token!, "utf8");

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("✅ Identidad verificada exitosamente");
  console.log("");
  console.log(`  DID:          ${result.did}`);
  console.log(`  Trust Score:  ${result.score}/100`);
  console.log(`  ZK Proof:     ${result.zkProof ? "✅ incluido" : "⏭ omitido"}`);
  console.log(`  Token:        ${TOKEN_FILE}`);
  console.log(`  Tiempo:       ${elapsed}s`);
  console.log("");
  console.log("Tu identidad está verificada. Los servicios compatibles con");
  console.log("Soulprint pueden confirmar que hay un humano real detrás de tu bot.");
  console.log("");
  console.log("Para ver tu token: soulprint show");
  console.log("Para correr un nodo validador: soulprint node");
  console.log("");
}

// ── show ──────────────────────────────────────────────────────────────────────

function cmdShow() {
  if (!existsSync(TOKEN_FILE)) {
    console.error("❌ No tienes token. Ejecuta: soulprint verify-me --selfie yo.jpg --document cedula.jpg");
    process.exit(1);
  }

  const raw   = readFileSync(TOKEN_FILE, "utf8").trim();
  const token = decodeToken(raw);

  if (!token) {
    console.error("❌ Token inválido o expirado. Ejecuta: soulprint renew o soulprint verify-me ...");
    process.exit(1);
  }

  const expiresIn = Math.floor((token.expires * 1000 - Date.now()) / 1000 / 3600);

  console.log("");
  console.log("📋 Tu Soulprint Token");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  DID:          ${token.did}`);
  console.log(`  Trust Score:  ${token.score}/100`);
  console.log(`  Nivel:        ${token.level}`);
  console.log(`  País:         ${token.country ?? "—"}`);
  console.log(`  Credenciales: ${token.credentials.join(", ")}`);
  console.log(`  ZK Proof:     ${(token as any).zkp ? "✅ incluido" : "❌ no incluido"}`);
  console.log(`  Expira en:    ${expiresIn}h`);
  console.log(`  Nullifier:    ${token.nullifier.slice(0, 18)}...`);
  console.log("");
  console.log("Token (para copiar/pegar en la configuración de tu agente):");
  console.log("");
  console.log(raw);
  console.log("");
}

// ── node ──────────────────────────────────────────────────────────────────────

async function cmdNode() {
  const port    = parseInt(getArg("--port") ?? "4888");
  const verbose = args.includes("--verbose");

  console.log("");
  console.log("🌐 Soulprint Validator Node");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Corriendo nodo validador en el puerto ${port}...`);
  console.log("Para detener: Ctrl+C");
  console.log("");

  try {
    const { startValidatorNode } = await import("soulprint-network");
    startValidatorNode(port);
  } catch (e: any) {
    if (e.code === "ERR_MODULE_NOT_FOUND") {
      console.error("❌ soulprint-network no está instalado.");
      console.error("   Instala con: npm install -g soulprint");
    } else {
      throw e;
    }
  }
}

// ── renew ─────────────────────────────────────────────────────────────────────

async function cmdRenew() {
  console.log("");
  console.log("🔄 Renovando token Soulprint...");

  if (!existsSync(TOKEN_FILE)) {
    console.error("❌ No hay token para renovar. Ejecuta: soulprint verify-me ...");
    process.exit(1);
  }

  const raw   = readFileSync(TOKEN_FILE, "utf8").trim();
  const token = decodeToken(raw);

  if (!token) {
    console.error("❌ Token muy expirado. Debes volver a verificar con: soulprint verify-me ...");
    process.exit(1);
  }

  // Re-emitir el token con las mismas credenciales por 24h más
  // (sin re-verificar cara/documento — solo extiende el lifetime)
  const { keypairFromPrivateKey, createToken } = await import("soulprint-core");
  const keyFile = join(SOULPRINT_DIR, "identity.json");

  if (!existsSync(keyFile)) {
    console.error("❌ Keypair no encontrado. Debes verificar de nuevo: soulprint verify-me ...");
    process.exit(1);
  }

  const stored  = JSON.parse(readFileSync(keyFile, "utf8"));
  const keypair = keypairFromPrivateKey(new Uint8Array(Buffer.from(stored.privateKey, "hex")));

  const newToken = createToken(keypair, token.nullifier, token.credentials as any, {
    country: token.country,
    lifetimeSeconds: 86400,
  });

  writeFileSync(TOKEN_FILE, newToken, "utf8");

  const exp = new Date(Date.now() + 86400000).toLocaleString();
  console.log(`✅ Token renovado hasta: ${exp}`);
}

// ── install-deps ──────────────────────────────────────────────────────────────

async function cmdInstallDeps() {
  const { spawnSync } = await import("node:child_process");
  console.log("");
  console.log("📦 Instalando dependencias Python para verificación facial...");
  console.log("   (insightface, opencv-python-headless, onnxruntime)");
  console.log("");

  const result = spawnSync(
    "pip3",
    ["install", "insightface", "opencv-python-headless", "onnxruntime", "--quiet"],
    { stdio: "inherit" }
  );

  if (result.status === 0) {
    console.log("\n✅ Dependencias instaladas correctamente.");
    console.log("Ahora puedes ejecutar: soulprint verify-me --selfie yo.jpg --document cedula.jpg");
  } else {
    console.error("\n❌ Error instalando dependencias.");
    console.error("Intenta manualmente: pip3 install insightface opencv-python-headless onnxruntime");
  }
}

// ── help ──────────────────────────────────────────────────────────────────────

function cmdHelp() {
  console.log(`
🔐 Soulprint — Identidad verificable para bots de IA

  "Every bot has a soul behind it."

COMANDOS:

  verify-me              Verifica tu identidad con cédula + selfie
    --selfie  <ruta>     Foto tuya (selfie)
    --document <ruta>    Foto de tu cédula de ciudadanía
    --verbose            Mostrar progreso detallado
    --liveness           Verificar que la selfie es real (no foto de foto)
    --no-zkp             Omitir ZK proof (más rápido, menor privacidad)
    --min-sim <float>    Similitud mínima requerida (default: 0.65)

  show                   Muestra tu token Soulprint actual

  renew                  Renueva tu token por 24h sin reverificar

  node                   Corre un nodo validador local
    --port <número>      Puerto (default: 4888)

  install-deps           Instala dependencias Python (InsightFace)

EJEMPLOS:

  npx soulprint install-deps
  npx soulprint verify-me --selfie yo.jpg --document cedula.jpg --verbose
  npx soulprint show
  npx soulprint node --port 4888
  npx soulprint renew

INTEGRACIÓN (3 líneas):

  // MCP Server
  import { soulprint } from "soulprint-mcp";
  server.use(soulprint({ minScore: 60 }));

  // Express / REST API
  import { soulprint } from "soulprint-express";
  app.use(soulprint({ minScore: 40 }));

MÁS INFORMACIÓN:
  https://github.com/manuelariasfz/soulprint
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
