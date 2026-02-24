#!/usr/bin/env node
/**
 * compute-code-hash.js — Fix 2: Code Integrity Hash (build-time)
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir  = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dir, "../src");
const outFile = join(__dir, "../dist/code-hash.json");

function getAllFiles(dir, ext = ".ts") {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...getAllFiles(full, ext));
    else if (full.endsWith(ext)) files.push(full);
  }
  return files.sort();
}

const files  = getAllFiles(srcDir);
const master = createHash("sha256");
for (const f of files) {
  master.update("[" + relative(srcDir, f) + "]");
  master.update(readFileSync(f, "utf8"));
}
const hash = master.digest("hex");

const output = {
  codeHash:    hash,
  codeHashHex: "0x" + hash,
  computedAt:  new Date().toISOString(),
  fileCount:   files.length,
  files:       files.map(f => relative(srcDir, f)),
};

writeFileSync(outFile, JSON.stringify(output, null, 2));
console.log("\u2705 Code integrity hash: " + hash.slice(0, 16) + "... (" + files.length + " files)");
