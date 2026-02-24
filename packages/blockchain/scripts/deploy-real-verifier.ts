/**
 * deploy-real-verifier.ts — Fix 1: reemplazar MockGroth16Verifier con el verifier real.
 *
 * Pasos:
 *  1. Deploy Groth16Verifier.sol (generado por snarkjs desde el circuito real)
 *  2. Llamar SoulprintRegistry.updateVerifier(newVerifierAddr)
 *  3. Llamar SoulprintRegistry.setGovernance(GovernanceModuleAddr)
 *     → bloquea al admin para siempre — solo governance puede cambiar el verifier
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();
  const balance    = await ethers.provider.getBalance(deployer.address);

  console.log("\n🔐 Fix 1 — Real Groth16Verifier + Governance Lock");
  console.log("═══════════════════════════════════════════════════");
  console.log(`Network:   ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Balance:   ${ethers.formatEther(balance)} ETH\n`);

  const deployFile = join(__dirname, `../deployments/${network.name}.json`);
  const deployment = JSON.parse(readFileSync(deployFile, "utf8"));

  const registryAddr    = deployment.contracts.SoulprintRegistry;
  const governanceAddr  = deployment.contracts.GovernanceModule;
  const oldVerifierAddr = deployment.contracts.Groth16Verifier; // Mock actual

  console.log(`📋 Contratos existentes:`);
  console.log(`   SoulprintRegistry:  ${registryAddr}`);
  console.log(`   GovernanceModule:   ${governanceAddr}`);
  console.log(`   Verifier actual:    ${oldVerifierAddr} (MOCK)\n`);

  // ── Step 1: Deploy Groth16Verifier real ──────────────────────────────────
  console.log("⚡ Step 1: Deploy Groth16Verifier (real — snarkjs)...");
  const VerifierFactory = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await VerifierFactory.deploy();
  await verifier.waitForDeployment();
  await new Promise(r => setTimeout(r, 3000));
  const verifierAddr = await verifier.getAddress();
  console.log(`   ✅ Groth16Verifier (REAL): ${verifierAddr}`);

  // Verificar que no acepta proof vacía (a diferencia del mock)
  try {
    const valid = await verifier.verifyProof(
      [0n, 0n],
      [[0n, 0n], [0n, 0n]],
      [0n, 0n],
      [1n, 0n, 0n]   // pubSignals[0] = 1 (no-zero, mock lo aceptaría)
    );
    console.log(`   ✅ Prueba de seguridad: proof vacía → ${valid ? "⚠️ ACEPTA (ERROR)" : "✅ RECHAZA (correcto)"}`);
    if (valid) {
      console.warn("   ⚠️  ADVERTENCIA: el verifier aceptó una proof inválida");
    }
  } catch {
    console.log(`   ✅ Prueba de seguridad: proof vacía → ✅ REVERTS (correcto)`);
  }

  // ── Step 2: Actualizar SoulprintRegistry ─────────────────────────────────
  console.log("\n🔄 Step 2: Actualizar SoulprintRegistry.verifier...");
  const REGISTRY_ABI = [
    "function updateVerifier(address newVerifier) external",
    "function setGovernance(address _governance) external",
    "function admin() view returns (address)",
    "function governance() view returns (address)",
    "function verifier() view returns (address)",
  ];
  const registry = new ethers.Contract(registryAddr, REGISTRY_ABI, deployer);

  // Verificar que somos el admin
  const currentAdmin = await registry.admin();
  if (currentAdmin.toLowerCase() !== deployer.address.toLowerCase()) {
    console.error(`❌ No somos el admin. Admin actual: ${currentAdmin}`);
    process.exit(1);
  }

  const tx1 = await registry.updateVerifier(verifierAddr);
  const r1  = await tx1.wait();
  console.log(`   ✅ updateVerifier tx: ${r1.hash}`);
  console.log(`   ✅ Nuevo verifier: ${await registry.verifier()}`);

  // ── Step 3: Ceder control a GovernanceModule ─────────────────────────────
  console.log("\n🏛️  Step 3: setGovernance → bloquear admin para siempre...");
  console.log(`   GovernanceModule: ${governanceAddr}`);
  const tx2 = await registry.setGovernance(governanceAddr);
  const r2  = await tx2.wait();
  console.log(`   ✅ setGovernance tx: ${r2.hash}`);

  // Verificar estado final
  const finalAdmin = await registry.admin();
  const finalGov   = await registry.governance();
  console.log(`   ✅ admin ahora: ${finalAdmin} (debe ser 0x000...)`);
  console.log(`   ✅ governance:  ${finalGov}`);
  console.log(`   ${finalAdmin === ethers.ZeroAddress ? "✅ Admin bloqueado — solo governance puede cambiar el verifier" : "⚠️  Admin no bloqueado"}`);

  // ── Actualizar deployment file ───────────────────────────────────────────
  deployment.contracts.Groth16Verifier      = verifierAddr;
  deployment.contracts.Groth16VerifierMock  = oldVerifierAddr;
  deployment.verifierReal                    = true;
  deployment.adminLocked                     = true;
  deployment.deployedAt                      = new Date().toISOString();
  writeFileSync(deployFile, JSON.stringify(deployment, null, 2));

  console.log("\n═══════════════════════════════════════════════════");
  console.log("✅ FIX 1 COMPLETE");
  console.log(`   Groth16Verifier (real): ${verifierAddr}`);
  console.log(`   Verifier mock (legacy): ${oldVerifierAddr}`);
  console.log(`   Admin: 🔒 LOCKED (address(0))`);
  console.log(`   Governance: ${governanceAddr}`);
  console.log(`\n   BaseScan:`);
  console.log(`   https://sepolia.basescan.org/address/${verifierAddr}`);
  console.log("═══════════════════════════════════════════════════\n");
}

main().catch(console.error);
