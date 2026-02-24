#!/usr/bin/env node
/**
 * compute-code-hash.ts — Fix 2: Code Integrity Hash
 *
 * Computa SHA-256 de todos los archivos fuente del nodo validador.
 * El resultado se embebe en dist/code-hash.json al hacer build.
 *
 * El validador:
 *  1. Lee dist/code-hash.json al arrancar
 *  2. Lo expone en GET /health como "codeHash"
 *  3. Governance puede registrar hashes aprobados on-chain
 *  4. Los peers pueden verificar que están corriendo el mismo código
 *
 * Uso: node scripts/compute-code-hash.ts
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR  = join(__dirname, "../src");
const OUT_FILE = join(__dirname, "../dist/code-hash.json");

function getAllFiles(dir: string, ext = ".ts"): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...getAllFiles(full, ext));
    } else if (full.endsWith(ext)) {
      files.push(full);
    }
  }
  return files.sort(); // determinístico
}

function computeCodeHash(): string {
  const files  = getAllFiles(SRC_DIR);
  const master = createHash("sha256");

  for (const file of files) {
    const relPath = relative(SRC_DIR, file);
    const content = readFileSync(file, "utf8");
    // Incluir nombre del archivo para detectar renombres/adiciones
    master.update(`[${relPath}]`);
    master.update(content);
  }

  return master.digest("hex");
}

const hash      = computeCodeHash();
const timestamp = new Date().toISOString();
const srcFiles  = getAllFiles(SRC_DIR);

const output = {
  codeHash:   hash,
  computedAt: timestamp,
  fileCount:  srcFiles.length,
  files:      srcFiles.map(f => relative(SRC_DIR, f)),
  // Prefijo 0x para compatibilidad con Solidity bytes32
  codeHashHex: "0x" + hash,
};

writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

console.log(`✅ Code integrity hash computed`);
console.log(`   Files:     ${srcFiles.length} source files`);
console.log(`   Hash:      ${hash}`);
console.log(`   Written to: dist/code-hash.json`);
