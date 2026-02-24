/**
 * code-integrity.ts — Fix 2: Runtime code integrity verification
 *
 * Carga el hash computado en build-time y lo expone para:
 *  1. Logging al arranque del nodo
 *  2. GET /health (peers pueden verificar)
 *  3. Comparación con hashes aprobados on-chain por governance
 *
 * GARANTÍA:
 *  - Si alguien modifica src/ y recompila → el hash cambia
 *  - Los peers pueden detectar que un nodo corre código diferente
 *  - El GovernanceModule puede registrar hashes aprobados on-chain
 *  - Si el hash no coincide con el aprobado → el nodo queda marcado como no confiable
 *
 * LIMITACIÓN (sin TEE):
 *  - Un atacante con root puede modificar dist/ directamente o falsificar el hash
 *  - La protección completa requiere TEE (Intel SGX / AMD SEV) — fase futura
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname }      from "node:path";
import { fileURLToPath }      from "node:url";
import { createHash }         from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));

export interface CodeIntegrityInfo {
  codeHash:    string;       // SHA-256 hex de los archivos fuente
  codeHashHex: string;       // Con prefix 0x (para Solidity)
  computedAt:  string;       // ISO timestamp del build
  fileCount:   number;
  available:   boolean;      // false si no se corrió compute-code-hash
}

let _cached: CodeIntegrityInfo | null = null;

/**
 * Carga el code-hash.json generado en build time.
 */
export function getCodeIntegrity(): CodeIntegrityInfo {
  if (_cached) return _cached;

  const hashFile = join(__dir, "code-hash.json");

  if (!existsSync(hashFile)) {
    _cached = {
      codeHash:    "unavailable",
      codeHashHex: "0x0000000000000000000000000000000000000000000000000000000000000000",
      computedAt:  new Date().toISOString(),
      fileCount:   0,
      available:   false,
    };
    return _cached;
  }

  try {
    const raw     = JSON.parse(readFileSync(hashFile, "utf8"));
    _cached = {
      codeHash:    raw.codeHash    ?? "unknown",
      codeHashHex: raw.codeHashHex ?? ("0x" + raw.codeHash),
      computedAt:  raw.computedAt  ?? "unknown",
      fileCount:   raw.fileCount   ?? 0,
      available:   true,
    };
  } catch {
    _cached = {
      codeHash:    "parse-error",
      codeHashHex: "0x0000000000000000000000000000000000000000000000000000000000000001",
      computedAt:  new Date().toISOString(),
      fileCount:   0,
      available:   false,
    };
  }

  return _cached;
}

/**
 * Verifica que el code hash del nodo actual coincide con uno aprobado.
 * @param approvedHashes  Lista de hashes aprobados por governance
 * @returns true si el hash actual está en la lista de aprobados
 */
export function isCodeApproved(approvedHashes: string[]): boolean {
  const info = getCodeIntegrity();
  if (!info.available) return false;  // si no hay hash, mejor denegar
  const h = info.codeHash.toLowerCase().replace("0x", "");
  return approvedHashes.some(a => a.toLowerCase().replace("0x", "") === h);
}

/**
 * Computa un hash rápido del propio binario en tiempo real (fallback).
 * Menos preciso que el hash del código fuente pero no requiere build step.
 */
export function computeRuntimeHash(): string {
  try {
    const selfPath = join(__dir, "validator.js");
    if (!existsSync(selfPath)) return "no-binary";
    const content = readFileSync(selfPath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "hash-error";
  }
}

/**
 * Log de integridad al arranque — llamar desde startServer().
 */
export function logCodeIntegrity(): void {
  const info = getCodeIntegrity();
  if (info.available) {
    console.log(`[integrity] ✅ Code hash: ${info.codeHash.slice(0, 16)}... (${info.fileCount} files)`);
    console.log(`[integrity]    Built at:  ${info.computedAt}`);
  } else {
    console.warn(`[integrity] ⚠️  Code hash unavailable — run 'pnpm build' to compute`);
    console.warn(`[integrity]    Without a code hash, peers cannot verify this node's integrity`);
  }
}
